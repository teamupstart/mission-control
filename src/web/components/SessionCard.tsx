import { useCallback, useEffect, useRef, useState } from "react";
import type { Session, SessionQueueSummary } from "@shared/types.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import { canRenameSession, relativeTime, shortenCwd, stateDisplay, uptime } from "../lib/format.ts";
import { queueChipVisible, queueChipView } from "../lib/queue.ts";
import { ActionBar, type ActionBarHandle } from "./ActionBar.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { NomistakesStrip } from "./NomistakesStrip.tsx";
import { NomistakesFixLog } from "./NomistakesFixLog.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { TranscriptPanel, type TranscriptHandle } from "./TranscriptPanel.tsx";
import { ForemanNote } from "./ForemanNote.tsx";
import { PaneDialogPrompt } from "./PaneDialogPrompt.tsx";
import { WorkQueue } from "./WorkQueue.tsx";
import {
  AGENT_LABEL,
  ChecksFailedIcon,
  GoalLine,
  PrStateIcon,
  RenameEditor,
  RuntimeMetaRow,
  subtitle,
} from "./session-bits.tsx";

/**
 * The teaser for a queue you can't see, and the way back into it.
 *
 * Hidden while the drawer is open: it would be the same count, verbatim, one row above
 * the panel that states it - and on an expanded card that row is a section's worth of
 * the height the panel needs. So it stands down and lets the real thing speak.
 *
 * Gated on the queue having a HISTORY rather than on work still waiting in it, because
 * an exited session has no ActionBar and therefore no Queue button: this chip is the
 * only way back to what its batch did, and a batch that has stopped is exactly the one
 * worth reading. What it SAYS about that batch is `queueChipView`'s call - it's a rule
 * about honesty, and rules are tested without a DOM; this renders the answer.
 */
function QueueChip({
  queue,
  onOpen,
}: {
  queue: SessionQueueSummary;
  onOpen: () => void;
}): React.JSX.Element {
  const chip = queueChipView(queue);
  return (
    <button
      className={`queue-chip qc-${queue.inFlightState ?? "waiting"}${chip.attention ? " qc-escalated" : ""}`}
      title={chip.title}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <span className="qc-count">{chip.label}</span>
      {queue.inFlightIntent && <span className="qc-intent">{queue.inFlightIntent}</span>}
      {queue.round > 0 && <span className="qc-round">fix {queue.round}</span>}
    </button>
  );
}

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
  resetNonce = 0,
  selected = false,
  onSelect,
  expanded = false,
  canExpand = true,
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
  /** True when this session's parked no-mistakes gate needs you (computed cross-session in App). */
  gateNeedsYou?: boolean;
  onOpenReviews?: () => void;
  /** Opens the diff viewer: the whole branch, or one commit when given a sha. */
  onOpenDiff?: (commit?: string) => void;
  onReset?: () => void;
  /** Bumped each time this session is reset, so the reply box remounts and drops the
   *  text the reset discarded (it's an uncontrolled box; clearing the draft map alone
   *  wouldn't empty one that's open). */
  resetNonce?: number;
  selected?: boolean;
  onSelect?: () => void;
  expanded?: boolean;
  /** Whether the header offers the expand/collapse toggle. False in the layouts whose
   *  detail pane is always the expanded card, where the control would toggle nothing. */
  canExpand?: boolean;
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
  // The work queue is a drawer, not part of the card: it opens on Queue / the shortcut
  // / the queued chip and stays open until you close it. Deliberately independent of
  // `expanded` - a queue is worth a glance without surrendering the grid to one card,
  // and expanding to read a conversation shouldn't dump a batch of work on top of it.
  const [queueOpen, setQueueOpen] = useState(false);
  // Folded down to its header, without closing the drawer. Distinct from `queueOpen` on
  // purpose: "put it away" and "keep it, but give the conversation the room back" are
  // different intents, and on a collapsed card folding is what stops a long batch from
  // stretching the whole grid row.
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  // The expanded transcript's reply box, so the send shortcut can put a cursor in the
  // box that's already there instead of opening a second one (null while collapsed,
  // which is exactly when this card's own send box is the right answer).
  const transcriptRef = useRef<TranscriptHandle>(null);
  // Whether that reply box is actually on screen right now - the panel's own report,
  // not this card's guess at it. The bar has to hear when it comes and goes, or it ends
  // up as the second send box on the card.
  const [hasReply, setHasReply] = useState(false);

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
        {canExpand && (
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
        )}
      </header>

      <GoalLine session={session} />

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

      {session.queue && queueChipVisible(session.queue) && !queueOpen && (
        <QueueChip queue={session.queue} onOpen={() => setQueueOpen(true)} />
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
          hasReply={hasReply}
          queueOpen={queueOpen}
          onToggleQueue={() => setQueueOpen((v) => !v)}
          onFocusReply={() => transcriptRef.current?.focusReply() ?? false}
          registerActions={registerActions}
          onReset={onReset}
        />
      )}

      {/* Not gated on `expanded`, unlike the note below it: a session parked on a menu is
          blocked until someone answers, which is the one thing a collapsed card most needs
          to say. Burying it behind a click is how it gets missed. */}
      {session.paneDialog && (
        <PaneDialogPrompt sessionId={session.id} dialog={session.paneDialog} />
      )}

      {expanded && session.note && (
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

      {/* The queue and the conversation, wrapped together so they can be laid out as one
          region rather than two things fighting over the card's height. Stacked on a card
          in the grid; side by side on an expanded one, where the card is full-width and
          the vertical room is the scarce thing (see `.card-panels`). One WorkQueue either
          way - moving the element between two parents would remount it on every expand. */}
      {(queueOpen || expanded) && (
        <div className="card-panels">
          {queueOpen && (
            <WorkQueue
              session={session}
              foremanMode={foremanMode}
              foremanEnabled={foremanEnabled}
              allowlisted={allowlisted(session, foremanAllowlist)}
              collapsed={queueCollapsed}
              onToggleCollapsed={() => setQueueCollapsed((v) => !v)}
            />
          )}
          {expanded && (
            <TranscriptPanel
              ref={transcriptRef}
              sessionId={session.id}
              agent={session.agent}
              canSend={canSend}
              dialogOpen={Boolean(session.paneDialog)}
              onReplyBox={setHasReply}
              resetNonce={resetNonce}
            />
          )}
        </div>
      )}
    </article>
  );
}
