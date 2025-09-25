console.log("[engine/rotation] LOADED");
import { POSITIONS } from "../../../shared/data/poolLayout.js";

export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type BreakState = Record<string, string>;
export type Conflict = { stationId: string; reason: "AGE_RULE"; guardId: string };
export type QueueEntry = { guardId: string; returnTo: string };

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
  for (const s of SECTIONS) {
    m[s].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
  }
  return m;
})();

function nextSection(sec: string): string {
  const i = SECTIONS.indexOf(sec);
  return SECTIONS[(i + 1) % SECTIONS.length];
}

export type EngineOutput = {
  nextAssigned: Assigned;
  nextBreaks: BreakState;
  conflicts: Conflict[];
  meta: { period: "ALL_AGES"; breakQueue: QueueEntry[] };
};

/**
 * Tick semantics (t -> t+1):
 * 1) Shift within each section (except tails).
 * 2) Tails enqueue into next section.
 * 3) Entry seats pull one from previous queue (per section).
 * 4) Remove consumed queue heads; dedupe; never keep seated guards in queue.
 */
export function rotateOnceEngine(
  assigned: Assigned,
  _guards: Guard[],
  breaks: BreakState,
  _now = new Date(),
  queueIn: QueueEntry[] = []
): EngineOutput {
  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );

  // Bucket the prior queue by section (preserve order)
  const qBuckets: Record<string, QueueEntry[]> = {};
  for (const s of SECTIONS) qBuckets[s] = [];
  for (const q of queueIn) {
    const sec = String(q.returnTo);
    if (SECTIONS.includes(sec)) qBuckets[sec].push(q);
  }

  // 1) Shift within section (top-down), leaving entry seats empty for now
  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    for (let i = seats.length - 1; i >= 1; i--) {
      const from = seats[i - 1];
      const to = seats[i];
      const gid = assigned[from];
      if (gid) nextAssigned[to] = gid;
    }
  }

  // Track who is seated in the new frame (for queue filtering)
  const seatedThisTick = new Set<string>(
    Object.values(nextAssigned).filter((v): v is string => Boolean(v))
  );

  // 2) Build queueOut starting from survivors (drop consumed heads later)
  const queueOut: QueueEntry[] = [];
  for (const s of SECTIONS) {
    for (const q of qBuckets[s]) queueOut.push(q);
  }

  // Append new tail entrants (from prior frame) into next section
  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    const tail = seats[seats.length - 1];
    const gid = assigned[tail];
    if (gid) {
      queueOut.push({ guardId: gid, returnTo: nextSection(s) });
    }
  }

  // 3) Feed entry seats from the PRIOR queue (one per section), if still empty
  const consumedHeads: Record<string, boolean> = {};
  for (const s of SECTIONS) {
    const entry = seatsBySection[s][0];
    if (nextAssigned[entry]) continue; // already filled by shift (rare)
    const bucket = qBuckets[s];
    if (bucket.length > 0) {
      const head = bucket[0];
      // Only seat if this guard isn't already seated elsewhere this tick
      if (!seatedThisTick.has(head.guardId)) {
        nextAssigned[entry] = head.guardId;
        consumedHeads[s] = true;
        seatedThisTick.add(head.guardId);
      }
    }
  }

  // 4) Remove consumed queue heads and anyone now seated; dedupe by guardId
  const toRemove = new Set<string>();
  for (const s of SECTIONS) {
    if (consumedHeads[s]) {
      const head = qBuckets[s][0];
      if (head) toRemove.add(head.guardId);
    }
  }
  for (const gid of seatedThisTick) {
    toRemove.add(gid); // ensure no seated guard remains queued
  }

  const seen = new Set<string>();
  const deduped: QueueEntry[] = [];
  for (const q of queueOut) {
    if (toRemove.has(q.guardId)) continue;
    if (seen.has(q.guardId)) continue;
    seen.add(q.guardId);
    deduped.push(q);
  }

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: deduped },
  };
}

export function computeNext({
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
}) {
  return rotateOnceEngine(assigned, guards, breaks, new Date(nowISO), queue);
}
