import { BASE_URL } from "@shared/harness-runtime.mjs";
import { ForemanConfigSchema } from "@shared/protocol.ts";
import type {
  BacklogPlanInput,
  ForemanConfig,
  ForemanLeaseResult,
  RecordEpisode,
  SetNote,
  SetWorkItemState,
} from "@shared/protocol.ts";
import type {
  BacklogPlan,
  ReviewItem,
  Session,
  SessionDiff,
  SessionGoal,
  SessionNote,
  SessionQueue,
  Task,
  ToolCall,
  TranscriptMessage,
  WorkItem,
} from "@shared/types.ts";
import type { StandardsBundle } from "../standards.ts";
import { InjectError } from "./queue-apply.ts";
import type { GateRef } from "./pending.ts";
import type { ForemanActions } from "./verdict.ts";

// The worker's client for the daemon's localhost API. All `/api/*` routes are
// loopback-gated (not token-gated), and the worker runs on the same host, so a
// bare fetch to 127.0.0.1 satisfies the Host check with no token. Reads throw on
// a non-2xx so the loop can log and continue; the config read is the liveness probe.

/**
 * The outcome of asking the daemon to start a task, WITH the HTTP status.
 *
 * The status is carried because "it failed" is not one fact here. The routes answer a
 * documented refusal (404, 409) when nothing was typed and the task is untouched, and a
 * 500 when something threw - and `TaskManager.assign` types the prompt BEFORE it claims
 * the row, so a 500 can mean the text landed in the pane and the write behind it did
 * not. A caller deciding whether it is safe to try again has to be able to tell those
 * apart. See `taskRefused` in worker.ts.
 */
export interface TaskActionResult {
  ok: boolean;
  status: number;
  error?: string;
}

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

/**
 * Coerce one turn's `tools` back to `ToolCall[]` across a daemon/worker version skew.
 *
 * `tools` used to be `string[]` and is now `ToolCall[]`. The worker is started separately from
 * the daemon, so an old daemon still serving `["Bash"]` to a new worker is an ordinary
 * upgrade-window state - and this is the one cast where that stops being free. Those strings
 * reach `riskContextFrom` as `t.input ? … : t.name`, where BOTH are undefined, so every call
 * flattens to the literal "undefined": the tool names and the commands vanish from the denylist
 * blob while prose still scans, so `hasProse` holds, backstop 3(a) does not fire, and a
 * `Bash(rm -rf …)` reads as clean - the exact hole carrying inputs was filed to close, failing
 * silently and OPEN. `formatTranscript` degrades the same way, rendering "(tools: undefined)".
 *
 * So this follows `recentTurns`' precedent rather than the blanket cast rule: a field arriving
 * over the wire must never let its own absence become the permissive answer. A string becomes
 * `{ name }`, which restores exactly the pre-input behaviour (names scan, inputs are absent
 * because that daemon never had them) and invents nothing. Anything unrecognisable is dropped
 * instead of being carried as a half-formed call.
 */
function normalizeTools(tools: unknown): ToolCall[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((t): ToolCall[] => {
    if (typeof t === "string") return [{ name: t }];
    if (!t || typeof t !== "object") return [];
    const { name, input } = t as Record<string, unknown>;
    if (typeof name !== "string") return [];
    return [{ name, input: typeof input === "string" ? input : undefined }];
  });
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
   * we couldn't ask is exactly how two workers end up draining the queue.
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

  // ---- the backlog autopilot ----

  /** Every task, not just the backlog: dependencies point at tasks that already left it. */
  tasks(): Promise<Task[]> {
    return get<Task[]>("/api/tasks");
  }

  /** Foreman's stored reading of the backlog, or null when it has never made one. */
  backlogPlan(): Promise<BacklogPlan | null> {
    return get<BacklogPlan | null>("/api/backlog/plan");
  }

  /**
   * Store a fresh plan, replacing whatever was there.
   *
   * Throws on failure, and the caller must NOT count that as progress: the write is
   * what makes the plan cover the backlog, so a tick that failed it leaves the machine
   * deciding `plan` again next pass. Reporting it as advanced is what would turn a
   * broken route into a Sonnet call every BETWEEN_MS.
   */
  async putBacklogPlan(plan: BacklogPlanInput): Promise<void> {
    const res = await send("PUT", "/api/backlog/plan", plan);
    if (!res.ok) throw new Error(`putBacklogPlan -> ${res.status}`);
  }

  /**
   * Launch a fresh agent in its own worktree for a backlog task.
   *
   * The daemon flips the task out of `backlog` before this resolves, so the next tick's
   * read cannot see it as schedulable again - which is the only thing standing between
   * a laggy read and two agents on one task. The worker keeps a short-lived guard of its
   * own as well; see `recentlyActed`.
   */
  async dispatchTask(id: string): Promise<TaskActionResult> {
    const res = await send("POST", `/api/tasks/${enc(id)}/dispatch`);
    if (res.ok) return { ok: true, status: res.status };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: body.error ?? `dispatch -> ${res.status}` };
  }

  /**
   * Hand a backlog task to an agent that is already running.
   *
   * A refusal is a 409 carrying a reason, and it is an ordinary outcome rather than an
   * error: the session can go busy between the decision and this call, and the daemon
   * re-checks. Nothing was typed in that case, so the task stays in the backlog and the
   * next tick decides again from a fresh snapshot.
   */
  async assignTask(id: string, sessionId: string): Promise<TaskActionResult> {
    const res = await send("POST", `/api/tasks/${enc(id)}/assign`, { sessionId });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && body.ok !== false) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: body.error ?? `assign -> ${res.status}` };
  }

  /**
   * The transcript window, with each turn's `tools` normalized - see `normalizeTools`. The rest
   * of the response is cast like every other read: `headCount` already refuses to let its own
   * absence mean anything permissive (see `recentTurns`), and the remaining fields cost a bad
   * log line at worst.
   */
  async transcript(id: string, turns = 48): Promise<TranscriptWindowResponse> {
    const w = await get<TranscriptWindowResponse>(`/api/sessions/${enc(id)}/transcript?turns=${turns}`);
    return { ...w, messages: (w.messages ?? []).map((m) => ({ ...m, tools: normalizeTools(m.tools) })) };
  }

  /** The transcript's current byte size - a work item's delivery anchor. */
  async transcriptSize(id: string): Promise<number | null> {
    const r = await get<{ size: number | null }>(`/api/sessions/${enc(id)}/transcript/size`);
    return r.size;
  }

  /**
   * The child's rendered screen, or null when there is none to read - no pane, a failed
   * capture, or a daemon too old to serve the route (the worker is started separately, so a
   * version skew between them is an ordinary upgrade-window state).
   *
   * Null-on-failure rather than a throw, because every caller's fallback is the same and is
   * safe: without the screen the reviewer reads the transcript alone and skips honestly,
   * which is exactly the behaviour this replaced. Failing the whole review over an
   * unreadable pane would turn a lost improvement into a lost review.
   */
  async pane(id: string): Promise<string | null> {
    try {
      const r = await get<{ text: string | null }>(`/api/sessions/${enc(id)}/pane`);
      return typeof r.text === "string" ? r.text : null;
    } catch {
      return null;
    }
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
      // `origin` is what lets the conversation log say who typed this. Every inject from
      // this client is Foreman's: the human's own replies go through the dashboard.
      res = await send("POST", `/api/sessions/${enc(id)}/inject`, { text, origin: "foreman" });
    } catch (err) {
      throw new InjectError(`inject ${id} -> ${String(err)}`, true);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        pasted?: boolean;
        paneBlocked?: boolean;
      };
      // `paneBlocked` reads the opposite way round from `pasted`: a MISSING field means
      // false, because only the daemon can know a human is in copy-mode and silence is
      // not that claim. Reading it as true would let any malformed error response buy an
      // item unlimited retries.
      throw new InjectError(
        `inject ${id} -> ${res.status}${body.error ? `: ${body.error}` : ""}`,
        body.pasted !== false,
        body.paneBlocked === true,
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

  /**
   * Stamp the wrap-up ask, so the Ship it? card renders.
   *
   * `clearAnswer` is the PROMPTED trigger's flag and must stay opt-in: that trigger can
   * raise a second ask on a row whose `wrapupAnswer` belongs to a previous episode, and
   * the card hides on a non-null answer - so without clearing it the new question is
   * stamped and then invisibly swallowed. The DRAIN path must never pass it: there the
   * answer it would clobber is the answer to the ask being raised.
   */
  async markWrapupAsked(sessionId: string, opts?: { clearAnswer?: boolean }): Promise<void> {
    const res = await send(
      "POST",
      `/api/sessions/${enc(sessionId)}/queue/wrapup/asked`,
      opts?.clearAnswer ? { clearAnswer: true } : undefined,
    );
    if (!res.ok) throw new Error(`markWrapupAsked ${sessionId} -> ${res.status}`);
  }

  /**
   * Record the wrap-up answer. This is the same endpoint the card uses when a human
   * clicks Send: an auto-wrapup is that same event with Foreman as the author, so it
   * must land in the same durable field. Anything else and the card would re-offer an
   * instruction the agent already has.
   */
  async setWrapupAnswer(sessionId: string, answer: string): Promise<void> {
    const res = await send("PUT", `/api/sessions/${enc(sessionId)}/queue/wrapup`, { answer });
    if (!res.ok) throw new Error(`setWrapupAnswer ${sessionId} -> ${res.status}`);
  }

  /**
   * Retire one episode of the `prompted` trigger. Throws on failure, and the caller
   * must treat that as fatal to the episode: this write is what stops the trigger
   * re-firing, so proceeding to type after it failed is the double-push.
   */
  async markPromptedWrapup(sessionId: string, goal: string): Promise<void> {
    const res = await send("POST", `/api/sessions/${enc(sessionId)}/queue/wrapup/prompted`, {
      goal,
    });
    if (!res.ok) throw new Error(`markPromptedWrapup ${sessionId} -> ${res.status}`);
  }

  /** The full goal record - the verbatim prompt, which the card summary never carries. */
  async goal(sessionId: string): Promise<SessionGoal | null> {
    const res = await send("GET", `/api/sessions/${enc(sessionId)}/goal`);
    if (!res.ok) return null;
    return (await res.json()) as SessionGoal;
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

  /**
   * Select a row of the menu a child is showing. Throws on a refusal, which is the point:
   * the daemon refuses whenever it can't confirm the row against the live screen, and
   * `applyVerdict` turns that throw into "not answered" rather than a false byline.
   */
  async selectOption(id: string, option: { number: number; label: string }): Promise<unknown> {
    const res = await send("POST", `/api/sessions/${enc(id)}/select-option`, option);
    if (!res.ok) throw new Error(`selectOption ${id} -> ${res.status}`);
    return res.json();
  }

  async resolveReview(reviewId: string, action: "answer", response: string): Promise<unknown> {
    const res = await send("POST", `/api/reviews/${enc(reviewId)}/resolve`, { action, response });
    if (!res.ok) throw new Error(`resolveReview ${reviewId} -> ${res.status}`);
    return res.json();
  }

  /**
   * Record the episode behind a note: what the child was asked, and what we did.
   *
   * Never throws. It runs after the answer has been delivered and the note stamped,
   * so by then the work has SUCCEEDED - letting a failed audit write surface as an
   * error would have the worker log a failure for a session it handled correctly,
   * and (worse) leave the loop looking like it should retry an act it must not
   * repeat. The daemon side fails soft for the same reason; this closes the other
   * half, where the request never arrives at all.
   */
  async recordEpisode(id: string, episode: RecordEpisode): Promise<void> {
    try {
      const res = await send("POST", `/api/sessions/${enc(id)}/foreman-episode`, episode);
      if (!res.ok) console.error(`[foreman] episode not recorded: ${id} -> ${res.status}`);
    } catch (err) {
      console.error("[foreman] could not record the episode:", err);
    }
  }

  async logGateReply(id: string, gate: GateRef, text: string): Promise<unknown> {
    const res = await send("POST", `/api/sessions/${enc(id)}/gate-reply`, {
      runId: gate.runId,
      step: gate.step,
      findingIds: gate.findingIds,
      text,
    });
    if (!res.ok) throw new Error(`logGateReply ${id} -> ${res.status}`);
    return res.json();
  }
}
