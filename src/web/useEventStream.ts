import { useEffect, useRef, useState } from "react";
import type { ReviewItem, ServerEvent, Session, Task } from "@shared/types.ts";

export interface FleetState {
  sessions: Session[];
  reviews: ReviewItem[];
  tasks: Task[];
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
export function useEventStream(): FleetState {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [reviews, setReviews] = useState<Map<string, ReviewItem>>(new Map());
  const [tasks, setTasks] = useState<Map<string, Task>>(new Map());
  const [connected, setConnected] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/events");
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

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
          setConnected(true);
          setHasSnapshot(true);
          break;
        case "session_upsert":
          setSessions((prev) => new Map(prev).set(msg.session.id, msg.session));
          break;
        case "session_remove":
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
    connected,
    hasSnapshot,
  };
}
