import { useCallback } from "react";
import type { Session } from "@shared/types.ts";
import { relativeTime, shortenCwd, stateDisplay, uptime } from "../lib/format.ts";
import { ActionBar, type ActionBarHandle } from "./ActionBar.tsx";
import { NomistakesStrip } from "./NomistakesStrip.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";

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
  onOpenReviews,
  selected = false,
  onSelect,
  expanded = false,
  onToggleExpand,
  registerEl,
  registerActions,
}: {
  session: Session;
  onOpenReviews?: () => void;
  selected?: boolean;
  onSelect?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  registerActions?: (id: string, handle: ActionBarHandle | null) => void;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const attention = st.tone === "attention";
  const canSend = Boolean(session.tmux || session.wezterm);

  // Stable per-session ref callback so the element map isn't churned each render.
  const setRef = useCallback(
    (el: HTMLElement | null) => registerEl?.(session.id, el),
    [registerEl, session.id],
  );

  return (
    <article
      ref={setRef}
      className={`card tone-${st.tone}${attention ? " attention" : ""}${selected ? " selected" : ""}`}
      data-agent={session.agent}
      onClick={onSelect}
    >
      <header className="card-head">
        <span className={`agent-dot agent-${session.agent}`} aria-hidden />
        <div className="card-title">
          <h2 title={session.name}>{session.name || "(unnamed)"}</h2>
          <span className="name-source">{subtitle(session)}</span>
        </div>
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

      {session.nomistakes && <NomistakesStrip sessionId={session.id} nm={session.nomistakes} />}

      <footer className="card-foot">
        <span className="agent-name">{AGENT_LABEL[session.agent]}</span>
        {session.nomistakesGated && (
          <span className="gated" title="This repo is gated by no-mistakes">
            ◇ gated
          </span>
        )}
        <span className="dot-sep">·</span>
        <span className="mono dim">pid {session.pid}</span>
        {session.tty && (
          <>
            <span className="dot-sep">·</span>
            <span className="mono dim">{session.tty}</span>
          </>
        )}
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
        <TranscriptPanel sessionId={session.id} agent={session.agent} canSend={canSend} />
      )}
    </article>
  );
}
