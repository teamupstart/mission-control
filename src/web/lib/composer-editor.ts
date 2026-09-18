// The full-size editor's keystroke and legend decisions, kept out of `TranscriptPanel` so
// they are functions of a chord alone and testable without a browser.

import { chordSurvivesTyping, formatChord } from "./keybindings.ts";

/**
 * Whether a keystroke inside a composer asked for the full-size editor.
 *
 * `chordSurvivesTyping` re-checks what `typingUnsafeChordReason` already enforces on every
 * stored binding, because this is the call site a leak would harm: a binding that slipped
 * through - an older build's config, a future default - would open a dialog on an ordinary
 * character, with nothing on screen to explain why.
 *
 * `chord` is `chordFromEvent`'s answer, so a lone modifier press (null) never matches.
 */
export function composerEditorRequested(
  chord: string | null,
  binding: string,
  event?: { altGraph?: boolean },
): boolean {
  if (!chord || !binding) return false;
  // AltGr, answered exactly. Windows and Linux report it as Ctrl+Alt, and on many layouts it
  // TYPES - AltGr+Q is `@` on a German keyboard. `chordMayBeAltGraph` refuses the whole
  // Ctrl+Alt shape when a binding is recorded, because a chord is a string by then and the
  // question cannot be answered; here the keystroke is still in hand, so ask it. Without
  // this, a stored Ctrl+Alt binding from an older build would still swallow that character.
  if (event?.altGraph) return false;
  return chord === binding && chordSurvivesTyping(binding);
}

/**
 * Whether a keystroke inside the editor asked to stage what is written there.
 *
 * ⌘Enter, or ⌃Enter on a keyboard with no Command key. Plain Enter must stay a newline -
 * this box exists for multi-line messages - which is why staging needs a chord at all.
 *
 * `isComposing` guards the IME candidate commit, which is the same keystroke on a Japanese,
 * Chinese or Korean keyboard.
 */
export function composerEditorStages(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  return e.metaKey || e.ctrlKey;
}

/**
 * Just the expand clause, for a composer that teaches its other keys elsewhere. Empty when
 * the action has no chord, so the caller renders nothing rather than a legend with a hole.
 */
export function composerExpandHint(expandChord: string): string {
  const expand = formatChord(expandChord);
  return expand ? `${expand} expands` : "";
}

/**
 * The terminal rendering's full key legend, built from the RESOLVED chord so a rebinding
 * moves the hint with it.
 *
 * Only terminal takes the whole list, and the constraint is height: it rides in a one-line
 * prompt row with room beside it, while chat's row is a two-line box. Putting the list on
 * its own line under chat costs the transcript log ~20px, which is a share
 * `console-tabs-toolbar.spec.ts` measures - so chat keeps teaching Enter, Shift+Enter and
 * images through its placeholder and takes only `composerExpandHint` beside Send.
 */
export function composerKeysHint(expandChord: string): string {
  const expand = composerExpandHint(expandChord);
  return ["enter sends", "shift+enter newline", expand || null, "drop images"]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * The editor's footer legend.
 *
 * Names BOTH staging modifiers rather than only ⌘. `composerEditorStages` accepts either,
 * and a legend that said ⌘ alone told every Windows and Linux reader about a key their
 * keyboard does not have while withholding the one that works for them.
 */
export const COMPOSER_EDITOR_KEYS_HINT =
  "⌘/⌃enter stages it in the send box · esc discards";
