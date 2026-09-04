import { useEffect, useRef, useState } from "react";
import type { OpenTargetId, OpenTargetView } from "@shared/open-targets.ts";
import { useOpenTargets } from "../lib/openTargets.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * "Open in ▾" - handing the file on screen to an application outside Mission Control.
 *
 * A menu with one row today, and that is the shape rather than an accident. Every row is
 * folded out of what the daemon reports for `OPEN_TARGET_IDS`, so a second target (an
 * editor, a JetBrains IDE) is a file under `src/server/open-targets/` and two record
 * entries - this component does not learn its name, and neither does the stylesheet. A
 * button that opened one hard-coded application would have to become this the moment
 * there were two, and the intermediate state is where the second one gets a different
 * disabled-reason story than the first.
 */

/**
 * The rows, split out from the popover so the interesting rendering rules - an
 * unavailable target says WHY, a resolved one names the application it found - are
 * reachable from a `renderToStaticMarkup` test, which never runs an effect and so can
 * never open the real menu.
 */
export function OpenInList({
  targets,
  failed,
  onChoose,
}: {
  targets: OpenTargetView[] | null;
  failed: boolean;
  onChoose: (target: OpenTargetView) => void;
}): React.JSX.Element {
  if (failed) {
    return <p className="open-in-note is-error">Could not ask the daemon what is available.</p>;
  }
  if (!targets) return <p className="open-in-note">Checking…</p>;
  if (targets.length === 0) return <p className="open-in-note">This build has nowhere to open files.</p>;
  return (
    <>
      {targets.map((target) => (
        <Tooltip
          key={target.id}
          label={target.unavailable ?? `Open this file in ${target.detail ?? target.label}`}
        >
          <button
            type="button"
            role="menuitem"
            className="open-in-row"
            disabled={Boolean(target.unavailable)}
            onClick={() => onChoose(target)}
          >
            <span className="open-in-glyph" aria-hidden>{target.glyph}</span>
            <span className="open-in-text">
              <span className="open-in-label">
                {target.label}
                {target.detail && <em>{target.detail}</em>}
              </span>
              <span className="open-in-note">{target.unavailable ?? target.blurb}</span>
            </span>
          </button>
        </Tooltip>
      ))}
    </>
  );
}

export function OpenInMenu({
  disabled,
  disabledReason,
  busy,
  onChoose,
}: {
  /** There is currently no file the daemon may hand to another application. */
  disabled: boolean;
  /** Why the otherwise available action is disabled. */
  disabledReason?: string;
  /** A launch is in flight - including the save that has to land before it. */
  busy: boolean;
  onChoose: (target: OpenTargetId) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { targets, failed } = useOpenTargets();

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  // Keys are taken in the CAPTURE phase on `window`, above every other listener in the
  // app, and stopped IMMEDIATELY. Escape has three claimants while this is up - the menu,
  // the files Overlay and App's grid handler - and only the topmost may act, or dismissing
  // the menu also closes the window behind it. The arrows are here for the same reason: in
  // the console layout they scroll the file reader.
  //
  // Both halves are load-bearing, and the second is the subtle one. Capture-at-window runs
  // before the other two (which listen on `window` in the BUBBLE phase - see Overlay.tsx
  // and App.tsx), and plain `stopPropagation` is enough to keep the event from ever
  // reaching that later point in the path. It is NOT enough against a listener on the same
  // target in the same phase, which only `stopImmediatePropagation` stops - so the weaker
  // call would make this correct by the accident of what phase everyone else happens to
  // have picked, and the next capture-phase window listener would silently take Escape
  // alongside the menu.
  useEffect(() => {
    if (!open) return;
    function seize(event: KeyboardEvent): void {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        seize(event);
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>(".open-in-btn")?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [...(root.current?.querySelectorAll<HTMLButtonElement>(".open-in-row") ?? [])]
        .filter((row) => !row.disabled);
      if (rows.length === 0) return;
      seize(event);
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Pointerdown, not click: a mousedown that starts outside should dismiss before whatever
  // it lands on gets its own event, so a click on the toolbar behind the menu does one
  // thing rather than two.
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent): void {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  // Focus the first row the human can actually use, so the menu is operable from the
  // keyboard the moment it appears.
  useEffect(() => {
    if (!open) return;
    const rows = root.current?.querySelectorAll<HTMLButtonElement>(".open-in-row");
    for (const row of rows ?? []) {
      if (!row.disabled) { row.focus(); return; }
    }
  }, [open, targets]);

  return (
    <div className="open-in" ref={root}>
      <Tooltip label={disabled ? (disabledReason ?? "Select a file first") : "Open this file in another application"}>
        <button
          type="button"
          className="btn open-in-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled || busy}
          onClick={() => setOpen((value) => !value)}
        >
          {busy ? "Opening…" : "Open in"}
          <span className="open-in-caret" aria-hidden>▾</span>
        </button>
      </Tooltip>
      {open && (
        <div className="open-in-pop" role="menu" aria-label="Open this file in">
          <OpenInList
            targets={targets}
            failed={failed}
            onChoose={(target) => { setOpen(false); onChoose(target.id); }}
          />
        </div>
      )}
    </div>
  );
}
