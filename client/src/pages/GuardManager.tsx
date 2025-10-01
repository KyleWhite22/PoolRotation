import { useEffect, useMemo, useState } from "react";
import AppShell from "../components/AppShell";

// --- Types ---
type Guard = {
  id: string;
  name: string;
  dob?: string;   // YYYY-MM-DD
  phone?: string; // any format
};

// --- Utils ---
function calcAge(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

type SortKey = "name" | "age" | "dob" | "phone";
type SortDir = "asc" | "desc";

// --- Page ---
export default function GuardsPage() {
  const [guards, setGuards] = useState<Guard[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [editGuard, setEditGuard] = useState<Guard | null>(null); // <-- NEW
  const API_HEADERS = { "x-api-key": "dev-key-123" };

  // fetch guards
  const fetchGuards = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/guards", { headers: API_HEADERS });
      if (!res.ok) throw new Error(`GET /api/guards failed: ${res.status}`);
      const data = await res.json();
      const norm: Guard[] = Array.isArray(data)
        ? data
          .map((it: any) => {
            const id =
              typeof it.id === "string"
                ? it.id
                : typeof it.pk === "string" && it.pk.startsWith("GUARD#")
                  ? it.pk.slice("GUARD#".length)
                  : "";
            return {
              id,
              name: it.name ?? "",
              dob: it.dob ?? "",
              phone: it.phone ?? "",
            };
          })
          .filter((g: Guard) => g.id)
        : [];
      setGuards(norm);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGuards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => {
    const withAge = guards.map((g) => ({ ...g, age: calcAge(g.dob ?? null) }));

    const filtered = query.trim()
      ? withAge.filter((g) =>
        g.name.toLowerCase().includes(query.trim().toLowerCase())
      )
      : withAge;

    filtered.sort((a, b) => {
      let res = 0;
      if (sortKey === "name") {
        res = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      } else if (sortKey === "age") {
        const aa = a.age, bb = b.age;
        if (aa == null && bb == null) res = 0;
        else if (aa == null) res = 1;
        else if (bb == null) res = -1;
        else res = aa - bb;
      } else if (sortKey === "dob") {
        const ad = a.dob ? new Date(a.dob).getTime() : NaN;
        const bd = b.dob ? new Date(b.dob).getTime() : NaN;
        if (isNaN(ad) && isNaN(bd)) res = 0;
        else if (isNaN(ad)) res = 1;
        else if (isNaN(bd)) res = -1;
        else res = ad - bd;
      } else if (sortKey === "phone") {
        res = (a.phone ?? "").localeCompare(b.phone ?? "");
      }
      return sortDir === "asc" ? res : -res;
    });

    return filtered;
  }, [guards, query, sortKey, sortDir]);

  // delete
  const removeGuard = async (id: string) => {
    try {
      const res = await fetch(`/api/guards/${id}`, {
        method: "DELETE",
        headers: API_HEADERS,
      });
      if (!res.ok) throw new Error(`DELETE /api/guards/${id} failed: ${res.status}`);
      setConfirmId(null);
      fetchGuards();
    } catch (e) {
      console.error("Failed to delete guard:", e);
    }
  };

  return (
    <AppShell title="Guard Manager" actions={<></>}>
      {/* Centered content container */}
      <div className="max-w-5xl mx-auto w-full">
        <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
          {/* Controls: search + sort + New Guard button (all on one row on desktop) */}
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name…"
              className="w-full md:w-72 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
            />

            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-300">Sort by:</label>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="rounded bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
              >
                <option value="name">Name</option>
                <option value="age">Age</option>
                <option value="dob">DOB</option>
                <option value="phone">Phone</option>
              </select>

              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                className="px-3 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 text-sm"
                title={`Toggle ${sortDir === "asc" ? "Descending" : "Ascending"}`}
              >
                {sortDir === "asc" ? "Asc ↑" : "Desc ↓"}
              </button>
            </div>

            <div className="md:ml-auto">
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="px-3 py-1.5 rounded bg-green-500 hover:bg-green-400 text-black font-medium text-sm"
              >
                New Guard
              </button>
            </div>

            {loading && <span className="text-xs text-slate-400">Loading…</span>}
          </div>

          <div className="max-h-[70vh] overflow-auto rounded border border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/60 sticky top-0">
                <tr>
                  <th className="text-left p-2 font-medium text-slate-200">Name</th>
                  <th className="text-left p-2 font-medium text-slate-200">DOB</th>
                  <th className="text-left p-2 font-medium text-slate-200">Age</th>
                  <th className="text-left p-2 font-medium text-slate-200">Phone</th>
                  <th className="p-2 text-slate-200"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id} className="odd:bg-slate-900 even:bg-slate-900/60">
                    <td className="p-2">{g.name || <span className="text-slate-500">—</span>}</td>
                    <td className="p-2">{g.dob || <span className="text-slate-500">—</span>}</td>
                    <td className="p-2">
                      {calcAge(g.dob ?? null) ?? <span className="text-slate-500">—</span>}
                    </td>
                    <td className="p-2">{g.phone || <span className="text-slate-500">—</span>}</td>
                    <td className="p-2 text-right space-x-2">
                      <button
                        onClick={() => setEditGuard(g)}          // <-- NEW
                        className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setConfirmId(g.id)}
                        className="px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white text-xs"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={5} className="p-4 text-center text-slate-400">
                      No guards found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Add Guard Modal */}
      {createOpen && (
        <AddGuardModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            fetchGuards();
          }}
        />
      )}

      {/* Edit Guard Modal */}
      {editGuard && (
        <EditGuardModal
          guard={editGuard}
          onClose={() => setEditGuard(null)}
          onSaved={() => {
            setEditGuard(null);
            fetchGuards();
          }}
        />
      )}

      {/* Confirm Delete */}
      {confirmId && (
        <ConfirmDialog
          title="Remove guard?"
          body="This will permanently remove the guard. Continue?"
          onCancel={() => setConfirmId(null)}
          onConfirm={() => removeGuard(confirmId)}
        />
      )}
    </AppShell>
  );
}

// ----------------- Add Guard Modal -----------------
function AddGuardModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [dob, setDob] = useState(""); // YYYY-MM-DD
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const API_HEADERS = { "Content-Type": "application/json", "x-api-key": "dev-key-123" };

  const canSave = name.trim().length > 0;

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/guards", {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          name: name.trim(),
          dob: dob || null,
          phone: phone || null,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`POST /api/guards failed (${res.status}): ${text}`);
      }
      onCreated();
    } catch (e) {
      console.error("Failed to create guard:", e);
      alert("Failed to create guard. Check console for details.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-slate-100">Add Guard</h3>
          <button onClick={onClose} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Close</button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-slate-300">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
              placeholder="Jane Doe"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-300">DOB</span>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-300">Phone</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
              placeholder="555-123-4567"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSave || saving}
            className="px-3 py-1.5 rounded bg-pool-500 hover:bg-pool-400 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------- Edit Guard Modal -----------------
function EditGuardModal({
  guard,
  onClose,
  onSaved,
}: {
  guard: Guard;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(guard.name ?? "");
  const [dob, setDob] = useState(guard.dob ?? "");
  const [phone, setPhone] = useState(guard.phone ?? "");
  const [saving, setSaving] = useState(false);

  const API_HEADERS = { "Content-Type": "application/json", "x-api-key": "dev-key-123" };
  const canSave = name.trim().length > 0;

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const body: Record<string, any> = { name: name.trim() };
      // include fields even if cleared -> send null to wipe, or send "" if you prefer keep empty string
      body.dob = dob || null;
      body.phone = phone || null;

      const res = await fetch(`/api/guards/${guard.id}`, {
        method: "PUT",
        headers: API_HEADERS,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PUT /api/guards/${guard.id} failed (${res.status}): ${text}`);
      }
      onSaved();
    } catch (e) {
      console.error("Failed to update guard:", e);
      alert("Failed to update guard. Check console for details.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-slate-100">Edit Guard</h3>
          <button onClick={onClose} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Close</button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-slate-300">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-300">DOB</span>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-300">Phone</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-pool-400"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSave || saving}
            className="px-3 py-1.5 rounded bg-pool-500 hover:bg-pool-400 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------- Confirm Dialog -----------------
function ConfirmDialog({
  title,
  body,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} aria-hidden="true" />
      <div className="relative w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-100 mb-2">{title}</h3>
        <p className="text-slate-300 mb-4">{body}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 rounded bg-red-600/80 hover:bg-red-600 text-white">
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}
