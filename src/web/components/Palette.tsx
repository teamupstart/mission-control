import { useEffect, useId, useRef, useState } from "react";
import {
  nextPaletteKind,
  PALETTE_KIND_INFO,
  paletteRowHint,
  searchPalette,
  type PaletteKind,
  type PaletteStores,
  type PaletteTarget,
} from "../lib/palette-index.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The everything-palette: `⌘K` from anywhere, over the Library's assets, the Line's live
// runs and ensembles, the missions that file work, and every setting - grouped as Jump to /
// Do / Settings, each row carrying its kind and its state.
//
// It draws NOTHING it computed itself. Every row, its live-state line and its destination
// come from `lib/palette-index.ts`, which is a pure function of the SSE stores; this file is
// the listbox, the keyboard, and the chrome. That split is what lets the index be tested
// without a DOM and lets a future kind (sessions, tasks) arrive as a provider rather than as
// a branch in here.
//
// It is a screen-owning dialog, so it routes through the shared `<Overlay>` primitive - that
// registers it as open (the overlay contract: membership is not a hand-kept list), gives it
// the shared backdrop, and makes `esc` peel exactly one layer, which is what lets it open
// over a Line drawer without the drawer's Escape and this one both firing.
//
// NOT a compose box. It carries no draft, no attachments, and never registers itself as a
// reply box: it is a transient field, cleared every time it opens and gone on close.
//
// Its keys ride the input's bubble-phase `onKeyDown`, never a capture-phase window listener,
// so the Keyboard panel's chord recorder (a CAPTURE-phase listener) still wins while it is
// recording. The input's own Escape does `preventDefault` and closes, which is what stops
// the Settings page's bubble Escape-to-fleet from navigating out from under the palette;
// `Overlay`'s Escape is the shared backup.

export function Palette({
  open,
  onClose,
  onActivate,
  stores,
}: {
  /** Whether the palette is showing. App owns this; `⌘K` and the Settings rail box set it. */
  open: boolean;
  /** Close without acting (Escape, backdrop click, ⌘K again). */
  onClose: () => void;
  /**
   * Do what the row says. App owns every destination, because every one of them is App's
   * already: `navigate` for the routes, the dispatch and binding overlays, the missions
   * panel, and the settings anchor hand-off. The palette decides WHICH; App still decides
   * how, so there is exactly one implementation of each.
   *
   * Returns nothing: whether the palette should stay open is decided here (a toggle flips in
   * place; everything else closes first), not by the handler.
   */
  onActivate: (target: PaletteTarget) => void;
  /** The live SSE collections the providers read, plus the settings toggle bindings. */
  stores: PaletteStores;
}): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PaletteKind | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Fresh every open: a query and a kind filter left over from last time would be the palette
  // answering something the operator did not just ask. Focus follows, so the shortcut lands
  // you typing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setKind(null);
    setSel(0);
    inputRef.current?.focus();
  }, [open]);

  // Keep the selected row in view. The results pane scrolls at ~380px and a fleet with real
  // history indexes far more rows than that, so arrowing past the fold would otherwise move a
  // selection nobody can see. `nearest` rather than `center` so a short list does not jump.
  //
  // Keyed on what the OPERATOR drove, never on the stores: the rows re-derive on every SSE
  // message, and scrolling on those would yank the list back under someone reading it.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, sel, query, kind]);

  if (!open) return null;

  const { groups, rows, kinds } = searchPalette(query, stores, kind);
  // Clamp rather than store a clamped value: the result set shrinks as the query narrows, so
  // the live selection is always re-derived against the current rows.
  const active = rows.length === 0 ? -1 : Math.min(sel, rows.length - 1);
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  // Where each group starts in the flat `rows` list. `searchPalette` flattens the groups in
  // this same order, so a running offset gives every row its flat index without searching for
  // it - which keeps the render linear rather than quadratic on a fleet with real history.
  const groupOffsets: number[] = [];
  groups.reduce((offset, group) => {
    groupOffsets.push(offset);
    return offset + group.rows.length;
  }, 0);

  function move(delta: number): void {
    if (rows.length === 0) return;
    setSel((s) => Math.max(0, Math.min(rows.length - 1, Math.min(s, rows.length - 1) + delta)));
  }

  function activate(index: number): void {
    const row = rows[index];
    if (!row) return;
    if (row.target.kind === "toggle") {
      // Flip in place and stay open, exactly as the settings-only palette did. The switch
      // re-reads the binding on the next render, so a daemon round-trip that has not landed
      // shows honestly as "not moved yet" rather than an optimistic guess.
      onActivate(row.target);
      return;
    }
    // Close FIRST for everything else. A row that opens an overlay (Dispatch, the binding
    // dialog, Missions) would otherwise leave two screen-owning surfaces registered at once,
    // and the palette would be the topmost - so its Escape would close the palette and leave
    // the dialog the operator just asked for behind it.
    onClose();
    onActivate(row.target);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setSel(0);
        break;
      case "End":
        e.preventDefault();
        setSel(Math.max(0, rows.length - 1));
        break;
      case "Tab":
        // The kind filter, per the palette mockup. Taken from the browser's focus walk
        // because the dialog holds exactly one focusable field - there is nowhere for Tab to
        // go - and cycling back to "everything" is what makes it escapable with the same key.
        e.preventDefault();
        setKind((current) => nextPaletteKind(kinds, current));
        setSel(0);
        break;
      case "Enter":
        e.preventDefault();
        activate(active);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  const filter = kind ? PALETTE_KIND_INFO[kind] : null;

  return (
    <Overlay
      id={OVERLAY_IDS.palette}
      onClose={onClose}
      className="pal"
      role="dialog"
      ariaLabel="Search everything"
    >
      <div className="pal-in">
        <span className="pal-glass" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className="pal-input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          aria-label="Search everything"
          placeholder="Search workflows, runs, Personas, missions, settings…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
        {/* A filter you cannot see is a palette that appears to have lost your results, so it
            is stated beside the caret rather than only implied by what is missing. Always
            mounted, empty when there is no filter: a live region has to exist BEFORE its
            content changes for a screen reader to announce the change at all, and one that
            appears with its text already in it announces nothing. `:empty` hides the box. */}
        <span className="pal-filter" aria-live="polite">
          {filter ? `${filter.label} only` : ""}
        </span>
      </div>
      <div className="pal-results" id={listId} role="listbox" aria-label="Search results">
        {rows.length === 0 ? (
          <div className="pal-empty">
            Nothing matches. Try a workflow name, a Persona, or "soak".
          </div>
        ) : (
          groups.map((group, groupIndex) => (
            <div key={group.group} role="group" aria-label={group.label}>
              <div className="pal-glabel">{group.label}</div>
              {group.rows.map((row, rowIndex) => {
                const index = (groupOffsets[groupIndex] ?? 0) + rowIndex;
                const info = PALETTE_KIND_INFO[row.kind];
                const isActive = index === active;
                return (
                  <Tooltip key={row.id} label={paletteRowHint(row)}>
                    <button
                      type="button"
                      ref={isActive ? activeRef : undefined}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isActive}
                      aria-label={
                        row.switchOn === undefined
                          ? `${row.title}, ${info.label}`
                          : `${row.title}, ${info.label}, ${row.switchOn ? "on" : "off"}`
                      }
                      className={`pal-row${isActive ? " is-active" : ""}`}
                      // Keep the caret in the search field: a bare button click would move
                      // focus here and the operator could not keep typing after an inline flip.
                      // onClick still fires - preventDefault only cancels the focus.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => {
                        if (!isActive) setSel(index);
                      }}
                      onClick={() => activate(index)}
                    >
                      <span className="pal-row-icon" aria-hidden>
                        {row.glyph ?? info.glyph}
                      </span>
                      <span className="pal-row-text">
                        <span className="pal-row-label">{row.title}</span>
                        <span className={`pal-row-desc${row.attention ? " is-attention" : ""}`}>
                          {row.detail}
                        </span>
                      </span>
                      {row.switchOn !== undefined && (
                        <span className="pal-switch" data-on={row.switchOn ? "true" : "false"} aria-hidden />
                      )}
                      <span className={`pal-kind pal-kind-${row.kind}`}>{info.label}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="pal-foot">
        <span>
          <b>↑↓</b> navigate
        </span>
        <span>
          <b>↵</b> open
        </span>
        <span>
          <b>⇥</b> filter by kind
        </span>
        <span>
          <b>esc</b> close
        </span>
      </div>
    </Overlay>
  );
}
