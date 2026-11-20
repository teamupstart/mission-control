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
  owned: readonly string[] = [],
): { ok: true; headers: Record<string, string>; resolved: ResolvedValue[] } | { ok: false; reason: string } {
  // Only headers that will be sent are resolved: one the transport owns and replaces, such as a
  // configured `Accept`, cannot block a call by naming a reference that is not set.
  const sent = withoutOwnedHeaders(withoutCarriedHeaders(configured), owned);
  const resolution = resolveReferenceMap(sent, { caller: request.context.caller });
  if (!resolution.ok) return { ok: false, reason: missingReferenceReason(resolution.missing) };
  return {
    ok: true,
    headers: { ...resolution.value, ...carriedHeaders(ctx.trace, ctx.workUnitId) },
    resolved: withTransmittedForms(resolution.resolved),
  };
}

/**
 * Each value as written, and as the server receives it when that differs: a header value is
 * sent with its leading and trailing spaces and tabs removed, so a value at either end of a
 * header reaches the server trimmed, and an echo of it carries the trimmed form.
 */
function withTransmittedForms(resolved: readonly ResolvedValue[]): ResolvedValue[] {
  return resolved.flatMap((entry) => {
    const trimmed = entry.value.replace(/^[\t ]+|[\t ]+$/g, "");
    return trimmed && trimmed !== entry.value ? [entry, { name: entry.name, value: trimmed }] : [entry];
  });
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
  // As written, then with every JSON string escape decoded, so `\u0061` or `\/` spellings of a
  // value are found as the value, then with whitespace collapsed, which can make a value out of
  // a spacing variant of it. Each pass scrubs the previous pass's output.
  const asWritten = redactResolved(text, forms);
  const decoded = redactResolved(decodeJsonEscapes(asWritten), forms);
  const collapsed = redactResolved(decoded.replace(/\s+/g, " ").trim(), forms);
  const redacted = asWritten !== text || decoded !== decodeJsonEscapes(asWritten) || collapsed !== decoded.replace(/\s+/g, " ").trim();
  return { text: collapsed.length > QUOTED_CHARS ? `${collapsed.slice(0, QUOTED_CHARS)}…` : collapsed, redacted };
}

const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * `text` with JSON string escapes decoded, up to three levels deep, for a body that nests one
 * JSON document's text inside another's. Only for matching and display: a diagnostic, not data.
 */
export function decodeJsonEscapes(text: string): string {
  let out = text;
  for (let level = 0; level < 3; level++) {
    const next = out.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g,
      (_whole, hex: string | undefined, char: string | undefined) => (hex ? String.fromCharCode(Number.parseInt(hex, 16)) : JSON_ESCAPES[char!]!));
    if (next === out) break;
    out = next;
  }
  return out;
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
  // A string in the reply can hold JSON text of its own, such as a dump of the request headers,
  // where a value with a quote, a backslash or a tab is written escaped: that form goes too.
  const forms = withJsonForms(resolved);
  const scrubbed = scrubResolved(decoded, forms);
  return {
    kind: "data",
    // As received when nothing was removed, otherwise the scrubbed reply as the decoded value it is.
    data: scrubbed.redacted ? scrubbed.data : raw,
    ...(scrubbed.redacted ? { redacted: true } : {}),
    ...(scrubbed.notes.length > 0 ? { redactionNotes: scrubbed.notes } : {}),
    ...(resolved.length > 0
      ? { redact: (text: string) => redactResolved(text, forms), holdsNamed: (text: string) => holdsResolvedValue(text, forms) }
      : {}),
  };
}
