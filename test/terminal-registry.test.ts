import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMULATORS,
  MULTIPLEXERS,
  bindPane,
  hostPanesFor,
  type TerminalHandles,
} from "../src/server/terminal/registry.ts";
import type {
  EmulatorPane,
  MuxClient,
  TerminalEmulator,
} from "../src/server/terminal/types.ts";
import { PLAIN_NAMES } from "../src/server/terminal/names.ts";
import { paneToken } from "../src/shared/pane.ts";
import type { TmuxInfo, WeztermInfo } from "../src/shared/types.ts";

// What is at stake: that a new terminal backend cannot be half-integrated.
//
// The failure mode this whole layer exists for is silent. Today ~20 call sites branch
// `if (session.tmux) … else if (session.wezterm) …`, so a third backend does not break a
// build - it produces a session whose Focus does nothing, whose queue never sends, and
// whose card looks entirely normal. The registries are the compiler enforcement that
// replaces that: an id in the union with no adapter is a type error, and an adapter is
// only complete once every capability is implemented OR explicitly declared null.
//
// These tests guard the two things a typecheck cannot: that a registry key still names the
// adapter filed under it, and that the composition rule (writes innermost, focus outward)
// has exactly one implementation.

test("every registry key names the adapter filed under it", () => {
  for (const [id, mux] of Object.entries(MULTIPLEXERS)) assert.equal(mux.id, id);
  for (const [id, emu] of Object.entries(EMULATORS)) assert.equal(emu.id, id);
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
  // Ghostty, the acceptance test for the emulator boundary: no scripting CLI, so it can be
  // spawned into and brought forward, and can be neither enumerated, captured nor typed
  // into. This has to typecheck with no field left over - if a real Ghostty adapter needs
  // the interface widened, the interface was shaped around `wezterm cli`.
  const ghostty: Omit<TerminalEmulator, "id"> = {
    label: "Ghostty",
    bin: { env: "GHOSTTY_BIN", candidates: ["ghostty"], dropEnv: [] },
    list: null,
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

  assert.equal(ghostty.list, null);
  assert.equal(ghostty.focus?.granularity, "app");
});

const MUX_HANDLE = { backend: "tmux" as const, session: "api", windowIndex: 0, paneId: "%3" };
const EMU_HANDLE = { backend: "wezterm" as const, paneId: "5", tabId: "2" };

test("writes prefer the innermost handle", () => {
  // The agent's real pane is the multiplexer pane; the emulator handle addresses the client
  // showing it, so typing there types at whatever that client is currently displaying. Four
  // call sites resolve this identically today and each states the rule again.
  const both: TerminalHandles = { multiplexer: MUX_HANDLE, emulator: EMU_HANDLE };
  const bound = bindPane(both);
  assert.equal(bound?.kind, "multiplexer");
  assert.equal(bound?.token, "tmux:%3");
});

test("an emulator-only session binds to its emulator", () => {
  const bound = bindPane({ multiplexer: null, emulator: EMU_HANDLE });
  assert.equal(bound?.kind, "emulator");
  assert.equal(bound?.token, "wezterm:5");
  assert.ok(bound?.write, "wezterm can be typed into");
  // Not "we asked and it is in no mode" - there is nothing to ask. A caller that reads the
  // two as the same thing will treat "cannot see a mode" as evidence a write will land.
  assert.equal(bound?.mode, null);
});

test("a session with no terminal handle binds to nothing", () => {
  assert.equal(bindPane({ multiplexer: null, emulator: null }), null);
});

test("the bound token is the one phase 0 collapsed the four copies into", () => {
  // `bindPane` builds its token from the backend id so a third multiplexer needs no token
  // function of its own, which only stays honest while a backend id is its `paneToken`
  // prefix. Both spellings are in-memory keys today, so drift is silent: two subsystems
  // would key the same pane differently and each would claim the other's lock was free.
  assert.equal(
    bindPane({ multiplexer: MUX_HANDLE, emulator: EMU_HANDLE })?.token,
    paneToken({ tmux: { paneId: MUX_HANDLE.paneId } as TmuxInfo, wezterm: null }),
  );
  assert.equal(
    bindPane({ multiplexer: null, emulator: EMU_HANDLE })?.token,
    paneToken({ tmux: null, wezterm: { paneId: Number(EMU_HANDLE.paneId) } as WeztermInfo }),
  );
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
