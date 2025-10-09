import { z } from "zod";

/** -------------------- Shared helpers -------------------- */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const stripGuardPrefix = (v: unknown) =>
  typeof v === "string" ? v.replace(/^GUARD#/, "") : v;

const toNullIfBlank = (v: unknown) => {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
};

const DobNullable = z.preprocess(
  toNullIfBlank,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "DOB must be YYYY-MM-DD").nullable()
);

const PhoneNullable = z.preprocess(toNullIfBlank, z.string().nullable());

/** Accepts a guard identifier coming from the client.
 *  - Strips "GUARD#" if present
 *  - Requires non-empty string (we’ll map names→IDs in the route layer)
 */
export const GuardIdLike = z.preprocess(
  stripGuardPrefix,
  z.string().trim().min(1, "guardId is required")
);

/** Section “3”, Seat “3.2” */
export const SectionId = z.string().regex(/^\d+$/, "Section must be like '3'");
export const SeatId = z.string().regex(/^\d+\.\d+$/, "Seat must be like '3.2'");

/** Date/time inputs */
export const DateYMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
export const ISODateTime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), "nowISO must be a valid ISO datetime");

/** -------------------- Guards -------------------- */

export const GuardCreate = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .refine((s) => !s.startsWith("GUARD#"), "Name cannot start with 'GUARD#'")
    .refine((s) => !UUID_RE.test(s), "Name cannot be a UUID")
    .transform((s) => s.replace(/\s+/g, " ")), // collapse inner whitespace
  dob: DobNullable.optional(), // ""/null/undefined -> null; else YYYY-MM-DD
  phone: PhoneNullable.optional(),
});
export type GuardCreate = z.infer<typeof GuardCreate>;

export const GuardUpdate = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .refine((s) => !s.startsWith("GUARD#"), "Name cannot start with 'GUARD#'")
    .refine((s) => !UUID_RE.test(s), "Name cannot be a UUID")
    .transform((s) => s.replace(/\s+/g, " "))
    .optional(),
  dob: DobNullable.optional(),
  phone: PhoneNullable.optional(),
});
export type GuardUpdate = z.infer<typeof GuardUpdate>;

/** -------------------- Queues & Rotation bodies -------------------- */

/** Single queue row from the client; tick optional (server clamps/preserves). */
export const QueueRowIn = z.object({
  guardId: GuardIdLike,
  returnTo: SectionId, // must be a section (e.g. "3"), not a seat ("3.2")
  enteredTick: z.number().int().nonnegative().optional(),
});
export type QueueRowIn = z.infer<typeof QueueRowIn>;

/** queue-set body:
 *  - either an array of rows
 *  - or a record { "1": QueueRowIn[], "2": QueueRowIn[], ... }
 */
export const QueueSetBody = z.object({
  date: DateYMD,
  nowISO: ISODateTime.optional(),
  queue: z.union([
    z.array(QueueRowIn),
    z.record(SectionId, z.array(QueueRowIn)),
  ]),
});
export type QueueSetBody = z.infer<typeof QueueSetBody>;

export const QueueAddBody = z.object({
  date: DateYMD,
  guardId: GuardIdLike,
  returnTo: SectionId,
  nowISO: ISODateTime.optional(),
});
export type QueueAddBody = z.infer<typeof QueueAddBody>;

/** rotate body: client may send a snapshot (seatId -> guardIdOrName|null) */
export const RotateBody = z.object({
  date: DateYMD,
  nowISO: ISODateTime.optional(),
  assignedSnapshot: z
    .record(SeatId, z.union([GuardIdLike, z.null()]))
    .optional(),
});
export type RotateBody = z.infer<typeof RotateBody>;

/** autopopulate body: optional allowedIds + optional assignedSnapshot */
export const AutopopulateBody = z.object({
  date: DateYMD,
  nowISO: ISODateTime.optional(),
  allowedIds: z.array(GuardIdLike).optional(),
  assignedSnapshot: z
    .record(SeatId, z.union([GuardIdLike, z.null()]))
    .optional(),
});
export type AutopopulateBody = z.infer<typeof AutopopulateBody>;
