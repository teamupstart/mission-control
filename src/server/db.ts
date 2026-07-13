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
  Task,
  TaskKind,
  TaskStatus,
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
  `);
  return db;
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

/** Tasks still in flight (queued/dispatching/running) - reloaded into the registry on start. */
export function loadActiveTasks(): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('queued','dispatching','running') ORDER BY created_at ASC`,
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
