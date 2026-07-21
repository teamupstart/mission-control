import { test } from "node:test";
import assert from "node:assert/strict";
import { canWriteTo, emulatorHandle, innermostPane, muxHandle } from "../src/shared/pane.ts";
import type { MultiplexerId, TerminalHandle } from "../src/shared/terminal.ts";
import { mkEmuHandle, mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: that "can we type into this session?" has ONE answer, and that it does
// not know how many terminal backends exist.
//
// It used to have twenty, spread over both processes and every layout - the Send box, the
// mode picker, Rename, the work queue's delivery check, Foreman's `canSend`, the reset
// preview's "will this clear context" - each spelled `Boolean(s.tmux || s.wezterm)`. None of
// them was a question about tmux or wezterm. A third backend would have been discovered,
// named, drawn on a card, and then refused a Send by twenty independent booleans, each of
// which looks correct on its own and none of which fails to compile.
//
// So these cases are about the SHAPE rather than about a vendor: a handle list generalizes
// past two, the write target is decided by the handle's axis rather than by its position,
// and a backend this file invents is answered like any other.

const MUX = mkMuxHandle({ session: "api", paneId: "%3" });
const EMU = mkEmuHandle({ paneId: "12" });

test("a session with any pane can be written to, and one with none cannot", () => {
  assert.equal(canWriteTo({ terminals: [MUX] }), true);
  assert.equal(canWriteTo({ terminals: [EMU] }), true);
  assert.equal(canWriteTo({ terminals: [MUX, EMU] }), true);
  // The honest state of an agent running in a terminal we do not integrate with, and the
  // one every refusing surface is phrased for.
  assert.equal(canWriteTo({ terminals: [] }), false);
});

test("the write target is the innermost handle, whatever order the list is in", () => {
  // The agent's real pane is the multiplexer pane; the emulator handle addresses the client
  // showing it, so typing there types at whatever that client currently displays. The list's
  // own order is a NAMING priority (`MULTIPLEXER_IDS` then `EMULATOR_IDS`), and reading one
  // as the other is how a re-ordered registry would silently re-aim every write.
  assert.deepEqual(innermostPane({ terminals: [MUX, EMU] }), MUX);
  assert.deepEqual(innermostPane({ terminals: [EMU, MUX] }), MUX);
  assert.deepEqual(innermostPane({ terminals: [EMU] }), EMU);
  assert.equal(innermostPane({ terminals: [] }), null);
});

test("a backend nothing here has heard of is reachable like any other", () => {
  // The acceptance test, and the reason for the cast rather than a real id: nothing in the
  // shared layer may be able to recognise a vendor. Before the list, a zellij pane had no
  // field on `Session` to land in - so a session it named was drawn on the board with a
  // Send button that would never work and no way to say why.
  const zellij: TerminalHandle = { ...mkMuxHandle(), backend: "zellij" as MultiplexerId };
  assert.equal(canWriteTo({ terminals: [zellij] }), true);
  assert.deepEqual(innermostPane({ terminals: [zellij, EMU] }), zellij);
});

test("the per-axis accessors answer only the questions that are about an axis", () => {
  // A named session to rename or kill is a multiplexer concept with no emulator equivalent,
  // and a tab to raise is the reverse. Everything else asks `canWriteTo`.
  const both = { terminals: [MUX, EMU] };
  assert.equal(muxHandle(both)?.session, "api");
  assert.equal(emulatorHandle(both)?.paneId, "12");
  // Kill on an emulator-only session signals the process and tears nothing else down; the
  // null is what tells it so, rather than an absent field that also meant "no tmux".
  assert.equal(muxHandle({ terminals: [EMU] }), null);
  assert.equal(emulatorHandle({ terminals: [MUX] }), null);
});
