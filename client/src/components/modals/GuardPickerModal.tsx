import { useMemo } from "react";

export type Guard = {
  id: string;
  name: string;
  dob: string;
};

export default function GuardPickerModal({
  open,
  onClose,
  guards,
  alreadyAssignedIds,
  onSelect,
  title = "Assign Guard"
}: {
  open: boolean;
  onClose: () => void;
  guards: Guard[];
  alreadyAssignedIds: string[];
  onSelect: (guardId: string) => void;
  title?: string;
}) {
  const available = useMemo(
    () => guards.filter(g => !alreadyAssignedIds.includes(g.id)),
    [guards, alreadyAssignedIds]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[360px] max-h-[80vh] overflow-y-auto rounded-lg bg-pool-900 p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-white">{title}</h2>
        {available.length === 0 && (
          <p className="text-slate-300 text-sm">No available guards</p>
        )}
        <ul className="space-y-2">
          {available.map(g => (
            <li key={g.id}>
              <button
                className="w-full flex items-center justify-between rounded bg-pool-800 px-3 py-2 hover:bg-pool-700 text-left"
                onClick={() => onSelect(g.id)}
              >
                <span className="text-white">{g.name}</span>
                <span className="text-xs text-slate-400">{g.dob}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
