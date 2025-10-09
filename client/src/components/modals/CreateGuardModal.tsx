// CreateGuardModal.tsx
import { useState } from "react";

export type Guard = { id: string; name: string; dob?: string | null };

export default function CreateGuardModal({
  open,
  onClose,
  onCreated, // now: (g: Guard) => void
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (g: Guard) => void;   // << change signature
}) {
  const [name, setName] = useState("");
  const [dob, setDob]   = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  if (!open) return null;

  const handleCreate = async () => {
    const nm = name.trim();
    if (!nm || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/guards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "dev-key-123",
          // optional: idempotency helps if users double-click
          "x-idempotency-key": crypto.randomUUID?.() ?? String(Date.now()),
        },
        body: JSON.stringify({ name: nm, dob: dob || null }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Create failed (${res.status}) ${detail}`);
      }
      const created: Guard = await res.json(); // { id, name, dob }
      onCreated(created);                      // << optimistic merge in parent
      setName("");
      setDob("");
      onClose();
    } catch (e: any) {
      console.error("Failed to create guard:", e);
      setError(e?.message ?? "Failed to create guard");
    } finally {
      setSaving(false);
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
              disabled={saving}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm mb-1 text-slate-300">Date of Birth</label>
            <input
              type="date"
              className="w-full rounded bg-pool-800 p-2 text-white outline-none"
              value={dob}
              onChange={e => setDob(e.target.value)}
              disabled={saving}
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="px-3 py-1 rounded bg-pool-500 hover:bg-pool-400 text-sm disabled:opacity-60"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
