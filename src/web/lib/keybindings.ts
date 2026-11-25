// Customizable keyboard shortcuts.
//
// The app's global keys (drive or act on the selected session, open the overlays) all
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
import { formatChord, isCased, parseChord } from "../../shared/keyboard-chords.ts";
export { formatChord };
import {
  ACTION_BY_ID, bindingValidationError, computeResolved, previewResetBinding, resolveKeybindings, sanitize, type ResetBindingPreview,
  type ActionId, type Overrides,
} from "@shared/keyboard-settings.ts";
export * from "@shared/keyboard-settings.ts";
import { subscribeUiConfig, uiConfig, updateUiConfig, useUiConfig } from "./uiConfig.ts";

export { chordFromEvent } from "../../shared/keyboard-chords.ts";

/** WAI-ARIA spelling of a canonical chord for `aria-keyshortcuts`. */
export function ariaKeyshortcuts(chord: string): string | undefined {
  if (!chord) return undefined;
  const { mods, key } = parseChord(chord);
  const ariaMods: Record<string, string> = {
    cmd: "Meta",
    ctrl: "Control",
    alt: "Alt",
    shift: "Shift",
  };
  const ariaKey = mods.includes("shift") && key.length === 1 && isCased(key)
    ? key.toUpperCase()
    : key;
  return [...mods.map((mod) => ariaMods[mod] ?? mod), ariaKey].join("+");
}

/**
 * Why a chord cannot be bound to an action, phrased to finish "⌘1 is reserved for …", or
 * null when it is bindable.
 *
 * Two kinds of reservation, and they are here together because a caller only ever wants the
 * one answer "can this be bound, and if not why not".
 *
 * The fleet's twelve session-jump chords are the second kind, and they are reserved for
 * exactly the reason `Enter` is above: App's jump arm runs ahead of the action dispatch, so an
 * action bound to ⌘4 keeps working on every other page, and with the display item switched
 * off, and silently stops working on the fleet - on either of its layouts, now that the
 * Console rail prints and answers the same keys. A binding that works in some places and not
 * others is the one promise this table makes, so the table refuses it rather than accepting a
 * chord it cannot honour. See `lib/card-shortcuts.ts`.
 *
 * Unconditional, deliberately - NOT gated on whether the operator has the card item on. What
 * this table accepts must not depend on a checkbox in another panel, or binding ⌘4 with the
 * item off would quietly become a shadowed binding the moment it was switched back on.
 */
/**
 * Which resident a keydown asks for, as a zero-based index, or null when it is not ⌥1 … ⌥9.
 *
 * Matched on `code`, the physical key, because `key` is a symbol under macOS Option. Any other
 * modifier held with it makes it a different chord, which this leaves alone.
 */
export function residentShortcutIndex(
  e: Pick<KeyboardEvent, "code" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">,
): number | null {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  const match = /^Digit([1-9])$/.exec(e.code);
  return match ? Number(match[1]) - 1 : null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select") !== null || target.isContentEditable;
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

function currentOverrides(): Overrides {
  return sanitize(uiConfig().keybindings);
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
