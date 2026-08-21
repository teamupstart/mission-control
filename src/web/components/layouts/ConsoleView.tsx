import type { Session } from "@shared/types.ts";
import { pipelineRunKeyOf } from "@shared/pipeline.ts";
import { clusterFallbackLabel, fleetRows, orderSessions } from "../../lib/fleet-order.ts";
import { heldSessionIds, newestSessionRun } from "../../lib/held.ts";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import {
  blockedMembersIn,
  EnsembleRailGroup,
  FleetSectionHead,
  PipelineClusterHead,
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
  const groups = orderSessions(
    props.sessions,
    heldSessionIds(props.workflowRunsBySession),
  ).groups.filter((g) => g.sessions.length > 0);

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
              ) : row.kind === "session" ? (
                railRow(row.session)
              ) : (
                // `row.key`, not the runId: a run split across the free/held boundary
                // frames once per side, and two frames keyed by one run collide.
                <div className="rail-cluster" key={row.key}>
                  {row.cluster === "pipeline" ? (
                    <PipelineClusterHead
                      run={props.pipelineRunByKey?.get(row.runId) ?? null}
                      slug={row.sessions[0]!.pipeline!.slug}
                      variant="rail"
                      onOpen={() => props.onOpenPipelineRun?.(row.sessions[0]!.pipeline!)}
                    />
                  ) : (
                    <EnsembleRailGroup
                      summary={props.ensembleSummaryByRun?.get(row.runId) ?? null}
                      fallbackLabel={clusterFallbackLabel(row.sessions[0]!)}
                      blockedHere={blockedMembersIn(row.sessions)}
                      onOpen={() => props.onOpenEnsemble?.(row.runId)}
                    />
                  )}
                  {row.sessions.map(railRow)}
                </div>
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
