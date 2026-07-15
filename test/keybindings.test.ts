import { test } from "node:test";
import assert from "node:assert/strict";

// The store reads localStorage at import time and writes on every rebind. Node's
// built-in global exists but throws without a backing file, which the store would
// quietly swallow as "storage unavailable" - so stand up a real in-memory one
// first, then import, to keep the persisted overrides observable here.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const {
  ACTIONS,
  chordFromEvent,
  findConflicts,
  formatChord,
  isReservedChord,
  resetAll,
  resetBinding,
  setBinding,
} = await import("../src/web/lib/keybindings.ts");
type ActionId = (typeof ACTIONS)[number]["id"];

/** The resolved map the runtime handler and the settings editor both read. */
function defaults(): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>;
  for (const a of ACTIONS) out[a.id] = a.defaultBinding;
  return out;
}

/** The overrides the store persists per machine (defaults are never written). */
function stored(): Partial<Record<ActionId, string>> {
  return JSON.parse(store.get("fleet-control.keybindings") ?? "{}");
}

/** Enough of a KeyboardEvent for chordFromEvent, which only reads these fields. */
function keydown(over: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over } as KeyboardEvent;
}

test("no two actions ship with the same default binding", () => {
  assert.deepEqual([...findConflicts(defaults()).keys()], []);
});

test("every default binding is bindable and round-trips through its chord form", () => {
  for (const a of ACTIONS) {
    assert.equal(isReservedChord(a.defaultBinding), false, `${a.id} defaults to a reserved key`);
    assert.notEqual(formatChord(a.defaultBinding), "", `${a.id} has no readable keycap`);
  }
});

test("reset is a first-class action defaulting to Ctrl+R on the selected card", () => {
  const reset = ACTIONS.find((a) => a.id === "reset");
  assert.ok(reset, "reset missing from the customizable registry");
  assert.equal(reset.defaultBinding, "ctrl+r");
  assert.equal(reset.group, "selection");
  // The chord a real Ctrl+R keydown produces must be what the handler matches on.
  assert.equal(chordFromEvent(keydown({ key: "r", ctrlKey: true })), "ctrl+r");
  assert.equal(chordFromEvent(keydown({ key: "R", ctrlKey: true })), "ctrl+r");
  assert.equal(formatChord(reset.defaultBinding), "⌃r");
});

test("reset rebinds and returns to its default like any other action", () => {
  // The settings modal drives rebinds through exactly these calls.
  setBinding("reset", "cmd+Backspace");
  assert.equal(stored().reset, "cmd+Backspace");
  assert.equal(chordFromEvent(keydown({ key: "Backspace", metaKey: true })), "cmd+Backspace");

  resetBinding("reset");
  assert.equal(stored().reset, undefined, "reset-to-default left an override behind");

  // Rebinding straight back to the default is a no-op, not a stored override.
  setBinding("reset", "ctrl+r");
  assert.equal(stored().reset, undefined);

  setBinding("reset", "cmd+Backspace");
  resetAll();
  assert.deepEqual(stored(), {}, "reset-all left overrides behind");
});

test("rebinding reset onto another action's chord is reported as a conflict", () => {
  const conflicts = findConflicts({ ...defaults(), reset: defaults().kill });
  assert.deepEqual(conflicts.get("reset"), ["kill"]);
  assert.deepEqual(conflicts.get("kill"), ["reset"]);
});
