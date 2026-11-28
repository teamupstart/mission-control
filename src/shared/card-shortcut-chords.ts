export const CARD_SHORTCUT_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
  "-",
  "=",
] as const;

/**
 * The canonical chord for one slot key, in `chordFromEvent`'s grammar.
 *
 * `cmd`, not `meta`: this codebase spells the Command/Meta modifier `cmd` (see
 * `keybindings.ts`), so a chord built any other way would never match a keypress. Every
 * chord here carries a command modifier, which is also what makes these safe to fire from
 * inside a half-written reply - the same rule `chordHasCommandModifier` states for ⌘K.
 */
export function cardShortcutChord(key: string): string {
  return `cmd+${key}`;
}

/** Every chord this module can hand out, for the guards that need the whole set. */
export const CARD_SHORTCUT_CHORDS: readonly string[] = CARD_SHORTCUT_KEYS.map(cardShortcutChord);
