import { useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void; // call after successful create
};

export default function CreateGuardModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [dob, setDob] = useState(""); // YYYY-MM-DD
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);

    if (!name.trim()) return setErr("Name is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return setErr("DOB must be YYYY-MM-DD");

    try {
      setSubmitting(true);
      const res = await fetch("/api/guards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "dev-key-123",
        },
        body: JSON.stringify({ name: name.trim(), dob }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(typeof data?.detail === "string" ? data.detail : "Create failed");
        return;
      }
      setName("");
      setDob("");
      onCreated(); // refresh list in parent
      onClose();   // close modal
    } catch (e) {
      setErr("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const closeOnBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      onClick={closeOnBackdrop}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      aria-modal="true"
      role="dialog"
    >
      <div className="w-full max-w-md rounded-2xl bg-pool-800 border border-pool-700 shadow-soft p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">New Guard</h3>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-pool-200 hover:bg-pool-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="mt-4 grid gap-4">
          <div>
            <label className="block text-sm text-pool-200 mb-1">Name</label>
            <input
              className="w-full rounded-xl2 bg-pool-900 text-white px-3 py-2 outline-none border border-pool-700 focus:border-pool-500"
              placeholder="e.g., Zach Whitney"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-pool-200 mb-1">DOB</label>
            <input
              type="date"
              className="w-full rounded-xl2 bg-pool-900 text-white px-3 py-2 outline-none border border-pool-700 focus:border-pool-500"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              disabled={submitting}
            />
          </div>

          {err && (
            <div className="text-sm text-red-200 bg-red-900/30 border border-red-800 rounded-xl2 px-3 py-2">
              {err}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl2 border border-pool-600 text-pool-100 hover:bg-pool-700"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 disabled:opacity-60 transition"
            >
              {submitting ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
