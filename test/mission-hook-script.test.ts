import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  MISSION_HOOK_SCRIPTS,
  isMissionHookCommand,
  missionHookScriptPath,
} from "../src/server/harness/claude/hooks.ts";
import { ENVIRONMENT_ROW_METADATA } from "../src/shared/setup-catalog.ts";
import { environmentCheckViews } from "../src/server/environment/index.ts";
import type { EnvironmentDeps, FileRead } from "../src/server/environment/types.ts";

// What is at stake: an installer of ours bakes an ABSOLUTE path into a file the operator
// owns, and then nothing watches it. A checkout gets renamed and every Claude session on
// the machine starts failing every hook event with MODULE_NOT_FOUND, printing a stack into
// each transcript that names neither Mission Control nor the settings file that caused it.
// That went unnoticed on a real machine until an operator pasted the stack into a session
// and asked what it was.
//
// Two halves, and they fail in opposite directions.
//
// Recognising our own command has to be EXACT, because whatever comes back is reported to a
// human as a file that is missing. A guess that happens to be wrong is a note pointing at a
// path that was never a path, in a dialog the operator then learns to ignore.
//
// Recognising it for REMOVAL has to be generous, because anything of ours left behind fires
// a second time for every event. That asymmetry is deliberate and is pinned below.
//
// The check itself is driven through `environmentCheckViews` against arranged deps, never
// the developer's own `~/.claude` - the same rule the UpstartClaw check's tests follow, and
// the reason `EnvironmentDeps` exists at all.

const HOME = "/home/tester";
const SETTINGS = join(HOME, ".claude", "settings.json");

/** The path this repository's installer bakes, from a checkout that later went away. */
const STALE = "/Users/tester/workspace/ai-harness/hooks/harness-hook.mjs";
/** The same installer, from a checkout that is still there. */
const LIVE = "/Users/tester/workspace/mission-control/hooks/harness-hook.mjs";
/** What the packaged app bakes. The space in the bundle name is why the path is quoted. */
const SATELLITE = "/Applications/Mission Control.app/Contents/Resources/app/dist/satellites/hook.mjs";

/** Every event this build installs a bridge for, which is what a real settings file holds. */
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

const missing = (): FileRead => ({ ok: false, missing: true, reason: "ENOENT" });
const text = (value: string, truncated = false): FileRead => ({ ok: true, text: value, truncated });

function deps(files: Record<string, FileRead>): EnvironmentDeps {
  return {
    homeDir: HOME,
    readText: async (path) => files[path] ?? missing(),
    subdirectories: async () => [],
  };
}

/** The repo installer's exact command shape, as it appears in settings.json. */
function repoCommand(script: string, event: string): string {
  return `"/opt/homebrew/bin/node" "${script}" ${event}`;
}

/** A settings file whose every event runs one command. */
function settingsFor(script: string, events: string[] = EVENTS): string {
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    const group: Record<string, unknown> = { hooks: [{ type: "command", command: repoCommand(script, event) }] };
    if (event === "PreToolUse" || event === "PostToolUse") group.matcher = "*";
    hooks[event] = [group];
  }
  return JSON.stringify({ hooks }, null, 2);
}

/** The hook check's view for a machine whose files are exactly `files`. */
async function hookCheck(files: Record<string, FileRead>) {
  const views = await environmentCheckViews(deps(files));
  const view = views.find((v) => v.id === "mission-hook-script");
  assert.ok(view, "the check must always be reported");
  return view;
}

// --- recognising our own command --------------------------------------------------------

test("both installers' command shapes yield the script they run", () => {
  assert.equal(missionHookScriptPath(repoCommand(STALE, "Stop")), STALE);
  // The packaged app, with a real node on PATH. The path contains a space, which is the
  // entire reason the installers quote it and the reason the quoted branch is tried first.
  assert.equal(missionHookScriptPath(`"/opt/homebrew/bin/node" "${SATELLITE}" SessionStart`), SATELLITE);
  // And the packaged app with no system node, which runs the app itself in Node mode.
  assert.equal(
    missionHookScriptPath(`ELECTRON_RUN_AS_NODE=1 "/Applications/Mission Control.app/Contents/MacOS/Mission Control" "${SATELLITE}" Stop`),
    SATELLITE,
  );
  // A hand-edited command with no quoting at all is still readable.
  assert.equal(missionHookScriptPath(`node ${LIVE} Stop`), LIVE);
});

test("nothing that is not one of our absolute script paths is reported as one", () => {
  for (const command of [
    // Somebody else's hook. The overwhelmingly common case, and the one a false positive
    // would accuse.
    `"/usr/bin/env" jq -r '.tool_input' | /Users/tester/.claude/hooks/format.sh`,
    "npx --yes some-linter --quiet",
    // Our script's NAME inside a wrapped shell command, and relative: not a path anything
    // can stat, so it must not be handed to a reader as a file that is missing.
    `sh -c "node ./harness-hook.mjs Stop"`,
    // The name as a directory rather than the file, and as a prefix of a longer name.
    `"/opt/homebrew/bin/node" "/Users/tester/harness-hook.mjs/index.mjs" Stop`,
    `"/opt/homebrew/bin/node" "/Users/tester/harness-hook.mjs.bak" Stop`,
    // A directory called `satellites` that is not ours.
    `"/opt/homebrew/bin/node" "/Users/tester/satellites/other.mjs" Stop`,
  ]) {
    assert.equal(missionHookScriptPath(command), null, command);
  }
});

// Stripping is the generous half, and the two are allowed to disagree in exactly this
// direction: a command we cannot resolve to a path is still ours to remove.
test("removal recognises a command that reporting will not resolve", () => {
  const wrapped = `sh -c "node ./harness-hook.mjs Stop"`;
  assert.equal(isMissionHookCommand(wrapped), true);
  assert.equal(missionHookScriptPath(wrapped), null);
  // The packaged app's satellite, which the packaged installer's own marker used to miss -
  // so every press of "Install Claude integrations" appended a duplicate group and its
  // uninstall removed nothing.
  assert.equal(isMissionHookCommand(`"/opt/homebrew/bin/node" "${SATELLITE}" Stop`), true);
  assert.equal(isMissionHookCommand(repoCommand(LIVE, "Stop")), true);
  assert.equal(isMissionHookCommand("npx --yes some-linter --quiet"), false);
});

// One list, two predicates derived from it. This is the drift guard: both halves are driven
// from `MISSION_HOOK_SCRIPTS` rather than from literals, so a script added there without
// updating a second list cannot make stripping and reporting disagree again.
test("every declared script is recognised by BOTH predicates, in either spelling", () => {
  for (const name of MISSION_HOOK_SCRIPTS) {
    const posix = `/Users/tester/mission-control/${name}`;
    assert.equal(missionHookScriptPath(`"/opt/homebrew/bin/node" "${posix}" Stop`), posix, name);
    assert.equal(isMissionHookCommand(`"/opt/homebrew/bin/node" "${posix}" Stop`), true, name);

    // The spelling the two used to disagree on: the regex accepted a backslash separator
    // while the substring array carried only the forward-slash form, so a command like this
    // was reportable as ours and not strippable as ours - one bridge removed, one left
    // firing. Both must answer the same way.
    const windows = `C:\\Users\\tester\\mission-control\\${name.split("/").join("\\")}`;
    assert.equal(isMissionHookCommand(`"node.exe" "${windows}" Stop`), true, `strip ${name}`);
  }
});

// The Setup row is required and raises the setup banner, so its remedy has to be actionable
// for BOTH populations the check fires for. A packaged-app user may have no checkout at all.
test("the Setup row's remedy names the desktop button as well as the npm script", () => {
  const remedy = ENVIRONMENT_ROW_METADATA["mission-hook-script"].remedy;
  assert.equal(remedy.kind, "command");
  if (remedy.kind !== "command") return;
  assert.deepEqual([...remedy.argv], ["npm", "run", "install-hooks"]);
  assert.match(remedy.note, /Install Claude integrations/);
  assert.match(remedy.note, /durable clone/);
});

// --- the check ---------------------------------------------------------------------------

test("a machine that never installed the hooks hears nothing", async () => {
  const view = await hookCheck({});
  assert.equal(view.warning, null);
  assert.equal(view.detail, null);
});

test("hooks pointing at a script that is there hear nothing", async () => {
  const view = await hookCheck({
    [SETTINGS]: text(settingsFor(LIVE)),
    [LIVE]: text("#!/usr/bin/env node\n"),
  });
  assert.equal(view.warning, null);
  assert.equal(view.detail, null);
});

// The reported outage, reproduced: a checkout renamed out from under nine installed events.
test("a renamed checkout is named, counted, and given the command that repairs it", async () => {
  const view = await hookCheck({ [SETTINGS]: text(settingsFor(STALE)) });
  assert.ok(view.warning);
  // The path, so the operator can see which of their checkouts it is.
  assert.ok(view.warning.includes(STALE), view.warning);
  // How much of their machine is affected. Nine events, not "a hook".
  assert.match(view.warning, /9 hook events/);
  // The symptom they actually saw, so they can connect this note to the stack in their
  // transcript rather than reading it as an unrelated complaint.
  assert.match(view.warning, /MODULE_NOT_FOUND/);
  // And both repairs, because the operator may have installed from either.
  assert.match(view.warning, /npm run install-hooks/);
  assert.match(view.warning, /Install Claude integrations/);
  // The evidence names the file that holds the dead path.
  assert.ok(view.detail?.includes(SETTINGS), view.detail ?? "");
  assert.ok(view.detail?.includes(STALE), view.detail ?? "");
});

test("the packaged app's missing satellite is reported the same way", async () => {
  const settings = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `"/opt/homebrew/bin/node" "${SATELLITE}" Stop` }] }] },
  });
  const view = await hookCheck({ [SETTINGS]: text(settings) });
  assert.ok(view.warning?.includes(SATELLITE), view.warning ?? "");
  assert.match(view.warning ?? "", /1 hook event\b/);
});

// The failure this surface cannot afford. Every machine runs this check, and most of them
// have hooks belonging to somebody else; a note about one of those is chrome the reader
// cannot act on, and the second time they see it they stop reading notes in this dialog.
test("a broken hook that is not ours is not ours to report", async () => {
  const settings = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/Users/tester/.claude/hooks/deleted-by-someone-else.sh" }] }],
    },
  });
  const view = await hookCheck({ [SETTINGS]: text(settings) });
  assert.equal(view.warning, null);
});

// An install from an older build sits under whatever events THAT build registered. It still
// runs, and it still fails, so the walk is over the file's own keys rather than this build's
// event list - the oldest installs are the likeliest to be stale.
test("an entry under an event this build no longer installs is still counted", async () => {
  const view = await hookCheck({ [SETTINGS]: text(settingsFor(STALE, ["SomeRetiredEvent"])) });
  assert.match(view.warning ?? "", /1 hook event\b/);
});

// jsonc-parser hands back a best-effort value for malformed input. A file that does not parse
// is one Claude Code cannot apply either, so a path recovered from it names a bridge that is
// not running: warning would accuse the operator of a dead hook when their problem is broken
// JSON. Comments and trailing commas are NOT malformed and must still be read.
test("a settings file with real parse errors is refused, even when a dead path is recoverable", async () => {
  const dead = `"/opt/homebrew/bin/node" "${STALE}" Stop`;
  const broken = `{ "hooks": { "Stop": [ { "hooks": [ { "command": ${JSON.stringify(dead)} } ] } ] }, oops }`;
  const view = await hookCheck({ [SETTINGS]: text(broken) });
  assert.equal(view.warning, null, view.warning ?? "");

  // The tolerated shapes still work, so this did not become a strict JSON parser.
  const jsonc = `{
    // a comment the operator left
    "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": ${JSON.stringify(dead)} } ] } ] },
  }`;
  const ok = await hookCheck({ [SETTINGS]: text(jsonc) });
  assert.ok(ok.warning?.includes(STALE), ok.warning ?? "");
});

// The one case where parse errors are OURS rather than the operator's: the read stopped at its
// bound, so the tail is unterminated by construction. Refusing here would mean a settings file
// larger than the bound could never be checked at all.
test("a truncated read still reports, because its parse errors are the reader's own", async () => {
  const dead = `"/opt/homebrew/bin/node" "${STALE}" Stop`;
  const cut = `{ "hooks": { "Stop": [ { "hooks": [ { "command": ${JSON.stringify(dead)} } ] } ] }`;
  const view = await hookCheck({ [SETTINGS]: text(cut, true) });
  assert.ok(view.warning?.includes(STALE), view.warning ?? "");
});

// The sharper half of the truncation exemption: being cut short does not make an EARLIER
// syntax error forgivable. A large settings file can be both truncated by the reader and
// genuinely malformed, and Claude Code cannot apply it either way, so a hook path recovered
// from it still names a bridge that is not running.
test("an early syntax error is refused even when the read was also truncated", async () => {
  const dead = `"/opt/homebrew/bin/node" "${STALE}" Stop`;
  // A stray token near the start, a perfectly recoverable stale hook after it, and enough
  // padding that the read would genuinely have hit its bound.
  const padding = " ".repeat(70 * 1024);
  const body =
    `{ oops "hooks": { "Stop": [ { "hooks": [ { "command": ${JSON.stringify(dead)} } ] } ] },` +
    ` "pad": "${padding}"`;
  const view = await hookCheck({ [SETTINGS]: text(body, true) });
  assert.equal(view.warning, null, view.warning ?? "");
});

test("a settings file it cannot make sense of produces silence, not an accusation", async () => {
  for (const body of ["", "not json at all", "[]", JSON.stringify({ hooks: "yes" })]) {
    const view = await hookCheck({ [SETTINGS]: text(body) });
    assert.equal(view.warning, null, body);
  }
  // Present and unreadable is Claude Code's own loud failure, not a missing script.
  const unreadable = await hookCheck({ [SETTINGS]: { ok: false, missing: false, reason: "EACCES" } });
  assert.equal(unreadable.warning, null);
});

// Several checkouts' worth of entries accumulate in one settings file over time. Each dead
// path is read once and named once, however many events run it.
test("two dead paths are read once each and both reported", async () => {
  const reads: string[] = [];
  const settings = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: repoCommand(STALE, "Stop") }] }],
      SessionStart: [
        { hooks: [{ type: "command", command: repoCommand(STALE, "SessionStart") }] },
        { hooks: [{ type: "command", command: `"/opt/homebrew/bin/node" "${SATELLITE}" SessionStart` }] },
      ],
    },
  });
  const files: Record<string, FileRead> = { [SETTINGS]: text(settings) };
  const views = await environmentCheckViews({
    homeDir: HOME,
    readText: async (path) => {
      reads.push(path);
      return files[path] ?? missing();
    },
    subdirectories: async () => [],
  });
  const warning = views.find((v) => v.id === "mission-hook-script")?.warning ?? "";
  assert.ok(warning.includes(STALE), warning);
  assert.ok(warning.includes(SATELLITE), warning);
  assert.equal(reads.filter((p) => p === STALE).length, 1, "the same dead path is probed once");
  assert.equal(reads.filter((p) => p === SATELLITE).length, 1);
});
