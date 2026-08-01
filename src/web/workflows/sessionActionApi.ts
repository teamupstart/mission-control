import { useEffect, useMemo, useState } from "react";
import { SessionActionCapabilitiesSchema } from "@shared/protocol.ts";
import type {
  SessionAction,
  SessionActionCompletionCapability,
  SessionActionCompletionKind,
} from "@shared/workflow.ts";

/**
 * The browser's half of the SessionAction catalog: one request helper, and one read of what
 * the DAEMON says it can prove.
 *
 * Split from `personaApi.ts` rather than generalised over both, because the two share only
 * `fetch` plus a JSON error envelope while differing in the thing that matters - a Persona
 * failure names a Persona and an action failure names an action, and one "entityRequest"
 * would have to be told which noun to put in its fallback sentence anyway.
 */

interface SessionActionErrorBody {
  error?: string;
  code?: string;
  /** The row as the server currently holds it, on a CAS conflict. */
  current?: SessionAction | null;
}

export type SessionActionRequestError = Error & {
  status: number;
  body: SessionActionErrorBody;
};

export async function sessionActionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & SessionActionErrorBody;
  if (!response.ok) {
    const error = new Error(
      body.error ?? `Session action request failed (${response.status})`,
    ) as SessionActionRequestError;
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/** The current row a 409 carried, or null when this failure did not name one. */
export function sessionActionConflict(
  caught: unknown,
  code: string,
): SessionAction | null {
  const known = caught as SessionActionRequestError | undefined;
  return known?.status === 409 && known.body?.code === code && known.body.current
    ? known.body.current
    : null;
}

/**
 * What this daemon can actually prove, per completion adapter.
 *
 * Fetched rather than imported. `SESSION_ACTION_COMPLETION_CAPABILITIES` is shared and the
 * browser CAN see it, but reading it here would make the dashboard's answer to "may I add
 * this?" a property of the bundle rather than of the daemon it is talking to - and those two
 * are the same build only until someone opens an older tab against a newer daemon, or the
 * reverse. The one that must win is the daemon's, because it is the process that will refuse
 * the publish.
 *
 * A failed read leaves the list EMPTY rather than falling back to the shared table. An empty
 * list makes every add control say "nothing is addable", which is a state an operator can see
 * and retry; a fallback would offer an adapter this daemon may not run and fail at Publish.
 */
export interface SessionActionCapabilityState {
  completions: SessionActionCompletionCapability[];
  /** Adapter kinds this daemon can execute, for the add-control filters. */
  available: Set<SessionActionCompletionKind>;
  loading: boolean;
  error: string | null;
}

export async function fetchSessionActionCapabilities(): Promise<
  SessionActionCompletionCapability[]
> {
  const raw = await sessionActionRequest<unknown>("/api/session-actions/capabilities");
  // Parsed rather than cast: this decides whether an authoring control appears, so a daemon
  // answering with a shape this build cannot read must read as "nothing available" instead
  // of as an array of `undefined`s that every `.filter` silently drops.
  return SessionActionCapabilitiesSchema.parse(raw).completions;
}

export function useSessionActionCapabilities(): SessionActionCapabilityState {
  const [completions, setCompletions] = useState<SessionActionCompletionCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSessionActionCapabilities()
      .then((next) => {
        if (!alive) return;
        setCompletions(next);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setCompletions([]);
        setError(caught instanceof Error
          ? caught.message
          : "Could not read what this build can prove");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // Memoised because callers hang `useMemo` off it. A fresh `Set` per render is a fresh
  // identity per render, which would re-run every catalog filter downstream on every
  // keystroke in the builder.
  const available = useMemo(
    () => new Set(
      completions.filter((capability) => capability.available).map((capability) => capability.kind),
    ),
    [completions],
  );

  return { completions, available, loading, error };
}
