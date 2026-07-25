import type { BacklogPlan, Session, Task } from "@shared/types.ts";
import type { ActionBarHandle } from "../ActionBar.tsx";
import type { SessionFilesController } from "../../lib/sessionFiles.ts";
import type { WorkspaceLinkHandler } from "../Markdown.tsx";
import type { WorkflowRunSummary } from "@shared/workflow.ts";

/**
 * What every layout gets from App, which stays the single owner of session state.
 * A layout arranges; it never decides.
 *
 * One shared bundle rather than each view growing its own prop list: SessionCard
 * takes eighteen props, and three hand-written copies of that wiring is three
 * places for a layout to quietly stop passing (say) `pendingReviewIds` and start
 * lying about a stale Foreman draft. `cardProps` below is the single spelling.
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
  /** Sessions whose parked no-mistakes gate actually needs you (computed cross-session). */
  gateAlerts: ReadonlySet<string>;
  selectedId: string | null;
  /**
   * Which half of the Console holds the keyboard - the rail selector or the open
   * conversation reader. Console-only: the grid and board ignore it. Drives whether the
   * rail's selected row reads as active or handed-off, and which surface shows the focus
   * ring. App owns the transition (Tab / Shift+Tab / Escape); the view reports native
   * focus movement so the state stays aligned with the DOM.
   */
  consoleZone: "rail" | "detail";
  onConsoleZoneChange: (zone: "rail" | "detail") => void;
  onSelect: (id: string) => void;
  /** Close the current detail: reverses the board drill-in or empties the console. */
  onDeselect: () => void;
  /** Open detail id: grid focus mode, console selection, or the board's drill-in. */
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onOpenReviews: (id: string) => void;
  onOpenDiff: (id: string, commit?: string) => void;
  /** One-shot request to reveal a session's integrated Diff tab, optionally at one fix. */
  diffTabRequest: { sessionId: string; commit: string | null; nonce: number } | null;
  onOpenFiles: (id: string) => void;
  /** Open a Markdown href only when it resolves inside this session's checkout. */
  onOpenFile: (id: string, href: string, probe?: boolean) => boolean | Promise<boolean>;
  /** One-shot request from a shortcut/picker to reveal a session's integrated Files tab. */
  fileTabRequest: { sessionId: string; nonce: number } | null;
  files: SessionFilesController;
  onReset: (id: string) => void;
  /** Open the complete-and-close confirm for this session (app-level modal). */
  onComplete: (id: string) => void;
  /** Open the kill confirm for this session (app-level modal). */
  onKill: (id: string) => void;
  /**
   * A kill landed on this session. The detail it was ordered from is now a dead
   * transcript, so App closes it: the board reverses its drill-in, the console empties
   * its pane, the grid leaves focus mode. Not driven by the session disappearing - it
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
  registerActions: (id: string, handle: ActionBarHandle | null) => void;
  /** Register the open detail pane's vertical reader for Console arrow-key scrolling. */
  registerDetailScroll: (id: string, scroll: ((direction: -1 | 1) => void) | null) => void;
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
  /** App-owned join from compact run SSE summaries to each live session. */
  workflowRunBySession?: ReadonlyMap<string, WorkflowRunSummary>;
  onOpenWorkflowRun?: (runId: string) => void;
  onBindWorkflow?: (sessionId: string) => void;
  /**
   * Open the Scheduled Catalog at a schedule (optionally at one occurrence in its
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
}

/**
 * The props for one session's card, spelled once. Only the grid (Cards) renders a
 * SessionCard now, so it's the sole caller - the console and board drill into a bespoke
 * ConsoleDetail built from the same leaf pieces instead.
 */
export function cardProps(p: SessionViewProps, s: Session) {
  return {
    session: s,
    gateNeedsYou: p.gateAlerts.has(s.id),
    selected: s.id === p.selectedId,
    onSelect: () => p.onSelect(s.id),
    expanded: p.expandedId === s.id,
    onToggleExpand: () => p.onToggleExpand(s.id),
    onOpenReviews: () => p.onOpenReviews(s.id),
    onOpenDiff: (commit?: string) => p.onOpenDiff(s.id, commit),
    onOpenFiles: () => p.onOpenFiles(s.id),
    onOpenFile: ((href: string, probe?: boolean) => p.onOpenFile(s.id, href, probe)) satisfies WorkspaceLinkHandler,
    onReset: () => p.onReset(s.id),
    onComplete: () => p.onComplete(s.id),
    onKill: () => p.onKill(s.id),
    onKilled: () => p.onKilled(s.id),
    resetNonce: p.resetNonces[s.id] ?? 0,
    registerEl: p.registerEl,
    registerActions: p.registerActions,
    renaming: p.renamingId === s.id,
    onRenameStart: () => p.onRenameStart(s.id),
    onRenameClose: p.onRenameClose,
    foremanMode: p.foremanMode,
    foremanEnabled: p.foremanEnabled,
    foremanAllowlist: p.foremanAllowlist,
    inputReviewId: p.inputReviewBySession.get(s.id) ?? null,
    pendingReviewIds: p.pendingReviewIds,
    workflowRun: p.workflowRunBySession?.get(s.id) ?? null,
    onOpenWorkflowRun: p.onOpenWorkflowRun,
    onBindWorkflow: p.onBindWorkflow ? () => p.onBindWorkflow?.(s.id) : undefined,
    onOpenSchedule: p.onOpenSchedule,
    scheduleNameById: p.scheduleNameById,
    onOpenEnsemble: p.onOpenEnsemble,
  };
}
