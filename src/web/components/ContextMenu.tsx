import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { COPY_FEEDBACK_HOLD_MS, useCopyFeedback } from "../lib/clipboard.ts";
import {
  resolveContextActions,
  urlAtPoint,
  type ContextActionEnvironment,
  type ContextPoint,
  type ResolvedContextAction,
} from "../lib/context-actions.ts";
import { Tooltip } from "./Tooltip.tsx";

const VIEWPORT_GAP = 8;

interface MenuState {
  actions: ResolvedContextAction[];
  anchor: ContextPoint;
  position: ContextPoint | null;
  returnFocus: HTMLElement | null;
}

interface Notice {
  message: string;
  detail: string;
  error: boolean;
}

export interface ContextMenuHostHandle {
  /** Open beside the focused element. Returns false when the element has no actions. */
  openFromKeyboard: (target: Element | null) => boolean;
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function selectionContainsPoint(selection: Selection, point: ContextPoint): boolean {
  if (selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    for (const rect of selection.getRangeAt(index).getClientRects()) {
      if (
        point.x >= rect.left && point.x <= rect.right &&
        point.y >= rect.top && point.y <= rect.bottom
      ) return true;
    }
  }
  return false;
}

function liveSelection(target: Element | null = null): string {
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  if (!selection || text.trim() === "") return "";
  if (!target) return text;
  for (let index = 0; index < selection.rangeCount; index++) {
    try {
      if (selection.getRangeAt(index).intersectsNode(target)) return text;
    } catch {
      // A detached target cannot own the selection that remains in the live document.
    }
  }
  return "";
}

function keyboardAnchor(target: Element): ContextPoint {
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
  }
  return { x: rect.left, y: rect.bottom };
}

export const ContextMenuHost = forwardRef<ContextMenuHostHandle>(function ContextMenuHost(
  _props,
  forwardedRef,
): React.JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copied");
  const {
    copied,
    error: copyError,
    copy: performCopy,
    reset: resetCopy,
  } = useCopyFeedback();
  const menuRef = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<number | null>(null);

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimer.current === null) return;
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
  }, []);

  const showStatus = useCallback((message: string, detail = "", error = false): void => {
    clearNoticeTimer();
    resetCopy();
    setNotice({ message, detail, error });
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, COPY_FEEDBACK_HOLD_MS);
  }, [clearNoticeTimer, resetCopy]);

  useEffect(() => () => clearNoticeTimer(), [clearNoticeTimer]);

  const open = useCallback((
    target: Element,
    anchor: ContextPoint,
    pointUrl: string | null,
    selectionText = liveSelection(),
  ) => {
    const actions = resolveContextActions(target, {
      selectionText,
      pointUrl,
    });
    if (actions.length === 0) return false;
    const focused = document.activeElement;
    setMenu({
      actions,
      anchor,
      position: null,
      returnFocus: focused instanceof HTMLElement ? focused : null,
    });
    return true;
  }, []);

  const openFromKeyboard = useCallback((target: Element | null): boolean => {
    if (!target) return false;
    return open(target, keyboardAnchor(target), null, liveSelection(target));
  }, [open]);

  useImperativeHandle(forwardedRef, () => ({ openFromKeyboard }), [openFromKeyboard]);

  // One delegated listener covers every current and future target. Shift preserves Chromium's
  // native menu for developer tools, matching the convention selected in the plan review.
  useEffect(() => {
    function onContextMenu(event: MouseEvent): void {
      if (event.shiftKey) {
        setMenu(null);
        return;
      }
      const target = eventElement(event.target);
      if (!target) return;
      const point = { x: event.clientX, y: event.clientY };
      const selection = window.getSelection();
      if (selection && !selectionContainsPoint(selection, point)) selection.removeAllRanges();
      if (!open(target, point, urlAtPoint(document, point))) return;
      event.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [open]);

  const restoreFocus = useCallback((target: HTMLElement | null) => {
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  const dismiss = useCallback((restore = false) => {
    setMenu((current) => {
      if (restore) restoreFocus(current?.returnFocus ?? null);
      return null;
    });
  }, [restoreFocus]);

  useLayoutEffect(() => {
    if (!menu || menu.position || !menuRef.current) return;
    const bounds = menuRef.current.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(menu.anchor.x, window.innerWidth - bounds.width - VIEWPORT_GAP),
    );
    const top = menu.anchor.y + bounds.height + VIEWPORT_GAP > window.innerHeight
      ? Math.max(VIEWPORT_GAP, menu.anchor.y - bounds.height)
      : Math.max(VIEWPORT_GAP, menu.anchor.y);
    setMenu((current) => current ? { ...current, position: { x: left, y: top } } : null);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu?.position) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, [menu?.position]);

  const environment = useCallback((): ContextActionEnvironment => ({
    copy: async (text, successLabel = "Copied") => {
      clearNoticeTimer();
      setNotice(null);
      setCopyLabel(successLabel);
      const outcome = await performCopy(text);
      return outcome.error === null;
    },
    readClipboard: async () => {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard read is unavailable");
      return navigator.clipboard.readText();
    },
    openExternal: async (url) => {
      try {
        if (window.missionDesktop) await window.missionDesktop.openExternal(url);
        else window.open(url, "_blank", "noopener");
      } catch {
        showStatus("Could not open link", url, true);
      }
    },
    status: showStatus,
  }), [clearNoticeTimer, performCopy, showStatus]);

  const activate = useCallback(async (action: ResolvedContextAction) => {
    const returnFocus = menu?.returnFocus ?? null;
    setMenu(null);
    await action.run(environment());
    if (document.activeElement === document.body) restoreFocus(returnFocus);
  }, [environment, menu?.returnFocus, restoreFocus]);

  // Context menus follow the anchored-popover key contract: capture at window, stop every
  // key immediately, and handle their own navigation. This prevents grid kill/reset shortcuts
  // from reaching a card behind the menu.
  useEffect(() => {
    if (!menu) return;
    function onKey(event: KeyboardEvent): void {
      event.stopImmediatePropagation();
      event.preventDefault();
      const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      if (event.key === "Escape") {
        dismiss(true);
        return;
      }
      if (rows.length === 0) return;
      const current = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown") {
        rows[(current + 1 + rows.length) % rows.length]?.focus({ preventScroll: true });
      } else if (event.key === "ArrowUp") {
        rows[(current - 1 + rows.length) % rows.length]?.focus({ preventScroll: true });
      } else if (event.key === "Home") {
        rows[0]?.focus({ preventScroll: true });
      } else if (event.key === "End") {
        rows.at(-1)?.focus({ preventScroll: true });
      } else if (event.key === "Enter" || event.key === " ") {
        (rows.includes(document.activeElement as HTMLButtonElement)
          ? document.activeElement as HTMLButtonElement
          : rows[0])?.click();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dismiss, menu]);

  useEffect(() => {
    if (!menu) return;
    function onMouseDown(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    }
    const close = (): void => dismiss();
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("wheel", close, { passive: true, capture: true });
    window.addEventListener("touchmove", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("touchmove", close, true);
      window.removeEventListener("resize", close);
    };
  }, [dismiss, menu]);

  const status = copied
    ? { message: copyLabel, detail: "", error: false }
    : copyError
      ? { message: "Copy failed", detail: copyError, error: true }
      : notice;

  if (!menu && !status) return null;
  let previousTier: string | null = null;
  return createPortal(
    <>
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          aria-label="Actions"
          style={{
            left: menu.position?.x ?? menu.anchor.x,
            top: menu.position?.y ?? menu.anchor.y,
            visibility: menu.position ? "visible" : "hidden",
          }}
        >
          {menu.actions.map((action) => {
            const separated = previousTier !== null && action.tier !== previousTier;
            previousTier = action.tier;
            return (
              <div key={`${action.id}:${action.payload}`} className={separated ? "context-menu-group" : undefined}>
                <Tooltip label={action.description ?? action.label}>
                  <button
                    type="button"
                    className="context-menu-row"
                    role="menuitem"
                    onClick={() => { void activate(action); }}
                  >
                    <span className="context-menu-label">{action.label}</span>
                    {action.hint && <span className="context-menu-hint" aria-hidden>{action.hint}</span>}
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
      {status && (
        <div className={`context-menu-flash${status.error ? " is-error" : ""}`} role="status">
          <strong>{status.message}</strong>
          {status.detail && <span>{status.detail}</span>}
        </div>
      )}
    </>,
    document.body,
  );
});
