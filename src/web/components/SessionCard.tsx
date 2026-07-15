import { useCallback, useEffect, useRef, useState } from "react";
import type { PrState, Session, SessionMeta } from "@shared/types.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import {
  canRenameSession,
  compactTokens,
  contextTone,
  relativeTime,
  shortenCwd,
  stateDisplay,
  uptime,
} from "../lib/format.ts";
import { api } from "../lib/api.ts";
import { ActionBar, type ActionBarHandle } from "./ActionBar.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { NomistakesStrip } from "./NomistakesStrip.tsx";
import { NomistakesFixLog } from "./NomistakesFixLog.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { ForemanNote } from "./ForemanNote.tsx";
import { WorkQueue } from "./WorkQueue.tsx";

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

/**
 * Whether Foreman may send live in this session - the SAME predicate the server
 * decides with (`foremanMayActLive` calls it too), not a copy of it. Takes the
 * session so cwd and repoRoot can't be passed in the wrong order or one of them
 * forgotten, which is exactly how the UI would start lying about the gate.
 */
function allowlisted(session: Session, allowlist: string[] | undefined): boolean {
  return foremanAllowlisted(session.cwd, session.repoRoot, allowlist ?? []);
}

export function SessionCard({
  session,
  gateNeedsYou = false,
  onOpenReviews,
  onOpenDiff,
  onReset,
  selected = false,
  onSelect,
  expanded = false,
  onToggleExpand,
  registerEl,
  registerActions,
  renaming = false,
  onRenameStart,
  onRenameClose,
  foremanMode = "dry-run",
  foremanEnabled = false,
  foremanAllowlist,
  inputReviewId = null,
  pendingReviewIds,
}: {
  session: Session;
  /** True when this session's parked no-mistakes gate needs you (computed fleet-wide in App). */
  gateNeedsYou?: boolean;
  onOpenReviews?: () => void;
  /** Opens the diff viewer: the whole branch, or one commit when given a sha. */
  onOpenDiff?: (commit?: string) => void;
  onReset?: () => void;
  selected?: boolean;
  onSelect?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  registerActions?: (id: string, handle: ActionBarHandle | null) => void;
  /** Whether this card's title is currently in its rename editor (App owns the id). */
  renaming?: boolean;
  /** Enter rename mode for this card (click the title, or the rename shortcut). */
  onRenameStart?: () => void;
  /** Leave rename mode (saved, cancelled, or the input blurred). */
  onRenameClose?: () => void;
  /** Current Foreman mode, so an expanded note can show semi-auto controls. */
  foremanMode?: string;
  /** Whether Foreman is switched on at all - the mode says nothing while it's off. */
  foremanEnabled?: boolean;
  /** Repo roots Foreman may send live in, so the card can be honest about why it's
   *  only drafting (matched against the session's cwd AND the repo it belongs to). */
  foremanAllowlist?: string[];
  /** A pending `input` review id for this session (for Foreman's Approve). */
  inputReviewId?: string | null;
  /** Live pending review ids, so Foreman's Approve can tell a since-resolved draft is stale. */
  pendingReviewIds?: ReadonlySet<string>;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const attention = st.tone === "attention";
  const canSend = Boolean(session.tmux || session.wezterm);
  const canRename = canRenameSession(session);

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
          {renaming ? (
            <RenameEditor session={session} onClose={() => onRenameClose?.()} />
          ) : canRename ? (
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
          ) : (
            <h2 title={session.name}>{session.name || "(unnamed)"}</h2>
          )}
          {!renaming && <span className="name-source">{subtitle(session)}</span>}
        </div>
        {session.prUrl && (
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
        )}
        {session.prUrl && session.prChecks === "failing" && (
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
        {attention &&
          session.note &&
          (session.note.disposition === "escalated" ||
            (session.note.disposition === "pending" && session.note.recommendation)) && (
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
        <Tooltip label={expanded ? "Hide conversation" : "Show conversation"}>
          <button
            className={`expand-toggle${expanded ? " open" : ""}`}
            aria-label={expanded ? "Collapse conversation" : "Expand conversation"}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
          >
            ⌃
          </button>
        </Tooltip>
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

      {session.queue && session.queue.openCount > 0 && (
        <button
          className={`queue-chip qc-${session.queue.inFlightState ?? "waiting"}`}
          title={
            session.queue.inFlightIntent
              ? `Foreman is working through this session's queue: ${session.queue.inFlightIntent}`
              : "Work queued for this session - expand to see it"
          }
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand?.();
          }}
        >
          <span className="qc-count">{session.queue.openCount} queued</span>
          {session.queue.inFlightIntent && (
            <span className="qc-intent">{session.queue.inFlightIntent}</span>
          )}
          {session.queue.round > 0 && <span className="qc-round">fix {session.queue.round}</span>}
        </button>
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

      {session.nomistakesFixes.length > 0 && (
        <NomistakesFixLog
          sessionId={session.id}
          fixes={session.nomistakesFixes}
          onOpenDiff={(sha) => onOpenDiff?.(sha)}
        />
      )}

      <footer className="card-foot">
        <span className="agent-name">{AGENT_LABEL[session.agent]}</span>
        {session.nomistakesGated && (
          <Tooltip label="This repo is gated by no-mistakes - changes run the gate before they can land">
            <span className="gated">◇ gated</span>
          </Tooltip>
        )}
        {session.agent === "claude" && <ModePicker session={session} />}
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
        <ActionBar
          session={session}
          expanded={expanded}
          registerActions={registerActions}
          onReset={onReset}
        />
      )}

      {expanded && (
        <>
          {session.note && (
            <ForemanNote
              session={session}
              note={session.note}
              mode={foremanMode}
              enabled={foremanEnabled}
              allowlist={foremanAllowlist}
              inputReviewId={inputReviewId}
              pendingReviewIds={pendingReviewIds}
            />
          )}
          <WorkQueue
            session={session}
            foremanMode={foremanMode}
            foremanEnabled={foremanEnabled}
            allowlisted={allowlisted(session, foremanAllowlist)}
          />
          <TranscriptPanel sessionId={session.id} agent={session.agent} canSend={canSend} />
        </>
      )}
    </article>
  );
}

/**
 * Inline title editor: the card title swapped for a text box (click the title or
 * press the rename shortcut). Enter or the ✓ button commits, Escape or ✕ cancels,
 * and clicking away blurs to cancel - so a rename only lands on an explicit save.
 * The button controls guard their own mousedown (`preventDefault`) so clicking one
 * doesn't blur-cancel the field before its click fires. A failing rename (e.g. an
 * invalid tmux name) keeps the editor open with the reason, rather than dropping
 * the edit. On success App drops rename mode; the registry's optimistic echo (and
 * the next discovery sweep) update the title, so nothing here has to.
 */
function RenameEditor({
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

  // Focus and select the whole name on open so the user can type over it at once.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // The input is disabled while the request is in flight, which drops focus to
  // <body>; without taking it back, a rejected name leaves Enter/Escape unheard
  // here and every grid chord held by App (which stands down while renaming).
  // Keyed on `busy` too, not just `error`: retrying the same bad name re-reports
  // an identical string, so `error` alone wouldn't fire.
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
          // Mirrors RenameSchema's .max(200): a longer paste would come back as a
          // raw Zod error dump, which the .rename-error span renders verbatim.
          maxLength={200}
          aria-label="Rename session"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // Keep grid shortcuts from firing while typing a name.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          // Clicking away cancels, but switching apps must not: the browser fires
          // blur at the focused element before the window itself loses focus, so
          // without the hasFocus guard a Cmd+Tab to the session's terminal - the
          // core loop here - would discard a half-typed name.
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

/**
 * Warning glyph for the "a CI check failed" alert next to the PR chip: an
 * outlined triangle with an exclamation. Color comes from the `.pr-checks-alert`
 * class (the danger tone).
 */
function ChecksFailedIcon(): React.JSX.Element {
  return (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
      />
    </svg>
  );
}
