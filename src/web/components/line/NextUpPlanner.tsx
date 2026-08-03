import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@shared/types.ts";
import type { PlannerFact } from "../../lib/backlog-copy.ts";
import { PriorityChip } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";

/**
 * THE AUTOPILOT PLANNER - the drawer's "next up" mark, saying why it is next up.
 *
 * The Backlog drawer answers *what* autopilot would take next by putting the queue in the
 * machine's own order and marking its head. This answers the question that comes straight
 * after it and that no list can answer by being a list: **why that one**. Until now the
 * only place that reasoning existed was `BacklogPlanEntry.reason` - a sentence Foreman
 * writes for every task it plans, stored, polled into the browser every four seconds, and
 * rendered by nothing.
 *
 * Four decisions shape the component.
 *
 *  1. **The mark IS the trigger.** Phase 1 drew a static `next up` pill and left this one
 *     element for this phase. Reusing it rather than adding a second control keeps the
 *     row's one-height rule and the ops column's floor untouched, and it puts the
 *     explanation exactly where the claim is: you click the word you doubted.
 *  2. **Foreman's words are quoted, and the computed facts are separate.** The reason is
 *     the planner model's own sentence and is printed verbatim, attributed. Everything
 *     under it is derived here from the same task list the rows are drawn from, so a
 *     reader can check every line against the panel behind the popover. Where the two
 *     disagree - a plan that put a `low` task first - the facts say so
 *     (`plannerFacts`), because a surface that only ever agreed with the model would be
 *     worth nothing on the day the model is wrong.
 *  3. **Fixed positioning, not absolute.** The drawer's body is capped at three rows and
 *     scrolls (`.line-drawer-body`), and the drawer itself clips (`overflow: hidden`) so
 *     its rounded corners hold. An absolutely-positioned popover inside that is cut off
 *     at the second row. Fixed placement is measured off the trigger at open time, so the
 *     panel is a sibling of the row in the DOM and a free-floating layer on screen -
 *     which is also why it closes on scroll rather than sliding away from its anchor.
 *  4. **It is one layer above the drawer, and Escape peels one layer.** The fleet's key
 *     handler closes the drawer on Escape while the keyboard is inside it. That handler
 *     is on `window`; this one is a React handler on the anchor, which runs first and
 *     stops the event, so the first press closes the popover and the second closes the
 *     drawer. Without it one press would take both and the operator would lose the queue
 *     they were reading to dismiss a panel about one row of it.
 */

/** Mockup B's panel width, and the width the placement clamps against. */
const POP_WIDTH = 460;
/** Breathing room from the viewport edges, matching the tooltip's own margin. */
const EDGE_MARGIN = 8;
/** Never place the panel's top nearer the bottom edge than this - it would open off-screen. */
const BOTTOM_KEEP = 140;

interface Placement {
  top: number;
  left: number;
  /** How much room is left below `top`, so the panel can never run off the screen. */
  fit: number;
}

/** Where the panel goes for a trigger at `rect`: under it, clamped into the viewport. */
function placeUnder(rect: DOMRect): Placement {
  const left = Math.min(
    Math.max(rect.left, EDGE_MARGIN),
    Math.max(EDGE_MARGIN, window.innerWidth - POP_WIDTH - EDGE_MARGIN),
  );
  const top = Math.min(rect.bottom + 6, Math.max(EDGE_MARGIN, window.innerHeight - BOTTOM_KEEP));
  // Passed to the stylesheet rather than applied as a height, so the DESIGN cap stays in
  // CSS (`min(62vh, 540px, ...)`) and this only ever tightens it. A window short enough
  // for a long reason to reach the bottom edge gets a panel that scrolls, never one whose
  // Launch button is below the fold.
  return { top, left, fit: Math.max(120, window.innerHeight - top - EDGE_MARGIN) };
}

/**
 * The panel itself - pure, so `renderToStaticMarkup` can read every sentence in it.
 *
 * Exported for that reason and used through `NextUpPlanner` everywhere else: a popover
 * whose content can only be reached by opening it is content no test in `test/` can see.
 */
export function PlannerPopover({
  task,
  planned,
  reason,
  facts,
  readyCount,
  busy,
  style,
  panelRef,
  onLaunch,
  onClose,
}: {
  task: Task;
  /** Whether Foreman's stored plan names this task at all. */
  planned: boolean;
  /** The plan entry's own explanation, or null when it recorded none. */
  reason: string | null;
  facts: PlannerFact[];
  /** How many tasks are in the ready band, for the ordering line in the header. */
  readyCount: number;
  busy: boolean;
  style?: React.CSSProperties;
  panelRef?: React.RefObject<HTMLDivElement | null>;
  onLaunch: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div
      className="bl-planner-pop"
      role="dialog"
      // Named for the task, not "Planner": a screen reader arriving here has just pressed
      // a mark on one row of six, and the panel's first job is to say which row it is.
      aria-label={`Why ${task.title} is next up`}
      // Takes focus as it opens, exactly as the drawer frame does, so it must be
      // focusable without joining the tab order.
      tabIndex={-1}
      ref={panelRef}
      style={style}
    >
      <header className="bl-planner-head">
        <h3 className="bl-planner-title">Next up</h3>
        {/* The rule in force, not a label: `readyBacklog` walks Foreman's plan first and
            falls back to priority-then-age for anything the plan does not name. Which of
            the two put this task on top is the first thing the reason below has to be
            read against. */}
        <p className="bl-planner-order">
          {planned ? "plan order" : "priority, then age"} · {readyCount} ready
        </p>
        <span className="bl-planner-spacer" />
        <Tooltip label="Close this - the queue behind it stays open">
          <button
            type="button"
            className="btn btn-ghost bl-planner-close"
            aria-label="Close the planner"
            onClick={onClose}
          >
            <span aria-hidden>✕</span>
            <kbd>esc</kbd>
          </button>
        </Tooltip>
      </header>
      <div className="bl-planner-body">
        <p className="bl-planner-task">
          <PriorityChip priority={task.priority} />
          <strong>{task.title}</strong>
        </p>
        <p className="bl-planner-meta">{[task.kind, task.agent].filter(Boolean).join(" · ")}</p>
        {/* The intent, clamped to two lines by the stylesheet. The full text is one click
            away in the editor the row's title opens, so this is an excerpt on purpose. */}
        {task.intent && <p className="bl-planner-intent">{task.intent}</p>}
        <h4 className="bl-planner-label">Why this one</h4>
        {reason ? (
          <blockquote className="bl-planner-reason">
            {reason}
            <cite>Foreman's plan</cite>
          </blockquote>
        ) : (
          // Two different absences, said differently. A planned task with no recorded
          // reason and a task the plan never named are not the same state: the second one
          // is being ordered by the fallback, which is a fact about how it got here.
          <p className="bl-planner-noreason">
            {planned
              ? "Foreman planned it here and recorded no reason."
              : "Foreman's plan does not name this one yet, so the fallback ordering put it first."}
          </p>
        )}
        <ul className="bl-planner-why">
          {facts.map((fact) => (
            <li key={fact.text} className={fact.tone === "soft" ? "is-soft" : undefined}>
              <span className="bl-planner-tick" aria-hidden>
                {fact.tone === "soft" ? "·" : "✓"}
              </span>
              {fact.text}
            </li>
          ))}
        </ul>
      </div>
      <div className="bl-planner-cta">
        <Tooltip label={`Dispatch "${task.title}" into a fresh worktree, ahead of the queue`}>
          <button type="button" className="btn btn-send" disabled={busy} onClick={onLaunch}>
            Launch now
          </button>
        </Tooltip>
        {/* No "Skip once" beside it, against mockup B: the worker's cooldowns are
            in-memory and are not an operator concept, and the deferral that IS one is the
            park switch on the row behind this panel. */}
      </div>
    </div>
  );
}

export function NextUpPlanner({
  task,
  planned,
  reason,
  facts,
  readyCount,
  busy,
  onLaunch,
}: {
  task: Task;
  planned: boolean;
  reason: string | null;
  facts: PlannerFact[];
  readyCount: number;
  /** A write on this row is in flight; the launch is inert until it lands. */
  busy: boolean;
  onLaunch: () => void;
}): React.JSX.Element {
  const [place, setPlace] = useState<Placement | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = place !== null;

  /** Close, and put the keyboard back where it came from - the frame's own contract. */
  const close = useCallback((restoreFocus: boolean): void => {
    setPlace(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  // Focus moves INTO the panel as it opens, and onto the panel rather than onto Launch:
  // this surface exists to be read, and landing on the button would announce the action
  // before the reasoning it is the conclusion of.
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && anchor.current !== null && anchor.current.contains(target);
    const onDown = (e: MouseEvent): void => {
      if (!inside(e.target)) close(false);
    };
    // Scrolling closes it, rather than the panel re-placing itself. It is fixed to a point
    // measured off a row inside a body capped at three rows, so following that row would
    // mean re-measuring on every frame of a scroll whose whole purpose is to look at the
    // OTHER rows. A resize moves the same anchor for the same reason.
    //
    // Capture, so a scroll in ANY container reaches this - and therefore filtered by
    // target, because the panel scrolls too: a long intent under a long reason would
    // otherwise close the popover the moment somebody scrolled it to read the rest.
    const onScroll = (e: Event): void => {
      if (!inside(e.target)) close(false);
    };
    const onResize = (): void => close(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [close, open]);

  return (
    <span
      className="bl-planner"
      ref={anchor}
      // The layering, and the whole reason this is a React handler on the anchor rather
      // than another `document` listener: the fleet's Escape closes the DRAWER, from
      // `window`, which is above React's root container. Stopping the event here means
      // the first press takes this panel and the second takes the drawer under it.
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }}
    >
      <Tooltip
        label={
          open
            ? "Hide why autopilot would take this one next"
            : "Why autopilot would take this one next - and launch it from here"
        }
      >
        <button
          type="button"
          // The board card's own `next up` mark, so the same fact wears the same colour on
          // every surface that draws it; `.bl-next-trigger` adds only what a control needs
          // that a chip does not.
          className="bl-next bl-next-trigger"
          ref={trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Next up: ${task.title} - why, and launch it now`}
          onClick={() => {
            if (open) {
              close(true);
              return;
            }
            const rect = trigger.current?.getBoundingClientRect();
            if (rect) setPlace(placeUnder(rect));
          }}
        >
          {/* The two words in their own element, so the mark is still exactly the string
              "next up" to anything selecting by text - the board, the Sitrep and this row
              are one vocabulary, and the caret is chrome this control added, not a change
              to what the mark SAYS. */}
          <span className="bl-next-word">next up</span>
          <span className="bl-next-caret" aria-hidden>
            ▾
          </span>
        </button>
      </Tooltip>
      {place && (
        <PlannerPopover
          task={task}
          planned={planned}
          reason={reason}
          facts={facts}
          readyCount={readyCount}
          busy={busy}
          style={{
            top: place.top,
            left: place.left,
            ["--bl-planner-fit" as string]: `${place.fit}px`,
          }}
          panelRef={panel}
          onLaunch={() => {
            // Closed on the click rather than when the write lands: the row leaves the
            // ready band over SSE a moment later, and a refusal is reported on the
            // drawer's own alert line with the row still in place. A panel that sat there
            // saying "launching…" would be a second, quieter copy of both.
            //
            // The keyboard goes back to the mark, which is where it belongs in the case
            // that matters - a REFUSED dispatch leaves the row exactly where it was, and
            // dropping focus to the body would strand it outside the drawer.
            close(true);
            onLaunch();
          }}
          onClose={() => close(true)}
        />
      )}
    </span>
  );
}
