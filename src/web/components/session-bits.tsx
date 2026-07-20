import { useEffect, useRef, useState } from "react";
import type {
  PrState,
  RateLimitWindow,
  Session,
  SessionCost,
  SessionMeta,
  TaskPriority,
} from "@shared/types.ts";
import { GOAL_UNSUPPORTED } from "@shared/goal.ts";
import { costTone } from "@shared/cost.ts";
import { PRIORITY_LABELS } from "@shared/task.ts";
import { compactTokens, contextTone, fmtUsd, stateDisplay, untilReset } from "../lib/format.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The small, presentational pieces a session is drawn from - the agent dot, the
 * goal line, the PR chip, the state badge, the title (with its rename editor), the
 * runtime pills - plus the task chips (priority, labels), which live here for the same
 * reason even though they hang off a Task rather than a Session: the board's backlog
 * column and the roundup panel both draw them, and two copies is how they drift.
 *
 * Every surface is a consumer here, the card included: the card, the console's detail
 * pane and the board's tile each arrange these SAME bits rather than importing one
 * another or keeping a private copy of the PR-icon SVG or the rename flow. That matters
 * because the card is rendered by ONE layout while the detail serves two, so a private
 * copy means a fix lands in two layouts and silently misses the third.
 *
 * `test/session-leaf-parity.test.ts` pins this: it renders each bit standalone and
 * asserts all three surfaces contain that exact output, so a re-inlined copy fails as
 * soon as it drifts.
 */

export const AGENT_LABEL: Record<Session["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** Where this session was found, phrased for the small grey subtitle. */
export function subtitle(session: Session): string {
  if (session.nameSource === "tmux" && session.tmux) return `tmux · ${session.tmux.paneId}`;
  if (session.nameSource === "wezterm") return "wezterm";
  return "process";
}

export function AgentDot({ agent }: { agent: Session["agent"] }): React.JSX.Element {
  return <span className={`agent-dot agent-${agent}`} aria-hidden />;
}

/**
 * What this session is trying to solve, under the title.
 *
 * Sits OUTSIDE any expand gate on purpose - a sentence you have to click to read is not a
 * status line. Distinct from `.activity`, the ticker ("running Bash"): what it is FOR versus
 * what it is doing this second, so the goal reads as primary text and the ticker stays muted.
 */
export function GoalLine({ session }: { session: Session }): React.JSX.Element | null {
  const unsupported = GOAL_UNSUPPORTED[session.agent];
  if (unsupported) {
    return (
      <p className="goal goal-none" title={`Goal is derived from a session's prompts. ${unsupported}`}>
        No goal · {unsupported}
      </p>
    );
  }
  if (!session.goal?.text) return null;
  return (
    <p
      className={`goal goal-${session.goal.source ?? "heuristic"}`}
      title={
        session.goal.source === "heuristic"
          ? `${session.goal.text}\n\n(your prompt, verbatim - being summarised)`
          : session.goal.text
      }
    >
      {session.goal.text}
    </p>
  );
}

/**
 * What the Inspector has to say about this session's pull request, in one chip.
 *
 * Renders nothing at all unless the PR was ADOPTED, and that silence is meaningful: the
 * Inspector only adopts PRs it can prove Mission Control opened, so a card showing a PR
 * chip and no inspector chip is telling you that PR came from somewhere else and will
 * never be commented on.
 *
 * Counts rather than findings. The card's job is to say whether to go and look; the pull
 * request is where you look.
 */
export function inspectorChipView(
  inspector: Session["inspector"],
): { mark: string; tone: string; title: string } | null {
  if (!inspector) return null;
  const dry = inspector.mode === "dry-run";
  const suffix = dry ? " (dry run - nothing was posted)" : "";
  if (inspector.failed) {
    return {
      mark: "!",
      tone: "insp-failed",
      title: `Inspector: the last review of this pull request did not complete${suffix}`,
    };
  }
  if (inspector.round === 0) {
    // Glyph alone. "Adopted, not looked at yet" is the least urgent thing this chip can
    // say, and it should not cost a single character more than its own presence.
    return {
      mark: "",
      tone: "insp-queued",
      title: `Inspector: adopted for review, not looked at yet${suffix}`,
    };
  }
  if (inspector.open === 0) {
    return {
      mark: "✓",
      tone: "insp-clean",
      title: `Inspector: reviewed, nothing outstanding${suffix}`,
    };
  }
  return {
    mark: `${inspector.open}`,
    tone: "insp-findings",
    title:
      `Inspector: ${inspector.open} open finding${inspector.open === 1 ? "" : "s"} ` +
      `after ${inspector.round} round${inspector.round === 1 ? "" : "s"}${suffix}`,
  };
}

/** The Inspector chip. Shared by all four session surfaces - see CLAUDE.md on parity. */
export function InspectorChip({ session }: { session: Session }): React.JSX.Element | null {
  const view = inspectorChipView(session.inspector);
  if (!view || !session.inspector) return null;
  return (
    <Tooltip label={view.title}>
      <a
        className={`insp-chip ${view.tone}${session.inspector.mode === "dry-run" ? " insp-dry" : ""}`}
        href={session.inspector.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="insp-glyph" aria-hidden>
          ⌕
        </span>
        {view.mark && <span className="insp-label">{view.mark}</span>}
      </a>
    </Tooltip>
  );
}

/** The PR chip, plus the "a CI check failed" alert beside it when checks are failing. */
export function PrChip({ session }: { session: Session }): React.JSX.Element | null {
  if (!session.prUrl) return null;
  return (
    <>
      <Tooltip
        label={
          session.prState === "merged"
            ? "Pull request merged - open on GitHub"
            : "Open pull request - open on GitHub"
        }
      >
        <a
          className={`pr-chip pr-${session.prState ?? "open"}`}
          href={session.prUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          <PrStateIcon state={session.prState ?? "open"} />
          <span className="pr-num">{session.prNumber ? `#${session.prNumber}` : "PR"}</span>
        </a>
      </Tooltip>
      {session.prChecks === "failing" && (
        <Tooltip label="A CI check failed on this PR - open on GitHub">
          <a
            className="pr-checks-alert"
            href={session.prUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="A CI check failed on this pull request - open on GitHub"
            onClick={(e) => e.stopPropagation()}
          >
            <ChecksFailedIcon />
          </a>
        </Tooltip>
      )}
    </>
  );
}

/** The status badge; a button that opens the reviews modal when there are pending reviews. */
export function StateBadge({
  session,
  onOpenReviews,
}: {
  session: Session;
  onOpenReviews?: () => void;
}): React.JSX.Element {
  const st = stateDisplay(session);
  if (session.pendingReviews > 0 && onOpenReviews) {
    return (
      <button
        className={`badge badge-${st.tone} badge-btn`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenReviews();
        }}
      >
        <span className="badge-dot" />
        {st.label} →
      </button>
    );
  }
  return (
    <span className={`badge badge-${st.tone}`}>
      <span className="badge-dot" />
      {st.label}
    </span>
  );
}

/**
 * The session title: either the inline rename editor, or the clickable title that opens
 * it (with the pencil affordance), or a plain heading when the session can't be renamed.
 * The name-source subtitle is a sibling the caller places, since the card wraps it with
 * the title and the console's detail head sets it beside them.
 */
export function SessionTitle({
  session,
  canRename,
  renaming,
  onRenameStart,
  onRenameClose,
}: {
  session: Session;
  canRename: boolean;
  renaming: boolean;
  onRenameStart?: () => void;
  onRenameClose?: () => void;
}): React.JSX.Element {
  if (renaming) return <RenameEditor session={session} onClose={() => onRenameClose?.()} />;
  if (canRename) {
    return (
      <h2>
        <button
          type="button"
          className="card-title-edit"
          title={`Rename "${session.name}"`}
          onClick={(e) => {
            e.stopPropagation();
            onRenameStart?.();
          }}
        >
          <span className="card-title-name">{session.name || "(unnamed)"}</span>
          <span className="rename-pencil" aria-hidden>
            ✎
          </span>
        </button>
      </h2>
    );
  }
  return <h2 title={session.name}>{session.name || "(unnamed)"}</h2>;
}

/**
 * Inline title editor: the title swapped for a text box. Enter or ✓ commits, Escape or ✕
 * cancels, and clicking away blurs to cancel - so a rename only lands on an explicit save.
 * A failing rename keeps the editor open with the reason. On success the caller drops
 * rename mode; the registry's optimistic echo updates the title, so nothing here has to.
 */
export function RenameEditor({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Disabling the input mid-flight drops focus to <body>; take it back so a rejected name
  // still hears Enter/Escape. Keyed on `busy` too: retrying the same bad name re-reports an
  // identical string, so `error` alone wouldn't re-fire.
  useEffect(() => {
    if (busy || !error) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [busy, error]);

  async function submit(): Promise<void> {
    const name = value.trim();
    if (!name || name === session.name) {
      onClose();
      return;
    }
    setBusy(true);
    const r = await api.rename(session.id, name);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error ?? "rename failed");
  }

  return (
    <div className="rename-edit" onClick={(e) => e.stopPropagation()}>
      <div className="rename-row">
        <input
          ref={inputRef}
          className="rename-input"
          value={value}
          disabled={busy}
          maxLength={200}
          aria-label="Rename session"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          // Clicking away cancels, but a Cmd+Tab to the terminal must not: the browser fires
          // blur before the window loses focus, so guard on document.hasFocus().
          onBlur={() => {
            if (!busy && document.hasFocus()) onClose();
          }}
        />
        <button
          type="button"
          className="rename-btn rename-save"
          aria-label="Save name"
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void submit()}
        >
          ✓
        </button>
        <button
          type="button"
          className="rename-btn rename-cancel"
          aria-label="Cancel rename"
          disabled={busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {error && (
        <span className="rename-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The runtime row: model, thinking level, and a context-window pressure meter - the same
 * facts ccstatusline shows in the terminal. Each chip is independently omitted when unknown.
 *
 * A `<span>` (styled `display:flex`), not a `<div>`, so it's phrasing content: the board's
 * tile draws its whole body as spans, and this row has to nest into that flow - and into
 * any button-like container a layout wraps it in - without being invalid HTML.
 */
export function RuntimeMetaRow({ meta }: { meta: SessionMeta }): React.JSX.Element | null {
  const hasCtx = meta.contextPct != null;
  if (!meta.model && !meta.thinkingLevel && !hasCtx) return null;
  const tone = contextTone(meta.contextPct);
  const ctxTitle =
    meta.contextTokens != null && meta.contextWindow != null
      ? `${compactTokens(meta.contextTokens)} / ${compactTokens(meta.contextWindow)} tokens in context`
      : `${meta.contextPct}% of the context window used`;
  return (
    <span className="card-runtime">
      {meta.model && (
        <span className="rt-pill rt-model" title={meta.modelId ?? undefined}>
          {meta.model}
          {meta.longContext && <span className="rt-1m">1M</span>}
        </span>
      )}
      {meta.thinkingLevel && (
        <span
          className={`rt-pill rt-think rt-think-${meta.thinkingLevel}`}
          title={`Reasoning effort: ${meta.thinkingLevel}`}
        >
          <span className="rt-think-glyph" aria-hidden>
            ✦
          </span>
          {meta.thinkingLevel}
        </span>
      )}
      {hasCtx && (
        <span className={`rt-ctx rt-ctx-${tone}`} title={ctxTitle}>
          <span className="rt-meter" aria-hidden>
            <span
              className="rt-meter-fill"
              style={{ width: `${Math.min(100, Math.max(0, meta.contextPct!))}%` }}
            />
          </span>
          <span className="rt-ctx-num">{meta.contextPct}%</span>
        </span>
      )}
    </span>
  );
}

/**
 * What a session has spent so far, as a chip beside the runtime row.
 *
 * Sits next to `RuntimeMetaRow` rather than among the alert marks because cost is the
 * fourth runtime fact of the same kind as model, thinking level and context - something
 * true of the session right now, not something asking for you. Escalation is expressed by
 * the chip's own tone (see `costTone`), not by a second copy of the number in the tile's
 * `.tile-marks`; the rail, which has no room for a figure, carries a glyph instead.
 *
 * A `<span>`, not a `<div>`, for the same reason `RuntimeMetaRow` is: the board's tile
 * draws its whole body as spans, and this has to nest into that flow without being
 * invalid HTML.
 *
 * Renders NOTHING when there is nothing to say - an unpriced session (no telemetry, or
 * none yet) and a session that genuinely cost nothing both get no chip, because a `$0.00`
 * would assert the one of those two that is false.
 */
export function CostChip({ cost }: { cost: SessionCost | null }): React.JSX.Element | null {
  if (!cost || cost.costUsd <= 0) return null;
  const tone = costTone(cost.costUsd);
  const tokensIn = cost.input + cost.cacheRead + cost.cacheWrite;
  return (
    <Tooltip
      label={
        `${fmtUsd(cost.costUsd)} estimated - ${compactTokens(tokensIn)} in / ` +
        `${compactTokens(cost.output)} out.\nClaude Code's own figure; your bill may differ.`
      }
    >
      <span className={`rt-pill cost-chip cost-${tone}`}>{fmtUsd(cost.costUsd)}</span>
    </Tooltip>
  );
}

/**
 * One subscription rate-limit window as a labelled meter.
 *
 * Reuses the context meter's `.rt-meter` / `.rt-meter-fill` idiom deliberately: there is
 * no charting library in this app and no non-icon SVG, so a bar is two spans and a width,
 * and a second way of drawing the same shape would be a second thing to keep in step.
 *
 * The caller decides whether to render it at all - an absent window means "we have not
 * been told", which must show as nothing rather than as a bar sitting at 0%.
 */
export function RateMeter({
  window,
  label,
  title,
}: {
  window: RateLimitWindow;
  label: string;
  title: string;
}): React.JSX.Element {
  const pct = Math.min(100, Math.max(0, window.usedPercentage));
  return (
    <Tooltip label={`${title}: ${Math.round(window.usedPercentage)}% used, resets ${untilReset(window.resetsAt)}`}>
      {/* `rt-ctx-<tone>` rather than a private rate-* tone set: the amber/red escalation is
          already defined for the context meter, and a second copy would drift. */}
      <span className={`rt-ctx rt-ctx-${contextTone(window.usedPercentage)} rate-meter`}>
        <span className="rate-label">{label}</span>
        <span className="rt-meter" aria-hidden>
          <span className="rt-meter-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="rt-ctx-num">{Math.round(window.usedPercentage)}%</span>
      </span>
    </Tooltip>
  );
}

/** GitHub-style glyph for the PR chip: pull-request icon while open, merge icon once landed. */
export function PrStateIcon({ state }: { state: PrState }): React.JSX.Element {
  return state === "merged" ? (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
      />
    </svg>
  ) : (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
      />
    </svg>
  );
}

/** Warning glyph for the "a CI check failed" alert: an outlined triangle with an exclamation. */
export function ChecksFailedIcon(): React.JSX.Element {
  return (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
      />
    </svg>
  );
}

/**
 * A task's priority, as a chip. Renders NOTHING when the priority is unset, which is
 * the default for every task and must stay visually silent: a backlog nobody has
 * triaged should look exactly as it did before priorities existed, not like a wall of
 * "none" chips.
 */
export function PriorityChip({ priority }: { priority: TaskPriority | null }): React.JSX.Element | null {
  if (!priority) return null;
  return (
    <span className={`task-priority prio-${priority}`} title={`Priority: ${PRIORITY_LABELS[priority]}`}>
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

/**
 * A task's labels, as chips. Also silent when empty, for the same reason as above.
 *
 * `max` exists because the same list is drawn in a roomy roundup row and in a narrow
 * board card; the overflow is reported as a count rather than dropped, so a card never
 * implies a task carries fewer tags than it does.
 */
export function LabelChips({
  labels,
  max = labels.length,
}: {
  labels: string[];
  max?: number;
}): React.JSX.Element | null {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const hidden = labels.length - shown.length;
  return (
    <span className="task-labels" title={labels.join(", ")}>
      {shown.map((l) => (
        <span className="task-label" key={l}>
          {l}
        </span>
      ))}
      {hidden > 0 && <span className="task-label task-label-more">+{hidden}</span>}
    </span>
  );
}
