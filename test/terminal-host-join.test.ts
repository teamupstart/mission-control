// What is at stake: a pane that cannot name its own tty must be paired with a process only
// when exactly one pairing is possible, and must be LEFT ALONE otherwise.
//
// The two directions fail differently, and that asymmetry is the whole reason the matcher
// refuses instead of guessing. Failing to pair costs a card its terminal handle - the
// already-tested handleless state, where Send is disabled and Focus refuses, and the
// operator can see that. Pairing WRONGLY costs someone else's terminal: Focus raises a
// stranger's tab and the next queued prompt is typed into it. One is a visible absence, the
// other is a silent misdirection, so every ambiguous case in here must assert that NOTHING
// was recorded rather than that something reasonable was.
//
// The second key exists because Ghostty enumerates real, focusable, typeable surfaces and
// cannot say which tty any of them is on (`todo/ghostty-emulator.md`). Before it, "can this
// backend name a tty?" was an unstated precondition for existing at all.
import test from "node:test";
import assert from "node:assert/strict";

import { correlate, type DiscoveryInput } from "../src/server/discovery/correlate.ts";
import type { Proc } from "../src/server/discovery/processes.ts";
import { canWriteTo, emulatorHandle, muxHandle } from "../src/shared/pane.ts";
import {
  argv0Basename,
  hostIsRunning,
  isHostProcess,
  ttysHostedBy,
  type HostProc,
} from "../src/server/terminal/host.ts";
import type { EmulatorPane } from "../src/server/terminal/types.ts";

const GHOSTTY = { commands: ["ghostty"] } as const;

function proc(p: Partial<Proc> & { pid: number }): Proc {
  return {
    pid: p.pid,
    ppid: p.ppid ?? 1,
    tty: p.tty ?? null,
    startRaw: "",
    startMs: p.startMs ?? 1000,
    command: p.command ?? "/usr/local/bin/claude",
    agent: p.agent === undefined ? "claude" : p.agent,
    agentNative: p.agentNative ?? true,
  };
}

/** The GUI process itself - not an agent, so it never becomes a session of its own. */
function gui(pid: number, command = "/Applications/Ghostty.app/Contents/MacOS/ghostty"): Proc {
  return proc({ pid, command, agent: null, agentNative: false });
}

function surface(p: Partial<EmulatorPane> & { paneId: string }): EmulatorPane {
  return {
    paneId: p.paneId,
    tabId: p.tabId ?? `tab-${p.paneId}`,
    windowId: p.windowId ?? `win-${p.paneId}`,
    tabTitle: p.tabTitle ?? "",
    windowTitle: p.windowTitle ?? "",
    isActive: p.isActive ?? false,
    // The point of the whole exercise: Ghostty reports no tty, ever.
    tty: p.tty ?? null,
    cwd: p.cwd ?? null,
  };
}

function input(procs: Proc[], panes: EmulatorPane[]): DiscoveryInput {
  return {
    procs,
    terminals: [{ kind: "emulator", backend: "ghostty", panes, hostProcess: GHOSTTY }],
  };
}

test("argv0 is read as a basename, never as a substring of the command line", () => {
  assert.equal(argv0Basename("/Applications/Ghostty.app/Contents/MacOS/ghostty"), "ghostty");
  // A login shell's argv0 carries a leading dash by convention.
  assert.equal(argv0Basename("-/bin/zsh"), "zsh");
  assert.equal(argv0Basename(""), "");

  assert.ok(isHostProcess(GHOSTTY, "/Applications/Ghostty.app/Contents/MacOS/ghostty"));
  // The expensive lesson from `DetectSpec.background`, applied one axis over: an agent whose
  // argv carries an operator's directory name or a 1.2KB prompt must never be mistaken for a
  // terminal because the word appears somewhere in the line.
  assert.equal(isHostProcess(GHOSTTY, "claude -p 'why does ghostty do that'"), false);
  assert.equal(isHostProcess(GHOSTTY, "vim /Users/me/ghostty/config"), false);
  assert.equal(isHostProcess(GHOSTTY, "/opt/bin/ghostty-helper"), false);
});

test("hostIsRunning is what keeps an Apple Event off the tick, and it reads live state", () => {
  // Not a "did it work last tick?" memo. An operator who opens their terminal is swept on
  // the very next tick, and one who quits it stops being asked immediately - which matters
  // because asking a non-running app anything LAUNCHES it.
  assert.equal(hostIsRunning(GHOSTTY, [proc({ pid: 1 })]), false);
  assert.equal(hostIsRunning(GHOSTTY, [proc({ pid: 1 }), gui(99)]), true);
});

test("ancestry finds a tty at depth, and stops at a recycled parent", () => {
  const procs: HostProc[] = [
    gui(100),
    proc({ pid: 200, ppid: 100, tty: "ttys1", command: "login -flp me" }),
    proc({ pid: 300, ppid: 200, tty: "ttys1", command: "-zsh" }),
    // A tty under nothing we host.
    proc({ pid: 400, ppid: 1, tty: "ttys2", command: "-zsh" }),
  ];
  assert.deepEqual([...ttysHostedBy(GHOSTTY, procs)], ["ttys1"]);

  // A process table read non-atomically can hand back a cycle. The walk is bounded, so this
  // returns rather than hanging the discovery tick.
  const cyclic: HostProc[] = [
    gui(100),
    proc({ pid: 500, ppid: 501, tty: "ttys9", command: "-zsh" }),
    proc({ pid: 501, ppid: 500, tty: null, command: "-zsh" }),
  ];
  assert.deepEqual([...ttysHostedBy(GHOSTTY, cyclic)], []);
});

test("a lone hosted tty and a lone tty-less pane are paired, and the pane names the session", () => {
  // The "last one standing" rule. It needs no directory at all, which is what carries a
  // surface spawned with a raw command - measured reporting an EMPTY cwd, because shell
  // integration never ran to emit OSC 7.
  const [s] = correlate(
    input(
      [gui(100), proc({ pid: 900, ppid: 100, tty: "ttys5" })],
      [surface({ paneId: "UUID-A", tabTitle: "alpha" })],
    ),
  );
  assert.equal(s?.nameSource, "ghostty");
  assert.equal(s?.name, "alpha");
  assert.equal(s?.tty, "ttys5");

  // And it records a real HANDLE, not just a name. This is the half that was impossible
  // before phase 3 landed the handle list: `legacyHandles` could project onto
  // `Session.tmux` / `Session.wezterm` and nothing else, so a correctly correlated Ghostty
  // pane was named and then dropped on the floor - discovered but unreachable. A pane the
  // second key had to work this hard to find would have been thrown away at the last step.
  assert.deepEqual(emulatorHandle(s!), {
    kind: "emulator",
    backend: "ghostty",
    paneId: "UUID-A",
    tabId: "tab-UUID-A",
    windowId: "win-UUID-A",
    tabTitle: "alpha",
    isActive: false,
  });
  assert.equal(canWriteTo(s!), true, "a paired session has a composer to type into");
});

test("distinct working directories pair both, because neither has a choice to make", () => {
  const procs = [
    gui(100),
    proc({ pid: 900, ppid: 100, tty: "ttysA" }),
    proc({ pid: 901, ppid: 100, tty: "ttysB" }),
  ];
  const panes = [
    surface({ paneId: "UUID-A", tabTitle: "alpha", cwd: "/w/alpha" }),
    surface({ paneId: "UUID-B", tabTitle: "beta", cwd: "/w/beta" }),
  ];
  const cwds = new Map([
    [900, "/w/alpha"],
    [901, "/w/beta"],
  ]);
  const byTty = new Map(correlate(input(procs, panes), cwds).map((s) => [s.tty, s]));
  assert.equal(byTty.get("ttysA")?.name, "alpha");
  assert.equal(byTty.get("ttysB")?.name, "beta");
  assert.equal(byTty.get("ttysA")?.nameSource, "ghostty");
});

test("two agents in ONE directory pair with nothing - the case that must refuse", () => {
  // The ordinary shape of this product: several sessions in one repo. Both ttys report the
  // same cwd and both surfaces do too, so nothing distinguishes them and the counts rule out
  // "last one standing". Pairing either way would be a coin flip that focuses a stranger's
  // tab, so both sessions fall back to `<agent> <pid>` and read as handleless.
  const procs = [
    gui(100),
    proc({ pid: 900, ppid: 100, tty: "ttysA" }),
    proc({ pid: 901, ppid: 100, tty: "ttysB" }),
  ];
  const panes = [
    surface({ paneId: "UUID-A", tabTitle: "one", cwd: "/w/repo" }),
    surface({ paneId: "UUID-B", tabTitle: "two", cwd: "/w/repo" }),
  ];
  const cwds = new Map([
    [900, "/w/repo"],
    [901, "/w/repo"],
  ]);
  for (const s of correlate(input(procs, panes), cwds)) {
    assert.equal(s.nameSource, "process", "an ambiguous pairing must not name a session");
    assert.match(s.name, /^claude \d+$/);
  }
});

test("a spare shell tab does not make the agent's tty ambiguous", () => {
  // One agent, two Ghostty surfaces - the agent's and a plain shell beside it. The counts
  // differ, so "last one standing" cannot fire; cwd agreement is what resolves it, and the
  // shell tab is alone in its own directory so it removes nothing.
  const procs = [gui(100), proc({ pid: 900, ppid: 100, tty: "ttysA" })];
  const panes = [
    surface({ paneId: "UUID-A", tabTitle: "agent", cwd: "/w/alpha" }),
    surface({ paneId: "UUID-B", tabTitle: "scratch", cwd: "/w/elsewhere" }),
  ];
  const [s] = correlate(input(procs, panes), new Map([[900, "/w/alpha"]]));
  assert.equal(s?.name, "agent");
  assert.equal(s?.nameSource, "ghostty");
});

test("a tty this backend does not host is never claimed, however few panes it has", () => {
  // The agent is in some other terminal entirely. Ghostty has exactly one unplaced surface,
  // which is what "last one standing" looks for - and the tty is not in its hosted set, so
  // it is not a candidate at all. Without the ancestry gate this is the case that would
  // cheerfully bind a wezterm session to a Ghostty tab.
  const procs = [gui(100), proc({ pid: 900, ppid: 1, tty: "ttysZ" })];
  const [s] = correlate(input(procs, [surface({ paneId: "UUID-A", tabTitle: "not-yours" })]));
  assert.equal(s?.nameSource, "process");
});

test("a pane that names its own tty still wins, and the fallback never overrides it", () => {
  // Pass 1 is exact. A backend that reports ttys is unaffected by any of this, which is why
  // both shipped adapters declare `hostProcess: null` and see no behaviour change.
  const procs = [gui(100), proc({ pid: 900, ppid: 100, tty: "ttysA" })];
  const panes = [
    surface({ paneId: "UUID-REAL", tabTitle: "exact", tty: "ttysA" }),
    surface({ paneId: "UUID-GUESS", tabTitle: "guess" }),
  ];
  const [s] = correlate(input(procs, panes));
  assert.equal(s?.name, "exact");
});

test("a hostless backend correlates on tty alone, exactly as before", () => {
  // wezterm's shape. The second key is opt-in per backend, so a null here is not a
  // degradation - it is the declaration that the strong key is always available.
  const [s] = correlate({
    procs: [proc({ pid: 900, tty: "ttysA" })],
    terminals: [
      {
        kind: "emulator",
        backend: "wezterm",
        panes: [surface({ paneId: "7", tabTitle: "wt", tty: "ttysA" })],
        hostProcess: null,
      },
    ],
  });
  assert.equal(s?.nameSource, "wezterm");
  assert.equal(s?.name, "wt");
});

test("a multiplexer inside a hosted window keeps the pane - the axes do not fight", () => {
  // Load-bearing, and it works because of what ancestry does NOT catch: a multiplexer server
  // is reparented to init, so an agent inside tmux hosted in a Ghostty window walks up to
  // init and not to Ghostty. The multiplexer is the inner, more specific handle and keeps it.
  const procs = [
    gui(100),
    // The tmux server, reparented away from the terminal that started it.
    proc({ pid: 200, ppid: 1, command: "tmux", agent: null, agentNative: false }),
    proc({ pid: 900, ppid: 200, tty: "ttysA" }),
  ];
  const [s] = correlate({
    procs,
    terminals: [
      {
        kind: "multiplexer",
        backend: "tmux",
        panes: [
          {
            session: "api",
            // tmux's two are one string; the split exists for a backend where they differ.
            sessionName: "api",
            windowIndex: 0,
            paneId: "%3",
            windowName: "w",
            panePid: 900,
            tty: "ttysA",
            cwd: null,
          },
        ],
      },
      {
        kind: "emulator",
        backend: "ghostty",
        panes: [surface({ paneId: "UUID-A", tabTitle: "outer" })],
        hostProcess: GHOSTTY,
      },
    ],
  });
  assert.equal(s?.nameSource, "tmux");
  assert.equal(s?.name, "api");
  assert.equal(muxHandle(s!)?.paneId, "%3");
  // And no emulator handle was invented for it: Ghostty's surface is a real pane, but it is
  // not the pane this agent sits on, and the ancestry walk is what knows the difference.
  assert.equal(emulatorHandle(s!), null);
});
