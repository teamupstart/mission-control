// The one fetch every shaper sign-in request uses: metadata, registration, the code exchange,
// refresh and revocation. It is deliberately not the shaper's fetch (`fetchOnOrigin`), which
// adds the shaper's configured headers and the trace and work unit carriers: a sign-in request
// carries only what the OAuth exchange itself puts in it.
//
// The rules are `plan.md`'s "Egress rules for sign-in requests". The URL rule is the resident
// MCP one, `plaintextCredentialProblem`: https, or plain http to this machine's loopback.

import { readCappedBody } from "../../origin-fetch.ts";
import { plaintextCredentialProblem } from "../../../shared/resident-mcp.ts";

/** The most a sign-in reply may hold. Nothing past it is buffered or parsed. */
export const SIGN_IN_REPLY_BYTES = 64 * 1024;

/** How long one sign-in request may take, the reading of its reply included. */
export const SIGN_IN_REQUEST_MS = 10_000;

/** The statuses that redirect a request. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Statuses a `Response` may not be built with a body for. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * Request headers a sign-in request never carries, whoever set them: a cookie, and the trace and
 * work unit carriers that a shaper's call sends. The SDK sets none of them today; this keeps it so.
 */
const NEVER_SENT: readonly string[] = ["cookie", "traceparent", "tracestate", "baggage", "x-work-unit-id"];

/**
 * A request Mission Control's own rules refused: an origin the sign-in may not reach, a URL that
 * is neither https nor loopback http, or a redirect that leaves the sign-in's origins. Thrown
 * before the request is made, or before a redirect is followed, so nothing reaches that place.
 */
export class SignInRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRefusal";
  }
}

/**
 * A request that was made and did not complete: the network failed, it passed its deadline, or
 * the reply passed its cap. Never a `TypeError`, so the SDK's discovery does not take it for a
 * CORS failure and quietly try again without headers.
 */
export class SignInRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequestError";
  }
}

export type SignInFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SignInFetchOptions {
  /** Per request, the reply's reading included. Tests shorten it. */
  timeoutMs?: number;
  /** The most one reply may hold. */
  capBytes?: number;
}

/** Why `url` may not be reached by a sign-in that may reach `origins`, or null. */
export function signInUrlProblem(url: URL, origins: readonly string[]): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return `${url.protocol} is not https or loopback http`;
  if (plaintextCredentialProblem(url)) return `${url.origin} is plain http to a host that is not loopback; use https`;
  if (url.username || url.password) return `${url.origin} carries a user name or password in its URL`;
  if (!origins.includes(url.origin)) return `${url.origin} is not an origin this sign-in may reach`;
  return null;
}

/**
 * A fetch that reaches only `origins`, over https or loopback http, and refuses anything else
 * before a request is made. It sends no cookie and adds no header of its own, follows no
 * redirect itself, refuses a redirect that leaves `origins`, reads at most 64 KiB of a reply and
 * gives each request 10 seconds. The reply comes back already read, so a caller never waits on a
 * body past the deadline. A redirect within `origins` answering a GET or a HEAD, a metadata
 * read, is returned unfollowed for the SDK's same-origin redirect handling to decide on, and
 * that hop comes back through here. A redirect answering any other method is refused: the SDK
 * would resend a 307 or 308's body, and a token request's body holds a code, a verifier or a
 * refresh token that belongs at the token endpoint and nowhere else on its origin.
 */
export function signInFetch(origins: readonly string[], options: SignInFetchOptions = {}): SignInFetch {
  const allowed = [...new Set(origins.map((origin) => new URL(origin).origin))];
  const timeoutMs = options.timeoutMs ?? SIGN_IN_REQUEST_MS;
  const capBytes = options.capBytes ?? SIGN_IN_REPLY_BYTES;
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const problem = signInUrlProblem(url, allowed);
    if (problem) throw new SignInRefusal(`Refused a sign-in request: ${problem}.`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    for (const name of NEVER_SENT) headers.delete(name);
    const body = init.body ?? (input instanceof Request ? input.body : undefined);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    try {
      const response = await fetch(url, {
        method, headers, body, signal, redirect: "manual", credentials: "omit",
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit);
      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
      if (location) {
        void response.body?.cancel().catch(() => {});
        let target: URL;
        try { target = new URL(location, url); } catch { throw new SignInRefusal(`${url.origin} answered a redirect to an unreadable location.`); }
        const leaves = signInUrlProblem(target, allowed);
        if (leaves) throw new SignInRefusal(`${url.origin} redirected the sign-in elsewhere, which was not followed: ${leaves}.`);
        const verb = method.toUpperCase();
        if (verb !== "GET" && verb !== "HEAD") {
          throw new SignInRefusal(`${url.origin} answered a ${verb} with a ${response.status} redirect, which is never followed, so its body is not sent again.`);
        }
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      const read = await readCappedBody(response, capBytes);
      if (!read.ok) throw new SignInRequestError(`${url.origin} answered with more than ${Math.round(capBytes / 1024)} KiB, which was not read.`);
      const bytes = NULL_BODY_STATUSES.has(response.status) ? null : read.bytes;
      return new Response(bytes as BodyInit | null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (error instanceof SignInRefusal || error instanceof SignInRequestError) throw error;
      if (deadline.aborted) throw new SignInRequestError(`${url.origin} did not answer within ${Math.round(timeoutMs / 100) / 10} seconds.`);
      if (init.signal?.aborted) throw new SignInRequestError(`The request to ${url.origin} was cancelled.`);
      throw new SignInRequestError(`Could not reach ${url.origin}: ${networkCause(error)}.`);
    }
  };
}

/** A network failure's cause, by its code where it has one. Never the request's contents. */
function networkCause(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : "";
  if (/^[A-Z_]{3,40}$/.test(code)) return code;
  return "the connection failed";
}
