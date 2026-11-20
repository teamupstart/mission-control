import type { ShapingRequest } from "@shared/shaping.ts";
import { plaintextCredentialProblem } from "@shared/resident-mcp.ts";
import {
  holdsResolvedValue,
  missingReferenceReason,
  redactResolved,
  resolveReferenceMap,
  scrubReason,
  scrubResolved,
  type ResolvedValue,
} from "../references.ts";
import { carriedHeaders, withoutCarriedHeaders } from "./carriers.ts";
import type { TransportContext, TransportReply } from "./types.ts";

/**
 * What the `http` and `mcp` transports share: the egress rule, header resolution, the 256 KiB
 * reply cap, and turning what came back into a reply that holds no value resolved into a header.
 */

/** The most a remote shaper may send in one reply: an `http` body, or one MCP message. As a `command` shaper's stdout. */
export const REMOTE_REPLY_BYTES = 256 * 1024;

/** The bound on a shaper's own text quoted in a failure reason, after it was scrubbed. */
const QUOTED_CHARS = 300;

export function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/**
 * Why no request may go to `url`, or null. The resident MCP rule, unchanged: https, or plain http
 * only to this machine's loopback. Applied to every remote shaper whether or not it has a
 * credential header, before anything is sent.
 */
export function egressRefusal(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "The shaper's URL is not valid, so no request was sent."; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "The shaper's URL is not http or https, so no request was sent.";
  return plaintextCredentialProblem(parsed)
    ? "The shaper's URL is plain http to a host that is not this machine, so no request was sent. Use https."
    : null;
}

/**
 * The headers a call sends: the configured ones with every reference resolved, then the
 * launch's trace context and work unit id. A configured header a carrier owns is removed first.
 * A reference that resolves to nothing fails closed, naming the reference, never a value.
 */
export function callHeaders(
  configured: Readonly<Record<string, string>>,
  request: ShapingRequest,
  ctx: Pick<TransportContext, "trace" | "workUnitId">,
): { ok: true; headers: Record<string, string>; resolved: ResolvedValue[] } | { ok: false; reason: string } {
  const resolution = resolveReferenceMap(withoutCarriedHeaders(configured), { caller: request.context.caller });
  if (!resolution.ok) return { ok: false, reason: missingReferenceReason(resolution.missing) };
  return { ok: true, headers: { ...resolution.value, ...carriedHeaders(ctx.trace, ctx.workUnitId) }, resolved: resolution.resolved };
}

/** This call's own signal: the engine's, and the call's timeout, whichever comes first. */
export function callSignal(ctx: Pick<TransportContext, "signal" | "timeoutMs">): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(0, ctx.timeoutMs))]);
}

/**
 * A reply that is not data, scrubbed of every resolved value and marked when anything was removed,
 * here or already from a quote inside it (`quoted`).
 */
export function failure(
  kind: "failed" | "timed_out" | "unavailable",
  reason: string,
  resolved: readonly ResolvedValue[],
  alreadyRedacted = false,
): TransportReply {
  const scrubbed = scrubReason(reason, resolved);
  return { kind, reason: scrubbed.reason, ...(scrubbed.redacted || alreadyRedacted ? { redacted: true } : {}) };
}

/**
 * Text a shaper wrote, quoted into a reason: scrubbed whole first, then cut, so no cut splits a
 * value. `redacted` says a value was removed, for the reply's mark.
 */
export function quoted(text: string, resolved: readonly ResolvedValue[]): { text: string; redacted: boolean } {
  const flat = text.replace(/\s+/g, " ").trim();
  const clean = redactResolved(flat, resolved);
  return { text: clean.length > QUOTED_CHARS ? `${clean.slice(0, QUOTED_CHARS)}…` : clean, redacted: holdsResolvedValue(flat, resolved) };
}

/** Why a request threw, with the cause's code when Node gives one: "fetch failed" alone says nothing. */
export function requestFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? `${message} (${cause.code})` : message;
}

/**
 * A successful reply for the engine. Every value the transport resolved into a header, a
 * `{caller.*}` or an `{env:NAME}`, may come back in an echo: it is removed from the reply's own
 * content, entries and facts included, before the engine sees it, and from every reason the
 * engine builds from it.
 */
export function dataReply(raw: unknown, resolved: readonly ResolvedValue[]): TransportReply {
  let decoded: unknown = raw;
  if (typeof raw === "string") {
    try { decoded = JSON.parse(raw); } catch { /* The engine refuses it without its text. */ }
  }
  const scrubbed = scrubResolved(decoded, resolved);
  return {
    kind: "data",
    // As received when nothing was removed, otherwise the scrubbed reply as the decoded value it is.
    data: scrubbed.redacted ? scrubbed.data : raw,
    ...(scrubbed.redacted ? { redacted: true } : {}),
    ...(scrubbed.notes.length > 0 ? { redactionNotes: scrubbed.notes } : {}),
    ...(resolved.length > 0
      ? { redact: (text: string) => redactResolved(text, resolved), holdsNamed: (text: string) => holdsResolvedValue(text, resolved) }
      : {}),
  };
}
