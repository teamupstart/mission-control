import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import {
  resolveContextActions,
  type ContextAction,
  type ContextInfo,
  type ContextPoint,
} from "../lib/context-actions.ts";
import { Tooltip } from "./Tooltip.tsx";

const MENU_WIDTH = 196;
const VIEWPORT_GAP = 8;
const NOTICE_HOLD_MS = 2_600;

interface MenuState {
  actions: ContextAction[];
  anchor: ContextPoint;
  returnFocus: HTMLElement | null;
  nonce: number;
}

interface Notice {
  message: string;
  tone: "ok" | "error";
}

export interface ContextMenuHandle {
  /** Open beside a focused element. Returns false when that element has no actions. */
  openFromKeyboard: (target: Element | null) => boolean;
  close: () => void;
}

function targetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function actionDescription(action: ContextAction): string {
  switch (action.id) {
    case "field.cut": return "Remove the selected text and put it on the clipboard";
    case "field.copy":
    case "selection.copy": return "Put the selected text on the clipboard";
    case "field.paste": return "Insert the clipboard contents at the captured cursor position";
    case "field.paste-quote": return "Insert the clipboard contents as a Markdown quote";
    case "link.copy": return "Put this link's visible text on the clipboard";
    case "link.copy-url": return "Put this link's URL on the clipboard";
    case "link.open": return "Open this link in the system browser";
    default: return action.label;
  }
}

function pointInSelection(selection: Selection, point: ContextPoint): boolean {
  if (selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    for (const rect of selection.getRangeAt(index).getClientRects()) {
      if (
        point.x >= rect.left
        && point.x <= rect.right
        && point.y >= rect.top
        && point.y <= rect.bottom
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The one context-menu host for the whole renderer.
 *
 * It owns the global `contextmenu` listener, placement, focus and dismissal. Product surfaces
 * contribute only target-registry entries, so a transcript or session card never acquires its
 * own right-click state machine.
 */
export function ContextMenuHost({
  ref,
}: {
  ref?: React.Ref<ContextMenuHandle>;
}): React.JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [position, setPosition] = useState<ContextPoint>({ x: VIEWPORT_GAP, y: VIEWPORT_GAP });
  const [notice, setNotice] = useState<Notice | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nonce = useRef(0);
  const copyFeedback = useCopyFeedback();

  const announce = useCallback((message: string, tone: "ok" | "error" = "ok"): void => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ message, tone });
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_HOLD_MS);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const contextInfo = useCallback((selection: string, point?: ContextPoint): ContextInfo => ({
    selection,
    ...(point ? { point } : {}),
    copy: async (text) => {
      const result = await copyFeedback.copy(text);
      return result.copied && result.error === null;
    },
    readClipboard: async () => {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard reads are unavailable");
      return navigator.clipboard.readText();
    },
    openExternal: async (href) => {
      if (window.missionDesktop) {
        await window.missionDesktop.openExternal(href);
        return;
      }
      window.open(href, "_blank", "noopener,noreferrer");
    },
    announce,
  }), [announce, copyFeedback.copy]);

  const openAt = useCallback((
    target: Element,
    anchor: ContextPoint,
    point?: ContextPoint,
  ): boolean => {
    const selection = window.getSelection();
    if (point && selection && !pointInSelection(selection, point)) selection.removeAllRanges();
    const selected = selection && !selection.isCollapsed ? selection.toString() : "";
    const actions = resolveContextActions(target, contextInfo(selected, point));
    if (actions.length === 0) {
      setMenu(null);
      return false;
    }
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(null);
    copyFeedback.reset();
    setPosition(anchor);
    setMenu({
      actions,
      anchor,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      nonce: ++nonce.current,
    });
    return true;
  }, [contextInfo, copyFeedback.reset]);

  const close = useCallback((restoreFocus = false): void => {
    setMenu((current) => {
      if (restoreFocus) current?.returnFocus?.focus({ preventScroll: true });
      return null;
    });
  }, []);

  useImperativeHandle(ref, () => ({
    openFromKeyboard: (target) => {
      if (!target) return false;
      const rect = target.getBoundingClientRect();
      const anchor = {
        x: rect.left + Math.min(24, Math.max(0, rect.width / 2)),
        y: rect.bottom + 4,
      };
      return openAt(target, anchor);
    },
    close: () => close(),
  }), [close, openAt]);

  // Shift+right-click keeps the browser's native developer menu. Every ordinary right-click
  // resolves through the same registry in both the browser build and the Electron renderer.
  useEffect(() => {
    function onContextMenu(event: MouseEvent): void {
      if (event.shiftKey) {
        close();
        return;
      }
      const target = targetElement(event.target);
      if (!target) return;
      const point = { x: event.clientX, y: event.clientY };
      if (openAt(target, point, point)) event.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
  }, [close, openAt]);

  // Clamp horizontally, then flip above the pointer/focus anchor when the measured menu would
  // cross the bottom edge. `useLayoutEffect` makes the corrected coordinates the first paint.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const height = menuRef.current.getBoundingClientRect().height;
    const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP);
    const left = Math.max(VIEWPORT_GAP, Math.min(menu.anchor.x, maxLeft));
    const below = menu.anchor.y;
    const top = below + height + VIEWPORT_GAP <= window.innerHeight
      ? below
      : Math.max(VIEWPORT_GAP, menu.anchor.y - height - 4);
    setPosition({ x: left, y: top });
    menuRef.current
      .querySelector<HTMLButtonElement>(".ctx-menu-row")
      ?.focus({ preventScroll: true });
  }, [menu]);

  const activate = useCallback(async (index: number): Promise<void> => {
    const current = menu;
    const action = current?.actions[index];
    if (!current || !action) return;
    setMenu(null);
    try {
      await action.run();
    } catch {
      announce(action.kind === "open" ? "Could not open link" : "The action did not complete", "error");
    } finally {
      if (!action.id.startsWith("field.")) current.returnFocus?.focus({ preventScroll: true });
    }
  }, [announce, menu]);

  // The menu is an anchored popover, not an Overlay. It therefore seizes keys at window
  // capture and stops them immediately: no grid kill/reset/navigation shortcut may reach the
  // card behind it. Even unused keys are swallowed while this surface owns focus.
  useEffect(() => {
    if (!menu) return;
    function onKey(event: KeyboardEvent): void {
      event.stopImmediatePropagation();
      event.preventDefault();
      const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(".ctx-menu-row") ?? [])];
      const at = Math.max(0, rows.indexOf(document.activeElement as HTMLButtonElement));
      if (event.key === "Escape") {
        close(true);
        return;
      }
      if (rows.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "Tab") {
        const direction = event.shiftKey && event.key === "Tab" ? -1 : 1;
        rows[(at + direction + rows.length) % rows.length]?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "ArrowUp") {
        rows[(at - 1 + rows.length) % rows.length]?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Home") {
        rows[0]?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "End") {
        rows.at(-1)?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "Enter" || event.key === " ") void activate(at);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activate, close, menu]);

  useEffect(() => {
    if (!menu) return;
    function onDown(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) close();
    }
    const dismiss = (): void => close();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("touchmove", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("touchmove", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [close, menu]);

  if (typeof document === "undefined") return null;
  const status = notice
    ?? (copyFeedback.error
      ? { message: copyFeedback.error, tone: "error" as const }
      : copyFeedback.copied
        ? { message: COPY_FEEDBACK_LABEL, tone: "ok" as const }
        : null);

  return createPortal(
    <>
      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu-pop"
          role="menu"
          aria-label="Actions for this item"
          style={{ left: position.x, top: position.y }}
          data-menu-open={menu.nonce}
        >
          {menu.actions.map((action, index) => {
            const previous = menu.actions[index - 1];
            const divided = previous && previous.tier !== action.tier;
            return (
              <Tooltip
                label={actionDescription(action)}
                key={`${action.id}:${action.kind}:${action.payload}`}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={`ctx-menu-row${divided ? " has-divider" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void activate(index);
                  }}
                >
                  <span>{action.label}</span>
                  {action.hint && <span className="ctx-menu-hint" aria-hidden>{action.hint}</span>}
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}
      {status && (
        <div
          className={`ctx-menu-flash action-flash${status.tone === "ok" ? " is-ok" : " is-error"}`}
          role="status"
        >
          {status.message}
        </div>
      )}
    </>,
    document.body,
  );
}
