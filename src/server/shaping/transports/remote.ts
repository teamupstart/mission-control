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
 * Each value as written, and as it reads inside a JSON string when that differs: a raw body
 * that echoes `alpha\tsecret` in JSON holds the six characters `alpha\\tsecret`, which an exact
 * match on the value as written never finds. Same name, so the marker is the same.
 */
function withJsonForms(resolved: readonly ResolvedValue[]): ResolvedValue[] {
  return resolved.flatMap((entry) => {
    const escaped = JSON.stringify(entry.value).slice(1, -1);
    return escaped === entry.value ? [entry] : [entry, { name: entry.name, value: escaped }];
  });
}

/**
 * Text a shaper wrote, quoted into a reason: scrubbed on the text exactly as written, of each
 * value and its JSON-escaped form, and only then flattened and cut. Flattening first would turn a
 * value with a run of whitespace, such as `alpha  secret`, into one the exact match no longer
 * finds; cutting first could split a value. `redacted` says a value was removed, for the mark.
 */
export function quoted(text: string, resolved: readonly ResolvedValue[]): { text: string; redacted: boolean } {
  const forms = withJsonForms(resolved);
  const clean = redactResolved(text, forms).replace(/\s+/g, " ").trim();
  return { text: clean.length > QUOTED_CHARS ? `${clean.slice(0, QUOTED_CHARS)}…` : clean, redacted: holdsResolvedValue(text, forms) };
}

/**
 * `headers` without the ones a transport owns, compared without case: `content-type` and
 * `accept` for both, and for MCP the protocol's own session headers. A configured `Content-Type`
 * kept beside the transport's `content-type` would be combined with it by the Headers API into
 * a body type the endpoint refuses.
 */
export function withoutOwnedHeaders(headers: Readonly<Record<string, string>>, owned: readonly string[]): Record<string, string> {
  const names = new Set(owned.map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())));
}

/** What the `http` transport sets itself. */
export const HTTP_OWNED_HEADERS = ["content-type", "accept"] as const;
/** What the MCP streamable-HTTP client sets itself. */
export const MCP_OWNED_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"] as const;

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
