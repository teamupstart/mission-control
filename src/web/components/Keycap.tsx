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
 * Renders NOTHING when hints are off - not an empty element - so a host laid out with
 * `gap` closes up rather than keeping a hole where the keycap was.
 *
 * Not every bound action gets one. Very small buttons (the settings gear, the sitrep
 * glyph, the expand chevron, the rename ✓/✕) carry their chord in the tooltip instead:
 * a keycap on a 24px icon is bigger than the icon. The command bar is the other
 * exception - see `useKeybindingHints`.
 */
export function Keycap({ action }: { action: ActionId }): React.JSX.Element | null {
  const { bindings } = useKeybindings();
  const [show] = useKeybindingHints();
  const chord = formatChord(bindings[action]);
  if (!show || !chord) return null;
  return <kbd className="kb-hint">{chord}</kbd>;
}
