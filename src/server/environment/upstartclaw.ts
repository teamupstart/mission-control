import { join } from "node:path";

import { ENVIRONMENT_CHECK_INFO } from "@shared/environment-checks.ts";

import type {
  EnvironmentCheckImpl,
  EnvironmentCheckResult,
  EnvironmentDeps,
} from "./types.ts";

// Does this machine's UpstartClaw core plugin have a finished setup?
//
// Why Mission Control cares at all: a dispatched session inherits the operator's
// `~/.claude`, so every plugin they have installed loads inside it - which is the whole
// zero-code integration, and also the one way it goes wrong unattended. UpstartClaw core
// ships a `PreToolUse` hook that refuses its own MCP calls until a setup state file says
// setup finished, and the setup it points at runs interactive OAuth flows that cannot
// complete inside a dispatched session. So an operator who installs the plugin and does not
// run its setup has built a fleet whose agents stall on their first Glean or Jira call, with
// nothing in Mission Control's own state to explain it. This check is the one place that
// says so, before the dispatch rather than after.
//
// Everything here is READ, per request, and nothing is written or fixed: Claw owns its own
// setup (plan decision "one owner per concern"), and a daemon that repaired another tool's
// state would be a second owner of it.
//
// Verified against the installed plugin, `upstartclaw-core` 1.1.7,
// `scripts/check-setup.sh` - which is the authority for the semantics below, because it IS
// the gate a dispatched agent hits:
//
//   STATE=$(cat "$HOME/.claude/upstartclaw-core-setup" 2>/dev/null || echo "no_setup")
//   case "$STATE" in completed | in_progress) exit 0 ;; *) <message> ; exit 2 ;; esac
//
// Two consequences worth stating, because the obvious reading of the plugin's own docs gets
// both wrong:
//
//   1. A MISSING file is not a separate case - the gate reads it as `no_setup` and blocks.
//      So "no file, plugin installed" and "file says no_setup" are the same warning.
//   2. `in_progress` PASSES the gate (the comment there says: so auth flows can run during
//      setup). It still warrants a warning, for a different reason than the blocked case:
//      setup was started and never finished, so the four core MCP servers are wired up but
//      unauthenticated, and a dispatched agent reaches them and fails on the credential
//      instead of being told why. The warning text has to say the true consequence per
//      state, or it sends the operator looking for a stall that will not happen.

/** The state file the plugin's setup skill writes, relative to the operator's home. */
const STATE_FILE = [".claude", "upstartclaw-core-setup"] as const;
/** Where Claude Code keeps installed plugins, relative to the operator's home. */
const PLUGINS_DIR = [".claude", "plugins"] as const;
/** Claude Code's own record of what is installed, inside `PLUGINS_DIR`. */
const INSTALL_RECORD = "installed_plugins.json";
/** The plugin's name - its directory under the plugin cache, and its key in the record. */
const PLUGIN = "upstartclaw-core";
/** The skill that fixes every warning below. */
const SETUP_COMMAND = "/upstartclaw-core:setup";

/** The one state that means "set up"; see the case statement quoted above. */
const COMPLETED = "completed";
/** Started and not finished. Passes the gate, which is why it reads differently. */
const IN_PROGRESS = "in_progress";

/**
 * How deep under `~/.claude/plugins` an installed plugin's directory sits.
 *
 * `cache/<marketplace>/<plugin>/<version>/` on the layout verified above, so the plugin's
 * own directory is at depth 3. Bounded rather than a full walk because the marketplace
 * checkout beside it is a whole monorepo of sixty-odd plugins: an unbounded search would
 * cost thousands of `readdir`s on every dispatch modal open, and would match the
 * marketplace's own copy of the plugin - which says the catalogue is available, not that
 * this operator installed it.
 */
const MAX_DEPTH = 3;
/** A hard ceiling on directories listed, so no layout can turn this probe into a stall. */
const MAX_DIRS = 200;

/** `"in_progress"` for a value, `an empty file` for the empty string. */
function quoted(value: string): string {
  return value ? `"${value}"` : "an empty file";
}

/**
 * Whether Claude Code's install record names the plugin.
 *
 * Matched as text rather than parsed against a shape, because the shape is not ours and has
 * already changed once (the file carries `"version": 2`). The plugin's NAME appearing as a
 * key - `"upstartclaw-core@<marketplace>"` - is the part that survives a revision, and the
 * quote and `@` boundaries are what keep it from matching the marketplace's own name.
 */
function recordNamesPlugin(text: string): boolean {
  return new RegExp(`"${PLUGIN}(@[^"]*)?"`).test(text);
}

/**
 * Whether a directory named after the plugin exists within `MAX_DEPTH` of the plugins dir.
 *
 * Breadth-first with a budget: the plugin's install directory is what a version bump moves
 * and a manual install may place differently, so this looks for the NAME at any depth up to
 * the bound rather than asserting one path.
 */
async function pluginDirPresent(root: string, deps: EnvironmentDeps): Promise<boolean> {
  let frontier = [root];
  let budget = MAX_DIRS;
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && budget > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (budget <= 0) break;
      budget -= 1;
      for (const name of await deps.subdirectories(dir)) {
        if (name === PLUGIN) return true;
        next.push(join(dir, name));
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Whether this machine has the plugin installed at all.
 *
 * Two independent signals, either of which is enough, because "installed" is a fact about
 * another tool's storage layout and this must not become a claim about one version of it:
 * Claude Code's own install record, and a directory bearing the plugin's name. A machine
 * with neither is a machine that has never heard of UpstartClaw, and gets silence.
 */
async function pluginInstalled(deps: EnvironmentDeps): Promise<boolean> {
  const root = join(deps.homeDir, ...PLUGINS_DIR);
  const record = await deps.readText(join(root, INSTALL_RECORD));
  if (record.ok && recordNamesPlugin(record.text)) return true;
  return pluginDirPresent(root, deps);
}

/** What every warning ends with: the one command that resolves it. */
function fix(verb: string): string {
  return `${verb} ${SETUP_COMMAND} in an interactive Claude Code session - its sign-in flows cannot complete in a dispatched one.`;
}

/**
 * Setup has not run, from the gate's point of view: it refuses core MCP calls with exit 2.
 *
 * The same sentence for "the file says no_setup" and for "there is no file", because
 * `check-setup.sh` reads a missing file as `no_setup` - they are one state, not two.
 */
function blockedWarning(): string {
  return `Setup has not finished on this machine, so UpstartClaw's own tool gate refuses the core MCP calls an agent makes (Glean, Jira, Confluence, Slack). An unattended dispatched agent stalls on its first one instead of finishing the task. ${fix("Run")}`;
}

export const upstartclawSetupCheck: EnvironmentCheckImpl = {
  ...ENVIRONMENT_CHECK_INFO["upstartclaw-core-setup"],

  async check(deps: EnvironmentDeps): Promise<EnvironmentCheckResult> {
    const path = join(deps.homeDir, ...STATE_FILE);
    const state = await deps.readText(path);

    if (state.ok) {
      const value = state.text.trim();
      if (value === COMPLETED) return { warning: null, detail: null };
      if (value === IN_PROGRESS) {
        return {
          warning:
            "Setup was started and never finished. UpstartClaw lets tool calls through while setup is in progress, so a dispatched agent reaches the core MCP servers unauthenticated and fails on the credential rather than being told why. "
            + fix("Finish"),
          detail: `${path} reads ${quoted(value)}`,
        };
      }
      // Any other value - `no_setup`, empty, or something nobody expected - is the gate's
      // `*` branch, which exits 2. Reported as the blocked case rather than as an unknown
      // state, because that is what the machine will actually do.
      return { warning: blockedWarning(), detail: `${path} reads ${quoted(value)}` };
    }

    if (!state.missing) {
      // The file is there and the daemon could not read it. The gate runs as the same user
      // and reads the same file, so it will not read it either - and its fallback is
      // `no_setup`. Reported as its own state so the operator fixes the file rather than
      // re-running a setup that already finished.
      return {
        warning: `The setup state file cannot be read, so this machine cannot be shown to be set up - and UpstartClaw's own gate, reading the same file, will refuse core MCP calls. ${fix("Repair the file or re-run")}`,
        detail: `${path}: ${state.reason}`,
      };
    }

    // No state file. Silence unless the plugin is actually here: on a machine that has
    // never installed UpstartClaw this is not a finding, and the dispatch form must show no
    // note, no chrome, and nothing to dismiss.
    if (!(await pluginInstalled(deps))) return { warning: null, detail: null };
    return {
      warning: blockedWarning(),
      detail: `no ${path}, and ${PLUGIN} is installed under ${join(deps.homeDir, ...PLUGINS_DIR)}`,
    };
  },
};
