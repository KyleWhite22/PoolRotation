import { useEffect, useMemo, useRef, useState } from "react";
import PoolMap from "../components/PoolMap";
import GuardPickerModal from "../components/GuardPickerModal";
import CreateGuardModal from "../components/CreateGuardModal";
import type { Guard } from "../components/GuardPickerModal";
import { POSITIONS, EDGES, VIEWBOX, POOL_PATH_D, REST_STATIONS }
  from "../../../shared/data/poolLayout.js";
// -------- Helpers --------
const todayISO = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

type Assigned = Record<string, string | null>;
type BreakState = Record<string, string>; // guardId -> breakUntilISO
type ConflictUI = { stationId: string; guardId: string; reason: string };

export default function Home() {
  // --- Server data ---
  const [guards, setGuards] = useState<Guard[]>([]);
  const [loading, setLoading] = useState(false);

  // --- Rotation state ---
  const [assigned, setAssigned] = useState<Assigned>(() =>
    Object.fromEntries(POSITIONS.map((p) => [p.id, null]))
  );
  const [breaks, setBreaks] = useState<BreakState>({});
  const [conflicts, setConflicts] = useState<ConflictUI[]>([]);

  // --- UI state ---
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const rotatingRef = useRef(false);


  // --- Derived ---
  const usedGuardIds = useMemo(
    () => Object.values(assigned).filter((v): v is string => Boolean(v)),
    [assigned]
  );

  // -------- Effects --------
  useEffect(() => {
    (async () => {
      await fetchGuards();
      await fetchAssignments();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- Data funcs --------
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
const handleRefresh = async () => {
  await fetchGuards();
  await fetchAssignments();

  // reset simulated clock back to noon
  const reset = new Date();
  reset.setHours(12, 0, 0, 0);
  setSimulatedNow(reset);
};
  const fetchAssignments = async () => {
    const res = await fetch(`/api/rotations/day/${todayISO()}`, {
      headers: { "x-api-key": "dev-key-123" },
    });
    const items: { stationId: string; guardId?: string | null; updatedAt?: string }[] =
      await res.json();

    const latestByStation = new Map<string, (typeof items)[number]>();
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
        if (rec) next[p.id] = rec.guardId ?? null;
      }
      return next;
    });
  };

  // -------- Handlers --------
  const assignGuard = async (positionId: string, guardId: string) => {
    if (usedGuardIds.includes(guardId)) return;

    // Optimistic UI
    setAssigned((prev) => ({ ...prev, [positionId]: guardId }));

    try {
      await fetch("/api/rotations/slot", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: todayISO(),
          time: new Date().toISOString().slice(11, 16),
          stationId: positionId,
          guardId,
          notes: "",
        }),
      });
    } catch (err) {
      console.error("Failed to persist assignment:", err);
    }
  };

  const clearGuard = async (positionId: string) => {
    setAssigned((prev) => ({ ...prev, [positionId]: null }));
    try {
      await fetch("/api/rotations/slot", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: todayISO(),
          time: new Date().toISOString().slice(11, 16),
          stationId: positionId,
          guardId: null,
          notes: "",
        }),
      });
    } catch (e) {
      console.error("Failed to clear slot:", e);
    }
  };

 // start at 12:00 PM today
const [simulatedNow, setSimulatedNow] = useState(() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // force to noon
  return d;
});

// -------- Handlers --------
const plus15Minutes = async () => {
  if (rotatingRef.current) return;
  rotatingRef.current = true;
  try {
    // advance simulated clock +15m
    const newNow = new Date(simulatedNow.getTime() + 15 * 60 * 1000);
    setSimulatedNow(newNow);

    // ask server to compute & persist next rotation at that simulated time
    const res = await fetch("/api/plan/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
      body: JSON.stringify({
        date: todayISO(),
        nowISO: newNow.toISOString(),
        assignedSnapshot: assigned, // 👈 send current client snapshot for fallback
      }),
    });
    const data = await res.json();

    if (data?.assigned) setAssigned(data.assigned);
    if (data?.breaks) setBreaks(data.breaks);
    if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);
  } catch (e) {
    console.error("Rotate failed:", e);
    fetchAssignments();
  } finally {
    rotatingRef.current = false;
  }
};

  // -------- UI helpers --------
  const anyAssigned = Object.values(assigned).some(Boolean);

  return (
    <div className="min-h-screen bg-pool-800 text-white">
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        <h1 className="text-xl font-semibold">Lifeguard Rotation Manager</h1>
        <div className="ml-auto flex gap-2">
           <span className="ml-4 text-xs rounded px-2 py-1 border border-pool-600">
    Simulated Time: {simulatedNow.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
  </span>
          <button
            type="button"
            onClick={plus15Minutes}
            disabled={!anyAssigned || rotatingRef.current}
            className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 disabled:opacity-50 transition"
          >
            +15 Minutes
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 transition"
          >
            New Guard
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            className="px-4 py-2 rounded-xl2 bg-pool-600 hover:bg-pool-500 transition"
          >
            Refresh Time
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
            onPick={(positionId) => setPickerFor(positionId)}
            onClear={clearGuard}
            conflicts={conflicts}
          />
        </section>
      </main>

      <CreateGuardModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={fetchGuards} />
      <GuardPickerModal
        open={pickerFor !== null}
        onClose={() => setPickerFor(null)}
        guards={guards}
        alreadyAssignedIds={usedGuardIds}
        onSelect={(guardId: string) => {
          if (!pickerFor) return;
          setPickerFor(null);
          void assignGuard(pickerFor, guardId);
        }}
        title={pickerFor ? `Assign to ${pickerFor}` : "Assign Guard"}
      />
    </div>
  );
}
