import { fetchOnOrigin, readCappedBody } from "../../origin-fetch.ts";
import type { ShapingTransport } from "./types.ts";
import {
  callHeaders, callSignal, dataReply, egressRefusal, failure, HTTP_OWNED_HEADERS, quoted, REMOTE_REPLY_BYTES, requestFailure, seconds,
  withoutOwnedHeaders,
} from "./remote.ts";

/**
 * The `http` transport: `POST` the request as JSON, read the result. Egress follows the resident
 * MCP rule, decided before anything is sent: https, or plain http only to loopback. Headers are
 * resolved at call time and a missing reference sends nothing. Redirects are followed by hand and
 * only on the origin, the body is read to at most 256 KiB, and the call's deadline aborts it.
 */
export const callHttp: ShapingTransport<"http"> = async (request, shaper, ctx) => {
  const { url } = shaper.transport;
  const refused = egressRefusal(url);
  if (refused) return { kind: "unavailable", reason: refused };
  const resolution = callHeaders(shaper.transport.headers, request, ctx);
  if (!resolution.ok) return { kind: "unavailable", reason: resolution.reason };
  const { resolved } = resolution;
  // The body type is Mission Control's to state, whatever a configured header says, in any case.
  const headers = { ...withoutOwnedHeaders(resolution.headers, HTTP_OWNED_HEADERS), "content-type": "application/json", accept: "application/json" };
  const signal = callSignal(ctx);
  const timedOut = () => failure("timed_out", `Timed out after ${seconds(ctx.timeoutMs)}.`, resolved);
  try {
    const response = await fetchOnOrigin(new URL(url).origin, headers, url, {
      method: "POST", body: JSON.stringify(request), signal, credentials: "omit",
    });
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
