// src/lib/api.ts
const API_BASE =
  location.hostname.includes("localhost")
    ? "http://localhost:3000"
    : "https://4hwaj6eh6g.execute-api.us-east-1.amazonaws.com"; // API Gateway

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

const get  = <T>(p: string) => fetch(`${API_BASE}${p}`, { credentials: "include" }).then(asJson<T>);
const post = <T>(p: string, body?: unknown) =>
  fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  }).then(asJson<T>);

export const api = {
  guards:   () => get("/api/guards"),
  day:      (day: string) => get(`/api/rotations/day/${day}`),
  slot:     (body: any)   => post("/api/rotations/slot", body),

  // plan routes are mounted at /api (no /plan prefix)
  queueGet: (day: string) => get(`/api/queue?date=${encodeURIComponent(day)}`),
  queueAdd: (body: any)   => post("/api/queue-add", body),
  queueClr: (day: string) => post("/api/queue-clear", { date: day }),
  rotate:   (body: any)   => post("/api/rotate", body),
  auto:     (body: any)   => post("/api/autopopulate", body),
};
