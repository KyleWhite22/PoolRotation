// src/lib/api.ts
const API_BASE =
  location.hostname.includes("localhost")
    ? "http://localhost:3000"
    : "https://4hwaj6eh6g.execute-api.us-east-1.amazonaws.com"; // your API Gateway

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json() as Promise<T>;
}

const get = <T>(path: string, init?: RequestInit) =>
  fetch(`${API_BASE}${path}`, { credentials: "include", ...init }).then(j<T>);

const post = <T>(path: string, body?: unknown, init?: RequestInit) =>
  fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
    ...init,
  }).then(j<T>);

export const api = {
  // guards router (mounted at /api/guards)
  guards:   () => get("/api/guards"),

  // rotation router
  day:      (day: string) => get(`/api/rotations/day/${day}`),
  slot:     (body: any)   => post("/api/rotations/slot", body),

  // plan router (mounted at /api) — NOTE: no /plan in the path
  queueGet: (day: string) => get(`/api/queue?date=${encodeURIComponent(day)}`),
  queueAdd: (body: any)   => post("/api/queue-add", body),
  queueClr: (day: string) => post("/api/queue-clear", { date: day }),
  rotate:   (body: any)   => post("/api/rotate", body),
  auto:     (body: any)   => post("/api/autopopulate", body),
};
