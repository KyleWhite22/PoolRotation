// backend/src/engine/rotation.ts
import { POSITIONS, EDGES, VIEWBOX, POOL_PATH_D, REST_STATIONS }
  from "../../../shared/data/poolLayout.js";

export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type BreakState = Record<string, string>;
export type Conflict = { stationId: string; reason: "AGE_RULE"; guardId: string };

const NEXT_BY_FROM = new Map<string, string>(EDGES.map((e) => [e.from, e.to]));

type Period = "ALL_AGES" | "ADULTS_ONLY";

function periodOfNow(now = new Date()): Period {
  return now.getMinutes() < 45 ? "ALL_AGES" : "ADULTS_ONLY";
}

// TEST-SAFE engine:
// - Pure wrap movement
// - Adults-only at :45 clears non-rest stations
// - No break timers, no age-rule enforcement
export type EngineOutput = {
  nextAssigned: Assigned;
  nextBreaks: BreakState;
  conflicts: Conflict[];
  meta: { period: Period };
};

export function rotateOnceEngine(
  assigned: Assigned,
  _guards: Guard[],
  breaks: BreakState,
  now = new Date()
): EngineOutput {
  const period = periodOfNow(now);

  // 1) Move everyone one step along the ring
  const next: Assigned = Object.fromEntries(POSITIONS.map((p) => [p.id, null]));
  for (const p of POSITIONS) {
    const gid = assigned[p.id];
    if (!gid) continue;
    const to = NEXT_BY_FROM.get(p.id);
    if (to) next[to] = gid;
  }

  // 2) Adults-only: keep ONLY REST_STATIONS staffed
  if (period === "ADULTS_ONLY") {
    for (const sid of Object.keys(next)) {
      if (!REST_STATIONS.has(sid)) next[sid] = null;
    }
  }

  return {
    nextAssigned: next,
    nextBreaks: breaks, // unchanged in test mode
    conflicts: [],      // skip age checks in test mode
    meta: { period },
  };
}

export function computeNext(opts: {
  assigned: Assigned;
  guards: Guard[];
  breaks: BreakState;
  nowISO: string;
}) {
  return rotateOnceEngine(opts.assigned, opts.guards, opts.breaks, new Date(opts.nowISO));
}
