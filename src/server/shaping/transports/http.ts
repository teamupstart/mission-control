import { fetchOnOrigin, readCappedBody } from "../../origin-fetch.ts";
import type { ShapingTransport } from "./types.ts";
import {
  callHeaders, callSignal, dataReply, egressRefusal, failure, HTTP_OWNED_HEADERS, quoted, REMOTE_REPLY_BYTES, requestFailure, seconds,
  signInFor, signInRefused, withoutOwnedHeaders,
} from "./remote.ts";

/**
 * The `http` transport: `POST` the request as JSON, read the result. Egress follows the resident
 * MCP rule, decided before anything is sent: https, or plain http only to loopback. Headers are
 * resolved at call time and a missing reference sends nothing. Redirects are followed by hand and
 * only on the origin, the body is read to at most 256 KiB, and the call's deadline aborts it.
 *
 * A shaper with the `auth` marker asks the sign-in service first: without a token it is not
 * called, and with one the token rides the request as a bearer header, to the origin only, and
 * is scrubbed from the reply. A `401` to a signed-in call answers `unavailable` and tells the
 * service; it is never retried.
 */
export const callHttp: ShapingTransport<"http"> = async (request, shaper, ctx) => {
  const { url } = shaper.transport;
  const refused = egressRefusal(url);
  if (refused) return { kind: "unavailable", reason: refused };
  // Asked before any header is resolved: a marked shaper that is not signed in sends nothing.
  const signIn = signInFor(shaper);
  if (signIn && !signIn.ok) return { kind: "unavailable", reason: signIn.reason };
  const resolution = callHeaders(shaper.transport.headers, request, ctx, HTTP_OWNED_HEADERS);
  if (!resolution.ok) return { kind: "unavailable", reason: resolution.reason };
  const resolved = signIn ? [...resolution.resolved, ...signIn.resolved] : resolution.resolved;
  // The body type is Mission Control's to state, whatever a configured header says, in any case.
  // The marker refuses a configured `authorization`, so the sign-in's header replaces nothing.
  const headers = {
    ...withoutOwnedHeaders(resolution.headers, HTTP_OWNED_HEADERS), ...signIn?.headers, "content-type": "application/json", accept: "application/json",
  };
  const signal = callSignal(ctx);
  const timedOut = () => failure("timed_out", `Timed out after ${seconds(ctx.timeoutMs)}.`, resolved);
  try {
    // A redirect that would resend the request as a GET without its body is refused: the
    // endpoint would never see the task, and a generic reply would pass for guidance.
    const response = await fetchOnOrigin(new URL(url).origin, headers, url, {
      method: "POST", body: JSON.stringify(request), signal, credentials: "omit",
    }, undefined, { keepMethod: true });
    // Read from the response itself, before its body: the server refused the token this call sent.
    if (signIn && response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return signInRefused(signIn);
    }
    const body = await readCappedBody(response, REMOTE_REPLY_BYTES);
    if (!body.ok) return failure("failed", `The reply was larger than ${REMOTE_REPLY_BYTES / 1024} KiB, so it was not read.`, resolved);
    const text = new TextDecoder().decode(body.bytes);
    if (response.status < 200 || response.status >= 300) {
      const detail = quoted(text, resolved);
      return failure("failed", `The shaper answered HTTP ${response.status}${detail.text ? `: ${detail.text}` : "."}`, resolved, detail.redacted);
    }
    return dataReply(text, resolved);
  } catch (error) {
    if (signal.aborted) return timedOut();
    return failure("failed", `The request failed: ${requestFailure(error)}`, resolved);
  }
};
