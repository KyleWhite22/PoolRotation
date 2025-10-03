import { useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import AppShell from "../components/AppShell";
import PoolMap from "../components/PoolMap";
import ToolbarActions from "../components/actions/ToolbarActions";
import BreakQueue from "../components/queue/BreakQueue";
import GuardPickerModal from "../components/modals/GuardPickerModal";
import GuardsListModal from "../components/modals/GuardsListModal";
import OnDutyPanel from "../components/modals/OnDutyPanel"; // <-- NEW
import { POSITIONS } from "../../../shared/data/poolLayout.js";
import type { Guard } from "../lib/types";

// -------- Local helpers / types --------
type Assigned = Record<string, string | null>;
type BreakState = Record<string, string>;
type ConflictUI = { stationId: string; guardId: string; reason: string };
type QueueEntry = { guardId: string; returnTo: string; enteredTick: number };
const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);

const ymdLocal = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // YYYY-MM-DD

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
  const [queuesBySection, setQueuesBySection] = useState<Record<string, QueueEntry[]>>({});

  // --- UI state ---
  const [pickerFor, setPickerFor] = useState<string | null>(null); // seat assignment
  const [queuePickerFor, setQueuePickerFor] = useState<string | null>(null); // section queue add
  const [createOpen, setCreateOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  const rotatingRef = useRef(false);
  const SIM_KEY = "simulatedNowISO";

  // Start at 12:00 PM today (local)
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

  // --- On-duty selection (persisted per day) ---
  const [onDutyIds, setOnDutyIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`onDuty:${dayKey}`);
      const arr = raw ? (JSON.parse(raw) as string[]) : [];
      return new Set(arr);
    } catch {
      return new Set<string>();
    }
  });

  // re-hydrate when day changes
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`onDuty:${dayKey}`);
      setOnDutyIds(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setOnDutyIds(new Set());
    }
  }, [dayKey]);

  // persist changes
  useEffect(() => {
    try {
      localStorage.setItem(`onDuty:${dayKey}`, JSON.stringify([...onDutyIds]));
    } catch {}
  }, [onDutyIds, dayKey]);

  // --- Derived ---
  const usedGuardIds = useMemo(
    () => Object.values(assigned).filter((v): v is string => Boolean(v)).map(strip),
    [assigned]
  );

  const seatedSet = useMemo(() => new Set(usedGuardIds), [usedGuardIds]);

  const alreadyQueuedIds = useMemo(
    () => new Set(breakQueue.map((q) => strip(q.guardId))),
    [breakQueue]
  );

  const totalQueued = useMemo(() => {
    const bucketTotals = Object.values(queuesBySection ?? {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    return bucketTotals > 0 ? bucketTotals : breakQueue.length;
  }, [queuesBySection, breakQueue]);

  const anyAssigned = useMemo(() => Object.values(assigned).some(Boolean), [assigned]);

  // ---------- Persistence race-guards ----------
  const assignedHydratedRef = useRef(false); // set true after we read LS on mount/day change
  const allowPersistRef = useRef(false); // set true *one microtask later* to avoid clobber

  // ---------- Data funcs ----------
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

    // Keep latest row per station
    const latestByStation = new Map<string, (typeof items)[number]>();
    for (const it of items) {
      const prev = latestByStation.get(it.stationId);
      if (!prev || String(prev.updatedAt ?? "") < String(it.updatedAt ?? "")) {
        latestByStation.set(it.stationId, it);
      }
    }

    // **Merge non-null only** so we never clear a locally assigned seat with nulls from server.
    setAssigned((prev) => {
      const next = { ...prev };
      for (const p of POSITIONS) {
        const rec = latestByStation.get(p.id);
        if (rec?.guardId) next[p.id] = rec.guardId;
      }
      return next;
    });
  };

  const fetchQueue = async (opts?: { keepBuckets?: boolean }) => {
    const keepBuckets = !!opts?.keepBuckets;

    const res = await fetch(`/api/plan/queue?date=${dayKey}`, {
      headers: { "x-api-key": "dev-key-123" },
    });
    const data = await res.json();

    // Normalize every row defensively
    const flat: QueueEntry[] = Array.isArray(data?.queue)
      ? data.queue.map((q: any) => ({
          guardId: strip(String(q.guardId)),
          returnTo: String(q.returnTo),
          enteredTick:
            typeof q.enteredTick === "number" && Number.isFinite(q.enteredTick)
              ? Math.trunc(q.enteredTick)
              : 0,
        }))
      : [];

    setBreakQueue(flat);

    if (!keepBuckets) {
      const sectionsLocal = Array.from(
        new Set(POSITIONS.map((p) => p.id.split(".")[0]))
      ).sort((a, b) => Number(a) - Number(b));

      const buckets: Record<string, QueueEntry[]> = {};
      for (const s of sectionsLocal) buckets[s] = [];
      for (const q of flat) {
        if (!buckets[q.returnTo]) buckets[q.returnTo] = [];
        buckets[q.returnTo].push(q);
      }
      setQueuesBySection(buckets);
    }
  };

  // ---------- Hydrate assigned (pre-paint) & then fetch data ----------
  useLayoutEffect(() => {
    assignedHydratedRef.current = false;
    allowPersistRef.current = false;

    // 1) Hydrate from localStorage synchronously
    const raw = localStorage.getItem(`assigned:${dayKey}`);
    if (raw) {
      try {
        const loc = JSON.parse(raw) as Assigned;
        const normalized: Assigned = Object.fromEntries(
          POSITIONS.map((p) => [p.id, loc && p.id in loc ? (loc as any)[p.id] : null])
        );
        setAssigned(normalized);
      } catch {
        // ignore parse error; keep current assigned
      }
    }

    // 2) Mark hydration done, allow persist on next microtask (after React applies setState)
    assignedHydratedRef.current = true;
    queueMicrotask(() => {
      allowPersistRef.current = true;
    });

    // 3) Fetch server data (merge-only for assigned)
    void fetchGuards();
    void fetchAssignments();
    void fetchQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  // Persist assigned to localStorage AFTER hydration has applied
  useEffect(() => {
    if (!assignedHydratedRef.current || !allowPersistRef.current) return;
    try {
      localStorage.setItem(`assigned:${dayKey}`, JSON.stringify(assigned));
    } catch {}
  }, [assigned, dayKey]);

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
        body: JSON.stringify({
          date: dayKey,
          guardId,
          returnTo,
          nowISO: simulatedNow.toISOString(),
        }),
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
          date: dayKey,
          nowISO: newNow.toISOString(),
          assignedSnapshot: assigned, // <- REQUIRED
        }),
      });

      const data = await res.json();
      if (data?.assigned) setAssigned(data.assigned);
      if (data?.breaks) setBreaks(data.breaks);
      if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);
      if (data?.meta?.queuesBySection) setQueuesBySection(data.meta.queuesBySection);
      // refresh flat list but DO NOT overwrite buckets we just set
      await fetchQueue({ keepBuckets: true });
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
    setQueuesBySection({});
    setAssigned(Object.fromEntries(POSITIONS.map((p) => [p.id, null])));
    setBreaks({});

    // clear local cache for THIS simulated day
    try {
      localStorage.removeItem(`breaks:${dayKey}`);
      localStorage.removeItem(`assigned:${dayKey}`); // also clear seats cache on explicit refresh
      localStorage.removeItem(`onDuty:${dayKey}`);
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
      const allowedIds = [...onDutyIds];
      if (allowedIds.length === 0) {
        alert("Select at least one on-duty guard before Autopopulate.");
        return;
      }

      const res = await fetch("/api/plan/autopopulate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: dayKey,
          nowISO: simulatedNow.toISOString(),
          allowedIds, // <-- ONLY these guards will be considered server-side
        }),
      });
      const data = await res.json();
      if (data?.assigned) setAssigned(data.assigned);
      if (data?.breaks) setBreaks(data.breaks);
      if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);
      if (Array.isArray(data?.meta?.breakQueue)) setBreakQueue(data.meta.breakQueue);
      if (data?.meta?.queuesBySection) setQueuesBySection(data.meta.queuesBySection);
    } catch (e) {
      console.error("Autopopulate failed:", e);
    }
  };

  // -------- Render --------
  return (
    <AppShell title="Lifeguard Rotation Manager">
      {/* Main layout: map left, tools/queue right on lg; stacked on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        {/* LEFT: Pool map */}
        <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
          <h2 className="text-lg font-semibold text-slate-100 mb-3">Pool Map</h2>
          <PoolMap
            className="w-full h-[70vh] lg:h-[82vh]"
            guards={guards}
            assigned={assigned}
            onPick={(positionId) => setPickerFor(positionId)}
            onClear={clearGuard}
            conflicts={conflicts}
          />
        </section>

        {/* RIGHT: Sidebar — toolbar + on-duty + queue (sticky on desktop) */}
        <aside className="space-y-6 lg:sticky lg:top-4 self-start">
          <ToolbarActions
            onPlus15={plus15Minutes}
            onAuto={autopopulate}
            onNewGuard={() => setCreateOpen(true)}
            onRefresh={handleRefreshAll}
            disabled={rotatingRef.current || (!anyAssigned && totalQueued === 0)}
            stamp={`Simulated: ${dayKey} ${simulatedNow.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}`}
          />

          {/* NEW: On-duty selector */}
          <OnDutyPanel
            guards={guards}
            value={onDutyIds}
            onChange={setOnDutyIds}
          />

          <BreakQueue
            queuesBySection={queuesBySection}
            flatQueue={breakQueue}
            seatedSet={seatedSet}
            guards={guards}
            onClearAll={async () => {
              try {
                await fetch("/api/plan/queue-clear", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
                  body: JSON.stringify({ date: dayKey }),
                });
                setBreakQueue([]);
                setQueuesBySection({});
              } catch (e) {
                console.error("Failed to clear queues:", e);
              }
            }}
            onAddToSection={(sec) => setQueuePickerFor(sec)}
          />
        </aside>
      </div>

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

      {/* Add directly to a section queue */}
      <GuardPickerModal
        open={queuePickerFor !== null}
        onClose={() => setQueuePickerFor(null)}
        guards={guards.filter((g) => !usedGuardIds.includes(g.id) && !alreadyQueuedIds.has(g.id))}
        alreadyAssignedIds={[]}
        onSelect={async (guardId: string) => {
          if (!queuePickerFor) return;
          const sec = queuePickerFor;
          setQueuePickerFor(null);
          await addToQueue(guardId, sec);
        }}
        title={queuePickerFor ? `Add guard to ${queuePickerFor}.x queue` : "Add to Queue"}
      />

      <GuardsListModal open={listOpen} onClose={() => setListOpen(false)} guards={guards} />
    </AppShell>
  );
}
