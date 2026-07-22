import { useEffect, useRef, useState } from "react";
import type { FleetCost, ReviewItem, ServerEvent, Session, Task } from "@shared/types.ts";
import type { PersonaView } from "@shared/workflow.ts";
import { dropSessionDrafts } from "./lib/drafts.ts";

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
  /**
   * Fleet spend and the subscription's rate limits, for the topbar strip. A single
   * value rather than a per-session field because that is the shape of the fact: the
   * rate-limit windows belong to the ACCOUNT, so one copy is the only way for the
   * dashboard to have exactly one answer. Null until the daemon has anything to say -
   * which is the ordinary state for anyone who hasn't switched telemetry on.
   */
  fleetCost: FleetCost | null;
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
  const [fleetCost, setFleetCost] = useState<FleetCost | null>(null);
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
          // Carried in the snapshot rather than waited for: the strip would otherwise sit
          // blank until the next export happened to change a figure.
          setFleetCost(msg.fleetCost);
          setConnected(true);
          setHasSnapshot(true);
          break;
        case "session_upsert":
          setSessions((prev) => new Map(prev).set(msg.session.id, msg.session));
          break;
        case "session_remove":
          // The one signal that positively means a session is gone, rather than not
          // yet re-added: the daemon evicted it after a completed sweep. That makes
          // this the only safe place to collect its half-written compose text.
          dropSessionDrafts(msg.id);
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
        case "cost_fleet":
          setFleetCost(msg.fleet);
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
    fleetCost,
    connected,
    hasSnapshot,
  };
}
