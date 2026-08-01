import { useEffect, useMemo, useRef, useState } from "react";
import type { ForemanEpisode, Session, SessionGoal } from "@shared/types.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import { activePaneDialog } from "@shared/session.ts";
import { canMessage } from "@shared/pane.ts";
import { shortenCwd, stateDisplay, uptime, relativeTime } from "../../lib/format.ts";
import { ActionBar } from "../ActionBar.tsx";
import { Keycap } from "../Keycap.tsx";
import { ModePicker } from "../ModePicker.tsx";
import { SessionWorkflowsPane } from "../SessionWorkflowsPane.tsx";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { PaneDialogPrompt } from "../PaneDialogPrompt.tsx";
import { ForemanStrip } from "../ForemanStrip.tsx";
import { ForemanDrawer, openEpisodeCount } from "../ForemanDrawer.tsx";
import { WorkQueue } from "../WorkQueue.tsx";
import { TranscriptPanel, type TranscriptHandle } from "../TranscriptPanel.tsx";
import {
  AgentDot,
  CostChip,
  GoalLine,
  InspectorChip,
  PrChip,
  RuntimeMetaRow,
  ScheduleOriginChip,
  SessionTitle,
  StateBadge,
  WorkflowChip,
  EnsembleChip,
  SessionWhere,
} from "../session-bits.tsx";
import { canRenameSession } from "../../lib/format.ts";
import { api } from "../../lib/api.ts";
import { useTimelineReviews } from "../../lib/timelineReviews.ts";
import { ensembleSummaryFor, type SessionViewProps } from "./types.ts";
import { FileWorkspace, type FileWorkspaceHandle } from "../FileWorkspace.tsx";
import { InlineDiffViewer } from "../DiffViewer.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { detailTabs, type DetailTabId } from "../../lib/detailTabs.ts";

type Tab = DetailTabId;

type DiffSelection = {
  sessionId: string;
  commit: string | null;
  requestNonce: number | undefined;
};

/**
 * This session's Foreman episodes, refetched whenever its note moves.
 *
 * Fetched rather than denormalized onto the session, unlike the note itself. An
 * episode carries a whole pane capture, and the session object rides the SSE snapshot
 * that every card in the fleet re-renders from - so denormalizing these would put a
 * terminal screenshot per session into every frame, to be read by the one panel that
 * is open.
 *
 * `noteStamp` is the trigger and not a timer: the worker writes the note and the
 * episode in the same breath, so the note's `updatedAt` moving IS the signal that
 * there is a new episode to read, and it arrives over the stream we are already
 * listening to. A poll would be strictly worse - later, and busy while nothing
 * happens.
 */
function useEpisodes(sessionId: string, noteStamp: number): ForemanEpisode[] {
  const [episodes, setEpisodes] = useState<ForemanEpisode[]>([]);
  useEffect(() => {
    let live = true;
    void api.episodes(sessionId).then((rows) => {
      // Guarded against the session switching mid-flight: without this, a slow
      // response for the session you just left would land in the panel for the one
      // you just opened, and its history would read as this session's.
      if (live && rows) setEpisodes(rows);
    });
    return () => {
      live = false;
    };
  }, [sessionId, noteStamp]);
  return episodes;
}

/**
 * SSE-visible goal fields that move when a prompt is captured and again when its
 * reconciliation becomes the effective completion contract.
 */
export function intentRefreshStamp(goal: Session["goal"]): string {
  return [
    goal?.promptRevision ?? 0,
    goal?.resolvedPromptRevision ?? 0,
    goal?.objectiveVersion ?? 0,
  ].join(":");
}

/** Load the full completion contract only for the drawer that can render it. */
function useIntent(
  sessionId: string,
  refreshStamp: string,
  open: boolean,
): SessionGoal | null {
  const [intent, setIntent] = useState<SessionGoal | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setIntent(null);
    void api
      .goal(sessionId)
      .then((goal) => {
        if (live) setIntent(goal);
      })
      .catch(() => {
        if (live) setIntent(null);
      });
    return () => {
      live = false;
    };
  }, [sessionId, refreshStamp, open]);
  return intent;
}

/**
 * The console's detail pane: a bespoke, tabbed reading of ONE session - not the grid's
 * card dropped into a column.
 *
 * The chrome is fixed and always on screen (who this is, where it lives, its controls);
 * only the body switches between Conversation, Work queue, Workflows, Diff and Files. That
 * is the whole point of a split-pane console - the conversation gets the room a card can't
 * give it, and the sections that share a card's height in the grid get a tab each here
 * instead of stacking and fighting.
 *
 * The Conversation tab is the transcript and nothing else. Progress readouts - the workflow
 * ladder and the no-mistakes gate strip - used to stack above it, and between them they
 * could push the first message of a long-running session off the bottom of the screen. Both
 * now live in Workflows, which is the tab that answers "how is this run going" while
 * Conversation answers "what was said". They are the same components either way; only where
 * they mount moved.
 *
 * Built from the same leaf pieces the card is (the transcript, the work queue, the gate
 * strip, the action bar, the session-bits), arranged fresh. Keyed by session id in the
 * parent, so switching sessions remounts it - the tab resets to the conversation and the
 * transcript starts clean, rather than showing the last session's Workflows tab.
 */
export function ConsoleDetail({
  view,
  session,
}: {
  view: SessionViewProps;
  session: Session;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("conversation");
  const workflowRun = view.workflowRunBySession?.get(session.id) ?? null;
  const ensembleLink = session.task?.ensemble ?? null;
  const [diffSelection, setDiffSelection] = useState<DiffSelection>({
    sessionId: session.id,
    commit: null,
    requestNonce: undefined,
  });
  const [hasReply, setHasReply] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const transcriptRef = useRef<TranscriptHandle>(null);
  const filesRef = useRef<FileWorkspaceHandle>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const episodes = useEpisodes(session.id, session.note?.updatedAt ?? 0);
  const intent = useIntent(session.id, intentRefreshStamp(session.goal), drawerOpen);
  const timelineReviews = useTimelineReviews(session.id, view.reviews);
  // Set when the send shortcut arrives on another tab: the reply box exists, it's just
  // not mounted yet, so the focus has to wait for the conversation to come back.
  const focusPending = useRef(false);

  // App owns shortcut routing across layouts. A request aimed at this mounted detail
  // reveals the same Files tab its tab button does; the nonce makes repeated presses
  // observable even when the session id has not changed.
  useEffect(() => {
    if (view.fileTabRequest?.sessionId === session.id) setTab("files");
  }, [view.fileTabRequest, session.id]);

  // Same shape for the conversation. It is the tab this detail OPENS on, so most of the
  // time the chord has nothing to switch - the nonce is what makes the press land
  // anyway, after you have walked off to Files and want the transcript back.
  useEffect(() => {
    if (view.conversationTabRequest?.sessionId === session.id) setTab("conversation");
  }, [view.conversationTabRequest, session.id]);

  // And for Workflows, reached by the same shape of one-shot request. This tab has no
  // grid equivalent to fall back to - Cards draws no tab strip - so the chord is a plain
  // reveal here rather than a per-layout decision like the conversation's.
  useEffect(() => {
    if (view.workflowsTabRequest?.sessionId === session.id) setTab("workflows");
  }, [view.workflowsTabRequest, session.id]);

  useEffect(() => {
    const scroll = (direction: -1 | 1): void => {
      if (tab === "conversation") {
        transcriptRef.current?.scrollByArrow(direction);
      } else if (tab === "files") {
        filesRef.current?.scrollByArrow(direction);
      } else {
        const el = paneRef.current;
        if (el) el.scrollBy({ top: direction * Math.max(80, el.clientHeight * 0.18) });
      }
    };
    view.registerDetailScroll(session.id, scroll);
    return () => view.registerDetailScroll(session.id, null);
  }, [session.id, tab, view.registerDetailScroll]);

  // Unlike Cards, Console and Board have a session-owned Diff tab. An action-bar
  // shortcut or a no-mistakes fix therefore lands here instead of opening a modal.
  useEffect(() => {
    const request = view.diffTabRequest;
    if (request?.sessionId !== session.id) return;
    setDiffSelection({
      sessionId: session.id,
      commit: request.commit,
      requestNonce: request.nonce,
    });
    setTab("diff");
  }, [view.diffTabRequest, session.id]);

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

  const gateNeedsYou = view.gateAlerts.has(session.id);
  const st = stateDisplay(session, gateNeedsYou);
  const live = session.state !== "exited";
  const canSend = canMessage(session);
  const canRename = canRenameSession(session);
  const dialog = activePaneDialog(session);
  const allowlisted = foremanAllowlisted(session.cwd, session.repoRoot, view.foremanAllowlist ?? []);
  const queueCount = session.queue?.openCount ?? 0;
  const openCount = openEpisodeCount(episodes);

  const tabs = useMemo(
    () => detailTabs({ queueCount, gateNeedsYou }),
    [queueCount, gateNeedsYou],
  );
  const tabLabel = tabs.find((t) => t.id === tab)?.label ?? "Detail";

  // Tab/Shift+Tab walk this tab strip left to right, driven from App's one global key
  // handler so the console and the board drill-in behave identically (both mount this
  // component). App owns the "which surface holds the keyboard" decision; this just reports
  // whether a step landed on a tab ("moved") or ran off the end ("edge"), which App reads
  // as clamp-here going forward and hand-back-to-the-rail going back.
  useEffect(() => {
    const order = tabs.map((t) => t.id);
    const nav = (dir: -1 | 1): "moved" | "edge" => {
      const nextTab = order[order.indexOf(tab) + dir];
      if (!nextTab) return "edge";
      setTab(nextTab);
      return "moved";
    };
    view.registerReaderTab(session.id, nav);
    return () => view.registerReaderTab(session.id, null);
  }, [session.id, tab, tabs, view.registerReaderTab]);

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
            <SessionWhere session={session} />
          )}
        </div>
        <PrChip session={session} />
        <InspectorChip session={session} />
        <WorkflowChip
          run={workflowRun}
          onOpen={workflowRun ? () => view.onOpenWorkflowRun?.(workflowRun.id) : undefined}
        />
        <EnsembleChip
          link={ensembleLink}
          summary={ensembleSummaryFor(view, session)}
          onOpen={ensembleLink ? () => view.onOpenEnsemble?.(ensembleLink.runId) : undefined}
        />
        {!workflowRun && view.onBindWorkflow && (
          <Tooltip label="Bind a published workflow version">
          <button
            className="workflow-bind-chip"
            onClick={() => view.onBindWorkflow?.(session.id)}
          >
            ＋ workflow
          </button>
          </Tooltip>
        )}
        <StateBadge
          session={session}
          gateNeedsYou={gateNeedsYou}
          onOpenReviews={() => view.onOpenReviews(session.id)}
        />
        <span className="detail-head-spacer" />
        {session.meta && <RuntimeMetaRow meta={session.meta} session={session} />}
        <CostChip cost={session.cost} />
      </header>

      <dl className="detail-sub">
        <div className="kv">
          <dt>path</dt>
          <Tooltip label={session.cwd ?? "This session has no working directory"}>
            <dd className="mono">{shortenCwd(session.cwd)}</dd>
          </Tooltip>
        </div>
        {session.gitBranch && (
          <div className="kv">
            <dt>branch</dt>
            <dd className="mono branch">{session.gitBranch}</dd>
          </div>
        )}
        {session.task && (
          <div className={`task-chip task-${session.task.status}`}>
            <Tooltip label={`${session.task.kind} task`}>
              <span className="task-kind">{session.task.kind}</span>
            </Tooltip>
            <span className="task-title">{session.task.title}</span>
            <ScheduleOriginChip
              task={session.task}
              scheduleNames={view.scheduleNameById}
              onOpen={view.onOpenSchedule}
            />
            {session.task.outcome &&
              (session.task.outcomeUrl ? (
                <Tooltip label={`Outcome: ${session.task.outcome} - open on GitHub`}>
                <a
                  className="task-outcome"
                  href={session.task.outcomeUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {session.task.outcome}
                </a>
                </Tooltip>
              ) : (
                <span className="task-outcome">{session.task.outcome}</span>
              ))}
          </div>
        )}
      </dl>

      <ForemanDrawer
        episodes={episodes}
        intent={intent}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      <div className="detail-tabs" role="tablist" aria-label="Session detail">
        {tabs.map((t) => (
          <Tooltip key={t.id} label={`Show this session's ${t.label.toLowerCase()}`}>
          <button
            role="tab"
            aria-selected={tab === t.id}
            className={`detail-tab${tab === t.id ? " on" : ""}`}
            onClick={() => {
              setTab(t.id);
              // The tab itself is the whole-checkout view. A fix-specific diff only
              // persists while it is the explicit destination of a fix-log action.
              if (t.id === "diff") {
                setDiffSelection({
                  sessionId: session.id,
                  commit: null,
                  requestNonce: undefined,
                });
              }
            }}
          >
            <Keycap action={t.action} />
            {t.label}
            {t.pip > 0 && <span className="detail-pip">{t.pip}</span>}
          </button>
          </Tooltip>
        ))}

        {/* In the tab row but NOT a tab - no `role="tab"`, and pushed to the far end
            past a flexible gap. Work queue, Gate and Diff are things this session
            HAS; Foreman is an observer talking about it, so it opens a surface rather
            than switching the body. A captured objective also makes the surface useful,
            even before Foreman has made its first decision. */}
        {(episodes.length > 0 || session.goal) && (
          <Tooltip label={drawerOpen ? "Close Foreman's session reading" : "Inspect Foreman's objective and decision history"}>
            <button
              className="foreman-rail"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((v) => !v)}
            >
              {openCount > 0 && <span className="fr-dot" aria-hidden="true" />}
              {episodes.length > 0 ? `Foreman · ${episodes.length}` : "Foreman intent"}
            </button>
          </Tooltip>
        )}
      </div>

      {/* The reader pane. `tabIndex=-1` so Tab from the rail can land focus HERE - the
          conversation window the operator reads and the vertical arrows scroll - and its
          ring frames just this body, not the header/tabs/footer chrome around it. */}
      <div className="detail-body" tabIndex={-1} aria-label={`${tabLabel} pane`}>
        {tab === "conversation" && (
          // Fills the body and pins the reply box: the leading bits stay put and the
          // transcript scrolls inside itself, rather than the whole tab scrolling the
          // compose box off the bottom.
          <div className="detail-conv">
            <GoalLine session={session} />
            {session.activity && <p className="activity">{session.activity}</p>}
            {dialog && <PaneDialogPrompt sessionId={session.id} dialog={dialog} />}
            {session.note && (
              <ForemanStrip
                session={session}
                note={session.note}
                mode={view.foremanMode}
                enabled={view.foremanEnabled}
                allowlist={view.foremanAllowlist}
                inputReviewId={view.inputReviewBySession.get(session.id) ?? null}
                pendingReviewIds={view.pendingReviewIds}
                onJump={() => transcriptRef.current?.scrollToEpisode(session.note?.handledMarker ?? null)}
              />
            )}
            <TranscriptPanel
              ref={transcriptRef}
              session={session}
              canSend={canSend}
              dialogOpen={Boolean(dialog)}
              episodes={episodes}
              reviews={timelineReviews}
              onReplyBox={setHasReply}
              onOpenFile={(href, probe) => view.onOpenFile(session.id, href, probe)}
              files={view.files}
              registerLaunchers={view.registerLaunchers}
              registerFind={view.registerFind}
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
          <div ref={paneRef} className="detail-pane">
            <WorkQueue
              session={session}
              foremanMode={view.foremanMode}
              foremanEnabled={view.foremanEnabled}
              allowlisted={allowlisted}
            />
          </div>
        )}

        {/* This tab absorbed the old Gate tab rather than sitting beside it: two adjacent
            tabs both answering "is this change allowed to land" was the split that put one
            of them above the transcript in the first place. */}
        {tab === "workflows" && (
          <div ref={paneRef} className="detail-pane">
            <SessionWorkflowsPane
              session={session}
              run={workflowRun}
              gateNeedsYou={gateNeedsYou}
              onOpenRun={(runId) => view.onOpenWorkflowRun?.(runId)}
              onOpenDiff={(sha) => view.onOpenDiff(session.id, sha)}
            />
          </div>
        )}

        {tab === "diff" && (
          session.cwd ? (
            <InlineDiffViewer
              session={session}
              commit={diffSelection.sessionId === session.id ? diffSelection.commit : null}
              requestNonce={
                diffSelection.sessionId === session.id ? diffSelection.requestNonce : undefined
              }
            />
          ) : (
            <div className="detail-pane">
              <p className="detail-empty">No working directory to diff.</p>
            </div>
          )
        )}
        {tab === "files" && (
          <div className="detail-files">
            {session.cwd ? (
              <FileWorkspace
                ref={filesRef}
                session={session}
                controller={view.files}
                onExtract={() => view.onOpenFiles(session.id)}
              />
            ) : (
              <p className="detail-empty">No working directory to browse.</p>
            )}
          </div>
        )}
      </div>

      <footer className="detail-foot">
        <span className="detail-agent">{AGENT_IDENTITY[session.agent].label}</span>
        {session.nomistakesGated && (
          <Tooltip label="This repo is gated by no-mistakes - changes run the gate before they can land">
            <span className="gated">◇ gated</span>
          </Tooltip>
        )}
        <ModePicker session={session} />
        <span className="dot-sep">·</span>
        <span className="mono dim">pid {session.pid}</span>
        {!session.instrumented && (
          <Tooltip label="No hooks reporting - status is coarse">
            <span className="hint">uninstrumented</span>
          </Tooltip>
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
            onComplete={() => view.onComplete(session.id)}
            onKill={() => view.onKill(session.id)}
          />
        )}
      </footer>
    </div>
  );
}
