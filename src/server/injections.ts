import { createHash } from "node:crypto";
import type { TurnOrigin, WorkCycleSummary } from "@shared/types.ts";

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
 * callers: `workflows/manager.ts` and `retro.ts` take their authorship calls as deps already,
 * so threading a second one through them would let a caller wire the label without the
 * journal - the exact pair that must not come apart.
 *
 * EVERY sender reserves before it writes and settles afterwards. `recordInjection` on its own
 * is for a delivery whose write has already completed by the time authorship is known; a
 * sender that is about to write wants `reserveInjection`, because the prompt hook can report
 * the text back before its own send resolves. The five that write are the `/inject` route,
 * the workflow manager's delivery, the retro packet, the skills broadcast and the SDK restart
 * continuation.
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
    // A landed delivery owns the label; a mere RESERVATION may not take it. Two senders can
    // put byte-identical text into one session, and a reservation that is later refused would
    // otherwise leave the earlier, genuinely delivered turn credited to whoever merely tried
    // to send it next. A new delivery that lands does update it, which is the behaviour this
    // had before reservations existed.
    origin: prior?.delivered && !landed ? prior.origin : origin,
    pending: (prior?.pending ?? 0) + 1,
    // Sticky: one confirmed delivery makes the label permanent for every later reservation
    // of the same text, which is what stops a refused retry from erasing it.
    delivered: (prior?.delivered ?? false) || landed,
  });
  while (byText.size > PER_SESSION) {
    // Spend the ceiling on entries that have nothing left to answer for. An entry with an
    // echo still owed is the only kind whose loss is a DEFECT rather than forgetting: the
    // agent is about to report that text back, and with no claim on file the Goal path reads
    // it as the operator's own instruction, which is the substitution this module exists to
    // prevent. Insertion order still decides among equals, so this stays oldest-first within
    // the settled entries.
    let victim: string | null = null;
    for (const [candidate, entry] of byText) {
      if (entry.pending > 0) continue;
      victim = candidate;
      break;
    }
    // Every entry is still owed an echo. That is pathological rather than ordinary - a
    // session's deliveries are serialized and each is echoed within moments - and the ceiling
    // has to hold regardless, so the oldest goes. Bounded forgetting beats an unbounded map.
    if (victim === null) {
      const oldest = byText.keys().next();
      if (oldest.done) break;
      victim = oldest.value;
    }
    byText.delete(victim);
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

// ---- the human's own follow-ups, expected back from the prompt hook ----

/**
 * A human follow-up sent to an Agent SDK session, waiting for its prompt-hook echo.
 *
 * The other half of the same problem, with the opposite answer. A daemon-typed packet must
 * never reach the Goal; a human follow-up must reach it exactly ONCE, and it has two doors
 * that each see it. The send's own acknowledgement captures it (`SdkSupervisor.send` for a
 * direct `/send`, `PendingTurnManager.deliverSdk` for the composer outbox), and then the
 * agent's prompt hook reports the same text back to `Registry.captureHookGoalPrompt`. Each is
 * an accepted human instruction by every test available at its door, so before this each
 * opened a prompt revision, and the second was classified against a conversation that had
 * already moved on.
 *
 * One entry per SEND, never per text. A retype of the same words is its own send with its
 * own entry, so it is captured by its own door like any other follow-up: a person repeating
 * an instruction is heard. Entries for one text answer echoes oldest first, the order the
 * driver received them in.
 *
 * States, in the order a send moves through them:
 *
 * - `open`: about to be handed to the driver, not acknowledged yet. The hook may already
 *   fire, because Claude submits the turn before the send's promise resolves.
 * - `confirmed`: acknowledged, and no door has captured it.
 * - `captured`: one door's `captureAcceptedPrompt` returned a goal. `markHumanEchoCaptured`
 *   is the only way here, and every door calls it AFTER its capture succeeded, never before:
 *   a door that marked first and then failed to write would leave the other door skipping a
 *   turn that was never recorded.
 *
 * `echoed` is separate from the state because the two doors finish in either order. An entry
 * whose echo the hook already used must not answer a LATER echo of the same text - that one
 * belongs to the next send - so a claim passes over it.
 *
 * Lifetime is the turn the send belongs to. `turnGeneration` is that turn's work-cycle
 * generation: the conversation's completed generation plus one for an idle session, plus two
 * when a cycle is active at the send, because the driver queues it behind the running turn
 * and Claude fires its prompt hook only once it dequeues it, after that turn's Stop. An
 * acknowledged entry expires when its own turn completes (`expireHumanEchoes`), never at the
 * end of the turn it was queued behind; an unacknowledged one waits for the driver's answer,
 * because until then the stamp is the registry's guess. Once its turn is the next one it is ELIGIBLE, and from then on it also
 * ages out after `HUMAN_ECHO_TTL_MS`, for a session that never finishes a turn. Age is read
 * lazily on every access, so no timer exists.
 *
 * In memory, like the authorship ledger, for the same reason and with the same trade: a
 * restart between a delivery and its echo lets one duplicate revision through.
 */
interface ExpectedHumanEcho {
  readonly sessionId: string;
  /** `injectionFingerprint` of the sent text. */
  readonly key: string;
  /**
   * The conversation the send was accepted into. A clear starts a different one. A launch-window
   * follow-up is registered under the session id and re-keyed when the conversation binds
   * (`rekeyHumanEchoes`).
   */
  noteKey: string;
  /** The conversation's completed work-cycle generation when the send was made. */
  readonly baseGeneration: number;
  turnGeneration: number;
  /**
   * The latest completed generation seen for this conversation. Recorded even while the entry
   * is `open`, because a completion can arrive before the driver says which turn the send
   * belongs to, and the acknowledgement settles the entry against it.
   */
  completedGeneration: number;
  /** When this entry started aging: its creation for an idle send, else when the turn ahead of it completed. */
  eligibleAt: number | null;
  state: "open" | "confirmed" | "captured";
  echoed: boolean;
}

declare const humanEchoTicket: unique symbol;

/** One send's entry, held by the door that will settle it. Opaque outside this module. */
export type HumanEchoTicket = { readonly [humanEchoTicket]: true };

/** What a prompt-hook echo should do about the follow-ups it might be the echo of. */
export type HumanEchoClaim =
  | { kind: "skip" }
  | { kind: "capture"; ticket: HumanEchoTicket }
  | { kind: "none" };

/**
 * How long an eligible entry waits for its echo.
 *
 * A hook reports a turn within moments of the agent taking it, so this is generous on
 * purpose. It only has to be shorter than the time before a person plausibly re-sends the
 * same words with no send of their own - which on an SDK session cannot happen at all - and
 * long enough that a slow hook is not mistaken for a lost one.
 */
export const HUMAN_ECHO_TTL_MS = 120_000;

/** Session id -> outstanding follow-ups, oldest first. */
const expected = new Map<string, ExpectedHumanEcho[]>();

const asTicket = (entry: ExpectedHumanEcho): HumanEchoTicket => entry as unknown as HumanEchoTicket;
const fromTicket = (ticket: HumanEchoTicket): ExpectedHumanEcho => ticket as unknown as ExpectedHumanEcho;

/** A session's live entries, after dropping every eligible one that has aged out. */
function liveEchoes(sessionId: string, now: number): ExpectedHumanEcho[] | undefined {
  const list = expected.get(sessionId);
  if (!list) return undefined;
  const live = list.filter((e) => e.eligibleAt === null || now - e.eligibleAt <= HUMAN_ECHO_TTL_MS);
  if (live.length === 0) {
    expected.delete(sessionId);
    return undefined;
  }
  if (live.length === list.length) return list;
  expected.set(sessionId, live);
  return live;
}

/** Whether this ticket's entry is still on file once age has been applied. */
function live(entry: ExpectedHumanEcho, now: number): boolean {
  return liveEchoes(entry.sessionId, now)?.includes(entry) ?? false;
}

function drop(entry: ExpectedHumanEcho): void {
  const list = expected.get(entry.sessionId);
  if (!list) return;
  const index = list.indexOf(entry);
  if (index < 0) return;
  list.splice(index, 1);
  if (list.length === 0) expected.delete(entry.sessionId);
}

/** Both doors are done with it: acknowledged, and its echo was the one that captured. */
function settled(entry: ExpectedHumanEcho): boolean {
  return entry.state === "captured" && entry.echoed;
}

/**
 * Register a human follow-up just before the driver is handed it.
 *
 * `cycle` is the session's work cycle as the registry projects it at that moment, which is
 * what decides the turn the send belongs to (see `ExpectedHumanEcho`).
 */
export function expectHumanEcho(
  sessionId: string,
  text: string,
  options: { noteKey: string; cycle: WorkCycleSummary | undefined; now?: number },
): HumanEchoTicket {
  const now = options.now ?? Date.now();
  let list = liveEchoes(sessionId, now);
  if (!list) {
    if (expected.size >= SESSIONS) {
      const oldest = expected.keys().next();
      if (!oldest.done) expected.delete(oldest.value);
    }
    list = [];
    expected.set(sessionId, list);
  }
  const base = options.cycle?.generation ?? 0;
  const queued = options.cycle?.active === true;
  const entry: ExpectedHumanEcho = {
    sessionId,
    key: injectionFingerprint(text),
    noteKey: options.noteKey,
    baseGeneration: base,
    turnGeneration: base + (queued ? 2 : 1),
    completedGeneration: base,
    eligibleAt: queued ? null : now,
    state: "open",
    echoed: false,
  };
  list.push(entry);
  // Oldest first. A session's follow-ups are serialized and each is echoed within moments,
  // so reaching this is pathological; the ceiling holds regardless.
  while (list.length > PER_SESSION) list.shift();
  return asTicket(entry);
}

/**
 * The driver acknowledged this follow-up. Reports whether the hook already captured it, in
 * which case the acknowledging door must not capture it again.
 *
 * `queued` is the driver's own answer that the turn waits behind a running one (`steered`).
 * The registry's projection of the cycle can lag the driver by an event, so a send stamped
 * against an idle session is moved to the turn after the running one - never earlier, which
 * would expire it before its echo.
 *
 * A capture is answered from the ticket, never from whether its entry is still on file. The
 * hook can capture the follow-up and the turn it started can complete, expiring the entry,
 * all before `handle.send` resolves: a quick turn on an idle session does exactly that. The
 * ledger has then forgotten the entry, but the send holding this ticket has not, and reading
 * "gone" as "not captured" would have it record the same turn a second time.
 */
export function confirmHumanEcho(
  ticket: HumanEchoTicket,
  options: { queued?: boolean; now?: number } = {},
): { captured: boolean } {
  const entry = fromTicket(ticket);
  if (!live(entry, options.now ?? Date.now())) return { captured: entry.state === "captured" };
  const now = options.now ?? Date.now();
  if (entry.state === "open") entry.state = "confirmed";
  if (options.queued && entry.turnGeneration < entry.baseGeneration + 2) {
    entry.turnGeneration = entry.baseGeneration + 2;
    // The turn ahead of it may already have completed while this send was unacknowledged;
    // then it is next, and ages from now.
    entry.eligibleAt = entry.turnGeneration <= entry.completedGeneration + 1 ? now : null;
  }
  const captured = entry.state === "captured";
  // Its own turn completed before the driver answered: whatever echo it had has come and gone,
  // so once this door has its answer nothing is left to wait for.
  if (settled(entry) || entry.turnGeneration <= entry.completedGeneration) drop(entry);
  return { captured };
}

/**
 * One door's `captureAcceptedPrompt` returned a goal for this follow-up. `echoed` says that
 * door was the prompt hook, so this entry's echo has been spent.
 */
export function markHumanEchoCaptured(
  ticket: HumanEchoTicket,
  options: { echoed?: boolean; now?: number } = {},
): void {
  const entry = fromTicket(ticket);
  if (!live(entry, options.now ?? Date.now())) return;
  const acknowledged = entry.state !== "open";
  entry.state = "captured";
  if (options.echoed) entry.echoed = true;
  if (acknowledged && settled(entry)) drop(entry);
}

/**
 * The prompt hook has reported this follow-up's echo, whatever its own capture did.
 *
 * Spending the echo is a separate fact from recording the turn, and the hook door marks it
 * before it attempts the capture. If that capture returns null or throws, the acknowledgement
 * still records the turn, but this entry must not stay open to an echo that has already come:
 * the next send of the same words would have its own echo matched here, skipped as this
 * one's, and lost.
 */
export function markHumanEchoSeen(ticket: HumanEchoTicket, now = Date.now()): void {
  const entry = fromTicket(ticket);
  if (!live(entry, now)) return;
  entry.echoed = true;
  if (entry.state !== "open" && settled(entry)) drop(entry);
}

/**
 * A launch-window follow-up's conversation has bound: move its entries from the session id
 * to the native key the hook will report, or drop them (`toKey` null) when a clear discarded
 * that launch generation and nothing will record them.
 */
export function rekeyHumanEchoes(sessionId: string, fromKey: string, toKey: string | null): void {
  const list = expected.get(sessionId);
  if (!list) return;
  for (const entry of list.filter((e) => e.noteKey === fromKey)) {
    if (toKey === null) drop(entry);
    else entry.noteKey = toKey;
  }
}

/**
 * The driver positively refused this follow-up, so no echo will come. A captured entry is
 * kept: its turn is in the Goal, and the only reader left is its own echo.
 */
export function releaseHumanEcho(ticket: HumanEchoTicket, now = Date.now()): void {
  const entry = fromTicket(ticket);
  if (!live(entry, now)) return;
  if (entry.state !== "captured") drop(entry);
}

/**
 * Decide a prompt-hook arrival against the follow-ups this session is waiting on.
 *
 * `skip` when the oldest unechoed entry for this text was already captured by its send: this
 * is that send's echo, and it is spent. `capture` when it has not been: the hook is the first
 * door, and the caller marks the ticket once its own capture succeeded. The entry is left
 * exactly as it was, so a capture that fails leaves the acknowledgement to record the turn.
 * `none` when nothing matches, and the arrival takes the ordinary path.
 */
export function claimHumanEcho(
  sessionId: string,
  noteKey: string,
  text: string,
  now = Date.now(),
): HumanEchoClaim {
  const key = injectionFingerprint(text);
  const entry = liveEchoes(sessionId, now)?.find(
    (e) => e.key === key && e.noteKey === noteKey && !e.echoed,
  );
  if (!entry) return { kind: "none" };
  if (entry.state === "captured") {
    drop(entry);
    return { kind: "skip" };
  }
  return { kind: "capture", ticket: asTicket(entry) };
}

/**
 * A turn of this conversation completed, leaving it at `completedGeneration`.
 *
 * Drops every acknowledged entry whose own turn that was, and starts the next turn's entries
 * aging. An entry from a conversation a clear has replaced can never be expired by generation,
 * so it starts aging too.
 *
 * An `open` entry is never dropped here, only told about the completion. Until the driver
 * answers, its turn is a guess: a send stamped against an idle session may be queued behind a
 * turn the registry has not seen start, and that turn can complete before `handle.send`
 * resolves `steered`. Dropping it then would let the acknowledgement capture the follow-up and
 * its later echo capture it again. `confirmHumanEcho` settles it against what it was told, and
 * an acknowledgement that never comes leaves it to age out.
 */
export function expireHumanEchoes(
  sessionId: string,
  noteKey: string,
  completedGeneration: number,
  now = Date.now(),
): void {
  const list = liveEchoes(sessionId, now);
  if (!list) return;
  for (const entry of list) {
    if (entry.noteKey === noteKey) {
      entry.completedGeneration = Math.max(entry.completedGeneration, completedGeneration);
    }
  }
  const kept = list.filter((entry) => entry.noteKey !== noteKey
    || entry.state === "open"
    || entry.turnGeneration > completedGeneration);
  for (const entry of kept) {
    if (entry.eligibleAt === null
      && (entry.noteKey !== noteKey || entry.turnGeneration <= completedGeneration + 1)) {
      entry.eligibleAt = now;
    }
  }
  if (kept.length === 0) expected.delete(sessionId);
  else expected.set(sessionId, kept);
}

/** Forget a session's deliveries. For tests, and for a reset that clears the context. */
export function forgetInjections(sessionId?: string): void {
  if (sessionId === undefined) {
    seen.clear();
    expected.clear();
  } else {
    seen.delete(sessionId);
    expected.delete(sessionId);
  }
}
