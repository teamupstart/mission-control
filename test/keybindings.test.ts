import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
  ariaKeyshortcuts,
  bindingValidationError,
  chordFromEvent,
  chordHasCommandModifier,
  chordUsesFunctionKey,
  findConflicts,
  formatChord,
  isReservedChord,
  resetAll,
  resetBinding,
  resolveKeybindings,
  setBinding,
} = await import("../src/web/lib/keybindings.ts");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { KeyboardPanel } = await import("../src/web/components/KeyboardPanel.tsx");
const { DeleteButton } = await import("../src/web/components/DeleteButton.tsx");
const { pageShortcutRoute } = await import("../src/web/workflows/useWorkflowRoute.ts");
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
  // The file-picker default only works because these differ; the flip side is that
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
  assert.equal(formatChord("shift+F10"), "⇧F10");
  assert.equal(formatChord("ContextMenu"), "☰");
  assert.equal(formatChord("cmd++"), "⌘+");
  assert.equal(formatChord("+"), "+");
  assert.equal(formatChord("/"), "/");
  assert.equal(formatChord("Escape"), "Esc");
  assert.equal(formatChord(""), "");
});

test("ARIA shortcuts use KeyboardEvent modifier names", () => {
  assert.equal(ariaKeyshortcuts("d"), "d");
  assert.equal(ariaKeyshortcuts("shift+d"), "Shift+d");
  assert.equal(ariaKeyshortcuts("cmd+ctrl+k"), "Meta+Control+k");
  assert.equal(ariaKeyshortcuts(""), undefined);
});

// ---- the action registry ----

test("no two actions ship with the same default binding", () => {
  assert.deepEqual([...findConflicts(defaults()).keys()], []);
});

test("Delete owns d by default and Diff stays available on Shift+D", () => {
  const remove = ACTIONS.find((action) => action.id === "delete");
  const diff = ACTIONS.find((action) => action.id === "diff");
  assert.equal(remove?.defaultBinding, "d");
  assert.equal(remove?.group, "selection");
  assert.equal(diff?.defaultBinding, "shift+d");
  assert.equal(chordFromEvent(key("d")), remove?.defaultBinding);
  assert.equal(chordFromEvent(key("D", { shift: true })), diff?.defaultBinding);
});

test("Delete buttons advertise the resolved binding and use the shared keycap", () => {
  const html = renderToStaticMarkup(createElement(DeleteButton, null, "Delete"));
  assert.match(html, /data-keybinding-action="delete"/);
  assert.match(html, /aria-keyshortcuts="d"/);
  assert.match(html, /<kbd class="kb-hint">d<\/kbd>/);
});

test("every current Delete surface uses the shared bound button", () => {
  const inventory = new Map([
    ["src/web/components/DispatchModal.tsx", 1],
    ["src/web/components/ReportPanel.tsx", 1],
    ["src/web/components/scouts/ScoutDeleteModal.tsx", 1],
    ["src/web/components/scouts/ScoutReader.tsx", 1],
    ["src/web/components/scouts/ScoutsPage.tsx", 1],
    ["src/web/ensembles/EnsembleActions.tsx", 1],
    ["src/web/ensembles/EnsembleDeleteModal.tsx", 1],
    ["src/web/workflows/WorkflowConfirmModal.tsx", 1],
    ["src/web/workflows/WorkflowLibrary.tsx", 1],
    ["src/web/workflows/WorkflowProperties.tsx", 2],
  ]);
  for (const [path, expected] of inventory) {
    const source = readFileSync(path, "utf8");
    assert.equal(
      source.match(/<DeleteButton\b/g)?.length ?? 0,
      expected,
      `${path} does not bind every Delete control through DeleteButton`,
    );
  }

  const app = readFileSync("src/web/App.tsx", "utf8");
  const activation = app.indexOf("activateDeleteShortcut(e.target)");
  assert.ok(
    activation >= 0 && activation < app.indexOf('if (route.page !== "fleet")', activation),
    "Delete must dispatch on every page before fleet-only shortcuts stand down",
  );
});

test("every default binding is bindable and round-trips through its chord form", () => {
  for (const a of ACTIONS) {
    assert.equal(isReservedChord(a.defaultBinding), false, `${a.id} defaults to a reserved key`);
    assert.notEqual(formatChord(a.defaultBinding), "", `${a.id} has no readable keycap`);
  }
});

test("chordHasCommandModifier flags only cmd/ctrl, so a text-field bypass is safe", () => {
  // The gate on the global search shortcut's typing-guard bypass: ⌘K / ⌃K may fire from
  // inside an input, but a bare key or a Shift/Alt combo (which just types a character)
  // must not. Getting this wrong is a rebound key opening the palette mid-word.
  assert.equal(chordHasCommandModifier("cmd+k"), true);
  assert.equal(chordHasCommandModifier("ctrl+r"), true);
  assert.equal(chordHasCommandModifier("cmd+shift+k"), true);
  assert.equal(chordHasCommandModifier("k"), false);
  assert.equal(chordHasCommandModifier("shift+o"), false);
  assert.equal(chordHasCommandModifier("alt+e"), false);
  assert.equal(chordHasCommandModifier("+"), false);
});

test("only function-key bindings bypass native behavior in a text field", () => {
  assert.equal(chordUsesFunctionKey("shift+F10"), true);
  assert.equal(chordUsesFunctionKey("cmd+F24"), true);
  assert.equal(chordUsesFunctionKey("ContextMenu"), false);
  assert.equal(chordUsesFunctionKey("shift+Tab"), false);
  assert.equal(chordUsesFunctionKey("Backspace"), false);
  assert.equal(chordUsesFunctionKey("Delete"), false);
  assert.equal(chordUsesFunctionKey("Home"), false);
  assert.equal(chordUsesFunctionKey("End"), false);
  assert.equal(chordUsesFunctionKey("cmd+k"), false);
  assert.equal(chordUsesFunctionKey("shift+o"), false);
});

test("bare Tab is reserved while modified Tab chords remain bindable", () => {
  assert.equal(isReservedChord("Tab"), true);
  assert.equal(isReservedChord("shift+Tab"), false);
  assert.equal(isReservedChord("ctrl+Tab"), false);
});

test("the dedicated ContextMenu key is structural while Shift+F10 remains bindable", () => {
  assert.equal(isReservedChord("ContextMenu"), true);
  assert.equal(isReservedChord("shift+F10"), false);
  assert.equal(chordFromEvent(key("ContextMenu")), "ContextMenu");
  assert.equal(chordFromEvent(key("F10", { shift: true })), "shift+F10");
});

test("file actions own Shift+F, Shift+O, and l and every default round-trips from a keypress", () => {
  const rename = ACTIONS.find((a) => a.id === "rename");
  const files = ACTIONS.find((a) => a.id === "files");
  const filePicker = ACTIONS.find((a) => a.id === "filePicker");
  const openDiffFile = ACTIONS.find((a) => a.id === "openDiffFile");
  assert.equal(files?.defaultBinding, "shift+f");
  assert.equal(filePicker?.defaultBinding, "shift+o");
  assert.equal(openDiffFile?.defaultBinding, "l");
  assert.equal(openDiffFile?.group, "selection");
  assert.equal(rename?.defaultBinding, "shift+r");
  // Every default binding must be something chordFromEvent can actually produce,
  // or the action would be unreachable.
  const producible = new Set([
    chordFromEvent(key("r")),
    chordFromEvent(key("r", { ctrl: true })),
    chordFromEvent(key("+", { shift: true })),
    chordFromEvent(key("/")),
    chordFromEvent(key("w")),
    chordFromEvent(key("e")),
    chordFromEvent(key("v")),
    chordFromEvent(key("g")),
    chordFromEvent(key("d")),
    chordFromEvent(key("D", { shift: true })),
    chordFromEvent(key("F", { shift: true })),
    chordFromEvent(key("O", { shift: true })),
    chordFromEvent(key("l")),
    chordFromEvent(key("s")),
    // Shift+S (Scouts), from the same "s" that sends. Both must be producible and they
    // must not collapse into one chord - the asymmetry that makes a shift+letter binding
    // expressible at all is exactly what this round trip is here to prove.
    chordFromEvent(key("S", { shift: true })),
    chordFromEvent(key("t")),
    chordFromEvent(key("a")),
    chordFromEvent(key("f")),
    chordFromEvent(key("p")),
    chordFromEvent(key("P", { shift: true })),
    chordFromEvent(key("T", { shift: true })),
    chordFromEvent(key("q")),
    chordFromEvent(key("y")),
    chordFromEvent(key("Tab", { shift: true })),
    chordFromEvent(key("R", { shift: true })),
    chordFromEvent(key("c")),
    // ⌃C. Produced from the same "c" the bare `complete` chord is, which is the point of
    // deriving this set from real keydowns rather than listing strings: the modifier has to
    // survive the round trip or the interrupt would be a shortcut nobody could press.
    chordFromEvent(key("c", { ctrl: true })),
    chordFromEvent(key("k")),
    chordFromEvent(key("k", { meta: true })),
    chordFromEvent(key("f", { meta: true })),
    chordFromEvent(key("F10", { shift: true })),
  ]);
  for (const a of ACTIONS) assert.ok(producible.has(a.defaultBinding), `${a.id} unreachable`);
});

test("context menu is one global action with Shift+F10 as its customizable chord", () => {
  const menu = ACTIONS.find((action) => action.id === "contextMenu");
  assert.ok(menu, "contextMenu missing from the customizable registry");
  assert.equal(menu.defaultBinding, "shift+F10");
  assert.equal(menu.group, "global");
  assert.equal(formatChord(menu.defaultBinding), "⇧F10");
});

test("Fleet, Library and Runs are separate global actions with direct bindings", () => {
  const fleet = ACTIONS.find((a) => a.id === "fleet");
  const library = ACTIONS.find((a) => a.id === "workflows");
  const runs = ACTIONS.find((a) => a.id === "runs");
  const sitrep = ACTIONS.find((a) => a.id === "roundup");
  assert.deepEqual(
    [fleet?.defaultBinding, library?.defaultBinding, runs?.defaultBinding],
    ["f", "w", "r"],
  );
  assert.deepEqual([fleet?.group, library?.group, runs?.group], ["global", "global", "global"]);
  assert.equal(chordFromEvent(key("f")), "f");
  assert.equal(chordFromEvent(key("w")), "w");
  assert.equal(chordFromEvent(key("r")), "r");
  assert.equal(sitrep?.defaultBinding, "shift+p");
  assert.equal(formatChord(sitrep?.defaultBinding ?? ""), "⇧P");
});

// ---- the direct page decision the App keydown handler runs ----
//
// The handler itself is a global keydown listener reaching refs through renders, which has
// no jsdom here to drive. `pageShortcutRoute` is the pure guard App feeds after matching one
// of the three page bindings, so the destination never depends on the page it was pressed on.
test("each page shortcut returns its named destination instead of toggling another", () => {
  const clear = { typing: false, renaming: false, overlayOpen: false } as const;
  assert.deepEqual(pageShortcutRoute({ target: "fleet", ...clear }), { page: "fleet" });
  assert.deepEqual(pageShortcutRoute({ target: "library", ...clear }), { page: "library" });
  assert.deepEqual(pageShortcutRoute({ target: "runs", ...clear }), { page: "runs" });
});

test("the page shortcuts stand down while typing, renaming, or an overlay is open", () => {
  const base = { target: "library" as const, typing: false, renaming: false, overlayOpen: false };
  assert.deepEqual(pageShortcutRoute(base), { page: "library" });
  assert.equal(pageShortcutRoute({ ...base, typing: true }), null);
  assert.equal(pageShortcutRoute({ ...base, renaming: true }), null);
  assert.equal(pageShortcutRoute({ ...base, overlayOpen: true }), null);
});

test("a non-page chord supplies no target and never navigates", () => {
  assert.equal(
    pageShortcutRoute({ target: null, typing: false, renaming: false, overlayOpen: false }),
    null,
  );
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

test("conversation is a first-class action defaulting to g on the selected card", () => {
  // The tab strip's first tab had no chord at all: Work queue, Diff and Files each print
  // one on their face and Conversation printed nothing, so the only way back to the
  // transcript was the mouse or Tab-walking the strip. It belongs in the registry rather
  // than hard-coded in App for the reason every entry here does - that is what makes it
  // rebindable in the settings editor and what puts the right keycap on the tab.
  const conversation = ACTIONS.find((a) => a.id === "conversation");
  assert.ok(conversation, "conversation missing from the customizable registry");
  assert.equal(conversation.defaultBinding, "g");
  assert.equal(conversation.group, "selection");
  assert.equal(chordFromEvent(key("g")), "g");
  assert.equal(formatChord(conversation.defaultBinding), "g");
});

test("every default binding is unique - a collision silently shadows one action", () => {
  // Two actions on one chord is not a compile error and not a runtime error: App's
  // handler simply matches the first branch and the second action becomes unreachable,
  // which looks exactly like a broken feature. Guarding the whole table rather than the
  // new entry, so the next one added is checked too.
  const seen = new Map<string, string>();
  for (const a of ACTIONS) {
    const already = seen.get(a.defaultBinding);
    assert.equal(
      already,
      undefined,
      `${a.id} and ${already} both default to "${a.defaultBinding}"`,
    );
    seen.set(a.defaultBinding, a.id);
  }
});

test("a stored override wins over a colliding new default", () => {
  const resolved = resolveKeybindings({ diff: "g" });
  assert.equal(resolved.diff, "g");
  assert.equal(resolved.conversation, "");
  assert.deepEqual([...findConflicts(resolved).keys()], []);
  assert.equal(resolveKeybindings({}).conversation, "g");
});

test("the editor rejects another action's chord and keeps the prior binding", () => {
  // `z`, not `v`: this needs a chord no action ships with, and `v` became the Board
  // workflow disclosure's default when the review queue took `e`.
  const bindings = { ...defaults(), conversation: "z", diff: "x" };
  assert.equal(
    bindingValidationError(bindings, "conversation", "x"),
    "x is already bound to Open diff.",
  );
  assert.equal(bindingValidationError(bindings, "conversation", "z"), null);

  resetAll();
  setBinding("conversation", "z");
  setBinding("diff", "x");
  const before = puts.length;
  setBinding("conversation", "x");
  assert.equal(puts.length, before);
  assert.equal(stored().conversation, "z");
  assert.equal(stored().diff, "x");
  resetAll();
});

test("reset copy reflects whether the default will be restored", async () => {
  await updateUiConfig({ keybindings: { conversation: "z" } });
  const freeDefault = renderToStaticMarkup(createElement(KeyboardPanel));
  assert.match(freeDefault, /Reset Open conversation to g/);
  assert.match(freeDefault, /aria-label="Reset Open conversation to default"/);

  await updateUiConfig({ keybindings: { conversation: "z", diff: "g" } });
  const claimedDefault = renderToStaticMarkup(createElement(KeyboardPanel));
  assert.match(
    claimedDefault,
    /Clear z - g is taken by Open diff, so this stays unset/,
  );
  assert.match(
    claimedDefault,
    /aria-label="Clear Open conversation z; g is taken by Open diff, so Open conversation stays unset"/,
  );
  resetAll();
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

test("complete is a first-class action defaulting to c, and sits just before kill", () => {
  // The pair is the point. Kill was for a long time the only way to end a session, so
  // an operator who had FINISHED the work still reached for it - and the task settled
  // as failed, blocking everything declared to wait on it. Complete is the other door,
  // and the ordering here is what puts it next to Kill in the settings panel (array
  // order is panel order) rather than somewhere else in the list.
  const complete = ACTIONS.find((a) => a.id === "complete");
  assert.ok(complete, "complete missing from the customizable registry");
  assert.equal(complete.defaultBinding, "c");
  assert.equal(complete.group, "selection");
  assert.equal(chordFromEvent(key("c")), "c");
  assert.equal(formatChord(complete.defaultBinding), "c");
  assert.equal(
    ACTIONS.findIndex((a) => a.id === "complete") + 1,
    ACTIONS.findIndex((a) => a.id === "kill"),
  );
});

test("settings search is a global action defaulting to ⌘K, and it rebinds and resets", () => {
  const search = ACTIONS.find((a) => a.id === "settingsSearch");
  assert.ok(search, "settingsSearch missing from the customizable registry");
  assert.equal(search.group, "global");
  // "cmd+k", not "meta+k": the chord grammar spells the Meta modifier `cmd`, so a real ⌘K
  // keydown produces this and the handler matches it. "meta+k" would be a dead shortcut.
  assert.equal(search.defaultBinding, "cmd+k");
  assert.equal(chordFromEvent(key("k", { meta: true })), "cmd+k");
  assert.equal(formatChord(search.defaultBinding), "⌘K");

  // Rebind to another chord and back to default, the way the Keyboard panel drives it.
  setBinding("settingsSearch", "cmd+shift+k");
  assert.equal(stored().settingsSearch, "cmd+shift+k");
  assert.equal(sent().settingsSearch, "cmd+shift+k");
  resetBinding("settingsSearch");
  assert.equal(stored().settingsSearch, undefined);
  assert.equal(sent().settingsSearch, undefined);
});

// ---- the override store ----

test("persisted reserved chords are dropped while modified Tab survives", async () => {
  await updateUiConfig({ keybindings: { filter: "Tab", send: "shift+Tab" } });
  setBinding("reset", "cmd+Backspace");
  assert.equal(sent().filter, undefined);
  assert.equal(sent().send, "shift+Tab");

  const before = puts.length;
  setBinding("filter", "Tab");
  assert.equal(puts.length, before);
  resetAll();
});

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

test("handoff is a first-class selection action, bound as the terminal launcher's Shift", () => {
  // A registry entry rather than a hard-coded key, which is also what puts it in the
  // settings editor and on the button's own face. Shift+T pairs it with Open terminal now
  // that Shift+P belongs to Sitrep.
  const handoff = ACTIONS.find((a) => a.id === "handoff");
  assert.ok(handoff, "handoff missing from the customizable registry");
  assert.equal(handoff.defaultBinding, "shift+t");
  assert.equal(handoff.group, "selection");
  const focus = ACTIONS.indexOf(ACTIONS.find((a) => a.id === "focus")!);
  assert.equal(ACTIONS.indexOf(handoff), focus + 1, "it reads next to focus in the panel");
});

test("the conversation launchers are customizable selection actions", () => {
  const terminal = ACTIONS.find((a) => a.id === "terminal");
  const agent = ACTIONS.find((a) => a.id === "agent");
  assert.ok(terminal, "terminal launcher missing from the customizable registry");
  assert.ok(agent, "agent launcher missing from the customizable registry");
  assert.equal(terminal.defaultBinding, "t");
  assert.equal(agent.defaultBinding, "a");
  assert.equal(terminal.group, "selection");
  assert.equal(agent.group, "selection");
  assert.equal(ACTIONS.indexOf(agent), ACTIONS.indexOf(terminal) + 1);
});
