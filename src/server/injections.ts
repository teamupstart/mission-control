import { createHash } from "node:crypto";
import type { TurnOrigin } from "@shared/types.ts";

/**
 * Who typed a given user turn - the one fact the transcript file cannot carry.
 *
 * Two things drive a session by typing into its pane: Foreman, delivering work items,
 * and this daemon itself, broadcasting `/reload-skills`. Both land in the JSONL as
 * ordinary user turns, byte-identical in shape to the ones a person types, so a reader
 * is told they asked for work they never asked for. Round 0 of a work item is the
 * human's intent delivered VERBATIM (see `payloadFor`), so there is nothing to
 * pattern-match on and nothing may be prepended: the agent must see the ask as written.
 * The only moment authorship is known is the moment of delivery, here in the daemon - so
 * that's where it's recorded, and the log reads it back by matching text.
 *
 * Deliberately in-memory and unpersisted. This colours a LIVE conversation the human is
 * watching; a restart forgets who typed what, and those turns fall back to reading as the
 * human's own - the same thing they read as before this existed. Persisting it would mean
 * a schema, a migration and an eviction policy for a label on a log line.
 */

/** Fingerprint -> who typed it, per session. Hashes rather than the payloads themselves:
 *  a fix prompt runs to kilobytes, and this only ever answers "was this text ours, and
 *  whose?" - never "what did we say?". */
const seen = new Map<string, Map<string, TurnOrigin>>();

/**
 * Deliveries remembered per session. A session's whole visible transcript is a few dozen
 * turns, and only a fraction are ours, so this holds far more than a reader can see - and
 * an item re-sent across fix rounds is a fresh entry each time.
 */
const PER_SESSION = 200;

/**
 * Sessions tracked at once. The map is only ever added to (a session that ends is never
 * announced here), so it needs its own ceiling or a long-lived daemon accumulates one
 * entry per session it has ever driven.
 */
const SESSIONS = 500;

function fingerprint(text: string): string {
  // Trimmed: the pane gets exactly what was passed, but a turn's recorded text has been
  // through `conversationText` and a trim on the way back out.
  return createHash("sha1").update(text.trim()).digest("base64");
}

/** Remember that `origin` - not the human - typed `text` into this session. */
export function recordInjection(sessionId: string, text: string, origin: TurnOrigin): void {
  let byText = seen.get(sessionId);
  if (!byText) {
    // Insertion order is the Map's own, so the first key is the least recently STARTED
    // session. Good enough for a ceiling nobody should reach.
    if (seen.size >= SESSIONS) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    byText = new Map();
    seen.set(sessionId, byText);
  }
  // Re-inserting moves a repeated payload to the back, so an instruction that keeps being
  // re-sent can't be the one evicted for being "old".
  const key = fingerprint(text);
  byText.delete(key);
  byText.set(key, origin);
  while (byText.size > PER_SESSION) {
    const oldest = byText.keys().next();
    if (oldest.done) break;
    byText.delete(oldest.value);
  }
}

/** Who typed this exact text into this session, or undefined for "the human, as far as
 *  we know" - the answer that leaves a turn reading the way it always has. */
export function originOf(sessionId: string, text: string): TurnOrigin | undefined {
  return seen.get(sessionId)?.get(fingerprint(text));
}

/** Forget a session's deliveries. For tests, and for a reset that clears the context. */
export function forgetInjections(sessionId?: string): void {
  if (sessionId === undefined) seen.clear();
  else seen.delete(sessionId);
}
