// TTY correlation must stay exact. GUI ancestry, cwd and elimination do not prove a recipient.
import test from "node:test";
import assert from "node:assert/strict";

import { correlate, type DiscoveryInput } from "../src/server/discovery/correlate.ts";
import type { Proc } from "../src/server/discovery/processes.ts";
import { canWriteTo, emulatorHandle, muxHandle } from "../src/shared/pane.ts";
import {
  argv0Basename,
  hostIsRunning,
  isHostProcess,
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

test("a lone tty-less pane cannot establish an agent recipient", () => {
  const [session] = correlate(input([gui(100), proc({ pid: 900, ppid: 100, tty: "ttys5" })],
    [surface({ paneId: "UUID-A", tabTitle: "alpha" })]));
  assert.equal(session?.nameSource, "process");
  assert.equal(canWriteTo(session!), false);
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
