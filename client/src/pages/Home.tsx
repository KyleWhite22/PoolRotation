import { useMemo, useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import AppShell from "../components/AppShell";
import PoolMap from "../components/PoolMap";
import ToolbarActions from "../components/actions/ToolbarActions";
import BreakQueue from "../components/queue/BreakQueue";
import GuardPickerModal from "../components/modals/GuardPickerModal";
import GuardsListModal from "../components/modals/GuardsListModal";
import { POSITIONS } from "../data/poolLayout.js";
import type { Guard } from "../lib/types";
import { StandardLoading, RotationLoading, AutofillLoading } from "../components/LoadingScreens";
import { apiFetch } from "../lib/api";

// -------- Local helpers / types --------
type Assigned = Record<string, string | null>;
type BreakState = Record<string, string>;
type ConflictUI = { stationId: string; guardId: string; reason: string };
type QueueEntry = { guardId: string; returnTo: string; enteredTick: number };

const strip = (s: string) => (s?.startsWith?.("GUARD#") ? s.slice(6) : s);
const ymdLocal = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // YYYY-MM-DD

const emptyAssigned = (): Assigned =>
  Object.fromEntries(POSITIONS.map((p) => [p.id, null])) as Assigned;

const SECTIONS = Array.from(new Set(POSITIONS.map((p) => p.id.split(".")[0]))).sort(
  (a, b) => Number(a) - Number(b)
);

// Normalize strings for name matching
const norm = (s: unknown) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

// ---------- queue helpers (canonical flat) ----------
const asQueueEntriesRaw = (v: any): QueueEntry[] =>
  Array.isArray(v)
    ? v.map((q) => ({
        guardId: String(q?.guardId ?? ""),
        returnTo: String(q?.returnTo ?? ""),
        enteredTick:
          typeof q?.enteredTick === "number" && Number.isFinite(q.enteredTick)
            ? Math.trunc(q.enteredTick)
            : 0,
      }))
    : [];

const deduplicateQueue = (queue: QueueEntry[]): QueueEntry[] => {
  const byGuard = new Map<string, QueueEntry>();
  for (const entry of queue) {
    const gid = strip(entry.guardId);
    if (!gid) continue;
    byGuard.set(gid, { guardId: gid, returnTo: entry.returnTo, enteredTick: entry.enteredTick });
  }
  return Array.from(byGuard.values());
};

// -------- Local persistence --------
type DaySnapshot = {
  assigned: Assigned;
  breakQueue: QueueEntry[];
  breaks: BreakState;
  conflicts: ConflictUI[];
  onDutyIds: string[];
  simulatedNowISO: string;
};
const SNAP_KEY = (day: string) => `snapshot:${day}`;
const loadSnapshot = (day: string): DaySnapshot | null => {
  try {
    const raw = localStorage.getItem(SNAP_KEY(day));
    return raw ? (JSON.parse(raw) as DaySnapshot) : null;
  } catch {
    return null;
  }
};
const saveSnapshot = (day: string, s: DaySnapshot) => {
  try {
    localStorage.setItem(SNAP_KEY(day), JSON.stringify(s));
  } catch {}
};

export default function Home() {
  // BEFORE any useState:
  const initialSimulatedNow = (() => {
    const saved = localStorage.getItem("simulatedNowISO");
    const d = saved ? new Date(saved) : new Date();
    if (isNaN(d.getTime())) {
      const now = new Date();
      now.setHours(12, 0, 0, 0);
      return now;
    }
    return d;
  })();
  const initialDayKey = ymdLocal(initialSimulatedNow);
  const initialSnap = loadSnapshot(initialDayKey);

  // --- Server data ---
  const [guards, setGuards] = useState<Guard[]>([]);
  const [guardsLoaded, setGuardsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isRotatingUI, setIsRotatingUI] = useState(false);
  const [isAutofilling, setIsAutofilling] = useState(false);

  // --- Rotation state ---
  const [assigned, setAssigned] = useState<Assigned>(() => emptyAssigned());
  const [breaks, setBreaks] = useState<BreakState>({});
  const [conflicts, setConflicts] = useState<ConflictUI[]>([]);
  const [breakQueue, setBreakQueue] = useState<QueueEntry[]>([]); // CANONICAL queue

  // --- Derived buckets from canonical flat queue ---
  const queuesBySection = useMemo(() => {
    const b: Record<string, QueueEntry[]> = {};
    for (const s of SECTIONS) b[s] = [];
    for (const q of breakQueue) (b[q.returnTo] ??= []).push(q);
    return b;
  }, [breakQueue]);

  // --- UI state ---
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [queuePickerFor, setQueuePickerFor] = useState<string | null>(null);
  const [_createOpen, setCreateOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [onDutyOpen, setOnDutyOpen] = useState(false);
  const [movingIds] = useState<Set<string>>(new Set());

  const rotatingRef = useRef(false);

  // Simulated time
  const [simulatedNow, setSimulatedNow] = useState<Date>(() => {
    return initialSnap?.simulatedNowISO ? new Date(initialSnap.simulatedNowISO) : initialSimulatedNow;
  });
  useEffect(() => {
    localStorage.setItem("simulatedNowISO", simulatedNow.toISOString());
  }, [simulatedNow]);

  const dayKey = useMemo(() => ymdLocal(simulatedNow), [simulatedNow]);

  // --- Known guard id set & name->id map (for normalization) ---
  const knownIds = useMemo(() => new Set(guards.map((g) => g.id)), [guards]);
  const guardIdByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of guards) {
      const key = norm(g.name || g.id);
      if (key) m.set(key, g.id);
    }
    return m;
  }, [guards]);

  const isUuid = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

  const toId = useCallback(
    (raw: any): string | null => {
      if (raw == null) return null;
      const s = strip(String(raw).trim());
      if (!s) return null;
      if (knownIds.has(s)) return s; // known id
      if (isUuid(s)) return s; // brand-new id
      const byName = guardIdByName.get(norm(s));
      if (byName && (knownIds.has(byName) || isUuid(byName))) return byName;
      return null;
    },
    [knownIds, guardIdByName]
  );

  // --- On-duty selection (persisted per day) ---
  const [onDutyIds, setOnDutyIds] = useState<Set<string>>(() => {
    if (initialSnap?.onDutyIds) return new Set(initialSnap.onDutyIds);
    try {
      const raw = localStorage.getItem(`onDuty:${initialDayKey}`);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  // ---------- Persistence guards ----------
  const assignedHydratedRef = useRef(false);
  const allowPersistRef = useRef(false);

  // Persist a full snapshot on any change to core day state
  useEffect(() => {
    if (!allowPersistRef.current) return;
    const snap: DaySnapshot = {
      assigned,
      breakQueue,
      breaks,
      conflicts,
      onDutyIds: [...onDutyIds],
      simulatedNowISO: simulatedNow.toISOString(),
    };
    saveSnapshot(dayKey, snap);
  }, [assigned, breakQueue, breaks, conflicts, onDutyIds, simulatedNow, dayKey]);

  useEffect(() => {
    if (!guardsLoaded) return;
    setOnDutyIds((prev) => {
      const keep = [...prev].filter((id) => knownIds.has(id) || isUuid(id));
      return new Set(keep);
    });
  }, [guardsLoaded, knownIds]);

  // --- Derived ---
  const usedGuardIds = useMemo(
    () =>
      Object.values(assigned)
        .filter((v): v is string => Boolean(v))
        .map((id) => String(id)),
    [assigned]
  );
  const seatedSet = useMemo(() => new Set(usedGuardIds), [usedGuardIds]);
  const totalQueued = useMemo(() => breakQueue.length, [breakQueue]);
  const anyAssigned = useMemo(() => Object.values(assigned).some(Boolean), [assigned]);

  // ---------- Data funcs ----------
  const normalizeGuards = (items: any[]): Guard[] =>
    items
      .map((it) => {
        const id: string =
          typeof it.id === "string"
            ? strip(it.id)
            : typeof it.pk === "string" && it.pk.startsWith("GUARD#")
            ? it.pk.slice("GUARD#".length)
            : "";
        if (!id) return null;
        return { id, name: it.name ?? "", dob: it.dob ?? "" };
      })
      .filter(Boolean) as Guard[];

  const guardsDirtyRef = useRef(false);

  const fetchGuards = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch(`/api/guards`, {
        headers: { "x-api-key": "dev-key-123" },
      });
      if (!res.ok) throw new Error(`GET /api/guards ${res.status}`);
      const data = await res.json();
      const normalized = Array.isArray(data) ? normalizeGuards(data) : [];
      setGuards(normalized);
      setGuardsLoaded(true);
      guardsDirtyRef.current = false;
      return normalized;
    } catch (err) {
      console.error("fetchGuards error:", err);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // listeners
  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("guards");
      bc.onmessage = (ev) => {
        if (ev?.data?.type === "created" || ev?.data?.type === "updated" || ev?.data?.type === "deleted") {
          guardsDirtyRef.current = true;
          void fetchGuards();
        }
      };
    } catch {}

    const onCreated = () => {
      guardsDirtyRef.current = true;
      void fetchGuards();
    };
    window.addEventListener("guards:created", onCreated);
    window.addEventListener("guards:updated", onCreated);
    window.addEventListener("guards:deleted", onCreated);

    const onStorage = (e: StorageEvent) => {
      if (e.key === "guards:invalidate") {
        guardsDirtyRef.current = true;
        void fetchGuards();
      }
    };
    window.addEventListener("storage", onStorage);

    const onFocus = () => {
      if (guardsDirtyRef.current) void fetchGuards();
    };
    window.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);

    return () => {
      try {
        bc?.close();
      } catch {}
      window.removeEventListener("guards:created", onCreated);
      window.removeEventListener("guards:updated", onCreated);
      window.removeEventListener("guards:deleted", onCreated);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchGuards]);

  const fetchAssignments = async () => {
    const res = await apiFetch(`/api/rotations/day/${dayKey}`, {
      headers: { "x-api-key": "dev-key-123" },
    });
    const items: { stationId: string; guardId?: string | null; updatedAt?: string }[] = await res.json();

    const latestByStation = new Map<string, (typeof items)[number]>();
    for (const it of items) {
      const prev = latestByStation.get(it.stationId);
      if (!prev || String(prev.updatedAt ?? "") < String(it.updatedAt ?? "")) {
        latestByStation.set(it.stationId, it);
      }
    }

    const raw: Assigned = emptyAssigned();
    for (const [seat, rec] of latestByStation.entries()) {
      const canon = toId(rec?.guardId);
      raw[seat] = canon; // null if unresolvable
    }
    setAssigned((prev) => ({ ...prev, ...raw } as Assigned));
  };

  const alreadyQueuedIds = useMemo(() => {
    const s = new Set<string>();
    for (const q of breakQueue ?? []) s.add(q.guardId);
    return s;
  }, [breakQueue]);

  // on-duty but not seated/queued
  const onDutyUnassigned: Guard[] = useMemo(() => {
    const onDuty = new Set(
      [...onDutyIds]
        .map((id) => toId(id))
        .filter((id): id is string => Boolean(id && (knownIds.has(id) || isUuid(String(id)))))
    );
    const inUse = new Set<string>();
    for (const gid of Object.values(assigned)) if (gid) inUse.add(gid);
    for (const q of breakQueue ?? []) inUse.add(q.guardId);
    for (const id of movingIds) {
      const canon = toId(id);
      if (canon) inUse.add(canon);
    }
    return guards.filter((g) => onDuty.has(g.id) && !inUse.has(g.id));
  }, [guards, onDutyIds, assigned, breakQueue, movingIds, knownIds, toId]);

  // ---------- Network helpers (queue) ----------
  const persistQueueFlat = async (flat: QueueEntry[]) => {
    const payload = flat.map((q) => ({
      guardId: q.guardId,
      returnTo: q.returnTo,
      enteredTick: q.enteredTick,
    }));
    await apiFetch(`/api/plan/queue-set`, {
      method: "POST",
      headers: { "x-api-key": "dev-key-123" },
      body: JSON.stringify({ date: dayKey, queue: payload }),
    });
  };

  const fetchQueue = async () => {
    const res = await apiFetch(`/api/plan/queue?date=${dayKey}`, {
      headers: { "x-api-key": "dev-key-123" },
    });
    const data = await res.json();
    const normalized: QueueEntry[] = asQueueEntriesRaw(data?.queue)
      .map((q) => {
        const canon = toId(q.guardId);
        return canon
          ? { guardId: canon, returnTo: String(q.returnTo), enteredTick: q.enteredTick || 0 }
          : null;
      })
      .filter(Boolean) as QueueEntry[];
    setBreakQueue(deduplicateQueue(normalized));
  };

  // ---------- Hydrate assigned & then fetch data ----------
  useLayoutEffect(() => {
    assignedHydratedRef.current = false;
    allowPersistRef.current = false;

    // 1) defaults
    setAssigned(emptyAssigned());
    setBreakQueue([]);
    setBreaks({});
    setConflicts([]);

    // 2) snapshot first
    const snap = loadSnapshot(dayKey);
    const bootstrappedFromLocal = !!snap;

    if (snap) {
      const d = new Date(snap.simulatedNowISO);
      if (!isNaN(d.getTime())) setSimulatedNow(d);

      setAssigned(snap.assigned ?? emptyAssigned());
      setBreakQueue(Array.isArray(snap.breakQueue) ? snap.breakQueue : []);
      setBreaks(snap.breaks ?? {});
      setConflicts(Array.isArray(snap.conflicts) ? snap.conflicts : []);
      setOnDutyIds(new Set(snap.onDutyIds ?? []));
    } else {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      setSimulatedNow(d);
      setOnDutyIds(new Set());
    }

    assignedHydratedRef.current = true;
    queueMicrotask(() => {
      allowPersistRef.current = true;
    });

    // 3) server merge
    if (!bootstrappedFromLocal) {
      void fetchAssignments();
      void fetchQueue();
    }
    void fetchGuards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  // -------- helpers --------
  const findSeatByGuard = (gid: string): string | null => {
    const want = toId(gid);
    if (!want) return null;
    for (const [sid, id] of Object.entries(assigned)) {
      if (id === want) return sid;
    }
    return null;
  };

  const persistSeat = async (seatId: string, guardId: string | null, notes: string) => {
    await apiFetch(`/api/rotations/slot`, {
      method: "POST",
      headers: { "x-api-key": "dev-key-123" },
      body: JSON.stringify({
        date: dayKey,
        nowISO: simulatedNow.toISOString(),
        stationId: seatId,
        guardId,
        notes,
      }),
    });
  };

  // -------- Mutations --------
  const assignGuard = async (positionId: string, guardId: string) => {
    const gid = toId(guardId);
    if (!gid) return;
    if (seatedSet.has(gid)) return;

    setAssigned((prev) => ({ ...prev, [positionId]: gid } as Assigned));
    try {
      await persistSeat(positionId, gid, "drag-drop-assign");
    } catch (err) {
      console.error("Failed to persist assignment:", err);
    }
  };

  const clearGuard = async (positionId: string) => {
    setAssigned((prev) => ({ ...prev, [positionId]: null } as Assigned));
    try {
      await apiFetch(`/api/rotations/slot`, {
        method: "POST",
        headers: { "x-api-key": "dev-key-123", "Cache-Control": "no-store" },
        body: JSON.stringify({
          date: dayKey,
          nowISO: simulatedNow.toISOString(),
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
    const gid = toId(guardId);
    if (!gid) return;
    try {
      await apiFetch(`/api/plan/queue-add`, {
        method: "POST",
        headers: { "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: dayKey,
          guardId: gid,
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

  // ---- Queue ops ----
  const flattenBuckets = (b: Record<string, QueueEntry[]>): QueueEntry[] =>
    SECTIONS.flatMap((sec) => b[sec] ?? []);

  const applyBuckets = async (nextBuckets: Record<string, QueueEntry[]>) => {
    const nextFlat = flattenBuckets(nextBuckets).map((q) => ({
      guardId: q.guardId,
      returnTo: q.returnTo,
      enteredTick: q.enteredTick,
    }));
    setBreakQueue(deduplicateQueue(nextFlat));
    try {
      await persistQueueFlat(nextFlat);
    } catch (err) {
      console.error("queue-set failed; refreshing", err);
      await fetchQueue();
    }
  };

  const handleQueueMove = ({
    guardId,
    fromSec,
    toSec,
    toIndex,
  }: {
    guardId: string;
    fromSec: string;
    fromIndex: number;
    toSec: string;
    toIndex: number;
  }) => {
    const gid = toId(guardId);
    if (!gid) return;

    const next: Record<string, QueueEntry[]> = {};
    for (const [sec, arr] of Object.entries(queuesBySection)) next[sec] = [...(arr ?? [])];

    const src = next[fromSec] ?? [];
    const i = src.findIndex((r) => r.guardId === gid);
    if (i === -1) return;
    const [row] = src.splice(i, 1);

    const dst = next[toSec] ?? [];
    for (let j = dst.length - 1; j >= 0; j--) if (dst[j].guardId === gid) dst.splice(j, 1);
    const idx = Math.max(0, Math.min(toIndex, dst.length));
    dst.splice(idx, 0, { ...row, guardId: gid, returnTo: toSec });

    next[fromSec] = src;
    next[toSec] = dst;

    void applyBuckets(next);
  };

  const handleExternalToQueue = async (
    {
      guardId,
      source,
      sec,
      index,
    }: { guardId: string; source: "bench" | "seat" | ""; sec: string; index: number },
    e: React.DragEvent
  ) => {
    const gid = toId(guardId);
    if (!gid) return;
    const currentTick = Math.floor(Date.parse(simulatedNow.toISOString()) / (15 * 1000 * 60));

    const next: Record<string, QueueEntry[]> = {};
    for (const [s, arr] of Object.entries(queuesBySection)) next[s] = [...(arr ?? [])];

    const alreadyQueued = Object.values(next).some((arr) => (arr ?? []).some((r) => r.guardId === gid));
    if (alreadyQueued) return;

    for (const s of Object.keys(next)) next[s] = (next[s] ?? []).filter((r) => r.guardId !== gid);

    const row: QueueEntry = { guardId: gid, returnTo: sec, enteredTick: currentTick };
    const dst = next[sec] ?? [];
    const idx = Math.max(0, Math.min(index, dst.length));
    dst.splice(idx, 0, row);
    next[sec] = dst;

    if (source === "seat") {
      const seatId = e.dataTransfer.getData("application/x-seat-id") || findSeatByGuard(gid);
      if (seatId) {
        setAssigned((prev) => ({ ...prev, [seatId]: null } as Assigned));
        try {
          await apiFetch(`/api/rotations/slot`, {
            method: "POST",
            headers: { "x-api-key": "dev-key-123", "Cache-Control": "no-store" },
            cache: "no-store" as RequestCache,
            body: JSON.stringify({
              date: dayKey,
              nowISO: simulatedNow.toISOString(),
              stationId: seatId,
              guardId: null,
              notes: "queue-drop-from-seat",
            }),
          });
        } catch (err) {
          console.error("clear seat on external->queue failed", err);
        }
      }
    }

    void applyBuckets(next);
  };

  const handleQueueDrop = async (sectionId: string, guardId: string) => {
    const gid = toId(guardId);
    if (!gid) return;
    if (!onDutyIds.has(gid)) setOnDutyIds((prev) => new Set([...prev, gid]));

    const next: Record<string, QueueEntry[]> = {};
    for (const [sec, arr] of Object.entries(queuesBySection)) next[sec] = [...(arr ?? [])];

    if (Object.values(next).some((arr) => (arr ?? []).some((qq: QueueEntry) => qq.guardId === gid))) return;

    const enteredTick = Math.floor(Date.parse(simulatedNow.toISOString()) / (15 * 1000 * 60));
    (next[sectionId] ??= []).push({ guardId: gid, returnTo: sectionId, enteredTick });

    await applyBuckets(next);
  };

  const handleBenchDrop = async (guardId: string, e: React.DragEvent) => {
    const gid = toId(guardId);
    if (!gid) return;

    const src = e.dataTransfer.getData("application/x-source");

    if (src === "seat") {
      const seatId = e.dataTransfer.getData("application/x-seat-id") || findSeatByGuard(gid);
      if (seatId) await clearGuard(seatId);
    }

    if (src === "queue") {
      const next: Record<string, QueueEntry[]> = {};
      for (const [sec, arr] of Object.entries(queuesBySection)) {
        next[sec] = (arr ?? []).filter((qq: QueueEntry) => qq.guardId !== gid);
      }
      await applyBuckets(next);
    }

    setOnDutyIds((prev) => (prev.has(gid) ? prev : new Set([...prev, gid])));
  };

  const handleSeatDrop = async (destSeatId: string, guardId: string) => {
    const gid = toId(guardId);
    if (!gid) return;
    if (!onDutyIds.has(gid)) {
      alert("Only on-duty guards can be seated.");
      return;
    }

    const fromSeatId = findSeatByGuard(gid);
    const destOccupant = (assigned[destSeatId] ?? null) as string | null;
    if (fromSeatId === destSeatId) return;

    if (fromSeatId) {
      setAssigned((prev) => {
        const next: Assigned = { ...prev };
        next[destSeatId] = gid;
        next[fromSeatId] = destOccupant ?? null;
        return next;
      });
      try {
        await Promise.all([
          persistSeat(destSeatId, gid, "drag-seat-move"),
          persistSeat(fromSeatId, destOccupant ? String(destOccupant) : null, "drag-seat-swap"),
        ]);
      } catch (e) {
        console.error("Swap persist failed:", e);
      }
      return;
    }

    setAssigned((prev) => ({ ...prev, [destSeatId]: gid } as Assigned));
    try {
      await persistSeat(destSeatId, gid, "drag-seat-assign");
    } catch (e) {
      console.error("Assign persist failed:", e);
    }
  };

  // ---------- Rotation step ----------
  const plus15Minutes = async () => {
    if (rotatingRef.current) return;
    rotatingRef.current = true;
    setIsRotatingUI(true);
    try {
      if (guardsDirtyRef.current) await fetchGuards({ silent: true });

      const allowedIds = [...onDutyIds].filter((id) => knownIds.has(id) || isUuid(String(id)));

      const newNow = new Date(simulatedNow.getTime() + 15 * 60 * 1000);
      setSimulatedNow(newNow);

      const res = await apiFetch(`/api/plan/rotate`, {
        method: "POST",
        headers: { "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: dayKey,
          nowISO: newNow.toISOString(),
          allowedIds,
          assignedSnapshot: assigned,
        }),
      });
      const data = await res.json();

      // merge assigned: only seats the server mentions
      if (data?.assigned) {
        const updates: Partial<Assigned> = {};
        const inp = data.assigned;

        if (Array.isArray(inp)) {
          for (const it of inp) {
            const seat = String(it?.seat ?? "");
            if (!seat) continue;
            updates[seat] = toId(it?.guard);
          }
        } else if (inp && typeof inp === "object") {
          for (const [seat, raw] of Object.entries(inp)) {
            updates[seat] = toId(raw);
          }
        }
        setAssigned((prev) => ({ ...prev, ...updates } as Assigned));
      }

      if (data?.breaks) setBreaks(data.breaks);
      if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);

      if (Array.isArray(data?.meta?.breakQueue)) {
        const flatSan: QueueEntry[] = asQueueEntriesRaw(data.meta.breakQueue)
          .map((q) => {
            const canon = toId(q.guardId);
            return canon
              ? { guardId: canon, returnTo: String(q.returnTo), enteredTick: q.enteredTick || 0 }
              : null;
          })
          .filter(Boolean) as QueueEntry[];
        setBreakQueue(deduplicateQueue(flatSan));
      } else {
        await fetchQueue();
      }
    } catch (e) {
      console.error("Rotate failed:", e);
      await fetchQueue();
    } finally {
      rotatingRef.current = false;
      setIsRotatingUI(false);
    }
  };

  // Clears queues both server- and client-side
  const handleClearQueues = async () => {
    try {
      await apiFetch(`/api/plan/queue-clear`, {
        method: "POST",
        headers: { "x-api-key": "dev-key-123" },
        body: JSON.stringify({ date: dayKey }),
      });
    } catch (e) {
      console.error("Failed to clear queues:", e);
    } finally {
      setBreakQueue([]);
    }
  };

const handleReset = async () => {
  try {
    // 1️⃣ Clear all local/session storage
    localStorage.clear();
    sessionStorage.clear();

    // 2️⃣ Clear service-worker caches
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }

    // 3️⃣ Unregister any service workers
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
    }
  } catch (err) {
    console.warn('Full site-data clear failed:', err);
  } finally {
    // 4️⃣ Hard reload (forces fresh JS, CSS, API_BASE, etc.)
    const { origin, pathname } = window.location;
    window.location.replace(`${origin}${pathname}?r=${Date.now()}`);
  }
};


  const autopopulate = async () => {
    setIsAutofilling(true);
    try {
      if (guardsDirtyRef.current) await fetchGuards({ silent: true });

      const allowedIds = [...onDutyIds].filter((id) => knownIds.has(id) || isUuid(String(id)));
      if (allowedIds.length === 0) {
        alert("Select at least one on-duty guard before Autopopulate.");
        return;
      }

      const lockedQueueIds = Array.from(new Set(breakQueue.map((q) => q.guardId))).filter(
        (id) => knownIds.has(id) || isUuid(String(id))
      );

      const res = await apiFetch(`/api/plan/autopopulate`, {
        method: "POST",
        headers: { "x-api-key": "dev-key-123" },
        body: JSON.stringify({
          date: dayKey,
          nowISO: simulatedNow.toISOString(),
          allowedIds,
          assignedSnapshot: assigned,
          lockedQueueIds,
        }),
      });

      const data = await res.json();

      if (data?.assigned) {
        const updates: Partial<Assigned> = {};
        const inp = data.assigned;

        if (Array.isArray(inp)) {
          for (const it of inp) {
            const seat = String(it?.seat ?? "");
            if (!seat) continue;
            updates[seat] = toId(it?.guard);
          }
        } else if (inp && typeof inp === "object") {
          for (const [seat, raw] of Object.entries(inp)) {
            updates[seat] = toId(raw);
          }
        }
        setAssigned((prev) => ({ ...prev, ...updates } as Assigned));
      }

      if (data?.breaks) setBreaks(data.breaks);
      if (Array.isArray(data?.conflicts)) setConflicts(data.conflicts);

      if (Array.isArray(data?.meta?.breakQueue)) {
        const normalized: QueueEntry[] = asQueueEntriesRaw(data.meta.breakQueue)
          .map((q) => {
            const canon = toId(q.guardId);
            return canon
              ? { guardId: canon, returnTo: String(q.returnTo), enteredTick: q.enteredTick || 0 }
              : null;
          })
          .filter(Boolean) as QueueEntry[];
        setBreakQueue(deduplicateQueue(normalized));
      } else {
        await fetchQueue();
      }
    } catch (e) {
      console.error("Autopopulate failed:", e);
    } finally {
      setIsAutofilling(false);
    }
  };

  // util to compute age
  const calcAge = (dob?: string | null): number | null => {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
  };

  // set of guard IDs who are 15 or younger (for underline styling in PoolMap)
  const minor15Ids = useMemo(() => {
    const s = new Set<string>();
    for (const g of guards) {
      const a = calcAge(g.dob ?? null);
      if (a !== null && a <= 15) s.add(g.id);
    }
    return s;
  }, [guards]);

  // -------- Render --------
  return (
    <AppShell title="Lifeguard Rotation Manager">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px_360px] gap-6 items-start">
        {/* LEFT: Clock + Pool map */}
        <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
          <div className="mb-3 grid place-items-center">
            <SimClock now={simulatedNow} onRotate={plus15Minutes} disabled={rotatingRef.current} />
          </div>

          <PoolMap
            className="w-full h-[70vh] lg:h-[82vh]"
            guards={guards}
            assigned={assigned}
            onPick={(positionId) => setPickerFor(positionId)}
            onClear={clearGuard}
            conflicts={conflicts}
            onSeatDrop={handleSeatDrop}
            minorIds={minor15Ids}
          />
        </section>

        {/* MIDDLE: Toolbar + Break Queue */}
        <aside className="space-y-6 lg:sticky lg:top-4 self-start">
       

          <BreakQueue
            queuesBySection={queuesBySection}
            flatQueue={breakQueue}
            seatedSet={seatedSet}
            guards={guards}
            onClearAll={handleClearQueues}
            onDropGuardToSection={(sec, e) => {
              const gid =
                e.dataTransfer.getData("application/x-guard-id") ||
                e.dataTransfer.getData("text/plain");
              if (!gid) return;
              void handleQueueDrop(sec, gid.trim());
            }}
            onMoveWithinQueue={handleQueueMove}
            onDropExternalToQueue={(payload, e) => handleExternalToQueue(payload, e)}
          />
        </aside>

        {/* RIGHT: On-duty column */}
        <aside className="space-y-4 lg:sticky lg:top-4 self-start">
             <ToolbarActions
            onPlus15={plus15Minutes}
            onAuto={autopopulate}
            onNewGuard={() => setCreateOpen(true)}
            onRefresh={handleReset}
            disabled={rotatingRef.current || (!anyAssigned && totalQueued === 0)}
            stamp={""}
          />
          <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md p-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <button
                className="px-3 py-2 rounded-lg bg-pool-500 hover:bg-pool-400 text-slate-200 text-sm"
                onClick={() => setOnDutyOpen(true)}
              >
                Select On-Duty Guards {guards.length ? `(${guards.length})` : ""}
              </button>
              <p className="text-slate-400 text-sm">
                Selected: <span className="text-slate-200 font-medium">{onDutyIds.size}</span>
              </p>
            </div>
          </section>

          {/* onDutyUnassigned is derived from single canonical queue + seats */}
          <OnDutyBench guards={onDutyUnassigned} onDropGuardToBench={handleBenchDrop} />
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
      {loading && !isRotatingUI && !isAutofilling && <StandardLoading />}
      {isRotatingUI && <RotationLoading />}
      {isAutofilling && <AutofillLoading />}
    </AppShell>
  );
}

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

  const normName = (s: unknown) =>
    String(s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const sorted = useMemo(
    () => [...guards].sort((a, b) => normName(a.name).localeCompare(normName(b.name))),
    [guards]
  );

  const filtered = useMemo(() => {
    const q = normName(query);
    if (!q) return sorted;
    const tokens = q.split(/\s+/).filter(Boolean);
    return sorted.filter((g) => {
      const hay = normName(g.name);
      return tokens.every((t) => hay.includes(t));
    });
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
            Select All
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
                  </div>
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(g.id)}
                      className="h-4 w-4 accent-slate-300"
                    />
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
  guards: { id: string; name: string }[];
  title?: string;
  onDropGuardToBench: (guardId: string, e: React.DragEvent) => void;
}) {
  const [zoneActive, setZoneActive] = useState(false);
  const [_dragDepth, setDragDepth] = useState(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth((d) => d + 1);
    setZoneActive(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth((d) => {
      const next = d - 1;
      if (next <= 0) {
        setZoneActive(false);
        return 0;
      }
      return next;
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const gid =
      e.dataTransfer.getData("application/x-guard-id") ||
      e.dataTransfer.getData("text/plain");
    setZoneActive(false);
    setDragDepth(0);
    if (!gid) return;
    onDropGuardToBench(gid.trim(), e);
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/70 shadow-md">
      <header className="p-4 border-b border-slate-700 flex items-center justify-between">
        <h3 className="text-slate-100 font-semibold">{title}</h3>
        <span className="text-xs text-slate-400">{guards.length}</span>
      </header>

      <div
        className={[
          "m-3 rounded-xl border-2 border-dashed px-3 py-4 text-sm transition-colors",
          zoneActive
            ? "border-sky-400 bg-sky-400/10 text-sky-200"
            : "border-slate-600 bg-slate-800/30 text-slate-300",
        ].join(" ")}
        role="button"
        aria-label="Drop here to send a guard to the bench"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center justify-center gap-2 pointer-events-none select-none">
          <svg width="16" height="16" viewBox="0 0 24 24" className="shrink-0">
            <path
              d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Drop guards here</span>
        </div>
      </div>

      <div className="p-3 pt-0">
        {guards.length === 0 ? (
          <p className="text-sm text-slate-400 px-1 py-2">No on-duty guards waiting.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {guards.map((g) => (
              <li
                key={g.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
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
    <div className="relative w-full max-w-xs">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl bg-pool-500/10 blur-xl opacity-20"
      />
      <div className="flex items-center justify-between gap-4">
        <div
          className="text-5xl md:text-4xl font-extrabold text-slate-100 leading-none drop-shadow-sm"
          aria-live="polite"
        >
          {timeStr}
        </div>
        <button
          onClick={onRotate}
          disabled={disabled}
          className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-pool-500 hover:bg-pool-400 active:bg-pool-400 text-slate-900 text-lg font-semibold
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-pool-300
                   disabled:opacity-60 disabled:cursor-not-allowed"
          title="Advance 15 minutes"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 5v4l3-3M21 12a9 9 0 10-3.3 6.9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          +15 min
        </button>
      </div>
    </div>
  );
}
