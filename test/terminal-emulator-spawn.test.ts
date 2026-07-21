import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: that "a tab opened" and "we can address it" stay two answers.
//
// `SpawnResult` splits them because the focus fallback reads a missing pane id as "no tab
// exists" and opens another one. Three outcomes have to stay distinguishable, and the
// recovery differs for each: the spawn was REFUSED (nothing opened - try again), the spawn
// SUCCEEDED but reported an id we cannot parse (a tab is in front of the human and nothing
// may be typed into it - never open a second), and the spawn succeeded with an addressable
// pane. An emulator with no scripting CLI, which is where this migration is going, lives
// permanently in the middle case.
//
// Driven through a fake `wezterm` on WEZTERM_BIN rather than a stubbed exec, deliberately.
// A real child process exercises the actual argv, the actual exit code, and the
// `WEZTERM_BIN.dropEnv` socket strip - and that last one only ever shows up in a spawned
// environment, so a fake exec could not assert it at all.

const home = mkdtempSync(join(tmpdir(), "mission-emu-spawn-"));
const FAKE = join(home, "fake-wezterm");
const LOG = join(home, "calls.jsonl");

after(() => rmSync(home, { recursive: true, force: true }));

// Answers `cli list` the way wezterm does - snake_case, and a tab id that is NOT the pane
// id, so a target that confused the two would be visible.
writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  argv,
  // The inherited socket pins the CLI to a dead GUI's mux. Recorded so the strip is proven
  // in the only place it can be: the child's own environment.
  sawSocket: process.env.WEZTERM_UNIX_SOCKET !== undefined,
}) + "\\n");
const sub = argv[2];
if (sub === "spawn") {
  if (process.env.FAKE_SPAWN === "refused") { process.stderr.write("no wezterm mux is running"); process.exit(1); }
  process.stdout.write(process.env.FAKE_SPAWN === "unreadable" ? "Created window id 4" : "7");
  process.exit(0);
}
if (sub === "list") {
  process.stdout.write(JSON.stringify([
    { window_id: 1, tab_id: 3, pane_id: 7, tab_title: "api", cwd: "file://host/w/api", tty_name: "/dev/ttys012", is_active: true },
  ]));
  process.exit(0);
}
process.exit(0);
`,
  { mode: 0o755 },
);

process.env.HARNESS_HOME = join(home, "state");
process.env.FAKE_LOG = LOG;
const { weztermEmulator } = await import("../src/server/terminal/wezterm.ts");

interface Call {
  argv: string[];
  sawSocket: boolean;
}

/** Run one spawn against the fake, returning the result and every call it made. */
async function spawnTab(mode: "ok" | "unreadable" | "refused") {
  writeFileSync(LOG, "");
  const prev = { bin: process.env.WEZTERM_BIN, spawn: process.env.FAKE_SPAWN, sock: process.env.WEZTERM_UNIX_SOCKET };
  process.env.WEZTERM_BIN = FAKE;
  process.env.FAKE_SPAWN = mode;
  // Set on the parent so the strip has something to strip - this is the stale-GUI case.
  process.env.WEZTERM_UNIX_SOCKET = "/tmp/gui-sock-dead";
  try {
    const result = await weztermEmulator().spawn!.tab({
      argv: ["tmux", "attach", "-t", "api"],
      title: "api",
      cwd: null,
    });
    const calls: Call[] = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { result, calls };
  } finally {
    if (prev.bin === undefined) delete process.env.WEZTERM_BIN;
    else process.env.WEZTERM_BIN = prev.bin;
    if (prev.spawn === undefined) delete process.env.FAKE_SPAWN;
    else process.env.FAKE_SPAWN = prev.spawn;
    if (prev.sock === undefined) delete process.env.WEZTERM_UNIX_SOCKET;
    else process.env.WEZTERM_UNIX_SOCKET = prev.sock;
  }
}

test("a spawn that opened an addressable tab reports the pane AND its tab", async () => {
  const { result, calls } = await spawnTab("ok");

  assert.equal(result.ok, true);
  assert.equal(result.outcomeUnknown, false);
  // `focus` raises TABS, so a target carrying only the pane could not be brought forward by
  // the caller that just created it. The tab id is resolved, not assumed equal to the pane.
  assert.deepEqual(result.target, { paneId: "7", tabId: "3" });

  assert.deepEqual(calls[0]!.argv, ["cli", "--no-auto-start", "spawn", "--", "tmux", "attach", "-t", "api"]);
  // Every call goes down the live default socket, which is what makes the id it returns
  // addressable by the writes that follow.
  assert.ok(
    calls.every((c) => !c.sawSocket),
    "an inherited WEZTERM_UNIX_SOCKET must not reach any wezterm call",
  );
});

test("a tab that opened but cannot name itself is a success with no target", async () => {
  // The case that makes this a split rather than a nullable id: the human has a window in
  // front of them. Reporting ok:false here is how the focus fallback opens a second one.
  const { result } = await spawnTab("unreadable");

  assert.equal(result.ok, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.target, null);
});

test("a refused spawn is a failure, and says why", async () => {
  const { result, calls } = await spawnTab("refused");

  assert.equal(result.ok, false);
  assert.equal(result.error, "no wezterm mux is running");
  assert.equal(result.target, null);
  // Nothing opened, so nothing is enumerated looking for it.
  assert.equal(calls.length, 1);
});
