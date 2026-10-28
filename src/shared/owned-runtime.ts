import { z } from "zod";

/** Executable identity for Mission-owned code, never an arbitrary command or argv. */
export const OwnedRuntimeContextSchema = z.object({
  executable: z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/),
  kind: z.enum(["node", "electron"]),
}).strict();
export type OwnedRuntimeContext = z.infer<typeof OwnedRuntimeContextSchema>;
