import { z } from "zod";

export const GuardCreate = z.object({
  name: z.string().min(1),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "DOB must be YYYY-MM-DD"),
});
export type GuardCreate = z.infer<typeof GuardCreate>;

export const RotationSlot = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  stationId: z.string().min(1),
  guardId: z.string().min(1),
  notes: z.string().optional(),
});
export type RotationSlot = z.infer<typeof RotationSlot>;
