import { Fragment, useState } from "react";
import { Keycap } from "../Keycap.tsx";
import { reviewShortcutTarget } from "../../lib/review-shortcut.ts";
import type { AssignResetConfirm, Session } from "@shared/types.ts";
import { provisioningTasks } from "@shared/session.ts";
import { FailedLaunchList, fleetFailureGroups } from "../LaunchFailures.tsx";
import { latestLaunchFailure } from "@shared/launch-failure.ts";
import { pipelineRunKeyOf, type PipelineRun } from "@shared/pipeline.ts";
import { stateDisplay } from "../../lib/format.ts";
import { backlogColumnMode, boardColumnModes } from "../../lib/tone.ts";
import {
  BLOCKED_LABEL,
  clusterFallbackLabel,
  fleetColumnOf,
  fleetRows,
  orderSessions,
  repoSessionTotals,
  type FleetBlock,
  type FleetColumnId,
  type FleetRow,
  type FleetToneGroup,
} from "../../lib/fleet-order.ts";
import { repoColor } from "../../lib/repo-color.ts";
import { hiddenSessionIds, toggleRepoCollapsed, useRepoCollapsed } from "../../lib/repo-collapse.ts";
import { updateUiConfig, useUiConfig } from "../../lib/uiConfig.ts";
import { useSessionRailFolded } from "../../lib/session-rail.ts";
import {
  collapsedColumnSessionIds,
  columnWidthOf,
  setColumnWidth,
  useColumnWidths,
  type BoardColumnId,
} from "../../lib/column-width.ts";
import { heldSessionIds, newestSessionRun } from "../../lib/held.ts";
import { pinnedResidentSessions } from "../../residents/marker.ts";
import { AssignResetModal } from "../AssignResetModal.tsx";
import { PendingList } from "../PendingDispatch.tsx";
import { BacklogColumn } from "./BacklogColumn.tsx";
import { ConsoleView } from "./ConsoleView.tsx";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import { ResidentVisitorCard } from "../../residents/ResidentVisitorCard.tsx";
import { SessionTile } from "./SessionTile.tsx";
import { SubagentTree } from "./SubagentTree.tsx";
import {
  ensembleSummaryFor,
  pipelineCommissionForSession,
  type SessionViewProps,
} from "./types.ts";
import {
  blockedMembersIn,
  CollapsedColumnStrip,
  ColumnWidthControl,
  EnsembleClusterHead,
  EnsembleRailGroup,
  FleetSectionHead,
  FoldedSessionRail,
  PipelineClusterHead,
  RepoGroupHead,
  SessionRailFoldButton,
} from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { useTourTargetRef } from "../../tour/target-context.tsx";
import { RestoringSessionsColumn } from "../RestoringSessionsColumn.tsx";
import { BlockedColumnAge, BlockedFrameHead, BlockedLane, BlockedRailHead } from "../BlockedGroup.tsx";

/**
 * Whether a cluster frame is one an operator has to do something about.
 *
 * An ensemble frame asks its members (each carries `needsInput` on its own link); a pipeline
 * frame asks the RUN, because a halt is a fact about the run and not about the agent - the
 * engine stops dispatching and there may be no live session in the frame at all by the time
 * anyone looks. Two questions, one answer, so the tone on the frame and the word in its
 * header cannot disagree.
 */
function clusterNeedsYou(
  block: Extract<FleetBlock, { kind: "cluster" }>,
  runs: ReadonlyMap<string, PipelineRun> | undefined,
): boolean {
  return block.cluster === "pipeline"
    ? Boolean(runs?.get(block.runId)?.halt)
    : blockedMembersIn(block.sessions) > 0;
}

/** The repository frame row, named so the two render helpers below can take it as a parameter. */
type FleetRepoRow = Extract<FleetRow, { kind: "repo" }>;

/** A drop waiting on the operator's yes: which task, onto which agent, and what it costs. */
interface PendingDrop {
  taskId: string;
  sessionId: string;
  confirm: AssignResetConfirm;
}

/**
 * Kanban by state that drills into the console.
 *
 * With nothing open the board is a column per tone: the ranking the grid spends on
 * an invisible sort becomes structure you can read - "how many need me" is answered
 * by a column's height instead of eight badges. In front of them sits the backlog,
 * so the work waiting to start is on the same screen as the agents free to start it.
 *
 * EMPTY COLUMNS. An empty column is noise - a headed box reading "nothing here" is a
 * board reporting on its own schema instead of your fleet, and horizontal room is the
 * one thing the board never has enough of. So every empty column leaves, the Backlog,
 * "needs you", "unconfirmed" and "gone" included, and the remaining columns expand into
 * the space. Nothing is drawn in its place - no chip, no slim rail. A column that fills
 * comes back in its place in the order.
 *
 * Opening a tile doesn't slide a cramped drawer over the board; it morphs the board
 * INTO the console. The clicked column collapses everything either side of it, slides
 * to the left edge and becomes a console rail of exactly that column's sessions, and
 * the ConsoleDetail - the same tabbed conversation the console layout opens, with its
 * pinned reply box - grows into the freed space. The whole move is one animated flex
 * track (see styles.css), so it reverses for free: Escape, or the rail's back button,
 * returns you to the board you left with nothing reflowed.
 *
 * The board stays your chosen layout - this is a drill-in, not a layout switch. So the
 * overview is never lost: you use the board as the board, and the console as the desk.
 */
export function BoardView(props: SessionViewProps): React.JSX.Element {
  const boardTourRef = useTourTargetRef<HTMLElement>("see-work:board");
  const detailTourRef = useTourTargetRef<HTMLElement>("see-work:session-detail");
  // A refused drop (agent went busy, wrong repo, pane locked). Shown on the board
  // rather than swallowed, because the card silently staying in the backlog looks
  // identical to a drag that simply missed.
  const [dropError, setDropError] = useState<string | null>(null);
  // A drop the daemon refused pending a yes: the handover would reset an agent that is
  // holding a work queue or a branch. Held here rather than on the tile because the
  // dialog outlives the drag - the tile it came from can re-render (or move column)
  // while the operator is reading it.
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  // The repo of the backlog card currently in the air. Drives which tiles light up as
  // targets, so it has to be state - a tile decides whether it may accept during a
  // render, and nothing about a native drag re-renders the board on its own.
  const [draggingRepo, setDraggingRepo] = useState<string | null>(null);
  // Each column's width - collapsed, normal, or expanded - by id ("backlog" or a tone). From
  // a store rather than local state because App reads the collapsed half to keep the arrow
  // keys off cards a strip is hiding; see `lib/column-width.ts` for the rules between the
  // two halves (one expanded column at a time, and only the collapsed set is saved).
  const widths = useColumnWidths();
  const toggleWide = (id: BoardColumnId): void =>
    setColumnWidth(id, columnWidthOf(widths, id) === "wide" ? "normal" : "wide");
  // Which repository frames are folded. From the shared store rather than local state, because
  // `App` has to read the same set to build the arrow-key arrays: a fold takes cards out of the
  // DOM, and navigation that did not know would step the cursor into rows nobody can see. See
  // `lib/repo-collapse.ts`. Still un-persisted, and still keyed per ROW so folding a repository
  // in one column cannot fold away its sibling in another.
  const repoCollapsed = useRepoCollapsed();

  // The SAME ordering App derived the arrow-key column arrays from, recomputed here rather
  // than threaded down - `orderSessions` is idempotent, so re-running it on the list App
  // already ordered returns that order, and both sides stay one fact. (This is exactly the
  // `groupByTone` arrangement it replaces, now with the cluster spans the frames need.)
  // `groupBoardByRepo` read from the SAME `useUiConfig` store App and ConsoleView read it from,
  // rather than threaded down as a prop. One store means the three orderings cannot disagree
  // about whether the fleet is repository-grouped, which is the property `boardColumns` (and
  // therefore the arrow keys) depends on.
  //
  // Hoisted into its own const rather than read inline in the call below: a hook buried in an
  // argument list is one refactor away from ending up inside a condition, and the Rules of Hooks
  // violation that follows is not something this file's tests would catch.
  //
  // `blockedPlacement` from the same store for the same reason: it decides which column the
  // Blocked group is drawn in, and `boardColumns` walks the columns `order.columns` lists.
  const {
    groupBoardByRepo: groupByRepo,
    boardSidebarAllSessions,
    blockedPlacement,
    blockedFrameCollapsed,
  } = useUiConfig();
  const order = orderSessions(
    props.sessions,
    heldSessionIds(props.workflowRunsBySession),
    groupByRepo,
    props.pipelineCommissionById,
    props.pipelineRunByKey,
    pinnedResidentSessions(props.residentBySession),
    blockedPlacement,
  );
  const groups = order.groups;
  const columns = order.columns;
  // The denominator in every repository head's `2 of 7`, folded once for the whole board rather
  // than per frame: the number is about the fleet, and a frame counting only its own column
  // would report each part of a split repository as the whole.
  const repoTotals = repoSessionTotals(order);
  // The dialog's target, resolved fresh every render: `null` here retires a confirm whose
  // agent has since disappeared, rather than leaving a dialog up over a session that is
  // no longer on the board.
  const pendingTarget = pendingDrop
    ? (() => {
        const session = props.sessions.find((s) => s.id === pendingDrop.sessionId);
        if (!session) return null;
        const task = props.tasks.find((t) => t.id === pendingDrop.taskId);
        return { ...pendingDrop, session, title: task?.title ?? null };
      })()
    : null;
  // App's one detail lookup, which can name a resident the Drawer placement keeps out of
  // `sessions`: it opens here while no column or rail row names it.
  const selected = props.detailSession !== undefined
    ? props.detailSession
    : props.sessions.find((s) => s.id === props.detailId) ?? null;
  // The focused column follows the session, not the click: if the open session moves
  // tone (working -> needs input), its column re-scopes with it, and the rail's rows
  // change under a detail that - keyed by id in the aside - stays put. A blocked idle session's
  // column is wherever the placement draws it, so it is read off the columns first; a session
  // no column holds (filtered, or a resident in the drawer) falls back to the same rule.
  const focusedColumn: FleetColumnId | null = selected
    ? columns.find((c) => c.sessions.some((s) => s.id === selected.id))?.id
      ?? fleetColumnOf(selected, stateDisplay(selected).tone, blockedPlacement)
    : null;
  // The At the top of Idle frame folds on the overview only; a drill-in rail lists it whole,
  // as a collapsed column's rail does. App applies the same rule to the arrow keys.
  const blockedFolded = blockedFrameCollapsed && focusedColumn === null;

  /**
   * Dispatched, still provisioning: the placeholders at the top of the `working` column.
   *
   * The full task list is intentional. A dispatch made seconds ago must not disappear because
   * a fleet filter is still typed, which would recreate the dropped-dispatch symptom this
   * placeholder closes.
   */
  const pending = provisioningTasks(props.tasks);
  // Dispatches that failed before their session started, drawn where their placeholder was.
  // From the full task list for the same reason: a filter must not hide a dispatch that failed.
  // A returned failure is shown on its Backlog card and a kept one on its session card - when
  // that card is on screen. A folded Backlog column or a fleet filter can hide it, and then the
  // failure is drawn here instead, so the count and Show always have something to reach.
  const backlogShown = columnWidthOf(widths, "backlog") !== "collapsed";
  // A session card is not on screen when its repository row or its column is folded, or when
  // its column is the drilled-in rail - whose rows carry no failure notice.
  const hiddenCards = new Set([
    ...hiddenSessionIds(groups, repoCollapsed),
    ...collapsedColumnSessionIds(columns, widths.collapsed),
    ...(blockedFolded && blockedPlacement === "idle" ? order.blocked.map((s) => s.id) : []),
  ]);
  const failed = fleetFailureGroups(props.tasks, (group) => {
    const latest = latestLaunchFailure(group);
    if (group.outcome === "returned") return backlogShown && props.backlog.some((t) => t.id === latest.id);
    const sessionId = latest.sessionId;
    if (sessionId === null || hiddenCards.has(sessionId)) return false;
    const onRail = focusedColumn != null
      && columns.some((c) => c.id === focusedColumn && c.sessions.some((s) => s.id === sessionId));
    return !onRail && props.sessions.some((s) => s.id === sessionId);
  });
  const starters = pending.length + failed.length;

  const modes = boardColumnModes(columns, starters);
  const backlogMode = backlogColumnMode(props.backlog.length);
  // The open session's own column has no card in it - a drawer resident, or a session a
  // fleet filter hides - so no rail is drawn. The detail takes the board, and its head
  // carries the way back the rail head would have.
  const railHidden = focusedColumn != null && modes.get(focusedColumn) === "hidden";
  // The one rail fold the Console reads too. It only draws while drilled in: the overview's
  // columns are Board columns, folded with their own width control, not the rail.
  const [railFolded, setRailFolded] = useSessionRailFolded();
  const railShape = railHidden ? "none" : focusedColumn != null && railFolded ? "folded" : undefined;

  // One spelling of each row, so a session drawn inside a cluster frame and one drawn loose
  // beside it are the SAME element with the same props - the frame is a wrapper, never a
  // second rendering.
  /** A visitor card in place of a resident's card or rail row, or null for any other session. */
  const visitor = (s: Session, variant: "tile" | "rail"): React.JSX.Element | null => {
    const mark = props.residentVisitors?.has(s.id) ? props.residentBySession?.get(s.id) : undefined;
    if (!mark) return null;
    return <ResidentVisitorCard
      key={s.id}
      session={s}
      mark={mark}
      variant={variant}
      selected={s.id === props.selectedId}
      registerEl={props.registerEl}
      onOpen={(id) => props.onOpenResident?.(id)}
    />;
  };

  /**
   * One session's place in a column: its card, and beneath it the background sub-agents it
   * launched. Always the same keyed fragment, whether or not agents are showing, so an agent
   * starting never remounts the card above it (which would drop its open disclosures).
   */
  const tile = (s: Session): React.JSX.Element => (
    <Fragment key={s.id}>
      {card(s)}
      <SubagentTree session={s} />
    </Fragment>
  );
  const card = (s: Session): React.JSX.Element => {
    const asVisitor = visitor(s, "tile");
    if (asVisitor) return asVisitor;
    const commission = pipelineCommissionForSession(props, s);
    return <SessionTile
      key={s.id}
      session={s}
      selected={s.id === props.selectedId}
      onOpen={() => props.onSelect(s.id)}
      onCursorTo={() => props.onCursorTo(s.id)}
      registerEl={props.registerEl}
      registerWorkflowDisclosure={props.registerWorkflowDisclosure}
      draggingRepo={draggingRepo}
      onDropped={() => setDraggingRepo(null)}
      onDropError={setDropError}
      onDropConfirm={(p) => setPendingDrop({ ...p, sessionId: s.id })}
      workflowRuns={props.workflowRunsBySession?.get(s.id) ?? null}
      workflowRun={newestSessionRun(props.workflowRunsBySession?.get(s.id))}
      onOpenWorkflowRun={props.onOpenWorkflowRun}
      onOpenSchedule={props.onOpenSchedule}
      scheduleNameById={props.scheduleNameById}
      onOpenEnsemble={props.onOpenEnsemble}
      ensembleSummary={ensembleSummaryFor(props, s)}
      onOpenPipelineRun={props.onOpenPipelineRun}
      pipelineRunObserved={Boolean(
        s.task?.pipelineRun && props.pipelineRunByKey?.has(pipelineRunKeyOf(s.task.pipelineRun)),
      )}
      // The card's phase meter, joined CLIENT SIDE against the map this view already holds.
      // `SessionPipelineLink` carries the three coordinates `pipelineRunKeyOf` needs and
      // nothing else on purpose - a whole run on every session frame would ship 22 step
      // states per correlated card per sweep - and the projection is already here, so this
      // is the whole cost of the feature on the wire: nothing.
      pipelineRun={
        commission?.linkedRun
          ? (props.pipelineRunByKey?.get(pipelineRunKeyOf(commission.linkedRun)) ?? null)
          : s.pipeline
            ? (props.pipelineRunByKey?.get(pipelineRunKeyOf(s.pipeline)) ?? null)
            : null
      }
      pipelineCommission={commission}
      // The card's ⌘-number slot, looked up rather than counted here. `tile()` is called from
      // inside the cluster frames and the repository frames as well as loose in a column, so
      // a position counted at the call site would restart inside every frame - which is the
      // one thing the numbering must not do.
      shortcutChord={props.cardShortcutBySession?.get(s.id) ?? null}
      resident={props.residentBySession?.get(s.id) ?? null}
    />
  };
  /**
   * One column's rows - section rules and repository frames included - rendered by whichever
   * row component this surface uses. The rule and frame placement lives in `fleetRows`, so the
   * board and the rail it morphs into cannot draw them in different places.
   *
   * `wrapRepo` takes the already-rendered children rather than the blocks, so the frame cannot
   * become a second rendering of a row: a card inside a repository frame is the SAME element
   * with the same props as one sitting loose beside it, exactly as the run cluster's frame is a
   * wrapper and never a fork.
   */
  const sectioned = (
    g: FleetToneGroup,
    render: (block: FleetBlock) => React.JSX.Element,
    wrapRepo: (row: FleetRepoRow, children: React.ReactNode) => React.JSX.Element,
  ): React.ReactNode[] =>
    fleetRows(g).map((row) =>
      row.kind === "section" ? (
        <FleetSectionHead key={`section-${row.section}`} kind={row.section} count={row.count} />
      ) : row.kind === "repo" ? (
        wrapRepo(row, repoCollapsed.has(row.key) ? null : row.blocks.map(render))
      ) : (
        render(row)
      ),
    );

  /** One repository frame's head, shared by the board frame and the rail group below. */
  const repoHead = (row: FleetRepoRow, variant: "board" | "rail"): React.JSX.Element => (
    <RepoGroupHead
      repoRoot={row.repoRoot}
      here={row.blocks.reduce((n, b) => n + (b.kind === "session" ? 1 : b.sessions.length), 0)}
      total={repoTotals.get(row.repoRoot) ?? 0}
      variant={variant}
      expanded={!repoCollapsed.has(row.key)}
      onToggle={() => toggleRepoCollapsed(row.key)}
    />
  );

  const railRow = (s: Session): React.JSX.Element => {
    const asVisitor = visitor(s, "rail");
    if (asVisitor) return asVisitor;
    const commission = pipelineCommissionForSession(props, s);
    const commissionRun = commission?.linkedRun
      ? (props.pipelineRunByKey?.get(pipelineRunKeyOf(commission.linkedRun)) ?? null)
      : null;
    return <RailRow
      key={s.id}
      session={s}
      selected={s.id === props.selectedId}
      onSelect={() => props.onSelect(s.id)}
      // Register the element like the console rail does, so Shift+Tab/Escape out of the
      // reader can land focus back on the selected row here.
      registerEl={props.registerEl}
      workflowRuns={props.workflowRunsBySession?.get(s.id) ?? null}
      workflowRun={newestSessionRun(props.workflowRunsBySession?.get(s.id))}
      onOpenWorkflowRun={props.onOpenWorkflowRun}
      onOpenSchedule={props.onOpenSchedule}
      scheduleNameById={props.scheduleNameById}
      onOpenEnsemble={props.onOpenEnsemble}
      ensembleSummary={ensembleSummaryFor(props, s)}
      onOpenPipelineRun={props.onOpenPipelineRun}
      pipelineRunObserved={Boolean(
        s.task?.pipelineRun && props.pipelineRunByKey?.has(pipelineRunKeyOf(s.task.pipelineRun)),
      )}
      pipelineCommission={commission}
      pipelineCommissionRun={commissionRun}
      onOpenPipelineCommission={props.onOpenPipelineCommission}
      resident={props.residentBySession?.get(s.id) ?? null}
    />
  };

  // A function rather than inline JSX: a column may draw a Blocked lane or frame beside these
  // rows, and both have to stay one spelling.
  const groupRows = (g: FleetToneGroup, isRail: boolean): React.ReactNode => isRail ? (
    // The clicked column, now a console rail: the same RailRow (and the same
    // cluster header) the console uses, so opening a column and switching to
    // the console read alike.
    sectioned(g, (block) =>
      block.kind === "session" ? (
        railRow(block.session)
      ) : (
        // `block.key`, not the runId: a run split across the free/held boundary
        // frames once per side, and two frames keyed by one run collide.
        <div className="rail-cluster" key={block.key}>
          {block.cluster === "pipeline" ? (
            <PipelineClusterHead
              run={props.pipelineRunByKey?.get(block.runId) ?? null}
              slug={block.sessions[0]!.pipeline!.slug}
              variant="rail"
              onOpen={() => props.onOpenPipelineRun?.(block.sessions[0]!.pipeline!)}
            />
          ) : (
            <EnsembleRailGroup
              summary={props.ensembleSummaryByRun?.get(block.runId) ?? null}
              fallbackLabel={clusterFallbackLabel(block.sessions[0]!)}
              blockedHere={blockedMembersIn(block.sessions)}
              onOpen={() => props.onOpenEnsemble?.(block.runId)}
            />
          )}
          {block.sessions.map(railRow)}
        </div>
      ),
      // The rail's own repository group: a one-line head over its rows, the same
      // shape `rail-cluster` uses, so the drill-in morph does not change what a
      // repository looks like on the way from column to rail.
      (row, children) => (
        <div
          className="rail-cluster rail-repo"
          style={{ "--repo-c": repoColor(row.repoRoot) } as React.CSSProperties}
          key={row.key}
        >
          {repoHead(row, "rail")}
          {children}
        </div>
      ),
    )
  ) : (
    // Sibling members of one run render inside a frame, in the SAME order the
    // arrow keys walk (`orderSessions` decided both). The frame is presentational
    // only: it carries no drag handlers, so a dragover started on a tile inside it
    // bubbles exactly as it did when the tiles were loose children.
    sectioned(g, (block) =>
      block.kind === "session" ? (
        tile(block.session)
      ) : (
        <div
          className={`board-cluster${
            clusterNeedsYou(block, props.pipelineRunByKey) ? " needs-you" : ""
          }`}
          // `block.key`, not the runId - see the rail cluster above.
          key={block.key}
        >
          {block.cluster === "pipeline" ? (
            <PipelineClusterHead
              run={props.pipelineRunByKey?.get(block.runId) ?? null}
              slug={block.sessions[0]!.pipeline!.slug}
              variant="board"
              onOpen={() => props.onOpenPipelineRun?.(block.sessions[0]!.pipeline!)}
            />
          ) : (
            <EnsembleClusterHead
              summary={props.ensembleSummaryByRun?.get(block.runId) ?? null}
              fallbackLabel={clusterFallbackLabel(block.sessions[0]!)}
              blockedHere={blockedMembersIn(block.sessions)}
              onOpen={() => props.onOpenEnsemble?.(block.runId)}
            />
          )}
          {block.sessions.map(tile)}
        </div>
      ),
      // The repository frame. Deliberately the same box the run cluster above
      // wears, re-tinted from ONE custom property so the border, the head and
      // the body cannot drift apart - the same way `.board-pipeline-head` borrows
      // the ensemble head and only recolours its glyph. Presentational only, like
      // that frame: no drag handlers, so a dragover started on a tile inside it
      // bubbles exactly as it did when the tile was a loose child.
      (row, children) => (
        <div
          className={`board-repo${repoCollapsed.has(row.key) ? " is-collapsed" : ""}`}
          style={{ "--repo-c": repoColor(row.repoRoot) } as React.CSSProperties}
          key={row.key}
        >
          {repoHead(row, "board")}
          {children}
        </div>
      ),
    )
  );

  const blockedRows = (list: readonly Session[], isRail: boolean): React.ReactNode =>
    list.map(isRail ? railRow : tile);

  // Reuse the full Console rail, including state, repository and workflow grouping.
  // App still owns Board selection and Escape, so returning preserves the overview.
  if (selected && boardSidebarAllSessions) {
    return (
      <main ref={boardTourRef} className="board board-all-sessions" data-focus={focusedColumn}>
        <ConsoleView {...props} onBackToBoard={props.onDeselect} />
      </main>
    );
  }

  return (
    <main
      ref={boardTourRef}
      className="board"
      data-focus={focusedColumn ?? "none"}
      data-rail={railShape}
      data-dragging={draggingRepo != null ? "task" : undefined}
    >
      {backlogMode !== "hidden" && <BacklogColumn
        width={columnWidthOf(widths, "backlog")}
        onWidthChange={(width) => setColumnWidth("backlog", width)}
        inert={focusedColumn != null}
        tasks={props.backlog}
        // The FULL task list as well as the backlog slice: a dependency very often
        // points at a task that has already left the backlog (it is running, or done),
        // and a column that could only see the backlog would report those as
        // unsatisfied forever.
        allTasks={props.tasks}
        plan={props.backlogPlan}
        onAssignError={setDropError}
        onDragging={setDraggingRepo}
        onEdit={props.onEditTask}
        onOpenSchedule={props.onOpenSchedule}
        scheduleNameById={props.scheduleNameById}
        backlogTrust={props.backlogTrust}
        onManageTrust={props.onManageForemanTrust}
        sessions={props.sessions}
        workflowSummaries={props.workflowSummaries}
        stackShipping={props.stackShipping}
      />}

      <RestoringSessionsColumn
        sessions={props.restoringSessions ?? []}
        groupByRepo={groupByRepo}
      />

      {columns
        .filter((c) => modes.get(c.id) !== "hidden")
        .map((c) => {
          const g = c.group;
          const isRail = focusedColumn === c.id;
          const width = columnWidthOf(widths, c.id);
          const wide = width === "wide";
          // Never while this column IS the drill-in rail: the rail is a fixed-width console
          // fixture that has to show its rows whatever the overview had folded. The fold is
          // kept, so coming back to the board finds the column as it was left.
          const collapsed = width === "collapsed" && !isRail;
          const lane = g !== null && c.blocked.length > 0 && blockedPlacement === "needs-you";
          const frame = g !== null && c.blocked.length > 0 && blockedPlacement === "idle";
          // A lane has its own head and count, so the column's count is its own cards; a frame
          // is part of the column it sits in, so Idle's count includes it.
          const count = (lane ? g.sessions.length : c.sessions.length) + (c.id === "working" ? starters : 0);
          if (collapsed) {
            return (
              <section
                key={c.id}
                className={`board-col tone-${c.id} is-collapsed`}
                inert={focusedColumn != null}
              >
                <CollapsedColumnStrip
                  label={c.label}
                  count={count}
                  blockedCount={lane ? c.blocked.length : undefined}
                  announce={c.id === "attention"}
                  onRestore={() => setColumnWidth(c.id, "normal")}
                />
              </section>
            );
          }
          // The drill-in rail folded to its strip: the same strip the Console's rail folds to,
          // counting only this column, since this column is all the rail lists. Kept as the
          // `is-rail` section so the morph and the reader's width rules still see a rail.
          //
          // One key whatever the tone, so it stays one strip as the open session moves between
          // columns: when that session starts waiting the rail follows it into Needs you, and a
          // strip remounted there would take the new count as its baseline and never pulse.
          // `asking` is the fleet's Needs you count for the same reason - this column's count
          // is not news just because focus moved into it. A Blocked lane folds with its column
          // and keeps its own red count, as the collapsed strip above does.
          if (isRail && railFolded) {
            return (
              <section key="folded-session-rail" className={`board-col tone-${c.id} is-rail is-folded`}>
                <FoldedSessionRail
                  label={c.label}
                  groups={lane
                    ? [
                        { tone: c.id, label: c.label, count },
                        { tone: "blocked", label: BLOCKED_LABEL, count: c.blocked.length },
                      ]
                    : [{ tone: c.id, label: c.label, count }]}
                  asking={groups.find((x) => x.tone === "attention")?.sessions.length ?? 0}
                  onUnfold={() => setRailFolded(false)}
                />
              </section>
            );
          }
          const ownRows = g === null ? blockedRows(c.blocked, isRail)
            : g.sessions.length > 0 ? groupRows(g, isRail) : null;
          return (
            <section
              key={c.id}
              className={`board-col tone-${c.id}${isRail ? " is-rail" : ""}${wide ? " is-wide" : ""}${
                lane ? " has-blocked-lane" : ""}`}
              inert={focusedColumn != null && !isRail}
            >
              {/* Double-click the head to expand, the gesture asked for. On the HEAD
                  rather than on the title alone: the head is the column's handle, the
                  title is a word inside it, and a 40px target is not one. It sits
                  beside the width control rather than instead of it, so neither
                  gesture is the only way in.

                  Not while this column IS the drill-in rail: the rail is a fixed-width
                  console fixture, so the gesture would record a width nothing draws and
                  then surprise you with it on the way back to the board. */}
              <header
                className="board-col-head"
                onDoubleClick={isRail ? undefined : () => toggleWide(c.id)}
              >
                {isRail && (
                  <Tooltip label="Back to the board (Esc)">
                    <button
                      className="board-back"
                      aria-label="Back to the board"
                      onClick={props.onDeselect}
                    >
                      ‹
                    </button>
                  </Tooltip>
                )}
                <span className="board-swatch" aria-hidden />
                <h2>{c.label}</h2>
                {/* The review chord's keycap, on Needs you while pressing it would open a queue:
                    `e` goes to the first session asking without a card being picked first. The
                    same rule the chord itself follows, so the keycap is never on a column the
                    key would leave alone. */}
                {c.id === "attention" && g !== null && reviewShortcutTarget(g.sessions, null) && (
                  <span className="board-col-key"><Keycap action="review" /></span>
                )}
                {g === null && <BlockedColumnAge sessions={c.blocked} />}
                {/* BEFORE the count, not after it. The count carries `margin-left: auto`
                    and sat flush against the head's right edge; a control placed after it
                    reserves its 22px even while transparent, so every column's count
                    quietly moved inboard to hold a gap for a button nobody had hovered.
                    Here it lands in the dead space the head already had.

                    Not while drilled in: the rail is a fixed-width console fixture, and
                    a width control there would offer to move something that cannot. */}
                {!isRail && (
                  <ColumnWidthControl
                    width={width}
                    label={c.label}
                    onChange={(next) => setColumnWidth(c.id, next)}
                  />
                )}
                {/* One number when the column is one kind of thing, two when it is not. A
                    column holding three agents an open run owns and two that are genuinely free
                    has no honest single count: "5" is the number a dispatch decision reads, and
                    only two of those five can take work.

                    The free pill is dropped when there are no free agents, matching `fleetRows`
                    dropping the free RULE in the same case. "0 free · 1 held" counts a side of
                    the split that is not there, and the pair then disagreed with the single
                    rule below it about whether this column had two halves at all. */}
                {/* A placeholder is a visible row and counts in the unsplit Working column.
                    It is not included in the free/held split because no session exists yet. */}
                {g === null || g.heldFrom === null ? (
                  <span className="board-col-n">{count}</span>
                ) : (
                  <>
                    {/* The At the top of Idle frame's cards sit in this column too, and the split
                        counts only the column's own group, so they get a pill of their own -
                        first, in the order the column draws them. */}
                    {frame && (
                      <Tooltip label={`${c.blocked.length} blocked in the frame above the idle cards`}>
                        <span className="board-col-n n-blocked">{c.blocked.length} blocked</span>
                      </Tooltip>
                    )}
                    {g.heldFrom > 0 && (
                      <Tooltip
                        label={`${g.heldFrom} of ${g.sessions.length} idle agents can take work`}
                      >
                        <span className="board-col-n n-free">{g.heldFrom} free</span>
                      </Tooltip>
                    )}
                    <Tooltip label="Held by a workflow run that is still open - the run owns the next turn">
                      <span className="board-col-n n-held">
                        {g.sessions.length - g.heldFrom} held
                      </span>
                    </Tooltip>
                  </>
                )}
                {/* The rail's own fold, where the width control would be: drilled in, the
                    column stops being a Board column and becomes the session rail. */}
                {isRail && <SessionRailFoldButton onFold={() => setRailFolded(true)} />}
              </header>
              {/* A Needs you column holding only its Blocked lane draws no body above it: the
                  lane takes the column. */}
              {(!lane || g.sessions.length > 0) && (
                <div className="board-col-body">
                  {/* Keep the placeholder at the top of Working, and use the rail shape while
                      this column is drilled in so the Board-to-Console morph stays coherent. */}
                  {c.id === "working" && (
                    <PendingList tasks={pending} variant={isRail ? "rail" : "tile"} />
                  )}
                  {c.id === "working" && (
                    <FailedLaunchList groups={failed} variant={isRail ? "rail" : "tile"} />
                  )}
                  {frame && (isRail ? (
                    <div className="rail-cluster rail-blocked" key="blocked">
                      <BlockedRailHead sessions={c.blocked} />
                      {blockedRows(c.blocked, true)}
                    </div>
                  ) : (
                    <div
                      className={`board-repo board-blocked${blockedFolded ? " is-collapsed" : ""}`}
                      role="group"
                      aria-label="Blocked"
                      key="blocked"
                    >
                      <BlockedFrameHead
                        sessions={c.blocked}
                        expanded={!blockedFolded}
                        onToggle={() => void updateUiConfig({ blockedFrameCollapsed: !blockedFrameCollapsed })}
                      />
                      {!blockedFolded && blockedRows(c.blocked, false)}
                    </div>
                  ))}
                  {/* Only Working is ever drawn with no sessions, and only while it is holding
                      dispatch placeholders - every other empty column is not rendered. */}
                  {ownRows}
                </div>
              )}
              {lane && (
                <BlockedLane sessions={c.blocked} alone={g.sessions.length === 0} rail={isRail}>
                  {blockedRows(c.blocked, isRail)}
                </BlockedLane>
              )}
            </section>
          );
        })}

      {dropError && (
        <p className="board-drop-error" role="status">
          {dropError}
          <Tooltip label="Dismiss this message">
            <button onClick={() => setDropError(null)} aria-label="Dismiss">
              ×
            </button>
          </Tooltip>
        </p>
      )}

      {/* Reconciled against the live lists rather than trusted: a session that went away
          (or a task that left the backlog) while the dialog was open would otherwise be
          confirmed against something that no longer exists. */}
      {pendingTarget && (
        <AssignResetModal
          session={pendingTarget.session}
          taskId={pendingTarget.taskId}
          taskTitle={pendingTarget.title}
          confirm={pendingTarget.confirm}
          onClose={() => setPendingDrop(null)}
        />
      )}

      {/* A flex track that's collapsed to nothing until a session is open, then grows to
          fill the board. Kept in the tree across the morph so both directions animate;
          the ConsoleDetail inside mounts only when there's a session to read, and is
          clipped while the track is closed. Keyed by id so switching sessions remounts,
          exactly as the console does. */}
      <aside
        ref={selected ? detailTourRef : undefined}
        className="board-detail"
        aria-label={selected ? "Session detail workspace" : undefined}
        aria-hidden={selected == null}
      >
        {selected && (
          <ConsoleDetail
            key={selected.id}
            view={props}
            session={selected}
            // The rail head's back button is off screen both when no rail is drawn and when
            // the rail is folded to its strip, so the detail head carries the way back then.
            onBack={railHidden || railFolded ? props.onDeselect : undefined}
          />
        )}
      </aside>
    </main>
  );
}
