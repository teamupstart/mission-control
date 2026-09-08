import { join } from "node:path";

import { parse, type ParseError } from "jsonc-parser";

import { ENVIRONMENT_CHECK_INFO } from "@shared/environment-checks.ts";

import { missionHookScriptPath } from "../harness/claude/hooks.ts";
import type {
  EnvironmentCheckImpl,
  EnvironmentCheckResult,
  EnvironmentDeps,
} from "./types.ts";

// Do the hook commands Mission Control baked into `~/.claude/settings.json` still point at
// a script that exists?
//
// Why this is an ENVIRONMENT check and not a status dot: the bridge does not live in the
// daemon's own state. An installer wrote absolute paths into a file the operator owns,
// months ago, from a checkout that has since been renamed, moved, or thrown away, and the
// daemon reading this may be a different build in a different directory. So the question is
// the same one every check in this directory asks - what will a session launched on THIS
// machine inherit from `~/.claude` - and the answer is a report, never a repair.
//
// The failure it names, observed: a checkout at `~/workspace/ai-harness` was renamed, and
// the hooks installed from it stayed behind. Claude Code went on running
// `node ~/workspace/ai-harness/hooks/harness-hook.mjs <Event>` for all nine events, in every
// session on the machine, and each one died:
//
//   Error: Cannot find module '/Users/…/workspace/ai-harness/hooks/harness-hook.mjs'
//       at Module._resolveFilename (node:internal/modules/cjs/loader:1573:15)
//   code: 'MODULE_NOT_FOUND'
//
// Claude Code surfaces that as a `UserPromptSubmit hook error` and a `Stop hook error`,
// printed into the transcript on every single turn. Nothing in it names Mission Control,
// names the settings file, or says which of the operator's tools installed the path, so the
// visible symptom points nowhere near the cause. Meanwhile every terminal session on the
// machine reports no state at all, because the bridge that would have reported it is the
// thing failing.
//
// It is deliberately NOT repaired here, and that restraint is the whole reason the check
// can be trusted. The daemon knows where its own hook script is, so rewriting the path
// looks trivial - but this daemon may itself be running from a pooled worktree that its
// allocator will reclaim, which is the exact install `hooks/install-checks.mjs` refuses
// outright. An auto-repair would therefore be free to cause the outage it just reported,
// and would do it silently, from a background read nobody asked for. Naming the fix and
// letting a human run it from a durable clone is the only version of this that cannot make
// the problem worse.
//
// Silence on every machine that has never installed the hooks: no settings file, no
// commands of ours in it, or paths that all resolve, and this says nothing.

/** Claude Code's user settings, relative to the operator's home. */
const SETTINGS_FILE = [".claude", "settings.json"] as const;

/** The installer command that repairs every warning below, from a durable checkout. */
const REPAIR_COMMAND = "npm run install-hooks";
/** What does the same thing for someone running the packaged app. */
const REPAIR_BUTTON = "Install Claude integrations";

/**
 * A ceiling on hook commands inspected, so no settings file can turn this into a stall.
 *
 * Nine events times a handful of groups each is the real shape; 500 is far past any
 * hand-written configuration and still one cheap pass over an already-parsed object.
 */
const MAX_COMMANDS = 500;

/**
 * A ceiling on distinct scripts probed, because each one costs a read.
 *
 * Two is the true maximum an installer of ours can produce (this repo's script and the
 * packaged app's satellite). The bound is for a settings file that has accumulated entries
 * from several checkouts over time, which is precisely the population this check is for.
 */
const MAX_SCRIPTS = 8;

/**
 * The longest path this check will print back.
 *
 * The path comes out of a file the daemon does not own, so it is bounded before it travels
 * to the dashboard - the same rule the UpstartClaw check applies to its state value. Unlike
 * that one there is no redaction question here: the shape is already pinned by
 * `missionHookScriptPath`, which only ever returns an absolute path ending in one of our
 * own script names. Length is the only thing left that could hurt, and it hurts a modal's
 * layout rather than a secret.
 */
const MAX_PATH_CHARS = 160;

function shortPath(path: string): string {
  return path.length <= MAX_PATH_CHARS ? path : `${path.slice(0, MAX_PATH_CHARS - 1)}…`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Every `{ event, command }` pair in a parsed settings file, in the file's own order.
 *
 * Every event key is walked, not only the ones `claudeHooks.events` currently lists. An
 * entry an older build installed under an event this one no longer registers is still an
 * entry Claude Code runs, and it fails exactly as loudly; a walk limited to today's
 * vocabulary would go quiet on the oldest installs, which are the likeliest to be stale.
 *
 * Shape-tolerant throughout: this is somebody else's file and anything unexpected is
 * skipped rather than assumed. A malformed group cannot produce a finding, so the cost of
 * ignoring it is silence about one entry, never a wrong sentence about it.
 */
function hookCommands(settings: unknown): { event: string; command: string }[] {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const found: { event: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const command = (entry as { command?: unknown } | null)?.command;
        if (typeof command !== "string") continue;
        found.push({ event, command });
        if (found.length >= MAX_COMMANDS) return found;
      }
    }
  }
  return found;
}

/** Our scripts named by the file, each with the events it was installed for. */
function scriptsInUse(settings: unknown): Map<string, Set<string>> {
  const byScript = new Map<string, Set<string>>();
  for (const { event, command } of hookCommands(settings)) {
    const script = missionHookScriptPath(command);
    if (script === null) continue;
    const events = byScript.get(script);
    if (events) events.add(event);
    else if (byScript.size < MAX_SCRIPTS) byScript.set(script, new Set([event]));
  }
  return byScript;
}

/** The sentence for one missing script, given how many events run it. */
function missingSentence(script: string, events: number): string {
  return `Claude Code runs ${shortPath(script)} for ${plural(events, "hook event")} on this machine, and that file is not there.`;
}

export const claudeHookScriptCheck: EnvironmentCheckImpl = {
  ...ENVIRONMENT_CHECK_INFO["mission-hook-script"],

  async check(deps: EnvironmentDeps): Promise<EnvironmentCheckResult> {
    const settingsPath = join(deps.homeDir, ...SETTINGS_FILE);
    const read = await deps.readText(settingsPath);
    // No settings file is the ordinary state of a machine that never ran the installer, and
    // one that exists and cannot be read is a fault Claude Code itself reports far more
    // loudly than a note in a dispatch dialog would. Neither is a missing script, which is
    // the only thing this check claims to know about, so both are silence rather than a
    // warning this check has not earned.
    if (!read.ok) return { warning: null, detail: null };

    // jsonc-parser is fault-tolerant by contract: it returns a best-effort value AND fills
    // `errors`, so passing `[]` and ignoring it means reading a reconstruction of a file that
    // was never validated. That matters here beyond tidiness. A settings file that does not
    // parse is one Claude Code cannot apply either, so a hook path salvaged from the wreckage
    // names a bridge that is not running - and this check would be accusing the operator of a
    // dead path when their real problem is broken JSON.
    //
    // Truncation is the one exception, and has to be, or a settings file larger than the read
    // bound could never be checked at all: an unterminated tail always parses with errors, and
    // those errors are OURS - we cut the file - not the operator's. Findings from a partial
    // read stay sound because each one needs a complete quoted absolute path ending in a known
    // script name, which truncation can remove but cannot fabricate.
    const errors: ParseError[] = [];
    const settings = parse(read.text, errors, { allowTrailingComma: true });
    if (errors.length > 0 && !read.truncated) return { warning: null, detail: null };

    const missing: { script: string; events: number }[] = [];
    for (const [script, events] of scriptsInUse(settings)) {
      const probe = await deps.readText(script);
      // Only absence counts. A script that is present but unreadable is a permission
      // problem this check cannot distinguish from a race, and `readText` already folds the
      // "a directory sits where the file should be" case into `missing`.
      if (!probe.ok && probe.missing) missing.push({ script, events: events.size });
    }
    if (missing.length === 0) return { warning: null, detail: null };

    const sentences = missing.map(({ script, events }) => missingSentence(script, events));
    return {
      warning:
        `${sentences.join(" ")} Every one of those events fails with MODULE_NOT_FOUND, prints its stack into the session transcript, and reports nothing back, so terminal sessions on this machine show no state. ` +
        `The path was baked in by an installer and does not follow a checkout that moved: re-run \`${REPAIR_COMMAND}\` from a Mission Control checkout that still exists, or press ${REPAIR_BUTTON} in the desktop app.`,
      detail: `${settingsPath} names ${missing.map(({ script }) => shortPath(script)).join(", ")}`,
    };
  },
};
