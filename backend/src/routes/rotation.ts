// src/routes/rotation.ts
import { Router } from "express";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { POSITIONS } from "../data/poolLayout.js";
import { getState, putState, type RotationState } from "../rotation/store";

const router = Router();

const SANDBOX_TTL_SECS = Number(process.env.SANDBOX_TTL_DAYS || 7) * 24 * 3600;
const VALID_SEATS = new Set(POSITIONS.map((p) => p.id));

// ---- helpers (same behavior as plan.ts) ----
const strip = (v: any) =>
  typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v || "");
const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

async function loadGuardMaps() {
  const scan = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p) AND #sk = :sk AND #type = :t",
      ExpressionAttributeValues: { ":p": "GUARD#", ":sk": "METADATA", ":t": "Guard" },
      ExpressionAttributeNames: { "#sk": "sk", "#type": "type" },
      ConsistentRead: true,
    })
  );
  const guards = (scan.Items ?? []).map((it: any) => ({
    id:
      typeof it.pk === "string" && it.pk.startsWith("GUARD#")
        ? it.pk.slice(6)
        : String(it.id ?? ""),
    name: String(it.name ?? ""),
  }));
  const knownIds = new Set(guards.map((g) => g.id));
  const byName = new Map<string, string>();
  for (const g of guards) byName.set(norm(g.name || g.id), g.id);
  return { knownIds, byName };
}
function toId(raw: any, known: Set<string>, byName: Map<string, string>) {
  if (raw == null) return null;
  const s = strip(raw).trim();
  if (!s) return null;
  if (known.has(s)) return s;
  const m = byName.get(norm(s));
  return m && known.has(m) ? m : null;
}

// ---- POST /api/rotations/slot  (single seat write; ID-only) ----
router.post("/slot", async (req: any, res) => {
  try {
    const date = String(req.body?.date || "");
    const time = String(req.body?.time || "").slice(0, 8); // HH:MM[:SS] accepted
    const stationId = String(req.body?.stationId || "");
    const notes = String(req.body?.notes || "");
    if (!date || !time || !stationId)
      return res.status(400).json({ error: "date, time, stationId required" });
    if (!VALID_SEATS.has(stationId))
      return res.status(400).json({ error: "invalid stationId" });

    // resolve guard to canonical id (or null to clear)
    const { knownIds, byName } = await loadGuardMaps();
    const canon = toId(req.body?.guardId, knownIds, byName); // may be null to clear

    // read current per-instance state
    const current = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);

    // update assigned + updatedAt
    const next: RotationState = {
      ...current,
      assigned: { ...(current.assigned || {}), [stationId]: canon ?? null },
      updatedAt: {
        ...(current.updatedAt || {}),
        [stationId]: new Date().toISOString(), // or use req.body.nowISO if you send it
      },
      // optional: keep a small audit trail if you want later
      // metadata: { ...(current.metadata||{}), lastNotes: notes },
      rev: (current.rev ?? 0) + 1,
    };

    const saved = await putState(ddb as any, TABLE, date, req.sandboxInstanceId, next, {
      ttlSeconds: req.sandboxInstanceId ? SANDBOX_TTL_SECS : undefined,
    });

    res.set("Cache-Control", "no-store");
    res.json({ ok: true, stationId, guardId: canon, date, time, state: saved });
  } catch (e) {
    console.error("POST /api/rotations/slot error", e);
    res.status(500).json({ error: "failed to persist slot" });
  }
});

// ---- GET /api/rotations/day/:date  (latest frame; IDs only) ----
router.get("/day/:date", async (req: any, res) => {
  try {
    const date = String(req.params.date || "");
    if (!date) return res.status(400).json({ error: "date required" });

    const state = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
    const assigned = state.assigned || {};
    const updatedAt = state.updatedAt || {};

    // Return one row per seat (like a "latest frame")
    const items = POSITIONS.map((p) => ({
      stationId: p.id,
      guardId: assigned[p.id] ?? null,
      updatedAt: updatedAt[p.id] ?? null,
    }));

    res.set("Cache-Control", "no-store");
    res.json(items);
  } catch (e) {
    console.error("GET /api/rotations/day/:date error", e);
    res.status(500).json({ error: "failed to load day" });
  }
});

export default router;
