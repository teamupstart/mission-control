#!/usr/bin/env node
// Idempotently wire the Fleet Control hook into Claude Code's settings.json.
//
// Adds one command hook per event that runs harness-hook.mjs. Re-running updates
// the path in place (matched by the "harness-hook.mjs" marker) without touching
// any of the user's other hooks. `--uninstall` removes only our entries.
//
// The edit is surgical: we parse settings.json with jsonc-parser and rewrite
// ONLY the hook arrays we actually change, so the rest of the file - your other
// keys, your comments, and its formatting - is left byte-for-byte intact. If
// nothing needs to change, the file isn't rewritten at all. This is opt-in: the
// user runs `npm run install-hooks`. It never runs itself.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";

const MARKER = "harness-hook.mjs";
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
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
const uninstall = process.argv.includes("--uninstall");

function command(event) {
  return `"${process.execPath}" "${scriptPath}" ${event}`;
}

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

// New files get a trailing newline; existing files keep their own byte layout.
if (!existed && !text.endsWith(formattingOptions.eol)) text += formattingOptions.eol;

// --- write only if something changed ----------------------------------------
const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp", "server.mjs");

if (text === original) {
  console.log(
    uninstall
      ? `No Fleet Control hooks found in ${settingsPath} - nothing to remove.`
      : `Fleet Control hooks already up to date in ${settingsPath} (left unchanged).`,
  );
  process.exit(0);
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, text);

if (uninstall) {
  console.log(`Removed Fleet Control hooks from ${settingsPath} (your other settings were left intact)`);
  console.log(`\nTo remove the review-channel MCP server:\n  claude mcp remove -s user ai-harness`);
} else {
  console.log(`Wired Fleet Control hooks into ${settingsPath} (merged in place; your other settings untouched)`);
  console.log(`  events: ${EVENTS.join(", ")}`);
  console.log(`  script: ${scriptPath}`);
  console.log(`\nStart a new Claude Code session; it will report live status to the harness.`);

  console.log(`\nTo enable the review channel (agents push diffs/plans for you to review),`);
  console.log(`register the MCP server once (needs \`npm run build\` first):\n`);
  console.log(`  claude mcp add -s user ai-harness -- "${process.execPath}" "${mcpPath}"\n`);
  if (!existsSync(mcpPath)) {
    console.log(`  (not built yet - run \`npm run build\`, or \`npm run setup\` to do both)`);
  }
}
