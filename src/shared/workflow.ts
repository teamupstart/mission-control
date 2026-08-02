import type { LlmRunnerId, ResolvedLlmRunner } from "./llm.ts";
import type { InspectorPosture } from "./inspector.ts";
import type { ModelChoiceSpec, ResolvedModel } from "./model-choice.ts";
import type {
  InspectorComment,
  InspectorInspection,
  InspectorMode,
  SessionIntentGuard,
} from "./types.ts";
import { providerModelDefault } from "./model.ts";
import { repoAllowlisted } from "./allowlist.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "./builtin-workflow.ts";

// Browser-safe workflow contracts. This module is intentionally data and pure helpers only:
// the daemon persists and executes these records, while the dashboard renders the same wire
// shapes. Nothing here may acquire a node: import.

export type PersonaId = string;
export type SessionActionId = string;
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
  sessionActionName: 100,
  sessionActionDescription: 500,
  /**
   * The exact instruction a SessionAction types into a session, in UTF-8 bytes.
   *
   * DERIVED from what can actually be delivered, not chosen: `sessionActionPacketBytes` less
   * `sessionActionEnvelopeBytes`. The two used to be set independently - a 100,000-byte
   * prompt against a 60,000-byte packet - and the gap between them was a published action
   * that types only a PREFIX of its immutable instruction. Truncating a repair packet loses
   * some of the daemon's own prose; truncating this changes the operation an operator asked
   * for, without failing the run. So the ceiling on what may be authored is exactly the
   * ceiling on what may be sent intact, and it is computed rather than restated.
   *
   * Enforced on create, on update, and on the published SNAPSHOT, so no version can carry a
   * prompt that cannot be delivered whole.
   */
  sessionActionPromptBytes: 58_000,
  /**
   * Headroom for everything the packet wraps the prompt in: the skill invocation, the action
   * and workflow names, the version and the run id.
   *
   * Every one of those is separately bounded and their sum is well under a kilobyte, so this
   * is deliberately generous - it is a guarantee, not a measurement, and the cost of being
   * generous is prompt bytes nobody was going to use.
   */
  sessionActionEnvelopeBytes: 2_000,
  /**
   * What may be STORED, which is looser than what may be authored or published.
   *
   * A row written before the prompt ceiling was tied to the packet budget stays readable, so
   * an operator can still see it, rename it, and shorten it. It simply cannot be published:
   * the snapshot schema holds it to `sessionActionPromptBytes`, which is what keeps an
   * undeliverable prompt out of every immutable version.
   */
  sessionActionPromptReadBytes: 100_000,
  /**
   * A skill id is a catalog NAME (`pull-request`), never an argv and never a path, so the
   * bound is conservative on purpose: anything long enough to hide a command line in is
   * already longer than any id the skills catalog can produce.
   */
  sessionActionSkillId: 200,
  /**
   * The delivered action packet, in UTF-8 bytes.
   *
   * Deliberately NOT `feedbackPayloadBytes`. A repair packet is a SUMMARY the daemon writes
   * from verdicts, so eight kilobytes is a design budget; an action packet carries the
   * operator's own authored instruction, and clipping that at the review budget would
   * silently deliver a different instruction from the one the version was published with.
   * The ceiling is instead the delivery row's own bound (`eventPayloadBytes`) less headroom,
   * and `sessionActionPromptBytes` is derived FROM this so the two cannot drift apart.
   */
  sessionActionPacketBytes: 60_000,
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
export function personaDescriptionFromMarkdown(
  markdown: string,
  maxLength: number = WORKFLOW_LIMITS.personaDescription,
): string {
  const body = markdown.replace(/^[\s\S]*?^#[^\S\r\n]+.*?$/m, "");
  const paragraph = (body === markdown ? markdown : body)
    .split(/(?:\r?\n){2,}/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#"));
  if (paragraph === undefined) return "";
  const collapsed = paragraph.replace(/\s+/gu, " ");
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// ---- SessionActions ---------------------------------------------------------
//
// A SessionAction is NOT a Persona with a different verb, and the two types are kept apart
// deliberately. A Persona selects an LLM runner and model, reads one immutable submission
// and returns a verdict. A SessionAction selects an instruction, an optional skill and a
// completion adapter, is typed into the BOUND session, and returns only "this finished".
// Widening `Persona` to carry both would make every reader of `PersonaSnapshot` - the
// engine's verdict path included - responsible for a record that produces no verdict.

/**
 * What the daemon must OBSERVE before an action counts as finished.
 *
 * APPEND-ONLY: these strings reach operator rows (`session_actions.completion_kind`) and
 * immutable published graphs, so renaming one does not migrate a version, it makes it
 * unreadable - and reading an unknown kind as `session_turn` would complete a historical
 * action under a weaker proof contract than the one it was published with.
 *
 * A completion kind names a CLOSED, server-owned adapter and never a script:
 *  - `session_turn`  - verified pickup followed by a settled idle turn.
 *  - `pull_request`  - the same turn boundary plus durable matching PR provenance.
 */
export const SESSION_ACTION_COMPLETION_KINDS = ["session_turn", "pull_request"] as const;
export type SessionActionCompletionKind = (typeof SESSION_ACTION_COMPLETION_KINDS)[number];

/**
 * An OBJECT rather than the bare kind string, so an adapter that later needs a parameter
 * gains one without reshaping every stored row and published snapshot that names it.
 */
export type SessionActionCompletion =
  | { kind: "session_turn" }
  | { kind: "pull_request" };

export interface SessionAction {
  id: SessionActionId;
  name: string;
  normalizedName: string;
  description: string;
  /**
   * Exact Markdown after UTF-8 decoding, whether operator-authored or shipped.
   *
   * Never trimmed, never newline-normalized, never variable-expanded, and never treated as
   * a template. Validation may look at its length and its emptiness and nothing else: this
   * is the literal text a session receives, and a boundary that "helpfully" rewrote it
   * would deliver an instruction nobody authored.
   */
  promptMarkdown: string;
  /**
   * A skill CAPABILITY id, never a command.
   *
   * The daemon resolves the harness-native invocation for this id immediately before it
   * sends, so a missing, disabled or drifted skill blocks before any write. Storing the
   * resolved command instead would put an argv into an exportable published version and
   * pin it to whatever the harness happened to spell it as on the publishing machine.
   */
  requiredSkillId: string | null;
  completion: SessionActionCompletion;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Shipped with the application rather than authored here. Exactly `Persona.builtin`:
   * app data, never a row, neither editable nor archivable, and Duplicate is the path to
   * a customized copy.
   */
  builtin: boolean;
}

/** SessionAction names use the same durable Unicode spelling rule as Persona names. */
export const normalizeSessionActionName = normalizePersonaName;

/** The name a SessionAction Markdown document carries: its first level-one heading. */
export const sessionActionNameFromMarkdown = personaNameFromMarkdown;

/** The one-line summary a SessionAction Markdown document carries. */
export function sessionActionDescriptionFromMarkdown(markdown: string): string {
  return personaDescriptionFromMarkdown(markdown, WORKFLOW_LIMITS.sessionActionDescription);
}

/**
 * The SessionActions a human is offered, with a live operator row SHADOWING a same-named
 * built-in. Deliberately the same rule as `personasForDisplay`, so the two libraries cannot
 * disagree about what a name collision means.
 */
export function sessionActionsForDisplay<
  T extends Pick<SessionAction, "archivedAt" | "builtin" | "normalizedName">,
>(actions: readonly T[]): T[] {
  const liveOperatorNames = new Set(
    actions
      .filter((action) => !action.builtin && action.archivedAt === null)
      .map((action) => action.normalizedName),
  );
  return actions.filter(
    (action) => !action.builtin || !liveOperatorNames.has(action.normalizedName),
  );
}

/**
 * The actions an ADD control may offer, which is a narrower question than what the library
 * lists.
 *
 * Two filters, and neither one is optional. `sessionActionsForDisplay` drops a built-in an
 * operator's row is shadowing and the archived rows go with it, because adding either would
 * bind a draft to a source the publish transaction is about to refuse. The second filter is
 * `available`, and it is passed IN rather than read from
 * `SESSION_ACTION_COMPLETION_CAPABILITIES` here on purpose: the daemon is the only thing
 * that knows which adapters this build can execute, and a browser that answered from its own
 * copy of the table would offer a stage whose graph the server then refuses to publish. The
 * caller hands over what `GET /api/session-actions/capabilities` said, and an empty set is an
 * honest "nothing is addable yet" rather than a silent fallback to everything.
 */
export function addableSessionActions<
  T extends Pick<SessionAction, "archivedAt" | "builtin" | "completion" | "normalizedName">,
>(actions: readonly T[], available: ReadonlySet<SessionActionCompletionKind>): T[] {
  return sessionActionsForDisplay(actions)
    .filter((action) => action.archivedAt === null && available.has(action.completion.kind));
}

/**
 * A picker's options: everything addable, plus a RETAINED entry for whatever a draft already
 * names.
 *
 * The retained arm is the whole reason this is not just `addableSessionActions`. A node may
 * point at an action that has since been archived, been shadowed by an operator's row of the
 * same name, or - as the built-in Pull Request does until its adapter ships - name a
 * completion this build cannot prove. In every one of those cases the option has to stay in
 * the list, because a `<select>` whose value is absent from its options renders as though
 * something else were selected, and the next change event would rewrite a draft nobody meant
 * to edit.
 */
export function sessionActionChoicesForDisplay<
  T extends Pick<SessionAction, "archivedAt" | "builtin" | "completion" | "id" | "normalizedName">,
>(
  actions: readonly T[],
  retainedIds: readonly string[],
  available: ReadonlySet<SessionActionCompletionKind>,
): Array<{ action: T; retained: boolean }> {
  const addable = addableSessionActions(actions, available);
  const addableIds = new Set(addable.map((action) => action.id));
  const retained = new Set(retainedIds);
  return [
    ...actions
      .filter((action) => retained.has(action.id) && !addableIds.has(action.id))
      .map((action) => ({ action, retained: true })),
    ...addable.map((action) => ({ action, retained: false })),
  ];
}

/**
 * What a retained option says about itself, in the order an operator needs to hear it.
 *
 * Unavailability comes FIRST because it is the only reason that is about this build rather
 * than about the catalog: the shipped Pull Request action is neither archived nor shadowed,
 * and labelling it "shadowed by your action" - which is what checking `builtin` first did -
 * would send an operator looking for a row of theirs that does not exist.
 */
export function sessionActionChoiceLabel(
  action: Pick<SessionAction, "archivedAt" | "builtin" | "completion" | "name">,
  retained: boolean,
  available: ReadonlySet<SessionActionCompletionKind>,
): string {
  if (!retained) return action.name;
  if (!available.has(action.completion.kind)) return `${action.name} (Not available in this build)`;
  if (action.archivedAt !== null) return `${action.name} (Archived)`;
  if (action.builtin) return `${action.name} (Built-in, shadowed by your action)`;
  return action.name;
}

/**
 * What an action's completion adapter proves, as the phrase a row or a rail prints.
 *
 * One function rather than the `kind === "pull_request" ? … : …` ternary that had started
 * appearing at every surface: the pipeline card, the graph rail, the version snapshot and
 * now the library each need this sentence, and four copies of a two-armed conditional is
 * four places to forget when a third adapter arrives. Reading the capability table's own
 * `label` keeps the wording the same as the selector an operator chose it from.
 */
export function sessionActionCompletionLabel(completion: SessionActionCompletion): string {
  // Falls back to the wire spelling rather than indexing into `undefined`. Catalog rows and
  // published snapshots reach the browser from a daemon that may be a version ahead, and the
  // kinds are explicitly append-only - so a third adapter would otherwise turn every list
  // row, stage card and run card that names one into a TypeError.
  return SESSION_ACTION_COMPLETION_CAPABILITIES[completion.kind]?.label ?? completion.kind;
}

/** The required skill as a phrase, including the honest answer when there is none. */
export function sessionActionSkillLabel(requiredSkillId: string | null): string {
  return requiredSkillId === null ? "No required skill" : `Skill · ${requiredSkillId}`;
}

/**
 * What a completion adapter PROVES, and whether this build can prove it.
 *
 * Shared rather than server-owned because three readers need the same answer and none of
 * them may invent one: graph validation refuses to publish a version naming an adapter this
 * build cannot run, the daemon's registry executes it, and the browser labels it. A second
 * list in any of the three is a surface offering a guarantee the runtime does not keep.
 *
 * `label` says what the runtime observes, never the wire spelling: an operator choosing
 * between adapters is choosing between proofs, not between identifiers.
 */
export interface SessionActionCompletionCapability {
  kind: SessionActionCompletionKind;
  available: boolean;
  label: string;
  /** One sentence a human can act on, or null when the adapter is available. */
  unavailableReason: string | null;
}

export const SESSION_ACTION_COMPLETION_CAPABILITIES: Record<
  SessionActionCompletionKind,
  SessionActionCompletionCapability
> = {
  session_turn: {
    kind: "session_turn",
    available: true,
    label: "Session turn finishes",
    unavailableReason: null,
  },
  pull_request: {
    kind: "pull_request",
    available: false,
    label: "Pull request is opened and verified",
    // A stable refusal rather than a placeholder that returns success. Completing a
    // `pull_request` action on the generic turn boundary alone would claim durable PR
    // provenance nobody checked, which is the one guarantee this adapter exists to make.
    unavailableReason:
      "This build cannot verify a pull request yet, so a workflow using this action cannot be published.",
  },
};

/**
 * Why a session action is still waiting. APPEND-ONLY: these strings reach a durable attempt's
 * `output_json` and a run's public projection, so a build that cannot read one fails the row
 * rather than guessing.
 *
 * Every one of them is a WAIT and not a failure: none of them may become a Persona verdict,
 * a repair packet, or a spent repair round.
 */
export const SESSION_ACTION_WAIT_REASONS = [
  /** The attempt exists and its one delivery has not been prepared yet. */
  "preparing",
  /** Prepared, and nothing has been typed - Preview, or Live waiting on authorization. */
  "awaiting_send",
  /** Sent, and nothing newer than the send anchor proves the session read it. */
  "awaiting_pickup",
  /** Proven picked up, and the turn has not settled. */
  "working",
  /** Picked up and parked on a question a human has to answer. Never a settled turn. */
  "needs_operator",
  /** Settled, and the completion adapter wants durable evidence it does not have yet. */
  "awaiting_proof",
  /** The adapter completed and the continuation segment is being captured. */
  "capturing",
] as const;
export type SessionActionWaitReason = (typeof SESSION_ACTION_WAIT_REASONS)[number];

/**
 * Why a session action can no longer proceed. APPEND-ONLY for `SESSION_ACTION_WAIT_REASONS`'
 * reason.
 *
 * A block is a RUN state and never a graph outcome: it blocks the run with an action-specific
 * diagnostic, spends no repair round, and never routes back to Session as a requested change.
 */
export const SESSION_ACTION_BLOCK_CODES = [
  "adapter_unavailable",
  "prompt_too_large",
  "required_skill_unavailable",
  "session_lost",
  "conversation_changed",
  "delivery_refused",
  "delivery_uncertain",
  "capture_failed",
  "expectation_unmet",
] as const;
export type SessionActionBlockCode = (typeof SESSION_ACTION_BLOCK_CODES)[number];

/**
 * What an adapter may require of the continuation capture, as a CLOSED union.
 *
 * Deliberately not an opaque JSON escape hatch. This value is persisted on the waiting
 * attempt and re-validated against a capture that may happen after a daemon restart, so an
 * unvalidated shape would be a durable field nothing can safely read back. Phase 4's PR
 * adapter adds its arm here rather than smuggling one through `unknown`.
 */
export type SessionActionContinuationExpectation =
  | { kind: "none" }
  | { kind: "head"; headSha: string };

/**
 * One adapter's answer once the generic observer has proven pickup and a settled turn.
 *
 * `complete` is the ONLY arm that advances the graph, and it always states its continuation
 * expectation explicitly so a capture cannot silently skip a check the adapter meant to make.
 */
export type SessionActionCompletionDecision =
  | { kind: "complete"; continuationExpectation: SessionActionContinuationExpectation }
  | { kind: "waiting"; reason: SessionActionWaitReason }
  | { kind: "blocked"; code: SessionActionBlockCode; detail: string };

/**
 * What the daemon proved about the packet it actually sent.
 *
 * Persisted so a restart can tell PRE-send session state from POST-send activity. Without it
 * the target session's ordinary idleness - which is the normal state immediately before a
 * packet is typed - would read as a finished turn on the very first observation.
 */
export interface SessionActionDeliveryAnchor {
  deliveryId: WorkflowDeliveryId;
  sessionId: string;
  noteKey: string;
  deliveredAt: number;
  /** Transcript bytes at confirmed send, or null when this harness exposes no transcript. */
  transcriptBytes: number | null;
}

/**
 * A waiting action attempt's durable observation state, carried in its `output_json`.
 *
 * On the ATTEMPT rather than the run, because a run holds at most one gate state while a
 * repair round may execute several actions in turn, and each one's anchor has to survive
 * independently for audit and recovery.
 */
export interface SessionActionAttemptState {
  wait: SessionActionWaitReason;
  deliveryId: WorkflowDeliveryId | null;
  anchor: SessionActionDeliveryAnchor | null;
  pickedUpAt: number | null;
  settledAt: number | null;
  expectation: SessionActionContinuationExpectation | null;
  continuationSubmissionId: WorkflowSubmissionId | null;
  blocked: { code: SessionActionBlockCode; detail: string } | null;
}

/**
 * The immutable copy a published version carries. Runtime code reads ONLY this: resolving
 * live library text during a run would let an edit change what an in-flight run types.
 */
export interface SessionActionSnapshot {
  sourceSessionActionId: SessionActionId;
  sourceRevision: number;
  name: string;
  description: string;
  promptMarkdown: string;
  requiredSkillId: string | null;
  completion: SessionActionCompletion;
}

/** The action half of `personaSnapshotOf`, and stated once for the same reason. */
export function sessionActionSnapshotOf(action: SessionAction): SessionActionSnapshot {
  return {
    sourceSessionActionId: action.id,
    sourceRevision: action.revision,
    name: action.name,
    description: action.description,
    promptMarkdown: action.promptMarkdown,
    requiredSkillId: action.requiredSkillId,
    completion: action.completion,
  };
}

/**
 * Whether history should report this snapshot's source as having moved on.
 *
 * A built-in is compared by its TEXT rather than its revision, exactly as
 * `personaSnapshotIsOutdated` does: a built-in's revision is a synthetic constant, so a
 * build shipping edited Markdown under the same revision would otherwise report as current.
 */
export function sessionActionSnapshotIsOutdated(
  snapshot: SessionActionSnapshot,
  current: SessionAction | null | undefined,
): boolean {
  if (!current) return true;
  if (current.builtin) {
    return snapshot.promptMarkdown !== current.promptMarkdown
      || snapshot.requiredSkillId !== current.requiredSkillId
      || snapshot.completion.kind !== current.completion.kind;
  }
  return snapshot.sourceRevision !== current.revision;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * APPEND-ONLY, for `WORKFLOW_CHECK_SLOTS`' reason: a port spelling reaches durable draft
 * and published edges, so renaming one orphans every version naming the old spelling.
 *
 * `complete` is a SessionAction's only source port, and it is deliberately not `pass`. A
 * pass says an evaluator judged the work acceptable; a complete says a turn the daemon
 * asked for finished. Reusing `pass` would let a Join treat "the session did the thing" as
 * a favourable verdict, and would invite a `fail` route back to Session for what is really
 * a delivery or infrastructure problem rather than a requested code change.
 */
export const WORKFLOW_SOURCE_PORTS = ["submitted", "pass", "fail", "complete"] as const;
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
  // A draft names the LIVE action; Publish resolves it to a snapshot. Same split as
  // `persona`, and for the same reason: a draft has to follow library edits, a version
  // must never see one.
  | { id: string; kind: "session_action"; sessionActionId: SessionActionId; position: Point }
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

/**
 * The immutable copy Publish freezes into a version.
 *
 * One function rather than an object literal at each publisher, because there are two - the
 * store's `publishWorkflow` and the built-in catalog's compile-time projection - and a field
 * added to the snapshot type but to only one of them is a version that silently ships
 * without it.
 */
export function personaSnapshotOf(persona: Persona): PersonaSnapshot {
  return {
    sourcePersonaId: persona.id,
    sourceRevision: persona.revision,
    name: persona.name,
    description: persona.description,
    guidanceMarkdown: persona.guidanceMarkdown,
    runner: persona.runner,
    model: persona.model,
  };
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
 * Persona and SessionAction are the two kinds whose published form differs, so every other
 * kind - including `check` - is carried through by the `Exclude`. A check node is
 * byte-identical in draft and published form because it snapshots nothing: its command is
 * deliberately not part of the version, which is the whole point of naming a slot.
 */
export type PublishedWorkflowNode =
  | Exclude<WorkflowDraftNode, { kind: "persona" | "session_action" }>
  | { id: string; kind: "persona"; persona: PersonaSnapshot; position: Point }
  | { id: string; kind: "session_action"; action: SessionActionSnapshot; position: Point };

/**
 * The kinds that return a `PersonaVerdict`. SessionAction is deliberately NOT one of them
 * and must never be added: every reader of this type treats its node as something that
 * passed or failed a review, and an action that finished has done neither.
 */
export type WorkflowVerdictNode = Extract<PublishedWorkflowNode, { kind: "persona" | "check" }>;

export function isVerdictNode(node: PublishedWorkflowNode): node is WorkflowVerdictNode {
  return node.kind === "persona" || node.kind === "check";
}

export function verdictAuthor(node: WorkflowVerdictNode): string {
  return node.kind === "persona" ? node.persona.name : `Check · ${node.slot}`;
}

export type WorkflowSessionActionNode = Extract<PublishedWorkflowNode, { kind: "session_action" }>;

/**
 * A NARROW guard beside `isVerdictNode` rather than a widening of it. Callers that ask
 * "did this node judge the work?" and callers that ask "did this node write to the
 * session?" are asking different questions, and one predicate answering both is how an
 * action's completion ends up rendered as a verdict.
 */
export function isSessionActionNode(
  node: PublishedWorkflowNode,
): node is WorkflowSessionActionNode {
  return node.kind === "session_action";
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
  "missing_complete_route",
  "session_action_join",
  "missing_session_action",
  "archived_session_action",
  "session_action_runtime_unavailable",
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

export const WORKFLOW_MISSING_PR_ACTIONS = [
  "wait",
  "offer_prepare_pr",
  "prepare_pr",
] as const;
export type WorkflowMissingPrAction = (typeof WORKFLOW_MISSING_PR_ACTIONS)[number];

export type WorkflowCompletionPolicy =
  | { kind: "none" }
  | {
      kind: "inspector";
      onFindings: InspectorFindingsPolicy;
      missingPrAction: WorkflowMissingPrAction;
    };

/**
 * Whether a parked repair round resumes itself once the agent has done the work.
 *
 * APPEND-ONLY: these strings are persisted in `workflows.resumption_policy` and
 * `workflow_versions.resumption_policy` on operators' machines, so renaming one does not
 * migrate a published version, it makes it unreadable.
 *
 * Deliberately NOT a member of `WorkflowCompletionPolicy`. That union is entirely about the
 * INSPECTOR final gate - `kind: "none"` means there is no such gate at all - while this
 * decides whether a run parked in `waiting_for_session` picks itself back up, which is a
 * question every pipeline has, including one with no Inspector node and no pull request.
 * Folding it into that union would make a repair loop unreachable for exactly the workflows
 * that have nothing else to fall back on.
 */
export const WORKFLOW_RESUMPTION_POLICIES = ["manual", "auto"] as const;
export type WorkflowResumptionPolicy = (typeof WORKFLOW_RESUMPTION_POLICIES)[number];

/**
 * What a NEW draft gets, and what a row written before this column existed READS AS - and the
 * two are deliberately different values.
 *
 * A fresh workflow is authored today, by someone who can see the setting, so it gets the loop
 * that actually closes (`auto`). A NULL column is a version published by a build that had no
 * such concept: its operator never chose anything, its packets ended by asking the model to
 * "signal completion", and something already relies on it standing still. Reading that as
 * `auto` would silently start resubmitting runs on machines that upgraded, so it reads as
 * `manual` and every already-published version keeps behaving exactly as it was published.
 */
export const DEFAULT_WORKFLOW_RESUMPTION_POLICY: WorkflowResumptionPolicy = "auto";
export const LEGACY_WORKFLOW_RESUMPTION_POLICY: WorkflowResumptionPolicy = "manual";

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
  triggerMode: "foreman_complete",
  deliveryMode: "preview",
  maxRepairRounds: 5,
};

export const WORKFLOW_BINDING_STATES = ["active", "paused", "orphaned", "archived"] as const;
export type WorkflowBindingState = (typeof WORKFLOW_BINDING_STATES)[number];

/**
 * APPEND-ONLY: persisted in `workflow_runs.status` on operators' machines.
 *
 * `waiting_for_action` is deliberately NOT `waiting_for_session`, even though both mean the
 * daemon is watching the same pane. `waiting_for_session` is a parked REPAIR round: the
 * resumption observer picks it up, the round budget applies, and a resubmission starts the
 * graph again from Session. An action wait is none of those - it resumes only the completed
 * action's downstream route, on fresh evidence, without spending a repair round - so sharing
 * the status would hand every action turn to the resumption observer to resubmit.
 */
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
  "waiting_for_action",
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

/**
 * Infrastructure lifecycle only. Persona pass/fail is stored separately as a verdict.
 *
 * APPEND-ONLY: persisted in `workflow_node_attempts.state`.
 *
 * `waiting` is a session action's own state and belongs to none of the others. It is not
 * `queued` (nothing will claim it from the runnable list and it occupies no model execution
 * slot), not `running` (no provider call is in flight and a restart must not retry it), and
 * not `completed` (its outgoing receipt has not been written). Collapsing it into any of
 * them would either spend a review slot on a session that is typing, or advance the graph
 * before the action turn finished.
 */
export const WORKFLOW_NODE_ATTEMPT_STATES = [
  "queued",
  "running",
  "retry_wait",
  "completed",
  "error",
  "cancelled",
  "waiting",
] as const;
export type WorkflowNodeAttemptState = (typeof WORKFLOW_NODE_ATTEMPT_STATES)[number];

/**
 * What a delivered packet IS. APPEND-ONLY, for `EVIDENCE_REF_KINDS`' reason: these strings
 * reach durable rows, so a build that cannot read a persisted kind fails the whole row at its
 * zod boundary rather than degrading. Add to the end; never rename, never remove.
 *
 * `unchanged_evidence_nudge` is the odd one out and deliberately so. The other three carry a
 * REVIEW's output to the session. This one carries the loop's own refusal: the session said it
 * was done, the evidence fingerprint was byte-identical to the round that asked for changes, and
 * capture refused. Without a packet that refusal is silent and terminal - the completion guard
 * is already spent by the time capture runs, so nothing would ever ask again. See
 * `renderUnchangedEvidenceNudge`.
 */
export const WORKFLOW_DELIVERY_KINDS = [
  "persona_feedback",
  "inspector_feedback",
  "pr_handoff",
  "unchanged_evidence_nudge",
  // An authored graph node's instruction, linked to the ONE attempt that owns it. Appended
  // beside `pr_handoff` rather than replacing it: every version published from 5 through 7
  // reaches its pull request through the legacy post-End path, and those rows have to stay
  // readable and recoverable exactly as they are.
  "session_action",
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
 *
 * `session` is the engine's own resumption observer: a repair round it started because the
 * bound session went idle with new work under a version whose `resumptionPolicy` is `auto`.
 * It is its own source rather than `foreman` because the Foreman never saw it - the daemon
 * did - and a run's history has to say which of the two moved it.
 */
export const WORKFLOW_TRIGGER_SOURCES = ["manual", "foreman", "ensemble", "session"] as const;
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
  /**
   * Machine-wide authorisation to TYPE a repair packet into a session's pane.
   *
   * On by default, and that is only half a gate. `repoAllowlist` is the other half and stays
   * empty, so a fresh install authorises delivery in NO repository until a human names one:
   * `repoAllowlisted(cwd, repoRoot, [])` is false for every path. `deliveryBlock` asks both in
   * one place and refuses with `live_not_authorized`, which is a visible reason on the run
   * rather than silence.
   *
   * Off by default would be the safer-looking choice and is the wrong one. It makes the
   * repair loop dead on arrival for everybody - the packet is prepared, never sent, and the
   * run parks forever - while the allowlist already carries the consent this flag looks like
   * it is carrying. Two gates that both default closed means the second one never gets read.
   */
  liveEnabled: boolean;
  repoAllowlist: string[];
  /**
   * Workflow identity preselected for new single-agent dispatches, or null for none.
   *
   * The identity is resolved to its then-current immutable published version when the
   * dispatched session is bound. Keeping the workflow id here means publishing a new version
   * updates the default without rewriting machine settings, while each resulting binding still
   * pins one immutable version.
   */
  defaultWorkflowId: WorkflowId | null;
  retention: WorkflowRetentionConfig;
  /**
   * Machine-wide consent for running a configured command from a workflow. Off by default -
   * deliberately NOT following `liveEnabled`, which is now on. Delivery types text a human
   * reads before anything happens; a check executes an argv on disk unattended, which is a
   * different question and gets its own answer. `repoAllowlist` is still the other half, and
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
  // Authorised, and gated on `repoAllowlist` being non-empty. See the field's docstring: an
  // empty allowlist authorises nothing, so this changes nothing for a repository nobody named.
  liveEnabled: true,
  repoAllowlist: [],
  // Store the stable workflow identity, not today's version. A task resolves it to the
  // newest immutable shipped version when its session is armed (v5 in this build), while
  // an explicit null in Settings or the dispatch form remains an opt-out.
  defaultWorkflowId: NO_MISTAKES_REVIEW_WORKFLOW_ID,
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
 *
 * A nested entry has a THIRD way to match, and it is the one that carries the common case.
 * Absolute containment alone selects `/repo/packages/web` only for a session standing under
 * that literal path - but a dispatched session stands in a pooled worktree under
 * `~/.treehouse/`, whose `cwd` is outside `/repo` entirely while its `repoRoot` still names
 * `/repo`. Containment therefore falls through to the repository-wide entry, so the package
 * override would work for a plain checkout and silently never for a dispatched one. A
 * worktree mirrors its repository's layout, so the entry's repository-relative subpath is
 * matched against `location.checkoutSubpath` - the session's position within its OWN
 * checkout, compared by whole path components.
 */
export function checkCommandFor(
  config: Pick<WorkflowConfig, "checkCommands">,
  location: CheckLocation,
  slot: WorkflowCheckSlot,
): WorkflowCheckCommand | null {
  let best: WorkflowCheckCommand | null = null;
  for (const entry of config.checkCommands) {
    if (entry.slot !== slot) continue;
    if (!checkCommandApplies(entry.repoRoot, location)) continue;
    if (!best || entry.repoRoot.length > best.repoRoot.length) best = entry;
  }
  // The whole ENTRY, not just its argv. The matched root is not decoration: when a nested
  // entry wins, it is also the directory that command has to run in, and a caller handed
  // only the argv has no way to know that - it would run the package's command at the top
  // of the repository and report the answer as the package's.
  return best ? { ...best, command: [...best.command] } : null;
}

/** Drop a single trailing separator so `/repo/` and `/repo` compare equal. */
function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Where a session stands, in the three vocabularies resolution needs.
 *
 * `checkoutSubpath` is the session's directory relative to its OWN checkout root, derived
 * by whoever can ask git - `null` when nobody did. It exists because the other two cannot
 * answer the question for a dispatched session: `cwd` is an absolute path inside a pooled
 * worktree, `repoRoot` names the main checkout, and nothing about either says which
 * directory OF THE REPOSITORY the session is in.
 */
export interface CheckLocation {
  cwd: string | null;
  repoRoot: string | null;
  checkoutSubpath: string | null;
}

/** Whether `inner` is `outer` or sits beneath it, compared by whole path components. */
function subpathWithin(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Whether one configured entry applies to a session, by any of the three routes.
 *
 * Split out so the third route is stated once and can be tested directly: the other two are
 * containment tests, and this one is the only place resolution can pick the wrong package.
 */
function checkCommandApplies(entryRoot: string, location: CheckLocation): boolean {
  // The two containment routes: the session stands inside the entry, or the entry covers
  // the session's whole repository.
  if (repoAllowlisted(location.cwd, location.repoRoot, [entryRoot])) return true;
  // The worktree route, for an entry nested inside THIS session's repository.
  //
  // Compared as a COMPONENT PATH against the session's checkout-relative directory, not as
  // a trailing substring of its absolute one. A substring match reads
  // `<worktree>/examples/packages/web` as `packages/web`, then runs the command in
  // `packages/web` of the leased checkout - silently testing a different package from the
  // one the submission was written in, and reporting that as the submission's answer. A
  // repository containing both `examples/packages/web` and `packages/web` is ordinary, so
  // "the same trailing path means the same directory" is simply not true.
  //
  // `null` declines rather than falling back to the looser rule: an unknown position is not
  // evidence of a match, and the repository-wide entry is the correct thing to land on.
  if (!location.repoRoot || location.checkoutSubpath === null) return false;
  const entrySubpath = checkCommandSubpath(location.repoRoot, entryRoot);
  if (!entrySubpath) return false;
  return subpathWithin(trimSlash(location.checkoutSubpath), entrySubpath);
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
  const root = trimSlash(repoRoot);
  const path = trimSlash(requestedPath);
  return path === root || path.startsWith(`${root}/`) ? path : root;
}

export function checkCommandSubpath(
  repoRoot: string | null,
  entryRoot: string,
): string {
  if (!repoRoot) return "";
  const root = trimSlash(repoRoot);
  const entry = trimSlash(entryRoot);
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
   * The one server-owned fallback the Foreman wrap-up setting may request.
   *
   * This is a closed capability rather than a workflow id supplied by the worker: the
   * daemon resolves the current built-in No-Mistakes Review version, and only when this
   * completion reaches a conversation with no active binding. Existing bindings always win.
   */
  fallbackWorkflow: "builtin-review" | null;
  expectedIntent: SessionIntentGuard | null;
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
  /** Frozen into every version this draft publishes. See `WORKFLOW_RESUMPTION_POLICIES`. */
  resumptionPolicy: WorkflowResumptionPolicy;
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
  /**
   * Immutable for the life of this version, exactly like `completionPolicy`. The resumption
   * observer reads it off the run's PINNED version, never off the draft, so editing a
   * workflow can never change how a run already in flight behaves.
   */
  resumptionPolicy: WorkflowResumptionPolicy;
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
  /**
   * Verdict node ids (Persona or Check) the operator disabled FOR THIS RUN ONLY.
   *
   * A disabled node auto-passes instead of running - the operator's way of forcing a gate
   * past a reviewer that keeps failing for reasons outside the work under review. It lives
   * on the run rather than the version because the version is immutable and shared: other
   * runs of the same workflow must keep running the gate. Optional so a detail payload
   * written by an older daemon still parses; absent reads as "nothing disabled".
   */
  disabledNodeIds?: string[];
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  evidencePrunedAt?: number | null;
}

export interface WorkflowSubmission {
  id: WorkflowSubmissionId;
  runId: WorkflowRunId;
  /**
   * Which REPAIR round this evidence belongs to. Only a fail/repair transition increments
   * it, and `maxRepairRounds` compares this and nothing else.
   */
  round: number;
  /**
   * Which immutable evidence snapshot within that round. Zero for every initial and repair
   * submission; a completed session action creates `segment + 1`.
   *
   * Continuation is NOT repair, and this is the field that keeps the two apart. Reusing the
   * parent submission would make upstream and downstream attempts claim they reviewed the
   * same evidence when the action turn changed it; creating a repair round instead would
   * restart the graph at Session and burn budget an action never earned.
   */
  segment: number;
  /** The segment this one continues from, or null at segment zero. */
  parentSubmissionId: WorkflowSubmissionId | null;
  /** The action node whose completion authorized this segment, or null at segment zero. */
  continuationNodeId: string | null;
  /**
   * The action ATTEMPT whose completion authorized this segment, or null at segment zero.
   *
   * That attempt belongs to the PARENT submission. The cross-submission link is deliberate
   * provenance - the action ran against the parent evidence and its completion authorized
   * downstream work against this one - and it is the only cross-submission receipt source
   * the store admits.
   */
  continuationNodeAttemptId: WorkflowNodeAttemptId | null;
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
  /**
   * The action this attempt is executing, copied from the run's immutable version.
   *
   * Its OWN field rather than a widening of `persona`, for the reason `SessionAction` is not
   * a `Persona`: every reader of `persona` treats the record as something that produces a
   * verdict. The copy exists so history, recovery diagnostics and retention stay readable
   * without re-resolving a live library entity, exactly as the Persona snapshot does.
   */
  sessionAction: SessionActionSnapshot | null;
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
  /**
   * The node attempt that owns this packet, for `session_action` only; null for every other
   * kind, including every historical `pr_handoff` row.
   *
   * Required for an action because two action nodes in one submission would otherwise be
   * indistinguishable to the delivery ledger - the packet identity is `(submission, kind,
   * payload sha)`, and two actions could legitimately share a payload. It is also what makes
   * recovery able to ask "does this waiting attempt already own a delivery?" without
   * guessing from timestamps.
   */
  nodeAttemptId: WorkflowNodeAttemptId | null;
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

export interface WorkflowRepeatOffender {
  nodeId: string;
  personaName: string;
  /** Consecutive most-recent rounds this member failed. Always >= 2. */
  rounds: number;
}

/**
 * One repeat offender, named with the run it is burning rounds on.
 *
 * Its own type rather than a field on `WorkflowRunSummary` because summaries travel over SSE
 * for every run in the fleet and must stay compact - the same reason `WorkflowRunDetail`
 * carries the list. This projection exists for the ALERT engine, which needs the run's
 * identity beside the member's; it is daemon-computed and reaches `AlertScope` the way
 * `Stall` does, on its own channel rather than by widening the summary.
 */
export interface WorkflowRunRepeatOffender extends WorkflowRepeatOffender {
  runId: WorkflowRunId;
  workflowName: string;
  sessionId: string | null;
  /** The run's latest round, so an alert can say how much of the budget is gone. */
  round: number;
  maxRepairRounds: number;
}

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
  /**
   * The latest evidence segment inside `round`. Optional so a summary written by an older
   * daemon still parses in a newer browser; absent reads as zero, which is what every run
   * predating continuations genuinely was.
   */
  segment?: number;
  /**
   * Why the run's session action is waiting, when one is. Detail lives on run detail; this
   * is the one compact fact a fleet-wide summary carries so a surface never has to re-derive
   * it from attempts or live session activity.
   */
  actionWait?: SessionActionWaitReason | null;
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
   * Members failing the most recent rounds consecutively. Detail-only and OPTIONAL: run
   * SUMMARIES travel over SSE for every run in the fleet and must stay compact, and an older
   * daemon serving a newer browser must not fail to parse.
   */
  repeatOffenders?: WorkflowRepeatOffender[];
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
  /** EVERY run row, of any status. Not the population any retention limit caps. */
  retainedRunCount: number;
  /**
   * The runs `retention.maxCompletedRuns` actually caps: finished (completed or cancelled)
   * families with a completion time and no uncertain delivery holding them back.
   *
   * A separate field rather than a nicer reading of `retainedRunCount`, because the two
   * answer different questions and the difference is the whole point of showing it. A limit
   * of 1000 rendered against a count that includes every active, blocked and failed run is
   * a gauge that moves for reasons the limit beside it cannot cause.
   */
  completedRunCount: number;
  /**
   * Deliveries confirmed typed into a session among retained run families. Compaction keeps
   * their state, while deleting a run family removes its deliveries from this count.
   */
  deliveredDeliveries: number;
  lastRetentionCompacted: number;
  lastRetentionDeleted: number;
}

export interface WorkflowExportEnvelope<T> {
  schemaVersion: 1;
  exportedAt: number;
  kind: "workflow_run" | "workflow_version";
  data: T;
}
