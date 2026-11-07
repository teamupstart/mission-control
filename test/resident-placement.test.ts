import assert from "node:assert/strict";
import test from "node:test";

import type { Tone } from "../src/web/lib/format.ts";
import { detailSessionLookup, residentPlacement } from "../src/web/lib/resident-placement.ts";
import { RESIDENT_SHORTCUT_CHORDS, chordFromEvent, isReservedChord, residentShortcutIndex } from "../src/web/lib/keybindings.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const tones: Record<string, Tone> = { calm: "idle", busy: "working", asking: "attention" };
const toneOf = (id: string): Tone | null => tones[id] ?? null;
const residentIds = ["calm", "busy", "asking"];

function place(over: Partial<Parameters<typeof residentPlacement>[0]> = {}) {
  const { excluded, visitors } = residentPlacement({
    placement: "drawer",
    residentIds,
    toneOf,
    drawerOpen: false,
    openDetailId: null,
    ...over,
  });
  return { excluded: [...excluded].sort(), visitors: [...visitors].sort() };
}

test("Board and Console placement leaves every resident on the fleet", () => {
  assert.deepEqual(place({ placement: "fleet" }), { excluded: [], visitors: [] });
  // Whatever the drawer or the open detail say: the fleet placement has no drawer to defer to.
  assert.deepEqual(place({ placement: "fleet", drawerOpen: true, openDetailId: "asking" }), { excluded: [], visitors: [] });
});

test("Drawer placement takes every resident off the fleet except one that needs you", () => {
  assert.deepEqual(place(), { excluded: ["busy", "calm"], visitors: ["asking"] });
});

test("an open or pinned drawer already shows the ask, so there is no visitor card", () => {
  assert.deepEqual(place({ drawerOpen: true }), { excluded: ["asking", "busy", "calm"], visitors: [] });
});

test("a resident whose own detail is open is not its own visitor, and leaves the fleet", () => {
  assert.deepEqual(place({ openDetailId: "asking" }), { excluded: ["asking", "busy", "calm"], visitors: [] });
  // Another resident's open detail does not withhold this one's card.
  assert.deepEqual(place({ openDetailId: "calm" }), { excluded: ["busy", "calm"], visitors: ["asking"] });
});

test("the card returns once the detail closes, and leaves once the ask is answered", () => {
  assert.deepEqual(place({ openDetailId: null }).visitors, ["asking"]);
  const answered = residentPlacement({
    placement: "drawer",
    residentIds,
    toneOf: (id) => (id === "asking" ? "working" : toneOf(id)),
    drawerOpen: false,
    openDetailId: null,
  });
  assert.equal(answered.visitors.size, 0);
  assert.ok(answered.excluded.has("asking"));
});

test("a resident whose session is gone is simply kept off the fleet", () => {
  assert.deepEqual(place({ residentIds: ["missing"] }), { excluded: ["missing"], visitors: [] });
});

const fleetSession = mkSession({ id: "task-1", name: "Fleet task" });
const residentSession = mkSession({ id: "res-1", name: "Triage" });
const sessions = [fleetSession, residentSession];
const isResident = (id: string): boolean => id === "res-1";

test("the detail lookup reads the fleet list first", () => {
  assert.equal(
    detailSessionLookup({ id: "task-1", fleet: [fleetSession], sessions, placement: "drawer", isResident }),
    fleetSession,
  );
  assert.equal(detailSessionLookup({ id: null, fleet: [fleetSession], sessions, placement: "drawer", isResident }), null);
});

test("in Drawer placement it falls back to the open resident, which no fleet list holds", () => {
  assert.equal(
    detailSessionLookup({ id: "res-1", fleet: [fleetSession], sessions, placement: "drawer", isResident }),
    residentSession,
  );
});

test("it never falls back for a session that is not a resident, or in Board and Console placement", () => {
  const filteredOut = mkSession({ id: "task-2", name: "Filtered" });
  const all = [...sessions, filteredOut];
  assert.equal(
    detailSessionLookup({ id: "task-2", fleet: [fleetSession], sessions: all, placement: "drawer", isResident }),
    null,
  );
  assert.equal(
    detailSessionLookup({ id: "res-1", fleet: [fleetSession], sessions, placement: "fleet", isResident }),
    null,
  );
});

test("⌥1 … ⌥9 match the physical digit key, with no other modifier", () => {
  const key = (code: string, mods: Partial<Record<"altKey" | "metaKey" | "ctrlKey" | "shiftKey", boolean>> = {}) =>
    residentShortcutIndex({ code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });
  assert.equal(key("Digit1"), 0);
  assert.equal(key("Digit9"), 8);
  assert.equal(key("Digit0"), null);
  assert.equal(key("KeyA"), null);
  assert.equal(key("Digit3", { altKey: false }), null);
  assert.equal(key("Digit3", { metaKey: true }), null);
  assert.equal(key("Digit3", { ctrlKey: true }), null);
  assert.equal(key("Digit3", { shiftKey: true }), null);
});

test("⌥1 … ⌥9 are reserved from rebinding", () => {
  for (let n = 1; n <= 9; n += 1) assert.ok(isReservedChord(`alt+${n}`), `alt+${n} is bindable`);
  for (const chord of RESIDENT_SHORTCUT_CHORDS) assert.ok(isReservedChord(chord), `${chord} is bindable`);
  assert.equal(isReservedChord("alt+0"), false);
});

test("macOS Option+digit records as the reserved digit chord, not the symbol it types", () => {
  // What a US-layout Mac delivers for ⌥1 and ⌥9: a symbol `key`, the digit's physical `code`.
  const press = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
    chordFromEvent({ key, code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, ...mods } as KeyboardEvent);
  assert.equal(press("¡", "Digit1"), "alt+1");
  assert.equal(press("ª", "Digit9"), "alt+9");
  assert.ok(isReservedChord(press("¡", "Digit1")!), "the Keyboard panel could record ⌥1 for an action");
  // Linux and Windows already deliver the digit; the spelling is the same.
  assert.equal(press("1", "Digit1"), "alt+1");
  // Another modifier with it is a different chord, and is left as the key it types.
  assert.equal(press("⁄", "Digit1", { shiftKey: true }), "alt+⁄");
  // A plain digit, or Option on a non-digit key, is untouched.
  assert.equal(chordFromEvent({ key: "1", code: "Digit1", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false } as KeyboardEvent), "1");
  assert.equal(press("å", "KeyA"), "alt+å");
});

test("an Option+digit binding stored as its macOS symbol is reserved, so it is dropped on read", () => {
  for (const symbol of ["¡", "™", "£", "¢", "∞", "§", "¶", "•", "ª"]) {
    assert.ok(isReservedChord(`alt+${symbol}`), `alt+${symbol} is bindable`);
  }
});
