export type Guard = { id: string; name: string; dob: string };
export type Assigned = Record<string, string | null>;
export type QueueEntry = { guardId: string; returnTo: string; enteredTick: number };
export type BreakState = Record<string, string>;
export type ConflictUI = { stationId: string; guardId: string; reason: string };
