import React, { useMemo, useState, Fragment } from "react";
import type { QueueEntry, Guard } from "../../lib/types.js";
import { POSITIONS } from "../../data/poolLayout.js";

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
  source: "bench" | "seat" | ""; // never "queue" here
  sec: string;
  index: number;
};

type Props = {
  queuesBySection: Record<string, QueueEntry[]>;
  flatQueue: QueueEntry[];
  seatedSet: Set<string>;
  guards: Guard[];
  onClearAll: () => void;
  onDropGuardToSection?: (sec: string, e: React.DragEvent) => void; // append to end (legacy)
  onMoveWithinQueue?: (p: MovePayload) => void;                      // precise reorder
  onDropExternalToQueue?: (p: ExternalDropPayload, e: React.DragEvent) => void; // bench/seat → queue@index
};

// --- helpers ---
type ExternalSource = "" | "bench" | "seat";
const readDragSource = (dt: DataTransfer): { raw: string; external: ExternalSource } => {
  const raw = (dt.getData("application/x-source") || "").trim(); // may be "queue"
  const external = (raw === "queue" ? "" : (raw as ExternalSource));
  return { raw, external };
};
const parseIndex = (v: string | null): number =>
  v && /^\d+$/.test(v) ? parseInt(v, 10) : -1;

export default function BreakQueue({
  queuesBySection,
  flatQueue,
  seatedSet,
  guards,
  onClearAll,
  onDropGuardToSection,
  onMoveWithinQueue,
  onDropExternalToQueue,
}: Props) {
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
    for (const g of guards) m.set(strip(g.id), g);
    return m;
  }, [guards]);

  const labelFor = (gidRaw: string) => {
    const id = strip(gidRaw);
    return guardById.get(id)?.name || id;
  };

  // Authoritative entries for a section:
  // - prefer buckets; fallback to flatQueue filter
  // - drop already-seated guards
  // - dedupe by guardId (first occurrence wins)
  const entriesFor = (sec: string): QueueEntry[] => {
    const fromBuckets = queuesBySection?.[sec];
    const source =
      (fromBuckets?.length ? fromBuckets : flatQueue.filter((q) => q.returnTo === sec)) || [];
    const seen = new Set<string>();
    const out: QueueEntry[] = [];
    for (const q of source) {
      const id = strip(q.guardId);
      if (seatedSet.has(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ guardId: id, returnTo: sec, enteredTick: Number(q.enteredTick) || 0 });
    }
    return out;
  };

  // Adjust target index when moving inside the same section and the source index is before target.
  const adjustedIndex = (fromSec: string, toSec: string, fromIndex: number, toIndex: number) => {
    if (fromSec === toSec && fromIndex >= 0 && toIndex >= 0 && fromIndex < toIndex) {
      return Math.max(0, toIndex - 1);
    }
    return toIndex;
  };

  // Small invisible gap between chips to accept precise index drops
  const Gap = ({ sec, index }: { sec: string; index: number }) => (
    <span
      className="inline-block align-middle"
      style={{ width: 12, height: 24, outline: "none" }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setDragOverSec(sec);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();

        const dt = e.dataTransfer;
        const rawId = dt.getData("application/x-guard-id") || dt.getData("text/plain");
        if (!rawId) return;

        const guardId = strip(rawId.trim());
        const { raw, external } = readDragSource(dt);
        const fromSec = dt.getData("application/x-queue-section") || "";
        const fromIndex = parseIndex(dt.getData("application/x-queue-index"));

        if (raw === "queue" && fromSec) {
          onMoveWithinQueue?.({
            guardId,
            fromSec,
            fromIndex: Number.isFinite(fromIndex) ? fromIndex : -1,
            toSec: sec,
            toIndex: adjustedIndex(fromSec, sec, fromIndex, index),
          });
        } else {
          onDropExternalToQueue?.({ guardId, source: external, sec, index }, e);
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
                  // Ignore background drops from within the queue; chips/gaps control order.
                  const { raw } = readDragSource(e.dataTransfer);
                  if (raw === "queue") {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOverSec(null);
                    return;
                  }
                  if (!onDropGuardToSection) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDropGuardToSection(sec, e); // append to end (legacy path)
                  setDragOverSec(null);
                }}
              >
                {entries.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Gap sec={sec} index={0} />
                    {entries.map((q, i) => {
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
                              e.dataTransfer.setData("application/x-guard-id", gid); // stripped
                              e.dataTransfer.setData("application/x-source", "queue");
                              e.dataTransfer.setData("application/x-queue-section", sec);
                              e.dataTransfer.setData("application/x-queue-index", String(i));
                              e.dataTransfer.setData("text/plain", gid);
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();

                              const dt = e.dataTransfer;
                              const rawId =
                                dt.getData("application/x-guard-id") ||
                                dt.getData("text/plain");
                              if (!rawId) return;

                              const guardId = strip(rawId.trim());
                              const { raw, external } = readDragSource(dt);
                              const fromSec = dt.getData("application/x-queue-section") || "";
                              const fromIndex = parseIndex(dt.getData("application/x-queue-index"));

                              if (raw === "queue" && fromSec) {
                                onMoveWithinQueue?.({
                                  guardId,
                                  fromSec,
                                  fromIndex: Number.isFinite(fromIndex) ? fromIndex : -1,
                                  toSec: sec,
                                  // insert BEFORE this chip; adjust if moving downward in same bucket
                                  toIndex: adjustedIndex(fromSec, sec, fromIndex, i),
                                });
                              } else {
                                onDropExternalToQueue?.(
                                  { guardId, source: external, sec, index: i },
                                  e
                                );
                              }
                              setDragOverSec(null);
                            }}
                          >
                            {label}
                          </span>
                          {/* Gap after this chip */}
                          <Gap sec={sec} index={i + 1} />
                        </Fragment>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    className="flex items-center justify-center text-slate-500 text-sm h-10 rounded"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverSec(sec);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const dt = e.dataTransfer;
                      const gid = strip(
                        (dt.getData("application/x-guard-id") ||
                          dt.getData("text/plain") ||
                          "").trim()
                      );
                      if (!gid) return;

                      const { raw, external } = readDragSource(dt);
                      if (raw === "queue") {
                        const fromSec = dt.getData("application/x-queue-section") || "";
                        const fromIndex = parseIndex(dt.getData("application/x-queue-index"));
                        onMoveWithinQueue?.({
                          guardId: gid,
                          fromSec,
                          fromIndex,
                          toSec: sec,
                          toIndex: 0,
                        });
                      } else {
                        onDropExternalToQueue?.(
                          { guardId: gid, source: external, sec, index: 0 },
                          e
                        );
                      }
                      setDragOverSec(null);
                    }}
                  >
                    empty
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
