import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import { shortenCwd, stateDisplay, uptime, relativeTime } from "../../lib/format.ts";
import { ActionBar } from "../ActionBar.tsx";
import { ModePicker } from "../ModePicker.tsx";
import { NomistakesStrip } from "../NomistakesStrip.tsx";
import { NomistakesFixLog } from "../NomistakesFixLog.tsx";
import { ForemanNote } from "../ForemanNote.tsx";
import { WorkQueue } from "../WorkQueue.tsx";
import { TranscriptPanel, type TranscriptHandle } from "../TranscriptPanel.tsx";
import {
  AGENT_LABEL,
  AgentDot,
  GoalLine,
  PrChip,
  RuntimeMetaRow,
  SessionTitle,
  StateBadge,
  subtitle,
} from "../session-bits.tsx";
import { canRenameSession } from "../../lib/format.ts";
import type { SessionViewProps } from "./types.ts";

type Tab = "conversation" | "queue" | "gate" | "diff";

/**
 * The console's detail pane: a bespoke, tabbed reading of ONE session - not the grid's
 * card dropped into a column.
 *
 * The chrome is fixed and always on screen (who this is, where it lives, its controls);
 * only the body switches between Conversation, Work queue, Gate and Diff. That is the
 * whole point of a split-pane console - the conversation gets the room a card can't give
 * it, and the sections that share a card's height in the grid get a tab each here instead
 * of stacking and fighting.
 *
 * Built from the same leaf pieces the card is (the transcript, the work queue, the gate
 * strip, the action bar, the session-bits), arranged fresh. Keyed by session id in the
 * parent, so switching sessions remounts it - the tab resets to the conversation and the
 * transcript starts clean, rather than showing the last session's Gate tab.
 */
export function ConsoleDetail({
  view,
  session,
}: {
  view: SessionViewProps;
  session: Session;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("conversation");
  const [hasReply, setHasReply] = useState(false);
  const transcriptRef = useRef<TranscriptHandle>(null);
  // Set when the send shortcut arrives on another tab: the reply box exists, it's just
  // not mounted yet, so the focus has to wait for the conversation to come back.
  const focusPending = useRef(false);

  /**
   * The console's one compose box lives in the conversation tab, so "I want to type
   * now" means going there - not opening a second, lesser send box in the footer, which
   * would take the place of the whole action row on its way past.
   */
  function focusReply(): boolean {
    if (transcriptRef.current?.focusReply()) return true;
    focusPending.current = true;
    setTab("conversation");
    return true;
  }

  useEffect(() => {
    if (tab !== "conversation" || !focusPending.current) return;
    focusPending.current = false;
    transcriptRef.current?.focusReply();
  }, [tab]);

  const st = stateDisplay(session);
  const live = session.state !== "exited";
  const canSend = Boolean(session.tmux || session.wezterm);
  const canRename = canRenameSession(session);
  const gateNeedsYou = view.gateAlerts.has(session.id);
  const allowlisted = foremanAllowlisted(session.cwd, session.repoRoot, view.foremanAllowlist ?? []);
  const queueCount = session.queue?.openCount ?? 0;

  const tabs = useMemo(
    () =>
      [
        { id: "conversation" as const, label: "Conversation", pip: 0 },
        { id: "queue" as const, label: "Work queue", pip: queueCount },
        { id: "gate" as const, label: "Gate", pip: gateNeedsYou ? 1 : 0 },
        { id: "diff" as const, label: "Diff", pip: 0 },
      ],
    [queueCount, gateNeedsYou],
  );

  return (
    <div className={`cdetail tone-${st.tone}`}>
      <header className="detail-head">
        <AgentDot agent={session.agent} />
        <div className="detail-title">
          <SessionTitle
            session={session}
            canRename={canRename}
            renaming={view.renamingId === session.id}
            onRenameStart={() => view.onRenameStart(session.id)}
            onRenameClose={view.onRenameClose}
          />
          {view.renamingId !== session.id && (
            <span className="name-source">{subtitle(session)}</span>
          )}
        </div>
        <PrChip session={session} />
        <StateBadge session={session} onOpenReviews={() => view.onOpenReviews(session.id)} />
        <span className="detail-head-spacer" />
        {session.meta && <RuntimeMetaRow meta={session.meta} />}
      </header>

      <dl className="detail-sub">
        <div className="kv">
          <dt>path</dt>
          <dd className="mono" title={session.cwd ?? ""}>
            {shortenCwd(session.cwd)}
          </dd>
        </div>
        {session.gitBranch && (
          <div className="kv">
            <dt>branch</dt>
            <dd className="mono branch">{session.gitBranch}</dd>
          </div>
        )}
        {session.task && (
          <div className={`task-chip task-${session.task.status}`} title={`${session.task.kind} task`}>
            <span className="task-kind">{session.task.kind}</span>
            <span className="task-title">{session.task.title}</span>
            {session.task.outcome &&
              (session.task.outcomeUrl ? (
                <a
                  className="task-outcome"
                  href={session.task.outcomeUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {session.task.outcome}
                </a>
              ) : (
                <span className="task-outcome">{session.task.outcome}</span>
              ))}
          </div>
        )}
      </dl>

      <div className="detail-tabs" role="tablist" aria-label="Session detail">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`detail-tab${tab === t.id ? " on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.pip > 0 && <span className="detail-pip">{t.pip}</span>}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === "conversation" && (
          // Fills the body and pins the reply box: the leading bits stay put and the
          // transcript scrolls inside itself, rather than the whole tab scrolling the
          // compose box off the bottom.
          <div className="detail-conv">
            <GoalLine session={session} />
            {session.activity && <p className="activity">{session.activity}</p>}
            {session.note && (
              <ForemanNote
                session={session}
                note={session.note}
                mode={view.foremanMode}
                enabled={view.foremanEnabled}
                allowlist={view.foremanAllowlist}
                inputReviewId={view.inputReviewBySession.get(session.id) ?? null}
                pendingReviewIds={view.pendingReviewIds}
              />
            )}
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
                onOpenDiff={(sha) => view.onOpenDiff(session.id, sha)}
              />
            )}
            <TranscriptPanel
              ref={transcriptRef}
              sessionId={session.id}
              agent={session.agent}
              canSend={canSend}
              onReplyBox={setHasReply}
              resetNonce={view.resetNonces[session.id] ?? 0}
            />
          </div>
        )}

        {/* Mounted unconditionally, exactly as the grid card does it. Gating this on
            `session.queue` looked like an empty state but was a dead end: that summary is
            null until a queue row exists, and the only thing that creates one is adding an
            item - which happens in WorkQueue's own empty branch, along with the re-attach
            hint an orphaned (post-`/clear`) queue needs. Hiding the component to say
            "nothing queued" hid the sole way to queue anything. */}
        {tab === "queue" && (
          <div className="detail-pane">
            <WorkQueue
              session={session}
              foremanMode={view.foremanMode}
              foremanEnabled={view.foremanEnabled}
              allowlisted={allowlisted}
            />
          </div>
        )}

        {tab === "gate" && (
          <div className="detail-pane">
            {session.nomistakes ? (
              <>
                <NomistakesStrip
                  sessionId={session.id}
                  nm={session.nomistakes}
                  needsYou={gateNeedsYou}
                  narration={session.nomistakesNarration}
                />
                {session.nomistakesFixes.length > 0 && (
                  <NomistakesFixLog
                    sessionId={session.id}
                    fixes={session.nomistakesFixes}
                    onOpenDiff={(sha) => view.onOpenDiff(session.id, sha)}
                  />
                )}
              </>
            ) : (
              <p className="detail-empty">This repo isn&rsquo;t gated by no-mistakes.</p>
            )}
          </div>
        )}

        {tab === "diff" && (
          <div className="detail-pane">
            {session.cwd ? (
              <div className="detail-diff">
                <p className="detail-empty">Changes on this checkout versus its source branch.</p>
                <button className="btn" onClick={() => view.onOpenDiff(session.id)}>
                  Open the diff viewer
                </button>
              </div>
            ) : (
              <p className="detail-empty">No working directory to diff.</p>
            )}
          </div>
        )}
      </div>

      <footer className="detail-foot">
        <span className="detail-agent">{AGENT_LABEL[session.agent]}</span>
        {session.nomistakesGated && (
          <span className="gated" title="Gated by no-mistakes">
            ◇ gated
          </span>
        )}
        {session.agent === "claude" && <ModePicker session={session} />}
        <span className="dot-sep">·</span>
        <span className="mono dim">pid {session.pid}</span>
        {!session.instrumented && (
          <span className="hint" title="No hooks reporting - status is coarse">
            uninstrumented
          </span>
        )}
        <span className="detail-seen dim">
          {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
        </span>
        <span className="detail-foot-spacer" />
        {live && (
          <ActionBar
            session={session}
            variant="foot"
            hasReply={hasReply}
            queueOpen={tab === "queue"}
            onToggleQueue={() => setTab((t) => (t === "queue" ? "conversation" : "queue"))}
            onFocusReply={focusReply}
            onDiff={() => view.onOpenDiff(session.id)}
            registerActions={view.registerActions}
            onReset={() => view.onReset(session.id)}
          />
        )}
      </footer>
    </div>
  );
}
