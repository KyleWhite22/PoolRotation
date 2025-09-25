console.log("[engine/rotation] LOADED");
import { POSITIONS, REST_STATIONS } from "../../../shared/data/poolLayout.js";

export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type BreakState = Record<string, string>;

// ✅ Queue entries now carry enteredTick (integer tick index)
export type QueueEntry = { guardId: string; returnTo: string; enteredTick: number };

export type Conflict = { stationId: string; reason: "AGE_RULE"; guardId: string };

export type EngineOutput = {
  nextAssigned: Assigned;
  nextBreaks: BreakState;
  conflicts: Conflict[];
  meta: { period: "ALL_AGES" | "ADULT_SWIM"; breakQueue: QueueEntry[] };
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
  // Coarse monotonic tick: 1 tick per 15 minutes since epoch.
  const ms = Date.parse(nowISO);
  return Math.floor(ms / (15 * 60 * 1000));
}
function minuteOfHourUTC(nowISO: string): number {
  const d = new Date(nowISO);
  return d.getUTCMinutes(); // since you're passing ISO strings, UTC is stable here
}
function isAdultSwimFromISO(nowISO: string): boolean {
  return minuteOfHourUTC(nowISO) === 45;
}

// ---- core stepper -----------------------------------------------------------
export function computeNext({
  assigned,
  guards,          // unused for now (kept for future rules)
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

  // Normalize queue buckets; fix missing/NaN enteredTick to "must wait 1 full tick"
const qBuckets: Record<string, QueueEntry[]> = {};
for (const s of SECTIONS) qBuckets[s] = [];
for (const raw of queue) {
  const sec = String(raw?.returnTo ?? "");
  const gid = String(raw?.guardId ?? "");
  const etRaw =
    typeof (raw as any)?.enteredTick === "number" && Number.isFinite((raw as any).enteredTick)
      ? (raw as any).enteredTick
      : currentTick; // default: added this/last frame → must sit out one full tick

  // 🔧 Clamp future ticks to currentTick so eligibility can eventually happen
  const et = Math.min(etRaw, currentTick);

  if (!gid || !SECTIONS.includes(sec)) continue;
  qBuckets[sec].push({ guardId: gid, returnTo: sec, enteredTick: et });
}

  const nextAssigned: Assigned = Object.fromEntries(
    POSITIONS.map((p) => [p.id, null as string | null])
  );

  // Easy access sets
  const restSet = new Set<string>(REST_STATIONS ?? []);
  const seatedThisTick = new Set<string>();
if (adult) {
  // ===== ADULT SWIM TICK =====
  // Step A) Normal shift first: tails enqueue to NEXT section, then shift within each section
  for (const seat of Object.keys(assigned)) {
    const gid = assigned[seat];
    if (!gid) continue;
    if (lastSeatSet.has(seat)) {
      const curSec = sectionBySeat[seat];
      const nxtSec = nextSectionId(curSec);
      qBuckets[nxtSec].push({ guardId: gid, returnTo: nxtSec, enteredTick: currentTick });
      // tail vacates
    }
  }

  const shifted: Assigned = Object.fromEntries(POSITIONS.map(p => [p.id, null as string | null]));
  for (const s of SECTIONS) {
    const seats = seatsBySection[s];
    for (let i = seats.length - 1; i >= 1; i--) {
      const from = seats[i - 1];
      const to   = seats[i];
      const gid  = assigned[from];
      if (!gid) continue;
      shifted[to] = gid;
    }
  }

  // Step B) Apply adult-swim: keep rest seats staffed; everyone else queues.
  // Special case: if the entry seat is a rest seat and empty after shift, pull from that section's queue (eligible only).
  const seatedNowAdult = new Set<string>(); // guards we keep seated (rest only)

  // 1) Per-section: ensure entry rest seat is filled (from shift or queue)
  for (const s of SECTIONS) {
    const entrySeat = seatsBySection[s][0];
    const entryIsRest = REST_STATIONS.has(entrySeat);

    if (entryIsRest) {
      if (shifted[entrySeat]) {
        // Someone rotated into entry rest seat; keep them seated
        const gid = shifted[entrySeat]!;
        nextAssigned[entrySeat] = gid;
        seatedNowAdult.add(gid);
      } else {
        // Entry rest is empty: pull first eligible from this section's queue
        const bucket = qBuckets[s];
        const idx = bucket.findIndex(e => e.enteredTick < currentTick); // waited ≥ 1 tick
        if (idx !== -1) {
          const [head] = bucket.splice(idx, 1);
          nextAssigned[entrySeat] = head.guardId;
          seatedNowAdult.add(head.guardId);
        }
      }
    }
  }

  // 2) For all other rest seats (non-entry) — keep whoever rotated into them
  for (const seat of Object.keys(shifted)) {
    if (!REST_STATIONS.has(seat)) continue;               // rest seats only
    if (nextAssigned[seat]) continue;                     // already handled entry rest above
    const gid = shifted[seat];
    if (!gid) continue;
    nextAssigned[seat] = gid;                             // stays put during adult swim
    seatedNowAdult.add(gid);
  }

  // 3) Everyone else (non-rest seats in the shifted snapshot) → queue (to their own section)
  //    enteredTick = currentTick (they start their adult-swim break now)
  for (const seat of Object.keys(shifted)) {
    if (REST_STATIONS.has(seat)) continue;                // rest handled already
    const gid = shifted[seat];
    if (!gid) continue;
    const sec = sectionBySeat[seat];
    qBuckets[sec].push({ guardId: gid, returnTo: sec, enteredTick: currentTick });
  }

  // 4) Build outgoing queue: keep order by section bucket; dedupe; drop any seated-at-rest
  const seen = new Set<string>();
  const queuedOutAdult: QueueEntry[] = [];
  for (const s of SECTIONS) {
    for (const q of qBuckets[s]) {
      if (seatedNowAdult.has(q.guardId)) continue; // don't queue someone we seated at rest
      if (seen.has(q.guardId)) continue;           // dedupe by guardId
      seen.add(q.guardId);
      queuedOutAdult.push(q);
    }
  }

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ADULT_SWIM", breakQueue: queuedOutAdult },
  };
}



// ===== NORMAL TICK =====
// 1) End-of-section → enqueue into NEXT section (unchanged)
const toEnqueue: Array<{ sec: string; gid: string }> = [];
for (const seat of Object.keys(assigned)) {
  const gid = assigned[seat];
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
  enteredTick: currentTick - 1, // ensures enteredTick < currentTick
});
}

// 2) Advance within each section (unchanged)
for (const s of SECTIONS) {
  const seats = seatsBySection[s];
  for (let i = seats.length - 1; i >= 1; i--) {
    const from = seats[i - 1];
    const to   = seats[i];
    const gid  = assigned[from];
    if (!gid) continue;
    nextAssigned[to] = gid;
    seatedThisTick.add(gid);
  }
}

// 3) Refill from queue
// If previous tick was adult swim (:45), refill ALL empty seats from that section’s queue;
// otherwise (ordinary tick), only fill the first seat.
const prevWasAdult = (((currentTick - 1) % 4) + 4) % 4 === 3;

for (const s of SECTIONS) {
  const seats  = seatsBySection[s];
  const bucket = qBuckets[s];
if (process.env.NODE_ENV !== "production") {
  console.log("[refill.debug]", {
    tick: currentTick,
    prevWasAdult,
    section: s,
    seatsBefore: seats.map(seat => ({ seat, guard: nextAssigned[seat] ?? "—" })),
    bucketBefore: bucket.map(q => `${q.guardId}(tick:${q.enteredTick})`),
  });
}
  if (prevWasAdult) {
    // After adult swim: fill ALL empty seats right -> left (not just the suffix)
    for (let i = seats.length - 1; i >= 0; i--) {
      const seat = seats[i];
      if (nextAssigned[seat]) continue; // already occupied after the normal shift

      // Pull the first eligible queue guard (FIFO) who waited at least one full tick
      const idx = bucket.findIndex(
        e => e.enteredTick < currentTick && !seatedThisTick.has(e.guardId)
      );
      if (idx === -1) break; // no more eligible in this section

      const [entry] = bucket.splice(idx, 1);
      nextAssigned[seat] = entry.guardId;
      seatedThisTick.add(entry.guardId);
    }
  } else {
    // Ordinary tick: only the entry seat pulls one (original logic)
    const entrySeat = seats[0];
    if (!nextAssigned[entrySeat]) {
      const idx = bucket.findIndex(
        e => e.enteredTick < currentTick && !seatedThisTick.has(e.guardId)
      );
      if (idx !== -1) {
        const [entry] = bucket.splice(idx, 1);
        nextAssigned[entrySeat] = entry.guardId;
        seatedThisTick.add(entry.guardId);
      }
    }
  }
}




// 4) Build outgoing queue (unchanged)
const outQueue: QueueEntry[] = [];
const seen = new Set<string>();
for (const s of SECTIONS) {
  for (const q of qBuckets[s]) {
    if (seatedThisTick.has(q.guardId)) continue; // anyone seated this frame is removed
    if (seen.has(q.guardId)) continue;
    seen.add(q.guardId);
    outQueue.push(q);
  }
}
if (process.env.NODE_ENV !== "production") {
  console.log("[rotation.debug] RESULT", {
    tick: currentTick,
    period: adult ? "ADULT_SWIM" : "ALL_AGES",
    assigned: Object.entries(nextAssigned).map(([seat, guard]) => ({
      seat,
      guard: guard ?? "—",
    })),
    queues: SECTIONS.map(s => ({
      section: s,
      queue: qBuckets[s].map(q =>
        `${q.guardId}(tick:${q.enteredTick})`
      ),
    })),
  });
}

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: outQueue },
  };
}
