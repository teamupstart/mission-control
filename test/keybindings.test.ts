import { test } from "node:test";
import assert from "node:assert/strict";

// What is at stake: a rebind has to actually leave the machine now.
//
// Overrides used to be this store's own localStorage key. They are the daemon's
// (`app_config.ui.keybindings`), reached through the shared config store, because
// localStorage is keyed by ORIGIN and by Electron profile and the product rename moved
// both - which silently reset every custom chord. localStorage survives only as a
// first-paint cache. So this file stands up both halves before importing: an in-memory
// localStorage (Node's built-in throws without a backing file, and the cache would
// swallow that as "storage unavailable"), and a fetch stub standing in for the daemon.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

/** Every config PUT the store made, in order. The rebind's real destination. */
const puts: Array<Record<string, unknown>> = [];
/** Flip to make the daemon refuse the next write, so the revert path is reachable. */
let daemonAccepts = true;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT" && path === "/api/ui/config") {
      puts.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
    }
    return Promise.resolve({
      ok: daemonAccepts,
      status: daemonAccepts ? 200 : 400,
      json: () => Promise.resolve(daemonAccepts ? {} : { error: "refused" }),
    });
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

/**
 * The overrides as mirrored into the first-paint cache (defaults are never written).
 *
 * The cache is what the next cold load paints from, so it is the observable side of a
 * rebind; `sent()` covers the durable side. Both, because a rebind that updates one and
 * not the other is exactly the bug this whole change exists to remove.
 */
function stored(): Partial<Record<ActionId, string>> {
  const cached = JSON.parse(store.get("mission-control.ui") ?? "{}") as {
    keybindings?: Partial<Record<ActionId, string>>;
  };
  return cached.keybindings ?? {};
}

/** The overrides in the most recent PUT to the daemon. */
function sent(): Partial<Record<ActionId, string>> {
  return (puts.at(-1)?.keybindings ?? {}) as Partial<Record<ActionId, string>>;
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
  assert.equal(sent().reset, "cmd+Backspace", "the rebind never reached the daemon");
  assert.equal(chordFromEvent(key("Backspace", { meta: true })), "cmd+Backspace");

  resetBinding("reset");
  assert.equal(stored().reset, undefined, "reset-to-default left an override behind");
  // The absence has to be PUT too. A patch that merged per-key would make dropping an
  // override unexpressible, since dropping one is exactly an absent key.
  assert.equal(sent().reset, undefined, "the daemon was never told to drop the override");

  // Rebinding straight back to the default is a no-op, not a stored override.
  setBinding("reset", "ctrl+r");
  assert.equal(stored().reset, undefined);

  setBinding("reset", "cmd+Backspace");
  resetAll();
  assert.deepEqual(stored(), {}, "reset-all left overrides behind");
  assert.deepEqual(sent(), {}, "reset-all never reached the daemon");
});

test("a rebind the daemon refuses is taken back, not left on screen", async () => {
  // The chord governs what the runtime handler fires on, so a control showing a binding
  // the daemon rejected is worse than one that never moved: the key would do nothing.
  setBinding("filter", "cmd+1");
  assert.equal(stored().filter, "cmd+1");

  daemonAccepts = false;
  try {
    setBinding("filter", "cmd+2");
    // The optimistic write lands first; the revert is a microtask behind the response.
    assert.equal(stored().filter, "cmd+2", "the optimistic write should be immediate");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(stored().filter, "cmd+1", "a refused rebind was left showing");
  } finally {
    daemonAccepts = true;
  }

  resetAll();
});

test("rebinding reset onto another action's chord is reported as a conflict", () => {
  const conflicts = findConflicts({ ...defaults(), reset: defaults().kill });
  assert.deepEqual(conflicts.get("reset"), ["kill"]);
  assert.deepEqual(conflicts.get("kill"), ["reset"]);
});
