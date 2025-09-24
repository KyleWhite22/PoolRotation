import { Router } from "express";
import { QueryCommand, PutCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { computeNext } from "../engine/rotation.js";
import { POSITIONS, EDGES, VIEWBOX, POOL_PATH_D, REST_STATIONS }
  from "../../../shared/data/poolLayout.js";

const router = Router();

// simple loader to get all guards
async function loadGuards() {
  const scan = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": "GUARD#" },
    })
  );
  return (scan.Items ?? []).map((it) => ({
    id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : it.id,
    name: it.name,
    dob: it.dob,
  }));
}

/**
 * POST /api/plan/rotate
 * Body: {
 *   date: "YYYY-MM-DD",
 *   nowISO?: string,
 *   assignedSnapshot?: Record<string, string|null>  // optional client UI fallback
 * }
 * Returns: { assigned, breaks, conflicts, meta, nowISO }
 */
router.post("/rotate", async (req, res) => {
  try {
    const date = req.body?.date;
    const nowISO = req.body?.nowISO ?? new Date().toISOString();
    const clientAssigned =
      (req.body?.assignedSnapshot as Record<string, string | null> | undefined) ?? {};

    if (!date) return res.status(400).json({ error: "date required" });

    // 1) latest assigned per-station for the date
    const q = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
      })
    );

    const latestByStation = new Map<string, any>();
    for (const it of q.Items ?? []) {
      if (it.type !== "RotationSlot") continue;
      const prev = latestByStation.get(it.stationId);
      if (!prev || String(prev.updatedAt ?? "") < String(it.updatedAt ?? "")) {
        latestByStation.set(it.stationId, it);
      }
    }

    // Build assigned with fallback to client snapshot when DB has no row
    const assigned: Record<string, string | null> = {};
    for (const p of POSITIONS) {
      const rec = latestByStation.get(p.id);
      assigned[p.id] = rec?.guardId ?? clientAssigned[p.id] ?? null;
    }

    // 2) guards
    const guards = await loadGuards();

    // 3) breaks (single item)
    const breaksItem = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `ROTATION#${date}`, sk: "BREAKS" },
      })
    );
    const breaks = (breaksItem.Item?.breaks ?? {}) as Record<string, string>;

    // 4) compute next
    const out = computeNext({ assigned, guards, breaks, nowISO });

    // 5) persist breaks + new slot snapshot entries
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `ROTATION#${date}`,
          sk: "BREAKS",
          type: "Breaks",
          breaks: out.nextBreaks,
          updatedAt: nowISO,
        },
      })
    );

    const time = nowISO.slice(11, 16); // HH:MM
    for (const [stationId, guardId] of Object.entries(out.nextAssigned)) {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: {
            pk: `ROTATION#${date}`,
            sk: `SLOT#${time}#${stationId}`,
            type: "RotationSlot",
            stationId,
            guardId,
            time,
            date,
            notes: "rotate-server",
            updatedAt: nowISO,
          },
        })
      );
    }

    res.json({
      assigned: out.nextAssigned,
      breaks: out.nextBreaks,
      conflicts: out.conflicts,
      meta: out.meta,
      nowISO,
    });
  } catch (err) {
    console.error("POST /api/plan/rotate error:", err);
    res.status(500).json({ error: "Failed to rotate" });
  }
});

// POST /api/plan/reset-breaks { date: "YYYY-MM-DD" }
router.post("/reset-breaks", async (req, res) => {
  try {
    const date = req.body?.date;
    if (!date) return res.status(400).json({ error: "date required" });

    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `ROTATION#${date}`,
          sk: "BREAKS",
          type: "Breaks",
          breaks: {}, // clear
          updatedAt: new Date().toISOString(),
        },
      })
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/plan/reset-breaks error:", err);
    res.status(500).json({ error: "Failed to reset breaks" });
  }
});

export default router;
