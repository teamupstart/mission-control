#!/usr/bin/env node
// Idempotently wire the Fleet Control hook into Claude Code's settings.json.
//
// Adds one command hook per event that runs harness-hook.mjs. Re-running updates
// the path in place (matched by the "harness-hook.mjs" marker) without touching
// any of the user's other hooks. `--uninstall` removes only our entries.
//
// Uninstall also clears the `fleet-*` skill symlinks out of ~/.claude/skills - as
// TEARDOWN, not as the off-switch. They are the most invasive thing the harness puts in
// a home directory (Claude loads them into every session on the machine), so a checkout
// being abandoned should not leave them pointing at it. Delegated to the reconciler
// rather than re-walked here, so the "only ever our own symlinks, never a real
// directory" rule keeps its single implementation.
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

const MARKER = "harness-hook.mjs";
/** Marker identifying our statusLine wrapper command in settings.json. */
const STATUSLINE_MARKER = "harness-statusline.mjs";
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
];
// Tool events use a matcher; the rest match all invocations.
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "harness-hook.mjs");
const statuslineScriptPath = join(dirname(fileURLToPath(import.meta.url)), "harness-statusline.mjs");
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
const uninstall = process.argv.includes("--uninstall");
// Opt-in: also wrap the terminal status line so Claude's live model / thinking /
// context % reaches the daemon. Off by default - we never touch statusLine unless
// asked (uninstall still unwraps ours, so an install never leaves a dangling one).
const doStatusline = process.argv.includes("--statusline");

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

// --- fleet skill symlinks (uninstall only) ----------------------------------
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

if (text === original) {
  console.log(
    uninstall
      ? `No Fleet Control hooks found in ${settingsPath} - nothing to remove.`
      : `Fleet Control hooks already up to date in ${settingsPath} (left unchanged).`,
  );
  reportSkills();
  process.exit(0);
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, text);

if (uninstall) {
  console.log(`Removed Fleet Control hooks from ${settingsPath} (your other settings were left intact)`);
  if (statuslineAction === "restored") console.log(`  restored your original status line command.`);
  else if (statuslineAction === "removed") console.log(`  removed the Fleet Control status line wrapper.`);
  reportSkills();
  console.log(`\nTo remove the review-channel MCP server:\n  claude mcp remove -s user fleet-control`);
} else {
  console.log(`Wired Fleet Control hooks into ${settingsPath} (merged in place; your other settings untouched)`);
  console.log(`  events: ${EVENTS.join(", ")}`);
  console.log(`  script: ${scriptPath}`);
  if (statuslineAction === "wrapped" || statuslineAction === "updated") {
    console.log(`  status line wrapped to report model / thinking level / context %`);
    console.log(`    (delegates to your existing status line; recorded at ${statuslineInnerPath})`);
  } else if (!doStatusline) {
    console.log(`\nOptional: also surface model / thinking level / context % on the cards:`);
    console.log(`  npm run install-statusline   (wraps your status line; reversible via --uninstall)`);
  }
  console.log(`\nStart a new Claude Code session; it will report live status to Fleet Control.`);

  console.log(`\nTo enable the review channel (agents push diffs/plans for you to review),`);
  console.log(`register the MCP server once (needs \`npm run build\` first):\n`);
  console.log(`  claude mcp add -s user fleet-control -- "${process.execPath}" "${mcpPath}"\n`);
  if (!existsSync(mcpPath)) {
    console.log(`  (not built yet - run \`npm run build\`, or \`npm run setup\` to do both)`);
  }
}
