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

// ---- Tick helpers (15-min) --------------------------------------------------
function tickIndexFromISO(nowISO: string): number {
  return Math.floor(Date.parse(nowISO) / (15 * 60 * 1000));
}

// DB/engine queue row type used in this routes file
type QueueRow = { guardId: string; returnTo: string; enteredTick: number };

/**
 * POST /api/plan/rotate
 * Body: { date: "YYYY-MM-DD", nowISO?: string, assignedSnapshot?: Record<string,string|null> }
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

  const countNonNull = (m: Record<string, string | null>) =>
    Object.values(m).reduce((n, v) => n + (v ? 1 : 0), 0);

  const clientNormalized: Record<string, string | null> = {};
  for (const [sid, gid] of Object.entries(clientAssigned)) {
    clientNormalized[sid] = gid?.startsWith?.("GUARD#") ? gid.slice(6) : gid ?? null;
  }

  // Prefer DB frame if it has data; otherwise use client snapshot
  const assigned =
    countNonNull(assignedFromDb) >= countNonNull(clientNormalized)
      ? assignedFromDb
      : clientNormalized;
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

  if (process.env.NODE_ENV !== "production") {
    console.log("[rotate.debug] buckets", Object.fromEntries(
      Object.entries(out.meta.queuesBySection).map(([s, arr]) => [s, arr.map(e => `${e.guardId}@${e.enteredTick}`)])
    ));
    const assignedIn = Object.values(assigned).filter(Boolean).length;
    const assignedOut = Object.values(out.nextAssigned).filter(Boolean).length;
    const queueLen = out.meta.breakQueue.length;
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
        time,
        date,
        notes: "rotate-ring+queue",
        updatedAt: writeUpdatedAt,
      },
    }));
  }

  // Persist updated queue once (outside the loop!), coercing enteredTick to number
  const queueToPersist = (out.meta.breakQueue ?? []).map(e => ({
    guardId: String(e.guardId),
    returnTo: String(e.returnTo),
    enteredTick: Number.isFinite((e as any)?.enteredTick)
      ? Math.trunc(Number((e as any).enteredTick))
      : tickIndexFromISO(nowISO),
  }));

  if (process.env.NODE_ENV !== "production") {
    const bad = queueToPersist.filter(q => !Number.isFinite(q.enteredTick));
    if (bad.length) console.warn("[queue.persist] bad enteredTick", bad);
  }

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: "QUEUE",
      type: "Queue",
      queue: queueToPersist,
      updatedAt: writeUpdatedAt,
    },
  }));

  res.json({
    assigned: out.nextAssigned,
    breaks: out.nextBreaks,
    conflicts: out.conflicts,
    meta: {
      period: out.meta.period,
      breakQueue: out.meta.breakQueue,
      queuesBySection: out.meta.queuesBySection,
    },
    nowISO,
  });
});

// --- Queue helpers -----------------------------------------------------------
const SECTIONS = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

/**
 * Coerce `enteredTick` from number OR numeric string.
 * Collapse duplicates per guard (keep earliest tick).
 * Deterministic ordering by tick then guardId.
 */// Keep the LARGEST enteredTick per guard (latest eligibility) so +2 credit survives.
// Coerce numbers or numeric strings; fallback to currentTick only if absent/invalid.
// Keep the LARGEST enteredTick per guard (to preserve +2),
// BUT preserve the original array order exactly as written to DB.
function sanitizeQueue(
  queue: any[],
  rosterIds: Set<string>,
  currentTick?: number
): { guardId: string; returnTo: string; enteredTick: number }[] {
  const coerceTick = (raw: any): number => {
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Math.trunc(parseInt(raw, 10));
    return typeof currentTick === "number" ? currentTick : 0;
  };

  const out: { guardId: string; returnTo: string; enteredTick: number }[] = [];
  const idxByGuard = new Map<string, number>();

  for (const raw of Array.isArray(queue) ? queue : []) {
    const gid = (() => {
      const v = raw?.guardId;
      if (!v) return null;
      const s = String(v);
      return s.startsWith("GUARD#") ? s.slice(6) : s;
    })();
    const sec = String(raw?.returnTo ?? "");
    if (!gid || !rosterIds.has(gid)) continue;
    if (!SECTIONS.includes(sec)) continue;

    const tick = coerceTick((raw as any)?.enteredTick);

    if (idxByGuard.has(gid)) {
      const i = idxByGuard.get(gid)!;
      // Keep later eligibility but DO NOT change position
      if (tick >= out[i].enteredTick) {
        out[i].enteredTick = tick;
        out[i].returnTo = sec; // last write wins on section
      }
    } else {
      idxByGuard.set(gid, out.length);
      out.push({ guardId: gid, returnTo: sec, enteredTick: tick });
    }
  }

  return out; // no sort — preserves per-section order written by the engine
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
  ConsistentRead: true,   // ← important
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
  ConsistentRead: true,   // ← important
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

  // add (idempotent)
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
// routes/plan.ts (or .js)
// POST /api/plan/queue-set  -> replace the whole queue atomically
// routes/plan.ts
router.post("/queue-set", async (req, res) => {
  const date = String(req.body?.date || "");
  if (!date) return res.status(400).json({ error: "date required" });

  const nowISO =
    typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  // ---------- Accept flat or bucketed payload ----------
  type RowIn = { guardId?: any; returnTo?: any; enteredTick?: any };
  const bodyQueue: any = req.body?.queue;

  let rows: RowIn[] = [];
  if (Array.isArray(bodyQueue)) {
    rows = bodyQueue as RowIn[];
  } else if (bodyQueue && typeof bodyQueue === "object") {
    // Treat as { "1": RowIn[], "2": RowIn[] } -> flatten
    rows = Object.entries(bodyQueue).flatMap(([sec, arr]) =>
      Array.isArray(arr) ? arr.map((r: any) => ({ ...r, returnTo: sec })) : []
    );
  }

  // ---------- Roster & valid sections ----------
 const guardsScan = await ddb.send(new ScanCommand({
  TableName: TABLE,
  FilterExpression: "begins_with(pk, :p)",
  ExpressionAttributeValues: { ":p": "GUARD#" },
  ConsistentRead: true,   // ← important
}));
  const rosterIds = new Set(
    (guardsScan.Items ?? []).map(it =>
      (typeof it.pk === "string" && it.pk.startsWith("GUARD#"))
        ? it.pk.slice(6) : it.id
    )
  );
  const SECTIONS = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0])))
    .sort((a,b) => Number(a) - Number(b));

  // ---------- Helpers ----------
  const strip = (s: any) =>
    typeof s === "string" && s.startsWith("GUARD#") ? s.slice(6) : String(s || "");

  const coerceTick = (v: any): number => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return Math.trunc(parseInt(v, 10));
    return currentTick;
  };

  // Skip seated: don't allow a guard who is in a chair to also be queued
  const assignedLatest = await loadAssignedLatestFrame(date);
  const seated = new Set(Object.values(assignedLatest).filter((v): v is string => Boolean(v)));

  // Preserve existing eligibility ticks where possible
  const existing = await loadQueue(date, rosterIds, currentTick);
  const existingByGuard = new Map(existing.map(q => [q.guardId, q.enteredTick]));

  // If the client (briefly) sends the same guard twice during a drag,
  // keep the *last* occurrence (what the user intended after the drop).
  const lastIndex = new Map<string, number>();
  rows.forEach((r, i) => {
    const gid = strip(r?.guardId);
    lastIndex.set(gid, i);
  });

  const nextQueue: { guardId: string; returnTo: string; enteredTick: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const gid = strip(r?.guardId);
    const sec = String(r?.returnTo || "");

    if (!gid || !rosterIds.has(gid)) continue;      // unknown guard
    if (!SECTIONS.includes(sec)) continue;          // invalid section
    if (seated.has(gid)) continue;                  // currently seated -> skip
    if (lastIndex.get(gid) !== i) continue;         // earlier duplicate -> skip

    const preservedTick = existingByGuard.get(gid);
    const enteredTick = preservedTick ?? coerceTick(r?.enteredTick);
    nextQueue.push({ guardId: gid, returnTo: sec, enteredTick });
  }

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


/**
 * POST /api/plan/autopopulate
 * Body: {
 *   date: "YYYY-MM-DD",
 *   nowISO?: string,
 *   allowedIds?: string[]   // <-- on-duty guard IDs; if omitted/empty, falls back to whole roster
 * }
 *
 * Behavior:
 * - Clears (overwrites) BREAKS & QUEUE snapshots.
 * - Seats guards left→right within each section using only allowedIds.
 * - Remaining allowedIds are placed into section queues round-robin 1→2→3→... (repeating).
 */
// --- POST /api/plan/autopopulate (PRESERVE EXISTING SEATS) -------------------
// --- POST /api/plan/autopopulate (PRESERVE EXISTING SEATS) -------------------
// routes/plan.ts
// --- POST /api/plan/autopopulate (preserve seats & queue; append leftovers) ---
router.post("/autopopulate", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });

  const nowISO =
    typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const time = nowISO.slice(11, 19);
  const currentTick = tickIndexFromISO(nowISO);

  // Local helper (avoid conflicting with other strip helpers in this file)
  const stripId = (v: any): string =>
    typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v || "");

  // ---- Roster --------------------------------------------------------------
 const guardsScan = await ddb.send(new ScanCommand({
  TableName: TABLE,
  FilterExpression: "begins_with(pk, :p)",
  ExpressionAttributeValues: { ":p": "GUARD#" },
  ConsistentRead: true,   // ← important
}));

  const guards =
    (guardsScan.Items ?? []).map((it) => ({
      id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : it.id,
      name: it.name,
      dob: it.dob,
    })) ?? [];

  // Allowed (from on-duty picker). If omitted, fall back to full roster.
  let allowedIds: string[] = Array.isArray(req.body?.allowedIds)
    ? (req.body.allowedIds as any[]).map((x) => stripId(x))
    : guards.map((g) => g.id);

  // ---- Load latest DB seats + normalize client snapshot --------------------
  const dbAssigned = await loadAssignedLatestFrame(date); // { seatId: guardId|null }

  const rawClient = (req.body?.assignedSnapshot ?? {}) as Record<
    string,
    string | null | undefined
  >;

  const clientAssigned: Record<string, string | null> = {};
  for (const p of POSITIONS) {
    const v = rawClient[p.id];
    clientAssigned[p.id] = v ? stripId(v) : null;
  }

  // Merge: client takes precedence when set; else DB
  const assignedMerged: Record<string, string | null> = Object.fromEntries(
    POSITIONS.map((p) => [p.id, clientAssigned[p.id] ?? dbAssigned[p.id] ?? null])
  );

  // ---- Load existing queue (authoritative; we will APPEND to it) -----------
  type QueueRow = { guardId: string; returnTo: string; enteredTick: number };

  const queueGet = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: `ROTATION#${date}`, sk: "QUEUE" },
    })
  );

  const existingQueue: QueueRow[] = Array.isArray(queueGet.Item?.queue)
    ? (queueGet.Item!.queue as any[]).map((q) => ({
        guardId: stripId(q.guardId),
        returnTo: String(q.returnTo),
        enteredTick:
          typeof q.enteredTick === "number" && Number.isFinite(q.enteredTick)
            ? Math.trunc(q.enteredTick)
            : currentTick,
      }))
    : [];

  // ---- Preserve seated & queued; fill empty seats; append leftovers --------
  const seatsSnapshot: Record<string, string | null> = { ...assignedMerged };

  const seatedSet = new Set(
    Object.values(seatsSnapshot).filter((v): v is string => Boolean(v))
  );
  const queuedSet = new Set(existingQueue.map((q) => q.guardId));

  // Candidates to place in seats: allowed minus (already seated OR already queued)
  const seatCandidates = allowedIds.filter((id) => !seatedSet.has(id) && !queuedSet.has(id));

  // Fill empty seats left→right
  const orderedSeats = [...POSITIONS].sort((a, b) => {
    const [sa, ia] = a.id.split(".");
    const [sb, ib] = b.id.split(".");
    return sa === sb ? Number(ia) - Number(ib) : Number(sa) - Number(sb);
  });

  for (const seat of orderedSeats) {
    if (seatsSnapshot[seat.id]) continue; // keep existing seat
    const gid = seatCandidates.shift();
    if (!gid) break;
    seatsSnapshot[seat.id] = gid;
    seatedSet.add(gid);
  }

  // Any remaining allowedIds not seated and not already queued → append to queue
  const remainingForQueue = allowedIds.filter(
    (id) => !seatedSet.has(id) && !queuedSet.has(id)
  );

  // Distribute new queue rows round-robin by section, preserving existingQueue order
  const SECTIONS_LOCAL = Array.from(
    new Set(POSITIONS.map((p) => p.id.split(".")[0]))
  ).sort((a, b) => Number(a) - Number(b));

  const appended: QueueRow[] = [];
  for (let i = 0; i < remainingForQueue.length; i++) {
    const gid = remainingForQueue[i];
    const sec = SECTIONS_LOCAL[i % SECTIONS_LOCAL.length];
    appended.push({ guardId: gid, returnTo: sec, enteredTick: currentTick });
  }

  const nextQueue = existingQueue.concat(appended);

  // ---- Persist seats & updated queue ---------------------------------------
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: "BREAKS",
        type: "Breaks",
        breaks: {},
        updatedAt: nowISO,
      },
    })
  );

  for (const [stationId, guardId] of Object.entries(seatsSnapshot)) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `ROTATION#${date}`,
          sk: `SLOT#${time}#${stationId}`,
          type: "RotationSlot",
          stationId,
          guardId: guardId ?? null,
          time,
          date,
          notes: "autopopulate-append-queue",
          updatedAt: nowISO,
        },
      })
    );
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: "QUEUE",
        type: "Queue",
        queue: nextQueue,
        updatedAt: nowISO,
      },
    })
  );

  // ---- Response (queuesBySection for UI) -----------------------------------
  const queuesBySection = Object.fromEntries(
    SECTIONS_LOCAL.map((s) => [s, nextQueue.filter((q) => q.returnTo === s)])
  );

  res.json({
    assigned: seatsSnapshot,
    breaks: {},
    conflicts: [],
    meta: {
      period: "ALL_AGES",
      breakQueue: nextQueue,
      queuesBySection,
    },
    nowISO,
  });
});

export default router;
