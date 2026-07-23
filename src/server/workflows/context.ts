import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewItem, Session, TranscriptMessage } from "@shared/types.ts";
import { WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import type {
  PersonaFeedbackSummary,
  WorkflowBinding,
  WorkflowContextSnapshot,
  WorkflowHumanDecision,
  WorkflowStandardsDocument,
} from "@shared/workflow.ts";
import { computeSessionDiff } from "../diff.ts";
import { loadResolvedWorkflowReviews } from "../db.ts";
import { sessionMessages } from "../harness/index.ts";
import { changedPaths } from "../inspector/diff-lines.ts";
import { getLlmConfig, llmJobModel, llmRunnerChoice } from "../llm/config.ts";
import { runJobStructured } from "../llm/jobs.ts";
import { parseModelJson } from "../llm/structured.ts";
import type { StructuredAttemptObserver, StructuredResult } from "../llm/structured.ts";
import type { Registry } from "../registry.ts";
import { noteKeyFor } from "../registry.ts";
import { readStandards } from "../standards.ts";
import { run } from "../util/exec.ts";

const MAX_GOAL = 16_000;
const MAX_DECISIONS = 200;
const MAX_DECISION_TEXT = 16_000;
const MAX_STATUS = 500;
const MAX_STATUS_LINE = 2_000;
const MAX_TRANSCRIPT_TURN = 3_000;
const MAX_DECISION_BYTES = 320_000;
const MAX_FEEDBACK_BYTES = 120_000;
const MAX_DIFF_BYTES = 800_000;
const MAX_STATUS_BYTES = 80_000;
const MAX_COMPACTION_BYTES = 160_000;
/** One compaction attempt gets 45s; parse retry receives the same independently. */
export const WORKFLOW_CONTEXT_TIMEOUT_MS = 45_000;

const CompactionSchema = z.object({
  rationales: z.array(z.object({
    sourceId: z.string().max(500),
    rationale: z.string().max(MAX_DECISION_TEXT),
  })).max(MAX_DECISIONS),
  constraints: z.array(z.string().max(4_000)).max(100),
  acceptanceCriteria: z.array(z.string().max(4_000)).max(100),
});
type CompactionValue = z.infer<typeof CompactionSchema>;

export interface WorkflowCompactionDeps {
  execute?: (prompt: string) => Promise<StructuredResult<CompactionValue>>;
  runner?: WorkflowContextSnapshot["compaction"]["runner"];
  model?: string;
  observer?: StructuredAttemptObserver;
}

export interface RawWorkflowContext {
  primaryGoal: WorkflowContextSnapshot["primaryGoal"];
  humanDecisions: WorkflowHumanDecision[];
  priorPersonaFeedback: PersonaFeedbackSummary[];
  session: WorkflowContextSnapshot["session"];
  evidence: WorkflowContextSnapshot["evidence"];
}

export interface WorkflowCaptureRead {
  context: WorkflowContextSnapshot;
  fingerprint: string;
  boundary: {
    noteKey: string;
    sessionId: string;
    headSha: string | null;
    transcriptPath: string | null;
    transcriptSize: number | null;
    repositoryFingerprint: string;
  };
}

export interface WorkflowRawCaptureRead {
  raw: RawWorkflowContext;
  context: WorkflowContextSnapshot;
  boundary: WorkflowCaptureRead["boundary"];
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function clipBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function boundedDecisions(items: WorkflowHumanDecision[]): WorkflowHumanDecision[] {
  const out: WorkflowHumanDecision[] = [];
  let remaining = MAX_DECISION_BYTES;
  for (const item of items) {
    if (remaining <= 0 || out.length >= MAX_DECISIONS) break;
    const decision = clipBytes(item.decision, Math.min(remaining, MAX_DECISION_TEXT));
    remaining -= Buffer.byteLength(decision);
    const rationale = item.rationale && remaining > 0
      ? clipBytes(item.rationale, Math.min(remaining, MAX_DECISION_TEXT))
      : null;
    remaining -= rationale ? Buffer.byteLength(rationale) : 0;
    if (decision) out.push({ ...item, decision, rationale: rationale || null });
  }
  return out;
}

function boundedFeedback(items: PersonaFeedbackSummary[]): PersonaFeedbackSummary[] {
  const out: PersonaFeedbackSummary[] = [];
  let remaining = MAX_FEEDBACK_BYTES;
  for (const item of items.slice(-100)) {
    if (remaining <= 0) break;
    const summary = clipBytes(item.summary, Math.min(remaining, 2_000));
    remaining -= Buffer.byteLength(summary);
    const requestedChanges: string[] = [];
    for (const change of item.requestedChanges) {
      if (remaining <= 0 || requestedChanges.length >= 20) break;
      const bounded = clipBytes(change, Math.min(remaining, 2_000));
      remaining -= Buffer.byteLength(bounded);
      if (bounded) requestedChanges.push(bounded);
    }
    out.push({ ...item, summary, requestedChanges });
  }
  return out;
}

function boundedStrings(items: string[], maxBytes: number, maxItems: number): string[] {
  const out: string[] = [];
  let remaining = maxBytes;
  for (const item of items) {
    if (remaining <= 0 || out.length >= maxItems) break;
    const bounded = clipBytes(item, Math.min(remaining, 4_000));
    remaining -= Buffer.byteLength(bounded);
    if (bounded) out.push(bounded);
  }
  return out;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function transcriptDecision(message: TranscriptMessage): WorkflowHumanDecision | null {
  if (message.role !== "user" || message.origin !== undefined || !message.text.trim()) return null;
  return {
    decision: clip(message.text.trim(), MAX_DECISION_TEXT),
    rationale: null,
    source: { kind: "transcript", id: message.id },
  };
}

/** Filtering is absence-based so every present and future attributed origin stays non-human. */
export function humanTranscriptDecisions(messages: TranscriptMessage[]): WorkflowHumanDecision[] {
  return messages.map(transcriptDecision).filter((item): item is WorkflowHumanDecision => item !== null);
}

export function workflowReviewDecision(review: ReviewItem): WorkflowHumanDecision {
  const response = review.response?.trim() || null;
  const answered = review.kind === "input" || review.kind === "plan-decisions";
  const decision = [
    `${answered ? "Answer" : "Decision"}: ${answered ? response ?? review.status : review.status}`,
    review.title,
    review.body,
  ].filter(Boolean).join("\n");
  return {
    decision: clip(decision, MAX_DECISION_TEXT),
    rationale: !answered && response ? clip(response, MAX_DECISION_TEXT) : null,
    source: { kind: "review", id: review.id },
  };
}

function compactPrompt(raw: RawWorkflowContext): string {
  return [
    "Compact workflow intent without rewriting it.",
    "Return ONLY JSON with rationales [{sourceId,rationale}], constraints [string], and acceptanceCriteria [string].",
    "Use sourceId exactly as supplied. Do not add decisions or infer a rationale that is not supported.",
    JSON.stringify({
      rawGoal: raw.primaryGoal.rawPrompt,
      refinedGoal: raw.primaryGoal.refined,
      decisions: raw.humanDecisions.map((item) => ({
        sourceId: `${item.source.kind}:${item.source.id}`,
        decision: item.decision,
        rationale: item.rationale,
      })),
    }),
  ].join("\n\n");
}

/** Deterministic degradation used for spawn, timeout, exit, and parse failure. */
export function fallbackWorkflowContext(
  raw: RawWorkflowContext,
  error: string | null,
): WorkflowContextSnapshot {
  return {
    ...raw,
    constraints: [],
    acceptanceCriteria: [],
    compaction: { status: "fallback", runner: null, model: null, error },
  };
}

export async function compactWorkflowContext(
  raw: RawWorkflowContext,
  deps: WorkflowCompactionDeps = {},
): Promise<WorkflowContextSnapshot> {
  const cfg = getLlmConfig();
  const runner = deps.runner ?? llmRunnerChoice(cfg).id;
  const model = deps.model ?? llmJobModel("workflow-context", cfg).id;
  const prompt = compactPrompt(raw);
  const result = deps.execute
    ? await deps.execute(prompt)
    : await runJobStructured<typeof CompactionSchema>(
        "workflow-context",
        prompt,
        (text) => parseModelJson(text, CompactionSchema),
        "Workflow context compaction",
        {
          timeoutMs: WORKFLOW_CONTEXT_TIMEOUT_MS,
          observer: deps.observer,
        },
      );
  if (result.kind === "failed") {
    return {
      ...fallbackWorkflowContext(raw, result.reason),
      compaction: {
        status: "fallback",
        runner,
        model,
        error: result.reason,
      },
    };
  }
  const constraints = boundedStrings(result.value.constraints, MAX_COMPACTION_BYTES / 2, 100);
  const acceptanceCriteria = boundedStrings(
    result.value.acceptanceCriteria,
    MAX_COMPACTION_BYTES / 2,
    100,
  );
  const compacted: WorkflowContextSnapshot = {
    ...raw,
    // Raw, sourced decisions and rationales are immutable evidence. Model-produced
    // rationales are advisory and may not overwrite a missing human rationale.
    humanDecisions: raw.humanDecisions,
    constraints,
    acceptanceCriteria,
    compaction: {
      status: "model",
      runner,
      model,
      error: null,
    },
  };
  return WorkflowContextSnapshotSchema.parse(compacted);
}

export async function captureStableWorkflowContext<T>(
  read: () => Promise<T>,
  boundaryChanged: (captured: T) => Promise<boolean>,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const captured = await read();
    if (!(await boundaryChanged(captured))) return captured;
  }
  return null;
}

function standardsDocuments(
  docs: ReturnType<typeof readStandards>["docs"],
): WorkflowStandardsDocument[] {
  return docs.map((doc) => ({
    path: doc.path,
    text: doc.text,
    truncated: doc.truncated,
    fingerprint: sha(`${doc.path}\0${doc.text}`),
  }));
}

async function readRepositoryEvidence(cwd: string | null): Promise<{
  diff: Awaited<ReturnType<typeof computeSessionDiff>>;
  allStatus: string[];
  status: string[];
  standards: ReturnType<typeof readStandards>;
  repositoryFingerprint: string;
}> {
  const diff = await computeSessionDiff(cwd);
  if (!diff.ok) {
    throw new Error(`Could not capture repository diff: ${diff.error ?? "unknown error"}`);
  }
  const statusResult = await run("git", ["-C", cwd!, "status", "--porcelain=v1"], {
    timeoutMs: 15_000,
  });
  if (statusResult.code !== 0) {
    throw new Error(`Could not capture repository status: ${statusResult.stderr.trim() || "git status failed"}`);
  }
  const allStatus = statusResult.stdout.split("\n").filter(Boolean).slice(0, MAX_STATUS);
  const status = boundedStrings(
    allStatus.map((item) => clip(item, MAX_STATUS_LINE)),
    MAX_STATUS_BYTES,
    MAX_STATUS,
  );
  const standards = readStandards(diff.repoRoot, changedPaths(diff.patch));
  const repositoryFingerprint = sha(JSON.stringify({
    headSha: diff.headSha,
    patch: diff.patch,
    patchTruncated: diff.truncated,
    status,
    standardsTruncated: standards.truncated,
    standards: standardsDocuments(standards.docs).map((doc) => ({
      path: doc.path,
      fingerprint: doc.fingerprint,
      truncated: doc.truncated,
    })),
  }));
  return { diff, allStatus, status, standards, repositoryFingerprint };
}

function sourceFingerprint(context: WorkflowContextSnapshot): string {
  return sha(JSON.stringify({
    rawGoal: context.primaryGoal.rawPrompt,
    refinedGoal: context.primaryGoal.refined,
    decisions: context.humanDecisions.map((item) => ({
      decision: item.decision,
      rationale: item.rationale,
      source: item.source,
    })),
    headSha: context.evidence.headSha,
    diffFingerprint: context.evidence.diffFingerprint,
    transcriptAnchor: context.evidence.transcriptAnchor,
    standards: context.evidence.standards.map((doc) => ({
      path: doc.path,
      fingerprint: doc.fingerprint,
    })),
  }));
}

export function workflowContextFingerprint(context: WorkflowContextSnapshot): string {
  return sourceFingerprint(context);
}

function compatibleSession(binding: WorkflowBinding, session: Session): boolean {
  return binding.sessionId === session.id && binding.noteKey === noteKeyFor(session);
}

/**
 * Read one bounded raw snapshot and its capture boundary. The manager re-reads that boundary
 * and retries once before persisting the raw evidence and starting compaction.
 */
export async function readWorkflowContextRaw(
  registry: Registry,
  binding: WorkflowBinding,
  priorPersonaFeedback: PersonaFeedbackSummary[] = [],
): Promise<WorkflowRawCaptureRead> {
  const session = binding.sessionId ? registry.getSession(binding.sessionId) : undefined;
  if (!session || !compatibleSession(binding, session)) {
    throw new Error("The workflow binding is not attached to its durable conversation");
  }
  const goal = registry.getGoal(session.id);
  const located = sessionMessages(session);
  const transcriptAnchor = located?.read.size(located.path) ?? null;
  const transcriptWindow = located?.read.window(located.path, 12, 68) ?? {
    messages: [],
    truncated: false,
    headCount: 0,
  };
  const {
    diff,
    allStatus,
    status,
    standards,
    repositoryFingerprint,
  } = await readRepositoryEvidence(session.cwd);
  const decisions = boundedDecisions([
    ...loadResolvedWorkflowReviews(session.id).map(workflowReviewDecision),
    ...registry.listEpisodes(session.id)
      .filter((episode) => episode.resolvedBy === "you")
      .map((episode): WorkflowHumanDecision => ({
        decision: clip([
          episode.question,
          episode.sentOption?.label ?? episode.sentText ?? episode.disposition,
        ].filter(Boolean).join("\nAnswer: "), MAX_DECISION_TEXT),
        rationale: clip(episode.brief ?? episode.recommendation ?? "", MAX_DECISION_TEXT) || null,
        source: { kind: "foreman_episode", id: String(episode.id) },
      })),
    ...humanTranscriptDecisions(transcriptWindow.messages),
  ]);
  const boundedDiff = clipBytes(diff.patch, MAX_DIFF_BYTES);
  const transcript = transcriptWindow.messages.map((message) => ({
    role: message.role,
    content: clipBytes(message.text, MAX_TRANSCRIPT_TURN),
    ...(message.ts > 0 ? { timestamp: message.ts } : {}),
  }));
  const raw: RawWorkflowContext = {
    primaryGoal: {
      rawPrompt: clip(goal?.prompt ?? goal?.text ?? "", MAX_GOAL),
      refined: goal?.text ? clip(goal.text, MAX_GOAL) : null,
      sourceNoteKey: binding.noteKey,
    },
    humanDecisions: decisions,
    priorPersonaFeedback: boundedFeedback(priorPersonaFeedback),
    session: {
      agent: session.agent,
      name: session.name,
      cwd: session.cwd,
      branch: diff.branch ?? session.gitBranch,
    },
    evidence: {
      headSha: diff.headSha,
      diffFingerprint: sha(JSON.stringify({ patch: diff.patch, status })),
      diff: boundedDiff,
      diffTruncated: diff.truncated || boundedDiff !== diff.patch,
      workingTreeDirty: allStatus.length > 0,
      workingTreeStatus: status,
      transcript,
      transcriptAnchor,
      transcriptTruncated:
        transcriptWindow.truncated
        || transcript.some((message, index) =>
          message.content !== transcriptWindow.messages[index]?.text),
      standards: standardsDocuments(standards.docs),
      standardsTruncated: standards.truncated,
    },
  };
  const context = WorkflowContextSnapshotSchema.parse(fallbackWorkflowContext(raw, null));
  return {
    raw,
    context,
    boundary: {
      noteKey: noteKeyFor(session),
      sessionId: session.id,
      headSha: diff.headSha,
      transcriptPath: located?.path ?? null,
      transcriptSize: located?.read.size(located.path) ?? null,
      repositoryFingerprint,
    },
  };
}

export async function readWorkflowContext(
  registry: Registry,
  binding: WorkflowBinding,
  priorPersonaFeedback: PersonaFeedbackSummary[] = [],
): Promise<WorkflowCaptureRead> {
  const captured = await readWorkflowContextRaw(registry, binding, priorPersonaFeedback);
  const context = await compactWorkflowContext(captured.raw);
  return {
    context,
    fingerprint: sourceFingerprint(context),
    boundary: captured.boundary,
  };
}

export async function captureBoundaryChanged(
  registry: Registry,
  binding: WorkflowBinding,
  boundary: WorkflowCaptureRead["boundary"],
): Promise<boolean> {
  const session = binding.sessionId ? registry.getSession(binding.sessionId) : undefined;
  if (!session || session.id !== boundary.sessionId || noteKeyFor(session) !== boundary.noteKey) return true;
  const located = sessionMessages(session);
  const size = located?.read.size(located.path) ?? null;
  if ((located?.path ?? null) !== boundary.transcriptPath || size !== boundary.transcriptSize) return true;
  const repository = await readRepositoryEvidence(session.cwd);
  return repository.diff.headSha !== boundary.headSha
    || repository.repositoryFingerprint !== boundary.repositoryFingerprint;
}
