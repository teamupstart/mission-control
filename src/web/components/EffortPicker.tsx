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
 *
 * Two levels can be true at once here, and conflating them is what made this chip revert.
 * `reported` is what the conversation is RUNNING under, read back off the harness's own
 * file. `session.pendingEffort` is a level the harness accepted but has not run yet -
 * Codex's driver puts effort on `turn/start`, and a turn already going cannot be moved
 * onto it, so its rollout keeps appending records naming the old level for as long as that
 * turn lasts. The server owns that projection and retires it against the next
 * `turn_context`; the chip's job is only to say both, rather than to pick one and be
 * contradicted by a routine metadata refresh.
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

  // What the conversation is on now, and what it will be on next - never merged. The
  // reachability list is asked about the LIVE level, because that is where a harness with
  // a one-step picker would actually be walking from.
  const level = optimistic?.level ?? reported;
  const pending = session.pendingEffort !== null && session.pendingEffort !== level
    ? session.pendingEffort
    : null;
  const shown = pending ?? level;
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
    // Fixed positioning does not track a scrolling card, so FOLLOW the anchor rather than
    // closing. Closing looks tidy and is wrong: the conversation under this chip auto-scrolls
    // whenever the agent streams a line, so on the one session an operator most wants to
    // retune - a busy one - the menu was being snatched away between the click that opened it
    // and the click that would have chosen a level. `RepoCombobox` already repositions for
    // exactly this reason; this is the same rule, applied to the same problem.
    const onScroll = place;
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

  if (!shown && session.meta?.nativeEffort) return (
    <Tooltip label={`Reasoning effort: ${session.meta.nativeEffort}`}>
      <span className="rt-pill rt-think" aria-label={`Reasoning effort: ${session.meta.nativeEffort}`}>
        {session.meta.nativeEffort}
      </span>
    </Tooltip>
  );
  if (!shown) return null;
  if (!canPick || levels.length === 0) return <EffortChip level={shown} pending={pending !== null} />;

  async function choose(next: ThinkingLevel): Promise<void> {
    if (next === shown) {
      setOpen(false);
      return;
    }
    setBusy(next);
    setError(null);
    const result = await api.setEffort(session.id, next);
    setBusy(null);
    if (result.ok) {
      // A DEFERRED change has a server-owned projection (`session.pendingEffort`), emitted
      // before this response was written. Holding a browser-local copy of it beside that
      // would be a second source of truth for the same fact, and the browser's copy is the
      // one with no way to learn it was superseded.
      setOptimistic(result.pending ? null : { level: next, modelId, updatedAt: reportedAt });
      setOpen(false);
    } else {
      setError(result.error ?? "couldn't change effort");
    }
  }

  const chipLabel = pending
    ? `Reasoning effort: ${level ?? "unknown"} on this turn, ${pending} from the next turn. ` +
      `Change effort for this session`
    : `Reasoning effort: ${shown}. Change effort for this session`;
  const chipTooltip = pending
    ? `Reasoning effort: ${pending} is set and applies from the next turn; this turn is ` +
      `still running ${level ?? "an unknown level"} - click to change it for this session`
    : `Reasoning effort: ${shown} - click to change it for this session`;

  return (
    <>
      <Tooltip label={chipTooltip}>
      <button
        ref={chipRef}
        className={`rt-pill rt-think rt-think-${shown} rt-think-btn${open ? " open" : ""}${
          pending ? " rt-think-pending" : ""
        }`}
        aria-label={chipLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setOpen((value) => !value);
        }}
      >
        <EffortReading level={shown} supersedes={pending ? level : null} pending={pending !== null} />
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
            {pending && (
              <p className="mode-pop-note">
                {pending} is set and applies from the next turn. This turn keeps running{" "}
                {level}; a follow-up message joins it rather than starting a new one.
              </p>
            )}
            {levels.map((option) => {
              const active = option === shown;
              const live = option === level && pending !== null;
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
                    <span className="mode-opt-desc">
                      {active && pending
                        ? "Set - applies from the next turn"
                        : live
                          ? "Running on this turn"
                          : "Apply to this session only"}
                    </span>
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

/**
 * What an effort pill READS, and the one place that is decided.
 *
 * Three components draw this pill: the interactive picker above, `EffortChip` below it for a
 * session that cannot be picked for, and `RuntimeMetaRow`'s static spelling in
 * `session-bits.tsx`. All three printed the mark, the level and the next-turn tag themselves,
 * and the level's own element is load-bearing rather than decorative - the console header's
 * ladder sheds `.rt-think-word` at rung 2 and keeps the glyph, so the pill collapses to its
 * mark while its accent, tooltip and `aria-label` survive (`detailHeadLadder.ts`).
 *
 * That is exactly the kind of fact that must not be spelled three times, and it was: the
 * `EffortChip` copy was left as a bare text node when the other two were wrapped, a reviewer
 * caught it, and the fix wrote the same span a third time. This component is the repair - the
 * rule now has an owner, so the next call site inherits it and a change to what the wrap
 * carries is one edit.
 *
 * Deliberately NOT here: the pill's own `className`, and the caret. The class differs per host
 * (the picker adds `rt-think-btn` and an `open` state), and the caret is the PICKER's
 * affordance rather than anything the level says - a static pill that grew one would be
 * promising a menu it does not have.
 */
export function EffortReading({
  level,
  supersedes = null,
  pending = false,
}: {
  /** The level the pill prints - the pending one when there is one, else the live one. */
  level: ThinkingLevel;
  /**
   * The level `level` replaces, struck through before an arrow. Only the picker has this:
   * a turn already running cannot be moved onto a new level, so it says both.
   */
  supersedes?: ThinkingLevel | null;
  /** Whether the level applies from the NEXT turn rather than this one. */
  pending?: boolean;
}): React.JSX.Element {
  return (
    <>
      <span className="rt-think-glyph" aria-hidden>✦</span>
      {supersedes && (
        <>
          <span className="rt-think-was">{supersedes}</span>
          <span className="rt-think-arrow" aria-hidden>→</span>
        </>
      )}
      <span className="rt-think-word">{level}</span>
      {pending && <span className="rt-think-next">next turn</span>}
    </>
  );
}

function EffortChip({
  level,
  pending = false,
}: {
  level: ThinkingLevel;
  pending?: boolean;
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        pending
          ? `Reasoning effort: ${level}, applying from the next turn`
          : `Reasoning effort: ${level}`
      }
    >
      <span className={`rt-pill rt-think rt-think-${level}${pending ? " rt-think-pending" : ""}`}>
        <EffortReading level={level} pending={pending} />
      </span>
    </Tooltip>
  );
}
