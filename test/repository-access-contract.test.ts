import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueHistoryParents,
  MAX_REPOSITORY_VIEW_ENTRIES,
  RepositoryViewDescriptorSchema,
  RepositoryOperationSchemas,
  RepositoryRangeSchema,
  RepositoryQueryAuditMetadataSchema,
  PERSONA_WORKLOAD_RESULT_KINDS,
  PersonaWorkloadResultSchema,
  PersonaRepositoryAccessSchema,
  REPOSITORY_HISTORY_POLICY_V1,
} from "../src/shared/repository-access.ts";
import {
  approvedPath,
  matchesGlob,
  INSPECTOR_DENY_PATHS,
} from "../src/server/workflows/persona-workload/policy.ts";

test("closed access, result kind and history policy remain the Phase 2/4 contracts", () => {
  assert.equal(PersonaRepositoryAccessSchema.parse(undefined), "none");
  assert.deepEqual(PERSONA_WORKLOAD_RESULT_KINDS, ["persona_verdict", "inspector_verdict"]);
  assert.equal(REPOSITORY_HISTORY_POLICY_V1.maxCommits, 2048);
  assert.equal(
    REPOSITORY_HISTORY_POLICY_V1.maxUniqueBlobBytes,
    512 * 1024 * 1024,
  );
  assert.equal(
    PersonaWorkloadResultSchema.safeParse({
      status: "completed",
      result: { kind: "inspector_verdict", verdict: {} },
      usage: {},
    }).success,
    false,
  );
  const inspector = {
    status: "completed", result: { kind: "inspector_verdict", verdict: { summary: "Reviewed", findings: [], resolved: [] } }, usage: {},
  };
  assert.deepEqual(PersonaWorkloadResultSchema.parse(inspector), inspector);
  assert.equal(PersonaWorkloadResultSchema.safeParse({ ...inspector, result: { ...inspector.result, kind: "unknown" } }).success, false);
});
test("status-only deletions accept the union of two independently bounded layers", () => {
  const entries = Array.from({ length: MAX_REPOSITORY_VIEW_ENTRIES + 1 }, (_, i) => ({
    path: "dir/" + i, classifications: ["staged", "deleted"],
  }));
  assert.equal(RepositoryViewDescriptorSchema.shape.statusDeletions.safeParse(entries).success, true);
});
test("history queue preserves discovery order, deduplicates merge parents and stops at the retained limit", () => {
  const queue = ["head"];
  const scheduled = new Set(queue);
  enqueueHistoryParents(queue, scheduled, ["left", "left", "right"], 4);
  enqueueHistoryParents(queue, scheduled, ["right", "base", "outside"], 4);
  enqueueHistoryParents(queue, scheduled, ["another"], 4);
  assert.deepEqual(queue, ["head", "left", "right", "base"]);
  assert.deepEqual([...scheduled], queue);
});
test("every path input rejects traversal and host spellings", () => {
  for (const path of [
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src//a",
    "src/./a",
    "C:/a",
    "a\\b",
    "-option",
    "a\0b",
    "",
  ]) {
    assert.equal(approvedPath(path), false, path);
    const cases = {
      read: { path },
      search: { query: "literal", caseSensitive: true, glob: path },
      glob: { glob: path },
      git_status: { glob: path },
      git_diff: { pair: "base_head", paths: [path] },
      git_log: { path },
      git_blame: { path, revision: "HEAD", startLine: 1, endLineExclusive: 2 },
    };
    for (const [operation, input] of Object.entries(cases))
      assert.equal(
        RepositoryOperationSchemas[
          operation as keyof typeof RepositoryOperationSchemas
        ].safeParse(input).success,
        false,
        operation + ":" + path,
      );
  }
  for (const path of [
    "a/.GiT/config",
    ".env.local",
    "src/CREDENTIALS.json",
    "x/id_rsa",
    "x/.ssh/config",
    "x/test.PEM",
    ".codex/auth.json",
  ])
    assert.equal(approvedPath(path), false, path);
  assert.equal(approvedPath("src/日本語.ts"), true);
  assert.equal(matchesGlob("src/a.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("a.ts", "**/*.ts"), true);
  assert.equal(matchesGlob("a.ts", "src/*"), false);
});
test("ranges are canonical half-open intervals including empty diff sides", () => {
  assert.equal(
    RepositoryRangeSchema.safeParse({
      kind: "line",
      startLine: 0,
      endLineExclusive: 1,
    }).success,
    false,
  );
  assert.equal(
    RepositoryRangeSchema.safeParse({
      kind: "byte",
      startByte: 0,
      endByteExclusive: 1,
      encoding: "raw",
    }).success,
    true,
  );
  assert.equal(
    RepositoryRangeSchema.safeParse({
      kind: "diff",
      oldStartLine: 1,
      oldEndLineExclusive: 1,
      newStartLine: 1,
      newEndLineExclusive: 2,
    }).success,
    true,
  );
  assert.equal(
    RepositoryRangeSchema.safeParse({
      kind: "line",
      startLine: 2,
      endLineExclusive: 1,
    }).success,
    false,
  );
});
test("audit metadata accepts a valid query record and rejects an added quote", () => {
  const audit = RepositoryQueryAuditMetadataSchema.parse({
    operationId: "90d7de2f-f72b-41ad-a17a-b4453366dd16",
    workloadId: "workload",
    attemptId: "attempt",
    snapshotDigest: "a".repeat(64),
    operation: "glob",
    inputHash: "b".repeat(64),
    status: "ok",
    code: null,
    bytes: 128,
    items: 0,
    durationMs: 1,
    truncated: false,
    handles: [],
  });
  assert.equal(
    RepositoryQueryAuditMetadataSchema.safeParse({ ...audit, quote: "secret" }).success,
    false,
  );
});
test("Inspector's historical deny vocabulary is unchanged", () =>
  assert.deepEqual(INSPECTOR_DENY_PATHS, [
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/.git/config",
    "**/.npmrc",
    "**/.netrc",
    "**/credentials*",
    "//Users/*/.aws/**",
    "//Users/*/.ssh/**",
    "//Users/*/.claude/**",
    "//Users/*/.mission-control/**",
  ]));

test("glob wildcards are bounded and cannot trigger regex backtracking", () => {
  assert.equal(matchesGlob("src/deep/a.ts", "src/**/a.?s"), true);
  assert.equal(matchesGlob("src/a.ts", "src/**/a.ts"), true);
  assert.equal(
    matchesGlob("a".repeat(250) + "x", "*a".repeat(120) + "z"),
    false,
  );
  assert.equal(matchesGlob("src/a.ts", "*.ts"), false);
  assert.equal(matchesGlob("日本語.ts", "???.ts"), true);
});

test("retained membership cannot smuggle a disconnected commit behind a valid HEAD", async () => {
  const { RepositoryViewDescriptorSchema } = await import(
    "../src/shared/repository-access.ts"
  );
  const head = "1".repeat(40),
    other = "2".repeat(40),
    tree = "3".repeat(40);
  const view = {
    version: 1,
    snapshotDigest: "a".repeat(64),
    policyVersion: 1,
    objectView: "fixture",
    head,
    base: null,
    indexTree: tree,
    worktreeTree: tree,
    historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
    retainedRevisions: [{ id: head, tree, parents: [] }],
    frontier: [],
    retainedCommitCount: 1,
    retainedBlobBytes: 0,
    worktree: [],
    index: [],
  };
  assert.equal(RepositoryViewDescriptorSchema.safeParse(view).success, true);
  assert.equal(
    RepositoryViewDescriptorSchema.safeParse({
      ...view,
      retainedRevisions: [
        ...view.retainedRevisions,
        { id: other, tree, parents: [] },
      ],
      retainedCommitCount: 2,
    }).success,
    false,
  );
});

test("structured fail verdicts preserve null-as-absent without weakening repository references", async () => {
  const { PersonaWorkloadProviderResultSchema } = await import(
    "../src/shared/repository-access.ts"
  );
  const parsed = PersonaWorkloadProviderResultSchema.parse({
    result: {
      kind: "persona_verdict",
      verdict: {
        verdict: "fail",
        summary: "Fix",
        requestedChanges: [
          {
            category: null,
            basis: null,
            path: null,
            line: null,
            title: "Issue",
            rationale: "Reason",
            evidence: [{ kind: "diff", quote: "line", path: null, line: null }],
          },
        ],
        confidence: 1,
      },
    },
  });
  const verdict = parsed.result.verdict;
  assert.equal(verdict.verdict, "fail");
  if (verdict.verdict === "fail") {
    assert.equal(verdict.requestedChanges[0]!.path, undefined);
    assert.equal(verdict.requestedChanges[0]!.category, undefined);
  }
  assert.equal(
    PersonaWorkloadProviderResultSchema.safeParse({
      result: { kind: "future", verdict: {} },
    }).success,
    false,
  );
});
