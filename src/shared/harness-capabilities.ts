import { AGENT_TYPES } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";
import type { AgentType, PermissionMode, Session, ThinkingLevel } from "./types.ts";
// By value, because `workQueueUnsupportedWhy` composes prose from it. Naming stays
// `AGENT_IDENTITY`'s job - a second register on a capability object is the exact defect
// Phase 0 collapsed.
import { AGENT_IDENTITY } from "./agent.ts";

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
   * The modes a picker offers, in the agent's own cycle order, so the list reads in the
   * same order as the keystroke it replaces.
   *
   * Not every listed mode is reachable in every session - some are gated behind a launch
   * flag or account support the daemon cannot see - and that is fine: the walk goes all
   * the way around, lands back where it started, and says so.
   */
  pickable: readonly PermissionMode[];
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
   * point of this slot is that no caller has to know which is which: Foreman's wrap-up
   * used to type Claude's `/no-mistakes` at every agent, so a Codex session was handed a
   * literal string its TUI has no command for and the gate ran only if the model happened
   * to reach for the skill anyway.
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
 * takes the per-session refusal until one reports a hook. Pi has readable turns but no
 * pickup/completion signal, so it declares this capability null.
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

function claudePickerSelection(paneText: string, model: string): ThinkingLevel | null {
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

/** One agent's capabilities, as far as they can be stated without touching a disk. */
export interface HarnessCapabilities {
  /** Matches this entry's key in `HARNESS_CAPABILITIES`. */
  id: AgentType;
  permissionModes: PermissionModeSpec | null;
  skills: SkillsSpec | null;
  workQueue: WorkQueueSpec | null;
  clearContext: ClearContextSpec | null;
  mcp: McpSpec | null;
  /** Null only for a harness with no launch-time reasoning-effort control. */
  effort: EffortSpec | null;
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
    permissionModes: {
      // `dontAsk` is deliberately absent: it is settable only at startup and Shift+Tab
      // never reaches it, so offering it would promise a walk that cannot arrive. It
      // still renders on the chip when a session was started in it.
      pickable: ["default", "acceptEdits", "plan", "bypassPermissions", "auto"],
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
    effort: {
      levels: THINKING_LEVELS,
      levelsFor: () => THINKING_LEVELS,
      launchArgs: (level) => ["--effort", level],
      sessionPicker: {
        kind: "horizontal",
        command: "/model",
        composerReady: claudeComposerReady,
        visible: CLAUDE_PICKER_VISIBLE,
        selected: claudePickerSelection,
        commit: "s",
      },
    },
  },
  codex: {
    id: "codex",
    // No permission-mode concept: no footer mode line to read, and no Shift+Tab cycle to
    // walk. `annotatePaneState` therefore has nothing to capture for it either.
    permissionModes: null,
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
    effort: {
      levels: CODEX_EFFORT_LEVELS,
      levelsFor: (modelId) => {
        const id = modelId?.toLowerCase() ?? "";
        return id.startsWith("gpt-5.6-sol") || id.startsWith("gpt-5.6-terra")
          ? THINKING_LEVELS
          : CODEX_EFFORT_LEVELS;
      },
      // `-c` parses its value as TOML, falling back to a raw string. The level is a
      // closed enum, so it is both valid here and safe on tmux's shell command line.
      launchArgs: (level) => ["-c", `model_reasoning_effort=${level}`],
      sessionPicker: {
        kind: "shortcuts",
        composerReady: codexComposerReady,
        selected: codexStatusSelection,
        lower: "shift-down",
        raise: "shift-up",
      },
    },
  },
  pi: {
    id: "pi",
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
      // Foreman never types this today (pi declares `workQueue: null`, so it holds no
      // queue and raises no wrap-up), but the answer is measured rather than left out:
      // a null here would claim pi cannot run a skill by name, which is false.
      invoke: (name) => `/skill:${name}`,
      dirEnvVar: "PI_SKILLS_DIR",
      homeDir: [".pi", "agent", "skills"],
      isolatedDirName: "pi-skills",
    },
    // Null: pi pushes no hooks (`HARNESSES.pi.hooks` is null), so Foreman has no signal for
    // when a pi session picks work up or finishes it and cannot verify a queue. Its rich
    // transcript proves the work was done, but authorship of the pickup is exactly the hook
    // signal it lacks - so `foremanAutomationAuthorized` refuses regardless, and null is the
    // honest permanent incapacity rather than the fixable-install `uninstrumentedWhy`.
    workQueue: null,
    // Verified: `/new` starts a fresh session in-place ("New session started", no prompt),
    // pi's equivalent of Claude's `/clear`. There is no `/clear` (pi has `/compact`, which
    // summarises rather than clears). Hookless sessions have no attributable transcript path.
    clearContext: { command: "/new" },
    // Null: pi has no MCP client at all - it extends via in-process TS extensions, not MCP - so
    // the installer says so rather than shelling out to a registration CLI that does not exist.
    mcp: null,
    // pi's `--thinking` accepts `off|minimal|low|medium|high|xhigh|max`; the app's
    // THINKING_LEVELS (`low..max`) are a subset it accepts verbatim.
    effort: {
      levels: THINKING_LEVELS,
      levelsFor: () => THINKING_LEVELS,
      launchArgs: (level) => ["--thinking", level],
      // Pi's Shift+Tab walks one direction through seven values, including `off` and
      // `minimal`, so neither existing live-picker shape can drive it faithfully.
      sessionPicker: null,
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

/** Why this particular session cannot hold a work queue, or null when it can. */
export function workQueueBlockedReason(
  session: Pick<Session, "agent" | "hooksSeen">,
): string | null {
  const queue = HARNESS_CAPABILITIES[session.agent].workQueue;
  if (!queue) return workQueueUnsupportedWhy(session.agent);
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
 * The agents "auto mode on dispatch" actually reaches - the ones that both have
 * permission modes and name one meaning "proceed autonomously".
 *
 * A setting whose switch reaches only some of the grid has to say which some, and the
 * settings panel used to answer that with the literal words "claude only" and "Codex
 * support comes later" - a sentence that is wrong the moment a third harness lands and
 * that nothing would fail to catch.
 */
export function autoModeAgents(): AgentType[] {
  return AGENT_TYPES.filter((a) => HARNESS_CAPABILITIES[a].permissionModes?.onDispatch);
}

/**
 * Why "auto mode on dispatch" does not drive this harness through a mode CYCLE, or null
 * when it does.
 *
 * Two different absences, said differently, because they are different facts: a harness
 * with no permission modes at all has nothing to switch, while one that HAS modes but
 * names no `onDispatch` has nothing that would mean "proceed without asking". Rolling
 * both into one sentence would make the second read as the first.
 *
 * Neither sentence may say the dispatch is UNAFFECTED, which is what both used to say and
 * is no longer true: `prepareCodexLaunch` takes this same switch and turns it into
 * `--sandbox workspace-write --ask-for-approval on-request` at launch. The switch reaches
 * Codex; what it does not reach is a `--permission-mode` flag, because Codex has no such
 * mode. A panel promising "unaffected" over a session launched with a widened sandbox is a
 * consent failure, not a copy nit.
 */
export function autoModeUnsupportedWhy(agent: AgentType): string | null {
  const modes = HARNESS_CAPABILITIES[agent].permissionModes;
  const who = AGENT_IDENTITY[agent].label;
  if (!modes) return `${who} has no permission modes to switch, so nothing is typed at it after launch.`;
  if (!modes.onDispatch)
    return `${who} has permission modes but none that mean "proceed without asking", so nothing is typed at it after launch.`;
  return null;
}
