import { useMemo } from "react";
import {
  POSITIONS,
  EDGES,
  VIEWBOX,
  POOL_SHAPES,          // ⬅️ use shapes array instead of POOL_PATH_D
  REST_BY_SECTION,
} from "../../../shared/data/poolLayout.js";

export type Assigned = Record<string, string | null>;
type Guard = { id: string; name: string; dob: string };

type Props = {
  guards: Guard[];
  assigned: Assigned;
  onPick: (positionId: string) => void;
  onClear: (positionId: string) => void;
  className?: string;
  conflicts?: { stationId: string }[]; // optional
};

function endWithPadding(ax: number, ay: number, bx: number, by: number, pad: number) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  return { x2: bx - ux * pad, y2: by - uy * pad };
}

export default function PoolMap({
  guards,
  assigned,
  onPick,
  onClear,
  className,
  conflicts = [],
}: Props) {
  const guardNameById = useMemo(() => {
    const m = new Map<string, string>();
    guards.forEach((g) => m.set(g.id, g.name));
    return m;
  }, [guards]);

  const isRestSeat = (seatId: string) => {
    const section = seatId.split(".")[0];
    return REST_BY_SECTION?.[section] === seatId;
  };

  return (
    <svg
      viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}`}
      // Let it grow: fill width, take ~88% of viewport height (fallback to your prop)
      className={className ?? "w-full h-[88vh]"}
      role="img"
      aria-label="Pool map"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker id="arrowhead" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L5,2.5 L0,5 Z" fill="#60a5fa" />
        </marker>
        <linearGradient id="poolFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {/* Draw ALL shapes from POOL_SHAPES */}
     {POOL_SHAPES.map((s, i) =>
  s.type === "path" ? (
    <path
      key={`shape-${i}`}
      d={s.d}
      fill={i === 0 ? "#bae6fd" : "none"}
      stroke="#7ba7edff"
      strokeWidth={0.8}
      opacity={i === 0 ? 1 : 0.9}
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"        // ⬅️ ignore clicks
    />
  ) : (
    <rect
      key={`shape-${i}`}
      x={s.x}
      y={s.y}
      width={s.width}
      height={s.height}
      fill="none"
      stroke="#7ba7edff"
      strokeWidth={0.8}
      opacity={0.9}
      vectorEffect="non-scaling-stroke"
      pointerEvents="none"        // ⬅️ ignore clicks
    />
  )
)}


      {/* Edges */}
      {/* edges */}
      {EDGES.map((e) => {
        const a = POSITIONS.find((p) => p.id === e.from)!;
        const b = POSITIONS.find((p) => p.id === e.to)!;

        // Visual “seat box” footprint (even if you’re not drawing boxes)
        const boxW = 30, boxH = 22;
        const pad = Math.hypot(boxW, boxH) / 2 - 5; // distance to inset from each seat

        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;

        // Inset start *and* end by the same padding
        const x1 = a.x + ux * pad;
        const y1 = a.y + uy * pad;
        const x2 = b.x - ux * pad;
        const y2 = b.y - uy * pad;

        return (
          <line
            key={`${e.from}-${e.to}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="#60a5fa"
            strokeDasharray="2 2"
            strokeWidth={0.8}
            opacity={0.9}
            markerEnd="url(#arrowhead)"
            pointerEvents="none"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
     {POSITIONS.map((p) => {
  const guardId = assigned[p.id] ?? null;
  const name = guardId ? guardNameById.get(guardId) ?? "" : "";
  const [first, ...restParts] = name.split(" ");
  const last = restParts.join(" ");

  const isRest = isRestSeat(p.id);
  const isConflict = conflicts.some((c) => c.stationId === p.id);

  return (
    <g
      key={p.id}
      transform={`translate(${p.x} ${p.y})`}
      className="cursor-pointer"
      onClick={() => onPick(p.id)}
    >
      {/* Invisible hit area (bigger than visuals) */}
      <rect
        x={-22}
        y={-22}
        width={44}
        height={44}
        fill="transparent"
        pointerEvents="all"   // ⬅️ ensure this receives the click
      />

      {/* Rest seat outline stays visible & clickable */}
      {isRest && (
        <rect
          x={-14}
          y={-14}
          width={28}
          height={28}
          rx={2}
          fill="none"
          stroke="#dc2626"
          strokeWidth={1.8}
          vectorEffect="non-scaling-stroke"
        />
      )}

     {guardId ? (
  last ? (
    <>
      {/* Two lines if there is a first and last */}
      <text
        x={0}
        y={-2}
        textAnchor="middle"
        fontSize="7"
        fill="#f1f5f9"
      >
        {first}
      </text>
      <text
        x={0}
        y={8}
        textAnchor="middle"
        fontSize="7"
        fill="#f1f5f9"
      >
        {last}
      </text>
    </>
  ) : (
    /* Single line if only one word */
    <text
      x={0}
      y={3}           // <- center the single name in the seat
      textAnchor="middle"
      fontSize="8"
      fill="#f1f5f9"
    >
      {first}
    </text>
  )
) : (
  <text
    x={0}
    y={3}
    textAnchor="middle"
    fontSize="10"
    fill="#f1f5f9"
  >
    X
  </text>
)}


      {isConflict && (
        <circle
          cx={0}
          cy={0}
          r={16}
          fill="none"
          stroke="#ef4444"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
})}
    </svg>
  );
}
