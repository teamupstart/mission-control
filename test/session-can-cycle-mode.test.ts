/**
 * What is at stake: Shift+Tab cycles a session's permission mode by typing the keystroke
 * into its pane, and that is only ever right for a LIVE session whose harness actually cycles
 * (Claude's footer) and has a pane to type into. Sending it to a harness whose live control is
 * a numbered menu (Codex's `/permissions`) types a key its TUI reads as something else; sending
 * it to an exited session or one with no pane does nothing but could mislead the offer.
 *
 * `canCycleMode` is the ONE gate for that decision, shared by the board/card keydown handler,
 * the CommandBar keycap and the ActionBar button, so none of the three can disagree about when
 * the cycle is offered. This pins the four answers that matter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { canCycleMode } from "../src/shared/session.ts";
import { mkSession } from "./helpers/session-fixture.ts";

test("a live cycling harness with a pane can cycle its mode", () => {
  // Claude's live control IS the Shift+Tab cycle, and the default fixture is live with a pane.
  assert.equal(canCycleMode(mkSession({ agent: "claude" })), true);
});

test("an exited session cannot cycle - there is nothing live to retarget", () => {
  assert.equal(canCycleMode(mkSession({ agent: "claude", state: "exited" })), false);
});

test("a session with no pane cannot cycle - there is nowhere to type the keystroke", () => {
  assert.equal(canCycleMode(mkSession({ agent: "claude", terminals: [] })), false);
});

test("a menu-driven harness does not cycle - its live control is not a keystroke", () => {
  // Codex has no Shift+Tab footer; its live permission control is the `/permissions` menu, so
  // the cycle keystroke must not be offered even for a live, paned Codex session.
  assert.equal(canCycleMode(mkSession({ agent: "codex" })), false);
});
