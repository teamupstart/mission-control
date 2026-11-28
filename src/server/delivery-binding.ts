import { setImmediate as yieldToDaemon } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { TranscriptMessage } from "@shared/types.ts";
import {
  deleteOtherSend,
  insertOtherSend,
  loadOtherSends,
  pruneOtherSends,
  takeOtherSendChanges,
  type BindableDelivery,
} from "./db.ts";
import type { SessionMessages } from "./harness/index.ts";
import type { TranscriptBoundary } from "./harness/types.ts";
import { injectionFingerprint } from "./injections.ts";

export type { BindableDelivery } from "./db.ts";

/**
 * Which user turn a recorded daemon delivery wrote, durably: the one binding rule.
 *
 * Delegated messages, review messages and spoken turns share this transcript binding rule.
 *
 * Each delivery is its own row, reserved BEFORE the send and carrying the target
 * transcript's byte size at that moment. Its turn is the first user turn with its words
 * written AFTER that offset in the file itself, not in whatever page a reader happens to
 * hold. Rows bind in reservation order, so identical words delivered twice each take their
 * own turn, and a turn written before the delivery, or a page that skips the delivery's own
 * turn, can never be mistaken for it. Once bound, a row answers for that turn by native id
 * and never moves.
 *
 * One ordering the file cannot settle: another send of the same words to the same target
 * that is in flight alongside the delivery - from the operator, Foreman, or a different
 * sender. Either turn could be written first, so neither can be credited. Such a row is
 * CONTESTED - persisted, never bound - and its words read as nobody's rather than risk
 * crediting the delivery's sender with the operator's turn. Every other sender reports
 * through `noteOtherSend` before it writes for exactly this, and that one record contests
 * the rows of every ledger.
 *
 * The daemon is the only writer of these tables, so a per-conversation cache stays coherent.
 */

/**
 * How long after a delivery its turn may first be written. An SDK target that is busy queues
 * the message until its current turn ends, so this is generous. It stops a delivery that
 * never produced a turn from claiming a much later operator turn with the same words.
 */
export const DELIVERY_LAG_MS = 24 * 60 * 60_000;
/** A turn's timestamp may round below the moment its delivery was recorded. */
const DELIVERY_SKEW_MS = 5_000;
/** Forward page size for the binding walk. */
const BIND_PAGE_TURNS = 50;

/** A target conversation, and the transcript its deliveries are bound against. */
export interface DeliveryConversation {
  key: string;
  transcript: SessionMessages | null;
  /** The page's spoken walks completed cooperatively. These rows have a unique timestamp fallback. */
  preparedSpokenFallbacks?: ReadonlySet<string>;
  /** Transcript-dependent send decisions checked against the file and senders at the write guard. */
  preparedHandoff?: { otherInFlight: boolean; reviewEchoes: ReadonlyMap<string, string | null> };
}

/** One table's persistence, and who its rows would be credited to. */
export interface DeliveryStore<Row extends BindableDelivery> {
  maxCachedConversations?: number;
  /** Native IDs in a rewritten transcript may now identify different words. */
  requireExactFingerprint?: boolean;
  /** A recorded offset belongs only to the transcript sampled for that send. */
  acceptsTranscript?(row: Row, transcript: SessionMessages): boolean;
  /** Verified text-binding boundary, false for a mismatch, null when cleanup must retry the read. */
  textBoundary?(row: Row, transcript: SessionMessages): TranscriptBoundary | false | null;
  /** Conversations whose rows an outbox transaction removed outside this ledger. */
  takeInvalidatedKeys?(): readonly string[] | undefined;
  /** Optional byte boundary for a transcript proven to have been created after reservation. */
  newTranscriptAfter?(transcript: SessionMessages, deliveredAt: number): boolean | null;
  /** For log lines: "a delegated turn". */
  label: string;
  /** A conversation's rows, in reservation (rowid) order. */
  load(noteKey: string): Row[];
  insert(row: Row): void;
  remove(id: string): void;
  contest(id: string, contested: boolean): void;
  /** Write-once: false when the row was already bound. */
  bind(row: Row, messageId: string, messageTs: number, boundary?: TranscriptBoundary): boolean;
  /** Return the persisted native timestamp, or null if the reservation was already removed. */
  observeClientReceipt?(id: string, messageTs: number): number | null;
  /**
   * The label a row would show. Two unbound rows of the same words with the same sender
   * cannot be credited to the wrong one, so they race nobody; different senders contest.
   */
  sender(row: Row): string;
}

/** What `bound` reads off one page of turns. */
export interface BoundTurns<Row> {
  /** The delivery bound to each turn, by message id. */
  rows: Map<string, Row>;
  /** Turns whose words this conversation has deliveries for: unclaimed ones are someone else's. */
  matched: Set<string>;
  /** Turns that could be an unresolved delivery (contested, or sent without a boundary). */
  ambiguous: Set<string>;
}

/**
 * The transcript's size now, or null when the boundary is unavailable: no transcript located
 * yet, or one whose size could not be read. Null is an unknown send boundary, never byte zero
 * - a transcript can be located only after the send, and binding from zero would let an older
 * operator turn with the same words be taken for this one.
 */
export function transcriptSize(transcript: SessionMessages | null): number | null {
  if (!transcript) return null;
  try {
    // The reader answers null for a located file that is missing: as unknown as no transcript.
    return transcript.read.size(transcript.path) ?? null;
  } catch {
    return null;
  }
}

/** A turn identity that survives a parser re-synthesizing ids, when the turn has a timestamp. */
function turnKey(fingerprint: string, ts: number | null): string | null {
  return ts && ts > 0 ? `${fingerprint}\0${ts}` : null;
}

// ---- sends that are not recorded deliveries ----

/** One non-delivery send; `offset` is null when the transcript size could not be read. */
interface OtherSend {
  id: string;
  at: number;
  offset: number | null;
  spokenBoundary?: string | null;
}

/**
 * Recent sends that are not recorded deliveries, per target conversation and fingerprint, with
 * the transcript size when each began. Persisted in `session_other_sends` and loaded lazily per
 * conversation, because a send can stay in flight across a restart: a pasted draft is
 * submitted whenever the operator presses Enter, and a delivery of the same words after the
 * restart must still see it.
 */
const otherSends = new Map<string, OtherSend[]>();
/** Conversations whose persisted sends have been loaded into `otherSends` this process. */
const sendsLoaded = new Set<string>();
/** When `otherSends` was last swept of entries past the race window. */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sendKey(noteKey: string, fingerprint: string): string {
  return `${noteKey}\0${fingerprint}`;
}

/**
 * Drop every remembered send older than the race window, across all keys. Only a send under
 * the same words is otherwise ever read back, so without this a long-running daemon would keep
 * one entry per distinct message it ever delivered. Throttled: at most once a minute.
 */
function sweepOtherSends(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  pruneOtherSends(now - DELIVERY_LAG_MS);
  for (const [key, sends] of otherSends) {
    const recent = sends.filter((send) => now - send.at <= DELIVERY_LAG_MS);
    if (recent.length) otherSends.set(key, recent);
    else otherSends.delete(key);
  }
}

/** Manual settlement keeps the original send boundary, but provides no runtime receipt.
 * A later sender can be credited if distinct eligible occurrences already landed before it.
 * A synchronous send guard with more than a page of evidence to check stays conservative. */
function settledSendInFlight(transcript: SessionMessages, fingerprint: string, sends: OtherSend[], used: Set<string>): boolean {
  const { read, path } = transcript;
  const snapshot = read.snapshot?.(path);
  if (!snapshot) return true;
  let budget = 512 * 1024;
  try {
    for (const send of [...sends].sort((a, b) => b.offset! - a.offset! || b.at - a.at)) {
      const offset = send.offset!;
      budget -= snapshot.size - offset + (send.spokenBoundary ? offset : 0);
      if (offset > snapshot.size || budget < 0) return true;
      if (send.spokenBoundary && read.boundary?.(path, offset)?.proof !== send.spokenBoundary) return true;
      const frame = read.appended(path, offset, snapshot.size);
      const match = frame.messages.find(m => m.role === "user" && m.text && !isClaimed(m, used) &&
        (!send.spokenBoundary || m.ts >= send.at) && injectionFingerprint(m.text) === fingerprint);
      if (!match) return true;
      used.add(match.id);
    }
    return read.snapshot?.(path)?.version !== snapshot.version;
  } catch {
    return true;
  }
}

/** Bring a conversation's persisted sends into memory once per process. */
function loadSends(noteKey: string, now: number): void {
  for (const changed of takeOtherSendChanges()) {
    sendsLoaded.delete(changed);
    for (const key of otherSends.keys()) if (key.startsWith(changed + "\0")) otherSends.delete(key);
  }
  if (sendsLoaded.has(noteKey)) return;
  sendsLoaded.add(noteKey);
  for (const row of loadOtherSends(noteKey, now - DELIVERY_LAG_MS)) {
    const key = sendKey(noteKey, row.fingerprint);
    const sends = otherSends.get(key) ?? [];
    if (!sends.some((send) => send.id === row.id)) sends.push({ id: row.id, at: row.sentAt, offset: row.transcriptOffset, spokenBoundary: row.spokenBoundary });
    otherSends.set(key, sends);
  }
}

function recentSends(noteKey: string, fingerprint: string, now: number): OtherSend[] {
  sweepOtherSends(now);
  loadSends(noteKey, now);
  const key = sendKey(noteKey, fingerprint);
  const recent = (otherSends.get(key) ?? []).filter((send) => now - send.at <= DELIVERY_LAG_MS);
  if (recent.length) otherSends.set(key, recent);
  else otherSends.delete(key);
  return recent;
}

/**
 * Every ledger. One send that is not a delivery contests the rows of all of them, and the
 * ledgers treat each other's rows as rivals and as claims: a transcript turn belongs to at most
 * one recorded delivery, whichever table recorded it. Two ledgers' rows of the same words race
 * exactly as two senders' rows in one ledger do, because nothing in the file says which wrote
 * the turn.
 */
let ledgers: Array<DeliveryLedger<BindableDelivery>> = [];
let beforeLedgerRead: (() => void) | undefined;

/**
 * Name the ledgers that make up the claim space. Called once, by `delivery-ledgers.ts`, which
 * constructs every ledger and is the module each delivery table's owner imports, so the set is
 * complete before any reservation, binding or other send consults it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each ledger has its own row type
export function registerDeliveryLedgers(list: ReadonlyArray<DeliveryLedger<any>>, beforeRead: () => void): void {
  beforeLedgerRead = beforeRead;
  ledgers = [...list] as Array<DeliveryLedger<BindableDelivery>>;
}

/** One conversation's unbound rows of these words, in every ledger, with who they credit. */
function openRows(noteKey: string, fingerprint: string, transcript?: SessionMessages | null): Array<{ ledger: DeliveryLedger<BindableDelivery>; row: BindableDelivery }> {
  return ledgers.flatMap((ledger) => ledger.rows(noteKey)
    .filter((row) => row.fingerprint === fingerprint && row.messageId === null && ledger.acceptsTranscript(row, transcript))
    .map((row) => ({ ledger, row })));
}

/** Every turn of this conversation some ledger has already bound. */
function claimedTurns(noteKey: string, transcript: SessionMessages | null): Set<string> {
  return new Set(ledgers.flatMap(ledger => ledger.rows(noteKey).flatMap(row =>
    row.messageId && ledger.acceptsTranscript(row, transcript) ? [row.messageId] : [])));
}

function isClaimed(message: TranscriptMessage, claimed: Set<string>): boolean {
  return claimed.has(message.id) || (message.clientMessageId !== undefined && claimed.has(message.clientMessageId));
}

type SpokenCandidate = (row: BindableDelivery) => boolean;

function visibleSpokenCandidate(key: string, messages: readonly TranscriptMessage[], transcript: SessionMessages | null): SpokenCandidate {
  let times: Map<string, number[]> | undefined;
  return row => {
    if (!times) {
      times = new Map();
      const claimed = claimedTurns(key, transcript);
      for (const m of messages) {
        if (m.role !== "user" || !m.text || isClaimed(m, claimed)) continue;
        const fingerprint = injectionFingerprint(m.text);
        const seen = times.get(fingerprint);
        if (seen) seen.push(m.ts);
        else times.set(fingerprint, [m.ts]);
      }
    }
    return times.get(row.fingerprint)?.some(ts => ts >= row.deliveredAt && ts - row.deliveredAt <= DELIVERY_LAG_MS) ?? false;
  };
}

/** Existing synchronous callers and the cooperative spoken preflight share the same page walks. */
export function finishWalk<T>(walk: Generator<void, T>): T {
  let step = walk.next();
  while (!step.done) step = walk.next();
  return step.value;
}

export async function finishHandoffWalk<T>(walk: Generator<void, T>, check: () => void): Promise<T> {
  for (;;) {
    check();
    const step = walk.next();
    if (step.done) return step.value;
    await yieldToDaemon();
  }
}

/** Native client UUIDs need file evidence only when a competing send might have landed. */
export function handoffNeedsTranscript(key: string, fingerprint: string, now: number): boolean {
  return recentSends(key, fingerprint, now).length > 0 || ledgers.some(ledger => ledger.rows(key).some(row => row.fingerprint === fingerprint));
}

/** Changes to a matching sender, claim or pending row invalidate a prepared reservation. */
export function handoffSenderState(key: string, fingerprint: string, now: number): string {
  return JSON.stringify([recentSends(key, fingerprint, now),
    ...ledgers.map(ledger => ledger.rows(key).filter(row => row.fingerprint === fingerprint)
      .map(row => [row.id, row.messageId, row.contested]))]);
}

export function settledHandoffOffsets(key: string, fingerprint: string, now: number): number[] {
  return recentSends(key, fingerprint, now).flatMap(send => send.spokenBoundary && send.offset !== null ? [send.offset] : []);
}

export async function reconcileHandoffRows(key: string, transcript: SessionMessages, now: number, check: () => void,
  pause: () => Promise<void>): Promise<void> {
  try {
    for (const ledger of ledgers) {
      for (const row of ledger.rows(key).filter(row => !row.contested && row.messageId === null)) {
        do {
          await pause();
        } while (!ledger.bindLanded(key, transcript, now, { pagedRow: row.id, beforeBind: check }));
        check();
      }
    }
  } catch (error) {
    // Partial walks in delegated/review ledgers also belong to the captured revision.
    for (const ledger of ledgers) ledger.forgetConversation(key);
    throw error;
  }
}

/** Ordinary synchronous sends reconcile the other ledgers, leaving spoken walks to prepared reads. */
function bindAll(conversation: DeliveryConversation, now: number, candidate: SpokenCandidate = () => false): void {
  if (!conversation.transcript || conversation.preparedHandoff) return;
  for (const ledger of ledgers) ledger.bindLanded(conversation.key, conversation.transcript, now, { candidate });
}

/** What `withdrawOtherSend` needs to take one send back. */
export interface OtherSendHandle {
  key: string;
  fingerprint: string;
  send: OtherSend;
}

/**
 * Told about every send of words into a conversation before it is written: another send
 * (`noteOtherSend`) or a recorded delivery of any ledger (`DeliveryLedger.reserve`).
 */
type SendListener = (conversation: DeliveryConversation, fingerprint: string) => void;
const sendListeners: SendListener[] = [];

/**
 * Hear every send before it writes. A ledger whose bound rows still have something to decide from
 * later turns of the same words (a steered review delivery's echo) settles it here, while the file
 * still holds only what was written before this send, so the new send's turn can never decide it.
 */
export function onSend(listener: SendListener): () => void {
  sendListeners.push(listener);
  return () => {
    const index = sendListeners.indexOf(listener);
    if (index >= 0) sendListeners.splice(index, 1);
  };
}

function announceSend(conversation: DeliveryConversation, fingerprint: string): void {
  for (const listener of sendListeners) {
    try {
      listener(conversation, fingerprint);
    } catch (err) {
      console.error("[transcript] a send listener failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Another sender - the operator's composer, a queued turn, Foreman - is about to write these
 * words to the target. Remembered, so a delivery that starts while it is in flight is
 * contested; and any delivery of the same words still unbound once what has already landed is
 * bound is contested now, since the two turns may land in either order.
 */
export function noteOtherSend(conversation: DeliveryConversation, text: string, now = Date.now()): OtherSendHandle {
  const fingerprint = injectionFingerprint(text);
  const sends = recentSends(conversation.key, fingerprint, now);
  const send: OtherSend = { id: randomUUID(), at: now, offset: transcriptSize(conversation.transcript) };
  insertOtherSend({ id: send.id, noteKey: conversation.key, fingerprint, sentAt: send.at, transcriptOffset: send.offset });
  sends.push(send);
  otherSends.set(sendKey(conversation.key, fingerprint), sends);
  for (const ledger of ledgers) ledger.contestRacing(conversation, fingerprint, now);
  announceSend(conversation, fingerprint);
  return { key: conversation.key, fingerprint, send };
}

/**
 * Take back a send with positive evidence that nothing landed. With no other send of those
 * words left to race them, the deliveries it contested are bindable again, so a failed
 * operator attempt does not cost a delivery its label.
 */
export function withdrawOtherSend(handle: OtherSendHandle): void {
  deleteOtherSend(handle.send.id);
  const key = sendKey(handle.key, handle.fingerprint);
  const remaining = (otherSends.get(key) ?? []).filter((send) => send.id !== handle.send.id);
  if (remaining.length) {
    otherSends.set(key, remaining);
    return;
  }
  otherSends.delete(key);
  for (const ledger of ledgers) ledger.reconsider(handle.key, handle.fingerprint);
}

/** For tests: how many distinct send keys are remembered. */
export function rememberedOtherSendKeys(): number {
  return otherSends.size;
}

/** Reload persisted attribution after a rollback or simulated restart. */
export function forgetDeliveryBindingState(): void {
  for (const ledger of ledgers) ledger.forgetCaches();
  otherSends.clear();
  sendsLoaded.clear();
  lastSweep = 0;
}

// ---- one table's deliveries ----

export class DeliveryLedger<Row extends BindableDelivery> {
  private readonly cache = new Map<string, Row[]>();
  /** How far each unbound row's walk has read, so a later frame continues instead of restarting. */
  private readonly scanned = new Map<string, number | "skipped">();
  /** Spoken scan progress is reusable only in the file revision that supplied its bytes. */
  private readonly scanVersions = new Map<string, string>();
  /** Bound text rows whose saved prefix was verified in this scan revision. */
  private readonly verifiedTextRows = new Set<string>();
  /** A native candidate was visible, but its read or binding could not finish on this revision. */
  private readonly deferredBindings = new Set<string>();
  /** Only failed writes are retained. Native UUIDs and timestamps outlive the payload cache. */
  private readonly pendingObservations = new Map<string, number>();
  /** Rows whose window closed with no turn of theirs: never scanned again this process. */
  private readonly expired = new Set<string>();
  /**
   * Per bound row, how many user turns in the whole transcript share its words and timestamp,
   * counted so far. Final once the walk passes a later timestamp; resumed from `from` until then.
   */
  private readonly twins = new Map<string, { from: number; count: number; final: boolean; checkSuffix: boolean } | "ineligible">();

  constructor(
    private readonly store: DeliveryStore<Row>,
    /** Drop whatever the owner derived from these rows, whenever the row caches are dropped. */
    private readonly onForget: () => void = () => {},
  ) {}

  rows(noteKey: string): Row[] {
    beforeLedgerRead?.();
    for (const key of this.store.takeInvalidatedKeys?.() ?? []) this.forgetConversation(key);
    let rows = this.cache.get(noteKey);
    if (!rows) {
      rows = this.store.load(noteKey);
      if (this.store.maxCachedConversations && this.cache.size >= this.store.maxCachedConversations) {
        this.forgetConversation(this.cache.keys().next().value!);
      }
      this.cache.set(noteKey, rows);
    } else if (this.store.maxCachedConversations) {
      this.cache.delete(noteKey);
      this.cache.set(noteKey, rows);
    }
    return rows;
  }

  /** Release one conversation's rows and scan state. A later read reloads them from SQLite. */
  forgetConversation(key: string): void {
    for (const row of this.cache.get(key) ?? []) this.forgetScan(row.id);
    this.scanVersions.delete(key);
    this.cache.delete(key);
  }

  private forgetScan(id: string): void {
    this.scanned.delete(id);
    this.verifiedTextRows.delete(id);
    this.deferredBindings.delete(id);
    this.expired.delete(id);
    this.twins.delete(id);
  }

  /** Drop every cache, so the next read comes from the table. */
  forgetCaches(): void {
    this.onForget();
    this.cache.clear();
    this.scanned.clear();
    this.scanVersions.clear();
    this.verifiedTextRows.clear();
    this.deferredBindings.clear();
    this.expired.clear();
    this.twins.clear();
  }

  /**
   * Record a delivery BEFORE it is attempted. `build` adds the table's own columns to the
   * shared ones; the target transcript's size now is where its turn can first appear.
   */
  reserve(conversation: DeliveryConversation, text: string, build: (base: BindableDelivery) => Row, now = Date.now(),
    id: string = randomUUID()): Row {
    // Loaded before the insert, or a cold cache would read this row back and then push it again.
    const rows = this.rows(conversation.key);
    const fingerprint = injectionFingerprint(text);
    // Before this delivery's row exists or its turn can be written: a delegated copy of a steered
    // review delivery's words must not be taken for that delivery's echo.
    announceSend(conversation, fingerprint);
    const row = build({
      id,
      noteKey: conversation.key,
      fingerprint,
      deliveredAt: now,
      // Null when the size could not be read. Never assume an unknown boundary is byte zero.
      transcriptOffset: transcriptSize(conversation.transcript),
      contested: conversation.preparedHandoff?.otherInFlight ?? finishWalk(this.otherSendInFlight(conversation, fingerprint, now)),
      messageId: null,
      messageTs: null,
    });
    // A different sender's identical delivery still unwritten races this one: either turn could
    // land first and nothing in the file says which delivery wrote it, so neither is credited.
    // The same sender under the same name delivering twice cannot swap names, so that stays
    // bindable; one renamed between the two sends could, so it counts as a rival.
    // Rivals are looked for in every ledger: a delegated send and a review delivery of the same
    // words race as two controllers do.
    bindAll(conversation, now);
    const sender = this.senderKey(row);
    const rivals = openRows(conversation.key, fingerprint, conversation.transcript).filter(({ ledger, row: other }) =>
      ledger.senderKey(other) !== sender && !ledger.isExpired(other.id) && now - other.deliveredAt <= DELIVERY_LAG_MS);
    if (rivals.length) {
      row.contested = true;
      for (const { ledger, row: other } of rivals) if (!other.contested) ledger.contestRow(other);
    }
    this.store.insert(row);
    rows.push(row);
    return row;
  }

  /** Give back a delivery with positive evidence that nothing landed. */
  release(noteKey: string, id: string): void {
    const released = this.rows(noteKey).find((row) => row.id === id);
    this.store.remove(id);
    this.cache.set(noteKey, this.rows(noteKey).filter((row) => row.id !== id));
    this.forgetScan(id);
    // A rival that never landed no longer races the deliveries it contested.
    if (released) this.reconsider(noteKey, released.fingerprint);
  }

  acceptsTranscript(row: Row, transcript?: SessionMessages | null): boolean {
    return !transcript || !this.store.acceptsTranscript || this.store.acceptsTranscript(row, transcript);
  }

  /** Contest this conversation's unbound rows of these words, once what has landed is bound. */
  contestRacing(conversation: DeliveryConversation, fingerprint: string, now: number): void {
    const rows = this.rows(conversation.key);
    const racing = () => rows.filter((row) => row.fingerprint === fingerprint && row.messageId === null && !row.contested
      && this.acceptsTranscript(row, conversation.transcript));
    if (!racing().length) return;
    bindAll(conversation, now);
    for (const row of racing()) this.contest(row);
  }

  /**
   * Clear the contest on these words' unbound deliveries once nothing races them any more: no
   * other send remembered, and every unbound delivery left shows the same sender, so no two
   * turns could be credited to the wrong name.
   */
  reconsider(noteKey: string, fingerprint: string): void {
    if (recentSends(noteKey, fingerprint, Date.now()).length) return;
    const open = openRows(noteKey, fingerprint);
    if (new Set(open.map(({ ledger, row }) => ledger.senderKey(row))).size > 1) return;
    for (const { ledger, row } of open) if (row.contested) ledger.contestRow(row, false);
  }

  /** Who a row credits, distinct across ledgers: a delegated sender is never Mission Control. */
  senderKey(row: Row): string {
    return `${this.store.label}\0${this.store.sender(row)}`;
  }

  isExpired(id: string): boolean {
    return this.expired.has(id);
  }

  contestRow(row: Row, contested = true): void {
    this.contest(row, contested);
  }

  /** Bind this ledger's landed deliveries in a conversation, against every ledger's claims. */
  bindLanded(noteKey: string, transcript: SessionMessages, now: number,
    options: { candidate?: SpokenCandidate; pagedRow?: string; strict?: boolean; beforeBind?: () => void } = {}): boolean {
    const rows = this.rows(noteKey);
    let version: string | undefined;
    if (rows.length && this.store.textBoundary) {
      version = transcript.read.snapshot?.(transcript.path)?.version;
      if (!version || this.scanVersions.get(noteKey) !== version) {
        // Native files can rewrite a suffix without changing size. Offsets, expiry and
        // timestamp uniqueness were all observed in the previous revision.
        for (const row of rows) {
          // A visible candidate awaiting a failed write is still owed on a quiet feed.
          this.scanned.delete(row.id);
          this.verifiedTextRows.delete(row.id);
          this.expired.delete(row.id);
          this.twins.delete(row.id);
        }
        if (version) this.scanVersions.set(noteKey, version);
        else this.scanVersions.delete(noteKey);
      }
    }
    const pending = rows.filter(row => row.messageId === null && !row.contested &&
      this.acceptsTranscript(row, transcript) &&
      (row.transcriptOffset !== null || this.store.newTranscriptAfter) && (!this.store.textBoundary || !options.candidate || options.candidate(row)) &&
      (options.pagedRow === undefined || row.id === options.pagedRow));
    return !pending.length || this.bindPending(pending, transcript, now, options.strict ?? false, options.pagedRow !== undefined, version, options.beforeBind);
  }

  /** Recheck persisted rows before deletion, even if an earlier best-effort read found nothing. */
  async reconcileBeforePrune(noteKey: string, transcript: SessionMessages, now: number, version: string, signal?: AbortSignal): Promise<void> {
    this.forgetConversation(noteKey);
    // Archived paths only establish claims for this ledger. The other ledgers' offsets
    // belong to the live transcript. bindPending still respects their existing native IDs.
    for (const row of this.rows(noteKey).filter(row => !row.contested && row.messageId === null)) {
      do {
        await yieldToDaemon();
        if (signal?.aborted || transcript.read.snapshot?.(transcript.path)?.version !== version) {
          throw new Error("Spoken cleanup interrupted or transcript changed");
        }
      } while (!this.bindLanded(noteKey, transcript, now, { pagedRow: row.id, strict: true }));
    }
  }

  /** Page the spoken lookup before rendering. Re-read claims after each yield, and only bind
   * against the same file revision. The forward walk still starts at the recorded handoff. */
  async prepareProjection(key: string, transcript: SessionMessages, messages?: TranscriptMessage[]): Promise<Set<string> | null> {
    const version = transcript.read.snapshot?.(transcript.path)?.version;
    const current = () => transcript.read.snapshot?.(transcript.path)?.version === version;
    const fallbacks = new Set<string>();
    if (!version) return fallbacks;
    const now = Date.now();
    const candidate = messages ? visibleSpokenCandidate(key, messages, transcript) : (row: Row) => this.deferredBindings.has(row.id);
    const pending = this.rows(key).filter(row => row.messageId === null && !row.contested && candidate(row));
    for (const row of pending) {
      while (current() && !this.bindLanded(key, transcript, now, { pagedRow: row.id })) await yieldToDaemon();
      if (!current()) return null;
    }
    if (!messages?.length) return fallbacks;
    const pageIds = new Set(messages.map(m => m.id));
    const timestamps = new Set(messages.filter(m => m.role === "user" && m.text && m.ts > 0)
      .map(m => turnKey(injectionFingerprint(m.text!), m.ts)));
    for (const row of this.rows(key)) {
      if (!row.messageId || row.messageId === row.id || pageIds.has(row.messageId) ||
          !timestamps.has(turnKey(row.fingerprint, row.messageTs))) continue;
      // A parser can synthesize a different ID for the same native record on another read.
      // Its uniqueness check can span the entire file as well.
      this.bindLanded(key, transcript, now, { candidate: () => false });
      let unique: boolean | undefined;
      while (current() && (unique = this.uniqueAtTimestamp(row, transcript, true)) === undefined) await yieldToDaemon();
      if (!current()) return null;
      if (unique) fallbacks.add(row.id);
    }
    return fallbacks;
  }

  /** Offsets this page (or a quiet feed retry) can need. SDK UUIDs never need a prefix proof. */
  projectionOffsets(key: string, version: string | undefined, messages?: TranscriptMessage[]): number[] {
    if (!messages && !this.deferredBindings.size) return [];
    const visible = messages && new Set(messages.filter(m => m.role === "user" && m.text).map(m => injectionFingerprint(m.text)));
    if (visible && !visible.size) return [];
    const verified = version !== undefined && this.scanVersions.get(key) === version;
    const offsets = this.rows(key).filter(row => row.messageId !== row.id && !row.contested &&
      !(verified && this.verifiedTextRows.has(row.id)) &&
      (visible ? visible.has(row.fingerprint) : this.deferredBindings.has(row.id))).map(row => row.transcriptOffset ?? 0);
    return [...new Set(offsets)];
  }

  /** An open feed can finish a deferred binding even if the native writer has gone quiet. */
  retryDeferredBindings(conversation: DeliveryConversation): void {
    this.flushClientObservations(conversation.key);
    if (!this.deferredBindings.size || conversation.preparedSpokenFallbacks) return;
    const pending = this.rows(conversation.key).filter(row => this.deferredBindings.has(row.id));
    if (pending.length) {
      const fingerprints = new Set(pending.map(row => row.fingerprint));
      bindAll(conversation, Date.now(), row => fingerprints.has(row.fingerprint));
    }
  }

  /** A failed observation never obscures a proven native turn. The pruner requires a successful flush. */
  flushClientObservations(key?: string): boolean {
    if (!this.pendingObservations.size || !this.store.observeClientReceipt) return true;
    // Native UUIDs survive eviction and the first bind from a provisional conversation key.
    // The hourly sweep also retries observations for conversations with no open reader.
    const rows = key === undefined ? undefined : new Map(this.rows(key).map(row => [row.id, row]));
    let complete = true;
    for (const [id, ts] of this.pendingObservations) {
      const row = rows?.get(id);
      if (rows && !row) continue;
      try {
        const saved = this.store.observeClientReceipt(id, ts);
        if (row) row.messageTs = saved;
        this.pendingObservations.delete(id);
      } catch {
        complete = false;
      }
    }
    return complete;
  }

  private contest(row: Row, contested = true): void {
    this.store.contest(row.id, contested);
    row.contested = contested;
  }

  /**
   * Whether another send of these words is still in flight: more were sent than have since been
   * written to the transcript, not counting turns any ledger's rows already own. Without a
   * transcript to count against, any recent send counts as in flight.
   */
  *otherSendInFlight(conversation: DeliveryConversation, fingerprint: string, now: number, reconciled = false): Generator<void, boolean> {
    const sends = recentSends(conversation.key, fingerprint, now);
    if (!sends.length) return false;
    const transcript = conversation.transcript;
    if (!transcript || sends.some((send) => send.offset === null)) return true;
    if (!reconciled) bindAll(conversation, now);
    // A contested delivery's turn may already be among the matches below, and nothing says
    // which one it is, so no landed turn can be credited to the other sends: still in flight.
    if (openRows(conversation.key, fingerprint, conversation.transcript).some(({ row }) => row.contested || row.transcriptOffset === null)) return true;
    const claimed = claimedTurns(conversation.key, transcript);
    if (sends.some(send => send.spokenBoundary)) return settledSendInFlight(transcript, fingerprint, sends, claimed);
    let from = Math.min(...sends.map((send) => send.offset!));
    let landed = 0;
    try {
      for (;;) {
        const page = transcript.read.after(transcript.path, from, BIND_PAGE_TURNS);
        for (const m of page.messages) {
          if (m.role === "user" && m.text && !isClaimed(m, claimed) && injectionFingerprint(m.text) === fingerprint) landed += 1;
        }
        if (page.atEnd || page.end <= from) break;
        from = page.end;
        yield;
      }
    } catch {
      return true;
    }
    return sends.length > landed;
  }

  /**
   * Walk the transcript forward from each unbound row's offset, in reservation order, and bind
   * the row to the first user turn with its words that no earlier row has claimed.
   */
  private bindPending(rows: Row[], transcript: SessionMessages, now: number, requireReadable: boolean, singlePage: boolean, version?: string, beforeBind?: () => void): boolean {
    // Claimed by id only: one walk reads ids consistently, and a timestamp two identical turns
    // can share would stop the second of them from ever being claimed. Every ledger's claims
    // count, so a turn another table already bound is never bound again here.
    const claimed = rows.length ? claimedTurns(rows[0]!.noteKey, transcript) : new Set<string>();
    nextRow: for (const row of rows) {
      if (row.messageId !== null || row.contested || this.expired.has(row.id)) {
        this.deferredBindings.delete(row.id);
        continue;
      }
      if (row.transcriptOffset === null) {
        const createdAfter = this.store.newTranscriptAfter?.(transcript, row.deliveredAt);
        if (!createdAfter) {
          if (createdAfter === null) {
            this.deferredBindings.add(row.id);
            if (requireReadable) throw new Error("Could not check transcript creation time");
          } else this.deferredBindings.delete(row.id);
          continue;
        }
      }
      const cursor = this.scanned.get(row.id);
      if (cursor === "skipped") continue;
      let from = cursor ?? row.transcriptOffset ?? 0;
      let found: TranscriptMessage | null = null;
      let closed = false;
      try {
        for (;;) {
          // An empty best-effort page can mean a failed read. Spoken binding needs to
          // distinguish that case from EOF so a quiet connection can finish its retry.
          const page = transcript.read.after(transcript.path, from, BIND_PAGE_TURNS, this.store.textBoundary ? "cooperative" : requireReadable);
          if (this.store.textBoundary && (page.skippedRecord || page.finishOversizedRecord)) {
            // The skipped record could be the delivery. A later copy cannot establish the first match.
            this.scanned.set(row.id, "skipped");
            this.deferredBindings.delete(row.id);
            continue nextRow;
          }
          for (const m of page.messages) {
            if (m.ts > 0 && m.ts - row.deliveredAt > DELIVERY_LAG_MS) {
              // A later native append may flush an earlier spoken turn's timestamp.
              if (this.store.textBoundary) continue;
              closed = true;
              break;
            }
            if (m.role !== "user" || !m.text || injectionFingerprint(m.text) !== row.fingerprint) continue;
            // A buffered terminal record can be appended past the offset long after it was authored.
            if ((this.store.textBoundary || row.transcriptOffset === null) && m.ts < row.deliveredAt) continue;
            if (isClaimed(m, claimed)) continue;
            found = m;
            break;
          }
          if (found || closed || page.atEnd || page.end <= from) break;
          from = page.end;
          if (singlePage) {
            this.scanned.set(row.id, from);
            return false;
          }
        }
      } catch (err) {
        if (this.store.textBoundary) this.deferredBindings.add(row.id);
        if (requireReadable) throw err;
        console.error(`[transcript] could not bind ${this.store.label}:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!found) {
        if (this.store.textBoundary && (!version || transcript.read.snapshot?.(transcript.path)?.version !== version)) {
          this.deferredBindings.add(row.id);
          continue;
        }
        this.deferredBindings.delete(row.id);
        if (closed || now - row.deliveredAt > DELIVERY_LAG_MS) this.expired.add(row.id);
        // Resume from the start of the last page read, not its end: a page can stop partway.
        else this.scanned.set(row.id, from);
        continue;
      }
      try {
        const boundary = this.store.textBoundary?.(row, transcript);
        if (this.store.textBoundary) {
          const stable = version && transcript.read.snapshot?.(transcript.path)?.version === version;
          if (boundary === null || !stable) this.deferredBindings.add(row.id);
          if (requireReadable && (boundary === null || !stable)) throw new Error("Could not verify a stable transcript boundary");
          if (!stable || !boundary) {
            if (stable && boundary === false) this.deferredBindings.delete(row.id);
            continue;
          }
        }
        beforeBind?.();
        if (!this.store.bind(row, found.id, found.ts, boundary || undefined)) continue;
        if (boundary) this.verifiedTextRows.add(row.id);
      } catch (err) {
        if (this.store.textBoundary) this.deferredBindings.add(row.id);
        if (requireReadable) throw err;
        console.error(`[transcript] could not bind ${this.store.label}:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      this.deferredBindings.delete(row.id);
      row.messageId = found.id;
      row.messageTs = found.ts;
      this.scanned.delete(row.id);
      claimed.add(found.id);
    }
    return true;
  }

  /**
   * Whether a bound row's turn is the only user turn in the transcript with its words and
   * timestamp - the condition for answering a re-synthesized id by timestamp. Judged on the
   * whole file, never on one page: a page holding only an operator repeat written in the same
   * millisecond would otherwise see one candidate and credit the repeat to the delivery.
   */
  private uniqueAtTimestamp(row: Row, transcript: SessionMessages, singlePage = false): boolean | undefined {
    const state = this.twins.get(row.id) ?? { from: 0, count: 0, final: false, checkSuffix: false };
    if (state === "ineligible") return false;
    this.twins.set(row.id, state);
    const handoff = this.store.textBoundary ? row.transcriptOffset ?? 0 : 0;
    try {
      while (!state.final) {
        const page = transcript.read.after(transcript.path, state.from, BIND_PAGE_TURNS, this.store.textBoundary ? "cooperative" : false);
        if (this.store.textBoundary && (page.skippedRecord || page.finishOversizedRecord)) {
          this.twins.set(row.id, "ineligible");
          return false;
        }
        for (const m of page.messages) {
          // Terminal records can be flushed out of timestamp order.
          if (!this.store.textBoundary && m.ts > row.messageTs!) {
            state.final = true;
            break;
          }
          if (m.role === "user" && m.ts === row.messageTs && m.text && injectionFingerprint(m.text) === row.fingerprint) {
            state.count += 1;
            if (this.store.textBoundary && (state.count > 1 || page.end <= handoff)) {
              this.twins.set(row.id, "ineligible");
              return false;
            }
            if (page.start < handoff) state.checkSuffix = true;
          }
        }
        if (state.final || page.atEnd || page.end <= state.from) {
          if (state.checkSuffix) {
            // The only match was on a page spanning the handoff. Its timestamp alone
            // cannot say which side it came from. Read from the exact byte boundary.
            state.from = handoff;
            state.count = 0;
            state.checkSuffix = false;
            if (singlePage) return undefined;
            continue;
          }
          if (this.store.textBoundary) state.final = true; // A new revision clears this scan.
          if (!state.final) state.from = Math.max(state.from, page.end);
          break;
        }
        state.from = page.end;
        if (singlePage) return undefined;
      }
    } catch (err) {
      console.error(`[transcript] could not read ${this.store.label}'s timestamp:`, err instanceof Error ? err.message : String(err));
      return false;
    }
    return state.count === 1;
  }

  private boundTextIntact(row: Row, transcript: SessionMessages | null): boolean {
    if (!this.store.textBoundary) return true;
    if (!transcript) return false;
    if (this.verifiedTextRows.has(row.id)) return true;
    if (!this.store.textBoundary(row, transcript)) return false;
    const version = this.scanVersions.get(row.noteKey);
    if (version && transcript.read.snapshot?.(transcript.path)?.version === version) this.verifiedTextRows.add(row.id);
    return true;
  }

  /**
   * The delivery bound to each turn in `messages`, by message id.
   *
   * Unbound deliveries are first bound against the transcript file (see `bindPending`), so the
   * answer never depends on which page is being read. A turn then answers by its exact native
   * id. A parser whose synthesized ids differ between reads falls back to the turn's words and
   * timestamp, but only when exactly one bound row and one turn on this page share them AND the
   * whole transcript holds exactly one such turn, so an identical turn in the same millisecond,
   * on this page or off it, never borrows the delivery. Without the transcript there is no
   * fallback at all.
   *
   * A text this conversation has rows for, on a turn none of them claims, is someone else's:
   * `matched` names those turns so the caller can tell them from "never delivered", where only
   * an in-memory label is left to ask.
   */
  bound(conversation: DeliveryConversation | null | undefined, messages: readonly TranscriptMessage[], now = Date.now()): BoundTurns<Row> {
    const result: BoundTurns<Row> = { rows: new Map(), matched: new Set(), ambiguous: new Set() };
    if (!conversation || (this.store.acceptsTranscript && !conversation.transcript)) return result;
    const rows = this.rows(conversation.key).filter(row => this.acceptsTranscript(row, conversation.transcript));
    if (!rows.length) return result;
    // Projection only needs spoken receipts that could own a turn on this page. A
    // candidate still searches forward from handoff, so a later visible copy cannot
    // steal an earlier native turn off screen. Reservations and pruning reconcile all rows.
    bindAll(conversation, now, this.store.textBoundary && !conversation.preparedSpokenFallbacks
      ? visibleSpokenCandidate(conversation.key, messages, conversation.transcript) : undefined);
    const fingerprints = new Set(rows.map((row) => row.fingerprint));
    // Deliveries that cannot be bound - contested, or sent without a known boundary. A turn with
    // their words written inside one's window could be that delivery, so no sender may be named
    // for it. Judged on the TURN's own time, not the clock now, so the doubt stays with the turn
    // for as long as the row is kept rather than lapsing once the window has passed.
    const unresolvedRows = rows.filter((row) => row.messageId === null && (row.contested || row.transcriptOffset === null));
    const couldBe = (fingerprint: string, m: TranscriptMessage) => unresolvedRows.some((row) => row.fingerprint === fingerprint
      && (m.ts <= 0 || (m.ts >= row.deliveredAt - DELIVERY_SKEW_MS && m.ts - row.deliveredAt <= DELIVERY_LAG_MS)));
    const byId = new Map(rows.filter((row) => row.messageId !== null).map((row) => [row.messageId!, row]));
    const pageIds = new Set(messages.map((m) => m.id));
    // Timestamp fallback candidates, counted on both sides so an ambiguous key answers nothing.
    const keyed = new Map<string, { rows: Row[]; turns: number }>();
    const prints = new Map<string, string>();
    for (const m of messages) {
      if (m.role !== "user" || !m.text) continue;
      const fingerprint = injectionFingerprint(m.text);
      if (!fingerprints.has(fingerprint)) continue;
      prints.set(m.id, fingerprint);
      const key = turnKey(fingerprint, m.ts);
      if (!key) continue;
      const entry = keyed.get(key) ?? { rows: [], turns: 0 };
      entry.turns += 1;
      keyed.set(key, entry);
    }
    for (const row of rows) {
      const key = turnKey(row.fingerprint, row.messageTs);
      // A row whose own turn is on this page answers by id and is no fallback candidate.
      if (key && row.messageId !== null && row.messageId !== row.id && !pageIds.has(row.messageId)) keyed.get(key)?.rows.push(row);
    }
    for (const m of messages) {
      const fingerprint = prints.get(m.id);
      if (!fingerprint) continue;
      result.matched.add(m.id);
      const clientReceipt = m.clientMessageId ? byId.get(m.clientMessageId) : undefined;
      // Some runtimes store the caller's receipt alongside their own native id.
      const exact = clientReceipt && clientReceipt.id === clientReceipt.messageId
        ? clientReceipt : byId.get(m.id);
      if (exact && this.store.requireExactFingerprint && exact.fingerprint !== fingerprint) continue;
      if (exact && (exact.messageId !== exact.id || exact.fingerprint === fingerprint)) {
        if (exact.messageId !== exact.id && this.store.textBoundary &&
            (exact.messageTs !== m.ts || !this.boundTextIntact(exact, conversation.transcript))) continue;
        if (exact.messageId === exact.id && exact.messageTs === null && this.store.observeClientReceipt) {
          if (!this.pendingObservations.has(exact.id)) {
            try {
              exact.messageTs = this.store.observeClientReceipt(exact.id, m.ts);
            } catch (error) {
              this.pendingObservations.set(exact.id, m.ts);
              console.warn("[transcript] Deferred native receipt observation:", error instanceof Error ? error.message : String(error));
            }
          }
        }
        result.rows.set(m.id, exact);
        continue;
      }
      const key = turnKey(fingerprint, m.ts);
      const entry = key ? keyed.get(key) : undefined;
      const row = entry && entry.turns === 1 && entry.rows.length === 1 ? entry.rows[0]! : null;
      if (row && conversation.transcript && this.acceptsTranscript(row, conversation.transcript)
        && (this.store.textBoundary && conversation.preparedSpokenFallbacks
        ? conversation.preparedSpokenFallbacks.has(row.id) : this.uniqueAtTimestamp(row, conversation.transcript))
          && this.boundTextIntact(row, conversation.transcript)) result.rows.set(m.id, row);
      else if (couldBe(fingerprint, m)) result.ambiguous.add(m.id);
    }
    return result;
  }
}
