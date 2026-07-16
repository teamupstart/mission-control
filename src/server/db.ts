import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.ts";
import type {
  NmFixReplySource,
  NoteDisposition,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
  SessionGoal,
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
import { IN_FLIGHT_ITEM_STATES, TERMINAL_ITEM_STATES } from "@shared/queue.ts";

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

    -- Who said what to a no-mistakes gate: the fix log's byline.
    --
    -- Its own table rather than a session_events kind, for three reasons that
    -- only look like taste until you try it:
    --  - hooksEverSeen reads ANY row in session_events for a session as "hooks
    --    reached us from this session", and leans in its own comment on there
    --    being exactly one writer. A second writer makes an uninstrumented
    --    session claim hooks, silently, in a fact that gates escalation.
    --  - the join key is the RUN, not the session. session_events is indexed
    --    (session_id, ts), which this could not use: the fix log resolves from a
    --    cwd and never holds a session id. Worse, a session id is synthetic
    --    (tty+pid+start) and re-mints on restart, while a run id doesn't - so
    --    session is the wrong key for a record meant to outlive the session.
    --  - retention differs. session_events is an append-only hook stream; this is
    --    a durable record that has to outlive its session but not forever.
    -- session_id is kept for provenance only - never joined on.
    CREATE TABLE IF NOT EXISTS gate_replies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      source      TEXT NOT NULL,  -- you | foreman
      run_id      TEXT NOT NULL,  -- the no-mistakes run id, from axi status
      step        TEXT NOT NULL,  -- the gate's step (review | document | ...)
      finding_ids TEXT NOT NULL,  -- JSON string[]: which round, without hashing its text
      text        TEXT            -- null: findings were selected but nothing was typed
    );
    CREATE INDEX IF NOT EXISTS idx_gate_replies_run ON gate_replies(run_id, step);

    CREATE TABLE IF NOT EXISTS session_agent_bindings (
      session_id       TEXT PRIMARY KEY,  -- the synthetic id (tty+pid+start)
      agent_session_id TEXT NOT NULL,     -- what the agent calls itself: the note/queue key
      updated_at       INTEGER NOT NULL
    );

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

    -- What each session is currently attempting to solve. Keyed exactly like session_notes
    -- (noteKeyFor = agentSessionId ?? synthetic id) so it shares that lifecycle, but kept
    -- in its own row: the note has one disposition and one updated_at that mean "what
    -- Foreman decided, and when", and a second writer sharing them would corrupt both.
    CREATE TABLE IF NOT EXISTS session_goals (
      note_key   TEXT PRIMARY KEY,
      text       TEXT,              -- the sentence; null while only a prompt is captured
      source     TEXT,              -- 'heuristic' (the raw prompt) | 'model' (refined)
      prompt     TEXT,              -- the filtered prompt it came from; the refiner's input
      updated_at INTEGER NOT NULL
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
      proposed_payload  TEXT,              -- the exact text a 'proposed' item would send
      recovered_at      INTEGER,           -- adopted mid-send after a restart -> never resend
      revision          INTEGER NOT NULL DEFAULT 0,  -- CAS token for edits
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      sent_at           INTEGER,
      completed_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fqi_queue ON foreman_queue_items(note_key, seq);
    -- The re-attach hint asks "any queue at THIS cwd?" once per discovered session
    -- per sweep, several times a second, on the one synchronous handle that also
    -- serves hook ingest and SSE. Unindexed that is a full scan per session per
    -- sweep, and the table only ever grows: every /clear mints a new note key and so
    -- a new row.
    CREATE INDEX IF NOT EXISTS idx_fq_cwd ON foreman_queues(cwd);
  `);
  db.exec(inFlightIndexSql());
  migrate(db);
  return db;
}

/**
 * Single-flight per queue, enforced by the DB rather than by hope: at most one item
 * per note_key may be mid-cycle. The stakes are a duplicated WORK INSTRUCTION typed
 * into a live agent, so this is a constraint, not a comment.
 *
 * The predicate is BUILT from IN_FLIGHT_ITEM_STATES rather than restated here, so
 * the enforcement and its two TypeScript readers cannot drift apart. `state` is a
 * closed enum of identifiers, so quoting them into SQL is safe by construction.
 */
function inFlightIndexSql(): string {
  const states = IN_FLIGHT_ITEM_STATES.map((s) => `'${s}'`).join(",");
  return `CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_per_queue ON foreman_queue_items(note_key)
      WHERE state IN (${states});`;
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

  // `proposed_payload`: what a drafted item would actually type. CREATE TABLE IF
  // NOT EXISTS won't add a column to a table that already exists, so an ALTER is
  // the only way an upgraded DB gets it. Nullable with no default, so existing
  // rows read as "no draft recorded" - and the machine re-drafts on the next tick
  // rather than showing a card with nothing under it.
  addColumn(d, "foreman_queue_items", "proposed_payload", "TEXT");

  // `recovered_at`: whether this item was adopted mid-send after a restart, which is
  // what stops it from ever resending. Same exposure and same reason as the ALTER
  // above - both were added to the CREATE TABLE after it had already shipped, and
  // `CREATE TABLE IF NOT EXISTS` will not add a column to a table that exists, so a
  // db created between the two would fail EVERY queue-item write. Nullable with no
  // default, so an existing row reads as "never crash-recovered" - which is the
  // truthful answer for a row written before the daemon could recover one.
  addColumn(d, "foreman_queue_items", "recovered_at", "INTEGER");

  // Goals need no migration: `session_goals` is a NEW table, and CREATE TABLE IF NOT EXISTS
  // creates it on an upgraded db exactly as on a fresh one. An existing fleet simply has no
  // goals until its sessions take their next prompt, which is the truthful answer for a
  // session whose prompts were all seen before goals existed. (This is the payoff of a
  // separate table over columns on `session_notes`: no ALTER, and no row written before
  // this build that has to be reasoned about.)

  rebuildInFlightIndexIfStale(d);
}

/**
 * Rebuild the single-flight index when its stored predicate no longer names the
 * states IN_FLIGHT_ITEM_STATES does.
 *
 * Deriving the SQL only makes the index agree with its readers on a FRESH db:
 * `CREATE UNIQUE INDEX IF NOT EXISTS` leaves an existing index untouched, so a db
 * created before a lifecycle state was added would go on enforcing the old
 * predicate while both TypeScript readers used the new one - exactly the silent
 * drift the shared constant exists to prevent, just deferred to upgrade time.
 *
 * A rebuild can legitimately fail: widening the set can surface rows that already
 * violate single-flight. That's worth reporting, but not worth bricking every
 * subsequent start over - the old index still enforces something, so keep it and
 * say so rather than refusing to open the db.
 *
 * That promise is what makes the TRANSACTION load-bearing rather than tidy. DDL is
 * transactional in SQLite, and without a transaction the DROP commits on its own:
 * the CREATE then fails on the violating rows, the catch logs, and the table is left
 * with NO index at all. Single-flight enforcement is silently gone, and - worse -
 * the next openDb() runs `db.exec(inFlightIndexSql())` against those same rows with
 * nothing to make it a no-op, throws uncaught, and the daemon refuses to start.
 * Failing to rebuild would brick every subsequent start: the exact outcome the catch
 * was written to prevent. Rolling back keeps the old index, so the CREATE stays a
 * no-op and the daemon opens.
 */
function rebuildInFlightIndexIfStale(d: DatabaseSync): void {
  const row = d
    .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='one_inflight_per_queue'`)
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) return;
  // SQLite stores the CREATE text with `IF NOT EXISTS` stripped, so compare the one
  // thing that carries meaning: which states the WHERE clause names.
  const stored = new Set([...row.sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const want = new Set<string>(IN_FLIGHT_ITEM_STATES);
  if (stored.size === want.size && [...want].every((s) => stored.has(s))) return;
  try {
    d.exec("BEGIN IMMEDIATE;");
    d.exec("DROP INDEX one_inflight_per_queue;");
    d.exec(inFlightIndexSql());
    d.exec("COMMIT;");
  } catch (err) {
    // Put the old index back. Swallowing a rollback failure is deliberate: the
    // original error is the one worth reporting, and masking it with "cannot
    // rollback - no transaction is active" would bury the actual cause.
    try {
      d.exec("ROLLBACK;");
    } catch {}
    console.error(
      "[db] could not rebuild one_inflight_per_queue (rows may already violate " +
        `single-flight); keeping the previous index: ${String(err)}`,
    );
  }
}

/** Add a column unless it's already there. The idempotent half of a migration. */
function addColumn(d: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
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

// ---- no-mistakes gate replies (the fix log's byline) ----

/**
 * Longest reply text kept. The fix log clamps again for display; this is the
 * bound on what the DB carries, since a reply is free-text a human or a model
 * typed and nothing upstream limits it.
 */
const MAX_GATE_REPLY_TEXT = 4000;
/**
 * Most finding ids kept per reply. Ids are short and a gate's finding set is
 * small (22 was the extreme in live data), so this only ever catches a runaway.
 * The set is a discriminator between rounds, not a record - dropping the tail
 * costs precision on an already-unlikely tie, never correctness.
 */
const MAX_GATE_REPLY_IDS = 200;

/** One recorded reply to a no-mistakes gate. */
export interface GateReplyRow {
  sessionId: string;
  ts: number;
  source: NmFixReplySource;
  runId: string;
  step: string;
  findingIds: string[];
  text: string | null;
}

/**
 * Record who answered a no-mistakes gate. Returns the row's id, so a caller that
 * wrote optimistically can take it back (see `dropGateReply`).
 *
 * Keyed by (runId, step) + the finding ids up at the gate, which is what the fix
 * log joins on. NOT by `findingsDigest`: that hashes finding DESCRIPTIONS as
 * `axi status` rendered them, and `axi status` truncates at 600 runes with a
 * "… (truncated, %d chars total)" suffix - so matching on it would mean
 * replicating another tool's display constant and format string byte-for-byte,
 * forever, with nothing failing loudly when they changed. Ids are short, stable,
 * never truncated, and identify a round at least as precisely.
 */
export function logGateReply(r: GateReplyRow): number {
  const ids = r.findingIds.filter((i) => typeof i === "string" && i).slice(0, MAX_GATE_REPLY_IDS);
  const text = r.text?.trim() ? r.text.trim().slice(0, MAX_GATE_REPLY_TEXT) : null;
  const res = openDb()
    .prepare(
      `INSERT INTO gate_replies (session_id, ts, source, run_id, step, finding_ids, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.sessionId, r.ts, r.source, r.runId, r.step, JSON.stringify(ids), text);
  return Number(res.lastInsertRowid);
}

/**
 * Take back a recorded reply - the compensating half of an optimistic write.
 *
 * Exists because a byline has to be stamped BEFORE we know the decision was
 * delivered: its `ts` is what the fix log's causality filter reads, so a row
 * written once the outcome is known would date from after the fix it explains and
 * be discarded (see the respond route). So the write is a claim, and this retracts
 * it when the claim turns out false. An unmatched id is a no-op: retracting a
 * byline that was never written is the same outcome as retracting one that was.
 */
export function dropGateReply(id: number): void {
  openDb().prepare(`DELETE FROM gate_replies WHERE id = ?`).run(id);
}

/**
 * Every recorded reply to one run's gate at `step`, oldest first.
 *
 * Bounded by the index on (run_id, step): a run works a step in a handful of
 * rounds, so this returns a handful of rows however long the daemon has run.
 *
 * A row whose `source` we don't recognise is DROPPED, not coerced. These rows live
 * for 90 days and outlive the daemon that wrote them, so a third source minted by a
 * newer daemon and read back by an older one is a real upgrade-window state rather
 * than a can't-happen. Coercing it would resolve "I don't know who did this" into
 * the most alarming claim the log can make - that a bot changed your branch. The
 * byline underclaims everywhere else; an unknown author is no byline.
 */
export function gateRepliesFor(runId: string, step: string): GateReplyRow[] {
  const rows = openDb()
    .prepare(
      `SELECT session_id, ts, source, run_id, step, finding_ids, text
         FROM gate_replies WHERE run_id = ? AND step = ? ORDER BY ts ASC`,
    )
    .all(runId, step) as unknown as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const source = row.source;
    if (source !== "you" && source !== "foreman") return [];
    return [
      {
        sessionId: String(row.session_id ?? ""),
        ts: Number(row.ts ?? 0),
        source,
        runId: String(row.run_id ?? ""),
        step: String(row.step ?? ""),
        findingIds: parseIdList(row.finding_ids),
        text: typeof row.text === "string" ? row.text : null,
      },
    ];
  });
}

/** A `finding_ids` JSON array back to a string[]; a bad blob costs precision, not the read. */
function parseIdList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((i): i is string => typeof i === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Age out gate replies. Returns how many rows went.
 *
 * Pruned by AGE and nothing else - deliberately, because the obvious alternative
 * is wrong. These are keyed to a session id, so session-scoped pruning is right
 * there and would drop a reply the moment its session exited; but the fix log
 * outlives the session BY DESIGN (it's read from git, and a finished run is
 * exactly when the log becomes interesting), so that would delete the byline for
 * the branch you sat down to review. Age is the only bound that doesn't fight
 * the feature.
 *
 * The window is a floor on how long a byline stays legible, not a bound on
 * anything the system needs: past it, the log still lists the fix and still shows
 * the reply - it just stops naming the author. One row per gate verdict makes
 * this a slow-growing table, so the window can afford to be generous.
 */
export function pruneGateReplies(cutoff: number): number {
  return Number(openDb().prepare(`DELETE FROM gate_replies WHERE ts < ?`).run(cutoff).changes);
}

/**
 * Whether this session has ever emitted a hook event - the durable half of
 * `Session.hooksSeen`.
 *
 * `session_events` is written by exactly one caller (`applyHook`) and never
 * pruned, so a row here means "hooks reached us from this session" for as long as
 * the DB lives.
 *
 * That single writer is LOad-BEARING, not incidental: this asks "any row?", not
 * "any row of a hook kind", so a second writer would make every session it
 * touched claim hooks it never emitted - silently, in a fact that decides whether
 * a session looks uninstrumented. Gate replies wanted a home here and were given
 * their own table partly for this reason (see `gate_replies`). Anything logged
 * against a session that is NOT a hook needs the same treatment, or this query
 * needs to start naming the kinds it counts.
 *
 * The durability outlasts the process, which is the whole point: overlays are
 * in-memory, so on a daemon restart a live, healthy, hook-instrumented session
 * that happens to be quiet looks identical to one with no integrations at all -
 * and anything that escalates on the latter would fire on the former. The
 * synthetic session id is tty+pid+start, so it's stable across a daemon restart
 * for the same agent process and mints fresh for a genuinely new one.
 */
export function hooksEverSeen(sessionId: string): boolean {
  const row = openDb()
    .prepare(`SELECT 1 AS hit FROM session_events WHERE session_id = ? LIMIT 1`)
    .get(sessionId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Remember which agent session a discovered session is running - the durable half
 * of `Session.agentSessionId`, and the same shape as `hooksEverSeen` above.
 *
 * The binding is not decoration: `noteKeyFor` is `agentSessionId ?? syntheticId`,
 * so it is the identity a session's note and WORK QUEUE are stored under. Only a
 * live hook/statusLine reports it, so without this a daemon restart rebuilds every
 * session under its synthetic id, no stored queue matches a live key, and the
 * orphan sweep terminally escalates the in-flight item of every healthy session in
 * the fleet. The synthetic id is tty+pid+start, so it's stable across a restart for
 * the same agent process and mints fresh for a genuinely new one; a `/clear` mints
 * a new agent session id on the same pane and overwrites the row, which is exactly
 * right - the queue it just left behind SHOULD orphan.
 */
export function recordAgentBinding(sessionId: string, agentSessionId: string, now: number): void {
  openDb()
    .prepare(
      `INSERT INTO session_agent_bindings (session_id, agent_session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         agent_session_id = excluded.agent_session_id,
         updated_at       = excluded.updated_at`,
    )
    .run(sessionId, agentSessionId, now);
}

/** The last agent session id bound to this session, or null if none ever was. */
export function lastAgentBinding(sessionId: string): string | null {
  const row = openDb()
    .prepare(`SELECT agent_session_id AS id FROM session_agent_bindings WHERE session_id = ?`)
    .get(sessionId) as { id: string } | undefined;
  return row?.id ?? null;
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

// ---- session goals ----

interface SessionGoalRow {
  note_key: string;
  text: string | null;
  source: string | null;
  prompt: string | null;
  updated_at: number;
}

function rowToGoal(r: SessionGoalRow): SessionGoal {
  return {
    noteKey: r.note_key,
    text: r.text,
    // Narrowed, not cast blind: a row written by a newer build (or hand-edited) could carry
    // a source this build doesn't know, and typing it as one we do would put an unrenderable
    // value on a card. An unknown source reads as "no source", which the UI handles already.
    source: r.source === "heuristic" || r.source === "model" ? r.source : null,
    prompt: r.prompt,
    updatedAt: r.updated_at,
  };
}

export function upsertSessionGoal(g: SessionGoal): void {
  openDb()
    .prepare(
      `INSERT INTO session_goals (note_key, text, source, prompt, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         text=excluded.text, source=excluded.source, prompt=excluded.prompt,
         updated_at=excluded.updated_at`,
    )
    .run(g.noteKey, g.text, g.source, g.prompt, g.updatedAt);
}

export function getSessionGoal(noteKey: string): SessionGoal | undefined {
  const r = openDb().prepare(`SELECT * FROM session_goals WHERE note_key = ?`).get(noteKey) as
    | unknown as SessionGoalRow | undefined;
  return r ? rowToGoal(r) : undefined;
}

/** All goals, reloaded into the registry on start so a card keeps its Goal across one. */
export function loadSessionGoals(): SessionGoal[] {
  const rows = openDb()
    .prepare(`SELECT * FROM session_goals ORDER BY updated_at DESC`)
    .all() as unknown as SessionGoalRow[];
  return rows.map(rowToGoal);
}

/**
 * Delete goals that belong to no live session and have gone stale. Returns how many went.
 *
 * The table needs this and `session_notes` does not, despite the identical shape: a note is
 * written only when Foreman inspects a session, whereas a goal row is written for every
 * instrumented session on every substantive prompt, and `loadSessionGoals` pulls all of them
 * into memory at boot. Every `/clear` rotates `noteKeyFor` and strands the old row for good,
 * so the orphans accumulate for as long as the daemon is used.
 *
 * BOTH conditions are load-bearing, and the live-key one is the safety property: a row whose
 * key still belongs to a session is never touched no matter how old it is, so a long-running
 * card cannot have the sentence deleted out from under it. Age alone would do exactly that.
 * `liveKeys` is `noteKeyFor` over the registry's live sessions - pass the real set or nothing
 * is protected.
 */
export function pruneSessionGoals(liveKeys: Iterable<string>, olderThan: number): number {
  const keys = [...new Set(liveKeys)];
  const placeholders = keys.map(() => "?").join(",");
  const where = keys.length
    ? `updated_at < ? AND note_key NOT IN (${placeholders})`
    : `updated_at < ?`;
  const r = openDb()
    .prepare(`DELETE FROM session_goals WHERE ${where}`)
    .run(olderThan, ...keys);
  return Number(r.changes);
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
  proposed_payload: string | null;
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
    proposedPayload: r.proposed_payload,
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

/** Queues recorded at one cwd - the re-attach hint's question, asked as a lookup. */
export function listQueueRowsForCwd(cwd: string): Omit<SessionQueue, "items">[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queues WHERE cwd = ? ORDER BY updated_at DESC`)
    .all(cwd) as unknown as QueueRow[];
  return rows.map((r) => ({
    noteKey: r.note_key,
    cwd: r.cwd,
    branch: r.branch,
    wrapupAskedAt: r.wrapup_asked_at,
    wrapupAnswer: r.wrapup_answer,
    updatedAt: r.updated_at,
  }));
}

/**
 * How many of a queue's items are still open, without loading any of them.
 *
 * The hint needs a count, and `listQueueItems` was hydrating every row - gaps JSON,
 * verdicts, drafted payloads and all - to take its length. The predicate is DERIVED
 * from TERMINAL_ITEM_STATES rather than restated, for the reason @shared/queue.ts
 * gives: a lifecycle state added without updating a hand-copied SQL list makes this
 * silently miscount. `state` is a closed enum of identifiers, so quoting them into
 * SQL is safe by construction (same argument as `inFlightIndexSql`).
 */
export function countOpenQueueItems(noteKey: string): number {
  const states = TERMINAL_ITEM_STATES.map((s) => `'${s}'`).join(",");
  const r = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM foreman_queue_items
        WHERE note_key = ? AND state NOT IN (${states})`,
    )
    .get(noteKey) as unknown as { n: number };
  return r.n;
}

/**
 * Age out queues nothing can reach any more. Returns how many rows went.
 *
 * Nothing pruned these before, so they accumulated for the DB's lifetime - and every
 * `/clear` mints a new note key, hence a new row, so the floor rose with use and
 * never came back down.
 *
 * Deliberately conservative about WHAT goes, because the failure mode on this side is
 * deleting a human's backlog:
 *  - a queue with ANY open item is untouchable at any age. That's precisely what the
 *    re-attach affordance exists to resume - the orphan sweep leaves `queued` items
 *    intact on purpose so a human can pick them up later, and a retention policy that
 *    ate them would be a bug wearing a safety hat.
 *  - a live session's queue is untouchable, whatever its items say: `liveKeys` is
 *    passed in rather than inferred from `updated_at`, because a drained queue on a
 *    session you are still sitting in is not garbage - it's the card's own history,
 *    and the wrap-up ask still hangs off that row.
 * So this only ever drops a fully-finished batch whose session is gone and which
 * nothing has touched since `cutoff`.
 */
export function pruneDeadQueues(liveKeys: Set<string>, cutoff: number): number {
  const db = openDb();
  const states = TERMINAL_ITEM_STATES.map((s) => `'${s}'`).join(",");
  const dead = db
    .prepare(
      `SELECT note_key FROM foreman_queues q
        WHERE q.updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM foreman_queue_items i
             WHERE i.note_key = q.note_key AND i.state NOT IN (${states})
          )`,
    )
    .all(cutoff) as unknown as Array<{ note_key: string }>;
  const drop = dead.map((r) => r.note_key).filter((k) => !liveKeys.has(k));
  if (drop.length === 0) return 0;
  // All-or-nothing, like `rekeyQueue`: a queue row outliving its items is a card
  // claiming a batch it can no longer show, and orphaned items outliving their row
  // are invisible to every reader here (all of which start from the row).
  db.exec("BEGIN");
  try {
    const delItems = db.prepare(`DELETE FROM foreman_queue_items WHERE note_key = ?`);
    const delQueue = db.prepare(`DELETE FROM foreman_queues WHERE note_key = ?`);
    for (const key of drop) {
      delItems.run(key);
      delQueue.run(key);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  return drop.length;
}

export function upsertQueueItem(i: WorkItem): void {
  openDb()
    .prepare(
      `INSERT INTO foreman_queue_items (
         id, note_key, seq, intent, state, round, base_sha, transcript_anchor, gaps,
         send_attempts, verify_failures, escalation_reason, last_verdict, approved_at,
         proposed_payload, recovered_at, revision, created_at, updated_at, sent_at,
         completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         note_key=excluded.note_key, seq=excluded.seq, intent=excluded.intent,
         state=excluded.state, round=excluded.round, base_sha=excluded.base_sha,
         transcript_anchor=excluded.transcript_anchor, gaps=excluded.gaps,
         send_attempts=excluded.send_attempts, verify_failures=excluded.verify_failures,
         escalation_reason=excluded.escalation_reason, last_verdict=excluded.last_verdict,
         approved_at=excluded.approved_at, proposed_payload=excluded.proposed_payload,
         recovered_at=excluded.recovered_at, revision=excluded.revision,
         updated_at=excluded.updated_at, sent_at=excluded.sent_at,
         completed_at=excluded.completed_at`,
    )
    .run(
      i.id, i.noteKey, i.seq, i.intent, i.state, i.round, i.baseSha, i.transcriptAnchor,
      JSON.stringify(i.gaps), i.sendAttempts, i.verifyFailures, i.escalationReason,
      i.lastVerdict, i.approvedAt, i.proposedPayload, i.recoveredAt, i.revision,
      i.createdAt, i.updatedAt, i.sentAt, i.completedAt,
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

/**
 * Move a whole queue onto a new note key, in ONE transaction: write the target
 * row, re-key every item, drop the source row.
 *
 * Atomic for the same reason `reorderQueueItems` is. This is a re-key of N rows
 * that is only correct all-or-nothing: a throw or a crash partway through the
 * statement sequence leaves the batch SPLIT across two keys, with some items under
 * a queue row that has already been deleted and the rest still on the old one -
 * a state no reader models and the re-attach button cannot repair, since the hint
 * it keys off is computed from the very rows that got half-moved.
 *
 * `items` arrive already re-keyed and renumbered; the caller owns that policy
 * (which seqs, which target row), this owns only the all-or-nothing.
 */
export function rekeyQueue(
  fromKey: string,
  toRow: Omit<SessionQueue, "items">,
  items: WorkItem[],
): void {
  const d = openDb();
  d.exec("BEGIN");
  try {
    upsertQueue(toRow);
    for (const i of items) {
      // Delete-then-insert rather than an in-place re-key: an in-flight item would
      // otherwise have to pass through a moment where both keys hold it, which is
      // exactly what the single-flight partial index forbids.
      deleteQueueItem(i.id);
      upsertQueueItem(i);
    }
    deleteQueue(fromKey);
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
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
    // Rows the client didn't list - a concurrent add that raced the drop, or a
    // caller that legitimately sent a subset (the route only validates that each
    // id it WAS given is known). They're selected explicitly rather than inferred
    // from a seq range: they never moved, so nothing distinguishes them by seq, and
    // an earlier attempt to catch them by `seq >= scratch` matched nothing at all.
    // Left where they were, an unlisted row collides at seq 0 with the reordered
    // head, and `nextSendable`'s strict `<` then breaks the tie by arbitrary row
    // order - i.e. which work instruction gets typed becomes luck.
    const placeholders = ids.map(() => "?").join(", ");
    const unlisted = (
      d
        .prepare(
          `SELECT id FROM foreman_queue_items
           WHERE note_key = ?${ids.length ? ` AND id NOT IN (${placeholders})` : ""}
           ORDER BY seq ASC`,
        )
        .all(noteKey, ...ids) as unknown as Array<{ id: string }>
    ).map((r) => r.id);

    // Their authored order is preserved, and they land after the reordered block.
    const order = [...ids, ...unlisted];

    const upd = d.prepare(
      `UPDATE foreman_queue_items SET seq = ?, updated_at = ? WHERE id = ? AND note_key = ?`,
    );
    // Two passes over a scratch offset: seq has no UNIQUE constraint, but writing
    // the final numbers directly still means the list passes through states where
    // two rows share a seq. Ordering by the scratch pass keeps the intermediate
    // rows unambiguous if anything reads mid-transaction.
    const scratch = 1_000_000;
    order.forEach((id, i) => upd.run(scratch + i, now, id, noteKey));
    order.forEach((id, i) => upd.run(i, now, id, noteKey));
    d.exec("COMMIT");
  } catch (err) {
    // Guarded like rekeyQueue's: if the BEGIN itself never took there is no
    // transaction to roll back, and an unguarded ROLLBACK throws over the original
    // error - which is the one the caller needs to see.
    try {
      d.exec("ROLLBACK");
    } catch {}
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
