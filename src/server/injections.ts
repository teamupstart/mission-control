import { createHash } from "node:crypto";
import type { TurnOrigin } from "@shared/types.ts";

/**
 * Who typed a given user turn - the one fact the transcript file cannot carry.
 *
 * Three non-human paths drive a session by typing into its pane: Foreman delivering work
 * items, workflow repair delivery, and this daemon broadcasting `/reload-skills`. They land in the JSONL as
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
 *
 * That trade is right for a label and wrong for an ARCHIVE, which is what `observeInjections`
 * is for. A scout's prompt trail outlives this process, so a turn that read as automation
 * before a restart and as the human's own after it would be published as something the
 * operator wrote. The observer is how a delivery reaches the durable, scout-scoped journal
 * without this module learning what a scout is.
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

export function injectionFingerprint(text: string): string {
  // Trimmed: the pane gets exactly what was passed, but a turn's recorded text has been
  // through `conversationText` and a trim on the way back out.
  return createHash("sha1").update(text.trim()).digest("base64");
}

/** Told about every recorded non-human delivery, after it is remembered here. */
export type InjectionObserver = (sessionId: string, text: string, origin: TurnOrigin) => void;

let observer: InjectionObserver | null = null;

/**
 * Watch every non-human delivery this module is told about. Pass null to stop.
 *
 * One observer on the existing chokepoint rather than a call beside each of the five
 * `recordInjection` sites, and the difference is what happens to the SIXTH. Every
 * non-human path that exists - the inject route, two workflow delivery points, the skills
 * broadcast, the retro packet - already reports here because reporting here is what makes
 * the turn read as automation in the live log. A path that forgot would be visibly wrong
 * in the dashboard, so the set stays complete on its own; hand-placed journal calls would
 * be invisible when missed, and the thing they would miss is an automated instruction
 * archived as a human's words.
 *
 * Wired once by the daemon. It is deliberately not an injected dependency of this module's
 * callers: `workflows/manager.ts` and `retro.ts` already take `recordInjection` itself as a
 * dep, so threading a second one through them would let a caller wire the label without the
 * journal - the exact pair that must not come apart.
 */
export function observeInjections(fn: InjectionObserver | null): void {
  observer = fn;
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
  const key = injectionFingerprint(text);
  byText.delete(key);
  byText.set(key, origin);
  while (byText.size > PER_SESSION) {
    const oldest = byText.keys().next();
    if (oldest.done) break;
    byText.delete(oldest.value);
  }
  // After the live label, never instead of it. An observer that threw would otherwise be
  // able to stop a delivery being attributed in the conversation the operator is watching,
  // and a durable journal is not worth that: a scout with no prompt row publishes a
  // truncated trail, while a session with no label misreads automation as a person.
  try {
    observer?.(sessionId, text, origin);
  } catch {
    /* a journal that cannot write must not break the delivery it was told about */
  }
}

/** Who typed this exact text into this session, or undefined for "the human, as far as
 *  we know" - the answer that leaves a turn reading the way it always has. */
export function originOf(sessionId: string, text: string): TurnOrigin | undefined {
  return seen.get(sessionId)?.get(injectionFingerprint(text));
}

/** Forget a session's deliveries. For tests, and for a reset that clears the context. */
export function forgetInjections(sessionId?: string): void {
  if (sessionId === undefined) seen.clear();
  else seen.delete(sessionId);
}
