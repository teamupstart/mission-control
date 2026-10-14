import { z } from "zod";

/** Versioned independently of publication authority. Phase 2 extends this policy union. */
const RepositoryPlanPolicySchema = z.object({
  storage: z.literal("repository"),
  commitPlanHtml: z.boolean(),
}).strict();
export const ManagedPlanPolicySchema = z.discriminatedUnion("storage", [
  RepositoryPlanPolicySchema,
  z.object({ version: z.literal(2), storage: z.literal("local"), commitPlanHtml: z.boolean() }).strict(),
]);
export type ManagedPlanPolicy = z.infer<typeof ManagedPlanPolicySchema>;
export const PlanIdentitySchema = z.object({
  repoKey: z.string().regex(/^[a-f0-9]{64}$/),
  planId: z.string().uuid(),
  revision: z.number().int().positive(),
}).strict();
export type PlanIdentity = z.infer<typeof PlanIdentitySchema>;
export const TaskPlanInputSchema = PlanIdentitySchema.extend({
  files: z.array(z.string().max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/)).min(1).max(32),
}).strict();
export const TaskPlanInputsSchema = z.array(TaskPlanInputSchema).max(16);
export type TaskPlanInput = z.infer<typeof TaskPlanInputSchema>;
export const PlanReviewInputSchema = z.object({
  repoSlot: z.string().regex(/^repo-\d{2,}$/).default("repo-01"),
  planId: z.string().uuid(), revision: z.number().int().positive(),
}).strict();
export const PLAN_APPROVAL_DECISION = "approve-final-bundle";
export const PLAN_APPROVAL_OPTION = "approve";
export const PlanPublicationReceiptSchema = PlanIdentitySchema.extend({
  version: z.literal(2), storage: z.literal("local"),
  id: z.string().uuid(), reviewId: z.string().min(1), sessionId: z.string().min(1),
  taskId: z.string().min(1), episodeId: z.string().nullable(),
  bindingId: z.string().nullable(), workflowVersionId: z.string().nullable(), submissionId: z.string().nullable(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/), publishedAt: z.number().int().positive(),
}).strict().refine((receipt) => receipt.bindingId === null
  ? receipt.workflowVersionId === null && receipt.submissionId === null
  : receipt.workflowVersionId !== null && receipt.submissionId !== null, "Incomplete validation receipt");
export type PlanPublicationReceipt = z.infer<typeof PlanPublicationReceiptSchema>;
export interface PlanReadiness {
  version: 2;
  state: "saved" | "approved" | "waiting-workflow" | "published" | "blocked";
  reason: string;
  receipt: PlanPublicationReceipt | null;
}
export const PLAN_CONTENT_LIMITS = { files: 64, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 } as const;
export const PlanFileNameSchema = z.string().max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(md|html|txt|css|svg)$/);
export const PlanSlotSchema = z.string().regex(/^repo-\d{2,}$/).default("repo-01");
export const PlanCatalogCursorSchema = z.string().uuid();
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
  cursor: PlanCatalogCursorSchema.optional(),
}).strict().refine((v) => (!v.planId && !v.revision && !v.file) || (v.planId && v.revision && !v.cursor), "Read an exact plan and revision, or omit both for the catalog; cursors are for catalog pages only");
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
  readiness?: PlanReadiness;
}
export interface ManagedPlanCatalog {
  plans: ManagedPlanRevision[];
  nextCursor: string | null;
}
export const managedPlanPreview = (id: string, revision: number): string => `/?plan=${id}&revision=${revision}`;
