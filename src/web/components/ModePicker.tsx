import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PermissionMode, Session } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { canWriteTo } from "@shared/pane.ts";
import { api } from "../lib/api.ts";
import { permissionModeDisplay, pickableModes } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The shared permission-mode chip, clickable to pick a different mode instead of
 * reaching for the agent's own terminal control.
 *
 * The daemon uses the harness's declared live mechanism: Claude's verified Shift+Tab
 * walk or Codex's native `/permissions` picker. Either can legitimately fail because
 * a mode is unavailable or another dialog owns the terminal, so the popover stays open
 * on failure and shows why rather than closing on a lie.
 *
 * Renders nothing for a harness that declares no `permissionModes`, so mounting it
 * unconditionally is safe and the layouts do not each carry their own agent check.
 *
 * The popover is a body-level portal with fixed positioning, like Tooltip, because
 * layout containers can otherwise clip it.
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

  const modes = pickableModes(session.agent);
  const liveControl = capabilitiesFor(session.agent).permissionModes?.liveControl;
  const current = permissionModeDisplay(session.permissionMode) ?? {
    label: "permissions",
    tone: "default" as const,
    title: "Permission mode has not been observed yet",
  };
  // Driving the mode writes to the agent TUI, which needs a live pane.
  const canPick = session.state !== "exited" && canWriteTo(session);

  const place = useCallback(() => {
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - WIDTH - GAP));
    // Prefer opening above anchors in the viewport's lower half, where there is
    // usually more room; otherwise open below.
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

  // A harness with no permission modes has nothing to draw, and says so HERE rather than
  // at each of the three layouts that mount this - which is what lets those call sites
  // drop their own agent checks. A capable session whose current mode is not observable
  // still gets a neutral picker: Codex may have a custom profile, or may not have written
  // its first turn_context yet, but the user can still choose a built-in profile.
  if (modes.length === 0) return null;

  if (!canPick) {
    return (
      <Tooltip label={current.title}>
        <span className={`mode mode-${current.tone}`}>{current.label}</span>
      </Tooltip>
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
      <Tooltip
        label={`${current.title} - click to change${
          liveControl?.kind === "cycle" ? " (or Shift+Tab in the terminal)" : ""
        }`}
      >
        <button
          ref={chipRef}
          className={`mode mode-${current.tone} mode-btn${open ? " open" : ""}`}
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
      </Tooltip>

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
            {pickableModes(session.agent).map((m) => {
              const d = permissionModeDisplay(m)!;
              const active = session.permissionMode === m;
              return (
                <Tooltip key={m} label={d.title}>
                <button
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
                </Tooltip>
              );
            })}
            {error && <p className="mode-pop-err">{error}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
