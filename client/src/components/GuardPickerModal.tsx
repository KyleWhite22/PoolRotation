import { useMemo, useState } from "react";

export type Guard = { id: string; name: string; dob: string };

type Props = {
  open: boolean;
  onClose: () => void;
  guards: Guard[];
  alreadyAssignedIds: string[];
  onSelect: (guardId: string) => void; // explicitly string
  title?: string;
};

export default function GuardPickerModal({
  open,
  onClose,
  guards,
  alreadyAssignedIds,
  onSelect,
  title = "Assign Guard",
}: Props) {
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    const filtered = guards.filter(g => !alreadyAssignedIds.includes(g.id));
    if (!q.trim()) return filtered;
    const s = q.toLowerCase();
    return filtered.filter(g => g.name.toLowerCase().includes(s));
  }, [guards, alreadyAssignedIds, q]);

  if (!open) return null;

  const closeOnBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      onClick={closeOnBackdrop}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl bg-pool-800 border border-pool-700 p-6 shadow-soft">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-pool-200 hover:bg-pool-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-4">
          <input
            placeholder="Search guards…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-xl2 bg-pool-900 text-white px-3 py-2 outline-none border border-pool-700 focus:border-pool-500"
          />
        </div>

        <div className="mt-4 max-h-64 overflow-y-auto space-y-2">
          {list.length === 0 ? (
            <div className="text-pool-200 text-sm">No available guards.</div>
          ) : (
            list.map((g) => (
              <button
                key={g.id}
                onClick={() => { onSelect(g.id); onClose(); }}
                className="w-full text-left px-3 py-2 rounded-xl2 bg-pool-900 hover:bg-pool-700 border border-pool-700"
              >
                <div className="font-medium">{g.name}</div>
                <div className="text-xs text-pool-300">{g.dob}</div>
              </button>
            ))
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl2 border border-pool-600 text-pool-100 hover:bg-pool-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
