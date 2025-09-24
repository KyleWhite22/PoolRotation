import { useEffect, useMemo, useState } from "react";
import PoolMap from "../components/PoolMap";
import GuardPickerModal from "../components/GuardPickerModal";
import CreateGuardModal from "../components/CreateGuardModal";
import type { Guard } from "../components/GuardPickerModal";
import { POSITIONS, EDGES } from "../data/poolLayout";

const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
type Assigned = Record<string, string | null>;

export default function Home() {
  const [guards, setGuards] = useState<Guard[]>([]);
  const [loading, setLoading] = useState(false);

  // initialize all positions as null
  const [assigned, setAssigned] = useState<Assigned>(() =>
    Object.fromEntries(POSITIONS.map((p) => [p.id, null]))
  );

  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Normalize API results -> Guard[]
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

  useEffect(() => {
    fetchGuards().then(fetchAssignments);
  }, []);
  // Guards already used (to filter the picker)
  const usedGuardIds = useMemo(
    () => Object.values(assigned).filter((v): v is string => Boolean(v)),
    [assigned]
  );
  type RotationItem = {
    stationId: string;
    guardId?: string;
    updatedAt?: string;
  };

 const fetchAssignments = async () => {
  const res = await fetch(`/api/rotations/day/${today()}`, {
    headers: { "x-api-key": "dev-key-123" },
  });
  const items: { stationId: string; guardId?: string | null; updatedAt?: string }[] = await res.json();

  const latestByStation = new Map<string, typeof items[number]>();
  for (const it of items) {
    const prev = latestByStation.get(it.stationId);
    if (!prev || String(prev.updatedAt ?? "") < String(it.updatedAt ?? "")) {
      latestByStation.set(it.stationId, it);
    }
  }

  setAssigned((prev) => {
    const next = { ...prev };
    for (const p of POSITIONS) {
      const rec = latestByStation.get(p.id);
      next[p.id] = rec?.guardId ?? null; // will be null for cleared
    }
    return next;
  });
};

  const openPicker = (positionId: string) => setPickerFor(positionId);

  const assignGuard = async (positionId: string, guardId: string) => {
    if (usedGuardIds.includes(guardId)) return;

    // optimistic update
    setAssigned((prev) => ({ ...prev, [positionId]: guardId }));

    try {
      await fetch("/api/rotations/slot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "dev-key-123",
        },
        body: JSON.stringify({
          date: today(),
          time: new Date().toISOString().slice(11, 16), // HH:MM
          stationId: positionId,
          guardId,
          notes: "",
        }),
      });
    } catch (err) {
      console.error("Failed to persist assignment:", err);
    } finally {
      // refresh from backend
      fetchAssignments();
    }
  };
 const clearGuard = async (positionId: string) => {
  // optimistic UI
  setAssigned((prev) => ({ ...prev, [positionId]: null }));

  try {
    await fetch("/api/rotations/slot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "dev-key-123",
      },
      body: JSON.stringify({
        date: today(),
        time: new Date().toISOString().slice(11, 16), // HH:MM now
        stationId: positionId,
        guardId: null, // <-- persist clear
        notes: "",
      }),
    });
  } catch (e) {
    console.error("Failed to clear slot:", e);
  } finally {
    // re-sync from server so refresh shows cleared
    fetchAssignments();
  }
};
// One rotation step: move along edges; drop if no outgoing edge
const rotateOnce = async () => {
  // Build a fresh map with all positions cleared
  const base: Record<string, string | null> = {};
  POSITIONS.forEach(p => (base[p.id] = null));

  // Fast lookup for "from -> to"
  const nextByFrom = new Map(EDGES.map(e => [e.from, e.to]));

  // Compute new assignments
  const next = { ...base };
  for (const p of POSITIONS) {
    const gid = assigned[p.id];
    if (!gid) continue;

    const to = nextByFrom.get(p.id);
    if (to) {
      next[to] = gid;        // move guard to the next slot
    } else {
      // no outgoing edge => break (dropped)
      // intentionally do nothing
    }
  }

  // Optimistic UI update
  setAssigned(next);

  // (Optional) Persist each slot to backend as the "current" snapshot
  try {
    const date = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
    const time = new Date().toISOString().slice(11, 16);  // HH:MM

    // Fire-and-forget; you can also await Promise.all if you prefer strict ordering
    await Promise.all(
      POSITIONS.map(p =>
        fetch("/api/rotations/slot", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "dev-key-123",
          },
          body: JSON.stringify({
            date,
            time,
            stationId: p.id,
            guardId: next[p.id], // may be string or null (clear)
            notes: "rotate",
          }),
        })
      )
    );
  } catch (e) {
    console.error("Failed to persist rotation:", e);
    // optional: re-sync from server
    fetchAssignments();
  }
};
const anyAssigned = Object.values(assigned).some(Boolean);

  return (
    <div className="min-h-screen bg-pool-800 text-white">
      {/* Top bar */}
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        <h1 className="text-xl font-semibold">Lifeguard Rotation Manager</h1>
        <div className="ml-auto flex gap-2">
      <button
  onClick={rotateOnce}
  disabled={!anyAssigned}
  className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 disabled:opacity-50 transition"
>
  Rotate
</button>
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

  <main className="p-6 max-w-6xl mx-auto space-y-6">
  <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
    <h2 className="text-lg font-semibold text-slate-100">Main Pool</h2>
    <PoolMap
      className="w-full h-[700px]"
      guards={guards}
      assigned={assigned}
      onPick={openPicker}
      onClear={clearGuard}
    />
    
  </section>
</main>

      {/* Modals */}
      <CreateGuardModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={fetchGuards}
      />

      <GuardPickerModal
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        guards={guards}
        alreadyAssignedIds={usedGuardIds}
        onSelect={(guardId: string) => {
          if (!pickerFor) return;
          assignGuard(pickerFor, guardId);
          setPickerFor(null);
        }}
        title={pickerFor ? `Assign to ${pickerFor}` : "Assign Guard"}
      />
    </div>
  );
}
