import { useEffect, useRef, useState } from "react";
import type { FleetCost, ReviewItem, ServerEvent, Session, SettingsStatus, Task } from "@shared/types.ts";
import type { LineSummary } from "@shared/line.ts";
import type {
  PersonaView,
  SessionAction,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import { dropSessionDrafts } from "./lib/drafts.ts";
import { dropHistory } from "./lib/transcript-history.ts";
import { dropRunActions } from "./workflows/run-action-store.ts";

/**
 * Unknown event types already warned about. A version-skewed daemon emitting an
 * unknown variant emits it repeatedly - often once per sweep - so warning on every
 * message would grow the console without end for as long as the skew lasts. One
 * line per distinct type carries the same diagnostic.
 */
const warnedUnknownEventTypes = new Set<string>();

export interface MissionState {
  sessions: Session[];
  reviews: ReviewItem[];
  tasks: Task[];
  personas: PersonaView[];
  /** The SessionAction catalog, archived rows included so a node can always name its source. */
  sessionActions: SessionAction[];
  workflowSummaries: WorkflowSummary[];
  workflowRunSummaries: WorkflowRunSummary[];
  /**
   * Compact ensemble projections. Members, artifacts, evaluations and patches are fetched
   * over HTTP when a detail view asks for them, so this collection stays bounded however
   * large a run's roster or evaluation history grows.
   */
  ensembleSummaries: EnsembleSummary[];
  /**
   * The live Recurring Missions catalog. The SOLE catalog source: EventSource reconnect and
   * the snapshot are the only refresh mechanism - this hook never polls the schedule routes.
   * Non-archived schedules only; occurrence history is fetched on demand elsewhere.
   */
  schedules: MissionSchedule[];
  /**
   * Fleet spend and the subscription's rate limits, for the topbar strip. A single
   * value rather than a per-session field because that is the shape of the fact: the
   * rate-limit windows belong to the ACCOUNT, so one copy is the only way for the
   * dashboard to have exactly one answer. Null until the daemon has anything to say -
   * which is the ordinary state for anyone who hasn't switched telemetry on.
   */
  fleetCost: FleetCost | null;
  /**
   * The Line's six stage folds, computed WHOLE on the daemon.
   *
   * The one rule this store carries: nothing here re-derives it. The browser holds sessions,
   * tasks, runs and ensembles, so a client-side fold would compile and look plausible - and
   * would be a second answer to "how is the fleet doing" that drifts the moment either side
   * learns something the other has not, and that is simply blind to the two stages whose
   * inputs never cross the wire (task-source sweep recency, the adoption ledger).
   *
   * Null only before the first snapshot lands. After that it is always a whole strip: a
   * quiet fleet is six real sentences, not an absence.
   */
  lineSummary: LineSummary | null;
  /**
   * The subsystem status the Settings rail dots and topbar gear read (Inspector live,
   * YOLO armed, failing task sources). The ONE client-side source of these facts - no
   * surface re-polls for them. Null until the first snapshot lands, which is "unknown",
   * NOT "all off": a null renders no gear dot rather than a green all-clear.
   */
  settingsStatus: SettingsStatus | null;
  connected: boolean;
  /** True once the initial `snapshot` has populated state (distinct from the SSE
   * connection opening). Alerting keys off this so opening the dashboard doesn't
   * diff the real snapshot against the empty first render. */
  hasSnapshot: boolean;
}

/**
 * Subscribe to the daemon's SSE stream and maintain a live view of sessions and
 * reviews. The browser's EventSource auto-reconnects on drop; we surface that
 * as `connected` so the header can show link state. This is the entire
 * auto-refresh mechanism - no polling from the client.
 */
export function useEventStream(): MissionState {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [reviews, setReviews] = useState<Map<string, ReviewItem>>(new Map());
  const [tasks, setTasks] = useState<Map<string, Task>>(new Map());
  const [personas, setPersonas] = useState<Map<string, PersonaView>>(new Map());
  const [sessionActions, setSessionActions] = useState<Map<string, SessionAction>>(new Map());
  const [workflowSummaries, setWorkflowSummaries] = useState<Map<string, WorkflowSummary>>(new Map());
  const [workflowRuns, setWorkflowRuns] = useState<Map<string, WorkflowRunSummary>>(new Map());
  const [ensembles, setEnsembles] = useState<Map<string, EnsembleSummary>>(new Map());
  const [schedules, setSchedules] = useState<Map<string, MissionSchedule>>(new Map());
  const [fleetCost, setFleetCost] = useState<FleetCost | null>(null);
  const [lineSummary, setLineSummary] = useState<LineSummary | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/events");
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // A reconnect re-sends a full snapshot; drop the flag so alerting re-baselines
      // off it instead of storming for everything that changed during the gap.
      setHasSnapshot(false);
      // Drop the settings status too: while the channel is down, Inspector/YOLO/task-source
      // health may change and we would not hear it, so the dots must go dark ("unknown")
      // rather than keep asserting the pre-drop state - the reconnect snapshot restores it.
      // This is the status tuple's own contract, not fleet cost's: a stale "armed"/"failing"
      // dot claims a subsystem posture that may no longer hold, where a stale cost figure is
      // just a few-second-old estimate.
      setSettingsStatus(null);
    };

    es.onmessage = (ev) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(ev.data) as ServerEvent;
      } catch {
        return;
      }
      switch (msg.type) {
        case "snapshot":
          setSessions(new Map(msg.sessions.map((s) => [s.id, s])));
          setReviews(new Map(msg.reviews.map((r) => [r.id, r])));
          setTasks(new Map(msg.tasks.map((t) => [t.id, t])));
          setPersonas(new Map(msg.personas.map((persona) => [persona.id, persona])));
          setSessionActions(new Map(msg.sessionActions.map((action) => [action.id, action])));
          setWorkflowSummaries(new Map(msg.workflowSummaries.map((workflow) => [workflow.id, workflow])));
          setWorkflowRuns(new Map(msg.workflowRunSummaries.map((run) => [run.id, run])));
          setEnsembles(new Map(msg.ensembleSummaries.map((ensemble) => [ensemble.id, ensemble])));
          // Replaced wholesale from the snapshot, like every other collection here: a
          // reconnect after a gap must drop schedules archived while we were away, not merge
          // them back in.
          setSchedules(new Map(msg.schedules.map((schedule) => [schedule.id, schedule])));
          // Carried in the snapshot rather than waited for: the strip would otherwise sit
          // blank until the next export happened to change a figure.
          setFleetCost(msg.fleetCost);
          // And the strip, for the same reason it is in the snapshot at all: it is permanent
          // chrome, so waiting for the next change would open the fleet on six blank stages.
          setLineSummary(msg.lineSummary);
          // Same reasoning for the settings dots: seed them from the snapshot so they are
          // right on the first render instead of blank until the next config write.
          setSettingsStatus(msg.settingsStatus);
          setConnected(true);
          setHasSnapshot(true);
          break;
        case "session_upsert":
          setSessions((prev) => new Map(prev).set(msg.session.id, msg.session));
          break;
        case "session_remove":
          // The one signal that positively means a session is gone, rather than not
          // yet re-added: the daemon evicted it after a completed sweep. That makes
          // this the only safe place to collect its half-written compose text, and its
          // accumulated conversation history, which is bound to the session the same way
          // and would otherwise be re-hydrated into a reused id.
          dropSessionDrafts(msg.id);
          dropHistory(msg.id);
          setSessions((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "review_upsert":
          setReviews((prev) => new Map(prev).set(msg.review.id, msg.review));
          break;
        case "review_remove":
          setReviews((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "task_upsert":
          setTasks((prev) => new Map(prev).set(msg.task.id, msg.task));
          break;
        case "task_remove":
          setTasks((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "persona_upsert":
          setPersonas((prev) => new Map(prev).set(msg.persona.id, msg.persona));
          break;
        case "persona_remove":
          setPersonas((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        // Archive arrives here, not at `session_action_remove`: the row stays addressable
        // because drafts and published versions name its id.
        case "session_action_upsert":
          setSessionActions((prev) => new Map(prev).set(msg.action.id, msg.action));
          break;
        case "session_action_remove":
          setSessionActions((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "workflow_upsert":
          setWorkflowSummaries((prev) => new Map(prev).set(msg.workflow.id, msg.workflow));
          break;
        case "workflow_remove":
          setWorkflowSummaries((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "workflow_run_upsert":
          setWorkflowRuns((prev) => new Map(prev).set(msg.run.id, msg.run));
          break;
        case "workflow_run_remove":
          dropRunActions(msg.id);
          setWorkflowRuns((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "ensemble_upsert":
          setEnsembles((prev) => new Map(prev).set(msg.ensemble.id, msg.ensemble));
          break;
        case "ensemble_remove":
          setEnsembles((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "schedule_upsert":
          setSchedules((prev) => new Map(prev).set(msg.schedule.id, msg.schedule));
          break;
        case "schedule_remove":
          setSchedules((prev) => {
            const next = new Map(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "cost_fleet":
          setFleetCost(msg.fleet);
          break;
        // Replaced whole, never merged per stage: the strip is read as one sentence about
        // the fleet, and a per-stage patch would draw a pipeline that never existed.
        case "line_summary":
          setLineSummary(msg.line);
          break;
        case "settings_status":
          setSettingsStatus(msg.status);
          break;
        default: {
          // Exhaustiveness: this assignment fails to compile the moment `ServerEvent`
          // grows a variant this switch doesn't handle. Without it the new variant
          // would be dropped on the floor here in total silence - the daemon emits,
          // nothing throws, no test fails, and the UI just never reflects it.
          const unhandled: never = msg;
          // Reachable at RUNTIME even while unreachable to the type system: the
          // daemon is a separate process, so a newer one can emit a variant this
          // build has never heard of. Ignoring it is right (there is nothing
          // sensible to do with it), but it should not be invisible.
          const type = (unhandled as { type?: unknown }).type;
          const key = typeof type === "string" ? type : String(type);
          if (!warnedUnknownEventTypes.has(key)) {
            warnedUnknownEventTypes.add(key);
            console.warn("Ignoring unknown server event", unhandled);
          }
        }
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return {
    sessions: [...sessions.values()],
    reviews: [...reviews.values()],
    tasks: [...tasks.values()],
    personas: [...personas.values()],
    sessionActions: [...sessionActions.values()],
    workflowSummaries: [...workflowSummaries.values()],
    workflowRunSummaries: [...workflowRuns.values()],
    ensembleSummaries: [...ensembles.values()],
    schedules: [...schedules.values()],
    fleetCost,
    lineSummary,
    settingsStatus,
    connected,
    hasSnapshot,
  };
}
