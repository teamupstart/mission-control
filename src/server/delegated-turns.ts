import { randomUUID } from "node:crypto";
import type { TranscriptMessage, TurnOriginSession } from "@shared/types.ts";
import {
  bindDelegatedTurn,
  contestDelegatedTurn,
  deleteDelegatedTurn,
  insertDelegatedTurn,
  loadDelegatedTurns,
  pruneDelegatedTurns as pruneRows,
  type DelegatedTurnRow,
} from "./db.ts";
import type { SessionMessages } from "./harness/index.ts";
import { injectionFingerprint } from "./injections.ts";

/**
 * Which controlling session sent a delegated message, durably and per delivery.
 *
 * `injections.ts` answers "who typed this text" from memory, keyed by the text, which is
 * right for its Goal-suppression reader and wrong for this label on two counts: a restart
 * forgets it, so an older delegated message reads as the operator's, and identical words
 * from two controllers collapse into one entry, so both turns name whichever sent last.
 *
 * So each delivery is its own row, carrying the target transcript's byte size when it was
 * sent. Its turn is the first user turn with its words written AFTER that offset in the file
 * itself, not in whatever page a reader happens to hold. Rows bind in reservation order, so
 * identical words from two controllers each take their own turn, and a turn the operator
 * wrote before the delivery, or a page that skips the delivery's own turn, can never be
 * mistaken for it. Once bound, a row answers for that turn by native id and never moves.
 *
 * One ordering the file cannot settle: another send of the same words to the same target
 * that is in flight alongside the delegated one - from the operator, Foreman, or a different
 * controller. Either turn could be written first, so neither can be credited. Such a row is CONTESTED - persisted, never bound - and its words
 * read as nobody's delegation rather than risk naming the controller on the operator's turn.
 * Every other sender reports through `noteOtherSend` before it writes for exactly this.
 *
 * The daemon is this table's only writer, so a per-conversation cache stays coherent.
 */

/**
 * How long after a delivery its turn may first be written. An SDK target that is busy queues
 * the message until its current turn ends, so this is generous. It stops a delivery that
 * never produced a turn from claiming a much later operator turn with the same words.
 */
const DELIVERY_LAG_MS = 24 * 60 * 60_000;
/** Forward page size for the binding walk. */
const BIND_PAGE_TURNS = 50;

/** A target conversation, and the transcript its deliveries are bound against. */
export interface DelegatedConversation {
  key: string;
  transcript: SessionMessages | null;
}

const cache = new Map<string, DelegatedTurnRow[]>();
/** How far each unbound row's walk has read, so a later frame continues instead of restarting. */
const scanned = new Map<string, number>();
/**
 * Recent non-delegated sends, per target conversation and fingerprint, with the transcript size
 * when each began. In memory: it only needs to outlive a send that is still in flight.
 */
const otherSends = new Map<string, OtherSend[]>();
/** Rows whose window closed with no turn of theirs: never scanned again this process. */
const expired = new Set<string>();
/**
 * Per bound row, how many user turns in the whole transcript share its words and timestamp,
 * counted so far. Final once the walk passes a later timestamp; resumed from `from` until then.
 */
const twins = new Map<string, { from: number; count: number; final: boolean }>();

function rowsFor(noteKey: string): DelegatedTurnRow[] {
  let rows = cache.get(noteKey);
  if (!rows) {
    rows = loadDelegatedTurns(noteKey);
    cache.set(noteKey, rows);
  }
  return rows;
}

function sourceOf(row: DelegatedTurnRow): TurnOriginSession {
  return { id: row.controllerId, name: row.controllerName };
}

/** One non-delegated send; `offset` is null when the transcript size could not be read. */
interface OtherSend {
  at: number;
  offset: number | null;
}

/**
 * The transcript's size now: 0 when there is no transcript yet, null when there is one but
 * its size could not be read. Null is an unknown send boundary, never byte zero - binding
 * from zero would let an older operator turn with the same words be taken for this one.
 */
function sizeOf(transcript: SessionMessages | null): number | null {
  if (!transcript) return 0;
  try {
    return transcript.read.size(transcript.path) ?? 0;
  } catch {
    return null;
  }
}

function sendKey(noteKey: string, fingerprint: string): string {
  return `${noteKey}\0${fingerprint}`;
}

function recentSends(noteKey: string, fingerprint: string, now: number): OtherSend[] {
  const key = sendKey(noteKey, fingerprint);
  const recent = (otherSends.get(key) ?? []).filter((send) => now - send.at <= DELIVERY_LAG_MS);
  if (recent.length) otherSends.set(key, recent);
  else otherSends.delete(key);
  return recent;
}

/**
 * Whether another send of these words is still in flight: more were sent than have since been
 * written to the transcript, not counting turns delegated rows already own. Without a
 * transcript to count against, any recent send counts as in flight.
 */
function otherSendInFlight(conversation: DelegatedConversation, rows: DelegatedTurnRow[], fingerprint: string, now: number): boolean {
  const sends = recentSends(conversation.key, fingerprint, now);
  if (!sends.length) return false;
  const transcript = conversation.transcript;
  if (!transcript || sends.some((send) => send.offset === null)) return true;
  bindPending(rows, transcript, now);
  // A contested delivery's turn may already be among the matches below, and nothing says
  // which one it is, so no landed turn can be credited to the other sends: still in flight.
  if (rows.some((row) => row.fingerprint === fingerprint && row.messageId === null && (row.contested || row.transcriptOffset === null))) return true;
  const claimed = new Set(rows.flatMap((row) => row.messageId === null ? [] : [row.messageId]));
  let from = Math.min(...sends.map((send) => send.offset!));
  let landed = 0;
  try {
    for (;;) {
      const page = transcript.read.after(transcript.path, from, BIND_PAGE_TURNS);
      for (const m of page.messages) {
        if (m.role === "user" && m.text && !claimed.has(m.id) && injectionFingerprint(m.text) === fingerprint) landed += 1;
      }
      if (page.atEnd || page.end <= from) break;
      from = page.end;
    }
  } catch {
    return true;
  }
  return sends.length > landed;
}

function contest(row: DelegatedTurnRow, contested = true): void {
  contestDelegatedTurn(row.id, contested);
  row.contested = contested;
}

/**
 * Record a delegated delivery BEFORE it is attempted; returns its id for `releaseDelegatedTurn`.
 * The target transcript's size now is where its turn can first appear.
 */
export function reserveDelegatedTurn(
  conversation: DelegatedConversation,
  text: string,
  source: TurnOriginSession,
  now = Date.now(),
): string {
  // Loaded before the insert, or a cold cache would read this row back and then push it again.
  const rows = rowsFor(conversation.key);
  const fingerprint = injectionFingerprint(text);
  const offset = sizeOf(conversation.transcript);
  const row: DelegatedTurnRow = {
    id: randomUUID(),
    noteKey: conversation.key,
    fingerprint,
    controllerId: source.id,
    controllerName: source.name,
    deliveredAt: now,
    // Null when the size could not be read: an unknown boundary is never bound, whatever else.
    transcriptOffset: offset,
    contested: otherSendInFlight(conversation, rows, fingerprint, now),
    messageId: null,
    messageTs: null,
  };
  // Another controller's identical delivery still unwritten races this one: either turn could
  // land first and nothing in the file says which delivery wrote it, so neither is credited.
  // The same controller sending twice cannot swap names, so that stays bindable.
  if (conversation.transcript) bindPending(rows, conversation.transcript, now);
  const rivals = rows.filter((other) => other.fingerprint === fingerprint && other.messageId === null
    && other.controllerId !== source.id && !expired.has(other.id) && now - other.deliveredAt <= DELIVERY_LAG_MS);
  if (rivals.length) {
    row.contested = true;
    for (const other of rivals) if (!other.contested) contest(other);
  }
  insertDelegatedTurn(row);
  rows.push(row);
  return row.id;
}

/**
 * Another sender - the operator's composer, a queued turn, Foreman - is about to write these
 * words to the target. Remembered, so a delegated send that starts while it is in flight is
 * contested; and any delegated row of the same words still unbound once what has already
 * landed is bound is contested now, since the two turns may land in either order.
 */
export function noteOtherSend(conversation: DelegatedConversation, text: string, now = Date.now()): OtherSendHandle {
  const fingerprint = injectionFingerprint(text);
  const sends = recentSends(conversation.key, fingerprint, now);
  const send: OtherSend = { at: now, offset: sizeOf(conversation.transcript) };
  sends.push(send);
  otherSends.set(sendKey(conversation.key, fingerprint), sends);
  const handle: OtherSendHandle = { key: conversation.key, fingerprint, send };
  const rows = rowsFor(conversation.key);
  const racing = () => rows.filter((row) => row.fingerprint === fingerprint && row.messageId === null && !row.contested);
  if (!racing().length) return handle;
  if (conversation.transcript) bindPending(rows, conversation.transcript, now);
  for (const row of racing()) contest(row);
  return handle;
}

/** What `withdrawOtherSend` needs to take one send back. */
export interface OtherSendHandle {
  key: string;
  fingerprint: string;
  send: OtherSend;
}

/**
 * Take back a send with positive evidence that nothing landed. With no other send of those
 * words left to race them, the deliveries it contested are bindable again, so a failed
 * operator attempt does not cost the controller its label.
 */
export function withdrawOtherSend(handle: OtherSendHandle): void {
  const key = sendKey(handle.key, handle.fingerprint);
  const remaining = (otherSends.get(key) ?? []).filter((send) => send !== handle.send);
  if (remaining.length) {
    otherSends.set(key, remaining);
    return;
  }
  otherSends.delete(key);
  reconsider(handle.key, handle.fingerprint);
}

/**
 * Clear the contest on these words' unbound deliveries once nothing races them any more: no
 * other send remembered, and every unbound delivery left is one controller's, so no two turns
 * could be credited to the wrong name.
 */
function reconsider(noteKey: string, fingerprint: string): void {
  if (otherSends.has(sendKey(noteKey, fingerprint))) return;
  const open = rowsFor(noteKey).filter((row) => row.fingerprint === fingerprint && row.messageId === null);
  if (new Set(open.map((row) => row.controllerId)).size > 1) return;
  for (const row of open) if (row.contested) contest(row, false);
}

/** Give back a delivery with positive evidence that nothing landed. */
export function releaseDelegatedTurn(noteKey: string, id: string): void {
  const released = rowsFor(noteKey).find((row) => row.id === id);
  deleteDelegatedTurn(id);
  cache.set(noteKey, rowsFor(noteKey).filter((row) => row.id !== id));
  scanned.delete(id);
  // A rival that never landed no longer races the deliveries it contested.
  if (released) reconsider(noteKey, released.fingerprint);
}

/** A turn identity that survives a parser re-synthesizing ids, when the turn has a timestamp. */
function turnKey(fingerprint: string, ts: number | null): string | null {
  return ts && ts > 0 ? `${fingerprint}\0${ts}` : null;
}

/**
 * Walk the transcript forward from each unbound row's offset, in reservation order, and bind
 * the row to the first user turn with its words that no earlier row has claimed.
 */
function bindPending(rows: DelegatedTurnRow[], transcript: SessionMessages, now: number): void {
  // Claimed by id only: one walk reads ids consistently, and a timestamp two identical turns
  // can share would stop the second of them from ever being claimed.
  const claimed = new Set(rows.flatMap((row) => row.messageId === null ? [] : [row.messageId]));
  for (const row of rows) {
    if (row.messageId !== null || row.contested || row.transcriptOffset === null || expired.has(row.id)) continue;
    let from = scanned.get(row.id) ?? row.transcriptOffset;
    let found: TranscriptMessage | null = null;
    let closed = false;
    try {
      for (;;) {
        const page = transcript.read.after(transcript.path, from, BIND_PAGE_TURNS);
        for (const m of page.messages) {
          if (m.ts > 0 && m.ts - row.deliveredAt > DELIVERY_LAG_MS) {
            closed = true;
            break;
          }
          if (m.role !== "user" || !m.text || injectionFingerprint(m.text) !== row.fingerprint) continue;
          if (claimed.has(m.id)) continue;
          found = m;
          break;
        }
        if (found || closed || page.atEnd || page.end <= from) break;
        from = page.end;
      }
    } catch (err) {
      console.error("[transcript] could not bind a delegated turn:", err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!found) {
      if (closed || now - row.deliveredAt > DELIVERY_LAG_MS) expired.add(row.id);
      // Resume from the start of the last page read, not its end: a page can stop partway.
      else scanned.set(row.id, from);
      continue;
    }
    try {
      if (!bindDelegatedTurn(row.id, found.id, found.ts)) continue;
    } catch (err) {
      console.error("[transcript] could not bind a delegated turn:", err instanceof Error ? err.message : String(err));
      continue;
    }
    row.messageId = found.id;
    row.messageTs = found.ts;
    scanned.delete(row.id);
    claimed.add(found.id);
  }
}

/**
 * Whether a bound row's turn is the only user turn in the transcript with its words and
 * timestamp - the condition for answering a re-synthesized id by timestamp. Judged on the
 * whole file, never on one page: a page holding only an operator repeat written in the same
 * millisecond would otherwise see one candidate and credit the repeat to the controller.
 */
function uniqueAtTimestamp(row: DelegatedTurnRow, transcript: SessionMessages): boolean {
  const state = twins.get(row.id) ?? { from: 0, count: 0, final: false };
  twins.set(row.id, state);
  try {
    while (!state.final) {
      const page = transcript.read.after(transcript.path, state.from, BIND_PAGE_TURNS);
      for (const m of page.messages) {
        // Turns are written in time order, so nothing later can share this timestamp.
        if (m.ts > row.messageTs!) {
          state.final = true;
          break;
        }
        if (m.role === "user" && m.ts === row.messageTs && m.text && injectionFingerprint(m.text) === row.fingerprint) {
          state.count += 1;
        }
      }
      if (state.final || page.atEnd || page.end <= state.from) {
        if (!state.final) state.from = Math.max(state.from, page.end);
        break;
      }
      state.from = page.end;
    }
  } catch (err) {
    console.error("[transcript] could not read a delegated turn's timestamp:", err instanceof Error ? err.message : String(err));
    return false;
  }
  return state.count === 1;
}

/**
 * The sender of each delegated turn in `messages`, by message id.
 *
 * Unbound deliveries are first bound against the transcript file (see `bindPending`), so the
 * answer never depends on which page is being read. A turn then answers by its exact native
 * id. A parser whose synthesized ids differ between reads falls back to the turn's words and
 * timestamp, but only when exactly one bound row and one turn on this page share them AND the
 * whole transcript holds exactly one such turn, so an identical turn in the same millisecond,
 * on this page or off it, never borrows the controller's sender. Without the transcript there
 * is no fallback at all.
 *
 * A text this conversation has delegated rows for, on a turn none of them claims, is the
 * operator's: `contested` names those turns so the caller can tell them from "never
 * delegated", where only the in-memory label is left to ask.
 */
export function delegatedTurnSources(
  conversation: DelegatedConversation | null | undefined,
  messages: readonly TranscriptMessage[],
  now = Date.now(),
): { sources: Map<string, TurnOriginSession>; contested: Set<string> } {
  const sources = new Map<string, TurnOriginSession>();
  const contested = new Set<string>();
  if (!conversation) return { sources, contested };
  const rows = rowsFor(conversation.key);
  if (!rows.length) return { sources, contested };
  if (conversation.transcript && rows.some((row) => row.messageId === null && !row.contested && row.transcriptOffset !== null)) {
    bindPending(rows, conversation.transcript, now);
  }
  const fingerprints = new Set(rows.map((row) => row.fingerprint));
  const byId = new Map(rows.filter((row) => row.messageId !== null).map((row) => [row.messageId!, row]));
  const pageIds = new Set(messages.map((m) => m.id));
  // Timestamp fallback candidates, counted on both sides so an ambiguous key answers nothing.
  const keyed = new Map<string, { rows: DelegatedTurnRow[]; turns: number }>();
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
    if (key && row.messageId !== null && !pageIds.has(row.messageId)) keyed.get(key)?.rows.push(row);
  }
  for (const m of messages) {
    const fingerprint = prints.get(m.id);
    if (!fingerprint) continue;
    contested.add(m.id);
    const exact = byId.get(m.id);
    if (exact) {
      sources.set(m.id, sourceOf(exact));
      continue;
    }
    const key = turnKey(fingerprint, m.ts);
    const entry = key ? keyed.get(key) : undefined;
    const row = entry && entry.turns === 1 && entry.rows.length === 1 ? entry.rows[0]! : null;
    if (row && conversation.transcript && uniqueAtTimestamp(row, conversation.transcript)) sources.set(m.id, sourceOf(row));
  }
  return { sources, contested };
}

/** Drop rows of conversations no live session holds, on the goal table's prune tick. */
export function pruneDelegatedTurns(liveKeys: Iterable<string>, olderThan: number): number {
  const removed = pruneRows(liveKeys, olderThan);
  if (removed) forgetDelegatedTurnCache();
  return removed;
}

/** For tests, and after a prune: forget the cache so the next read comes from the table. */
export function forgetDelegatedTurnCache(): void {
  cache.clear();
  scanned.clear();
  expired.clear();
  twins.clear();
  otherSends.clear();
}
