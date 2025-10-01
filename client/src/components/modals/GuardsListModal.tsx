import { useMemo, useState } from "react";

export type Guard = { id: string; name: string; dob: string };

function ageFromDOB(dob: string): number | null {
  // expecting YYYY-MM-DD (or anything Date can parse)
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age;
}

type SortKey = "name" | "age";
type SortDir = "asc" | "desc";

export default function GuardsListModal({
  open,
  onClose,
  guards,
}: {
  open: boolean;
  onClose: () => void;
  guards: Guard[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? guards.filter((g) => g.name.toLowerCase().includes(q))
      : guards.slice();

    const cmp = (a: Guard, b: Guard) => {
      if (sortKey === "name") {
        const aa = a.name.toLowerCase();
        const bb = b.name.toLowerCase();
        if (aa < bb) return -1;
        if (aa > bb) return 1;
        return 0;
      } else {
        const aa = ageFromDOB(a.dob);
        const bb = ageFromDOB(b.dob);
        // nulls sort to the end
        if (aa == null && bb == null) return 0;
        if (aa == null) return 1;
        if (bb == null) return -1;
        return aa - bb;
      }
    };

    base.sort(cmp);
    if (sortDir === "desc") base.reverse();
    return base;
  }, [guards, sortKey, sortDir, query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      aria-modal="true"
      role="dialog"
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-slate-100">Guards</h3>
          <button
            onClick={onClose}
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700"
          >
            Close
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center mb-4">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            className="w-full sm:w-auto flex-1 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
          />
          <div className="flex gap-2">
            <label className="text-sm text-slate-300 flex items-center gap-2">
              Sort by:
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="rounded bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
              >
                <option value="name">Name</option>
                <option value="age">Age</option>
              </select>
            </label>

            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              className="px-3 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 text-sm"
              title={`Toggle ${sortDir === "asc" ? "Descending" : "Ascending"}`}
            >
              {sortDir === "asc" ? "Asc ↑" : "Desc ↓"}
            </button>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto rounded border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/60 sticky top-0">
              <tr>
                <th className="text-left p-2 font-medium text-slate-200">Name</th>
                <th className="text-left p-2 font-medium text-slate-200">DOB</th>
                <th className="text-left p-2 font-medium text-slate-200">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const age = ageFromDOB(g.dob);
                return (
                  <tr key={g.id} className="odd:bg-slate-900 even:bg-slate-900/60">
                    <td className="p-2">{g.name || <span className="text-slate-500">—</span>}</td>
                    <td className="p-2">{g.dob || <span className="text-slate-500">—</span>}</td>
                    <td className="p-2">{age ?? <span className="text-slate-500">—</span>}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-slate-400">
                    No guards found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}
