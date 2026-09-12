import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMULATORS,
  MULTIPLEXERS,
  bindPane,
  hostPanesFor,
  terminalBackendBin,
} from "../src/server/terminal/registry.ts";
import type {
  EmulatorPane,
  MuxClient,
  TerminalEmulator,
} from "../src/server/terminal/types.ts";
import { PLAIN_NAMES } from "../src/server/terminal/names.ts";
import { paneToken } from "../src/shared/pane.ts";
import {
  EMULATOR_IDS,
  MULTIPLEXER_IDS,
  type TerminalHandle,
} from "../src/shared/terminal.ts";

// What is at stake: that a new terminal backend cannot be half-integrated.
//
// The failure mode this whole layer exists for is silent. Call sites used to branch
// `if (session.tmux) … else if (session.wezterm) …`, so a third backend did not break a
// build - it produced a session whose Focus does nothing, whose queue never sends, and
// whose card looks entirely normal. The registries are the compiler enforcement that
// replaces that: an id in the union with no adapter is a type error, and an adapter is
// only complete once every capability is implemented OR explicitly declared null.
//
// These tests guard the two things a typecheck cannot: that a registry key still names the
// adapter filed under it, and that the composition rule (writes innermost, focus outward)
// has exactly one implementation.

test("every registry key names its adapter and binary spec", () => {
  for (const [id, mux] of Object.entries(MULTIPLEXERS)) assert.equal(mux.id, id);
  for (const [id, emu] of Object.entries(EMULATORS)) assert.equal(emu.id, id);
  for (const id of MULTIPLEXER_IDS) assert.equal(terminalBackendBin(id), MULTIPLEXERS[id].bin);
  for (const id of EMULATOR_IDS) assert.equal(terminalBackendBin(id), EMULATORS[id].bin);
});

test("capability nulls are declarations, and the two axes differ in what they declare", () => {
  const tmux = MULTIPLEXERS.tmux;
  const wezterm = EMULATORS.wezterm;

  // The asymmetry that made these two interfaces rather than one. tmux can tell you a pane
  // is in copy-mode and cannot raise a window; wezterm can raise a window and has no
  // concept of an input mode to be stuck in.
  assert.ok(tmux.paneMode, "tmux must expose its copy-mode probe");
  assert.ok(tmux.sessions, "tmux must expose named-session lifecycle");
  assert.ok(wezterm.focus, "wezterm must be able to raise");
  assert.equal(wezterm.focus?.granularity, "pane");
});

test("the interface admits an emulator that can only be launched into", () => {
  // The launch-only pole of the emulator axis: something that opens a window and answers
  // nothing else. This was written as "Ghostty" on the belief that Ghostty was that shape.
  // It is not - the real adapter lists, writes, focuses and spawns (`ghostty.ts`) - so the
  // case is kept as the hypothetical it always really was. It still earns its place: no
  // shipped backend exercises these nulls, and a path first exercised by a new adapter is a
  // path that ships broken.
  const launchOnly: Omit<TerminalEmulator, "id"> = {
    label: "Launch-only",
    glyph: "▦",
    bin: { env: null, candidates: ["someterm"], dropEnv: [] },
    list: null,
    // Null because it cannot enumerate at all - there is nothing to correlate, so the
    // second join key would have nothing to pair. Not the same declaration Ghostty makes.
    hostProcess: null,
    write: null,
    capture: null,
    // It brings the application forward with no idea which tab that lands on, and says so
    // rather than pretending it focused a session.
    focus: { granularity: "app", raise: async () => ({ ok: true, outcomeUnknown: false }) },
    spawn: {
      // A tab opened, and nothing may be driven in it. `ok: true` with a null target is the
      // honest answer, which is why spawn does not return a nullable id.
      tab: async () => ({ ok: true, outcomeUnknown: false, target: null }),
    },
    retitle: null,
    // A tab title it can stamp at spawn but never change: display text, with no grammar of
    // its own, said out loud rather than assumed by the caller stamping it.
    names: PLAIN_NAMES,
  };

  assert.equal(launchOnly.list, null);
  assert.equal(launchOnly.focus?.granularity, "app");
});

const MUX_HANDLE: TerminalHandle = {
  kind: "multiplexer",
  backend: "tmux",
  session: "api",
  sessionName: "api",
  windowIndex: 0,
  windowName: "w",
  paneId: "%3",
};
const EMU_HANDLE: TerminalHandle = {
  kind: "emulator",
  backend: "wezterm",
  paneId: "5",
  tabId: "2",
  windowId: "0",
  tabTitle: "",
  isActive: true,
};

test("writes prefer the innermost handle", () => {
  // The agent's real pane is the multiplexer pane; the emulator handle addresses the client
  // showing it, so typing there types at whatever that client is currently displaying. Four
  // call sites resolve this identically today and each states the rule again.
  // Emulator FIRST in the list, so this cannot pass by reading position: the list's order
  // is a naming priority, and the write target is decided by the handle's axis.
  for (const multiplexer of MULTIPLEXER_IDS) {
    for (const emulator of EMULATOR_IDS) {
      const bound = bindPane([
        { ...EMU_HANDLE, backend: emulator },
        { ...MUX_HANDLE, backend: multiplexer },
      ]);
      assert.equal(bound?.kind, "multiplexer");
      assert.equal(bound?.token, `${multiplexer}:%3`, `${multiplexer} inside ${emulator}`);
      assert.ok(bound?.write, "the inner pane supports interrupt keystrokes");
    }
  }
});

test("an emulator-only session binds to its emulator", () => {
  for (const emulator of EMULATOR_IDS) {
    const bound = bindPane([{ ...EMU_HANDLE, backend: emulator }]);
    assert.equal(bound?.kind, "emulator");
    assert.equal(bound?.token, `${emulator}:5`);
    assert.ok(bound?.write, `${emulator} supports interrupt keystrokes`);
    // No multiplexer mode probe exists for a standalone emulator.
    assert.equal(bound?.mode, null);
  }
});

test("a session with no terminal handle binds to nothing", () => {
  assert.equal(bindPane([]), null);
});

test("the bound token is the one phase 0 collapsed the four copies into", () => {
  // `bindPane` and `paneToken` now resolve the same handle through `innermostPane` and
  // spell it with the same constructor, so a third multiplexer needs no token function of
  // its own. Pinned anyway, because these are in-memory keys and drift is silent: two
  // subsystems would key the same pane differently and each would claim the other's lock
  // was free.
  assert.equal(
    bindPane([MUX_HANDLE, EMU_HANDLE])?.token,
    paneToken({ terminals: [MUX_HANDLE, EMU_HANDLE] }),
  );
  assert.equal(bindPane([EMU_HANDLE])?.token, paneToken({ terminals: [EMU_HANDLE] }));
});

test("the host-tab join is an equality test on normalized ttys", () => {
  // The outward half of the composition rule. A tab running `tmux attach` shares its tty
  // with the tmux CLIENT, while the agent inside sits on a tmux PANE tty - so this join is
  // the only link from a multiplexer session to the window showing it.
  const clients: MuxClient[] = [
    { tty: "ttys028", session: "api" },
    { tty: "ttys031", session: "web" },
    { tty: null, session: "api" },
  ];
  const panes: EmulatorPane[] = [
    pane("1", "ttys028"),
    pane("2", "ttys031"),
    pane("3", null),
  ];

  assert.deepEqual(
    hostPanesFor("api", clients, panes).map((p) => p.paneId),
    ["1"],
  );
  // A client with no tty matches nothing rather than every pane that also has none.
  assert.deepEqual(hostPanesFor("nobody", clients, panes), []);
  // Attached, but in a terminal we do not integrate with - Focus reads this as "nothing to
  // raise" and falls through to spawning a tab, which is a different outcome from "not
  // attached at all".
  assert.deepEqual(hostPanesFor("api", [{ tty: "ttys099", session: "api" }], panes), []);
});

test("a session with several clients gets its hosts in enumeration order", () => {
  // Callers take the first (`focus` raises one tab), so the pick has to be deterministic
  // rather than whichever client tmux happened to list first this tick.
  const clients: MuxClient[] = [
    { tty: "ttys004", session: "web" },
    { tty: "ttys019", session: "web" },
  ];
  const panes: EmulatorPane[] = [pane("9", "ttys019"), pane("2", "ttys004")];
  assert.deepEqual(
    hostPanesFor("web", clients, panes).map((p) => p.paneId),
    ["9", "2"],
  );
});

function pane(paneId: string, tty: string | null): EmulatorPane {
  return {
    paneId,
    tabId: paneId,
    windowId: "0",
    tabTitle: "",
    windowTitle: "",
    isActive: false,
    tty,
    cwd: null,
  };
}
