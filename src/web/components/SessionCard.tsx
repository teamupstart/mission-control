import { useCallback } from "react";
import type { PrState, Session, SessionMeta } from "@shared/types.ts";
import {
  compactTokens,
  contextTone,
  permissionModeDisplay,
  relativeTime,
  shortenCwd,
  stateDisplay,
  uptime,
} from "../lib/format.ts";
import { ActionBar, type ActionBarHandle } from "./ActionBar.tsx";
import { NomistakesStrip } from "./NomistakesStrip.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { ForemanNote } from "./ForemanNote.tsx";

function subtitle(session: Session): string {
  if (session.nameSource === "tmux" && session.tmux) {
    return `tmux · ${session.tmux.paneId}`;
  }
  if (session.nameSource === "wezterm") return "wezterm";
  return "process";
}

const AGENT_LABEL: Record<Session["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function SessionCard({
  session,
  gateNeedsYou = false,
  onOpenReviews,
  onOpenDiff,
  selected = false,
  onSelect,
  expanded = false,
  onToggleExpand,
  registerEl,
  registerActions,
  foremanMode = "dry-run",
  inputReviewId = null,
}: {
  session: Session;
  /** True when this session's parked no-mistakes gate needs you (computed fleet-wide in App). */
  gateNeedsYou?: boolean;
  onOpenReviews?: () => void;
  onOpenDiff?: () => void;
  selected?: boolean;
  onSelect?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  registerActions?: (id: string, handle: ActionBarHandle | null) => void;
  /** Current Foreman mode, so an expanded note can show semi-auto controls. */
  foremanMode?: string;
  /** A pending `input` review id for this session (for Foreman's Approve). */
  inputReviewId?: string | null;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const attention = st.tone === "attention";
  const canSend = Boolean(session.tmux || session.wezterm);
  const mode = permissionModeDisplay(session.permissionMode);

  // Stable per-session ref callback so the element map isn't churned each render.
  const setRef = useCallback(
    (el: HTMLElement | null) => registerEl?.(session.id, el),
    [registerEl, session.id],
  );

  return (
    <article
      ref={setRef}
      className={`card tone-${st.tone}${attention ? " attention" : ""}${selected ? " selected" : ""}${expanded ? " expanded" : ""}`}
      data-agent={session.agent}
      onClick={onSelect}
    >
      <header className="card-head">
        <span className={`agent-dot agent-${session.agent}`} aria-hidden />
        <div className="card-title">
          <h2 title={session.name}>{session.name || "(unnamed)"}</h2>
          <span className="name-source">{subtitle(session)}</span>
        </div>
        {session.prUrl && (
          <a
            className={`pr-chip pr-${session.prState ?? "open"}`}
            href={session.prUrl}
            target="_blank"
            rel="noreferrer"
            title={
              session.prState === "merged"
                ? "Pull request merged - open on GitHub"
                : "Open pull request - open on GitHub"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <PrStateIcon state={session.prState ?? "open"} />
            <span className="pr-num">{session.prNumber ? `#${session.prNumber}` : "PR"}</span>
          </a>
        )}
        {session.pendingReviews > 0 ? (
          <button className={`badge badge-${st.tone} badge-btn`} onClick={onOpenReviews}>
            <span className="badge-dot" />
            {st.label} →
          </button>
        ) : (
          <span className={`badge badge-${st.tone}`}>
            <span className="badge-dot" />
            {st.label}
          </span>
        )}
        {session.note &&
          (session.note.disposition === "escalated" || session.note.disposition === "pending") && (
            <button
              className={`foreman-flag ff-${session.note.disposition}`}
              title={
                session.note.disposition === "escalated"
                  ? "Foreman escalated a decision to you - expand to see it"
                  : "Foreman drafted a reply - expand to review it"
              }
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.();
              }}
            >
              {session.note.disposition === "escalated" ? "◆ decision" : "✎ draft"}
            </button>
          )}
        {session.cwd && (
          <button
            className="diff-btn"
            aria-label="View changes vs source branch"
            title="View changes vs source branch"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDiff?.();
            }}
          >
            diff
          </button>
        )}
        <button
          className={`expand-toggle${expanded ? " open" : ""}`}
          aria-label={expanded ? "Collapse conversation" : "Expand conversation"}
          aria-expanded={expanded}
          title={expanded ? "Hide conversation" : "Show conversation"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
        >
          ⌃
        </button>
      </header>

      <dl className="card-meta">
        <div>
          <dt>path</dt>
          <dd className="mono" title={session.cwd ?? ""}>
            {shortenCwd(session.cwd)}
          </dd>
        </div>
        {session.gitBranch && (
          <div>
            <dt>branch</dt>
            <dd className="mono branch">{session.gitBranch}</dd>
          </div>
        )}
      </dl>

      {session.meta && <RuntimeMetaRow meta={session.meta} />}

      {session.task && (
        <div className={`task-chip task-${session.task.status}`} title={`${session.task.kind} task`}>
          <span className="task-kind">{session.task.kind}</span>
          <span className="task-title" title={session.task.title}>
            {session.task.title}
          </span>
          {session.task.status === "dispatching" && <span className="task-status">dispatching…</span>}
          {session.task.status === "failed" && <span className="task-status">failed</span>}
          {session.task.outcome &&
            (session.task.outcomeUrl ? (
              <a
                className="task-outcome"
                href={session.task.outcomeUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {session.task.outcome}
              </a>
            ) : (
              <span className="task-outcome">{session.task.outcome}</span>
            ))}
        </div>
      )}

      {session.activity && <p className="activity">{session.activity}</p>}

      {session.nomistakes && (
        <NomistakesStrip
          sessionId={session.id}
          nm={session.nomistakes}
          needsYou={gateNeedsYou}
          narration={session.nomistakesNarration}
        />
      )}

      <footer className="card-foot">
        <span className="agent-name">{AGENT_LABEL[session.agent]}</span>
        {session.nomistakesGated && (
          <span className="gated" title="This repo is gated by no-mistakes">
            ◇ gated
          </span>
        )}
        {mode && (
          <span className={`mode mode-${mode.tone}`} title={mode.title}>
            {mode.label}
          </span>
        )}
        <span className="dot-sep">·</span>
        <span className="mono dim">pid {session.pid}</span>
        <span className="spacer" />
        {!session.instrumented && (
          <span className="hint" title="No hooks reporting - status is coarse">
            uninstrumented
          </span>
        )}
        <span className="dim seen">
          {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
        </span>
      </footer>

      {session.state !== "exited" && (
        <ActionBar session={session} expanded={expanded} registerActions={registerActions} />
      )}

      {expanded && (
        <>
          {session.note && (
            <ForemanNote
              sessionId={session.id}
              note={session.note}
              mode={foremanMode}
              inputReviewId={inputReviewId}
            />
          )}
          <TranscriptPanel sessionId={session.id} agent={session.agent} canSend={canSend} />
        </>
      )}
    </article>
  );
}

/**
 * The runtime row beneath the meta: model, thinking level, and a context-window
 * pressure meter - the same facts ccstatusline shows in the terminal. Rendered
 * only when we have at least one of them; each chip is independently omitted when
 * unknown (e.g. an un-instrumented Claude session shows model + context but no
 * thinking level).
 */
function RuntimeMetaRow({ meta }: { meta: SessionMeta }): React.JSX.Element | null {
  const hasCtx = meta.contextPct != null;
  if (!meta.model && !meta.thinkingLevel && !hasCtx) return null;
  const tone = contextTone(meta.contextPct);
  const ctxTitle =
    meta.contextTokens != null && meta.contextWindow != null
      ? `${compactTokens(meta.contextTokens)} / ${compactTokens(meta.contextWindow)} tokens in context`
      : `${meta.contextPct}% of the context window used`;
  return (
    <div className="card-runtime">
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
    </div>
  );
}

/**
 * GitHub-style status glyph for the PR chip: the pull-request icon while the PR
 * is open, the merge icon once it has landed. Color comes from the chip class.
 */
function PrStateIcon({ state }: { state: PrState }): React.JSX.Element {
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
