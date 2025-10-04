import { useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import AppShell from "../components/AppShell";
import PoolMap from "../components/PoolMap";
import ToolbarActions from "../components/actions/ToolbarActions";
import BreakQueue from "../components/queue/BreakQueue";
import GuardPickerModal from "../components/modals/GuardPickerModal";
import GuardsListModal from "../components/modals/GuardsListModal";
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

// ---------- On-duty modal ----------
function OnDutySelectorModal({
  open,
  onClose,
  guards,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  guards: Guard[];
  value: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const sorted = useMemo(
    () =>
      [...guards].sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: "base" })
      ),
    [guards]
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return sorted;
    const q = query.toLowerCase();
    return sorted.filter(
      (g) => g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q)
    );
  }, [sorted, query]);

  const toggle = (gid: string) => {
    const next = new Set(value);
    next.has(gid) ? next.delete(gid) : next.add(gid);
    onChange(next);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[min(720px,95vw)] max-h-[85vh] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
        <header className="p-4 border-b border-slate-700 flex items-center gap-3">
          <h3 className="text-slate-100 font-semibold">Select On-Duty Guards</h3>
          <span className="ml-auto text-slate-400 text-sm">
            Selected: <span className="text-slate-200 font-medium">{value.size}</span> / {guards.length}
          </span>
          <button
            className="ml-3 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={onClose}
          >
            Done
          </button>
        </header>

        <div className="p-4 border-b border-slate-700 flex items-center gap-2">
          <input
            type="text"
            placeholder="Search guards…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 rounded-lg bg-slate-800/80 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-500"
          />
          <button
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={() => onChange(new Set(filtered.map((g) => g.id)))}
            title="Select all shown"
          >
            Select shown
          </button>
          <button
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={() => {
              const ids = new Set(filtered.map((g) => g.id));
              onChange(new Set([...value].filter((id) => !ids.has(id))));
            }}
            title="Clear all shown"
          >
            Clear shown
          </button>
          <button
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
            onClick={() => onChange(new Set())}
            title="Clear all"
          >
            Clear all
          </button>
        </div>

        <div className="overflow-auto max-h-[60vh]">
          <ul className="divide-y divide-slate-800">
            {filtered.map((g) => {
              const checked = value.has(g.id);
              return (
                <li key={g.id} className="flex items-center justify-between px-4 py-2 hover:bg-slate-800/60">
                  <div className="min-w-0">
                    <p className="text-slate-100 truncate">{g.name || g.id}</p>
                    <p className="text-slate-400 text-xs truncate">{g.id}</p>
                  </div>
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={checked} onChange={() => toggle(g.id)} className="h-4 w-4 accent-slate-300" />
                    <span className="text-slate-300 text-sm">{checked ? "On duty" : "Off"}</span>
                  </label>
                </li>
              );
            })}
            {!filtered.length && (
              <li className="px-4 py-6 text-center text-slate-400 text-sm">No guards match your search.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

// --- On-duty bench (drag sources) ---
function OnDutyBench({
  guards,
  title = "On-duty (unassigned)",
  onDropGuardToBench,
}: {
  guards: Guard[];
  title?: string;
  onDropGuardToBench: (guardId: string, e: React.DragEvent) => void;
}) {
  return (
    <section
      className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const gid =
          e.dataTransfer.getData("application/x-guard-id") ||
          e.dataTransfer.getData("text/plain");
        if (gid) onDropGuardToBench(gid.trim(), e);
      }}
    >
      <header className="p-4 border-b border-slate-700 flex items-center justify-between">
        <h3 className="text-slate-100 font-semibold">{title}</h3>
        <span className="text-xs text-slate-400">{guards.length}</span>
      </header>

      <div className="p-3">
        {guards.length === 0 ? (
          <p className="text-sm text-slate-400 px-1 py-2">No on-duty guards waiting.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {guards.map((g) => (
              <li
                key={g.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-guard-id", g.id);
                  e.dataTransfer.setData("text/plain", g.id);
                  e.dataTransfer.setData("application/x-source", "bench");
                }}
                className="select-none cursor-grab active:cursor-grabbing px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-100 text-sm shadow-sm"
                title={`Drag ${g.name || g.id} onto a seat or a queue`}
                data-guard-id={g.id}
              >
                <span className="font-medium">{g.name || g.id}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-500">Drag a chip to a seat or a section queue. Drop here to unseat/unqueue.</p>
      </div>
    </section>
  );
}

// --- Simple simulated clock ---
function SimClock({
  now,
  onRotate,
  disabled,
}: {
  now: Date;
  onRotate: () => void;
  disabled?: boolean;
}) {
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div>
      <div className="text-2xl font-bold text-slate-100 leading-tight">{timeStr}</div>
      <button
        onClick={onRotate}
        disabled={disabled}
        className="mt-2 w-full px-3 py-1.5 rounded-lg bg-pool-500 hover:bg-pool-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-900 text-sm font-semibold"
      >
        Rotate
      </button>
    </div>
  );
}

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
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [queuePickerFor, setQueuePickerFor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [onDutyOpen, setOnDutyOpen] = useState(false);
  const [movingIds, setMovingIds] = useState<Set<string>>(new Set());
  const beginMove = (gid: string) => setMovingIds((s) => new Set(s).add(gid));
  const endMove = (gid: string) => setMovingIds((s) => { const n = new Set(s); n.delete(gid); return n; });

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
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`onDuty:${dayKey}`);
      setOnDutyIds(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setOnDutyIds(new Set());
    }
  }, [dayKey]);
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

  const onDutyUnassigned: Guard[] = useMemo(() => {
    const onDuty = new Set(onDutyIds);
    return guards.filter(
      (g) => onDuty.has(g.id) && !seatedSet.has(g.id) && !alreadyQueuedIds.has(g.id) && !movingIds.has(g.id)
    );
  }, [guards, onDutyIds, seatedSet, alreadyQueuedIds, movingIds]);

  const totalQueued = useMemo(() => {
    const bucketTotals = Object.values(queuesBySection ?? {}).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
    return bucketTotals > 0 ? bucketTotals : breakQueue.length;
  }, [queuesBySection, breakQueue]);

  const anyAssigned = useMemo(() => Object.values(assigned).some(Boolean), [assigned]);

  // ---------- Persistence guards ----------
  const assignedHydratedRef = useRef(false);
  const allowPersistRef = useRef(false);

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
      for (const q of flat as QueueEntry[]) {
        if (!buckets[q.returnTo]) buckets[q.returnTo] = [];
        buckets[q.returnTo].push(q);
      }
      setQueuesBySection(buckets);
    }
  };

  const tickToISO = (tick: number) => new Date(tick * 15 * 60 * 1000).toISOString();

  // -------------- Queue helpers / persistence --------------
  const SECTIONS = Array.from(new Set(POSITIONS.map(p => p.id.split(".")[0]))).sort((a,b)=>Number(a)-Number(b));
  const flattenBuckets = (b: Record<string, QueueEntry[]>): QueueEntry[] =>
    SECTIONS.flatMap((sec) => (b[sec] ?? []));

  // single-write snapshot persist (NO CLEAR)
  const persistQueueSnapshot = async (buckets: Record<string, QueueEntry[]>) => {
    const payload = flattenBuckets(buckets).map((q: QueueEntry) => ({
      guardId: q.guardId,
      returnTo: q.returnTo,
      enteredTick: q.enteredTick,
    }));

    await fetch("/api/plan/queue-set", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
      body: JSON.stringify({ date: dayKey, queue: payload }),
    });
  };

  const applyBucketsAndPersist = async (next: Record<string, QueueEntry[]>) => {
    setQueuesBySection(next);
    setBreakQueue(flattenBuckets(next));
    try {
      await persistQueueSnapshot(next);
    } catch (err) {
      console.error("queue-set failed; refreshing", err);
      await fetchQueue({ keepBuckets: false });
    }
  };

  // ---------- Hydrate assigned & then fetch data ----------
  useLayoutEffect(() => {
    assignedHydratedRef.current = false;
    allowPersistRef.current = false;

    const raw = localStorage.getItem(`assigned:${dayKey}`);
    if (raw) {
      try {
        const loc = JSON.parse(raw) as Assigned;
        const normalized: Assigned = Object.fromEntries(
          POSITIONS.map((p) => [p.id, (loc && p.id in loc ? (loc as any)[p.id] : null)])
        );
        setAssigned(normalized);
      } catch {}
    }

    assignedHydratedRef.current = true;
    queueMicrotask(() => {
      allowPersistRef.current = true;
    });

    void fetchGuards();
    void fetchAssignments();
    void fetchQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  useEffect(() => {
    if (!assignedHydratedRef.current || !allowPersistRef.current) return;
    try {
      localStorage.setItem(`assigned:${dayKey}`, JSON.stringify(assigned));
    } catch {}
  }, [assigned, dayKey]);

  // -------- Seat/Queue helpers --------
  const findSeatByGuard = (gid: string): string | null => {
    for (const [sid, g] of Object.entries(assigned)) if (g === gid) return sid;
    return null;
  };
  const persistSeat = async (seatId: string, guardId: string | null, notes: string) => {
    await fetch("/api/rotations/slot", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
      body: JSON.stringify({
        date: dayKey,
        time: new Date().toISOString().slice(11, 16),
        stationId: seatId,
        guardId,
        notes,
      }),
    });
  };

  const optimisticSeatClearByGuard = (guardId: string) => {
    setAssigned((prev) => {
      let seatFound: string | null = null;
      for (const [sid, id] of Object.entries(prev)) if (id === guardId) { seatFound = sid; break; }
      if (!seatFound) return prev;
      const next = { ...prev };
      next[seatFound] = null;
      return next;
    });
  };

  // -------- Mutations --------
  const assignGuard = async (positionId: string, guardId: string) => {
    const seatedIds = new Set(Object.values(assigned).filter(Boolean) as string[]);
    if (seatedIds.has(guardId)) return;

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
          notes: "drag-drop-assign",
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
          notes: "clear-seat",
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
          notes: "drag-drop-queue",
        }),
      });
      await fetchQueue();
    } catch (e) {
      console.error("Failed to add to queue:", e);
    }
  };

  // ---- Drops: seats ----
  const handleSeatDrop = async (destSeatId: string, guardId: string) => {
    if (!onDutyIds.has(guardId)) {
      alert("Only on-duty guards can be seated.");
      return;
    }

    const fromSeatId = findSeatByGuard(guardId);
    const destOccupant = (assigned[destSeatId] ?? null) as string | null;
    if (fromSeatId === destSeatId) return;

    if (fromSeatId) {
      setAssigned((prev) => {
        const next = { ...prev };
        next[destSeatId] = guardId;
        next[fromSeatId] = destOccupant;
        return next;
      });

      try {
        await Promise.all([
          persistSeat(destSeatId, guardId, "drag-seat-move"),
          persistSeat(fromSeatId, destOccupant, "drag-seat-swap"),
        ]);
      } catch (e) {
        console.error("Swap persist failed:", e);
      }
      return;
    }

    setAssigned((prev) => ({ ...prev, [destSeatId]: guardId }));
    try {
      await persistSeat(destSeatId, guardId, "drag-seat-assign");
    } catch (e) {
      console.error("Assign persist failed:", e);
    }
  };

  // ---- Drops: queues ----
  // precise within/between reordering (queue → queue)
  const handleQueueMove = ({
    guardId, fromSec, toSec, toIndex,
  }: { guardId: string; fromSec: string; fromIndex: number; toSec: string; toIndex: number }) => {
    setQueuesBySection(prev => {
      const next: Record<string, QueueEntry[]> = {};
      for (const [sec, arr] of Object.entries(prev)) next[sec] = [...(arr ?? [])];

      const src = next[fromSec] ?? [];
      const i = src.findIndex(r => r.guardId === guardId);
      if (i === -1) return prev;
      const [row] = src.splice(i, 1);

      const dst = next[toSec] ?? [];
      const idx = Math.max(0, Math.min(toIndex, dst.length));
      dst.splice(idx, 0, row);

      // optimistic UI
      next[fromSec] = src;
      next[toSec] = dst;
      setBreakQueue(flattenBuckets(next));

      // persist atomically
      void persistQueueSnapshot(next).catch(async (e) => {
        console.error("persist reorder failed", e);
        await fetchQueue({ keepBuckets: false });
      });

      return next;
    });
  };

  // bench/seat → queue at index
  const handleExternalToQueue = async (
    { guardId, source, sec, index }: { guardId: string; source: "bench" | "seat" | ""; sec: string; index: number },
    e: React.DragEvent
  ) => {
    const currentTick = Math.floor(Date.parse(simulatedNow.toISOString()) / (15 * 60 * 1000));

    // if from seat, optimistically clear it
    if (source === "seat") {
      const seatId = e.dataTransfer.getData("application/x-seat-id") || findSeatByGuard(guardId);
      if (seatId) setAssigned(prev => ({ ...prev, [seatId]: null }));
    }

    setQueuesBySection(prev => {
      const next: Record<string, QueueEntry[]> = {};
      for (const [s, arr] of Object.entries(prev)) {
        next[s] = (arr ?? []).filter(r => r.guardId !== guardId);
      }
      const row: QueueEntry = { guardId, returnTo: sec, enteredTick: currentTick };
      const dst = next[sec] ?? [];
      const idx = Math.max(0, Math.min(index, dst.length));
      dst.splice(idx, 0, row);
      next[sec] = dst;

      // optimistic UI
      setBreakQueue(flattenBuckets(next));

      // persist atomically; also clear seat on server if needed
      void (async () => {
        try {
          if (source === "seat") {
            const seatId = e.dataTransfer.getData("application/x-seat-id") || findSeatByGuard(guardId);
            if (seatId) {
              await fetch("/api/rotations/slot", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
                body: JSON.stringify({
                  date: dayKey,
                  time: new Date().toISOString().slice(11, 16),
                  stationId: seatId,
                  guardId: null,
                  notes: "queue-drop-from-seat",
                }),
              });
            }
          }
          await persistQueueSnapshot(next);
        } catch (err) {
          console.error("persist external→queue failed", err);
          await fetchQueue({ keepBuckets: false });
        }
      })();

      return next;
    });
  };

  // append (legacy bucket background drop)
  const handleQueueDrop = async (sectionId: string, guardId: string) => {
    // mark on-duty if needed
    if (!onDutyIds.has(guardId)) setOnDutyIds(prev => new Set([...prev, guardId]));

    // if already in any bucket, ignore (use precise reorder instead)
    if (Object.values(queuesBySection).some(arr => (arr ?? []).some((qq: QueueEntry) => qq.guardId === guardId))) return;

    const enteredTick = Math.floor(Date.parse(simulatedNow.toISOString()) / (15 * 60 * 1000));

    const next: Record<string, QueueEntry[]> = {};
    for (const [sec, arr] of Object.entries(queuesBySection)) next[sec] = [...(arr ?? [])];
    (next[sectionId] ??= []).push({ guardId, returnTo: sectionId, enteredTick });

    await applyBucketsAndPersist(next);
  };

  // queue → bench (drop on OnDutyBench)
  const handleBenchDrop = async (guardId: string, e: React.DragEvent) => {
    const src = e.dataTransfer.getData("application/x-source");

    if (src === "seat") {
      const seatId = e.dataTransfer.getData("application/x-seat-id") || findSeatByGuard(guardId);
      if (seatId) await clearGuard(seatId);
    }

    if (src === "queue") {
      // remove from buckets and persist via queue-set (NO CLEAR spam)
      const next: Record<string, QueueEntry[]> = {};
      for (const [sec, arr] of Object.entries(queuesBySection)) {
        next[sec] = (arr ?? []).filter((qq: QueueEntry) => qq.guardId !== guardId);
      }
      await applyBucketsAndPersist(next);
    }

    setOnDutyIds(prev => (prev.has(guardId) ? prev : new Set([...prev, guardId])));
  };

  // ---- Rotate / Refresh / Autopopulate
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
          assignedSnapshot: assigned,
        }),
      });

      const data = await res.json();
      if (data?.assigned) setAssigned(data.assigned);
      if (data?.breaks) setBreaks(data.breaks);
      if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);
      if (data?.meta?.queuesBySection) setQueuesBySection(data.meta.queuesBySection);
      await fetchQueue({ keepBuckets: true });
    } catch (e) {
      console.error("Rotate failed:", e);
    } finally {
      rotatingRef.current = false;
    }
  };

  const handleClearQueues = async () => {
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
  };

  const handleRefreshAll = async () => {
    const reset = new Date(simulatedNow);
    reset.setHours(12, 0, 0, 0);
    setSimulatedNow(reset);

    setOnDutyOpen(false);
    setMovingIds(new Set());
    setOnDutyIds(new Set());
    setBreakQueue([]);
    setQueuesBySection({});
    setAssigned(Object.fromEntries(POSITIONS.map((p) => [p.id, null])));
    setBreaks({});
    setConflicts([]);

    try {
      localStorage.removeItem(`breaks:${dayKey}`);
      localStorage.removeItem(`assigned:${dayKey}`);
      localStorage.removeItem(`onDuty:${dayKey}`);
    } catch {}

    try {
      const time = new Date().toISOString().slice(11, 16);
      await Promise.allSettled([
        ...POSITIONS.map((p) =>
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
        ),
        fetch("/api/plan/queue-clear", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
          body: JSON.stringify({ date: dayKey }),
        }),
      ]);
    } catch (e) {
      console.warn("Backend reset failed (continuing):", e);
    } finally {
      await Promise.allSettled([fetchAssignments(), fetchQueue()]);
    }
  };

  const autopopulate = async () => {
    try {
      const allowedIds = [...onDutyIds];
      if (allowedIds.length === 0) {
        alert("Select at least one on-duty guard before Autopopulate.");
        return;
      }

      // lock all currently queued guards (do not move)
      const lockedQueueIds = Array.from(new Set(breakQueue.map((q) => strip(q.guardId))));

      const res = await fetch("/api/plan/autopopulate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: dayKey,
          nowISO: simulatedNow.toISOString(),
          allowedIds,
          assignedSnapshot: assigned,
          lockedQueueIds,
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
      {/* Desktop: 3 columns — Main | BreakQueue | On-Duty column */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px_360px] gap-6 items-start">
        {/* LEFT: Clock + Pool map */}
        <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
          <h2 className="text-lg font-semibold text-slate-100 mb-3">Pool Map</h2>
          <div className="mb-3 grid place-items-center">
            <SimClock
              now={simulatedNow}
              onRotate={plus15Minutes}
              disabled={rotatingRef.current}
            />
          </div>

          <PoolMap
            className="w-full h-[70vh] lg:h-[82vh]"
            guards={guards}
            assigned={assigned}
            onPick={(positionId) => setPickerFor(positionId)}
            onClear={clearGuard}
            conflicts={conflicts}
            onSeatDrop={handleSeatDrop}
          />
        </section>

        {/* MIDDLE: Toolbar + Break Queue */}
        <aside className="space-y-6 lg:sticky lg:top-4 self-start">
          <ToolbarActions
            onPlus15={plus15Minutes}
            onAuto={autopopulate}
            onNewGuard={() => setCreateOpen(true)}
            onRefresh={handleRefreshAll}
            disabled={rotatingRef.current || (!anyAssigned && totalQueued === 0)}
            stamp={""}
          />

          <BreakQueue
            queuesBySection={queuesBySection}
            flatQueue={breakQueue}
            seatedSet={seatedSet}
            guards={guards}
            onClearAll={handleClearQueues}
            // Background drop on bucket = append (legacy)
            onDropGuardToSection={(sec, e) => {
              const gid =
                e.dataTransfer.getData("application/x-guard-id") ||
                e.dataTransfer.getData("text/plain");
              if (!gid) return;
              void handleQueueDrop(sec, gid.trim());
            }}
            // Precise within/between reordering
            onMoveWithinQueue={handleQueueMove}
            // Bench/Seat → Queue at specific index
            onDropExternalToQueue={(payload, e) => handleExternalToQueue(payload, e)}
          />
        </aside>

        {/* RIGHT: On-duty column */}
        <aside className="space-y-4 lg:sticky lg:top-4 self-start">
          <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-slate-100 font-semibold">On-Duty Controls</h3>
                <p className="text-slate-400 text-sm">
                  Selected: <span className="text-slate-200 font-medium">{onDutyIds.size}</span>
                </p>
              </div>
              <button
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                onClick={() => setOnDutyOpen(true)}
              >
                Select On-Duty
              </button>
            </div>
          </section>

          <OnDutyBench
            guards={onDutyUnassigned}
            onDropGuardToBench={handleBenchDrop}
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

      {/* On-duty selector modal */}
      <OnDutySelectorModal
        open={onDutyOpen}
        onClose={() => setOnDutyOpen(false)}
        guards={guards}
        value={onDutyIds}
        onChange={setOnDutyIds}
      />

      <GuardsListModal open={listOpen} onClose={() => setListOpen(false)} guards={guards} />
    </AppShell>
  );
}
