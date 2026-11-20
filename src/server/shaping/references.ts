import { SHAPING_LIMITS, type ShapingConfig, type ShapingReferenceStatus } from "@shared/shaping.ts";

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

/** What `scrubResolved` returns: the reply with every resolved value gone, and whether it found any. */
export interface ScrubbedReply {
  data: unknown;
  redacted: boolean;
}

function replaceResolved(text: string, resolved: readonly ResolvedValue[]): string {
  let out = text;
  for (const { name, value } of resolved) {
    if (out.includes(value)) out = out.split(value).join(`[${name} redacted]`);
  }
  return out;
}

function holdsResolved(text: string, resolved: readonly ResolvedValue[]): ResolvedValue | undefined {
  return resolved.find(({ value }) => text.includes(value));
}

/**
 * A shaper cannot hand a value back. Every occurrence of a value the transport handed it is
 * replaced with `[NAME redacted]` in every string of a decoded reply: entry paths, titles and
 * bodies, the summary, fact values, notes, the version and an error. Keys the result schema
 * defines are never changed. An entry whose id, or a fact whose name, contains such a value is
 * dropped with a note instead of renamed, so redaction can never merge two entries or two facts.
 *
 * The walk is iterative, so no nesting the reply could carry overflows the stack, and it
 * rewrites the freshly decoded value in place. A reply that is not a JSON object is left alone:
 * the engine refuses it without recording any of its text.
 */
export function scrubResolved(data: unknown, resolved: readonly ResolvedValue[]): ScrubbedReply {
  const values = resolved.filter(({ value }) => value.length > 0).sort((a, b) => b.value.length - a.value.length);
  if (values.length === 0 || data === null || typeof data !== "object") return { data, redacted: false };
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
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      node.forEach((item, at) => {
        if (typeof item === "string") {
          const next = replaceResolved(item, values);
          if (next !== item) { node[at] = next; redacted = true; }
        } else if (item && typeof item === "object") {
          pending.push(item);
        }
      });
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        if (typeof item === "string") {
          const next = replaceResolved(item, values);
          if (next !== item) { record[key] = next; redacted = true; }
        } else if (item && typeof item === "object") {
          pending.push(item);
        }
      }
    }
  }
  // A drop's note joins the reply's own notes only while they stay within the result schema's
  // bound: a reply that was valid must not become invalid because something was removed from
  // it. The record's `redacted` mark says so either way.
  if (notes.length > 0) {
    const own = Array.isArray(root.notes) ? root.notes : [];
    const room = Math.max(0, SHAPING_LIMITS.replyNotes - own.length);
    if (room > 0) root.notes = [...own, ...notes.slice(0, room)];
  }
  return { data: root, redacted };
}
