import type { Session } from "@shared/types.ts";
import { pipelineRunKeyOf } from "@shared/pipeline.ts";
import {
  clusterFallbackLabel,
  fleetRows,
  orderSessions,
  repoSessionTotals,
  type FleetBlock,
} from "../../lib/fleet-order.ts";
import { heldSessionIds, newestSessionRun } from "../../lib/held.ts";
import { repoColor } from "../../lib/repo-color.ts";
import { toggleRepoCollapsed, useRepoCollapsed } from "../../lib/repo-collapse.ts";
import { useUiConfig } from "../../lib/uiConfig.ts";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import {
  blockedMembersIn,
  EnsembleRailGroup,
  FleetSectionHead,
  PipelineClusterHead,
  RepoGroupHead,
} from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { ensembleSummaryFor, type SessionViewProps } from "./types.ts";

/**
 * Split-pane master/detail: a dense rail of every session, one always-open detail
 * beside it.
 *
 * The detail is a bespoke, tabbed reading of the session (see ConsoleDetail), built from
 * the shared session leaf pieces (transcript, work queue, action bar, session-bits).
 *
 * Selection means the selected session IS the
 * mounted detail, and only a mounted ActionBar registers the handle the keyboard
 * shortcuts drive. Nothing selected means nothing to send into, so the pane says so
 * rather than silently swallowing a keystroke.
 */
export function ConsoleView(props: SessionViewProps): React.JSX.Element {
  const active = props.sessions.find((s) => s.id === props.selectedId) ?? null;
  // The one fleet ordering, so the rail's rows come out in the order the arrow keys walk and
  // an ensemble's siblings sit together under one header. Empty groups are dropped here (and
  // only here - the contract is that `orderSessions` returns them all, because App's board
  // column arrays depend on the indices lining up whether or not a column is on screen).
  // `groupBoardByRepo` from the SAME store BoardView and App read it from. The console rail is
  // what the board's focused column morphs INTO, so a rail that grouped differently would read
  // as the fleet regrouping when only the layout moved - the same reason the free/held rule is
  // drawn by one shared component in both places.
  const order = orderSessions(
    props.sessions,
    heldSessionIds(props.workflowRunsBySession),
    useUiConfig().groupBoardByRepo,
  );
  const groups = order.groups.filter((g) => g.sessions.length > 0);
  const repoTotals = repoSessionTotals(order);
  // Which repository groups are folded, from the store `App` and the board read too. Shared
  // rather than per-layout: the board's focused column BECOMES this rail on drill-in, so two
  // fold states meant one repository could be open on one side of the morph and folded on the
  // other - and `App` needs the same set to keep the arrow keys off folded rows.
  const repoCollapsed = useRepoCollapsed();

  // The zone only reads on screen once a session is open beside the rail; with an empty
  // pane there is no reader to hand focus to, so it always presents as the rail.
  const zone = active ? props.consoleZone : "rail";

  const railRow = (s: Session): React.JSX.Element => (
    <RailRow
      key={s.id}
      session={s}
      selected={s.id === props.selectedId}
      onSelect={() => props.onSelect(s.id)}
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
    />
  );

  /**
   * One rail row that is not a section rule: a loose session, or a run's framed siblings.
   *
   * Extracted so the repository group below renders its contents with the SAME spelling the
   * top level uses. A repository frame containing a second copy of this JSX is a fork waiting
   * to drift - the run frame inside a repository has to be the same frame as one sitting loose
   * beside it, or a pipeline that moved into a grouped column would quietly lose its head.
   */
  const renderBlock = (block: FleetBlock): React.JSX.Element =>
    block.kind === "session" ? (
      railRow(block.session)
    ) : (
      // `block.key`, not the runId: a run split across the free/held boundary frames once per
      // side, and two frames keyed by one run collide.
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
    );

  return (
    <div className="console" data-zone={zone}>
      <nav
        className="console-rail"
        aria-label="Sessions"
        onFocusCapture={() => props.onConsoleZoneChange("rail")}
      >
        {groups.map((g) => (
          <div key={g.tone}>
            <div className={`rail-group tone-${g.tone}`}>
              {g.label}
              {/* The same split the board head draws, in the rail's register: "idle 5" over
                  three held agents reads as five free ones, and the rail is the surface a
                  dispatch glance actually scans. One number when the group is one kind of
                  thing, two when it is not; the free side drops at zero exactly as the
                  board's pill and `fleetRows`' free rule do. */}
              {g.heldFrom === null ? (
                <span className="rail-group-n">{g.sessions.length}</span>
              ) : (
                <span className="rail-group-n rail-group-split">
                  {g.heldFrom > 0 && (
                    <Tooltip label={`${g.heldFrom} of ${g.sessions.length} idle agents can take work`}>
                      <span className="n-free">{g.heldFrom} free</span>
                    </Tooltip>
                  )}
                  <Tooltip label="Held by a workflow run that is still open - the run owns the next turn">
                    <span className="n-held">{g.sessions.length - g.heldFrom} held</span>
                  </Tooltip>
                </span>
              )}
            </div>
            {/* Sibling members of one run sit under a header row of their own, inside the
                tone section they belong to. The header is NOT a session row: rail navigation
                walks session ids, so an arrow key steps over it (`layoutNav.ts`). */}
            {/* The same free/held rule the board draws. `orderSessions` sorts held sessions
                last within `idle` for every layout, so without this the rail would reorder
                with nothing on screen saying why. */}
            {fleetRows(g).map((row) =>
              row.kind === "section" ? (
                <FleetSectionHead
                  key={`section-${row.section}`}
                  kind={row.section}
                  count={row.count}
                />
              ) : row.kind === "repo" ? (
                // A repository group, one level above the run frames inside it. `row.key`
                // rather than the root, for the reason the cluster below gives: a repository is
                // grouped once per tone section and once per side of the free/held boundary.
                <div
                  className="rail-cluster rail-repo"
                  style={{ "--repo-c": repoColor(row.repoRoot) } as React.CSSProperties}
                  key={row.key}
                >
                  <RepoGroupHead
                    repoRoot={row.repoRoot}
                    here={row.blocks.reduce(
                      (n, b) => n + (b.kind === "session" ? 1 : b.sessions.length),
                      0,
                    )}
                    total={repoTotals.get(row.repoRoot) ?? 0}
                    variant="rail"
                    expanded={!repoCollapsed.has(row.key)}
                    onToggle={() => toggleRepoCollapsed(row.key)}
                  />
                  {!repoCollapsed.has(row.key) && row.blocks.map(renderBlock)}
                </div>
              ) : (
                renderBlock(row)
              ),
            )}
          </div>
        ))}
      </nav>

      <section
        className="console-detail"
        onFocusCapture={() => props.onConsoleZoneChange("detail")}
      >
        {active ? (
          // Keyed by id so switching sessions remounts: the tab resets to the
          // conversation and the transcript starts clean, instead of showing the
          // previous session's selected tab.
          <ConsoleDetail key={active.id} view={props} session={active} />
        ) : (
          <div className="console-empty">
            <p className="empty-title">No session selected</p>
            <p className="empty-sub">
              Pick one from the list, or press an arrow key. Its conversation, work queue and
              controls open here.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
