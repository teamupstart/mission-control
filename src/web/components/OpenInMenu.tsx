import { useEffect, useRef, useState } from "react";
import type { OpenTargetId, OpenTargetView } from "@shared/open-targets.ts";
import { useOpenTargets } from "../lib/openTargets.ts";

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
        <button
          key={target.id}
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
      ))}
    </>
  );
}

export function OpenInMenu({
  disabled,
  busy,
  onChoose,
}: {
  /** No file is selected, so there is nothing to hand anyone. */
  disabled: boolean;
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
  // app. Escape has three claimants while this is up - the menu, the files Overlay (which
  // listens on `window`, see Overlay.tsx) and App's grid handler - and only the topmost
  // one may act, or dismissing the menu also closes the window behind it. The arrows are
  // here for the same reason: in the console layout they scroll the file reader.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>(".open-in-btn")?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [...(root.current?.querySelectorAll<HTMLButtonElement>(".open-in-row") ?? [])]
        .filter((row) => !row.disabled);
      if (rows.length === 0) return;
      event.stopPropagation();
      event.preventDefault();
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
      <button
        type="button"
        className="btn open-in-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy}
        title={disabled ? "Select a file first" : "Open this file in another application"}
        onClick={() => setOpen((value) => !value)}
      >
        {busy ? "Opening…" : "Open in"}
        <span className="open-in-caret" aria-hidden>▾</span>
      </button>
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
