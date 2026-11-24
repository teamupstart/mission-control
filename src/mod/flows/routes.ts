import type { ZodType } from "zod";
import {
  HomeDispatchConfirmResultSchema,
  HomeDispatchDraftSummarySchema,
  HomeDispatchOptionsResponseSchema,
  type HomeDispatchConfirmResult,
  type HomeDispatchDraftCreate,
  type HomeDispatchDraftSummary,
  type HomeDispatchOptionsRequest,
  type HomeDispatchOptionsResponse,
} from "@shared/home-dispatch.ts";
import { isFlagOffAnswer } from "../client.ts";
import type { ModHost } from "../host.ts";

/**
 * The daemon calls the dispatch flows make (spec 7.5, 7.6): dialog pages, drafts, confirm. The
 * flows never throw on a daemon answer. A refusal keeps the daemon's own sentence so the mod
 * can show it as written (7.11), and a daemon that is not running is its own outcome.
 */

export interface FlowSession {
  sessionId: string;
  cwd: string;
  /**
   * Whether the Claude session that started this flow is still the current one. A flow whose
   * session has ended (a dialog left open across `session.end`) makes no further daemon call
   * that would file or change a task; cancelling a draft is still sent. Absent means always live.
   */
  live?: () => boolean;
  /**
   * The drafts a blank command has already reminded the person about in this session. It lives and
   * dies with the session, so an abandoned draft's entry is dropped with it. Absent means a fresh
   * set for each call (every blank is a first one).
   */
  reminded?: Set<string>;
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "down" | "off" | "unauthorized" | "ended" }
  | { ok: false; kind: "refused"; status: number; error: string; body: Record<string, unknown> };

type Fetcher = Pick<ModHost, "fetch">;

async function send<T>(
  host: Fetcher,
  session: FlowSession,
  path: string,
  body: unknown,
  schema: ZodType<T>,
  unreadable: string,
  allowWhenEnded = false,
  keepReply = false,
): Promise<Outcome<T>> {
  if (!allowWhenEnded && session.live && !session.live()) return { ok: false, kind: "ended" };
  let reply;
  try {
    reply = await host.fetch(path, { method: "POST", body, ...(allowWhenEnded || !session.live ? {} : { guard: session.live }) });
  } catch {
    // A request the host held back because the session ended is not a daemon that is down.
    if (!allowWhenEnded && session.live && !session.live()) return { ok: false, kind: "ended" };
    return { ok: false, kind: "down" };
  }
  // The session may have ended while the daemon answered. Whatever the flow would do next (fill
  // the prompt, show a summary, open a dialog) belongs to a session that is gone, so it stops here.
  // A reply to a request that already took effect (a confirm that filed or started a task) is the
  // truth whether or not the session is still there; only replies that lead to more UI are dropped.
  if (!allowWhenEnded && !keepReply && session.live && !session.live()) return { ok: false, kind: "ended" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    parsed = null;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (isFlagOffAnswer(reply.status, parsed)) return { ok: false, kind: "off" };
  if (reply.status === 401) return { ok: false, kind: "unauthorized" };
  if (reply.status === 200) {
    const checked = schema.safeParse(parsed);
    if (checked.success) return { ok: true, value: checked.data };
    return { ok: false, kind: "refused", status: 200, error: unreadable, body: record };
  }
  const error = typeof record.error === "string" && record.error !== "" ? record.error : `Mission Control answered ${reply.status}.`;
  return { ok: false, kind: "refused", status: reply.status, error, body: record };
}

export function fetchOptions(
  host: Fetcher,
  session: FlowSession,
  query: Pick<HomeDispatchOptionsRequest, "entry" | "kind" | "brief">,
): Promise<Outcome<HomeDispatchOptionsResponse>> {
  const body: HomeDispatchOptionsRequest = { sessionId: session.sessionId, cwd: session.cwd, entry: query.entry };
  if (query.kind !== undefined) body.kind = query.kind;
  if (query.brief !== undefined) body.brief = query.brief;
  return send(host, session, "/dispatch/dispatch-options", body, HomeDispatchOptionsResponseSchema, "Mission Control sent dialog pages this build cannot read.");
}

export function createDraft(
  host: Fetcher,
  session: FlowSession,
  fields: Omit<HomeDispatchDraftCreate, "sessionId" | "cwd">,
): Promise<Outcome<HomeDispatchDraftSummary>> {
  return send(host, session, "/dispatch/drafts", { sessionId: session.sessionId, cwd: session.cwd, ...fields }, HomeDispatchDraftSummarySchema, "Mission Control sent a draft this build cannot read.");
}

export interface DraftChange {
  kind?: HomeDispatchDraftCreate["kind"];
  workflowId?: string;
  repo?: string;
  words?: string;
  context?: string;
}

export function updateDraft(
  host: Fetcher,
  session: FlowSession,
  draftId: string,
  change: DraftChange,
): Promise<Outcome<HomeDispatchDraftSummary>> {
  return send(host, session, `/dispatch/drafts/${encodeURIComponent(draftId)}`, { sessionId: session.sessionId, cwd: session.cwd, ...change }, HomeDispatchDraftSummarySchema, "Mission Control sent a draft this build cannot read.");
}

export function confirmDraft(
  host: Fetcher,
  session: FlowSession,
  draftId: string,
  choice: "start" | "backlog" | "cancel",
): Promise<Outcome<HomeDispatchConfirmResult>> {
  return send(host, session, `/dispatch/drafts/${encodeURIComponent(draftId)}/confirm`, { sessionId: session.sessionId, cwd: session.cwd, choice }, HomeDispatchConfirmResultSchema, "Mission Control sent a result this build cannot read.", choice === "cancel", true);
}
