import { useEffect, useRef, useState } from "react";
import type { ReviewItem, ServerEvent, Session } from "@shared/types.ts";

export interface FleetState {
  sessions: Session[];
  reviews: ReviewItem[];
  connected: boolean;
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
  const [connected, setConnected] = useState(false);
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
          setConnected(true);
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
    connected,
  };
}
