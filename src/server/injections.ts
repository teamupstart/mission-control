import { createHash } from "node:crypto";
import type { TurnOrigin } from "@shared/types.ts";

/**
 * Who typed a given user turn - the one fact the transcript file cannot carry.
 *
 * Several non-human paths drive a session by typing into its pane: Foreman delivering work
 * items and recovery packets, workflow repair and evidence-preflight delivery, the retro
 * packet, the SDK's restart continuation, and this daemon broadcasting `/reload-skills`.
 * They land in the JSONL as ordinary user turns, byte-identical in shape to the ones a
 * person types, so a reader is told they asked for work they never asked for. Round 0 of a
 * work item is the human's intent delivered VERBATIM (see `payloadFor`), so there is nothing
 * to pattern-match on and nothing may be prepended: the agent must see the ask as written.
 * The only moment authorship is known is the moment of delivery, here in the daemon - so
 * that's where it's recorded, and the log reads it back by matching text.
 *
 * TWO readers now, and the second is why a missing `recordInjection` is worse than a
 * mislabelled log line. `Registry.captureHookGoalPrompt` asks the same question of every
 * prompt event, because the agent echoes a delivered packet straight back to its prompt hook
 * and nothing in that echo says who wrote it. A sender that does not report here has its
 * packet captured as the session's Goal, frozen onto the next workflow run, and handed to
 * the review as "Original user goal".
 *
 * Deliberately in-memory and unpersisted. This colours a LIVE conversation the human is
 * watching; a restart forgets who typed what, and those turns fall back to reading as the
 * human's own - the same thing they read as before this existed. Persisting it would mean
 * a schema, a migration and an eviction policy for a label on a log line. The Goal reader
 * inherits that trade knowingly: a restart landing between a delivery and its echo lets one
 * packet through, which is the same window the log already has and is bounded by the tick it
 * happened in.
 *
 * That trade is right for a label and wrong for an ARCHIVE, which is what `observeInjections`
 * is for. A scout's prompt trail outlives this process, so a turn that read as automation
 * before a restart and as the human's own after it would be published as something the
 * operator wrote. The observer is how a delivery reaches the durable, scout-scoped journal
 * without this module learning what a scout is.
 */

/**
 * One remembered delivery: who typed it, and how many echoes of it are still owed.
 *
 * The count is what separates the module's two readers. A LABEL is permanent - the turn in
 * the log was typed by Foreman forever, and scrolling back to it a week later must still say
 * so. A SUPPRESSION is single-use: one delivery produces exactly one prompt-hook echo, and
 * once that echo has been accounted for, the next arrival of the same text is somebody
 * retyping it. Only the human can do that, and swallowing it would leave them unable to
 * change the Goal by saying the same thing twice.
 */
interface RememberedInjection {
  origin: TurnOrigin;
  /** Echoes delivered and not yet claimed by the Goal path. Incremented per delivery. */
  pending: number;
  /**
   * Whether any delivery of this text is known to have LANDED.
   *
   * A reservation is a claim about a send that has not happened, so it can be taken back. A
   * confirmed delivery cannot: that turn is in the conversation forever, and the log asks who
   * typed it every time it renders. Without this bit a release could not tell "undo the
   * reservation I just made" from "nothing about this text was ever delivered", and a refused
   * RETRY of a text that landed earlier - the restart continuation is a fixed string, so it
   * retries verbatim - would erase the earlier turn's label and hand it back to the human.
   */
  delivered: boolean;
}

/** Fingerprint -> who typed it, per session. Collision-resistant hashes rather than the payloads themselves:
 *  a fix prompt runs to kilobytes, and this only ever answers "was this text ours, and
 *  whose?" - never "what did we say?". */
const seen = new Map<string, Map<string, RememberedInjection>>();

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
  return createHash("sha256").update(text.trim()).digest("base64");
}

/** Told about every recorded non-human delivery, after it is remembered here. */
export type InjectionObserver = (sessionId: string, text: string, origin: TurnOrigin) => void;

let observer: InjectionObserver | null = null;

/**
 * Watch every non-human delivery this module is told about. Pass null to stop.
 *
 * One observer on the existing chokepoint rather than a call beside each of the
 * `recordInjection` sites, and the difference is what happens to the NEXT one. Hand-placed
 * journal calls would be invisible when missed, and the thing they would miss is an
 * automated instruction archived as a human's words.
 *
 * This used to argue further that the set of senders stays complete on its own, because a
 * path that forgot would be visibly wrong in the dashboard. It does not. The SDK's restart
 * continuation went unreported for as long as it has existed, read as the operator's own
 * words in every log that carried it, and nobody noticed - a mislabelled line is only wrong
 * if somebody is looking at that line at the time. Adding a sender means adding its
 * `recordInjection`. `test/prompt-authorship.test.ts` pins the goal path's guard, and the
 * restart continuation's own record is pinned in `test/sdk-supervisor.test.ts`.
 *
 * Wired once by the daemon. It is deliberately not an injected dependency of this module's
 * callers: `workflows/manager.ts` and `retro.ts` already take `recordInjection` itself as a
 * dep, so threading a second one through them would let a caller wire the label without the
 * journal - the exact pair that must not come apart.
 */
export function observeInjections(fn: InjectionObserver | null): void {
  observer = fn;
}

/** Write the label and count one owed echo. `landed` marks the label permanent. */
function remember(sessionId: string, text: string, origin: TurnOrigin, landed: boolean): void {
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
  const prior = byText.get(key);
  byText.delete(key);
  byText.set(key, {
    origin,
    pending: (prior?.pending ?? 0) + 1,
    // Sticky: one confirmed delivery makes the label permanent for every later reservation
    // of the same text, which is what stops a refused retry from erasing it.
    delivered: (prior?.delivered ?? false) || landed,
  });
  while (byText.size > PER_SESSION) {
    const oldest = byText.keys().next();
    if (oldest.done) break;
    byText.delete(oldest.value);
  }
}

/**
 * Claim authorship BEFORE attempting the delivery it describes.
 *
 * The agent's prompt hook can fire while the send is still in flight - the driver hands the
 * turn over, the agent submits it, and the hook reaches the daemon before the caller's
 * `await` has resolved. Recording afterwards therefore leaves a window in which the echo
 * arrives with no authorship on file and is captured as the human's Goal, which is the exact
 * substitution the record exists to prevent. Reserve first; call `releaseInjection` when the
 * delivery is known not to have landed.
 *
 * Deliberately does NOT notify the observer. A reservation is a claim about a send that has
 * not happened yet, and the durable journal must archive turns that exist rather than turns
 * that were attempted - so the journal waits for `recordInjection` to confirm.
 */
export function reserveInjection(sessionId: string, text: string, origin: TurnOrigin): void {
  remember(sessionId, text, origin, false);
}

/**
 * Give a reservation back, for a delivery that provably did not land.
 *
 * Only for POSITIVE evidence that nothing was delivered. An ambiguous outcome keeps its
 * reservation: an echo that may still arrive must find authorship on file, and the cost of
 * being wrong in that direction is one suppressed retype rather than a review judged against
 * this daemon's own words.
 */
export function releaseInjection(sessionId: string, text: string): void {
  const byText = seen.get(sessionId);
  if (!byText) return;
  const key = injectionFingerprint(text);
  const prior = byText.get(key);
  if (!prior) return;
  if (prior.pending > 1) {
    byText.set(key, { ...prior, pending: prior.pending - 1 });
    return;
  }
  // Give back only what this reservation added. A text that has landed before keeps its
  // label with nothing owed: the earlier turn is still in the conversation, and answering
  // `undefined` for it would re-attribute machine-typed words to the operator.
  if (prior.delivered) {
    byText.set(key, { ...prior, pending: 0 });
    return;
  }
  byText.delete(key);
  // And drop the session with its last delivery. This is the only path that can empty a
  // session's map - before releases existed, an entry here always held at least one
  // fingerprint - and an empty one still occupies a slot against `SESSIONS`. Left behind,
  // enough refused deliveries push the ceiling over on dead weight and evict a LIVE session
  // that still has a claim outstanding, whose next daemon echo then becomes the human's Goal.
  // That is the failure this whole module exists to prevent, arrived at through its own
  // bookkeeping.
  if (byText.size === 0) seen.delete(sessionId);
}

/**
 * Hand the delivery to the durable journal, after the live label and never instead of it.
 *
 * An observer that threw would otherwise be able to stop a delivery being attributed in the
 * conversation the operator is watching, and a durable journal is not worth that: a scout with
 * no prompt row publishes a truncated trail, while a session with no label misreads automation
 * as a person.
 */
function notifyObserver(sessionId: string, text: string, origin: TurnOrigin): void {
  try {
    observer?.(sessionId, text, origin);
  } catch {
    /* a journal that cannot write must not break the delivery it was told about */
  }
}

/** Remember that `origin` - not the human - typed `text` into this session. */
export function recordInjection(sessionId: string, text: string, origin: TurnOrigin): void {
  remember(sessionId, text, origin, true);
  notifyObserver(sessionId, text, origin);
}

/**
 * Settle a delivery this caller already reserved: journal it, and change nothing else.
 *
 * The reservation already wrote the label and already counted this send's one echo - which by
 * now may even have been spent, because the whole point of reserving early is that the echo
 * can arrive before the send resolves. So confirmation deliberately does NOT remember again.
 * Doing so would owe a second echo for a single delivery, and the surplus would be spent
 * silencing the next turn the human typed that happened to repeat the text. All that is left
 * to do is the journal entry the reservation withheld until the send was real.
 */
export function confirmReservedInjection(
  sessionId: string,
  text: string,
  origin: TurnOrigin,
): void {
  // The one thing it changes about the entry: this send really happened, so the label is now
  // permanent and no later release may take it away. The echo count is deliberately untouched
  // - the reservation already counted it, and by now it may already have been spent.
  const prior = seen.get(sessionId)?.get(injectionFingerprint(text));
  if (prior) prior.delivered = true;
  notifyObserver(sessionId, text, origin);
}

/**
 * Spend one owed echo for this text, answering who typed it.
 *
 * The Goal path's reader, and the reason a delivery is counted rather than merely labelled.
 * One delivery earns one suppression: the echo the agent is about to report. After that the
 * count is zero and the same text arriving again is somebody typing it, which only the human
 * can be doing - so it is captured as the instruction it is. A human who scrolls back, copies
 * a packet out of the transcript and sends it again to redirect the session is heard.
 *
 * `originOf` deliberately stays non-consuming beside this. The conversation log asks the same
 * question about the same turn every time it renders, and an answer that decayed on first read
 * would relabel automation as the operator on the second scroll past it.
 */
export function claimInjectionEcho(sessionId: string, text: string): TurnOrigin | undefined {
  const byText = seen.get(sessionId);
  const prior = byText?.get(injectionFingerprint(text));
  if (!prior || prior.pending <= 0) return undefined;
  prior.pending -= 1;
  return prior.origin;
}

/** Who typed this exact text into this session, or undefined for "the human, as far as
 *  we know" - the answer that leaves a turn reading the way it always has. Non-consuming:
 *  see `claimInjectionEcho` for why the two readers cannot share one answer. */
export function originOf(sessionId: string, text: string): TurnOrigin | undefined {
  return seen.get(sessionId)?.get(injectionFingerprint(text))?.origin;
}

/** Forget a session's deliveries. For tests, and for a reset that clears the context. */
export function forgetInjections(sessionId?: string): void {
  if (sessionId === undefined) seen.clear();
  else seen.delete(sessionId);
}
