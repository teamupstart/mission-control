/*
 * Shared fixture for the Local Inspector accounting tests and their process-death child.
 * Import it dynamically, after the caller has chosen its state home: it loads modules that
 * resolve that home.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublishedWorkflowGraph, WorkflowContextSnapshot } from "../../src/shared/workflow.ts";
import { FIXTURE_RUN_INTENT } from "./workflow-run-intent.ts";
import { tempDir } from "../temp-root.mjs";

const { openDb } = await import("../../src/server/db.ts");
const { WorkflowStore, workflowJson } = await import("../../src/server/workflows/store.ts");
const { WorkflowRepositoryArtifactService } = await import("../../src/server/workflows/repository-artifact/service.ts");
const { LocalPersonaWorkloadExecutor } = await import("../../src/server/workflows/persona-workload/executor.ts");
const { applyFeatureFlagIntent } = await import("../../src/server/feature-flags/index.ts");
const { setInspectorConfig } = await import("../../src/server/inspector/config.ts");
export type Store = InstanceType<typeof WorkflowStore>;
export type ProviderLaunch = Parameters<import("../../src/server/workflows/persona-workload/providers.ts").RepositoryProvider>[0];
type RepositoryProvider = import("../../src/server/workflows/persona-workload/providers.ts").RepositoryProvider;

export const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Review the submitted change", refined: null, sourceNoteKey: "note-1" },
  humanDecisions: [], constraints: [], acceptanceCriteria: [], priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc", diffFingerprint: "diff", diff: "patch", diffTruncated: false,
    workingTreeDirty: false, workingTreeStatus: [], workingTreeStatusTruncated: false,
    transcript: [], transcriptAnchor: null, transcriptTruncated: false, standards: [], standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

// Two gates on the one `inspector` Command: the budget is the Command's, so with an
// allowance of one the second gate is a second call on the same allowance.
export const graph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "inspect", kind: "check", slot: "inspector", position: { x: 200, y: 0 } },
    { id: "inspect-again", kind: "check", slot: "inspector", position: { x: 400, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: "inspect", source: "session", sourcePort: "submitted", target: "inspect", targetPort: "activate" },
    { id: "again", source: "inspect", sourcePort: "pass", target: "inspect-again", targetPort: "activate" },
    { id: "repair", source: "inspect", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    { id: "end", source: "inspect-again", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "repair-again", source: "inspect-again", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

/** Local Inspector on, reviewing with Codex. */
export function enableLocalInspector() {
  applyFeatureFlagIntent({ kind: "flag", id: "local-inspector", enabled: true });
  setInspectorConfig({ enabled: true, localReview: true, runner: "codex", model: "gpt-5.6-sol" });
}

export function seed(id: string, repo: string): Store {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(`INSERT INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json,
      completion_policy_json, binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at)
    VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`)
    .run(`workflow-${id}`, `Review ${id}`, `review-${id}`, defaults, `version-${id}`);
  db.prepare(`INSERT INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json,
      completion_policy_json, binding_defaults_json, published_at)
    VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`).run(`version-${id}`, `workflow-${id}`, JSON.stringify(graph), defaults);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`, workflowVersionId: `version-${id}`, noteKey: `note-${id}`, sessionId: `session-${id}`,
    sessionAgent: "claude", sessionName: id, sessionCwd: repo, sessionRepoRoot: repo,
    triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5, now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: `manual:${id}`, now: 2 },
    { id: `submission-${id}`, triggerSource: "manual", triggerKey: `manual:${id}`, context: {}, evidence: {}, now: 2 },
  );
  store.updateSubmissionCapture(`submission-${id}`, {
    context: workflowJson(context), evidence: workflowJson(context.evidence), fingerprint: `fingerprint-${id}`, status: "running",
  }, 3);
  return store;
}

/** A Git repository with a submitted commit over origin/main. The caller removes `repo`. */
export function repository() {
  const repo = tempDir("mission-local-inspector-accounting-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const commit = (name: string) => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", name);
  git("init", "-q");
  commit("base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeFileSync(join(repo, "submitted.txt"), "submitted\n");
  git("add", "submitted.txt");
  commit("submitted");
  return { repo, base, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}

/** Capture the submitted checkout as the submission's active repository artifact. */
export async function capture(store: Store, submissionId: string, source: Source) {
  const evidence = { ...context.evidence, headSha: source.head, reviewCommit: source.head,
    localInspectorEnabled: true, contentTreeOid: source.tree };
  const artifacts = WorkflowRepositoryArtifactService.forRoot(store);
  store.setSubmissionState(submissionId, "capturing");
  const candidate = await artifacts.prepare({ checkout: source.repo, sourceBase: source.base }, new AbortController().signal);
  const claim = await artifacts.promote(candidate, submissionId);
  store.commitRepositoryCaptureActivation({ ...claim, capture: {
    context: workflowJson({ ...context, evidence }), evidence: workflowJson(evidence),
    readiness: null, fingerprint: source.head, repositoryFingerprint: source.head,
  } });
}

/** What the repository MCP leaves behind: one audited query and, unless withheld, its seal. */
export async function audit(launch: ProviderLaunch, { query = true, seal = true } = {}) {
  const prefix = "REPOSITORY_MCP_DESCRIPTOR=";
  const descriptor = launch.mcp.args.find(arg => arg.startsWith(prefix))!.slice(prefix.length);
  const { auditPath } = JSON.parse(await readFile(descriptor, "utf8")) as { auditPath: string };
  const { request } = launch;
  if (query) await appendFile(auditPath, JSON.stringify({
    operationId: randomUUID(), operation: "glob", workloadId: request.workloadId, attemptId: request.attemptId,
    snapshotDigest: request.artifact.digest, inputHash: "b".repeat(64), status: "ok", code: null,
    bytes: 14, items: 1, durationMs: 1, truncated: false, handles: [],
  }) + "\n");
  if (!seal) return;
  const bytes = await readFile(auditPath);
  await writeFile(auditPath + ".seal", JSON.stringify({
    workloadId: request.workloadId, attemptId: request.attemptId, count: query ? 1 : 0,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
}

export type Source = ReturnType<typeof repository>;

/** The real in-process executor over the captured artifact, with only the provider faked. */
export function localExecutor(store: Store, codex: RepositoryProvider, providerBinary: () => Promise<string> = async () => "/fixture/codex") {
  return new LocalPersonaWorkloadExecutor({
    materializer: WorkflowRepositoryArtifactService.forRoot(store),
    repositoryMcpBundle: "/fixture/repository-mcp.mjs",
    nodeBinary: process.execPath,
    gitBinary: "/usr/bin/git",
    providerBinary,
    providerEnvironment: async () => ({}),
    providers: {
      claude: async () => { throw new Error("Local Inspector is configured for Codex"); },
      codex,
    },
  });
}

export const clean = { summary: "Reviewed the submitted change", findings: [], resolved: [] };
export const usage = { input_tokens: 120, output_tokens: 40 };

export type Provider = (launch: ProviderLaunch, call: number) => Promise<{ verdict: unknown; usage: Record<string, number> }>;
