import {
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  SCOUT_SESSION_LOCATOR_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
  readToken,
} from "@shared/harness-runtime.mjs";
import {
  classifyShapers,
  SHAPING_LIMITS,
  shapingReferences,
  ShapingResultSchema,
  type DiscoveredShaper,
  type Shaper,
  type ShapingConfig,
  type ShapingContext,
  type ShapingReferenceStatus,
} from "@shared/shaping.ts";
import { STATE_HOME_ENV_NAMES } from "../agent-subprocess-env.ts";
import { forEachOccurrence, redactSpans, type RedactionSpan } from "./redaction.ts";
import { carriedEnvName, HTTP_OWNED_HEADERS, MCP_OWNED_HEADERS, withoutCarriedHeaders, withoutOwnedHeaders } from "./transports/carriers.ts";

// ---------------------------------------------------------------------------------------------
// Resolution
//
// A shaper's config holds references, never secrets, and a reference is resolved when the call is
// made. Nothing here logs, stores or returns a resolved value: a resolution hands the values back
// to its caller, which sends them and then scrubs them from whatever came back (`scrubResolved`).
// Kept free of shaping's request types beyond the caller identity, so another adapter, such as
// FR-06 lesson promotion, can resolve its own headers the same way.

/**
 * Variables no reference resolves, whatever a shaper names: Mission Control's own API token and
 * its file, its scout credentials and session locator, and its state directory under every name.
 * The `command` transport refuses to pass the same names. A reference to one fails closed.
 */
export const NEVER_PASSED_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  ...STATE_HOME_ENV_NAMES,
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  SCOUT_SESSION_LOCATOR_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
]);

/** Who a call is made for, as `{caller.*}` resolves it. Null or empty is unresolved. */
export type ReferenceCaller = ShapingContext["caller"];

export interface ReferenceContext {
  caller: ReferenceCaller;
  /** The daemon's environment at call time. */
  env?: NodeJS.ProcessEnv;
  /** The daemon's own API token: a value that carries it never resolves. Read from its file when absent. */
  daemonToken?: string;
}

/**
 * What one resolution came to. `resolved` lists every value it put into the text, `{caller.*}` and
 * `{env:NAME}` alike, so the caller can scrub each one from whatever comes back: no resolved
 * header value is ever exposed in a reply, a log or a record.
 */
export type ResolvedReferences<T> =
  | { ok: true; value: T; resolved: ResolvedValue[] }
  | { ok: false; missing: string[] };

/** One reference as written, `{caller.user}` or `{env:NAME}`, for a reason. Never a value. */
function spelled(reference: string): string {
  return `{${reference}}`;
}

/**
 * Whether `value` can travel in a header as written: tabs, spaces, visible ASCII and the Latin-1
 * range only, the characters `Headers` accepts. A CR, LF or NUL is refused when a header is built
 * or stripped from its ends before it is sent, and a character above U+00FF cannot be encoded at
 * all, so a value holding one would either fail every call or reach the server in a form no
 * scrub knows. Such a value is unresolved, and nothing is sent.
 */
function sendable(value: string): boolean {
  return !/[^\t\x20-\x7e\x80-\xff]/.test(value);
}

/** The value one reference resolves to, or null. An empty or blank value is unresolved. */
function resolveOne(reference: string, ctx: ReferenceContext, token: string): string | null {
  // A caller value of only spaces and tabs is blank once it is sent as a header, as an
  // environment value is: unresolved, so no request carries an empty identity or bare text.
  const caller = (value: string | null) => (value && value.trim() !== "" && sendable(value) ? value : null);
  switch (reference) {
    case "caller.user": return caller(ctx.caller.user);
    case "caller.agent": return caller(ctx.caller.agent);
    case "caller.conversation": return caller(ctx.caller.conversation);
  }
  if (!reference.startsWith("env:")) return null;
  const name = reference.slice(4);
  if (NEVER_PASSED_ENV_NAMES.has(name)) return null;
  // The environment's own string only: a name such as `constructor` would otherwise read an
  // inherited property. A value of only spaces and tabs is blank once it is sent as a header, so
  // it is unresolved too, and the call is not made with an empty header or a bare scheme.
  const env = ctx.env ?? process.env;
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!sendable(value)) return null;
  if (token.length > 0 && value.includes(token)) return null;
  return value;
}

/**
 * `text` with every `{caller.user}`, `{caller.agent}`, `{caller.conversation}` and `{env:NAME}`
 * replaced by its value. Every reference that resolves to nothing, an empty value included, is
 * reported by its spelling, and then nothing is returned: a caller that cannot resolve a
 * reference makes no call. Text that names a reference this build does not know is unresolved
 * too, so a newer config never sends a literal `{...}` by mistake.
 */
export function resolveReferences(text: string, ctx: ReferenceContext): ResolvedReferences<string> {
  const result = resolveReferenceMap({ text }, ctx);
  return result.ok ? { ok: true, value: result.value.text!, resolved: result.resolved } : result;
}

/**
 * Every value of `values` resolved, such as a shaper's headers, or every reference that could
 * not be, each named once in the order it first appears.
 */
export function resolveReferenceMap(values: Readonly<Record<string, string>>, ctx: ReferenceContext): ResolvedReferences<Record<string, string>> {
  const token = (ctx.daemonToken ?? readToken()).trim();
  const missing: string[] = [];
  const resolved = new Map<string, string>();
  // Built as entries, so a header named `__proto__` is an own entry rather than a prototype write.
  const entries: Array<[string, string]> = [];
  for (const [key, text] of Object.entries(values)) {
    entries.push([key, text.replace(/\{([^{}]*)\}/g, (_whole, inner: string) => {
      const value = resolveOne(inner, ctx, token);
      if (value === null) {
        if (!missing.includes(spelled(inner))) missing.push(spelled(inner));
        return "";
      }
      // An environment value is reported under its variable's name, a caller value under its own.
      resolved.set(inner.startsWith("env:") ? inner.slice(4) : inner, value);
      return value;
    })]);
  }
  const out: Record<string, string> = Object.fromEntries(entries);
  if (missing.length > 0) return { ok: false, missing };
  // Every value is scrubbed wherever it appears, however short, a caller value as much as a
  // credential: a short one such as the harness `pi` inside a longer word is redacted too, for a
  // shaper that sends that reference. Over-redaction is the accepted cost of never echoing one.
  return { ok: true, value: out, resolved: [...resolved].map(([name, value]) => ({ name, value })) };
}

/** The reason a shaper was not called because a reference did not resolve. Names, never values. */
export function missingReferenceReason(missing: readonly string[]): string {
  const list = missing.join(", ");
  return missing.length === 1
    ? `The reference ${list} did not resolve to a value, so the shaper was not called.`
    : `The references ${list} did not resolve to values, so the shaper was not called.`;
}

/** Every `{env:NAME}` a shaper's definition references, in the order they appear. */
export function shaperEnvReferences(shaper: Shaper): string[] {
  const transport = shaper.transport;
  // Only headers a call sends: the ones a carrier or the transport owns are dropped before any
  // reference resolves, so a variable named only there is never needed and is not listed.
  const configured = transport.type === "http"
    ? withoutOwnedHeaders(transport.headers, HTTP_OWNED_HEADERS)
    : transport.type === "mcp" && transport.server.type === "http" ? withoutOwnedHeaders(transport.server.headers, MCP_OWNED_HEADERS) : {};
  const headers = withoutCarriedHeaders(configured);
  const names: string[] = [];
  for (const value of Object.values(headers)) {
    for (const reference of shapingReferences(value) ?? []) {
      if (reference.startsWith("env:") && !names.includes(reference.slice(4))) names.push(reference.slice(4));
    }
  }
  return names;
}

/** Every name a `command` shaper or a locally started MCP server passes through in its `env`. */
function passedThroughNames(shapers: readonly Shaper[]): Set<string> {
  return new Set(shapers.flatMap((shaper) => {
    const transport = shaper.transport;
    return transport.type === "command" ? transport.env
      : transport.type === "mcp" && transport.server.type === "stdio" ? transport.server.env : [];
  }));
}

/** Whether a pass-through variable reaches the child, by the `command` transport's own rule. */
function passesThrough(name: string, env: NodeJS.ProcessEnv, token: string): boolean {
  if (NEVER_PASSED_ENV_NAMES.has(name)) return false;
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  return typeof value === "string" && value !== "" && !(token.length > 0 && value.includes(token));
}

/**
 * Every environment name a shaper uses, in the order it names them: the `{env:NAME}` its headers
 * reference, and the variables a `command` shaper or a locally started MCP server passes through
 * in its `env` list. The carriers' own names are left out, because a shaper never receives one
 * it named. Settings shows each as set or not set beside the shaper.
 */
export function shaperEnvironmentNames(shaper: Shaper): string[] {
  const transport = shaper.transport;
  const passed = transport.type === "command"
    ? transport.env
    : transport.type === "mcp" && transport.server.type === "stdio" ? transport.server.env : [];
  return [...new Set([...shaperEnvReferences(shaper), ...passed.filter((name) => !carriedEnvName(name))])];
}

/**
 * Whether each environment name a shaper uses is set in the daemon's environment, never its
 * value: every registered shaper this build understands and every discovered one that can run.
 * A name counts as set only when a call would send it: one no reference may resolve, or that a
 * `command` shaper may never receive, such as Mission Control's own token, is always `unset`, as
 * are an empty value and one that carries the daemon's token.
 */
export function referenceStatus(
  config: ShapingConfig,
  discovered: readonly DiscoveredShaper[] = [],
  env: NodeJS.ProcessEnv = process.env,
  daemonToken: string = readToken(),
): ShapingReferenceStatus {
  const shapers = [
    ...classifyShapers(config).flatMap((entry) => entry.kind === "known" ? [entry.shaper] : []),
    ...discovered.flatMap((entry) => entry.state === "ok" && entry.shaper ? [entry.shaper] : []),
  ];
  const token = daemonToken.trim();
  const referenced = new Set(shapers.flatMap(shaperEnvReferences));
  // Built as entries, so a variable named `__proto__` is listed rather than lost to the setter.
  const status: Array<[string, "set" | "unset"]> = [];
  for (const name of [...new Set(shapers.flatMap(shaperEnvironmentNames))].sort()) {
    // A header reference is set only when a call can resolve it; a pass-through name only when a
    // `command` shaper or a local server would receive it. A name used both ways needs both.
    const asReference = !referenced.has(name)
      || resolveOne(`env:${name}`, { caller: { user: null, agent: null, conversation: null }, env }, token) !== null;
    const passed = passedThroughNames(shapers).has(name) ? passesThrough(name, env, token) : true;
    status.push([name, asReference && passed ? "set" : "unset"]);
  }
  return Object.fromEntries(status);
}

/**
 * Remove every NUL from the strings of a decoded reply, in place, and drop any key that holds
 * one together with its value, so two keys can never merge. Walked with a stack, so no nesting
 * overflows it. The engine applies the same rule to every reply; a transport that redacts
 * applies it first, so what it checks is what the engine will keep.
 */
export function withoutNul(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!Array.isArray(record) && key.includes("\u0000")) { delete record[key]; continue; }
      const item = record[key];
      if (typeof item === "string") {
        if (item.includes("\u0000")) record[key] = item.replaceAll("\u0000", "");
      } else if (item && typeof item === "object") {
        pending.push(item);
      }
    }
  }
}

/** A value a transport handed a shaper, and the name it is reported under. Matched anywhere. */
export interface ResolvedValue {
  name: string;
  value: string;
}

/**
 * The form every spelling of `value` with other whitespace collapses to: its words joined by single
 * spaces, such as `Jane Doe` for `Jane   Doe` or `Jane\nDoe`; or null when it has no inner
 * whitespace. Collapsing whitespace, as a section heading and a recorded reason do, turns such a
 * spelling back into the value, so it is a copy of the value and is found as one.
 */
function spacingKey(value: string): string | null {
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length < 2 ? null : parts.join(" ");
}

const WHITESPACE = /\s/;

/**
 * `text` with every run of whitespace written as one space, and for each of its characters the
 * span of `text` it stands for. A spacing variant of a value in `text` is exactly an occurrence of
 * the value's `spacingKey` here, so it is found by the linear search used for every other match,
 * overlapping occurrences included. A regular expression would scan the same long prefix again
 * from every candidate start, which a value of many repeated words makes quadratic in the reply.
 */
function collapsedView(text: string): { collapsed: string; starts: Int32Array; ends: Int32Array } {
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  const pieces: string[] = [];
  let length = 0;
  for (let at = 0; at < text.length;) {
    let end = at + 1;
    if (WHITESPACE.test(text[at]!)) {
      while (end < text.length && WHITESPACE.test(text[end]!)) end += 1;
      pieces.push(" ");
    } else {
      pieces.push(text[at]!);
    }
    starts[length] = at;
    ends[length] = end;
    length += 1;
    at = end;
  }
  return { collapsed: pieces.join(""), starts: starts.subarray(0, length), ends: ends.subarray(0, length) };
}

/**
 * How many levels of JSON text nested in JSON strings a scrub decodes: a reply string can hold
 * a serialized diagnostic that itself holds serialized JSON, a value escaped once per level.
 * Bounded, because a crafted chain such as `\u005cu005c...` peels only a few characters a level,
 * and decoding until nothing changes would cost the text's length squared.
 */
export const JSON_ESCAPE_LEVELS = 3;

const JSON_STRING_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * `text` with one level of JSON string escapes decoded, and for each decoded character the span
 * of `text` it came from. A reply string can hold JSON text of its own, such as a dump of the
 * request headers, where a value may be spelled with any escape (`\u0061` for `a`, `\/` for `/`).
 */
function decodeEscapes(text: string): { decoded: string; starts: number[]; ends: number[] } | null {
  if (!text.includes("\\")) return null;
  let decoded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const escape = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/y;
  for (let at = 0; at < text.length;) {
    escape.lastIndex = at;
    const match = text[at] === "\\" ? escape.exec(text) : null;
    if (match) {
      decoded += match[1] ? String.fromCharCode(Number.parseInt(match[1], 16)) : JSON_STRING_ESCAPES[match[2]!]!;
      starts.push(at);
      ends.push(at + match[0].length);
      at += match[0].length;
    } else {
      decoded += text[at];
      starts.push(at);
      ends.push(at + 1);
      at += 1;
    }
  }
  return decoded === text ? null : { decoded, starts, ends };
}

/**
 * Every stretch of `text` that spells a resolved value other than as written, as a span with the
 * value's name: a spacing variant (`Jane   Doe` for `Jane Doe`), and the raw text of an escaped
 * spelling of the value or of a spacing variant of it, found through one level of decoding. Each
 * value costs one linear pass and one regular-expression scan, over the text and over its
 * decoding, and each match yields its span directly: however many distinct spellings a reply
 * holds, nothing is searched for again.
 */
export function variantSpans(text: string, resolved: readonly ResolvedValue[]): RedactionSpan[] {
  // One scan per distinct value, however many names share it: each span carries all of them.
  const byValue = new Map<string, string[]>();
  for (const { name, value } of resolved) {
    if (value === "") continue;
    const names = byValue.get(value);
    if (!names) byValue.set(value, [name]);
    else if (!names.includes(name)) names.push(name);
  }
  const out: RedactionSpan[] = [];
  // Spans of one scan, merged as they are found. A scan reports matches in order of where they
  // start in the original text, so a span that meets the last one only extends it, and the
  // spans kept never outnumber the stretches of text they cover. A match that is the value as
  // written is left to the caller's own search for it, which every caller makes.
  const collect = (value: string, labels: readonly string[]) => {
    let last: { start: number; end: number; labels: readonly string[] } | null = null;
    return (start: number, end: number) => {
      if (end - start === value.length && text.startsWith(value, start)) return;
      if (last && start <= last.end) { if (end > last.end) last.end = end; return; }
      last = { start, end, labels };
      out.push(last);
    };
  };
  // The values that have inner whitespace, each with the form its spacing variants collapse to.
  const spaced = [...byValue].flatMap(([value, labels]) => {
    const key = spacingKey(value);
    return key ? [{ value, labels, key }] : [];
  });
  // Every spacing variant in `view`, found as its key in the collapsed view, overlapping ones
  // included, and mapped back to the original text through `toOriginal`.
  const spacedIn = (view: string, toOriginal: (start: number, end: number) => [number, number]) => {
    if (spaced.length === 0) return;
    const { collapsed, starts, ends } = collapsedView(view);
    for (const { value, labels, key } of spaced) {
      const add = collect(value, labels);
      forEachOccurrence(collapsed, key, false, (at) => add(...toOriginal(starts[at]!, ends[at + key.length - 1]!)));
    }
  };
  spacedIn(text, (start, end) => [start, end]);
  // Each level is decoded from the one before, and each of its characters keeps the span of the
  // original text it came from, so a value found at any level is removed there as written.
  let map = decodeEscapes(text);
  for (let level = 0; map && level < JSON_ESCAPE_LEVELS; level++) {
    const { decoded, starts, ends } = map;
    for (const [value, labels] of byValue) {
      const exact = collect(value, labels);
      forEachOccurrence(decoded, value, false, (start) => exact(starts[start]!, ends[start + value.length - 1]!));
    }
    spacedIn(decoded, (start, end) => [starts[start]!, ends[end - 1]!]);
    const next = level + 1 < JSON_ESCAPE_LEVELS ? decodeEscapes(decoded) : null;
    map = next && { decoded: next.decoded, starts: next.starts.map((at) => starts[at]!), ends: next.ends.map((at) => ends[at - 1]!) };
  }
  return out;
}

function holdsOne(text: string, resolved: ResolvedValue): boolean {
  if (resolved.value.length === 0) return false;
  if (text.includes(resolved.value)) return true;
  return variantSpans(text, [resolved]).length > 0;
}

/** The values to search `text` for, as written. Their other spellings come as spans. */
function targets(resolved: readonly ResolvedValue[]) {
  return resolved.map(({ name, value }) => ({ value, wholeToken: false, label: name }));
}

/** What `scrubResolved` returns: the reply with every resolved value gone, and what it removed. */
export interface ScrubbedReply {
  data: unknown;
  redacted: boolean;
  /**
   * Why an entry or a fact was dropped. Kept apart from the reply's own notes, which a reply may
   * already fill to their bound, so the engine can record them whatever the outcome.
   */
  notes: string[];
}

/** How a scrub names what it removed, decided once per reply. */
interface Marker {
  /** The replacement for a span covering these labels. */
  render: (labels: readonly string[]) => string;
  /** How a drop note names the value. */
  name: (value: ResolvedValue) => string;
}

/**
 * The marker for one reply. A variable's name is printed in `[NAME redacted]` and in drop notes,
 * so when any name contains any resolved value, naming it would repeat the credential: every
 * marker and note is then neutral.
 */
function markerFor(values: readonly ResolvedValue[]): Marker {
  const neutral = values.some(({ name }) => values.some(({ value }) => name.includes(value)));
  return neutral
    ? { render: () => "[redacted]", name: () => "a passed variable" }
    : { render: (labels) => `[${labels.join(", ")} redacted]`, name: (value) => value.name };
}

/** How a span covering these values' labels is written: `[NAME redacted]`, or neutral when a name holds a value. */
export function resolvedMarker(values: readonly ResolvedValue[]): (labels: readonly string[]) => string {
  return markerFor(values).render;
}

/**
 * Every occurrence of every resolved value, found on the original text and merged where values
 * overlap, so replacing one can never hide part of another from a later pass. The result is
 * bounded as it is built: a field within its limit stays within it, and a field already over
 * it stays just over it, for the schema to refuse, without growing further.
 */
function replaceResolved(text: string, resolved: readonly ResolvedValue[], limit: number, marker: Marker): string {
  return redactSpans(text, targets(resolved), marker.render, 0, text.length <= limit ? limit : limit + 1, variantSpans(text, resolved));
}

function holdsResolved(text: string, resolved: readonly ResolvedValue[]): ResolvedValue | undefined {
  return resolved.find((value) => holdsOne(text, value));
}

/**
 * A shaper cannot hand a value back. Every occurrence of a value the transport handed it is
 * replaced with `[NAME redacted]` in every field of a decoded reply the engine reads: entry ids,
 * paths, titles and bodies, the summary, fact values, notes, the version and an error. Fields the
 * result schema does not define are skipped, because the engine discards them unread. Keys the
 * schema defines are never changed. An otherwise valid entry whose id, or fact whose name,
 * contains such a value is dropped instead of renamed, so redaction can never merge two entries
 * or two facts, and the drop is returned as a note beside the reply. Only a reply that is valid as
 * written is rewritten: an invalid one is left as sent, so no rewrite can make the engine accept
 * a reply the protocol requires it to refuse.
 *
 * Nothing here recurses, and the decoded value is rewritten in place. A reply that is not a
 * JSON object is left alone: the engine refuses it without recording any of its text.
 */
export function scrubResolved(data: unknown, resolved: readonly ResolvedValue[]): ScrubbedReply {
  const values = resolved.filter(({ value }) => value.length > 0).sort((a, b) => b.value.length - a.value.length);
  if (values.length === 0 || data === null || typeof data !== "object" || Array.isArray(data)) return { data, redacted: false, notes: [] };
  // NUL first: the engine removes it from every string later, so a value split by a NUL here
  // would pass every check below and be joined back into the credential afterwards.
  withoutNul(data);
  const marker = markerFor(values);
  // A reply that is invalid as the shaper sent it is left exactly as sent. Any rewrite changes
  // what validation sees: dropping an entry can bring an oversized list within its bound, and
  // replacing a long value can shorten an oversized title. Left alone, it is refused by the
  // engine as sent, none of its content is ever returned, and the diagnostic built from it goes
  // through the reply's redactor, which marks the record when it removes a named value.
  if (!ShapingResultSchema.safeParse(data).success) return { data, redacted: false, notes: [] };
  let redacted = false;
  const notes: string[] = [];
  const root = data as Record<string, unknown>;
  const scrub = (text: string, limit: number): string => {
    const next = replaceResolved(text, values, limit, marker);
    if (next !== text) redacted = true;
    return next;
  };
  const scrubIn = (record: Record<string, unknown>, key: string, limit: number) => {
    const item = record[key];
    if (typeof item === "string") record[key] = scrub(item, limit);
  };
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

  scrubIn(root, "version", SHAPING_LIMITS.versionChars);
  if (Array.isArray(root.notes)) root.notes = root.notes.map((note) => (typeof note === "string" ? scrub(note, SHAPING_LIMITS.replyNoteChars) : note));
  // An error the engine reports: a string, or `{ code, message }`.
  if (typeof root.error === "string") root.error = scrub(root.error, SHAPING_LIMITS.replyText);
  else if (isRecord(root.error)) { scrubIn(root.error, "code", SHAPING_LIMITS.replyText); scrubIn(root.error, "message", SHAPING_LIMITS.replyText); }

  if (Array.isArray(root.guidance)) {
    root.guidance = root.guidance.filter((entry) => {
      if (!isRecord(entry)) return true;
      const hit = typeof entry.id === "string" ? holdsResolved(entry.id, values) : undefined;
      if (hit) {
        notes.push(`An entry was dropped because its id contained the value of ${marker.name(hit)}.`);
        redacted = true;
        return false;
      }
      scrubIn(entry, "id", SHAPING_LIMITS.entryIdChars);
      scrubIn(entry, "title", SHAPING_LIMITS.entryTitleChars);
      scrubIn(entry, "path", SHAPING_LIMITS.entryPathChars);
      scrubIn(entry, "body", SHAPING_LIMITS.replyText);
      return true;
    });
  }
  if (isRecord(root.repo)) {
    scrubIn(root.repo, "summary", SHAPING_LIMITS.replyText);
    const facts = root.repo.facts;
    if (isRecord(facts)) {
      for (const name of Object.keys(facts)) {
        const hit = holdsResolved(name, values);
        if (hit) {
          delete facts[name];
          notes.push(`A fact was dropped because its name contained the value of ${marker.name(hit)}.`);
          redacted = true;
          continue;
        }
        const value = facts[name];
        if (typeof value === "string") facts[name] = scrub(value, SHAPING_LIMITS.factValueChars);
        else if (Array.isArray(value)) facts[name] = value.map((item) => (typeof item === "string" ? scrub(item, SHAPING_LIMITS.factValueChars) : item));
      }
    }
  }
  // The reply's own notes are left as written: a reply that was valid stays valid. The drops are
  // returned beside it for the engine to record.
  return { data: root, redacted, notes };
}

/**
 * `text` with every occurrence of every resolved value replaced by `[NAME redacted]`, found on
 * the original text first so overlapping values are removed over their combined span. For a
 * failure reason or any diagnostic built from what a shaper wrote. Not bounded: redact the
 * whole text first and only then cut it, so a cut cannot split a value into a fragment no
 * search recognises.
 */
export function redactResolved(text: string, resolved: readonly ResolvedValue[]): string {
  const values = resolved.filter(({ value }) => value.length > 0);
  if (values.length === 0) return text;
  return redactSpans(text, targets(values), markerFor(values).render, 0, Number.POSITIVE_INFINITY, variantSpans(text, values));
}

/** Whether `text` holds any resolved value, which `redactResolved` would remove. */
export function holdsResolvedValue(text: string, resolved: readonly ResolvedValue[]): boolean {
  return resolved.some((value) => holdsOne(text, value));
}

/** A failure reason scrubbed of every resolved value, and whether anything was removed. */
export function scrubReason(reason: string, resolved: readonly ResolvedValue[]): { reason: string; redacted: boolean } {
  return holdsResolvedValue(reason, resolved)
    ? { reason: redactResolved(reason, resolved), redacted: true }
    : { reason, redacted: false };
}
