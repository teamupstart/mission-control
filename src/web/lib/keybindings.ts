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
import { subscribeUiConfig, uiConfig, updateUiConfig } from "./uiConfig.ts";

export type ActionId =
  | "roundup"
  | "dispatch"
  | "filter"
  | "expand"
  | "diff"
  | "files"
  | "filePicker"
  | "send"
  | "focus"
  | "queue"
  | "mode"
  | "rename"
  | "complete"
  | "kill"
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
    // Named "roundup" before the panel became the Sitrep. The id keys persisted
    // overrides in localStorage, so it stays put while the label moves on.
    id: "roundup",
    label: "Toggle Sitrep",
    description: "Open or close the sitrep.",
    defaultBinding: "r",
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
    id: "expand",
    label: "Expand / collapse",
    description: "Focus-expand the selected card, or collapse it.",
    defaultBinding: "e",
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
    defaultBinding: "f",
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
    id: "focus",
    label: "Focus pane",
    description: "Bring the selected session's terminal pane to the front.",
    defaultBinding: "p",
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
  return RESERVED_KEYS.has(parseChord(chord).key);
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
    if (typeof v === "string" && v && v !== a.defaultBinding) clean[a.id] = v;
  }
  return clean;
}

function currentOverrides(): Overrides {
  return sanitize(uiConfig().keybindings);
}

function computeResolved(overrides: Overrides): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>;
  for (const a of ACTIONS) out[a.id] = overrides[a.id] ?? a.defaultBinding;
  return out;
}

/**
 * Write the overrides through to the daemon. This store holds NO copy of them - the
 * shared config store is the only one - so there is nothing here to keep in step, and a
 * rebind made in one surface cannot be stale in another.
 */
function commit(next: Overrides): void {
  void updateUiConfig({ keybindings: next as Record<string, string> });
}

/** Rebind an action. Setting it back to its default clears the override. */
export function setBinding(id: ActionId, chord: string): void {
  const def = ACTION_BY_ID.get(id);
  if (!def) return;
  const next: Overrides = { ...currentOverrides() };
  if (chord === def.defaultBinding) delete next[id];
  else next[id] = chord;
  commit(next);
}

/** Drop the override for one action, restoring its default. */
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
    const arr = byChord.get(bindings[a.id]) ?? [];
    arr.push(a.id);
    byChord.set(bindings[a.id], arr);
  }
  const conflicts = new Map<ActionId, ActionId[]>();
  for (const ids of byChord.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) conflicts.set(id, ids.filter((x) => x !== id));
  }
  return conflicts;
}

export interface KeybindingsApi {
  /** Resolved chord per action (override or default). */
  bindings: Record<ActionId, string>;
  /** Whether an action currently differs from its default. */
  isCustom: (id: ActionId) => boolean;
  /** Whether any action differs from its default. */
  hasCustom: boolean;
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
let cachedSnapshot: Record<ActionId, string> = computeResolved({});

function getSnapshot(): Record<ActionId, string> {
  const source = uiConfig().keybindings;
  if (source !== cachedSource) {
    cachedSource = source;
    cachedSnapshot = computeResolved(sanitize(source));
  }
  return cachedSnapshot;
}

/** Live view of the resolved bindings; re-renders on any rebind/reset. */
export function useKeybindings(): KeybindingsApi {
  const bindings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isCustom = useCallback(
    (id: ActionId) => bindings[id] !== ACTION_BY_ID.get(id)?.defaultBinding,
    [bindings],
  );
  const hasCustom = ACTIONS.some((a) => bindings[a.id] !== a.defaultBinding);
  return { bindings, isCustom, hasCustom };
}
