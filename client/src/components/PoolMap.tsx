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
    guards.forEach((g) => m.set(g.id, g.name));
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
        <linearGradient id="poolFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.15" />
        </linearGradient>
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
        const guardId = assigned[p.id] ?? null;
        const name = guardId ? guardNameById.get(guardId) ?? "" : "";
        const [first, ...restParts] = name.split(" ");
        const last = restParts.join(" ");
        const isRest = isRestSeat(p.id);
        const isConflict = conflicts.some((c) => c.stationId === p.id);
        const isDragOver = dragSeatId === p.id;
        const isMinor = guardId ? minorIds?.has(guardId) : false; // ← underline trigger

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
              if (gid) onSeatDrop?.(p.id, gid);
              setDragSeatId(null);
            }}
          >
            {/* Invisible hit area for easy click & drop (drawn first = behind content) */}
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

            {/* Content: draggable HTML chip inside foreignObject */}
            {guardId ? (
              <foreignObject x={-18} y={-18} width={36} height={36}>
                <div
                  className={isMinor ? "underline underline-offset-2 decoration-amber-400" : undefined}
                  style={{
                    width: "36px",
                    height: "36px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#f1f5f9",
                    fontSize: last ? "7px" : "8px",
                    lineHeight: "10px",
                    userSelect: "none",
                    cursor: "grab",
                    // critical: allow events to reach this HTML node
                    pointerEvents: "auto",
                  }}
                  draggable
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(p.id);
                  }}
                  onDragStart={(e) => {
                    // mark this drag as originating from a seat
                    e.dataTransfer.setData("application/x-guard-id", guardId);
                    e.dataTransfer.setData("application/x-source", "seat");
                    e.dataTransfer.setData("application/x-seat-id", p.id);
                    e.dataTransfer.setData("text/plain", guardId);
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
    </svg>
  );
}
