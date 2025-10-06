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

// -------- eligibility helpers (declare BEFORE use) --------
const isEligibleAtOrSame = (entry: QueueEntry, tick: number) => entry.enteredTick <= tick;
// Treat same-tick arrivals as eligible for seating (used for ALL seating pulls).
const isEligNow = (e: QueueEntry, tick: number, seatedThisTick: Set<string>) =>
  e.enteredTick <= tick && !seatedThisTick.has(e.guardId);

/**
 * Adult-swim (:45) step:
 * - Clear seats;
 * - Last-seat guards → NEXT section with +2 ticks (30 min) credit;
 * - Others → CURRENT section queue (enteredTick = currentTick);
 * - If a section has a rest chair, seat the next eligible (<= currentTick) into it.
 */
function tickAdultSwim(
  assignedBefore: Assigned,
  qBuckets: Record<string, QueueEntry[]>,
  currentTick: number
) {
  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );

  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    const lastSeat = seats[seats.length - 1];

    // push in seat order to preserve left→right
    for (const seat of seats) {
      const gid = assignedBefore[seat];
      if (!gid) continue;

      if (seat === lastSeat) {
        const nxt = nextSectionId(s);
        qBuckets[nxt].push({ guardId: gid, returnTo: nxt, enteredTick: currentTick + 2 });
      } else {
        qBuckets[s].push({ guardId: gid, returnTo: s, enteredTick: currentTick });
      }
    }
  }

  const seatedAtRest = new Set<string>();
  for (const s of SECTIONS) {
    const restSeat = restChairBySection[s];
    if (!restSeat) continue;

    const bucket = qBuckets[s];
    const idx = bucket.findIndex((e) => isEligibleAtOrSame(e, currentTick)); // <= currentTick
    if (idx !== -1) {
      const [entry] = bucket.splice(idx, 1);
      nextAssigned[restSeat] = entry.guardId;
      seatedAtRest.add(entry.guardId);
    }
  }

  return { nextAssigned, seatedAtRest };
}

// ---------------- core stepper ----------------
export function computeNext({
  assigned,
  guards, // reserved for future rules
  breaks,
  queue = [],
  nowISO,
}: {
  assigned: Assigned;
  guards: Guard[];
  breaks: BreakState;
  queue?: QueueEntry[];
  nowISO: string;
}): EngineOutput {
  const currentTick = tickIndexFromISO(nowISO);
  const adult = isAdultSwimFromISO(nowISO);

  // Build per-section queues; DO NOT reorder.
  const qBuckets: Record<string, QueueEntry[]> = {};
  for (const s of SECTIONS) qBuckets[s] = [];
  for (const raw of queue) {
    const sec = String(raw?.returnTo ?? "");
    const gid = String(raw?.guardId ?? "");
    const etRaw = (raw as any)?.enteredTick;
    const et =
      typeof etRaw === "number" && Number.isFinite(etRaw)
        ? Math.trunc(etRaw)
        : typeof etRaw === "string" && /^\d+$/.test(etRaw)
        ? Math.trunc(parseInt(etRaw, 10))
        : currentTick;
    if (!gid || !SECTIONS.includes(sec)) continue;
    qBuckets[sec].push({ guardId: gid, returnTo: sec, enteredTick: et });
  }

  // --- ADULT SWIM FRAME ---
  if (adult) {
    const { nextAssigned, seatedAtRest } = tickAdultSwim(assigned, qBuckets, currentTick);

    // Outgoing queue: preserve order, drop those seated at rest.
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

  // Did we just come from adult?
  const prevWasAdult = (() => {
    const prevISO = new Date(Date.parse(nowISO) - 15 * 60 * 1000).toISOString();
    return isAdultSwimFromISO(prevISO);
  })();

  // Snapshot of current seats (last frame)
  const assignedStart: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, assigned[p.id] ?? null])
  );

  // Pull rest returners off rest seats (so they don't "shift right"); seat to entry later
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
  //    NOTE: On post-adult frames, assignedStart[last seats] are null, so this is a no-op there.
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
  for (const item of toEnqueue) {
    qBuckets[item.sec].push({ guardId: item.gid, returnTo: item.sec, enteredTick: currentTick });
  }

  // 1b) Balance queues ONLY on ordinary frames (never post-adult to preserve order)
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

  // 2b) Seat rest returners (post-adult only): put them on entry seat now
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
      // POST-ADULT: fill seats[1..end] first (preserves "k → k+1" mapping),
      // then fill entry LAST if it’s still empty (unless rest returner took it).
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
      // ORDINARY: fill entry only (<= eligibility).
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

  // 3b) Global borrowing ONLY on ordinary frames (never post-adult to keep order)
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

        const surplus = Math.max(0, eligIdxs.length - 1); // keep 1 eligible for own entry seat
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

  // 4) Outgoing queue snapshot (preserve order; exclude newly seated)
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

  if (process.env.NODE_ENV !== "production") {
    console.log("[rotation.debug] RESULT", {
      tick: currentTick,
      period: "ALL_AGES",
      assigned: Object.entries(nextAssigned).map(([seat, guard]) => ({ seat, guard: guard ?? "—" })),
      queues: SECTIONS.map((s) => ({
        section: s,
        queue: qBuckets[s].map((q) => `${q.guardId}(tick:${q.enteredTick})`),
      })),
    });
    const seatedIds = new Set(Object.values(nextAssigned).filter(Boolean) as string[]);
    const remaining = SECTIONS.flatMap((s) =>
      (qBuckets[s] ?? []).map((q) => q.guardId).filter((id) => !seatedIds.has(id))
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
