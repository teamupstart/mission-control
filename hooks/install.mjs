#!/usr/bin/env node
// Idempotently wire the AI Harness hook into Claude Code's settings.json.
//
// Adds one command hook per event that runs harness-hook.mjs. Re-running updates
// the path in place (matched by the "harness-hook.mjs" marker) without touching
// any of the user's other hooks. `--uninstall` removes only our entries.
//
// This is opt-in: the user runs `npm run install-hooks`. It never runs itself.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

function load() {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err) {
    console.error(`Refusing to edit: ${settingsPath} is not valid JSON (${err.message}).`);
    process.exit(1);
  }
}

const settings = load();
settings.hooks ??= {};

for (const event of EVENTS) {
  const cleaned = stripOurs(settings.hooks[event]);
  if (!uninstall) {
    const group = { hooks: [{ type: "command", command: command(event) }] };
    if (MATCHER_EVENTS.has(event)) group.matcher = "*";
    cleaned.push(group);
  }
  if (cleaned.length > 0) settings.hooks[event] = cleaned;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

const mcpPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp", "server.mjs");

if (uninstall) {
  console.log(`Removed AI Harness hooks from ${settingsPath}`);
  console.log(`\nTo remove the review-channel MCP server:\n  claude mcp remove -s user ai-harness`);
} else {
  console.log(`Wired AI Harness hooks into ${settingsPath}`);
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
