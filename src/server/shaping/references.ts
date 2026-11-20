import { SHAPING_LIMITS, ShapingResultSchema, type ShapingConfig, type ShapingReferenceStatus } from "@shared/shaping.ts";
import { redactSpans } from "./redaction.ts";

/**
 * Whether each `{env:NAME}` a shaper references is set in the daemon's environment, never its
 * value. Resolution arrives with the remote transports; until then nothing is reported, and
 * `GET /api/shaping` already carries the field.
 */
export function referenceStatus(_config: ShapingConfig): ShapingReferenceStatus {
  return {};
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

/** A secret a transport handed a shaper, and the name it is reported under. */
export interface ResolvedValue {
  name: string;
  value: string;
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
  return redactSpans(text, resolved.map(({ name, value }) => ({ value, wholeToken: false, label: name })),
    marker.render, 0, text.length <= limit ? limit : limit + 1);
}

function holdsResolved(text: string, resolved: readonly ResolvedValue[]): ResolvedValue | undefined {
  return resolved.find(({ value }) => text.includes(value));
}

/**
 * A shaper cannot hand a value back. Every occurrence of a value the transport handed it is
 * replaced with `[NAME redacted]` in every field of a decoded reply the engine reads: entry ids,
 * paths, titles and bodies, the summary, fact values, notes, the version and an error. Fields the
 * result schema does not define are skipped, because the engine discards them unread. Keys the
 * schema defines are never changed. An otherwise valid entry whose id, or fact whose name,
 * contains such a value is dropped instead of renamed, so redaction can never merge two entries
 * or two facts, and the drop is returned as a note beside the reply. Drops happen only when the
 * reply is valid as written: an invalid reply is kept, scrubbed, so the engine still refuses it
 * rather than reporting a reply that only a drop made valid.
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
  // A drop changes what validation sees: a reply with one entry too many would pass once an entry
  // is dropped. So entries and facts are dropped only from a reply that is valid as written; an
  // invalid one is only scrubbed, and the engine refuses it as the shaper sent it.
  const valid = ShapingResultSchema.safeParse(data).success;
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
      if (hit && valid) {
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
        if (hit && valid) {
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
