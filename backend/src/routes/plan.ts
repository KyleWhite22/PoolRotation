/* eslint-disable no-console */
console.log("[routes/plan] LOADED");

import { Router } from "express";
import {
  QueryCommand,
  PutCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { computeNext } from "../engine/rotation.js";
import { POSITIONS, REST_BY_SECTION } from "../../../shared/data/poolLayout.js";

const router = Router();

// ---------- Canonicalization helpers ----------
const stripGuardPrefix = (v: any): string =>
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
    dob: String(it.dob ?? ""), // always string for engine typing
  }));

  const knownIds = new Set(guards.map((g) => g.id));
  const byName = new Map<string, string>();
  for (const g of guards) byName.set(norm(g.name || g.id), g.id);
  return { guards, knownIds, byName };
}

function toId(raw: any, knownIds: Set<string>, byName: Map<string, string>): string | null {
  if (raw == null) return null;
  const s = stripGuardPrefix(raw).trim();
  if (!s) return null;
  if (knownIds.has(s)) return s;
  const m = byName.get(norm(s));
  return m && knownIds.has(m) ? m : null;
}

// ---------- Sections & ticks ----------
const SECTIONS = Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

function tickIndexFromISO(nowISO: string): number {
  return Math.floor(Date.parse(nowISO) / (15 * 60 * 1000));
}

// DB/engine queue row type used in this routes file
type QueueRow = { guardId: string; returnTo: string; enteredTick: number };

// ---------- Common loaders ----------
async function loadAssignedLatestFrame(
  date: string,
  knownIds?: Set<string>,
  byName?: Map<string, string>
) {
  const q = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
      ConsistentRead: true,
    })
  );

  const slots = (q.Items ?? []).filter((it: any) => it.type === "RotationSlot");
  let latestTickISO: string | null = null;
  for (const it of slots) {
    const u = String(it.updatedAt ?? "");
    if (!u) continue;
    if (!latestTickISO || u > latestTickISO) latestTickISO = u;
  }

  const assigned: Record<string, string | null> = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );

  if (latestTickISO) {
    for (const it of slots) {
      if (String(it.updatedAt ?? "") !== latestTickISO) continue;
      const sid = String(it.stationId ?? "");
      if (!sid) continue;
      const canon = toId(it.guardId, knownIds ?? new Set(), byName ?? new Map());
      assigned[sid] = canon; // may be null
    }
  }
  return assigned;
}

function sanitizeQueue(
  queue: any[],
  knownIds: Set<string>,
  byName: Map<string, string>,
  currentTick?: number
): QueueRow[] {
  const coerceTick = (raw: any): number => {
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Math.trunc(parseInt(raw, 10));
    return typeof currentTick === "number" ? currentTick : 0;
  };

  const out: QueueRow[] = [];
  const idxByGuard = new Map<string, number>();

  for (const raw of Array.isArray(queue) ? queue : []) {
    const gid = toId(raw?.guardId, knownIds, byName);
    const sec = String(raw?.returnTo ?? "");
    if (!gid || !knownIds.has(gid)) continue;
    if (!SECTIONS.includes(sec)) continue;

    const tickRaw = coerceTick((raw as any)?.enteredTick);
     const tick = tickRaw;

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

async function loadQueue(
  date: string,
  knownIds: Set<string>,
  byName: Map<string, string>,
  currentTick?: number
) {
  const item = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: `ROTATION#${date}`, sk: "QUEUE" },
      ConsistentRead: true,
    })
  );
  return sanitizeQueue(item.Item?.queue ?? [], knownIds, byName, currentTick);
}

// ============================================================================
// POST /api/plan/rotate
// ============================================================================
router.post("/rotate", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });

  const { guards, knownIds, byName } = await loadGuardMaps();

  // DB latest snapshot vs client snapshot — client wins if it has more filled seats
  const dbAssigned = await loadAssignedLatestFrame(date, knownIds, byName);

  const clientAssignedRaw = (req.body?.assignedSnapshot ?? {}) as Record<
    string,
    string | null | undefined
  >;

  const clientAssigned: Record<string, string | null> = {};
  for (const p of POSITIONS) {
    clientAssigned[p.id] = toId(clientAssignedRaw[p.id], knownIds, byName);
  }

  const countNonNull = (m: Record<string, string | null>) =>
    Object.values(m).reduce((n, v) => n + (v ? 1 : 0), 0);

  const assigned =
    countNonNull(dbAssigned) >= countNonNull(clientAssigned) ? dbAssigned : clientAssigned;

  // Breaks (optional)
  const breaksItem = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: `ROTATION#${date}`, sk: "BREAKS" },
    })
  );
  const breaks = (breaksItem.Item?.breaks ?? {}) as Record<string, string>;

  const nowISO = req.body?.nowISO ?? new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  const queue = await loadQueue(date, knownIds, byName, currentTick);

  const out = computeNext({ assigned, guards, breaks, queue, nowISO });

  // Invariants/logs (dev)
  if (process.env.NODE_ENV !== "production") {
    console.log(
      "[rotate.debug] buckets",
      Object.fromEntries(
        Object.entries(out.meta.queuesBySection).map(([s, arr]) => [
          s,
          arr.map((e) => `${e.guardId}@${e.enteredTick}`),
        ])
      )
    );
    const assignedIn = Object.values(assigned).filter(Boolean).length;
    const assignedOut = Object.values(out.nextAssigned).filter(Boolean).length;
    console.log("[rotate.debug]", {
      period: out.meta.period,
      assignedIn,
      assignedOut,
      queueLen: out.meta.breakQueue.length,
    });
  }

  // Monotonic updatedAt for snapshot writes
  const serverNow = new Date();
  let writeUpdatedAt = serverNow.toISOString();

  // For monotonic check, we need latest write
  const q = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
      ProjectionExpression: "updatedAt, #t",
      ExpressionAttributeNames: { "#t": "type" },
      ConsistentRead: true,
    })
  );
  const frames = (q.Items ?? []).filter((it: any) => it.type === "RotationSlot");
  let latestTickISO: string | null = null;
  for (const it of frames) {
    const u = String(it.updatedAt ?? "");
    if (u && (!latestTickISO || u > latestTickISO)) latestTickISO = u;
  }
  if (latestTickISO && writeUpdatedAt <= latestTickISO) {
    writeUpdatedAt = new Date(new Date(latestTickISO).getTime() + 1).toISOString();
  }
  const time = writeUpdatedAt.slice(11, 19);

  // Persist seats
  for (const [stationId, guardId] of Object.entries(out.nextAssigned)) {
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
          notes: "rotate-ring+queue",
          updatedAt: writeUpdatedAt,
        },
      })
    );
  }

  // Persist updated queue (IDs only)
  const queueToPersist = (out.meta.breakQueue ?? []).map((e: any) => ({
    guardId: String(e.guardId),
    returnTo: String(e.returnTo),
    enteredTick:
      typeof e?.enteredTick === "number" && Number.isFinite(e.enteredTick)
        ? Math.trunc(e.enteredTick)
        : currentTick,
  }));

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: "QUEUE",
        type: "Queue",
        queue: queueToPersist,
        updatedAt: writeUpdatedAt,
      },
    })
  );

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

// ============================================================================
// GET /api/plan/queue
// ============================================================================
router.get("/queue", async (req, res) => {
  const date = String(req.query?.date || "");
  if (!date) return res.status(400).json({ error: "date required" });

  const { knownIds, byName } = await loadGuardMaps();
  const currentTick = tickIndexFromISO(new Date().toISOString());
  const queue = await loadQueue(date, knownIds, byName, currentTick);
  res.json({ queue });
});

// ============================================================================
// POST /api/plan/queue-add
// ============================================================================
router.post("/queue-add", async (req, res) => {
  const date = req.body?.date as string;
  const returnTo = String(req.body?.returnTo ?? "");
  const { knownIds, byName } = await loadGuardMaps();

  const guardId = toId(req.body?.guardId, knownIds, byName);
  if (!date || !guardId || !returnTo) {
    return res.status(400).json({ error: "date, guardId, returnTo required" });
  }
  if (!SECTIONS.includes(returnTo)) {
    return res
      .status(400)
      .json({ error: `returnTo must be one of ${SECTIONS.join(",")}` });
  }

  // reject if seated
  const assigned = await loadAssignedLatestFrame(date, knownIds, byName);
  const seated = new Set(Object.values(assigned).filter((v): v is string => Boolean(v)));
  if (seated.has(guardId)) {
    const qNow = await loadQueue(date, knownIds, byName);
    return res.status(409).json({ error: "Guard is already assigned to a seat", queue: qNow });
  }

  const nowISO =
    typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  const qNow = await loadQueue(date, knownIds, byName, currentTick);
  if (qNow.some((e) => e.guardId === guardId)) {
    return res.json({ ok: true, queue: qNow });
  }

  const nextQueue: QueueRow[] = [...qNow, { guardId, returnTo, enteredTick: currentTick }];

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

  res.json({ ok: true, queue: nextQueue });
});

// ============================================================================
// POST /api/plan/queue-clear
// ============================================================================
router.post("/queue-clear", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `ROTATION#${date}`,
        sk: "QUEUE",
        type: "Queue",
        queue: [],
        updatedAt: new Date().toISOString(),
      },
    })
  );
  res.json({ ok: true, queue: [] });
});

// ============================================================================
// POST /api/plan/queue-set  (atomic replace)
// ============================================================================
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
    // allow legacy buckets shape { "1": [{...}], ... }
    rows = Object.entries(bodyQueue).flatMap(([sec, arr]) =>
      Array.isArray(arr) ? arr.map((r: any) => ({ ...r, returnTo: sec })) : []
    );
  }

  const { knownIds, byName } = await loadGuardMaps();
  const assignedLatest = await loadAssignedLatestFrame(date, knownIds, byName);
  const seated = new Set(Object.values(assignedLatest).filter((v): v is string => Boolean(v)));

  const existing = await loadQueue(date, knownIds, byName, currentTick);
  const existingByGuard = new Map(existing.map((q) => [q.guardId, q.enteredTick]));

  // Keep last occurrence per guard in the provided payload
  const lastIndex = new Map<string, number>();
  rows.forEach((r, i) => {
    const gid = toId(r?.guardId, knownIds, byName) || "";
    if (gid) lastIndex.set(gid, i);
  });

  const coerceTick = (v: any): number => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return Math.trunc(parseInt(v, 10));
    return currentTick;
  };

  const nextQueue: QueueRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const gid = toId(r?.guardId, knownIds, byName);
    const sec = String(r?.returnTo || "");

    if (!gid || !knownIds.has(gid)) continue;
    if (!SECTIONS.includes(sec)) continue;
    if (seated.has(gid)) continue;
    if (lastIndex.get(gid) !== i) continue; // not the last instance

    const preservedTick = existingByGuard.get(gid);
    const enteredTick = preservedTick ?? coerceTick(r?.enteredTick);
    nextQueue.push({ guardId: gid, returnTo: sec, enteredTick });
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

  res.json({ ok: true, queue: nextQueue });
});

// ============================================================================
// POST /api/plan/autopopulate
//  (fills seats; append leftover to queues, IDs only; logs with names for dev)
// ============================================================================
router.post("/autopopulate", async (req, res) => {
  const date = req.body?.date;
  if (!date) return res.status(400).json({ error: "date required" });

  const { guards, knownIds, byName } = await loadGuardMaps();

  const nowISO = typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const time = nowISO.slice(11, 19);
  const currentTick = tickIndexFromISO(nowISO);
  const log = (...xs: any[]) => console.log("[auto]", ...xs);

  const nameById = new Map(guards.map((g) => [g.id, g.name || g.id]));
  const nm = (id?: string | null) => (id ? nameById.get(id) || id : "(none)");

  // Allowed (on-duty or everyone if not supplied)
  let allowedIds: string[] = Array.isArray(req.body?.allowedIds)
    ? (req.body.allowedIds as any[])
        .map((v) => toId(v, knownIds, byName))
        .filter(Boolean) as string[]
    : guards.map((g) => g.id);

  // Seats (client snapshot wins for any provided slot)
  const dbAssigned = await loadAssignedLatestFrame(date, knownIds, byName);
  const rawClient = (req.body?.assignedSnapshot ?? {}) as Record<string, string | null | undefined>;
  const seatsSnapshot: Record<string, string | null> = {};
  for (const p of POSITIONS) {
    const clientVal = toId(rawClient[p.id], knownIds, byName);
    seatsSnapshot[p.id] = clientVal != null ? clientVal : dbAssigned[p.id] ?? null;
  }

  // Existing queue (canonicalize to IDs)
  const existingQueue = await loadQueue(date, knownIds, byName, currentTick);

  // Section seats (ordered)
  const sectionIds = SECTIONS;
  const seatsBySection: Record<string, string[]> = {};
  for (const s of sectionIds) seatsBySection[s] = [];
  for (const p of POSITIONS) seatsBySection[p.id.split(".")[0]].push(p.id);
  for (const s of sectionIds)
    seatsBySection[s].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));

  const restSeatBySection: Record<string, string | null> = {};
  for (const s of sectionIds) restSeatBySection[s] = (REST_BY_SECTION as any)?.[s] ?? null;

  // Age split
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
  const queuedSet = new Set(existingQueue.map((q) => q.guardId));
  const pool = allowedIds.filter((id) => !seatedSet.has(id) && !queuedSet.has(id));

  const minors: string[] = [];
  const adults: string[] = [];
  for (const id of pool) {
    const g = guards.find((x) => x.id === id);
    const age = calcAge(g?.dob ?? "");
    if (age !== null && age <= 15) minors.push(id);
    else adults.push(id);
  }

  const take = (arr: string[]) => (arr.length ? arr.shift()! : null);
  const takeAdult = () => take(adults);
  const takeMinor = () => take(minors);
  const takePrefer = (pref: "adult" | "minor"): { id: string | null; tag: string } => {
    if (pref === "adult") {
      const a = takeAdult();
      return { id: a, tag: a ? "A" : "none" };
    } else {
      const m = takeMinor();
      return { id: m, tag: m ? "M" : "none" };
    }
  };

  // Per-section fill (entry -> middle -> rest -> tail)
  for (const s of sectionIds) {
    const order = seatsBySection[s];
    if (!order.length) continue;

    const entry = order[0];
    const middle = order.length >= 3 ? order[1] : order[order.length - 1];
    const rest = restSeatBySection[s];

    const seatWithPref = (seatId: string | null | undefined, pref: "adult" | "minor", label: string) => {
      if (!seatId) return;
      if (seatsSnapshot[seatId]) return;
      const pick = takePrefer(pref);
      if (pick.id) {
        seatsSnapshot[seatId] = pick.id;
        seatedSet.add(pick.id);
        log(`${label} ${seatId} ← ${nm(pick.id)} [${pick.tag}]`);
      } else {
        log(`${label} ${seatId} ← (none)`);
      }
    };

    seatWithPref(entry, "adult", "entry");
    seatWithPref(middle, "minor", "middle");
    if (rest && rest !== entry && rest !== middle) seatWithPref(rest, "adult", "rest");

    for (const seatId of order) {
      if (seatId === entry || seatId === middle || seatId === rest) continue;
      seatWithPref(seatId, "adult", "tail");
    }
  }

  // Backfill any still empty
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

  // Append leftovers to queues: balance by smallest
  const appended: QueueRow[] = [];
  const qCount = new Map<string, number>();
  for (const s of sectionIds) qCount.set(s, 0);
  for (const q of existingQueue) qCount.set(q.returnTo, (qCount.get(q.returnTo) ?? 0) + 1);

  let rr = currentTick % sectionIds.length;
  const pickSmallest = (): string => {
    let best = sectionIds[rr],
      bestCount = qCount.get(best) ?? 0;
    for (let k = 1; k < sectionIds.length; k++) {
      const s = sectionIds[(rr + k) % sectionIds.length];
      const c = qCount.get(s) ?? 0;
      if (c < bestCount) {
        best = s;
        bestCount = c;
      }
    }
    rr = (rr + 1) % sectionIds.length;
    return best;
  };

  for (const gid of [...minors, ...adults]) {
    if (seatedSet.has(gid) || queuedSet.has(gid)) continue;
    const sec = pickSmallest();
    appended.push({ guardId: gid, returnTo: sec, enteredTick: currentTick });
    qCount.set(sec, (qCount.get(sec) ?? 0) + 1);
  }

  const nextQueue = existingQueue.concat(appended);

  // Persist breaks (empty), seats, queue
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

  for (const [seatId, gid] of Object.entries(seatsSnapshot)) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: `ROTATION#${date}`,
          sk: `SLOT#${time}#${seatId}`,
          type: "RotationSlot",
          stationId: seatId,
          guardId: gid ?? null,
          time,
          date,
          notes: "autopopulate-rest-prefill",
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

  const queuesBySection = Object.fromEntries(
    sectionIds.map((s) => [s, nextQueue.filter((q) => q.returnTo === s)])
  );

  res.json({
    assigned: seatsSnapshot,
    breaks: {},
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: nextQueue, queuesBySection },
    nowISO,
  });
});

export default router;
