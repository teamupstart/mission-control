import { cloneElement, useCallback, useId, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

/**
 * Reusable, theme-matched tooltip. Wrap any single interactive element to give it
 * a hover/focus tooltip:
 *
 *   <Tooltip label="Open pull request">
 *     <a href={url}>…</a>
 *   </Tooltip>
 *
 * The bubble is rendered in a body-level portal with fixed positioning, so it
 * never clips against card edges or `overflow` and never re-flows the trigger's
 * layout (handlers are merged onto the child - no extra wrapper DOM node). It
 * flips below the trigger when there isn't room above, and is exposed to screen
 * readers via `role="tooltip"` + `aria-describedby`.
 */

type Placement = "above" | "below";
type TipState = { x: number; y: number; placement: Placement };

/** Below this many px from the viewport top, flip the bubble under the trigger. */
const TOP_FLIP_THRESHOLD = 56;

export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}): React.JSX.Element {
  const [tip, setTip] = useState<TipState | null>(null);
  const id = useId();

  const show = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const placement: Placement = r.top < TOP_FLIP_THRESHOLD ? "below" : "above";
    setTip({
      x: r.left + r.width / 2,
      y: placement === "above" ? r.top : r.bottom,
      placement,
    });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  // Merge our listeners onto the child (chaining any it already has) rather than
  // wrapping it, so the trigger's own layout - e.g. flex sizing in the card
  // header - is untouched.
  const props = children.props as Record<string, unknown> & {
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
    onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  };
  const trigger = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(e);
      show(e.currentTarget);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      props.onFocus?.(e);
      show(e.currentTarget);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      props.onBlur?.(e);
      hide();
    },
    "aria-describedby": tip ? id : props["aria-describedby"],
  } as Partial<typeof props>);

  return (
    <>
      {trigger}
      {tip &&
        createPortal(
          <span
            role="tooltip"
            id={id}
            className={`tooltip tt-${tip.placement}`}
            style={{ left: tip.x, top: tip.y }}
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
