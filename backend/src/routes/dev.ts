/* eslint-disable no-console */
// src/routes/dev.ts
import { Router } from "express";
import {
  ScanCommand,
  UpdateCommand,
  PutCommand,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db"; // TS source (no .js)

const router = Router();

// ---------- types ----------
type GuardRow = { pk: string; sk: "METADATA"; type: "Guard"; name?: string; dob?: string | null };
type QueueEntry = { guardId: string; returnTo?: string; enteredTick?: number };
type StateItem = {
  pk: string;
  sk: "STATE";
  assigned?: Record<string, string | null>;
  queue?: QueueEntry[];
  rev?: number;
  updatedAt?: Record<string, string>;
  ttl?: number;
};

// ---------- helpers ----------
const norm = (s: string) =>
  s?.normalize?.("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() ?? "";

const stripId = (v: unknown) =>
  typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v ?? "");

async function scanAll<T = any>(params: ScanCommandInput): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    if (page.Items?.length) items.push(...(page.Items as T[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function loadGuardMaps() {
  const guards = await scanAll<GuardRow>({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p) AND #sk = :sk AND #type = :t",
    ExpressionAttributeValues: { ":p": "GUARD#", ":sk": "METADATA", ":t": "Guard" },
    ExpressionAttributeNames: {
      "#sk": "sk",
      "#type": "type",
      "#name": "name",
    },
    ProjectionExpression: "pk, #sk, #type, #name, dob",
    ConsistentRead: true,
  });

  const rows = guards.map((it) => ({
    id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : (it as any).id,
    name: String(it.name ?? ""),
    dob: it.dob ?? null,
  }));

  const knownIds = new Set(rows.map((g) => g.id));
  const byName = new Map<string, string>();
  for (const g of rows) byName.set(norm(g.name || g.id), g.id);

  return { rows, knownIds, byName };
}

function toCanonicalId(
  raw: unknown,
  knownIds: Set<string>,
  byName: Map<string, string>
): string | null {
  if (raw == null) return null;
  const s = stripId(raw).trim();
  if (!s) return null;
  if (knownIds.has(s)) return s;
  const m = byName.get(norm(s));
  return m && knownIds.has(m) ? m : null;
}

// ---------- scan STATE rows (optionally for one date) ----------
async function scanStateRows(date?: string) {
  // We store state in rows where sk = "STATE" and pk begins with ROTATION#
  // If a date is given, prefer ROTATION#${date}; this covers live and all #INSTANCE# rows.
  const filterExpr = date
    ? "begins_with(pk, :p) AND #sk = :sk"
    : "begins_with(pk, :p) AND #sk = :sk";
  const exprVals = date
    ? { ":p": `ROTATION#${date}`, ":sk": "STATE" }
    : { ":p": "ROTATION#", ":sk": "STATE" };

  const rows = await scanAll<StateItem>({
    TableName: TABLE,
    FilterExpression: filterExpr,
    ExpressionAttributeValues: exprVals,
    ExpressionAttributeNames: { "#sk": "sk" },
    ConsistentRead: true,
  });

  return rows;
}

// ---------- DIAG: quick snapshot over STATE items ----------
router.get("/diag", async (req, res) => {
  try {
    const { rows: roster, knownIds, byName } = await loadGuardMaps();
    const date = String(req.query?.date ?? ""); // optional YYYY-MM-DD

    const stateRows = await scanStateRows(date);

    const out: any = {
      rosterCount: roster.length,
      stateRowCount: stateRows.length,
      unknownAssigned: 0,
      unknownQueue: 0,
      samples: [] as any[],
    };

    for (const st of stateRows) {
      const assigned = st.assigned || {};
      for (const [seat, gid] of Object.entries(assigned)) {
        if (gid == null) continue;
        const canon = toCanonicalId(gid, knownIds, byName);
        if (!canon) {
          out.unknownAssigned++;
          if (out.samples.length < 10)
            out.samples.push({ kind: "assigned", pk: st.pk, seat, bad: gid });
        }
      }

      const q = Array.isArray(st.queue) ? st.queue : [];
      for (const row of q) {
        const canon = toCanonicalId(row.guardId, knownIds, byName);
        if (!canon) {
          out.unknownQueue++;
          if (out.samples.length < 10)
            out.samples.push({ kind: "queue", pk: st.pk, bad: row.guardId });
        }
      }
    }

    res.json(out);
  } catch (err: any) {
    console.error("[/api/dev/diag] failed:", err);
    res.status(500).json({ error: "diag failed", detail: err?.message || String(err) });
  }
});

// ---------- FIX: convert names → ids in STATE.assigned & STATE.queue ----------
router.post("/fix-ids", async (req, res) => {
  try {
    const apply = String(req.query.apply ?? "0") === "1";
    const date = String(req.query?.date ?? ""); // optional YYYY-MM-DD
    const { knownIds, byName } = await loadGuardMaps();

    const stateRows = await scanStateRows(date);

    let examined = 0;
    let changed = 0;
    const changes: any[] = [];

    for (const st of stateRows) {
      examined++;
      let dirty = false;

      // Fix assigned
      const nextAssigned: Record<string, string | null> = { ...(st.assigned || {}) };
      for (const [seat, gid] of Object.entries(nextAssigned)) {
        if (gid == null) continue;
        const canon = toCanonicalId(gid, knownIds, byName);
        if (canon && canon !== stripId(gid)) {
          nextAssigned[seat] = canon;
          dirty = true;
          changed++;
          changes.push({ kind: "assigned", pk: st.pk, seat, from: gid, to: canon });
        } else if (!canon) {
          // If unresolvable, you can choose to null it or leave it. Here we leave it as-is for fix-ids.
        }
      }

      // Fix queue
      const currentQueue = Array.isArray(st.queue) ? st.queue : [];
      const nextQueue: QueueEntry[] = currentQueue.map((row) => {
        const canon = toCanonicalId(row.guardId, knownIds, byName);
        if (canon && canon !== stripId(row.guardId)) {
          dirty = true;
          changed++;
          changes.push({ kind: "queue", pk: st.pk, from: row.guardId, to: canon });
          return { ...row, guardId: canon };
        }
        return row;
      });

      if (!dirty || !apply) continue;

      // Apply update: set assigned/queue and bump rev atomically
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: st.pk, sk: "STATE" },
          UpdateExpression: "SET #a = :a, #q = :q, #rev = if_not_exists(#rev,:z) + :one, #u = :now",
          ExpressionAttributeNames: {
            "#a": "assigned",
            "#q": "queue",
            "#rev": "rev",
            "#u": "updatedAt", // store a flat timestamp map? If you use map, you can skip this.
          },
          ExpressionAttributeValues: {
            ":a": nextAssigned,
            ":q": nextQueue,
            ":z": 0,
            ":one": 1,
            ":now": { ...(st as any).updatedAt, _devFixIds: new Date().toISOString() },
          },
          ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
        })
      );
    }

    res.json({ examined, changed, applied: apply, samples: changes.slice(0, 20) });
  } catch (err: any) {
    console.error("[/api/dev/fix-ids] failed:", err);
    res.status(500).json({ error: "fix-ids failed", detail: err?.message || String(err) });
  }
});

// ---------- PURGE: drop unknowns (null seats & remove queue rows) for a date ----------
router.post("/purge-unknown", async (req, res) => {
  try {
    const date = String(req.query?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date required (YYYY-MM-DD)" });
    }

    const { knownIds, byName } = await loadGuardMaps();
    const toCanon = (v: unknown) => toCanonicalId(v, knownIds, byName);

    const stateRows = await scanStateRows(date);

    let touched = 0;
    let seatsCleared = 0;
    let queueRemoved = 0;

    for (const st of stateRows) {
      const assigned = { ...(st.assigned || {}) };
      const queue = Array.isArray(st.queue) ? [...st.queue] : [];

      let dirty = false;

      // Clear unknown seats
      for (const [seat, gid] of Object.entries(assigned)) {
        if (gid == null) continue;
        const canon = toCanon(gid);
        if (!canon) {
          assigned[seat] = null;
          seatsCleared++;
          dirty = true;
        }
      }

      // Drop unknown queue rows
      const kept: QueueEntry[] = [];
      for (const row of queue) {
        const canon = toCanon(row.guardId);
        if (canon) {
          kept.push({ ...row, guardId: canon });
        } else {
          queueRemoved++;
          dirty = true;
        }
      }

      if (!dirty) continue;

      touched++;
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: st.pk, sk: "STATE" },
          UpdateExpression:
            "SET #a = :a, #q = :q, #rev = if_not_exists(#rev,:z) + :one, #u = :now",
          ExpressionAttributeNames: {
            "#a": "assigned",
            "#q": "queue",
            "#rev": "rev",
            "#u": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":a": assigned,
            ":q": kept,
            ":z": 0,
            ":one": 1,
            ":now": { ...(st as any).updatedAt, _devPurgeUnknown: new Date().toISOString() },
          },
          ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
        })
      );
    }

    res.json({ date, stateRows: stateRows.length, touched, seatsCleared, queueRemoved });
  } catch (err: any) {
    console.error("[/api/dev/purge-unknown] failed:", err);
    res.status(500).json({ error: "purge-unknown failed", detail: err?.message || String(err) });
  }
});

export default router;
