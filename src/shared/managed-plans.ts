import { z } from "zod";

/** Versioned independently of publication authority. Phase 2 extends this policy union. */
export const ManagedPlanPolicySchema = z.object({
  storage: z.literal("repository"),
  commitPlanHtml: z.boolean(),
}).strict();
export const PLAN_CONTENT_LIMITS = { files: 64, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 } as const;
export const PlanFileNameSchema = z.string().max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(md|html|txt|css|svg)$/);
export const PlanSlotSchema = z.string().regex(/^repo-\d{2,}$/).default("repo-01");
export const PlanContextInputSchema = z.object({ repoSlot: PlanSlotSchema }).strict();
export const SavePlanInputSchema = z.object({
  repoSlot: PlanSlotSchema,
  requestId: z.string().uuid(),
  planId: z.string().uuid().optional(),
  slug: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  expectedRevision: z.number().int().nonnegative(),
  files: z.array(z.object({ name: PlanFileNameSchema, content: z.string().max(PLAN_CONTENT_LIMITS.fileBytes) }).strict()).min(2).max(PLAN_CONTENT_LIMITS.files),
}).strict();
export const ReadPlanInputSchema = z.object({
  repoSlot: PlanSlotSchema,
  planId: z.string().uuid().optional(),
  revision: z.number().int().positive().optional(),
  file: PlanFileNameSchema.optional(),
}).strict().refine((v) => (!v.planId && !v.revision && !v.file) || (v.planId && v.revision), "Read an exact plan and revision, or omit both for the catalog");
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanManifestSchema = z.object({
  version: z.literal(1),
  planId: z.string().uuid(),
  repoKey: DigestSchema,
  slug: SavePlanInputSchema.shape.slug,
  revision: z.number().int().positive(),
  policy: ManagedPlanPolicySchema,
  createdAt: z.number().int(),
  files: z.array(z.object({
    name: PlanFileNameSchema,
    bytes: z.number().int().nonnegative().max(PLAN_CONTENT_LIMITS.fileBytes),
    sha256: DigestSchema,
    source: PlanFileNameSchema.nullable(),
    sourceSha256: DigestSchema.nullable(),
    checkoutPath: z.string().nullable(),
  }).strict()).min(2).max(PLAN_CONTENT_LIMITS.files),
}).strict();
export type PlanManifest = z.infer<typeof PlanManifestSchema>;
export type SavePlanInput = z.infer<typeof SavePlanInputSchema>;
export type ReadPlanInput = z.infer<typeof ReadPlanInputSchema>;
export interface ManagedPlanRevision {
  manifest: PlanManifest;
  preview: string;
  requiredPaths: string[];
}
export const managedPlanPreview = (id: string, revision: number): string => `/?plan=${id}&revision=${revision}`;
