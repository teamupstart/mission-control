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
  return JSON.parse(store.get("mission-control.keybindings") ?? "{}");
}

// chordFromEvent only reads key + the modifier flags, so a literal is a complete
// fixture - no DOM needed.
function key(k: string, mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", true>> = {}) {
  return {
    key: k,
    metaKey: Boolean(mods.meta),
    ctrlKey: Boolean(mods.ctrl),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
  } as KeyboardEvent;
}

// ---- chordFromEvent (canonicalization) ----

test("shift is a modifier on a letter, so Shift+O and o are distinct chords", () => {
  assert.equal(chordFromEvent(key("O", { shift: true })), "shift+o");
  assert.equal(chordFromEvent(key("o")), "o");
});

test("a shifted letter does not collapse onto the bare letter's action", () => {
  // The rename default only works because these differ; the flip side is that
  // Shift+S no longer reaches "send".
  assert.equal(chordFromEvent(key("S", { shift: true })), "shift+s");
  assert.notEqual(chordFromEvent(key("S", { shift: true })), chordFromEvent(key("s")));
});

test("an uncased character keeps shift baked in", () => {
  // "+" is Shift+= on a US layout - the dispatch binding must stay "+".
  assert.equal(chordFromEvent(key("+", { shift: true })), "+");
  assert.equal(chordFromEvent(key("/")), "/");
  assert.equal(chordFromEvent(key("?", { shift: true })), "?");
});

test("a named key keeps shift as a modifier", () => {
  assert.equal(chordFromEvent(key("Tab", { shift: true })), "shift+Tab");
  assert.equal(chordFromEvent(key("Tab")), "Tab");
});

test("cmd/ctrl combos are unchanged", () => {
  assert.equal(chordFromEvent(key("k", { meta: true })), "cmd+k");
  assert.equal(chordFromEvent(key("K", { meta: true, shift: true })), "cmd+shift+k");
});

test("a lone modifier press yields no chord", () => {
  assert.equal(chordFromEvent(key("Shift", { shift: true })), null);
  assert.equal(chordFromEvent(key("Meta", { meta: true })), null);
});

// ---- formatChord (keycaps) ----

test("formatChord renders a modified letter as an upper-case keycap", () => {
  assert.equal(formatChord("shift+o"), "⇧O");
  assert.equal(formatChord("cmd+k"), "⌘K");
  assert.equal(formatChord("ctrl+r"), "⌃R");
  assert.equal(formatChord("alt+e"), "⌥E");
  assert.equal(formatChord("cmd+shift+k"), "⌘⇧K");
});

test("formatChord leaves an unmodified letter lower-case", () => {
  // The stock keycaps are bare letters and must keep reading as typed.
  assert.equal(formatChord("o"), "o");
  assert.equal(formatChord("s"), "s");
});

test("formatChord leaves uncased and named keys alone", () => {
  assert.equal(formatChord("shift+Tab"), "⇧⇥");
  assert.equal(formatChord("cmd++"), "⌘+");
  assert.equal(formatChord("+"), "+");
  assert.equal(formatChord("/"), "/");
  assert.equal(formatChord("Escape"), "Esc");
  assert.equal(formatChord(""), "");
});

// ---- the action registry ----

test("no two actions ship with the same default binding", () => {
  assert.deepEqual([...findConflicts(defaults()).keys()], []);
});

test("every default binding is bindable and round-trips through its chord form", () => {
  for (const a of ACTIONS) {
    assert.equal(isReservedChord(a.defaultBinding), false, `${a.id} defaults to a reserved key`);
    assert.notEqual(formatChord(a.defaultBinding), "", `${a.id} has no readable keycap`);
  }
});

test("rename defaults to Shift+O and every default round-trips from a keypress", () => {
  const rename = ACTIONS.find((a) => a.id === "rename");
  assert.equal(rename?.defaultBinding, "shift+o");
  // Every default binding must be something chordFromEvent can actually produce,
  // or the action would be unreachable.
  const producible = new Set([
    chordFromEvent(key("r")),
    chordFromEvent(key("r", { ctrl: true })),
    chordFromEvent(key("+", { shift: true })),
    chordFromEvent(key("/")),
    chordFromEvent(key("e")),
    chordFromEvent(key("d")),
    chordFromEvent(key("s")),
    chordFromEvent(key("f")),
    chordFromEvent(key("q")),
    chordFromEvent(key("Tab", { shift: true })),
    chordFromEvent(key("O", { shift: true })),
    chordFromEvent(key("k")),
  ]);
  for (const a of ACTIONS) assert.ok(producible.has(a.defaultBinding), `${a.id} unreachable`);
});

test("queue is a first-class action defaulting to q on the selected card", () => {
  // The work queue is hidden behind a disclosure now, so this chord is the only way to
  // reach it without the mouse - it has to be in the registry (which is also what puts
  // it in the settings editor) rather than hard-coded in App.
  const queue = ACTIONS.find((a) => a.id === "queue");
  assert.ok(queue, "queue missing from the customizable registry");
  assert.equal(queue.defaultBinding, "q");
  assert.equal(queue.group, "selection");
  assert.equal(chordFromEvent(key("q")), "q");
  assert.equal(formatChord(queue.defaultBinding), "q");
});

test("reset is a first-class action defaulting to Ctrl+R on the selected card", () => {
  const reset = ACTIONS.find((a) => a.id === "reset");
  assert.ok(reset, "reset missing from the customizable registry");
  assert.equal(reset.defaultBinding, "ctrl+r");
  assert.equal(reset.group, "selection");
  // The chord a real Ctrl+R keydown produces must be what the handler matches on.
  assert.equal(chordFromEvent(key("r", { ctrl: true })), "ctrl+r");
  assert.equal(chordFromEvent(key("R", { ctrl: true })), "ctrl+r");
  assert.equal(formatChord(reset.defaultBinding), "⌃R");
});

// ---- the override store ----

test("reset rebinds and returns to its default like any other action", () => {
  // The settings modal drives rebinds through exactly these calls.
  setBinding("reset", "cmd+Backspace");
  assert.equal(stored().reset, "cmd+Backspace");
  assert.equal(chordFromEvent(key("Backspace", { meta: true })), "cmd+Backspace");

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
