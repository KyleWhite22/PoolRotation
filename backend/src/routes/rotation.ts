//src/routes/rotation.ts
import { Router } from "express";
import { QueryCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { POSITIONS } from "../data/poolLayout.js";

const router = Router();

// ---- helpers (same behavior as plan.ts) ----
const strip = (v:any)=> typeof v==="string" && v.startsWith("GUARD#") ? v.slice(6) : String(v||"");
const norm  = (s:string)=> s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();

async function loadGuardMaps() {
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p) AND #sk = :sk AND #type = :t",
    ExpressionAttributeValues: { ":p": "GUARD#", ":sk": "METADATA", ":t": "Guard" },
    ExpressionAttributeNames: { "#sk": "sk", "#type": "type" },
    ConsistentRead: true,
  }));
  const guards = (scan.Items ?? []).map((it:any)=> ({
    id: typeof it.pk === "string" && it.pk.startsWith("GUARD#") ? it.pk.slice(6) : String(it.id ?? ""),
    name: String(it.name ?? ""),
  }));
  const knownIds = new Set(guards.map(g => g.id));
  const byName = new Map<string,string>();
  for (const g of guards) byName.set(norm(g.name || g.id), g.id);
  return { knownIds, byName };
}
function toId(raw:any, known:Set<string>, byName:Map<string,string>) {
  if (raw == null) return null;
  const s = strip(raw).trim();
  if (!s) return null;
  if (known.has(s)) return s;
  const m = byName.get(norm(s));
  return m && known.has(m) ? m : null;
}

const VALID_SEATS = new Set(POSITIONS.map(p => p.id));

// ---- POST /api/rotations/slot  (single seat write; ID-only) ----
router.post("/slot", async (req, res) => {
  try {
    const date = String(req.body?.date || "");
    const time = String(req.body?.time || "").slice(0,8); // HH:MM:SS or HH:MM
    const stationId = String(req.body?.stationId || "");
    const notes = String(req.body?.notes || "");
    if (!date || !time || !stationId) return res.status(400).json({ error: "date, time, stationId required" });
    if (!VALID_SEATS.has(stationId)) return res.status(400).json({ error: "invalid stationId" });

    const { knownIds, byName } = await loadGuardMaps();
    const canon = toId(req.body?.guardId, knownIds, byName); // may be null

    const nowISO = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: `SLOT#${time}#${stationId}`,
        type: "RotationSlot",
        stationId,
        guardId: canon ?? null,
        time,
        date,
        notes,
        updatedAt: nowISO,
      },
    }));
    res.json({ ok: true, stationId, guardId: canon, date, time });
  } catch (e) {
    console.error("POST /api/rotations/slot error", e);
    res.status(500).json({ error: "failed to persist slot" });
  }
});

// ---- GET /api/rotations/day/:date  (latest frame; IDs only) ----
router.get("/day/:date", async (req, res) => {
  try {
    const date = String(req.params.date || "");
    if (!date) return res.status(400).json({ error: "date required" });

    const q = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
      ConsistentRead: true,
    }));
    const slots = (q.Items ?? []).filter((it:any) => it.type === "RotationSlot");

    // choose latest updatedAt across the frame
    let latestTickISO: string | null = null;
    for (const it of slots) {
      const u = String(it.updatedAt ?? "");
      if (u && (!latestTickISO || u > latestTickISO)) latestTickISO = u;
    }

    const latest: { stationId: string; guardId: string|null; updatedAt: string }[] = [];
    if (latestTickISO) {
      for (const it of slots) {
        if (String(it.updatedAt ?? "") !== latestTickISO) continue;
        const stationId = String(it.stationId || "");
        if (!VALID_SEATS.has(stationId)) continue;
        const gidRaw = it.guardId ?? null;
        // they were written as IDs already by POST /slot, but be defensive:
        const gid = typeof gidRaw === "string" && gidRaw.startsWith("GUARD#") ? gidRaw.slice(6) : (gidRaw ?? null);
        latest.push({ stationId, guardId: gid, updatedAt: latestTickISO });
      }
    }
    res.set("Cache-Control", "no-store");
    res.json(latest);
  } catch (e) {
    console.error("GET /api/rotations/day/:date error", e);
    res.status(500).json({ error: "failed to load day" });
  }
});

export default router;
