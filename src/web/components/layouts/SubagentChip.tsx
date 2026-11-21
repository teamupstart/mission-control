import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@shared/types.ts";
import { hasSubagents, subagentCountLabel, subagentCounts } from "@shared/subagents.ts";
import { useNow } from "../../useNow.ts";
import { backgroundAgentsHeadline } from "../BackgroundAgentsTray.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { SubagentRow } from "./SubagentTree.tsx";

/** The popover's width, and the viewport inset it keeps. */
const POPOVER_WIDTH = 320;
const VIEWPORT_INSET = 8;
/** The gap between the chip and the popover. */
const CHIP_GAP = 6;

interface Placement {
  left: number;
  /** The panel's whole outer width - border and padding included (`box-sizing: border-box`). */
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * The words on the chip: "3 agents", or "12+ agents" when the list may have been cut short.
 * A session whose every agent has already folded into the finished count says so instead of
 * claiming "0 agents".
 */
export function subagentChipLabel(session: Pick<Session, "subagents">): string {
  const counts = subagentCounts(session.subagents);
  if (counts.listed === 0) return `${counts.folded} finished`;
  const n = subagentCountLabel(counts.listed, counts.atLeast);
  return `${n} ${counts.listed === 1 && !counts.atLeast ? "agent" : "agents"}`;
}

/**
 * A session's background sub-agents as one chip in its tile's flag row - the board half of
 * the Chip and popover treatment. "⑂ 3 agents" with one status pip per agent; clicking it
 * opens a popover that lists them with the same rows the nested tree draws.
 *
 * The tile gains no height, which is the reason to pick this over the nested sub-cards.
 *
 * The popover is non-modal, portalled to the body so no tile, column or board scroller clips
 * it, and dismissed by Escape, by a press outside it, or by the chip again. It is a dialog,
 * not a menu: nothing in it is a command. Like the tree it controls nothing about an agent.
 *
 * React bubbles a portal's events through its React parents, so a click inside the popover
 * would otherwise reach the tile's own click handler and open the session. Both the chip and
 * the popover stop that here.
 *
 * Draws nothing for a session without background agents.
 */
export function SubagentChip({ session }: { session: Pick<Session, "name" | "subagents"> }): React.JSX.Element | null {
  const summary = session.subagents;
  const present = hasSubagents(summary);
  const counts = subagentCounts(summary);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement>({ left: 0, width: POPOVER_WIDTH, top: 0, maxHeight: 0 });
  const chip = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const shown = open && present;
  // One clock for every row, and only while the popover is open over a running agent.
  const now = useNow(shown && counts.running > 0);

  // The agents ending and folding away closes the popover, so their return does not reopen it.
  useEffect(() => {
    if (!present) setOpen(false);
  }, [present]);

  useLayoutEffect(() => {
    if (!shown) return;
    const placeIt = (): void => {
      const rect = chip.current?.getBoundingClientRect();
      if (!rect) return;
      // The area a fixed panel can actually be seen in: the viewport less any scrollbar, which
      // `innerWidth`/`innerHeight` (and `100vw`) would count as room. The panel's width and
      // max-height are set from the same numbers, as border-box sizes, so its padding and
      // border are inside them and its outer box never passes the inset from either edge.
      const viewW = document.documentElement.clientWidth;
      const viewH = document.documentElement.clientHeight;
      const width = Math.max(0, Math.min(POPOVER_WIDTH, viewW - 2 * VIEWPORT_INSET));
      const left = Math.max(VIEWPORT_INSET, Math.min(rect.left, viewW - width - VIEWPORT_INSET));
      // Opens toward the larger half, so a chip low on the board does not push its list off-screen.
      setPlace(rect.top > viewH / 2
        ? { left, width, bottom: viewH - rect.top + CHIP_GAP, maxHeight: Math.max(0, rect.top - CHIP_GAP - VIEWPORT_INSET) }
        : { left, width, top: rect.bottom + CHIP_GAP, maxHeight: Math.max(0, viewH - rect.bottom - CHIP_GAP - VIEWPORT_INSET) });
    };
    placeIt();
    popover.current?.focus({ preventScroll: true });
    window.addEventListener("resize", placeIt);
    window.addEventListener("scroll", placeIt, true);
    return () => {
      window.removeEventListener("resize", placeIt);
      window.removeEventListener("scroll", placeIt, true);
    };
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const inside = (target: EventTarget | null): boolean =>
      !!target && (!!popover.current?.contains(target as Node) || !!chip.current?.contains(target as Node));
    const onDown = (event: PointerEvent): void => {
      if (!inside(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      // Only a key meant for this popover: focus inside it, or on its chip.
      if (!inside(document.activeElement)) return;
      const fromPopover = !!popover.current?.contains(document.activeElement);
      if (event.key === "Escape") {
        // Captured first, so the board's own Escape (leaving a drill-in) does not also fire.
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      setOpen(false);
      // Back to the chip, so Escape lands where the popover was opened and a Tab out of the
      // popover carries on from the chip rather than from the end of the document.
      if (event.key === "Escape" || fromPopover) chip.current?.focus();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [shown]);

  if (!present) return null;

  const label = subagentChipLabel(session);
  return (
    <>
      <Tooltip label={shown ? "Hide the background sub-agents" : "Show the background sub-agents"}>
        <button
          ref={chip}
          type="button"
          className={`tile-flag tf-agents${counts.running > 0 ? " is-running" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={shown}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <span className="tf-agents-glyph" aria-hidden>
            ⑂
          </span>
          <span className="tf-agents-label">{label}</span>
          {summary.agents.length > 0 && (
            <span className="tf-agents-pips" aria-hidden>
              {summary.agents.map((agent) => (
                <span key={agent.id} className={`tf-agents-pip is-${agent.state}`} />
              ))}
            </span>
          )}
        </button>
      </Tooltip>
      {shown &&
        createPortal(
          <div
            ref={popover}
            role="dialog"
            aria-label="Background agents"
            tabIndex={-1}
            className="subagent-popover"
            style={place}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <p className="sp-head">
              <span className="sp-glyph" aria-hidden>
                ⑂
              </span>
              {backgroundAgentsHeadline(session)}
            </p>
            <ul className="st-list" aria-label={`Background sub-agents of ${session.name || "this session"}`}>
              {summary.agents.map((agent) => <SubagentRow key={agent.id} agent={agent} now={now} />)}
              {counts.folded > 0 && <li className="st-row st-folded">{counts.folded} finished</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
