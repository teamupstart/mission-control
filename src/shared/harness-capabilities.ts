import { AGENT_TYPES, SESSION_RUNTIMES } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";
import type {
  AgentType,
  PermissionMode,
  Session,
  SessionRuntime,
  ThinkingLevel,
} from "./types.ts";
// By value, because `workQueueUnsupportedWhy` composes prose from it. Naming stays
// `AGENT_IDENTITY`'s job - a second register on a capability object is the exact defect
// Phase 0 collapsed.
import { AGENT_IDENTITY } from "./agent.ts";
import type { StandingInstructionsMechanism } from "./standing-instructions.ts";

// The Harness axis' PURE half: what an agent can do, spelled as data, with no `node:`
// imports and no filesystem.
//
// Why this is not simply more fields on `Harness` (`server/harness/types.ts`): most of
// these capabilities are answered in the BROWSER. The dashboard decides whether to draw a
// mode picker, whether a work-queue box can exist, and what sentence to show when it
// can't - and it cannot import a spec whose `locate` calls `statSync`. Splitting by
// PURITY rather than by capability keeps that from becoming a second vocabulary: `Harness
// extends HarnessCapabilities`, so a server call site holding a harness still sees every
// slot on one object, and the two records ask disjoint questions (this one asks the pure
// ones, `HARNESSES` asks only for `transcript`).
//
// `Record<AgentType, HarnessCapabilities>` is the enforcement, the same one `HARNESSES`
// and `SESSION_FIELD_COMPARATORS` use: a new id in `AGENT_TYPES` does not compile until
// every capability below is either implemented or explicitly declared `null`.
//
// `null` is a first-class answer meaning "this harness genuinely does not have this",
// never a stub. The point of the migration is that `if (!harness.permissionModes)` states
// WHY a branch is skipped, where `if (agent !== "claude")` only ever stated WHO - so a new
// harness that genuinely lacks a capability takes the existing, already-tested degradation
// path instead of needing a code change.
//
// Test: `harness-capabilities.test.ts` pins the degradations; `session-contracts.test.ts`
// pins that the record cannot have a hole.

/**
 * Driving the agent's permission mode - what it will do without asking.
 *
 * Null for a harness with no such concept at all. That is not the same as "we can't read
 * it right now": the routes refuse with a 400 rather than attempting a walk, the card
 * draws no chip, and the dispatcher does not try to arm a mode that does not exist.
 */
export interface PermissionModeSpec {
  /**
   * The modes a picker offers, in the agent's native control order.
   *
   * Not every listed mode is reachable in every session - some are gated behind a launch
   * flag, feature, or account support the daemon cannot see. The live-control path verifies
   * the option exists and reports a refusal instead of claiming it changed.
   */
  pickable: readonly PermissionMode[];
  /**
   * How a live session changes modes.
   *
   * Claude exposes a one-way Shift+Tab cycle with a readable footer. Codex exposes a
   * numbered `/permissions` menu instead. Keeping the mechanism here lets the shared
   * card picker ask the harness rather than smuggling an agent-id check into each layout.
   */
  liveControl:
    | { kind: "cycle" }
    | {
        kind: "menu";
        command: string;
        composerReady(paneText: string): boolean;
        labels: Partial<Record<PermissionMode, string>>;
        confirmations?: Partial<Record<PermissionMode, string>>;
      };
  /**
   * The mode a freshly dispatched session is driven to when "auto mode on dispatch" is
   * on, or null when this harness has modes but none that mean "proceed autonomously".
   *
   * Separate from `pickable` because the two answer different questions: `pickable` is
   * what a human may choose, this is what the setting promises on the operator's behalf.
   */
  onDispatch: PermissionMode | null;
  /**
   * How to start a session already in `mode`, as launch argv - or null when this harness
   * can only reach a mode by walking its TUI after launch.
   *
   * This is what "auto mode on dispatch" uses now, instead of the post-launch Shift+Tab
   * walk (`setPermissionMode`): a flag on the argv sets the mode declaratively, so it no
   * longer depends on a readable mode-line footer. A freshly launched session's
   * folder-trust dialog HIDES that footer, and the walk read it as "can't see the mode"
   * and gave up - silently leaving the session in its default mode. A flag is also
   * scoped to sessions WE launch by construction: it can only ride an argv we build.
   *
   * The walk stays the mechanism for a human swapping a LIVE session's mode from the
   * card, where there is no relaunch to carry a flag. Null here says exactly that: this
   * harness has modes, but the only lever is the walk.
   *
   * Note the token can differ from the `PermissionMode` name: the name is what Claude
   * reports on hooks and prints in its footer, the arg is what its CLI accepts, and the
   * renderer bridges the two (see Claude's spec).
   */
  launchArgs: ((mode: PermissionMode) => readonly string[]) | null;
}

/**
 * Installing skills for a harness and invoking them in a live session.
 *
 * Null means the harness does not load Mission Control-managed skills. Within a
 * non-null spec, reload and typed invocation are independent capabilities: a harness
 * may watch its directory without a reload command, or load skills without exposing a
 * composer syntax that runs one by name.
 */
export interface SkillsSpec {
  /**
   * The command that makes a live session re-read its skills directory without being
   * restarted. Verified against claude 2.1.211: a directory symlinked in AFTER a session
   * reached its prompt is picked up by this and nothing else - there is no watcher on the
   * skills directory.
   *
   * Spelled once here because it is typed into a live pane, so the bytes must have
   * exactly one definition. It must also stay a SINGLE LINE - a slash command carrying
   * a newline is two submissions.
   *
   * Do NOT parse what comes back. On a REMOVAL the count correctly dropped (the skill
   * really did unload) while the label still read "(no changes)". The unload is real; the
   * message is not trustworthy. Treat delivery as fire-and-forget.
   */
  reloadCommand: string | null;
  reloadIdleSource: "hooks" | "transcript" | null;
  /**
   * How a skill's NAME becomes the ONE line typed into this harness's composer to run
   * it, or null when the harness loads skills but offers no typed invocation at all.
   *
   * The three shipped harnesses spell the same act three different ways, and the whole
   * point of this slot is that no caller has to know which is which. A harness-specific
   * invocation sent to a different TUI is just literal text it cannot execute.
   *
   * A line, not a token, because the invocation is not the only thing that has to be
   * true: it must also SUBMIT. Measured against codex-cli 0.145.0, over the daemon's own
   * delivery (tmux bracketed paste, then one Enter):
   *
   *  - `$name` at the end of the composer opens Codex's skill-mention popup ("Press enter
   *    to insert or esc to close"). That popup EATS the first Enter to insert the
   *    mention, so the message is still sitting unsubmitted afterwards - and Codex
   *    declares `pastePlaceholder: null`, so delivery spends exactly one Enter and has no
   *    evidence to retry on. The wrap-up would silently never be sent.
   *  - Worse when the name matches nothing: the popup says "no matches" and Enter does
   *    nothing AT ALL, so the composer can never be submitted without an Esc first.
   *  - A SPACE (and only whitespace - a trailing `.` is read as part of the name and
   *    lands back in "no matches") closes the popup. The token then stays plain text
   *    rather than becoming a mention token, and one Enter submits it - and the skill is
   *    still loaded and followed, because every skill's name and description are already
   *    in Codex's system prompt.
   *
   * So Codex's line carries a trailing clause. It is not decoration: it is what keeps the
   * line submittable by the one Enter this harness gets.
   *
   * Keep it a SINGLE LINE for `reloadCommand`'s reason - `sendText` submits on every
   * embedded newline, so a wrapped invocation is two half-instructions.
   *
   * Changing what a harness returns here RETIRES a payload: `isWrapupPayload` recognises
   * Foreman's own instruction coming back as a session's goal by composing this, so an
   * older spelling still sitting in someone's DB has to be moved to
   * `RETIRED_WRAPUP_PAYLOADS` (`@shared/queue.ts`) rather than dropped.
   */
  invoke: ((name: string) => string) | null;
  /**
   * Env var naming the skills directory outright, overriding both paths below. A test (or
   * an operator) that wants a specific directory names it and gets it.
   */
  dirEnvVar: string;
  /**
   * Path segments under the operator's REAL home - the machine-wide install, which is the
   * whole point of the feature.
   */
  homeDir: readonly string[];
  /**
   * The single directory name used when the daemon runs on an explicit home override. An
   * isolated daemon has its own, usually empty, config and no business reconciling the
   * real install's symlinks against it - see `claudeSkillsDir`, which records the data
   * loss that rule exists to prevent.
   */
  isolatedDirName: string;
}

/**
 * Running a Foreman work queue against this harness.
 *
 * Two things have to be true to queue work: the agent must report when it picks an item
 * up and finishes it (hooks), and its transcript must be readable back to check that it
 * did. Claude and Codex can do both and use the harness-neutral pane delivery path. Codex
 * hooks are attached only to Mission Control launches, so a discovery-only session still
 * takes the per-session refusal until one reports a hook. Pi has readable turns and lifecycle
 * events, but its Mission integration has not shipped yet, so its per-session refusal states
 * that current gap.
 *
 * Whatever the reason, the consequence of a null is the same and is why it is not a
 * detail: a queue on a session the worker skips is a one-way trip to nowhere. Because the
 * session is LIVE its key is live, so neither the cwd re-attach hint nor the orphan sweep
 * would ever offer the batch to anyone.
 */
export interface WorkQueueSpec {
  /**
   * What to tell the operator when the harness CAN hold a queue but this particular
   * session has never reported a hook - a fixable install problem, as distinct from the
   * permanent incapacity `null` describes.
   */
  uninstrumentedWhy: string;
}

/**
 * Clearing the agent's conversation context in place, without restarting it.
 *
 * Null means there is no such command, and the reset path degrades to `cleared: false` -
 * the identical answer a session with no pane has always produced, which every caller
 * already handles. `resetToOrigin` used to send Claude's `/clear` to EVERY agent type
 * ungated, which for a harness that does not speak Claude's slash commands typed a
 * literal `/clear` into the composer as a prompt.
 */
export interface ClearContextSpec {
  /**
   * The command typed into the pane. Single-line, for `reloadCommand`'s reason: a newline
   * is a second submission.
   */
  command: string;
}

/**
 * Registering our MCP server with the agent's own client.
 *
 * Null means the agent has no MCP client to register with, so the installer says so
 * rather than shelling out to a CLI that was never going to exist.
 */
export interface McpSpec {
  /** The CLI that owns the registration, resolved on PATH. */
  cli: string;
  /** Where the registration is written (`claude mcp add -s <scope>`). */
  scope: string | null;
  /** Flag used for each environment assignment by this CLI. */
  envFlag: "-e" | "--env";
  /** The name we register under - also the name an uninstall removes. */
  serverName: string;
}

/**
 * How Mission Control's own tools reach the model, distinct from the vendor MCP client.
 * The mechanism describes the route, not whether it is currently installed. Launch scope
 * is reported by the argv builder; machine scope needs an installation probe.
 */
export interface MissionToolsSpec {
  mechanism: "mcp-client" | "installed-extension";
  scope: "launch" | "machine";
}

/** Selecting and applying reasoning effort at launch and in a live session. */
export interface EffortSpec {
  /** Values the harness accepts, in increasing order of reasoning spend. */
  levels: readonly ThinkingLevel[];
  /**
   * Values the model currently selected in a session accepts. A harness-level list is
   * still needed for launch settings, where no session model exists yet; the live
   * picker must ask the model because providers can expose different ceilings.
   */
  levelsFor(modelId: string | null): readonly ThinkingLevel[];
  /** Exact argv fragment that applies one level to a newly launched session. */
  launchArgs(level: ThinkingLevel): readonly string[];
  /**
   * WHEN an embedded driver's accepted level actually takes effect.
   *
   * `"now"` means the driver moves the conversation it is already running, so the change
   * is observable as soon as the call returns. `"next-turn"` means the level rides the
   * next turn the driver starts and the running one keeps its old value - the card must
   * say the selection is pending rather than claim it applied. `null` is a harness with
   * no embedded effort control at all.
   *
   * Declared here, and read by the route, so "does this accepted change need a pending
   * projection" is a fact about the harness rather than a branch on an agent name.
   */
  driverApplies: "now" | "next-turn" | null;
  /** The harness's own session-scoped effort control, or null when it has none. */
  sessionPicker:
    | {
        kind: "horizontal";
        command: string;
        composerReady(paneText: string): boolean;
        visible: RegExp;
        selected(paneText: string, model: string): ThinkingLevel | null;
        commit: string;
      }
    | {
        kind: "shortcuts";
        composerReady(paneText: string): boolean;
        selected(paneText: string, modelId: string): ThinkingLevel | null;
        lower: "shift-down";
        raise: "shift-up";
      }
    | null;
}

const CLAUDE_PICKER_VISIBLE = /◉\s+(?:xhigh|medium|high|max|low)\s+effort[\s\S]*use this session only/i;

function claudeComposerReady(paneText: string): boolean {
  const prompt = paneText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("❯"))
    .at(-1);
  return prompt === "❯";
}

function claudePickerSelection(paneText: string, _model: string): ThinkingLevel | null {
  if (!CLAUDE_PICKER_VISIBLE.test(paneText)) return null;
  const match = /^\s*◉\s+(xhigh|medium|high|max|low)\s+effort\b/im.exec(paneText);
  return match ? (match[1]!.toLowerCase() as ThinkingLevel) : null;
}

function codexComposerReady(paneText: string): boolean {
  const prompt = paneText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("›"))
    .at(-1);
  return prompt === "›" || prompt === "› Ask Codex to do anything" || prompt === "› Use /skills to list available skills";
}

function codexStatusSelection(paneText: string, modelId: string): ThinkingLevel | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escaped}\\s+(low|medium|high|xhigh|max|ultra)(?:\\s|·)`, "im").exec(paneText);
  if (!match) return null;
  const level = match[1]!.toLowerCase();
  return level === "ultra" ? "max" : level as ThinkingLevel;
}

/**
 * Can one dispatched session hold WRITE access to checkouts outside its own cwd?
 *
 * The capability behind multi-repo tasks. A session's cwd is always the primary repo's
 * worktree; a secondary repo is a second worktree the same session is granted access to,
 * and a harness that cannot express that grant at launch cannot run one of these tasks.
 *
 * A spec rather than a boolean, for the reason `permissionModes` is one: the answer the
 * dispatcher needs is which flags grant access, or why no grant is needed. Keeping that beside
 * the measurement is what stops a launch path from re-deriving it per harness. Null is a
 * MEASURED unsupported, never a placeholder.
 */
export type MultiRepoDispatchSpec =
  | {
      kind: "flags";
      /** Launch argv granting every directory; called only with a non-empty list. */
      launchArgs: (dirs: readonly string[]) => string[];
      /** Whether the embedded driver also carries the grant. */
      sdk: boolean;
    }
  | {
      kind: "no-boundary";
      /** Measured reason no directory grant is needed. */
      why: string;
      sdk: boolean;
    };

/**
 * Stopping the turn this session is running right now, without ending the session.
 *
 * The gesture is one key (Ctrl+C on the dashboard) and the mechanism is per-runtime, which
 * is the whole reason this is a spec rather than a boolean: an embedded session is stopped
 * through its driver's own interrupt primitive, and a pane-backed one by writing `Escape`
 * into the terminal - never by forwarding the operator's literal Ctrl+C, which both shipped
 * TUIs read as "clear the input line" and, pressed twice, as "quit".
 *
 * It carries the RUNTIMES and nothing else, because that is the only part of the answer the
 * browser needs: whether to offer the control on this card, and what to say in the tooltip
 * when it cannot. The concrete keystroke is a terminal `Key`, which lives in
 * `src/server/terminal/` and cannot be named from a browser-safe module - the same split
 * `runtimes`/`sdk` and `resumes`/`resume` already use.
 *
 * Null means this harness cannot be interrupted on any runtime at all. That is a permanent
 * incapacity rather than a gap in the plumbing, and the consequence is stated rather than
 * hidden: the card draws the control disabled with the sentence
 * `interruptUnsupportedWhy` composes, so an operator learns the turn has to finish or the
 * session has to be killed instead of pressing a key that silently does nothing.
 */
export interface InterruptSpec {
  /** Runtimes on which this harness's current turn can be stopped. */
  runtimes: readonly SessionRuntime[];
}

/**
 * How this harness carries the operator's REPOSITORY STANDING INSTRUCTIONS - text that is
 * not a conversation turn - per runtime.
 *
 * A spec rather than a boolean for the reason `permissionModes` is one: the answer the
 * composer needs is not "yes" but "which channel", and the channel differs by RUNTIME
 * within a single harness. Claude carries it as a system-prompt append on both of its
 * runtimes, by two different spellings; Codex has a channel on its embedded driver and
 * none in a terminal; Pi has one system-prompt append that both of its runtimes reach, by
 * a flag in a terminal and by the same resource-loader option in its driver.
 *
 * A runtime ABSENT from the record has no such channel, and the text is composed into turn
 * one instead. That is not a degradation - it is the other half of the same contract, and
 * it is why this is a record of what EXISTS rather than a nullable capability: a pair with
 * no entry still receives the instruction.
 *
 * Read ONCE, here, by everything that needs the answer - the launch composer, the resolved
 * route's preview, and the snapshot. Two independent readings of "does this pair have a
 * channel" are exactly how a future harness ends up either double-delivered (the agent
 * reads the same rule twice in its first turn) or silently undelivered.
 */
export interface StandingInstructionsSpec {
  outOfBand: Partial<Record<SessionRuntime, StandingInstructionsMechanism>>;
}

/**
 * Live model discovery, and the sign-in that makes it answer anything.
 *
 * A UNION rather than two independent fields, because only two of the four combinations
 * are real and the other two are nonsense a registry entry could otherwise ship:
 * a harness that discovers but cannot say how to sign in renders a signed-out notice with
 * no remedy - the exact defect this pair was added to fix - and a harness on shipped rows
 * carrying a sign-in sentence advertises an account for a catalog it never asks about.
 * `discoversModels` discriminates, so the compiler refuses both, and a consumer that has
 * checked the flag gets `modelProviderSignIn` as `string` with no null to re-handle.
 *
 * `discoversModels` - does this harness answer a live model catalog, rather than only its
 * shipped rows? The pure half of `Harness.models.discover`
 * (`src/server/harness/types.ts`), and here for the reason `runtimes` and `resumes` are:
 * the BROWSER asks it. The catalog notice beside every picker - "checking", "showing
 * built-in rows", and the retry button - is meaningful only for a harness that has
 * something to check, and the browser cannot import a spec that spawns a subprocess to
 * find out.
 *
 * ONE FACT IN TWO FILES with `HARNESSES[a].models.discover !== null`, the treatment
 * `runtimes` / `resumes` get: `harness-model-catalog.test.ts` fails until they agree, so a
 * probe cannot ship with no way to report its failure and the browser cannot offer to
 * retry a discovery that does not exist. That flag replaced a proxy that asked whether any
 * row reported a provider - true for Pi, false for everything else, so it read correctly
 * while Pi was the only harness that discovered, and then silently hid Codex's degraded
 * state, because Codex reports no provider per row and discovers anyway.
 *
 * `modelProviderSignIn` - how a human signs this harness in to those providers, as one
 * sentence the catalog notice appends when the probe says there are none. A discovering
 * harness answers with the models its SIGNED-IN accounts offer, so "no rows" and "no
 * account" are one state seen from two sides. Measured against pi 0.84.2: an installation
 * with no provider credentials answers `get_available_models` with `{"models":[]}` and
 * exits 0, which the probe reports as `unavailable`. The notice used to render that as
 * "Pi did not report any available provider models" - true, and no help at all to the one
 * person who could fix it by signing in. Per harness rather than one shared sentence,
 * because the act genuinely differs: Pi is signed in from inside a session with `/login`,
 * Codex from a terminal with `codex login`. Plain text, not markup - the notice renders it
 * as a sentence a person reads.
 */
export type ModelDiscoverySpec =
  | { discoversModels: true; modelProviderSignIn: string }
  | { discoversModels: false; modelProviderSignIn: null };

/**
 * The slots every harness answers the same way, whatever it decides about discovery.
 *
 * Not exported: `HarnessCapabilities` below is the type callers hold, and splitting the
 * base out is a mechanism for intersecting `ModelDiscoverySpec` in rather than a second
 * vocabulary to learn.
 */
interface HarnessCapabilitiesBase {
  /** Matches this entry's key in `HARNESS_CAPABILITIES`. */
  id: AgentType;
  /**
   * The runtimes this harness can be driven over, in preference order.
   *
   * Pure data, and here rather than beside the driver, because the BROWSER asks it: the
   * Harnesses panel draws a runtime control only for a harness that offers more than
   * `terminal`, and it cannot import a spec that spawns a subprocess. `terminal` is on
   * every entry - a harness we cannot type at is not a harness (`ControlSpec` is not
   * nullable for the same reason).
   *
   * `"sdk"` here and `HARNESSES[a].sdk !== null` are ONE FACT IN TWO FILES, the treatment
   * `GOAL_UNSUPPORTED` gets: `harness-sdk.test.ts` fails until they agree, so a capability
   * cannot advertise a driver that does not exist and a driver cannot ship invisible.
   */
  runtimes: readonly SessionRuntime[];
  /**
   * Can this harness's CLI reopen a conversation it already holds?
   *
   * The pure half of `Harness.resume` (`src/server/harness/types.ts`), and here for the
   * same reason `runtimes` is: the BROWSER asks it. The conversation pane shapes its
   * agent launcher from this - a harness that answers `false` gets a disabled control
   * carrying a sentence rather than one that spawns a command line the CLI will reject -
   * and it cannot import a spec that resolves a binary off the filesystem.
   *
   * ONE FACT IN TWO FILES with `HARNESSES[a].resume !== null`, the treatment `runtimes` /
   * `sdk` gets: `harness-resume.test.ts` fails until they agree, so a capability cannot
   * advertise a resume that does not exist and a spec cannot ship unreachable.
   *
   * Every harness shipped today answers `true`, each measured against a real install
   * rather than assumed. That is not a reason to drop the flag: it is the difference
   * between "no harness needs this yet" and "no harness will", and only the second would
   * justify a boolean nobody can set.
   */
  resumes: boolean;
  permissionModes: PermissionModeSpec | null;
  skills: SkillsSpec | null;
  workQueue: WorkQueueSpec | null;
  clearContext: ClearContextSpec | null;
  mcp: McpSpec | null;
  missionTools: MissionToolsSpec | null;
  /** Null only for a harness with no launch-time reasoning-effort control. */
  effort: EffortSpec | null;
  /** Null for a harness whose write scope could not be widened past cwd at launch. */
  multiRepoDispatch: MultiRepoDispatchSpec | null;
  /** Null for a harness whose running turn cannot be stopped on any runtime. */
  interrupt: InterruptSpec | null;
  /**
   * Which channel carries repository standing instructions, per runtime. Never null: a
   * harness with no out-of-band channel declares an empty record and is prefixed instead.
   */
  standingInstructions: StandingInstructionsSpec;
}

const CODEX_EFFORT_LEVELS = THINKING_LEVELS.filter((level) => level !== "max");

/**
 * Claude Code's skills capability, named so `claudeSkillsDir` can reach it without a
 * null check.
 *
 * The reconciler folds over EVERY declaring harness now (`skillsDirs()`), which is what
 * this comment used to predict - except that it named `skillsAgents()` as the selector,
 * and that turned out to be the wrong one: it filters on `reloadCommand`, so a harness
 * that loads skills without needing a nudge (Codex) would have been left out of the very
 * loop that installs them. Install and nudge are two capabilities.
 */
/**
 * One agent's capabilities, as far as they can be stated without touching a disk.
 *
 * An intersection rather than one interface because `ModelDiscoverySpec` is a union, and
 * an interface cannot extend one. Every call site still sees one flat object: `runtimes`,
 * `discoversModels` and `modelProviderSignIn` read the same way they always did.
 */
export type HarnessCapabilities = HarnessCapabilitiesBase & ModelDiscoverySpec;

export const CLAUDE_SKILLS: SkillsSpec & { reloadCommand: string } = {
  reloadCommand: "/reload-skills",
  reloadIdleSource: "hooks",
  // The shipped spelling, unchanged: a skill is a slash command, and the bare command
  // submits. Claude also verifies its own submits (`pastePlaceholder` is non-null here),
  // so this line does not have to survive a single unverified Enter the way Codex's does.
  invoke: (name) => `/${name}`,
  dirEnvVar: "CLAUDE_SKILLS_DIR",
  homeDir: [".claude", "skills"],
  isolatedDirName: "claude-skills",
};

export const HARNESS_CAPABILITIES: Record<AgentType, HarnessCapabilities> = {
  claude: {
    id: "claude",
    // The list declares what the harness supports; dispatch takes the configured runtime.
    // `"sdk"` here and `HARNESSES.claude.sdk` are one fact in two files
    // (`harness-sdk.test.ts`).
    runtimes: ["terminal", "sdk"],
    // `claude --resume <id>`. Already shipping - this is the argv the embedded handoff
    // has spawned since the first driver landed.
    resumes: true,
    // Claude's SDK does report a live list, but it is account-shaped aliases, two of which
    // `ModelIdSchema` rejects for their long-context marker and one of which is a MODE
    // rather than a model. Adopting it is a persisted-vocabulary decision, so it is
    // deliberately deferred: see `docs/plans/claude-codex-live-model-catalog/plan.md`.
    discoversModels: false,
    modelProviderSignIn: null,
    permissionModes: {
      // `dontAsk` is deliberately absent: it is settable only at startup and Shift+Tab
      // never reaches it, so offering it would promise a walk that cannot arrive. It
      // still renders on the chip when a session was started in it.
      pickable: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
      liveControl: { kind: "cycle" },
      onDispatch: "auto",
      // `--permission-mode <mode>` starts Claude in that mode (verified against 2.1.219;
      // choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan). One token
      // differs from our `PermissionMode`: the default mode is `default` on Claude's hooks
      // and `manual mode on` in its footer, but the CLI spells it `manual` - the mirror of
      // `FOOTER_MODES` mapping `manual mode on` back to `default` on the reading side. The
      // flag does NOT skip the folder-trust dialog (that is only waived for `-p`/non-TTY
      // runs), but it no longer needs to: the mode is set whether or not the footer is
      // readable, and the dialog just delays the first prompt, not the mode.
      launchArgs: (mode) => ["--permission-mode", mode === "default" ? "manual" : mode],
    },
    skills: CLAUDE_SKILLS,
    workQueue: {
      uninstrumentedWhy:
        "This session has no hooks reporting, so Foreman can't tell when it picks work up or finishes it. Install the Claude integrations to queue work here.",
    },
    clearContext: { command: "/clear" },
    mcp: { cli: "claude", scope: "user", envFlag: "-e", serverName: "mission-control" },
    missionTools: { mechanism: "mcp-client", scope: "launch" },
    effort: {
      levels: THINKING_LEVELS,
      levelsFor: () => THINKING_LEVELS,
      launchArgs: (level) => ["--effort", level],
      // `applyFlagSettings({ effortLevel })` on the live query object: the SDK moves the
      // conversation it is already running, so the route observes the change immediately.
      driverApplies: "now",
      sessionPicker: {
        kind: "horizontal",
        command: "/model",
        composerReady: claudeComposerReady,
        visible: CLAUDE_PICKER_VISIBLE,
        selected: claudePickerSelection,
        commit: "s",
      },
    },
    // Verified against the pinned `@anthropic-ai/claude-agent-sdk@0.3.220` and the shipped
    // CLI, whose flag is declared `--add-dir <directories...>`.
    //
    // REPEATED rather than variadic - `--add-dir a --add-dir b`, not `--add-dir a b` -
    // because that is what the vendor's own SDK emits when it renders
    // `Options.additionalDirectories` for this same CLI (`for (let d of dirs)
    // args.push("--add-dir", d)` in `sdk.mjs`). Both spellings are accepted, and this one
    // is the measured one; it also cannot swallow a following flag, which the variadic form
    // would, so the argv stays order-independent.
    //
    // It has to be a LAUNCH-time grant on both paths. The SDK's runtime `addDirectories`
    // control request requires its argument to be a strict subdirectory of cwd or of a
    // directory passed at launch (`sdk.d.ts`), so a sibling repository is reachable only
    // by naming it here.
    multiRepoDispatch: { kind: "flags", launchArgs: (dirs) => dirs.flatMap((dir) => ["--add-dir", dir]), sdk: true },
    // The embedded driver calls the vendor SDK's own `query.interrupt()`
    // (`harness/claude/sdk.ts`), which aborts the running turn and leaves the conversation
    // open. `terminal` is `Escape` into the bound pane, measured live against the TUI: a
    // streaming turn stops and the session takes a next prompt.
    interrupt: { runtimes: ["terminal", "sdk"] },
    // Claude carries operator text that is not a turn on BOTH runtimes, by two different
    // spellings. `--append-system-prompt` is single-valued and the CLI carries no guard
    // against the flag being repeated against itself, so a second flag silently discards
    // the first - measured against 2.1.239. The terminal launch therefore composes ONE
    // value from every contributor (the ask-channel redirect and this), which is why the
    // mechanism names the flag rather than the contributor.
    standingInstructions: {
      outOfBand: {
        terminal: "claude-append-system-prompt",
        sdk: "claude-sdk-system-prompt-append",
      },
    },
  },
  codex: {
    id: "codex",
    // `codex app-server` JSON-RPC, behind `HARNESSES.codex.sdk` - one fact in two files
    // (`harness-sdk.test.ts`). This list declares support, not a preference order.
    runtimes: ["terminal", "sdk"],
    // `codex resume <uuid>`. Measured against `codex resume --help`, which documents the
    // positional as "Session id (UUID) or session name". Resuming and being drivable
    // programmatically remain different capabilities: Codex supports both, while Pi's
    // non-null resume beside a terminal-only runtime demonstrates why this flag could not
    // stay on `SdkSpec`.
    resumes: true,
    // `model/list` over `codex app-server`, behind `HARNESSES.codex.models.discover`.
    discoversModels: true,
    modelProviderSignIn:
      "Codex only lists models the account it is signed in to can use. If you are signed out, run codex login in a terminal and try again.",
    // Measured against codex-cli 0.145.0. Codex has no Shift+Tab footer cycle, but
    // `/permissions` opens a numbered picker and applies the selected profile to the
    // current conversation. The rollout's turn_context records the matching sandbox,
    // approval policy and reviewer, so the card can also read the current value back.
    permissionModes: {
      pickable: ["askForApproval", "approveForMe", "fullAccess", "readOnly"],
      liveControl: {
        kind: "menu",
        command: "/permissions",
        composerReady: codexComposerReady,
        labels: {
          askForApproval: "Ask for approval",
          approveForMe: "Approve for me",
          fullAccess: "Full Access",
          readOnly: "Read Only",
        },
        // Codex deliberately puts its most permissive profile behind a second menu.
        confirmations: { fullAccess: "Yes, continue anyway" },
      },
      // The mode an auto dispatch arms, and it costs the TERMINAL path nothing: with
      // `launchArgs` null, `dispatchPermissionModeArgs` still renders no flags for Codex,
      // so a dispatched pane is byte-identical - `prepareCodexLaunch` goes on owning its
      // launch-time sandbox flags, and the live `/permissions` menu is still reserved for a
      // human. It is the EMBEDDED runtime that needed a mode named here: it sets its
      // posture through the app-server's own turn parameters rather than through argv,
      // which is the case `dispatchPermissionModeArgs` documents itself as not holding
      // back. `approveForMe` keeps the same `workspace-write` + `on-request` boundary as
      // the auto flags while routing eligible approvals through Codex's native auto
      // reviewer. That is the autonomous posture this setting promises; a request the
      // reviewer declines to approve still reaches the card.
      onDispatch: "approveForMe",
      launchArgs: null,
    },
    // A skills directory of its own (`~/.agents/skills`), and no reload command: Codex
    // watches that directory itself, so the set it offers changes without anything being
    // typed at a running session. `skillsAgents()` therefore excludes it from the pane
    // broadcast.
    skills: {
      reloadCommand: null,
      reloadIdleSource: null,
      // `$name`, and then a clause, because the sigil alone does not submit here - see
      // `SkillsSpec.invoke` for the capture this is read off. The clause is generic on
      // purpose: it has to read correctly for whatever skill a caller names, and its job
      // is the space in front of it.
      invoke: (name) => `$${name} - run this skill now.`,
      dirEnvVar: "CODEX_SKILLS_DIR",
      homeDir: [".agents", "skills"],
      isolatedDirName: "codex-skills",
    },
    // Codex reports pickup/completion through its launch-scoped hooks, its rollout parses
    // back into turns, and its keystroke control spec drives the same generic delivery
    // path as Claude. A manually-started Codex without those hooks still takes the
    // per-session refusal below rather than accepting a queue it cannot verify.
    workQueue: {
      uninstrumentedWhy:
        "This session has no hooks reporting, so Foreman can't tell when it picks work up or finishes it. Start Codex through Mission Control so its launch-scoped hooks are attached before queuing work here.",
    },
    // Measured against 0.144.x, where `/clear` is Codex's own slash command and not, as
    // this said while the value was null, a line that would land in the prompt as text.
    clearContext: { command: "/clear" },
    // `codex mcp add <name> --env K=V -- <cmd>`: a different CLI and a different config
    // file from Claude's, which is what `cli` and `envFlag` carry. `scope: null` is the
    // real difference - Codex writes one registration and has no `-s user|project` to
    // choose between.
    mcp: { cli: "codex", scope: null, envFlag: "--env", serverName: "mission-control" },
    missionTools: { mechanism: "mcp-client", scope: "launch" },
    effort: {
      levels: CODEX_EFFORT_LEVELS,
      levelsFor: (modelId) => {
        const id = modelId?.toLowerCase() ?? "";
        return id.startsWith("gpt-5.6-sol") || id.startsWith("gpt-5.6-terra")
          ? THINKING_LEVELS
          : CODEX_EFFORT_LEVELS;
      },
      // `-c` parses its value as TOML, falling back to a raw string. The level is a
      // closed enum, so every value rendered here is valid for that parser.
      launchArgs: (level) => ["-c", `model_reasoning_effort=${level}`],
      // `effort` is a `turn/start` parameter. `turn/steer` has no such field, so a level
      // chosen while a turn is running - and a level chosen while none is - both land on
      // the NEXT turn this driver starts, and the rollout's next `turn_context` is what
      // confirms it.
      driverApplies: "next-turn",
      sessionPicker: {
        kind: "shortcuts",
        composerReady: codexComposerReady,
        selected: codexStatusSelection,
        lower: "shift-down",
        raise: "shift-up",
      },
    },
    // Measured against codex-cli 0.145.0 rather than read off documentation, because the
    // answer is not the obvious one. `sandbox_workspace_write.writable_roots` is the key,
    // and it rides as a `-c` TOML override, which is the one grammar BOTH Codex runtimes
    // accept: the terminal launch already speaks it, and `codex app-server` documents the
    // same `-c <key=value>` flag, so the embedded driver carries the identical grant.
    //
    // What was measured, with a two-repo probe (cwd in repo A's worktree, repo B's
    // worktree granted):
    //
    //   plain `--sandbox workspace-write`          write into B  -> denied
    //   + writable_roots = [B]                     write into B  -> allowed
    //
    // And the part worth stating because it looks like a gap and is not: Codex protects
    // the git metadata of every writable root, so `git commit` inside a LINKED worktree is
    // refused in-sandbox and escalates through `--ask-for-approval on-request`. That is
    // not a shortfall of this grant - the primary worktree, which is the session's own
    // cwd, was measured to behave identically today. A granted secondary lands in exactly
    // the posture the primary is already in, which is the parity this capability promises.
    multiRepoDispatch: {
      kind: "flags",
      launchArgs: (dirs) => ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(dirs)}`],
      sdk: true,
    },
    // `turn/interrupt` over the app-server RPC (`harness/codex/sdk.ts`), which the driver
    // already tolerates being sent a moment late. `terminal` is `Escape`, measured live: the
    // TUI's own footer advertises "esc to interrupt", and it answers with
    // "Conversation interrupted" while the session stays open.
    interrupt: { runtimes: ["terminal", "sdk"] },
    // Only the embedded driver. `thread/start` takes `developerInstructions`; a terminal
    // Codex has no equivalent, so that pair is prefixed into turn one instead.
    standingInstructions: { outOfBand: { sdk: "codex-developer-instructions" } },
  },
  pi: {
    id: "pi",
    // Both, since Pi's own SDK landed behind `HARNESSES.pi.sdk`. ONE fact in two files
    // (`harness-sdk.test.ts`), and the driver is the package's `AgentSessionRuntime` rather
    // than the `--mode rpc` transport an older phase proposed - see the note on that slot.
    runtimes: ["terminal", "sdk"],
    // `pi --session <id>`. Measured against `pi --help`: "--session <path|id>  Use specific
    // session file or partial UUID". Deliberately NOT `--resume`, which on pi opens an
    // interactive PICKER rather than taking an id, and not `--fork`, which would branch the
    // conversation instead of continuing it - three neighbouring flags, one right answer.
    resumes: true,
    // `get_available_models` over pi's RPC mode, behind `HARNESSES.pi.models.discover`.
    discoversModels: true,
    // Provider-NEUTRAL, because Pi's catalog is: it lists whatever provider the operator
    // has configured, and naming only Anthropic told an operator signed in to Bedrock,
    // OpenAI or a local endpoint that their own provider did not count. `/login
    // amazon-bedrock` is spelled out because it is the one this sentence was rewritten
    // for and because Bedrock's own console gives no hint that Pi is where the credential
    // goes. Mission Control never asks for the secret itself - there is no form here to
    // paste one into, by design.
    modelProviderSignIn:
      "Pi only lists models a signed-in provider offers. If you are signed out, open a Pi session and run /login <provider> - /login amazon-bedrock for Amazon Bedrock - or set that provider's API key, and try again. Pi keeps the credential; Mission Control never stores it.",
    // FINDING (see `todo/pi-harness.md`): pi HAS an approval mode - `manual`/`auto`/`readonly`,
    // with a `cycleMode` - so this is not quite "no such concept at all". But the app's
    // `PermissionMode` is a CLOSED union of Claude's own mode strings, and pi's vocabulary does
    // not map onto it, nor is it a Shift+Tab footer cycle (Shift+Tab on pi cycles the THINKING
    // level). Supporting it would mean widening a shared union with pi's words - a change the
    // acceptance criterion forbids quietly - so this is null: no chip, routes 400, dispatcher
    // arms nothing. The one place the harness axis still bakes in a Claude assumption.
    permissionModes: null,
    // Verified: pi loads SKILL.md skills (agentskills.io standard) from its own
    // `~/.pi/agent/skills` (probed live) as well as the shared `~/.agents/skills`. Declared
    // with pi's OWN dir so `skillsDirs()` does not have to reconcile a directory it shares with
    // Codex. pi has no skills-dir watcher. A dispatched session's exact launch identity
    // makes its transcript an attributable idle source for the verified command.
    skills: {
      reloadCommand: "/reload",
      reloadIdleSource: "transcript",
      // Verified against pi 0.81.0: a skill is a NAMESPACED slash command, `/skill:<name>`
      // (its own completion menu offers `skill:probe-echo` for a skill named
      // `probe-echo`), and the bare command submits - pi's completion menu opens on typed
      // keys, not on a bracketed paste, so nothing intercepts the Enter. Pasting
      // `/skill:<name>` and pressing Enter once loaded the skill and ran it.
      //
      // Foreman never types this today (pi has no Mission lifecycle hooks, so it holds no
      // queue and raises no wrap-up), but the answer is measured rather than left out:
      // a null here would claim pi cannot run a skill by name, which is false.
      invoke: (name) => `/skill:${name}`,
      dirEnvVar: "PI_SKILLS_DIR",
      homeDir: [".pi", "agent", "skills"],
      isolatedDirName: "pi-skills",
    },
    // Pi can report lifecycle events through the Mission Control extension. Name the
    // missing instrumentation without promising an installer before it ships.
    workQueue: {
      uninstrumentedWhy:
        "This Pi session has not loaded the Mission Control extension's lifecycle hooks, so Foreman cannot tell when work starts or finishes.",
    },
    // Verified: `/new` starts a fresh session in-place ("New session started", no prompt),
    // pi's equivalent of Claude's `/clear`. There is no `/clear` (pi has `/compact`, which
    // summarises rather than clears). Hookless sessions have no attributable transcript path.
    clearContext: { command: "/new" },
    // Null: pi has no MCP client at all - it extends via in-process TS extensions, not MCP - so
    // the installer says so rather than shelling out to a registration CLI that does not exist.
    mcp: null,
    missionTools: { mechanism: "installed-extension", scope: "machine" },
    // pi's `--thinking` accepts `off|minimal|low|medium|high|xhigh|max`; the app's
    // THINKING_LEVELS (`low..max`) are a subset it accepts verbatim.
    effort: {
      levels: THINKING_LEVELS,
      levelsFor: () => THINKING_LEVELS,
      launchArgs: (level) => ["--thinking", level],
      // `AgentSession.setThinkingLevel` writes the agent's state, and Pi clamps it to what
      // the model supports - but the request that is already in flight was built with the
      // old level, so the change is observable from the next one. Same answer as Codex,
      // for the same reason, and the card says the selection is pending rather than
      // claiming the running turn moved.
      driverApplies: "next-turn",
      // Pi's Shift+Tab walks one direction through seven values, including `off` and
      // `minimal`, so neither existing live-picker shape can drive it faithfully.
      sessionPicker: null,
    },
    multiRepoDispatch: {
      kind: "no-boundary",
      why: "Pi has no sandbox or directory write boundary: measured against 0.85.1, its write tool wrote an absolute path in a sibling directory without a flag, grant or refusal.",
      // `false` even though the managed runtime uses those same unbounded tools, because
      // the measurement above was taken against the TERMINAL one and this axis does not
      // accept an inherited answer. The driver refuses `extraDirs` to match, so the two
      // cannot disagree; measuring the managed path is a one-line change with its own
      // evidence, exactly as this slot's previous null said.
      sdk: false,
    },
    // Both interrupt mechanisms, and each was measured on its own runtime rather than
    // inherited.
    //
    // TERMINAL: nothing in pi's docs says which key aborts a turn. Escape into a running pi
    // turn prints "Operation aborted" and writes `stopReason: "aborted"` into the transcript
    // - the exact record `pi/meta.ts` already reads - and the session then answers a
    // follow-up prompt normally.
    //
    // SDK: `AgentSession.abort()` stops the run and WAITS for the agent to be idle, so the
    // driver's `interrupt` returns on a session that has genuinely stopped rather than one
    // that has been asked to. `harness-sdk.test.ts` fails if this outruns the driver.
    //
    // This is the declaration that took `interrupt` off `harness-capabilities.test.ts`'s
    // real-null-declarer list; the slot's null path is a named fixture there now.
    interrupt: { runtimes: ["terminal", "sdk"] },
    // BOTH runtimes, by the same mechanism, because it is the same mechanism: `pi
    // --append-system-prompt <value>` is the CLI spelling of the resource loader's
    // `appendSystemPrompt`, which the managed driver hands to `createAgentSessionServices`
    // directly. Verified against the pinned 0.85.1 - `main.js` routes the flag into exactly
    // that option.
    //
    // Declaring only `terminal` would be worse than declaring neither: the composer reads
    // this to decide whether to prefix, so a managed Pi session would have taken its rules
    // as turn-one prose while a terminal one took them out of band - the same operator
    // instruction delivered two different ways depending on a toggle. Codex terminal remains
    // the live prover for the prompt-prefix fallback.
    standingInstructions: {
      outOfBand: { terminal: "pi-append-system-prompt", sdk: "pi-append-system-prompt" },
    },
  },
};

/**
 * One agent's capabilities. Total by construction - the record cannot have a hole.
 *
 * The browser-safe door to the fields below. Server code holding a `Harness`
 * (`harnessFor`) reads the same slots off that object; the two are the same values,
 * because `HARNESSES` is built by spreading this record.
 */
export function capabilitiesFor(agent: "claude"): HarnessCapabilities & { skills: typeof CLAUDE_SKILLS };
export function capabilitiesFor(agent: AgentType): HarnessCapabilities;
export function capabilitiesFor(agent: AgentType): HarnessCapabilities {
  return HARNESS_CAPABILITIES[agent];
}

/**
 * The effort levels this harness offers AT LAUNCH for a given model.
 *
 * The launch-time twin of `sessionEffortLevels`, and separate from it for the reason
 * `EffortSpec.levelsFor` already gives: the live picker also has to answer where the
 * session's CURRENT level sits and which neighbours it may step to, none of which exists
 * before a session does. A launch has only two facts - the harness and the model - and both
 * are known here.
 *
 * Empty for a harness with no launch-time effort control at all, which is the honest answer
 * and the one every caller wants: nothing is offered, so nothing may be passed.
 */
export function launchEffortLevels(
  agent: AgentType,
  modelId: string | null,
): readonly ThinkingLevel[] {
  return HARNESS_CAPABILITIES[agent].effort?.levelsFor(modelId) ?? [];
}

/**
 * The effort levels EVERY harness offers at launch, for a caller that does not yet know
 * which one it will get.
 *
 * A recurring mission or a task source may inherit its agent from the task kind, and the kind
 * can be repointed after the mission is written - so the harness is genuinely unknown until
 * the run fires. Offering one harness's levels there would offer a level that silently falls
 * back on another, and offering the whole vocabulary would do it more often. The intersection
 * is the set that survives whichever harness the kind resolves to.
 */
export function portableEffortLevels(): readonly ThinkingLevel[] {
  const agents = Object.keys(HARNESS_CAPABILITIES) as AgentType[];
  const [first, ...rest] = agents;
  if (!first) return [];
  return launchEffortLevels(first, null).filter((level) =>
    rest.every((agent) => launchEffortLevels(agent, null).includes(level)),
  );
}

export function supportsEffort(agent: AgentType, level: ThinkingLevel): boolean {
  return HARNESS_CAPABILITIES[agent].effort?.levels.includes(level) ?? false;
}

/** Whether an effort is selectable for one live session's currently selected model. */
export function supportsSessionEffort(
  agent: AgentType,
  modelId: string | null,
  current: ThinkingLevel | null,
  level: ThinkingLevel,
): boolean {
  return sessionEffortLevels(agent, modelId, current).includes(level);
}

export function sessionEffortLevels(
  agent: AgentType,
  modelId: string | null,
  current: ThinkingLevel | null,
): readonly ThinkingLevel[] {
  const effort = HARNESS_CAPABILITIES[agent].effort;
  const picker = effort?.sessionPicker;
  if (!effort || !picker || !current) return [];
  const levels = effort.levelsFor(modelId);
  const currentIndex = levels.indexOf(current);
  if (currentIndex < 0) return [];
  if (picker.kind === "horizontal") return levels;
  return levels.filter((level, index) =>
    level === current || (Math.abs(index - currentIndex) === 1 && level !== "max")
  );
}

/**
 * A stored runtime choice, resolved against what this build and this harness can actually
 * do - and carrying whatever it had to drop.
 *
 * The `ResolvedLlmRunner.unknown` shape, for the same reason: swallowed, a stored value
 * from a newer build is indistinguishable from an unset one, and the panel would render
 * the fallback as the operator's own choice. Two different drops, kept apart because they
 * are two different sentences for a human - "this build has never heard of that" and "this
 * harness has no driver behind that".
 */
export interface ResolvedSessionRuntime {
  runtime: SessionRuntime;
  /** The stored string this build could not read at all, if that is what happened. */
  unknown: string | null;
  /** A runtime this build knows that this harness does not offer, if that is what happened. */
  unsupported: SessionRuntime | null;
}

/**
 * The out-of-band channel this harness · runtime pair carries standing instructions on, or
 * null when it has none and the text belongs in turn one instead.
 *
 * The ONE reading of that question. The launch composer asks it to decide whether to
 * prefix, the resolved route asks it to label a preview, and the snapshot records what it
 * answered - so a marker and a delivery cannot disagree about the mechanism, and adding a
 * harness cannot silently double-deliver or silently drop.
 */
export function standingInstructionsChannel(
  agent: AgentType,
  runtime: SessionRuntime,
): StandingInstructionsMechanism | null {
  return HARNESS_CAPABILITIES[agent].standingInstructions.outOfBand[runtime] ?? null;
}

/** Whether this harness can be driven over `runtime` at all. */
export function harnessOffersRuntime(agent: AgentType, runtime: SessionRuntime): boolean {
  return HARNESS_CAPABILITIES[agent].runtimes.includes(runtime);
}

/** How a runtime is named to a person, so the refusal below reads as English. */
const RUNTIME_PROSE: Record<SessionRuntime, string> = {
  terminal: "a terminal",
  sdk: "the Agent SDK",
};

/**
 * Whether this harness's current turn can be stopped while it is running over `runtime`.
 *
 * The ONE gate the whole gesture asks - the keydown handler, the action-bar button, the
 * board overview's in-place arm and the daemon's own route - so a card cannot offer a stop
 * the route would refuse, and the route cannot accept one no mechanism exists for. Beside
 * `harnessOffersRuntime` because it is the same shape of question about the same axis.
 */
export function canInterrupt(agent: AgentType, runtime: SessionRuntime): boolean {
  return HARNESS_CAPABILITIES[agent].interrupt?.runtimes.includes(runtime) ?? false;
}

/**
 * Why this harness/runtime pair cannot be interrupted, or null when it can.
 *
 * Two absences, worded differently because they are different facts and lead different
 * places. A harness with no `interrupt` capability at all can never be stopped mid-turn -
 * the only ways out are waiting and Kill. A harness that CAN be interrupted, but not on the
 * runtime this session happens to be running over, is a mechanism that has not been built
 * yet, and naming the runtime is what tells the operator that the same session dispatched
 * the other way would answer to the key.
 *
 * Composed here rather than typed at each refusing surface, for the reason
 * `workQueueUnsupportedWhy` gives: the disabled button's tooltip and the daemon's 400 have
 * to give the same answer, and a sentence written twice is how they stop.
 */
export function interruptUnsupportedWhy(
  agent: AgentType,
  runtime: SessionRuntime,
): string | null {
  const spec = HARNESS_CAPABILITIES[agent].interrupt;
  const who = AGENT_IDENTITY[agent].label;
  if (!spec) {
    return `Mission Control can't stop a ${who} turn once it has started, so this one has to finish or the session has to be killed.`;
  }
  if (!spec.runtimes.includes(runtime)) {
    return `Mission Control can't yet stop a ${who} turn running in ${RUNTIME_PROSE[runtime]}, so this one has to finish or the session has to be killed.`;
  }
  return null;
}

/**
 * The runtime a dispatch of `agent` should actually use, given what was stored.
 *
 * The ONE narrowing gate for the persisted choice, shared by the dispatcher and the
 * settings panel so the daemon and the card cannot disagree about which runtime is in
 * force. Falls back to `"terminal"` in both failure cases, which is the safe direction by
 * construction: it is the runtime every harness declares and the path this app shipped on.
 *
 * The unsupported case is not hypothetical bookkeeping. A toggle stored while a harness had
 * a driver, read back by a build where that driver was removed, must dispatch into a
 * terminal and SAY it did - silently launching the other runtime is a session that behaves
 * nothing like the operator's last instruction.
 */
export function resolveSessionRuntime(
  agent: AgentType,
  stored: string | null | undefined,
): ResolvedSessionRuntime {
  const known = SESSION_RUNTIMES.find((r) => r === stored);
  if (!known) {
    return { runtime: "terminal", unknown: stored ? stored : null, unsupported: null };
  }
  if (!harnessOffersRuntime(agent, known)) {
    return { runtime: "terminal", unknown: null, unsupported: known };
  }
  return { runtime: known, unknown: null, unsupported: null };
}

/**
 * Why this harness cannot be driven over the Agent SDK, or null when it can.
 *
 * Composed from the capability and `AGENT_IDENTITY`, never typed at the panel, for the
 * reason `workQueueUnsupportedWhy` gives: a fourth harness gets a correct sentence for
 * free instead of inheriting the third one's.
 */
export function sdkRuntimeUnsupportedWhy(agent: AgentType): string | null {
  if (harnessOffersRuntime(agent, "sdk")) return null;
  return `Mission Control has no embedded driver for ${AGENT_IDENTITY[agent].label} yet, so its dispatched sessions run in a terminal.`;
}

/**
 * Why Foreman cannot run a work queue on this harness at all, or null when it can.
 *
 * Composed from the capability rather than written out at each refusing surface: the
 * panel hiding its add box, the daemon refusing the write, and the re-attach button all
 * have to give the same answer, and a sentence typed three times is how they stop.
 * Derived from `AGENT_IDENTITY` so a fourth harness gets a correct sentence for free instead
 * of inheriting Codex's.
 */
export function workQueueUnsupportedWhy(agent: AgentType): string | null {
  if (HARNESS_CAPABILITIES[agent].workQueue) return null;
  return `Foreman doesn't drive ${AGENT_IDENTITY[agent].label} sessions, so anything queued here would never be picked up.`;
}

/** Shared refusal copy; callers with a machine probe use it only when that probe fails. */
export function missionToolsUnavailableWhy(agent: AgentType): string | null {
  const spec = capabilitiesFor(agent).missionTools;
  const label = AGENT_IDENTITY[agent].label;
  if (!spec) return `${label} has no integration that can carry Mission Control tools.`;
  if (spec.mechanism === "installed-extension") {
    return `The Mission Control integration for ${label} is not installed on this machine, so required Mission MCP tools are unavailable.`;
  }
  return null;
}

/**
 * Why this particular session cannot hold a work queue, or null when it can.
 *
 * The browser-side half of `foremanAutomationAuthorized` (`server/harness/index.ts`), and
 * the two must agree arm for arm - this decides whether the panel offers an add box, that
 * decides whether the daemon will drive what the box produced, and a session that can be
 * queued into but never driven is a queue that silently never moves.
 *
 * The `sdk` arm returns null (no blocker) for the reason stated there: an embedded session's
 * instrumentation IS the handle the supervisor holds, so `hooksSeen` - a question about a
 * hook script on this machine - is not the evidence that applies to it. It is scoped to the
 * runtime and not to an agent so the next driver inherits it without an edit.
 */
export function workQueueBlockedReason(
  session: Pick<Session, "agent" | "hooksSeen" | "runtime">,
): string | null {
  const queue = HARNESS_CAPABILITIES[session.agent].workQueue;
  if (!queue) return workQueueUnsupportedWhy(session.agent);
  if (session.runtime === "sdk") return null;
  return session.hooksSeen ? null : queue.uninstrumentedWhy;
}

/**
 * The agents a switched-on skill actually REACHES - who a skills surface is about.
 *
 * Everything the panel says about scope is this list: which directories the links go
 * into, whose sessions are affected, whose are not. `skillsDirs()` (`server/skills/
 * reconcile.ts`) is the same question asked of the filesystem.
 */
export function skillLoadingAgents(): AgentType[] {
  return AGENT_TYPES.filter((a) => HARNESS_CAPABILITIES[a].skills !== null);
}

/**
 * The line that runs one named skill in this agent's composer, or null when it has no
 * skills at all or no way to invoke one by typing.
 *
 * The one reader of `SkillsSpec.invoke`, so the three grammars are spelled once and a
 * caller (Foreman's wrap-up, the Ship it? card) states WHICH SKILL it wants and never
 * which sigil that harness puts in front of it.
 *
 * Null is not "nothing happens" - it is "there is no line to type", which a caller has
 * to degrade on rather than send a blank. The wrap-up's degradation is the one it
 * already has for `ask` mode: hand the decision to the human.
 */
export function skillCommand(agent: AgentType, name: string): string | null {
  return HARNESS_CAPABILITIES[agent].skills?.invoke?.(name) ?? null;
}

/**
 * Whether an embedded session of this harness can receive a named skill invocation.
 *
 * A non-null command alone is not enough for a managed launch: the host must also offer
 * the SDK runtime that delivers the invocation.
 */
export function supportsSdkSkillInvocation(agent: AgentType, name: string): boolean {
  return capabilitiesFor(agent).runtimes.includes("sdk") && skillCommand(agent, name) !== null;
}

/**
 * The agents a skills change has to be TYPED at - the pane-reload broadcast.
 *
 * A strict subset of `skillLoadingAgents()`, and the two must not be conflated: Codex
 * loads skills and watches its directory itself, so it is reached by every skill and owed
 * no keystroke. Using this list to answer "who does this switch affect" understates the
 * panel by a whole harness; using the other to answer "who do we type at" invents a slash
 * command for a session that would render it as a prompt.
 *
 */
export function skillsAgents(): AgentType[] {
  return AGENT_TYPES.filter((a) => !!HARNESS_CAPABILITIES[a].skills?.reloadCommand);
}

/**
 * The agents whose "auto mode on dispatch" posture Mission Control can arm.
 *
 * A terminal launch can carry the posture through `launchArgs`; an embedded launch can
 * hand it directly to an SDK driver. `onDispatch` remains the primary requirement - an
 * available transport cannot invent an autonomous mode the harness did not declare.
 */
export function autoModeAgents(): AgentType[] {
  return AGENT_TYPES.filter((a) => {
    const capabilities = HARNESS_CAPABILITIES[a];
    const modes = capabilities.permissionModes;
    return !!modes?.onDispatch && (!!modes.launchArgs || capabilities.runtimes.includes("sdk"));
  });
}

/**
 * Why Mission Control cannot arm this harness's "auto mode on dispatch" posture, or null
 * when it can.
 *
 * Three different absences, said differently, because they are different facts: a
 * harness with no permission modes at all has nothing to arm, one that HAS modes but
 * names no `onDispatch` has nothing that would mean "proceed without asking", and one
 * with that mode but neither a launch renderer nor an SDK driver lacks a transport that
 * can apply it. Rolling them into one sentence would misstate the declared capability.
 *
 * No refusal may say the dispatch is UNAFFECTED, which is what two branches used to say and
 * is no longer true: `prepareCodexLaunch` takes this same switch and turns it into
 * `--sandbox workspace-write --ask-for-approval on-request` at launch. The switch reaches
 * Codex; what it does not reach is a `--permission-mode` launch flag, because Codex
 * expresses the same posture through separate sandbox and approval flags. A panel
 * promising "unaffected" over a session launched with a widened sandbox is a consent
 * failure, not a copy nit. Embedded Codex is the complementary case: its driver consumes
 * the declared mode directly even though its permission capability has no argv renderer.
 */
export function autoModeUnsupportedWhy(agent: AgentType): string | null {
  const capabilities = HARNESS_CAPABILITIES[agent];
  const modes = capabilities.permissionModes;
  const who = AGENT_IDENTITY[agent].label;
  if (!modes) return `${who} has no permission modes to arm with a launch flag.`;
  if (!modes.onDispatch)
    return `${who} has permission modes but none that mean "proceed without asking", so no mode is armed at launch.`;
  if (!modes.launchArgs && !capabilities.runtimes.includes("sdk"))
    return `${who} has an autonomous permission mode but no launch-argument renderer, so Mission Control cannot arm it at launch; its live TUI walk is reserved for a human changing an existing session.`;
  return null;
}
