import { z } from "zod";

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

/** Whether the provider's own background daemon is running in one repository. */
export type PipelineDaemonState = "running" | "paused" | "stopped" | "unknown";

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
}

/** The whole Conductor panel in one read: consent, detection, and health. */
export interface PipelinesView {
  config: PipelinesConfig;
  probes: PipelineProbe[];
  status: PipelineRepoStatus[];
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
