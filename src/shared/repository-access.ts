import {
  RepositoryPathSchema,
  RepositoryGlobSchema,
  approvedPath,
} from "./repository-policy.ts";
export {
  RepositoryPathSchema,
  RepositoryGlobSchema,
} from "./repository-policy.ts";
import { z } from "zod";
import { boundedRecord } from "./zod-shapes.ts";
import { WORKFLOW_FINDING_REASONS } from "./workflow-reasons.ts";
import { WORKFLOW_EXECUTION_LIMITS } from "./workflow.ts";
import {
  PersonaSnapshotSchema,
  PersonaVerdictSchema,
  WorkflowEvidenceRefSchema,
  WorkflowRequestedChangeSchema,
} from "./protocol.ts";

export const PERSONA_REPOSITORY_ACCESS_MODES = ["none", "read"] as const;
export const PersonaRepositoryAccessSchema = z
  .enum(PERSONA_REPOSITORY_ACCESS_MODES)
  .default("none");
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
export type RepositoryOperation = (typeof REPOSITORY_OPERATION_IDS)[number];
const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const cursor = z.string().max(4096).optional();
const revision = z.union([z.literal("HEAD"), oid]);
export const RepositoryOperationSchemas = {
  read: z.strictObject({
    path: RepositoryPathSchema,
    layer: z.enum(["worktree", "index"]).default("worktree"),
    unit: z.enum(["line", "byte"]).default("line"),
    start: count.default(0),
    length: z.number().int().min(1).max(65536).default(200),
    cursor,
  }),
  search: z.strictObject({
    query: z.string().min(1).max(1000),
    caseSensitive: z.boolean(),
    glob: RepositoryGlobSchema.default("**"),
    context: z.number().int().min(0).max(5).default(0),
    cursor,
  }),
  glob: z.strictObject({ glob: RepositoryGlobSchema.default("**"), cursor }),
  git_status: z.strictObject({
    glob: RepositoryGlobSchema.default("**"),
    cursor,
  }),
  git_diff: z.strictObject({
    pair: z.enum([
      "base_head",
      "head_index",
      "index_worktree",
      "base_worktree",
    ]),
    paths: z.array(RepositoryPathSchema).max(100).optional(),
    cursor,
  }),
  git_show: z.strictObject({
    revision,
    patch: z.boolean().default(false),
    cursor,
  }),
  git_log: z.strictObject({
    revision: revision.default("HEAD"),
    path: RepositoryPathSchema.optional(),
    cursor,
  }),
  git_blame: z
    .strictObject({
      revision,
      path: RepositoryPathSchema,
      startLine: z.number().int().positive(),
      endLineExclusive: z.number().int().positive(),
      cursor,
    })
    .refine(
      (v) =>
        v.endLineExclusive > v.startLine &&
        v.endLineExclusive - v.startLine <= 1000,
    ),
} satisfies Record<RepositoryOperation, z.ZodType>;
export const RepositoryHistoryPolicyV1Schema = z.strictObject({
  version: z.literal(1),
  root: z.literal("captured_head"),
  traversal: z.literal("all_parent_breadth_first"),
  maxCommits: z.literal(2048),
  maxUniqueBlobBytes: z.literal(536870912),
  overflow: z.literal("stop_before_overflow"),
  timestampCutoff: z.null(),
});
export const REPOSITORY_HISTORY_POLICY_V1 =
  RepositoryHistoryPolicyV1Schema.parse({
    version: 1,
    root: "captured_head",
    traversal: "all_parent_breadth_first",
    maxCommits: 2048,
    maxUniqueBlobBytes: 536870912,
    overflow: "stop_before_overflow",
    timestampCutoff: null,
  });
export const RepositoryBudgetsSchema = z.strictObject({
  callBytes: z.number().int().min(4096).max(1048576).default(1048576),
  callItems: z.number().int().min(1).max(1000).default(100),
  callMs: z.number().int().min(1).max(30000).default(10000),
  attemptCalls: z.number().int().min(1).max(128).default(128),
  attemptBytes: z.number().int().min(4096).max(33554432).default(33554432),
  attemptMs: z.number().int().min(1).max(900000).default(900000),
});
export const REPOSITORY_DEFAULT_BUDGETS = RepositoryBudgetsSchema.parse({});
export const RepositoryPolicySchema = z.strictObject({
  version: z.literal(1),
  operations: z.tuple(
    REPOSITORY_OPERATION_IDS.map((v) => z.literal(v)) as [
      z.ZodLiteral<"read">,
      z.ZodLiteral<"search">,
      z.ZodLiteral<"glob">,
      z.ZodLiteral<"git_status">,
      z.ZodLiteral<"git_diff">,
      z.ZodLiteral<"git_show">,
      z.ZodLiteral<"git_log">,
      z.ZodLiteral<"git_blame">,
    ],
  ),
});
const entry = z.strictObject({
  path: RepositoryPathSchema,
  kind: z.enum(["file", "symlink", "submodule"]),
  blob: oid.nullable(),
  binary: z.boolean(),
  classifications: z
    .array(
      z.enum([
        "committed",
        "staged",
        "unstaged",
        "untracked",
        "deleted",
        "sensitive_denied",
      ]),
    )
    .max(6),
});
export const RepositoryViewDescriptorSchema = z
  .strictObject({
    version: z.literal(1),
    snapshotDigest: sha,
    policyVersion: z.literal(1),
    // Opaque lease-local locator. Only the trusted materializer maps this to a directory.
    objectView: id,
    head: oid.nullable(),
    base: oid.nullable(),
    indexTree: oid,
    worktreeTree: oid,
    historyPolicy: RepositoryHistoryPolicyV1Schema,
    retainedRevisions: z
      .array(
        z.strictObject({ id: oid, parents: z.array(oid).max(100), tree: oid }),
      )
      .max(2048),
    frontier: z
      .array(
        z.strictObject({
          revision: oid,
          omittedParents: z.array(oid).max(100),
        }),
      )
      .max(2048),
    retainedCommitCount: count.max(2048),
    retainedBlobBytes: count.max(536870912),
    worktree: z.array(entry).max(200000),
    index: z.array(entry).max(200000),
  })
  .superRefine((v, ctx) => {
    const ids = new Set(v.retainedRevisions.map((r) => r.id));
    if (
      ids.size !== v.retainedRevisions.length ||
      ids.size !== v.retainedCommitCount ||
      (v.head !== null && v.retainedRevisions[0]?.id !== v.head)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid retained revision set",
      });
    if (v.head === null && v.retainedRevisions.length)
      ctx.addIssue({
        code: "custom",
        message: "Unborn view cannot retain history",
      });
    const queue = v.head ? [v.head] : [];
    const visited = new Set<string>();
    let ordinal = 0;
    while (queue.length && ordinal < v.retainedRevisions.length) {
      const next = queue.shift()!;
      if (visited.has(next)) continue;
      visited.add(next);
      const record = v.retainedRevisions[ordinal++];
      if (!record || record.id !== next) {
        ctx.addIssue({
          code: "custom",
          message: "History is not a breadth-first prefix",
        });
        break;
      }
      queue.push(...record.parents);
    }
    if (ordinal !== v.retainedRevisions.length)
      ctx.addIssue({
        code: "custom",
        message: "Retained history contains disconnected revisions",
      });
    const frontier = v.retainedRevisions
      .filter((r) => r.parents.some((p) => !ids.has(p)))
      .map((r) => ({
        revision: r.id,
        omittedParents: r.parents.filter((p) => !ids.has(p)),
      }));
    if (JSON.stringify(frontier) !== JSON.stringify(v.frontier))
      ctx.addIssue({ code: "custom", message: "Invalid history frontier" });
    for (const layer of [v.worktree, v.index]) {
      const names = new Set(layer.map((e) => e.path));
      for (const entry of layer) {
        const parts = entry.path.split("/");
        for (let i = 1; i < parts.length; i++)
          if (names.has(parts.slice(0, i).join("/")))
            ctx.addIssue({
              code: "custom",
              message: "Manifest traverses a leaf entry",
            });
      }
    }
    for (const layer of [v.worktree, v.index])
      if (new Set(layer.map((e) => e.path)).size !== layer.length)
        ctx.addIssue({ code: "custom", message: "Duplicate manifest path" });
  });
export type RepositoryViewDescriptor = z.infer<
  typeof RepositoryViewDescriptorSchema
>;
export const RepositoryRangeSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("line"),
      startLine: count.min(1),
      endLineExclusive: count.min(1),
    })
    .refine((v) => v.endLineExclusive > v.startLine),
  z
    .strictObject({
      kind: z.literal("byte"),
      startByte: count,
      endByteExclusive: count,
      encoding: z.literal("raw"),
    })
    .refine((v) => v.endByteExclusive > v.startByte),
  z
    .strictObject({
      kind: z.literal("diff"),
      oldStartLine: count.min(1),
      oldEndLineExclusive: count.min(1),
      newStartLine: count.min(1),
      newEndLineExclusive: count.min(1),
    })
    .refine(
      (v) =>
        v.oldEndLineExclusive >= v.oldStartLine &&
        v.newEndLineExclusive >= v.newStartLine,
    ),
]);
export const RepositoryEvidenceHandleIdSchema = z.string().uuid();
export const RepositoryEvidenceHandleSchema = z.strictObject({
  evidenceHandleId: RepositoryEvidenceHandleIdSchema,
  snapshotDigest: sha,
  workloadId: id,
  attemptId: id,
  operationId: z.string().uuid(),
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  itemOrdinal: count,
  path: RepositoryPathSchema,
  policyVersion: z.literal(1),
  truncated: z.boolean(),
  range: RepositoryRangeSchema,
});
export type RepositoryEvidenceHandle = z.infer<
  typeof RepositoryEvidenceHandleSchema
>;
export const REPOSITORY_FAILURE_CODES = [
  "invalid_request",
  "denied_path",
  "revision_out_of_range",
  "history_boundary",
  "unavailable",
  "invalid_cursor",
  "budget_exhausted",
  "cancelled",
  "timeout",
  "audit_unavailable",
] as const;
export const RepositoryQueryAuditMetadataSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    workloadId: id,
    attemptId: id,
    snapshotDigest: sha,
    operation: z.enum(REPOSITORY_OPERATION_IDS),
    inputHash: sha,
    status: z.enum(["ok", "denied", "failed", "cancelled"]),
    code: z.enum(REPOSITORY_FAILURE_CODES).nullable(),
    bytes: count,
    items: count.max(1000),
    durationMs: count,
    truncated: z.boolean(),
    handles: z.array(RepositoryEvidenceHandleSchema).max(1000),
  })
  .superRefine((audit, ctx) => {
    const ids = new Set<string>();
    const ordinals = new Set<number>();
    if (audit.status !== "ok" && audit.handles.length)
      ctx.addIssue({
        code: "custom",
        message: "Failed query cannot mint evidence",
      });
    for (const handle of audit.handles) {
      if (
        handle.operationId !== audit.operationId ||
        handle.operation !== audit.operation ||
        handle.snapshotDigest !== audit.snapshotDigest ||
        handle.workloadId !== audit.workloadId ||
        handle.attemptId !== audit.attemptId ||
        handle.truncated !== audit.truncated ||
        handle.itemOrdinal >= audit.items ||
        ids.has(handle.evidenceHandleId) ||
        ordinals.has(handle.itemOrdinal) ||
        !approvedPath(handle.path)
      )
        ctx.addIssue({ code: "custom", message: "Invalid evidence binding" });
      ids.add(handle.evidenceHandleId);
      ordinals.add(handle.itemOrdinal);
    }
  });
export type RepositoryQueryAuditMetadata = z.infer<
  typeof RepositoryQueryAuditMetadataSchema
>;
export const RepositoryCursorMetadataSchema = z.strictObject({
  version: z.literal(1),
  snapshotDigest: sha,
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  inputHash: sha,
  policyVersion: z.literal(1),
  position: count,
});
export const RepositoryResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  operation: z.enum(REPOSITORY_OPERATION_IDS),
  status: z.enum(["ok", "denied", "failed", "cancelled"]),
  code: z.enum(REPOSITORY_FAILURE_CODES).nullable(),
  bytes: count,
  itemCount: count,
  truncated: z.boolean(),
  limit: z.enum(["bytes", "items"]).nullable(),
  nextCursor: z.string().nullable(),
  historyTruncated: z.boolean(),
  items: z
    .array(
      z.strictObject({
        path: RepositoryPathSchema.optional(),
        text: z.string().optional(),
        metadata: boundedRecord(
          z.string().max(100),
          z.union([
            z.string().max(1048576),
            z.number().finite(),
            z.boolean(),
            z.null(),
            z.array(z.string().max(4096)).max(2048),
          ]),
          16,
        ).optional(),
        evidenceHandleId: RepositoryEvidenceHandleIdSchema.optional(),
      }),
    )
    .max(1000),
});
export type RepositoryResult = z.infer<typeof RepositoryResultSchema>;
export const REPOSITORY_EVIDENCE_CAPABILITY = "repository_evidence_v1" as const;
export const PersonaWorkloadRequestSchema = z.strictObject({
  version: z.literal(1),
  workloadId: id,
  attemptId: id,
  submissionId: id,
  idempotencyKey: id,
  persona: PersonaSnapshotSchema,
  accounting: z.strictObject({
    callId: id,
    runId: id,
    purpose: z.literal("persona_review"),
    attempt: count.min(1),
  }),
  execution: z.strictObject({
    provider: z.enum(["claude", "codex"]),
    model: id,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  }),
  prompt: z.string().max(2000000),
  images: z
    .array(
      z.strictObject({
        id,
        path: z.string().min(1),
        mimeType: z.enum([
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
        ]),
        bytes: count,
        sha256: sha,
      }),
    )
    .max(20),
  artifact: z.strictObject({ locator: id, digest: sha }),
  policy: RepositoryPolicySchema,
  budgets: RepositoryBudgetsSchema,
  deadline: count,
  cancellationGeneration: count,
  requiredCapability: z.literal(REPOSITORY_EVIDENCE_CAPABILITY),
});
export type PersonaWorkloadRequest = z.infer<
  typeof PersonaWorkloadRequestSchema
>;
export const RepositoryEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("repository"),
  operationId: z.string().uuid(),
  evidenceHandleId: RepositoryEvidenceHandleIdSchema,
});
// Strict providers express an omitted optional as null. Keep the output contract unchanged.
const wireOptional = <S extends z.ZodType>(schema: S) =>
  schema
    .nullable()
    .transform((value) => (value === null ? undefined : value))
    .optional();
const workloadContextEvidence = z
  .object({
    ...WorkflowEvidenceRefSchema.shape,
    path: wireOptional(WorkflowEvidenceRefSchema.shape.path),
    line: wireOptional(WorkflowEvidenceRefSchema.shape.line),
  })
  .pipe(WorkflowEvidenceRefSchema);
const workloadEvidence = z
  .array(z.union([workloadContextEvidence, RepositoryEvidenceReferenceSchema]))
  .max(WORKFLOW_EXECUTION_LIMITS.verdictEvidence);
export const PersonaWorkloadVerdictSchema = z
  .discriminatedUnion("verdict", [
    PersonaVerdictSchema.options[0].extend({
      approvalDetails:
        PersonaVerdictSchema.options[0].shape.approvalDetails.extend({
          evidence: workloadEvidence,
        }),
    }),
    PersonaVerdictSchema.options[1].extend({
      requestedChanges: z
        .array(
          WorkflowRequestedChangeSchema.extend({
            category: wireOptional(z.enum(WORKFLOW_FINDING_REASONS).optional()),
            basis: wireOptional(WorkflowRequestedChangeSchema.shape.basis),
            path: wireOptional(WorkflowRequestedChangeSchema.shape.path),
            line: wireOptional(WorkflowRequestedChangeSchema.shape.line),
            evidence: workloadEvidence.min(1),
          }),
        )
        .min(1)
        .max(WORKFLOW_EXECUTION_LIMITS.verdictChanges),
    }),
  ])
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      WORKFLOW_EXECUTION_LIMITS.verdictJsonBytes,
    "Persona verdict exceeds its UTF-8 budget",
  );
// Append only: Phase 4 adds inspector_verdict at this discriminator, without a transport bump.
export const PERSONA_WORKLOAD_RESULT_KINDS = ["persona_verdict"] as const;
export const PersonaWorkloadResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    result: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("persona_verdict"),
        verdict: PersonaWorkloadVerdictSchema,
      }),
    ]),
    usage: boundedRecord(
      z.string().max(100),
      z.number().nonnegative().finite(),
      16,
    ),
  }),
  z.strictObject({
    status: z.literal("failed"),
    usage: boundedRecord(
      z.string().max(100),
      z.number().nonnegative().finite(),
      16,
    ).optional(),
    code: z.enum([
      "invalid_request",
      "artifact_unavailable",
      "provider_unavailable",
      "invalid_verdict",
      "audit_unavailable",
      "cancelled",
      "deadline",
      "capability_mismatch",
    ]),
  }),
]);
export type PersonaWorkloadResult = z.infer<typeof PersonaWorkloadResultSchema>;
// Provider APIs require an object root; future result kinds append inside this envelope.
export const PersonaWorkloadProviderResultSchema = z.strictObject({
  result: PersonaWorkloadResultSchema.options[0].shape.result,
});
const eventBase = {
  eventId: z.string().uuid(),
  workloadId: id,
  attemptId: id,
  sequence: count.min(1),
  timestamp: count,
};
export const PersonaWorkloadEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("accepted") }),
  z.strictObject({ ...eventBase, type: z.literal("repository_verified") }),
  z.strictObject({ ...eventBase, type: z.literal("persona_started") }),
  z.strictObject({ ...eventBase, type: z.literal("cancelled") }),
  z.strictObject({
    ...eventBase,
    type: z.literal("repository_query"),
    audit: RepositoryQueryAuditMetadataSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("terminal"),
    result: PersonaWorkloadResultSchema,
  }),
]);
export type PersonaWorkloadEvent = z.infer<typeof PersonaWorkloadEventSchema>;
export const PersonaWorkloadReconciliationSchema = z.strictObject({
  workloadId: id,
  state: z.enum(["unknown", "running", "terminal"]),
  events: z.array(PersonaWorkloadEventSchema).max(134),
});
export type PersonaWorkloadReconciliation = z.infer<
  typeof PersonaWorkloadReconciliationSchema
>;
