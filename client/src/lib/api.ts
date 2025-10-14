// src/lib/api.ts
import { getInstanceId } from "./sandbox";

const API_BASE =
  location.hostname.includes("localhost")
    ? "http://localhost:3000"
    : "https://4hwaj6eh6g.execute-api.us-east-1.amazonaws.com";

console.log("[api] API_BASE =", API_BASE);
(window as any).__API_BASE = API_BASE;

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json() as Promise<T>;
}

// ❌ remove credentials: "include" so CORS doesn’t require ACA-Credentials
const get = <T>(path: string) =>
  fetch(`${API_BASE}${path}`, { mode: "cors", cache: "no-store" }).then(asJson<T>);

const post = <T>(path: string, body?: unknown) =>
  fetch(`${API_BASE}${path}`, {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(asJson<T>);

export const api = {
  guards: async () => {
    const data: any = await get<any>("/api/guards");
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.data))  return data.data;
    return [];
  },
  day:  (day: string) => get(`/api/rotations/day/${encodeURIComponent(day)}`),
  slot: (body: any)   => post("/api/rotations/slot", body),

  // plan routes (no /plan prefix)
  queueGet: (day: string) => get(`/api/queue?date=${encodeURIComponent(day)}`),
  queueAdd: (body: any)   => post("/api/queue-add", body),
queueClr: (day: string) => post("/api/queue-clear", { date: day }),
  rotate:   (body: any)   => post("/api/rotate", body),
  auto:     (body: any)   => post("/api/autopopulate", body),
};

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  headers.set("X-Rotation-Instance", getInstanceId());

  return fetch(`${API_BASE}${path}`, {
    ...init,
    mode: "cors",
    cache: "no-store",
    headers,
    // no credentials unless you’ve enabled ACA-Credentials on the server & API GW
  });
}
