import { useEffect, useId, useRef, useState } from "react";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The fleet pulse's "lost" segment: running tasks that no agent session is attached to.
 *
 * Nothing finishes a lost task, so it sits in `running` holding its worktree until someone
 * cancels it - and the one place that offers Cancel is Sitrep, which nothing used to point
 * at. This segment is that pointer. It renders only while lost tasks exist and leaves the
 * moment the last one is cancelled, the way `did not start` does beside it.
 *
 * A click opens a card rather than jumping straight to Sitrep, because the word alone does
 * not say what happened: the card explains it and carries the Open Sitrep button. It is a
 * popover and not a hover bubble because the shared `Tooltip` is `pointer-events: none` by
 * contract, so it cannot hold a button. Dismissal follows the other topbar popovers (outside
 * mousedown, and an Escape that stops before App's global handler and returns focus to the
 * trigger, as `KeepAwakeControl` does) - see `topbar-popover-dismiss.test.ts`.
 */

/** The card's copy, shared with the render test so the two cannot drift. */
export function lostTasksCopy(count: number): { headline: string; body: string; trigger: string } {
  const one = count === 1;
  return {
    headline: `${count} task${one ? " is" : "s are"} running with no session`,
    body: `${one ? "Its agent session" : "Their agent sessions"} ended without closing ${one ? "it" : "them"}, so nothing will finish ${one ? "it" : "them"}. Review and cancel ${one ? "it" : "them"} in Sitrep.`,
    trigger: `${count} lost task${one ? "" : "s"} - running with no session`,
  };
}

export function LostTasksControl({
  count,
  onOpenSitrep,
}: {
  count: number;
  onOpenSitrep: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening moves the keyboard into the card, the way a dialog takes focus, so Tab reaches
  // Open Sitrep next. It is also what clears the trigger's own tooltip: that bubble hides on
  // blur, and left up it would sit on the card's headline for as long as the pointer rests on
  // the segment. The card itself, not its button, so the button's tooltip stays shut too.
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>(".lost-pop")?.focus();
  }, [open]);

  const copy = lostTasksCopy(count);
  return (
    <div className="lost-wrap" ref={ref}>
      <Tooltip label={`${copy.headline}. Click for details`}>
        <button
          type="button"
          ref={triggerRef}
          className="pulse-seg pulse-btn pulse-failed"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={copy.trigger}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="pulse-dot" aria-hidden />
          <span className="pulse-n">{count}</span>
          <span className="tb-label">lost</span>
        </button>
      </Tooltip>
      {open && (
        <LostTasksPanel
          id={panelId}
          count={count}
          onOpenSitrep={() => {
            setOpen(false);
            onOpenSitrep();
          }}
        />
      )}
    </div>
  );
}

/**
 * The card. Presentational and driven by props, so it renders under `renderToStaticMarkup`
 * without a popover to open first.
 */
export function LostTasksPanel({
  id,
  count,
  onOpenSitrep,
}: {
  id?: string;
  count: number;
  onOpenSitrep: () => void;
}): React.JSX.Element {
  const copy = lostTasksCopy(count);
  return (
    <div className="lost-pop" role="dialog" aria-label="Lost tasks" id={id} tabIndex={-1}>
      <p className="lost-pop-head">{copy.headline}</p>
      <p className="lost-pop-body">{copy.body}</p>
      <div className="lost-pop-actions">
        <Tooltip label="Open Sitrep at the lost tasks, where each one can be cancelled">
          <button type="button" className="btn btn-primary lost-pop-open" onClick={onOpenSitrep}>
            Open Sitrep
            <Keycap action="roundup" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
