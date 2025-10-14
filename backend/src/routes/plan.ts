
// src/routes/plan.ts
console.log("[routes/plan] LOADED");

import { Router } from "express";
import {
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { computeNext } from "../engine/rotation.js";
import { POSITIONS, REST_BY_SECTION } from "../data/poolLayout.js";

// 🔑 per-instance state helpers
import { getState, putState, type RotationState } from "../rotation/store";
import { rotationKey } from "../rotation/rotationKey";
import crypto from "node:crypto";

// env
const SANDBOX_TTL_SECS = Number(process.env.SANDBOX_TTL_DAYS || 7) * 24 * 3600;

const router = Router();
router.get("/_ping", (_req, res) => res.json({ ok: true, router: "plan" }));

// Build key (used only for reference/logs)
const keyFor = (req: any, date: string) => rotationKey(date, req.sandboxInstanceId);

// ---------- Canonicalization helpers ----------
const stripGuardPrefix = (v: any): string =>
  typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v || "");

const norm = (s: string) => s.normalize?.("NFKC").toLowerCase().trim();
const strip = (s?: any) => String(s ?? "").trim().replace(/^GUARD#/, "");
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

// Guards/known-ids map
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
    dob: String(it.dob ?? ""), // keep string for engine typing
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

// ✅ Loose resolver: allow new UUIDs as IDs and name->ID mapping
function toIdLoose(raw: any, knownIds: Set<string>, byName: Map<string, string>): string | null {
  const s = strip(raw);
  if (!s) return null;
  if (knownIds.has(s)) return s; // known
  if (isUuid(s)) return s; // brand-new UUID
  const mapped = byName.get(norm(s) || "");
  if (!mapped) return null;
  if (knownIds.has(mapped) || isUuid(mapped)) return mapped;
  return null;
}

// ---------- Sections & ticks ----------
const SECTIONS = Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

function tickIndexFromISO(nowISO: string): number {
  return Math.floor(Date.parse(nowISO) / (15 * 60 * 1000));
}

// DB/engine queue row type used here
type QueueRow = { guardId: string; returnTo: string; enteredTick: number };

/** Helpers that now read/write the single per-instance STATE row **/
async function readAssigned(req: any, date: string): Promise<Record<string, string | null>> {
  const state = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  const assigned: Record<string, string | null> = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );
  Object.assign(assigned, state.assigned || {});
  return assigned;
}
async function readQueue(req: any, date: string): Promise<QueueRow[]> {
  const state = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  return Array.isArray(state.queue) ? state.queue.map(q => ({
    guardId: String(q.guardId),
    returnTo: String(q.returnTo),
    enteredTick: Number.isFinite(q.enteredTick) ? Math.trunc(q.enteredTick) : 0,
  })) : [];
}

// ============================================================================
// POST /api/plan/rotate  (per-instance)
// ============================================================================
router.post("/rotate", async (req: any, res) => {
  const date = req.body?.date as string;
  if (!date) return res.status(400).json({ error: "date required" });

  const { guards, knownIds, byName } = await loadGuardMaps();

  // normalize incoming client snapshot vs server snapshot
  const dbAssigned = await readAssigned(req, date);

  const clientAssignedRaw = (req.body?.assignedSnapshot ?? {}) as Record<
    string,
    string | null | undefined
  >;
  const clientAssigned: Record<string, string | null> = {};
  for (const p of POSITIONS) {
    clientAssigned[p.id] = toIdLoose(clientAssignedRaw[p.id], knownIds, byName);
  }

  const countNonNull = (m: Record<string, string | null>) =>
    Object.values(m).reduce((n, v) => n + (v ? 1 : 0), 0);

  const assigned =
    countNonNull(dbAssigned) >= countNonNull(clientAssigned) ? dbAssigned : clientAssigned;

  const nowISO =
    typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  const queue = await readQueue(req, date);

  // Compute next using your engine
  const out = computeNext({ assigned, guards, breaks: {}, queue, nowISO });

  // Build next per-instance state
  const current = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  const next: RotationState = {
    ...current,
    assigned: out.nextAssigned,
    queue: (out.meta?.breakQueue ?? []).map((e: any) => ({
      guardId: String(e.guardId),
      returnTo: String(e.returnTo),
      enteredTick:
        typeof e?.enteredTick === "number" && Number.isFinite(e.enteredTick)
          ? Math.trunc(e.enteredTick)
          : currentTick,
    })),
    breaks: out.nextBreaks || {},
    conflicts: Array.isArray(out.conflicts) ? out.conflicts : [],
    tick: (current.tick ?? 0) + 1,
    updatedAt: {
      ...(current.updatedAt || {}),
      // optionally stamp each seat touched; here we just stamp the write time per seat
      ...Object.fromEntries(Object.keys(out.nextAssigned).map((sid) => [sid, nowISO])),
    },
    rev: (current.rev ?? 0) + 1,
  };

  const saved = await putState(ddb as any, TABLE, date, req.sandboxInstanceId, next, {
    ttlSeconds: req.sandboxInstanceId ? SANDBOX_TTL_SECS : undefined,
  });

  res.json({
    assigned: saved.assigned,
    breaks: saved.breaks,
    conflicts: saved.conflicts,
    meta: { period: out.meta?.period ?? "UNKNOWN", breakQueue: saved.queue },
    nowISO,
  });
});

// ============================================================================
// GET /api/plan/queue  (per-instance)
// ============================================================================
router.get("/queue", async (req: any, res) => {
  const date = String(req.query?.date || "");
  if (!date) return res.status(400).json({ error: "date required" });
  const q = await readQueue(req, date);
  res.json({ queue: q });
});

// ============================================================================
// POST /api/plan/queue-add  (per-instance)
// ============================================================================
router.post("/queue-add", async (req: any, res) => {
  const date = req.body?.date as string;
  const returnTo = String(req.body?.returnTo ?? "");
  if (!date || !returnTo) {
    return res.status(400).json({ error: "date, returnTo required" });
  }
  if (!SECTIONS.includes(returnTo)) {
    return res.status(400).json({ error: `returnTo must be one of ${SECTIONS.join(",")}` });
  }

  const { knownIds, byName } = await loadGuardMaps();
  const guardId = toId(req.body?.guardId, knownIds, byName);
  if (!guardId) {
    return res.status(400).json({ error: "guardId invalid" });
  }

  // reject if seated
  const assigned = await readAssigned(req, date);
  const seated = new Set(Object.values(assigned).filter((v): v is string => Boolean(v)));
  if (seated.has(guardId)) {
    const qNow = await readQueue(req, date);
    return res.status(409).json({ error: "Guard is already assigned to a seat", queue: qNow });
  }

  const nowISO =
    typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const currentTick = tickIndexFromISO(nowISO);

  // load & append if not exists
  const current = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  const existing = Array.isArray(current.queue) ? current.queue : [];
  if (existing.some((e) => e.guardId === guardId)) {
    return res.json({ ok: true, queue: existing });
  }

  const next: RotationState = {
    ...current,
    queue: [...existing, { guardId, returnTo, enteredTick: currentTick }],
    rev: (current.rev ?? 0) + 1,
  };

  const saved = await putState(ddb as any, TABLE, date, req.sandboxInstanceId, next, {
    ttlSeconds: req.sandboxInstanceId ? SANDBOX_TTL_SECS : undefined,
  });

  res.json({ ok: true, queue: saved.queue || [] });
});

// ============================================================================
// POST /api/plan/queue-clear  (per-instance)
// ============================================================================
router.post("/queue-clear", async (req: any, res) => {
  const date = req.body?.date as string;
  if (!date) return res.status(400).json({ error: "date required" });

  const current = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  const next: RotationState = { ...current, queue: [], rev: (current.rev ?? 0) + 1 };

  const saved = await putState(ddb as any, TABLE, date, req.sandboxInstanceId, next, {
    ttlSeconds: req.sandboxInstanceId ? SANDBOX_TTL_SECS : undefined,
  });

  res.json({ ok: true, queue: saved.queue || [] });
});

// ============================================================================
// POST /api/plan/queue-set (atomic replace, per-instance)
// ============================================================================
router.post("/queue-set", async (req: any, res) => {
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
  const assignedLatest = await readAssigned(req, date);
  const seated = new Set(Object.values(assignedLatest).filter((v): v is string => Boolean(v)));

  const current = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  const existing = Array.isArray(current.queue) ? current.queue : [];
  const existingByGuard = new Map(existing.map((q) => [q.guardId, q.enteredTick]));

  // Keep last occurrence per guard in payload
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

    if (!gid || (!knownIds.has(gid) && !isUuid(gid))) continue;
    if (!SECTIONS.includes(sec)) continue;
    if (seated.has(gid)) continue;
    if (lastIndex.get(gid) !== i) continue; // keep only last instance

    const preservedTick = existingByGuard.get(gid);
    const enteredTick = preservedTick ?? coerceTick(r?.enteredTick);
    nextQueue.push({ guardId: gid, returnTo: sec, enteredTick });
  }

  const next: RotationState = {
    ...current,
    queue: nextQueue,
    rev: (current.rev ?? 0) + 1,
  };

  const saved = await putState(ddb as any, TABLE, date, req.sandboxInstanceId, next, {
    ttlSeconds: req.sandboxInstanceId ? SANDBOX_TTL_SECS : undefined,
  });

  res.json({ ok: true, queue: saved.queue || [] });
});
// String -> 32-bit seed
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// Simple fast PRNG (mulberry32)
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Fisher–Yates with injectable RNG
function shuffleInPlace<T>(arr: T[], rnd: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ============================================================================
// POST /api/plan/autopopulate  (per-instance)
//  fills seats; appends leftovers to queues; prefers adults/minors by seat
// ============================================================================
router.post("/autopopulate", async (req: any, res) => {
  const date = req.body?.date as string;
  if (!date) return res.status(400).json({ error: "date required" });

  const { guards, knownIds, byName } = await loadGuardMaps();

  const nowISO = typeof req.body?.nowISO === "string" ? req.body.nowISO : new Date().toISOString();
  const time = nowISO.slice(11, 19);
  const currentTick = tickIndexFromISO(nowISO);

  // Allowed (on-duty set or everyone if missing)
  const rawAllowed = Array.isArray(req.body?.allowedIds)
    ? (req.body.allowedIds as any[])
    : guards.map((g) => g.id);
  const allowedIds: string[] = rawAllowed
    .map((v) => toIdLoose(v, knownIds, byName))
    .filter(Boolean) as string[];
const seedBuf = crypto.randomBytes(4);
const seed = seedBuf.readUInt32LE(0);
const rnd = mulberry32(seed);
  // Seats: client snapshot wins if provided; fallback to server
  const serverAssigned = await readAssigned(req, date);
  const rawClient = (req.body?.assignedSnapshot ?? {}) as Record<
    string,
    string | null | undefined
  >;
  const seatsSnapshot: Record<string, string | null> = {};
  for (const p of POSITIONS) {
    const clientVal = toIdLoose(rawClient[p.id], knownIds, byName);
    seatsSnapshot[p.id] = clientVal != null ? clientVal : serverAssigned[p.id] ?? null;
  }

  // Existing queue
  const existingQueue = await readQueue(req, date);

  // Section seat ordering
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

  const nameById = new Map(guards.map((g) => [g.id, g.name || g.id]));
  const nm = (id?: string | null) => (id ? nameById.get(id) || id : "(none)");

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
shuffleInPlace(minors, rnd);
shuffleInPlace(adults, rnd);
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
        console.log(`[auto] ${label} ${seatId} ← ${nm(pick.id)} [${pick.tag}]`);
      } else {
        console.log(`[auto] ${label} ${seatId} ← (none)`);
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
          console.log(`[auto] backfill ${seatId} ← ${nm(pick.id)} [${pick.tag}]`);
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

  // Persist single STATE row
  const current = await getState(ddb as any, TABLE, date, req.sandboxInstanceId);
  const next: RotationState = {
    ...current,
    assigned: seatsSnapshot,
    queue: nextQueue,
    breaks: {}, // you can wire real breaks here later
    conflicts: [],
    tick: (current.tick ?? 0) + 1,
    updatedAt: {
      ...(current.updatedAt || {}),
      ...Object.fromEntries(Object.keys(seatsSnapshot).map((sid) => [sid, nowISO])),
    },
    rev: (current.rev ?? 0) + 1,
  };

  const saved = await putState(ddb as any, TABLE, date, req.sandboxInstanceId, next, {
    ttlSeconds: req.sandboxInstanceId ? SANDBOX_TTL_SECS : undefined,
  });

  const queuesBySection = Object.fromEntries(
    sectionIds.map((s) => [s, (saved.queue || []).filter((q) => q.returnTo === s)])
  );

  res.json({
    assigned: saved.assigned,
    breaks: saved.breaks || {},
    conflicts: saved.conflicts || [],
    meta: { period: "ALL_AGES", breakQueue: saved.queue || [], queuesBySection },
    nowISO,
  });
});

export default router;
