// backend/src/routes/plan.ts
console.log("[routes/plan] LOADED");
import { Router } from "express";
import { QueryCommand, PutCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { computeNext } from "../engine/rotation.js";
import { POSITIONS } from "../../../shared/data/poolLayout.js";

const router = Router();

const stripGuard = (gid: any): string | null => {
  if (!gid) return null;
  const s = String(gid);
  return s.startsWith("GUARD#") ? s.slice("GUARD#".length) : s;
};

async function loadGuards() {
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
  }));
  return (scan.Items ?? []).map((it) => ({
    id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : it.id,
    name: it.name,
    dob: it.dob,
  }));
}
// ---- Tick helpers (15-min ticks) -------------------------------------------
// ---- Tick helpers
function tickIndexFromISO(nowISO: string): number {
  return Math.floor(Date.parse(nowISO) / (15 * 60 * 1000));
}

// DB/engine queue row type used in this routes file
type QueueRow = { guardId: string; returnTo: string; enteredTick: number };
/**
 * POST /api/plan/rotate
 * Body: { date: "YYYY-MM-DD", nowISO?: string, assignedSnapshot?: Record<string,string|null> }
 * Reads the latest frame by updatedAt, rotates, then writes a NEWER frame
 * regardless of client-supplied nowISO (monotonic on server).
 */
router.post("/rotate", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });

  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
    ConsistentRead: true,
  }));

  const slots = (q.Items ?? []).filter(it => it.type === "RotationSlot");

  let latestTickISO: string | null = null;
  for (const it of slots) {
    const u = String(it.updatedAt ?? "");
    if (!u) continue;
    if (!latestTickISO || u > latestTickISO) latestTickISO = u;
  }

  // Build from DB or client snapshot
  const assignedFromDb: Record<string, string | null> =
    Object.fromEntries(POSITIONS.map(p => [p.id, null as string | null]));
  if (latestTickISO) {
    for (const it of slots) {
      if (String(it.updatedAt ?? "") !== latestTickISO) continue;
      const sid = String(it.stationId ?? "");
      if (!sid) continue;
      let gid = it.guardId ?? null;
      if (typeof gid === "string" && gid.startsWith("GUARD#")) gid = gid.slice(6);
      assignedFromDb[sid] = gid;
    }
  }

  const clientAssigned = (req.body?.assignedSnapshot ?? {}) as Record<string, string | null>;

  // ---- NEW: choose a SAFE assigned frame ----
  const countNonNull = (m: Record<string, string | null>) =>
    Object.values(m).reduce((n, v) => n + (v ? 1 : 0), 0);
  const clientNormalized: Record<string, string | null> = {};
  for (const [sid, gid] of Object.entries(clientAssigned)) {
    clientNormalized[sid] = gid?.startsWith?.("GUARD#") ? gid.slice(6) : gid ?? null;
  }

  // Prefer DB frame if it has data; otherwise use client snapshot
  const assigned = countNonNull(assignedFromDb) > 0 ? assignedFromDb : clientNormalized;

  // ---- NEW: lightweight debug (safe in dev) ----
 /* if (process.env.NODE_ENV !== "production") {
    console.log("[rotate.debug] latestTickISO:", latestTickISO,
      "dbCount:", countNonNull(assignedFromDb),
      "clientCount:", countNonNull(clientNormalized));
  }*/

  // guards/breaks as before...
  const guards = await loadGuards();
  const breaksItem = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `ROTATION#${date}`, sk: "BREAKS" },
  }));
  const breaks = (breaksItem.Item?.breaks ?? {}) as Record<string, string>;

  const nowISO = req.body?.nowISO ?? new Date().toISOString();

  const rosterIds = new Set(guards.map(g => g.id));
  const queue = await loadQueue(date, rosterIds, tickIndexFromISO(nowISO));

  const out = computeNext({ assigned, guards, breaks, queue, nowISO });
  // in /api/plan/rotate, right after `const out = computeNext(...)`
if (process.env.NODE_ENV !== "production") {
  const assignedIn  = Object.values(assigned).filter(Boolean).length;
  const assignedOut = Object.values(out.nextAssigned).filter(Boolean).length;
  const queueLen    = out.meta.breakQueue.length;
  console.log("[rotate.debug]", { period: out.meta.period, assignedIn, assignedOut, queueLen });
}
  (function invariantChecks() {
  const seated = new Set<string>();
  for (const gid of Object.values(out.nextAssigned)) {
    if (!gid) continue;
    if (seated.has(gid)) console.warn("[invariant] duplicate seated guard", gid);
    seated.add(gid);
  }
  for (const q of out.meta.breakQueue) {
    if (seated.has(q.guardId)) console.warn("[invariant] seated guard still in queue", q.guardId);
  }
})();

  // 5) MONOTONIC WRITE TIMESTAMP (server authoritative)
  const serverNow = new Date();
  let writeUpdatedAt = serverNow.toISOString();
  if (latestTickISO && writeUpdatedAt <= latestTickISO) {
    writeUpdatedAt = new Date(new Date(latestTickISO).getTime() + 1).toISOString();
  }
  const time = writeUpdatedAt.slice(11, 19); // "HH:MM:SS"

  // 6) Persist snapshot rows for this new frame
for (const [stationId, guardId] of Object.entries(out.nextAssigned)) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: `SLOT#${time}#${stationId}`,
      type: "RotationSlot",
      stationId,
      guardId: guardId ?? null,
      time,                // same HH:MM:SS for the frame
      date,
      notes: "rotate-ring+queue",
      updatedAt: writeUpdatedAt, // strictly newer than last frame
    },
  }));
}

// Persist updated queue once (outside the loop!)
await ddb.send(new PutCommand({
  TableName: TABLE,
  Item: {
    pk: `ROTATION#${date}`,
    sk: "QUEUE",
    type: "Queue",
    queue: out.meta.breakQueue,
    updatedAt: writeUpdatedAt,
  },
}));

  res.json({
    assigned: out.nextAssigned,
    breaks: out.nextBreaks,
    conflicts: out.conflicts,
    meta: { period: out.meta.period, breakQueue: out.meta.breakQueue },
    nowISO,
  });
});

// --- Queue helpers -----------------------------------------------------------

const SECTIONS = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);
function sanitizeQueue(
  queue: any[],
  rosterIds: Set<string>,
  currentTick?: number
): QueueRow[] {
  const seen = new Set<string>();
  const out: QueueRow[] = [];
  for (const raw of Array.isArray(queue) ? queue : []) {
    const gid = stripGuard(raw?.guardId);
    const sec = String(raw?.returnTo ?? "");
    const etRaw = (raw as any)?.enteredTick;
    const enteredTick =
      typeof etRaw === "number" && Number.isFinite(etRaw)
        ? etRaw
        : (typeof currentTick === "number" ? currentTick : 0); // default: must wait 1 full tick
    if (!gid || !rosterIds.has(gid)) continue;
    if (!SECTIONS.includes(sec)) continue;
    if (seen.has(gid)) continue;
    seen.add(gid);
    out.push({ guardId: gid, returnTo: sec, enteredTick });
  }
  return out;
}


async function loadQueue(date: string, rosterIds: Set<string>, currentTick?: number) {
  const item = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `ROTATION#${date}`, sk: "QUEUE" },
  }));
  return sanitizeQueue(item.Item?.queue ?? [], rosterIds, currentTick);
}

// Build a coherent "assigned" snapshot from the latest frame (same updatedAt)
async function loadAssignedLatestFrame(date: string) {
  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
    ConsistentRead: true,
  }));
  const slots = (q.Items ?? []).filter(it => it.type === "RotationSlot");
  let latestTickISO: string | null = null;
  for (const it of slots) {
    const u = String(it.updatedAt ?? "");
    if (!u) continue;
    if (!latestTickISO || u > latestTickISO) latestTickISO = u;
  }
  const assigned: Record<string, string | null> =
    Object.fromEntries(POSITIONS.map(p => [p.id, null as string | null]));
  if (latestTickISO) {
    for (const it of slots) {
      if (String(it.updatedAt ?? "") !== latestTickISO) continue;
      const sid = String(it.stationId ?? "");
      if (!sid) continue;
      let gid = it.guardId ?? null;
      if (typeof gid === "string" && gid.startsWith("GUARD#")) gid = gid.slice(6);
      assigned[sid] = gid;
    }
  }
  return assigned;
}

// --- GET /api/plan/queue -----------------------------------------------------
router.get("/queue", async (req, res) => {
  const date = String(req.query?.date || "");
  if (!date) return res.status(400).json({ error: "date required" });

  const guardsScan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
  }));
  const rosterIds = new Set(
    (guardsScan.Items ?? []).map(it =>
      (typeof it.pk === "string" && it.pk.startsWith("GUARD#"))
        ? it.pk.slice(6) : it.id
    )
  );

  const queue = await loadQueue(date, rosterIds);
  res.json({ queue });
});

// --- POST /api/plan/queue-add ------------------------------------------------
router.post("/queue-add", async (req, res) => {
   const date = req.body?.date;
  const guardId = stripGuard(req.body?.guardId);
  const returnTo = String(req.body?.returnTo ?? "");
  if (!date || !guardId || !returnTo) {
    return res.status(400).json({ error: "date, guardId, returnTo required" });
  }
  if (!SECTIONS.includes(returnTo)) {
    return res.status(400).json({ error: `returnTo must be one of ${SECTIONS.join(",")}` });
  }

  // roster
  const guardsScan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
  }));
  const rosterIds = new Set(
    (guardsScan.Items ?? []).map(it =>
      (typeof it.pk === "string" && it.pk.startsWith("GUARD#"))
        ? it.pk.slice(6) : it.id
    )
  );
  if (!rosterIds.has(guardId)) {
    return res.status(404).json({ error: "Unknown guardId" });
  }

  // block adding if seated in the latest frame
  const assigned = await loadAssignedLatestFrame(date);
  const seated = new Set(Object.values(assigned).filter((v): v is string => Boolean(v)));
  if (seated.has(guardId)) {
    const qNow = await loadQueue(date, rosterIds);
    return res.status(409).json({ error: "Guard is already assigned to a seat", queue: qNow });
  }

  // read current queue, dedupe, idempotent add
 
  const nowISO = typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  const qNow = await loadQueue(date, rosterIds, currentTick);
  if (qNow.some(e => e.guardId === guardId)) {
    return res.json({ ok: true, queue: qNow });
  }
  const nextQueue: QueueRow[] = [...qNow, { guardId, returnTo, enteredTick: currentTick }];

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: "QUEUE",
      type: "Queue",
      queue: nextQueue,
      updatedAt: nowISO,
    },
  }));

  res.json({ ok: true, queue: nextQueue });
});

// --- POST /api/plan/queue-clear ---------------------------------------------
router.post("/queue-clear", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: "QUEUE",
      type: "Queue",
      queue: [],
      updatedAt: new Date().toISOString(),
    },
  }));
  res.json({ ok: true, queue: [] });
});


/**
 * POST /api/plan/autopopulate
 * Seed one frame of assignments; no queue.
 */// POST /api/plan/autopopulate — fill seats, plus 1 queued per section
router.post("/autopopulate", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });

  // 🔧 use client-simulated time if provided
  const nowISO = typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const time = nowISO.slice(11, 19);
  const currentTick = tickIndexFromISO(nowISO);

  // ... roster & seats unchanged ...



  // 1) Roster
  const guardsScan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
  }));
  const guards = (guardsScan.Items ?? []).map((it) => ({
    id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : it.id,
    name: it.name,
    dob: it.dob,
  }));
  const guardIds = guards.map(g => g.id);

  // 2) Seats ordered by section then seat index (e.g., 1.1,1.2,1.3,2.1,2.2,...)
  const orderedSeats = [...POSITIONS].sort((a, b) => {
    const [sa, ia] = a.id.split(".");
    const [sb, ib] = b.id.split(".");
    return sa === sb ? Number(ia) - Number(ib) : Number(sa) - Number(sb);
  });

  // 3) Assign first N guards to seats
  const nextAssigned: Record<string, string | null> =
    Object.fromEntries(POSITIONS.map(p => [p.id, null as string | null]));
  const seatCount = orderedSeats.length;
  const seatGuardIds = guardIds.slice(0, seatCount);
  orderedSeats.forEach((p, i) => {
    nextAssigned[p.id] = seatGuardIds[i] ?? null;
  });

  // 4) Build queue: exactly ONE per section from remaining guards
  const SECTIONS = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort(
    (a, b) => Number(a) - Number(b)
  );
  const seatedSet = new Set<string>(seatGuardIds.filter(Boolean));
  const bench = guardIds.filter(id => !seatedSet.has(id));

  // Queue: one per section
  const queue: QueueRow[] = [];
  let bi = 0;
  for (const sec of SECTIONS) {
    if (bi < bench.length) {
      queue.push({ guardId: bench[bi++], returnTo: sec, enteredTick: currentTick });
    }
  }

  // 5) Persist BREAKS (empty), QUEUE, and the SLOT snapshot for every seat
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: "BREAKS",
      type: "Breaks",
      breaks: {},
      updatedAt: nowISO,
    },
  }));

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: "QUEUE",
      type: "Queue",
      queue,
      updatedAt: nowISO,
    },
  }));

  for (const [stationId, guardId] of Object.entries(nextAssigned)) {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: `SLOT#${time}#${stationId}`,
        type: "RotationSlot",
        stationId,
        guardId: guardId ?? null,
        time,
        date,
        notes: "autopopulate-seats+queue(1-per-section)",
        updatedAt: nowISO,
      },
    }));
  }

  // 6) Respond
  res.json({
    assigned: nextAssigned,
    breaks: {},
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: queue },
    nowISO,
  });
});

export default router;
