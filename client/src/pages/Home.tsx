import { useEffect, useMemo, useState } from "react";
import GuardPickerModal from "../components/GuardPickerModal";
import type { Guard } from "../components/GuardPickerModal";
import CreateGuardModal from "../components/CreateGuardModal";

function ageFromDob(dob: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return null;
  const [_, ys, ms, ds] = m;
  const y = Number(ys), mo = Number(ms), d = Number(ds);
  const now = new Date();
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() + 1 < mo ||
    (now.getMonth() + 1 === mo && now.getDate() < d);
  if (beforeBirthday) age--;
  return age;
}

const BLOCK_LABELS = ["Block A", "Block B", "Block C", "Block D"] as const;

export default function Home() {
  const [guards, setGuards] = useState<Guard[]>([]);
  const [loading, setLoading] = useState(false);

  // assignments: index 0..3 -> guardId | null
  const [assignments, setAssignments] = useState<(string | null)[]>([null, null, null, null]);

  // modals
  const [createOpen, setCreateOpen] = useState(false);
  const [pickerOpenIndex, setPickerOpenIndex] = useState<number | null>(null);

  // fetch + normalize
  const normalizeGuards = (items: any[]): Guard[] =>
    items
      .map((it) => {
        const id: string =
          typeof it.id === "string"
            ? it.id
            : typeof it.pk === "string" && it.pk.startsWith("GUARD#")
            ? it.pk.slice("GUARD#".length)
            : "";
        if (!id) return null;
        return { id, name: it.name ?? "", dob: it.dob ?? "" };
      })
      .filter(Boolean) as Guard[];

  const fetchGuards = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/guards", { headers: { "x-api-key": "dev-key-123" } });
      const data = await res.json();
      setGuards(Array.isArray(data) ? normalizeGuards(data) : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchGuards(); }, []);

  // derived: which guards are already assigned
  const assignedIds = useMemo(
    () => assignments.filter((x): x is string => Boolean(x)),
    [assignments]
  );

  // helpers
  const getGuard = (id: string | null) => guards.find((g) => g.id === id) || null;

  const openPickerFor = (i: number) => setPickerOpenIndex(i);

  const assignGuardToBlock = (i: number, guardId: string) => {
    // ensure uniqueness (guard can only be used once)
    if (assignedIds.includes(guardId)) return;

    setAssignments((prev) => {
      const next = [...prev];
      next[i] = guardId;
      return next;
    });
  };

  const clearBlock = (i: number) => {
    setAssignments((prev) => {
      const next = [...prev];
      next[i] = null;
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-pool-800 text-white">
      {/* Top bar */}
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Lifeguard Rotation Manager</h1>
          <span className="text-xs text-pool-300">(prototype blocks)</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 transition"
          >
            New Guard
          </button>
          <button
            onClick={fetchGuards}
            className="px-4 py-2 rounded-xl2 bg-pool-600 hover:bg-pool-500 transition"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="p-6 max-w-6xl mx-auto space-y-6">
        {/* 2x2 grid of blocks */}
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {BLOCK_LABELS.map((label, i) => {
              const g = getGuard(assignments[i]);
              const age = g?.dob ? ageFromDob(g.dob) : null;

              return (
                <div
                  key={label}
                  className="rounded-2xl border border-pool-700 bg-pool-900/60 p-6 shadow-soft"
                >
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold">{label}</h3>
                    <div className="flex gap-2">
                      {g && (
                        <button
                          onClick={() => clearBlock(i)}
                          className="px-3 py-1 rounded-xl2 border border-pool-600 text-pool-100 hover:bg-pool-700"
                          title="Clear assignment"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        onClick={() => openPickerFor(i)}
                        className="px-3 py-1 rounded-xl2 bg-pool-500 hover:bg-pool-400"
                      >
                        {g ? "Change" : "Assign"}
                      </button>
                    </div>
                  </div>

                  {/* Assignment display */}
                  {g ? (
                    <div className="rounded-xl2 bg-pool-800 border border-pool-700 p-4">
                      <div className="text-base font-medium">{g.name}</div>
                      <div className="text-sm text-pool-200">
                        {g.dob}{age !== null ? ` (${age})` : ""}
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => openPickerFor(i)}
                      className="w-full h-28 rounded-2xl border-2 border-dashed border-pool-700 text-pool-300 hover:border-pool-500 hover:text-white transition"
                    >
                      Click to assign a guard
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {loading && (
            <p className="mt-4 text-pool-300 text-sm">Loading guards…</p>
          )}
        </section>
      </main>

      {/* Modals */}
      <CreateGuardModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={fetchGuards}
      />

   <GuardPickerModal
  open={pickerOpenIndex !== null}
  onClose={() => setPickerOpenIndex(null)}
  guards={guards}
  alreadyAssignedIds={assignedIds}
  onSelect={(guardId: string) => {
    if (pickerOpenIndex === null) return;
    assignGuardToBlock(pickerOpenIndex, guardId);
  }}
  title={
    pickerOpenIndex !== null
      ? `Assign to ${BLOCK_LABELS[pickerOpenIndex]}`
      : "Assign Guard"
  }
/>
    </div>
  );
}
