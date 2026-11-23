import { DAEMON_PROTOCOL_CAPABILITIES, daemonHealthCompatibility } from "@shared/daemon-protocol.ts";
import {
  HomeDispatchInboxSchema,
  HomeSessionRegistrationAnswerSchema,
  type HomeDispatchInbox,
  type HomeSessionRegistration,
  type HomeSessionRegistrationAnswer,
} from "@shared/home-dispatch.ts";
import type { CoreHost, ModFetchInit } from "./host.ts";

/** The client needs only `fetch`, so flows (P11) can pass any host that has it. */
type Fetcher = Pick<CoreHost, "fetch">;

/**
 * The mod's whole daemon surface (spec 7.10): `/api/health` and `/dispatch/*`, nothing else.
 * `src/mod/allowed-calls.json` lists the same two and the `mod-calls` smoke check and a unit
 * test fail when a path outside it appears anywhere under `src/mod/`.
 *
 * Every function answers a value and never throws: a daemon that is not running is ordinary
 * (the person may simply not have started it), so it is `down`, not an error.
 */

export const HEALTH_PATH = "/api/health";
export const SESSIONS_PATH = "/dispatch/sessions";
export const INBOX_PATH = "/dispatch/inbox";

export type DaemonResult<T> =
  | { kind: "ok"; value: T }
  /** The headless-mode flag is off (or the daemon is too old to have the routes). Show nothing. */
  | { kind: "off" }
  /** Nothing answered, or what answered is not Mission Control. */
  | { kind: "down" }
  /** The token was refused; the person's token file changed or is unreadable. */
  | { kind: "unauthorized" }
  /** Any other reply, including one this build cannot read. */
  | { kind: "error"; status: number };

/** What `GET /api/health` says about the flag: the capability is listed only while it is on. */
export async function checkHealth(host: Fetcher): Promise<DaemonResult<null>> {
  let reply;
  try {
    reply = await host.fetch(HEALTH_PATH);
  } catch {
    return { kind: "down" };
  }
  if (reply.status !== 200) return { kind: "down" };
  let body: unknown;
  try {
    body = JSON.parse(reply.text);
  } catch {
    return { kind: "down" };
  }
  const verdict = daemonHealthCompatibility(body, DAEMON_PROTOCOL_CAPABILITIES.homeDispatch);
  if (verdict === "unreachable") return { kind: "down" };
  return verdict === "compatible" ? { kind: "ok", value: null } : { kind: "off" };
}

/**
 * Whether a daemon reply is the "flag is off" answer: while the headless-mode flag is off the whole
 * `/dispatch/*` group answers 404 `{ feature: "headless-mode" }`. The one definition of that contract,
 * used by every daemon call the mod makes (this file's and the flows'), so a missing route is never
 * read as the flag being off.
 */
export function isFlagOffAnswer(status: number, body: unknown): boolean {
  return status === 404 && body !== null && typeof body === "object" && (body as { feature?: unknown }).feature === "headless-mode";
}

async function call<T>(
  host: Fetcher,
  path: string,
  init: ModFetchInit,
  parse: (value: unknown) => T | null,
): Promise<DaemonResult<T>> {
  let reply;
  try {
    reply = await host.fetch(path, init);
  } catch {
    return { kind: "down" };
  }
  let body: unknown;
  try {
    body = JSON.parse(reply.text);
  } catch {
    body = undefined;
  }
  // Any other 404 (a route that is not there, a session the daemon forgot) is an error, not the flag being off.
  if (reply.status === 404) return isFlagOffAnswer(reply.status, body) ? { kind: "off" } : { kind: "error", status: 404 };
  if (reply.status === 401) return { kind: "unauthorized" };
  if (reply.status !== 200 || body === undefined) return { kind: "error", status: reply.status };
  const value = parse(body);
  return value === null ? { kind: "error", status: reply.status } : { kind: "ok", value };
}

export function registerSession(
  host: Fetcher,
  body: HomeSessionRegistration,
): Promise<DaemonResult<HomeSessionRegistrationAnswer>> {
  return call(host, SESSIONS_PATH, { method: "POST", body }, (v) => {
    const parsed = HomeSessionRegistrationAnswerSchema.safeParse(v);
    return parsed.success ? parsed.data : null;
  });
}

export function fetchInbox(
  host: Fetcher,
  query: { repoRoot: string | null; sessionId: string },
): Promise<DaemonResult<HomeDispatchInbox>> {
  const params = new URLSearchParams();
  if (query.repoRoot) params.set("repo", query.repoRoot);
  params.set("session", query.sessionId);
  return call(host, `${INBOX_PATH}?${params.toString()}`, { method: "GET" }, (v) => {
    const parsed = HomeDispatchInboxSchema.safeParse(v);
    return parsed.success ? parsed.data : null;
  });
}
