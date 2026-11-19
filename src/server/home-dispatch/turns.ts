import { randomUUID } from "node:crypto";
import { HOME_DISPATCH_RETENTION_MS, TURN_EXCERPT_MAX } from "@shared/home-dispatch.ts";
import { openDb } from "../db.ts";

/**
 * The turn log (spec 7.9): one row per message the person sends, kept so a later approval can be
 * checked against what the session was actually shown. It never stores the full prompt: only a
 * 120-code-point excerpt, a yes or no for approval, and any 6-hex tokens the person typed.
 */

/** What a card shown in a turn recorded: enough to prove the person saw this revision. */
export interface ShownCard {
  key: string;
  changedAt: number;
  state: string;
  revisionHash: string | null;
}

export interface TurnRow {
  sessionId: string;
  promptId: string;
  openedAt: number;
  closedAt: number | null;
  excerpt: string;
  containsApproval: boolean;
  mentionedHashes: string[];
  cardsShown: ShownCard[];
}

interface RawTurnRow {
  session_id: string;
  prompt_id: string;
  opened_at: number;
  closed_at: number | null;
  excerpt: string;
  contains_approval: number;
  mentioned_hashes: string | null;
  cards_shown: string | null;
}

/**
 * The turn a `SessionStart` summary card is recorded in. Its id starts with this prefix so a reader
 * of the log can tell it from a person's turn. It plays no part in first-turn eligibility: that is
 * read from `home_dispatch_sessions.last_turn_at`, which only a person's turn sets (spec 7.3, 7.4).
 */
export const SESSION_START_TURN_PREFIX = "session-start:" as const;

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function decode(row: RawTurnRow): TurnRow {
  return {
    sessionId: row.session_id,
    promptId: row.prompt_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    excerpt: row.excerpt,
    containsApproval: row.contains_approval === 1,
    mentionedHashes: parseJsonArray<string>(row.mentioned_hashes),
    cardsShown: parseJsonArray<ShownCard>(row.cards_shown),
  };
}

// ---- approval words ---------------------------------------------------------------------

const APPROVAL_PHRASES = /\b(?:approve|approved|yes,\s*publish|publish\s+it)\b/i;
const NEGATIONS = /\b(?:not|no|don't|dont|do\s+not|never|can't|cannot|won't|wait|hold)\b/i;

// A sentence that opens with a question word is a question even without its `?` ("why would I
// approve that"). The spec lists it among the sentences that must never approve.
const QUESTION_OPENER = /^(?:why|how|what|when|where|who|which|would|could|should|do|does|did|can|will|is|are|shall)\b/i;

/** Sentence-level split: a terminator stays with its sentence so a trailing `?` is still seen. */
function sentencesOf(text: string): string[] {
  return text.match(/[^.!?\n]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

/**
 * Whether a prompt approves (spec 7.9, L13). True only when a sentence has an approval word as a
 * whole word, no negation BEFORE it in that same sentence, and is not a question (no trailing `?`,
 * no question word opening it). The whole
 * sentence is checked back to its start, not a window of a few words, and a question never
 * approves. Negations after the word do not matter ("Approve. Not sure about step two." is two
 * sentences, and "Not sure about the second step. Approve." approves).
 */
export function containsApproval(text: string): boolean {
  return sentencesOf(text.replace(/[‘’]/g, "'")).some((sentence) => {
    if (sentence.endsWith("?") || QUESTION_OPENER.test(sentence)) return false;
    const match = APPROVAL_PHRASES.exec(sentence);
    if (!match) return false;
    return !NEGATIONS.test(sentence.slice(0, match.index));
  });
}

/** Any 6-hex tokens, lowercased and de-duplicated, in the order typed. */
export function mentionedHashesIn(text: string): string[] {
  const found = text.toLowerCase().match(/\b[0-9a-f]{6}\b/g) ?? [];
  return [...new Set(found)];
}

/** The first 120 code points with whitespace collapsed. Never more of the prompt than this. */
export function excerptOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return Array.from(collapsed).slice(0, TURN_EXCERPT_MAX).join("");
}

// ---- the log ----------------------------------------------------------------------------

const turnsFor = (sessionId: string): TurnRow[] =>
  (
    openDb()
      .prepare("SELECT * FROM home_dispatch_turns WHERE session_id = ? ORDER BY opened_at, rowid")
      .all(sessionId) as unknown as RawTurnRow[]
  ).map(decode);

/** Every turn of a session, oldest first. */
export function listTurns(sessionId: string): TurnRow[] {
  return turnsFor(sessionId);
}

/** The session's latest turn: the current one while the model is working on it. */
export function latestTurn(sessionId: string): TurnRow | null {
  const row = openDb()
    .prepare("SELECT * FROM home_dispatch_turns WHERE session_id = ? ORDER BY opened_at DESC, rowid DESC LIMIT 1")
    .get(sessionId) as RawTurnRow | undefined;
  return row ? decode(row) : null;
}

export interface OpenTurnInput {
  sessionId: string;
  prompt: string;
  now?: number;
}

/**
 * Open a turn for a message the person sent: close any open turn, then store the excerpt, the
 * approval flag and the hashes. The card delta is added afterwards with `recordCardsShown`, once
 * the inbox has said which cards this turn shows.
 */
export function openTurn(input: OpenTurnInput): TurnRow {
  const now = input.now ?? Date.now();
  const d = openDb();
  pruneExpiredOncePerDay(now);
  d.prepare("UPDATE home_dispatch_turns SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL").run(now, input.sessionId);
  const promptId = randomUUID();
  d.prepare(
    `INSERT INTO home_dispatch_turns
       (session_id, prompt_id, opened_at, excerpt, contains_approval, mentioned_hashes, cards_shown)
     VALUES (?, ?, ?, ?, ?, ?, '[]')`,
  ).run(
    input.sessionId,
    promptId,
    now,
    excerptOf(input.prompt),
    containsApproval(input.prompt) ? 1 : 0,
    JSON.stringify(mentionedHashesIn(input.prompt)),
  );
  d.prepare("UPDATE home_dispatch_sessions SET last_turn_at = ? WHERE session_id = ?").run(now, input.sessionId);
  return latestTurn(input.sessionId)!;
}

/**
 * Record the summary card `SessionStart` returned, as a turn with an empty excerpt that does not
 * count as the first turn. Skipped when there is nothing to record, so a quiet start writes no row.
 */
export function recordSessionStartCards(sessionId: string, cards: readonly ShownCard[], now = Date.now()): void {
  if (cards.length === 0) return;
  openDb()
    .prepare(
      `INSERT INTO home_dispatch_turns (session_id, prompt_id, opened_at, closed_at, excerpt, contains_approval, mentioned_hashes, cards_shown)
       VALUES (?, ?, ?, ?, '', 0, '[]', ?)`,
    )
    .run(sessionId, `${SESSION_START_TURN_PREFIX}${randomUUID()}`, now, now, JSON.stringify(cards));
}

/** Record what a turn showed, as `{ key, changedAt, state, revisionHash }` per card. */
export function recordCardsShown(sessionId: string, promptId: string, cards: readonly ShownCard[]): void {
  openDb()
    .prepare("UPDATE home_dispatch_turns SET cards_shown = ? WHERE session_id = ? AND prompt_id = ?")
    .run(JSON.stringify(cards), sessionId, promptId);
}

/** `Stop`: close the session's open turn and stamp `last_stop_at`. Returns whether a turn was open. */
export function closeTurn(sessionId: string, now = Date.now()): boolean {
  const d = openDb();
  const closed = d
    .prepare("UPDATE home_dispatch_turns SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL")
    .run(now, sessionId);
  d.prepare("UPDATE home_dispatch_sessions SET last_stop_at = ? WHERE session_id = ?").run(now, sessionId);
  return Number(closed.changes) > 0;
}

// ---- retention (spec 5, 7.1) ------------------------------------------------------------

const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

/** Delete turns and receipts older than 7 days. Returns how many rows went. */
export function pruneExpiredHomeDispatchLog(now = Date.now()): number {
  const cutoff = now - HOME_DISPATCH_RETENTION_MS;
  const d = openDb();
  const turns = d.prepare("DELETE FROM home_dispatch_turns WHERE opened_at < ?").run(cutoff);
  const receipts = d.prepare("DELETE FROM home_dispatch_receipts WHERE created_at < ?").run(cutoff);
  return Number(turns.changes) + Number(receipts.changes);
}

/**
 * The daily cleanup, run from the one place that is already flag-gated: opening a turn. A timer
 * would have to start and stop with the flag; this runs only while the flag is on and a person is
 * using the feature, and costs one comparison otherwise.
 */
function pruneExpiredOncePerDay(now: number): void {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  pruneExpiredHomeDispatchLog(now);
}

/** For tests: forget when the last cleanup ran. */
export function resetTurnLogCleanupClock(): void {
  lastPruneAt = 0;
}
