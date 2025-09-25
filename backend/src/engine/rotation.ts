console.log("[engine/rotation] LOADED");
import { POSITIONS } from "../../../shared/data/poolLayout.js";

export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type BreakState = Record<string, string>;
export type Conflict = { stationId: string; reason: "AGE_RULE"; guardId: string };
export type QueueEntry = { guardId: string; returnTo: string };

// Build sections and seats-in-section in numeric order
const SECTIONS = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

const seatsBySection: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const s of SECTIONS) map[s] = [];
  for (const p of POSITIONS) {
    const [sec] = p.id.split(".");
    map[sec].push(p.id);
  }
  for (const s of SECTIONS) {
    map[s].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
  }
  return map;
})();

// Global ring: [1.1,1.2,1.3, 2.1,2.2,2.3, 3.1,3.2,3.3, 4.1,4.2]
const RING: string[] = SECTIONS.flatMap(sec => seatsBySection[sec]);

export type EngineOutput = {
  nextAssigned: Assigned;
  nextBreaks: BreakState;
  conflicts: Conflict[];
  meta: { period: "ALL_AGES"; breakQueue: QueueEntry[] };
};

// Everyone moves to the next seat in the ring (wrap around).
export function rotateOnceEngine(
  assigned: Assigned,
  _guards: Guard[],
  breaks: BreakState,
  _now = new Date(),
  _queue: QueueEntry[] = []
): EngineOutput {
  const nextAssigned: Assigned = Object.fromEntries(POSITIONS.map(p => [p.id, null as string | null]));

  for (let i = 0; i < RING.length; i++) {
    const from = RING[i];
    const gid = assigned[from];
    if (!gid) continue;
    const to = RING[(i + 1) % RING.length];
    nextAssigned[to] = gid;
  }

  return {
    nextAssigned,
    nextBreaks: breaks,
    conflicts: [],
    meta: { period: "ALL_AGES", breakQueue: _queue },
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
