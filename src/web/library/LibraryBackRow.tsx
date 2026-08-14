import { Tooltip } from "../components/Tooltip.tsx";
import { useKeybindingHints } from "../lib/keybindings.ts";

/**
 * The visible way out of a Library authoring surface.
 *
 * Pinned above the rail's own heading in all four rails, first in reading order and never
 * scrolled away with the asset list. Before this, the only control on a detail screen that
 * navigated back to `#/library` was the topbar's Library segment - already painted
 * `aria-current`, so it reads as the page you are ON rather than the way out of it.
 *
 * It owns no navigation of its own. `onLeave` is App's router call, so this row and the
 * Escape ladder leave by exactly one path and a dirty draft raises exactly one dialog.
 *
 * `esc` rides on the face rather than only in the tooltip, because the keystroke is the
 * thing a person could not have guessed - and it is gated on the keybinding-hints
 * preference like every other `.kb-hint` in the app, so an operator who turned chord caps
 * off does not get one here that nothing can hide. The accessible name is fixed at "Back
 * to Library" either way: it says where the control goes rather than what glyph it draws,
 * and the Playwright specs select by it.
 */
export function LibraryBackRow({ onLeave }: { onLeave: () => void }): React.JSX.Element {
  const [showHints] = useKeybindingHints();
  return (
    <div className="lib-back-row">
      <Tooltip label="Back to the Library (Escape)">
        <button className="lib-back" aria-label="Back to Library" onClick={onLeave}>
          <span aria-hidden>←</span>
          <span>Library</span>
          {showHints && <kbd className="kb-hint">esc</kbd>}
        </button>
      </Tooltip>
    </div>
  );
}
