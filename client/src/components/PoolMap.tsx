import React, { useMemo, useState } from "react";
import {
  POSITIONS,
  EDGES,
  VIEWBOX,
  POOL_SHAPES,
  REST_BY_SECTION,
} from "../../../shared/data/poolLayout.js";

export type Assigned = Record<string, string | null>;
type Guard = { id: string; name: string; dob: string };

type Props = {
  guards: Guard[];
  assigned: Assigned;
  onPick: (positionId: string) => void;
  onClear: (positionId: string) => void; // kept for compatibility
  className?: string;
  conflicts?: { stationId: string }[];
  /** Called when a guard chip is dropped onto a seat */
  onSeatDrop?: (positionId: string, guardId: string) => void;
  /** Set of guard IDs age ≤ 15 to underline on map */
  minorIds?: Set<string>;
};

// ---- helpers ----
const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);

export default function PoolMap({
  guards,
  assigned,
  onPick,
  onClear, // not used here, kept for API compatibility
  className,
  conflicts = [],
  onSeatDrop,
  minorIds,
}: Props) {
  const [dragSeatId, setDragSeatId] = useState<string | null>(null);

  const guardNameById = useMemo(() => {
    const m = new Map<string, string>();
    guards.forEach((g) => m.set(strip(g.id), g.name));
    return m;
  }, [guards]);

  const isRestSeat = (seatId: string) => {
    const section = seatId.split(".")[0];
    return REST_BY_SECTION?.[section] === seatId;
  };

  const getDroppedGuardId = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    const gid = dt.getData("application/x-guard-id") || dt.getData("text/plain");
    return gid?.trim() || null;
  };

  return (
    <svg
      viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}`}
      className={className ?? "w-full h-[88vh]"}
      role="img"
      aria-label="Pool map"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker id="arrowhead" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L5,2.5 L0,5 Z" fill="#60a5fa" />
        </marker>
      </defs>

      {/* Pool shapes */}
      {POOL_SHAPES.map((s: any, i: number) =>
        s.type === "path" ? (
          <path
            key={`shape-${i}`}
            d={s.d}
            fill={i === 0 ? "#bae6fd" : "none"}
            stroke="#7ba7edff"
            strokeWidth={0.8}
            opacity={i === 0 ? 1 : 0.9}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
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
            pointerEvents="none"
          />
        )
      )}

      {/* Edges */}
      {EDGES.map((e: any) => {
        const a = POSITIONS.find((p: any) => p.id === e.from)!;
        const b = POSITIONS.find((p: any) => p.id === e.to)!;

        const boxW = 30, boxH = 22;
        const pad = Math.hypot(boxW, boxH) / 2 - 5;

        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;

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

      {/* Seats */}
      {POSITIONS.map((p: any) => {
        const rawId = assigned[p.id] ?? null;
        const guardId = rawId ? strip(rawId) : null; // normalize
        const name = guardId ? guardNameById.get(guardId) ?? "" : "";
        const [first, ...restParts] = name.split(" ");
        const last = restParts.join(" ");
        const isRest = isRestSeat(p.id);
        const isConflict = conflicts.some((c) => c.stationId === p.id);
        const isDragOver = dragSeatId === p.id;
        const isMinor = guardId ? minorIds?.has(guardId) : false;

        return (
          <g
            key={p.id}
            transform={`translate(${p.x} ${p.y})`}
            className="cursor-pointer"
            data-seat-id={p.id}
            onClick={() => onPick(p.id)}
            // --- Drop onto seats ---
            onDragOver={(e) => {
              e.preventDefault();
              if (dragSeatId !== p.id) setDragSeatId(p.id);
            }}
            onDragLeave={(e) => {
              const nextTarget = e.relatedTarget as Node | null;
              if (!nextTarget || !(e.currentTarget as Node).contains(nextTarget)) {
                if (dragSeatId === p.id) setDragSeatId(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const gid = getDroppedGuardId(e);
              if (gid) onSeatDrop?.(p.id, strip(gid));
              setDragSeatId(null);
            }}
          >
            {/* big invisible hit area for click & drop */}
            <rect x={-22} y={-22} width={44} height={44} fill="transparent" pointerEvents="all" />

            {/* Drag-over highlight */}
            {isDragOver && (
              <rect
                x={-18}
                y={-18}
                width={36}
                height={36}
                rx={4}
                fill="none"
                stroke="#60a5fa"
                strokeWidth={2}
                opacity={0.9}
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* Rest seat outline */}
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

            {/* Occupant chip (draggable) */}
            {guardId ? (
              <foreignObject x={-18} y={-18} width={36} height={36}>
                <div
                  className={isMinor ? "underline underline-offset-2 decoration-amber-400" : undefined}
                  style={{
                    width: 36,
                    height: 36,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#f1f5f9",
                    fontSize: last ? 7 : 8,
                    lineHeight: "10px",
                    userSelect: "none",
                    cursor: "grab",
                    pointerEvents: "auto", // critical to allow DnD
                  }}
                  draggable
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(p.id);
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    // payload BreakQueue expects:
                    e.dataTransfer.setData("application/x-guard-id", guardId);
                    e.dataTransfer.setData("application/x-source", "seat");
                    e.dataTransfer.setData("application/x-seat-id", p.id);
                    // fallback text
                    e.dataTransfer.setData("text/plain", guardId);
                    // optional tiny drag-image to avoid jitter
                    try {
                      const img = new Image();
                      img.src = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMXB4IiBoZWlnaHQ9IjFweCIvPg==";
                      e.dataTransfer.setDragImage(img, 0, 0);
                    } catch {}
                  }}
                >
                  {last ? (
                    <>
                      <span style={{ transform: "translateY(-1px)" }}>{first}</span>
                      <span style={{ transform: "translateY(1px)" }}>{last}</span>
                    </>
                  ) : (
                    <span>{first}</span>
                  )}
                </div>
              </foreignObject>
            ) : (
              <text x={0} y={3} textAnchor="middle" fontSize="10" fill="#f1f5f9">
                X
              </text>
            )}

            {/* Conflict ring */}
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

      {/* Legend (compact) */}
      <g transform={`translate(${VIEWBOX.x + 10} ${VIEWBOX.y + 20})`}>
        <text x={0} y={0} fontSize="10" fill="#f1f5f9" fontWeight="bold">
          Legend
        </text>
        <foreignObject x={0} y={6} width={120} height={16}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              whiteSpace: "nowrap",
              fontSize: 9,
              color: "#f1f5f9",
              lineHeight: 1,
              margin: 0,
              padding: 0,
            }}
          >
            <span
              style={{
                textDecoration: "underline",
                textDecorationColor: "#facc15",
                textUnderlineOffset: 2,
              }}
            >
              GuardName
            </span>
            <span style={{ marginLeft: 2 }}>= &lt;16 yrs old</span>
          </div>
        </foreignObject>
        <g transform="translate(0 26)">
          <rect x={0} y={0} width={12} height={12} stroke="#dc2626" strokeWidth={1.5} fill="none" rx={2} />
          <text x={16} y={9} fontSize="9" fill="#f1f5f9">
            Rest chair
          </text>
        </g>
      </g>
    </svg>
  );
}
