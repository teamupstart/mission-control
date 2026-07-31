import { test } from "node:test";
import assert from "node:assert/strict";
import { correlate, type DiscoveryInput } from "../src/server/discovery/correlate.ts";
import { daemonOwnedPids, type Proc } from "../src/server/discovery/processes.ts";
import type { TerminalEnumeration } from "../src/server/terminal/enumerate.ts";
import type { EmulatorPane, MultiplexerId, MuxPane } from "../src/server/terminal/types.ts";
import { emulatorHandle, muxHandle } from "../src/shared/pane.ts";

// What is at stake: that discovery names sessions by asking the terminal REGISTRIES what
// they can see, in the order they declare, rather than by an `if (tmux) … else if (wezterm)
// … else …` chain whose arm order silently was the precedence.
//
// The precedence itself has to be preserved exactly - a multiplexer outranks an emulator,
// because a tmux pane lives inside a wezterm pane - so the cases above the composition-rule
// test assert unchanged behaviour through the new shape. The ones below it assert the
// generalization: that the priority is the registries' declared order rather than an arm
// order here, that a backend this file has never heard of names sessions correctly, and that
// the two axes are independent rather than one gating the other.

function proc(p: Partial<Proc> & Pick<Proc, "pid" | "tty">): Proc {
  return {
    ppid: 1,
    startRaw: "",
    startMs: 1000,
    command: "claude",
    agent: "claude",
    agentNative: true,
    ...p,
  };
}
function muxPane(p: Partial<MuxPane> & Pick<MuxPane, "session" | "tty" | "paneId">): MuxPane {
  return {
    windowIndex: 0,
    windowName: "w",
    panePid: 10,
    cwd: "/repo",
    // Defaulted to the address, which is what tmux reports and what every case below but
    // one assumes. A backend whose title differs from its target spec passes both.
    sessionName: p.session,
    ...p,
  };
}
function emuPane(p: Partial<EmulatorPane> & Pick<EmulatorPane, "tty" | "tabTitle">): EmulatorPane {
  return {
    paneId: "5",
    tabId: "2",
    windowId: "0",
    windowTitle: "win",
    cwd: null,
    isActive: false,
    ...p,
  };
}

/** The registries' output for one tick. Order is naming priority - see `enumerateTerminals`. */
function terminals(mux: MuxPane[], emu: EmulatorPane[]): TerminalEnumeration[] {
  return [
    { kind: "multiplexer", backend: "tmux", panes: mux },
    { kind: "emulator", backend: "wezterm", panes: emu, hostProcess: null },
  ];
}

test("names a tmux session by its session name", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 100, ppid: 50, tty: "ttys1" })],
    terminals: terminals([muxPane({ session: "work", tty: "ttys1", paneId: "%1" })], []),
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "work");
  assert.equal(s?.nameSource, "tmux");
  assert.equal(muxHandle(s!)?.paneId, "%1");
});

test("names a wezterm pane by its tab title", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 200, ppid: 50, tty: "ttys2" })],
    terminals: terminals([], [emuPane({ tty: "ttys2", tabTitle: "Editor" })]),
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "Editor");
  assert.equal(s?.nameSource, "wezterm");
});

test("tmux wins over wezterm when a tty is in both", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 300, ppid: 50, tty: "ttysX" })],
    terminals: terminals(
      [muxPane({ session: "inner", tty: "ttysX", paneId: "%9" })],
      [emuPane({ tty: "ttysX", tabTitle: "Outer" })],
    ),
  };
  const [s] = correlate(input);
  assert.equal(s?.nameSource, "tmux");
  assert.equal(s?.name, "inner");
});

test("falls back to cwd basename when wezterm tab is unnamed", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 400, ppid: 50, tty: "ttys4" })],
    terminals: terminals([], [emuPane({ tty: "ttys4", tabTitle: "", cwd: "/Users/me/workspace/sim" })]),
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "sim");
});

test("excludes agent processes with no controlling tty (headless subagents)", () => {
  const input: DiscoveryInput = {
    procs: [proc({ pid: 500, tty: null, command: "claude --resume x" })],
    terminals: terminals([], []),
  };
  assert.equal(correlate(input).length, 0);
});

// ---- what is OURS is not a session ----
//
// The other half of "no controlling tty" above. A headless run we spawn is invisible to
// discovery because it has no tty, which held until the embedded runtime arrived: the vendor
// SDK owns that spawn, so its CLI child inherits whatever terminal the daemon itself was
// started from and shows up as an ordinary agent on an ordinary tty. `daemonOwnedPids` is
// what keeps it off the dashboard, and these pin both directions of that rule.

test("excludes the CLI subprocess of an embedded session we spawned ourselves", () => {
  // Verbatim from `ps` on the machine this was found on: two Agent SDK sessions whose CLI
  // children both inherited ttys000 from a daemon started with `npm run dev` in wezterm pane
  // 0. Each already has its own `sdk:` card. As agent processes on a tty they collapsed into
  // ONE phantom terminal card (`chooseAgentRoot` keeps the earliest), named after the tab the
  // DAEMON was started in and carrying the first session's cwd, branch, PR and task - so two
  // cards claimed one PR, and killing the stray one would have signalled a live session.
  const sdkArgv =
    "/Users/me/.local/bin/claude --output-format stream-json --verbose --input-format" +
    " stream-json --model claude-opus-5 --permission-prompt-tool stdio --resume=f07285ee";
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 66148, ppid: process.pid, tty: "ttys000", command: sdkArgv, startMs: 1000 }),
      proc({ pid: 66223, ppid: process.pid, tty: "ttys000", command: sdkArgv, startMs: 1001 }),
    ],
    terminals: terminals([], [emuPane({ tty: "ttys000", tabTitle: "Investigate Conductor" })]),
  };
  assert.deepEqual(correlate(input), []);
});

test("excludes an agent we spawned through a shim, not just a direct child", () => {
  // Descent, not parentage: the rule has to survive anything we put between us and the agent.
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 7000, ppid: process.pid, tty: "ttys7", command: "node scripts/shim.mjs", agent: null, agentNative: false }),
      proc({ pid: 7001, ppid: 7000, tty: "ttys7", command: "claude" }),
    ],
    terminals: terminals([], [emuPane({ tty: "ttys7", tabTitle: "make restart" })]),
  };
  assert.deepEqual(correlate(input), []);
});

test("an agent the daemon dispatched into a terminal is still a session", () => {
  // The safety half, and the reason the rule is descent rather than "we caused it": every
  // backend hands the launch to a mux server or a GUI (`tmux new-session -d`, `wezterm cli
  // spawn`), so a dispatched agent is reparented away from us before it ever runs. Excluding
  // by causation would empty the dashboard of every dispatched session.
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 6263, ppid: 1, tty: null, agent: null, agentNative: false, command: "tmux new-session -d -s Fix the Thing -c /w -- claude" }),
      proc({ pid: 6301, ppid: 6263, tty: "ttys4", command: "claude" }),
    ],
    terminals: terminals([muxPane({ session: "Fix the Thing", tty: "ttys4", paneId: "%2" })], []),
  };
  const [s] = correlate(input);
  assert.equal(s?.pid, 6301);
  assert.equal(s?.name, "Fix the Thing");
});

test("daemon ownership is the whole subtree, and only it", () => {
  const kid = (pid: number, ppid: number): Proc =>
    proc({ pid, ppid, tty: null, agent: null, agentNative: false, command: "node x" });
  const owned = daemonOwnedPids([kid(10, process.pid), kid(11, 10), kid(12, 1)], process.pid);
  assert.deepEqual([...owned].sort((a, b) => a - b), [10, 11]);
  assert.ok(!owned.has(process.pid), "the daemon is not its own descendant");
});

test("picks the root agent process on a tty (launcher, not re-exec child)", () => {
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 600, ppid: 50, tty: "ttys6", command: "claude" }),
      proc({ pid: 601, ppid: 600, tty: "ttys6", command: "/x/claude/versions/2.1.0" }),
    ],
    terminals: terminals([muxPane({ session: "s", tty: "ttys6", paneId: "%1" })], []),
  };
  const results = correlate(input);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.pid, 600); // the launcher, whose parent is the shell
});

test("prefers the native agent over a make/node launcher and takes its real cwd", () => {
  // `make claude` (launcher, cwd = main repo) -> `node new-session.mjs` (not an
  // agent) -> `claude` (real session, cwd = worktree). The tmux pane path tracks
  // the launcher's dir; the representative must be the real claude and its cwd.
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 65940, ppid: 39533, tty: "ttys21", command: "make claude", agentNative: false, startMs: 1000 }),
      proc({ pid: 66144, ppid: 65940, tty: "ttys21", command: "node scripts/new-session.mjs -- claude", agent: null, agentNative: false, startMs: 1100 }),
      proc({ pid: 66512, ppid: 66144, tty: "ttys21", command: "claude", agentNative: true, startMs: 1200 }),
    ],
    terminals: terminals(
      [muxPane({ session: "AI2", tty: "ttys21", paneId: "%15", cwd: "/Users/me/workspace/ai-harness" })],
      [],
    ),
  };
  const procCwds = new Map([[66512, "/Users/me/.treehouse/x/4/ai-harness"]]);
  const [s] = correlate(input, procCwds);
  assert.equal(s?.pid, 66512); // the real claude, not the make launcher (65940)
  assert.equal(s?.cwd, "/Users/me/.treehouse/x/4/ai-harness");
});

test("falls back to the tmux pane path when the process cwd is unavailable", () => {
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 65940, ppid: 39533, tty: "ttys21", command: "make claude", agentNative: false, startMs: 1000 }),
      proc({ pid: 66512, ppid: 65940, tty: "ttys21", command: "claude", agentNative: true, startMs: 1200 }),
    ],
    terminals: terminals(
      [muxPane({ session: "AI2", tty: "ttys21", paneId: "%15", cwd: "/Users/me/workspace/ai-harness" })],
      [],
    ),
  };
  const [s] = correlate(input); // no procCwds -> pane path fallback
  assert.equal(s?.pid, 66512); // still the native agent, not the launcher
  assert.equal(s?.cwd, "/Users/me/workspace/ai-harness");
});

test("a session on one tty keeps a handle from EACH axis, not just the namer's", () => {
  // The composition rule: a multiplexer pane lives inside an emulator pane, so both handles
  // are real and a session may hold one of each. This used to be a fixup that ran after the
  // naming branch and restated what that branch had just decided - taking the first pane of
  // each axis is the rule itself, so the emulator handle can no longer be dropped by an
  // early `else`.
  const input: DiscoveryInput = {
    procs: [proc({ pid: 800, ppid: 50, tty: "ttysZ" })],
    terminals: terminals(
      [muxPane({ session: "inner", tty: "ttysZ", paneId: "%7" })],
      [emuPane({ tty: "ttysZ", tabTitle: "Outer", paneId: "12", tabId: "4", windowId: "1", isActive: true })],
    ),
  };
  const [s] = correlate(input);
  assert.equal(muxHandle(s!)?.paneId, "%7");
  assert.deepEqual(emulatorHandle(s!), {
    kind: "emulator",
    backend: "wezterm",
    paneId: "12",
    tabId: "4",
    windowId: "1",
    tabTitle: "Outer",
    isActive: true,
  });
});

test("one backend reporting a tty twice yields one handle, the last reported", () => {
  // `tmux list-panes -a` walks sessions then windows, so a window linked into two sessions
  // (`new-session -t existing`, `link-window`) reports the SAME pane once per session with a
  // different session_name each time. The map this replaced was keyed by tty and last-write
  // wins; a list that appended both would let a duplicate's arrival order decide the card's
  // name and - through `MuxHandle.session` - which session Rename and Kill target.
  const input: DiscoveryInput = {
    procs: [proc({ pid: 840, ppid: 50, tty: "ttysD" })],
    terminals: terminals(
      [
        muxPane({ session: "grouped-a", tty: "ttysD", paneId: "%4" }),
        muxPane({ session: "grouped-b", tty: "ttysD", paneId: "%4" }),
      ],
      [],
    ),
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "grouped-b");
  assert.equal(muxHandle(s!)?.session, "grouped-b");
});

test("naming priority is the registries' order, not a branch in this file", () => {
  // The same two panes on the same tty, enumerated emulator-first. Nothing here special-cases
  // tmux, so the precedence follows the list - which is what makes `MULTIPLEXER_IDS` /
  // `EMULATOR_IDS` the one place a third backend declares where it ranks. If this still said
  // "inner", the arm order of an if/else would still be the real precedence.
  const input: DiscoveryInput = {
    procs: [proc({ pid: 810, ppid: 50, tty: "ttysY" })],
    terminals: [
      { kind: "emulator", backend: "wezterm", panes: [emuPane({ tty: "ttysY", tabTitle: "Outer" })], hostProcess: null },
      { kind: "multiplexer", backend: "tmux", panes: [muxPane({ session: "inner", tty: "ttysY", paneId: "%9" })] },
    ],
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "Outer");
  assert.equal(s?.nameSource, "wezterm");
  // Both handles are still recorded: which backend NAMED the session and which handles it
  // holds are different questions, and only the first one is about order.
  assert.equal(muxHandle(s!)?.paneId, "%9");
});

test("a backend this file has never heard of correlates, names AND keeps its handle", () => {
  // The acceptance test for this item, and the reason the cast is here rather than a real id:
  // correlation must not be able to recognise a vendor. A third multiplexer names its
  // sessions, stamps its own `nameSource` and lands a handle on the card with no code
  // change. Before phase 3 the last of those was missing - `Session` had a field per vendor,
  // so this session was discovered, named, drawn, and then unreachable by every write.
  const input: DiscoveryInput = {
    procs: [proc({ pid: 820, ppid: 50, tty: "ttysQ" })],
    terminals: [
      {
        kind: "multiplexer",
        backend: "zellij" as MultiplexerId,
        panes: [muxPane({ session: "sprint", tty: "ttysQ", paneId: "0", cwd: "/w/sprint" })],
      },
    ],
  };
  const [s] = correlate(input);
  assert.equal(s?.name, "sprint");
  assert.equal(s?.nameSource, "zellij");
  assert.equal(s?.cwd, "/w/sprint");
  assert.deepEqual(muxHandle(s!), {
    kind: "multiplexer",
    backend: "zellij",
    session: "sprint",
    sessionName: "sprint",
    windowIndex: 0,
    windowName: "w",
    paneId: "0",
  });
});

test("a session with no pane at all is named by pid, never by its directory", () => {
  // The cwd basename is a BACKEND's fallback for an untitled tab, not a fallback for having
  // no backend: nothing named this session, so `nameSource` is `process` and the name must
  // agree with it. A name lifted from the cwd here would read as a tab title that does not
  // exist.
  const input: DiscoveryInput = {
    procs: [proc({ pid: 830, ppid: 50, tty: "ttysP" })],
    terminals: terminals([], []),
  };
  const [s] = correlate(input, new Map([[830, "/Users/me/workspace/sim"]]));
  assert.equal(s?.nameSource, "process");
  assert.equal(s?.name, "claude 830");
  assert.equal(s?.cwd, "/Users/me/workspace/sim");
});

test("two sessions in one tmux session stay distinct (different panes/ttys)", () => {
  const input: DiscoveryInput = {
    procs: [
      proc({ pid: 700, ppid: 50, tty: "ttysA" }),
      proc({ pid: 701, ppid: 51, tty: "ttysB" }),
    ],
    terminals: terminals(
      [
        muxPane({ session: "dev", tty: "ttysA", paneId: "%1" }),
        muxPane({ session: "dev", tty: "ttysB", paneId: "%2" }),
      ],
      [],
    ),
  };
  const results = correlate(input);
  assert.equal(results.length, 2);
  assert.notEqual(results[0]?.syntheticId, results[1]?.syntheticId);
});
