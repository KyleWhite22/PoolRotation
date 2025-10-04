import { useMemo, useState } from "react";
import type { QueueEntry, Guard } from "../../lib/types.js";
import { POSITIONS } from "../../../../shared/data/poolLayout.js";

const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);

export default function BreakQueue({
  queuesBySection,
  flatQueue,
  seatedSet,
  guards,
  onClearAll,
  onAddToSection,
  // NEW: optional—called when a guard chip is dropped into a section bucket
  onDropGuardToSection,
}: {
  queuesBySection: Record<string, QueueEntry[]>;
  flatQueue: QueueEntry[];
  seatedSet: Set<string>;
  guards: Guard[];
  onClearAll: () => void;
  onAddToSection: (sec: string) => void;
  onDropGuardToSection?: (sec: string, e: React.DragEvent) => void;
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

              {/* DROPPABLE BUCKET */}
              <div
                data-section-id={sec}
                className={[
                  "flex-1 rounded-xl border px-2 py-2 min-h-[44px] transition-colors",
                  active
                    ? "border-sky-400 bg-slate-800/60"
                    : "border-slate-700 bg-slate-800/40",
                ].join(" ")}
                onDragOver={(e) => {
                  if (!onDropGuardToSection) return;
                  e.preventDefault();
                  if (dragOverSec !== sec) setDragOverSec(sec);
                }}
                onDragEnter={() => {
                  if (!onDropGuardToSection) return;
                  setDragOverSec(sec);
                }}
                onDragLeave={(e) => {
                  if (!onDropGuardToSection) return;
                  const next = e.relatedTarget as Node | null;
                  if (!next || !(e.currentTarget as Node).contains(next)) {
                    if (dragOverSec === sec) setDragOverSec(null);
                  }
                }}
                onDrop={(e) => {
                  if (!onDropGuardToSection) return;
                  e.preventDefault();
                  onDropGuardToSection(sec, e);
                  setDragOverSec(null);
                }}
              >
                {entries.length ? (
                  <div className="flex flex-wrap gap-2">
                    {entries.map((q, i) => {
                      const gid = strip(q.guardId);
                      const label = labelFor(gid);
                      return (
                        <span
                          key={`${sec}-${i}-${gid}`}
                          className="px-2 py-0.5 rounded bg-slate-900/70 border border-slate-700 text-slate-100 text-sm select-none"
                          draggable
                          onDragStart={(e) => {
                            // Make queue chips draggable to the On-Duty bench (or seats if you want).
                            e.dataTransfer.setData("application/x-guard-id", gid);
                            e.dataTransfer.setData("application/x-source", "queue");
                            e.dataTransfer.setData("application/x-queue-section", sec);
                            // Also include text/plain for easier testing
                            e.dataTransfer.setData("text/plain", gid);
                          }}
                        >
                          {label}
                        </span>
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
