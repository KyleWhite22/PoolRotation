import { useMemo, useState, Fragment } from "react";
import type { QueueEntry, Guard } from "../../lib/types.js";
import { POSITIONS } from "../../../../shared/data/poolLayout.js";

const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);

type MovePayload = {
  guardId: string;
  fromSec: string;
  fromIndex: number;
  toSec: string;
  toIndex: number;
};

type ExternalDropPayload = {
  guardId: string;
  source: "bench" | "seat" | ""; // "" when unknown
  sec: string;
  index: number;
};

export default function BreakQueue({
  queuesBySection,
  flatQueue,
  seatedSet,
  guards,
  onClearAll,
  onDropGuardToSection,   // legacy append to bucket
  onMoveWithinQueue,      // precise reorder (queue→queue)
  onDropExternalToQueue,  // bench/seat → queue at index
}: {
  queuesBySection: Record<string, QueueEntry[]>;
  flatQueue: QueueEntry[];
  seatedSet: Set<string>;
  guards: Guard[];
  onClearAll: () => void;
  onDropGuardToSection?: (sec: string, e: React.DragEvent) => void;
  onMoveWithinQueue?: (p: MovePayload) => void;
  onDropExternalToQueue?: (p: ExternalDropPayload, e: React.DragEvent) => void;
}) {
  const [dragOverSec, setDragOverSec] = useState<string | null>(null);

  const sections = useMemo(
    () =>
      Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
        (a, b) => Number(a) - Number(b)
      ),
    []
  );

  const guardById = useMemo(() => {
    const m = new Map<string, Guard>();
    guards.forEach((g) => m.set(strip(g.id), g));
    return m;
  }, [guards]);

  const entriesFor = (sec: string): QueueEntry[] => {
    const bucket = queuesBySection?.[sec];
    return (bucket?.length ? bucket : flatQueue.filter((q) => q.returnTo === sec)).filter(
      (q) => !seatedSet.has(strip(q.guardId))
    );
  };

  const labelFor = (gidRaw: string) => {
    const id = strip(gidRaw);
    return guardById.get(id)?.name || id;
  };

  // ----- Gap (between-chips) target for precise index drops -----
  const Gap = ({
    sec,
    index,
  }: {
    sec: string;
    index: number; // destination index *in this bucket*
  }) => {
    return (
      <span
        // visual: a slim, invisible-ish spacer that still receives drops
        className="inline-block w-2 h-6 align-middle"
        onDragOver={(e) => {
          // allow dropping here and make it look like a valid move
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();

          const dt = e.dataTransfer;
          const rawId = dt.getData("application/x-guard-id") || dt.getData("text/plain");
          if (!rawId) return;
          const guardId = rawId.trim();
          const source = (dt.getData("application/x-source") || "") as "queue" | "bench" | "seat" | "";

          const fromSec = dt.getData("application/x-queue-section") || "";
          const fromIndexRaw = dt.getData("application/x-queue-index");
          const fromIndex = fromIndexRaw ? parseInt(fromIndexRaw, 10) : -1;

          if (source === "queue" && fromSec) {
            // Reorder within/between queues
            onMoveWithinQueue?.({
              guardId,
              fromSec,
              fromIndex: Number.isFinite(fromIndex) ? fromIndex : -1,
              toSec: sec,
              toIndex: index,
            });
          } else {
            // External (bench/seat) → specific index
            onDropExternalToQueue?.(
              { guardId, source: source === "queue" ? "" as const : source, sec, index },
              e
            );
          }
          setDragOverSec(null);
        }}
      />
    );
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-md font-semibold text-slate-100">Break queue</h3>
        <button
          onClick={onClearAll}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sm"
        >
          Clear queues
        </button>
      </div>

      <ul className="space-y-2">
        {sections.map((sec) => {
          const entries = entriesFor(sec);
          const active = dragOverSec === sec;

          return (
            <li key={sec} className="flex items-center gap-3">
              <span className="w-6 text-right font-mono text-slate-300">{sec}.</span>

              {/* BUCKET */}
              <div
                data-section-id={sec}
                className={[
                  "flex-1 rounded-xl border px-2 py-2 min-h-[44px] transition-colors",
                  active
                    ? "border-sky-400 bg-slate-800/60"
                    : "border-slate-700 bg-slate-800/40",
                ].join(" ")}
                onDragOver={(e) => {
                  // Needed so background accepts drops (legacy append)
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  setDragOverSec(sec);
                }}
                onDragEnter={() => setDragOverSec(sec)}
                onDragLeave={(e) => {
                  const next = e.relatedTarget as Node | null;
                  if (!next || !(e.currentTarget as Node).contains(next)) {
                    if (dragOverSec === sec) setDragOverSec(null);
                  }
                }}
                onDrop={(e) => {
                  // Background drop = append to end (legacy).
                  // BUT: if source is 'queue', we ignore, because
                  // precise reorders should use gaps.
                  const src = e.dataTransfer.getData("application/x-source");
                  if (src === "queue") {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverSec(null);
                    return;
                  }

                  if (!onDropGuardToSection) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDropGuardToSection(sec, e);
                  setDragOverSec(null);
                }}
              >
                {entries.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Leading gap at index 0 */}
                    <Gap sec={sec} index={0} />

                    {entries.map((q, i) => {
                      const gid = strip(q.guardId);
                      const label = labelFor(gid);
                      return (
                        <Fragment key={`${sec}-${i}-${gid}`}>
                          {/* CHIP */}
                          <span
                            className="px-2 py-0.5 rounded bg-slate-900/70 border border-slate-700 text-slate-100 text-sm select-none cursor-grab active:cursor-grabbing"
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("application/x-guard-id", gid);
                              e.dataTransfer.setData("application/x-source", "queue");
                              e.dataTransfer.setData("application/x-queue-section", sec);
                              e.dataTransfer.setData("application/x-queue-index", String(i));
                              e.dataTransfer.setData("text/plain", gid);
                            }}
                            onDragOver={(e) => {
                              // prevent bubbling to bucket (avoids double-handling)
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              // If someone *does* drop directly on a chip,
                              // treat it as "insert before this chip".
                              e.preventDefault();
                              e.stopPropagation();

                              const dt = e.dataTransfer;
                              const rawId =
                                dt.getData("application/x-guard-id") || dt.getData("text/plain");
                              if (!rawId) return;
                              const guardId = rawId.trim();
                              const source = (dt.getData("application/x-source") || "") as
                                | "queue"
                                | "bench"
                                | "seat"
                                | "";

                              const fromSec = dt.getData("application/x-queue-section") || "";
                              const fromIndexRaw = dt.getData("application/x-queue-index");
                              const fromIndex = fromIndexRaw ? parseInt(fromIndexRaw, 10) : -1;

                              if (source === "queue" && fromSec) {
                                onMoveWithinQueue?.({
                                  guardId,
                                  fromSec,
                                  fromIndex: Number.isFinite(fromIndex) ? fromIndex : -1,
                                  toSec: sec,
                                  toIndex: i, // insert before this chip
                                });
                              } else {
                                onDropExternalToQueue?.(
                                  {
                                    guardId,
                                    source: source === "queue" ? "" : source,
                                    sec,
                                    index: i,
                                  },
                                  e
                                );
                              }
                              setDragOverSec(null);
                            }}
                          >
                            {label}
                          </span>

                          {/* Gap between i and i+1 maps to index i+1 */}
                          <Gap sec={sec} index={i + 1} />
                        </Fragment>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-slate-500 text-sm">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
