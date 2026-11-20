import { SHAPING_LIMITS, type ShapingConfig, type ShapingReferenceStatus } from "@shared/shaping.ts";
import { redactSpans } from "./redaction.ts";

/**
 * Whether each `{env:NAME}` a shaper references is set in the daemon's environment, never its
 * value. Resolution arrives with the remote transports; until then nothing is reported, and
 * `GET /api/shaping` already carries the field.
 */
export function referenceStatus(_config: ShapingConfig): ShapingReferenceStatus {
  return {};
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

/**
 * Every occurrence of every resolved value, found on the original text and merged where values
 * overlap, so replacing one can never hide part of another from a later pass.
 */
function replaceResolved(text: string, resolved: readonly ResolvedValue[], limit: number | undefined): string {
  const next = redactSpans(text, resolved.map(({ name, value }) => ({ value, wholeToken: false, label: name })),
    (labels) => `[${labels.join(", ")} redacted]`);
  // `[NAME redacted]` can be longer than the value it replaced. A field the result schema bounds
  // is cut back to that bound, so a reply that was valid never becomes invalid because something
  // was removed from it. Only the tail is cut, and nothing of the value is left in it. A field
  // within its bound is left whole.
  return limit !== undefined && next.length > limit ? next.slice(0, limit) : next;
}

/**
 * The result schema's bound on the string at `path`, or undefined for a field it does not bound
 * or does not define. Read from `SHAPING_LIMITS`, the same constants the schema reads.
 */
function fieldLimit(path: readonly (string | number)[]): number | undefined {
  const [first, second, third] = path;
  if (first === "version" && path.length === 1) return SHAPING_LIMITS.versionChars;
  if (first === "notes" && path.length === 2) return SHAPING_LIMITS.replyNoteChars;
  if (first === "guidance" && path.length === 3) {
    if (third === "title") return SHAPING_LIMITS.entryTitleChars;
    if (third === "path") return SHAPING_LIMITS.entryPathChars;
    if (third === "id") return SHAPING_LIMITS.entryIdChars;
    if (third === "body") return SHAPING_LIMITS.replyText;
  }
  if (first === "repo" && second === "summary" && path.length === 2) return SHAPING_LIMITS.replyText;
  if (first === "repo" && second === "facts" && (path.length === 3 || path.length === 4)) return SHAPING_LIMITS.factValueChars;
  return undefined;
}

function holdsResolved(text: string, resolved: readonly ResolvedValue[]): ResolvedValue | undefined {
  return resolved.find(({ value }) => text.includes(value));
}

/**
 * A shaper cannot hand a value back. Every occurrence of a value the transport handed it is
 * replaced with `[NAME redacted]` in every string of a decoded reply: entry paths, titles and
 * bodies, the summary, fact values, notes, the version and an error. Keys the result schema
 * defines are never changed. An entry whose id, or a fact whose name, contains such a value is
 * dropped instead of renamed, so redaction can never merge two entries or two facts, and the
 * drop is returned as a note beside the reply.
 *
 * The walk is iterative, so no nesting the reply could carry overflows the stack, and it
 * rewrites the freshly decoded value in place. A reply that is not a JSON object is left alone:
 * the engine refuses it without recording any of its text.
 */
export function scrubResolved(data: unknown, resolved: readonly ResolvedValue[]): ScrubbedReply {
  const values = resolved.filter(({ value }) => value.length > 0).sort((a, b) => b.value.length - a.value.length);
  if (values.length === 0 || data === null || typeof data !== "object") return { data, redacted: false, notes: [] };
  let redacted = false;
  const notes: string[] = [];
  const root = data as Record<string, unknown>;
  if (Array.isArray(root.guidance)) {
    root.guidance = root.guidance.filter((entry) => {
      const id = (entry as { id?: unknown } | null)?.id;
      const hit = typeof id === "string" ? holdsResolved(id, values) : undefined;
      if (hit) notes.push(`An entry was dropped because its id contained the value of ${hit.name}.`);
      return !hit;
    });
  }
  const repo = root.repo as { facts?: unknown } | undefined;
  if (repo && typeof repo === "object" && repo.facts && typeof repo.facts === "object" && !Array.isArray(repo.facts)) {
    const facts = repo.facts as Record<string, unknown>;
    for (const name of Object.keys(facts)) {
      const hit = holdsResolved(name, values);
      if (!hit) continue;
      delete facts[name];
      notes.push(`A fact was dropped because its name contained the value of ${hit.name}.`);
    }
  }
  if (notes.length > 0) redacted = true;
  // Each node carries its path, so a replaced string can be held to its field's bound. The
  // path is kept only to the depth the result schema defines; below that no field is bounded.
  const pending: Array<{ node: unknown; path: readonly (string | number)[] }> = [{ node: root, path: [] }];
  const child = (path: readonly (string | number)[], key: string | number) => (path.length < 4 ? [...path, key] : path);
  while (pending.length > 0) {
    const { node, path } = pending.pop()!;
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const keys = Array.isArray(node) ? node.map((_, at) => at) : Object.keys(record);
    for (const key of keys) {
      const item = (record as Record<string | number, unknown>)[key];
      const at = child(path, key);
      if (typeof item === "string") {
        const next = replaceResolved(item, values, at.length === path.length + 1 ? fieldLimit(at) : undefined);
        if (next !== item) { (record as Record<string | number, unknown>)[key] = next; redacted = true; }
      } else if (item && typeof item === "object") {
        pending.push({ node: item, path: at });
      }
    }
  }
  // The reply's own notes are left as written: a reply that was valid stays valid. The drops are
  // returned beside it for the engine to record.
  return { data: root, redacted, notes };
}
