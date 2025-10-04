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
  source: "bench" | "seat" | ""; // "" when unknown (never "queue")
  sec: string;
  index: number;
};

export default function BreakQueue({
  queuesBySection,
  flatQueue,
  seatedSet,
  guards,
  onClearAll,
  onDropGuardToSection,   // legacy append to bucket (background)
  onMoveWithinQueue,      // queue↔queue precise reorder
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

  // Small invisible gap between chips to accept precise index drops
  const Gap = ({ sec, index }: { sec: string; index: number }) => (
    <span
      className="inline-block w-2 h-6 align-middle"
      onDragOver={(e) => {
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
            toIndex: index,
          });
        } else {
          onDropExternalToQueue?.(
            { guardId, source: source === "queue" ? "" : source, sec, index },
            e
          );
        }
        setDragOverSec(null);
      }}
    />
  );

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

              {/* Bucket background: legacy append (bench/seat only) */}
              <div
                data-section-id={sec}
                className={[
                  "flex-1 rounded-xl border px-2 py-2 min-h-[44px] transition-colors",
                  active ? "border-sky-400 bg-slate-800/60" : "border-slate-700 bg-slate-800/40",
                ].join(" ")}
                onDragOver={(e) => {
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
                  // If source is queue, we ignore background drop so chips/gaps control order.
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
                  onDropGuardToSection(sec, e); // append to end (legacy)
                  setDragOverSec(null);
                }}
              >
                {entries.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Leading gap (index 0) */}
                    <Gap sec={sec} index={0} />

                    {entries.map((q: QueueEntry, i: number) => {
                      const gid = strip(q.guardId);
                      const label = labelFor(gid);
                      return (
                        <Fragment key={`${sec}-${i}-${gid}`}>
                          {/* Chip */}
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
                              // Allow dropping ON the chip (treated as insert-before).
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              // Insert before this chip
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
                                  toIndex: i,
                                });
                              } else {
                                onDropExternalToQueue?.(
                                  { guardId, source: source === "queue" ? "" : source, sec, index: i },
                                  e
                                );
                              }
                              setDragOverSec(null);
                            }}
                          >
                            {label}
                          </span>

                          {/* Gap after this chip => index i+1 */}
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
