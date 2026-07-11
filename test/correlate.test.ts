import { test } from "node:test";
import assert from "node:assert/strict";
import { correlate, type DiscoveryInput } from "../src/server/discovery/correlate.ts";
import type { Proc } from "../src/server/discovery/processes.ts";
import type { TmuxPane } from "../src/server/discovery/tmux.ts";
import type { WeztermPane } from "../src/server/discovery/wezterm.ts";

function proc(p: Partial<Proc> & Pick<Proc, "pid" | "tty">): Proc {
  return {
    ppid: 1,
    startRaw: "",
    startMs: 1000,
    command: "claude",
    agent: "claude",
    ...p,
  };
}
function tmuxPane(p: Partial<TmuxPane> & Pick<TmuxPane, "session" | "tty" | "paneId">): TmuxPane {
  return {
    windowIndex: 0,
    windowName: "w",
    panePid: 10,
    currentCommand: "claude",
    currentPath: "/repo",
    ...p,
  };
}
function wezPane(p: Partial<WeztermPane> & Pick<WeztermPane, "tty" | "tabTitle">): WeztermPane {
  return {
    paneId: 5,
    tabId: 2,
    windowId: 0,
    windowTitle: "win",
    cwd: "",
    isActive: false,
    ...p,
  };
}

test("names a tmux session by its session name", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 100, ppid: 50, tty: "ttys1" })],
    tmux: [tmuxPane({ session: "work", tty: "ttys1", paneId: "%1" })],
    wezterm: [],
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "work");
  assert.equal(s?.nameSource, "tmux");
  assert.equal(s?.tmux?.paneId, "%1");
});

test("names a wezterm pane by its tab title", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 200, ppid: 50, tty: "ttys2" })],
    tmux: [],
    wezterm: [wezPane({ tty: "ttys2", tabTitle: "Editor" })],
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "Editor");
  assert.equal(s?.nameSource, "wezterm");
});

test("tmux wins over wezterm when a tty is in both", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 300, ppid: 50, tty: "ttysX" })],
    tmux: [tmuxPane({ session: "inner", tty: "ttysX", paneId: "%9" })],
    wezterm: [wezPane({ tty: "ttysX", tabTitle: "Outer" })],
  };
  const [s] = correlate(input);
  assert.equal(s?.nameSource, "tmux");
  assert.equal(s?.name, "inner");
});

test("falls back to cwd basename when wezterm tab is unnamed", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 400, ppid: 50, tty: "ttys4" })],
    tmux: [],
    wezterm: [wezPane({ tty: "ttys4", tabTitle: "", cwd: "file:///Users/me/workspace/sim" })],
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "sim");
});

test("excludes agent processes with no controlling tty (headless subagents)", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 500, tty: null, command: "claude --resume x" })],
    tmux: [],
    wezterm: [],
  };
  assert.equal(correlate(input).length, 0);
});

test("picks the root agent process on a tty (launcher, not re-exec child)", () => {
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 600, ppid: 50, tty: "ttys6", command: "claude" }),
      proc({ pid: 601, ppid: 600, tty: "ttys6", command: "/x/claude/versions/2.1.0" }),
    ],
    tmux: [tmuxPane({ session: "s", tty: "ttys6", paneId: "%1" })],
    wezterm: [],
  };
  const results = correlate(input);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.pid, 600); // the launcher, whose parent is the shell
});

test("two sessions in one tmux session stay distinct (different panes/ttys)", () => {
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 700, ppid: 50, tty: "ttysA" }),
      proc({ pid: 701, ppid: 51, tty: "ttysB" }),
    ],
    tmux: [
      tmuxPane({ session: "dev", tty: "ttysA", paneId: "%1" }),
      tmuxPane({ session: "dev", tty: "ttysB", paneId: "%2" }),
    ],
    wezterm: [],
  };
  const results = correlate(input);
  assert.equal(results.length, 2);
  assert.notEqual(results[0]?.syntheticId, results[1]?.syntheticId);
});
