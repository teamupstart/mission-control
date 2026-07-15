// Customizable keyboard shortcuts.
//
// The grid's global keys (drive/act on the selected card, open the overlays) all
// live here as an editable registry rather than being hard-coded in App. Each
// action resolves to a *chord* - a canonical string like "s", "cmd+k", "/", or
// "shift+Tab" - that both the runtime handler and the settings editor compare
// against. Overrides persist per-machine in localStorage, mirroring the alert
// settings; a lightweight external store lets every reader (the key handler, the
// command bar, the settings panel) stay in lockstep without prop-drilling.

import { useCallback, useSyncExternalStore } from "react";

export type ActionId =
  | "roundup"
  | "dispatch"
  | "filter"
  | "expand"
  | "diff"
  | "send"
  | "focus"
  | "mode"
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
    id: "roundup",
    label: "Toggle Roundup",
    description: "Open or close the fleet report.",
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
    defaultBinding: "f",
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
const RESERVED_KEYS = new Set(["Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

const MOD_TOKENS = ["cmd", "ctrl", "alt", "shift"] as const;

/**
 * Canonical chord for a keydown: modifier tokens (cmd/ctrl/alt, plus shift only
 * for named keys) joined by "+" ahead of the key. A printable character already
 * bakes shift into itself ("?" not "shift+/"), and letters are lower-cased so case
 * never matters. Returns null for a lone modifier press so key capture can keep
 * waiting for a real key.
 */
export function chordFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("cmd");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  let key: string;
  if (k.length === 1) {
    key = k.toLowerCase();
  } else {
    key = k;
    if (e.shiftKey) mods.push("shift");
  }
  return [...mods, key].join("+");
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

/** Human-readable form of a chord for keycaps and the editor (e.g. "⌘K", "⇥", "/"). */
export function formatChord(chord: string): string {
  if (!chord) return "";
  const { mods, key } = parseChord(chord);
  const modStr = mods.map((m) => MOD_SYMBOL[m] ?? m).join("");
  return modStr + (KEY_LABEL[key] ?? key);
}

/** True when a chord targets a reserved navigation key and so can't be bound. */
export function isReservedChord(chord: string): boolean {
  return RESERVED_KEYS.has(parseChord(chord).key);
}

// ---- store ----------------------------------------------------------------

const STORAGE_KEY = "fleet-control.keybindings";
type Overrides = Partial<Record<ActionId, string>>;

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Overrides;
    // Keep only known actions with non-empty string chords, dropping anything an
    // older/newer build (or a hand-edit) left behind.
    const clean: Overrides = {};
    for (const a of ACTIONS) {
      const v = parsed[a.id];
      if (typeof v === "string" && v && v !== a.defaultBinding) clean[a.id] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

let overrides: Overrides = loadOverrides();
const listeners = new Set<() => void>();

// A cached snapshot so useSyncExternalStore gets a stable reference between
// changes (rebuilt only when overrides actually move).
function computeResolved(): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>;
  for (const a of ACTIONS) out[a.id] = overrides[a.id] ?? a.defaultBinding;
  return out;
}
let snapshot = computeResolved();

function commit(next: Overrides): void {
  overrides = next;
  snapshot = computeResolved();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* storage unavailable - keep in-memory only */
  }
  for (const l of listeners) l();
}

/** Rebind an action. Setting it back to its default clears the override. */
export function setBinding(id: ActionId, chord: string): void {
  const def = ACTION_BY_ID.get(id);
  if (!def) return;
  const next: Overrides = { ...overrides };
  if (chord === def.defaultBinding) delete next[id];
  else next[id] = chord;
  commit(next);
}

/** Drop the override for one action, restoring its default. */
export function resetBinding(id: ActionId): void {
  if (!(id in overrides)) return;
  const next: Overrides = { ...overrides };
  delete next[id];
  commit(next);
}

/** Restore every action to its default. */
export function resetAll(): void {
  if (Object.keys(overrides).length === 0) return;
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
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Record<ActionId, string> {
  return snapshot;
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
