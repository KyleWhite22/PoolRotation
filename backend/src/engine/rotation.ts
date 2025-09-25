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
  // Step A) Do a normal shift first (like a normal tick):
  // - Tails enqueue to NEXT section (enteredTick = currentTick)
  // - Within each section, everybody advances right by one
  // - Do NOT pull from queue on adult tick

  // A1: tail -> enqueue to next section
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

  // A2: advance within each section (build a shifted snapshot)
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

  // Step B) Apply adult-swim rules to the shifted snapshot:
  // - Keep guards in REST_STATIONS seated
  // - Everyone else is queued (to their own section) for the adult-swim period
  const queuedOutAdult: QueueEntry[] = [];
  const seenQueued = new Set<string>();     // dedupe by guardId
  const seatedNowAdult = new Set<string>(); // who we keep seated (rest only)

  // Start with whatever was already in qBuckets (tails + previous queue contents)
  for (const s of SECTIONS) {
    for (const q of qBuckets[s]) {
      if (!seenQueued.has(q.guardId)) {
        seenQueued.add(q.guardId);
        queuedOutAdult.push(q);
      }
    }
    // Clear buckets; we'll rebuild the output list below
    qBuckets[s] = [];
  }

  // Build nextAssigned: only rest seats from the shifted frame
  for (const seat of Object.keys(shifted)) {
    const gid = shifted[seat];
    if (!gid) continue;
    if (REST_STATIONS.has(seat)) {
      nextAssigned[seat] = gid;     // stays staffed during adult swim
      seatedNowAdult.add(gid);
    } else {
      // Non-rest: goes to queue for their own section
      const sec = sectionBySeat[seat];
      const entry: QueueEntry = { guardId: gid, returnTo: sec, enteredTick: currentTick };
      if (!seenQueued.has(gid)) {
        seenQueued.add(gid);
        queuedOutAdult.push(entry);
      }
    }
  }

  // Final: drop any guard that is seated (rest) from the outgoing queue (safety)
  const filteredQueue: QueueEntry[] = [];
  for (const q of queuedOutAdult) {
    if (seatedNowAdult.has(q.guardId)) continue;
    filteredQueue.push(q);
  }

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ADULT_SWIM", breakQueue: filteredQueue },
  };
}


  // ===== NORMAL TICK =====
  // 1) End-of-section → enqueue into NEXT section
  const toEnqueue: Array<{ sec: string; gid: string }> = [];
  for (const seat of Object.keys(assigned)) {
  const gid = assigned[seat];
  if (!gid) continue;
  if (lastSeatSet.has(seat)) {
    const curSec = sectionBySeat[seat];
    const nextSec = nextSectionId(curSec);
    qBuckets[nextSec].push({ guardId: gid, returnTo: nextSec, enteredTick: currentTick });
  }
}

  // 2) Advance within each section (rightward), skipping vacated tails
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
  // 3) Refill first seat from the section queue if guard has waited >= 1 full tick
  for (const s of SECTIONS) {
    const entrySeat = firstSeatBySection[s];
    if (nextAssigned[entrySeat]) continue; // already filled by advance
    const bucket = qBuckets[s];
    const idx = bucket.findIndex((e) => e.enteredTick < currentTick);
    if (idx !== -1) {
      const [entry] = bucket.splice(idx, 1);
      nextAssigned[entrySeat] = entry.guardId;
      seatedThisTick.add(entry.guardId);
    }
  }

  // 4) Build output queue: keep order, dedupe by guardId, drop anyone seated now
  const outQueue: QueueEntry[] = [];
  const seen = new Set<string>();
  for (const s of SECTIONS) {
    for (const q of qBuckets[s]) {
      if (seatedThisTick.has(q.guardId)) continue; // seated this frame
      if (seen.has(q.guardId)) continue;
      seen.add(q.guardId);
      outQueue.push(q);
    }
  }



  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: outQueue },
  };
}
