import { useEffect, useMemo, useRef, useState } from "react";
import PoolMap from "../components/PoolMap";
import GuardPickerModal from "../components/GuardPickerModal";
import CreateGuardModal from "../components/CreateGuardModal";
import type { Guard } from "../components/GuardPickerModal";
import { POSITIONS } from "../../../shared/data/poolLayout.js";

// -------- Types --------
type Assigned = Record<string, string | null>;
type BreakState = Record<string, string>; // guardId -> breakUntilISO
type ConflictUI = { stationId: string; guardId: string; reason: string };
type QueueEntry = { guardId: string; returnTo: string };

// Local YYYY-MM-DD based on your simulated clock (NY time to match ops)
const ymdLocal = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // en-CA => YYYY-MM-DD

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
  const [breakQueue, setBreakQueue] = useState<QueueEntry[]>([]);

  // --- UI state ---
  const [pickerFor, setPickerFor] = useState<string | null>(null); // seat assignment
  const [queuePickerFor, setQueuePickerFor] = useState<string | null>(null); // section queue add
  const [createOpen, setCreateOpen] = useState(false);
  const rotatingRef = useRef(false);
const SIM_KEY = "simulatedNowISO";

  // start at 12:00 PM today (local)
  const [simulatedNow, setSimulatedNow] = useState(() => {
  const saved = localStorage.getItem(SIM_KEY);
  if (saved) {
    const d = new Date(saved);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
});
useEffect(() => {
  localStorage.setItem(SIM_KEY, simulatedNow.toISOString());
}, [simulatedNow]);
  // All API traffic must use this key (prevents UTC day drift)
  const dayKey = useMemo(() => ymdLocal(simulatedNow), [simulatedNow]);

  // --- Derived ---
  const usedGuardIds = useMemo(
    () => Object.values(assigned).filter((v): v is string => Boolean(v)),
    [assigned]
  );
  const alreadyQueuedIds = useMemo(
    () => new Set(breakQueue.map((q) => q.guardId)),
    [breakQueue]
  );

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

  const fetchAssignments = async () => {
    const res = await fetch(`/api/rotations/day/${dayKey}`, {
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

  const fetchQueue = async () => {
    const res = await fetch(`/api/plan/queue?date=${dayKey}`, {
      headers: { "x-api-key": "dev-key-123" },
    });
    const data = await res.json();
    setBreakQueue(Array.isArray(data?.queue) ? data.queue : []);
  };

  // -------- Effects --------
  useEffect(() => {
    (async () => {
      await fetchGuards();
      await fetchAssignments();
      await fetchQueue(); // ensure UI has current queue on load
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]); // re-pull if you change simulated date

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
          date: dayKey,
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
          date: dayKey,
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

  const addToQueue = async (guardId: string, returnTo: string) => {
    try {
      await fetch("/api/plan/queue-add", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({ date: dayKey, guardId, returnTo }),
      });
      await fetchQueue();
    } catch (e) {
      console.error("Failed to add to queue:", e);
    }
  };

 const plus15Minutes = async () => {
  if (rotatingRef.current) return;
  rotatingRef.current = true;
  try {
    const newNow = new Date(simulatedNow.getTime() + 15 * 60 * 1000);
    setSimulatedNow(newNow);

    const res = await fetch("/api/plan/rotate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
      body: JSON.stringify({
        date: dayKey,                 // or todayISO() if you prefer
        nowISO: newNow.toISOString(),
        assignedSnapshot: assigned,   // <- REQUIRED
      }),
    });

    const data = await res.json();
    if (data?.assigned) setAssigned(data.assigned);
    if (data?.breaks) setBreaks(data.breaks);
    if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);
     await fetchQueue();
  } catch (e) {
    console.error("Rotate failed:", e);
  } finally {
    rotatingRef.current = false;
  }
};

  const handleRefreshAll = async () => {
    // reset clock back to noon
    const reset = new Date(simulatedNow);
    reset.setHours(12, 0, 0, 0);
    setSimulatedNow(reset);

    // clear UI state
    setBreakQueue([]);
    setAssigned(Object.fromEntries(POSITIONS.map((p) => [p.id, null])));
    setBreaks({});

    // clear local cache for THIS simulated day
    try {
      localStorage.removeItem(`breaks:${dayKey}`);
    } catch {}

    // clear backend snapshots + breaks + queues (best-effort)
    try {
      const time = new Date().toISOString().slice(11, 16);
      await Promise.all(
        POSITIONS.map((p) =>
          fetch("/api/rotations/slot", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
            body: JSON.stringify({
              date: dayKey,
              time,
              stationId: p.id,
              guardId: null,
              notes: "refresh-all",
            }),
          })
        )
      );
      await fetch("/api/plan/queue-clear", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({ date: dayKey }),
      });
    } catch (e) {
      console.warn("Backend reset failed (continuing):", e);
    }
  };

  const autopopulate = async () => {
    try {
      const res = await fetch("/api/plan/autopopulate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({ date: dayKey }),
      });
      const data = await res.json();
      if (data?.assigned) setAssigned(data.assigned);
      if (Array.isArray(data?.meta?.breakQueue)) setBreakQueue(data.meta.breakQueue);
      if (data?.breaks) setBreaks(data.breaks);
      if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);
    } catch (e) {
      console.error("Autopopulate failed:", e);
    }
  };

  // -------- UI helpers --------
  const anyAssigned = Object.values(assigned).some(Boolean);

  // simple numbered queue display (always show all sections found in POSITIONS)
  const sections = Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
    (a, b) => Number(a) - Number(b)
  );

  const guardName = (gid: string) => guards.find((g) => g.id === gid)?.name ?? gid;
  const queueBySection = (sec: string) =>
    breakQueue.filter((q) => q.returnTo === sec).map((q) => guardName(q.guardId));

  return (
    <div className="min-h-screen bg-pool-800 text-white">
      <header className="h-16 flex items-center px-6 border-b border-pool-700 bg-pool-900">
        <h1 className="text-xl font-semibold">Lifeguard Rotation Manager</h1>
        <span className="ml-4 text-xs rounded px-2 py-1 border border-pool-600">
          Simulated: {dayKey}{" "}
          {simulatedNow.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={plus15Minutes}
            disabled={rotatingRef.current || (!anyAssigned && breakQueue.length === 0)}
            className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 disabled:opacity-50 transition"
          >
            +15 Minutes
          </button>
          <button
            type="button"
            onClick={autopopulate}
            className="px-4 py-2 rounded-xl2 bg-pool-500 hover:bg-pool-400 transition"
          >
            Autopopulate
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
            onClick={handleRefreshAll}
            className="px-4 py-2 rounded-xl2 bg-pool-600 hover:bg-pool-500 transition"
          >
            Refresh All
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

        {/* Break queue: numbered by section, always visible */}
        <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-md font-semibold text-slate-100">Break queue</h3>
            <button
              type="button"
              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sm"
              onClick={async () => {
                try {
                  await fetch("/api/plan/queue-clear", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
                    body: JSON.stringify({ date: dayKey }),
                  });
                  setBreakQueue([]);
                } catch (e) {
                  console.error("Failed to clear queues:", e);
                }
              }}
            >
              Clear queues
            </button>
          </div>

          <ul className="space-y-2">
            {sections.map((sec) => {
              const names = queueBySection(sec);
              return (
                <li key={sec} className="flex items-center gap-3">
                  <span className="w-6 text-right font-mono text-slate-300">{sec}.</span>
                  {names.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {names.map((n, i) => (
                        <span
                          key={`${sec}-${i}-${n}`}
                          className="px-2 py-0.5 rounded bg-slate-800 text-slate-100 text-sm"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-slate-500 text-sm">—</span>
                  )}
                  <button
                    type="button"
                    className="ml-auto px-2 py-1 rounded bg-pool-500 hover:bg-pool-400 text-sm"
                    onClick={() => setQueuePickerFor(sec)}
                  >
                    + Add to {sec} queue
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </main>

      <CreateGuardModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={fetchGuards}
      />

      {/* Assign directly to a seat */}
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

      {/* Assign directly to a section queue */}
      <GuardPickerModal
        open={queuePickerFor !== null}
        onClose={() => setQueuePickerFor(null)}
        guards={guards.filter(
          (g) => !usedGuardIds.includes(g.id) && !alreadyQueuedIds.has(g.id)
        )}
        alreadyAssignedIds={[]}
        onSelect={async (guardId: string) => {
          if (!queuePickerFor) return;
          const sec = queuePickerFor;
          setQueuePickerFor(null);
          await addToQueue(guardId, sec);
        }}
        title={queuePickerFor ? `Add guard to ${queuePickerFor}.x queue` : "Add to Queue"}
      />
    </div>
  );
}
