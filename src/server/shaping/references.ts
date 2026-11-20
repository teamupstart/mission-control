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
import { redactSpans } from "./redaction.ts";
import { carriedEnvName } from "./transports/carriers.ts";

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

/** The value one reference resolves to, or null. An empty value is unresolved. */
function resolveOne(reference: string, ctx: ReferenceContext, token: string): string | null {
  switch (reference) {
    case "caller.user": return ctx.caller.user || null;
    case "caller.agent": return ctx.caller.agent || null;
    case "caller.conversation": return ctx.caller.conversation || null;
  }
  if (!reference.startsWith("env:")) return null;
  const name = reference.slice(4);
  if (NEVER_PASSED_ENV_NAMES.has(name)) return null;
  const value = (ctx.env ?? process.env)[name];
  if (!value) return null;
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
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(values)) {
    out[key] = text.replace(/\{([^{}]*)\}/g, (_whole, inner: string) => {
      const value = resolveOne(inner, ctx, token);
      if (value === null) {
        if (!missing.includes(spelled(inner))) missing.push(spelled(inner));
        return "";
      }
      // An environment value is reported under its variable's name, a caller value under its own.
      resolved.set(inner.startsWith("env:") ? inner.slice(4) : inner, value);
      return value;
    });
  }
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
  const headers = transport.type === "http"
    ? transport.headers
    : transport.type === "mcp" && transport.server.type === "http" ? transport.server.headers : {};
  const names: string[] = [];
  for (const value of Object.values(headers)) {
    for (const reference of shapingReferences(value) ?? []) {
      if (reference.startsWith("env:") && !names.includes(reference.slice(4))) names.push(reference.slice(4));
    }
  }
  return names;
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
 * A name no reference may resolve, such as Mission Control's own token, is always `unset`, as a
 * call would find it.
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
  const status: ShapingReferenceStatus = {};
  for (const name of [...new Set(shapers.flatMap(shaperEnvironmentNames))].sort()) {
    status[name] = resolveOne(`env:${name}`, { caller: { user: null, agent: null, conversation: null }, env }, token) === null ? "unset" : "set";
  }
  return status;
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
 * The pattern that finds a value written with other whitespace where it has some, such as
 * `Jane   Doe` or `Jane\nDoe` for `Jane Doe`, or null when the value has no inner whitespace.
 * Collapsing whitespace, as a section heading and a recorded reason do, turns such a spelling
 * back into the value, so it is a copy of the value and is found as one.
 */
function spacingPattern(value: string): RegExp | null {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return new RegExp(parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g");
}

/** Every spacing variant of a resolved value that `text` holds, as a literal value under its name. */
function spacingVariants(text: string, resolved: readonly ResolvedValue[]): ResolvedValue[] {
  const out: ResolvedValue[] = [];
  for (const entry of resolved) {
    const pattern = spacingPattern(entry.value);
    if (!pattern) continue;
    for (const match of text.matchAll(pattern)) {
      if (match[0] !== entry.value) out.push({ name: entry.name, value: match[0] });
    }
  }
  return out;
}

function holdsOne(text: string, resolved: ResolvedValue): boolean {
  if (resolved.value.length === 0) return false;
  if (text.includes(resolved.value)) return true;
  const pattern = spacingPattern(resolved.value);
  return pattern !== null && pattern.test(text);
}

/** What to remove from `text`: every value, and every spacing variant of one that `text` holds. */
function targets(resolved: readonly ResolvedValue[], text: string) {
  return [...resolved, ...spacingVariants(text, resolved)].map(({ name, value }) => ({ value, wholeToken: false, label: name }));
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

/**
 * Every occurrence of every resolved value, found on the original text and merged where values
 * overlap, so replacing one can never hide part of another from a later pass. The result is
 * bounded as it is built: a field within its limit stays within it, and a field already over
 * it stays just over it, for the schema to refuse, without growing further.
 */
function replaceResolved(text: string, resolved: readonly ResolvedValue[], limit: number, marker: Marker): string {
  return redactSpans(text, targets(resolved, text), marker.render, 0, text.length <= limit ? limit : limit + 1);
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
  return redactSpans(text, targets(values, text), markerFor(values).render);
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
