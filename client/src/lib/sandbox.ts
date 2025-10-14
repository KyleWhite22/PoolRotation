// src/lib/sandbox.ts
const KEY = "rotation:instanceId";

export function getInstanceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
  } catch {}

  const id =
    (globalThis.crypto?.randomUUID?.() as string | undefined) ||
    `${Date.now()}-${Math.random()}`.replace(/[^a-zA-Z0-9-]/g, "");
  try { localStorage.setItem(KEY, id); } catch {}
  return id;
}
