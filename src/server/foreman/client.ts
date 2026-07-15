import { BASE_URL } from "@shared/harness-runtime.mjs";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type {
  ForemanConfig,
  ForemanLeaseResult,
  SetNote,
  SetWorkItemState,
} from "@shared/protocol.ts";
import type {
  ReviewItem,
  Session,
  SessionDiff,
  SessionNote,
  SessionQueue,
  TranscriptMessage,
  WorkItem,
} from "@shared/types.ts";
import type { StandardsBundle } from "../standards.ts";
import { InjectError } from "./queue-apply.ts";
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
  /**
   * True when a `since` offset is past EOF: the transcript was reset (a `/clear`),
   * so the anchor is meaningless. Callers must escalate rather than judge an item
   * against a near-empty window and invent gaps.
   */
  reset?: boolean;
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

  /**
   * Acquire/renew the worker lease. Returns null when the daemon is unreachable,
   * which the caller MUST treat as "not the leader" - assuming leadership because
   * we couldn't ask is exactly how two workers end up draining the fleet.
   */
  async heartbeat(workerId: string): Promise<ForemanLeaseResult | null> {
    try {
      const res = await send("POST", "/api/foreman/heartbeat", { workerId });
      if (!res.ok) return null;
      return (await res.json()) as ForemanLeaseResult;
    } catch {
      return null;
    }
  }

  /** Hand the lease back on a clean shutdown, so a standby takes over at once. */
  async releaseLease(workerId: string): Promise<void> {
    await send("POST", "/api/foreman/heartbeat/release", { workerId }).catch(() => {});
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

  /** The transcript's current byte size - a work item's delivery anchor. */
  async transcriptSize(id: string): Promise<number | null> {
    const r = await get<{ size: number | null }>(`/api/sessions/${enc(id)}/transcript/size`);
    return r.size;
  }

  /** The transcript from a byte offset forward - one work item's turns, exactly. */
  transcriptSince(id: string, offset: number): Promise<TranscriptWindowResponse> {
    return get<TranscriptWindowResponse>(`/api/sessions/${enc(id)}/transcript?since=${offset}`);
  }

  /** A session's diff, optionally scoped to the base recorded when an item was sent. */
  diff(id: string, base?: string | null): Promise<SessionDiff> {
    const q = base ? `?base=${enc(base)}` : "";
    return get<SessionDiff>(`/api/sessions/${enc(id)}/diff${q}`);
  }

  /**
   * The repo standards that apply to the files a diff touched.
   *
   * POSTed rather than GET-with-`path=`-params, because the path list is derived
   * from a patch capped at 1.2MB and is otherwise UNBOUNDED: a few hundred
   * URL-encoded source paths (every `/` becomes `%2F`) overflow Node's 16KB default
   * `maxHeaderSize`, the daemon rejects the request line, and the caller's `.catch`
   * turns that into an empty bundle reporting `truncated: false` - so the verifier
   * judges the item against the repo's contract having read none of it, and nothing
   * says so. A body has no such limit, so the request cannot outgrow its input.
   * This is a read; it's a POST only because the query doesn't fit in a URL.
   */
  async standards(id: string, paths: string[]): Promise<StandardsBundle> {
    const res = await send("POST", `/api/sessions/${enc(id)}/standards`, { paths });
    if (!res.ok) throw new Error(`standards ${id} -> ${res.status}`);
    return (await res.json()) as StandardsBundle;
  }

  // ---- work queues ----

  /**
   * The FULL queue for a session. Fetched per target per tick because
   * `Session.queue` carries only the compact card summary, while the machine needs
   * gaps, baseSha, transcriptAnchor, round, revision and strike counts. That's one
   * extra round-trip against a loopback API - noise next to a `claude -p`.
   */
  queue(id: string): Promise<SessionQueue | null> {
    return get<SessionQueue | null>(`/api/sessions/${enc(id)}/queue`);
  }

  /** Queues with no live session at all - the orphan sweep's input. */
  orphanedQueues(): Promise<SessionQueue[]> {
    return get<SessionQueue[]>("/api/queues?orphaned=1");
  }

  async setItemState(sessionId: string, itemId: string, patch: SetWorkItemState): Promise<WorkItem> {
    const res = await send("PUT", `/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/state`, patch);
    if (!res.ok) throw new Error(`setItemState ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /**
   * The same write addressed by QUEUE KEY - for a queue whose session is gone, which
   * is the only state the orphan sweep acts in. The session-scoped route insists the
   * session resolves, and here by definition it cannot.
   */
  async setItemStateByKey(
    noteKey: string,
    itemId: string,
    patch: SetWorkItemState,
  ): Promise<WorkItem> {
    const res = await send("PUT", `/api/queues/${enc(noteKey)}/items/${enc(itemId)}/state`, patch);
    if (!res.ok) throw new Error(`setItemStateByKey ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /**
   * Deliver a whole prompt as ONE bracketed-paste submission. Throws on failure,
   * which is what lets the caller stamp `awaiting_pickup` only after it resolves.
   *
   * The throw is an `InjectError` carrying whether text may have reached the pane,
   * because that decides whether the caller may retry or must escalate. It is only
   * ever safe when the daemon positively said `pasted: false`; a request that never
   * completed tells us nothing about what the daemon did with it.
   */
  async inject(id: string, text: string): Promise<void> {
    let res: Response;
    try {
      res = await send("POST", `/api/sessions/${enc(id)}/inject`, { text });
    } catch (err) {
      throw new InjectError(`inject ${id} -> ${String(err)}`, true);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; pasted?: boolean };
      throw new InjectError(
        `inject ${id} -> ${res.status}${body.error ? `: ${body.error}` : ""}`,
        body.pasted !== false,
      );
    }
  }

  /** Stamp delivery server-side (sentAt is the daemon's clock, not ours). */
  async markSent(
    sessionId: string,
    itemId: string,
    baseSha: string | null,
    transcriptAnchor: number | null,
  ): Promise<WorkItem> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/sent`, {
      baseSha,
      transcriptAnchor,
    });
    if (!res.ok) throw new Error(`markSent ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  /** Adopt an item a restart left mid-send. */
  async recoverItem(sessionId: string, itemId: string): Promise<WorkItem> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/${enc(itemId)}/recover`);
    if (!res.ok) throw new Error(`recoverItem ${itemId} -> ${res.status}`);
    return (await res.json()) as WorkItem;
  }

  async markWrapupAsked(sessionId: string): Promise<void> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/wrapup/asked`);
    if (!res.ok) throw new Error(`markWrapupAsked ${sessionId} -> ${res.status}`);
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
