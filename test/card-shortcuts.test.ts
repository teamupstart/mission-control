import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assignCardShortcuts,
  CARD_SHORTCUT_CHORDS,
  CARD_SHORTCUT_KEYS,
  cardShortcutChord,
  cardShortcutTarget,
} from "../src/web/lib/card-shortcuts.ts";
import {
  ariaKeyshortcuts,
  chordFromEvent,
  formatChord,
  isReservedChord,
} from "../src/web/lib/keybindings.ts";

/**
 * The Board card's ⌘1 … ⌘= jump keys: how a slot is handed out, and what a keypress
 * addresses.
 *
 * Pure over the column arrays App already builds, which is why this lives here rather than
 * in `e2e/`. The browser spec proves that pressing the key opens the console; these are the
 * cases a browser could only reach by staging twelve sessions - running out of slots,
 * crossing a tone boundary, a hidden card claiming nothing - and each of them is a
 * one-line arrangement of ids.
 */

/** The shape `boardColumns` has: a column per tone, in reading order. */
function columns(...cols: string[][]): string[][] {
  return cols;
}

test("slots are handed out down the board and ACROSS its columns", () => {
  // The claim the feature makes and the one a per-column counter would break: the numbering
  // does not restart when the reader's eye moves to the next status.
  const assigned = assignCardShortcuts(columns(["needs-a", "needs-b"], ["work-a"], ["idle-a"]));
  assert.deepEqual([...assigned], [
    ["needs-a", "cmd+1"],
    ["needs-b", "cmd+2"],
    ["work-a", "cmd+3"],
    ["idle-a", "cmd+4"],
  ]);
});

test("the twelve keys are the number row as it is spelled on the keyboard", () => {
  // 1-9, then 0, then the two keys that continue the row. NOT 1-12: the affordance is
  // "press the key over the card's number", and there is no `10` key to press.
  assert.deepEqual([...CARD_SHORTCUT_KEYS], [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=",
  ]);
  assert.equal(CARD_SHORTCUT_KEYS.length, 12);
});

test("the slots run out rather than wrapping", () => {
  // A thirteenth card with a chord nobody can press would be worse than one with none.
  const ids = Array.from({ length: 15 }, (_, i) => `s${i}`);
  const assigned = assignCardShortcuts(columns(ids));
  assert.equal(assigned.size, 12);
  assert.equal(assigned.get("s11"), "cmd+=");
  assert.equal(assigned.get("s12"), undefined);
  // And the twelve went to the twelve HIGHEST-priority cards, which is what makes running
  // out acceptable: the cards a shortcut is worth having on are at the top of the board.
  assert.deepEqual(
    [...assigned.keys()],
    ids.slice(0, 12),
  );
});

test("a card nobody can see claims no slot", () => {
  // `boardColumns` has already dropped what a folded repository frame is hiding, so the
  // rule this pins is that the assignment does not go looking for those sessions again -
  // slot 2 belongs to the next VISIBLE card, and no key addresses a hidden one.
  const assigned = assignCardShortcuts(columns(["shown-a", "shown-b"]));
  assert.deepEqual([...assigned.values()], ["cmd+1", "cmd+2"]);
  assert.equal(cardShortcutTarget("cmd+3", assigned), null);
});

test("empty columns are skipped without spending a key", () => {
  // A board with an empty `working` column must not give ⌘2 to nothing and start `idle` at
  // ⌘3 - the keycaps would then read 1, 3, 4 down the screen.
  const assigned = assignCardShortcuts(columns(["a"], [], ["b"], [], []));
  assert.deepEqual([...assigned], [["a", "cmd+1"], ["b", "cmd+2"]]);
});

test("a keypress resolves to the card printing that key, and to nothing else", () => {
  const assigned = assignCardShortcuts(columns(["a", "b"], ["c"]));
  assert.equal(cardShortcutTarget("cmd+2", assigned), "b");
  // Not ours: an unassigned slot, a bare digit, and the shifted key that shares ⌘='s cap.
  // Each has to answer null rather than "no card", because the caller's next move is to
  // leave the keystroke to the browser instead of swallowing it.
  assert.equal(cardShortcutTarget("cmd+9", assigned), null);
  assert.equal(cardShortcutTarget("1", assigned), null);
  assert.equal(cardShortcutTarget("cmd++", assigned), null);
  assert.equal(cardShortcutTarget("", assigned), null);
});

test("an empty board claims no key at all", () => {
  const assigned = assignCardShortcuts(columns());
  assert.equal(assigned.size, 0);
  for (const chord of CARD_SHORTCUT_CHORDS) {
    assert.equal(cardShortcutTarget(chord, assigned), null, `${chord} was claimed`);
  }
});

test("every chord is one a keypress can actually produce", () => {
  // The bug this exists to catch is a chord spelled in the wrong grammar - `meta+1` rather
  // than `cmd+1` - which typechecks, prints a plausible keycap and never matches a keydown.
  // So each chord is round-tripped through the SAME function App's handler normalizes with.
  for (const key of CARD_SHORTCUT_KEYS) {
    const event = { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    assert.equal(
      chordFromEvent(event as unknown as KeyboardEvent),
      cardShortcutChord(key),
      `⌘${key} does not normalize to the chord the card prints`,
    );
  }
});

test("no slot collides with grid navigation, and each prints and announces itself", () => {
  for (const chord of CARD_SHORTCUT_CHORDS) {
    assert.equal(isReservedChord(chord), false, `${chord} is reserved for navigation`);
    // The keycap on the card, and the WAI-ARIA spelling on the button it drives. Both are
    // asserted because they are read by different people and produced by different helpers.
    assert.match(formatChord(chord), /^⌘[0-9=-]$/);
    assert.match(ariaKeyshortcuts(chord) ?? "", /^Meta\+[0-9=-]$/);
  }
});

test("no rebindable action ships with a chord these twelve would shadow", () => {
  // The one real collision risk, and it is between two registries rather than inside either.
  // These chords are fixed and are dispatched ahead of the selection actions, so a DEFAULT
  // binding that landed on one of them would be an action that silently stopped working on
  // the Board. An operator who rebinds onto one is their own business; a shipped default is
  // ours.
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/lib/keybindings.ts", import.meta.url)),
    "utf8",
  );
  const claimed = new Set(CARD_SHORTCUT_CHORDS);
  for (const [, chord] of source.matchAll(/defaultBinding:\s*"([^"]+)"/g)) {
    assert.equal(claimed.has(chord!), false, `${chord} is both a default binding and a card slot`);
  }
});
