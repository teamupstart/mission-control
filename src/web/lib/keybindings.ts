// Customizable keyboard shortcuts.
//
// The grid's global keys (drive/act on the selected card, open the overlays) all
// live here as an editable registry rather than being hard-coded in App. Each
// action resolves to a *chord* - a canonical string like "s", "cmd+k", "/", or
// "shift+Tab" - that both the runtime handler and the settings editor compare
// against. Overrides are stored in the daemon (`app_config.ui.keybindings`), per machine,
// via the shared config store in `./uiConfig.ts`; this file keeps no copy of them, and
// only derives the resolved chord map. A lightweight external store lets every reader
// (the key handler, the command bar, the settings panel) stay in lockstep without
// prop-drilling.
//
// They lived in localStorage until the Mission Control rename reset them: that store is
// keyed by origin and by Electron profile, and the rename changed both. See
// docs/plans/ui-settings-to-daemon/plan.md.

import { useCallback, useSyncExternalStore } from "react";
import { subscribeUiConfig, uiConfig, updateUiConfig, useUiConfig } from "./uiConfig.ts";

export type ActionId =
  | "fleet"
  | "roundup"
  | "dispatch"
  | "filter"
  | "settingsSearch"
  | "contextMenu"
  | "workflows"
  | "runs"
  | "expand"
  | "conversation"
  | "findInConversation"
  | "diff"
  | "files"
  | "openDiffFile"
  | "sessionWorkflows"
  | "filePicker"
  | "send"
  | "terminal"
  | "agent"
  | "focus"
  | "handoff"
  | "queue"
  | "mode"
  | "rename"
  | "complete"
  | "kill"
  | "interrupt"
  | "reset";

export interface ActionDef {
  id: ActionId;
  label: string;
  description: string;
  /** Canonical chord used until the user rebinds it (see chordFromEvent). */
  defaultBinding: string;
  /** "global" fires anywhere on the grid; "selection" needs a selected card. */
  group: "global" | "selection";
}

// Order here is the order shown in the settings panel.
export const ACTIONS: readonly ActionDef[] = [
  {
    id: "fleet",
    label: "Open Fleet",
    description: "Show the fleet of running sessions.",
    defaultBinding: "f",
    group: "global",
  },
  {
    // Named "workflows" before the authoring surfaces became the Library, and the id keys
    // persisted overrides in `app_config.ui.keybindings` - so it stays put while the label
    // moves on, exactly as "roundup" did when its panel became the Sitrep. Renaming it here
    // would silently reset every operator's rebinding of this key.
    id: "workflows",
    label: "Open Library",
    description: "Open the Library of workflows, Personas and actions.",
    defaultBinding: "w",
    group: "global",
  },
  {
    id: "runs",
    label: "Open Workflow Runs",
    description: "Show live and finished workflow runs.",
    defaultBinding: "r",
    group: "global",
  },
  {
    // Named "roundup" before the panel became the Sitrep. The id keys persisted
    // overrides in localStorage, so it stays put while the label moves on.
    id: "roundup",
    label: "Toggle Sitrep",
    description: "Open or close the sitrep.",
    defaultBinding: "shift+p",
    group: "global",
  },
  {
    id: "dispatch",
    label: "Dispatch an agent",
    description: "Open the form to launch or queue a new agent.",
    defaultBinding: "+",
    group: "global",
  },
  {
    id: "filter",
    label: "Focus filter",
    description: "Jump to the filter box to narrow the grid.",
    defaultBinding: "/",
    group: "global",
  },
  {
    // The ⌘K palette. `defaultBinding` is "cmd+k", not "meta+k": this codebase's chord
    // grammar spells the Command/Meta modifier `cmd` (see `chordFromEvent`, which emits it
    // from `e.metaKey`), so "meta+k" would never match a keypress. Global, because it opens
    // over whatever page you are on.
    //
    // The id stays `settingsSearch` while the label moves on, exactly as `roundup` did when
    // its panel became the Sitrep and `workflows` did when its page became the Library: it
    // keys persisted overrides in `app_config.ui.keybindings`, so renaming it here would
    // silently reset every operator's rebinding of ⌘K.
    id: "settingsSearch",
    label: "Search everything",
    description: "Open the palette over workflows, runs, ensembles, missions and settings.",
    defaultBinding: "cmd+k",
    group: "global",
  },
  {
    id: "contextMenu",
    label: "Open context menu",
    description: "Show the actions for the focused item or text field.",
    defaultBinding: "shift+F10",
    group: "global",
  },
  {
    // The id predates the Board's in-place workflow disclosure and is persisted in
    // `app_config.ui.keybindings`, so keep it stable while narrowing what the action means.
    id: "expand",
    label: "Toggle workflow details",
    description:
      "Show or collapse the selected Board card's full workflow without opening its session detail.",
    defaultBinding: "e",
    group: "selection",
  },
  {
    // First in the tab strip, so first of the four tab chords here - this list is the
    // order the settings panel shows. `g` because the obvious letters are actions of
    // their own: `c` completes a task and `t` opens its terminal launcher.
    id: "conversation",
    label: "Open conversation",
    description: "Show the selected session's conversation.",
    defaultBinding: "g",
    group: "selection",
  },
  {
    // The one chord in this list nobody has to learn. It is also the only shape that
    // works from inside the reply box: App's typing guard lets a chord through only
    // when it carries a command modifier, so a bare letter could not open find while
    // the cursor was in a half-written reply - which is exactly when you want it.
    // `/` is the fleet filter and `cmd+k` is the settings palette, so neither was free.
    id: "findInConversation",
    label: "Find in conversation",
    description: "Search the selected session's conversation, and step between matches.",
    defaultBinding: "cmd+f",
    group: "selection",
  },
  {
    id: "diff",
    label: "Open diff",
    description: "Show the working diff for the selected session.",
    defaultBinding: "d",
    group: "selection",
  },
  {
    id: "files",
    label: "Open files",
    description: "Open the file editor for the expanded or console session.",
    defaultBinding: "shift+f",
    group: "selection",
  },
  {
    id: "openDiffFile",
    label: "Open in Files",
    description: "Open the currently displayed diff file in the Files tab.",
    defaultBinding: "l",
    group: "selection",
  },
  {
    // The detail's Workflows tab: this session's workflow ladder,
    // which used to stack above the transcript and push it off the screen. Distinct from
    // the global `workflows` action above - that one opens the fleet-wide Workflows PAGE,
    // this reveals one session's run. `y` because every letter either verb owns is taken;
    // `w` is the Library page and the tab chords already spent `g`, `d` and Shift+F.
    id: "sessionWorkflows",
    label: "Open session workflows",
    description: "Show the selected session's workflow ladder.",
    defaultBinding: "y",
    group: "selection",
  },
  {
    id: "filePicker",
    label: "Find a file",
    description: "Search the selected session's checkout and open a file.",
    defaultBinding: "shift+o",
    group: "selection",
  },
  {
    id: "send",
    label: "Send message",
    description: "Compose and send a message to the selected session.",
    defaultBinding: "s",
    group: "selection",
  },
  {
    id: "terminal",
    label: "Open terminal",
    description: "Open a terminal shell in the selected session's worktree.",
    defaultBinding: "t",
    group: "selection",
  },
  {
    id: "agent",
    label: "Open Codex / Claude",
    description: "Focus or reopen the selected session's Codex or Claude conversation.",
    defaultBinding: "a",
    group: "selection",
  },
  {
    id: "focus",
    label: "Focus pane",
    description: "Bring the selected session's terminal pane to the front.",
    defaultBinding: "p",
    group: "selection",
  },
  {
    // Shift+T keeps this beside the terminal launcher semantically now that Shift+P opens
    // Sitrep. This action makes a terminal-backed continuation for an embedded session; it
    // does nothing on a session that already has a pane.
    id: "handoff",
    label: "Continue in terminal",
    description:
      "Hand the selected Agent SDK session to a terminal, continuing the same conversation.",
    defaultBinding: "shift+t",
    group: "selection",
  },
  {
    id: "queue",
    label: "Toggle work queue",
    description: "Show or hide the selected session's work queue.",
    defaultBinding: "q",
    group: "selection",
  },
  {
    id: "mode",
    label: "Cycle permission mode",
    description: "Cycle the selected Claude session's permission mode (Shift+Tab).",
    defaultBinding: "shift+Tab",
    group: "selection",
  },
  {
    id: "rename",
    label: "Rename session",
    description: "Rename the selected session's terminal home (Shift+R).",
    defaultBinding: "shift+r",
    group: "selection",
  },
  {
    // Immediately BEFORE the Complete/Kill pair, never between them: those two are the ways
    // a session ENDS and their adjacency is deliberate. This is the answer that is short of
    // both - stop what it is doing, keep everything else - so it reads as the first rung of
    // the same ladder, in the panel and in the button row that follows this order.
    //
    // ⌃C, which is the gesture in the two TUIs this app drives, and NOT the byte those
    // TUIs receive: Ctrl+C into a pane clears the composer and, twice, quits the CLI. The
    // dashboard chord and the wire mechanism are separate on purpose (see
    // `HarnessCapabilities.interrupt`). It yields to a live text selection, because ⌃C is
    // also copy on Windows and Linux and the Electron shell inherits that - see
    // `chordYieldsToSelection`, which App's keydown handler consults ahead of every
    // dispatch path.
    id: "interrupt",
    label: "Interrupt turn",
    description: "Stop what the selected session is doing now and drop its queued messages.",
    defaultBinding: "ctrl+c",
    group: "selection",
  },
  {
    // Sits immediately before Kill, in both this list and the panel it orders, because
    // the pair is the point: they are the two ways a session ends, and the whole reason
    // Complete exists is that Kill was the only one. An operator who finished the work
    // and reached for the nearest button got a task nothing could ever satisfy.
    id: "complete",
    label: "Complete task",
    description: "Mark the selected session's task done and close the session.",
    defaultBinding: "c",
    group: "selection",
  },
  {
    id: "kill",
    label: "Kill session",
    description: "Request termination of the selected session.",
    defaultBinding: "k",
    group: "selection",
  },
  {
    id: "reset",
    label: "Reset checkout",
    description: "Reset the selected session's checkout to origin and clear its context.",
    defaultBinding: "ctrl+r",
    group: "selection",
  },
];

const ACTION_BY_ID = new Map<ActionId, ActionDef>(ACTIONS.map((a) => [a.id, a]));

// Keys the grid reserves for structural navigation. They can't be reassigned,
// because the handler acts on them unconditionally (Esc peels back a layer;
// arrows walk the grid regardless of modifiers), so a binding here could never win.
//
// Enter is reserved for a slightly different reason: it opens the board's selected tile,
// and everywhere else it is the browser's own "activate the focused control". A binding
// on it would work in some layouts and silently not in others, which is the one promise
// the shortcut table makes.
const RESERVED_KEYS = new Set([
  "Escape",
  "Enter",
  "ContextMenu",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

const MOD_TOKENS = ["cmd", "ctrl", "alt", "shift"] as const;

/**
 * Canonical chord for a keydown: modifier tokens (cmd/ctrl/alt/shift) joined by
 * "+" ahead of the key. Returns null for a lone modifier press so key capture can
 * keep waiting for a real key.
 *
 * Whether shift is a modifier depends on whether the key is *cased*:
 *
 * - A cased character (a letter) only changes case under shift, so shift is a real
 *   modifier: Shift+O is "shift+o", distinct from a bare "o". That asymmetry is
 *   what makes a shift+letter binding expressible at all - and it cuts both ways:
 *   Shift+S is "shift+s" and so no longer triggers "s" (send), Shift+K no longer
 *   kills, and so on. Deliberate.
 * - An uncased character comes out of the keyboard *different* under shift ("+"
 *   from Shift+= on a US layout, "?" from Shift+/), so shift stays baked into the
 *   character and is never emitted as a token - "+" and "/" bind as themselves.
 * - A named key (Tab, Enter) has no character to bake shift into, so shift is a
 *   modifier there too: "shift+Tab".
 */
export function chordFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("cmd");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  let key: string;
  if (k.length === 1 && !isCased(k)) {
    key = k;
  } else {
    key = k.length === 1 ? k.toLowerCase() : k;
    if (e.shiftKey) mods.push("shift");
  }
  return [...mods, key].join("+");
}

/** True for a character whose case shift merely flips (i.e. a letter). */
function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

/**
 * Split a canonical chord back into modifiers + key. Done by peeling known
 * "<mod>+" prefixes rather than splitting on "+", so a chord whose key *is* "+"
 * (e.g. "cmd++" or a bare "+") parses correctly.
 */
function parseChord(chord: string): { mods: string[]; key: string } {
  let rest = chord;
  const mods: string[] = [];
  let matched = true;
  while (matched) {
    matched = false;
    for (const m of MOD_TOKENS) {
      const prefix = `${m}+`;
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        mods.push(m);
        rest = rest.slice(prefix.length);
        matched = true;
        break;
      }
    }
  }
  return { mods, key: rest };
}

const MOD_SYMBOL: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "↵",
  Tab: "⇥",
  " ": "Space",
  Backspace: "⌫",
  Delete: "⌦",
  ContextMenu: "☰",
};

/** Human-readable form of a chord for keycaps and the editor (e.g. "⌘K", "⇧O", "⇥", "/"). */
export function formatChord(chord: string): string {
  if (!chord) return "";
  const { mods, key } = parseChord(chord);
  const modStr = mods.map((m) => MOD_SYMBOL[m] ?? m).join("");
  // A modified letter reads as the keycap convention it's written in everywhere
  // else ("⌘K", "⇧O"), while a bare letter stays as typed ("k").
  if (mods.length > 0 && key.length === 1 && isCased(key)) return modStr + key.toUpperCase();
  return modStr + (KEY_LABEL[key] ?? key);
}

/** True when a chord targets a reserved navigation key and so can't be bound. */
export function isReservedChord(chord: string): boolean {
  return chord === "Tab" || RESERVED_KEYS.has(parseChord(chord).key);
}

/**
 * True when a chord carries a Command or Control modifier (⌘/⌃).
 *
 * Those are the chords a global shortcut may fire from inside a text field without eating
 * the operator's typing: ⌘K is unambiguous mid-sentence, but a bare `k` - or even a
 * Shift/Alt combo, which just types a character - is not. A handler that bypasses the
 * usual "don't act while typing" guard should gate that bypass on this, so a rebinding to
 * a plain key stays behind the guard.
 */
export function chordHasCommandModifier(chord: string): boolean {
  const { mods } = parseChord(chord);
  return mods.includes("cmd") || mods.includes("ctrl");
}

/** True when a chord uses a standard function key, which has no text-editing behavior. */
export function chordUsesFunctionKey(chord: string): boolean {
  const { key } = parseChord(chord);
  return /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
}

/**
 * Whether a keypress must be handed back to the browser because it is a copy in progress.
 *
 * The interrupt chord defaults to ⌃C, which on Windows and Linux - and so in the Electron
 * shell, which inherits the platform's editing keys - is also Copy. The rule the plan
 * settled on is that a live selection wins: while text is selected the browser keeps the
 * keystroke, and otherwise it stops the agent.
 *
 * Its CALLER's placement is the part that matters, and it is why this takes a flat record
 * instead of reading the DOM. App's `typing` guard is true only for focus inside an
 * editable field, so the selections this has to protect are mostly NOT typing: a transcript
 * line, a diff hunk, captured terminal output. Those reach the action-bar dispatch, which
 * calls `preventDefault()` unconditionally. So the check belongs in ONE gate ahead of every
 * dispatch path rather than inside the composer bypass, where it would look sufficient and
 * would break the single most common copy in the app.
 *
 * Two kinds of selection, because they are held in two places and a check that knew about
 * only one would break the other's copy. `documentSelection` is what
 * `window.getSelection()` reports, which covers ordinary and contenteditable text and is
 * EMPTY for a selection inside an `<input>` or `<textarea>`; `fieldSelection` is that
 * field's own span, which is how a half-selected draft in the composer keeps its ⌃C.
 *
 * Scoped to the interrupt chord alone. Nothing else in the registry is a platform editing
 * key, and yielding every chord to a stray selection would make shortcuts fail for reasons
 * an operator could not see.
 */
export function chordYieldsToSelection(input: {
  chord: string;
  /** The resolved interrupt chord; empty when the action could not claim one. */
  interruptChord: string;
  /** `window.getSelection()?.toString() ?? ""` at the call site. */
  documentSelection: string;
  /** The focused field's own selection span, or null when focus is not in one. */
  fieldSelection: { start: number | null; end: number | null } | null;
}): boolean {
  if (!input.interruptChord || input.chord !== input.interruptChord) return false;
  if (input.documentSelection.length > 0) return true;
  const field = input.fieldSelection;
  if (!field || field.start === null || field.end === null) return false;
  return field.start !== field.end;
}

// ---- store ----------------------------------------------------------------

type Overrides = Partial<Record<ActionId, string>>;

/**
 * Keep only known actions with non-empty chords that actually differ from the default,
 * dropping anything an older/newer build (or a hand-edit) left behind.
 *
 * Applied on every read rather than once at load, because the source is now the shared
 * config store and can be replaced under us by a hydrate. It is also why the daemon's
 * schema keeps `keybindings` a loose record: a build that RETIRED an action must be able
 * to read a config that still mentions it, and drop it here, rather than fail to parse.
 */
function sanitize(raw: Record<string, string>): Overrides {
  const clean: Overrides = {};
  for (const a of ACTIONS) {
    const v = raw[a.id];
    if (typeof v === "string" && v && v !== a.defaultBinding && !isReservedChord(v)) {
      clean[a.id] = v;
    }
  }
  return clean;
}

function currentOverrides(): Overrides {
  return sanitize(uiConfig().keybindings);
}

/**
 * Stored overrides claim chords before defaults so a newly shipped default never
 * displaces an operator's existing choice. Within each pass registry order breaks
 * malformed legacy/hand-edited ties; an action that cannot claim its stored chord or
 * default stays unset.
 */
function computeResolved(overrides: Overrides): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>;
  const claimed = new Set<string>();
  for (const a of ACTIONS) out[a.id] = "";
  for (const a of ACTIONS) {
    const chord = overrides[a.id];
    if (!chord || claimed.has(chord)) continue;
    out[a.id] = chord;
    claimed.add(chord);
  }
  for (const a of ACTIONS) {
    if (overrides[a.id] || claimed.has(a.defaultBinding)) continue;
    out[a.id] = a.defaultBinding;
    claimed.add(a.defaultBinding);
  }
  return out;
}

export function resolveKeybindings(raw: Record<string, string>): Record<ActionId, string> {
  return computeResolved(sanitize(raw));
}

export interface ResetBindingPreview {
  binding: string;
  owner: ActionId | null;
}

export function previewResetBinding(
  raw: Record<string, string>,
  id: ActionId,
): ResetBindingPreview {
  const next = sanitize(raw);
  delete next[id];
  const bindings = computeResolved(next);
  const binding = bindings[id];
  const defaultBinding = ACTION_BY_ID.get(id)?.defaultBinding;
  const owner =
    !binding && defaultBinding
      ? (ACTIONS.find((action) => bindings[action.id] === defaultBinding)?.id ?? null)
      : null;
  return { binding, owner };
}

/**
 * Write the overrides through to the daemon. This store holds NO copy of them - the
 * shared config store is the only one - so there is nothing here to keep in step, and a
 * rebind made in one surface cannot be stale in another.
 */
function commit(next: Overrides): void {
  void updateUiConfig({ keybindings: next as Record<string, string> });
}

/** Rebind an action to an unclaimed chord; an available own default clears the override. */
export function setBinding(id: ActionId, chord: string): void {
  const def = ACTION_BY_ID.get(id);
  if (!def) return;
  const next: Overrides = { ...currentOverrides() };
  if (bindingValidationError(computeResolved(next), id, chord)) return;
  if (chord === def.defaultBinding) delete next[id];
  else next[id] = chord;
  commit(next);
}

/** Drop one override; the action returns to its default when that chord is available. */
export function resetBinding(id: ActionId): void {
  const overrides = currentOverrides();
  if (!(id in overrides)) return;
  const next: Overrides = { ...overrides };
  delete next[id];
  commit(next);
}

/** Restore every action to its default. */
export function resetAll(): void {
  if (Object.keys(currentOverrides()).length === 0) return;
  commit({});
}

/**
 * For a resolved binding map, the set of actions each action collides with (two
 * actions sharing a chord). Empty for anything unique.
 */
export function findConflicts(bindings: Record<ActionId, string>): Map<ActionId, ActionId[]> {
  const byChord = new Map<string, ActionId[]>();
  for (const a of ACTIONS) {
    const chord = bindings[a.id];
    if (!chord) continue;
    const arr = byChord.get(chord) ?? [];
    arr.push(a.id);
    byChord.set(chord, arr);
  }
  const conflicts = new Map<ActionId, ActionId[]>();
  for (const ids of byChord.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) conflicts.set(id, ids.filter((x) => x !== id));
  }
  return conflicts;
}

export function bindingValidationError(
  bindings: Record<ActionId, string>,
  id: ActionId,
  chord: string,
): string | null {
  if (isReservedChord(chord)) {
    return `${formatChord(chord)} is reserved for grid navigation.`;
  }
  const owner = findConflicts({ ...bindings, [id]: chord }).get(id)?.[0];
  if (!owner) return null;
  return `${formatChord(chord)} is already bound to ${ACTION_BY_ID.get(owner)?.label ?? owner}.`;
}

export interface KeybindingsApi {
  /** Resolved chord per action, or empty when its stored chord/default cannot be claimed. */
  bindings: Record<ActionId, string>;
  /** Whether an action has a stored override. */
  isCustom: (id: ActionId) => boolean;
  /** Whether any action has a stored override. */
  hasCustom: boolean;
  previewReset: (id: ActionId) => ResetBindingPreview;
}

// Stable references for useSyncExternalStore so it doesn't re-subscribe on every
// render (an inline arrow would delete + re-add the listener each commit).
const subscribe = subscribeUiConfig;

// The resolved map is cached against the identity of the record it was derived from, so
// useSyncExternalStore keeps getting the SAME reference until the overrides actually
// move. Rebuilding per call would return a fresh object every time and loop the render.
// Identity is the right key because the config store never mutates in place - every
// change commits a new object.
let cachedSource: Record<string, string> | null = null;
let cachedSnapshot: Record<ActionId, string> = resolveKeybindings({});

function getSnapshot(): Record<ActionId, string> {
  const source = uiConfig().keybindings;
  if (source !== cachedSource) {
    cachedSource = source;
    cachedSnapshot = resolveKeybindings(source);
  }
  return cachedSnapshot;
}

/**
 * Whether a button that a shortcut also drives prints that shortcut on its face.
 *
 * The chords were only ever discoverable from the settings panel and a handful of
 * tooltips, so the keycaps go on the buttons themselves and this is the switch that
 * takes them back off. It lives beside the bindings rather than in its own module
 * because it answers a question about them, and every keycap reads both.
 *
 * Deliberately does NOT reach the command bar: that strip is nothing BUT keycaps, so
 * hiding them leaves a row of unlabelled verbs rather than a tidier one.
 *
 * Stored in the daemon (`app_config.ui.keybindingHints`), per machine, like the
 * overrides above.
 */
export function useKeybindingHints(): [boolean, (on: boolean) => void] {
  const on = useUiConfig().keybindingHints;
  const set = useCallback((next: boolean) => {
    void updateUiConfig({ keybindingHints: next });
  }, []);
  return [on, set];
}

/** Live view of the resolved bindings; re-renders on any rebind/reset. */
export function useKeybindings(): KeybindingsApi {
  const bindings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const source = uiConfig().keybindings;
  const overrides = sanitize(source);
  const isCustom = useCallback(
    (id: ActionId) => Object.hasOwn(overrides, id),
    [overrides],
  );
  const hasCustom = Object.keys(overrides).length > 0;
  const previewReset = useCallback(
    (id: ActionId) => previewResetBinding(source, id),
    [source],
  );
  return { bindings, isCustom, hasCustom, previewReset };
}
