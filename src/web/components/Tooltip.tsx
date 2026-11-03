import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
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
 * A dropdown's options are the exception: there the bubble opens BESIDE the menu, level
 * with the row, to its right or, without room, its left. Above or below an option is
 * exactly where its sibling options are, so a bubble there covers the very choices the
 * person is reading it to pick between (issue #1315). When neither side has room - a
 * narrow window - it goes above or below the whole menu, never the row, for the same
 * reason. Keyed on the trigger's own `role` rather than a per-call prop, so every menu and
 * listbox gets this without each call site having to remember it.
 *
 * The label is ALSO rendered, always, into a visually-hidden body-level portal that the
 * trigger points `aria-describedby` at. Two reasons, and both are things `title` did for free:
 * a description that exists only while a pointer happens to be over the element is one
 * a screen reader can never reach, and - because this codebase renders components with
 * `renderToStaticMarkup` and has no jsdom - a label that appears only on hover cannot be
 * asserted by any test in `test/`. The hidden copy is what keeps "this control says what
 * it does" a checkable claim rather than a hope. The visible bubble is `aria-hidden`, so
 * the text is announced once, not twice.
 *
 * `label` also accepts `TooltipContent` - a laid-out node plus its own plain sentence - for
 * the one case a string cannot serve: a popover with rows, such as the board card's pipeline
 * phase meter. That is a WIDENING of this primitive rather than a second hover component,
 * because everything above is what a second one would have had to reimplement, and because
 * `test/tooltip-coverage.test.ts` deliberately leaves no escape hatch for a lookalike. The
 * bubble is `pointer-events: none` either way, so a rich bubble cannot steal the hover from
 * the trigger that opened it - which is also why its content must stay non-interactive.
 */

type Placement = "above" | "below" | "right" | "left";
type TipState = {
  x: number;
  y: number;
  placement: Placement;
  /** Horizontal correction that keeps the bubble on screen; `undefined` until measured. */
  shift?: number;
  /** Vertical correction for a side bubble, which can overrun the top or bottom instead. */
  shiftY?: number;
  /**
   * The box the bubble is placed against, kept so the measure pass can still move the
   * bubble to another side of it. Without it the correction below could detect an overflow
   * off the edge of the viewport but have no way to say where "below" or "left of" is.
   * The trigger's own box, except for an option: there it is the enclosing menu's.
   */
  trigger: { top: number; bottom: number; left: number; right: number };
};

/** Below this many px from the viewport top, flip the bubble under the trigger. */
const TOP_FLIP_THRESHOLD = 56;
/** Keep the bubble at least this far from the viewport's edges. */
const EDGE_MARGIN = 8;
/** The gap between the bubble and its trigger, which the caret spans. Matches the CSS. */
const GAP = 8;

/**
 * Roles whose bubble opens beside the trigger rather than above it: the options of a
 * menu or listbox, which are stacked against their siblings. See the header.
 */
const SIDE_ROLES = new Set(["menuitem", "menuitemradio", "menuitemcheckbox", "option"]);
/** What an option's bubble is placed beside: the list it belongs to, not the row alone. */
const SIDE_CONTAINER = '[role="menu"], [role="listbox"]';

/**
 * The one bubble on screen, by its owner's `hide`. There is one pointer and one focus, and
 * a second bubble only ever paints over the first: a menu focuses its checked option as it
 * opens, so hovering any other option used to stack its explanation onto the focused one's.
 * The newest trigger wins, since that is where the person just moved.
 */
let shown: (() => void) | null = null;

function verticalPlacement(top: number, height?: number): Placement {
  if (top < TOP_FLIP_THRESHOLD) return "below";
  return height !== undefined && height > top - EDGE_MARGIN ? "below" : "above";
}

function verticalTip(trigger: TipState["trigger"], placement: Placement): TipState {
  return {
    x: (trigger.left + trigger.right) / 2,
    y: placement === "above" ? trigger.top : trigger.bottom,
    placement,
    trigger,
  };
}

/** How far to slide a span of `start..end` along an axis of `size` to keep it on screen. */
function onScreen(start: number, end: number, size: number): number {
  const overStart = EDGE_MARGIN - start;
  const overEnd = end - (size - EDGE_MARGIN);
  return overStart > 0 ? overStart : overEnd > 0 ? -overEnd : 0;
}

/**
 * Where a side bubble of this size settles: right of the menu, which is where submenus
 * open and so where a person looks first; left when the right runs off screen and the left
 * does not; and above or below the whole menu when neither side has room - a narrow
 * window, where a beside-bubble cannot fit at all.
 */
function settleSide(tip: TipState, width: number, height: number): TipState {
  const { trigger } = tip;
  const fitsRight = trigger.right + GAP + width <= window.innerWidth - EDGE_MARGIN;
  const fitsLeft = trigger.left - GAP - width >= EDGE_MARGIN;
  const side: Placement | null = fitsRight ? "right" : fitsLeft ? "left" : null;
  if (side === null) {
    const next = verticalTip(trigger, verticalPlacement(trigger.top, height));
    return { ...next, shift: onScreen(next.x - width / 2, next.x + width / 2, window.innerWidth) };
  }
  const top = tip.y - height / 2;
  return {
    ...tip,
    placement: side,
    x: side === "right" ? trigger.right : trigger.left,
    shift: 0,
    shiftY: onScreen(top, top + height, window.innerHeight),
  };
}

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

/**
 * Rich tooltip content: what the bubble paints, and the sentence a screen reader gets.
 *
 * Two fields rather than one because the label is rendered in two places that are different
 * jobs (see the header): the bubble is already `aria-hidden`, so arbitrary nodes are safe
 * there, while the `.tt-desc` node is what `aria-describedby` RESOLVES TO - and rendering
 * markup into an accessible name is how a description becomes unreadable. So a caller that
 * wants a laid-out popover supplies the plain sentence beside it rather than having one
 * derived by stringifying its JSX.
 */
export interface TooltipContent {
  content: ReactNode;
  /** The accessible description. Plain text, because `aria-describedby` resolves to it. */
  description: string;
}

export function Tooltip({
  label,
  children,
}: {
  /**
   * A string, which is what almost every call site passes, or rich content plus its own
   * plain-text description. Additive: the string arm is unchanged in behaviour and in
   * markup, so widening this cost no call site a migration.
   */
  label: string | TooltipContent;
  children: ReactElement;
}): React.JSX.Element {
  // Derived once, and named for the two jobs above rather than for their types.
  const rich = typeof label !== "string";
  const description = rich ? label.description : label;
  const painted: ReactNode = rich ? label.content : label;
  const [tip, setTip] = useState<TipState | null>(null);
  const id = useId();

  const triggerRole = (children.props as { role?: unknown }).role;
  const beside = typeof triggerRole === "string" && SIDE_ROLES.has(triggerRole);
  const show = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (!beside) {
      setTip(verticalTip(
        { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        verticalPlacement(r.top),
      ));
      return;
    }
    // Placed against the menu, so the bubble clears the menu's own border and padding and
    // a fallback above or below lands outside the list rather than on a sibling row. The
    // measure pass picks the side once the bubble's real width is known.
    const m = (el.closest(SIDE_CONTAINER) ?? el).getBoundingClientRect();
    setTip({
      x: m.right,
      y: r.top + r.height / 2,
      placement: "right",
      trigger: { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
    });
  }, [beside]);
  const hide = useCallback(() => {
    if (shown === hide) shown = null;
    setTip(null);
  }, []);
  const showOnly = useCallback((el: HTMLElement) => {
    if (shown !== hide) shown?.();
    shown = hide;
    show(el);
  }, [show, hide]);
  // A trigger unmounted with its bubble open must not stay the one `shown` points at.
  useEffect(() => hide, [hide]);

  // Measured on the ref callback rather than in a layout effect: this runs before paint
  // on the client just the same, but is never invoked during the `renderToStaticMarkup`
  // the component tests use, where `useLayoutEffect` would warn on every render.
  // Reattach when the tip changes: hover can reset a focused trigger's existing bubble
  // to unmeasured without remounting it. Guard BEFORE scheduling an update so parent
  // renders cannot form a ref/state update loop, even when an updater returns its input.
  const measure = useCallback((el: HTMLSpanElement | null): void => {
    if (!el || !tip || tip.shift !== undefined) return;
    const r = el.getBoundingClientRect();
    if (tip.placement === "left" || tip.placement === "right") {
      setTip(settleSide(tip, r.width, r.height));
      return;
    }
    const shift = onScreen(r.left, r.right, window.innerWidth);
    // Flip under the trigger when the bubble does not actually FIT above it. The
    // threshold in `show` cannot answer this: it runs before the bubble exists, so it
    // can only ask whether the trigger sits near the top of the viewport, not whether
    // this particular bubble is taller than the gap above it. A short tooltip on a
    // topbar control is fine either way; a tall one - the automation stat lists a line
    // per role - is clipped off the top of the screen, which is how this was found.
    // Measured here because this is the one moment the real height is known, and it is
    // the same pass that already corrects horizontally.
    const flip = tip.placement === "above" && r.height > tip.trigger.top - EDGE_MARGIN;
    setTip(flip
      ? { ...tip, shift, placement: "below", y: tip.trigger.bottom }
      : { ...tip, shift });
  }, [tip]);

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

  // A trigger that DISABLES ITSELF while its tip is open would otherwise strand the bubble
  // on screen, covering whatever sits under it until something else happens to move the
  // pointer or focus.
  //
  // Not a hypothetical: the backlog's move controls disable as a RESULT of being pressed -
  // sending a card to the top is exactly what makes `to top` inapplicable - and the branch
  // below swaps the cloned child for the anchor span at that moment, so the child's own
  // `onBlur` unmounts without ever firing. The browser does not help either: it drops focus
  // from a disabled element without a blur event of its own.
  //
  // Hiding on the transition rather than on every render, so a tip that is legitimately
  // open on a control that was already disabled - hovering the anchor span to read WHY it
  // is unavailable - is left alone.
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  // Merge our listeners onto the child (chaining any it already has) rather than wrapping
  // it, so the trigger's own layout - e.g. flex sizing in the card header - is untouched.
  // A disabled child cannot receive them, so it gets the anchor span instead.
  const handlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showOnly(e.currentTarget),
    onMouseLeave: () => hide(),
    onFocus: (e: React.FocusEvent<HTMLElement>) => showOnly(e.currentTarget),
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
  const describedBy = (
    <span id={id} className="tt-desc">
      {description}
    </span>
  );

  return (
    <>
      {trigger}
      {typeof document === "undefined" ? describedBy : createPortal(describedBy, document.body)}
      {tip &&
        createPortal(
          <span
            ref={measure}
            // The accessible description is the hidden portal above; this is the paint.
            aria-hidden
            // `tt-rich` is what lets CSS drop the centred, single-line-ish text layout a
            // string bubble wants. Not inferred from the content: a caller passing a node
            // is exactly the caller that laid it out itself.
            className={`tooltip tt-${tip.placement}${rich ? " tt-rich" : ""}`}
            style={{
              left: tip.x + (tip.shift ?? 0),
              top: tip.y + (tip.shiftY ?? 0),
              // The bubble slid to stay on screen; walk the caret back the same distance
              // so it still points at the trigger it belongs to.
              ["--tt-caret" as string]: `calc(50% - ${tip.shift ?? 0}px)`,
              ["--tt-caret-y" as string]: `calc(50% - ${tip.shiftY ?? 0}px)`,
              // Until measured, the bubble is positioned but not yet corrected. Painting
              // it in the wrong place for a frame is what the fade-in would otherwise be
              // covering up, and at a viewport edge that frame is a visible jump.
              visibility: tip.shift === undefined ? "hidden" : undefined,
            }}
          >
            {painted}
          </span>,
          document.body,
        )}
    </>
  );
}
