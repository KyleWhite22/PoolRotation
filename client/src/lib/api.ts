// src/lib/api.ts
const API_BASE =
  location.hostname.includes("localhost")
    ? "http://localhost:3000"
    : "https://4hwaj6eh6g.execute-api.us-east-1.amazonaws.com";

const j = async <T>(r: Response) => {
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
};
const get  = <T>(p: string) => fetch(`${API_BASE}${p}`, { credentials: "include" }).then(j<T>);
const post = <T>(p: string, body?: unknown) =>
  fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  }).then(j<T>);

export const api = {
  guards:   () => get("/api/guards"),
  day:      (day: string) => get(`/api/rotations/day/${day}`),
  slot:     (body: any)   => post("/api/rotations/slot", body),

  // plan is mounted at /api (no /plan prefix)
  queueGet: (day: string) => get(`/api/queue?date=${encodeURIComponent(day)}`),
  queueAdd: (body: any)   => post("/api/queue-add", body),
  queueClr: (day: string) => post("/api/queue-clear", { date: day }),
  rotate:   (body: any)   => post("/api/rotate", body),
  auto:     (body: any)   => post("/api/autopopulate", body),
};
