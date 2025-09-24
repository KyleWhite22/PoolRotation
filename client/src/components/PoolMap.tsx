import { useMemo } from "react";
import type { Position } from "../data/poolLayout";
import { VIEWBOX, POOL_PATH_D, POSITIONS, EDGES } from "../data/poolLayout";

export type Assigned = Record<string, string | null>;
type Guard = { id: string; name: string; dob: string };

type Props = {
    guards: Guard[];
    assigned: Assigned;
    onPick: (positionId: string) => void;
    onClear: (positionId: string) => void;
    className?: string; // allow parent to control size
};
function endWithPadding(ax: number, ay: number, bx: number, by: number, pad: number) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    return { x2: bx - ux * pad, y2: by - uy * pad };
}
export default function PoolMap({ guards, assigned, onPick, onClear, className }: Props) {
    const guardNameById = useMemo(() => {
        const m = new Map<string, string>();
        guards.forEach((g) => m.set(g.id, g.name));
        return m;
    }, [guards]);

    return (
        <svg
            viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}`}
            className={className ?? "w-full h-[420px]"}
            role="img"
            aria-label="Pool map"
        >
            {/* Gradient defs */}
            <defs>
                <marker
                    id="arrowhead"
                    markerWidth="5"
                    markerHeight="5"
                    refX="4"
                    refY="2.5"
                    orient="auto"
                    markerUnits="strokeWidth"
                >
                    <path d="M0,0 L5,2.5 L0,5 Z" fill="#60a5fa" />
                </marker>

                <linearGradient id="poolFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.15" />
                </linearGradient>
            </defs>

            {/* Pool outline */}
            <path
                d={POOL_PATH_D}
                transform="translate(-20,-30) scale(1.3)"  // adjust as needed
                fill="url(#poolFill)"
                stroke="#3b82f6"
                strokeWidth={0.8}
            />

            {/* Edges (connections) */}
            {EDGES.map((e) => {
                const a = POSITIONS.find((p) => p.id === e.from)!;
                const b = POSITIONS.find((p) => p.id === e.to)!;

                // same dimensions you use for boxes in the Nodes section
                const boxW = 30; // <- keep in sync with your node box size
                const boxH = 22;
                // stop before the box: half the diagonal minus a hair
                const pad = Math.hypot(boxW, boxH) / 2 - 5; // closer to box

                const { x2, y2 } = endWithPadding(a.x, a.y, b.x, b.y, pad);

                return (
                    <line
                        key={`${e.from}-${e.to}`}
                        x1={a.x}
                        y1={a.y}
                        x2={x2}
                        y2={y2}
                        stroke="#60a5fa"
                        strokeDasharray="2 2"
                        strokeWidth={0.8}
                        opacity={0.9}
                        markerEnd="url(#arrowhead)"
                        pointerEvents="none" // clicks pass through to boxes
                    />
                );
            })}
            {/* Nodes */}
            {POSITIONS.map((p) => {
                const selectedGuardId = assigned[p.id] ?? null;
                const has = Boolean(selectedGuardId);

                const boxW = 20;
                const boxH = 16;

                // derive name + split into first/last (inside the loop)
                const fullName = has ? (guardNameById.get(selectedGuardId!) ?? "") : "";
                const [first, ...rest] = fullName.split(" ");
                const last = rest.join(" ");

                return (
                    <g key={p.id} transform={`translate(${p.x - boxW / 2} ${p.y - boxH / 2})`}>
                        <rect
                            width={boxW}
                            height={boxH}
                            rx={1.6}
                            className="cursor-pointer"
                            fill={has ? "#1e293b" : "rgba(2,6,23,0.5)"}
                            stroke={has ? "#22c55e" : "#64748b"}
                            strokeWidth={0.7}
                            onClick={() => onPick(p.id)}
                        />

                        {/* Station label */}
                        <text x={boxW / 2} y={3.5} textAnchor="middle" fontSize="3" fill="#9cc2ff">
                            {p.label}
                        </text>

                        {/* Assigned guard name: first on top, last below. Otherwise show "Assign" */}
                        {has ? (
                            <>
                                <text
                                    x={boxW / 2}
                                    y={7.5}                 // top line
                                    textAnchor="middle"
                                    fontSize="3"
                                    fill="#e2e8f0"
                                >
                                    {first}
                                </text>
                                {last && (
                                    <text
                                        x={boxW / 2}
                                        y={11.5}              // bottom line
                                        textAnchor="middle"
                                        fontSize="3"
                                        fill="#e2e8f0"
                                    >
                                        {last}
                                    </text>
                                )}
                            </>
                        ) : (
                            <text
                                x={boxW / 2}
                                y={9.5}
                                textAnchor="middle"
                                fontSize="3"
                                fill="#e2e8f0"
                                className="pointer-events-none"
                            >
                                Assign
                            </text>
                        )}

                        {/* Clear button */}
                        {has && (
                            <g transform={`translate(${boxW - 4.5} ${-2})`}>
                                <rect
                                    width={6}
                                    height={4}
                                    rx={0.9}
                                    fill="#991b1b"
                                    className="cursor-pointer"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClear(p.id);
                                    }}
                                />
                                <text
                                    x={3}
                                    y={2.8}
                                    textAnchor="middle"
                                    fontSize="2.4"
                                    fill="#fff"
                                    className="cursor-pointer select-none"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClear(p.id);
                                    }}
                                >
                                    ✕
                                </text>
                            </g>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
