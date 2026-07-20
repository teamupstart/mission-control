#!/usr/bin/env node
// Idempotently wire the Mission Control hook into Claude Code's settings.json.
//
// Adds one command hook per event that runs harness-hook.mjs. Re-running updates
// the path in place (matched by the "harness-hook.mjs" marker) without touching
// any of the user's other hooks. `--uninstall` removes only our entries.
//
// Uninstall also clears our `mission-*` and `fleet-*` skill symlinks out of
// ~/.claude/skills - as TEARDOWN, not as the off-switch. They are the most invasive
// thing the harness puts in a home directory (Claude loads them into every session on
// the machine), so a checkout being abandoned should not leave them pointing at it.
// Delegated to the reconciler rather than re-walked here, so the "only ever our own
// symlinks, never a real directory" rule keeps its single implementation.
//
// It does NOT turn the feature off, and must not be described as though it does: the
// config still says the skills are on, and the daemon reconciles against that config on
// every start, so a daemon run from this checkout again re-creates them. The durable
// off-switch is the panel's master switch, which records the intent. This is for the
// case where there is no panel left to click.
//
// The edit is surgical: we parse settings.json with jsonc-parser and rewrite
// ONLY the hook arrays we actually change, so the rest of the file - your other
// keys, your comments, and its formatting - is left byte-for-byte intact. If
// nothing needs to change, the file isn't rewritten at all. This is opt-in: the
// user runs `npm run install-hooks`. It never runs itself.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";
import { stateDir } from "../src/shared/harness-runtime.mjs";
// TypeScript, and reachable because this script's entry point is `tsx hooks/install.mjs`
// (see package.json) - unlike harness-hook.mjs, which bare `node` runs at hook time and
// which is why the runtime module above is .mjs at all.
import { claudeSkillsDir, uninstallSkillLinks } from "../src/server/skills/reconcile.ts";
// One definition of the OTel env block, shared with the packaged app's installer and the
// dashboard's Cost panel - three writers of the same six keys is exactly how half a block
// gets left behind that nothing owns. See src/shared/claude-settings.ts.
import { otelEnvInstalled, writeOtelEnv } from "../src/shared/claude-settings.ts";
import { BASE_URL, ensureToken } from "../src/shared/harness-runtime.mjs";
// The event vocabulary belongs to the harness, not to its installers. Both this script
// and the packaged app's installer (src/main/integrations.ts) used to carry their own
// copy of these two lists, hand-kept, with nothing catching the drift - so an event
// added to one and not the other was a session state that worked from a checkout and
// not from the .app. Imported from the spec directly rather than through
// `harness/index.ts` to keep the daemon out of the Electron bundle; see that file.
import { claudeHooks } from "../src/server/harness/claude/hooks.ts";

const MARKER = "harness-hook.mjs";
/** Marker identifying our statusLine wrapper command in settings.json. */
const STATUSLINE_MARKER = "harness-statusline.mjs";
const EVENTS = claudeHooks.events;
// Tool events use a matcher; the rest match all invocations.
const MATCHER_EVENTS = new Set(claudeHooks.matcherEvents);

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "harness-hook.mjs");
const statuslineScriptPath = join(dirname(fileURLToPath(import.meta.url)), "harness-statusline.mjs");
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
const uninstall = process.argv.includes("--uninstall");
// Opt-in: also wrap the terminal status line so Claude's live model / thinking /
// context % reaches the daemon. Off by default - we never touch statusLine unless
// asked (uninstall still unwraps ours, so an install never leaves a dangling one).
const doStatusline = process.argv.includes("--statusline");
// Opt-in, and separately from --statusline: cost telemetry over OpenTelemetry. Two
// switches rather than one because they are two different asks of the user's config -
// this one adds an `env` block that makes EVERY Claude session on the machine export to
// the daemon, while --statusline rewrites the command that draws their terminal line.
// Someone may well want the spend figures and not want us near their status line, and
// the reverse; bundling them would force a choice neither of them made.
const doTelemetry = process.argv.includes("--telemetry");
/**
 * Default export interval, in ms, matching `CostConfigSchema`'s default.
 *
 * The SDK's own default is 60s, which makes a cost badge feel dead beside a context
 * meter that moves every render. 15s is livelier at the cost of four requests per
 * session per minute, all on loopback.
 */
const TELEMETRY_INTERVAL_MS = 15000;

function command(event) {
  return `"${process.execPath}" "${scriptPath}" ${event}`;
}

/** Our statusLine wrapper command (delegates to the user's real status line). */
function statuslineCommand() {
  return `"${process.execPath}" "${statuslineScriptPath}"`;
}

/** Sidecar recording the user's pre-wrap status line so the forwarder delegates to it. */
const statuslineInnerPath = join(stateDir(), "statusline-inner");

/** Our hook group for an event, matcher-first so re-runs are byte-stable. */
function ourGroup(event) {
  const group = { hooks: [{ type: "command", command: command(event) }] };
  return MATCHER_EVENTS.has(event) ? { matcher: "*", ...group } : group;
}

/** Strip any prior harness groups / hooks from an event's array. */
function stripOurs(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g) => {
      if (!g || !Array.isArray(g.hooks)) return g;
      const hooks = g.hooks.filter((h) => !(h && typeof h.command === "string" && h.command.includes(MARKER)));
      return { ...g, hooks };
    })
    .filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
}

// --- read current file ------------------------------------------------------
const existed = existsSync(settingsPath);
const original = existed ? readFileSync(settingsPath, "utf8") : "";

const parseErrors = [];
const settings = parse(original || "{}", parseErrors, { allowTrailingComma: true });
// Comments and trailing commas are tolerated; only genuinely broken JSON errors.
if (original.trim() && parseErrors.length > 0) {
  console.error(`Refusing to edit: ${settingsPath} is not valid JSON/JSONC. Fix it and re-run.`);
  process.exit(1);
}

const hooksVal = settings && typeof settings === "object" ? settings.hooks : undefined;
const hooksIsObject = Boolean(hooksVal) && typeof hooksVal === "object" && !Array.isArray(hooksVal);
const currentHooks = hooksIsObject ? hooksVal : {};

// Match the file's own formatting so anything we insert blends in.
const formattingOptions = {
  insertSpaces: !/^\t/m.test(original),
  tabSize: (original.match(/\n( +)\S/) ?? [, "  "])[1].length,
  eol: original.includes("\r\n") ? "\r\n" : "\n",
};
const edit = (text, path, value) => applyEdits(text, modify(text, path, value, { formattingOptions }));

// --- compute + apply the minimal edits --------------------------------------
let text = original.trim() ? original : "{}";

if (!hooksIsObject) {
  // No usable hooks object yet: set the whole `hooks` key in one edit (still
  // surgical - the rest of the file is untouched).
  const hooksObj = {};
  for (const event of EVENTS) {
    if (!uninstall) hooksObj[event] = [ourGroup(event)];
  }
  if (Object.keys(hooksObj).length > 0) text = edit(text, ["hooks"], hooksObj);
  else if (hooksVal !== undefined) text = edit(text, ["hooks"], undefined); // uninstall: drop malformed hooks
} else {
  for (const event of EVENTS) {
    const current = currentHooks[event];
    const desired = uninstall ? stripOurs(current) : [...stripOurs(current), ourGroup(event)];
    if (desired.length > 0) {
      // Only rewrite this event's array if it actually differs.
      if (JSON.stringify(current) !== JSON.stringify(desired)) text = edit(text, ["hooks", event], desired);
    } else if (current !== undefined) {
      text = edit(text, ["hooks", event], undefined);
    }
  }
  // Drop an emptied `hooks` object (e.g. after --uninstall).
  const after = parse(text, [], { allowTrailingComma: true });
  if (after?.hooks && typeof after.hooks === "object" && Object.keys(after.hooks).length === 0) {
    text = edit(text, ["hooks"], undefined);
  }
}

// --- statusLine wrapper (opt-in) --------------------------------------------
// Wrap the user's status line so Claude's live model/effort/context reaches the
// daemon, delegating to their existing command (recorded in a sidecar) so the
// terminal is unchanged. Uninstall always unwraps ours - restoring the recorded
// command, or dropping the key - so we never leave a wrapper pointing at a script
// that's been removed.
const currentSL = settings && typeof settings === "object" ? settings.statusLine : undefined;
const slIsOurs = Boolean(
  currentSL &&
    typeof currentSL === "object" &&
    typeof currentSL.command === "string" &&
    currentSL.command.includes(STATUSLINE_MARKER),
);
let statuslineAction = null;

if (uninstall) {
  if (slIsOurs) {
    let inner = null;
    try {
      inner = readFileSync(statuslineInnerPath, "utf8").trim() || null;
    } catch {
      inner = null;
    }
    text = inner
      ? edit(text, ["statusLine"], { type: "command", command: inner })
      : edit(text, ["statusLine"], undefined);
    try {
      rmSync(statuslineInnerPath, { force: true });
    } catch {
      // sidecar already gone - fine
    }
    statuslineAction = inner ? "restored" : "removed";
  }
} else if (doStatusline) {
  const ourCommand = statuslineCommand();
  if (!slIsOurs) {
    // Record the user's existing command (if any) so the forwarder delegates to it.
    const existing =
      currentSL && typeof currentSL === "object" && typeof currentSL.command === "string"
        ? currentSL.command.trim()
        : "";
    if (existing) {
      try {
        mkdirSync(dirname(statuslineInnerPath), { recursive: true });
        writeFileSync(statuslineInnerPath, existing + "\n");
      } catch {
        // couldn't record - forwarder falls back to ccstatusline
      }
    }
    text = edit(text, ["statusLine"], { type: "command", command: ourCommand });
    statuslineAction = "wrapped";
  } else if (currentSL.command !== ourCommand) {
    // Already ours: keep the recorded inner, just refresh a drifted script path.
    text = edit(text, ["statusLine"], { type: "command", command: ourCommand });
    statuslineAction = "updated";
  }
}

// New files get a trailing newline; existing files keep their own byte layout.
if (!existed && !text.endsWith(formattingOptions.eol)) text += formattingOptions.eol;

// --- skill symlinks (uninstall only) ----------------------------------
// Ahead of the write, and reported on BOTH exits below, because whether settings.json
// still holds a hook of ours says nothing about whether the skills directory holds a
// link of ours. Hooks already stripped by an earlier run would otherwise take the
// "nothing to remove" exit and leave the links installed - exactly the state this is
// here to end. Never on install: the daemon reconciles from the config, and creating
// links from here would enable skills nobody switched on.
const skills = uninstall ? uninstallSkillLinks() : null;

function reportSkills() {
  if (!skills) return;
  if (skills.unlinked.length > 0) {
    const names = skills.unlinked.sort().join(", ");
    console.log(`  removed ${skills.unlinked.length} skill link(s) from ${claudeSkillsDir()}: ${names}`);
  }
  // Say so rather than exiting 0 over it - a link we couldn't remove is still loaded
  // by every Claude on the machine, and the operator is the only one who can finish it.
  for (const problem of skills.problems) console.log(`  ${problem}`);
}

// --- write only if something changed ----------------------------------------
const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp", "server.mjs");

const hooksChanged = text !== original;
if (hooksChanged) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, text);
}

// --- OTel env block (opt-in on install; always removed on uninstall) ----------
//
// AFTER the write above, deliberately: `writeOtelEnv` re-reads settings.json from disk and
// writes it back, so running it against the pre-write text would have this script's own
// `text` clobber the env edit a moment later. Sequencing it here means each edit sees the
// other's result, and both stay surgical.
//
// Uninstall removes the block unconditionally, exactly as it unwraps the status line -
// leaving an `env` pointing at a daemon this checkout no longer runs would keep every
// Claude session on the machine retrying an export forever.
//
// An install WITHOUT `--telemetry` touches the block not at all - it is not a request to
// remove one, the same way an install without `--statusline` never unwraps a status line.
// The app's Cost settings toggle is what owns this block; tearing it down from a plain
// `install-hooks` would silently disable telemetry someone switched on there and leave the
// daemon's stored `enabled` disagreeing with the file, with nothing to reconcile them.
//
// `ensureToken()` rather than `readToken()`: this runs before the daemon has necessarily
// ever booted (`npm run setup` installs first), and "" would bake an empty auth header
// into settings.json, get every export 401'd, and look exactly like a fresh install.
let telemetryAction = "unchanged";
try {
  if (uninstall) telemetryAction = writeOtelEnv(null);
  else if (doTelemetry)
    telemetryAction = writeOtelEnv({
      endpoint: BASE_URL,
      token: ensureToken(),
      intervalMs: TELEMETRY_INTERVAL_MS,
    });
} catch (err) {
  // Never fatal: the hooks are the point of this script, and a telemetry block we
  // couldn't write costs cost figures, not status.
  console.error(`  could not update the telemetry env block: ${err?.message ?? err}`);
}

function reportTelemetry() {
  if (telemetryAction === "installed" || telemetryAction === "updated") {
    console.log(`  cost telemetry enabled: Claude Code will export usage to ${BASE_URL}`);
    console.log(`    (env block in ${settingsPath}; export every ${TELEMETRY_INTERVAL_MS / 1000}s)`);
  } else if (telemetryAction === "removed") {
    console.log(`  removed the cost telemetry env block.`);
  }
}

if (!hooksChanged && telemetryAction === "unchanged") {
  console.log(
    uninstall
      ? `No Mission Control hooks found in ${settingsPath} - nothing to remove.`
      : `Mission Control hooks already up to date in ${settingsPath} (left unchanged).`,
  );
  reportSkills();
  process.exit(0);
}

if (uninstall) {
  console.log(`Removed Mission Control hooks from ${settingsPath} (your other settings were left intact)`);
  if (statuslineAction === "restored") console.log(`  restored your original status line command.`);
  else if (statuslineAction === "removed") console.log(`  removed the Mission Control status line wrapper.`);
  reportTelemetry();
  reportSkills();
  // Names it was registered under before the renames, too: the MCP server is added by
  // hand with `claude mcp add <name>`, so an install from an older version is still
  // registered under whatever name it was added with, and a hint that only names the
  // current one leaves that registration behind pointing at a script we just removed.
  console.log(
    `\nTo remove the review-channel MCP server:\n  claude mcp remove -s user mission-control` +
      `\n  (installed before the rename? try: fleet-control, ai-harness)`,
  );
} else {
  console.log(`Wired Mission Control hooks into ${settingsPath} (merged in place; your other settings untouched)`);
  console.log(`  events: ${EVENTS.join(", ")}`);
  console.log(`  script: ${scriptPath}`);
  if (statuslineAction === "wrapped" || statuslineAction === "updated") {
    console.log(`  status line wrapped to report model / thinking level / context %`);
    console.log(`    (delegates to your existing status line; recorded at ${statuslineInnerPath})`);
  } else if (!doStatusline && !slIsOurs) {
    console.log(`\nOptional: also surface model / thinking level / context % on the cards:`);
    console.log(`  npm run install-statusline   (wraps your status line; reversible via --uninstall)`);
  }
  reportTelemetry();
  // Both hints above and below ask "is it actually off?", not "did this run change it?".
  // Neither opt-in is touched by a plain install any more, so the action stays "unchanged"
  // whether or not the thing is already on - and offering someone who switched telemetry
  // on in Settings -> Cost a command to switch it on is worse than saying nothing.
  if (!doTelemetry && !otelEnvInstalled()) {
    console.log(`\nOptional: track what the fleet costs (Claude Code's own figures, over OpenTelemetry):`);
    console.log(`  npm run install-telemetry    (adds an env block; reversible via --uninstall)`);
  }
  console.log(`\nStart a new Claude Code session; it will report live status to Mission Control.`);

  console.log(`\nTo enable the review channel (agents push diffs/plans for you to review),`);
  console.log(`register the MCP server once (needs \`npm run build\` first):\n`);
  console.log(`  claude mcp add -s user mission-control -- "${process.execPath}" "${mcpPath}"\n`);
  if (!existsSync(mcpPath)) {
    console.log(`  (not built yet - run \`npm run build\`, or \`npm run setup\` to do both)`);
  }
}
