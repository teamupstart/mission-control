import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { useHarnessModelCatalogs } from "../model-catalog.tsx";
import { Tooltip } from "./Tooltip.tsx";

const GAP = 8;
const WIDTH = 304;
type Anchor = { left: number; top?: number; bottom?: number; maxHeight: number };

/** The configured SDK model is server-owned; metadata continues to describe the observed turn. */
export function ModelPicker({ session }: { session: Session }): React.JSX.Element | null {
  const { resolve } = useHarnessModelCatalogs();
  const reported = session.meta?.modelId ?? null;
  const selected = session.configuredModel ?? reported;
  const catalog = resolve(session.agent, selected);
  const pending = Boolean(selected && reported && selected !== reported);
  const label = pending
    ? catalog.choices.find((choice) => choice.id === selected)?.label ?? selected
    : session.meta?.model ?? selected;
  const canPick = session.runtime === "sdk" && session.state !== "exited" && session.state !== "stopping";
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const rect = chipRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - WIDTH - GAP));
    const above = rect.top > window.innerHeight / 2;
    setAnchor(above
      ? { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: rect.top - GAP * 2 }
      : { left, top: rect.bottom + GAP, maxHeight: window.innerHeight - rect.bottom - GAP * 2 });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popRef.current?.contains(target) && !chipRef.current?.contains(target)) setOpen(false);
    };
    // Streaming conversations scroll underneath the open picker. Follow the chip.
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    popRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  function close(): void {
    setOpen(false);
    chipRef.current?.focus({ preventScroll: true });
  }

  async function choose(model: string): Promise<void> {
    if (model === selected) return close();
    // Disabling a focused option sends focus to the page. Keep Escape with this menu,
    // including after a refusal, so it cannot close the underlying session detail.
    popRef.current?.focus({ preventScroll: true });
    setBusy(model);
    setError(null);
    const result = await api.setModel(session.id, model);
    setBusy(null);
    if (result.ok) close();
    else setError(result.error ?? "Couldn't change model");
  }

  if (!label) return null;
  const reading = <>{label}{!pending && session.meta?.longContext && <span className="rt-1m">1M</span>}
    {pending && <span className="rt-think-next">selected</span>}</>;
  if (!canPick) return <Tooltip label={`Model: ${reported ?? label}`}>
    <span className="rt-pill rt-model">{reading}</span>
  </Tooltip>;

  return <>
    <Tooltip label={`Model: ${selected ?? label} - click to change it for this session`}>
      <button
        ref={chipRef}
        className={`rt-pill rt-model rt-model-btn${open ? " open" : ""}${pending ? " rt-model-pending" : ""}`}
        aria-label={`Model: ${selected ?? label}${pending ? ". Selected for future responses" : ""}. Change model for this session`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          place();
          setError(null);
          setOpen((value) => !value);
        }}
      >{reading}<span className="mode-caret" aria-hidden>⌄</span></button>
    </Tooltip>
    {open && anchor && createPortal(
      <div
        ref={popRef}
        role="menu"
        tabIndex={-1}
        aria-label="Session model"
        className="alert-pop mode-pop model-pop"
        style={{ width: WIDTH, ...anchor }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            event.stopPropagation();
            close();
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            const items = [...(popRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[index]?.focus();
          }
        }}
      >
        <p className="mode-pop-note">Applies to future responses in this session. Responses already underway may still report the previous model.</p>
        {catalog.choices.map((choice) => <button
          key={choice.id}
          role="menuitemradio"
          aria-checked={choice.id === selected}
          className={`mode-opt${choice.id === selected ? " active" : ""}`}
          disabled={busy !== null}
          onClick={() => void choose(choice.id)}
        >
          <span className="mode-opt-text">
            <span className="mode-opt-label">{choice.label}</span>
            <span className="mode-opt-desc">{choice.id}</span>
          </span>
          {busy === choice.id && <span className="mode-opt-spin" aria-label="changing" />}
          {choice.id === selected && busy === null && <span className="mode-opt-check" aria-hidden>✓</span>}
        </button>)}
        {error && <p className="mode-pop-err" role="alert">{error}</p>}
      </div>, document.body,
    )}
  </>;
}
