import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * The application's one tooltip. Wrap any single interactive element to give it a
 * hover/focus tooltip:
 *
 *   <Tooltip label="Open pull request">
 *     <a href={url}>…</a>
 *   </Tooltip>
 *
 * It replaces the native `title` attribute everywhere, which is why it has to cover
 * everything `title` covered. `title` is untunable (the ~1s delay and the OS bubble are
 * the platform's, not ours), it does not fire on focus so keyboard users never see it,
 * and it renders in the OS chrome rather than the app's - so it was the one surface in
 * the dashboard that ignored the theme.
 *
 * The bubble is rendered in a body-level portal with fixed positioning, so it never clips
 * against card edges or `overflow` and never re-flows the trigger's layout (handlers are
 * merged onto the child - no extra wrapper DOM node, except for disabled triggers, see
 * below). It flips below the trigger when there isn't room above, and slides horizontally
 * to stay on screen.
 *
 * The label is ALSO rendered, always, into a visually-hidden body-level portal that the
 * trigger points `aria-describedby` at. Two reasons, and both are things `title` did for free:
 * a description that exists only while a pointer happens to be over the element is one
 * a screen reader can never reach, and - because this codebase renders components with
 * `renderToStaticMarkup` and has no jsdom - a label that appears only on hover cannot be
 * asserted by any test in `test/`. The hidden copy is what keeps "this control says what
 * it does" a checkable claim rather than a hope. The visible bubble is `aria-hidden`, so
 * the text is announced once, not twice.
 */

type Placement = "above" | "below";
type TipState = {
  x: number;
  y: number;
  placement: Placement;
  /** Horizontal correction that keeps the bubble on screen; `undefined` until measured. */
  shift?: number;
};

/** Below this many px from the viewport top, flip the bubble under the trigger. */
const TOP_FLIP_THRESHOLD = 56;
/** Keep the bubble at least this far from the viewport's left/right edges. */
const EDGE_MARGIN = 8;

/**
 * A disabled `<button>`/`<input>`/`<select>` dispatches no mouse events at all - not to
 * itself and not to an ancestor - so merged handlers never fire on one. That would have
 * silently dropped exactly the tooltips that matter most: the ones explaining WHY a
 * control is unavailable ("No pane to send to"). `title` did show on those, so dropping
 * them would have been a regression, not a wash.
 *
 * For those triggers only, we render an anchor span that takes the hover in the disabled
 * child's place (`.tt-anchor > :disabled` is `pointer-events: none`, so the hit test falls
 * through to the span). Enabled triggers keep the wrapper-free path, which is what lets
 * the chips in a card header stay flex items of the header itself.
 */
function isDisabled(props: Record<string, unknown>): boolean {
  return props.disabled === true;
}

function mergeDescription(props: Record<string, unknown>, id: string): string {
  return [props["aria-describedby"], id].filter(Boolean).join(" ");
}

function describeLabelControls(children: ReactNode, id: string): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child) || typeof child.type !== "string") return child;
    if (child.type !== "input" && child.type !== "select" && child.type !== "button") return child;
    const props = child.props as Record<string, unknown>;
    return cloneElement(child, {
      "aria-describedby": mergeDescription(props, id),
    } as Partial<typeof props>);
  });
}

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

  // Measured on the ref callback rather than in a layout effect: this runs before paint
  // on the client just the same, but is never invoked during the `renderToStaticMarkup`
  // the component tests use, where `useLayoutEffect` would warn on every render.
  const measure = useCallback((el: HTMLSpanElement | null) => {
    if (!el) return;
    setTip((prev) => {
      if (!prev || prev.shift !== undefined) return prev;
      const r = el.getBoundingClientRect();
      const overLeft = EDGE_MARGIN - r.left;
      const overRight = r.right - (window.innerWidth - EDGE_MARGIN);
      const shift = overLeft > 0 ? overLeft : overRight > 0 ? -overRight : 0;
      return { ...prev, shift };
    });
  }, []);

  const childProps = children.props as Record<string, unknown>;
  const describedChildren =
    children.type === "label"
      ? describeLabelControls(childProps.children as ReactNode, id)
      : childProps.children;
  const describedTrigger = cloneElement(children, {
    "aria-describedby": mergeDescription(childProps, id),
    ...(children.type === "label" ? { children: describedChildren } : {}),
  } as Partial<typeof childProps>);
  const props = describedTrigger.props as Record<string, unknown> & {
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
    onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  };
  const disabled = isDisabled(props);

  // Merge our listeners onto the child (chaining any it already has) rather than wrapping
  // it, so the trigger's own layout - e.g. flex sizing in the card header - is untouched.
  // A disabled child cannot receive them, so it gets the anchor span instead.
  const handlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: () => hide(),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: () => hide(),
  };
  const trigger = disabled ? (
    <span className="tt-anchor" {...handlers}>
      {describedTrigger}
    </span>
  ) : (
    cloneElement(describedTrigger, {
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
        props.onMouseEnter?.(e);
        handlers.onMouseEnter(e);
      },
      onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
        props.onMouseLeave?.(e);
        hide();
      },
      onFocus: (e: React.FocusEvent<HTMLElement>) => {
        props.onFocus?.(e);
        handlers.onFocus(e);
      },
      onBlur: (e: React.FocusEvent<HTMLElement>) => {
        props.onBlur?.(e);
        hide();
      },
    } as Partial<typeof props>)
  );
  const description = (
    <span id={id} className="tt-desc">
      {label}
    </span>
  );

  return (
    <>
      {trigger}
      {typeof document === "undefined" ? description : createPortal(description, document.body)}
      {tip &&
        createPortal(
          <span
            ref={measure}
            // The accessible description is the hidden portal above; this is the paint.
            aria-hidden
            className={`tooltip tt-${tip.placement}`}
            style={{
              left: tip.x + (tip.shift ?? 0),
              top: tip.y,
              // The bubble slid to stay on screen; walk the caret back the same distance
              // so it still points at the trigger it belongs to.
              ["--tt-caret" as string]: `calc(50% - ${tip.shift ?? 0}px)`,
              // Until measured, the bubble is positioned but not yet corrected. Painting
              // it in the wrong place for a frame is what the fade-in would otherwise be
              // covering up, and at a viewport edge that frame is a visible jump.
              visibility: tip.shift === undefined ? "hidden" : undefined,
            }}
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
