import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * The shared overlay primitive, and the single source of truth for "is an overlay open".
 *
 * Six components used to hand-roll the same four things - the backdrop, `stopPropagation`
 * on the panel, their own Escape handler, and the `.modal-*` class vocabulary - and App
 * then hand-enumerated the open ones in FOUR separate places (the sitrep-toggle guard, the
 * stand-down guard, that effect's dependency array, and a session-disappeared effect).
 *
 * The failure that motivates this is silent: an overlay missing from the stand-down list
 * leaves the global key handler live, so grid shortcuts drive - and act on - the card
 * behind the overlay you are looking at. Nothing throws; you just kill the wrong session.
 *
 * So membership is not a list anyone maintains. An `<Overlay>` registers itself on mount
 * and unregisters on unmount, which makes "rendered" and "counted as open" the same fact.
 * Rendering one outside `<OverlayHost>` throws rather than going uncounted - the whole
 * point is that an overlay cannot exist without the guards knowing about it.
 *
 * Escape is deliberately NOT centralised into App. The documented invariant (see the
 * comments in ReportPanel and DiffViewer) is that App stands down while an overlay is up
 * and the overlay closes itself; that still holds, because the listener below belongs to
 * the overlay INSTANCE, not to App. What the primitive adds is that only the topmost
 * overlay acts on a keystroke, so one Escape closes exactly one layer.
 */

/**
 * Every overlay's id, in one place. Only `sitrep` is read back by name (its shortcut is a
 * toggle, so it has to recognise itself); the rest exist so a typo is a compile error and
 * so this list doubles as the inventory the parity test walks.
 */
export const OVERLAY_IDS = {
  attention: "attention",
  reviews: "reviews",
  dispatch: "dispatch",
  sitrep: "sitrep",
  diff: "diff",
  reset: "reset",
  complete: "complete",
  kill: "kill",
  assignReset: "assign-reset",
  digest: "digest",
  files: "files",
  filePicker: "file-picker",
  workflowBinding: "workflow-binding",
  workflowConfirm: "workflow-confirm",
  palette: "palette",
  recurringMissions: "recurring-missions",
  personaDirective: "persona-directive",
} as const;

export type OverlayId = (typeof OVERLAY_IDS)[keyof typeof OVERLAY_IDS];

/** One live registration. The token, not the id, identifies it - see `register`. */
export interface OverlayEntry {
  token: symbol;
  id: string;
}

type RegisterFn = (token: symbol, id: string) => () => void;

/**
 * Split in two on purpose. `register` must be referentially stable or the registration
 * effect would unregister and re-register on every stack change - which is itself a stack
 * change, and so would never settle. The stack is read during render, where churn is fine.
 */
const OverlayRegisterContext = createContext<RegisterFn | null>(null);
const OverlayStackContext = createContext<readonly OverlayEntry[]>([]);

/**
 * Registration runs in a LAYOUT effect, so it lands in the SAME commit that puts the
 * overlay on screen: React runs layout effects during commit and flushes the state update
 * they schedule before yielding to the event loop. A passive `useEffect` is flushed at the
 * start of the next render instead, which leaves an interval where the overlay is on
 * screen but the registry has not been told - so do not "tidy" this back to `useEffect`.
 *
 * This alone is not sufficient, and did not used to be: App's key handler read the
 * registry through a closure re-subscribed by a passive effect, so it kept the PREVIOUS
 * value across that interval even once the registry itself was correct. App therefore
 * reads the registry through a ref (see `overlaysRef` in App.tsx); the two together are
 * what make "on screen" and "counted as open" the same commit. Neither helps if a render
 * is deferred - an overlay opened inside `startTransition` could be delayed before commit,
 * and nothing here uses transitions.
 *
 * Falls back to `useEffect` with no DOM, where effects never run anyway and
 * `useLayoutEffect` would only warn.
 */
const useRegistrationEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface OverlayHostValue {
  /**
   * Ordered registrations; the last one is topmost. Tokens, not ids, identify them. The
   * single carrier of what is open - ids are DERIVED from this rather than travelling
   * alongside it, because two representations of one fact are a parallel list to keep in
   * step, which is the failure this whole module exists to remove.
   */
  openEntries: readonly OverlayEntry[];
  /** True when any overlay owns the screen - the stand-down condition. */
  anyOpen: boolean;
  /**
   * True when nothing is open except (optionally) `id`. This is what lets a toggle
   * shortcut close its OWN overlay while still standing down for everyone else's.
   */
  onlyOpen: (id: string) => boolean;
  register: RegisterFn;
}

/**
 * Owns the registry. Lives in App because App is what reads it - the guards and the key
 * handler's dependency array are its only consumers.
 */
export function useOverlayHost(): OverlayHostValue {
  const [entries, setEntries] = useState<OverlayEntry[]>([]);

  // Keyed by the caller's per-instance token rather than by id so a double-invoked effect
  // (StrictMode mounts, cleans up, and mounts again) can only ever remove its own
  // registration, and two overlays sharing an id can't delete each other's.
  const register = useCallback<RegisterFn>((token, id) => {
    setEntries((es) => [...es, { token, id }]);
    return () => setEntries((es) => es.filter((e) => e.token !== token));
  }, []);

  return useMemo(
    () => ({ openEntries: entries, ...overlayGuards(entries.map((e) => e.id)), register }),
    [entries, register],
  );
}

/**
 * The two questions App's key handler asks, as a pure function of what's open - so the
 * guards can be tested without a DOM, which this repo's runner doesn't have.
 */
export function overlayGuards(openIds: readonly string[]): {
  anyOpen: boolean;
  onlyOpen: (id: string) => boolean;
} {
  return {
    anyOpen: openIds.length > 0,
    // Vacuously true when nothing is open, which is what makes the sitrep chord work
    // from a clean screen as well as from its own panel.
    onlyOpen: (id: string) => openIds.every((open) => open === id),
  };
}

/** Publishes the registry to the overlays beneath it. */
export function OverlayHost({
  value,
  children,
}: {
  value: OverlayHostValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <OverlayRegisterContext.Provider value={value.register}>
      <OverlayStackContext.Provider value={value.openEntries}>
        {children}
      </OverlayStackContext.Provider>
    </OverlayRegisterContext.Provider>
  );
}

export function Overlay({
  id,
  onClose,
  className,
  as: Tag = "div",
  role,
  ariaLabel,
  closable = true,
  onKeyDown,
  children,
}: {
  /** Stable identity for this overlay, so a toggle shortcut can recognise its own. */
  id: string;
  onClose: () => void;
  /** The panel's own classes. The backdrop is the primitive's; the panel stays the
   *  caller's, which is how a centered `.modal` and a slide-over `.report-panel` share
   *  this without being forced to look alike. */
  className: string;
  /** The panel element. `aside` for the slide-overs, which are landmarks, not boxes. */
  as?: "div" | "aside";
  role?: string;
  ariaLabel?: string;
  /**
   * Whether the overlay may be dismissed right now. Gates the backdrop click AND Escape
   * together - a half-finished reset must not be abandoned by either route, and having
   * one guard rather than two is what keeps them from drifting apart.
   */
  closable?: boolean;
  /**
   * Keys the overlay wants beyond Escape (the diff viewer walks its file list). Only
   * fires while this overlay is topmost. Memoise it, or the listener re-subscribes on
   * every render.
   */
  onKeyDown?: (e: KeyboardEvent) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const register = useContext(OverlayRegisterContext);
  const stack = useContext(OverlayStackContext);
  // One token per Overlay INSTANCE, so identity survives re-renders but is never shared
  // with another overlay that happens to carry the same id.
  const tokenRef = useRef<symbol | null>(null);
  tokenRef.current ??= Symbol(id);
  const token = tokenRef.current;
  if (!register) {
    throw new Error(
      `<Overlay id="${id}"> was rendered outside <OverlayHost>. An overlay that isn't ` +
        `registered isn't counted as open, which leaves the global key handler live and ` +
        `lets grid shortcuts act on the card behind it.`,
    );
  }

  useRegistrationEffect(() => register(token, id), [register, token, id]);

  // Last registered wins. Nothing in the app stacks overlays today (opening one closes
  // the other in the same commit), but nothing PREVENTED it either, and a stray second
  // listener would close two layers on one Escape. Compared by token, not id: ids are not
  // guaranteed unique, and two overlays sharing one would otherwise both be "topmost".
  const isTop = stack.length > 0 && stack[stack.length - 1]?.token === token;

  useEffect(() => {
    if (!isTop) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        if (closable) onClose();
        return;
      }
      onKeyDown?.(e);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isTop, closable, onClose, onKeyDown]);

  return (
    <div className="modal-backdrop" onClick={() => closable && onClose()}>
      <Tag
        className={className}
        role={role}
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </Tag>
    </div>
  );
}
