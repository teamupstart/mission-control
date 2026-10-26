import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip } from "./Tooltip.tsx";

export function SessionToolbarIcon({ kind }: { kind: "chat" | "terminal" | "control" }): React.JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "chat" ? <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z" />
      : kind === "terminal" ? <><rect x="2" y="4" width="20" height="16" rx="3" /><path d="m6 9 3 3-3 3m7 0h4" /></>
      : <><rect x="2" y="3" width="8" height="7" rx="2" /><rect x="14" y="14" width="8" height="7" rx="2" /><path d="M14 6h3a2 2 0 0 1 2 2v3m-9 7H7a2 2 0 0 1-2-2v-3" /></>}
  </svg>;
}

/** Compact session controls share focus, dismissal and viewport-safe menu placement. */
export function SessionToolbarMenu({ label, title, icon, className = "", children }: {
  label: string;
  title: string;
  icon: React.ReactNode;
  className?: string;
  children: (close: () => void) => React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); button.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(272, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setAnchor(rect.top > window.innerHeight / 2
        ? { left, bottom: window.innerHeight - rect.top + 6 }
        : { left, top: rect.bottom + 6 });
    };
    place();
    // Position the portal before focus opens a row's tooltip at its measured coordinates.
    const frame = requestAnimationFrame(() => {
      const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
      (selected ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu.current)?.focus();
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") { setOpen(false); button.current?.focus(); return; }
      if (!["Escape", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") { close(); return; }
      const rows = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
        : at < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
        : (at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [open]);

  return <>
    <Tooltip label={label}>
      <button ref={button} type="button" className={`launch-btn session-toolbar-btn ${className}`} aria-label={label}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {icon}<span className="session-toolbar-caret" aria-hidden="true">⌄</span>
      </button>
    </Tooltip>
    {open && createPortal(<div ref={menu} role="menu" aria-label={title} tabIndex={-1}
      className="session-toolbar-menu" style={anchor}>
      <span className="session-toolbar-heading">{title}</span>
      {children(close)}
    </div>, document.body)}
  </>;
}
