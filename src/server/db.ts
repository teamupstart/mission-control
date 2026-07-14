import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";
import type {
  NoteDisposition,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
  SessionNote,
  SessionQueue,
  Task,
  TaskKind,
  TaskStatus,
  TrackedGap,
  WorkItem,
  WorkItemState,
  WorktreeProvider,
} from "@shared/types.ts";

/**
 * Durable state. Live sessions are intentionally NOT persisted - they're rebuilt
 * from the OS on every poll. What survives a restart is state the OS can't rebuild:
 * pending review items (a human decision may be waiting), dispatched tasks (their
 * backlog, running intent, and recent outcomes), and the session event log.
 */
let db: DatabaseSync;

export function openDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      status      TEXT NOT NULL,
      response    TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

    CREATE TABLE IF NOT EXISTS session_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, ts);

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      intent        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      agent         TEXT NOT NULL,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      tmux_session  TEXT,
      session_id    TEXT,
      status        TEXT NOT NULL,
      outcome       TEXT,
      outcome_url   TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_worktree ON tasks(worktree_path);

    CREATE TABLE IF NOT EXISTS session_notes (
      note_key       TEXT PRIMARY KEY,
      purpose        TEXT,
      brief          TEXT,
      recommendation TEXT,
      disposition    TEXT NOT NULL,
      last_action    TEXT,
      handled_marker TEXT,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS foreman_queues (
      note_key        TEXT PRIMARY KEY,   -- noteKeyFor(s) = agentSessionId ?? synthetic id
      cwd             TEXT,               -- + branch: the re-attach hint when the key dies
      branch          TEXT,
      wrapup_asked_at INTEGER,            -- the drain ask fires exactly once
      wrapup_answer   TEXT,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS foreman_queue_items (
      id                TEXT PRIMARY KEY,
      note_key          TEXT NOT NULL,
      seq               INTEGER NOT NULL,  -- whole-list renumber on reorder, in a txn
      intent            TEXT NOT NULL,
      state             TEXT NOT NULL,
      round             INTEGER NOT NULL DEFAULT 0,
      base_sha          TEXT,              -- HEAD at delivery -> scopes the diff
      transcript_anchor INTEGER,           -- transcript byte offset at delivery -> scopes it
      gaps              TEXT,              -- JSON TrackedGap[]
      send_attempts     INTEGER NOT NULL DEFAULT 0,
      verify_failures   INTEGER NOT NULL DEFAULT 0,
      escalation_reason TEXT,
      last_verdict      TEXT,
      approved_at       INTEGER,           -- set when a human approves a 'proposed' item
      recovered_at      INTEGER,           -- adopted mid-send after a restart -> never resend
      revision          INTEGER NOT NULL DEFAULT 0,  -- CAS token for edits
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      sent_at           INTEGER,
      completed_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fqi_queue ON foreman_queue_items(note_key, seq);

    -- Single-flight per queue, enforced by the DB rather than by hope: at most one
    -- item per note_key may be mid-cycle. The stakes are a duplicated WORK
    -- INSTRUCTION typed into a live agent, so this is a constraint, not a comment.
    CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_per_queue ON foreman_queue_items(note_key)
      WHERE state IN ('sending','awaiting_pickup','in_progress','verifying');
  `);
  migrate(db);
  return db;
}

/**
 * Schema migrations, run once per open after the CREATE TABLEs. Each must be
 * idempotent - this block runs on every start, not just on an upgrade.
 */
function migrate(d: DatabaseSync): void {
  // `queued` -> `backlog`: the task backlog stopped calling itself a queue, so
  // "queue" now only ever means a session's work queue. Rows persisted before the
  // rename still say 'queued', and `loadActiveTasks` would silently drop them from
  // the backlog on the next start. `tasks.status` is bare TEXT with no CHECK
  // constraint, so rewriting the value in place is safe.
  d.exec(`UPDATE tasks SET status='backlog' WHERE status='queued';`);
}

interface ReviewRow {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  response: string | null;
  created_at: number;
  resolved_at: number | null;
}

function rowToReview(r: ReviewRow): ReviewItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as ReviewKind,
    title: r.title,
    body: r.body,
    status: r.status as ReviewStatus,
    response: r.response,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function insertReview(r: ReviewItem): void {
  openDb()
    .prepare(
      `INSERT INTO reviews (id, session_id, kind, title, body, status, response, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.id, r.sessionId, r.kind, r.title, r.body, r.status, r.response, r.createdAt, r.resolvedAt);
}

export function updateReviewStatus(
  id: string,
  status: ReviewStatus,
  response: string | null,
  resolvedAt: number | null,
): void {
  openDb()
    .prepare(`UPDATE reviews SET status = ?, response = ?, resolved_at = ? WHERE id = ?`)
    .run(status, response, resolvedAt, id);
}

/** Reviews still awaiting a human decision - reloaded into the registry on start. */
export function loadPendingReviews(): ReviewItem[] {
  const rows = openDb()
    .prepare(`SELECT * FROM reviews WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as unknown as ReviewRow[];
  return rows.map(rowToReview);
}

export function logEvent(sessionId: string, ts: number, kind: string, payload: unknown): void {
  openDb()
    .prepare(`INSERT INTO session_events (session_id, ts, kind, payload) VALUES (?, ?, ?, ?)`)
    .run(sessionId, ts, kind, payload === undefined ? null : JSON.stringify(payload));
}

// ---- tasks ----

interface TaskRow {
  id: string;
  title: string;
  intent: string;
  kind: string;
  agent: string;
  repo_root: string;
  worktree_path: string | null;
  branch: string | null;
  provider: string | null;
  tmux_session: string | null;
  session_id: string | null;
  status: string;
  outcome: string | null;
  outcome_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    intent: r.intent,
    kind: r.kind as TaskKind,
    agent: r.agent as Task["agent"],
    repoRoot: r.repo_root,
    worktreePath: r.worktree_path,
    branch: r.branch,
    provider: r.provider as WorktreeProvider | null,
    tmuxSession: r.tmux_session,
    sessionId: r.session_id,
    status: r.status as TaskStatus,
    outcome: r.outcome,
    outcomeUrl: r.outcome_url,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
  };
}

export function upsertTask(t: Task): void {
  openDb()
    .prepare(
      `INSERT INTO tasks (
         id, title, intent, kind, agent, repo_root, worktree_path, branch, provider, tmux_session,
         session_id, status, outcome, outcome_url, error, created_at, updated_at,
         dispatched_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, intent=excluded.intent, kind=excluded.kind, agent=excluded.agent,
         repo_root=excluded.repo_root, worktree_path=excluded.worktree_path, branch=excluded.branch,
         provider=excluded.provider, tmux_session=excluded.tmux_session, session_id=excluded.session_id,
         status=excluded.status, outcome=excluded.outcome, outcome_url=excluded.outcome_url,
         error=excluded.error, updated_at=excluded.updated_at, dispatched_at=excluded.dispatched_at,
         completed_at=excluded.completed_at`,
    )
    .run(
      t.id, t.title, t.intent, t.kind, t.agent, t.repoRoot, t.worktreePath, t.branch, t.provider,
      t.tmuxSession, t.sessionId, t.status, t.outcome, t.outcomeUrl, t.error, t.createdAt,
      t.updatedAt, t.dispatchedAt, t.completedAt,
    );
}

export function getTask(id: string): Task | undefined {
  const r = openDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
    | TaskRow
    | undefined;
  return r ? rowToTask(r) : undefined;
}

export function deleteTask(id: string): void {
  openDb().prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

export function listTasks(): Task[] {
  const rows = openDb()
    .prepare(`SELECT * FROM tasks ORDER BY created_at DESC`)
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/** Tasks still in flight (backlog/dispatching/running) - reloaded into the registry on start. */
export function loadActiveTasks(): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('backlog','dispatching','running') ORDER BY created_at ASC`,
    )
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/**
 * The most recent terminal tasks (done/failed/cancelled), so the fleet report's
 * "recent outcomes" survives a daemon restart instead of vanishing even though
 * the row is still stored. Bounded so a long-lived history doesn't bloat memory.
 */
export function loadRecentTerminalTasks(limit: number): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('done','failed','cancelled')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/**
 * Terminal tasks that still hold a worktree (a `done` task awaiting reclaim, or a
 * failed-but-alive dispatch). Loaded regardless of the recent cap so their live
 * resources are always reconciled on start rather than orphaned once newer terminal
 * tasks push them past the cap.
 */
export function loadResourceHoldingTerminalTasks(): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('done','failed') AND worktree_path IS NOT NULL`,
    )
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

// ---- Foreman session notes ----

interface SessionNoteRow {
  note_key: string;
  purpose: string | null;
  brief: string | null;
  recommendation: string | null;
  disposition: string;
  last_action: string | null;
  handled_marker: string | null;
  updated_at: number;
}

function rowToNote(r: SessionNoteRow): SessionNote {
  return {
    noteKey: r.note_key,
    purpose: r.purpose,
    brief: r.brief,
    recommendation: r.recommendation,
    disposition: r.disposition as NoteDisposition,
    lastAction: r.last_action,
    handledMarker: r.handled_marker,
    updatedAt: r.updated_at,
  };
}

export function upsertSessionNote(n: SessionNote): void {
  openDb()
    .prepare(
      `INSERT INTO session_notes (
         note_key, purpose, brief, recommendation, disposition, last_action, handled_marker, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         purpose=excluded.purpose, brief=excluded.brief, recommendation=excluded.recommendation,
         disposition=excluded.disposition, last_action=excluded.last_action,
         handled_marker=excluded.handled_marker, updated_at=excluded.updated_at`,
    )
    .run(
      n.noteKey, n.purpose, n.brief, n.recommendation, n.disposition, n.lastAction,
      n.handledMarker, n.updatedAt,
    );
}

export function getSessionNote(noteKey: string): SessionNote | undefined {
  const r = openDb().prepare(`SELECT * FROM session_notes WHERE note_key = ?`).get(noteKey) as
    | unknown as SessionNoteRow | undefined;
  return r ? rowToNote(r) : undefined;
}

/** All notes, reloaded into the registry on start so Purpose survives a restart. */
export function loadSessionNotes(): SessionNote[] {
  const rows = openDb()
    .prepare(`SELECT * FROM session_notes ORDER BY updated_at DESC`)
    .all() as unknown as SessionNoteRow[];
  return rows.map(rowToNote);
}

// ---- Foreman session work queues ----

interface QueueRow {
  note_key: string;
  cwd: string | null;
  branch: string | null;
  wrapup_asked_at: number | null;
  wrapup_answer: string | null;
  updated_at: number;
}

interface QueueItemRow {
  id: string;
  note_key: string;
  seq: number;
  intent: string;
  state: string;
  round: number;
  base_sha: string | null;
  transcript_anchor: number | null;
  gaps: string | null;
  send_attempts: number;
  verify_failures: number;
  escalation_reason: string | null;
  last_verdict: string | null;
  approved_at: number | null;
  recovered_at: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  completed_at: number | null;
}

function rowToItem(r: QueueItemRow): WorkItem {
  return {
    id: r.id,
    noteKey: r.note_key,
    seq: r.seq,
    intent: r.intent,
    state: r.state as WorkItemState,
    round: r.round,
    baseSha: r.base_sha,
    transcriptAnchor: r.transcript_anchor,
    gaps: parseGaps(r.gaps),
    sendAttempts: r.send_attempts,
    verifyFailures: r.verify_failures,
    escalationReason: r.escalation_reason,
    lastVerdict: r.last_verdict,
    approvedAt: r.approved_at,
    recoveredAt: r.recovered_at,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at,
    completedAt: r.completed_at,
  };
}

/** Corrupt/absent gap JSON reads as "no gaps" - never throws out of a row read. */
function parseGaps(raw: string | null): TrackedGap[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as TrackedGap[]) : [];
  } catch {
    return [];
  }
}

export function upsertQueue(q: Omit<SessionQueue, "items">): void {
  openDb()
    .prepare(
      `INSERT INTO foreman_queues (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         cwd=excluded.cwd, branch=excluded.branch, wrapup_asked_at=excluded.wrapup_asked_at,
         wrapup_answer=excluded.wrapup_answer, updated_at=excluded.updated_at`,
    )
    .run(q.noteKey, q.cwd, q.branch, q.wrapupAskedAt, q.wrapupAnswer, q.updatedAt);
}

export function getQueueRow(noteKey: string): Omit<SessionQueue, "items"> | undefined {
  const r = openDb().prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`).get(noteKey) as
    | unknown as QueueRow | undefined;
  if (!r) return undefined;
  return {
    noteKey: r.note_key,
    cwd: r.cwd,
    branch: r.branch,
    wrapupAskedAt: r.wrapup_asked_at,
    wrapupAnswer: r.wrapup_answer,
    updatedAt: r.updated_at,
  };
}

/** Every stored queue (without items) - for the orphan sweep + the fleet list. */
export function listQueueRows(): Omit<SessionQueue, "items">[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queues ORDER BY updated_at DESC`)
    .all() as unknown as QueueRow[];
  return rows.map((r) => ({
    noteKey: r.note_key,
    cwd: r.cwd,
    branch: r.branch,
    wrapupAskedAt: r.wrapup_asked_at,
    wrapupAnswer: r.wrapup_answer,
    updatedAt: r.updated_at,
  }));
}

export function upsertQueueItem(i: WorkItem): void {
  openDb()
    .prepare(
      `INSERT INTO foreman_queue_items (
         id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
         send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
         recovered_at, revision, created_at, updated_at, sent_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         note_key=excluded.note_key, seq=excluded.seq, intent=excluded.intent,
         state=excluded.state, round=excluded.round, base_sha=excluded.base_sha,
         transcript_anchor=excluded.transcript_anchor, gaps=excluded.gaps,
         send_attempts=excluded.send_attempts, verify_failures=excluded.verify_failures,
         escalation_reason=excluded.escalation_reason, last_verdict=excluded.last_verdict,
         approved_at=excluded.approved_at, recovered_at=excluded.recovered_at,
         revision=excluded.revision,
         updated_at=excluded.updated_at, sent_at=excluded.sent_at,
         completed_at=excluded.completed_at`,
    )
    .run(
      i.id, i.noteKey, i.seq, i.intent, i.state, i.round, i.baseSha, i.transcriptAnchor,
      JSON.stringify(i.gaps), i.sendAttempts, i.verifyFailures, i.escalationReason,
      i.lastVerdict, i.approvedAt, i.recoveredAt, i.revision, i.createdAt, i.updatedAt,
      i.sentAt, i.completedAt,
    );
}

export function getQueueItem(id: string): WorkItem | undefined {
  const r = openDb().prepare(`SELECT * FROM foreman_queue_items WHERE id = ?`).get(id) as
    | unknown as QueueItemRow | undefined;
  return r ? rowToItem(r) : undefined;
}

/** A queue's items in authored order. */
export function listQueueItems(noteKey: string): WorkItem[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queue_items WHERE note_key = ? ORDER BY seq ASC`)
    .all(noteKey) as unknown as QueueItemRow[];
  return rows.map(rowToItem);
}

export function deleteQueueItem(id: string): void {
  openDb().prepare(`DELETE FROM foreman_queue_items WHERE id = ?`).run(id);
}

/** Drop a queue row (its items are re-keyed or deleted by the caller first). */
export function deleteQueue(noteKey: string): void {
  openDb().prepare(`DELETE FROM foreman_queues WHERE note_key = ?`).run(noteKey);
}

/** The next authored position for a queue (max(seq) + 1, or 0 when empty). */
export function nextQueueSeq(noteKey: string): number {
  const r = openDb()
    .prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM foreman_queue_items WHERE note_key = ?`)
    .get(noteKey) as { m: number } | undefined;
  return (r?.m ?? -1) + 1;
}

/**
 * Renumber a whole queue to the given id order, in ONE transaction. Whole-list
 * (not a swap) because a partial renumber can transiently collide on seq, and the
 * authored order is the queue's entire contract - it must never be observable
 * half-applied. Ids not in `ids` keep their rows and are pushed after, so a stale
 * client list can't silently drop an item.
 */
export function reorderQueueItems(noteKey: string, ids: string[], now: number): void {
  const d = openDb();
  d.exec("BEGIN");
  try {
    const upd = d.prepare(
      `UPDATE foreman_queue_items SET seq = ?, updated_at = ? WHERE id = ? AND note_key = ?`,
    );
    // Two passes over a scratch offset: seq has no UNIQUE constraint, but writing
    // the final numbers directly still means the list passes through states where
    // two rows share a seq. Ordering by the scratch pass keeps the intermediate
    // rows unambiguous if anything reads mid-transaction.
    const scratch = 1_000_000;
    ids.forEach((id, i) => upd.run(scratch + i, now, id, noteKey));
    ids.forEach((id, i) => upd.run(i, now, id, noteKey));
    // Anything the client didn't list (added concurrently) keeps a stable order
    // after the reordered block rather than colliding at seq 0.
    d.prepare(
      `UPDATE foreman_queue_items SET seq = seq + ?, updated_at = ?
       WHERE note_key = ? AND seq >= ?`,
    ).run(ids.length, now, noteKey, scratch);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

// ---- generic app config (Foreman config, future singletons) ----

/** Read a JSON-encoded config blob by key, or undefined when unset/corrupt. */
export function getAppConfig<T>(key: string): T | undefined {
  const r = openDb().prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return undefined;
  }
}

export function setAppConfig(key: string, value: unknown): void {
  openDb()
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(key, JSON.stringify(value));
}
