import type { ActionId } from "../lib/keybindings.ts";
import { formatChord, useKeybindingHints, useKeybindings } from "../lib/keybindings.ts";

/**
 * The shortcut a button is also bound to, printed on the button's face.
 *
 * ONE component for every such button, rather than a `<kbd>` per call site, because
 * three things have to agree at each of them and only one of them is local: the
 * RESOLVED chord (an operator may have rebound it, and a stale keycap teaches the
 * wrong key), the show/hide preference, and the markup the stylesheet targets. A
 * hand-rolled `<kbd>{formatChord(bindings.diff)}</kbd>` satisfies the first and
 * silently opts out of the second - which is exactly what the console footer's five
 * buttons used to do.
 *
 * Renders NOTHING when hints are off or the action is unset - not an empty element - so
 * a host laid out with `gap` closes up rather than keeping a hole where the keycap was.
 *
 * Not every bound action gets one. Very small buttons (the settings gear, the expand
 * chevron, the rename ✓/✕) carry their chord in the tooltip instead:
 * a keycap on a 24px icon is bigger than the icon. The command bar is the other
 * exception - see `useKeybindingHints`.
 */
export function Keycap(
  props:
    | { action: ActionId }
    /**
     * A chord this component cannot look up, given directly.
     *
     * For the one kind of shortcut the rebindable registry does not hold: the Board card's
     * ⌘1 … ⌘= jump keys, which address a POSITION rather than an action and so have no
     * `ActionId` to resolve (see `lib/card-shortcuts.ts`). Everything else this component
     * owns still applies, which is the whole reason the case lives here instead of in a
     * hand-rolled `<kbd>` on the tile: the hint preference and the markup stay one fact,
     * and turning keycaps off turns this one off too.
     */
    | { chord: string },
): React.JSX.Element | null {
  const { bindings } = useKeybindings();
  const [show] = useKeybindingHints();
  const chord = formatChord("action" in props ? bindings[props.action] : props.chord);
  if (!show || !chord) return null;
  return <kbd className="kb-hint" aria-hidden="true">{chord}</kbd>;
}
