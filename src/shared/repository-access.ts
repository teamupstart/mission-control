import { z } from "zod";
import { RASTER_IMAGE_MIME_TYPES } from "./images.ts";
import { LLM_RUNNER_IDS } from "./llm.ts";
import { PersonaVerdictSchema } from "./protocol.ts";

export const PERSONA_REPOSITORY_ACCESS_MODES = ["none", "read"] as const;
export const DEFAULT_PERSONA_REPOSITORY_ACCESS = "none" as const;
export type PersonaRepositoryAccessMode = (typeof PERSONA_REPOSITORY_ACCESS_MODES)[number];

export const REPOSITORY_OPERATION_IDS = [
  "read",
  "search",
  "glob",
  "git_status",
  "git_diff",
  "git_show",
  "git_log",
  "git_blame",
] as const;
export type RepositoryOperationId = (typeof REPOSITORY_OPERATION_IDS)[number];
export const REPOSITORY_MCP_SERVER_NAME = "repository" as const;

export function repositoryMcpToolName(operation: RepositoryOperationId): string {
  return `mcp__${REPOSITORY_MCP_SERVER_NAME}__${operation}`;
}

export const REPOSITORY_RESULT_STATUSES = [
  "ok",
  "denied",
  "invalid",
  "unavailable",
  "cancelled",
  "failed",
] as const;

export const REPOSITORY_FAILURE_CODES = [
  "path_denied",
  "path_invalid",
  "request_invalid",
  "cursor_invalid",
  "budget_exhausted",
  "response_too_large",
  "deadline_exceeded",
  "cancelled",
  "revision_out_of_range",
  "history_boundary",
  "object_unavailable",
  "audit_unavailable",
  "view_unavailable",
  "provider_unavailable",
  "provider_protocol",
  "internal",
] as const;
export type RepositoryFailureCode = (typeof REPOSITORY_FAILURE_CODES)[number];

export const REPOSITORY_HISTORY_POLICY_V1 = Object.freeze({
  version: 1 as const,
  traversal: "all_parent_breadth_first" as const,
  root: "captured_head" as const,
  maxCommits: 2_048,
  maxIncrementalAllowedBlobBytes: 512 * 1024 * 1024,
  overflow: "stop_before_overflow" as const,
  timestampCutoff: null,
});

export const RepositoryHistoryPolicyV1Schema = z.object({
  version: z.literal(1),
  traversal: z.literal("all_parent_breadth_first"),
  root: z.literal("captured_head"),
  maxCommits: z.literal(REPOSITORY_HISTORY_POLICY_V1.maxCommits),
  maxIncrementalAllowedBlobBytes: z.literal(
    REPOSITORY_HISTORY_POLICY_V1.maxIncrementalAllowedBlobBytes,
  ),
  overflow: z.literal("stop_before_overflow"),
  timestampCutoff: z.null(),
}).strict();
export type RepositoryHistoryPolicyV1 = z.infer<typeof RepositoryHistoryPolicyV1Schema>;

const OpaqueIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const GitObjectIdSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
export const RepositoryEvidenceHandleIdSchema = OpaqueIdSchema.brand<"RepositoryEvidenceHandleId">();
export type RepositoryEvidenceHandleId = z.infer<typeof RepositoryEvidenceHandleIdSchema>;

export const RepositoryLineRangeSchema = z.object({
  kind: z.literal("line"),
  startLine: z.number().int().min(1),
  endLineExclusive: z.number().int().min(1),
}).strict().refine((range) => range.endLineExclusive >= range.startLine, {
  message: "line range end must not precede start",
});

export const RepositoryByteRangeSchema = z.object({
  kind: z.literal("byte"),
  startByte: z.number().int().nonnegative(),
  endByteExclusive: z.number().int().nonnegative(),
  encoding: z.literal("raw"),
}).strict().refine((range) => range.endByteExclusive >= range.startByte, {
  message: "byte range end must not precede start",
});

const DiffSideRangeSchema = z.object({
  startLine: z.number().int().min(1),
  endLineExclusive: z.number().int().min(1),
}).strict().refine((range) => range.endLineExclusive >= range.startLine, {
  message: "diff range end must not precede start",
});

export const RepositoryDiffRangeSchema = z.object({
  kind: z.literal("diff"),
  old: DiffSideRangeSchema,
  new: DiffSideRangeSchema,
}).strict();

export const RepositoryEvidenceRangeSchema = z.union([
  RepositoryLineRangeSchema,
  RepositoryByteRangeSchema,
  RepositoryDiffRangeSchema,
]);
export type RepositoryEvidenceRange = z.infer<typeof RepositoryEvidenceRangeSchema>;

export const RepositoryEvidenceHandleMetadataSchema = z.object({
  handleId: RepositoryEvidenceHandleIdSchema,
  snapshotDigest: Sha256Schema,
  workloadId: OpaqueIdSchema,
  workflowAttemptId: OpaqueIdSchema,
  operationInstanceId: OpaqueIdSchema,
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  itemOrdinal: z.number().int().positive(),
  path: z.string().min(1).max(4_096),
  policyVersion: z.literal(1),
  truncated: z.boolean(),
  range: RepositoryEvidenceRangeSchema,
}).strict();
export type RepositoryEvidenceHandleMetadata = z.infer<
  typeof RepositoryEvidenceHandleMetadataSchema
>;

export const REPOSITORY_DIFF_LAYERS = [
  "head:index",
  "index:worktree",
  "head:worktree",
  "source:worktree",
] as const;

const RepositoryPathSchema = z.string().min(1).max(4_096);
const CursorSchema = z.string().min(16).max(8_192);
const CommonRequest = {
  cursor: CursorSchema.optional(),
};

const ReadWindowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("line"),
    startLine: z.number().int().min(1),
    maxLines: z.number().int().min(1).max(20_000),
  }).strict(),
  z.object({
    kind: z.literal("byte"),
    startByte: z.number().int().nonnegative(),
    maxBytes: z.number().int().min(1).max(1024 * 1024),
  }).strict(),
]);

export const RepositoryToolInputSchemas = {
  read: z.object({
    path: RepositoryPathSchema,
    layer: z.enum(["worktree", "index"]),
    window: ReadWindowSchema,
    ...CommonRequest,
  }).strict(),
  search: z.object({
    literal: z.string().min(1).max(8_192),
    caseSensitive: z.boolean(),
    paths: z.array(RepositoryPathSchema).max(256).default([]),
    globs: z.array(RepositoryPathSchema).max(64).default([]),
    contextLines: z.number().int().min(0).max(10).default(0),
    ...CommonRequest,
  }).strict(),
  glob: z.object({
    pattern: RepositoryPathSchema,
    ...CommonRequest,
  }).strict(),
  git_status: z.object({ ...CommonRequest }).strict(),
  git_diff: z.object({
    layers: z.enum(REPOSITORY_DIFF_LAYERS),
    paths: z.array(RepositoryPathSchema).max(256).default([]),
    ...CommonRequest,
  }).strict(),
  git_show: z.object({
    revision: GitObjectIdSchema,
    patch: z.boolean().default(false),
    paths: z.array(RepositoryPathSchema).max(256).default([]),
    ...CommonRequest,
  }).strict(),
  git_log: z.object({
    revision: GitObjectIdSchema.optional(),
    path: RepositoryPathSchema.optional(),
    limit: z.number().int().min(1).max(500).default(100),
    ...CommonRequest,
  }).strict(),
  git_blame: z.object({
    revision: GitObjectIdSchema,
    path: RepositoryPathSchema,
    startLine: z.number().int().min(1),
    endLineExclusive: z.number().int().min(1),
    ...CommonRequest,
  }).strict(),
} as const satisfies Record<RepositoryOperationId, z.AnyZodObject>;

export const RepositoryOperationRequestSchema = z.union([
  RepositoryToolInputSchemas.read.extend({ operation: z.literal("read") }),
  RepositoryToolInputSchemas.search.extend({ operation: z.literal("search") }),
  RepositoryToolInputSchemas.glob.extend({ operation: z.literal("glob") }),
  RepositoryToolInputSchemas.git_status.extend({ operation: z.literal("git_status") }),
  RepositoryToolInputSchemas.git_diff.extend({ operation: z.literal("git_diff") }),
  RepositoryToolInputSchemas.git_show.extend({ operation: z.literal("git_show") }),
  RepositoryToolInputSchemas.git_log.extend({ operation: z.literal("git_log") }),
  RepositoryToolInputSchemas.git_blame.extend({ operation: z.literal("git_blame") }).refine((request) => request.endLineExclusive >= request.startLine, {
    message: "blame range end must not precede start",
  }).refine((request) => request.endLineExclusive - request.startLine <= 20_000, {
    message: "blame range exceeds the line-window limit",
  }),
]);
export type RepositoryOperationRequest = z.infer<typeof RepositoryOperationRequestSchema>;

const RepositoryResultMetadataSchema = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const RepositoryResultItemCommon = {
  ordinal: z.number().int().positive(),
  metadata: RepositoryResultMetadataSchema.default({}),
};

const RepositoryHandledItemCommon = {
  ...RepositoryResultItemCommon,
  path: RepositoryPathSchema,
  evidenceHandleId: RepositoryEvidenceHandleIdSchema,
};

export const RepositoryResultItemSchema = z.discriminatedUnion("kind", [
  z.object({
    ...RepositoryHandledItemCommon,
    kind: z.literal("text"),
    text: z.string().max(1024 * 1024),
    range: z.union([RepositoryLineRangeSchema, RepositoryByteRangeSchema]),
  }).strict(),
  z.object({
    ...RepositoryResultItemCommon,
    kind: z.literal("path"),
    path: RepositoryPathSchema,
  }).strict(),
  z.object({
    ...RepositoryResultItemCommon,
    kind: z.literal("status"),
    path: RepositoryPathSchema,
  }).strict(),
  z.object({
    ...RepositoryResultItemCommon,
    kind: z.literal("commit"),
    text: z.string().max(1024 * 1024),
  }).strict(),
  z.object({
    ...RepositoryHandledItemCommon,
    kind: z.literal("blame"),
    text: z.string().max(1024 * 1024),
    range: RepositoryLineRangeSchema,
  }).strict(),
  z.object({
    ...RepositoryHandledItemCommon,
    kind: z.literal("diff"),
    text: z.string().max(1024 * 1024),
    range: RepositoryDiffRangeSchema,
  }).strict(),
]);

const RepositoryHistoryBoundarySchema = z.object({
  truncated: z.boolean(),
  frontier: z.array(GitObjectIdSchema).max(4_096),
  omittedParents: z.array(GitObjectIdSchema).max(8_192),
}).strict();

const RepositorySuccessHistoryBoundarySchema = RepositoryHistoryBoundarySchema.extend({
  truncated: z.literal(true),
  omittedParents: z.array(GitObjectIdSchema).min(1).max(8_192),
}).strict();

const RepositoryResultIdentity = {
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  operationInstanceId: OpaqueIdSchema,
};

const RepositorySuccessResult = {
  ...RepositoryResultIdentity,
  status: z.literal("ok"),
  code: z.null(),
  message: z.null(),
  items: z.array(RepositoryResultItemSchema).max(10_000),
  byteCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  historyBoundary: RepositorySuccessHistoryBoundarySchema.nullable(),
};

type RepositoryResultItemKind = z.infer<typeof RepositoryResultItemSchema>["kind"];

export const REPOSITORY_SUCCESS_ITEM_KINDS = Object.freeze({
  read: ["text"],
  search: ["text"],
  glob: ["path"],
  git_status: ["status"],
  git_diff: ["diff"],
  git_show: ["commit", "diff"],
  git_log: ["commit"],
  git_blame: ["blame"],
} as const satisfies Record<RepositoryOperationId, readonly RepositoryResultItemKind[]>);

interface RepositorySuccessValidationInput {
  operation: RepositoryOperationId;
  items: Array<z.infer<typeof RepositoryResultItemSchema>>;
  itemCount: number;
  historyBoundary: z.infer<typeof RepositorySuccessHistoryBoundarySchema> | null;
}

function validateRepositorySuccessResult(
  result: RepositorySuccessValidationInput,
  ctx: z.RefinementCtx,
): void {
  if (result.itemCount !== result.items.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["itemCount"],
      message: "item count mismatch",
    });
  }
  const allowedKinds: readonly RepositoryResultItemKind[] = REPOSITORY_SUCCESS_ITEM_KINDS[result.operation];
  for (const [index, item] of result.items.entries()) {
    if (!allowedKinds.includes(item.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "kind"],
        message: `${item.kind} items are not valid for ${result.operation}`,
      });
    }
  }
  if ((result.operation === "read" || result.operation === "git_blame") && result.items.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: `${result.operation} returns at most one item`,
    });
  }
  if (result.operation === "search") {
    for (const [index, item] of result.items.entries()) {
      if (item.kind === "text" && item.range.kind !== "line") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "range"],
          message: "search text requires a line range",
        });
      }
    }
  }
  if (result.operation === "git_show" && result.items.length > 0) {
    const itemKinds = new Set(result.items.map((item) => item.kind));
    if (itemKinds.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "git_show cannot mix commit metadata and diff items",
      });
    }
    if (result.items[0]?.kind === "commit" && result.items.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "git_show returns at most one commit metadata item",
      });
    }
  }
  if (result.operation !== "git_log" && result.historyBoundary !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["historyBoundary"],
      message: `history boundaries are not valid for ${result.operation}`,
    });
  }
}

const RepositoryCompleteSuccessResultSchema = z.object({
  ...RepositorySuccessResult,
  truncated: z.literal(false),
  truncationReason: z.null(),
  continuationCursor: z.null(),
}).strict().superRefine(validateRepositorySuccessResult);

const RepositoryTruncatedSuccessResultSchema = z.object({
  ...RepositorySuccessResult,
  truncated: z.literal(true),
  truncationReason: z.enum(["bytes", "items", "lines", "time", "history"]),
  continuationCursor: CursorSchema,
}).strict().superRefine(validateRepositorySuccessResult);

const RepositoryFailureResultCommon = {
  ...RepositoryResultIdentity,
  message: z.string().min(1).max(1_000),
  items: z.tuple([]),
  byteCount: z.literal(0),
  itemCount: z.literal(0),
  truncated: z.literal(false),
  truncationReason: z.null(),
  continuationCursor: z.null(),
};

const RepositoryDeniedResultSchema = z.object({
  ...RepositoryFailureResultCommon,
  status: z.literal("denied"),
  code: z.literal("path_denied"),
  historyBoundary: z.null(),
}).strict();

const RepositoryInvalidResultSchema = z.object({
  ...RepositoryFailureResultCommon,
  status: z.literal("invalid"),
  code: z.enum(["path_invalid", "request_invalid", "cursor_invalid"]),
  historyBoundary: z.null(),
}).strict();

const RepositoryCancelledResultSchema = z.object({
  ...RepositoryFailureResultCommon,
  status: z.literal("cancelled"),
  code: z.enum(["cancelled", "deadline_exceeded"]),
  historyBoundary: z.null(),
}).strict();

const RepositoryUnavailableResultSchema = z.object({
  ...RepositoryFailureResultCommon,
  status: z.literal("unavailable"),
  code: z.enum([
    "budget_exhausted",
    "response_too_large",
    "revision_out_of_range",
    "object_unavailable",
    "audit_unavailable",
    "view_unavailable",
    "provider_unavailable",
  ]),
  historyBoundary: z.null(),
}).strict();

const RepositoryFailedResultSchema = z.object({
  ...RepositoryFailureResultCommon,
  status: z.literal("failed"),
  code: z.enum(["provider_protocol", "internal"]),
  historyBoundary: z.null(),
}).strict();

const RepositoryHistoryBoundaryFailureResultSchema = z.object({
  ...RepositoryFailureResultCommon,
  status: z.literal("unavailable"),
  code: z.literal("history_boundary"),
  historyBoundary: RepositoryHistoryBoundarySchema,
}).strict();

export const RepositoryOperationResultSchema = z.union([
  RepositoryCompleteSuccessResultSchema,
  RepositoryTruncatedSuccessResultSchema,
  RepositoryDeniedResultSchema,
  RepositoryInvalidResultSchema,
  RepositoryCancelledResultSchema,
  RepositoryUnavailableResultSchema,
  RepositoryFailedResultSchema,
  RepositoryHistoryBoundaryFailureResultSchema,
]);
export type RepositoryOperationResult = z.infer<typeof RepositoryOperationResultSchema>;

export const RepositoryHistoryRevisionSchema = z.object({
  id: GitObjectIdSchema,
  parents: z.array(GitObjectIdSchema).max(64),
  incrementalAllowedBlobBytes: z.number().int().nonnegative(),
}).strict();

export const RepositoryManifestEntrySchema = z.object({
  path: RepositoryPathSchema,
  kind: z.enum(["file", "symlink", "submodule"]),
  addressable: z.boolean(),
  mode: z.number().int().nonnegative(),
  sensitive: z.boolean(),
  worktreePresent: z.boolean(),
  indexObjectId: GitObjectIdSchema.nullable(),
  worktreeObjectId: GitObjectIdSchema.nullable(),
  worktreeObjectSha256: Sha256Schema.nullable(),
  status: z.string().max(64),
}).strict().superRefine((entry, ctx) => {
  const readableWorktreeObject = entry.worktreePresent && entry.kind !== "submodule";
  if (readableWorktreeObject && (!entry.worktreeObjectId || !entry.worktreeObjectSha256)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["worktreeObjectSha256"],
      message: "readable worktree objects require Git and SHA-256 identities",
    });
  }
  if (!entry.worktreePresent && (entry.worktreeObjectId || entry.worktreeObjectSha256)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["worktreeObjectSha256"],
      message: "absent worktree objects cannot carry content identities",
    });
  }
});
export type RepositoryManifestEntry = z.infer<typeof RepositoryManifestEntrySchema>;

export const RepositoryViewDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotDigest: Sha256Schema,
  artifactLocator: OpaqueIdSchema,
  manifestPath: z.string().min(1).max(4_096),
  repositoryRoot: z.string().min(1).max(4_096),
  objectDirectory: z.string().min(1).max(4_096),
  headRevision: GitObjectIdSchema,
  sourceRevision: GitObjectIdSchema.nullable(),
  indexTree: GitObjectIdSchema,
  worktreeTree: GitObjectIdSchema,
  historyPolicy: RepositoryHistoryPolicyV1Schema,
  retainedRevisions: z.array(RepositoryHistoryRevisionSchema).max(
    REPOSITORY_HISTORY_POLICY_V1.maxCommits,
  ),
  frontier: z.array(GitObjectIdSchema).max(4_096),
  omittedParents: z.array(GitObjectIdSchema).max(8_192),
  retainedCommitCount: z.number().int().nonnegative().max(REPOSITORY_HISTORY_POLICY_V1.maxCommits),
  retainedAllowedBlobBytes: z.number().int().nonnegative().max(
    REPOSITORY_HISTORY_POLICY_V1.maxIncrementalAllowedBlobBytes,
  ),
  entries: z.array(RepositoryManifestEntrySchema).max(1_000_000),
}).strict().superRefine((descriptor, ctx) => {
  if (descriptor.retainedCommitCount !== descriptor.retainedRevisions.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retainedCommitCount"], message: "retained revision count mismatch" });
  }
  const total = descriptor.retainedRevisions.reduce(
    (sum, revision) => sum + revision.incrementalAllowedBlobBytes,
    0,
  );
  if (total !== descriptor.retainedAllowedBlobBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["retainedAllowedBlobBytes"], message: "retained byte count mismatch" });
  }
});
export type RepositoryViewDescriptor = z.infer<typeof RepositoryViewDescriptorSchema>;

export const DEFAULT_REPOSITORY_BUDGETS = Object.freeze({
  maxCalls: 128,
  maxAttemptBytes: 32 * 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxAttemptMs: 15 * 60 * 1_000,
  maxItemsPerCall: 2_000,
  maxCallMs: 30_000,
});

export const RepositoryBudgetsSchema = z.object({
  maxCalls: z.number().int().min(1).max(1_024),
  maxAttemptBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
  maxResponseBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  maxAttemptMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000),
  maxItemsPerCall: z.number().int().min(1).max(100_000),
  maxCallMs: z.number().int().min(100).max(10 * 60 * 1_000),
}).strict();
export type RepositoryBudgets = z.infer<typeof RepositoryBudgetsSchema>;

export const RepositoryCursorMetadataSchema = z.object({
  version: z.literal(1),
  snapshotDigest: Sha256Schema,
  policyVersion: z.literal(1),
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  inputHash: Sha256Schema,
  position: z.number().int().nonnegative(),
}).strict();

export const REPOSITORY_EVIDENCE_PROTOCOL = "repository-evidence-v1" as const;
export const PERSONA_HOSTED_SEARCH_MAXIMUM = "cached" as const;

/** Phase 3 must land this dormant reader floor before any repository citation writer. */
export const REPOSITORY_EVIDENCE_COMPATIBILITY_FLOOR = Object.freeze({
  version: 1 as const,
  citationWritersEnabled: false as const,
  refuseNewerDatabaseSchema: true as const,
  preserveRepositoryEvidence: true as const,
});

export const RepositoryEvidenceCompatibilityFloorSchema = z.object({
  version: z.literal(1),
  citationWritersEnabled: z.literal(false),
  refuseNewerDatabaseSchema: z.literal(true),
  preserveRepositoryEvidence: z.literal(true),
}).strict();

export const PersonaWorkloadImageReferenceSchema = z.object({
  id: OpaqueIdSchema,
  mimeType: z.enum(RASTER_IMAGE_MIME_TYPES),
  bytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();
export type PersonaWorkloadImageReference = z.infer<typeof PersonaWorkloadImageReferenceSchema>;

const TextEvidenceSchema = z.object({
  id: OpaqueIdSchema,
  kind: z.enum(["artifact", "command", "submission"]),
  text: z.string().max(4 * 1024 * 1024),
  sha256: Sha256Schema,
}).strict();

export const PersonaWorkloadRequestSchema = z.object({
  schemaVersion: z.literal(1),
  workloadId: OpaqueIdSchema,
  workflowAttemptId: OpaqueIdSchema,
  submissionId: OpaqueIdSchema,
  idempotencyKey: OpaqueIdSchema,
  persona: z.object({
    id: OpaqueIdSchema,
    name: z.string().min(1).max(500),
    description: z.string().max(4_000),
    guidance: z.string().min(1).max(256 * 1024),
  }).strict(),
  provider: z.enum(LLM_RUNNER_IDS),
  model: z.string().min(1).max(500),
  prompt: z.string().min(1).max(8 * 1024 * 1024),
  images: z.array(PersonaWorkloadImageReferenceSchema).max(8),
  textEvidence: z.array(TextEvidenceSchema).max(128),
  artifactLocator: OpaqueIdSchema,
  artifactDigest: Sha256Schema,
  historyPolicy: RepositoryHistoryPolicyV1Schema,
  budgets: RepositoryBudgetsSchema,
  deadline: z.number().int().positive(),
  cancellationGeneration: z.number().int().nonnegative(),
  repositoryEvidenceProtocol: z.literal(REPOSITORY_EVIDENCE_PROTOCOL),
  hostedSearchMaximum: z.literal(PERSONA_HOSTED_SEARCH_MAXIMUM),
  llmCall: z.object({
    callId: OpaqueIdSchema,
    purpose: z.literal("persona_review"),
    attempt: z.number().int().positive(),
  }).strict(),
}).strict();
export type PersonaWorkloadRequest = z.infer<typeof PersonaWorkloadRequestSchema>;

export const RepositoryMaterializationRequestSchema = z.object({
  submissionId: OpaqueIdSchema,
  workloadId: OpaqueIdSchema,
  workflowAttemptId: OpaqueIdSchema,
  artifactLocator: OpaqueIdSchema,
  artifactDigest: Sha256Schema,
}).strict();
export type RepositoryMaterializationRequest = z.infer<
  typeof RepositoryMaterializationRequestSchema
>;

export const RepositoryQueryAuditMetadataSchema = z.object({
  operationInstanceId: OpaqueIdSchema,
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  normalizedInputHash: Sha256Schema,
  status: z.enum(REPOSITORY_RESULT_STATUSES),
  failureCode: z.enum(REPOSITORY_FAILURE_CODES).nullable(),
  byteCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  handles: z.array(RepositoryEvidenceHandleMetadataSchema).max(10_000),
}).strict();
export type RepositoryQueryAuditMetadata = z.infer<typeof RepositoryQueryAuditMetadataSchema>;

const EventBase = {
  workloadId: OpaqueIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.number().int().positive(),
};

export const PersonaWorkloadResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("succeeded"),
    verdict: PersonaVerdictSchema,
    llmCall: z.object({
      callId: OpaqueIdSchema,
      inputBytes: z.number().int().nonnegative(),
      outputBytes: z.number().int().nonnegative(),
      providerUsage: z.record(z.unknown()).nullable(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("failed"),
    code: z.enum(REPOSITORY_FAILURE_CODES),
    message: z.string().min(1).max(4_000),
    retryable: z.boolean(),
    llmCall: z.object({
      callId: OpaqueIdSchema,
      inputBytes: z.number().int().nonnegative(),
      outputBytes: z.number().int().nonnegative(),
      providerUsage: z.record(z.unknown()).nullable(),
    }).strict().nullable(),
  }).strict(),
]);
export type PersonaWorkloadResult = z.infer<typeof PersonaWorkloadResultSchema>;

export const PersonaWorkloadEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...EventBase, kind: z.literal("accepted"), cancellationGeneration: z.number().int().nonnegative() }).strict(),
  z.object({ ...EventBase, kind: z.literal("materialized"), snapshotDigest: Sha256Schema }).strict(),
  z.object({ ...EventBase, kind: z.literal("provider_started"), provider: z.enum(LLM_RUNNER_IDS), model: z.string().min(1).max(500) }).strict(),
  z.object({ ...EventBase, kind: z.literal("repository_query"), audit: RepositoryQueryAuditMetadataSchema }).strict(),
  z.object({ ...EventBase, kind: z.literal("cancel_requested"), generation: z.number().int().nonnegative() }).strict(),
  z.object({ ...EventBase, kind: z.literal("completed"), result: PersonaWorkloadResultSchema }).strict(),
]);
export type PersonaWorkloadEvent = z.infer<typeof PersonaWorkloadEventSchema>;

export const PersonaWorkloadReconciliationSchema = z.object({
  workloadId: OpaqueIdSchema,
  state: z.enum(["unknown", "running", "completed", "cancelled"]),
  lastSequence: z.number().int().nonnegative(),
  cancellationGeneration: z.number().int().nonnegative(),
  terminalResult: PersonaWorkloadResultSchema.nullable(),
  events: z.array(PersonaWorkloadEventSchema).max(10_000),
}).strict();
export type PersonaWorkloadReconciliation = z.infer<
  typeof PersonaWorkloadReconciliationSchema
>;
