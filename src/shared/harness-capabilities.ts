import { AGENT_TYPES } from "./types.ts";
import type { AgentType, PermissionMode } from "./types.ts";
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
}

/**
 * Loading skills into a live session.
 *
 * Null means both halves are absent: nothing to symlink into, and no command that would
 * make a running session notice if there were. Typing a reload command at a harness that
 * has none puts a stray line in someone's prompt and changes nothing, which is exactly
 * the silent no-op the capability exists to prevent.
 */
export interface SkillsSpec {
  /**
   * The command that makes a live session re-read its skills directory without being
   * restarted. Verified against claude 2.1.211: a directory symlinked in AFTER a session
   * reached its prompt is picked up by this and nothing else - there is no watcher on the
   * skills directory.
   *
   * Spelled once, here, for the same reason `WRAPUP_NO_MISTAKES` is: it is typed into a
   * live pane, so the bytes must have exactly one definition. It must also stay a SINGLE
   * LINE - a slash command carrying a newline is two submissions.
   *
   * Do NOT parse what comes back. On a REMOVAL the count correctly dropped (the skill
   * really did unload) while the label still read "(no changes)". The unload is real; the
   * message is not trustworthy. Treat delivery as fire-and-forget.
   */
  reloadCommand: string;
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
 * Null is a composite claim, and all of it has to be true to queue work: hooks report
 * when the agent picks an item up and finishes it, and the transcript can be read back to
 * check that it did. Codex has neither, so a queue on a Codex session would be a one-way
 * trip to nowhere - every tick would skip it, and because the session is LIVE its key is
 * live, so neither the cwd re-attach hint nor the orphan sweep would ever offer the batch
 * to anyone.
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
  scope: string;
  /** The name we register under - also the name an uninstall removes. */
  serverName: string;
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
}

/**
 * Claude Code's skills capability, named so `claudeSkillsDir` can reach it without a
 * null check. The reconciler manages ONE directory today because exactly one harness
 * declares skills; when a second does, that function becomes a loop over
 * `skillsAgents()` and its callers take a list.
 */
export const CLAUDE_SKILLS: SkillsSpec = {
  reloadCommand: "/reload-skills",
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
    },
    skills: CLAUDE_SKILLS,
    workQueue: {
      uninstrumentedWhy:
        "This session has no hooks reporting, so Foreman can't tell when it picks work up or finishes it. Install the Claude integrations to queue work here.",
    },
    clearContext: { command: "/clear" },
    mcp: { cli: "claude", scope: "user", serverName: "mission-control" },
  },
  codex: {
    id: "codex",
    // No permission-mode concept: no footer mode line to read, and no Shift+Tab cycle to
    // walk. `annotatePaneState` therefore has nothing to capture for it either.
    permissionModes: null,
    // No `/reload-skills` and no skills directory of its own.
    skills: null,
    // No hooks and no readable turns - see `GOAL_UNSUPPORTED`, which is the same fact
    // stated for the card.
    workQueue: null,
    // Its slash vocabulary is its own; `/clear` here would be typed as a prompt.
    clearContext: null,
    // Codex ships an MCP client, but registering with it is a different CLI and a
    // different config file, and nothing has been verified against one. Declared absent
    // rather than guessed at: the installer says what it did not do.
    mcp: null,
  },
};

/**
 * One agent's capabilities. Total by construction - the record cannot have a hole.
 *
 * The browser-safe door to the fields below. Server code holding a `Harness`
 * (`harnessFor`) reads the same slots off that object; the two are the same values,
 * because `HARNESSES` is built by spreading this record.
 */
export function capabilitiesFor(agent: AgentType): HarnessCapabilities {
  return HARNESS_CAPABILITIES[agent];
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
  return `Work queues need hook reporting and a readable transcript, which ${AGENT_IDENTITY[agent].label} sessions don't have.`;
}

/** The agents whose harness can load skills - who a skills surface is actually about. */
export function skillsAgents(): AgentType[] {
  return AGENT_TYPES.filter((a) => HARNESS_CAPABILITIES[a].skills !== null);
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
 * Why "auto mode on dispatch" leaves this harness alone, or null when it doesn't.
 *
 * Two different absences, said differently, because they are different facts: a harness
 * with no permission modes at all has nothing to switch, while one that HAS modes but
 * names no `onDispatch` has nothing that would mean "proceed without asking". Rolling
 * both into one sentence would make the second read as the first.
 */
export function autoModeUnsupportedWhy(agent: AgentType): string | null {
  const modes = HARNESS_CAPABILITIES[agent].permissionModes;
  const who = AGENT_IDENTITY[agent].label;
  if (!modes) return `${who} has no permission modes, so its dispatches are unaffected.`;
  if (!modes.onDispatch)
    return `${who} has permission modes but none that mean "proceed without asking", so its dispatches are unaffected.`;
  return null;
}
