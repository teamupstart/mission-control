import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  ENVIRONMENT_CHECK_IDS,
  ENVIRONMENT_CHECK_INFO,
} from "../src/shared/environment-checks.ts";
import { ENVIRONMENT_CHECKS, environmentCheckViews } from "../src/server/environment/index.ts";
import { upstartclawCoreReady } from "../src/server/environment/upstartclaw.ts";
import type { EnvironmentDeps, FileRead } from "../src/server/environment/types.ts";

// What is at stake: this surface warns an operator about somebody ELSE'S installation, at
// the moment they are about to dispatch. Two failures matter and they pull in opposite
// directions.
//
// Warning when there is nothing wrong is the worse one. Every machine that has never heard
// of UpstartClaw runs these checks too, and a note about a plugin that is not installed is
// chrome the reader cannot act on - the second time they see it they stop reading notes in
// this dialog at all, including the one that blocks their dispatch. So silence is asserted
// as hard as the warnings are.
//
// Missing the real thing is the failure the feature exists to prevent: an unattended agent
// stalling on a `PreToolUse` gate, with nothing in Mission Control explaining why.
//
// Every case runs the REAL check against an arranged home through injected deps. Nothing
// here may read the developer's own `~/.claude`, which is exactly what `EnvironmentDeps`
// exists for - and why the route (whose defaults resolve `homedir()`) is covered by the
// e2e spec against an isolated home instead of here.

const HOME = "/home/tester";
const STATE = join(HOME, ".claude", "upstartclaw-core-setup");
const PLUGINS = join(HOME, ".claude", "plugins");
const RECORD = join(PLUGINS, "installed_plugins.json");

const missing = (): FileRead => ({ ok: false, missing: true, reason: "ENOENT" });

/**
 * A machine, described by the files and directories it has.
 *
 * `dirs` maps a directory to the directories inside it, so the plugin probe walks a real
 * shape rather than a boolean - that walk is bounded, and a stub that just answered "yes"
 * would never exercise the bound.
 */
function deps(arrange: {
  files?: Record<string, FileRead>;
  dirs?: Record<string, string[]>;
  onList?: (path: string) => void;
}): EnvironmentDeps {
  return {
    homeDir: HOME,
    readText: async (path) => arrange.files?.[path] ?? missing(),
    subdirectories: async (path) => {
      arrange.onList?.(path);
      return arrange.dirs?.[path] ?? [];
    },
  };
}

const text = (value: string, truncated = false): FileRead => ({
  ok: true,
  text: value,
  truncated,
});

/** The one check's view, for a machine arranged as `arrange`. */
async function claw(arrange: Parameters<typeof deps>[0]) {
  const views = await environmentCheckViews(deps(arrange));
  const view = views.find((v) => v.id === "upstartclaw-core-setup");
  assert.ok(view, "the check must always be reported");
  return view;
}

/** The verified layout: `~/.claude/plugins/cache/<marketplace>/upstartclaw-core/<version>/`. */
const INSTALLED_LAYOUT: Record<string, string[]> = {
  [PLUGINS]: ["cache", "marketplaces", "data"],
  [join(PLUGINS, "cache")]: ["upstartclaw"],
  [join(PLUGINS, "cache", "upstartclaw")]: ["upstartclaw-core", "dev-tools"],
};

test("every declared check is implemented, and nothing is implemented that isn't declared", () => {
  for (const id of ENVIRONMENT_CHECK_IDS) {
    assert.ok(ENVIRONMENT_CHECKS[id], `${id} is declared but has no implementation`);
    assert.equal(ENVIRONMENT_CHECKS[id].id, id, `${id}'s implementation names itself wrong`);
    assert.equal(ENVIRONMENT_CHECKS[id].label, ENVIRONMENT_CHECK_INFO[id].label);
  }
  assert.deepEqual(Object.keys(ENVIRONMENT_CHECKS).sort(), [...ENVIRONMENT_CHECK_IDS].sort());
});

// A note whose subject cannot be named is a note the reader cannot attribute to any of
// their tools.
test("every check says what it is about", () => {
  for (const id of ENVIRONMENT_CHECK_IDS) {
    assert.ok(ENVIRONMENT_CHECK_INFO[id].label.trim().length > 0, `${id} has no label`);
  }
});

test("a machine with no UpstartClaw at all says nothing", async () => {
  const view = await claw({});
  assert.equal(view.warning, null);
  assert.equal(view.detail, null);
});

test("an unattended UpstartClaw query requires both the installed plugin and completed setup", async () => {
  assert.equal(await upstartclawCoreReady(deps({})), false);
  assert.equal(
    await upstartclawCoreReady(
      deps({ files: { [STATE]: text("completed\n") }, dirs: INSTALLED_LAYOUT }),
    ),
    true,
  );
  assert.equal(
    await upstartclawCoreReady(
      deps({ files: { [STATE]: text("in_progress") }, dirs: INSTALLED_LAYOUT }),
    ),
    false,
    "a state that passes the interactive setup gate is not reliable enough for a background sweep",
  );
});

// The uninstall case, and the reason installation is checked BEFORE the state file rather
// than only when the file is missing. Nothing deletes `~/.claude/upstartclaw-core-setup` when
// the plugin goes away, so a machine that tried UpstartClaw and dropped it keeps a stale
// `no_setup` forever. Reading that as a finding warns about a gate that is no longer installed
// and cannot stall anything - on a machine this surface promises to stay silent about.
//
// Every non-completed state is asserted, not just one, because each has its own branch and a
// precondition applied to only some of them is the bug this test is named after.
test("a leftover state file on a machine without the plugin says nothing", async () => {
  for (const state of [
    text("no_setup\n"),
    text("in_progress"),
    text("banana"),
    text(""),
    { ok: false, missing: false, reason: "EACCES: permission denied" } as FileRead,
  ]) {
    const view = await claw({ files: { [STATE]: state } });
    assert.equal(
      view.warning,
      null,
      `an uninstalled plugin must not warn about ${JSON.stringify(state)}`,
    );
    assert.equal(view.detail, null);
  }
});

test("a finished setup says nothing", async () => {
  // Arranged WITH the plugin installed, so this is the "everything is fine" case rather
  // than the "nothing is here" case above - the two must not be provable by the same stub.
  const view = await claw({ files: { [STATE]: text("completed\n") }, dirs: INSTALLED_LAYOUT });
  assert.equal(view.warning, null);
  assert.equal(view.detail, null);
});

test("no_setup gives the setup action and a brief reason without file details", async () => {
  const view = await claw({ files: { [STATE]: text("no_setup\n") }, dirs: INSTALLED_LAYOUT });
  assert.equal(
    view.warning,
    "Run /upstartclaw-core:setup in an interactive Claude Code session before dispatching. UpstartClaw requires an interactive sign-in before agents can use its tools.",
  );
  assert.equal(view.detail, null);
});

// `check-setup.sh` exits 0 for `in_progress` - so the honest warning for this state is NOT
// the stall. Setup was abandoned half-done: the servers are wired and unauthenticated, and
// the agent fails on a credential. A note claiming a stall here would send the operator
// hunting for a hang that never happens.
test("in_progress tells the operator to finish setup and briefly explains why", async () => {
  const view = await claw({ files: { [STATE]: text("in_progress") }, dirs: INSTALLED_LAYOUT });
  assert.equal(
    view.warning,
    "Finish /upstartclaw-core:setup in an interactive Claude Code session before dispatching. UpstartClaw requires its interactive sign-ins to finish before agents can reliably use its tools.",
  );
  assert.equal(view.detail, null);
});

// The gate's `*` branch: anything it does not recognise exits 2, so an unexpected value is
// the blocked case and not a state of its own. An empty file is the same story and is worth
// pinning separately, because "" is the value a half-written file leaves behind. Whitespace
// only is a third: the gate sees the spaces (substitution strips newlines and nothing else),
// so the value is not empty and the detail must not claim it is.
test("an unrecognised or empty state file is reported as the blocked case", async () => {
  for (const [value, detail] of [
    ["banana", `${STATE} reads "banana"`],
    ["", `${STATE} reads an empty file`],
    ["   \n", `${STATE} reads "   "`],
  ] as const) {
    const view = await claw({ files: { [STATE]: text(value) }, dirs: INSTALLED_LAYOUT });
    assert.match(
      view.warning ?? "",
      /^Run \/upstartclaw-core:setup/,
      `${JSON.stringify(value)} should warn`,
    );
    assert.equal(view.detail, detail);
  }
});

// The comparison has to be the GATE'S, not a lenient one. `STATE=$(cat file)` strips trailing
// newlines and nothing else, and `case "$STATE" in completed | in_progress)` forgives no
// whitespace - so every value below is one the gate REFUSES with exit 2 while a `trim()` here
// would have called the machine ready. That is the silent direction of wrong: the form says
// everything is fine and the agent stalls on its first tool call.
//
// Each row was checked against a real shell before being written down.
test("values the gate refuses are not excused by surrounding whitespace", async () => {
  for (const value of [
    " completed\n",
    "completed \n",
    "completed\t\n",
    "completed\r\n", // a CRLF file: substitution leaves the carriage return behind
    "\ncompleted\n",
    " in_progress\n",
    "in_progress \n",
  ]) {
    const view = await claw({ files: { [STATE]: text(value) }, dirs: INSTALLED_LAYOUT });
    assert.notEqual(view.warning, null, `${JSON.stringify(value)} must not read as set up`);
    // Named as the malformed file it is, rather than as an unfinished setup: the operator's
    // setup DID run, and the fix is a character to delete.
    assert.match(view.warning ?? "", /whitespace/, `${JSON.stringify(value)} should say why`);
    assert.match(view.warning ?? "", /stalls/);
    // The detail escapes what is invisible, so a stray \r is legible rather than baffling.
    assert.equal(view.detail, `${STATE} reads ${JSON.stringify(value.replace(/\n+$/, ""))}`);
  }
});

// The other half of the same claim: what the gate DOES accept stays silent. Trailing newlines
// are the one thing command substitution removes, so a file written by `echo` is fine however
// many of them it ends with.
test("values the gate accepts stay silent, trailing newlines and all", async () => {
  for (const value of ["completed", "completed\n", "completed\n\n\n"]) {
    const view = await claw({ files: { [STATE]: text(value) }, dirs: INSTALLED_LAYOUT });
    assert.equal(view.warning, null, `${JSON.stringify(value)} is set up as far as the gate is`);
    assert.equal(view.detail, null);
  }
});

// `in_progress` with trailing newlines is the same story on the other accepted value: the gate
// lets it through, so the note has to tell the operator to finish the setup.
test("in_progress survives its trailing newlines as the unfinished-setup note", async () => {
  for (const value of ["in_progress", "in_progress\n", "in_progress\n\n"]) {
    const view = await claw({ files: { [STATE]: text(value) }, dirs: INSTALLED_LAYOUT });
    assert.match(view.warning ?? "", /^Finish \/upstartclaw-core:setup/, JSON.stringify(value));
  }
});

// Reading a file the daemon does not own is not permission to render it. Whatever is in the
// state file would otherwise travel through the route and into the dispatch dialog, so a value
// that is not plausibly a state word is classified by size and never quoted. Both halves are
// asserted: the sentinel is absent from EVERY string the view carries, and the note still
// appears, because silently dropping the finding would "pass" this test while hiding a stall.
test("a state file holding something else is classified, never quoted", async () => {
  const secret = "sk-ant-api03-DO-NOT-RENDER-ME";
  const cases: [string, RegExp][] = [
    // Token-shaped: short enough to quote, but its alphabet is not the gate's.
    [secret, /29 characters/],
    // A log someone redirected over the file.
    [`2026-08-06 12:33:01 INFO ${secret} retrying\n`, /characters/],
    // Long, and all letters - the length bound is what catches this one.
    ["completedcompletedcompletedcompleted", /36 characters/],
  ];
  for (const [value, size] of cases) {
    const view = await claw({ files: { [STATE]: text(value) }, dirs: INSTALLED_LAYOUT });
    assert.match(
      view.warning ?? "",
      /^Run \/upstartclaw-core:setup/,
      `${JSON.stringify(value)} still has to warn`,
    );
    assert.match(view.detail ?? "", size);
    assert.match(view.detail ?? "", /not shown here/);
    // The path is still named, so the operator can open the file they already own.
    assert.match(view.detail ?? "", new RegExp(STATE.replace(/[/\\]/g, "\\$&")));
    for (const field of [view.warning, view.detail]) {
      assert.doesNotMatch(field ?? "", /DO-NOT-RENDER-ME/, "file contents must not reach the UI");
    }
  }
});

// A size derived from a bounded read is a floor, not a fact, and saying it plainly is cheaper
// than a reader discovering later that the number was a guess.
test("a truncated read reports its size as a floor", async () => {
  const view = await claw({
    files: { [STATE]: text("9".repeat(200), true) },
    dirs: INSTALLED_LAYOUT,
  });
  assert.match(view.detail ?? "", /at least 200 characters/);
});

// The near-miss sentence quotes the module's OWN constant rather than the operator's bytes, so
// even a value made entirely of padding cannot push anything into the warning text.
test("the near-miss sentence quotes the bare word, not the file", async () => {
  const view = await claw({
    files: { [STATE]: text(`${" ".repeat(80)}completed\n`) },
    dirs: INSTALLED_LAYOUT,
  });
  assert.match(view.warning ?? "", /holds "completed" wrapped in whitespace/);
  // 89 characters of value: past the quoting bound, so the detail classifies it instead.
  assert.match(view.detail ?? "", /89 characters/);
  assert.match(view.detail ?? "", /not shown here/);
});

test("a state file that exists but cannot be read is its own warning", async () => {
  const view = await claw({
    files: { [STATE]: { ok: false, missing: false, reason: "EACCES: permission denied" } },
    dirs: INSTALLED_LAYOUT,
  });
  assert.match(view.warning ?? "", /cannot be read/);
  assert.match(view.warning ?? "", /\/upstartclaw-core:setup/);
  assert.equal(view.detail, `${STATE}: EACCES: permission denied`);
});

// The stall case the feature was built for: a freshly installed plugin nobody has set up.
// The gate reads a MISSING file as `no_setup`, so this is the same warning as that value -
// which is why it is asserted to be the same sentence rather than a similar one.
test("an installed plugin with no state file warns, by the plugin's directory", async () => {
  const view = await claw({ dirs: INSTALLED_LAYOUT });
  const named = await claw({ files: { [STATE]: text("no_setup") }, dirs: INSTALLED_LAYOUT });
  assert.equal(view.warning, named.warning);
  assert.equal(view.detail, null);
});

// The second, independent signal. Claude Code's install record is authoritative and cheap;
// a layout change that moves the cache directory must not silence the check.
test("an installed plugin is also recognised from Claude Code's install record", async () => {
  const record = JSON.stringify({
    version: 2,
    plugins: { "upstartclaw-core@upstartclaw": [{ version: "1.1.7" }] },
  });
  const view = await claw({ files: { [RECORD]: text(record) } });
  assert.match(view.warning ?? "", /^Run \/upstartclaw-core:setup/);
});

// The record is read under a byte bound and grows with the number of installed plugins, so a
// machine with dozens of them can carry this entry past the window. A miss there must not be
// read as "not installed" - which is the whole reason the two signals are OR'd.
test("a record that does not name the plugin does not overrule the directory", async () => {
  const truncated = JSON.stringify({
    version: 2,
    plugins: { "dev-tools@upstartclaw": [{ version: "1.9.0" }] },
  });
  const view = await claw({ files: { [RECORD]: text(truncated) }, dirs: INSTALLED_LAYOUT });
  assert.match(view.warning ?? "", /^Run \/upstartclaw-core:setup/);
});

// The marketplace's name is a PREFIX of the plugin's, and a machine that merely added the
// marketplace has installed nothing. Matching loosely here would warn every Upstart
// engineer who browsed the catalogue and installed something else.
test("the marketplace alone is not the plugin", async () => {
  const record = JSON.stringify({
    version: 2,
    plugins: { "dev-tools@upstartclaw": [{ version: "1.9.0" }] },
  });
  const view = await claw({
    files: { [RECORD]: text(record) },
    dirs: {
      [PLUGINS]: ["cache", "marketplaces"],
      [join(PLUGINS, "cache")]: ["upstartclaw"],
      [join(PLUGINS, "cache", "upstartclaw")]: ["dev-tools", "memory-search"],
    },
  });
  assert.equal(view.warning, null);
});

// The marketplace checkout is a monorepo of every plugin in the catalogue, including this
// one, several levels down. Finding it there would report "installed" for anyone who added
// the marketplace - so the probe is depth-bounded, and this is that bound.
test("the plugin probe does not reach past the install layout, and is bounded", async () => {
  const listed: string[] = [];
  const view = await claw({
    onList: (path) => listed.push(path),
    dirs: {
      [PLUGINS]: ["marketplaces"],
      [join(PLUGINS, "marketplaces")]: ["upstartclaw"],
      [join(PLUGINS, "marketplaces", "upstartclaw")]: ["extensions"],
      [join(PLUGINS, "marketplaces", "upstartclaw", "extensions")]: ["plugins"],
      // Depth 5. Reachable only by an unbounded walk.
      [join(PLUGINS, "marketplaces", "upstartclaw", "extensions", "plugins")]: [
        "upstartclaw-core",
      ],
    },
  });
  assert.equal(view.warning, null, "a catalogue checkout is not an installation");
  assert.ok(
    listed.every((path) => path.split("/").length <= PLUGINS.split("/").length + 2),
    `the probe walked deeper than the install layout: ${listed.join(", ")}`,
  );
});

// A check that throws must not fail the route or take the list down - and must not fall
// silent either, since silence is the claim "your machine is fine".
test("a check that throws becomes its own warning, and blames itself", async () => {
  const exploding: EnvironmentDeps = {
    homeDir: HOME,
    readText: () => {
      throw new Error("the disk went away");
    },
    subdirectories: async () => [],
  };
  const views = await environmentCheckViews(exploding);
  assert.equal(views.length, ENVIRONMENT_CHECK_IDS.length);
  assert.match(views[0]?.warning ?? "", /could not run: the disk went away/);
  assert.match(views[0]?.warning ?? "", /Mission Control fault/);
  assert.match(views[0]?.warning ?? "", /does not affect dispatch/);
});

// The wire shape the dispatch form folds over, and what Phase 3 and anything after it may
// rely on: one entry per declared id, every one carrying `warning`.
test("the view reports every check, in declaration order, with a null-or-sentence warning", async () => {
  const views = await environmentCheckViews(deps({}));
  assert.deepEqual(views.map((v) => v.id), [...ENVIRONMENT_CHECK_IDS]);
  for (const view of views) {
    assert.equal(view.label, ENVIRONMENT_CHECK_INFO[view.id].label);
    assert.ok(view.warning === null || view.warning.trim().length > 0);
    // Detail without a warning would be a fact with nothing to explain.
    if (view.warning === null) assert.equal(view.detail, null);
  }
});
