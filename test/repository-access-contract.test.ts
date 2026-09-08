import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PERSONA_REPOSITORY_ACCESS,
  PERSONA_HOSTED_SEARCH_MAXIMUM,
  PersonaWorkloadRequestSchema,
  REPOSITORY_EVIDENCE_PROTOCOL,
  REPOSITORY_EVIDENCE_COMPATIBILITY_FLOOR,
  REPOSITORY_HISTORY_POLICY_V1,
  REPOSITORY_OPERATION_IDS,
  RepositoryByteRangeSchema,
  RepositoryDiffRangeSchema,
  RepositoryLineRangeSchema,
  RepositoryOperationResultSchema,
  RepositoryOperationRequestSchema,
} from "../src/shared/repository-access.ts";

test("repository access and operations are closed append-only contracts", () => {
  assert.equal(DEFAULT_PERSONA_REPOSITORY_ACCESS, "none");
  assert.equal(PERSONA_HOSTED_SEARCH_MAXIMUM, "cached");
  assert.deepEqual(REPOSITORY_OPERATION_IDS, ["read", "search", "glob", "git_status", "git_diff", "git_show", "git_log", "git_blame"]);
  assert.equal(REPOSITORY_HISTORY_POLICY_V1.maxCommits, 2_048);
  assert.equal(REPOSITORY_HISTORY_POLICY_V1.maxIncrementalAllowedBlobBytes, 512 * 1024 * 1024);
  assert.deepEqual(REPOSITORY_EVIDENCE_COMPATIBILITY_FLOOR, { version: 1, citationWritersEnabled: false, refuseNewerDatabaseSchema: true, preserveRepositoryEvidence: true });
  assert.equal(RepositoryOperationRequestSchema.safeParse({ operation: "read", path: "x", layer: "worktree", window: { kind: "line", startLine: 1, maxLines: 10 }, argv: ["--all"] }).success, false);
});

test("canonical evidence coordinates accept exact half-open line, byte, and empty-sided diff ranges", () => {
  assert.deepEqual(RepositoryLineRangeSchema.parse({ kind: "line", startLine: 1, endLineExclusive: 3 }), { kind: "line", startLine: 1, endLineExclusive: 3 });
  assert.deepEqual(RepositoryByteRangeSchema.parse({ kind: "byte", startByte: 0, endByteExclusive: 4, encoding: "raw" }), { kind: "byte", startByte: 0, endByteExclusive: 4, encoding: "raw" });
  assert.deepEqual(RepositoryDiffRangeSchema.parse({ kind: "diff", old: { startLine: 2, endLineExclusive: 2 }, new: { startLine: 2, endLineExclusive: 5 } }).old, { startLine: 2, endLineExclusive: 2 });
  assert.equal(RepositoryLineRangeSchema.safeParse({ kind: "line", startLine: 0, endLineExclusive: 1 }).success, false);
  assert.equal(RepositoryByteRangeSchema.safeParse({ kind: "byte", startByte: 4, endByteExclusive: 3, encoding: "raw" }).success, false);
});

test("repository result schemas reject contradictory item and failure states", () => {
  const commonItem = { ordinal: 1, path: "source.txt", metadata: {} };
  const commonResult = {
    operation: "read",
    operationInstanceId: "operation-1",
    byteCount: 0,
    itemCount: 0,
    truncated: false,
    truncationReason: null,
    continuationCursor: null,
    historyBoundary: null,
  };

  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...commonResult,
    status: "ok",
    code: null,
    message: null,
    byteCount: 4,
    itemCount: 1,
    items: [{ ...commonItem, kind: "binary", text: "oops" }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...commonResult,
    status: "ok",
    code: null,
    message: null,
    itemCount: 1,
    items: [{ ...commonItem, kind: "path", base64: "YQ==" }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...commonResult,
    status: "unavailable",
    code: "view_unavailable",
    message: "changed",
    itemCount: 1,
    items: [{ ...commonItem, kind: "path" }],
    truncated: true,
    truncationReason: "items",
    continuationCursor: "cursor-value-that-is-long-enough",
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...commonResult,
    status: "cancelled",
    code: "path_denied",
    message: "contradictory",
    items: [],
  }).success, false);
});

test("repository success schemas enforce operation item, range, and history-boundary variants", () => {
  const success = {
    operationInstanceId: "operation-1",
    status: "ok",
    code: null,
    message: null,
    byteCount: 6,
    itemCount: 1,
    truncated: false,
    truncationReason: null,
    continuationCursor: null,
    historyBoundary: null,
  } as const;
  const items = {
    text: { kind: "text", ordinal: 1, metadata: {}, path: "source.txt", evidenceHandleId: "handle-1", text: "text", range: { kind: "line", startLine: 1, endLineExclusive: 2 } },
    path: { kind: "path", ordinal: 1, metadata: {}, path: "source.txt" },
    status: { kind: "status", ordinal: 1, metadata: {}, path: "source.txt" },
    commit: { kind: "commit", ordinal: 1, metadata: {}, text: "commit" },
    blame: { kind: "blame", ordinal: 1, metadata: {}, path: "source.txt", evidenceHandleId: "handle-1", text: "blame", range: { kind: "line", startLine: 1, endLineExclusive: 2 } },
    diff: { kind: "diff", ordinal: 1, metadata: {}, path: "source.txt", evidenceHandleId: "handle-1", text: "diff", range: { kind: "diff", old: { startLine: 1, endLineExclusive: 2 }, new: { startLine: 1, endLineExclusive: 2 } } },
  } as const;
  const legalKinds = {
    read: ["text"],
    search: ["text"],
    glob: ["path"],
    git_status: ["status"],
    git_diff: ["diff"],
    git_show: ["commit", "diff"],
    git_log: ["commit"],
    git_blame: ["blame"],
  } as const;

  for (const [operation, expectedKinds] of Object.entries(legalKinds)) {
    for (const [kind, item] of Object.entries(items)) {
      assert.equal(
        RepositoryOperationResultSchema.safeParse({ ...success, operation, items: [item] }).success,
        (expectedKinds as readonly string[]).includes(kind),
        `${operation} with ${kind}`,
      );
    }
  }
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "search",
    items: [{ ...items.text, range: { kind: "byte", startByte: 0, endByteExclusive: 4, encoding: "raw" } }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "read",
    items: [{ ...items.text, range: { kind: "byte", startByte: 0, endByteExclusive: 4, encoding: "raw" } }],
  }).success, true);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "read",
    itemCount: 2,
    items: [items.text, { ...items.text, ordinal: 2 }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_show",
    itemCount: 2,
    items: [items.commit, { ...items.diff, ordinal: 2 }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_show",
    itemCount: 2,
    items: [items.diff, { ...items.diff, ordinal: 2 }],
  }).success, true);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_show",
    itemCount: 2,
    items: [items.commit, { ...items.commit, ordinal: 2 }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_blame",
    itemCount: 2,
    items: [items.blame, { ...items.blame, ordinal: 2 }],
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_status",
    items: [{ kind: "status", ordinal: 1, metadata: {}, path: "source.txt" }],
    historyBoundary: { truncated: true, frontier: [], omittedParents: ["a".repeat(40)] },
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_log",
    items: [{ kind: "commit", ordinal: 1, metadata: {}, text: "commit" }],
    historyBoundary: { truncated: true, frontier: [], omittedParents: ["a".repeat(40)] },
  }).success, true);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_log",
    items: [{ kind: "commit", ordinal: 1, metadata: {}, text: "commit" }],
    historyBoundary: { truncated: false, frontier: [], omittedParents: ["a".repeat(40)] },
  }).success, false);
  assert.equal(RepositoryOperationResultSchema.safeParse({
    ...success,
    operation: "git_log",
    items: [{ kind: "commit", ordinal: 1, metadata: {}, text: "commit" }],
    historyBoundary: { truncated: true, frontier: [], omittedParents: [] },
  }).success, false);
});

test("workload requests require submission, workload, attempt, artifact, evidence, image, and call identities", () => {
  const result = PersonaWorkloadRequestSchema.safeParse({
    schemaVersion: 1,
    workloadId: "workload-1",
    workflowAttemptId: "attempt-1",
    submissionId: "submission-1",
    idempotencyKey: "idempotency-1",
    persona: { id: "persona-1", name: "Reviewer", description: "", guidance: "Review" },
    provider: "claude",
    model: "model",
    prompt: "review",
    images: [],
    textEvidence: [],
    artifactLocator: "artifact-1",
    artifactDigest: "a".repeat(64),
    historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
    budgets: { maxCalls: 128, maxAttemptBytes: 32 * 1024 * 1024, maxResponseBytes: 1024 * 1024, maxAttemptMs: 900_000, maxItemsPerCall: 2_000, maxCallMs: 30_000 },
    deadline: Date.now() + 60_000,
    cancellationGeneration: 0,
    repositoryEvidenceProtocol: REPOSITORY_EVIDENCE_PROTOCOL,
    hostedSearchMaximum: PERSONA_HOSTED_SEARCH_MAXIMUM,
    llmCall: { callId: "call-1", purpose: "persona_review", attempt: 1 },
  });
  assert.equal(result.success, true);
  assert.equal(PersonaWorkloadRequestSchema.safeParse({ ...(result.success ? result.data : {}), workflowAttemptId: undefined }).success, false);
  const imageReference = {
    id: "image-1",
    mimeType: "image/png" as const,
    bytes: 128,
    sha256: "b".repeat(64),
  };
  assert.equal(PersonaWorkloadRequestSchema.safeParse({ ...(result.success ? result.data : {}), images: [imageReference] }).success, true);
  assert.equal(PersonaWorkloadRequestSchema.safeParse({
    ...(result.success ? result.data : {}),
    images: [{ ...imageReference, path: "/tmp/caller-controlled.png" }],
  }).success, false);
});
