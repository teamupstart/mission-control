import { useEffect, useRef, useState } from "react";
import type {
  FleetCost,
  KeepAwakeStatus,
  ReviewItem,
  ServerEvent,
  Session,
  SettingsStatus,
  Task,
} from "@shared/types.ts";
import type { LineSummary } from "@shared/line.ts";
import type {
  PersonaView,
  SessionAction,
  WorkflowBindingSummary,
  WorkflowCommandView,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import { dropSessionView } from "./lib/conversation-view.ts";
import { dropSessionDrafts } from "./lib/drafts.ts";
import { dropInterrupting, reconcileInterrupting } from "./lib/interrupting.ts";
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
  /**
   * The Global Command catalog: what each portable workflow slot runs on this machine.
   *
   * Always exactly four entries, in slot order, configured or not - the daemon projects the
   * built-in slots rather than only the written ones, so a surface never has to decide
   * whether a missing entry means "unconfigured" or "not loaded yet". Snapshot and one
   * upsert event are the ONLY refresh mechanism; nothing here polls the command routes.
   */
  workflowCommands: WorkflowCommandView[];
  workflowSummaries: WorkflowSummary[];
  workflowRunSummaries: WorkflowRunSummary[];
  /** What each conversation is ARMED with, which precedes and outlives its runs. */
  workflowBindingSummaries: WorkflowBindingSummary[];
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
  /**
   * The daemon's Keep Awake observation, or null while it is UNKNOWN - before the first
   * snapshot, and again whenever the stream drops. Null is never "off": while the channel
   * is down the OS child may exit or the daemon may restart and we would not hear it, so
   * the control must disable rather than keep asserting the pre-drop state. The reconnect
   * snapshot restores the truth - which, after a daemon restart, is `off` by design. The
   * ONE client-side source of this fact: no surface polls the keep-awake route for state.
   */
  keepAwakeStatus: KeepAwakeStatus | null;
  /**
   * How many times the per-harness dispatch defaults have changed since this stream opened,
   * plus one per (re)connect. A COUNTER, not the config: `harnesses_config_changed` carries
   * no body, so surfaces that name those defaults - the Harnesses panel and the dispatch
   * modal's "Default - …" labels - watch this number and re-read the route when it moves.
   *
   * Bumped on connect as well as on the event so a change that happened while the stream was
   * down is picked up at once: this config rides no snapshot, so a reconnect is otherwise
   * indistinguishable from nothing having happened.
   */
  harnessesRevision: number;
  /**
   * How many times the local archive library has changed since this stream opened, plus one
   * per (re)connect. A COUNTER, for `harnessesRevision`'s reason and one more: archive
   * history is deliberately absent from the snapshot, so there is nothing for a reconnect to
   * restore and the only honest response to regaining the stream is to re-run whatever
   * bounded query is on screen.
   *
   * Unused until the Archives page exists. It is here now because `ServerEvent` is exhaustive
   * across the daemon and this hook, and a wire contract that only half-lands is a version
   * skew waiting to happen; carrying the number costs nothing and starts no polling.
   */
  archivesRevision: number;
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
  const [workflowCommands, setWorkflowCommands] = useState<Map<string, WorkflowCommandView>>(
    new Map(),
  );
  const [workflowSummaries, setWorkflowSummaries] = useState<Map<string, WorkflowSummary>>(new Map());
  const [workflowRuns, setWorkflowRuns] = useState<Map<string, WorkflowRunSummary>>(new Map());
  const [workflowBindings, setWorkflowBindings] = useState<Map<string, WorkflowBindingSummary>>(new Map());
  const [ensembles, setEnsembles] = useState<Map<string, EnsembleSummary>>(new Map());
  const [schedules, setSchedules] = useState<Map<string, MissionSchedule>>(new Map());
  const [fleetCost, setFleetCost] = useState<FleetCost | null>(null);
  const [lineSummary, setLineSummary] = useState<LineSummary | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null);
  const [keepAwakeStatus, setKeepAwakeStatus] = useState<KeepAwakeStatus | null>(null);
  const [harnessesRevision, setHarnessesRevision] = useState(0);
  const [archivesRevision, setArchivesRevision] = useState(0);
  const [connected, setConnected] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/events");
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      // A change announced while the channel was down reached nobody, and this config is not
      // part of the reconnect snapshot - so treat regaining the stream as a reason to re-read.
      setHarnessesRevision((n) => n + 1);
      // Same rule for the archive library, which rides no snapshot at all: bundles can be
      // reconciled, refused, or pruned while the channel is down, and a mounted Archives page
      // would otherwise go on showing the page it had before the gap.
      setArchivesRevision((n) => n + 1);
    };
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
      // And the keep-awake status, under the same contract with a sharper edge: `on` is a
      // claim about a live OS power assertion, and the daemon restarting - the one event
      // most likely to have severed this stream - is exactly what resets that assertion
      // to off. Unknown disables the toggle; the reconnect snapshot restores the truth.
      setKeepAwakeStatus(null);
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
          // Replaced wholesale, like every other collection here. A daemon that migrated or
          // cleared a slot while this tab was disconnected is the authority on reconnect.
          setWorkflowCommands(new Map((msg.workflowCommands ?? []).map((c) => [c.slot, c])));
          setWorkflowSummaries(new Map(msg.workflowSummaries.map((workflow) => [workflow.id, workflow])));
          setWorkflowRuns(new Map(msg.workflowRunSummaries.map((run) => [run.id, run])));
          setWorkflowBindings(new Map(msg.workflowBindingSummaries.map((b) => [b.id, b])));
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
          // Seeded from the snapshot so the live indicator is truthful from the first
          // frame. The `?? null` is a runtime guard the type system cannot see: during
          // development this build can connect to an older daemon whose snapshot has no
          // such field, and `undefined` must read as unknown - never as on.
          setKeepAwakeStatus(msg.keepAwake ?? null);
          setConnected(true);
          setHasSnapshot(true);
          break;
        case "session_upsert":
          // A real reading retires the optimistic "interrupting" badge the moment it says
          // the agent has stopped, so the transient presentation hands over to the durable
          // one rather than waiting out its own timeout on top of the truth.
          reconcileInterrupting(msg.session);
          setSessions((prev) => new Map(prev).set(msg.session.id, msg.session));
          break;
        case "session_remove":
          // The one signal that positively means a session is gone, rather than not
          // yet re-added: the daemon evicted it after a completed sweep. That makes
          // this the only safe place to collect its half-written compose text, its
          // accumulated conversation history, and the rendering it was being read in -
          // all three are bound to the session the same way and would otherwise be
          // re-hydrated into a reused id.
          dropSessionDrafts(msg.id);
          dropHistory(msg.id);
          dropSessionView(msg.id);
          dropInterrupting(msg.id);
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
        // No remove twin, deliberately: a built-in slot is emptied, never deleted, and an
        // emptied slot is still a card that has to say "Not configured".
        case "workflow_command_upsert":
          setWorkflowCommands((prev) => new Map(prev).set(msg.command.slot, msg.command));
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
        case "workflow_binding_upsert":
          setWorkflowBindings((prev) => new Map(prev).set(msg.binding.id, msg.binding));
          break;
        case "workflow_binding_remove":
          setWorkflowBindings((prev) => {
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
        // Replaced whole: the status is one observation of one OS child, and every open
        // window must converge on the same one - this event is how a second dashboard
        // sees a toggle it did not click.
        case "keep_awake_status":
          setKeepAwakeStatus(msg.status);
          break;
        // Counted, not stored: the event carries no config (see its declaration), so the
        // number is the whole signal - it tells the harness pickers to re-read the route.
        case "harnesses_config_changed":
          setHarnessesRevision((n) => n + 1);
          break;
        // Counted for the same reason, and one batch of reconciled bundles is one bump: the
        // page's response is to re-run its own bounded, filtered query, and forty frames
        // would not tell it anything one does not.
        case "archive_changed":
          setArchivesRevision((n) => n + 1);
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
    workflowCommands: [...workflowCommands.values()],
    workflowSummaries: [...workflowSummaries.values()],
    workflowRunSummaries: [...workflowRuns.values()],
    workflowBindingSummaries: [...workflowBindings.values()],
    ensembleSummaries: [...ensembles.values()],
    schedules: [...schedules.values()],
    fleetCost,
    lineSummary,
    settingsStatus,
    keepAwakeStatus,
    harnessesRevision,
    archivesRevision,
    connected,
    hasSnapshot,
  };
}
