// backend/src/engine/rotation.ts
console.log("[engine/rotation] LOADED");
import { POSITIONS, REST_BY_SECTION } from "../../../shared/data/poolLayout.js";

export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type BreakState = Record<string, string>;

// Queue entries carry enteredTick (integer "15-min tick" index)
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

// -------- derived layout helpers --------
const SECTIONS = Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

// seats ordered within section
const seatsBySection: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const s of SECTIONS) m[s] = [];
  for (const p of POSITIONS) {
    const [sec] = p.id.split(".");
    m[sec].push(p.id);
  }
  for (const s of SECTIONS) {
    m[s].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
  }
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

const firstSeatBySection: Record<string, string> = Object.fromEntries(
  SECTIONS.map((s) => [s, seatsBySection[s][0]])
);

const lastSeatSet = new Set<string>(
  SECTIONS.map((s) => seatsBySection[s][seatsBySection[s].length - 1])
);

const sectionBySeat: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const s of SECTIONS) for (const seat of seatsBySection[s]) m[seat] = s;
  return m;
})();

function nextSectionId(sec: string): string {
  const i = SECTIONS.indexOf(sec);
  return SECTIONS[(i + 1) % SECTIONS.length];
}

function tickIndexFromISO(nowISO: string): number {
  // 1 tick per 15 minutes since epoch
  const ms = Date.parse(nowISO);
  return Math.floor(ms / (15 * 60 * 1000));
}
function minuteOfHourUTC(nowISO: string): number {
  const d = new Date(nowISO);
  return d.getUTCMinutes();
}
function isAdultSwimFromISO(nowISO: string): boolean {
  return minuteOfHourUTC(nowISO) === 45;
}

// ---- helpers ---------------------------------------------------------------
const isEligibleAt = (entry: QueueEntry, tick: number) => entry.enteredTick < tick;

/**
 * Adult-swim (:45) step:
 * - Everyone leaves their seats.
 *   - If a guard WAS on a section's last seat before :45, they move to the NEXT section's queue
 *     with a 30-min break credit => ineligible for 2 ticks (enteredTick = currentTick + 2).
 *   - All others go to their CURRENT section's queue, eligible immediately at :00 (enteredTick = currentTick).
 * - For each section that has a rest chair, the guard who would have started at the first chair
 *   (i.e., next usable from that section's queue) is seated on that rest chair for :45–:00.
 */
function tickAdultSwim(
  assignedBefore: Assigned,
  qBuckets: Record<string, QueueEntry[]>,
  currentTick: number
) {
  // Clear seating for the :45 frame; we only show rest chairs during adult swim
  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );

  // 1) Move seated guards to queues according to end/non-end rules
  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    const lastSeat = seats[seats.length - 1];

    for (const seat of seats) {
      const gid = assignedBefore[seat];
      if (!gid) continue;

      if (seat === lastSeat) {
        // End-of-section before :45 -> next section queue, 30-min break (2 ticks wait)
        const nxt = nextSectionId(s);
        qBuckets[nxt].push({ guardId: gid, returnTo: nxt, enteredTick: currentTick + 2 });
      } else {
        // Not end -> current section queue, eligible at :00
        qBuckets[s].push({ guardId: gid, returnTo: s, enteredTick: currentTick });
      }
    }
  }

  // 2) Seat rest guard (if any) per section by popping next usable for that section
  const seatedAtRest = new Set<string>();
  for (const s of SECTIONS) {
    const restSeat = restChairBySection[s];
    if (!restSeat) continue;

    const bucket = qBuckets[s];
    const idx = bucket.findIndex((e) => isEligibleAt(e, currentTick)); // must have enteredTick < currentTick
    if (idx !== -1) {
      const [entry] = bucket.splice(idx, 1);
      nextAssigned[restSeat] = entry.guardId;
      seatedAtRest.add(entry.guardId);
    }
  }

  return { nextAssigned, seatedAtRest };
}

// ---- core stepper -----------------------------------------------------------
export function computeNext({
  assigned,
  guards, // unused for now (kept for future rules)
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

  // Normalize queue buckets; clamp bad/missing enteredTick to currentTick
  const qBuckets: Record<string, QueueEntry[]> = {};
  for (const s of SECTIONS) qBuckets[s] = [];
  for (const raw of queue) {
    const sec = String(raw?.returnTo ?? "");
    const gid = String(raw?.guardId ?? "");
    const etRaw =
      typeof (raw as any)?.enteredTick === "number" && Number.isFinite((raw as any).enteredTick)
        ? (raw as any).enteredTick
        : currentTick;

    const et = Math.min(etRaw, currentTick);
    if (!gid || !SECTIONS.includes(sec)) continue;
    qBuckets[sec].push({ guardId: gid, returnTo: sec, enteredTick: et });
  }

  // ADULT SWIM FRAME ---------------------------------------------------------
  if (adult) {
    const { nextAssigned, seatedAtRest } = tickAdultSwim(assigned, qBuckets, currentTick);

    // Outgoing queue: flatten per-section buckets, excluding those we seated on rest
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
      meta: {
        period: "ADULT_SWIM",
        breakQueue: queuedOutAdult,
        queuesBySection: qBuckets,
      },
    };
  }

  // ALL-AGES FRAME -----------------------------------------------------------
  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );
  const seatedThisTick = new Set<string>();

  // Was the PREVIOUS frame adult swim?
  const prevWasAdult = (((currentTick - 1) % 4) + 4) % 4 === 3;

  // Start from a working copy
  const assignedStart: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, assigned[p.id] ?? null])
  );

  // Collect rest returners; we’ll seat them on first chair AFTER the shift
  const restReturners: Record<string, string> = {};
  if (prevWasAdult) {
    for (const s of SECTIONS) {
      const restSeat = restChairBySection[s];
      if (!restSeat) continue;
      const gid = assignedStart[restSeat];
      if (gid) {
        assignedStart[restSeat] = null; // remove from rest seat before shifting
        restReturners[s] = gid;         // place on first chair after shift
      }
    }
  }

  // 1) End-of-section → enqueue into NEXT section
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
    qBuckets[item.sec].push({
      guardId: item.gid,
      returnTo: item.sec,
      enteredTick: currentTick,
    });
  }

  // ---- 1b) Queue balancing
  {
    const isElig = (e: QueueEntry) => isEligibleAt(e, currentTick);

    let moved = true;
    while (moved) {
      moved = false;

      const eligCount: Record<string, number> = {};
      for (const s of SECTIONS) eligCount[s] = (qBuckets[s] ?? []).filter(isElig).length;

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
        const di = dbucket.findIndex(isElig);
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

  // 2) Advance within each section (right shift)
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

  // 2b) Seat rest returners directly onto first chair AFTER the shift
  if (prevWasAdult) {
    for (const s of SECTIONS) {
      const gid = restReturners[s];
      if (!gid) continue;
      const entrySeat = firstSeatBySection[s];
      nextAssigned[entrySeat] = gid; // ensure they truly start on the first chair
      seatedThisTick.add(gid);
    }
  }

  // 3) Refill from each section's queue
  // If previous tick was adult swim, preserve order:
  // - If no rest chair returner, fill entry seat from queue.
  // - Then fill seats left→right starting at index 1.
  // Otherwise (ordinary tick), fill only the entry seat.
  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    const bucket = qBuckets[s];

    if (prevWasAdult) {
      // prevWasAdult: fill entry if no rest chair, then seats 1..
      const entrySeat = seats[0];

      // 3a) Ensure entry seat is filled when the section has no rest chair
      if (!nextAssigned[entrySeat]) {
        const idx0 = bucket.findIndex(
          (e) => isEligibleAt(e, currentTick) && !seatedThisTick.has(e.guardId)
        );
        if (idx0 !== -1) {
          const [entry] = bucket.splice(idx0, 1);
          nextAssigned[entrySeat] = entry.guardId;
          seatedThisTick.add(entry.guardId);
        }
      }

      // 3b) Fill remaining seats left→right (indices 1..N-1) to preserve queue order
      for (let i = 1; i < seats.length; i++) {
        const seat = seats[i];
        if (nextAssigned[seat]) continue; // already filled by shift
        const idx = bucket.findIndex(
          (e) => isEligibleAt(e, currentTick) && !seatedThisTick.has(e.guardId)
        );
        if (idx === -1) break;
        const [entry] = bucket.splice(idx, 1);
        nextAssigned[seat] = entry.guardId;
        seatedThisTick.add(entry.guardId);
      }
    } else {
      // Ordinary tick: only the entry seat
      const entrySeat = seats[0];
      if (!nextAssigned[entrySeat]) {
        // prefer truly eligible; if none, allow same-tick fallbacks to avoid gaps
        let idx = bucket.findIndex(
          (e) => isEligibleAt(e, currentTick) && !seatedThisTick.has(e.guardId)
        );
        if (idx === -1) {
          idx = bucket.findIndex(
            (e) => e.enteredTick === currentTick && !seatedThisTick.has(e.guardId)
          );
        }
        if (idx !== -1) {
          const [entry] = bucket.splice(idx, 1);
          nextAssigned[entrySeat] = entry.guardId;
          seatedThisTick.add(entry.guardId);
        }
      }
    }
  }

  // 3b) Global borrowing pass
  type SeatRef = { section: string; seat: string; idx: number };
  const isElig = (e: QueueEntry) => e.enteredTick <= currentTick && !seatedThisTick.has(e.guardId);

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
      eligCountBySection[s] = (qBuckets[s] ?? []).filter(isElig).length;
    }

    type Donor = { section: string; entry: QueueEntry };
    const donors: Donor[] = [];
    for (const s of SECTIONS) {
      const bucket = qBuckets[s];
      if (!bucket?.length) continue;
      const eligIdxs: number[] = [];
      for (let i = 0; i < bucket.length; i++) if (isElig(bucket[i])) eligIdxs.push(i);

      const surplus = Math.max(0, eligIdxs.length - 1); // keep 1 eligible for own entry seat
      for (let k = 0; k < surplus; k++) {
        donors.push({ section: s, entry: bucket[eligIdxs[k]] });
      }
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

  // 4) Build outgoing queue snapshot
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
      assigned: Object.entries(nextAssigned).map(([seat, guard]) => ({
        seat,
        guard: guard ?? "—",
      })),
      queues: SECTIONS.map((s) => ({
        section: s,
        queue: qBuckets[s].map((q) => `${q.guardId}(tick:${q.enteredTick})`),
      })),
    });
  }

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: {
      period: "ALL_AGES",
      breakQueue: outQueue,
      queuesBySection: qBuckets,
    },
  };
}
