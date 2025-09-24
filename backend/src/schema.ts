import { z } from "zod";

export const GuardCreate = z.object({
  name: z.string().min(1),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "DOB must be YYYY-MM-DD"),
});
export type GuardCreate = z.infer<typeof GuardCreate>;

export const RotationSlot = z.object({
  date: z.string(),          // "YYYY-MM-DD"
  time: z.string(),          // "HH:MM"
  stationId: z.string(),
  guardId: z.string().nullable().optional(), // <- allow null
  notes: z.string().optional(),
});
export type RotationSlot = z.infer<typeof RotationSlot>;
