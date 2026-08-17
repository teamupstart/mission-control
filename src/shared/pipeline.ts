import { z } from "zod";

import type { LlmSpendRole } from "./llm-spend.ts";
import { TERMINAL_BACKEND_IDS } from "./terminal.ts";

// Pipelines: what Mission Control knows about a gated SDLC engine it does not own.
//
// A "pipeline provider" is an EXTERNAL engine that drives a feature through a fixed,
// gated sequence of steps in its own worktrees, keeps its own state on disk, and is the
// only writer of that state. Mission Control observes, projects and (from phase 4)
// controls through the provider's own sanctioned surfaces. It never writes a
// provider-owned file, and it never ports a provider's step logic.
//
// This file is the browser-safe half - no `node:` imports - because the Settings panel
// and (later) the Runs page render from it. The same split `HARNESS_CAPABILITIES` makes
// against `HARNESSES` and `TASK_SOURCE_KIND_INFO` makes against `TASK_SOURCES`: what a
// provider IS lives here, what it DOES lives under `src/server/pipelines/`.
//
// The step table below is Mission Control's own FROZEN COPY of the provider's vocabulary,
// and that is deliberate rather than lazy. The provider is a separate program on a release
// train nobody here controls, so the copy is a display aid and never an authority: an
// unknown step name renders as an unknown-step chip and sorts after every known one, so a
// conductor upgrade that adds a step degrades this display and never breaks the page.

/**
 * The pipeline engines this build can observe. **APPEND-ONLY**: these ids are persisted in
 * the `pipelines` blob in `app_config` and in `pipeline_runs.provider`, so renaming one
 * orphans every repository an operator consented to under the old spelling - the row stops
 * matching a registered provider and its runs silently stop being projected.
 */
export const PIPELINE_PROVIDER_IDS = ["ai-conductor"] as const;
export type PipelineProviderId = (typeof PIPELINE_PROVIDER_IDS)[number];

/** Runtime membership, for a value that arrived over the wire or out of the database. */
export function isPipelineProviderId(id: string): id is PipelineProviderId {
  return (PIPELINE_PROVIDER_IDS as readonly string[]).includes(id);
}

/**
 * What each provider is called and what it is, for the browser.
 *
 * `Record<PipelineProviderId, …>` is the enforcement, exactly as `TASK_SOURCE_KIND_INFO`
 * is: a new id appended above does not compile until somebody has said what it is named
 * and what an operator is consenting to when they enable it.
 */
export interface PipelineProviderInfo {
  provider: PipelineProviderId;
  /** Display name, as the operator's own installation calls itself. */
  label: string;
  /** One sentence: what this engine does, in the panel that offers to observe it. */
  blurb: string;
  /** The binary Mission Control probes for on `PATH`. */
  bin: string;
  /** Where its per-repository worktrees live, relative to a repository root. */
  worktreesDir: string;
}

export const PIPELINE_PROVIDER_INFO: Record<PipelineProviderId, PipelineProviderInfo> = {
  "ai-conductor": {
    provider: "ai-conductor",
    label: "ai-conductor",
    blurb:
      "Drives a feature through a gated 22-step SDLC in its own worktree, one step at a " +
      "time, and halts for a human when a gate refuses.",
    bin: "conduct-ts",
    worktreesDir: ".worktrees",
  },
};

/** The five phases every provider step belongs to, in pipeline order. */
export const PIPELINE_PHASES = ["SETUP", "UNDERSTAND", "DECIDE", "BUILD", "SHIP"] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

/**
 * What one step is doing, as the provider records it.
 *
 * Read LENIENTLY out of provider state: a status this build does not know decodes to
 * `pending`, which is the arm that claims the least. Never write these into a
 * provider-owned file - Mission Control does not write provider state at all.
 */
export const PIPELINE_STEP_STATES = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "skipped",
  "stale",
] as const;
export type PipelineStepState = (typeof PIPELINE_STEP_STATES)[number];

/** Runtime membership, for a status string read out of a provider's own JSON. */
export function isPipelineStepState(value: string): value is PipelineStepState {
  return (PIPELINE_STEP_STATES as readonly string[]).includes(value);
}

/**
 * Why a halted run is halted, in the vocabulary an operator can act on.
 *
 * `unclassified` is the honest arm and the default: the provider's halt marker may carry
 * no class at all, and guessing one would tell somebody a halt needs them when it does
 * not, or the reverse. Phase 3 turns these into attention items; phase 4 gives each one
 * the verbs that clear it.
 */
export const PIPELINE_HALT_CLASSES = [
  "needs-human",
  "mechanical",
  "protected-artifact",
  "legacy",
  "unclassified",
] as const;
export type PipelineHaltClass = (typeof PIPELINE_HALT_CLASSES)[number];

/** Runtime membership, for a class string read out of a provider's own marker file. */
export function isPipelineHaltClass(value: string): value is PipelineHaltClass {
  return (PIPELINE_HALT_CLASSES as readonly string[]).includes(value);
}

/** How a halt class is named and what it means for whoever has to clear it. */
export interface PipelineHaltClassInfo {
  label: string;
  /** One line: what this class says about who can act on it. */
  blurb: string;
}

/**
 * The operator-facing reading of each halt class.
 *
 * `Record<PipelineHaltClass, …>` for the reason every other record in this file is one: a
 * class appended to the tuple above does not compile until somebody has said what it means.
 * Flat rather than keyed by provider because the CLASSES are - `PIPELINE_HALT_CLASSES` is
 * one tuple that every provider's markers are read into, and a second provider whose halts
 * did not fit it would be extending that tuple, not this record.
 *
 * The runbook that clears a halt IS provider-specific, and lives in
 * `PIPELINE_HALT_RUNBOOKS` below rather than here.
 */
export const PIPELINE_HALT_CLASS_INFO: Record<PipelineHaltClass, PipelineHaltClassInfo> = {
  "needs-human": {
    label: "Needs a human",
    blurb: "Only an operator can clear this one; the engine will not re-kick it.",
  },
  mechanical: {
    label: "Mechanical",
    blurb: "The engine may re-kick this one on its own once the cause clears.",
  },
  "protected-artifact": {
    label: "Protected artifact",
    blurb: "A sealed decision artifact changed under the engine; the seal wants a ceremony.",
  },
  legacy: {
    label: "Legacy",
    blurb: "A halt raised before the engine classified them. Read the reason and decide.",
  },
  unclassified: {
    label: "Unclassified",
    blurb: "The engine recorded no class, so nothing here guesses one.",
  },
};

/** A provider's own operational document for a halt, and the part of it that applies. */
export interface PipelineRunbook {
  /** The document's title, as the provider publishes it. */
  name: string;
  /** The section inside it that owns this class, or null when the whole document does. */
  section: string | null;
}

/**
 * Which of a provider's runbooks an operator opens for each halt class.
 *
 * Part of the same frozen display copy as the step table, under the same rule: it names
 * another program's documentation so the inbox can say where to go, and it decides nothing.
 * A name that has fallen behind a provider release makes one line of a row stale.
 *
 * Read from ai-conductor's own `docs/runbooks/` at `8b51392d`, where a HALT is owned by one
 * document - "Stalled or stuck feature", whose symptom list leads with `■ done <slug>:
 * halted` - and the classes differ by which of its sections applies. Both fields are copied
 * from that file's headings rather than paraphrased, so a reader can find them.
 */
export const PIPELINE_HALT_RUNBOOKS: Record<
  PipelineProviderId,
  Record<PipelineHaltClass, PipelineRunbook>
> = {
  "ai-conductor": {
    "needs-human": { name: "Stalled or stuck feature", section: "The halt refused a DECIDE entry" },
    mechanical: { name: "Stalled or stuck feature", section: "Classify the stall" },
    "protected-artifact": {
      name: "Stalled or stuck feature",
      section: "The halt is a protected-artifact violation",
    },
    legacy: { name: "Stalled or stuck feature", section: "Classify the stall" },
    unclassified: { name: "Stalled or stuck feature", section: "Classify the stall" },
  },
};

/** The runbook for one halt, as one line: `"Stalled or stuck feature - Classify the stall"`. */
export function pipelineHaltRunbookLine(
  provider: PipelineProviderId,
  haltClass: PipelineHaltClass,
): string {
  const runbook = PIPELINE_HALT_RUNBOOKS[provider][haltClass];
  return runbook.section ? `${runbook.name} - ${runbook.section}` : runbook.name;
}

/**
 * Which bucket a run sits in, for the rail that will group them (phase 2).
 *
 * Derived on the daemon from provider state, never in the browser: two surfaces deriving
 * the same grouping from the same facts is how they come to disagree the first time one
 * of them learns something the other has not.
 *
 * - `building` - a step is in progress right now.
 * - `eligible` - nothing is running and the next step could start.
 * - `waiting` - the daemon is paused or the run is not this daemon's to advance.
 * - `halted` - a gate refused and the engine stopped for a human.
 * - `parked` - an operator set it aside.
 * - `processed` - it reached the end, or its pull request is open.
 */
export const PIPELINE_RUN_GROUPS = [
  "building",
  "eligible",
  "waiting",
  "halted",
  "parked",
  "processed",
] as const;
export type PipelineRunGroup = (typeof PIPELINE_RUN_GROUPS)[number];

/** The provider's own tiering of how much ceremony a feature gets. */
export type PipelineTier = "S" | "M" | "L";
/** Product work versus technical-only work, which decides which steps are skipped. */
export type PipelineTrack = "product" | "technical";

/** One step of a run, as projected for display. */
export interface PipelineStep {
  /** The provider's own step id, e.g. `build`. Unknown names are carried through. */
  name: string;
  state: PipelineStepState;
}

/**
 * One pipeline run, as the dashboard sees it.
 *
 * Keyed `(provider, repoRoot, slug)`. The slug is the plan stem, which is the provider's
 * own canonical key for a feature - not a Mission Control id, because nothing here mints
 * one: this projection is rebuildable from the provider's files at any moment, and an id
 * of our own would be the one field a rebuild could not reproduce.
 */
export interface PipelineRun {
  provider: PipelineProviderId;
  /** Absolute path of the repository root the run belongs to. */
  repoRoot: string;
  /** The provider's canonical key for the feature - the plan stem. */
  slug: string;
  /** Absolute path of the run's own worktree, when it has cut one; else null. */
  worktree: string | null;
  tier: PipelineTier | null;
  track: PipelineTrack | null;
  /**
   * Every step the provider's state mentions, in the order this build knows, with the
   * ones it does not know appended in the order they were read. Never re-ordered into
   * a canonical list that dropped an unknown step - a step nobody can see is worse than
   * one drawn without a phase.
   */
  steps: PipelineStep[];
  /** The step the provider last recorded working on, or null before the first one. */
  lastStep: string | null;
  /** Why it stopped, when it stopped. Null on a run that has not halted. */
  halt: { class: PipelineHaltClass; reason: string } | null;
  group: PipelineRunGroup;
  /** The pull request the run opened, once it has. */
  prUrl: string | null;
  /** Tokens the provider attributes to this feature, when it reports any. */
  costTokens: number | null;
  /** When the projection last changed, in epoch ms. */
  updatedAt: number;
}

/** The three coordinates that durably address one provider-owned run. */
export interface PipelineRunLink {
  provider: PipelineProviderId;
  /** Absolute repository root, matching `PipelineRun.repoRoot` exactly. */
  repoRoot: string;
  slug: string;
}

/**
 * What one SESSION carries about the run it is doing the work of: `Session.pipeline`.
 *
 * The run's key plus the step that was running when the session was last observed, and
 * nothing else: a whole `PipelineRun` on every session frame would ship 22 step states per
 * correlated card per sweep to say one word on a chip.
 *
 * The key is all three coordinates because two repositories legitimately hold the same slug
 * (`pipeline-sse.test.ts` pins that case), so a link naming only provider and slug cannot
 * address the run it belongs to, which is the whole job of the chip, the ladder and the
 * composer's replacement notice.
 */
export interface SessionPipelineLink extends PipelineRunLink {
  /** The provider's `lastStep` as of the observation, or null before the first one. */
  step: string | null;
}

/**
 * The sentence a surface shows in place of a composer on an engine-driven session.
 *
 * One spelling, because three surfaces say it - the reply box's placeholder, the Send
 * button's tooltip and the notice that replaces the box - and an operator reading two
 * different reasons for one disabled control has to work out which is true.
 */
export function pipelineDrivenSentence(link: SessionPipelineLink): string {
  return `Driven by ${PIPELINE_PROVIDER_INFO[link.provider].label} - act through its run in Runs`;
}

// ---- what a selected run is read in detail ---------------------------------------------

/**
 * One gate's verdict, as the provider recorded it.
 *
 * Deliberately NOT a field on `PipelineRun`. The projection rides the connect snapshot for
 * every run on the fleet, and `test/pipeline-sse.test.ts` pins one run at under 2kB with the
 * answer to growth written into its failure message: fetch step detail on demand for the
 * detail view rather than widening the wire. Verdicts are read by exactly one surface - the
 * one run somebody has open - so they travel on that surface's own request.
 */
export interface PipelineGateVerdict {
  /** The step whose gate this is. May be a name this build does not know. */
  step: string;
  satisfied: boolean;
  /** The provider's own sentence, or null when it recorded none. */
  reason: string | null;
  /** When the gate was answered, in epoch ms, or null when the record carried no time. */
  checkedAt: number | null;
  /**
   * The step that re-opened this gate, when a downstream refusal kicked the run back to it.
   *
   * The one durable trace a provider leaves of a run having gone round again, which is what
   * the detail view draws its attempts from - see `pipelineAttempts` in the web module.
   */
  kickbackFrom: string | null;
  /**
   * The verdict records a SKIP rather than evidence that passed.
   *
   * A tier-S run "passes" nine gates it never ran, and a surface that read `satisfied` alone
   * would credit it with them. Decided by the daemon's reader, once, so no two surfaces can
   * come to disagree about which of a run's ticks were earned.
   */
  skipped: boolean;
}

/**
 * Everything the detail view needs that the rail does not: the run's gate evidence.
 *
 * Read from the provider's files at request time rather than from the projection, so it is
 * as fresh as the moment it was asked for and costs nothing on a fleet where nobody has a
 * pipeline open. Keyed by the same triple as the run itself, and echoed back so a slow
 * response cannot be drawn under a run the operator has since moved off.
 */
export interface PipelineRunDetail {
  provider: PipelineProviderId;
  repoRoot: string;
  slug: string;
  /** Every gate the run has a record for, in the provider's own step order. */
  gates: PipelineGateVerdict[];
  /** When these files were read, in epoch ms. */
  readAt: number;
}

/**
 * What separates the parts of a composite key here.
 *
 * A unit separator rather than a space or a slash, and written as an ESCAPE rather than as
 * a literal so this file stays text that `git diff` and `grep` can read. Both of the parts
 * it joins can contain a space - a repository root is an absolute path, and macOS puts
 * spaces in them routinely - so a space would let `("/repo/a", "b c")` and
 * `("/repo/a b", "c")` produce one key, which is two features sharing one row.
 */
const KEY_SEPARATOR = "\u001f";

/**
 * One consented repository's key: `(provider, repoRoot)`.
 *
 * Exported and used everywhere rather than hand-written per call site, because four places
 * index by this pair - the health map, the consent reconciliation, the panel's row lookup
 * and the offsets - and two of them disagreeing is a repository whose health line belongs
 * to a different checkout.
 */
export function pipelineRepoKey(provider: PipelineProviderId, repoRoot: string): string {
  return `${provider}${KEY_SEPARATOR}${repoRoot}`;
}

/** The projection's key, as one string - for a `Map`, a `Set`, or a React key. */
export function pipelineRunKey(
  provider: PipelineProviderId,
  repoRoot: string,
  slug: string,
): string {
  return `${pipelineRepoKey(provider, repoRoot)}${KEY_SEPARATOR}${slug}`;
}

/** The same key, taken off a run. */
export function pipelineRunKeyOf(run: {
  provider: PipelineProviderId;
  repoRoot: string;
  slug: string;
}): string {
  return pipelineRunKey(run.provider, run.repoRoot, run.slug);
}

// ---- consent ----------------------------------------------------------------------------

/** How many repositories one operator may consent to. A watch tick reads each of them. */
export const MAX_PIPELINE_REPOS = 50;

/**
 * One repository an operator has said Mission Control may observe.
 *
 * Present in the list is CONFIGURATION; `enabled` is CONSENT. The two are separate acts
 * for the same reason a task source's are: a repository can be listed - because the
 * provider reports it, or because it was switched off yesterday - without anything reading
 * its files, and turning it on is a decision somebody makes on purpose.
 */
export const PipelineRepoSchema = z.object({
  provider: z.enum(PIPELINE_PROVIDER_IDS),
  /** Absolute repository root, as the daemon resolved it. */
  repoRoot: z.string().min(1),
  /** Ships OFF. See above. */
  enabled: z.boolean().default(false),
});
export type PipelineRepo = z.infer<typeof PipelineRepoSchema>;

/**
 * The whole `pipelines` blob: a schema-validated value over the `app_config` KV, the same
 * pattern as `taskSources` / `harnesses` / `foreman`, which is what means a new key needs
 * no migration - zod's defaults are applied on every read, so a blob written by an older
 * build gains new fields for free.
 *
 * `enabled` is a MASTER switch above the per-repository ones, and it is not redundant with
 * them. It is the one control that answers "stop looking at any of this" without asking an
 * operator to remember which repositories they had turned on - so switching it off and
 * back on restores exactly the set they consented to rather than an empty one.
 */
export const PipelinesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Foreman may unpark mechanical halts. Ships off and never widens to another class. */
  foremanMechanicalTriage: z.boolean().default(false),
  repos: z
    .array(PipelineRepoSchema)
    .max(MAX_PIPELINE_REPOS)
    .default([])
    // The pair keys the projection, the offsets and the health map. Two entries sharing
    // one would each overwrite the other's consent on every write.
    .refine(
      (list) => new Set(list.map((r) => `${r.provider} ${r.repoRoot}`)).size === list.length,
      { message: "two entries name the same repository" },
    ),
});
export type PipelinesConfig = z.infer<typeof PipelinesConfigSchema>;
export type PipelinesConfigInput = z.input<typeof PipelinesConfigSchema>;

/**
 * The repositories a pass should actually read: consented to, under a live master switch.
 *
 * One implementation, because the watcher, the health line and the consent-withdrawal
 * sweep all have to agree about it - and a second copy is how a repository comes to be
 * read by a loop that a panel is reporting as off.
 */
export function activePipelineRepos(config: PipelinesConfig): PipelineRepo[] {
  return config.enabled ? config.repos.filter((repo) => repo.enabled) : [];
}

// ---- what the Settings panel reads --------------------------------------------------------

/** One repository a provider says it manages, as offered in the consent list. */
export interface PipelineProject {
  /** Display name the provider itself uses. */
  name: string;
  /** Absolute repository root, canonicalized by the provider. */
  path: string;
  /** Origin remote, credential-redacted by the provider. Null when it reports none. */
  remote: string | null;
  /** The provider's own status word for the record. Carried through, never interpreted. */
  status: string | null;
}

/** What one probe of a provider found. */
export interface PipelineProbe {
  provider: PipelineProviderId;
  /** Whether the engine binary resolved at all. Everything else is conditional on it. */
  found: boolean;
  /** The command that was looked for, after the operator's env override. */
  bin: string;
  binPath: string | null;
  /**
   * Null means "this build could not tell", never "old".
   *
   * The engine ships no `--version` flag, so this is derived from the installation the
   * resolved binary points into. It gates nothing: an operator whose layout the derivation
   * does not recognise still gets detection, consent and a projection.
   */
  version: string | null;
  /** Where the project registry was looked for. Shown so a wrong path is diagnosable. */
  registryPath: string;
  projects: PipelineProject[];
  /** A bounded sentence about what went wrong, or null. A probe never throws. */
  error: string | null;
  checkedAt: number;
}

/**
 * Which spend role each provider's usage lands under in the ledger.
 *
 * `Record<PipelineProviderId, LlmSpendRole>` is the point of the indirection: the role keys
 * are persisted in `usage_ledger.note_key` and read back by exact value, so a provider that
 * shipped without one would either write an unlabelled key into permanent history or write
 * nothing at all - and the second failure is invisible. This way a provider appended to
 * `PIPELINE_PROVIDER_IDS` does not compile until somebody has appended its role too.
 */
export const PIPELINE_SPEND_ROLES: Record<PipelineProviderId, LlmSpendRole> = {
  "ai-conductor": "pipeline:ai-conductor",
};

/**
 * Which ledger WRITER id each provider's rows carry. The same argument as the roles above,
 * about the other persisted identifier on the row.
 *
 * `usage_ledger.writer` is append-only and is read back by exact value - it is how a row's
 * provenance survives a schema that can no longer tell one ingest from another by its
 * columns. A second engine gets a writer id of its own rather than borrowing this one:
 * "which program wrote this" is the one question the column answers, and two engines behind
 * one id makes it unanswerable for ever, because the rows are already written.
 */
export const PIPELINE_SPEND_WRITERS: Record<PipelineProviderId, string> = {
  "ai-conductor": "conductor",
};

/** Whether the provider's own background daemon is running in one repository. */
export type PipelineDaemonState = "running" | "paused" | "stopped" | "unknown";

/**
 * How observation is arriving for one repository - by push, or by reading files.
 *
 * Mission Control observes a pipeline engine two ways at once. Reading the engine's files on
 * a cadence always works and needs nothing installed; a visualizer plugin pushing events to
 * `POST /ingest/conductor` is faster but needs the operator to have installed it AND the
 * engine to start it. So this is the answer to "is my plugin working", and it has to
 * distinguish three things an operator would otherwise have to guess between:
 *
 * - `never` - nothing has ever been pushed for this repository. The shipped state, and the
 *   permanent one for anyone who has not installed the plugin. The file tail is observation.
 * - `live` - events are arriving now, so the tail has relaxed to a backfill sweep.
 * - `quiet` - the plugin has delivered here before and has stopped. The tail is primary
 *   again, so nothing is lost - but this is also exactly what a revoked token or a crashed
 *   engine looks like, and it must not read as `never`.
 *
 * Never a reason to stop reading files. The tail's cadence changes; its authority does not.
 */
export type PipelineIngestState = "never" | "live" | "quiet";

/**
 * What the last pass over one consented repository saw - the panel's health line.
 *
 * Derived and never persisted, like `TaskSourceStatus`: every figure is re-derived by the
 * next tick from files that are still on disk.
 */
export interface PipelineRepoStatus {
  provider: PipelineProviderId;
  repoRoot: string;
  daemon: PipelineDaemonState;
  /** How many runs the projection holds for this repository. */
  runs: number;
  /** How many of them are halted - the figure the health line leads with. */
  halted: number;
  /**
   * When the last pass finished, or null before the first one.
   *
   * Null is "not looked at yet", which is NOT the same claim as "nothing there" - a
   * just-enabled repository reports it, and the panel says so rather than drawing zeroes
   * as fact.
   */
  lastReadAt: number | null;
  /** Why the last pass saw less than it should have, or null. */
  error: string | null;
  /**
   * Whether a visualizer plugin is pushing events for this repository.
   *
   * Optional so a status assembled by an older build, or by a test that predates ingest,
   * still typechecks and renders - it reads as `never`, which is the honest answer for a
   * daemon that has no ingest at all.
   */
  ingest?: PipelineIngestState;
}

/** The whole Conductor panel in one read: consent, detection, and health. */
export interface PipelinesView {
  config: PipelinesConfig;
  probes: PipelineProbe[];
  status: PipelineRepoStatus[];
}

/**
 * What a provider answered when asked to register one canonical repository root.
 *
 * Registration changes provider-owned state only. It is deliberately not an observation
 * consent result: Mission Control writes that separate choice through `PipelinesConfig` after a
 * confirmed registration, so either half can fail without being reported as the other.
 */
export interface PipelineRepoRegistrationResult {
  ok: boolean;
  provider: PipelineProviderId;
  /** The canonical main-checkout root handed to the provider. */
  repoRoot: string;
  /** One bounded sentence confirming the registration or explaining the refusal. */
  detail: string;
  /** Bounded provider output for diagnosis. Empty on a clean confirmation. */
  output: string;
}

/** The registration answer plus the provider/config facts derived immediately afterwards. */
export interface PipelineRepoRegistrationResponse {
  registration: PipelineRepoRegistrationResult;
  view: PipelinesView;
}

/** One halted run offered to the standalone Foreman worker. */
export interface PipelineForemanItem {
  run: PipelineRun;
  /** Stable identity for this exact halt observation. */
  marker: string;
  /** Whether an episode already owns this marker. */
  handled: boolean;
}

/** The narrow, no-probe fleet view Foreman polls for pipeline triage. */
export interface PipelineForemanView {
  enabled: boolean;
  items: PipelineForemanItem[];
}

// ---- the frozen step table -------------------------------------------------------------

/** One entry of Mission Control's display copy of a provider's step vocabulary. */
export interface PipelineStepInfo {
  name: string;
  /** How the provider labels it. */
  label: string;
  phase: PipelinePhase;
  /**
   * Out of the linear sequence: the engine dispatches it only in response to something,
   * so it has no ordered slot and must not be drawn as one the run "skipped".
   */
  outOfBand: boolean;
  /**
   * A retained compatibility slot that performs no work. Drawn dashed, like a disabled
   * command, rather than hidden - it still occupies a slot in the provider's own state.
   */
  deprecated: boolean;
}

/**
 * ai-conductor's 22 sequential steps, in its own `ALL_STEPS` order, plus its four
 * out-of-band steps.
 *
 * Copied from `src/conductor/src/engine/steps.ts` at ai-conductor `8b51392d` and frozen
 * here. It is a DISPLAY aid, never an authority: nothing refuses a step name that is
 * missing from it, and `pipelineStepInfo` returning null is an ordinary answer meaning
 * "this build has not been taught what that step is", not an error. See the file header.
 */
const AI_CONDUCTOR_STEPS: readonly PipelineStepInfo[] = [
  { name: "worktree", label: "Worktree", phase: "SETUP", outOfBand: false, deprecated: false },
  { name: "memory", label: "Memory", phase: "UNDERSTAND", outOfBand: false, deprecated: false },
  { name: "explore", label: "Explore", phase: "DECIDE", outOfBand: false, deprecated: false },
  { name: "complexity", label: "Complexity", phase: "DECIDE", outOfBand: false, deprecated: false },
  { name: "prd", label: "PRD", phase: "DECIDE", outOfBand: false, deprecated: false },
  {
    name: "architecture_diagram",
    label: "Architecture Diagram",
    phase: "DECIDE",
    outOfBand: false,
    deprecated: false,
  },
  {
    name: "architecture_review",
    label: "Architecture Review",
    phase: "DECIDE",
    outOfBand: false,
    deprecated: false,
  },
  { name: "stories", label: "Stories", phase: "DECIDE", outOfBand: false, deprecated: false },
  {
    name: "conflict_check",
    label: "Conflict Check",
    phase: "DECIDE",
    outOfBand: false,
    deprecated: false,
  },
  { name: "plan", label: "Plan", phase: "DECIDE", outOfBand: false, deprecated: false },
  {
    name: "coherence_check",
    label: "Coherence Check",
    phase: "DECIDE",
    outOfBand: false,
    deprecated: false,
  },
  {
    name: "acceptance_specs",
    label: "Acceptance Specs",
    phase: "BUILD",
    outOfBand: false,
    deprecated: false,
  },
  { name: "build", label: "Build", phase: "BUILD", outOfBand: false, deprecated: false },
  // Retained no-op: `build_review` owns wiring judgement now, but the slot stays in the
  // engine's own state and prerequisite contracts until its scheduled retirement.
  {
    name: "wiring_check",
    label: "Wiring Check",
    phase: "BUILD",
    outOfBand: false,
    deprecated: true,
  },
  { name: "test_suite", label: "Test Suite", phase: "BUILD", outOfBand: false, deprecated: false },
  {
    name: "build_review",
    label: "Build Review",
    phase: "BUILD",
    outOfBand: false,
    deprecated: false,
  },
  { name: "manual_test", label: "Manual Test", phase: "SHIP", outOfBand: false, deprecated: false },
  { name: "prd_audit", label: "PRD Audit", phase: "SHIP", outOfBand: false, deprecated: false },
  {
    name: "architecture_review_as_built",
    label: "Architecture Review (as-built)",
    phase: "SHIP",
    outOfBand: false,
    deprecated: false,
  },
  { name: "retro", label: "Retro", phase: "SHIP", outOfBand: false, deprecated: false },
  { name: "rebase", label: "Rebase", phase: "SHIP", outOfBand: false, deprecated: false },
  { name: "finish", label: "Finish", phase: "SHIP", outOfBand: false, deprecated: false },
  // Out of band: dispatched in response to something rather than in sequence, so each is
  // drawn beside the strip rather than as a slot the run walked past.
  { name: "bootstrap", label: "Bootstrap", phase: "UNDERSTAND", outOfBand: true, deprecated: false },
  { name: "assess", label: "Assess", phase: "UNDERSTAND", outOfBand: true, deprecated: false },
  { name: "remediate", label: "Remediate", phase: "SHIP", outOfBand: true, deprecated: false },
  {
    name: "attribution_verify",
    label: "Attribution Verify",
    phase: "SHIP",
    outOfBand: true,
    deprecated: false,
  },
];

/** Every provider's frozen step table, keyed by provider. */
export const PIPELINE_STEPS: Record<PipelineProviderId, readonly PipelineStepInfo[]> = {
  "ai-conductor": AI_CONDUCTOR_STEPS,
};

/**
 * The steps a refused gate can send a run BACK to, per provider.
 *
 * Part of the same frozen display copy as the step table above, and under the same rule: it
 * states the engine's kickback rule so the detail view can print it beside the strip, and it
 * decides nothing. Mission Control never kicks a run back - the engine does - so a copy that
 * has fallen behind a conductor release makes one footer sentence stale and changes no
 * behaviour anywhere.
 *
 * It is drawn as a sentence rather than as return edges for the reason the workflow strip
 * draws its repair loop as one: four arrows from five phase cards back to four steps is a
 * picture nobody can read, and every one of them says the same thing.
 */
export const PIPELINE_KICKBACK_TARGETS: Record<PipelineProviderId, readonly string[]> = {
  "ai-conductor": ["prd", "architecture_review", "stories", "plan"],
};

/** Index of each known step's position, so ordering is a lookup rather than a scan. */
const STEP_ORDER: Record<PipelineProviderId, ReadonlyMap<string, number>> = {
  "ai-conductor": new Map(AI_CONDUCTOR_STEPS.map((step, i) => [step.name, i])),
};

/**
 * What this build knows about one step, or null when it knows nothing.
 *
 * Null is an ordinary answer: the provider is a separate program that may have added a
 * step since this table was frozen, and every caller has to be able to draw one.
 */
export function pipelineStepInfo(
  provider: PipelineProviderId,
  name: string,
): PipelineStepInfo | null {
  return PIPELINE_STEPS[provider].find((step) => step.name === name) ?? null;
}

/** Which phase a step belongs to, or null for a step this build does not know. */
export function pipelinePhaseOfStep(
  provider: PipelineProviderId,
  name: string,
): PipelinePhase | null {
  return pipelineStepInfo(provider, name)?.phase ?? null;
}

/**
 * Sort position for a step name. Every unknown name sorts AFTER every known one, in the
 * order it was first seen, which is the whole tolerance rule stated as a number.
 */
export function pipelineStepOrder(provider: PipelineProviderId, name: string): number {
  return STEP_ORDER[provider].get(name) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Order a run's steps for display: known steps in the provider's own sequence, unknown
 * ones appended in the order they arrived.
 *
 * Stable rather than merely sorted, because two unknown steps compare equal under
 * `pipelineStepOrder` and a browser that reshuffled them between two frames would draw a
 * strip that moved for no reason anybody could see.
 */
export function sortPipelineSteps<T extends { name: string }>(
  provider: PipelineProviderId,
  steps: readonly T[],
): T[] {
  return sortByPipelineStep(provider, steps, (step) => step.name);
}

/**
 * The same ordering for anything else keyed by a step name - gate verdicts, most of all,
 * which name their step `step` rather than `name`.
 *
 * One implementation, reached two ways, because the tolerance rule is the interesting part:
 * a second sort that spelled "unknown steps last, stably" slightly differently would draw a
 * strip and its evidence list in two different orders for the same run.
 */
export function sortByPipelineStep<T>(
  provider: PipelineProviderId,
  items: readonly T[],
  nameOf: (item: T) => string,
): T[] {
  return [...items]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const byOrder =
        pipelineStepOrder(provider, nameOf(a.item)) - pipelineStepOrder(provider, nameOf(b.item));
      return byOrder !== 0 ? byOrder : a.i - b.i;
    })
    .map((entry) => entry.item);
}

// ---- control: the verbs Mission Control may ask an engine to perform ----------------------
//
// The line every one of these is on the far side of: **Mission Control still writes nothing
// the engine owns.** An action spawns the engine's own CLI and reads what it says. The park
// markers, the grant files, the pidfile and the pause marker are all written by the engine,
// in response to a verb, exactly as they are when an operator types it - which is what keeps
// the projection a read of one program's state rather than a negotiation between two.
//
// So this vocabulary is a WIRE contract rather than a persisted one: nothing here reaches
// SQLite or a config blob, and a verb this build does not offer is simply a button that is
// not drawn. What makes it worth stating once, here, is that four surfaces read it - the run
// header, the attention row, the daemon route and (from phase 6) the Foreman's triage - and
// a second spelling of "unpark" would be a second control path to the same engine.

/**
 * Every control verb, as it crosses the wire.
 *
 * Named for what an OPERATOR is asking for rather than for the engine's own argv: `grant`
 * is one word here and `decide-grant --slug … --step … --reason …` at the provider, because
 * a second engine's spelling of the same intent must be a difference inside its provider and
 * not a second entry in this tuple.
 */
export const PIPELINE_ACTIONS = [
  "daemon-start",
  "daemon-stop",
  "daemon-pause",
  "daemon-resume",
  "park",
  "unpark",
  "grant",
] as const;
export type PipelineAction = (typeof PIPELINE_ACTIONS)[number];

/** Runtime membership, for a verb that arrived over the wire. */
export function isPipelineAction(value: string): value is PipelineAction {
  return (PIPELINE_ACTIONS as readonly string[]).includes(value);
}

/**
 * What one verb is called, what it needs, and what it acts on.
 *
 * `scope` is the load-bearing field and it is not cosmetic: a repository verb addressed at a
 * run would silently pause every OTHER feature in that checkout, and a run verb with no run
 * has nothing to name. The route refuses on this record rather than on a hand-written list
 * per verb, so the button that is drawn and the request that is accepted cannot disagree.
 */
export interface PipelineActionInfo {
  label: string;
  /** One sentence for the tooltip: what pressing this does, in the engine's terms. */
  blurb: string;
  scope: "repo" | "run";
  /** The verb names a step - only a DECIDE re-entry grant does. */
  needsStep: boolean;
  /**
   * The verb carries the operator's own justification, which Mission Control never invents.
   *
   * True for exactly one verb today, and the reason is the engine's: a grant is a one-time
   * authorization recorded with `grantedBy: "operator"`, and its `reason` is the whole audit
   * trail of why an autonomous DECIDE re-entry was allowed. A default sentence supplied from
   * here would be Mission Control forging that trail - so the form asks, and the button
   * cannot be pressed until somebody has answered.
   */
  needsReason: boolean;
}

export const PIPELINE_ACTION_INFO: Record<PipelineAction, PipelineActionInfo> = {
  "daemon-start": {
    label: "Start daemon",
    blurb: "Start the engine's own background daemon in this repository.",
    scope: "repo",
    needsStep: false,
    needsReason: false,
  },
  "daemon-stop": {
    label: "Stop daemon",
    blurb: "Stop the engine's background daemon. Nothing in this repository advances after it.",
    scope: "repo",
    needsStep: false,
    needsReason: false,
  },
  "daemon-pause": {
    label: "Pause daemon",
    blurb: "Hold the daemon between steps. A step already running finishes.",
    scope: "repo",
    needsStep: false,
    needsReason: false,
  },
  "daemon-resume": {
    label: "Resume daemon",
    blurb: "Let the daemon dispatch again.",
    scope: "repo",
    needsStep: false,
    needsReason: false,
  },
  park: {
    label: "Park",
    blurb: "Set this feature aside. The engine stops dispatching and re-kicking it.",
    scope: "run",
    needsStep: false,
    needsReason: false,
  },
  unpark: {
    label: "Unpark",
    blurb: "Let the engine dispatch this feature again, and reset its no-evidence counter.",
    scope: "run",
    needsStep: false,
    needsReason: false,
  },
  grant: {
    label: "Grant DECIDE re-entry",
    blurb:
      "Authorize ONE autonomous entry to one DECIDE step for this feature. Spent on the next " +
      "dispatch, and never renewed on its own.",
    scope: "run",
    needsStep: true,
    needsReason: true,
  },
};

/**
 * The DECIDE steps a grant may NEVER name, per provider.
 *
 * `plan` for ai-conductor, and this copy exists so the picker can leave it out with a note
 * rather than offering a button whose only outcome is the engine's refusal. The engine
 * refuses it in four independent places of its own - the CLI, the entry policy before the
 * grant is read, the consumption path, and the halt it raises - so nothing here is the
 * enforcement. It is the EXPLANATION, which is the part a refusal relayed from a subprocess
 * cannot give: a daemon that re-planned would rewrite an approved artifact with no human at
 * the gate, which is the failure the re-entry gate exists to prevent.
 */
export const PIPELINE_UNGRANTABLE_STEPS: Record<PipelineProviderId, readonly string[]> = {
  "ai-conductor": ["plan"],
};

/**
 * The steps a DECIDE re-entry grant may name, in the engine's own order.
 *
 * DERIVED from the frozen step table rather than listed, because the engine derives it the
 * same way - its policy gate asks `step.phase === "DECIDE"` and never consults a name list.
 * A conductor release that adds a DECIDE step therefore appears in this picker as soon as
 * the frozen table learns it, and one that this build has never heard of is simply absent
 * from a picker rather than mis-offered.
 */
export function pipelineGrantableSteps(provider: PipelineProviderId): PipelineStepInfo[] {
  const ungrantable = new Set(PIPELINE_UNGRANTABLE_STEPS[provider]);
  return PIPELINE_STEPS[provider].filter(
    (step) => step.phase === "DECIDE" && !step.outOfBand && !ungrantable.has(step.name),
  );
}

/** Whether a step name may carry a grant. The route's refusal, and the picker's filter. */
export function isPipelineGrantableStep(provider: PipelineProviderId, step: string): boolean {
  return pipelineGrantableSteps(provider).some((entry) => entry.name === step);
}

/**
 * The sentence a refused grant gets, spelled once.
 *
 * Mission Control refuses `plan` BEFORE spawning - see `PIPELINE_UNGRANTABLE_STEPS` - so this
 * is what a caller reads instead of the engine's own stderr. Written as an explanation rather
 * than as a relayed error for that reason: nothing ran, so there is no output to quote.
 */
export function pipelineGrantRefusal(provider: PipelineProviderId, step: string): string | null {
  if (PIPELINE_UNGRANTABLE_STEPS[provider].includes(step)) {
    return (
      `${PIPELINE_PROVIDER_INFO[provider].label} never grants re-entry to '${step}': an ` +
      "autonomous pass there would rewrite an approved decision with nobody at the gate. " +
      "Drive that revision yourself, then resume the feature."
    );
  }
  if (!isPipelineGrantableStep(provider, step)) {
    return `'${step}' is not a DECIDE step this build can offer a grant for.`;
  }
  return null;
}

/**
 * Which verbs each halt class offers, in the order an operator should consider them.
 *
 * `Record<PipelineHaltClass, …>` for the reason every record in this file is one: a class
 * appended to the tuple does not compile until somebody has said what clears it. Empty is a
 * legitimate answer and `protected-artifact` is it - that halt is cleared by the reseal
 * ceremony, which is a console rather than a verb, because the engine refuses to perform it
 * without a terminal.
 *
 * `mechanical` gets `unpark` alone deliberately. The engine re-kicks that class on its own
 * once the cause clears, so the useful action is releasing a park somebody applied while
 * looking at it - and offering a grant beside it would suggest a DECIDE gate is what stopped
 * a run that no DECIDE gate touched.
 */
export const PIPELINE_HALT_ACTIONS: Record<PipelineHaltClass, readonly PipelineAction[]> = {
  "needs-human": ["grant", "unpark"],
  mechanical: ["unpark"],
  "protected-artifact": [],
  legacy: ["unpark"],
  unclassified: ["unpark"],
};

/**
 * Whether a DECIDE re-entry grant is a thing this run can be offered at all.
 *
 * Read off the table above rather than decided again here, and that is the whole point of the
 * function: the inbox draws a halt's verbs from `PIPELINE_HALT_ACTIONS`, and a run header that
 * decided for itself which verbs a run deserves is a second policy that agrees with the first
 * one only until somebody edits one of them. It disagreed exactly there - the header offered a
 * grant on every unfinished run, including a run that has not halted at all.
 *
 * A grant is the ANSWER TO A REFUSAL, which is why the halt is what licenses it. The engine
 * stops at a DECIDE gate, classifies that stop `needs-human`, and the grant authorizes one
 * re-entry past it; granted to a run that never stopped, the same record is a standing
 * permission for the engine to walk through the next gate it meets with nobody watching. That
 * is the gate's entire purpose, spent in advance.
 *
 * The daemon holds this too (`POST /api/pipelines/action`), for the reason every refusal in
 * this file is held on both sides: hiding a button decides what an operator is offered, not
 * what the loopback API accepts.
 */
export function pipelineGrantAllowed(halt: { class: PipelineHaltClass } | null): boolean {
  return halt !== null && PIPELINE_HALT_ACTIONS[halt.class].includes("grant");
}

/**
 * Which daemon verbs are worth offering for each state the daemon was observed in.
 *
 * Derived from the state rather than drawn as four permanent buttons, because three of them
 * are no-ops at any given moment and a control whose only outcome is "already paused" teaches
 * an operator to distrust the row. The engine tolerates every one of them regardless - pause
 * on a paused daemon prints `already paused` - so this decides what is USEFUL, never what is
 * permitted.
 *
 * `unknown` offers both ends deliberately. That state means a pass could not read the
 * engine's `.daemon/` at all, so the honest offer is the two verbs that resolve the question
 * either way rather than a guess about which one is needed.
 */
export const PIPELINE_DAEMON_ACTIONS: Record<PipelineDaemonState, readonly PipelineAction[]> = {
  running: ["daemon-pause", "daemon-stop"],
  paused: ["daemon-resume", "daemon-stop"],
  stopped: ["daemon-start"],
  unknown: ["daemon-start", "daemon-stop"],
};

// ---- consoles: the two things that need a terminal rather than a verb ---------------------

/**
 * The hosted terminals this integration opens.
 *
 * Separate from the verbs above because they are not requests with answers: one ATTACHES to
 * a running daemon for as long as somebody watches it, and the other performs a ceremony the
 * engine refuses to perform without a terminal at all. Neither has stdout Mission Control
 * could validate, because in both cases the person reading the output is the point.
 */
export const PIPELINE_CONSOLES = ["daemon", "reseal"] as const;
export type PipelineConsole = (typeof PIPELINE_CONSOLES)[number];

/** Runtime membership, for a console named over the wire. */
export function isPipelineConsole(value: string): value is PipelineConsole {
  return (PIPELINE_CONSOLES as readonly string[]).includes(value);
}

export interface PipelineConsoleInfo {
  label: string;
  blurb: string;
  scope: "repo" | "run";
  /** The verb a person is about to perform, for the backend picker's heading. */
  verb: string;
}

export const PIPELINE_CONSOLE_INFO: Record<PipelineConsole, PipelineConsoleInfo> = {
  daemon: {
    label: "Open daemon console",
    blurb:
      "Attach a terminal to the engine daemon's own session, read-only, so you can watch " +
      "what it is doing without typing into it.",
    scope: "repo",
    verb: "Watch the engine daemon in",
  },
  reseal: {
    label: "Open reseal terminal",
    blurb:
      "Re-seal a protected artifact the engine found changed under it. The engine refuses " +
      "this without a terminal, so it happens where you can read the result.",
    scope: "run",
    verb: "Run the reseal ceremony in",
  },
};

/**
 * Which console each halt class offers, beside the verbs in `PIPELINE_HALT_ACTIONS`.
 *
 * The other half of that record, and the reason its `protected-artifact` entry is empty: that
 * halt is cleared by a ceremony rather than by a verb, and a class whose only way out is a
 * hosted terminal would otherwise be the one attention row with nothing on it. Kept as a
 * second record rather than folded into the first because the two are not interchangeable at
 * the call site - one posts and reads an answer, the other opens a window.
 */
export const PIPELINE_HALT_CONSOLES: Record<PipelineHaltClass, readonly PipelineConsole[]> = {
  "needs-human": [],
  mechanical: [],
  "protected-artifact": ["reseal"],
  legacy: [],
  unclassified: [],
};

/**
 * Whether one console is licensed by the run state the daemon is holding.
 *
 * Repository consoles do not answer a halt and are always eligible once repository consent
 * has passed. A run console does: hiding its button decides what the dashboard offers, while
 * this predicate also lets the route decide what the loopback API accepts from any caller.
 */
export function pipelineConsoleAllowed(
  console_: PipelineConsole,
  halt: { class: PipelineHaltClass } | null,
): boolean {
  return (
    PIPELINE_CONSOLE_INFO[console_].scope === "repo" ||
    (halt !== null && PIPELINE_HALT_CONSOLES[halt.class].includes(console_))
  );
}

/**
 * What a control request may carry: how many artifact paths one reseal may name, how long
 * each may be, and how long a rationale may be - a grant's as well as a reseal's.
 *
 * Bounded because every one of them reaches an argv this daemon composes, and an unbounded
 * list from a browser is an unbounded command line. Generous enough that no real ceremony
 * or grant meets them.
 */
export const PIPELINE_CONTROL_LIMITS = { paths: 20, pathBytes: 1024, reasonBytes: 2000 } as const;

// ---- what crosses the wire ----------------------------------------------------------------

/**
 * One control request.
 *
 * The run's identity is the same `(provider, repoRoot, slug)` triple every other pipeline
 * route takes, with `slug` null for a repository verb - a discriminated union per verb would
 * be seven near-identical members whose only difference is a field this record already
 * declares in `PIPELINE_ACTION_INFO`. The cross-field rules are checked against that record
 * below, so adding a verb cannot forget them.
 */
export const PipelineActionRequestSchema = z
  .object({
    provider: z.enum(PIPELINE_PROVIDER_IDS),
    repoRoot: z.string().min(1),
    /** The feature, for a run-scoped verb. Null, and refused, for a repository one. */
    slug: z.string().min(1).nullable().default(null),
    action: z.enum(PIPELINE_ACTIONS),
    /**
     * Present only for the standalone Foreman worker. An absent value is an operator action,
     * which remains available when Foreman is off; the daemon re-checks both automation
     * switches for a Foreman-tagged request immediately before it reaches the provider.
     */
    requestedBy: z.literal("foreman").optional(),
    /** The DECIDE step a grant names. */
    step: z.string().min(1).nullable().default(null),
    /** The operator's own justification, for a verb that records one. */
    reason: z.string().min(1).max(PIPELINE_CONTROL_LIMITS.reasonBytes).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const info = PIPELINE_ACTION_INFO[value.action];
    // Both directions. A missing slug on a run verb is the obvious half; a slug supplied
    // with a repository verb is the dangerous one, because it reads as "pause this feature"
    // and would in fact pause every feature in the checkout.
    if (info.scope === "run" && value.slug === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slug"], message: `${value.action} names a feature` });
    }
    if (info.scope === "repo" && value.slug !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: `${value.action} acts on the whole repository, not one feature`,
      });
    }
    if (info.needsStep && value.step === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["step"], message: `${value.action} names a step` });
    }
    if (!info.needsStep && value.step !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["step"], message: `${value.action} names no step` });
    }
    if (info.needsReason && (value.reason === null || value.reason.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `${value.action} records why you allowed it`,
      });
    }
  });
export type PipelineActionRequest = z.infer<typeof PipelineActionRequestSchema>;

/** One request to open a hosted terminal. */
export const PipelineConsoleRequestSchema = z
  .object({
    provider: z.enum(PIPELINE_PROVIDER_IDS),
    repoRoot: z.string().min(1),
    slug: z.string().min(1).nullable().default(null),
    console: z.enum(PIPELINE_CONSOLES),
    /**
     * The reseal ceremony's own arguments, absent for the daemon console.
     *
     * Supplied by the operator rather than derived here, and that is the same rule the grant
     * form holds: the engine records a reseal as an operator act with a rationale, and a path
     * list Mission Control guessed at would be Mission Control deciding which sealed decision
     * is allowed to have moved.
     */
    paths: z
      .array(z.string().min(1).max(PIPELINE_CONTROL_LIMITS.pathBytes))
      .max(PIPELINE_CONTROL_LIMITS.paths)
      .default([]),
    reason: z.string().max(PIPELINE_CONTROL_LIMITS.reasonBytes).default(""),
    /** Also clear the halt, which the engine does only for a protected-artifact one. */
    clearHalt: z.boolean().default(false),
    backend: z.enum(TERMINAL_BACKEND_IDS),
  })
  .superRefine((value, ctx) => {
    if (PIPELINE_CONSOLE_INFO[value.console].scope === "run" && value.slug === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slug"], message: "that console names a feature" });
    }
    if (value.console !== "reseal") return;
    if (value.paths.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paths"], message: "name at least one sealed artifact" });
    }
    if (value.reason.trim() === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "the engine records why you resealed" });
    }
  });
export type PipelineConsoleRequest = z.infer<typeof PipelineConsoleRequestSchema>;

/**
 * What an action answers with, whether it worked or not.
 *
 * Always a 200 with `ok` inside, the shape `POST /api/ensembles/preview` uses: "the engine
 * refused" is the ANSWER to this request rather than a failure of it, and the surface that
 * asked has to draw the engine's own words either way. The two refusal classes that DO get a
 * status - a repository nobody consented to, a body that does not parse - are the ones where
 * there is no engine answer to carry.
 */
export interface PipelineActionResult {
  ok: boolean;
  action: PipelineAction;
  /**
   * What was asked of the engine, as a command line.
   *
   * Shown beside a failure so an operator can run the same thing by hand and see more. It is
   * assembled from the argv this daemon spawned rather than re-derived for display, so it
   * cannot describe a command other than the one that ran.
   */
  command: string;
  /** One sentence: the confirmation parsed out of the engine's output, or why this failed. */
  detail: string;
  /** The engine's own output, clipped. Carried on a failure; empty on a clean success. */
  output: string;
}

/** What opening a console answers with. */
export interface PipelineConsoleResult {
  ok: boolean;
  console: PipelineConsole;
  /** The terminal that took it, for the flash an operator reads. */
  label: string;
  error?: string;
}
