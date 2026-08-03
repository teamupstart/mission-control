import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Session, ThinkingLevel } from "@shared/types.ts";
import { sessionEffortLevels } from "@shared/harness-capabilities.ts";
import { canMessage } from "@shared/pane.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

const GAP = 8;
const WIDTH = 224;

type Anchor = { left: number; top?: number; bottom?: number };
type OptimisticEffort = {
  level: ThinkingLevel;
  modelId: string | null;
  updatedAt: number;
};

export function reconcileOptimisticEffort(
  optimistic: OptimisticEffort | null,
  reported: ThinkingLevel | null,
  modelId: string | null,
  updatedAt: number,
): OptimisticEffort | null {
  if (!optimistic) return null;
  if (reported === optimistic.level) return null;
  if (modelId !== optimistic.modelId || updatedAt > optimistic.updatedAt) return null;
  return optimistic;
}

/**
 * The live reasoning-effort chip. Unlike launch defaults, this opens the selected
 * harness's own `/model` picker and commits its session-only choice, so a running
 * session changes without changing what future sessions start with.
 */
export function EffortPicker({ session }: { session: Session }): React.JSX.Element | null {
  const reported = session.meta?.thinkingLevel ?? null;
  const modelId = session.meta?.modelId ?? null;
  const reportedAt = session.meta?.updatedAt ?? 0;
  const [optimistic, setOptimistic] = useState<OptimisticEffort | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState<ThinkingLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // The passive metadata reader eventually confirms the TUI change. Until then, keep the
  // chip honest about the change we successfully delivered rather than flashing backward.
  useEffect(() => {
    setOptimistic((value) => reconcileOptimisticEffort(value, reported, modelId, reportedAt));
  }, [optimistic, reported, modelId, reportedAt]);

  const level = optimistic?.level ?? reported;
  const levels = sessionEffortLevels(session.agent, modelId, level);
  // Delivery intent, like the mode picker beside it: the TUI walk is one way to apply a
  // level, a driver's own control is another.
  const canPick =
    session.effortBaselineReady &&
    session.state !== "exited" &&
    session.state !== "stopping" &&
    canMessage(session);

  const place = useCallback(() => {
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - WIDTH - GAP));
    const above = r.top > window.innerHeight / 2;
    setAnchor(above ? { left, bottom: window.innerHeight - r.top + GAP } : { left, top: r.bottom + GAP });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !chipRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
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

  if (!level) return null;
  if (!canPick || levels.length === 0) return <EffortChip level={level} />;

  async function choose(next: ThinkingLevel): Promise<void> {
    if (next === level) {
      setOpen(false);
      return;
    }
    setBusy(next);
    setError(null);
    const result = await api.setEffort(session.id, next);
    setBusy(null);
    if (result.ok) {
      setOptimistic({ level: next, modelId, updatedAt: reportedAt });
      setOpen(false);
    } else {
      setError(result.error ?? "couldn't change effort");
    }
  }

  return (
    <>
      <Tooltip label={`Reasoning effort: ${level} - click to change it for this session`}>
      <button
        ref={chipRef}
        className={`rt-pill rt-think rt-think-${level} rt-think-btn${open ? " open" : ""}`}
        aria-label={`Reasoning effort: ${level}. Change effort for this session`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setOpen((value) => !value);
        }}
      >
        <span className="rt-think-glyph" aria-hidden>
          ✦
        </span>
        {level}
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
            className="alert-pop mode-pop effort-pop"
            role="menu"
            aria-label="Reasoning effort"
            style={{ width: WIDTH, ...anchor }}
            onClick={(e) => e.stopPropagation()}
          >
            {levels.map((option) => {
              const active = option === level;
              return (
                <Tooltip key={option} label={`Set this session's reasoning effort to ${option}`}>
                <button
                  role="menuitemradio"
                  aria-checked={active}
                  className={`mode-opt${active ? " active" : ""}`}
                  disabled={busy !== null}
                  onClick={() => void choose(option)}
                >
                  <span className={`mode-opt-dot rt-think rt-think-${option}`} aria-hidden />
                  <span className="mode-opt-text">
                    <span className="mode-opt-label">{option}</span>
                    <span className="mode-opt-desc">Apply to this session only</span>
                  </span>
                  {busy === option && <span className="mode-opt-spin" aria-label="changing" />}
                  {active && busy === null && <span className="mode-opt-check" aria-hidden>✓</span>}
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

function EffortChip({ level }: { level: ThinkingLevel }): React.JSX.Element {
  return (
    <Tooltip label={`Reasoning effort: ${level}`}>
      <span className={`rt-pill rt-think rt-think-${level}`}>
        <span className="rt-think-glyph" aria-hidden>✦</span>
        {level}
      </span>
    </Tooltip>
  );
}
