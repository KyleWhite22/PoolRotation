// src/lib/api.ts
import { getInstanceId } from "./sandbox";
export type Guard = { id: string; name: string; dob: string | null; phone: string | null };

const API_BASE =
  location.hostname.includes("localhost")
    ? "http://localhost:3000"
    : "https://4hwaj6eh6g.execute-api.us-east-1.amazonaws.com";

console.log("[api] API_BASE =", API_BASE);
(window as any).__API_BASE = API_BASE; // check in console if needed

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json() as Promise<T>;
}

const get = <T>(path: string) =>
  fetch(`${API_BASE}${path}`, { credentials: "include" }).then(asJson<T>);

const post = <T>(path: string, body?: unknown) =>
  fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  }).then(asJson<T>);

export const api = {
  // Guards
  guards: async (): Promise<Guard[]> => {
    const data: any = await get<any>("/api/guards");
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items; // tolerate {items:[]}
    if (Array.isArray(data?.data))  return data.data;  // tolerate {data:[]}
    return [];
  },

  // Rotations
  day:  (day: string) => get(`/api/rotations/day/${encodeURIComponent(day)}`),
  slot: (body: any)   => post("/api/rotations/slot", body),

  // Plan router is mounted at /api (no /plan prefix)
  queueGet: (day: string) => get(`/api/queue?date=${encodeURIComponent(day)}`),
  queueAdd: (body: any)   => post("/api/queue-add", body),
  queueClr: (day: string) => post("/api/queue-clear", { date: day }),
  rotate:   (body: any)   => post("/api/rotate", body),
  auto:     (body: any)   => post("/api/autopopulate", body),
};

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  headers.set("X-Rotation-Instance", getInstanceId()); // ← always sandbox
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}