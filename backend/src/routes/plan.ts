/* eslint-disable no-console */
console.log("[routes/plan] LOADED");
import { Router } from "express";
import { QueryCommand, PutCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { computeNext } from "../engine/rotation.js";
import { POSITIONS, REST_BY_SECTION } from "../../../shared/data/poolLayout.js";

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
    ConsistentRead: true,
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

  // 5) MONOTONIC WRITE TIMESTAMP
  const serverNow = new Date();
  let writeUpdatedAt = serverNow.toISOString();
  if (latestTickISO && writeUpdatedAt <= latestTickISO) {
    writeUpdatedAt = new Date(new Date(latestTickISO).getTime() + 1).toISOString();
  }
  const time = writeUpdatedAt.slice(11, 19);

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

  // Persist updated queue once
  const queueToPersist = (out.meta.breakQueue ?? []).map(e => ({
    guardId: String(e.guardId),
    returnTo: String(e.returnTo),
    enteredTick: Number.isFinite((e as any)?.enteredTick)
      ? Math.trunc(Number((e as any).enteredTick))
      : tickIndexFromISO(nowISO),
  }));

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
    conflicts: out.conflicts, // includes AGE_RULE if enforcement couldn’t fully satisfy
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
      if (tick >= out[i].enteredTick) {
        out[i].enteredTick = tick;
        out[i].returnTo = sec;
      }
    } else {
      idxByGuard.set(gid, out.length);
      out.push({ guardId: gid, returnTo: sec, enteredTick: tick });
    }
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
    ConsistentRead: true,
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

  const guardsScan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
    ConsistentRead: true,
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

  const assigned = await loadAssignedLatestFrame(date);
  const seated = new Set(Object.values(assigned).filter((v): v is string => Boolean(v)));
  if (seated.has(guardId)) {
    const qNow = await loadQueue(date, rosterIds);
    return res.status(409).json({ error: "Guard is already assigned to a seat", queue: qNow });
  }

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

// --- POST /api/plan/queue-set  (atomic replace) ------------------------------
router.post("/queue-set", async (req, res) => {
  const date = String(req.body?.date || "");
  if (!date) return res.status(400).json({ error: "date required" });

  const nowISO =
    typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  type RowIn = { guardId?: any; returnTo?: any; enteredTick?: any };
  const bodyQueue: any = req.body?.queue;

  let rows: RowIn[] = [];
  if (Array.isArray(bodyQueue)) {
    rows = bodyQueue as RowIn[];
  } else if (bodyQueue && typeof bodyQueue === "object") {
    rows = Object.entries(bodyQueue).flatMap(([sec, arr]) =>
      Array.isArray(arr) ? arr.map((r: any) => ({ ...r, returnTo: sec })) : []
    );
  }

  const guardsScan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
    ConsistentRead: true,
  }));
  const rosterIds = new Set(
    (guardsScan.Items ?? []).map(it =>
      (typeof it.pk === "string" && it.pk.startsWith("GUARD#"))
        ? it.pk.slice(6) : it.id
    )
  );
  const SECTIONS_LOCAL = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0])))
    .sort((a,b) => Number(a) - Number(b));

  const strip = (s: any) =>
    typeof s === "string" && s.startsWith("GUARD#") ? s.slice(6) : String(s || "");

  const coerceTick = (v: any): number => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return Math.trunc(parseInt(v, 10));
    return currentTick;
  };

  const assignedLatest = await loadAssignedLatestFrame(date);
  const seated = new Set(Object.values(assignedLatest).filter((v): v is string => Boolean(v)));

  const existing = await loadQueue(date, rosterIds, currentTick);
  const existingByGuard = new Map(existing.map(q => [q.guardId, q.enteredTick]));

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

    if (!gid || !rosterIds.has(gid)) continue;
    if (!SECTIONS_LOCAL.includes(sec)) continue;
    if (seated.has(gid)) continue;
    if (lastIndex.get(gid) !== i) continue;

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
// --- POST /api/plan/autopopulate (level-by-level fill; fills all seats if possible; name-based logs) ---
// --- POST /api/plan/autopopulate (rest chairs filled during kids swim; name logs) ---
router.post("/autopopulate", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });

  const nowISO = typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const time = nowISO.slice(11, 19);
  const currentTick = Math.floor(Date.parse(nowISO) / (15 * 60 * 1000));
  const stripId = (v: any): string =>
    typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v || "");

  const log = (...xs: any[]) => console.log("[auto]", ...xs);
  console.log("========== [/api/plan/autopopulate] ==========");
  log("date:", date, "nowISO:", nowISO, "time:", time, "tick:", currentTick);

  // ----- Roster -----
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" },
    ConsistentRead: true,
  }));
  const guards = (scan.Items ?? []).map((it) => ({
    id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : it.id,
    name: it.name,
    dob: it.dob,
  })) as { id: string; name?: string; dob?: string }[];
  const nameById = new Map(guards.map(g => [g.id, g.name || g.id]));
  const nm = (id?: string | null) => (id ? nameById.get(id) || id : "(none)");
  log("roster size:", guards.length);

  // Allowed (on-duty)
  let allowedIds: string[] = Array.isArray(req.body?.allowedIds)
    ? (req.body.allowedIds as any[]).map(stripId)
    : guards.map(g => g.id);
  log("allowed:", allowedIds.map(nm));

  // ----- Seats (DB + optional client snapshot; client wins) -----
  const dbAssigned = await loadAssignedLatestFrame(date); // { seatId: guardId|null }
  const rawClient = (req.body?.assignedSnapshot ?? {}) as Record<string, string | null | undefined>;
  const clientAssigned: Record<string, string | null> = {};
  for (const p of POSITIONS) clientAssigned[p.id] = rawClient[p.id] ? stripId(rawClient[p.id]) : null;

  const seatsSnapshot: Record<string, string | null> =
    Object.fromEntries(POSITIONS.map(p => [p.id, clientAssigned[p.id] ?? dbAssigned[p.id] ?? null]));

  // ----- Existing queue -----
  type QueueRow = { guardId: string; returnTo: string; enteredTick: number };
  const qGet = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `ROTATION#${date}`, sk: "QUEUE" } }));
  const existingQueue: QueueRow[] = Array.isArray(qGet.Item?.queue)
    ? (qGet.Item!.queue as any[]).map(q => ({
        guardId: stripId(q.guardId),
        returnTo: String(q.returnTo),
        enteredTick:
          typeof q.enteredTick === "number" && Number.isFinite(q.enteredTick)
            ? Math.trunc(q.enteredTick)
            : currentTick,
      }))
    : [];
  log("existingQueue len:", existingQueue.length);

  // ----- Sections & seat order -----
  const sectionIds = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort((a,b)=>Number(a)-Number(b));
  const seatsBySection: Record<string, string[]> = {};
  for (const s of sectionIds) seatsBySection[s] = [];
  for (const p of POSITIONS) seatsBySection[p.id.split(".")[0]].push(p.id);
  for (const s of sectionIds) seatsBySection[s].sort((a,b)=>Number(a.split(".")[1])-Number(b.split(".")[1]));

  const restSeatBySection: Record<string, string | null> = {};
  for (const s of sectionIds) restSeatBySection[s] = (REST_BY_SECTION as any)?.[s] ?? null;

  // ----- Adults vs Minors (<= 15) -----
  const calcAge = (dob?: string | null): number | null => {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const now = new Date(nowISO);
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
  };

  const seatedSet = new Set(Object.values(seatsSnapshot).filter((v): v is string => Boolean(v)));
  const queuedSet = new Set(existingQueue.map(q => q.guardId));

  const pool = allowedIds.filter(id => !seatedSet.has(id) && !queuedSet.has(id));
  const minors: string[] = [];
  const adults: string[] = [];
  for (const id of pool) {
    const g = guards.find(x => x.id === id);
    const age = calcAge(g?.dob ?? null);
    if (age !== null && age <= 15) minors.push(id); else adults.push(id);
  }
  log("adults:", adults.map(nm), "minors:", minors.map(nm), "sections:", sectionIds);

  const takeAdult = (): string | null => { const x = adults.shift() ?? null; log("takeAdult →", nm(x)); return x; };
  const takeMinor = (): string | null => { const x = minors.shift() ?? null; log("takeMinor →", nm(x)); return x; };
  const takePrefer = (pref: "adult" | "minor"): { id: string | null; tag: string } => {
    if (pref === "adult") {
      const a = takeAdult(); if (a) return { id: a, tag: "A" };
      const m = takeMinor(); return { id: m, tag: m ? "M (fallback)" : "none" };
    } else {
      const m = takeMinor(); if (m) return { id: m, tag: "M" };
      const a = takeAdult(); return { id: a, tag: a ? "A (fallback)" : "none" };
    }
  };

  // ----- Per-section fill: entry A → rest A → second M → remaining A -----
 for (const s of sectionIds) {
  const order = seatsBySection[s]; // includes rest (if any), sorted left→right
  if (!order.length) continue;

  // Identify physical positions
  const entry = order[0];
  const middle = order.length >= 3 ? order[1] : order[order.length - 1]; // if 2 seats, "middle" is the second
  const rest = restSeatBySection[s];

  const seatWithPref = (seatId: string | null | undefined, pref: "adult" | "minor", label: string) => {
    if (!seatId) return;
    if (seatsSnapshot[seatId]) return; // preserve existing
    const pick = takePrefer(pref);      // logs which list it came from
    if (pick.id) {
      seatsSnapshot[seatId] = pick.id;
      seatedSet.add(pick.id);
      log(`${label} ${seatId} ← ${nm(pick.id)} [${pick.tag}]`);
    } else {
      log(`${label} ${seatId} ← (none)`);
    }
  };

  // 1) Entry gets an Adult (fallback Minor)
  seatWithPref(entry, "adult", "entry");

  // 2) Middle gets a Minor (fallback Adult) — even if the middle happens to be the rest chair
  seatWithPref(middle, "minor", "middle");

  // 3) Rest gets an Adult *if not already filled by step 2*
  if (rest && rest !== entry && rest !== middle) {
    seatWithPref(rest, "adult", "rest");
  }

  // 4) Remaining tail seats → Adults
  for (const seatId of order) {
    if (seatId === entry || seatId === middle || seatId === rest) continue;
    seatWithPref(seatId, "adult", "tail");
  }
}

  // Backfill any still-empty seats (prefer adult, fallback minor)
  for (const s of sectionIds) {
    for (const seatId of seatsBySection[s]) {
      if (!seatsSnapshot[seatId]) {
        const pick = takePrefer("adult");
        if (pick.id) {
          seatsSnapshot[seatId] = pick.id;
          seatedSet.add(pick.id);
          log(`backfill ${seatId} ← ${nm(pick.id)} [${pick.tag}]`);
        }
      }
    }
  }

  // Debug snapshots
  const byWatch: Record<string, string[]> = {};
  for (const s of sectionIds) {
    byWatch[s] = seatsBySection[s].map(seat => seatsSnapshot[seat]).filter(Boolean).map(nm) as string[];
  }
  log("seated snapshot (all seats):", byWatch);

  // ----- Balance leftover → queues (minors first, then adults) -----
  const appendOrder = [...minors, ...adults];
  const qCount = new Map<string, number>();
  for (const s of sectionIds) qCount.set(s, 0);
  for (const q of existingQueue) qCount.set(q.returnTo, (qCount.get(q.returnTo) ?? 0) + 1);

  const snapshot = () => Object.fromEntries(sectionIds.map(s => [s, qCount.get(s) ?? 0]));
  let rr = currentTick % sectionIds.length;   // rotate tie-break start
  const pickSmallest = (): string => {
    let best = sectionIds[rr], bestCount = qCount.get(best) ?? 0;
    for (let k = 1; k < sectionIds.length; k++) {
      const s = sectionIds[(rr + k) % sectionIds.length];
      const c = qCount.get(s) ?? 0;
      if (c < bestCount) { best = s; bestCount = c; }
    }
    rr = (rr + 1) % sectionIds.length;
    return best;
  };

  const appended: QueueRow[] = [];
  for (const gid of appendOrder) {
    if (seatedSet.has(gid) || queuedSet.has(gid)) continue;
    const sec = pickSmallest();
    appended.push({ guardId: gid, returnTo: sec, enteredTick: currentTick });
    qCount.set(sec, (qCount.get(sec) ?? 0) + 1);
    log(`append ${nm(gid)} → ${sec}; qSizes:`, snapshot());
  }

  const nextQueue = existingQueue.concat(appended);
  log("appended to queues:", appended.map(a => `${nm(a.guardId)}→${a.returnTo}`));
  log("queuesBySection sizes:", snapshot());

  // ----- Persist -----
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: `ROTATION#${date}`, sk: "BREAKS", type: "Breaks", breaks: {}, updatedAt: nowISO },
  }));

  let seatWrites = 0;
  for (const [seatId, gid] of Object.entries(seatsSnapshot)) {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: `SLOT#${time}#${seatId}`,
        type: "RotationSlot",
        stationId: seatId,
        guardId: gid ?? null,
        time, date,
        notes: "autopopulate-kidsswim-rest-filled",
        updatedAt: nowISO,
      },
    }));
    seatWrites++;
  }

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: `ROTATION#${date}`, sk: "QUEUE", type: "Queue", queue: nextQueue, updatedAt: nowISO },
  }));

  log("persisted seat rows:", seatWrites);
  log("persisted queue rows:", appended.length);
  log("DONE. Seats:", byWatch);
  log("DONE. Queue sizes:", snapshot());

  const queuesBySection = Object.fromEntries(sectionIds.map(s => [s, nextQueue.filter(q => q.returnTo === s)]));

  res.json({
    assigned: seatsSnapshot,
    breaks: {},
    conflicts: [],         // indicate later if rotation creates adjacency conflicts; don’t fix here
    meta: { period: "ALL_AGES", breakQueue: nextQueue, queuesBySection },
    nowISO,
  });
});




export default router;
