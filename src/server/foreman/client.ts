import { BASE_URL } from "@shared/harness-runtime.mjs";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type { ForemanConfig, SetNote } from "@shared/protocol.ts";
import type { ReviewItem, Session, SessionNote, TranscriptMessage } from "@shared/types.ts";
import type { ForemanActions } from "./verdict.ts";

// The worker's client for the daemon's localhost API. All `/api/*` routes are
// loopback-gated (not token-gated), and the worker runs on the same host, so a
// bare fetch to 127.0.0.1 satisfies the Host check with no token. Reads throw on
// a non-2xx so the loop can log and continue; the config read is the liveness probe.

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE_URL + path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(BASE_URL + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

const enc = encodeURIComponent;

export interface TranscriptWindowResponse {
  messages: TranscriptMessage[];
  truncated: boolean;
  /** Boundary of the elided middle - see `TranscriptWindow`. Absent when there is no window. */
  headCount?: number;
  unavailable?: boolean;
}

/** Read + write helpers over the daemon API; satisfies `ForemanActions`. */
export class ForemanClient implements ForemanActions {
  /**
   * The config, parsed rather than cast. Every other read here casts the response and can
   * afford to: a malformed session list costs a bad log line. This one drives whether Foreman
   * acts and how - so it is validated at the edge, which applies the schema's own defaults to
   * a key an older daemon doesn't serve yet (`triage` -> `shadow`; the worker is started
   * separately from the daemon, so a version skew between them is an ordinary upgrade-window
   * state) and rejects a value outside the enum instead of letting it reach the tier dispatch.
   * A parse failure throws like any other bad read: the caller already logs it and retries,
   * which idles Foreman rather than running it under a config nobody can vouch for.
   */
  async getConfig(): Promise<ForemanConfig> {
    return ForemanConfigSchema.parse(await get<unknown>("/api/foreman/config"));
  }

  async heartbeat(): Promise<void> {
    await send("POST", "/api/foreman/heartbeat").catch(() => {});
  }

  sessions(): Promise<Session[]> {
    return get<Session[]>("/api/sessions");
  }

  reviews(): Promise<ReviewItem[]> {
    return get<ReviewItem[]>("/api/reviews");
  }

  transcript(id: string, turns = 48): Promise<TranscriptWindowResponse> {
    return get<TranscriptWindowResponse>(`/api/sessions/${enc(id)}/transcript?turns=${turns}`);
  }

  note(id: string): Promise<SessionNote | null> {
    return get<SessionNote | null>(`/api/sessions/${enc(id)}/note`);
  }

  async putNote(id: string, patch: SetNote): Promise<unknown> {
    const res = await send("PUT", `/api/sessions/${enc(id)}/note`, patch);
    if (!res.ok) throw new Error(`putNote ${id} -> ${res.status}`);
    return res.json();
  }

  async sendText(id: string, text: string, submit: boolean): Promise<unknown> {
    const res = await send("POST", `/api/sessions/${enc(id)}/send`, { text, submit });
    if (!res.ok) throw new Error(`sendText ${id} -> ${res.status}`);
    return res.json();
  }

  async resolveReview(reviewId: string, action: "answer", response: string): Promise<unknown> {
    const res = await send("POST", `/api/reviews/${enc(reviewId)}/resolve`, { action, response });
    if (!res.ok) throw new Error(`resolveReview ${reviewId} -> ${res.status}`);
    return res.json();
  }
}
