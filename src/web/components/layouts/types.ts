import type {
  BacklogPlan,
  FileCommentReview,
  FileCommentThread,
  ReviewItem,
  Session,
  Task,
} from "@shared/types.ts";
import type { ActionBarHandle } from "../ActionBar.tsx";
import type { SessionLaunchersHandle } from "../LaunchMenu.tsx";
import type { TranscriptFindHandle } from "../TranscriptPanel.tsx";
import type { SessionFilesController } from "../../lib/sessionFiles.ts";
import type { WorkflowBindingSummary, WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { PipelineRun, PipelineRunLink } from "@shared/pipeline.ts";

/** The Board card's in-place workflow disclosure, registered for App's global shortcut. */
export interface WorkflowDisclosureHandle {
  toggle(): void;
}

/**
 * What every layout gets from App, which stays the single owner of session state.
 * A layout arranges; it never decides.
 *
 * One shared bundle rather than each view growing its own prop list: Console and Board
 * share the same detail component, and two hand-written copies of that wiring are two
 * places for a layout to quietly stop passing a session signal.
 */
export interface SessionViewProps {
  /** The visible, sorted sessions - already filtered; layouts render exactly these. */
  sessions: Session[];
  /**
   * Every known task, unfiltered. Lookups only: resolving a drop's title, and the
   * dependency/ordering reads (`nextUpTaskId`, `backlogIndex`) that are wrong unless
   * they can see the WHOLE backlog - narrow this and item #7 renders as "next up".
   * To draw the backlog, use `backlog`.
   */
  tasks: Task[];
  /**
   * The backlog to draw: ordered, and already narrowed by the nav-bar filter - the
   * same contract `sessions` has, for the same reason. Split from `tasks` because the
   * two answer different questions: this one is "what does the operator see", `tasks`
   * is "what exists". Filtering the one list that did both is what made the filter box
   * silently skip the Backlog column.
   */
  backlog: Task[];
  /** Reopen the dispatch modal over a backlog task, to correct it or send it now. */
  onEditTask: (taskId: string) => void;
  /**
   * Foreman's reading of the backlog (dependencies + order), or null when it has none.
   *
   * Lives on the shared bundle rather than being fetched by `BacklogColumn`, per the
   * rule at the top of this file: a layout arranges, it never decides - and a fourth
   * layout that also wanted to show the backlog would otherwise grow its own fetch and
   * its own poll.
   */
  backlogPlan: BacklogPlan | null;
  selectedId: string | null;
  /**
   * Which half of the Console holds the keyboard - the rail selector or the open
   * conversation reader. Console and the Board drill-in share it. Drives whether the
   * rail's selected row reads as active or handed-off, and which surface shows the focus
   * ring. App owns the transition (Tab / Shift+Tab / Escape); the view reports native
   * focus movement so the state stays aligned with the DOM.
   */
  consoleZone: "rail" | "detail";
  onConsoleZoneChange: (zone: "rail" | "detail") => void;
  onSelect: (id: string) => void;
  /**
   * Move the selection cursor to a session WITHOUT opening its detail.
   *
   * What the arrow keys have always done, offered to a pointer. Only one surface needs it:
   * a Board tile's expanded workflow panel, whose first click says "this session" and whose
   * second says "that run" - and drilling in on the first would replace the tile (and the
   * ladder being read) with the rail row, leaving the second click nowhere to land.
   */
  onCursorTo: (id: string) => void;
  /** Close the current detail: reverses the board drill-in or empties the console. */
  onDeselect: () => void;
  /** Open detail id: the Console selection or the Board's drill-in. */
  detailId: string | null;
  onOpenReviews: (id: string) => void;
  onOpenDiff: (id: string, commit?: string) => void;
  /** One-shot request to reveal a session's integrated Diff tab, optionally at one fix. */
  diffTabRequest: { sessionId: string; commit: string | null; nonce: number } | null;
  onOpenFiles: (id: string) => void;
  /** Open a Markdown href only when it resolves inside this session's checkout. */
  onOpenFile: (id: string, href: string, probe?: boolean) => boolean | Promise<boolean>;
  /**
   * Show one EXACT checkout-relative path in the Files workspace. For callers holding a
   * path rather than prose - `onOpenFile` would read a trailing `:12` as a line number.
   */
  onOpenFilePath: (id: string, path: string) => void;
  /** One-shot request from a shortcut/picker to reveal a session's integrated Files tab. */
  fileTabRequest: { sessionId: string; nonce: number } | null;
  /**
   * One-shot request from the conversation shortcut to reveal a session's Conversation
   * tab. Carries a nonce like the other two: the detail already OPENS on this tab, so
   * without one a second press after walking to Files would be a no-op.
   */
  conversationTabRequest: { sessionId: string; nonce: number } | null;
  /**
   * One-shot request from the session-workflows shortcut to reveal a session's Workflows
   * tab and its workflow ladder. Nonce for the same reason the others
   * carry one: the request is consumed by a mounted detail, not stored as a tab preference.
   */
  workflowsTabRequest: { sessionId: string; nonce: number } | null;
  files: SessionFilesController;
  /**
   * Every live line-comment thread, for every session - the Files tab narrows to its own.
   * Whole rather than per-session so the integrated tab and the extracted Files window
   * cannot hold two different narrowings of the same frames.
   *
   * Optional for the same reason `isOverlayOpen` is: a layout test that never opens a Files
   * tab has no threads to hand it, and a surface with none behaves exactly as one with an
   * empty list.
   */
  fileCommentThreads?: FileCommentThread[];
  /** Each session's walkthrough run state. At most one row per session; empty until one starts. */
  fileCommentReviews?: FileCommentReview[];
  /** Which source line the reader deep-linked to, and how many times they asked. */
  fileLineRequest?: { sessionId: string; path: string; line: number; nonce: number } | null;
  onReset: (id: string) => void;
  /** Open the complete-and-close confirm for this session (app-level modal). */
  onComplete: (id: string) => void;
  /** Open the kill confirm for this session (app-level modal). */
  onKill: (id: string) => void;
  /**
   * A kill landed on this session. The detail it was ordered from is now a dead
   * transcript, so App closes it: the board reverses its drill-in, the console empties
   * its pane. Not driven by the session disappearing - it
   * lingers ~8s as `exited` first, which is the whole delay this removes.
   *
   * Fired by the confirm dialogs, both of which end the session - Complete closes it
   * once the outcome is recorded, exactly as Kill does.
   */
  onKilled: (id: string) => void;
  /** Per-session counter bumped on each reset, so a card can remount its (uncontrolled)
   *  reply box and clear the text a reset discarded. Absent id means never reset (0). */
  resetNonces: Record<string, number>;
  registerEl: (id: string, el: HTMLElement | null) => void;
  /** Register a Board tile's workflow disclosure for the rebindable expand action. */
  registerWorkflowDisclosure?: (id: string, handle: WorkflowDisclosureHandle | null) => void;
  registerActions: (id: string, handle: ActionBarHandle | null) => void;
  /** Register the conversation toolbar's terminal and agent launch controls. */
  registerLaunchers: (id: string, handle: SessionLaunchersHandle | null) => void;
  /** Register the mounted transcript's find surface, so the fleet-wide chord can open
   *  it on whichever conversation is selected. */
  registerFind: (id: string, handle: TranscriptFindHandle | null) => void;
  /** Register the open detail pane's owner for vertical reader and file-navigation arrows. */
  registerDetailScroll: (
    id: string,
    scroll: ((direction: -1 | 1, fromReader: boolean) => boolean) | null,
  ) => void;
  /** Read App's live overlay registry before a tab-local shortcut acts. */
  isOverlayOpen?: () => boolean;
  /** Register the open detail's tab stepper, so Tab/Shift+Tab can cycle its tabs. Returns
   *  "edge" when there is no next/previous tab (App clamps forward, exits to the rail back). */
  registerReaderTab: (id: string, nav: ((dir: -1 | 1) => "moved" | "edge") | null) => void;
  renamingId: string | null;
  onRenameStart: (id: string) => void;
  onRenameClose: () => void;
  foremanMode: string;
  foremanEnabled: boolean;
  foremanAllowlist?: string[];
  inputReviewBySession: ReadonlyMap<string, string>;
  pendingReviewIds: ReadonlySet<string>;
  /**
   * Every review App holds, at every status - NOT the pending ones.
   *
   * Deliberately wider than the two narrowed views above it, because the conversation reads
   * the opposite end of a review's life: what was ANSWERED, so it can show the answer where
   * it was given. Narrowing here would leave `useTimelineReviews` unable to see a resolution
   * arrive, which is the whole point of taking the live list rather than refetching.
   */
  reviews: ReviewItem[];
  /**
   * App-owned join from compact run SSE summaries to each live session: EVERY run the session
   * carries, one per repository a multi-repo task changed.
   *
   * One entry for the fleet's single-repo sessions, so every rule built on it answers exactly
   * what it answered when there was one run: the held mark, the drop target, the bind
   * affordance and the chips.
   *
   * The three surfaces that genuinely speak about a single review - the board tile's ladder,
   * the console's Workflows tab, the retro offer - derive it with `newestSessionRun` rather
   * than reading a second map, so a session's list and its one run cannot disagree.
   */
  workflowRunsBySession?: ReadonlyMap<string, readonly WorkflowRunSummary[]>;
  /** App-owned join from compact binding SSE summaries to each live session. */
  workflowBindingBySession?: ReadonlyMap<string, WorkflowBindingSummary>;
  onOpenWorkflowRun?: (runId: string) => void;
  onBindWorkflow?: (sessionId: string) => void;
  /**
   * Open Recurring Missions at a schedule (optionally at one occurrence in its
   * history), from a generated task's provenance mark. A deep link, not a session
   * action: it changes no session state, focus, expansion, drag, or keyboard behavior.
   */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /**
   * Live catalog names by schedule id, so a scheduled task's mark can read "Scheduled by
   * <name>" without every renderer re-deriving it. A `ReadonlyMap` like
   * `workflowRunBySession`; absent entries (an archived or purged schedule) fall back to a
   * generic label, and the deep link still works because history carries the schedule.
   */
  scheduleNameById?: ReadonlyMap<string, string>;
  /**
   * Open the Ensemble run a session's member belongs to. No App-owned lookup map is needed:
   * the member projection already nests on `session.task.ensemble` (a `TaskEnsembleLink`), so
   * the renderers read it straight off the session and route through this handler by run id.
   */
  onOpenEnsemble?: (runId: string) => void;
  /**
   * The live ensemble runs by id, for the facts that are about the GROUP rather than about one
   * member: a cluster header's stage word and progress dots, and the chip's `n/m in` suffix.
   *
   * A map on the shared bundle rather than a per-session join, unlike `workflowRunBySession`,
   * because a run is not a property of one session - a cluster header is drawn once for several
   * of them. Absent entries are first-class: a member's link can arrive a tick before its run's
   * SSE summary does, and every consumer falls back to what the link alone can say.
   */
  ensembleSummaryByRun?: ReadonlyMap<string, EnsembleSummary>;
  /**
   * Open the pipeline run a correlated session is doing the work of.
   *
   * Takes the LINK rather than a run key, because the address is assembled in one place
   * (`pipelineRunRoute`) and a renderer that passed a key would have to know that the
   * repository half of it is a composite. Every renderer already holds the link: it is on
   * the session.
   */
  onOpenPipelineRun?: (link: PipelineRunLink) => void;
  /**
   * The live pipeline runs by `pipelineRunKey`, for the facts about the RUN rather than the
   * session: the cluster header's group word and current step.
   *
   * `ensembleSummaryByRun`'s twin, and absent entries are first-class for the same reason -
   * a session's link rides its own frame and the run's projection is a separate collection
   * that can land a tick later. Every consumer falls back to what the link alone can say,
   * which is the slug.
   */
  pipelineRunByKey?: ReadonlyMap<string, PipelineRun>;
}

/** The run summary behind this session's member link, when both are on hand. */
export function ensembleSummaryFor(
  p: Pick<SessionViewProps, "ensembleSummaryByRun">,
  s: Session,
): EnsembleSummary | null {
  const runId = s.task?.ensemble?.runId;
  return (runId ? p.ensembleSummaryByRun?.get(runId) : null) ?? null;
}
