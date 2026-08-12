import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  caretUrlAtPoint,
  contextMenuIsEmpty,
  previewPayload,
  quoteMarkdown,
  resolveContextActions,
  type ContextAction,
  type ContextFieldTarget,
  type ResolvedContextMenu,
} from "../lib/context-actions.ts";
import { COPY_FEEDBACK_HOLD_MS, COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { openExternalUrl } from "../lib/desktop.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The application's right-click menu: one delegated listener, one menu, both builds.
 *
 * The packaged desktop app ships NO context menu at all - Electron installs none, and
 * `src/main/menu.ts` and `src/main/tray.ts` are an application menu and a tray menu, neither of
 * which is a `webContents` menu. So until this component the desktop build had no right-click
 * Copy and no right-click Paste anywhere. A browser tab has Chromium's own, which is why the
 * decision (D2) was one DOM menu rather than a native `Menu` over IPC: the browser build needs
 * this implementation regardless, so the alternative is two implementations of one feature.
 *
 * `Shift`+right-click falls through to the browser's own menu (D1). The users of a developer
 * tool on localhost want View Source and Inspect, and Firefox's convention keeps them one
 * modifier away without spending a row on them.
 *
 * NOT an `Overlay`. `Overlay.tsx` has one return path and it renders `.modal-backdrop`
 * unconditionally - a full-screen blurred veil with the panel as a CENTRED FLEX CHILD, which is
 * structurally hostile to `left: clientX; top: clientY` - and joining the registry would set
 * `anyOpen`, which stands down App's entire global handler and kills its Escape ladder. This
 * takes the anchored-popover contract instead (`OpenInMenu.tsx:86-99`): capture-phase `window`
 * keydown, `stopImmediatePropagation`. It also SWALLOWS every key it does not use, which
 * `test/overlay-registry.test.ts:89-136` records as an unfixed gap for the six popovers already
 * outside the registry - while one is open, `k` and `r` still reach the card behind it. A menu
 * is opened on a target with the operator's hands on the keyboard, so it is the surface where a
 * stray `kill` matters most; this closes that gap for itself rather than inheriting it.
 */

/** Air between the menu and whatever it hangs off. */
const GAP = 8;

/** Where the menu wants to sit, before it has been measured against the viewport. */
interface MenuAnchor {
  left: number;
  /** Preferred top edge. */
  top: number;
  /**
   * Where the menu's BOTTOM goes when it does not fit below - the cursor point for a
   * right-click, the top of the focused control for a keyboard open.
   */
  flipTo: number;
}

interface OpenState {
  menu: ResolvedContextMenu;
  anchor: MenuAnchor;
  /** What opened it. Decides where focus lands - see the focus effect. */
  source: "pointer" | "keyboard";
  /** Null until measured. Rendering before then would paint the menu in the wrong place. */
  placed: { left: number; top: number } | null;
}

/** A transient confirmation. */
interface Notice {
  tone: "ok" | "error";
  text: string;
  detail?: string;
}

export interface ContextMenuHandle {
  /**
   * Open the menu on a focused element rather than a cursor point - `Shift+F10` and the Menu
   * key. False when the element offers nothing, so the caller can leave the keystroke to the
   * browser instead of eating it.
   */
  openAtElement: (el: Element) => boolean;
}

/**
 * The rows, split out from the host the way `OpenInList` is split out of `OpenInMenu`: the
 * interesting rendering rules are then reachable from a `renderToStaticMarkup` test, which
 * never runs an effect and so can never open the real menu.
 *
 * Each row is wrapped in its own `Tooltip`, which `test/tooltip-coverage.test.ts` requires of
 * every interactive control and which earns its place here: the tooltip is where the FULL
 * payload goes, so a reader can confirm what a row will write before choosing it, and it is
 * also the row's accessible description. The `hint` is a short qualifier for the eye only and
 * is `aria-hidden`, which leaves each row's accessible name exactly its label - so `Copy` and
 * `Copy URL` stay distinguishable to a screen reader and to a test.
 */
export function ContextMenuRows({
  menu,
  onChoose,
}: {
  menu: ResolvedContextMenu;
  onChoose: (action: ContextAction) => void;
}): React.JSX.Element {
  const row = (action: ContextAction): React.JSX.Element => (
    <Tooltip key={action.id} label={action.description}>
      <button type="button" role="menuitem" className="ctx-row" onClick={() => onChoose(action)}>
        <span className="ctx-label">{action.label}</span>
        {action.hint && (
          <span className="ctx-hint" aria-hidden>
            {action.hint}
          </span>
        )}
      </button>
    </Tooltip>
  );
  return (
    <>
      {menu.item.map(row)}
      {menu.item.length > 0 && menu.container.length > 0 && (
        <div className="ctx-sep" role="separator" />
      )}
      {menu.container.map(row)}
    </>
  );
}

/** Is this point inside the selection's own rectangles? */
function pointInSelection(x: number, y: number): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (const rect of selection.getRangeAt(0).getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

/**
 * Replace a span of a text field, so React sees it and the operator can undo it.
 *
 * Assigning `field.value` is not enough on its own: every composer in this app is a CONTROLLED
 * input, so React would overwrite the write on the next render and `onChange` would never fire.
 * `execCommand("insertText")` is the one call that performs a real editing operation - it fires
 * `beforeinput`/`input`, which is what React's `onChange` is built on, and it joins the field's
 * native undo stack, so ⌘Z after a right-click Paste does what it looks like it should. The
 * same deprecation-with-no-replacement applies to it as to the `execCommand("copy")` fallback
 * `clipboard.ts` already depends on for this renderer.
 *
 * The fallback covers a browser that refuses it, and gets React's attention by dispatching the
 * `input` event itself through the prototype's native value setter - assigning through the
 * instance would be swallowed by React's own value tracker.
 */
function replaceFieldRange(target: ContextFieldTarget, text: string): void {
  const { element, start, end } = target;
  element.focus({ preventScroll: true });
  element.setSelectionRange(Math.min(start, end), Math.max(start, end));
  // `delete` rather than inserting an empty string: removing the selection is its own editing
  // command, and `insertText` with "" is not reliably treated as one.
  const edited = text
    ? document.execCommand("insertText", false, text)
    : document.execCommand("delete");
  if (edited) return;

  const prototype =
    element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const next = element.value.slice(0, from) + text + element.value.slice(to);
  setter?.call(element, next);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = from + text.length;
  element.setSelectionRange(caret, caret);
}

export function ContextMenuHost({
  register,
}: {
  register?: (handle: ContextMenuHandle | null) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<OpenState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<number | null>(null);

  /*
   * The clipboard half comes from phase 1's helper rather than a seventh hand-rolled label
   * flip: it owns the `copyText` fallback the Electron renderer needs, the generation guard
   * that stops two copies settling out of order from publishing contradicting outcomes, and
   * the failure sentence. What it publishes is not rendered here, because a menu closes on
   * activation - the confirmation has to outlive it, so it belongs to the host and appears as
   * the transient line below. `copy()` never rejects; it RETURNS the outcome, which is exactly
   * the shape a surface with one message slot of its own is meant to use.
   */
  const feedback = useCopyFeedback();

  const showNotice = useCallback((next: Notice) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, COPY_FEEDBACK_HOLD_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  /*
   * Where the keyboard was when the menu opened, so closing can put it back.
   *
   * A ref and not part of the open state, because restoring focus is a side effect and a state
   * updater is not the place for one: React invokes updaters twice under StrictMode, which
   * would make the restore happen twice in development and once in the build.
   */
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(null);
    if (restoreFocus) returnFocus.current?.focus({ preventScroll: true });
    returnFocus.current = null;
  }, []);

  const show = useCallback(
    (menu: ResolvedContextMenu, anchor: MenuAnchor, source: "pointer" | "keyboard") => {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement ? active : null;
      setOpen({ menu, anchor, source, placed: null });
    },
    [],
  );

  // ---- opening ------------------------------------------------------------

  useEffect(() => {
    function onContextMenu(event: MouseEvent): void {
      // D1. The one gesture that still reaches View Source and Inspect.
      if (event.shiftKey) return;
      // An embedded surface that has already answered this right-click keeps it.
      if (event.defaultPrevented) return;
      const el = event.target instanceof Element ? event.target : null;
      if (!el) return;

      /*
       * A right-click OUTSIDE the current selection collapses it BEFORE anything is resolved,
       * which is what every browser does and what stops `Copy` writing something the reader is
       * no longer pointing at. Right-clicking inside it keeps it, so a selection-aware `Copy`
       * stays honest. Compared against the selection's own rectangles rather than any element,
       * because a selection is a Range and does not belong to one.
       */
      if (!pointInSelection(event.clientX, event.clientY)) {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) selection.removeAllRanges();
      }

      const menu = resolveContextActions(el, {
        selection: window.getSelection()?.toString().trim() ?? "",
        urlAtPoint: caretUrlAtPoint(event.clientX, event.clientY, document),
      });
      // Nothing to offer, so leave the gesture alone: in a browser tab that yields Chromium's
      // own menu, which is strictly better than a menu with no rows.
      if (contextMenuIsEmpty(menu)) return;

      event.preventDefault();
      show(menu, { left: event.clientX, top: event.clientY, flipTo: event.clientY }, "pointer");
    }
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, [show]);

  const openAtElement = useCallback(
    (el: Element): boolean => {
      // No cursor, so no caret scan and no selection to collapse - the reader pointed at
      // nothing, and a keyboard open must never disturb what they had selected.
      const menu = resolveContextActions(el, {
        selection: window.getSelection()?.toString().trim() ?? "",
        urlAtPoint: "",
      });
      if (contextMenuIsEmpty(menu)) return false;
      const rect = el.getBoundingClientRect();
      show(menu, { left: rect.left, top: rect.bottom + GAP, flipTo: rect.top - GAP }, "keyboard");
      return true;
    },
    [show],
  );

  useEffect(() => {
    register?.({ openAtElement });
    return () => register?.(null);
  }, [register, openAtElement]);

  // ---- placement ----------------------------------------------------------

  /*
   * Measured on the ref callback, the way `Tooltip` measures its bubble: it runs before paint
   * on the client and is never invoked by `renderToStaticMarkup`. A cursor-anchored menu cannot
   * be placed from the anchor alone the way `ModePicker` places its popover, because how far it
   * hangs below the cursor depends on how many rows the resolver produced.
   */
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setOpen((current) => {
      if (!current || current.placed) return current;
      const rect = el.getBoundingClientRect();
      const { anchor } = current;
      const left = Math.max(GAP, Math.min(anchor.left, window.innerWidth - rect.width - GAP));
      const fits = anchor.top + rect.height + GAP <= window.innerHeight;
      const top = fits ? anchor.top : Math.max(GAP, anchor.flipTo - rect.height);
      return { ...current, placed: { left, top } };
    });
  }, []);

  // One stable callback rather than an inline arrow, which React would tear down and re-run
  // with null on every render.
  const attachMenu = useCallback(
    (el: HTMLDivElement | null) => {
      menuRef.current = el;
      measure(el);
    },
    [measure],
  );

  /*
   * Focus moves INTO the menu either way, so the keys below have somewhere to land and nothing
   * behind it can be typed into - but WHERE depends on who opened it.
   *
   * A keyboard open takes the first row, so Enter works immediately and the row's tooltip
   * announces what it will write. That tooltip is the whole point for a keyboard user, who has
   * no hover.
   *
   * A pointer open takes the menu itself. Row tooltips fire on focus as well as hover - which
   * is what makes them reachable without a mouse - and a cursor-anchored menu is by definition
   * drawn ON the thing that was clicked, so focusing a row on open paints its bubble straight
   * over the link, the selection or the turn the reader just pointed at. The evidence shots
   * made that obvious in a way the markup could not. Hovering any row still shows it, which is
   * what a pointer user is asking for when they hover.
   *
   * `preventScroll` is load-bearing rather than tidy: focusing can make the browser scroll to
   * reveal the target, and this menu floats over `.transcript-log`, which is a scroll
   * container - so a plain `focus()` lets the menu close itself on open, intermittently,
   * depending on where the cursor was. Gated on `placed` because a menu is `visibility: hidden`
   * until it has been measured, and a hidden element cannot take focus at all.
   */
  useEffect(() => {
    if (!open?.placed) return;
    const menu = menuRef.current;
    if (!menu) return;
    const target =
      open.source === "keyboard" ? menu.querySelector<HTMLButtonElement>(".ctx-row") : null;
    (target ?? menu).focus({ preventScroll: true });
  }, [open?.placed, open?.source]);

  // ---- dismissal ----------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    const dismiss = (): void => close(false);
    function onDown(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    }
    /*
     * The reader's scroll INPUT, never the scroll EVENT. `ModePicker` closes on any scroll
     * because a fixed popover cannot track the chip it hangs off; this menu opens at a point
     * and has no anchor to drift from, so the only reason to close is that the reader moved the
     * view themselves. Listening to `scroll` is actively wrong here: one dispatched a frame
     * after the menu opens closes it immediately, and in this product that frame belongs to
     * `.transcript-log` auto-scrolling as a streamed turn arrives - the menu would slam shut
     * mid-read through no action of the reader's.
     */
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", dismiss, { passive: true });
    window.addEventListener("touchmove", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", dismiss);
      window.removeEventListener("touchmove", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close]);

  // ---- keys ---------------------------------------------------------------

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      /*
       * Capture-at-window and stopped IMMEDIATELY, not merely stopped. `KeyboardPanel` is a
       * second capture-phase window listener, so ordering between the two is registration order
       * and only the immediate form is deterministic; the weaker call would be correct by the
       * accident of what phase everyone else picked.
       *
       * Every key is seized, not just the ones below. While this is up it is the topmost
       * surface, and App's grid handler is still live behind it - `k` kills, `r` opens Runs,
       * `c` completes. A context menu is opened ON a target with the operator's hands on the
       * keyboard, so an unclaimed keystroke reaching the card behind it is the worst version of
       * the gap the six unregistered popovers already have.
       */
      event.stopImmediatePropagation();
      const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(".ctx-row") ?? [])];
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      switch (event.key) {
        case "Escape":
        // Nowhere for the keyboard to go inside a menu, so Tab leaves it the way Escape does
        // rather than walking out to whatever happens to follow a body-level portal.
        case "Tab":
          event.preventDefault();
          close(true);
          return;
        case "ArrowDown":
        case "ArrowUp": {
          if (rows.length === 0) return;
          event.preventDefault();
          const down = event.key === "ArrowDown";
          // `at` is -1 while focus is on the menu itself, which is where a pointer-opened menu
          // starts. From there the first Down is the first row and the first Up is the last,
          // rather than whatever the modulo below would land on.
          const next = at < 0 ? (down ? 0 : rows.length - 1) : (at + (down ? 1 : -1) + rows.length) % rows.length;
          rows[next]?.focus({ preventScroll: true });
          return;
        }
        case "Home":
          event.preventDefault();
          rows[0]?.focus({ preventScroll: true });
          return;
        case "End":
          event.preventDefault();
          rows[rows.length - 1]?.focus({ preventScroll: true });
          return;
        case "Enter":
        case " ":
          // Activation is the browser's: a focused `<button>` clicks itself on both keys, and
          // it can only do that if the event is not defaultPrevented. Propagation is still
          // stopped above, so nothing behind the menu sees it.
          return;
        default:
          // Everything else is swallowed - but the DEFAULT is left alone for a command chord,
          // so ⌘R still reloads and ⌘Q still quits rather than dying silently in a menu.
          if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // ---- performing ---------------------------------------------------------

  const openLink = useCallback(
    async (url: string): Promise<void> => {
      /*
       * Awaited, and the failure reported. `missionDesktop.openExternal` is backed by
       * `shell.openExternal` in main, whose promise rejects on a malformed URL or a scheme with
       * no registered handler - so firing and forgetting would both tell the operator "Opened"
       * over a link that did not open AND leave an unhandled rejection behind it.
       */
      try {
        await openExternalUrl(url);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message.trim() : "";
        showNotice({
          tone: "error",
          text: message === "" ? "The link did not open" : message,
          detail: previewPayload(url, 90),
        });
        return;
      }
      showNotice({ tone: "ok", text: "Opened", detail: previewPayload(url, 90) });
    },
    [showNotice],
  );

  const write = useCallback(
    async (payload: string, detail = payload): Promise<boolean> => {
      const outcome = await feedback.copy(payload);
      showNotice(
        outcome.error
          ? { tone: "error", text: outcome.error }
          : { tone: "ok", text: COPY_FEEDBACK_LABEL, detail: previewPayload(detail, 90) },
      );
      return outcome.error === null;
    },
    [feedback, showNotice],
  );

  const paste = useCallback(
    async (action: ContextAction): Promise<void> => {
      const field = action.field;
      if (!field) return;
      let text: string;
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard) throw new Error("no clipboard");
        text = await clipboard.readText();
      } catch {
        /*
         * Q2, and the one item a DOM menu genuinely does worse than an OS menu. Reading the
         * clipboard needs the `clipboard-read` permission: already granted in the Electron
         * renderer, prompted on first use in a browser tab and refusable there. Say so and
         * point at the accelerator that never needs asking, rather than doing nothing.
         */
        field.element.focus({ preventScroll: true });
        showNotice({
          tone: "error",
          text: "Paste needs clipboard permission",
          detail: "press ⌘V, which always works",
        });
        return;
      }
      if (!text) {
        showNotice({ tone: "error", text: "The clipboard is empty" });
        field.element.focus({ preventScroll: true });
        return;
      }
      const inserted = action.kind === "paste-quote" ? quoteMarkdown(text) : text;
      replaceFieldRange(field, inserted);
      showNotice({
        tone: "ok",
        text: action.kind === "paste-quote" ? "Pasted as quote" : "Pasted",
        detail: previewPayload(inserted, 90),
      });
    },
    [showNotice],
  );

  const choose = useCallback(
    (action: ContextAction) => {
      // Closed first, and focus is only handed back for the actions that do not place it
      // themselves - a field action ends with the caret in the field it edited.
      close(action.field === undefined);
      switch (action.kind) {
        case "open":
          void openLink(action.payload);
          return;
        case "copy":
          if (action.field) action.field.element.focus({ preventScroll: true });
          void write(action.payload);
          return;
        case "cut":
          void write(action.payload).then((ok) => {
            // Only after the clipboard actually took it. Cutting text nobody can paste back is
            // the one failure in this menu that loses work.
            if (ok && action.field) replaceFieldRange(action.field, "");
          });
          return;
        case "paste":
        case "paste-quote":
          void paste(action);
      }
    },
    [close, openLink, paste, write],
  );

  // ---- render -------------------------------------------------------------

  return (
    <>
      {open &&
        createPortal(
          <div
            ref={attachMenu}
            className="ctx-menu"
            role="menu"
            aria-label="Context actions"
            // Focusable but not tabbable: a pointer-opened menu parks focus here, so the keys
            // have somewhere to land without a row's tooltip covering what was clicked.
            tabIndex={-1}
            style={{
              left: open.placed?.left ?? open.anchor.left,
              top: open.placed?.top ?? open.anchor.top,
              // Measured but not yet corrected: painting it at the raw anchor for a frame is a
              // visible jump at a viewport edge, and a hidden element cannot take focus, which
              // is what keeps the focus effect above from firing early.
              visibility: open.placed ? undefined : "hidden",
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <ContextMenuRows menu={open.menu} onChoose={choose} />
          </div>,
          document.body,
        )}
      {notice &&
        createPortal(
          <div
            className={`ctx-flash${notice.tone === "error" ? " is-error" : ""}`}
            role="status"
          >
            <b>{notice.text}</b>
            {notice.detail && <span>{notice.detail}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
