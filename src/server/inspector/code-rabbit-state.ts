import { z } from "zod";

const FindingSchema = z.object({
  id: z.string(), rootId: z.string(), url: z.string(), path: z.string().nullable(),
  identity: z.string(), resolved: z.boolean(), generation: z.number().int().nonnegative(),
  present: z.boolean(),
});
export const CodeRabbitRecordSchema = z.object({
  version: z.literal(1),
  observationId: z.string(), processId: z.string(),
  observedAt: z.number(), headSha: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  draft: z.boolean(), error: z.string().nullable(),
  findings: z.array(FindingSchema).max(2000),
  receipts: z.array(z.object({
    noteKey: z.string(), episodeKey: z.string(), threadId: z.string(), generation: z.number(),
    observationId: z.string(), headSha: z.string(),
    claimId: z.string(), at: z.number(), outcome: z.enum(["uncertain", "delivered"]),
  })).max(10000),
});
export type CodeRabbitRecord = z.infer<typeof CodeRabbitRecordSchema>;
