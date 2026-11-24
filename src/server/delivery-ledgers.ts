import { setImmediate as yieldToDaemon } from "node:timers/promises";
import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { PendingTurn, TranscriptMessage } from "@shared/types.ts";
import {
  bindDelegatedTurn,
  bindReviewDelivery,
  bindSpokenTurn,
  contestDelegatedTurn,
  contestReviewDelivery,
  contestSpokenTurn,
  deleteDelegatedTurn,
  deleteExpiredSpokenReservations,
  deleteReviewDelivery,
  deleteSpokenTurn,
  expiredSpokenConversationKeys,
  inTransaction,
  insertDelegatedTurn,
  insertReviewDelivery,
  insertSpokenTurn,
  loadDelegatedTurns,
  loadReviewDeliveries,
  loadSpokenTurns,
  moveSpokenTurns,
  observeSpokenClientReceipt,
  openDb,
  type BindableDelivery,
  recordSpokenHandoff,
  processSpokenReleases,
  spokenTranscriptLocators,
  spokenTranscriptState,
  takeDiscardedSpokenKeys,
  type DelegatedTurnRow,
  type ReviewDeliveryRow,
  type SpokenTranscriptLocator,
  type SpokenTurnRow,
} from "./db.ts";
import type { PreparedTranscriptBoundaries, TranscriptSession } from "./harness/types.ts";
import { DELIVERY_LAG_MS, DeliveryLedger, forgetDeliveryBindingState, finishHandoffWalk, handoffNeedsTranscript, handoffSenderState, reconcileHandoffRows, settledHandoffOffsets, onSend, registerDeliveryLedgers, type DeliveryConversation } from "./delivery-binding.ts";
import { injectionFingerprint } from "./injections.ts";
import { readSteerEcho, settleSteerEchoesBeforeSend, STEER_ECHO_UNREADABLE, STEER_ECHO_PENDING } from "./review-steer-echo.ts";

export {
  noteOtherSend,
  rememberedOtherSendKeys,
  withdrawOtherSend,
  type OtherSendHandle,
} from "./delivery-binding.ts";

/**
 * The composition point for every recorded-delivery table, constructed and registered together.
 *
 * The binding rule treats the ledgers as one claim space: a turn is bound by at most one row of
 * any of them, and rows of the same words in different ledgers contest each other. That only holds
 * if every ledger is registered before any binding, reservation or other send runs. Constructing
 * them here, in one module that both `delegated-turns.ts` and `review-deliveries.ts` import, means
 * whichever is loaded first brings the other's rows into the claim space with it, rather than the
 * claim space depending on which delivery module some caller happened to import. The same holds for
 * what a ledger must do before any send into that space: the review ledger's steered-echo listener
 * is installed here, with the ledger, so a delegated send settles a review delivery's echo even in
 * a process that never imported `review-deliveries.ts`.
 */

/** A controlling session's delegated messages (`delegated-turns.ts`). */
export const delegatedLedger = new DeliveryLedger<DelegatedTurnRow>({
  label: "a delegated turn",
  load: loadDelegatedTurns,
  insert: insertDelegatedTurn,
  remove: deleteDelegatedTurn,
  contest: contestDelegatedTurn,
  bind: (row, id, ts) => bindDelegatedTurn(row.id, id, ts),
  // The label a row would show: two rows with the same one cannot be credited to the wrong sender.
  sender: (row) => `${row.controllerId}\0${row.controllerName}`,
});

/** Each workflow send attempt can bind one native turn, including a delayed echo after restart. */
type WorkflowDeliveryTurn = BindableDelivery & { deliveryId: string; transcriptPath: string | null };
export const WORKFLOW_TRANSCRIPT_ANCHOR_LIMIT = 200;
export const workflowDeliveryLedger = new DeliveryLedger<WorkflowDeliveryTurn>({
  label: "a workflow packet",
  acceptsTranscript: (row, transcript) => row.transcriptPath === null || row.transcriptPath === transcript.path,
  requireExactFingerprint: true,
  maxCachedConversations: 200,
  load: key => {
    const db = openDb();
    const retained = "has_transcript_receipt = 1 AND payload_pruned_at IS NULL AND note_key = ?";
    // Seek directly to each originating session, including predecessors after a transfer.
    // DISTINCT or a window function here would walk all of a long conversation's history.
    const nextSession = db.prepare(`SELECT session_id FROM workflow_deliveries
      WHERE ${retained} AND session_id > ? ORDER BY session_id LIMIT 1`);
    const forSession = `${retained} AND session_id = ?`;
    const window = db.prepare(`
      WITH recent AS (SELECT id FROM workflow_deliveries WHERE ${forSession} AND delivered_at IS NOT NULL
                      ORDER BY delivered_at DESC, id DESC LIMIT ?),
      eligible(id, oldest_receipt) AS (
        SELECT id, NULL FROM recent
        UNION SELECT id, NULL FROM workflow_deliveries WHERE ${forSession} AND delivered_at IS NULL AND state = 'sending'
        UNION SELECT id, ? FROM workflow_deliveries WHERE ${forSession} AND delivered_at IS NULL AND state = 'uncertain' AND updated_at >= ?
        UNION SELECT id, NULL FROM workflow_deliveries WHERE ${forSession} AND delivered_at >= ?
      )
      SELECT turns.rowid AS ordinal, turns.id, delivery_id AS deliveryId, transcript_path AS transcriptPath, note_key AS noteKey,
             fingerprint, delivered_at AS deliveredAt, transcript_offset AS transcriptOffset, contested,
             message_id AS messageId, message_ts AS messageTs
        FROM eligible JOIN workflow_delivery_turns turns ON turns.delivery_id = eligible.id
       WHERE discarded_at IS NULL AND (oldest_receipt IS NULL OR delivered_at >= oldest_receipt)`);
    type StoredTurn = Omit<WorkflowDeliveryTurn, "contested"> & { ordinal: number; contested: number };
    const rows: StoredTurn[] = [];
    const cutoff = Date.now() - DELIVERY_LAG_MS;
    let after = "";
    for (;;) {
      const origin = nextSession.get(key, after) as { session_id: string } | undefined;
      if (!origin) break;
      after = origin.session_id;
      for (const row of window.iterate(key, after, WORKFLOW_TRANSCRIPT_ANCHOR_LIMIT, key, after,
        cutoff, key, after, cutoff, key, after, cutoff)) {
        rows.push(row as unknown as StoredTurn);
      }
    }
    return rows.sort((a, b) => a.ordinal - b.ordinal).map(({ ordinal: _ordinal, ...row }) => ({ ...row, contested: Boolean(row.contested) }));
  },
  insert: row => {
    openDb().prepare(
      `INSERT INTO workflow_delivery_turns
         (id, delivery_id, transcript_path, note_key, fingerprint, delivered_at, transcript_offset, contested, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.deliveryId, row.transcriptPath, row.noteKey, row.fingerprint, row.deliveredAt, row.transcriptOffset, Number(row.contested), row.messageId);
  },
  remove: id => { openDb().prepare("DELETE FROM workflow_delivery_turns WHERE id = ?").run(id); },
  contest: (id, contested) => {
    openDb().prepare("UPDATE workflow_delivery_turns SET contested = ? WHERE id = ? AND message_id IS NULL")
      .run(Number(contested), id);
  },
  bind: (row, id, ts) => Boolean(openDb().prepare(
    "UPDATE workflow_delivery_turns SET message_id = ?, message_ts = ? WHERE id = ? AND message_id IS NULL AND discarded_at IS NULL",
  ).run(id, ts, row.id).changes),
  sender: () => "workflow",
});

let checkDiscardedWorkflowReceipts = true;

/** The delivery transition already made this receipt ineligible, even if deleting it fails. */
export function noteDiscardedWorkflowReceipt(noteKey: string): void {
  workflowDeliveryLedger.forgetConversation(noteKey);
  checkDiscardedWorkflowReceipts = true;
}

function cleanDiscardedWorkflowReceipts(): void {
  if (!checkDiscardedWorkflowReceipts || openDb().isTransaction) return;
  checkDiscardedWorkflowReceipts = false;
  try {
    inTransaction(() => {
      const rows = openDb().prepare(
        "DELETE FROM workflow_delivery_turns WHERE discarded_at IS NOT NULL RETURNING note_key AS noteKey, fingerprint",
      ).all() as { noteKey: string; fingerprint: string }[];
      for (const row of rows) {
        workflowDeliveryLedger.forgetConversation(row.noteKey);
        workflowDeliveryLedger.reconsider(row.noteKey, row.fingerprint);
      }
    });
  } catch {
    // Retry on the next ledger read. A rolled-back reconsideration cannot survive in cache.
    forgetDeliveryBindingState();
    checkDiscardedWorkflowReceipts = true;
  }
}

const reviewForgetHooks: Array<() => void> = [];

/** Mission Control's own messages about a review (`review-deliveries.ts`). */
export const reviewLedger = new DeliveryLedger<ReviewDeliveryRow>({
  label: "a review message",
  load: loadReviewDeliveries,
  insert: insertReviewDelivery,
  remove: deleteReviewDelivery,
  contest: contestReviewDelivery,
  bind: (row, id, ts) => bindReviewDelivery(row.id, id, ts),
  // Every review message is Mission Control's, so two of the same words never contest each other.
  sender: () => "mission-control",
}, () => {
  for (const hook of reviewForgetHooks) hook();
});

/** Drop what `review-deliveries.ts` derived from the review rows whenever their caches drop. */
export function onReviewLedgerForget(hook: () => void): void {
  reviewForgetHooks.push(hook);
}

// Before any send into the claim space, a bound review delivery's steered echo is settled from
// what the file already holds (`review-steer-echo.ts`), so the new send's turn can never take it.
onSend(settleSteerEchoesBeforeSend(reviewLedger));

export const spokenLedger = new DeliveryLedger<SpokenTurnRow>({
  label: "a spoken message",
  // Reads include archived sessions and hourly cleanup, which can outlive Registry eviction.
  maxCachedConversations: 32,
  requireExactFingerprint: true,
  takeInvalidatedKeys: takeDiscardedSpokenKeys,
  textBoundary(row, transcript) {
    if (row.transcriptOffset === null) {
      // bindPending checked the file's creation time. Pin its identity on the first binding.
      if (row.messageId !== null || row.transcriptBoundary !== "missing") return false;
      return transcript.read.boundary?.(transcript.path, 0) ?? null;
    }
    if (row.transcriptBoundary === null) return false;
    const boundary = transcript.read.boundary?.(transcript.path, row.transcriptOffset);
    if (!boundary) return null;
    return boundary.proof === row.transcriptBoundary ? boundary : false;
  },
  newTranscriptAfter(transcript, deliveredAt) {
    try {
      const created = statSync(transcript.path).birthtimeMs;
      return created > 0 && Math.floor(created) > deliveredAt;
    } catch {
      return null;
    }
  },
  load: loadSpokenTurns,
  insert: insertSpokenTurn,
  remove: deleteSpokenTurn,
  contest: contestSpokenTurn,
  bind(row, id, ts, boundary) {
    if (!boundary || !bindSpokenTurn(row.id, id, ts, boundary)) return false;
    row.transcriptOffset = boundary.offset;
    row.transcriptBoundary = boundary.proof;
    return true;
  },
  observeClientReceipt: observeSpokenClientReceipt,
  sender: row => row.spokenWords,
});

type SpokenConversation = DeliveryConversation & { session?: Pick<TranscriptSession, "agent" | "cwd" | "transcriptPath"> };

/** On runtimes that accept a native user-message id, reserve that identity before the write. */
export function reserveSpokenTurn(conversation: SpokenConversation, spokenWords: string, received: string,
  clientMessageIds: boolean, attempt: Pick<PendingTurn, "id" | "revision"> & { reservationId: string }, now = Date.now()) {
  return spokenLedger.reserve(conversation, received, base => {
    const transcript = conversation.transcript;
    const boundary = !clientMessageIds && transcript ? transcript.read.boundary?.(transcript.path) : null;
    return {
      ...base, spokenWords, received, outboxTurnId: attempt.id, outboxRevision: attempt.revision,
      messageId: clientMessageIds ? base.id : null,
      transcriptOffset: boundary?.offset ?? base.transcriptOffset,
      transcriptBoundary: boundary?.proof ?? (!clientMessageIds && !transcript ? "missing" : null),
      transcriptAgent: conversation.session?.agent ?? null,
      transcriptCwd: conversation.session?.cwd ?? null,
      transcriptPath: transcript?.path ?? conversation.session?.transcriptPath ?? null,
    };
  }, now, attempt.reservationId);
}

export function followSpokenConversationKey(sessionId: string, fromKey: string, toKey: string): void {
  if (fromKey === sessionId && fromKey !== toKey && moveSpokenTurns(fromKey, toKey)) spokenLedger.forgetCaches();
}

export interface PreparedSpokenTranscript {
  path: string;
  capture: PreparedTranscriptBoundaries;
  fingerprint: string;
  senderState: string;
  receipt: string | null;
  decisions: NonNullable<DeliveryConversation["preparedHandoff"]>;
  checkFile: boolean;
}
export const SPOKEN_TRANSCRIPT_CHANGED = "The transcript changed while preparing the spoken message.";
export class SpokenTranscriptChanged extends Error {
  constructor() { super(SPOKEN_TRANSCRIPT_CHANGED); }
}

export class SpokenTranscriptUnavailable extends Error {
  constructor(cause: unknown) {
    super("The transcript worker could not prepare the spoken message.", { cause });
  }
}

export async function prepareSpokenTranscript(key: string, transcript: NonNullable<DeliveryConversation["transcript"]>,
  text: string, clientMessageIds = false, now = Date.now()): Promise<PreparedSpokenTranscript> {
  const { path, read } = transcript;
  const fingerprint = injectionFingerprint(text);
  const offsets = spokenLedger.rows(key).filter(row => row.messageId === null && !row.contested && row.transcriptBoundary !== null)
    .map(row => row.transcriptOffset ?? 0);
  offsets.push(...settledHandoffOffsets(key, fingerprint, now));
  let capture: PreparedTranscriptBoundaries | null;
  try {
    capture = read.prepareHandoffBoundaries && (!clientMessageIds || offsets.length)
      ? await read.prepareHandoffBoundaries(path, offsets, !clientMessageIds)
      : { version: read.snapshot?.(path)?.version ?? null, eof: null, proofs: new Map() };
  } catch (error) {
    throw new SpokenTranscriptUnavailable(error);
  }
  if (!capture) throw new SpokenTranscriptChanged();
  const verified = { path, read: { ...read, boundary: (_path: string, offset?: number) =>
    offset === undefined ? capture.eof : capture.proofs.get(offset) ?? null } };
  const check = () => {
    if ((read.snapshot?.(path)?.version ?? null) !== capture.version) throw new SpokenTranscriptChanged();
  };
  const checkFile = !clientMessageIds || handoffNeedsTranscript(key, fingerprint, now);
  if (checkFile) {
    check();
    if (capture.version !== null) {
      await reconcileHandoffRows(key, verified, now, check, async () => {
        const prior = handoffSenderState(key, fingerprint, now);
        const receipt = spokenTranscriptState(key)?.receipt;
        await yieldToDaemon();
        check();
        if (prior !== handoffSenderState(key, fingerprint, now) || receipt !== spokenTranscriptState(key)?.receipt) {
          throw new SpokenTranscriptChanged();
        }
      });
    }
  }
  const senderState = handoffSenderState(key, fingerprint, now);
  const receipt = spokenTranscriptState(key)?.receipt ?? null;
  const reviewEchoes = new Map<string, string | null>();
  let otherInFlight = false;
  if (checkFile) {
    for (const row of reviewLedger.rows(key)) {
      if (row.messageId === null || row.fingerprint !== fingerprint || row.steerEcho !== null) continue;
      const echo = await finishHandoffWalk(readSteerEcho(row, verified), check);
      if (echo !== STEER_ECHO_UNREADABLE) reviewEchoes.set(row.id, echo === STEER_ECHO_PENDING ? null : echo);
    }
    otherInFlight = await finishHandoffWalk(spokenLedger.otherSendInFlight({ key, transcript: verified }, fingerprint, now, true), check);
    check();
  }
  return { path, capture, fingerprint, senderState, receipt, decisions: { otherInFlight, reviewEchoes }, checkFile };
}

export interface SpokenPageAnchor {
  /** File revision sampled before the native parser read this frame. */
  version: string | undefined;
  end: number;
  reread: () => TranscriptMessage[];
}

/** A visible frame is anchored to complete bytes. Growth after that anchor is allowed when
 * two worker captures agree through the end and the intervening read reproduces the page. */
export async function withSpokenReadProofs<T>(conversation: DeliveryConversation | null, messages: TranscriptMessage[] | undefined,
  project: (conversation: DeliveryConversation | null) => T, anchor?: SpokenPageAnchor): Promise<T> {
  const transcript = conversation?.transcript;
  const prepare = transcript?.read.prepareHandoffBoundaries;
  if (!conversation || !transcript || !prepare || !spokenLedger.rows(conversation.key).length) return project(conversation);
  const { path, read } = transcript;
  const pageMatches = () => {
    try { return !!anchor && isDeepStrictEqual(anchor.reread(), messages); }
    catch { return false; }
  };
  const captureOffsets = async (offsets: number[]) => {
    try {
      const capture = await prepare(path, offsets, false);
      return capture?.unreadable ? null : capture;
    } catch (error) { throw new SpokenTranscriptUnavailable(error); }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const version = read.snapshot?.(path)?.version;
    if (anchor && anchor.version !== version && !pageMatches()) throw new SpokenTranscriptChanged();
    const needed = spokenLedger.projectionOffsets(conversation.key, version, messages);
    const offsets = needed.length && anchor
      ? [...new Set([...spokenLedger.projectionOffsets(conversation.key, undefined, messages), anchor.end])] : needed;
    let capture = offsets.length ? await captureOffsets(offsets) : null;
    if (offsets.length && (!capture || capture.version !== version || read.snapshot?.(path)?.version !== version)) {
      const first = capture;
      if (!anchor || !first?.proofs.has(anchor.end) || !pageMatches()) continue;
      capture = await captureOffsets(offsets);
      if (!capture || !capture.fileId || capture.fileId !== first.fileId ||
          offsets.some(n => first.proofs.get(n)?.proof !== capture?.proofs.get(n)?.proof)) continue;
    }
    // Even growth on the same inode can include a prefix edit. Only the revision the
    // final worker pass verified can authorize a disclosure or a durable binding.
    const snapshot = () => {
      const live = read.snapshot?.(path);
      return live && (!capture || capture.version === live.version) ? live : null;
    };
    const valid = () => capture ? !!snapshot() : read.snapshot?.(path)?.version === version;
    if (capture && !valid()) continue;
    const verified = { path, read: { ...read, snapshot,
      boundary: (_path: string, offset?: number) => offset !== undefined && capture && valid() ? capture.proofs.get(offset) ?? null : null,
    } };
    const pageIsCurrent = () => valid() || (!capture && (!anchor || pageMatches()) &&
      !spokenLedger.projectionOffsets(conversation.key, read.snapshot?.(path)?.version, messages).length);
    const preparedSpokenFallbacks = await spokenLedger.prepareProjection(conversation.key, verified, messages);
    if (!preparedSpokenFallbacks || !pageIsCurrent()) continue;
    const result = project({ ...conversation, transcript: verified, preparedSpokenFallbacks });
    if (pageIsCurrent()) return result;
  }
  throw new SpokenTranscriptChanged();
}

/** At the transport guard, the receiving cycle and its corresponding ledger reservation commit together. */
export function reserveSpokenHandoff(conversation: SpokenConversation, turn: PendingTurn, words: string,
  clientMessageIds: boolean, generation: number, now: number, prepared?: PreparedSpokenTranscript): SpokenTurnRow | null {
  const transcript = conversation.transcript;
  const capture = prepared?.capture;
  const checkRevision = () => {
    if (clientMessageIds && !prepared?.checkFile) return;
    if (transcript?.path !== prepared?.path || (transcript &&
        (!capture || (transcript.read.snapshot?.(transcript.path)?.version ?? null) !== capture.version))) throw new SpokenTranscriptChanged();
  };
  checkRevision();
  if (prepared && (injectionFingerprint(turn.text) !== prepared.fingerprint ||
      handoffSenderState(conversation.key, prepared.fingerprint, now) !== prepared.senderState ||
      (spokenTranscriptState(conversation.key)?.receipt ?? null) !== prepared.receipt)) throw new SpokenTranscriptChanged();
  if (transcript && !prepared && clientMessageIds && handoffNeedsTranscript(conversation.key, injectionFingerprint(turn.text), now)) {
    throw new SpokenTranscriptChanged();
  }
  const atHandoff = prepared && transcript && capture ? { ...conversation, preparedHandoff: prepared.decisions, transcript: {
    path: transcript.path, read: { ...transcript.read,
      boundary: (_path: string, offset?: number) => offset === undefined ? capture.eof : capture.proofs.get(offset) ?? null,
    },
  } } : clientMessageIds && transcript ? { ...conversation, preparedHandoff: { otherInFlight: false, reviewEchoes: new Map() } } : conversation;
  // Process invalidations from prior outbox transactions before the ledger is read inside this one.
  spokenLedger.rows(conversation.key);
  try {
    return inTransaction(() => {
      const reservationId = recordSpokenHandoff(turn.id, turn.revision, generation, now);
      if (!reservationId) return null;
      const row = reserveSpokenTurn(atHandoff, words, turn.text, clientMessageIds, { ...turn, reservationId }, now);
      checkRevision();
      return row;
    });
  } catch (error) {
    // Binding can also have updated the other ledgers' contests before the insert or commit failed.
    forgetDeliveryBindingState();
    throw error;
  }
}

type SpokenTranscript = NonNullable<DeliveryConversation["transcript"]>;
type ScanResult = { transcript: SpokenTranscript; version: string | null; complete: boolean } | "retry";

// Only exact SDK identities can reuse a negative scan. A text binding also depends on other senders.
const sdkScans = new Map<string, { version: string; ids: Set<string> }>();

async function reconcileSpokenTurns(noteKey: string, transcript: SpokenTranscript, now: number, signal?: AbortSignal): Promise<ScanResult> {
  const snapshot = transcript.read.snapshot?.(transcript.path);
  if (!snapshot) return { transcript, version: null, complete: false };
  const rows = spokenLedger.rows(noteKey);
  const textPending = rows.some(row => row.messageId === null);
  const ids = rows.filter(row => row.messageId === row.id && row.messageTs === null).map(row => row.id);
  const cacheKey = JSON.stringify([noteKey, transcript.path]);
  const cached = sdkScans.get(cacheKey);
  const verified = { transcript, version: snapshot.version, complete: true };
  if (!textPending && cached?.version === snapshot.version && ids.every(id => cached.ids.has(id))) return verified;
  try {
    if (textPending) {
      let verified = transcript;
      if (transcript.read.prepareHandoffBoundaries) {
        const offsets = rows.filter(row => row.messageId === null && !row.contested).map(row => row.transcriptOffset ?? 0);
        const captured = await transcript.read.prepareHandoffBoundaries(transcript.path, [...new Set(offsets)], false);
        if (signal?.aborted || !captured || captured.unreadable || captured.version !== snapshot.version ||
            transcript.read.snapshot?.(transcript.path)?.version !== snapshot.version) return "retry";
        verified = { path: transcript.path, read: { ...transcript.read, boundary: (_path, offset) =>
          offset !== undefined && transcript.read.snapshot?.(transcript.path)?.version === captured.version
            ? captured.proofs.get(offset) ?? null : null } };
      }
      await spokenLedger.reconcileBeforePrune(noteKey, verified, now, snapshot.version, signal);
    }
    // A rewritten transcript can put an SDK UUID before its handoff offset. Exact IDs
    // can be observed from each page without starting another whole-file binding walk.
    let skippedRecord = false;
    for (let from = 0;;) {
      await yieldToDaemon();
      if (signal?.aborted || transcript.read.snapshot?.(transcript.path)?.version !== snapshot.version) return "retry";
      const first = transcript.read.after(transcript.path, from, 50, "cooperative");
      const page = first.finishOversizedRecord ? await first.finishOversizedRecord(signal) : first;
      if (page.start !== from || transcript.read.snapshot?.(transcript.path)?.version !== snapshot.version) return "retry";
      skippedRecord ||= !!page.skippedRecord;
      spokenLedger.bound({ key: noteKey, transcript: null }, page.messages, now);
      if (!spokenLedger.flushClientObservations(noteKey)) return "retry";
      if (page.atEnd) {
        // Later records can prove a receipt was seen. A skipped record prevents proving absence.
        if (skippedRecord) return "retry";
        if (page.end !== snapshot.size) {
          // A runtime can exit mid-record. Only a strict read through the actual EOF
          // can establish that all complete records were checked. Give the writer the
          // existing delivery window to finish its last record before expiring a receipt.
          if (page.partialTailEnd !== snapshot.size || snapshot.changedAt === undefined ||
              snapshot.changedAt > now - DELIVERY_LAG_MS) return "retry";
        }
        if (!textPending) {
          sdkScans.delete(cacheKey);
          if (sdkScans.size >= 32) sdkScans.delete(sdkScans.keys().next().value!);
          sdkScans.set(cacheKey, { version: snapshot.version, ids: new Set(ids) });
        }
        return verified;
      }
      if (page.end <= from || page.end >= snapshot.size) return "retry";
      from = page.end;
    }
  } catch (error) {
    console.warn("[voice] Could not reconcile spoken receipts:", error instanceof Error ? error.message : String(error));
    return error instanceof Error && "path" in error && error.path === transcript.path ? { ...verified, complete: false } : "retry";
  }
}

/** Final transcript pass for abandoned attempts and confirmed deliveries still awaiting a native match. */
export async function pruneExpiredSpokenTurns(now: number, transcriptsFor: (key: string, locators: SpokenTranscriptLocator[]) => DeliveryConversation["transcript"][],
  unavailableBefore?: number, signal?: AbortSignal): Promise<number> {
  const cutoff = now - DELIVERY_LAG_MS;
  let removed = 0;
  spokenLedger.flushClientObservations();
  for (const key of expiredSpokenConversationKeys(cutoff)) {
    if (signal?.aborted) break;
    if (!spokenLedger.flushClientObservations(key)) continue;
    const candidates = spokenLedger.rows(key).map(row => row.id);
    const sources = transcriptsFor(key, spokenTranscriptLocators(key));
    const scans: ScanResult[] = [];
    for (const source of sources) {
      if (source) scans.push(await reconcileSpokenTurns(key, source, now, signal));
      if (signal?.aborted) return removed;
    }
    // Both the files and the conversation's locators can change while a sibling scan yields.
    const paths = new Set(sources.map(s => s?.path));
    const current = new Set(transcriptsFor(key, spokenTranscriptLocators(key)).map(s => s?.path));
    if (current.size !== paths.size || [...current].some(path => !paths.has(path))) continue;
    if (scans.some(scan => scan === "retry" ||
      (scan.transcript.read.snapshot?.(scan.transcript.path)?.version ?? null) !== scan.version)) continue;
    if (scans.length && scans.length === sources.length && scans.every(scan => scan !== "retry" && scan.complete)) removed += deleteExpiredSpokenReservations(key, candidates, cutoff, cutoff);
    else if (unavailableBefore !== undefined) {
      removed += deleteExpiredSpokenReservations(key, candidates, null, Math.min(cutoff, unavailableBefore));
    }
  }
  return removed;
}

registerDeliveryLedgers([delegatedLedger, reviewLedger, spokenLedger, workflowDeliveryLedger], () => {
  cleanDiscardedWorkflowReceipts();
  try {
    processSpokenReleases(rows => {
      for (const { noteKey, fingerprint } of rows) {
        spokenLedger.forgetConversation(noteKey);
        spokenLedger.reconsider(noteKey, fingerprint);
      }
    });
  } catch (error) {
    // Contest writes roll back together with the release acknowledgement.
    forgetDeliveryBindingState();
    throw error;
  }
});
