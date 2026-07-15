import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PermissionMode, Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { permissionModeDisplay, PICKABLE_MODES } from "../lib/format.ts";

/**
 * The card's permission-mode chip, clickable to pick a different mode instead of
 * reaching for Shift+Tab in the terminal.
 *
 * Choosing a mode doesn't set it directly - Claude has no such API. The daemon
 * walks the Shift+Tab cycle for us, reading the pane after each step (see
 * `setPermissionMode`). That walk can legitimately fail: the mode may not be
 * enabled for the session, or a dialog may be open and eating the keystroke. So
 * the popover stays open on failure and shows why, rather than closing on a lie.
 *
 * The popover is a body-level portal with fixed positioning, like Tooltip, because
 * `.card` sets `overflow: hidden` and would otherwise clip it.
 */

/** Leave the chip this many px of air. */
const GAP = 8;
/** Popover width; also used to keep it inside the viewport's right edge. */
const WIDTH = 264;

type Anchor = { left: number; top?: number; bottom?: number };

export function ModePicker({ session }: { session: Session }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState<PermissionMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const current = permissionModeDisplay(session.permissionMode);
  // Driving the mode means sending a keystroke, which needs a live pane to send into.
  const canPick = session.state !== "exited" && Boolean(session.tmux || session.wezterm);

  const place = useCallback(() => {
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - WIDTH - GAP));
    // The chip lives in the card footer, so there's usually room above and not
    // below; flip only when opening upward would run off the top.
    const above = r.top > window.innerHeight / 2;
    setAnchor(
      above ? { left, bottom: window.innerHeight - r.top + GAP } : { left, top: r.bottom + GAP },
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    function onDoc(e: MouseEvent): void {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !chipRef.current?.contains(t)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    // Fixed positioning doesn't track a scrolling card, so close rather than drift.
    const onScroll = (): void => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  // A session that reports no mode has no chip to hang this on - same as before
  // the picker existed. With the mode read off the pane each poll, that now only
  // happens when Claude is showing a dialog over its own mode line.
  if (!current) return null;

  if (!canPick) {
    return (
      <span className={`mode mode-${current.tone}`} title={current.title}>
        {current.label}
      </span>
    );
  }

  async function choose(mode: PermissionMode): Promise<void> {
    setBusy(mode);
    setError(null);
    const r = await api.setMode(session.id, mode);
    setBusy(null);
    if (r.ok) setOpen(false);
    else setError(r.error ?? "couldn't change the mode");
  }

  return (
    <>
      <button
        ref={chipRef}
        className={`mode mode-${current.tone} mode-btn${open ? " open" : ""}`}
        title={`${current.title}\nClick to change (or Shift+Tab in the terminal)`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setOpen((o) => !o);
        }}
      >
        {current.label}
        <span className="mode-caret" aria-hidden>
          ⌄
        </span>
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={popRef}
            className="alert-pop mode-pop"
            role="menu"
            aria-label="Permission mode"
            // `left` plus exactly one of top/bottom; `.mode-pop` resolves the rest.
            style={{ width: WIDTH, ...anchor }}
            onClick={(e) => e.stopPropagation()}
          >
            {PICKABLE_MODES.map((m) => {
              const d = permissionModeDisplay(m)!;
              const active = session.permissionMode === m;
              return (
                <button
                  key={m}
                  role="menuitemradio"
                  aria-checked={active}
                  className={`mode-opt${active ? " active" : ""}`}
                  disabled={busy !== null}
                  onClick={() => void choose(m)}
                >
                  <span className={`mode-opt-dot mode-${d.tone}`} aria-hidden />
                  <span className="mode-opt-text">
                    <span className="mode-opt-label">{d.label}</span>
                    <span className="mode-opt-desc">{d.title.split(" - ")[1] ?? d.title}</span>
                  </span>
                  {busy === m && <span className="mode-opt-spin" aria-label="changing" />}
                  {active && busy === null && (
                    <span className="mode-opt-check" aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
            {error && <p className="mode-pop-err">{error}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
