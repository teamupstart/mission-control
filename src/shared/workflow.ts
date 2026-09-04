import { LLM_IMAGE_LIMITS, type LlmRunnerId, type ResolvedLlmRunner } from "./llm.ts";
import type { RasterImageMimeType } from "./images.ts";
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
import {
  NO_MISTAKES_REVIEW_WORKFLOW_ID,
  parseBuiltinWorkflowVersionId,
} from "./builtin-workflow.ts";

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
  /** One run-scoped instruction placed ahead of a Persona's published guidance. */
  personaDirectiveBytes: 8_000,
  /**
   * The stored `PersonaProvenance` blob, in UTF-8 bytes.
   *
   * Generous against the sum of its own bounded fields (two 4096-byte paths, a short version,
   * a 64-character hash) because it is a read ceiling rather than a budget: its job is to stop
   * one malformed write from making every later read of that row expensive.
   */
  personaProvenanceJsonBytes: 16_000,
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
  /** The legacy flat `checkCommands` list, across every slot. Still the PUT route's bound. */
  checkCommands: 200,
  /**
   * Overrides one Command slot may carry.
   *
   * The same number as the flat ceiling above, applied per SLOT because the slot is now the
   * unit of both storage and update. That is no looser than before for any single slot - one
   * slot could always have used the whole flat budget - and it deliberately does not divide
   * the old ceiling by four, which would have made a legitimate existing config unmigratable.
   * The aggregate ceiling is therefore four times the old one; both are far above any real
   * configuration, and the bound's job is to stop one write making every later read expensive.
   */
  commandOverrides: 200,
  /**
   * The floor under a Command's per-run execution budget.
   *
   * ONE, not zero. Zero would read as "never run this gate", and that is a decision this
   * catalog already expresses by leaving the slot unconfigured - a second way to say it
   * would be a second thing to check before believing a gate is active, and the one an
   * operator is least likely to look at.
   */
  commandMaxRunsMin: 1,
  /**
   * The ceiling on the same budget: `repairRoundsMax` PLUS ONE, and the plus one is the point.
   *
   * A run is an initial submission followed by up to `repairRoundsMax` repair rounds - a new
   * one is created while `round <= maxRepairRounds`, so the highest round a run can reach is
   * `maxRepairRounds + 1`. A check node runs at most once per submission, so that is also the
   * most times a Command can execute in one run. Setting the ceiling to `repairRoundsMax`
   * alone would leave the option labelled "every round" one execution short, and the last
   * repair round an operator paid for would skip the gate they asked to run every time.
   *
   * Derived from the round ceiling rather than written as a number, so the two cannot drift
   * apart if that ceiling ever moves.
   */
  commandMaxRunsMax: 21,
  checkCommandArgs: 32,
  checkCommandArg: 1_000,
  checkCommandLength: 4_000,
} as const;

/**
 * Worst-case bytes one character of a bounded string can become, once JSON-encoded as UTF-8.
 *
 * Every character ceiling in `WORKFLOW_LIMITS` is exactly that - a count of UTF-16 code units,
 * which is what `z.string().max()` measures. It is NOT a byte count, so any byte budget derived
 * from one has to carry the expansion or it refuses payloads the schema accepts: a 4,096-
 * character repository path of CJK or emoji is four times that many bytes on the wire, and a
 * request rejected before validation is a 413 an operator cannot read a reason out of.
 *
 * SIX rather than four, and the extra two are not padding. Four is the widest UTF-8 encoding, but
 * JSON escapes a control character to `\u00XX`, which is six ASCII bytes for one code unit - and
 * `parseCheckCommand` accepts a tab inside a quoted argument, so a control character in a stored
 * argv is a shape this product supports rather than a hypothetical.
 */
export const JSON_UTF8_MAX_BYTES_PER_CHAR = 6;

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

/**
 * Workflow evidence inherits Phase 1's provider limits and adds bounds for durable metadata.
 * These are browser-safe because every intake surface and every retained row must agree.
 */
export const WORKFLOW_IMAGE_LIMITS = {
  ...LLM_IMAGE_LIMITS,
  captionChars: 1_000,
  displayNameChars: 200,
  clientItemIdChars: 200,
  relativePathChars: 4_096,
  uploadIdChars: 200,
  locatorJsonBytes: 64 * 1_024,
} as const;

/**
 * Bounded text or log evidence registered beside workflow screenshots.
 *
 * The aggregate stays below one model-facing review section, even before the manifest and
 * fence framing are added. A focused test transcript is normally a few kilobytes; 64 KiB per
 * item leaves room for a useful failure tail without allowing one log to dominate the immutable
 * 2 MB workflow context.
 */
export const WORKFLOW_TEXT_EVIDENCE_LIMITS = {
  maxCount: 8,
  maxBytesPerArtifact: 64 * 1_024,
  maxAggregateBytes: 192 * 1_024,
  captionChars: 1_000,
  displayNameChars: 200,
  clientItemIdChars: 200,
  relativePathChars: 4_096,
  locatorJsonBytes: 64 * 1_024,
} as const;

export type WorkflowEvidenceRepositoryScope = "all" | `repo-${string}`;
export type WorkflowEvidenceImageAvailability = "retained" | "pruned";

/** Browser-safe audit metadata. Storage and source paths never enter this record. */
export interface WorkflowEvidenceImage {
  id: string;
  ordinal: number;
  displayName: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
  mimeType: RasterImageMimeType;
  bytes: number;
  sha256: string;
  availability: WorkflowEvidenceImageAvailability;
  prunedAt: number | null;
  createdAt: number;
}

export interface WorkflowEvidenceTextArtifact {
  id: string;
  ordinal: number;
  displayName: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
  mimeType: "text/plain";
  bytes: number;
  sha256: string;
  /** Exact UTF-8 text frozen at submission capture; empty only after raw-evidence pruning. */
  content: string;
  availability: WorkflowEvidenceImageAvailability;
  prunedAt: number | null;
  createdAt: number;
}

/** A staged item visible to a bound session or the Phase 3 evidence composer. */
export interface WorkflowStagedEvidenceImage {
  id: string;
  clientItemId: string;
  sourceKind: "agent" | "upload" | "retained";
  /** Child-supplied registration locator; consumers must keep it inside evidence fences. */
  sourceLocator: string;
  /** Resolved intent episode at registration, or null for legacy/unresolved evidence. */
  episodeKey: string | null;
  displayName: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
  mimeType: RasterImageMimeType;
  bytes: number;
  sha256: string;
  generation: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStagedEvidenceTextArtifact {
  id: string;
  clientItemId: string;
  sourceKind: "agent" | "command";
  /** Child-supplied path or command; consumers must keep it inside evidence fences. */
  sourceLocator: string;
  /** Resolved intent episode at registration, or null for legacy/unresolved evidence. */
  episodeKey: string | null;
  displayName: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
  mimeType: "text/plain";
  bytes: number;
  sha256: string;
  generation: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStagedEvidenceList {
  generation: number;
  images: WorkflowStagedEvidenceImage[];
  artifacts: WorkflowStagedEvidenceTextArtifact[];
}

export interface WorkflowAgentEvidenceLocator {
  kind: "agent";
  clientItemId: string;
  path: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
}

export interface WorkflowAgentTextEvidenceLocator {
  kind: "text";
  clientItemId: string;
  path: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
}

/** Completed command output supplied directly through the workflow evidence transport. */
export interface WorkflowAgentCommandEvidenceLocator {
  kind: "command";
  clientItemId: string;
  command: string;
  exitCode: number;
  output: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
}

/**
 * One canonical rendering for direct command evidence, shared by validation and capture.
 *
 * The explicit command and exit code make the retained artifact useful even when a harness
 * transcript intentionally omits tool-result bodies. This is evidence the agent reports from a
 * completed command, not a daemon execution endpoint; Check nodes remain the server-observed path.
 */
export function workflowCommandEvidenceContent(
  item: Pick<WorkflowAgentCommandEvidenceLocator, "command" | "exitCode" | "output">,
): string {
  return [
    `Command: ${item.command}`,
    `Exit code: ${item.exitCode}`,
    "Output:",
    item.output,
  ].join("\n");
}

export interface WorkflowUploadEvidenceLocator {
  kind: "upload";
  clientItemId: string;
  uploadId: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
}

export type WorkflowEvidenceLocator =
  | WorkflowAgentEvidenceLocator
  | WorkflowUploadEvidenceLocator;

export interface WorkflowRetainedEvidenceLocator {
  imageId: string;
  clientItemId: string;
  caption: string;
  repositoryScope: WorkflowEvidenceRepositoryScope;
}

export interface WorkflowSubmissionEvidenceImages {
  submissionId: WorkflowSubmissionId;
  images: WorkflowEvidenceImage[];
}

export const WORKFLOW_PERSONA_MODEL_ENV = "WORKFLOW_PERSONA_MODEL";
export const WORKFLOW_PERSONA_MODEL_SPEC: ModelChoiceSpec = {
  label: "Workflow Persona",
  envVar: `MISSION_${WORKFLOW_PERSONA_MODEL_ENV}`,
  fallback: providerModelDefault("claude", "balanced"),
  blurb: "Reviews workflow evidence with this Persona. An individual Persona override wins.",
};

/**
 * Where an imported Persona's guidance came from, so drift against it can be SEEN.
 *
 * Recorded once, at import, and rewritten only by a re-import. It is a fact about a live
 * catalog row and deliberately NOT part of `PersonaSnapshot`: a published version carries its
 * own copy of the guidance, and that copy's authority comes from the publish, not from a file
 * that may since have changed. Drift is therefore a diff a human adopts by re-importing and
 * republishing - never something applied to a version behind their back.
 *
 * Field names are persisted inside `personas.import_provenance_json`, so they are
 * additive-only. A blob this build cannot read degrades to null rather than failing the row:
 * an unreadable provenance record must not hide a working reviewer.
 */
export interface PersonaProvenance {
  /**
   * The absolute path the operator named, resolved for `.` and `..` but NOT through symlinks.
   *
   * The link is deliberately left unresolved because it is part of what the operator pointed
   * at: a plugin install whose `references/` is a symlink is re-read through that link on
   * every drift check, so a plugin upgrade that re-points it is upstream CHANGE rather than a
   * provenance record silently pinned to a stale target. Containment and file-type checks run
   * again on each read, on the resolved path, for exactly that reason.
   */
  sourcePath: string;
  /**
   * The enclosing git worktree root, when one was found by walking up from the file.
   *
   * Discovered from the RESOLVED path, unlike `sourcePath` beside it, so these two can disagree
   * about their prefix for a document reached through a link - which is correct rather than
   * sloppy. What owns a file is a property of where its bytes live; where to re-read it is a
   * property of what the operator pointed at.
   */
  sourceRepo: string | null;
  /**
   * `version` from the nearest `.claude-plugin/plugin.json` above the file, when readable.
   *
   * Found from the resolved path too, for the same reason - a role file symlinked out of an
   * installed plugin still belongs to that plugin's version.
   */
  pluginVersion: string | null;
  /**
   * A version-INDEPENDENT identity for a document imported from an installed plugin catalog.
   *
   * `<marketplace>/<plugin>/<path within the plugin>`, and null for every Persona an operator
   * imported by naming a path. It exists because `sourcePath` cannot answer the question the
   * boot-time catalog sync has to ask. An installed plugin lives at
   * `…/cache/<marketplace>/<plugin>/<version>/…`, so the path of a role document CHANGES on
   * every plugin upgrade: keyed on `sourcePath`, the sync would find no match after an upgrade
   * and import all eleven roles a second time under conflicting names. Keyed on this, an
   * upgrade is recognised as the same document at a new revision of its plugin - which is
   * exactly what the drift badge is for.
   *
   * Never a containment or trust claim. It is a name for "the same document as last boot", and
   * the reads that follow are validated on their own terms like every other import.
   */
  sourceKey: string | null;
  /**
   * The catalog to credit in the UI - `"UpstartClaw"` - or null for an operator's own import.
   *
   * STORED rather than derived from `sourceKey`'s marketplace segment, so that no part of the
   * product has to map a marketplace's directory name onto a human name. The registry that
   * names the plugin also names the catalog, once; every reader downstream renders this string
   * and knows nothing about who supplied it. That is what keeps the Persona library, the sort
   * order and the sidebar tag generic while still being able to say `UpstartClaw` out loud.
   */
  catalogLabel: string | null;
  /** sha256 of the exact bytes read, hex. The one thing a drift check compares. */
  contentSha256: string;
  importedAt: number;
}

/**
 * What a re-read of an imported Persona's source found.
 *
 * `missing` is "the path no longer yields a readable document" and covers more than absence -
 * a directory in its place, a file grown past the guidance ceiling, bytes that stopped being
 * valid UTF-8. All of them mean the same thing to an operator: the upstream this Persona
 * claims cannot be compared right now, so no badge may claim it is current.
 */
export type PersonaUpstreamState = "current" | "changed" | "missing";

/** One imported Persona's upstream verdict, fetched on request rather than streamed. */
export interface PersonaDriftView {
  id: PersonaId;
  upstream: PersonaUpstreamState;
}

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
  /** Set only for a Persona imported from a file on the daemon's machine; null otherwise. */
  provenance: PersonaProvenance | null;
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

/**
 * The keys a Persona document may carry in YAML frontmatter, if it carries any at all.
 *
 * Deliberately TWO keys and no YAML parser. Plugin-authored role documents lead with a
 * frontmatter block that states the role's title and its one-line function, and those two
 * facts are better than what the Markdown rules below can infer from the same file: a role
 * whose heading reads `# The Reviewer` and whose first paragraph is `**Speech pattern:**
 * Terse, declarative, verdict first…` yields a name nobody chose and a description that
 * describes prose style rather than the role.
 *
 * The subset understood here is the subset those documents use: a block fenced by `---` at the
 * very start of the file, `key: value` at column zero, and a value that may continue onto
 * following MORE-INDENTED lines. Anything else in the block is skipped rather than rejected -
 * this is a reader of two fields, not a validator of somebody else's file, and a document it
 * cannot understand falls through to the heading rules unchanged.
 */
const PERSONA_FRONTMATTER_KEYS = ["role-title", "function"] as const;

type PersonaFrontmatterKey = (typeof PERSONA_FRONTMATTER_KEYS)[number];

/**
 * The frontmatter fields a document declares, or an empty record when it declares none.
 *
 * Exported for its tests. Values arrive whitespace-collapsed because a folded YAML scalar is a
 * single logical string that happens to be wrapped, and every consumer here wants the string.
 */
export function personaFrontmatter(
  markdown: string,
): Partial<Record<PersonaFrontmatterKey, string>> {
  // The block has to open on the very first line, which is what makes this unambiguous: a
  // `---` further down a document is a horizontal rule or a section break, never frontmatter.
  const opened = /^---[^\S\r\n]*\r?\n/.exec(markdown);
  if (!opened) return {};
  const rest = markdown.slice(opened[0].length);
  const closed = /^---[^\S\r\n]*(?:\r?$|\r?\n)/m.exec(rest);
  if (!closed) return {};
  const lines = rest.slice(0, closed.index).split(/\r?\n/);
  const out: Partial<Record<PersonaFrontmatterKey, string>> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z][\w-]*):[^\S\r\n]*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1] as PersonaFrontmatterKey;
    const parts = [match[2] ?? ""];
    // A value continues while the following lines are indented further than the key, which is
    // how the plain multi-line scalars in these documents wrap. Stopping at the first
    // unindented line is what keeps the NEXT key out of this value.
    while (index + 1 < lines.length && /^[^\S\r\n]+\S/.test(lines[index + 1] ?? "")) {
      index += 1;
      parts.push(lines[index] ?? "");
    }
    if (!PERSONA_FRONTMATTER_KEYS.includes(key)) continue;
    const value = parts.join(" ").replace(/\s+/gu, " ").trim();
    // First declaration wins, and an empty value is not a declaration: both keep a malformed
    // block from erasing a name the heading rule could still have supplied.
    if (value.length > 0 && out[key] === undefined) out[key] = value;
  }
  return out;
}

/**
 * The name a Persona document carries, preferring its frontmatter over its heading.
 *
 * The single rule every reader of an authored document uses, so a role file imported by hand
 * and the same file adopted by the plugin catalog sync arrive under ONE name. That mattered
 * enough to widen `personaNameFromMarkdown`'s remit rather than add a second rule beside it:
 * two derivations would meet at the unique index and present as a name conflict nobody caused.
 */
export function personaNameFromDocument(markdown: string, fallback: string): string {
  return personaFrontmatter(markdown)["role-title"]
    ?? personaNameFromMarkdown(markdown, fallback);
}

/** The one-line summary a Persona document carries, preferring frontmatter `function`. */
export function personaDescriptionFromDocument(
  markdown: string,
  maxLength: number = WORKFLOW_LIMITS.personaDescription,
): string {
  const declared = personaFrontmatter(markdown).function;
  if (declared === undefined) return personaDescriptionFromMarkdown(markdown, maxLength);
  // Truncated by the same rule as a derived description rather than a bare slice, so one
  // ceiling and one ellipsis serve both spellings.
  return declared.length <= maxLength
    ? declared
    : personaDescriptionFromMarkdown(`# x\n\n${declared}`, maxLength);
}

/**
 * Where a Persona sits in the library's ordering, before names are compared.
 *
 * Three tiers, because the catalog now has three ORIGINS and a flat alphabetical list buries
 * the distinction: the reviewers shipped with the build, the reviewers an installed plugin
 * catalog supplied, and the operator's own. Shipped first as the product's own foundation,
 * the supplied catalog next, and the operator's own last - where they stay in one predictable
 * place instead of being scattered through eleven role names they did not write.
 *
 * Ranked in the STORE rather than the sidebar so every surface that lists Personas - the
 * library, the pickers, a workflow's reviewer choices - agrees about order without each one
 * re-deriving it.
 */
export function personaOriginRank(
  persona: Pick<Persona, "builtin" | "provenance">,
): number {
  if (persona.builtin) return 0;
  return persona.provenance?.catalogLabel != null ? 1 : 2;
}

/**
 * One upstream verdict, from a stored hash and whatever a fresh read of the path found.
 *
 * Here rather than in the daemon that reads the file so the comparison has exactly one
 * spelling: the route derives it, the badge renders it, and a unit test exercises it without
 * a filesystem. Comparing HASHES rather than text keeps the whole document out of the reply.
 */
export function personaUpstreamState(
  provenance: Pick<PersonaProvenance, "contentSha256">,
  observed: { contentSha256: string } | null,
): PersonaUpstreamState {
  if (observed === null) return "missing";
  return observed.contentSha256 === provenance.contentSha256 ? "current" : "changed";
}

/**
 * The words every surface uses for an upstream state, or null when there is nothing to say.
 *
 * `current` renders no badge at all - "up to date with a file on this machine" is the ordinary
 * case, and a chip for it would put a tag on most of the library and teach the eye to skip
 * the two that matter.
 */
export function personaUpstreamLabel(state: PersonaUpstreamState): string | null {
  if (state === "changed") return "upstream changed";
  if (state === "missing") return "source missing";
  return null;
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
 *  - `repo_commit`   - the same turn boundary plus a commit in the bound checkout, made after
 *                      the session was proven to have read the instruction.
 */
export const SESSION_ACTION_COMPLETION_KINDS = [
  "session_turn",
  "pull_request",
  "repo_commit",
] as const;
export type SessionActionCompletionKind = (typeof SESSION_ACTION_COMPLETION_KINDS)[number];

/**
 * An OBJECT rather than the bare kind string, so an adapter that later needs a parameter
 * gains one without reshaping every stored row and published snapshot that names it.
 */
export type SessionActionCompletion =
  | { kind: "session_turn" }
  | { kind: "pull_request" }
  | { kind: "repo_commit" };

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
    available: true,
    label: "Pull request is opened and verified",
    unavailableReason: null,
  },
  repo_commit: {
    kind: "repo_commit",
    available: true,
    label: "A commit lands in the checkout",
    unavailableReason: null,
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
  /**
   * Settled, and no adopted pull request yet names this repository and branch.
   *
   * Its own reason rather than `awaiting_proof` because the two point at different work. This
   * one means the turn produced no pull request Mission Control can see, and the operator's
   * remedy is about the session or the PR itself; `awaiting_pushed_head` below means the pull
   * request exists and the commit has not reached it.
   */
  "awaiting_pull_request",
  /** A matching pull request exists and its observed remote head is not the local head yet. */
  "awaiting_pushed_head",
  /**
   * This action's own turn opened a pull request, and it is against a DIFFERENT repository.
   *
   * Its own reason rather than `awaiting_pull_request`, because the two are opposite problems
   * wearing the same words. "No pull request yet" is something waiting can fix; this is the
   * turn having produced one and sent it somewhere else - a second checkout of another
   * repository, usually - and no amount of waiting moves it. A single "awaiting" state left an
   * operator watching for a pull request that had already been opened where they were not
   * looking.
   */
  "pull_request_wrong_repository",
  /**
   * This action's own turn opened a pull request on this repository, from another BRANCH.
   *
   * Distinct from the repository case because the remedy is: the work is in the right project
   * and the pull request is off the wrong head - a branch that was never switched, or one
   * pushed before the last checkout.
   */
  "pull_request_wrong_branch",
  /**
   * Prepared, and held because another repository's review is using this conversation's turn.
   *
   * A multi-repo task's session runs one review per repository it changed, and they share one
   * pane and one turn. At most one of them may have a delivery outstanding at a time: two
   * instructions typed into one conversation interleave into a turn neither expects, and the
   * pickup anchor that proves an action was read cannot tell which of them the session
   * answered. So the others hold HERE, explicitly, rather than racing.
   *
   * Its own reason rather than `awaiting_send`, which means "ready, and Preview never types"
   * or "ready, waiting on authorization". This one is ready, authorized, and deliberately
   * queued - it clears on its own the moment the sibling's turn is accounted for, and an
   * operator who reads `awaiting_send` on a Live binding would go looking for a consent
   * problem that is not there.
   */
  "queued_for_conversation",
] as const;
export type SessionActionWaitReason = (typeof SESSION_ACTION_WAIT_REASONS)[number];

/**
 * The wait reasons no amount of waiting clears - a person has to act.
 *
 * The list above is mostly the daemon waiting on ITSELF: `awaiting_send`, `awaiting_pickup`,
 * `working`, `awaiting_proof`, `capturing`, `awaiting_pull_request` and `awaiting_pushed_head`
 * all resolve on their own, and a surface that lit them amber would report a healthy run as
 * blocked for most of its life. These three do not: `needs_operator` is a session parked on a
 * question, and the two `pull_request_wrong_*` reasons are, in their own words, states "no
 * amount of waiting moves".
 *
 * APPEND-ONLY alongside `SESSION_ACTION_WAIT_REASONS`.
 */
export const SESSION_ACTION_OPERATOR_WAIT_REASONS: readonly SessionActionWaitReason[] = [
  "needs_operator",
  "pull_request_wrong_repository",
  "pull_request_wrong_branch",
];

/** True when this wait is one only a person can end. */
export function sessionActionWaitsOnOperator(
  reason: SessionActionWaitReason | null | undefined,
): boolean {
  return reason != null && SESSION_ACTION_OPERATOR_WAIT_REASONS.includes(reason);
}

/**
 * True when this RUN is stopped on something only a person can clear.
 *
 * The Line's Review fold and the Review drawer both count these, and the drawer marks
 * exactly these rows. Stated once, here, because the two are the same claim rendered at two
 * grains: a strip that says one run needs you, above a drawer that marks none, is the
 * surface arguing with itself - and both readings would be defensible if each carried its
 * own copy of the rule.
 *
 * `blocked`, an operator-only action wait, and a parked repair round that will not resume
 * itself.
 *
 * That third arm used to be absent, on the stated grounds that `waiting_for_session` is the
 * workflow's ordinary repair loop and "the session will resubmit on its own". That is true
 * under `auto` resumption AND `live` delivery, and false under every other posture - so the
 * runs it excluded were not the ones the daemon was about to resume, they were precisely the
 * ones nothing would ever resume. A manual version or a Preview binding parks a round that
 * only a human Resubmit can clear, and this predicate is what puts it on screen; see
 * `workflowRunResumesItself` for why an ABSENT policy still reads as self-resuming.
 *
 * `waiting_for_new_head` is deliberately still absent, and it is not an oversight: that run
 * waits on a PUSHED head, which is the bound session's job and not the operator's. Nothing a
 * person can click moves it. It is not silent, though - the stall detector counts it as
 * outstanding work against the session (`workOutstanding` in `stall.ts`), which is the
 * clock-based signal a status this inert actually needs.
 *
 * This predicate is the WHOLE of "does a person owe this run anything". How that total is
 * SAID - one number, or the two `workflowRunAttentionSplit` reports - is presentation, and
 * splitting the sentence must never narrow the predicate.
 */
export function workflowRunWaitsOnOperator(
  run: Pick<
    WorkflowRunSummary,
    "status" | "actionWait" | "resumptionPolicy" | "deliveryMode"
  >,
): boolean {
  if (run.status === "blocked") return true;
  if (sessionActionWaitsOnOperator(run.actionWait)) return true;
  return run.status === "waiting_for_session" && !workflowRunResumesItself(run);
}

/** The two halves of `workflowRunWaitsOnOperator`, counted so they cannot overlap. */
export interface WorkflowRunAttentionSplit {
  /** Waiting on a person, and a person's answer still moves it. */
  needsYou: number;
  /** Stopped. No answer restarts it from here; it is dismissed, reattached, or it stays. */
  stalled: number;
}

/**
 * "1 needs you · 31 stalled" - one number for what you owe, one for what is simply dead.
 *
 * `workflowRunWaitsOnOperator` is a UNION, and a run can satisfy both of its arms at once:
 * `orphanBinding` blocks a run whose session action was already parked on `needs_operator`.
 * So the split is defined by SUBTRACTION rather than by two independent filters -
 * `needsYou + stalled` is exactly the old single total, and a run counted twice would have
 * the strip claiming more attention than the fleet owes.
 *
 * Blocked wins the overlap, and that is the truer reading rather than a tie-break: a blocked
 * run cannot act on an action wait at all, because `orphanBinding` cancelled its attempts on
 * the way past. Answering its question would move nothing.
 */
export function workflowRunAttentionSplit(
  runs: readonly Pick<
    WorkflowRunSummary,
    "status" | "actionWait" | "resumptionPolicy" | "deliveryMode"
  >[],
): WorkflowRunAttentionSplit {
  const stalled = runs.filter((run) => run.status === "blocked").length;
  const waiting = runs.filter(workflowRunWaitsOnOperator).length;
  return { needsYou: waiting - stalled, stalled };
}

/**
 * The split as the parts a sentence is joined from, empty halves dropped.
 *
 * PARTS rather than a finished string, because the strip joins with `line-summary.ts`'s own
 * `sentence()` helper - which is what turns them into the " · " the accessible name rewrites
 * to commas - while the drawer header joins them itself. The WORDS live here so the two
 * surfaces cannot drift: `foldReview`'s doc comment requires them to read the same, and a
 * strip saying "stalled" over a drawer saying "blocked" is that promise broken quietly.
 *
 * "needs/need you" is the Working stage's own plural, so one fleet vocabulary covers both.
 */
export function workflowRunAttentionParts(split: WorkflowRunAttentionSplit): string[] {
  return [
    split.needsYou > 0 ? `${split.needsYou} need${split.needsYou === 1 ? "s" : ""} you` : "",
    split.stalled > 0 ? `${split.stalled} stalled` : "",
  ].filter((part) => part.length > 0);
}

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
  /**
   * The pull request this action's work belongs to is closed or merged.
   *
   * A BLOCK rather than a wait, and the only one the pull request adapter raises. Every other
   * way a PR can fail to match - not opened yet, opened on another branch, head not pushed,
   * `gh` unreachable for a tick - is a state that a later observation can change on its own,
   * so those wait. A closed pull request is a durable contradiction: nothing the daemon waits
   * for will reopen it, and a human has to decide whether to reopen, replace or abandon it.
   */
  "pull_request_closed",
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
  /**
   * The pull request adapter's proof, carried forward so the capture can be held to it.
   *
   * Every field is something the adapter VERIFIED before it said complete, written down so a
   * capture that happens later - possibly after a daemon restart, possibly after the checkout
   * moved - can be checked against the same facts rather than against whatever is true by
   * then. `expectedHeadOid` is the load-bearing one: the adapter proved this exact commit is
   * the pull request's remote head, so a child segment captured at any other commit is
   * evidence of work the pull request does not contain.
   *
   * Bounded and provider-neutral on purpose. No credentials, no `gh` output, no diff: this is
   * durable attempt state that run detail renders and export carries.
   */
  | {
      kind: "pull_request";
      /** `owner/repo#number`, the same identity the adoption ledger is keyed by. */
      pullRequestKey: string;
      pullRequestUrl: string;
      pullRequestNumber: number;
      /** The local repository root the adoption was matched against. */
      repositoryRoot: string;
      /** The head branch the pull request was observed to be opened from. */
      branch: string;
      /** The commit the pull request's remote head was observed at. */
      expectedHeadOid: string;
      /** When that observation was made, so provenance can say how fresh the proof was. */
      observedAt: number;
    };

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
  // "Command", not the wire kind. The node is serialized as `check` forever - see
  // `WorkflowCommandView` - and every surface a person reads says Command.
  return node.kind === "persona" ? node.persona.name : `Command · ${node.slot}`;
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

/**
 * The statuses a run cannot leave. Everything else is still on its way somewhere.
 *
 * `blocked` IS DELIBERATELY NOT HERE, and the reason is worth the paragraph because the
 * omission looks like an oversight from two directions at once.
 *
 * A `blocked` run has stopped, so "terminal" reads right - and adding it would, in one
 * line, end the permanent Shipping veto a `round_limit` run holds over its pull request.
 * That is exactly why it must not be added. `blocked` is the status of a gate that did
 * NOT pass: the reviewer ran out of repair rounds with findings still open. Marking it
 * terminal would make `workflowRunIsOpen` false, `mergeGate` return "none", and YOLO
 * mode merge the branch - so "the reviewer gave up" would become "the reviewer approved
 * it", which is precisely the bypass the veto was built to prevent. A workflow that
 * exhausted its budget is the LAST thing that should auto-merge.
 *
 * The second direction: `blocked` is not even reliably an ending. `session_disappeared`
 * blocks a run a Reattach can revive, and a `round_limit` run comes back the moment an
 * operator grants it more rounds. `workflowRunIsOpen` also drives board drop targets,
 * held-session marks, and the ＋ bind chip, all of which mean "this session is still
 * spoken for" - which a blocked run genuinely is.
 *
 * So the veto stays, and the fix for a run that will never clear on its own is to say so
 * and offer a way out, not to stop vetoing: `workflowRunGaveUp` below separates "still
 * working" from "gave up", Shipping reports the two as different blocks, and run detail
 * carries the controls that clear it. See "Blocked runs are recoverable, not terminal" in
 * `docs/workflows.md`.
 *
 * Worth knowing before acting on this list: it is NOT the only place the three terminal
 * statuses are written down. `workflow_runs` queries in the store spell the same set as a
 * literal `status NOT IN ('completed', 'cancelled', 'failed')` in around a dozen
 * statements, including the `activeRunForBinding` that the Shipping veto reads. Editing
 * this array alone therefore moves the browser and leaves the daemon where it was - which
 * is a quieter failure than it sounds, so a fourth terminal status means changing both.
 */
export const WORKFLOW_RUN_TERMINAL_STATUSES = ["completed", "cancelled", "failed"] as const;

/**
 * Whether a run is still going, as one predicate rather than a status list per surface.
 *
 * Stated here, beside the status union, because "is this run finished" is a question the
 * browser answers in several places and the union is append-only: a fourth terminal status
 * added to the list above must reach every reader at once, and a surface carrying its own
 * copy of the array is how one of them would keep counting a finished run as live.
 */
export function workflowRunIsOpen(status: WorkflowRunStatus): boolean {
  return !(WORKFLOW_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The statuses in which a run is stopped waiting for THE BOUND SESSION to do something.
 *
 * Both mean the same thing to a person watching: the reviewer has said its piece, the packet
 * is in the pane, and nothing moves until that session acts. They are un-parked by different
 * machinery - `waiting_for_session` by the resumption observer, a Foreman claim or a human
 * Resubmit, and `waiting_for_new_head` only by the Inspector poller observing a PUSHED head -
 * which is exactly why a surface asking "is this session still on the hook" must not pick one
 * of them. `waiting_for_new_head` has no local observer at all, so the status a session is
 * most likely to be stranded in is the one a hand-written list forgets.
 *
 * Deliberately NOT `waiting_for_pr`, `waiting_for_inspector` or `waiting_for_action`.
 * The first two wait on machinery rather than on the session's next turn, and an action wait
 * is already its own vocabulary with its own operator/machine split (`actionWait`) - folding
 * it in here would count it twice.
 */
export const WORKFLOW_RUN_SESSION_PARKED_STATUSES = [
  "waiting_for_session",
  "waiting_for_new_head",
] as const;

/** True when the run is stopped waiting on its bound session's next turn. */
export function workflowRunParkedOnSession(status: WorkflowRunStatus): boolean {
  return (WORKFLOW_RUN_SESSION_PARKED_STATUSES as readonly string[]).includes(status);
}

/**
 * True when a round parked in `waiting_for_session` will pick itself back up.
 *
 * BOTH halves are required, and that is the correction this predicate exists to make. The
 * resumption observer resumes a run only under a version whose `resumptionPolicy` is `auto`
 * (`resumableRun`), and only after a packet was actually delivered - which a `preview`
 * binding never does, because Preview prepares and never types. Either half missing means
 * the run sits there until a human clicks Resubmit.
 *
 * ABSENCE READS AS SELF-RESUMING, which is not the reading the persisted columns use, and the
 * difference is deliberate. A NULL `resumption_policy` COLUMN reads as `manual` because a
 * version published before the column existed must keep standing still. An ABSENT field on
 * this summary is a different fact entirely: a daemon that does not report the setting at
 * all. Reading that as `manual` would take every parked run on an older daemon - including
 * the ones it is busily resuming on its own 15-second timer - and put them on a person's
 * plate. So absence preserves exactly the behaviour that shipped before this field existed,
 * and the field is what changes it.
 */
export function workflowRunResumesItself(
  run: Pick<WorkflowRunSummary, "resumptionPolicy" | "deliveryMode">,
): boolean {
  return (run.resumptionPolicy ?? "auto") === "auto" && (run.deliveryMode ?? "live") === "live";
}

/**
 * The phases in which a run has spent its repair budget and cannot open another round.
 *
 * Every writer sets the phase `round_limit` today, so that is the only live entry.
 * `inspector_round_limit` is DEFENSIVE, not a second live spelling: the Inspector gate's
 * new-head re-test writes `round_limit` as the phase and `inspector_round_limit` only as
 * the event kind, and run detail already carries a phase label for it on the same "this
 * costs one line and removes a class of bug" reasoning. It is listed so that a future
 * writer which does set it as a phase is classified as spent rather than as still working,
 * which is the failure this predicate exists to prevent.
 */
export const WORKFLOW_RUN_SPENT_PHASES = ["round_limit", "inspector_round_limit"] as const;

/**
 * Has this run given up - stopped in a way that will NEVER clear on its own?
 *
 * The distinction this draws is the whole point of leaving `blocked` non-terminal (see
 * `WORKFLOW_RUN_TERMINAL_STATUSES`). "Blocked" spans a run a Reattach revives and a run
 * whose budget is gone, and only the second one is a dead end: the Inspector gate re-tests
 * `round > maxRepairRounds` on EVERY new head, so pushing more commits re-enters the same
 * refusal. The operator cannot push their way out, and a surface that cannot tell the two
 * apart has to describe a permanent stop with the same words it uses for a live review.
 *
 * Stated here, beside the status union, so the daemon's Shipping veto and the browser's
 * run detail answer it identically - the same reason `workflowRunIsOpen` lives here.
 */
export function workflowRunGaveUp(run: {
  status: WorkflowRunStatus;
  phase: string;
  round: number;
  maxRepairRounds: number;
}): boolean {
  if (run.status !== "blocked") return false;
  if (!(WORKFLOW_RUN_SPENT_PHASES as readonly string[]).includes(run.phase)) return false;
  // The BUDGET, not just the phase. `round_limit` is a historical marker of how the run
  // stopped and it never gets rewritten; the live question is whether another round is
  // affordable, which is the same `round > maxRepairRounds` inequality every writer of the
  // phase tested on the way in. Reading the budget is what lets granting rounds downgrade
  // this to "still working" the instant it lands, with no second revival path to keep in
  // step - the existing resume and full-restart moves gate on the same inequality and come
  // back by themselves.
  return workflowRunHasNoRepairsLeft(run);
}

/**
 * Whether the run is on the last round its repair budget can afford.
 *
 * `maxRepairRounds` counts repairs after the initial submission, so round
 * `maxRepairRounds + 1` is legal but cannot be followed by another repair. Kept separate from
 * `workflowRunGaveUp` because the budget fact applies to completed runs too; only the latter also
 * requires a blocked, spent run.
 */
export function workflowRunHasNoRepairsLeft(run: {
  round: number;
  maxRepairRounds: number;
}): boolean {
  return run.round > run.maxRepairRounds;
}

/**
 * The phase a run was parked in before its budget ran out, recorded on the way into
 * `round_limit` so a later grant can put it back.
 *
 * A run that spends its budget loses the only record of what it was waiting for: the
 * round-limit block overwrites `current_phase` with `round_limit` and `gate_state_json`
 * with the budget, and neither is recoverable afterwards. That was survivable while a
 * grant only ever handed the run to a human's next click. It is not survivable now that a
 * grant may hand it back to the resumption observer, which needs the run to read as the
 * parked round it actually is - `pr_handoff` in particular takes a different branch there
 * than an ordinary repair round does.
 *
 * So the phase rides along in the same payload as the budget, written by the one store
 * helper every round-limit writer goes through. It is deliberately NOT re-recorded on a
 * second block: a run blocked, granted, resumed and blocked again must keep pointing at
 * the round it was parked in, not at `round_limit` itself.
 *
 * Absence is meaningful and is the reason this returns `null` rather than a default. A run
 * blocked by a build that predates this field cannot say what it was doing, and guessing
 * would restore a run into a phase whose branch never ran. Those runs keep the behaviour
 * they were blocked under: the grant raises the budget and the operator resumes by hand.
 */
export function workflowRoundLimitParkedPhase(gateState: WorkflowJson | null): string | null {
  if (!gateState || typeof gateState !== "object" || Array.isArray(gateState)) return null;
  const parked = (gateState as { [key: string]: WorkflowJson }).parkedPhase;
  if (typeof parked !== "string" || parked.length === 0) return null;
  if ((WORKFLOW_RUN_SPENT_PHASES as readonly string[]).includes(parked)) return null;
  return parked;
}

/**
 * The phase a run carries while its last resubmission was refused for naming work that
 * does not exist yet - the repository has not moved since the round that asked for it.
 *
 * It sits beside `unchanged_evidence` rather than reusing it because the two refusals
 * measure different things and are recovered at different costs. `unchanged_evidence`
 * compares the captured, compacted snapshot and is only reachable after a capture has
 * already been paid for. This one compares two git reads taken BEFORE a submission row
 * exists, so refusing costs nothing and spends no round. Both are answered by the same
 * "review it anyway" move, which is why both are listed as unchanged-evidence phases in
 * the browser; only the sentence above the button differs.
 */
export const WORKFLOW_UNCHANGED_REPOSITORY_PHASE = "unchanged_repository";

/**
 * Why the resumption observer declined to open the next repair round this tick.
 *
 * Every one of these was previously a bare `return null` inside `resumableRun`, which is
 * why "the session never resubmitted" was unanswerable from the dashboard: the observer
 * looked, decided not to act, and left no trace anywhere. Naming the reasons is the whole
 * fix - the run page can then say which gate held instead of showing a parked run and no
 * explanation at all.
 *
 * `repository_unchanged` is the one an operator will see most, and it is not a fault: it
 * is the observer correctly refusing to spend a round on a repair that changed no code.
 */
export const WORKFLOW_RESUMPTION_WITHHELD_REASONS = [
  "policy_manual",
  "binding_inactive",
  "session_unavailable",
  "session_busy",
  "session_needs_you",
  "packet_undelivered",
  "repository_unchanged",
] as const;

export type WorkflowResumptionWithheldReason =
  (typeof WORKFLOW_RESUMPTION_WITHHELD_REASONS)[number];

/**
 * What the run page says about a withheld resumption, in the operator's language.
 *
 * One sentence each, and each one names what would change it. These are read by run detail
 * and by nothing else; the daemon stores the reason code, never the prose, so re-wording
 * this never invalidates a ledger entry.
 */
export function workflowResumptionWithheldSentence(
  reason: string,
  round: number,
): string | null {
  switch (reason) {
    case "policy_manual":
      return "This workflow version was published before automatic resumption existed, so the"
        + " next round waits for you rather than for the session.";
    case "binding_inactive":
      return "The review is no longer attached to a live session, so nothing is watching for"
        + " the repair.";
    case "session_unavailable":
      return "The bound session is gone or has been replaced, so the repair packet has no"
        + " reader.";
    case "session_busy":
      return "The session is still working. The next round opens once it settles.";
    case "session_needs_you":
      return "The session is waiting on you - a permission prompt or a dialog - so it has not"
        + " been handed another round.";
    case "packet_undelivered":
      return "The repair packet has not reached the session yet, so there is nothing for it to"
        + " have repaired.";
    case "repository_unchanged":
      return `Waiting on the session: the repository has not changed since round ${round}.`
        + " Reviewing it again would return the same verdicts, so no round has been spent.";
    default:
      return null;
  }
}

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
  // One reminder for a repair round that has been parked, with its packet delivered and its
  // repository untouched, for longer than a session doing the work would take. Appended
  // rather than folded into `unchanged_evidence_nudge`, which answers a claim the session
  // actually made; this one answers a silence, and the two have to stay distinguishable in a
  // ledger a person reads to work out why a run sat still.
  "parked_repair_reminder",
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

/**
 * What one repository runs for one slot, in the LEGACY flat shape.
 *
 * Retained as the wire projection `GET /api/workflows/config` still answers with and the
 * shape `PUT` still accepts, so the Settings form keeps working while the durable catalog
 * moves underneath it. It is no longer a persisted shape: see `WorkflowCommandView`, which
 * is the one authority, and `legacyCheckCommands`, which flattens it back to this.
 */
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

/**
 * One repository or subdirectory exception to a Command's machine-wide default.
 *
 * No `slot`: an override only ever exists inside the slot that owns it, and repeating the
 * slot on the row would be a second place for it to disagree with its parent.
 */
export interface WorkflowCommandOverride {
  repoRoot: string;
  command: string[];
}

/**
 * The complete durable state of ONE portable Command slot - the grouped view every surface
 * reads and the only persisted command authority in the daemon.
 *
 * Grouped rather than flat because the slot is the unit an operator reasons about ("what
 * does `test` run on this machine, and where is that not true?") and, more load-bearing, the
 * unit of the atomic write: one CAS replaces the nullable default AND the complete override
 * set together, so a surface can never commit half of a slot's configuration.
 *
 * All four built-in slots are always projected, in `WORKFLOW_CHECK_SLOTS` order, including
 * the ones nobody has configured. A slot that vanished until it was written would make
 * "unconfigured" indistinguishable from "not loaded" for every reader.
 */
export interface WorkflowCommandView {
  slot: WorkflowCheckSlot;
  /**
   * What this slot runs when no override matches - repository-neutral, and null when the
   * operator has not named one.
   *
   * Deliberately NOT inferred from any override during migration. That a repository runs
   * `npm test` is not evidence the same argv is correct, or safe, in every other checkout
   * a workflow may reach.
   */
  defaultCommand: string[] | null;
  /** Unique by `repoRoot` within the slot, canonical paths, longest match wins. */
  overrides: WorkflowCommandOverride[];
  /**
   * How many times this Command may actually EXECUTE inside one workflow run, across every
   * repair round, before the gate that would have run it is skipped instead.
   *
   * A property of the Command rather than of the node that names it, because the cost this
   * bounds is the command's own: a test suite that takes twenty minutes takes twenty minutes
   * in every workflow that gates on it, and an operator who has decided that suite is worth
   * running once per run should not have to re-decide it in each graph.
   *
   * So the allowance is SHARED by every check node resolving to this slot, not handed to each
   * of them. A graph gating on `test` twice spends one execution between the two, and with a
   * limit of one the second is skipped inside the same round. Per-node budgets would make this
   * number mean "how many times each place a workflow mentions the command may run it", which
   * is not what an operator setting a maximum on the command itself has said - and would let a
   * limit of one execute a twenty-minute suite twice in one round.
   *
   * The default is 1, and that is a deliberate statement about where the remaining coverage
   * comes from: the first round gates on a real execution, and the repair rounds after it
   * lean on CI, which runs the full suite against the merge commit anyway. Raising it buys
   * re-validation of a repair at the cost of running the suite again.
   *
   * Counts EXECUTIONS, not opportunities. A round in which the gate was skipped for a budget
   * it had already spent, an unconfigured slot, a repository the operator has not granted, or
   * a build with no execution runtime never reached a command, so none of them spend a run -
   * `WorkflowStore.reserveCheckRun` is claimed at the moment the ladder decides to spawn, and
   * nothing above that rung claims one. An infrastructure retry is the same execution asked
   * again and is bounded separately by `MAX_INFRA_ATTEMPTS`.
   */
  maxRuns: number;
  /** Compare-and-swap token. Starts at 1 for a seeded, never-edited slot. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * How many times a Command executes per run when nobody has said otherwise.
 *
 * ONE, which is a behaviour change for every catalog that existed before this field and is
 * meant to be: the gate used to re-run in full on every repair round, and the time that spent
 * is the whole reason this setting exists. Stated as a named constant because three places
 * have to agree on it - the column default an upgrading database takes, the schema default a
 * write path applies, and the projection of a slot that has never been stored - and a literal
 * `1` repeated in three files is three chances to disagree.
 */
export const WORKFLOW_COMMAND_DEFAULT_MAX_RUNS = 1;

/** The projected state of a slot nobody has configured yet. */
export function emptyWorkflowCommandView(
  slot: WorkflowCheckSlot,
  now = 0,
): WorkflowCommandView {
  return {
    slot,
    defaultCommand: null,
    overrides: [],
    maxRuns: WORKFLOW_COMMAND_DEFAULT_MAX_RUNS,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Whether a Command has already executed as many times as this run allows it to.
 *
 * A `>=` rather than a `>`, and the asymmetry is the point: `spent` counts executions that
 * have FINISHED, so an attempt asking this question is about to become the `spent + 1`th.
 *
 * Defensive on the ceiling rather than trusting it. A `maxRuns` of zero or below would make
 * every gate skip forever, which is a way to switch a Command off that this catalog already
 * has a better answer for (do not configure one), and a row hand-edited to `0` must not turn
 * into a silently dead gate. The floor is applied here rather than at the read boundary so
 * every caller - engine, store projection, and Library form alike - gets the same answer.
 */
export function checkRunBudgetSpent(spent: number, maxRuns: number): boolean {
  return spent >= Math.max(1, maxRuns);
}

/**
 * The Command's run budget as the sentence the Library and the workflow palette show.
 *
 * Says "per workflow run" rather than "per round" because the budget spans rounds - that IS
 * the feature - and an operator reading "once" beside a gate they watched run in round one
 * needs to know round two will not run it again.
 */
export function workflowCommandRunsFact(maxRuns: number): string {
  const runs = Math.max(1, maxRuns);
  if (runs === 1) return "Runs once per workflow run";
  return `Runs up to ${runs} times per workflow run`;
}

/**
 * What one slot IS, in one sentence, for the surfaces that offer it.
 *
 * The conventional gate rather than a command: this catalog exists precisely because the
 * argv differs per machine, so naming a package manager here would be the claim the whole
 * feature is built to stop making.
 */
export const WORKFLOW_COMMAND_PURPOSE: Record<WorkflowCheckSlot, string> = {
  test: "The automated test suite this repository gates on.",
  lint: "The style and correctness pass that runs before review.",
  typecheck: "The type checker, when this repository has one separate from its build.",
  build: "The build or bundle step that proves the change compiles.",
};

/**
 * What every Command surface says when the catalog has not arrived.
 *
 * Not `Not configured`, and not "Loading…" either: this one sentence has to cover both halves
 * of the same absence - the snapshot has not landed yet, or the daemon has stopped answering -
 * and no surface can tell those apart. Stated once so the shelf, the editor rail and the
 * palette cannot answer the same question three ways.
 */
export const WORKFLOW_COMMAND_UNKNOWN = "Waiting for the daemon";

/**
 * The one thing a configured Command is NOT: guaranteed to run.
 *
 * Resolution and execution are different questions with different owners. This catalog decides
 * which argv a slot resolves to; whether it is ever executed is decided by the machine-wide
 * switch, the repository's Workflows grant in Trust, and whether this build can run one at
 * all - and a gate that quietly passes is exactly the thing an operator must not believe is
 * active. Stated wherever configuration is described, so no surface has to remember to.
 *
 * Phrased as what running ALSO needs rather than as a list of everything that can stop it.
 * That is honest about necessity without claiming sufficiency - the platform floor is a third
 * gate and is deliberately not enumerated here - and it fits the workflow palette's rail,
 * which is 200px wide and where a four-line disclaimer would simply not be read.
 */
export const COMMAND_AUTHORIZATION_NOTE =
  "Running one also needs Commands allowed and the repository granted in Trust.";

/**
 * The DURABLE configuration state of one Command slot, as the line a card or a list row
 * shows: `Global default · 2 overrides`, `Global default`, `1 override · no global default`,
 * or `Not configured`.
 *
 * Shared rather than spelled at each surface because three of them show it - the Library
 * shelf card, the Command editor's slot rail, and the workflow palette - and a fact that
 * reads differently in three places is three answers to one question. It says nothing about
 * a run: whether a Command is configured is a property of this machine, not of any workflow.
 *
 * `hasSnapshot` is REQUIRED, and that is the safety property rather than ceremony. Every
 * string below is a claim about what this machine has stored, and an absent view means one of
 * two very different things: nobody configured this slot, or the catalog has not arrived. A
 * caller that could omit the flag would default to the first and invite an operator to type
 * over a global default that merely had not loaded. A present view is trusted whatever the
 * flag says - the flag describes an absence, and a slot the stream delivered is not absent.
 */
export function workflowCommandFact(
  view: Pick<WorkflowCommandView, "defaultCommand" | "overrides"> | null | undefined,
  hasSnapshot: boolean,
): string {
  if (!view && !hasSnapshot) return WORKFLOW_COMMAND_UNKNOWN;
  const overrides = view?.overrides.length ?? 0;
  const plural = overrides === 1 ? "override" : "overrides";
  const hasDefault = Boolean(view?.defaultCommand && view.defaultCommand.length > 0);
  if (hasDefault) {
    return overrides === 0 ? "Global default" : `Global default · ${overrides} ${plural}`;
  }
  if (overrides > 0) return `${overrides} ${plural} · no global default`;
  return "Not configured";
}

/**
 * The same state as a SENTENCE, for the workflow palette, where the operator is deciding
 * whether adding this node will do anything.
 *
 * It states the skip rather than converting it into a validation error: a portable workflow
 * is meant to name a slot a given machine may not configure, and passing with a note is the
 * designed behaviour rather than a mistake to prevent.
 *
 * `hasSnapshot` for `workflowCommandFact`'s reason, and it matters MORE here: this sentence
 * does not merely describe configuration, it promises what a run will do. "Nothing is
 * configured, so this Command skips" read off a catalog that has not arrived tells an operator
 * their working gate is inert.
 *
 * What it will NOT say is that a configured Command runs. Configuration decides which argv
 * RESOLVES here; whether that argv is ever executed is a separate question owned by the
 * machine-wide switch, the repository's Workflows grant in Trust, and the platform floor -
 * none of which this catalog knows anything about. Only the negative direction is certain in
 * both, which is why the unconfigured arm states its skip flatly and the configured arms
 * carry `COMMAND_AUTHORIZATION_NOTE` instead of a promise.
 */
export function workflowCommandStatusSentence(
  view: Pick<WorkflowCommandView, "defaultCommand" | "overrides"> | null | undefined,
  hasSnapshot: boolean,
): string {
  if (!view && !hasSnapshot) {
    return `${WORKFLOW_COMMAND_UNKNOWN}, so what this Command runs here is not known yet.`;
  }
  const overrides = view?.overrides.length ?? 0;
  // OVERRIDES, never repositories. An override is keyed by path, so a monorepo puts two of
  // them under one checkout - and "configured in 2 repositories" would overstate how much of
  // the fleet this Command reaches, which is the number an operator reads to decide whether a
  // workflow travels. Counting distinct roots instead is not available here: the catalog
  // stores paths, and finding the repository boundary above one needs the daemon.
  const counted = `${overrides} ${overrides === 1 ? "override" : "overrides"}`;
  if (view?.defaultCommand && view.defaultCommand.length > 0) {
    const where = overrides === 0
      ? "A global default is configured, so every repository resolves to it."
      : `A global default is configured, with ${counted}.`;
    return `${where} ${COMMAND_AUTHORIZATION_NOTE}`;
  }
  if (overrides > 0) {
    return `Configured by ${counted} only - everywhere else this Command skips and passes `
      + `with a note. ${COMMAND_AUTHORIZATION_NOTE}`;
  }
  return "Nothing is configured, so this Command skips and passes with a note.";
}

/**
 * The legacy flat `checkCommands` projection of the catalog.
 *
 * Overrides ONLY. A global default has no repository and therefore no legacy row it could
 * honestly occupy - inventing one per repository would tell the old surface a default is an
 * override, and the next save it made would write that fiction back as one.
 *
 * Deterministic: registry slot order, then the store's canonical override order. The old
 * field was an append-ordered array whose order no surface displayed, so pinning a stable
 * order here is strictly more legible than what it replaces.
 */
export function legacyCheckCommands(
  views: readonly WorkflowCommandView[],
): WorkflowCheckCommand[] {
  const bySlot = new Map(views.map((view) => [view.slot, view]));
  const rows: WorkflowCheckCommand[] = [];
  for (const slot of WORKFLOW_CHECK_SLOTS) {
    for (const override of bySlot.get(slot)?.overrides ?? []) {
      rows.push({ repoRoot: override.repoRoot, slot, command: [...override.command] });
    }
  }
  return rows;
}

/**
 * Machine-wide workflow POLICY - the part of the old config that is still stored in
 * `app_config`.
 *
 * Split from the commands it used to sit beside because they are owned by different things
 * now: policy is a small settings blob, and commands are a normalized catalog with its own
 * revisions and its own write path. `checkBlockedReason` reads this and nothing else, which
 * is what keeps authorization a separate question from resolution.
 */
export interface WorkflowPolicy {
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
}

/**
 * Policy PLUS the legacy flat command projection: the shape `/api/workflows/config` still
 * answers with and still accepts.
 *
 * Not a persisted shape any more. `checkCommands` is composed from the Command catalog on
 * read and mapped back into it on write, so the field an old caller sees is a view of the
 * one authority rather than a second copy of it.
 */
export interface WorkflowConfig extends WorkflowPolicy {
  /**
   * A LIST rather than a `Record<repoRoot, …>` for `repoAllowlist`'s reason: repository
   * roots are absolute paths and make poor object keys, and the flat shape is how this
   * config already stored roots.
   *
   * Overrides only. A slot's global default has no repository and so has no row here.
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

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
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
};

/** The default policy under the legacy wire shape: no commands, because none are stored. */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  ...DEFAULT_WORKFLOW_POLICY,
  checkCommands: [],
};

/**
 * What one Command slot actually runs here, and where - or null when nobody configured it.
 *
 * The argv is COPIED and the working path is carried beside it. The matched override root is
 * not decoration: when a nested override wins, it is also the directory the command has to
 * run in, and a caller handed only the argv would run the package's command at the top of
 * the repository and report the answer as the package's.
 */
export interface WorkflowCommandResolution {
  command: string[];
  /**
   * Where the command runs, RELATIVE to the checkout root. `""` is the root.
   *
   * Relative, never absolute: the execution runtime leases a pooled worktree pinned to the
   * submission's commit rather than standing in the operator's own directory.
   */
  workingSubpath: string;
  /** Which rung of the ladder answered. Diagnostic only; execution treats both alike. */
  source: "override" | "default";
}

/**
 * Resolve one slot for one location: longest matching override, else the global default.
 *
 * Shared so the daemon and every authoring surface resolve identically: a surface that
 * showed a command the daemon would not pick is a gate an operator believes they configured.
 *
 * `cwd` and `repoRoot` are BOTH consulted, through the same `repoAllowlisted` boundary the
 * consent gate uses, because a session normally stands in a pooled worktree under
 * `~/.treehouse/` while its `repoRoot` names the shared main repository. Matching on either
 * is what makes an override naming the project reach a worktree of that project.
 *
 * The LONGEST matching root wins, so a monorepo subdirectory can override the entry that
 * covers the whole tree. Two overrides sharing a root cannot occur within a slot, and that
 * is ENFORCED at the write boundary rather than assumed here: the update schema and the
 * store's composite key both refuse a duplicate. It has to be enforced somewhere, because
 * this function silently keeps the first of a tie - which would make the command that runs
 * depend on array order, a thing no surface shows the operator.
 *
 * A nested override has a THIRD way to match, and it is the one that carries the common
 * case. Absolute containment alone selects `/repo/packages/web` only for a session standing
 * under that literal path - but a dispatched session stands in a pooled worktree under
 * `~/.treehouse/`, whose `cwd` is outside `/repo` entirely while its `repoRoot` still names
 * `/repo`. Containment therefore falls through to the repository-wide override, so the
 * package override would work for a plain checkout and silently never for a dispatched one.
 * A worktree mirrors its repository's layout, so the override's repository-relative subpath
 * is matched against `location.checkoutSubpath` - the session's position within its OWN
 * checkout, compared by whole path components.
 *
 * The global default is the LAST rung, reached only when no override matched, and it runs at
 * the checkout ROOT. A default is repository-neutral by definition, so it carries no opinion
 * about which subdirectory to stand in, and inheriting a losing override's subpath would run
 * a machine-wide command somewhere it was never configured for.
 */
export function resolveWorkflowCommand(
  view: Pick<WorkflowCommandView, "defaultCommand" | "overrides"> | null,
  location: CheckLocation,
): WorkflowCommandResolution | null {
  if (!view) return null;
  let best: WorkflowCommandOverride | null = null;
  for (const entry of view.overrides) {
    if (!checkCommandApplies(entry.repoRoot, location)) continue;
    if (!best || entry.repoRoot.length > best.repoRoot.length) best = entry;
  }
  if (best) {
    return {
      command: [...best.command],
      workingSubpath: checkCommandSubpath(location.repoRoot, best.repoRoot),
      source: "override",
    };
  }
  if (view.defaultCommand && view.defaultCommand.length > 0) {
    return { command: [...view.defaultCommand], workingSubpath: "", source: "default" };
  }
  return null;
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
  config: Pick<WorkflowPolicy, "checksEnabled" | "repoAllowlist">,
  cwd: string | null,
  repoRoot: string | null,
): string | null {
  if (!config.checksEnabled) {
    return "Workflow Commands are switched off, so no command was run.";
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
 * Four of the five PASS, and every one of those four says something different about WHY the
 * graph advanced without a green command. `skipped` is "nobody configured this", `unavailable`
 * is "somebody has to authorize it", and `budget_spent` is "this machine configured it, it
 * ran earlier in this very run, and the operator capped how often it may run". All of them
 * carry a note rather than silently letting the graph through - a shipped workflow with check
 * gates has to be safe on a machine that configured none of them, and an operator has to be
 * able to tell a gate that passed from a gate that never ran.
 *
 * `budget_spent` is its OWN status rather than a `skipped` carrying different prose, and that
 * is the honesty property this vocabulary exists for. Every surface keys its explanation off
 * the status - `CHECK_STATUS_SENTENCES` in `run-model.ts` is a `Record` over this exact enum -
 * so folding a budget skip into `skipped` would have the ladder tell an operator that no
 * Command is configured for a slot they configured themselves, about a gate they watched run
 * one round earlier. That is a worse lie than the one the note would have corrected, because
 * the ladder is where it is read and the note is not shown there.
 */
export const WORKFLOW_CHECK_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "unavailable",
  "budget_spent",
] as const;
export type WorkflowCheckStatus = (typeof WORKFLOW_CHECK_STATUSES)[number];

export interface WorkflowCheckOutcome {
  status: WorkflowCheckStatus;
  slot: WorkflowCheckSlot;
  /**
   * Null whenever no command was resolved, which is every `skipped` outcome.
   *
   * A `budget_spent` outcome DOES carry one: resolution succeeded and the argv is exactly
   * what the run declined to spend time on again, which is what an operator needs to see to
   * decide whether the cap is set where they want it.
   */
  command: string[] | null;
  exitCode: number | null;
  /** Bounded and tail-biased: a failure's last lines are the useful ones. */
  output: string;
  /** Bytes of streamed output dropped to honour that bound, or 0 when nothing was. */
  truncatedBytes: number;
  /** Always a complete sentence, including on a pass. */
  note: string;
}

/**
 * Whether this outcome lets the graph advance. Only `failed` does not.
 *
 * Written as "is not failed" rather than as a list of the passing statuses on purpose: a
 * status appended later passes by default, which is the safe direction for a vocabulary whose
 * additions have all been reasons a gate did not run. A new BLOCKING status would have to say
 * so here explicitly, and that is a change somebody has to make deliberately.
 */
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
  /** SHA-256 of the worker's proof boundary, never raw prompt or diff text. */
  marker: string;
  /** Completed lifecycle generation consumed by prompted claims; null for drain. */
  expectedWorkCycle: { logicalKey: string; generation: number } | null;
  summary: string;
  evidenceFingerprint: string;
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
export interface WorkflowAssetReferenceSet {
  /** Unique Persona ids named by this graph, bounded by `WORKFLOW_LIMITS.graphNodes`. */
  personaIds: PersonaId[];
  /** Unique SessionAction ids named by this graph, bounded by `WORKFLOW_LIMITS.graphNodes`. */
  sessionActionIds: SessionActionId[];
}

/**
 * The asset identities named by the two graphs one workflow can truthfully expose.
 *
 * Draft and published stay separate because they mean different things: the draft follows
 * Library edits, while the published graph is the immutable version a new run binds. Each set
 * is bounded by the graph's 100-node ceiling and contains ids only, never graph shape or asset
 * content. `published` is null until the workflow has a current version.
 */
export interface WorkflowAssetReferences {
  draft: WorkflowAssetReferenceSet;
  published: WorkflowAssetReferenceSet | null;
}

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
  /**
   * Bounded asset identities for the Library's "Used by" footer.
   *
   * Optional only for wire compatibility with an older daemon. A browser that does not receive
   * it must render no footer rather than infer references from names or fetch every workflow.
   */
  assetReferences?: WorkflowAssetReferences;
}

/** The catalog facts naming a version id needs. A `WorkflowSummary` satisfies it as-is. */
export type WorkflowNamingSource =
  Pick<WorkflowSummary, "id" | "name" | "currentVersionId" | "publishedVersion">;

/**
 * What to call an immutable version id, for a surface that holds one and must say what it is.
 *
 * Shared because three surfaces hold a bare version id and each was rendering it as
 * `id.slice(0, 8)`. That is a usable prefix for an operator workflow, whose version ids are
 * UUIDs, and it is nothing at all for a built-in: `builtin-workflow:no-mistakes-review@8`
 * truncates to `builtin-`, which named the wrong thing so completely that an operator read a
 * correctly bound session as unbound. A name the reader recognises is the whole job here.
 *
 * Three sources, in falling order of confidence: the catalog entry whose CURRENT version this
 * is, then the workflow named by a built-in id's own structure (which keeps a superseded
 * built-in version - `@7` while `@8` ships - naming its workflow rather than falling through),
 * then the raw id. The last is deliberately not "Unknown": an id an operator can paste into a
 * bug report beats a word that discards it.
 */
export function workflowVersionLabel(
  versionId: string,
  workflows: readonly WorkflowNamingSource[],
): string {
  const current = workflows.find((workflow) => workflow.currentVersionId === versionId);
  if (current) return `${current.name} · v${current.publishedVersion}`;
  const builtin = parseBuiltinWorkflowVersionId(versionId);
  if (builtin) {
    const named = workflows.find((workflow) => workflow.id === builtin.workflowId);
    if (named) return `${named.name} · v${builtin.version}`;
  }
  return versionId;
}

/**
 * WHICH workflow an immutable version id belongs to, or null when the catalog cannot say.
 *
 * The same two-step resolution `workflowVersionLabel` performs, exposed on its own for callers
 * that need the identity rather than the words - fetching that workflow's detail, say.
 *
 * Keying off `currentVersionId` equality alone is the trap this closes. That matches only while
 * a version is the newest one, so a session bound to a superseded built-in - `@7` after `@8`
 * ships - resolved to nothing, and whatever the caller does with the answer silently did not
 * happen. Naming and identity have to agree about which versions are recognisable, or a surface
 * can name a version in one line and fail to look it up in the next.
 */
export function workflowIdForVersion(
  versionId: string,
  workflows: readonly WorkflowNamingSource[],
): WorkflowId | null {
  const current = workflows.find((workflow) => workflow.currentVersionId === versionId);
  if (current) return current.id;
  const builtin = parseBuiltinWorkflowVersionId(versionId);
  if (builtin && workflows.some((workflow) => workflow.id === builtin.workflowId)) {
    return builtin.workflowId;
  }
  return null;
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
  /**
   * WHICH CHECKOUT this binding reviews, and the second half of the active-binding key.
   *
   * A conversation owns one active binding per repository - `(noteKey, repoRoot)` - because a
   * multi-repo task's session makes changes in several checkouts and each one gets its own
   * full review run. One workflow run is one repository, and this is where that starts.
   *
   * Empty string means "this session's own checkout", which is what every binding ever
   * written was and what every single-repo binding still is. It is a SENTINEL rather than
   * null because SQLite treats nulls as distinct in a unique index, so a null here would let
   * two active bindings own one conversation - the exact invariant this column widens rather
   * than removes. It is not the resolved repository path either: a session's repo root can be
   * null (a checkout outside a repository) and can move under it, and neither may cost a
   * conversation its one-binding guarantee.
   *
   * A non-empty value names a SECONDARY repository attached to the session's task. Then
   * `sessionCwd` and `sessionRepoRoot` below hold THAT repository's worktree and root rather
   * than the session's own - which is what makes every existing per-binding rule (evidence
   * capture, check execution, the Inspector gate's adoption match, the capture root) scope
   * itself to the right repository without knowing this feature exists.
   */
  repoRoot: string;
  /**
   * Immutable compatibility facts captured when the binding was created or reattached.
   *
   * `sessionCwd`/`sessionRepoRoot` are the BINDING'S CHECKOUT, which for a `repoRoot` binding
   * is a secondary worktree rather than the session's cwd. See `repoRoot` above.
   */
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

/**
 * What a conversation is ARMED with, compact enough to ride the fleet stream.
 *
 * A separate projection from `WorkflowBinding` for the reason `WorkflowRunSummary` is separate
 * from `WorkflowRun`: the row is the durable shape four mutating routes return and thirty-odd
 * call sites build, while this is a display record that resolves the workflow's NAME and
 * VERSION NUMBER server-side. A binding stores only `workflowVersionId`, and no browser can
 * turn that into a name on its own - a built-in's version has no database row to join, so the
 * catalog lookup that resolves it lives in the store beside the identical one for runs.
 *
 * This exists because a session with an armed binding and no run yet was indistinguishable
 * from an unbound one: every surface keyed "is a workflow attached" off the RUN, which for the
 * `foreman_complete` trigger does not exist until the work is finished. Sessions spent their
 * whole working life looking unarmed, and the chip offering to attach one said so.
 */
export interface WorkflowBindingSummary {
  id: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  /** Resolved from the version, so a surface holding a binding can name its workflow. */
  workflowId: WorkflowId;
  workflowName: string;
  workflowVersion: number;
  noteKey: string;
  sessionId: string | null;
  /**
   * The repository this binding reviews, RESOLVED for display: a secondary repository's root,
   * or the session's own root for the binding that follows its cwd.
   *
   * Resolved here rather than shipped raw so no surface has to know that the empty-string
   * sentinel on `WorkflowBinding.repoRoot` means "ask the session". Null when the binding
   * follows a session that has no repository at all, which is the one case with nothing to
   * name. OPTIONAL and append-only: a summary written by an older daemon still parses.
   */
  repoRoot?: string | null;
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  state: WorkflowBindingState;
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
  /**
   * Active operator directives, scoped by this run and the pinned graph's Persona node id.
   *
   * These are deliberately not part of the immutable workflow version or the shared
   * submission context. A directive follows one Persona through later repair rounds of one
   * run, and no sibling Persona or other run may inherit it.
   */
  personaDirectives?: WorkflowPersonaDirective[];
  /**
   * The repair round this run's Command execution budgets start counting from, or null to
   * count every execution the run has made.
   *
   * Only the two operator escape hatches write it - granting repair rounds and the full
   * restart out of an Inspector-only repair - and both write the round their new submission
   * will carry. An operator who has explicitly asked for another round is asking for another
   * real attempt at the gate, so the rounds they bought must not all skip a Command that
   * spent its budget before they intervened. Nothing else resets it: ordinary repair rounds
   * are exactly what the budget exists to bound.
   *
   * Optional for the reason `disabledNodeIds` is: a detail payload written by an older
   * daemon still parses, and absent reads as "count from the beginning".
   */
  checkBudgetEpochRound?: number | null;
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
  /**
   * The idempotency key the submission was created under. Composed for a manual submission by
   * `manualWorkflowTriggerKey` below, which is also the only thing that reads one back apart.
   */
  triggerKey: string;
  /** One completion boundary shared by sibling repository submissions. */
  evidenceGroupKey?: string;
  /** Staged-set generation frozen when this submission reserved its locators. */
  stagedImageGeneration?: number;
  evidenceFingerprint: string;
  /**
   * The same capture hashed without its transcript anchor, or null on a row captured
   * before the column existed.
   *
   * `evidenceFingerprint` is IDENTITY - every input, transcript included - and is what
   * trigger keys and idempotency are built on. This is the answer to a different question:
   * has the work changed? The two differ by exactly one field, and that field moves on its
   * own the instant a repair packet is typed into the pane, which is why the unchanged
   * resubmission guard reads this one and the submission's identity reads the other.
   */
  repositoryFingerprint?: string | null;
  context: WorkflowJson;
  evidence: WorkflowJson;
  prHeadSha: string | null;
  status: WorkflowSubmissionStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/**
 * The idempotency key a MANUAL submission is filed under, composed in one place.
 *
 * It lives here, beside the field it is written into, because both sides of the wire need it and
 * for opposite reasons. The daemon composes it to find a prior submission by trigger and replay
 * it instead of creating a second; the browser reads one back to recover the request id of a
 * submission the daemon REFUSED, which is the only way to ask for that exact submission again
 * rather than a new round. A format spelled twice is a format that drifts, and the failure it
 * drifts into is silent - a key that matches nothing looks exactly like a first attempt.
 *
 * Deliberately NOT the shape used by `restart-full` or `delivery-resolution`, which namespace a
 * second segment inside this same prefix. `manualWorkflowTriggerRequestId` rejects those rather
 * than returning their request id, because replaying one against `resubmit` would find a
 * submission that is not the refused one.
 */
export function manualWorkflowTriggerKey(
  bindingId: WorkflowBindingId,
  requestId: string,
): string {
  return `manual:${bindingId}:${requestId}`;
}

/** The request id inside a manual submission key, or `null` when it is not one. */
export function manualWorkflowTriggerRequestId(
  bindingId: WorkflowBindingId,
  triggerKey: string,
): string | null {
  const prefix = `manual:${bindingId}:`;
  if (!triggerKey.startsWith(prefix)) return null;
  const requestId = triggerKey.slice(prefix.length);
  // A remaining separator means a namespaced sibling (`restart-full:`, `delivery-resolution:`),
  // not a request id. Request ids are `crypto.randomUUID()` values and carry none.
  return requestId.length > 0 && !requestId.includes(":") ? requestId : null;
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
  /** Exact run-scoped directive this Persona attempt claimed, if any. */
  operatorDirective?: WorkflowPersonaDirectiveSnapshot | null;
  /**
   * Completed same-submission Check outcomes frozen when this Persona became runnable.
   * Absent on historical attempts and every non-Persona attempt.
   */
  checkEvidence?: WorkflowCheckEvidence[];
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

/** The active, editable directive attached to one Persona node of one workflow run. */
export interface WorkflowPersonaDirective {
  nodeId: string;
  feedback: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Immutable copy written onto each Persona attempt when that attempt is first claimed. */
export interface WorkflowPersonaDirectiveSnapshot {
  feedback: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
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
  /** Present when one oversized turn retains an explicit head and tail around an omission. */
  omittedMiddleBytes?: number;
}

/** Immutable output from one completed Check attempt that is upstream of a Persona. */
export interface WorkflowCheckEvidence {
  nodeId: string;
  attemptId: WorkflowNodeAttemptId;
  attempt: number;
  slot: WorkflowCheckSlot;
  status: WorkflowCheckStatus;
  command: string[] | null;
  exitCode: number | null;
  outputTail: string;
  omittedBytes: number;
  headSha: string | null;
  note: string;
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
    /** Bytes from older retained turns dropped to keep newest transcript evidence in budget. */
    transcriptOmittedHeadBytes?: number;
    /** The harness supplied a non-contiguous head/tail window with a missing middle. */
    transcriptMiddleOmitted?: boolean;
    standards: WorkflowStandardsDocument[];
    standardsTruncated: boolean;
    /** Defaults to an empty list when reading snapshots written before image evidence. */
    images?: WorkflowEvidenceImage[];
    /** Defaults to an empty list when reading snapshots written before text evidence. */
    artifacts?: WorkflowEvidenceTextArtifact[];
    /** Defaults to zero when reading snapshots written before image evidence. */
    stagedImageGeneration?: number;
    retention?:
      | { state: "full" }
      | {
          state: "pruned";
          prunedAt: number;
          diffBytes: number;
          workingTreeStatusEntries: number;
          transcriptMessages: number;
          standardsDocuments: number;
          imageCount?: number;
          imageBytes?: number;
          textArtifactCount?: number;
          textArtifactBytes?: number;
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
  "image",
  "artifact",
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
  /**
   * The human title the binding captured when it was created - "Fix Busy State for Diff Link".
   *
   * OPTIONAL and append-only, like every other optional field here: a summary written by an
   * older daemon must still parse in a newer browser, and it is omitted rather than emitted
   * as `""` so a binding with no captured title costs nothing on a payload that ships for
   * every run in the fleet on every change.
   *
   * It matters because a RUN OUTLIVES THE SESSION IT REVIEWED. When the session goes,
   * `orphanBinding` nulls `sessionId` and blocks the run, so a surface that names a row from
   * the live session list has nothing left to name it with and falls through to `noteKey` -
   * a raw conversation GUID. This field is the only human name that survives, and it is
   * already durable on `workflow_bindings.session_name`; the summary just carries it now.
   */
  sessionName?: string;
  /**
   * The repository this run reviews, resolved exactly as `WorkflowBindingSummary.repoRoot` is.
   *
   * One workflow run is one repository. A session running a multi-repo task has one run per
   * repository it changed, and this is the only thing that tells two of them apart on a
   * surface: they share a conversation, a workflow, a version and usually a status.
   *
   * OPTIONAL and append-only for the reason every optional field here is - an older daemon's
   * summary must still parse in a newer browser - and absent reads as "the session's own
   * repository", which is what every run predating per-repo runs genuinely reviewed. Surfaces
   * shorten it with `repoLeaf` and draw it only when a session has more than one run, so a
   * single-repo session's markup is unchanged.
   */
  repoRoot?: string | null;
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
  /**
   * Provenance for a run an external orchestrator started - today, an ensemble handoff.
   *
   * OPTIONAL and append-only, for the reason every other optional field here is: a summary
   * written by an older daemon must still parse in a newer browser, and absent reads as "an
   * operator or Foreman started this", which is what every run predating claims genuinely
   * was. Resolved by a single LEFT JOIN rather than a per-run lookup, because summaries are
   * folded for the whole fleet on every change.
   *
   * It carries the same fact as `WorkflowRunDetail.externalSource`, and that is not a second
   * opinion: the detail FORWARDS this field rather than resolving its own. There is exactly
   * one place the rule lives - the claims join in the store's `WORKFLOW_RUN_SUMMARY_SELECT`,
   * read into this field by `externalSourceFromRow` - and the detail's copy is that value
   * handed on. The rule itself is narrow and worth knowing while reading either: a claim
   * counts only when its kind matches the RUN's own trigger source, because a claimed binding
   * stays usable by the manual and Foreman paths and a later run on it is genuinely not the
   * external one.
   *
   * The detail's field is the older of the two and stays because that is where a reader opens
   * a run to see it; this one exists so a TRIAGE surface - the Line's Review drawer - can say
   * "this came out of an ensemble" for every live run without fetching a detail per row.
   */
  externalSource?: WorkflowExternalSource | null;
  /**
   * Whether a round parked in `waiting_for_session` picks itself back up, from the VERSION
   * this run is pinned to - the same row `resumableRun` reads before it resumes anything.
   *
   * The version's and not the workflow's, and that distinction is the whole point: a run
   * pinned to a version published before the column existed keeps behaving as it was
   * published, and a surface that read the workflow's current setting would promise an
   * automatic resumption the observer is never going to perform.
   *
   * OPTIONAL and append-only for the reason every optional field here is - a summary written
   * by an older daemon must still parse in a newer browser. Absent means "this daemon does
   * not report it", which is NOT the same as `manual`: read
   * `workflowRunResumesItself`, which treats absence as the behaviour that shipped before
   * this field existed rather than inventing an operator obligation retroactively.
   */
  resumptionPolicy?: WorkflowResumptionPolicy;
  /**
   * Whether the BINDING types into the pane or only prepares packets for a human to read.
   *
   * Carried beside `resumptionPolicy` because neither answers the question on its own. A
   * `preview` binding never types, so its packet sits `prepared` for ever and the resumption
   * observer's in-flight check reads that as "the agent was never told what to fix" - an
   * `auto` version on a `preview` binding is therefore just as parked as a `manual` one, and
   * a surface reading only the policy would call it self-resuming and say nothing.
   *
   * OPTIONAL and append-only on the same terms as `resumptionPolicy`.
   */
  deliveryMode?: WorkflowDeliveryMode;
  maxRepairRounds: number;
  activePersonaNames: string[];
  /**
   * Exact ids for the active Persona attempts represented by `activePersonaNames`.
   * Optional only for compatibility with older summaries, where name shadowing makes an exact
   * asset match impossible.
   */
  activePersonaIds?: PersonaId[];
  /**
   * Exact ids for SessionAction attempts the run is currently waiting on.
   * Optional only for compatibility with older summaries, whose `actionWait` names the reason
   * but not the action.
   */
  activeSessionActionIds?: SessionActionId[];
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
  /** Ordered immutable image metadata grouped by the submission that owns it. */
  evidenceImages?: WorkflowSubmissionEvidenceImages[];
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
   * The last repair-round grant this run was given, if it was given one.
   *
   * Its own field for the reason `resumption` below has one, and this one was the miss that
   * proved the rule: it was first derived in the browser from `events`, which is a PAGE - and
   * not the most recent page, but the OLDEST two hundred rows. A grant only ever happens after
   * a run has exhausted its budget, so it is a late event by construction, and a run that
   * spent five repair rounds is exactly the run whose first two hundred events are all older
   * than it. The notice would have gone missing on every run long enough to need it, which is
   * the "the grant did nothing" report all over again.
   */
  repairGrant?: WorkflowRunRepairGrant | null;
  /**
   * Why the resumption observer last declined to open the next round on this run, if it did.
   *
   * Its own field rather than a derivation over `events`, and the reason is that `events` is
   * a PAGE. A long-running review can hold hundreds of them, so the detail ships one page and
   * a cursor; deriving the current answer from whichever page happened to arrive would answer
   * correctly on a short run and silently stop answering on the runs that need it most.
   *
   * Detail-only and OPTIONAL, on the same terms as `repeatOffenders`: summaries travel over
   * SSE for every run in the fleet and must stay compact, and an older daemon serving a newer
   * browser must not fail to parse.
   */
  resumption?: WorkflowRunResumptionState | null;
  /**
   * Provenance for a run an external orchestrator started. Optional and detail-only: run
   * SUMMARIES travel over SSE for every run in the fleet and must stay compact.
   */
  externalSource?: WorkflowExternalSource | null;
  inspectorGate: WorkflowInspectorGateDetail | null;
}

/**
 * One repair-round grant, as run detail carries it.
 *
 * `round` is the round the run was on when the grant landed, which is what makes the notice
 * self-clearing: the browser drops it once the run has moved past that round, because the
 * grant has been spent and the run's own state is the better story from then on.
 */
export interface WorkflowRunRepairGrant {
  round: number;
  from: number;
  to: number;
}

/**
 * The observer's last word on a parked round, as run detail carries it.
 *
 * `reason` is the stored code, never prose - `workflowResumptionWithheldSentence` turns it
 * into a sentence in the browser, so re-wording never invalidates a ledger entry. `round` is
 * the round that was parked when the observer looked, which is what the sentence names.
 */
export interface WorkflowRunResumptionState {
  reason: string;
  round: number | null;
  /** True when this run's own version and binding mean the loop closes without a human. */
  resumesItself: boolean;
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
  retainedEvidenceImages: number;
  retainedEvidenceImageBytes: number;
  prunedEvidenceImages: number;
  pendingEvidenceImageCleanup: number;
  orphanedEvidenceImages: number;
}

/**
 * Why a built-in Test Evidence Auditor attempt asked for changes.
 *
 * A durable enum, not a display string: it is written into every `test_evidence_audit`
 * workflow event and read back months later by the aggregate below, so a rename here
 * silently reclassifies history. Add a member rather than re-spelling one.
 */
export type TestEvidenceRequestCategory =
  | "visual_artifact"
  | "focused_execution"
  | "downstream_proof"
  | "other";

/** Every category, in the order the readiness panel lists them. */
export const TEST_EVIDENCE_REQUEST_CATEGORIES = [
  "visual_artifact",
  "focused_execution",
  "downstream_proof",
  "other",
] as const satisfies readonly TestEvidenceRequestCategory[];

/**
 * A share, carried with the population it was taken over.
 *
 * `rate` is null when `total` is zero rather than 0, because "no auditor attempt has been
 * recorded" and "every attempt passed" are the two readings this telemetry exists to tell
 * apart, and a bare `0` renders identically for both. The panel draws null as "no reading".
 * Never pre-rounded: the caller decides how many digits its surface can honestly show.
 */
export interface TestEvidenceAuditRate {
  count: number;
  total: number;
  rate: number | null;
}

/** One rejection reason's share of the failing attempts in the window. */
export interface TestEvidenceAuditCategoryShare {
  category: TestEvidenceRequestCategory;
  /** Failing attempts citing this category, over all failing attempts. Categories overlap. */
  failures: TestEvidenceAuditRate;
}

/**
 * One guidance-revision slice, which is the whole reason the identity fields exist.
 *
 * The scout report's rollout criterion is a before/after comparison across guidance
 * revisions ("compare the next 30 runs"), and an aggregate that only reports one fleet-wide
 * number cannot answer it. `guidanceDigest` is a short content hash of the immutable Persona
 * guidance the attempt actually ran with - identity, never prose - so two revisions of the
 * same Persona separate here without any guidance text entering the event.
 *
 * Every field is nullable because events appended before those identifiers existed are still
 * counted; they collect in one slice whose identity is unknown rather than being dropped.
 */
/**
 * The built-in Test Evidence Auditor's Persona id - the only Persona whose attempts append
 * `test_evidence_audit`. It lives here because both the daemon that classifies attempts and
 * the panel that reads them back need it, and two copies of an identity string is one copy
 * too many.
 */
export const TEST_EVIDENCE_AUDITOR_PERSONA_ID = "builtin:test-evidence-auditor";

export interface TestEvidenceAuditSlice {
  workflowId: string | null;
  workflowVersion: number | null;
  personaId: string | null;
  /**
   * The newest Persona revision observed carrying this guidance, not a grouping field.
   *
   * Slices are keyed by guidance DIGEST, so a Persona edit that left the guidance byte-identical
   * keeps its attempts in this one row rather than opening a second, identically labelled one.
   */
  personaRevision: number | null;
  guidanceDigest: string | null;
  attempts: number;
  /** Passing first submissions over all first submissions in this slice. */
  firstSubmissionAccepted: TestEvidenceAuditRate;
  /** Failing attempts over all attempts in this slice. */
  attemptFailures: TestEvidenceAuditRate;
}

/** Evidence-readiness adoption, all measured over FIRST submissions (round 1, segment 0). */
export interface TestEvidenceAuditReadiness {
  withoutImages: TestEvidenceAuditRate;
  withoutTextArtifacts: TestEvidenceAuditRate;
  withoutChecks: TestEvidenceAuditRate;
  transcriptTruncated: TestEvidenceAuditRate;
  /** Total bytes upstream Check retention dropped across first submissions. */
  checkOmittedBytes: number;
  /** Total transcript head bytes dropped across first submissions. */
  transcriptOmittedHeadBytes: number;
}

/**
 * What the `test_evidence_audit` events add up to, for the built-in Test Evidence Auditor.
 *
 * Advisory telemetry over already-written events. Nothing here re-runs, re-judges or
 * rewrites a Persona verdict, and no operator or session content reaches it - only the
 * bounded counts and durable enums the event itself carries.
 */
export interface TestEvidenceAuditAggregate {
  /** Auditor attempts in the window. */
  attempts: number;
  /** Distinct runs those attempts belong to - the denominator of `attemptsPerRun`. */
  runs: number;
  /** The report's "at most 1.5 attempts per run" target, or null with no attempts. */
  attemptsPerRun: number | null;
  /** Events in the window whose payload could not be read back. Counted, never guessed at. */
  malformed: number;
  /** True when older events fell outside the scan cap below, so the window is partial. */
  truncated: boolean;
  /** The newest-first cap the window was taken with. */
  scanLimit: number;
  oldestAt: number | null;
  newestAt: number | null;
  /** The report's headline: passing first submissions over all first submissions. */
  firstSubmissionAccepted: TestEvidenceAuditRate;
  /** Failing attempts over all attempts. */
  attemptFailures: TestEvidenceAuditRate;
  rejectionCategories: TestEvidenceAuditCategoryShare[];
  readiness: TestEvidenceAuditReadiness;
  /** Attempts that asked for later-stage proof the original intent never named. */
  possibleOverreach: TestEvidenceAuditRate;
  /** Busiest slices first. */
  slices: TestEvidenceAuditSlice[];
  /** Slices past the cap. Reported rather than silently truncated. */
  slicesOmitted: number;
}

export interface WorkflowExportEnvelope<T> {
  schemaVersion: 1;
  exportedAt: number;
  kind: "workflow_run" | "workflow_version";
  data: T;
}
