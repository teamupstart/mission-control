import type { LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";
import type { InspectorPosture } from "./inspector.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
import type { InspectorComment, InspectorInspection, InspectorMode } from "./types.ts";
import { providerModelDefault } from "./model.ts";
import { repoAllowlisted } from "./allowlist.ts";

// Browser-safe workflow contracts. This module is intentionally data and pure helpers only:
// the daemon persists and executes these records, while the dashboard renders the same wire
// shapes. Nothing here may acquire a node: import.

export type PersonaId = string;
export type WorkflowId = string;
export type WorkflowVersionId = string;
export type WorkflowBindingId = string;
export type WorkflowRunId = string;
export type WorkflowSubmissionId = string;
export type WorkflowNodeAttemptId = string;
export type WorkflowDeliveryId = string;
export type WorkflowLlmCallId = string;

export const WORKFLOW_LIMITS = {
  personaName: 100,
  personaDescription: 500,
  personaGuidanceBytes: 100_000,
  workflowName: 120,
  graphNodes: 100,
  graphEdges: 300,
  graphJsonBytes: 500_000,
  eventPayloadBytes: 64_000,
  canvasCoordinateAbs: 100_000,
  repairRoundsMin: 1,
  repairRoundsMax: 20,
  feedbackFieldBytes: 4_000,
  feedbackPayloadBytes: 8_000,
  externalSourceId: 200,
  externalSourceSegment: 200,
  externalSourceKey: 1_000,
  checkRepoRoot: 4_096,
  checkCommands: 200,
  checkCommandArgs: 32,
  checkCommandArg: 1_000,
  checkCommandLength: 4_000,
} as const;

export const WORKFLOW_EXECUTION_LIMITS = {
  contextJsonBytes: 2_000_000,
  verdictJsonBytes: 12_000,
  verdictSummary: 2_000,
  verdictReason: 4_000,
  verdictChanges: 20,
  verdictEvidence: 30,
  verdictPath: 1_000,
  verdictLine: 10_000_000,
  /**
   * How much of a check command's output is retained, and how much of that reaches its
   * synthetic verdict.
   *
   * Two numbers because they answer to two budgets. `checkOutput` is what run detail shows
   * and lives in `output_json`, whose ceiling is `contextJsonBytes`. `checkVerdictOutput` is
   * what the same failure quotes into `requestedChanges`, and a verdict as a whole must fit
   * `verdictJsonBytes` - the rationale and its evidence quote both carry that text, so the
   * verdict's share has to be under half the outcome's.
   */
  checkOutput: 4_000,
  checkVerdictOutput: 2_000,
} as const;

export const WORKFLOW_PERSONA_MODEL_ENV = "WORKFLOW_PERSONA_MODEL";
export const WORKFLOW_PERSONA_MODEL_SPEC: ModelChoiceSpec = {
  label: "Workflow Persona",
  envVar: `MISSION_${WORKFLOW_PERSONA_MODEL_ENV}`,
  fallback: providerModelDefault("claude", "balanced"),
  blurb: "Reviews workflow evidence with this Persona. An individual Persona override wins.",
};

export interface Persona {
  id: PersonaId;
  name: string;
  normalizedName: string;
  description: string;
  /** Exact Markdown after UTF-8 decoding, whether operator-authored or shipped. Never normalize. */
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Shipped with the application rather than authored here.
   *
   * A built-in is app data, not operator data: it is not a row, it always carries the
   * Markdown this build was made from, and it can be neither edited nor archived. Duplicate
   * is the path to a customized copy, and that copy is an ordinary Persona like any other.
   */
  builtin: boolean;
}

export interface PersonaExecutionView {
  runner: ResolvedLlmRunner;
  model: ResolvedModel;
}

export interface PersonaDefaultsView {
  runner: ResolvedLlmRunner;
  models: Record<LlmRunnerId, ResolvedModel>;
}

export interface PersonaView extends Persona {
  execution: PersonaExecutionView;
}

/**
 * One durable uniqueness spelling for a Persona name.
 *
 * SQLite's NOCASE is ASCII-only. Normalize in JavaScript so names that differ only by
 * compatibility characters, whitespace, or English case cannot become two durable identities.
 */
export function normalizePersonaName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export function personasForDisplay<
  T extends Pick<Persona, "archivedAt" | "builtin" | "normalizedName">,
>(personas: readonly T[]): T[] {
  const liveOperatorNames = new Set(
    personas
      .filter((persona) => !persona.builtin && persona.archivedAt === null)
      .map((persona) => persona.normalizedName),
  );
  return personas.filter(
    (persona) => !persona.builtin || !liveOperatorNames.has(persona.normalizedName),
  );
}

export function personaChoicesForDisplay<
  T extends Pick<Persona, "archivedAt" | "builtin" | "id" | "normalizedName">,
>(
  personas: readonly T[],
  retainedIds: readonly string[],
): Array<{ persona: T; retained: boolean }> {
  const visible = personasForDisplay(personas)
    .filter((persona) => persona.archivedAt === null);
  const visibleIds = new Set(visible.map((persona) => persona.id));
  const retained = new Set(retainedIds);
  return [
    ...personas
      .filter((persona) => retained.has(persona.id) && !visibleIds.has(persona.id))
      .map((persona) => ({ persona, retained: true })),
    ...visible.map((persona) => ({ persona, retained: false })),
  ];
}

export function personaChoiceLabel(
  persona: Pick<Persona, "archivedAt" | "builtin" | "name">,
  retained: boolean,
): string {
  if (!retained) return persona.name;
  if (persona.builtin) return `${persona.name} (Built-in, shadowed by your Persona)`;
  if (persona.archivedAt !== null) return `${persona.name} (Archived)`;
  return persona.name;
}

/** Workflow names use the same durable Unicode spelling rule as Persona names. */
export const normalizeWorkflowName = normalizePersonaName;

/**
 * The workflows a human is offered, with a live operator row SHADOWING a same-named built-in.
 *
 * Deliberately the same rule and the same narrow cause as `personasForDisplay`: an operator
 * who authored a workflow under a shipped name before it shipped keeps that name, because
 * their bindings and published versions already point at it. `create` and rename refuse a
 * built-in's name, so no new shadow can appear, and the shadowed built-in stays addressable
 * by id through the store's catalog projection - which is what keeps a binding pinned to its
 * version resolving while the library is showing somebody else's workflow under that name.
 *
 * Only a LIVE row shadows, so the archived listing stays a superset of the active one.
 */
export function workflowsForDisplay<
  T extends Pick<WorkflowDefinition, "archivedAt" | "builtin" | "normalizedName">,
>(workflows: readonly T[]): T[] {
  const liveOperatorNames = new Set(
    workflows
      .filter((workflow) => !workflow.builtin && workflow.archivedAt === null)
      .map((workflow) => workflow.normalizedName),
  );
  return workflows.filter(
    (workflow) => !workflow.builtin || !liveOperatorNames.has(workflow.normalizedName),
  );
}

/**
 * The name a Persona Markdown document carries: its first level-one heading.
 *
 * One rule for both readers of authored Markdown - the built-ins compiled into the build and
 * an operator's **Import .md** - so a file imported by hand and the same file shipped with the
 * app arrive under the same name instead of two spellings that only collide at the unique index.
 */
export function personaNameFromMarkdown(markdown: string, fallback: string): string {
  return /^#[^\S\r\n]+(.+?)[^\S\r\n]*\r?$/m.exec(markdown)?.[1]?.trim() || fallback;
}

/**
 * The one-line summary a Persona Markdown document carries: the paragraph under its heading.
 *
 * Derived rather than stored so the description cannot drift from the document it describes.
 * A file with nothing but headings has no summary, and an empty description is a legal answer.
 */
export function personaDescriptionFromMarkdown(markdown: string): string {
  const body = markdown.replace(/^[\s\S]*?^#[^\S\r\n]+.*?$/m, "");
  const paragraph = (body === markdown ? markdown : body)
    .split(/(?:\r?\n){2,}/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#"));
  if (paragraph === undefined) return "";
  const collapsed = paragraph.replace(/\s+/gu, " ");
  if (collapsed.length <= WORKFLOW_LIMITS.personaDescription) return collapsed;
  const cut = collapsed.slice(0, WORKFLOW_LIMITS.personaDescription - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface Point {
  x: number;
  y: number;
}

export const WORKFLOW_SOURCE_PORTS = ["submitted", "pass", "fail"] as const;
export type WorkflowSourcePort = (typeof WORKFLOW_SOURCE_PORTS)[number];

export const WORKFLOW_TARGET_PORTS = [
  "activate",
  "result",
  "return_for_changes",
  "terminal",
] as const;
export type WorkflowTargetPort = (typeof WORKFLOW_TARGET_PORTS)[number];

/**
 * The deterministic gates a Check node can name.
 *
 * APPEND-ONLY: a slot id reaches durable published graphs, so renaming one orphans every
 * version naming the old spelling - the node stops matching a configured command and
 * silently skips forever, which is indistinguishable from a repository nobody configured.
 *
 * A node names a SLOT and never a command. A published version carrying an argv would be
 * executable content reachable through the version export route, and a built-in workflow
 * hard-coding `npm test` would be wrong on every repository that is not the one it was
 * written in. The operator describes the machine; the version describes the gate.
 */
export const WORKFLOW_CHECK_SLOTS = ["test", "lint", "typecheck", "build"] as const;
export type WorkflowCheckSlot = (typeof WORKFLOW_CHECK_SLOTS)[number];

export type WorkflowDraftNode =
  | { id: string; kind: "session"; position: Point }
  | { id: string; kind: "persona"; personaId: PersonaId; position: Point }
  | { id: string; kind: "all_pass"; position: Point }
  | { id: string; kind: "check"; slot: WorkflowCheckSlot; position: Point }
  | { id: string; kind: "end"; outcome: string; position: Point };

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: WorkflowSourcePort;
  target: string;
  targetPort: WorkflowTargetPort;
}

export interface WorkflowDraftGraph {
  nodes: WorkflowDraftNode[];
  edges: WorkflowEdge[];
}

export interface PersonaSnapshot {
  sourcePersonaId: PersonaId;
  sourceRevision: number;
  name: string;
  description: string;
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
}

export function personaSnapshotIsOutdated(
  snapshot: PersonaSnapshot,
  current: Persona | null | undefined,
): boolean {
  if (!current) return true;
  if (current.builtin) return snapshot.guidanceMarkdown !== current.guidanceMarkdown;
  return snapshot.sourceRevision !== current.revision;
}

/**
 * Persona is the only kind whose published form differs, so every other kind - including
 * `check` - is carried through by the `Exclude`. A check node is byte-identical in draft
 * and published form because it snapshots nothing: its command is deliberately not part of
 * the version, which is the whole point of naming a slot.
 */
export type PublishedWorkflowNode =
  | Exclude<WorkflowDraftNode, { kind: "persona" }>
  | { id: string; kind: "persona"; persona: PersonaSnapshot; position: Point };

export type WorkflowVerdictNode = Extract<PublishedWorkflowNode, { kind: "persona" | "check" }>;

export function isVerdictNode(node: PublishedWorkflowNode): node is WorkflowVerdictNode {
  return node.kind === "persona" || node.kind === "check";
}

export function verdictAuthor(node: WorkflowVerdictNode): string {
  return node.kind === "persona" ? node.persona.name : `Check · ${node.slot}`;
}

export interface PublishedWorkflowGraph {
  nodes: PublishedWorkflowNode[];
  edges: WorkflowEdge[];
}

export const WORKFLOW_DIAGNOSTIC_CODES = [
  "missing_session",
  "multiple_sessions",
  "missing_end",
  "duplicate_node_id",
  "duplicate_edge_id",
  "node_limit",
  "edge_limit",
  "graph_size",
  "invalid_position",
  "coordinate_limit",
  "dangling_edge",
  "invalid_source_port",
  "invalid_target_port",
  "session_submitted_route",
  "session_return_route",
  "missing_pass_route",
  "missing_fail_route",
  "join_predecessors",
  "join_predecessor_kind",
  "join_missing_outcome",
  "join_duplicate_outcome",
  "unreachable_node",
  "no_terminal_path",
  "cycle_without_session",
  "missing_persona",
  "archived_persona",
  "invalid_completion_policy",
] as const;
export type WorkflowDiagnosticCode = (typeof WORKFLOW_DIAGNOSTIC_CODES)[number];

export interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  diagnostics: WorkflowDiagnostic[];
}

export const INSPECTOR_FINDINGS_POLICIES = ["restart_workflow", "inspector_only"] as const;
export type InspectorFindingsPolicy = (typeof INSPECTOR_FINDINGS_POLICIES)[number];

export type WorkflowCompletionPolicy =
  | { kind: "none" }
  | {
      kind: "inspector";
      onFindings: InspectorFindingsPolicy;
      missingPrAction: "wait" | "offer_prepare_pr";
    };

export const WORKFLOW_TRIGGER_MODES = ["manual", "foreman_complete"] as const;
export type WorkflowTriggerMode = (typeof WORKFLOW_TRIGGER_MODES)[number];

export const WORKFLOW_DELIVERY_MODES = ["preview", "live"] as const;
export type WorkflowDeliveryMode = (typeof WORKFLOW_DELIVERY_MODES)[number];

export interface WorkflowBindingDefaults {
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  maxRepairRounds: number;
}

export const DEFAULT_WORKFLOW_BINDING_DEFAULTS: WorkflowBindingDefaults = {
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 5,
};

export const WORKFLOW_BINDING_STATES = ["active", "paused", "orphaned", "archived"] as const;
export type WorkflowBindingState = (typeof WORKFLOW_BINDING_STATES)[number];

export const WORKFLOW_RUN_STATUSES = [
  "capturing",
  "running",
  "waiting_for_session",
  "waiting_for_pr",
  "waiting_for_inspector",
  "waiting_for_new_head",
  "blocked",
  "completed",
  "cancelled",
  "failed",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_GATE_WAIT_REASONS = [
  "missing_pr",
  "unadopted_pr",
  "inspector_disabled",
  "awaiting_fresh_observation",
  "working_tree_not_pushed",
  "head_mismatch",
  "review_pending",
  "review_backoff",
  "review_error",
  "findings",
  "pr_closed",
] as const;
export type WorkflowGateWaitReason = (typeof WORKFLOW_GATE_WAIT_REASONS)[number];

export interface WorkflowInspectorGateState {
  prKey: string | null;
  prUrl: string | null;
  targetHeadSha: string | null;
  failedHeadSha: string | null;
  enteredAt: number;
  lastObservedAt: number | null;
  observedHeadSha: string | null;
  reviewPosture: InspectorPosture | null;
  waitReason: WorkflowGateWaitReason | null;
  findingFingerprints: string[];
}

export const WORKFLOW_GATE_SUMMARIES = [
  "none",
  "waiting_pr",
  "waiting_inspector",
  "findings",
  "clean",
  "blocked",
] as const;
export type WorkflowGateSummary = (typeof WORKFLOW_GATE_SUMMARIES)[number];

export const WORKFLOW_SUBMISSION_MODES = ["full_workflow", "inspector_only"] as const;
export type WorkflowSubmissionMode = (typeof WORKFLOW_SUBMISSION_MODES)[number];

export const WORKFLOW_SUBMISSION_STATUSES = [
  "capturing",
  "running",
  "waiting_for_session",
  "completed",
  "cancelled",
  "failed",
] as const;
export type WorkflowSubmissionStatus = (typeof WORKFLOW_SUBMISSION_STATUSES)[number];

/** Infrastructure lifecycle only. Persona pass/fail is stored separately as a verdict. */
export const WORKFLOW_NODE_ATTEMPT_STATES = [
  "queued",
  "running",
  "retry_wait",
  "completed",
  "error",
  "cancelled",
] as const;
export type WorkflowNodeAttemptState = (typeof WORKFLOW_NODE_ATTEMPT_STATES)[number];

export const WORKFLOW_DELIVERY_KINDS = [
  "persona_feedback",
  "inspector_feedback",
  "pr_handoff",
] as const;
export type WorkflowDeliveryKind = (typeof WORKFLOW_DELIVERY_KINDS)[number];

export const WORKFLOW_DELIVERY_STATES = [
  "prepared",
  "sending",
  "delivered",
  "refused",
  "uncertain",
  "cancelled",
] as const;
export type WorkflowDeliveryState = (typeof WORKFLOW_DELIVERY_STATES)[number];

export const WORKFLOW_COMPLETION_KINDS = ["drain", "prompted"] as const;
export type WorkflowCompletionKind = (typeof WORKFLOW_COMPLETION_KINDS)[number];

export const WORKFLOW_LLM_PURPOSES = ["context_compaction", "persona_review"] as const;
export type WorkflowLlmPurpose = (typeof WORKFLOW_LLM_PURPOSES)[number];

export const WORKFLOW_LLM_CALL_STATES = [
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type WorkflowLlmCallState = (typeof WORKFLOW_LLM_CALL_STATES)[number];

/**
 * Who started one durable run and submission. APPEND-ONLY: these strings are persisted in
 * `workflow_runs.trigger_source` and `workflow_submissions.trigger_source` on operators'
 * machines, so renaming one does not migrate history, it makes it unparsable.
 *
 * Deliberately NOT the same axis as `WORKFLOW_TRIGGER_MODES`. A trigger mode is recurring
 * binding behaviour an operator chose (answer manually, or let Foreman claim a completion);
 * a trigger source records which caller actually produced a given submission, and `ensemble`
 * is a server-owned handoff that starts exactly one initial submission and never recurs.
 */
export const WORKFLOW_TRIGGER_SOURCES = ["manual", "foreman", "ensemble"] as const;
export type WorkflowTriggerSource = (typeof WORKFLOW_TRIGGER_SOURCES)[number];

/**
 * External orchestrators that may claim one Workflow binding through the server-owned
 * boundary. Append-only for the `WORKFLOW_TRIGGER_SOURCES` reason: it is persisted in
 * `workflow_binding_claims.source_kind`.
 */
export const WORKFLOW_EXTERNAL_SOURCE_KINDS = ["ensemble"] as const;
export type WorkflowExternalSourceKind = (typeof WORKFLOW_EXTERNAL_SOURCE_KINDS)[number];

/**
 * Display provenance for a run whose binding was claimed by an external orchestrator.
 *
 * `sourceId` is DISPLAY identity - the id of the record a later phase can deep-link to.
 * It is explicit precisely so no reader ever has to take the opaque idempotency key apart:
 * that key is a server-derived string whose shape may change, and parsing it in the store
 * or the browser would turn an internal spelling into a wire contract.
 */
export interface WorkflowExternalSource {
  kind: WorkflowExternalSourceKind;
  sourceId: string;
  createdAt: number;
}

/** One external orchestrator's durable claim on exactly one Workflow binding. */
export interface WorkflowBindingClaim {
  kind: WorkflowExternalSourceKind;
  /** Opaque, server-derived idempotency key. Never parsed by a reader. */
  sourceKey: string;
  sourceId: string;
  bindingId: WorkflowBindingId;
  createdAt: number;
}

/**
 * What an externally sourced submission must observe before its evidence is durable.
 *
 * `requireCleanWorktree` is the literal `true` rather than a boolean because a matching HEAD
 * alone is NOT the selected artifact: uncommitted changes would put evidence into the review
 * that the external caller never selected. Typing it as a literal is what stops a later
 * caller from opting out of exact-clean capture while still satisfying the contract.
 */
export interface WorkflowCaptureExpectation {
  expectedHeadSha: string;
  requireCleanWorktree: true;
}

/** What one repository runs for one slot. */
export interface WorkflowCheckCommand {
  repoRoot: string;
  slot: WorkflowCheckSlot;
  /**
   * An argv, not a shell string. The execution seam accepts this array directly and its
   * runtime must spawn it without a shell; this build intentionally supplies no runtime.
   * `parseCheckCommand` is the one place a typed line becomes this array.
   */
  command: string[];
}

export interface WorkflowConfig {
  liveEnabled: boolean;
  repoAllowlist: string[];
  retention: WorkflowRetentionConfig;
  /**
   * Machine-wide consent for running a configured command from a workflow. Off by default,
   * matching `liveEnabled`, and it is only half the gate: `repoAllowlist` is the other, and
   * `checkBlockedReason` is the one place both are asked.
   */
  checksEnabled: boolean;
  /**
   * A LIST rather than a `Record<repoRoot, …>` for `repoAllowlist`'s reason: repository
   * roots are absolute paths and make poor object keys, and the flat shape is how this
   * config already stores roots.
   */
  checkCommands: WorkflowCheckCommand[];
}

export interface WorkflowRetentionConfig {
  /** Remove raw evidence from eligible terminal runs after this many days. */
  rawEvidenceDays: number;
  /** Remove the complete eligible run family after this many days. */
  completedRunDays: number;
  /** Always retain this many newest completed or cancelled run families. */
  maxCompletedRuns: number;
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  liveEnabled: false,
  repoAllowlist: [],
  retention: {
    rawEvidenceDays: 30,
    completedRunDays: 180,
    maxCompletedRuns: 1_000,
  },
  checksEnabled: false,
  checkCommands: [],
};

/**
 * The argv configured for this checkout and slot, or null when nobody configured one.
 *
 * Shared so the daemon and the settings panel resolve identically: a panel that showed a
 * command the daemon would not pick is a gate an operator believes they configured.
 *
 * `cwd` and `repoRoot` are BOTH consulted, through the same `repoAllowlisted` boundary the
 * consent gate uses, because a session normally stands in a pooled worktree under
 * `~/.treehouse/` while its `repoRoot` names the shared main repository. Matching on either
 * is what makes an entry naming the project reach a worktree of that project.
 *
 * The LONGEST matching root wins, so a monorepo subdirectory can override the entry that
 * covers the whole tree. Two entries sharing a root and slot cannot occur, and that is
 * ENFORCED at the write boundary rather than assumed here: `WorkflowConfigSchema` refuses
 * a duplicate `(repoRoot, slot)` pair. It has to be enforced somewhere, because this
 * function silently keeps the first of a tie - which would make the command that runs
 * depend on array order, a thing no surface shows the operator.
 */
export function checkCommandFor(
  config: Pick<WorkflowConfig, "checkCommands">,
  cwd: string | null,
  repoRoot: string | null,
  slot: WorkflowCheckSlot,
): WorkflowCheckCommand | null {
  let best: WorkflowCheckCommand | null = null;
  for (const entry of config.checkCommands) {
    if (entry.slot !== slot) continue;
    if (!repoAllowlisted(cwd, repoRoot, [entry.repoRoot])) continue;
    if (!best || entry.repoRoot.length > best.repoRoot.length) best = entry;
  }
  // The whole ENTRY, not just its argv. The matched root is not decoration: when a nested
  // entry wins, it is also the directory that command has to run in, and a caller handed
  // only the argv has no way to know that - it would run the package's command at the top
  // of the repository and report the answer as the package's.
  return best ? { ...best, command: [...best.command] } : null;
}

/**
 * Where a matched command runs, as a path RELATIVE to the repository's checkout.
 *
 * Relative, never absolute, and that is the load-bearing part. The execution runtime does
 * not run in the operator's own directory: it leases a pooled worktree of `repoRoot` and
 * pins it to the submission's captured commit, so the configured `/repo/packages/web` has
 * to become `packages/web` and be joined onto whatever tree was leased. Handing an absolute
 * path down would run the check against the operator's live checkout instead of the
 * reviewed commit.
 *
 * `""` means the checkout root, and it is the answer for every shape except a genuinely
 * nested entry - including an entry that sits ABOVE the repository (a broad rule covering
 * several projects says nothing about which subdirectory to stand in) and one matched
 * through `cwd` from outside the repository tree. Degrading those to the root is the safe
 * direction: the root is where a repository-wide command expects to be.
 */
/**
 * Which path a settings entry should STORE, given the repository a typed path resolved to
 * and the canonical form of the path itself.
 *
 * The inverse of `checkCommandSubpath`, and it exists because resolving a typed path to its
 * repository is lossy in exactly the direction that matters: `/repo/packages/web` resolves
 * to `/repo`, so storing the resolved root alone makes the subdirectory override
 * unconfigurable from Settings - a documented capability with no way to reach it.
 *
 * Keeps the typed path when it is the repository or strictly inside it, and falls back to
 * the repository otherwise. That fallback is not defensive noise: a path canonicalizing
 * outside the repository it resolved to is a symlinked or relocated checkout, and storing
 * a root the matcher can never match would be an entry that silently never applies.
 */
export function checkCommandRoot(repoRoot: string, requestedPath: string): string {
  const root = repoRoot.length > 1 && repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const path = requestedPath.length > 1 && requestedPath.endsWith("/")
    ? requestedPath.slice(0, -1)
    : requestedPath;
  return path === root || path.startsWith(`${root}/`) ? path : root;
}

export function checkCommandSubpath(
  repoRoot: string | null,
  entryRoot: string,
): string {
  if (!repoRoot) return "";
  const root = repoRoot.length > 1 && repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const entry = entryRoot.length > 1 && entryRoot.endsWith("/") ? entryRoot.slice(0, -1) : entryRoot;
  if (entry === root) return "";
  // A boundary match, like the allowlist's: `/repo-backup` is not inside `/repo`.
  return entry.startsWith(`${root}/`) ? entry.slice(root.length + 1) : "";
}

/**
 * Why a check may not run against this checkout, or null when it may.
 *
 * A SENTENCE and never a boolean, for `workQueueBlockedReason`'s reason: the two ways to be
 * unauthorized need different things from the operator - one is a switch in Settings, the
 * other is adding this repository - and a boolean makes the surface guess which.
 */
export function checkBlockedReason(
  config: Pick<WorkflowConfig, "checksEnabled" | "repoAllowlist">,
  cwd: string | null,
  repoRoot: string | null,
): string | null {
  if (!config.checksEnabled) {
    return "Workflow checks are switched off, so no command was run.";
  }
  if (!repoAllowlisted(cwd, repoRoot, config.repoAllowlist)) {
    return "This repository is not on the workflow allowlist, so no command was run.";
  }
  return null;
}

/**
 * What a check command DID, once it was allowed to try.
 *
 * APPEND-ONLY: a status reaches durable `output_json`, which run detail reads back.
 *
 * Three of the four PASS. `skipped` and `unavailable` are the difference between "nobody
 * configured this" and "somebody has to authorize it", and both carry a note rather than
 * silently letting the graph through - a shipped workflow with check gates has to be safe
 * on a machine that configured none of them, and an operator has to be able to tell a gate
 * that passed from a gate that never ran.
 */
export const WORKFLOW_CHECK_STATUSES = ["passed", "failed", "skipped", "unavailable"] as const;
export type WorkflowCheckStatus = (typeof WORKFLOW_CHECK_STATUSES)[number];

export interface WorkflowCheckOutcome {
  status: WorkflowCheckStatus;
  slot: WorkflowCheckSlot;
  /** Null whenever no command was resolved, which is every `skipped` outcome. */
  command: string[] | null;
  exitCode: number | null;
  /** Bounded and tail-biased: a failure's last lines are the useful ones. */
  output: string;
  /** Bytes of streamed output dropped to honour that bound, or 0 when nothing was. */
  truncatedBytes: number;
  /** Always a complete sentence, including on a pass. */
  note: string;
}

/** Whether this outcome lets the graph advance. Only `failed` does not. */
export function checkOutcomePasses(outcome: Pick<WorkflowCheckOutcome, "status">): boolean {
  return outcome.status !== "failed";
}

/**
 * Split a typed command line into an argv the way the settings field promises to.
 *
 * The panel displays what this returns, so an operator sees what will actually run rather
 * than trusting a split they cannot inspect. Deliberately NOT a shell grammar: there are no
 * variables, globs, pipes, redirections or operators, because nothing downstream has a
 * shell to interpret them and a split that accepted `a && b` would produce an argv whose
 * second half is silently an argument to the first.
 *
 * The exact rules:
 *  - Tokens are separated by unquoted whitespace, and runs of it collapse.
 *  - `'…'` is literal to the next `'`, with no escapes inside - the sh rule, so a Windows
 *    path or a regex can be pasted without doubling anything.
 *  - `"…"` is literal to the next `"`, except `\"` and `\\`, which produce `"` and `\`. Any
 *    other backslash inside double quotes stays as both characters, again as sh does, so
 *    `"C:\tmp"` is not silently given a tab.
 *  - Outside quotes a backslash escapes exactly the next character, including whitespace
 *    and quotes.
 *  - Adjacent runs concatenate into ONE token, so `--filter="a b"` is one argument.
 *  - An unterminated quote or a trailing backslash is an ERROR, never a token: a line the
 *    operator has not finished typing must not resolve to something that would run.
 *  - An empty token is an ERROR. `''` means an empty argument in sh, but every element here
 *    is bounded non-empty at the zod boundary, so accepting it would show the operator a
 *    parse the daemon then refuses.
 */
export function parseCheckCommand(
  line: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const argv: string[] = [];
  let token: string | null = null;
  const push = (text: string): void => {
    token = (token ?? "") + text;
  };
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (/\s/.test(char)) {
      if (token !== null) {
        argv.push(token);
        token = null;
      }
      continue;
    }
    if (char === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) return { ok: false, error: "This line has an unclosed ' quote." };
      push(line.slice(i + 1, close));
      i = close;
      continue;
    }
    if (char === '"') {
      let text = "";
      let j = i + 1;
      let closed = false;
      for (; j < line.length; j += 1) {
        const inner = line[j]!;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "\\" && (line[j + 1] === '"' || line[j + 1] === "\\")) {
          text += line[j + 1]!;
          j += 1;
          continue;
        }
        text += inner;
      }
      if (!closed) return { ok: false, error: 'This line has an unclosed " quote.' };
      push(text);
      i = j;
      continue;
    }
    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined) return { ok: false, error: "This line ends in a lone backslash." };
      push(next);
      i += 1;
      continue;
    }
    push(char);
  }
  if (token !== null) argv.push(token);
  if (argv.length === 0) return { ok: false, error: "Type the command to run." };
  if (argv.some((arg) => arg === "")) {
    return { ok: false, error: "An empty argument cannot be part of a command." };
  }
  return { ok: true, argv };
}

/**
 * How the panel and run detail print an argv back, so both quote the same things.
 *
 * The escaping is `parseCheckCommand`'s OWN, not JSON's, and that is the whole contract:
 * whatever this prints must re-parse to the argv it was given. `JSON.stringify` looked
 * right and was not - it escapes a tab as the two characters `\t`, which this parser reads
 * literally as a backslash and a `t` (its double-quote rule honours `\"` and `\\` and
 * nothing else, deliberately, so that `"C:\tmp"` is a path and not a tab). An argument
 * carrying a control character therefore displayed as an argv that would run differently
 * from the one configured.
 *
 * A raw control character inside double quotes round-trips exactly, because the parser
 * copies everything up to the closing quote verbatim - so the fix is to escape LESS, not
 * more: only the two characters that would end or escape the quoted run.
 */
export function formatCheckCommand(argv: readonly string[]): string {
  return argv
    .map((arg) => (/[\s'"\\]/.test(arg) ? `"${arg.replace(/[\\"]/g, "\\$&")}"` : arg))
    .join(" ");
}

export interface WorkflowCompletionClaim {
  completionKind: WorkflowCompletionKind;
  /** SHA-256 of the worker's proof episode, never raw prompt or diff text. */
  marker: string;
  summary: string;
  evidenceFingerprint: string;
  /**
   * The prompted episode the verifier judged. Null for drain claims.
   *
   * The daemon compares this with its current goal at the same synchronous boundary
   * that retires the guard, so a newer human prompt cannot inherit an older verdict.
   */
  expectedGoal: string | null;
}

export type WorkflowCompletionClaimResult =
  | { claimed: false; reason: "no_binding" | "manual_trigger" }
  | {
      claimed: true;
      runId: WorkflowRunId;
      submissionId: WorkflowSubmissionId | null;
      state: "started" | "resubmitted" | "already_claimed" | "blocked";
    };

/** JSON that has crossed a validation boundary. */
export type WorkflowJson =
  | null
  | boolean
  | number
  | string
  | WorkflowJson[]
  | { [key: string]: WorkflowJson };

export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  normalizedName: string;
  description: string;
  draft: WorkflowDraftGraph;
  completionPolicy: WorkflowCompletionPolicy;
  bindingDefaults: WorkflowBindingDefaults;
  draftRevision: number;
  currentVersionId: WorkflowVersionId | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Shipped with the application rather than authored here.
   *
   * A built-in workflow is app data, not operator data: it is not a row, it arrives already
   * published, and it can be neither edited, archived, nor published again. Duplicate is the
   * path to a customized copy, and that copy is an ordinary workflow like any other.
   */
  builtin: boolean;
}

export interface WorkflowVersion {
  id: WorkflowVersionId;
  workflowId: WorkflowId;
  version: number;
  sourceDraftRevision: number;
  graph: PublishedWorkflowGraph;
  completionPolicy: WorkflowCompletionPolicy;
  bindingDefaults: WorkflowBindingDefaults;
  publishedAt: number;
}

export type WorkflowVersionMetadata = Omit<WorkflowVersion, "graph">;

/** The bounded catalog projection carried over SSE. Graphs and guidance stay on HTTP. */
export interface WorkflowSummary {
  id: WorkflowId;
  name: string;
  description: string;
  draftRevision: number;
  currentVersionId: WorkflowVersionId | null;
  publishedVersion: number | null;
  archivedAt: number | null;
  updatedAt: number;
  errorCount: number;
  warningCount: number;
  nodeCount: number;
  personaCount: number;
  /** Mirrors `WorkflowDefinition.builtin` so the library row can say so without a detail fetch. */
  builtin: boolean;
}

export interface WorkflowDetail {
  workflow: WorkflowDefinition;
  versions: WorkflowVersionMetadata[];
}

export interface WorkflowBinding {
  id: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  noteKey: string;
  sessionId: string | null;
  /** Immutable compatibility facts captured when the binding was created or reattached. */
  sessionAgent: string;
  sessionName: string;
  sessionCwd: string | null;
  sessionRepoRoot: string | null;
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  state: WorkflowBindingState;
  maxRepairRounds: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: WorkflowRunId;
  bindingId: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  status: WorkflowRunStatus;
  currentPhase: string;
  maxRepairRounds: number;
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  inspectorPrKey: string | null;
  inspectorHeadSha: string | null;
  gateState: WorkflowJson | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  evidencePrunedAt?: number | null;
}

export interface WorkflowSubmission {
  id: WorkflowSubmissionId;
  runId: WorkflowRunId;
  round: number;
  mode: WorkflowSubmissionMode;
  triggerSource: WorkflowTriggerSource;
  triggerKey: string;
  evidenceFingerprint: string;
  context: WorkflowJson;
  evidence: WorkflowJson;
  prHeadSha: string | null;
  status: WorkflowSubmissionStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkflowNodeAttempt {
  id: WorkflowNodeAttemptId;
  submissionId: WorkflowSubmissionId;
  nodeId: string;
  attempt: number;
  state: WorkflowNodeAttemptState;
  persona: PersonaSnapshot | null;
  /** Actual provider/model resolved at attempt start. */
  runner: LlmRunnerId | null;
  model: string | null;
  verdict: WorkflowJson | null;
  output: WorkflowJson | null;
  retryAt: number | null;
  inputFingerprint: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowEdgeReceipt {
  id: number;
  submissionId: WorkflowSubmissionId;
  edgeId: string;
  sourceAttemptId: WorkflowNodeAttemptId;
  payload: WorkflowJson;
  createdAt: number;
}

export interface WorkflowDelivery {
  id: WorkflowDeliveryId;
  runId: WorkflowRunId;
  submissionId: WorkflowSubmissionId;
  kind: WorkflowDeliveryKind;
  sessionId: string;
  noteKey: string;
  payload: string;
  payloadSha256: string;
  state: WorkflowDeliveryState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  payloadPrunedAt?: number | null;
}

export interface WorkflowLlmCall {
  id: WorkflowLlmCallId;
  runId: WorkflowRunId;
  submissionId: WorkflowSubmissionId;
  nodeAttemptId: WorkflowNodeAttemptId | null;
  purpose: WorkflowLlmPurpose;
  runner: LlmRunnerId;
  model: string;
  attempt: number;
  state: WorkflowLlmCallState;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  inputBytes: number;
  outputBytes: number;
  costUsd: number | null;
  errorCode: string | null;
}

export interface WorkflowEvent {
  id: number;
  runId: WorkflowRunId;
  timestamp: number;
  kind: string;
  payload: WorkflowJson;
}

export interface WorkflowHumanDecision {
  decision: string;
  rationale: string | null;
  source: {
    kind: "transcript" | "review" | "foreman_episode";
    id: string;
  };
}

export interface PersonaFeedbackSummary {
  personaName: string;
  summary: string;
  requestedChanges: string[];
}

export interface WorkflowStandardsDocument {
  path: string;
  text: string;
  truncated: boolean;
  fingerprint: string;
}

export interface WorkflowTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface WorkflowContextSnapshot {
  primaryGoal: {
    rawPrompt: string;
    refined: string | null;
    sourceNoteKey: string;
  };
  humanDecisions: WorkflowHumanDecision[];
  constraints: string[];
  acceptanceCriteria: string[];
  priorPersonaFeedback: PersonaFeedbackSummary[];
  session: {
    agent: string;
    name: string;
    cwd: string | null;
    branch: string | null;
  };
  evidence: {
    headSha: string | null;
    diffFingerprint: string;
    diff: string;
    diffTruncated: boolean;
    workingTreeDirty: boolean;
    workingTreeStatus: string[];
    workingTreeStatusTruncated: boolean;
    transcript: WorkflowTranscriptMessage[];
    transcriptAnchor: number | null;
    transcriptTruncated: boolean;
    standards: WorkflowStandardsDocument[];
    standardsTruncated: boolean;
    retention?:
      | { state: "full" }
      | {
          state: "pruned";
          prunedAt: number;
          diffBytes: number;
          workingTreeStatusEntries: number;
          transcriptMessages: number;
          standardsDocuments: number;
        };
  };
  compaction: {
    status: "model" | "fallback";
    runner: LlmRunnerId | null;
    model: string | null;
    error: string | null;
  };
}

/**
 * Where a claim in a verdict came from, so a human can trace it to its source.
 *
 * APPEND-ONLY: a kind reaches durable `verdict_json`, and a build that cannot read one
 * fails the whole verdict at its zod boundary rather than dropping a citation.
 *
 * Declared here rather than spelled out at each of the three schemas that used to carry
 * their own copy of the list (`WorkflowEvidenceRefSchema`, `EvidenceInputSchema`, and this
 * type), because the model-facing schema and the strict one have to admit exactly the same
 * set - a kind added to one and not the other is a citation the model may produce and the
 * normalizer then rejects as an infrastructure parse failure.
 *
 * `check` is the Check node's, and it is a real kind rather than a relaxation of the
 * "every requested change cites something" rule. That rule exists so a human can trace a
 * claim to its source, and a command's own output IS that source - exempting the one
 * author whose evidence is machine-produced and exact would weaken the rule for the
 * strongest citation in the system.
 */
export const EVIDENCE_REF_KINDS = [
  "diff",
  "transcript",
  "standard",
  "goal",
  "decision",
  "check",
] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];

export interface EvidenceRef {
  kind: EvidenceRefKind;
  quote: string;
  path?: string;
  line?: number;
}

export interface RequestedChange {
  title: string;
  rationale: string;
  evidence: EvidenceRef[];
  path?: string;
  line?: number;
}

export type PersonaVerdict =
  | {
      verdict: "pass";
      summary: string;
      approvalDetails: {
        reason: string;
        evidence: EvidenceRef[];
      };
      confidence: number;
    }
  | {
      verdict: "fail";
      summary: string;
      requestedChanges: RequestedChange[];
      confidence: number;
    };

export interface WorkflowRunSummary {
  id: WorkflowRunId;
  bindingId: WorkflowBindingId;
  workflowId: WorkflowId;
  workflowName: string;
  workflowVersion: number;
  sessionId: string | null;
  noteKey: string;
  status: WorkflowRunStatus;
  phase: string;
  round: number;
  maxRepairRounds: number;
  activePersonaNames: string[];
  failedPersonaCount: number;
  bypassedPersonaReview: boolean;
  gate: WorkflowGateSummary;
  gatePrNumber: number | null;
  gateHeadShort: string | null;
  reviewPosture: InspectorPosture | null;
  uncertainDeliveryCount?: number;
  refusedDeliveryCount?: number;
  updatedAt: number;
}

export interface WorkflowInspectorGateDetail {
  state: WorkflowInspectorGateState;
  inspection: InspectorInspection | null;
  findings: InspectorComment[];
  inspector: {
    enabled: boolean;
    mode: InspectorMode;
    posture: InspectorPosture | null;
  };
}

export interface WorkflowRunDetail {
  summary: WorkflowRunSummary;
  binding: WorkflowBinding;
  version: WorkflowVersion | null;
  run: WorkflowRun;
  contextState: "captured" | "not_captured" | "corrupt";
  submissions: WorkflowSubmission[];
  attempts: WorkflowNodeAttempt[];
  receipts: WorkflowEdgeReceipt[];
  deliveries: WorkflowDelivery[];
  events: WorkflowEvent[];
  eventCount?: number;
  nextEventAfter?: number | null;
  llmCalls?: WorkflowLlmCall[];
  llmCallCount?: number;
  nextLlmCallAfter?: string | null;
  /**
   * Provenance for a run an external orchestrator started. Optional and detail-only: run
   * SUMMARIES travel over SSE for every run in the fleet and must stay compact.
   */
  externalSource?: WorkflowExternalSource | null;
  inspectorGate: WorkflowInspectorGateDetail | null;
}

export interface WorkflowRunPage {
  items: WorkflowRunSummary[];
  nextCursor: string | null;
}

export interface WorkflowEventPage {
  items: WorkflowEvent[];
  nextAfter: number | null;
}

export interface WorkflowLlmCallPage {
  items: WorkflowLlmCall[];
  nextAfter: string | null;
}

export interface WorkflowStatus {
  activeRuns: number;
  queuedPersonaCalls: number;
  runningPersonaCalls: number;
  waitingDeliveries: number;
  uncertainDeliveries: number;
  inspectorGates: number;
  lastRecoveryAt: number | null;
  lastRetentionAt: number | null;
  lastRetentionError: string | null;
  retainedRunCount: number;
  lastRetentionCompacted: number;
  lastRetentionDeleted: number;
}

export interface WorkflowExportEnvelope<T> {
  schemaVersion: 1;
  exportedAt: number;
  kind: "workflow_run" | "workflow_version";
  data: T;
}
