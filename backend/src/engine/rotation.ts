// engine/rotation.ts
console.log("[engine/rotation] LOADED");
import { POSITIONS, REST_BY_SECTION } from "../../../shared/data/poolLayout.js";

export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type BreakState = Record<string, string>;
export type QueueEntry = { guardId: string; returnTo: string; enteredTick: number };
export type Conflict = { stationId: string; reason: "AGE_RULE"; guardId: string };

export type EngineOutput = {
  nextAssigned: Assigned;
  nextBreaks: BreakState;
  conflicts: Conflict[];
  meta: {
    period: "ALL_AGES" | "ADULT_SWIM";
    breakQueue: QueueEntry[];
    queuesBySection: Record<string, QueueEntry[]>;
  };
};

// -------- layout helpers --------
const SECTIONS = Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

const seatsBySection: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const s of SECTIONS) m[s] = [];
  for (const p of POSITIONS) {
    const [sec] = p.id.split(".");
    m[sec].push(p.id);
  }
  for (const s of SECTIONS) m[s].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
  return m;
})();

const restChairBySection: Record<string, string | null> = (() => {
  const m: Record<string, string | null> = {};
  for (const s of SECTIONS) {
    const v = (REST_BY_SECTION as any)?.[s];
    m[s] = typeof v === "string" ? v : null;
  }
  return m;
})();

const firstSeatBySection: Record<string, string> =
  Object.fromEntries(SECTIONS.map((s) => [s, seatsBySection[s][0]]));

const lastSeatSet = new Set<string>(
  SECTIONS.map((s) => seatsBySection[s][seatsBySection[s].length - 1])
);

const sectionBySeat: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const s of SECTIONS) for (const seat of seatsBySection[s]) m[seat] = s;
  return m;
})();

// -------- time helpers --------
function nextSectionId(sec: string): string {
  const i = SECTIONS.indexOf(sec);
  return SECTIONS[(i + 1) % SECTIONS.length];
}
function tickIndexFromISO(nowISO: string): number {
  return Math.floor(Date.parse(nowISO) / (15 * 60 * 1000)); // 15-min ticks
}
function minuteOfHourNY(nowISO: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      minute: "2-digit",
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowISO));
    const m = parts.find((p) => p.type === "minute")?.value;
    return m ? parseInt(m, 10) : new Date(nowISO).getMinutes();
  } catch {
    return new Date(nowISO).getMinutes();
  }
}
function isAdultSwimFromISO(nowISO: string): boolean {
  return minuteOfHourNY(nowISO) === 45;
}

// -------- eligibility helpers --------
const isEligibleAtOrSame = (entry: QueueEntry, tick: number) => entry.enteredTick <= tick;
const isEligNow = (e: QueueEntry, tick: number, seatedThisTick: Set<string>) =>
  e.enteredTick <= tick && !seatedThisTick.has(e.guardId);

// -------- validation helper --------
function validateNoGuardLoss(
  beforeSeated: string[],
  beforeQueued: string[],
  afterSeated: string[],
  afterQueued: string[],
  context: string
) {
  const beforeTotal = new Set([...beforeSeated, ...beforeQueued]);
  const afterTotal = new Set([...afterSeated, ...afterQueued]);

  const lost = [...beforeTotal].filter((id) => !afterTotal.has(id));
  const gained = [...afterTotal].filter((id) => !beforeTotal.has(id));

  if (lost.length > 0) {
    console.error(`[${context}] GUARDS LOST:`, lost);
  }
  if (gained.length > 0) {
    console.warn(`[${context}] GUARDS GAINED:`, gained);
  }
  if (afterTotal.size !== beforeTotal.size) {
    console.error(`[${context}] Total count mismatch: ${beforeTotal.size} → ${afterTotal.size}`);
  }

  return lost.length === 0 && gained.length === 0;
}

/**
 * Adult-swim (:45) step:
 * - Clear seats
 * - Last-seat guards → NEXT section with +1 tick (15 min) credit
 * - Others → CURRENT section queue (enteredTick = currentTick)
 * - Seat next eligible into rest chairs
 */
function tickAdultSwim(
  assignedBefore: Assigned,
  qBuckets: Record<string, QueueEntry[]>,
  currentTick: number
) {
  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );

  // Collect new queue entries first (don't mutate buckets while reading)
  const toAddToQueue: QueueEntry[] = [];

  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    const lastSeat = seats[seats.length - 1];

    for (const seat of seats) {
      const gid = assignedBefore[seat];
      if (!gid) continue;

      if (seat === lastSeat) {
        // Last seat → NEXT section with +1 tick credit
        const nxt = nextSectionId(s);
        toAddToQueue.push({
          guardId: gid,
          returnTo: nxt,
          enteredTick: currentTick + 1,
        });
      } else {
        // Non-last seats → CURRENT section (no credit)
        toAddToQueue.push({
          guardId: gid,
          returnTo: s,
          enteredTick: currentTick,
        });
      }
    }
  }

  // Apply queue additions (dedupe guard globally to last write)
  const lastIndex: Map<string, number> = new Map();
  toAddToQueue.forEach((e, i) => lastIndex.set(e.guardId, i));
  for (let i = 0; i < toAddToQueue.length; i++) {
    if (lastIndex.get(toAddToQueue[i].guardId) !== i) continue; // keep only last
    // Remove this guard from ALL sections first
    for (const s of SECTIONS) {
      qBuckets[s] = (qBuckets[s] ?? []).filter((q) => q.guardId !== toAddToQueue[i].guardId);
    }
    (qBuckets[toAddToQueue[i].returnTo] ?? (qBuckets[toAddToQueue[i].returnTo] = [])).push(
      toAddToQueue[i]
    );
  }

  // Seat guards at rest chairs from queues
  const seatedAtRest = new Set<string>();
  for (const s of SECTIONS) {
    const restSeat = restChairBySection[s];
    if (!restSeat) continue;

    const bucket = qBuckets[s];
    const idx = bucket.findIndex(
      (e) => e.enteredTick <= currentTick && !seatedAtRest.has(e.guardId)
    );

    if (idx !== -1) {
      const [entry] = bucket.splice(idx, 1);
      nextAssigned[restSeat] = entry.guardId;
      seatedAtRest.add(entry.guardId);
    }
  }

  return { nextAssigned, seatedAtRest };
}

// ---------------- core stepper ----------------
export function computeNext(
  {
    assigned,
    guards,
    breaks,
    queue = [],
    nowISO,
  }: {
    assigned: Assigned;
    guards: Guard[];
    breaks: BreakState;
    queue?: QueueEntry[];
    nowISO: string;
  }
): EngineOutput {
  const currentTick = tickIndexFromISO(nowISO);
  const adult = isAdultSwimFromISO(nowISO);

  // Build per-section queues; DO NOT reorder (preserve FIFO within each section)
  const qBuckets: Record<string, QueueEntry[]> = {};
  for (const s of SECTIONS) qBuckets[s] = [];

  // Normalize incoming queue rows (clamp future ticks; ignore bad sections)
  for (const raw of queue) {
    const sec = String(raw?.returnTo ?? "");
    const gid = String(raw?.guardId ?? "");
    const etRaw = (raw as any)?.enteredTick;

    let et =
      typeof etRaw === "number" && Number.isFinite(etRaw)
        ? Math.trunc(etRaw)
        : typeof etRaw === "string" && /^\d+$/.test(etRaw)
        ? Math.trunc(parseInt(etRaw, 10))
        : currentTick;

    if (et > currentTick) et = currentTick; // clamp future-dated

    if (!gid || !SECTIONS.includes(sec)) continue;
    (qBuckets[sec] ?? (qBuckets[sec] = [])).push({ guardId: gid, returnTo: sec, enteredTick: et });
  }

  // --- ADULT SWIM FRAME ---
  if (adult) {
    const { nextAssigned, seatedAtRest } = tickAdultSwim(assigned, qBuckets, currentTick);

    // Outgoing queue: preserve order, drop those seated at rest (dedupe by guard)
    const seen = new Set<string>();
    const queuedOutAdult: QueueEntry[] = [];
    for (const s of SECTIONS) {
      for (const q of qBuckets[s]) {
        if (seatedAtRest.has(q.guardId)) continue;
        if (seen.has(q.guardId)) continue;
        seen.add(q.guardId);
        queuedOutAdult.push(q);
      }
    }

    // VALIDATION
    if (process.env.NODE_ENV !== "production") {
      const beforeSeated = Object.values(assigned).filter(Boolean) as string[];
      const beforeQueued = queue.map((q) => q.guardId);
      const afterSeated = Object.values(nextAssigned).filter(Boolean) as string[];
      const afterQueued = queuedOutAdult.map((q) => q.guardId);

      validateNoGuardLoss(beforeSeated, beforeQueued, afterSeated, afterQueued, "ADULT_SWIM");
    }

    return {
      nextAssigned,
      nextBreaks: breaks,
      conflicts: [],
      meta: { period: "ADULT_SWIM", breakQueue: queuedOutAdult, queuesBySection: qBuckets },
    };
  }

  // --- ALL-AGES FRAME ---
  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );
  const seatedThisTick = new Set<string>();

  // Did we just come from adult swim?
  const prevWasAdult = (() => {
    const prevISO = new Date(Date.parse(nowISO) - 15 * 60 * 1000).toISOString();
    return isAdultSwimFromISO(prevISO);
  })();

  // Snapshot of current seats (last frame)
  const assignedStart: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, assigned[p.id] ?? null])
  );

  // Pull rest returners off rest seats (so they don't "shift right")
  const restReturners: Record<string, string> = {};
  if (prevWasAdult) {
    for (const s of SECTIONS) {
      const restSeat = restChairBySection[s];
      if (!restSeat) continue;
      const gid = assignedStart[restSeat];
      if (gid) {
        assignedStart[restSeat] = null; // prevent a shift from rest seat
        restReturners[s] = gid;
      }
    }
  }

  // 1) End-of-section → enqueue into NEXT section (eligible now)
  const toEnqueue: Array<{ sec: string; gid: string }> = [];
  for (const seat of Object.keys(assignedStart)) {
    const gid = assignedStart[seat];
    if (!gid) continue;
    if (lastSeatSet.has(seat)) {
      const curSec = sectionBySeat[seat];
      const nextSec = nextSectionId(curSec);
      toEnqueue.push({ sec: nextSec, gid });
    }
  }
  // enqueue (dedupe: keep last write)
  const lastIdx = new Map<string, number>();
  toEnqueue.forEach((e, i) => lastIdx.set(e.gid, i));
  for (let i = 0; i < toEnqueue.length; i++) {
    if (lastIdx.get(toEnqueue[i].gid) !== i) continue;
    const e = toEnqueue[i];
    (qBuckets[e.sec] ?? (qBuckets[e.sec] = [])).push({
      guardId: e.gid,
      returnTo: e.sec,
      enteredTick: currentTick,
    });
  }

  // 1b) Balance queues ONLY on ordinary frames (never post-adult)
  if (!prevWasAdult) {
    const eligLE = (e: QueueEntry) => e.enteredTick <= currentTick;
    let moved = true;
    while (moved) {
      moved = false;
      const eligCount: Record<string, number> = {};
      for (const s of SECTIONS) eligCount[s] = (qBuckets[s] ?? []).filter(eligLE).length;
      const receivers = SECTIONS.filter((s) => eligCount[s] === 0);
      if (!receivers.length) break;
      const donors = SECTIONS
        .map((s) => ({ s, count: eligCount[s] }))
        .filter((x) => x.count > 1)
        .sort((a, b) => b.count - a.count);
      if (!donors.length) break;
      for (const r of receivers) {
        const donor = donors.find((d) => d.count > 1);
        if (!donor) break;
        const dbucket = qBuckets[donor.s];
        const di = dbucket.findIndex(eligLE);
        if (di === -1) {
          donor.count = 0;
          continue;
        }
        const [entry] = dbucket.splice(di, 1);
        entry.returnTo = r;
        (qBuckets[r] ?? (qBuckets[r] = [])).push(entry);
        donor.count -= 1;
        moved = true;
      }
    }
  }

  // 2) Advance within section only on ordinary frames (NEVER post-adult)
  if (!prevWasAdult) {
    for (const s of SECTIONS) {
      const seats = seatsBySection[s];
      for (let i = seats.length - 1; i >= 1; i--) {
        const from = seats[i - 1];
        const to = seats[i];
        const gid = assignedStart[from];
        if (!gid) continue;
        nextAssigned[to] = gid;
        seatedThisTick.add(gid);
      }
    }
  }

  // 2b) Seat rest returners (post-adult only)
  if (prevWasAdult) {
    for (const s of SECTIONS) {
      const gid = restReturners[s];
      if (!gid) continue;
      const entrySeat = firstSeatBySection[s];
      nextAssigned[entrySeat] = gid;
      seatedThisTick.add(gid);
    }
  }

  // 3) Refill from each section's queue
  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    const bucket = qBuckets[s];

    if (prevWasAdult) {
      // POST-ADULT: fill seats[1..end] first, then entry last
      const entrySeat = seats[0];

      for (let i = 1; i < seats.length; i++) {
        const seat = seats[i];
        if (nextAssigned[seat]) continue;
        const idx = bucket.findIndex((e) => isEligNow(e, currentTick, seatedThisTick));
        if (idx === -1) break;
        const [entry] = bucket.splice(idx, 1);
        nextAssigned[seat] = entry.guardId;
        seatedThisTick.add(entry.guardId);
      }

      if (!nextAssigned[entrySeat]) {
        const idx0 = bucket.findIndex((e) => isEligNow(e, currentTick, seatedThisTick));
        if (idx0 !== -1) {
          const [entry] = bucket.splice(idx0, 1);
          nextAssigned[entrySeat] = entry.guardId;
          seatedThisTick.add(entry.guardId);
        }
      }
    } else {
      // ORDINARY: fill entry only
      const entrySeat = seats[0];
      if (!nextAssigned[entrySeat]) {
        const idx = bucket.findIndex((e) => isEligNow(e, currentTick, seatedThisTick));
        if (idx !== -1) {
          const [entry] = bucket.splice(idx, 1);
          nextAssigned[entrySeat] = entry.guardId;
          seatedThisTick.add(entry.guardId);
        }
      }
    }
  }

  // 3b) Global borrowing ONLY on ordinary frames
  if (!prevWasAdult) {
    type SeatRef = { section: string; seat: string; idx: number };
    const eligLEAndFree = (e: QueueEntry) =>
      e.enteredTick <= currentTick && !seatedThisTick.has(e.guardId);

    const emptySeats: SeatRef[] = [];
    for (const s of SECTIONS) {
      const seats = seatsBySection[s];
      for (let i = seats.length - 1; i >= 0; i--) {
        const seatId = seats[i];
        if (!nextAssigned[seatId]) emptySeats.push({ section: s, seat: seatId, idx: i });
      }
    }

    if (emptySeats.length) {
      const eligCountBySection: Record<string, number> = {};
      for (const s of SECTIONS) {
        eligCountBySection[s] = (qBuckets[s] ?? []).filter(eligLEAndFree).length;
      }

      type Donor = { section: string; entry: QueueEntry };
      const donors: Donor[] = [];
      for (const s of SECTIONS) {
        const bucket = qBuckets[s];
        if (!bucket?.length) continue;
        const eligIdxs: number[] = [];
        for (let i = 0; i < bucket.length; i++) if (eligLEAndFree(bucket[i])) eligIdxs.push(i);

        const surplus = Math.max(0, eligIdxs.length - 1);
        for (let k = 0; k < surplus; k++) donors.push({ section: s, entry: bucket[eligIdxs[k]] });
      }

      for (const slot of emptySeats) {
        if (!donors.length) break;
        if (eligCountBySection[slot.section] > 0) continue;

        const pick = donors.shift()!;
        const donorBucket = qBuckets[pick.section];

        const bi = donorBucket.findIndex(
          (e) => e.guardId === pick.entry.guardId && e.enteredTick === pick.entry.enteredTick
        );
        if (bi !== -1) donorBucket.splice(bi, 1);

        nextAssigned[slot.seat] = pick.entry.guardId;
        seatedThisTick.add(pick.entry.guardId);
      }
    }
  }

  // 4) Outgoing queue snapshot (preserve order; exclude newly seated; dedupe)
  const outQueue: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const s of SECTIONS) {
    for (const q of qBuckets[s]) {
      if (seatedThisTick.has(q.guardId)) continue;
      if (seen.has(q.guardId)) continue;
      seen.add(q.guardId);
      outQueue.push(q);
    }
  }

  // VALIDATION & DEBUG
  if (process.env.NODE_ENV !== "production") {
    const beforeSeated = Object.values(assignedStart).filter(Boolean) as string[];
    const beforeQueued = queue.map((q) => q.guardId);
    const afterSeated = Object.values(nextAssigned).filter(Boolean) as string[];
    const afterQueued = outQueue.map((q) => q.guardId);

    validateNoGuardLoss(beforeSeated, beforeQueued, afterSeated, afterQueued, "ALL_AGES");

    console.log("[rotation.debug] RESULT", {
      tick: currentTick,
      period: "ALL_AGES",
      assigned: Object.entries(nextAssigned).map(([seat, guard]) => ({ seat, guard: guard ?? "—" })),
      queues: SECTIONS.map((s) => ({
        section: s,
        queue: (qBuckets[s] ?? []).map((q) => `${q.guardId}(tick:${q.enteredTick})`),
      })),
    });

    const seatedIds = new Set(Object.values(nextAssigned).filter(Boolean) as string[]);
    const remaining = SECTIONS.flatMap((s) =>
      (qBuckets[s] ?? [])
        .map((q) => q.guardId)
        .filter((id) => !seatedIds.has(id))
    );
    console.log("[rotation.debug] seated:", Array.from(seatedIds));
    console.log("[rotation.debug] still queued:", remaining);
  }

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: outQueue, queuesBySection: qBuckets },
  };
}
