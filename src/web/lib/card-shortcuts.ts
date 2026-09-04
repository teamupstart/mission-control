/**
 * ⌘1 … ⌘9, ⌘0, ⌘-, ⌘= - jump straight into a Board card's console.
 *
 * The board answers "which of these needs me" at a glance and then charges an arrow-key
 * walk, or a mouse, to act on the answer. These twelve chords are the missing half: the
 * card you already read is one keystroke from its open conversation.
 *
 * POSITIONAL, not persistent. A slot belongs to a place on the board, never to a session,
 * so the numbering is handed out fresh from the live order on every render - a completed
 * card leaves and everything below it moves up a key. That is what "the shortcuts refresh
 * as cards finish" means, and it is why this is a derivation rather than stored state:
 * anything durable would have to be invalidated by every session event on the fleet, and
 * would be stale in exactly the seconds after a completion when it is reached for.
 *
 * NOT in `keybindings.ts`, and the difference is the point. That registry binds one chord
 * to one action and lets an operator rebind it; these twelve address a POSITION, so there
 * is no per-chord action to name in a settings row and nothing an operator could
 * meaningfully rebind - ⌘4 means "the fourth card" or it means nothing. They are switched
 * on and off as a whole, with the keycap they print, through the Board card's own display
 * registry (`board-card.ts`, item `cardShortcut`).
 *
 * ---
 *
 * WHO OWNS THESE KEYS, and the decision taken on it. This is the one thing about this
 * module that is not a free choice, so it is written down rather than discovered.
 *
 * All twelve are also shortcuts in a WEB BROWSER'S OWN CHROME: on macOS ⌘1…⌘9 select a tab
 * and ⌘0/⌘-/⌘= reset, shrink and enlarge the page. A browser resolves its window shortcuts
 * itself, and which of them it lets a page cancel is the browser's decision and differs
 * between them - there is no page-JavaScript answer to it at all. App's handler calls
 * `preventDefault()`, so where a browser offers the page the choice the jump wins; where a
 * browser reserves the key, the browser wins and the jump does not happen.
 *
 * That splits by surface, and the split is honest rather than hidden:
 *
 * - The PACKAGED DESKTOP APP is where all twelve are ours, and where the operator asked for
 *   them. It has no tabs to select, and `src/main/menu-template.ts` spells out the View menu
 *   so its zoom items keep working from the menu while giving up ⌘0/⌘-/⌘=. That file's
 *   `RENDERER_OWNED_ACCELERATORS` is the same decision from the menu's side, and
 *   `test/app-menu-template.test.ts` holds it.
 * - A PLAIN BROWSER TAB gets the same keys and the same keycaps, and any of them its browser
 *   reserves stay the browser's.
 *
 * The alternative was a second chord vocabulary for the browser - ⌃-digit, say - so that a
 * keycap always named a key that surface could not lose. It was declined: it would print a
 * different key on the same card depending on how the dashboard was opened, teach two sets
 * of muscle memory for one gesture, and trade a shortcoming that is visible the first time
 * you press a key for a permanent inconsistency. The escape hatch for an operator who wants
 * their browser's keys back is the item's own checkbox, which takes the chords down with the
 * keycaps. `docs/ui.md` states all of this where an operator reads it.
 */

/**
 * The keys, in the order the board hands them out.
 *
 * The number row as it is spelled on the keyboard - `1` through `0`, then the two keys
 * that continue the row - rather than 1-12, because the whole affordance is "press the key
 * over the card's number" and there is no `10` key to press.
 */
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

/**
 * Hand out the slots over the board's columns, in reading order.
 *
 * Takes the SAME `boardColumns` arrays the arrow keys walk - a column per tone, already
 * narrowed to what is on screen - so the numbering crosses statuses exactly as a reader's
 * eye does: the first card in **needs you** is ⌘1 and the count carries on into **working**
 * and **idle** rather than restarting per column. A session a folded repository frame is
 * hiding is not in those arrays and so claims no slot, which is the same rule navigation
 * follows: a chord must not open a card nobody can see.
 *
 * Runs out rather than wraps. A fleet with more than twelve visible cards gives the twelve
 * slots to the twelve highest-priority cards and leaves the rest with no keycap, which is
 * honest - a thirteenth card with a chord nobody can press would be worse than a card that
 * plainly has none.
 */
export function assignCardShortcuts(
  columns: readonly (readonly string[])[],
): ReadonlyMap<string, string> {
  const assigned = new Map<string, string>();
  let next = 0;
  for (const column of columns) {
    for (const id of column) {
      if (next >= CARD_SHORTCUT_KEYS.length) return assigned;
      // A duplicate id would silently burn a slot on a card that already has one. It cannot
      // happen from `boardColumns` - a session sits in exactly one tone group - but the
      // guard costs nothing and keeps the invariant local to this function.
      if (assigned.has(id)) continue;
      assigned.set(id, cardShortcutChord(CARD_SHORTCUT_KEYS[next]!));
      next += 1;
    }
  }
  return assigned;
}

/**
 * Which session a keypress addresses, or null when the chord is not one of ours.
 *
 * Reverse lookup over the assignment rather than a second index: the map holds at most
 * twelve entries, and one derivation means the key printed on a card and the key that opens
 * it cannot come to disagree. Null for every chord outside the set, and for a slot no card
 * currently holds, so the caller leaves the keystroke to the browser instead of swallowing
 * it.
 */
export function cardShortcutTarget(
  chord: string,
  assigned: ReadonlyMap<string, string>,
): string | null {
  for (const [id, bound] of assigned) if (bound === chord) return id;
  return null;
}

/** Shared empty assignment, so a board with the feature off allocates nothing per render. */
export const NO_CARD_SHORTCUTS: ReadonlyMap<string, string> = new Map();
