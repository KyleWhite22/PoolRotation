import { useState } from "react";

export type GuardForm = {
  name: string;
  dob: string;
};

export default function CreateGuardModal({
  open,
  onClose,
  onCreated
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");

  if (!open) return null;

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      await fetch("/api/guards", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({ name, dob })
      });
      await onCreated();
      setName("");
      setDob("");
      onClose();
    } catch (e) {
      console.error("Failed to create guard:", e);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[360px] rounded-lg bg-pool-900 p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-white">Create Guard</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm mb-1 text-slate-300">Name</label>
            <input
              className="w-full rounded bg-pool-800 p-2 text-white outline-none"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="John Doe"
            />
          </div>
          <div>
            <label className="block text-sm mb-1 text-slate-300">Date of Birth</label>
            <input
              type="date"
              className="w-full rounded bg-pool-800 p-2 text-white outline-none"
              value={dob}
              onChange={e => setDob(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="px-3 py-1 rounded bg-pool-500 hover:bg-pool-400 text-sm"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
