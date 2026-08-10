import { useEffect, useMemo, useRef, useState } from "react";
import type { ForemanEpisode, Session, SessionGoal } from "@shared/types.ts";
import { foremanAllowlisted } from "@shared/foreman.ts";
import { activePaneDialog } from "@shared/session.ts";
import { canMessage } from "@shared/pane.ts";
import { shortenCwd, stateDisplay, uptime, relativeTime } from "../../lib/format.ts";
import { sessionCanBindWorkflow } from "../../lib/held.ts";
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
 * Why an invite write did not stick, in one sentence that leads with what is STILL true.
 *
 * Worded around the state rather than around the failure because the state is the part
 * that can hurt. "Couldn't withdraw Foreman" invites the reading that nothing happened and
 * the operator can move on; what they actually need to know is that Foreman is still in
 * this session and may be typing into it right now. The daemon's own words follow, flatted
 * and clamped for the same reason `useForeman`'s `whyItFailed` does it: a refusal can
 * arrive as a multi-line JSON dump, and this line has a single row to live in.
 */
export function inviteFailure(action: "invite" | "withdraw", error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
  const why = flat ? `: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}` : "";
  return action === "invite"
    ? `Foreman was not invited${why}. It is still not in this session.`
    : `Foreman was not withdrawn${why}. It may still be triaging, wrapping up and following pull requests here.`;
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
 * The Conversation tab is the transcript and nothing else. The workflow ladder lives in
 * Workflows, which answers "how is this run going", while Conversation answers "what was said".
 *
 * Built from the same leaf pieces the card is (the transcript, the work queue, the action
 * bar, the session-bits), arranged fresh. Keyed by session id in the
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
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
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
  // shortcut or a commit-specific request therefore lands here instead of opening a modal.
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

  /**
   * The two halves of one control: the rail invites, the drawer's header withdraws.
   *
   * Kept together here rather than one per component because they are a single decision
   * with two directions, and because NEITHER of them writes the answer down locally. The
   * daemon re-resolves the invite and emits a `session_upsert`, so `session.foremanInvite`
   * arriving over the stream is what swaps the button - the same field the Foreman worker
   * gates itself on. An optimistic local copy would be a second source of truth for
   * exactly the question this feature exists to answer, and the first thing it would do
   * is claim Foreman had left a session it was still typing into.
   *
   * `api`'s writes go through `request()`, which NEVER rejects - a 500, a vanished session
   * or a dropped connection all come back as `{ ok: false, error }`. So a settled promise
   * is not a success, and treating it as one here would be the most dangerous possible
   * lie this feature can tell: closing the drawer on a failed withdrawal shows the
   * operator the exact signal they would get if it had worked, while Foreman keeps
   * typing. Both handlers read `.ok`, both leave the surface where it was on failure, and
   * the message says what is STILL true rather than that something went wrong. Same shape
   * as `useForeman`'s `update`, which reverts and explains for the same reason.
   *
   * `inviteBusy` is only about the in-flight request: it disables the control so a second
   * click cannot race the first, and it makes no claim about the outcome.
   */
  async function inviteForeman(): Promise<void> {
    setInviteBusy(true);
    try {
      const res = await api.inviteForeman(session.id);
      setInviteError(res.ok ? null : inviteFailure("invite", res.error));
    } finally {
      setInviteBusy(false);
    }
  }

  async function withdrawForeman(): Promise<void> {
    setInviteBusy(true);
    try {
      const res = await api.withdrawForemanInvite(session.id);
      if (!res.ok) return setInviteError(inviteFailure("withdraw", res.error));
      setInviteError(null);
      // Only on success. The drawer belongs to a session Foreman is in: left open over one
      // it has just been removed from, its header would keep offering an action that has
      // already happened - and closing it is what puts the rail's invite affordance back
      // in view. Closing it on a REFUSED withdrawal would say all of that falsely.
      setDrawerOpen(false);
    } finally {
      setInviteBusy(false);
    }
  }

  useEffect(() => {
    if (tab !== "conversation" || !focusPending.current) return;
    focusPending.current = false;
    transcriptRef.current?.focusReply();
  }, [tab]);

  // Both pieces of local state that are really claims ABOUT the invite, retired the moment
  // the invite itself moves - however it moved.
  //
  // The message first: without this, a refused withdrawal followed by a successful one from
  // another tab - or by the session being re-dispatched - would leave "Foreman may still be
  // triaging here" standing over a rail that says it is not in this session at all.
  //
  // Then the drawer's flag, and this one has to happen HERE rather than only in
  // `withdrawForeman`, because that handler covers exactly one of the ways an invite ends.
  // The daemon owns this field: another client on the same session, a direct API call, or a
  // reset can all withdraw it, and every one of those arrives as an ordinary
  // `session_upsert`. The `invited` gate unmounts the drawer on any of them - but unmounting
  // does not clear `drawerOpen`, so the flag survives, and the next invite remounts the
  // drawer with `open` still true and pops it open in front of an operator who never
  // clicked anything. Scoped to the transition to `null` rather than to every change, so a
  // grant merely CHANGING KIND (an `operator` invite replaced by `dispatch` on redispatch)
  // does not close a drawer the reader is using.
  useEffect(() => {
    setInviteError(null);
    if (session.foremanInvite === null) setDrawerOpen(false);
  }, [session.foremanInvite]);

  const st = stateDisplay(session);
  const live = session.state !== "exited" && session.state !== "stopping";
  const canSend = canMessage(session);
  const canRename = canRenameSession(session);
  const dialog = activePaneDialog(session);
  const allowlisted = foremanAllowlisted(session.cwd, session.repoRoot, view.foremanAllowlist ?? []);
  const queueCount = session.queue?.openCount ?? 0;
  const invited = session.foremanInvite !== null;

  const tabs = useMemo(() => detailTabs({ queueCount }), [queueCount]);
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
        {/* The card's gate, read from the same helper: a terminal run releases the offer here
            too, and stands its outcome chip next to it rather than instead of it. */}
        {sessionCanBindWorkflow(workflowRun) && view.onBindWorkflow && (
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

      {/* Gated on the invite, not just on `drawerOpen`: this is Foreman's record of a
          session it is in, and the header's one action is to leave. A session it has been
          removed from renders the invite affordance alone (the rail below), so the slot
          keeps a single meaning; the history is not deleted, only unreachable until
          Foreman is invited back. */}
      {invited && (
        <ForemanDrawer
          session={session}
          episodes={episodes}
          intent={intent}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onWithdraw={() => void withdrawForeman()}
        />
      )}

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

        <ForemanRail
          session={session}
          episodes={episodes}
          live={live}
          drawerOpen={drawerOpen}
          busy={inviteBusy}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          onInvite={() => void inviteForeman()}
        />
      </div>

      {/* Directly under the control that produced it, and outside the body so it does not
          belong to whichever tab happens to be open - the write is about the session, not
          about its conversation or its queue. `role="alert"` because it appears in
          response to a press and is the only signal that the press did nothing. */}
      {inviteError && (
        <p className="detail-invite-error" role="alert">
          {inviteError}
        </p>
      )}

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

        {tab === "workflows" && (
          <div ref={paneRef} className="detail-pane">
            <SessionWorkflowsPane
              run={workflowRun}
              onOpenRun={(runId) => view.onOpenWorkflowRun?.(runId)}
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
              // The destination a transcript file link reaches, without its prose
              // parsing: a diff path is exact (see `diffFileOpenTarget`).
              onOpenInFiles={(path) => view.onOpenFilePath(session.id, path)}
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

/**
 * The Foreman slot at the far end of the detail tab strip. One control, three states,
 * because whether Foreman is in this session is one question.
 *
 * In the tab row but NOT a tab - no `role="tab"`, and pushed past a flexible gap. Work
 * queue, Gate and Diff are things this session HAS; Foreman is an observer talking about
 * it, so it opens a surface rather than switching the body.
 *
 *  1. **Uninvited and live** - `＋ Invite foreman`, in the Foreman purple so it reads as
 *     an action rather than a status. Every neighbour here is muted until hovered, and a
 *     muted "Invite foreman" reads as a label for a state. No confirm step: the write is
 *     cheap, immediately visible, and undone by the drawer's Withdraw.
 *  2. **Invited, no history** - `Foreman intent`, and now ALWAYS, where this used to be
 *     gated on an objective or an episode existing. That gate made the slot vanish for
 *     the seconds right after an invite, taking the drawer - and with it the only way to
 *     withdraw - out of reach at the moment the operator is most likely to want it.
 *  3. **Invited, with history** - `Foreman · N` and the attention dot, unchanged.
 *
 * Uninvited and NOT live renders nothing at all: an exited session has no work left for
 * Foreman to be invited to. Uninvited sessions also show no route to their past episodes;
 * that history still exists and comes back with the invite, and keeping the slot
 * single-purpose is worth more than a reading nobody was asking for.
 *
 * Its own component so all three states can be rendered by a test. The rail's episode
 * count arrives from a fetch inside `ConsoleDetail`, which no `renderToStaticMarkup` test
 * can make return - so state 3 was unpinnable while this was written inline.
 */
export function ForemanRail({
  session,
  episodes,
  live,
  drawerOpen,
  busy,
  onToggleDrawer,
  onInvite,
}: {
  session: Session;
  episodes: ForemanEpisode[];
  live: boolean;
  drawerOpen: boolean;
  /** An invite write is in flight, so a second click cannot race the first. */
  busy: boolean;
  onToggleDrawer: () => void;
  onInvite: () => void;
}): React.JSX.Element | null {
  if (session.foremanInvite === null) {
    if (!live) return null;
    return (
      <Tooltip label="Foreman is not in this session. Invite it to triage, wrap up, and follow PRs here.">
        <button className="foreman-rail invite" disabled={busy} onClick={onInvite}>
          {/* Decoration, so a screen reader does not announce "full-width plus sign"
              ahead of the words that say what the button does. */}
          <span className="fr-plus" aria-hidden="true">
            ＋
          </span>
          Invite foreman
        </button>
      </Tooltip>
    );
  }

  const openCount = openEpisodeCount(episodes);
  return (
    <Tooltip label={drawerOpen ? "Close Foreman's session reading" : "Inspect Foreman's objective and decision history"}>
      <button className="foreman-rail" aria-expanded={drawerOpen} onClick={onToggleDrawer}>
        {openCount > 0 && <span className="fr-dot" aria-hidden="true" />}
        {episodes.length > 0 ? `Foreman · ${episodes.length}` : "Foreman intent"}
      </button>
    </Tooltip>
  );
}
