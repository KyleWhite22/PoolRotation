import type { QueueEntry, Guard } from "../../lib/types.js";
import { POSITIONS } from "../../../../shared/data/poolLayout.js";

const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);

export default function BreakQueue({
  queuesBySection,
  flatQueue,
  seatedSet,
  guards,
  onClearAll,
  onAddToSection
}: {
  queuesBySection: Record<string, QueueEntry[]>;
  flatQueue: QueueEntry[];
  seatedSet: Set<string>;
  guards: Guard[];
  onClearAll: () => void;
  onAddToSection: (sec: string) => void;
}) {
  const sections = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort((a,b)=>Number(a)-Number(b));

  const guardName = (rawId: string) => {
    const id = strip(rawId);
    const g = guards.find(x => strip(x.id) === id);
    return g?.name || id; // fallback prevents UUID-looking chips when roster hasn't loaded yet
  };

  const namesFor = (sec: string) => {
    const bucket = queuesBySection?.[sec];
    const raw = bucket?.length ? bucket : flatQueue.filter(q => q.returnTo === sec);
    // compare with seatedSet using stripped ids
    return raw
      .filter(q => !seatedSet.has(strip(q.guardId)))
      .map(q => guardName(q.guardId));
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-md font-semibold text-slate-100">Break queue</h3>
        <button onClick={onClearAll} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sm">Clear queues</button>
      </div>
      <ul className="space-y-2">
        {sections.map(sec => {
          const names = namesFor(sec);
          return (
            <li key={sec} className="flex items-center gap-3">
              <span className="w-6 text-right font-mono text-slate-300">{sec}.</span>
              {names.length ? (
                <div className="flex flex-wrap gap-2">
                  {names.map((n,i)=>(
                    <span key={`${sec}-${i}-${n}`} className="px-2 py-0.5 rounded bg-slate-800 text-slate-100 text-sm">{n}</span>
                  ))}
                </div>
              ) : <span className="text-slate-500 text-sm">—</span>}
              <button onClick={()=>onAddToSection(sec)} className="ml-auto px-2 py-1 rounded bg-pool-500 hover:bg-pool-400 text-sm">
                + Add to {sec} queue
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
