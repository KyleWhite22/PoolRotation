// GuardPickerModal.tsx (simplified)
import { useState } from "react";
import type { Guard } from "../../lib/types";

export default function GuardPickerModal({
  open,
  onClose,
  onSelect,
  guards,
  alreadyAssignedIds,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (guardId: string) => void;
  guards: Guard[];
  alreadyAssignedIds: string[];
  title: string;
}) {
  const [search, setSearch] = useState("");

  const filtered = guards.filter(
    g =>
      g.name.toLowerCase().includes(search.toLowerCase()) &&
      !alreadyAssignedIds.includes(g.id)
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-lg p-4 max-w-sm w-full">
        <h2 className="text-lg font-semibold mb-2">{title}</h2>

        {/* IMPORTANT: don't split on spaces, just allow them */}
        <input
          className="w-full mb-3 p-2 rounded bg-slate-700"
          placeholder="Search guard…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <ul className="max-h-48 overflow-y-auto">
          {filtered.map(g => (
            <li key={g.id}>
              <button
                className="w-full text-left px-2 py-1 hover:bg-slate-700 rounded"
                onClick={() => {
                  onSelect(g.id);
                  onClose();
                }}
              >
                {g.name}
              </button>
            </li>
          ))}
        </ul>

        <button
          onClick={onClose}
          className="mt-3 px-3 py-1 bg-slate-600 rounded hover:bg-slate-500"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
