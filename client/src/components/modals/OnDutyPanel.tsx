import { useMemo, useState, useEffect, useRef } from "react";
import type { Guard } from "../../lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  guards: Guard[];
  value: Set<string>;                 // on-duty guard IDs
  onChange: (next: Set<string>) => void;
  className?: string;
};

const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);
const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

export default function OnDutyPanel({
  open,
  onClose,
  guards,
  value,
  onChange,
  className,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // focus when opened, clear query when closed
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    } else {
      setQuery("");
    }
  }, [open]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Always work with a stripped local copy for comparisons
  const normValue = useMemo(() => new Set([...value].map((id) => strip(String(id)))), [value]);

  const sorted = useMemo(
    () => [...guards].sort((a, b) => norm(a.name || a.id).localeCompare(norm(b.name || b.id))),
    [guards]
  );

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return sorted;
    const tokens = q.split(/\s+/).filter(Boolean);
    return sorted.filter((g) => {
      const hay = norm(g.name || g.id);
      return tokens.every((t) => hay.includes(t));
    });
  }, [sorted, query]);

  // Mutators (write stripped ids)
  const toggle = (gidRaw: string) => {
    const gid = strip(gidRaw);
    const next = new Set(normValue);
    next.has(gid) ? next.delete(gid) : next.add(gid);
    onChange(next);
  };

  const selectAllFiltered = () => {
    const next = new Set(normValue);
    for (const g of filtered) next.add(strip(g.id));
    onChange(next);
  };

  const clearAllFiltered = () => {
    if (!filtered.length) return;
    const ids = new Set(filtered.map((g) => strip(g.id)));
    const next = new Set([...normValue].filter((id) => !ids.has(id)));
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  const count = normValue.size;
  const total = guards.length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="on-duty-title"
        className={["absolute inset-0 flex items-center justify-center p-4", className || ""].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        <section className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
          {/* Header */}
          <header className="p-4 border-b border-slate-700 flex items-center gap-3">
            <div className="flex-1">
              <h3 id="on-duty-title" className="text-slate-100 font-semibold">
                Select On-Duty Guards
              </h3>
              <p className="text-slate-400 text-sm">
                Selected: <span className="font-medium text-slate-200">{count}</span> / {total}
              </p>
            </div>
            <div className="hidden sm:flex gap-2">
              <button
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                onClick={selectAllFiltered}
                title="Select all shown"
              >
                Select shown
              </button>
              <button
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                onClick={clearAllFiltered}
                title="Clear all shown"
              >
                Clear shown
              </button>
              <button
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                onClick={clearAll}
                title="Clear all"
              >
                Clear all
              </button>
            </div>
          </header>

          {/* Search */}
          <div className="p-4 border-b border-slate-700">
            <input
              ref={inputRef}
              type="text"
              placeholder="Search guards…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-lg bg-slate-800/80 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-500"
            />
            <div className="mt-2 text-xs text-slate-400">Tip: “Select shown” acts only on the filtered list.</div>
          </div>

          {/* List */}
          <ul className="max-h-[50vh] overflow-auto divide-y divide-slate-800">
            {filtered.map((g) => {
              const id = strip(g.id);
              const checked = normValue.has(id);
              return (
                <li key={g.id} className="flex items-center justify-between px-4 py-2 hover:bg-slate-800/60">
                  <div className="min-w-0">
                    <p className="text-slate-100 truncate">{g.name || g.id}</p>
                    <p className="text-slate-400 text-xs truncate">{id}</p>
                  </div>
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(id)}
                      className="h-4 w-4 accent-slate-300"
                    />
                    <span className="text-slate-300 text-sm">{checked ? "On duty" : "Off"}</span>
                  </label>
                </li>
              );
            })}
            {!filtered.length && (
              <li className="px-4 py-6 text-center text-slate-400 text-sm">No guards match your search.</li>
            )}
          </ul>

          {/* Footer */}
          <footer className="p-4 border-t border-slate-700 flex items-center justify-end gap-2">
            <button
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
              onClick={clearAllFiltered}
            >
              Clear shown
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
              onClick={selectAllFiltered}
            >
              Select shown
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-pool-500 hover:bg-pool-400 text-slate-900 font-semibold text-sm"
              onClick={onClose}
            >
              Done
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
