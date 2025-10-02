import { z } from "zod";

// Helpers that coerce "", "  ", undefined, null -> null (and trim strings)
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

const PhoneNullable = z.preprocess(
  toNullIfBlank,
  z.string().nullable()
);

export const GuardCreate = z.object({
  name: z.string().trim().min(1, "Name is required"),
  dob: DobNullable.optional(),     // trims; ""/null/undefined -> null; else YYYY-MM-DD
  phone: PhoneNullable.optional(), // trims; ""/null/undefined -> null; else string
});
export type GuardCreate = z.infer<typeof GuardCreate>;

export const GuardUpdate = z.object({
  name: z.string().trim().min(1).optional(),
  dob: DobNullable.optional(),
  phone: PhoneNullable.optional(),
});
export type GuardUpdate = z.infer<typeof GuardUpdate>;
