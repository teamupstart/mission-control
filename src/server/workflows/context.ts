import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { z } from "zod";
import type { ReviewItem, Session, TranscriptMessage } from "@shared/types.ts";
import { WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import type {
  PersonaFeedbackSummary,
  WorkflowBinding,
  WorkflowCanonicalCriterion,
  WorkflowContextSnapshot,
  WorkflowCriterionMapping,
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceProofClass,
  WorkflowHumanDecision,
  WorkflowStandardsDocument,
} from "@shared/workflow.ts";
import {
  WORKFLOW_EVIDENCE_PROOF_CLASSES,
  workflowCrossCriterionClaimIds,
} from "@shared/workflow.ts";
import { computeSessionDiff } from "../diff.ts";
import { injectionFingerprint } from "../injections.ts";
import { clipUtf8Bytes } from "../util/utf8.ts";
import { loadResolvedWorkflowReviews } from "../db.ts";
import { sessionMessages } from "../harness/index.ts";
import { attributeTranscript } from "../transcript-attribution.ts";
import { changedPaths } from "../inspector/diff-lines.ts";
import { getLlmConfig, llmJobModel, llmRunnerChoice } from "../llm/config.ts";
import { providerJsonSchema } from "../llm/json-schema.ts";
import { runJobStructured } from "../llm/jobs.ts";
import type { JobExecution } from "../llm/jobs.ts";
import { parseModelJson } from "../llm/structured.ts";
import type { StructuredAttemptObserver, StructuredResult } from "../llm/structured.ts";
import type { Registry } from "../registry.ts";
import { noteKeyFor } from "../registry.ts";
import { readStandards } from "../standards.ts";
import { run } from "../util/exec.ts";
import { FULL_SHA } from "./commit-id.ts";

const MAX_GOAL = 16_000;
const MAX_DECISIONS = 200;
const MAX_DECISION_TEXT = 16_000;
const MAX_STATUS = 500;
const MAX_STATUS_LINE = 2_000;
export const WORKFLOW_TRANSCRIPT_LIMITS = {
  perTurnBytes: 8_000,
  aggregateBytes: 180_000,
  /** Headroom under the shared 240,000-character prompt-section ceiling for JSON framing. */
  jsonCharacters: 230_000,
} as const;
const MAX_DECISION_BYTES = 320_000;
const MAX_FEEDBACK_BYTES = 120_000;
const MAX_DIFF_BYTES = 800_000;
const MAX_STATUS_BYTES = 80_000;
const MAX_COMPACTION_BYTES = 160_000;
/** One compaction attempt gets 45s; parse retry receives the same independently. */
export const WORKFLOW_CONTEXT_TIMEOUT_MS = 45_000;

/**
 * Exported for the provider-schema contract test only, which has to be able to name every
 * schema that reaches `LlmRunOptions.schema`. This one is a CONTROL there: it already listed
 * every key in `required`, which is why 72 live Codex compactions succeeded while the
 * Inspector's schema failed every call.
 */
export const CompactionSchema = z.object({
  constraints: z.array(z.string().max(4_000)).max(100),
  acceptanceCriteria: z.array(z.string().max(4_000)).max(100),
  canonicalCriteria: z.array(z.object({
    text: z.string().max(4_000),
    material: z.boolean(),
    suggestedProofClass: z.enum(WORKFLOW_EVIDENCE_PROOF_CLASSES).nullable(),
  })).max(100),
});
export const CriterionReconciliationSchema = z.object({
  criterionMappings: z.array(z.object({
    canonicalCriterionOrdinal: z.number().int().min(1).max(100),
    matchedClientCriterionIds: z.array(z.string().min(1).max(200)).max(100),
  })).max(100),
});
const COMPACTION_JSON_SCHEMA = providerJsonSchema(CompactionSchema);
const CRITERION_RECONCILIATION_JSON_SCHEMA = providerJsonSchema(CriterionReconciliationSchema);
type CompactionValue = z.infer<typeof CompactionSchema>;
type CriterionReconciliationValue = z.infer<typeof CriterionReconciliationSchema>;

export interface WorkflowCompactionDeps {
  execute?: (prompt: string) => Promise<StructuredResult<CompactionValue>>;
  reconcile?: (prompt: string) => Promise<StructuredResult<CriterionReconciliationValue>>;
  runner?: WorkflowContextSnapshot["compaction"]["runner"];
  model?: string;
  observer?: StructuredAttemptObserver;
  reconciliationObserver?: StructuredAttemptObserver;
  /**
   * Told the pair the call resolved, before its first attempt runs.
   *
   * Forwarded straight to `runJobStructured`. The engine's `llm_calls` row is written from
   * inside `observer.start`, which is earlier than this function's own return value.
   */
  onExecution?: (execution: JobExecution) => void;
  onReconciliationExecution?: (execution: JobExecution) => void;
}

export interface RawWorkflowContext {
  primaryGoal: WorkflowContextSnapshot["primaryGoal"];
  humanDecisions: WorkflowHumanDecision[];
  priorPersonaFeedback: PersonaFeedbackSummary[];
  session: WorkflowContextSnapshot["session"];
  evidence: WorkflowContextSnapshot["evidence"];
  /** Bounded author metadata for reconciliation. Never persisted inside context_json. */
  coverage?: WorkflowEvidenceCoverageClaim[];
  /** Bounded frozen evidence metadata. Source locators and bodies are never included. */
  evidenceMetadata?: Array<{
    clientItemId: string;
    kind: "image" | "artifact";
    caption: string;
    repositoryScope: string;
    exitCode: number | null;
  }>;
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

function boundedDecisions(items: WorkflowHumanDecision[]): WorkflowHumanDecision[] {
  const out: WorkflowHumanDecision[] = [];
  let remaining = MAX_DECISION_BYTES;
  for (const item of items) {
    if (remaining <= 0 || out.length >= MAX_DECISIONS) break;
    const decision = clipUtf8Bytes(item.decision, Math.min(remaining, MAX_DECISION_TEXT));
    remaining -= Buffer.byteLength(decision);
    const rationale = item.rationale && remaining > 0
      ? clipUtf8Bytes(item.rationale, Math.min(remaining, MAX_DECISION_TEXT))
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
    const summary = clipUtf8Bytes(item.summary, Math.min(remaining, 2_000));
    remaining -= Buffer.byteLength(summary);
    const requestedChanges: string[] = [];
    for (const change of item.requestedChanges) {
      if (remaining <= 0 || requestedChanges.length >= 20) break;
      const bounded = clipUtf8Bytes(change, Math.min(remaining, 2_000));
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
    const bounded = clipUtf8Bytes(item, Math.min(remaining, 4_000));
    remaining -= Buffer.byteLength(bounded);
    if (bounded) out.push(bounded);
  }
  return out;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedCriterionText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function intentFingerprintFields(raw: RawWorkflowContext): object {
  const decisions: Array<{ decision: string; rationale: string | null }> = [];
  const seen = new Set<string>();
  for (const item of raw.humanDecisions) {
    const decision = { decision: item.decision, rationale: item.rationale };
    const key = JSON.stringify(decision);
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push(decision);
  }
  return {
    rawGoal: raw.primaryGoal.rawPrompt,
    refinedGoal: raw.primaryGoal.refined,
    decisions,
  };
}

/** Stable intent identity. Repository state, evidence, coverage, and Persona feedback are excluded. */
export function workflowIntentFingerprint(raw: RawWorkflowContext): string {
  return sha(JSON.stringify(intentFingerprintFields(raw)));
}

/**
 * Map one replacement coverage packet onto stable canonical criteria without trusting old ids.
 *
 * Exact normalized criterion text is the fail-closed bridge. A source claim's text remains a
 * valid bridge when the compactor phrased its canonical criterion differently. New claim ids
 * are therefore accepted only when their text has one unambiguous stable owner; duplicates
 * stay visible to `criterion_mapped_v1` as an ambiguous mapping.
 */
export function reconcileWorkflowCriterionMappings(
  criteria: readonly WorkflowCanonicalCriterion[],
  coverage: readonly WorkflowEvidenceCoverageClaim[],
  options: {
    sourceCoverage?: readonly WorkflowEvidenceCoverageClaim[];
    sourceMappings?: readonly WorkflowCriterionMapping[];
    proposedMappings?: readonly WorkflowCriterionMapping[];
  } = {},
): WorkflowCriterionMapping[] {
  const sourceCoverage = options.sourceCoverage ?? [];
  const sourceMappings = options.sourceMappings ?? [];
  const proposedMappings = options.proposedMappings ?? [];
  const sourceClaims = new Map(sourceCoverage.map((claim) => [claim.clientCriterionId, claim]));
  const currentClaimIds = new Set(coverage.map((claim) => claim.clientCriterionId));
  const owners = new Map<string, Set<number>>();
  const addOwner = (text: string, ordinal: number) => {
    const key = normalizedCriterionText(text);
    if (!key) return;
    const indexes = owners.get(key) ?? new Set<number>();
    indexes.add(ordinal);
    owners.set(key, indexes);
  };
  criteria.forEach((criterion, ordinal) => {
    addOwner(criterion.text, ordinal);
    const sourceMapping = sourceMappings.find((mapping) => mapping.criterionId === criterion.id);
    for (const id of sourceMapping?.matchedClientCriterionIds ?? []) {
      const source = sourceClaims.get(id);
      if (source) addOwner(source.criterion, ordinal);
    }
  });
  const ambiguousProposedIds = workflowCrossCriterionClaimIds({
    canonicalCriteria: criteria,
    criterionMappings: proposedMappings,
    coverage,
  });
  const matches = criteria.map((criterion) => proposedMappings
    .filter((mapping) => mapping.criterionId === criterion.id)
    .flatMap((mapping) => mapping.matchedClientCriterionIds)
    .filter((id) => currentClaimIds.has(id)));
  for (const claim of coverage) {
    if (ambiguousProposedIds.has(claim.clientCriterionId)) continue;
    const indexes = owners.get(normalizedCriterionText(claim.criterion));
    if (!indexes || indexes.size !== 1) continue;
    matches[[...indexes][0]!]!.push(claim.clientCriterionId);
  }
  return criteria.map((criterion, ordinal) => ({
    criterionId: criterion.id,
    matchedClientCriterionIds: [...new Set(matches[ordinal])].sort(),
  }));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value);
}

function tailUtf8Bytes(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const scalars = [...value];
  let bytes = 0;
  let index = scalars.length;
  while (index > 0) {
    const size = utf8Bytes(scalars[index - 1]!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index -= 1;
  }
  return scalars.slice(index).join("");
}

function boundedTranscriptTurn(message: TranscriptMessage): WorkflowContextSnapshot["evidence"]["transcript"][number] {
  const total = utf8Bytes(message.text);
  const base = {
    role: message.role,
    ...(message.ts > 0 ? { timestamp: message.ts } : {}),
  };
  if (total <= WORKFLOW_TRANSCRIPT_LIMITS.perTurnBytes) {
    return { ...base, content: message.text };
  }
  let omitted = total;
  let head = "";
  let tail = "";
  let marker = "";
  // The omitted count affects the marker width. Start with the longest possible count and
  // converge until the displayed count and retained byte arithmetic agree. The count can only
  // decrease; once its decimal width stops shrinking, the next calculation is identical.
  while (true) {
    const displayedOmitted = omitted;
    marker = `\n[transcript turn head retained; ${omitted} UTF-8 bytes omitted]\n`
      + "[transcript turn tail retained]\n";
    const available = Math.max(0, WORKFLOW_TRANSCRIPT_LIMITS.perTurnBytes - utf8Bytes(marker));
    const headBudget = Math.min(2_000, Math.floor(available / 2));
    const tailBudget = Math.max(0, available - headBudget);
    head = clipUtf8Bytes(message.text, headBudget);
    tail = tailUtf8Bytes(message.text, tailBudget);
    omitted = Math.max(0, total - utf8Bytes(head) - utf8Bytes(tail));
    if (omitted === displayedOmitted) break;
  }
  return { ...base, content: `${head}${marker}${tail}`, omittedMiddleBytes: omitted };
}

/**
 * Bound transcript evidence independently from the harness window.
 *
 * Turns are clipped with visible head/tail markers, then the aggregate selects from newest to
 * oldest. That ordering is deliberate: the opening goal already has its own immutable field,
 * while the end of the transcript contains the verification output a Persona otherwise loses.
 */
export function boundedWorkflowTranscript(
  messages: TranscriptMessage[],
): {
  transcript: WorkflowContextSnapshot["evidence"]["transcript"];
  omittedHeadBytes: number;
  truncated: boolean;
} {
  const bounded = messages.map(boundedTranscriptTurn);
  const selected: typeof bounded = [];
  let retainedBytes = 0;
  let firstRetained = bounded.length;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const candidate = bounded[index]!;
    const candidateBytes = utf8Bytes(candidate.content);
    const next = [candidate, ...selected];
    if (
      retainedBytes + candidateBytes > WORKFLOW_TRANSCRIPT_LIMITS.aggregateBytes
      || JSON.stringify(next).length > WORKFLOW_TRANSCRIPT_LIMITS.jsonCharacters
    ) break;
    selected.unshift(candidate);
    retainedBytes += candidateBytes;
    firstRetained = index;
  }
  const omittedHeadBytes = messages
    .slice(0, firstRetained)
    .reduce((sum, message) => sum + utf8Bytes(message.text), 0);
  return {
    transcript: selected,
    omittedHeadBytes,
    truncated: omittedHeadBytes > 0 || selected.some((message) => (message.omittedMiddleBytes ?? 0) > 0),
  };
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

export interface DeliveredWorkflowTranscriptAnchor {
  payload: string;
  transcriptAnchor: number;
}

interface WorkflowTranscriptTurnIdentity {
  id: string;
  ts: number;
  payloadFingerprint: string;
}

/**
 * Restore authorship that the transcript format cannot carry.
 *
 * Workflow attribution is identity-based here, not the live overlay's text-only label. A human
 * can quote a packet verbatim after it was delivered, and context capture must keep that later
 * decision. Native ids are preferred; a timestamp plus payload fingerprint is used only when
 * both sides contain one unambiguous match, for transcript parsers whose synthesized ids differ
 * between reads.
 */
export function attributeWorkflowContextTranscript(
  sessionId: string,
  messages: TranscriptMessage[],
  deliveredWorkflowTurns: readonly WorkflowTranscriptTurnIdentity[],
): TranscriptMessage[] {
  const liveAttributed = attributeTranscript(sessionId, messages).map((message) => {
    if (message.origin !== "workflow") return message;
    return { ...message, origin: undefined };
  });
  const exactIds = new Set(deliveredWorkflowTurns.map((turn) => turn.id));
  const fallbackCounts = new Map<string, number>();
  const messageCounts = new Map<string, number>();
  const keyFor = (fingerprint: string, ts: number): string => `${ts}\0${fingerprint}`;

  for (const turn of deliveredWorkflowTurns) {
    if (turn.ts <= 0) continue;
    const key = keyFor(turn.payloadFingerprint, turn.ts);
    fallbackCounts.set(key, (fallbackCounts.get(key) ?? 0) + 1);
  }
  for (const message of liveAttributed) {
    if (message.role !== "user" || !message.text || message.ts <= 0) continue;
    const key = keyFor(injectionFingerprint(message.text), message.ts);
    messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
  }

  return liveAttributed.map((message) => {
    if (message.role !== "user" || message.origin !== undefined || !message.text) return message;
    const fingerprint = injectionFingerprint(message.text);
    const exact = exactIds.has(message.id)
      && deliveredWorkflowTurns.some((turn) =>
        turn.id === message.id && turn.payloadFingerprint === fingerprint
      );
    const fallbackKey = keyFor(fingerprint, message.ts);
    const unambiguousFallback = message.ts > 0
      && fallbackCounts.get(fallbackKey) === 1
      && messageCounts.get(fallbackKey) === 1;
    return exact || unambiguousFallback ? { ...message, origin: "workflow" } : message;
  });
}

function deliveredWorkflowTurnIdentities(
  located: NonNullable<ReturnType<typeof sessionMessages>>,
  deliveries: readonly DeliveredWorkflowTranscriptAnchor[],
): WorkflowTranscriptTurnIdentity[] {
  const identities: WorkflowTranscriptTurnIdentity[] = [];
  for (const delivery of deliveries) {
    if (!delivery.payload.trim()) continue;
    const payloadFingerprint = injectionFingerprint(delivery.payload);
    const messages = located.read.before(located.path, delivery.transcriptAnchor, 12).messages;
    const match = messages.findLast((message) =>
      message.role === "user"
      && Boolean(message.text)
      && injectionFingerprint(message.text) === payloadFingerprint
    );
    if (match) identities.push({ id: match.id, ts: match.ts, payloadFingerprint });
  }
  return identities;
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
    "Return ONLY JSON with constraints [string], acceptanceCriteria [string], and canonicalCriteria.",
    "Each canonical criterion has text, material, and suggestedProofClass.",
    "Proof class suggestions are advisory.",
    "Do not add decisions or infer intent that is not supported by the supplied sources.",
    JSON.stringify(intentFingerprintFields(raw)),
  ].join("\n\n");
}

function criterionReconciliationPrompt(
  criteria: readonly WorkflowCanonicalCriterion[],
  coverage: readonly WorkflowEvidenceCoverageClaim[],
): string {
  return [
    "Reconcile author coverage claims to stable workflow criteria without rewriting either.",
    "Return ONLY JSON with criterionMappings.",
    "Each mapping names a 1-based canonicalCriterionOrdinal and the semantically matching client criterion ids.",
    "Do not infer coverage. Leave unmatched or ambiguous criteria with no matched ids.",
    JSON.stringify({
      canonicalCriteria: criteria.map((criterion, ordinal) => ({
        canonicalCriterionOrdinal: ordinal + 1,
        text: criterion.text,
      })),
      authorCoverage: coverage.map((claim) => ({
        clientCriterionId: claim.clientCriterionId,
        criterion: claim.criterion,
      })),
    }),
  ].join("\n\n");
}

async function reconcileSourceWorkflowCriteria(
  criteria: readonly WorkflowCanonicalCriterion[],
  coverage: readonly WorkflowEvidenceCoverageClaim[],
  deps: WorkflowCompactionDeps,
): Promise<WorkflowCriterionMapping[]> {
  if (criteria.length === 0 || coverage.length === 0) {
    return reconcileWorkflowCriterionMappings(criteria, coverage);
  }
  const prompt = criterionReconciliationPrompt(criteria, coverage);
  let result: StructuredResult<CriterionReconciliationValue>;
  if (deps.reconcile) {
    result = await deps.reconcile(prompt);
  } else if (deps.execute) {
    // An injected extraction seam must never fall through to a real model call in a test or embedder.
    result = { kind: "failed", reason: "Workflow criterion reconciliation was not supplied." };
  } else {
    result = await runJobStructured<typeof CriterionReconciliationSchema>(
      "workflow-context",
      prompt,
      (text) => parseModelJson(text, CriterionReconciliationSchema),
      "Workflow criterion reconciliation",
      {
        timeoutMs: WORKFLOW_CONTEXT_TIMEOUT_MS,
        observer: deps.reconciliationObserver,
        onExecution: deps.onReconciliationExecution,
        schema: CRITERION_RECONCILIATION_JSON_SCHEMA,
        shapeGuaranteed: true,
      },
    );
  }
  const proposedMappings: WorkflowCriterionMapping[] = result.kind === "ok"
    ? result.value.criterionMappings.flatMap((mapping) => {
        const criterion = criteria[mapping.canonicalCriterionOrdinal - 1];
        return criterion
          ? [{
              criterionId: criterion.id,
              matchedClientCriterionIds: mapping.matchedClientCriterionIds,
            }]
          : [];
      })
    : [];
  return reconcileWorkflowCriterionMappings(criteria, coverage, { proposedMappings });
}

function contextFields(raw: RawWorkflowContext): Omit<
  RawWorkflowContext,
  "coverage" | "evidenceMetadata"
> {
  const { coverage: _coverage, evidenceMetadata: _evidenceMetadata, ...context } = raw;
  return context;
}

/** Deterministic degradation used for spawn, timeout, exit, and parse failure. */
export function fallbackWorkflowContext(
  raw: RawWorkflowContext,
  error: string | null,
): WorkflowContextSnapshot {
  return {
    ...contextFields(raw),
    intentFingerprint: workflowIntentFingerprint(raw),
    constraints: [],
    acceptanceCriteria: [],
    canonicalCriteria: [],
    criterionMappings: [],
    compaction: {
      status: "fallback",
      runner: null,
      model: null,
      error,
      reusedFromSubmissionId: null,
    },
  };
}

export function reuseWorkflowContextCriteria(
  raw: RawWorkflowContext,
  source: WorkflowContextSnapshot,
  sourceSubmissionId: string,
  sourceCoverage: readonly WorkflowEvidenceCoverageClaim[],
): WorkflowContextSnapshot {
  return WorkflowContextSnapshotSchema.parse({
    ...contextFields(raw),
    intentFingerprint: workflowIntentFingerprint(raw),
    constraints: source.constraints,
    acceptanceCriteria: source.acceptanceCriteria,
    canonicalCriteria: source.canonicalCriteria ?? [],
    criterionMappings: reconcileWorkflowCriterionMappings(
      source.canonicalCriteria ?? [],
      raw.coverage ?? [],
      {
        sourceCoverage,
        sourceMappings: source.criterionMappings ?? [],
      },
    ),
    compaction: {
      ...source.compaction,
      reusedFromSubmissionId: source.compaction.reusedFromSubmissionId ?? sourceSubmissionId,
    },
  });
}

export async function compactWorkflowContext(
  raw: RawWorkflowContext,
  deps: WorkflowCompactionDeps = {},
): Promise<WorkflowContextSnapshot> {
  const prompt = compactPrompt(raw);
  let result: StructuredResult<CompactionValue>;
  /** What the call reported it ran on, or null when a test supplied its own executor. */
  let ran: JobExecution | null = null;
  if (deps.execute) {
    result = await deps.execute(prompt);
  } else {
    const call = await runJobStructured<typeof CompactionSchema>(
      "workflow-context",
      prompt,
      (text) => parseModelJson(text, CompactionSchema),
      "Workflow context compaction",
      {
        timeoutMs: WORKFLOW_CONTEXT_TIMEOUT_MS,
        observer: deps.observer,
        onExecution: deps.onExecution,
        schema: COMPACTION_JSON_SCHEMA,
        shapeGuaranteed: true,
      },
    );
    ran = call.execution;
    result = call;
  }
  // The pair the CALL reported, never a second resolution of the same config. Re-deriving it
  // was merely redundant while every job shared one provider; with a provider per job the
  // re-derived label names the app-wide one while the call used this job's own, so an
  // installation with an override set stamped every snapshot wrong. Only the callee knows -
  // it also absorbs `guardProviderModel` substituting a fallback. The two `??` tails below
  // are for the injected-executor path alone, where no real call was made to ask.
  const cfg = deps.execute ? getLlmConfig() : null;
  const runner = deps.runner ?? ran?.runner ?? llmRunnerChoice(cfg ?? undefined).id;
  const model = deps.model ?? ran?.model ?? llmJobModel("workflow-context", cfg ?? undefined).id;
  if (result.kind === "failed") {
    return {
      ...fallbackWorkflowContext(raw, result.reason),
      compaction: {
        status: "fallback",
        runner,
        model,
        error: result.reason,
        reusedFromSubmissionId: null,
      },
    };
  }
  const constraints = boundedStrings(result.value.constraints, MAX_COMPACTION_BYTES / 2, 100);
  const acceptanceCriteria = boundedStrings(
    result.value.acceptanceCriteria,
    MAX_COMPACTION_BYTES / 2,
    100,
  );
  const canonicalCriteria = result.value.canonicalCriteria.map(
    (criterion, ordinal) => {
      const text = clipUtf8Bytes(criterion.text.trim(), 4_000);
      if (!text) return null;
      const normalized = normalizedCriterionText(text);
      return {
        id: `criterion-${ordinal + 1}-${sha(`${normalized}\0${ordinal}`).slice(0, 16)}`,
        text,
        material: criterion.material,
        suggestedProofClass: criterion.suggestedProofClass as WorkflowEvidenceProofClass | null,
      };
    },
  ).filter(
    (criterion): criterion is WorkflowCanonicalCriterion => criterion !== null,
  );
  const criterionMappings = await reconcileSourceWorkflowCriteria(
    canonicalCriteria,
    raw.coverage ?? [],
    deps,
  );
  const compacted: WorkflowContextSnapshot = {
    ...contextFields(raw),
    intentFingerprint: workflowIntentFingerprint(raw),
    // Raw, sourced decisions and their human rationale remain immutable evidence.
    // Compaction adds only derived constraints and acceptance criteria.
    humanDecisions: raw.humanDecisions,
    constraints,
    acceptanceCriteria,
    canonicalCriteria,
    criterionMappings,
    compaction: {
      status: "model",
      runner,
      model,
      error: null,
      reusedFromSubmissionId: null,
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

async function readRepositoryWorkEvidence(cwd: string | null): Promise<{
  diff: Awaited<ReturnType<typeof computeSessionDiff>>;
  allStatus: string[];
  status: string[];
  statusTruncated: boolean;
  statusFingerprint: string;
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
  const allStatus = statusResult.stdout.split("\n").filter(Boolean);
  const status = boundedStrings(
    allStatus.map((item) => clip(item, MAX_STATUS_LINE)),
    MAX_STATUS_BYTES,
    MAX_STATUS,
  );
  const statusTruncated = status.length !== allStatus.length
    || status.some((item, index) => item !== allStatus[index]);
  const statusFingerprint = sha(statusResult.stdout);
  return { diff, allStatus, status, statusTruncated, statusFingerprint };
}

async function readRepositoryEvidence(cwd: string | null): Promise<{
  diff: Awaited<ReturnType<typeof computeSessionDiff>>;
  allStatus: string[];
  status: string[];
  statusTruncated: boolean;
  statusFingerprint: string;
  standards: ReturnType<typeof readStandards>;
  repositoryFingerprint: string;
}> {
  const work = await readRepositoryWorkEvidence(cwd);
  const { diff, statusFingerprint } = work;
  const standards = readStandards(diff.repoRoot, changedPaths(diff.patch));
  const repositoryFingerprint = sha(JSON.stringify({
    headSha: diff.headSha,
    patch: diff.patch,
    patchTruncated: diff.truncated,
    statusFingerprint,
    standardsTruncated: standards.truncated,
    standards: standardsDocuments(standards.docs).map((doc) => ({
      path: doc.path,
      fingerprint: doc.fingerprint,
      truncated: doc.truncated,
    })),
  }));
  return { ...work, standards, repositoryFingerprint };
}

function sourceFingerprintFields(
  context: WorkflowContextSnapshot,
  transcriptAnchor: number | null,
): object {
  return {
    rawGoal: context.primaryGoal.rawPrompt,
    refinedGoal: context.primaryGoal.refined,
    decisions: context.humanDecisions.map((item) => ({
      decision: item.decision,
      rationale: item.rationale,
      source: item.source,
    })),
    headSha: context.evidence.headSha,
    diffFingerprint: context.evidence.diffFingerprint,
    transcriptAnchor,
    standards: context.evidence.standards.map((doc) => ({
      path: doc.path,
      fingerprint: doc.fingerprint,
    })),
    images: (context.evidence.images ?? []).map((image) => ({
      id: image.id,
      sha256: image.sha256,
      caption: image.caption,
      repositoryScope: image.repositoryScope,
    })),
    artifacts: (context.evidence.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      sha256: artifact.sha256,
      caption: artifact.caption,
      repositoryScope: artifact.repositoryScope,
    })),
    stagedImageGeneration: context.evidence.stagedImageGeneration ?? 0,
  };
}

function sourceFingerprint(context: WorkflowContextSnapshot): string {
  return sha(JSON.stringify(sourceFingerprintFields(
    context,
    context.evidence.transcriptAnchor,
  )));
}

export function workflowContextFingerprint(context: WorkflowContextSnapshot): string {
  return sourceFingerprint(context);
}

/**
 * The same fingerprint with the transcript anchor held at a constant - what changed about
 * the WORK, rather than what changed about the conversation.
 *
 * `sourceFingerprint` above is the submission's identity and must keep reading every input,
 * transcript included: two captures of the same repository taken either side of a real
 * manual verification are genuinely different submissions and have to hash differently.
 *
 * But identity is the wrong question for "has anything changed since the round that asked
 * for a fix?", and answering it with the identity hash is why that guard had fired twice in
 * the system's entire history. The anchor is the transcript file's byte size, and delivering
 * the repair packet is itself a transcript write, so by the time anyone can resubmit, the
 * identity has already moved - whether or not a single byte of the work did. Comparing this
 * instead lets the refusal mean what it says.
 *
 * Everything else stays in, staged evidence and standards included. A screenshot registered
 * through `submit_workflow_evidence` is new evidence about the work and must read as a
 * change; that is exactly the signal the resumption observer already resumes on, and the two
 * must not disagree.
 */
export function workflowRepositoryFingerprint(context: WorkflowContextSnapshot): string {
  return sha(JSON.stringify(sourceFingerprintFields(context, null)));
}

function compatibleSession(binding: WorkflowBinding, session: Session): boolean {
  return binding.sessionId === session.id && binding.noteKey === noteKeyFor(session);
}

/**
 * The checkout one binding's evidence comes from.
 *
 * One workflow run is one repository, and this is the single place that says which. A
 * binding with an empty `repoRoot` follows the session's own cwd - the LIVE one, not the
 * copy frozen at bind time, exactly as every capture read before this existed, so a
 * single-repo run's evidence is byte-identical. A binding that names a secondary repository
 * of the session's multi-repo task reads that repository's worktree instead, which the
 * binding captured when the run created it.
 *
 * Deliberately not "the frozen cwd, falling back to the session's": the session's cwd is
 * mutable and the frozen copy exists to detect that it moved (`reattach` compares them). A
 * primary run reading the stale copy would review a checkout the agent left.
 *
 * Any falsy `repoRoot` reads as the session's own, not just the empty string the store
 * writes. That is the same rule the wire type states - absent means the session's own
 * repository - and it is what keeps a binding row read by a build whose `migrate()` has not
 * run, or one assembled without the field, following the session rather than falling through
 * to a checkout it never named.
 */
export function workflowCheckoutPath(
  binding: Pick<WorkflowBinding, "repoRoot" | "sessionCwd">,
  session: Pick<Session, "cwd" | "workspace">,
): string | null {
  if (!binding.repoRoot && session.workspace?.authority === "provider") {
    return session.workspace.availability === "available" &&
      session.workspace.capabilities.manualWorkflow
      ? session.workspace.reportedPath
      : null;
  }
  return binding.repoRoot ? binding.sessionCwd : session.cwd;
}

/**
 * Read one bounded raw snapshot and its capture boundary. The manager re-reads that boundary
 * and retries once before persisting the raw evidence and starting compaction.
 */
export async function readWorkflowContextRaw(
  registry: Registry,
  binding: WorkflowBinding,
  priorPersonaFeedback: PersonaFeedbackSummary[] = [],
  deliveredWorkflowAnchors: readonly DeliveredWorkflowTranscriptAnchor[] = [],
): Promise<WorkflowRawCaptureRead> {
  const session = binding.sessionId ? registry.getSession(binding.sessionId) : undefined;
  if (!session || !compatibleSession(binding, session)) {
    throw new Error("The workflow binding is not attached to its durable conversation");
  }
  const goal = registry.getGoal(session.id);
  // The BINDING'S checkout, which for a secondary-repository run is its own worktree and for
  // every other run is the session's cwd unchanged. The transcript, goal and decisions below
  // stay session-scoped on purpose: sibling runs review different repositories of the same
  // conversation, and the conversation is one.
  const checkout = workflowCheckoutPath(binding, session);
  const located = sessionMessages(session);
  const transcriptAnchor = located?.read.size(located.path) ?? null;
  const transcriptWindow = located?.read.window(located.path, 12, 68) ?? {
    messages: [],
    truncated: false,
    headCount: 0,
  };
  const attributedTranscript = attributeWorkflowContextTranscript(
    session.id,
    transcriptWindow.messages,
    located ? deliveredWorkflowTurnIdentities(located, deliveredWorkflowAnchors) : [],
  );
  const contextTranscript = attributedTranscript.filter((message) => message.origin !== "workflow");
  const {
    diff,
    allStatus,
    status,
    statusTruncated,
    statusFingerprint,
    standards,
    repositoryFingerprint,
  } = await readRepositoryEvidence(checkout);
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
    ...humanTranscriptDecisions(contextTranscript),
  ]);
  const boundedDiff = clipUtf8Bytes(diff.patch, MAX_DIFF_BYTES);
  const boundedTranscript = boundedWorkflowTranscript(contextTranscript);
  const transcript = boundedTranscript.transcript;
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
      // The reviewed checkout, so a Persona reading the snapshot is told which repository the
      // diff beside it came from rather than the session's cwd in every case.
      cwd: checkout,
      branch: diff.branch ?? session.gitBranch,
    },
    evidence: {
      headSha: diff.headSha,
      diffFingerprint: sha(JSON.stringify({ patch: diff.patch, statusFingerprint })),
      diff: boundedDiff,
      diffTruncated: diff.truncated || boundedDiff !== diff.patch,
      workingTreeDirty: allStatus.length > 0,
      workingTreeStatus: status,
      workingTreeStatusTruncated: statusTruncated,
      transcript,
      transcriptAnchor,
      transcriptTruncated:
        transcriptWindow.truncated
        || boundedTranscript.truncated,
      transcriptOmittedHeadBytes: boundedTranscript.omittedHeadBytes,
      transcriptMiddleOmitted: transcriptWindow.truncated && transcriptWindow.headCount > 0,
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

/**
 * The repository facts that answer "has any work moved since that submission?" without
 * capturing transcript, standards, decisions, or compacted context.
 *
 * `diffFingerprint` is intentionally the SAME hash a full capture stores: the bounded patch
 * plus the complete status fingerprint. HEAD and the bounded status list are useful cheap
 * explanations, but neither sees a second edit to an already-dirty path. Omitting the patch
 * hash left a real repair invisible whenever it changed bytes without adding a path or making
 * a commit, which is the ordinary shape of consecutive repair rounds.
 *
 * It is deliberately REPOSITORY-ONLY. The transcript anchor is an input to the evidence
 * fingerprint, but it is not a fact about the work, and it is the one field that moves for
 * free: delivering a repair packet is itself a transcript write (the injected prompt lands
 * as a `UserPromptSubmit`), so the anchor has already moved before the agent has been asked
 * to do anything. Reading it here made a session whose hooks had lapsed - still reporting
 * `idle` because nothing reported it working - resubmit byte-identical code into the same
 * personas, fail identically, and repeat until the repair budget was gone.
 *
 * Excluding it means a transcript-only change leaves the probe matching while the full source
 * fingerprint moved, and that is the intended reading: a repair that changed no code is not a
 * repair, and a human can still Resubmit it by hand. Standards, decisions and compacted context
 * stay out for the same reason: they are not repository work, and loading them would turn the
 * pre-filter into the full capture it exists to guard.
 */
export interface WorkflowEvidenceProbe {
  headSha: string | null;
  workingTreeStatus: string[];
  diffFingerprint: string;
  stagedImageGeneration?: number;
}

export async function readWorkflowEvidenceProbe(
  registry: Registry,
  binding: WorkflowBinding,
): Promise<WorkflowEvidenceProbe> {
  const session = binding.sessionId ? registry.getSession(binding.sessionId) : undefined;
  if (!session || !compatibleSession(binding, session)) {
    throw new Error("The workflow binding is not attached to its durable conversation");
  }
  const checkout = workflowCheckoutPath(binding, session);
  if (!checkout) throw new Error("The bound session has no working directory");
  const work = await readRepositoryWorkEvidence(checkout);
  return {
    headSha: work.diff.headSha,
    workingTreeStatus: work.status,
    diffFingerprint: sha(JSON.stringify({
      patch: work.diff.patch,
      statusFingerprint: work.statusFingerprint,
    })),
  };
}

/** Whether a probe describes the same work a captured snapshot's evidence already did. */
export function probeMatchesEvidence(
  probe: WorkflowEvidenceProbe,
  evidence: WorkflowContextSnapshot["evidence"],
): boolean {
  return probe.headSha === evidence.headSha
    && probe.workingTreeStatus.length === evidence.workingTreeStatus.length
    && probe.workingTreeStatus.every((line, index) => line === evidence.workingTreeStatus[index])
    && probe.diffFingerprint === evidence.diffFingerprint
    && (probe.stagedImageGeneration ?? 0) === (evidence.stagedImageGeneration ?? 0);
}

/**
 * The bound checkout's identity and current commit, without capturing evidence.
 *
 * Three `rev-parse` calls, which is what makes this affordable on the action observer's
 * fifteen-second sweep. `readWorkflowEvidenceProbe` above answers a different question - "has
 * the work moved?" - and pays for a whole diff to answer it; a `pull_request` action asks only
 * "which repository, which branch, which commit", and asking it the expensive way would put a
 * full diff of every bound repository on a timer.
 *
 * `HEAD^{commit}` is asked for in FULL, deliberately. Evidence capture stores
 * `rev-parse --short HEAD`, and a pull request's head arrives from GitHub as a 40-character
 * object id, so an abbreviation here would make the one comparison this feature turns on into
 * a prefix match. `HEAD` is a symbolic ref rather than an abbreviation, so unlike a captured
 * head it needs no disambiguation - see `resolveCapturedCommit` for the side that does.
 *
 * Every field is null-safe rather than throwing: a reaped worktree, a directory that is not a
 * repository, an unborn branch and a detached HEAD are all states a bound session can really
 * be in, and the caller's answer to all of them is to keep waiting.
 */
export interface WorkflowRepositoryHead {
  /**
   * Which REPOSITORY this checkout belongs to, as git's common directory.
   *
   * Not the working tree's toplevel, and that distinction is the whole point. Mission Control
   * dispatches agents into linked worktrees, so a bound session's toplevel is a per-session
   * path while the pull request it opens is adopted against the repository the worktree was
   * cut from. Comparing toplevels made those two look like different repositories for every
   * dispatched session - which is the ordinary case, not an edge one - and a `pull_request`
   * action could then never complete. `--git-common-dir` is identical for a main checkout and
   * all of its linked worktrees, which is exactly the identity being compared.
   */
  repositoryId: string;
  /** The working tree's own toplevel. Reported for diagnostics, never for identity. */
  root: string;
  branch: string | null;
  headOid: string | null;
  /**
   * When HEAD was COMMITTED, in epoch milliseconds, or null when there is no commit to ask
   * about.
   *
   * Read because "a commit landed during this action's turn" has no other honest answer. An
   * object id alone cannot say WHEN it arrived, and the adapter that needs to know has no
   * baseline of its own: nothing durable records the head at delivery, so comparing an id
   * against a null baseline would complete on the first settled turn whether or not anything
   * was committed.
   *
   * Committer time, not author time. A rebase, a cherry-pick and a `--amend` all preserve
   * author time and reset committer time, so author time would report work the session merely
   * MOVED as work it did during this turn.
   */
  headCommittedAt: number | null;
}

export async function readWorkflowRepositoryHead(
  cwd: string | null,
): Promise<WorkflowRepositoryHead | null> {
  if (!cwd) return null;
  const top = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 15_000 });
  const root = top.code === 0 ? top.stdout.trim() : "";
  if (!root) return null;
  const repositoryId = await readWorkflowRepositoryId(cwd);
  if (!repositoryId) return null;
  const branchResult = await run(
    "git",
    ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
    { timeoutMs: 15_000 },
  );
  const branchName = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  // "HEAD" is what `--abbrev-ref` answers on a detached HEAD, and it is not a branch. Reported
  // as null so a caller cannot match a pull request against the literal string.
  const branch = branchName && branchName !== "HEAD" ? branchName : null;
  const headResult = await run(
    "git",
    ["-C", cwd, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    { timeoutMs: 15_000 },
  );
  // `FULL_SHA` rather than a 40-character literal, so a SHA-256 repository - whose HEAD is 64
  // characters - reports a head instead of null. Null here means "unborn branch" to every
  // caller, and an adapter that reads it waits for a commit that already exists.
  const headOid = headResult.code === 0 && FULL_SHA.test(headResult.stdout.trim())
    ? headResult.stdout.trim()
    : null;
  // Only when there is a commit to ask about, so an unborn branch still costs one `rev-parse`
  // rather than two. `%ct` is committer time in epoch SECONDS; the whole daemon speaks
  // milliseconds, so it is converted here rather than at each comparison.
  let headCommittedAt: number | null = null;
  if (headOid) {
    const committed = await run(
      "git",
      ["-C", cwd, "show", "-s", "--format=%ct", headOid],
      { timeoutMs: 15_000 },
    );
    const seconds = committed.code === 0 ? Number(committed.stdout.trim()) : Number.NaN;
    headCommittedAt = Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
  }
  return { repositoryId, root, branch, headOid, headCommittedAt };
}

/**
 * The repository a checkout belongs to, as git's common directory, or null when it is not one.
 *
 * Shared by the repository facts a completion adapter compares and by the resolution of an
 * adoption ledger row, because the two must answer identically or a correct pull request reads
 * as belonging elsewhere. `--path-format=absolute` is required: without it git answers a linked
 * worktree with a RELATIVE path, which would compare unequal against the main checkout's
 * absolute one and reinstate the bug this exists to close.
 */
export async function readWorkflowRepositoryId(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  const result = await run(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs: 15_000 },
  );
  const dir = result.code === 0 ? result.stdout.trim() : "";
  if (!dir) return null;
  // Resolved, because the two sides are reached by different paths: a session's cwd is the
  // string it was launched with, while a ledger row holds the repository root recorded at
  // adoption. On macOS every `/tmp` and `/var/folders` checkout differs between the two
  // spellings, and so does any repository behind a symlinked home or workspace.
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
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
  const repository = await readRepositoryEvidence(workflowCheckoutPath(binding, session));
  return repository.diff.headSha !== boundary.headSha
    || repository.repositoryFingerprint !== boundary.repositoryFingerprint;
}
