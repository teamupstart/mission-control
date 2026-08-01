import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, envVar } from "./config.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import type {
  EpisodeAuthor,
  ForemanEpisode,
  ForemanEpisodeSummary,
  InspectorComment,
  InspectorCommentStatus,
  InspectorFailKind,
  InspectorInspection,
  InspectorPr,
  InspectorPrState,
  InspectorSeverity,
  InspectorSource,
  NmFixReplySource,
  NoteDisposition,
  PaneDialogSummary,
  PlanDecision,
  ReviewItem,
  ReviewKind,
  ReviewStatus,
  SessionCost,
  CostBasis,
  SessionGoal,
  SessionNote,
  SessionQueue,
  Task,
  TaskKind,
  TaskPriority,
  TaskStatus,
  TrackedGap,
  WorkItem,
  WorkItemState,
  WorktreeProvider,
} from "@shared/types.ts";
import { IN_FLIGHT_ITEM_STATES, TERMINAL_ITEM_STATES } from "@shared/queue.ts";
import { readCheapAction, readDivergence } from "@shared/foreman.ts";
import { askPreviewForWire } from "@shared/foreman-ask.ts";
import type { CheapAction, Divergence } from "@shared/foreman.ts";
import { normalizeLabels } from "@shared/task.ts";

/**
 * Durable state. Live sessions are intentionally NOT persisted - they're rebuilt
 * from the OS on every poll. What survives a restart is state the OS can't rebuild:
 * pending review items (a human decision may be waiting), dispatched tasks (their
 * backlog, running intent, and recent outcomes), and the session event log.
 */
let db: DatabaseSync;

/**
 * Refuse to open the operator's real state dir from inside the test runner.
 *
 * Twice now a test has destroyed live state: the state-dir rename once moved
 * `~/.fleet-control` out from under a running daemon (see migrate-state.ts), and a
 * branch's config test ran `DELETE FROM app_config` against the real db on every
 * `npm test`, wiping every setting the operator had saved - repeatedly, since agents
 * run the suite before every PR. Both had the same shape: a test file that imports
 * server modules without redirecting the state dir first, failing silently into
 * someone's home directory.
 *
 * The check is here rather than in `stateDir()` because resolution has to stay
 * side-effect free and is evaluated at module load by files that never touch the db
 * (health.test.ts imports routes.ts and is rightly hermetic without any env). Opening
 * the db is the moment real damage becomes possible, so it is the moment to refuse.
 *
 * Comparing DB_PATH against the CURRENT override catches both mistakes: no override
 * at all, and an override set after `config.ts` had already resolved the real home -
 * the same wipe with an alibi.
 */
function assertTestStateIsolation(): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const override = envVar("HOME");
  if (override && DB_PATH.startsWith(override)) return;
  throw new Error(
    `refusing to open ${DB_PATH} under the test runner: this is the machine's real ` +
      "state dir. Set MISSION_HOME (or HARNESS_HOME) to a fresh temp dir BEFORE " +
      "importing anything that resolves it - see ui-config-store.test.ts for the pattern.",
  );
}

export function openDb(): DatabaseSync {
  if (db) return db;
  assertTestStateIsolation();
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  // SQLite parses REFERENCES clauses whatever this says and enforces them only when it is
  // on, so declaring a foreign key without this line is a comment that looks like a
  // constraint. It is safe to switch on for the whole file because the ensemble family
  // below is the ONLY one that declares a foreign key - every other table in here relates
  // by convention, and turning the pragma on cannot retroactively constrain a relation the
  // schema never declared. A new REFERENCES clause on an older table therefore becomes
  // live the moment it is written, which is the point.
  db.exec("PRAGMA foreign_keys = ON;");
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
      priority      TEXT,               -- low|med|high|blocker, NULL = nobody set one
      labels        TEXT,               -- JSON array of strings, NULL = none
      dependencies  TEXT,               -- JSON TaskDependency[], NULL = none
      -- May the backlog autopilot schedule this? 1 unless somebody switched it off.
      -- NOT NULL DEFAULT 1 rather than nullable: there is no third state, and a NULL
      -- read as falsy would silently park every task filed before the toggle existed.
      enabled       INTEGER NOT NULL DEFAULT 1,
      model         TEXT,
      effort        TEXT,
      -- Published Workflow identity armed for this task's completion. The immutable
      -- version is selected only when the launched session can be bound.
      workflow_id   TEXT,
      -- Where a task source swept this task from. The LINK BACK only: identity for
      -- de-duplication lives in task_source_seen below, whose rows outlive the task.
      -- NULL on every task a human typed, which is nearly all of them.
      source_id     TEXT,
      external_id   TEXT,
      source_url    TEXT,
      repo_root     TEXT NOT NULL,
      worktree_path TEXT,
      branch        TEXT,
      provider      TEXT,
      home_name     TEXT,               -- name of the terminal home, any backend (was tmux_session)
      terminal_resource_id TEXT,
      session_id    TEXT,
      -- Which recurring mission filed this task, and for which instant. All three NULL
      -- on every task a human dispatched, an MCP call created, or a task source swept -
      -- which is every task that existed before Recurring Missions. Deliberately NOT
      -- folded into source_id/external_id above: a task source reads an EXTERNAL system
      -- and dedupes against task_source_seen, where a schedule is internal state whose
      -- identity is (schedule_id, scheduled_for) and lives in its own occurrence ledger.
      schedule_id            TEXT,
      schedule_occurrence_id TEXT,
      scheduled_for          INTEGER,
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

    CREATE TABLE IF NOT EXISTS session_work_episodes (
      session_id       TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL UNIQUE,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      prompted_at      INTEGER,
      awaiting_agent_rebind INTEGER NOT NULL DEFAULT 0,
      rebind_from_transcript_path TEXT,
      started_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_work_episode_prompts (
      session_id  TEXT NOT NULL,
      episode_id  TEXT NOT NULL,
      prompted_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, episode_id, prompted_at)
    );

    CREATE TABLE IF NOT EXISTS task_work_episode_bindings (
      task_id          TEXT PRIMARY KEY,
      episode_id       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      bound_at         INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_work_episode_session
      ON task_work_episode_bindings(session_id);

    CREATE TABLE IF NOT EXISTS historical_task_work_episode_bindings (
      task_id          TEXT NOT NULL,
      episode_id       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      agent_session_id TEXT NOT NULL,
      branch           TEXT,
      pr_url           TEXT,
      pr_head_sha      TEXT,
      merged_at        INTEGER,
      bound_at         INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      PRIMARY KEY (task_id, episode_id)
    );
    CREATE INDEX IF NOT EXISTS idx_historical_task_work_episode_session
      ON historical_task_work_episode_bindings(session_id, episode_id);

    -- Every decision Foreman has faced on a session, append-only: the question it
    -- was asked, what it concluded, and what was actually sent back.
    --
    -- Its own table rather than columns on session_notes, and for a sharper reason
    -- than "history needs rows". session_notes is a CURRENT STATE row: one
    -- disposition and one updated_at, both meaning "what Foreman decided, and when".
    -- It is keyed note_key PRIMARY KEY and upserted, so each write destroys its
    -- predecessor - and the UI's Approve deliberately nulls brief/recommendation,
    -- because after you answer there IS no current recommendation. All three of
    -- those are correct for a live pointer and fatal for a record.
    --
    -- What makes this buildable is that the marker already exists: classifyPending
    -- computes a stable id for each waiting episode and the worker already sends it
    -- as handledMarker for its own idempotency. So episode identity costs nothing,
    -- and (note_key, marker) is unique BY CONSTRUCTION - the worker refuses to
    -- re-handle a marker it has stamped, and a human's later Approve updates that
    -- same row rather than appending a second one.
    --
    -- The pane is the load-bearing column. For a terminal ask - a permission prompt,
    -- an AskUserQuestion menu - the child's screen is the ONLY place the question
    -- ever exists: Claude appends the assistant turn when a tool call COMPLETES, so
    -- a blocked dialog is not in the transcript, and the worker reads the pane once
    -- and drops it. Not capturing it here does not defer the question, it loses it.
    --
    -- session_id is provenance only, never joined on: it is synthetic (tty+pid+start)
    -- and re-mints on restart, which is why note_key is the key here as it is there.
    CREATE TABLE IF NOT EXISTS foreman_episodes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      note_key       TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      marker         TEXT NOT NULL,  -- Pending.marker: this waiting episode's identity
      situation      TEXT NOT NULL,  -- PendingSituation
      surface        TEXT NOT NULL,  -- input-review | terminal
      question       TEXT NOT NULL,  -- the ask, verbatim
      pane           TEXT,           -- the child's screen at decision time (terminal only)
      menu           TEXT,           -- JSON PaneDialog: the rows the model chose among
      review_id      TEXT,           -- reviews.id when the ask arrived as a review
      purpose        TEXT,
      brief          TEXT,
      recommendation TEXT,
      classification TEXT,
      confidence     REAL,
      tier           INTEGER,
      -- The shadow measurement: what the cheap tier would have done, and how that compared
      -- with the full review that actually acted. Written only under the shadow posture,
      -- and NULL everywhere else - which is "not measured", not "agreed". Deliberately
      -- separate from tier, which keeps reporting the tier whose verdict was USED (2 under
      -- shadow). Also ALTERed in migrate(), for a db that predates them.
      cheap_action   TEXT,           -- answer | escalate | skip | route-up
      divergence     TEXT,           -- deferred | agree | cheap-over-eager | cheap-too-cautious | minor
      disposition    TEXT NOT NULL,
      last_action    TEXT,
      sent_text      TEXT,           -- what was actually delivered
      sent_option    TEXT,           -- JSON {number,label} for a menu selection
      sent_by        TEXT,           -- foreman | you: who authored what was delivered
      created_at     INTEGER NOT NULL,
      resolved_at    INTEGER,
      -- Who DECIDED the episode, which is a different question from who sent the text
      -- and has a different answer on every path where nothing was sent. A dismissal
      -- resolves an episode without delivering a word, so sent_by is null there while
      -- resolved_by is 'you'; folding the two together made a dismissal indistinguishable
      -- from an approval, and the card read "You approved" over a header saying you
      -- dismissed it. Null while the episode is still open.
      resolved_by    TEXT            -- foreman | you
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_foreman_episodes_marker
      ON foreman_episodes(note_key, marker);
    CREATE INDEX IF NOT EXISTS idx_foreman_episodes_key
      ON foreman_episodes(note_key, created_at DESC);

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
      note_key                TEXT PRIMARY KEY,
      text                    TEXT,              -- compact durable objective for the card
      source                  TEXT,              -- 'heuristic' (initial raw ask) | 'model'
      objective               TEXT,              -- durable completion contract
      prompt                  TEXT,              -- latest filtered human instruction
      focus                   TEXT,              -- compact latest instruction
      relationship            TEXT,              -- initial | steer | amend | replace | unclear
      rationale               TEXT,              -- why the latest relationship was chosen
      objective_version       INTEGER NOT NULL DEFAULT 0,
      prompt_revision         INTEGER NOT NULL DEFAULT 0,
      resolved_prompt_revision INTEGER NOT NULL DEFAULT 0,
      pending_prompts         TEXT NOT NULL DEFAULT '[]', -- unresolved revisions, oldest first
      updated_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Reusable workflow judges. guidance_md is exact operator-authored Markdown: no
    -- normalized copy exists and every write names this column directly.
    CREATE TABLE IF NOT EXISTS personas (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      guidance_md     TEXT NOT NULL,
      runner_id       TEXT,
      model_id        TEXT,
      revision        INTEGER NOT NULL DEFAULT 1,
      archived_at     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_normalized_name
      ON personas(normalized_name);

    -- The complete workflow family is front-loaded in Phase 1 so published definitions,
    -- executions, delivery identity and later audit data all share one migration boundary.
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      normalized_name        TEXT NOT NULL,
      description            TEXT NOT NULL DEFAULT '',
      draft_graph_json       TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      resumption_policy      TEXT,
      binding_defaults_json  TEXT NOT NULL,
      draft_revision         INTEGER NOT NULL DEFAULT 1,
      current_version_id     TEXT,
      archived_at            INTEGER,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_definitions_normalized_name
      ON workflow_definitions(normalized_name);

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id                     TEXT PRIMARY KEY,
      workflow_id            TEXT NOT NULL,
      version                INTEGER NOT NULL,
      source_draft_revision  INTEGER NOT NULL,
      graph_json             TEXT NOT NULL,
      completion_policy_json TEXT NOT NULL,
      resumption_policy      TEXT,
      binding_defaults_json  TEXT NOT NULL,
      published_at           INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_number
      ON workflow_versions(workflow_id, version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_draft
      ON workflow_versions(workflow_id, source_draft_revision);

    CREATE TABLE IF NOT EXISTS workflow_bindings (
      id                  TEXT PRIMARY KEY,
      workflow_version_id TEXT NOT NULL,
      note_key            TEXT NOT NULL,
      session_id          TEXT,
      session_agent       TEXT NOT NULL DEFAULT '',
      session_name        TEXT NOT NULL DEFAULT '',
      session_cwd         TEXT,
      session_repo_root   TEXT,
      trigger_mode        TEXT NOT NULL,
      delivery_mode       TEXT NOT NULL,
      state               TEXT NOT NULL,
      max_repair_rounds   INTEGER NOT NULL,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_bindings_active_note
      ON workflow_bindings(note_key) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_workflow_bindings_version
      ON workflow_bindings(workflow_version_id);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                    TEXT PRIMARY KEY,
      binding_id            TEXT NOT NULL,
      workflow_version_id   TEXT NOT NULL,
      status                TEXT NOT NULL,
      current_phase         TEXT NOT NULL,
      max_repair_rounds     INTEGER NOT NULL,
      trigger_source        TEXT NOT NULL,
      trigger_key           TEXT NOT NULL,
      inspector_pr_key      TEXT,
      inspector_head_sha    TEXT,
      gate_state_json       TEXT,
      started_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      completed_at          INTEGER,
      evidence_pruned_at    INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_trigger
      ON workflow_runs(trigger_key);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_binding
      ON workflow_runs(binding_id, updated_at);

    CREATE TABLE IF NOT EXISTS workflow_submissions (
      id                   TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      round                INTEGER NOT NULL,
      mode                 TEXT NOT NULL,
      trigger_source       TEXT NOT NULL,
      trigger_key          TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      context_json         TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      pr_head_sha          TEXT,
      status               TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_submissions_round
      ON workflow_submissions(run_id, round);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_submissions_trigger
      ON workflow_submissions(trigger_key);

    CREATE TABLE IF NOT EXISTS workflow_node_attempts (
      id                    TEXT PRIMARY KEY,
      submission_id         TEXT NOT NULL,
      node_id               TEXT NOT NULL,
      attempt               INTEGER NOT NULL,
      state                 TEXT NOT NULL,
      persona_snapshot_json TEXT,
      runner_id             TEXT,
      model_id              TEXT,
      verdict_json          TEXT,
      output_json           TEXT,
      retry_at              INTEGER,
      input_fingerprint     TEXT NOT NULL,
      error                 TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      started_at            INTEGER,
      finished_at           INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_node_attempts_identity
      ON workflow_node_attempts(submission_id, node_id, attempt);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_attempts_state
      ON workflow_node_attempts(state, retry_at);

    CREATE TABLE IF NOT EXISTS workflow_edge_receipts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id     TEXT NOT NULL,
      edge_id            TEXT NOT NULL,
      source_attempt_id  TEXT NOT NULL,
      payload_json       TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_edge_receipts_identity
      ON workflow_edge_receipts(submission_id, edge_id, source_attempt_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_edge_receipts_edge
      ON workflow_edge_receipts(submission_id, edge_id);

    CREATE TABLE IF NOT EXISTS workflow_deliveries (
      id             TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      submission_id  TEXT NOT NULL,
      kind           TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      note_key       TEXT NOT NULL,
      payload        TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      state          TEXT NOT NULL,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      delivered_at   INTEGER,
      payload_pruned_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_deliveries_identity
      ON workflow_deliveries(submission_id, kind, payload_sha256);
    CREATE INDEX IF NOT EXISTS idx_workflow_deliveries_run
      ON workflow_deliveries(run_id, created_at);

    CREATE TABLE IF NOT EXISTS workflow_llm_calls (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL,
      submission_id    TEXT NOT NULL,
      node_attempt_id  TEXT,
      purpose          TEXT NOT NULL,
      runner_id        TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      state            TEXT NOT NULL,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      duration_ms      INTEGER,
      input_bytes      INTEGER NOT NULL DEFAULT 0,
      output_bytes     INTEGER NOT NULL DEFAULT 0,
      cost_usd         REAL,
      error_code       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_llm_calls_run
      ON workflow_llm_calls(run_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_llm_calls_submission
      ON workflow_llm_calls(submission_id, purpose);

    CREATE TABLE IF NOT EXISTS workflow_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      event_kind   TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run
      ON workflow_events(run_id, id);

    -- One external orchestrator's durable claim on exactly one Workflow binding.
    --
    -- source_key is the PRIMARY KEY because it is the idempotency key: a caller that lost
    -- our response, or that retried after a daemon restart, derives the same key and gets
    -- the same binding back instead of creating a second one. binding_id is UNIQUE because
    -- a binding has at most one owner, so two orchestrators cannot both believe they
    -- started the same review.
    --
    -- source_id is stored separately and is display identity only. Nothing parses the
    -- opaque source_key back into ids; that spelling is internal and may change.
    --
    -- Every column is NOT NULL: SQLite treats NULLs as distinct inside a unique index, so a
    -- nullable half would let the row multiply on retry rather than collide. source_key says
    -- NOT NULL explicitly even though it is the primary key, because on a non-STRICT rowid
    -- table SQLite does NOT imply it - a long-standing compatibility quirk - so PRIMARY KEY
    -- alone would admit several NULL keys and lose the one-claim-per-source identity.
    CREATE TABLE IF NOT EXISTS workflow_binding_claims (
      source_key  TEXT NOT NULL PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      binding_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_binding_claims_binding
      ON workflow_binding_claims(binding_id);

    -- The durable owner of a pooled worktree a Workflow check is holding.
    --
    -- Not workflow_node_attempts.output_json, which holds the final CheckOutcome and
    -- nothing else. A lease is a RESOURCE, and a resource outlives the row that asked for
    -- it: a daemon killed mid-check has to be able to find the tree it was holding, prove
    -- it is still ours, and hand it back - long after attempt retention would have removed
    -- the attempt itself.
    --
    -- NO FOREIGN KEY to workflow_node_attempts, deliberately, and it must stay that way.
    -- PRAGMA foreign_keys = ON is set above, so a REFERENCES clause here would be
    -- ENFORCED, and both enforcement modes are wrong: ON DELETE CASCADE would delete this
    -- row when retention removes the attempt, destroying the only record of a tree that is
    -- still held; RESTRICT would make retention fail outright on a leaked lease. The
    -- requirement is precisely that this table outlives both. (It also matches the house
    -- rule that the ensemble family is the only one here that declares foreign keys.)
    --
    -- submission_id and node_id are CARRIED rather than joined for, for the same reason.
    -- Before a check node may retry, it has to answer "does this node still own an
    -- unresolved lease?" - because a retry is a NEW attempt id, so it carries a new holder
    -- token and would happily lease a DIFFERENT tree while the first group may still be
    -- writing into the original. There is no natural collision to rely on. A join through
    -- workflow_node_attempts would answer that correctly right up until the moment it
    -- matters, which is exactly when retention has deleted the attempt.
    --
    -- Every column is NOT NULL, and attempt_id says so explicitly even though it is the
    -- primary key: on a non-STRICT rowid table SQLite does NOT imply it (a long-standing
    -- compatibility quirk), so PRIMARY KEY alone would admit several NULL keys - see
    -- workflow_binding_claims above.
    --
    -- supervisor_pid = 0 and supervisor_start_ticks = '' are SENTINELS meaning "the gate
    -- was never released", and that state is load-bearing rather than filler. A row
    -- carrying the sentinel is positive proof that branch code never started, which is the
    -- one thing that distinguishes a crash between spawn and persist from a process group
    -- that is still alive - and only the first of those may have its tree returned on
    -- ownership alone. Do NOT "clean these up" into nullable columns: a NULL is
    -- indistinguishable from a row written by a build that did not set the column, and the
    -- distinction is what authorises a destructive return.
    --
    -- cleanup_state is the lease's own lifecycle: 'held' -> 'returning' -> 'returned', plus
    -- the terminal 'lost'. A failed return moves to 'returning' and STAYS there; it must
    -- never delete the row, release its reaper pin, or permit a second lease for the same
    -- attempt. 'lost' is the holder-mismatch terminal: the path is held by a token that is
    -- not ours, so no return is issued, the row is kept for audit, and the pin IS dropped
    -- (see check-lease.ts for why those two are compatible).
    CREATE TABLE IF NOT EXISTS workflow_check_leases (
      attempt_id             TEXT    NOT NULL PRIMARY KEY,
      submission_id          TEXT    NOT NULL,
      node_id                TEXT    NOT NULL,
      repo_root              TEXT    NOT NULL,
      lease_path             TEXT    NOT NULL,
      holder_token           TEXT    NOT NULL,
      cleanup_state          TEXT    NOT NULL,
      supervisor_pid         INTEGER NOT NULL,
      supervisor_start_ticks TEXT    NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
    -- UNIQUE over LIVE rows only. Two attempts believing they hold the same tree is the
    -- corruption this whole subsystem exists to prevent, so it fails at the insert - but
    -- the uniqueness has to be scoped to the states that mean "we are holding it", because
    -- terminal rows are retained for audit and the pool hands the SAME slot out again and
    -- again. Unscoped, the second check to ever use pool slot 3 would fail its insert
    -- against slot 3's retained 'returned' row, and would keep failing forever. This is the
    -- same seam that keeps the reaper's checkLeasePaths honest: retaining a row for audit
    -- and treating the table as a live index are different jobs, and the state filter is
    -- what makes both claims true at once. Write it as the WHERE, not as a convention.
    --
    -- Do not "restore" the unscoped index this was written as. The failure is not
    -- hypothetical and it is not recoverable: it strands a pool slot for every future run.
    -- Proven by "a pool slot can be leased again after an earlier lease of it went terminal"
    -- in test/workflow-check-lease.test.ts, which fails with UNIQUE constraint failed the
    -- moment the WHERE is removed.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_check_leases_path
      ON workflow_check_leases(lease_path) WHERE cleanup_state IN ('held', 'returning');
    CREATE INDEX IF NOT EXISTS idx_workflow_check_leases_node
      ON workflow_check_leases(submission_id, node_id);

    -- What each task source has already filed, and will never file again.
    --
    -- Its OWN table rather than de-duplicating against the three columns on tasks, and
    -- this is the load-bearing decision of the whole feature:
    --
    --   A TASK YOU DELETED MUST STAY DELETED. Dedupe against tasks means deleting a
    --   swept task makes it un-seen, so the next sweep files it again - the source
    --   becomes impossible to say no to, and the delete button becomes a snooze button
    --   that does not even snooze.
    --
    -- So a row here OUTLIVES the task it produced, and holds no reference to one: there
    -- is nothing to join on, which is what stops the next reader from re-introducing the
    -- bug. Re-filing an item you deleted is a deliberate act - "Forget seen items" on the
    -- source, which clears its rows.
    --
    -- Both key columns are NOT NULL, which the ON CONFLICT depends on: SQLite treats
    -- NULLs as DISTINCT inside a unique index, so a nullable half would make the upsert
    -- silently become an insert and the row would multiply on every sweep.
    CREATE TABLE IF NOT EXISTS task_source_seen (
      source_id   TEXT NOT NULL,   -- TaskSourceInstance.id
      external_id TEXT NOT NULL,   -- stable id in the EXTERNAL system, e.g. owner/repo#123
      url         TEXT,            -- deep link, kept for provenance; never matched on
      seen_at     INTEGER NOT NULL,
      PRIMARY KEY (source_id, external_id)
    );

    -- API-equivalent estimates and token usage, one row per source event or export window.
    --
    -- Its OWN table rather than a new kind in session_events, and the reason is written
    -- down at logEvent below: that table has exactly one writer, and hooksEverSeen asks
    -- "any row for this session?" - not "any row of a hook kind". A second writer would
    -- make every session it touched claim hooks it never emitted, which is the
    -- installation fact the work queue gates on. gate_replies got its own table for
    -- exactly this reason; so does this.
    --
    -- Keyed on note_key, never on session_id: a session id is synthetic (tty+pid+start)
    -- and re-mints on every restart, while this record is meant to outlive the session
    -- that made it. OTel's session.id attribute IS the agent session id, which is what
    -- noteKeyFor already prefers.
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      note_key      TEXT NOT NULL,           -- agentSessionId (OTel session.id)
      session_id    TEXT,                    -- provenance only; never joined on
      agent         TEXT NOT NULL DEFAULT 'claude',
      -- Both NOT NULL with an empty-string "unknown", and that is load-bearing rather
      -- than tidiness: SQLite treats NULLs as DISTINCT inside a UNIQUE index, so a
      -- nullable model_id would make the ON CONFLICT below never fire for a datapoint
      -- that carried no model attribute - every retry of that export would insert a new
      -- row and the total would climb on its own. The writer coalesces; nothing stores null.
      model_id      TEXT NOT NULL DEFAULT '',  -- raw, e.g. claude-opus-4-8[1m]
      query_source  TEXT NOT NULL DEFAULT '',  -- main | subagent | auxiliary
      -- The datapoint's dedup identity, as TEXT. timeUnixNano is ~1.78e18, well past
      -- Number.MAX_SAFE_INTEGER (9.007e15), so parsing it as a JS number would silently
      -- collide adjacent windows. Holds timeUnixNano for a delta datapoint (each export
      -- is a distinct window, and the rows accumulate) and startTimeUnixNano for a
      -- cumulative one (the series has one fixed start, so every export replaces the same
      -- row with the newer running total). SUM over rows is correct in both cases.
      window_end_ns TEXT NOT NULL,
      ts            INTEGER NOT NULL,        -- window end in epoch ms, for range queries
      -- Who the spend belongs to: 'session' for work a human asked a card to do,
      -- 'automation' for a headless run one of the autonomous loops made on its own.
      --
      -- A column rather than a prefix test on note_key, because four separate aggregate
      -- queries need the distinction and 'note_key LIKE ''foreman:%'' OR ...' repeated in
      -- each is a convention enforced nowhere - the fifth query would silently omit a role.
      -- The DEFAULT is what makes the migration correct on an existing database: every row
      -- written before this column existed came from a session's OTel or rollout stream.
      --
      -- An automation row keys window_end_ns to the RUN's own id (claude's session_id,
      -- codex's thread_id) rather than an export window, which is what makes a retried
      -- report idempotent and what lets SESSION_SPEND_ONLY find a claude run's OTel twin.
      spend_kind    TEXT NOT NULL DEFAULT 'session',
      cost_usd      REAL NOT NULL DEFAULT 0,
      cost_basis    TEXT NOT NULL DEFAULT 'reported',
      cost_known    INTEGER NOT NULL DEFAULT 1,
      pricing_version TEXT NOT NULL DEFAULT '',
      input         INTEGER NOT NULL DEFAULT 0,
      output        INTEGER NOT NULL DEFAULT 0,
      reasoning_output INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(note_key, model_id, query_source, window_end_ns)
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_key ON usage_ledger(note_key, ts);
    CREATE INDEX IF NOT EXISTS idx_ledger_ts  ON usage_ledger(ts);
    -- The index on spend_kind is NOT here: this block runs before migrate() adds that
    -- column, so an existing database would fail to open on a CREATE naming it. See the
    -- addColumn beside it.

    -- Durable byte cursors for harness-owned append-only usage sources. The event rows
    -- and cursor move in one transaction, so a crash can replay but cannot skip usage.
    CREATE TABLE IF NOT EXISTS usage_sources (
      source_key   TEXT PRIMARY KEY,
      agent        TEXT NOT NULL,
      offset       INTEGER NOT NULL,
      model_id     TEXT NOT NULL DEFAULT '',
      discard_partial INTEGER NOT NULL DEFAULT 0,
      file_id      TEXT NOT NULL DEFAULT '',
      updated_at   INTEGER NOT NULL
    );

    -- The last skills generation each session was told about. Durable on purpose:
    -- held in memory, a daemon restart would forget every ack while the generation
    -- stayed put, and the next idle moment would type /reload-skills into every
    -- claude on the machine at once.
    CREATE TABLE IF NOT EXISTS skills_acks (
      note_key   TEXT PRIMARY KEY,   -- noteKeyFor(s), same key as session_notes
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Sessions the daemon RUNS rather than finds: one row per embedded (SDK-runtime)
    -- session. Live sessions are otherwise never persisted because the OS can rebuild
    -- them, but not these: terminal discovery deliberately excludes daemon-owned
    -- subprocesses. Without this row a daemon restart loses the session, its harness-native
    -- thread id (the only way to resume the conversation), and any task bound to it.
    --
    -- The id is the supervisor's own sdk:<uuid>, which is why it is durable: it is the
    -- registry's map key AND this primary key, so a restored row registers the same card
    -- rather than a second one. agent_session_id is nullable because it does not exist
    -- until the harness mints it - that is the driver bound event, and a row written before
    -- it lands is a session that was starting when the daemon died.
    --
    -- Ordinary table with no REFERENCES clause (the ensemble family stays the only one
    -- declaring foreign keys) and no index: the only reads are by primary key and the
    -- whole-table restore sweep, which runs once at startup over the embedded-session ledger.
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id                TEXT PRIMARY KEY NOT NULL,
      agent             TEXT NOT NULL,
      agent_session_id  TEXT,
      cwd               TEXT NOT NULL,
      task_id           TEXT,
      model             TEXT,
      effort            TEXT,
      permission_mode   TEXT,
      status            TEXT NOT NULL,
      -- Independent of lifecycle status: a suspended driver may owe a continuation turn.
      turn_in_progress  INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS foreman_queues (
      note_key        TEXT PRIMARY KEY,   -- noteKeyFor(s) = agentSessionId ?? synthetic id
      cwd             TEXT,               -- + branch: the re-attach hint when the key dies
      branch          TEXT,
      wrapup_asked_at INTEGER,            -- the drain ask fires exactly once
      wrapup_answer   TEXT,
      prompted_goal   TEXT,               -- the goal the prompted trigger last fired on
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

    -- The Inspector's ADOPTION ledger. A row here is the permission to comment on a
    -- pull request, and the absence of one is why we don't comment on everyone else's.
    -- Rows are written only from a signal that PROVES we opened the PR, and they
    -- outlive the session that did (a PR is not done when its session exits).
    CREATE TABLE IF NOT EXISTS inspector_prs (
      key              TEXT PRIMARY KEY,  -- "owner/repo#123"
      url              TEXT NOT NULL,
      owner            TEXT NOT NULL,
      repo             TEXT NOT NULL,
      number           INTEGER NOT NULL,
      repo_root        TEXT,              -- INSPECTOR.md + standards + the allowlist check
      cwd              TEXT,              -- a checkout to run gh from
      session_id       TEXT,              -- nullable: the PR outlives the session
      source           TEXT NOT NULL,     -- hook | no-mistakes (how we know it's ours)
      state            TEXT NOT NULL,     -- open | closed
      head_sha         TEXT,              -- head as of the last completed review
      review_posture   TEXT,              -- consent posture that produced head_sha
      round            INTEGER NOT NULL DEFAULT 0,
      last_reviewed_at INTEGER,
      last_error       TEXT,
      fail_count       INTEGER NOT NULL DEFAULT 0,  -- consecutive failures, for the backoff
      last_fail_kind   TEXT,              -- push-fixable | persistent (may a push skip the wait)
      next_attempt_at  INTEGER,          -- not before this; null = due now
      last_attempt_sha TEXT,             -- the head the backoff was earned on
      merged_at        INTEGER,          -- when YOLO mode landed it; null = we did not
      merge_block      TEXT,             -- why it has not merged itself (see shipping.ts)
      adopted_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspector_prs_state ON inspector_prs(state);

    -- The Inspector's PROVENANCE ledger: one row per ISSUE per PR, not per comment.
    --
    -- The unique index is the dedup, and it is here rather than in code on purpose:
    -- "don't post the same complaint twice" is the rule that keeps an automated
    -- reviewer tolerable, and a rule enforced by a code path is a rule someone
    -- eventually routes around. The fingerprint deliberately excludes the line number,
    -- so a push that shifts code down doesn't re-raise everything.
    CREATE TABLE IF NOT EXISTS inspector_comments (
      id                  TEXT PRIMARY KEY,  -- our uuid, also embedded in the marker
      pr_key              TEXT NOT NULL,
      fingerprint         TEXT NOT NULL,     -- sha1(path + normalized title)
      path                TEXT,
      line                INTEGER,
      title               TEXT NOT NULL,
      body                TEXT,
      severity            TEXT NOT NULL,
      round               INTEGER NOT NULL,
      status              TEXT NOT NULL,     -- drafted | posting | open | resolved
      replies             INTEGER NOT NULL DEFAULT 0,
      answered_comment_id INTEGER,           -- newest foreign comment we've answered
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    -- No index on (pr_key) alone: it is the leftmost prefix of the unique index below,
    -- so it can serve no query that one cannot, and it costs a write per row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inspector_comments_fp
      ON inspector_comments(pr_key, fingerprint);

    -- ---- recurring missions ----
    --
    -- One row per schedule the operator created. The TEMPLATE is not here: it lives on
    -- the immutable revision this row points at, because history has to be able to say
    -- what a run was configured to do at the moment it ran, and a rename must not
    -- rewrite what already happened.
    CREATE TABLE IF NOT EXISTS mission_schedules (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 0,
      archived_at    INTEGER,           -- archived: hidden from the catalog, deletes nothing
      expression     TEXT NOT NULL,     -- five cron fields, canonical spacing
      timezone       TEXT NOT NULL,     -- canonical IANA id, as Intl resolved it
      overlap_policy TEXT NOT NULL,
      missed_policy  TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      runner_id      TEXT,              -- always NULL in V1; the always-on host, later
      revision       INTEGER NOT NULL,  -- -> mission_schedule_revisions.revision
      -- The durable cursor, in UTC epoch milliseconds. This, not an in-memory timer, is
      -- what makes catch-up correct: timers stop when the laptop sleeps and are lost on
      -- restart, and neither event may lose a due instant. NULL only for paused,
      -- archived, or uncomputable.
      next_run_at    INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    -- The tick asks "which enabled, unarchived schedules are due?" on a bounded loop.
    CREATE INDEX IF NOT EXISTS idx_mission_schedules_due
      ON mission_schedules(enabled, next_run_at);

    -- Immutable. An edit inserts revision n+1 and repoints the schedule; nothing here is
    -- ever updated. Cadence and policies are COPIED rather than joined because they are
    -- what explain a historical decision, and the schedule's current values do not.
    CREATE TABLE IF NOT EXISTS mission_schedule_revisions (
      schedule_id    TEXT NOT NULL,
      revision       INTEGER NOT NULL,
      template_json  TEXT NOT NULL,
      expression     TEXT NOT NULL,
      timezone       TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      missed_policy  TEXT NOT NULL,
      execution_mode TEXT NOT NULL,
      runner_id      TEXT,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (schedule_id, revision)
    );

    -- The exactly-once ledger. One row per (schedule, instant), and the UNIQUE index is
    -- the guarantee itself rather than a check somewhere in TypeScript: two ticks, two
    -- processes or a restart mid-claim all collide on the same key, and exactly one wins.
    --
    -- Both key columns are NOT NULL, which is load-bearing. SQLite treats NULLs as
    -- distinct, so a nullable column in an index you ON CONFLICT against turns the upsert
    -- back into an insert and the row multiplies on every retry - here that would be a
    -- duplicate agent task per tick.
    CREATE TABLE IF NOT EXISTS mission_schedule_occurrences (
      id                TEXT PRIMARY KEY,
      schedule_id       TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL,  -- the revision in force at claim time
      scheduled_for     INTEGER NOT NULL,  -- the instant this is FOR, not when it ran
      trigger_kind      TEXT NOT NULL,     -- scheduled | manual (Run now)
      -- The intent RESERVED with the claim, before any task exists. Immutable, and the
      -- reason recovery can finish a crashed claim at all: without it, a restart would
      -- have to recompute policy from a schedule the operator may have edited in the
      -- meantime, and a pending coalesce would come back as something else.
      decision_kind     TEXT NOT NULL,
      claimed_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      status            TEXT NOT NULL,     -- claimed is the only non-terminal value
      task_id           TEXT,              -- preallocated at claim, so recovery can find it
      covered_by_id     TEXT,              -- the later occurrence that represented this one
      blocking_task_id  TEXT,              -- the still-active task behind a skipped_overlap
      delay_ms          INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      created_at        INTEGER NOT NULL,
      UNIQUE (schedule_id, scheduled_for)
    );
    -- History is drawn newest-first and paged on scheduled_for; the UNIQUE index above is
    -- (schedule_id, scheduled_for) already, so this exists only for the DESC scan.
    CREATE INDEX IF NOT EXISTS idx_mission_occurrences_history
      ON mission_schedule_occurrences(schedule_id, scheduled_for DESC);
    -- Crash recovery sweeps every unfinished reservation, across all schedules.
    CREATE INDEX IF NOT EXISTS idx_mission_occurrences_recovery
      ON mission_schedule_occurrences(status, claimed_at);
    -- A generated task deep-links back to the run that filed it.
    CREATE INDEX IF NOT EXISTS idx_mission_occurrences_task
      ON mission_schedule_occurrences(task_id);

    -- ---- multi-agent ensembles ----
    --
    -- One family, generic on purpose. Nothing below says candidate, judge, diff or winner:
    -- Best-of-N is a strategy that COMPILES into these rows, and a tournament, a critique
    -- round or a synthesis has to persist through the same ones. A strategy that needed a
    -- column here would be introducing a new primitive, not a new strategy.
    --
    -- This is the one table family in this file that declares FOREIGN KEYs, and they are
    -- live: the pragma above is on. A member row whose run does not exist is unreachable
    -- garbage - nothing can render it, cancel it or clean up after it - so the constraint
    -- is worth more than the freedom to write one. Deletion cascades DOWNWARD from a run
    -- only; nothing here references tasks, because ensemble history has to outlive the task
    -- cleanup that reaps a worktree.
    --
    -- Every TEXT primary key below says NOT NULL explicitly, for the reason spelled out on
    -- workflow_binding_claims: a non-STRICT rowid table does NOT imply it, so PRIMARY KEY
    -- alone would admit several NULL ids and lose the identity the whole family joins on.
    CREATE TABLE IF NOT EXISTS ensemble_runs (
      id                   TEXT NOT NULL PRIMARY KEY,
      -- Who asked. source_key is the caller's idempotency key: a create request that lost
      -- its response, or was retried after a restart, derives the same key and gets the same
      -- run back instead of launching another N agents. Both columns are NOT NULL because
      -- SQLite treats NULLs as DISTINCT inside a unique index, so a nullable half would let
      -- the row multiply on exactly the retry it exists to absorb.
      source_kind          TEXT NOT NULL,
      source_key           TEXT NOT NULL,
      -- Display identity of the external record. NULL, not empty string: an operator-created
      -- ensemble genuinely has no external record, and this column is in no uniqueness key,
      -- so there is nothing an empty-string normalization would buy.
      source_id            TEXT,
      -- id and version separately, plus the id@version key the compiled plan carries. The
      -- key is what a newer build's run is still identifiable by when strategy_id names
      -- nothing this build has.
      strategy_id          TEXT NOT NULL,
      strategy_version     INTEGER NOT NULL,
      strategy_key         TEXT NOT NULL,
      strategy_label       TEXT NOT NULL,
      title                TEXT NOT NULL,
      intent               TEXT NOT NULL,
      repo_root            TEXT NOT NULL,
      -- Informational. base_sha is the fact that matters, and it is NULL until the launch
      -- runtime resolves and pins one full commit - a phase this schema deliberately
      -- precedes. Comparison between members is meaningless if their starting points differ.
      base_branch          TEXT,
      base_sha             TEXT,
      -- The immutable compiled plan and the validated config it came from. A run executes
      -- THIS for its whole life; recovery never recompiles with current defaults, because a
      -- compiler whose defaults moved would silently re-aim a run that is already launched.
      compiled_plan_json   TEXT NOT NULL,
      strategy_config_json TEXT NOT NULL,
      status               TEXT NOT NULL,
      active_stage_id      TEXT,
      outcome_json         TEXT,
      -- The optional post-selection Workflow handoff snapshot, pinned at creation and updated
      -- as the handoff runs. Nullable: most runs choose no handoff, and the linkage lives here
      -- rather than on workflow_bindings so Workflow retention never reaches an ensemble ref.
      workflow_handoff_json TEXT,
      -- A stable fingerprint of the raw create request. A retry that reuses a source key with any
      -- different field (a different repository, title, config, or workflow) is a conflict rather
      -- than a silent idempotent replay of the old run. Empty string on rows written before it.
      request_fingerprint    TEXT NOT NULL DEFAULT '',
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      completed_at         INTEGER,
      error                TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_runs_source
      ON ensemble_runs(source_kind, source_key);
    -- Restart reconciliation asks "which runs are not terminal?" once per start.
    CREATE INDEX IF NOT EXISTS idx_ensemble_runs_status
      ON ensemble_runs(status, updated_at);

    -- One logical member per compiled role. Created with the run, before any process exists,
    -- because every member of a wave has to be durable before the first task in that wave is
    -- dispatched - otherwise a crash mid-launch leaves agents nothing owns.
    --
    -- Deliberately holds no score, rank or winner flag. Those belong to an evaluation or the
    -- terminal outcome: one artifact may be judged in several panels, pairs or rounds, and a
    -- column here could only hold the last of them.
    CREATE TABLE IF NOT EXISTS ensemble_members (
      id                  TEXT NOT NULL PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      role_key            TEXT NOT NULL,
      role_label          TEXT NOT NULL,
      ordinal             INTEGER NOT NULL,
      wave                INTEGER NOT NULL,
      -- Empty string means "no task yet", and unlike source_id above this one IS in a
      -- uniqueness key, which is why it is normalized rather than nullable. The partial
      -- index enforces at most one member per task while leaving every unlaunched member
      -- free to share the empty value.
      task_id             TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL,
      selected_attempt_id TEXT,
      result_label        TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      error               TEXT,
      UNIQUE (id, run_id),
      UNIQUE (run_id, ordinal),
      UNIQUE (run_id, role_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_members_task
      ON ensemble_members(task_id) WHERE task_id <> '';

    -- One launch of one member. A retry appends an attempt; it never rewrites the member,
    -- so what was tried and what it was pinned to stays readable afterwards.
    CREATE TABLE IF NOT EXISTS ensemble_attempts (
      id               TEXT NOT NULL PRIMARY KEY,
      run_id           TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      member_id        TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      task_id          TEXT,
      session_id       TEXT,
      -- Launch facts as RESOLVED, not as requested: requested_model records what was asked
      -- for and observed_model what the harness reported, and reading one as the other is
      -- how a comparison credits a model that never ran.
      agent            TEXT,
      requested_model  TEXT,
      requested_effort TEXT,
      observed_model   TEXT,
      base_sha         TEXT,
      worktree_path    TEXT,
      branch           TEXT,
      status           TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      started_at       INTEGER,
      finished_at      INTEGER,
      error            TEXT,
      UNIQUE (id, run_id),
      FOREIGN KEY (member_id, run_id)
        REFERENCES ensemble_members(id, run_id) ON DELETE CASCADE,
      UNIQUE (member_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_ensemble_attempts_run
      ON ensemble_attempts(run_id, member_id);

    -- Immutable submitted evidence. LOCATORS and digests only - a ref, a commit id, a path -
    -- never the bytes. A full patch belongs in Git, which already stores it exactly once and
    -- can hand it back on demand; storing it here would put megabytes into a row that a
    -- detail read has to page and an SSE summary must never carry.
    CREATE TABLE IF NOT EXISTS ensemble_artifacts (
      id             TEXT NOT NULL PRIMARY KEY,
      run_id         TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      -- Attempt ownership, or the empty string for an artifact the RUN owns (a synthesis
      -- input, an evaluation record) that belongs to no single attempt. Normalized rather
      -- than nullable because it is half of the uniqueness key below.
      attempt_id     TEXT NOT NULL DEFAULT '',
      kind           TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      attempt        INTEGER NOT NULL,
      status         TEXT NOT NULL,
      locator_json   TEXT NOT NULL,
      digest         TEXT NOT NULL,
      metadata_json  TEXT NOT NULL,
      -- Stable per-capture key, so a repeated submission returns the artifact it already
      -- made rather than a second row describing the same commit.
      operation_key  TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      ready_at       INTEGER,
      error          TEXT,
      UNIQUE (run_id, attempt_id, kind, attempt)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_artifacts_operation
      ON ensemble_artifacts(operation_key);
    CREATE INDEX IF NOT EXISTS idx_ensemble_artifacts_status
      ON ensemble_artifacts(run_id, status);

    -- One attempt at one compiled stage. command_key is persisted BEFORE the side effect it
    -- authorizes, which is what makes a crash mid-wave replayable: the same command derives
    -- the same key, collides, and does not launch a second set of agents.
    CREATE TABLE IF NOT EXISTS ensemble_stage_attempts (
      id          TEXT NOT NULL PRIMARY KEY,
      run_id      TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      stage_id    TEXT NOT NULL,
      driver_kind TEXT NOT NULL,
      -- The exact id@version the plan named, not whatever this build considers current for
      -- that stage kind. A driver version removed while a non-terminal run still names it is
      -- a startup health error, never permission to invoke the latest one.
      driver_key  TEXT NOT NULL,
      attempt     INTEGER NOT NULL,
      command_key TEXT NOT NULL,
      status      TEXT NOT NULL,
      input_json  TEXT NOT NULL,
      output_json TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER,
      error       TEXT,
      UNIQUE (id, run_id),
      UNIQUE (run_id, stage_id, attempt)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_stage_attempts_command
      ON ensemble_stage_attempts(command_key);

    -- What a review stage decided, and about exactly which artifacts. input_fingerprint is
    -- the digest of the bounded evidence actually presented, so a retry can prove it judged
    -- the same thing rather than a re-materialized approximation of it.
    CREATE TABLE IF NOT EXISTS ensemble_evaluations (
      id                TEXT NOT NULL PRIMARY KEY,
      run_id            TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      stage_attempt_id  TEXT NOT NULL,
      attempt           INTEGER NOT NULL,
      method            TEXT NOT NULL,
      runner_id         TEXT,
      model_id          TEXT,
      input_fingerprint TEXT NOT NULL,
      subjects_json     TEXT NOT NULL,
      result_json       TEXT,
      status            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      error             TEXT,
      UNIQUE (id, run_id),
      FOREIGN KEY (stage_attempt_id, run_id)
        REFERENCES ensemble_stage_attempts(id, run_id) ON DELETE CASCADE,
      UNIQUE (stage_attempt_id, attempt)
    );

    -- Model calls the ENSEMBLE made - never the member agents' own work, whose cost is
    -- session telemetry. cost_usd stays nullable and authoritative-only: a provider that
    -- does not report a cost gets NULL, and reading that as zero is how a total quietly
    -- understates itself.
    CREATE TABLE IF NOT EXISTS ensemble_llm_calls (
      id               TEXT NOT NULL PRIMARY KEY,
      run_id           TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      stage_attempt_id TEXT,
      evaluation_id    TEXT,
      purpose          TEXT NOT NULL,
      runner_id        TEXT NOT NULL,
      model_id         TEXT NOT NULL,
      attempt          INTEGER NOT NULL,
      operation_key    TEXT NOT NULL,
      state            TEXT NOT NULL,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      duration_ms      INTEGER,
      input_bytes      INTEGER NOT NULL DEFAULT 0,
      output_bytes     INTEGER NOT NULL DEFAULT 0,
      cost_usd         REAL,
      error_code       TEXT,
      FOREIGN KEY (stage_attempt_id, run_id)
        REFERENCES ensemble_stage_attempts(id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (evaluation_id, run_id)
        REFERENCES ensemble_evaluations(id, run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ensemble_llm_calls_run
      ON ensemble_llm_calls(run_id, started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_llm_calls_operation
      ON ensemble_llm_calls(operation_key);

    -- The operator-visible audit trail. Append-only and bounded: what changed, not why an
    -- agent said it did. operation_key is UNIQUE so a replayed transition writes one row.
    CREATE TABLE IF NOT EXISTS ensemble_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      ts            INTEGER NOT NULL,
      event_kind    TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      operation_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ensemble_events_run
      ON ensemble_events(run_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_events_operation
      ON ensemble_events(operation_key);

    -- What a person chose. Versioned rather than updated, so history explains a promotion
    -- under the evidence that was on screen when it was made. An LLM ranking is evidence and
    -- reaches this table only as the rationale beside a human actor.
    CREATE TABLE IF NOT EXISTS ensemble_decisions (
      id                            TEXT NOT NULL PRIMARY KEY,
      run_id                        TEXT NOT NULL REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      version                       INTEGER NOT NULL,
      actor                         TEXT NOT NULL,
      actor_id                      TEXT,
      status                        TEXT NOT NULL,
      selection_json                TEXT NOT NULL,
      rationale                     TEXT NOT NULL DEFAULT '',
      finalization_stage_attempt_id TEXT,
      operation_key                 TEXT NOT NULL,
      created_at                    INTEGER NOT NULL,
      updated_at                    INTEGER NOT NULL,
      FOREIGN KEY (finalization_stage_attempt_id, run_id)
        REFERENCES ensemble_stage_attempts(id, run_id) ON DELETE CASCADE,
      UNIQUE (run_id, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ensemble_decisions_operation
      ON ensemble_decisions(operation_key);

    -- One in-progress explicit deletion per run. run_id is the PRIMARY KEY, so a repeated
    -- Delete resumes the same intent rather than opening a second. It CASCADES with its run:
    -- deletion's last durable step is deleteRun, and after it the intent is gone too, so
    -- recovery only ever finds intents whose run still exists - "there are refs still to
    -- delete". A pre-completion crash leaves this row; a post-completion one leaves nothing.
    CREATE TABLE IF NOT EXISTS ensemble_deletion_intents (
      run_id     TEXT NOT NULL PRIMARY KEY REFERENCES ensemble_runs(id) ON DELETE CASCADE,
      status     TEXT NOT NULL,
      error      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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
  // An embedded driver can be relaunched from `status` plus `agent_session_id`, but those
  // facts cannot say whether the old process died in the middle of a turn. Existing rows
  // default idle: no older build recorded proof that they owe an automatic continuation.
  addColumn(d, "sdk_sessions", "turn_in_progress", "INTEGER NOT NULL DEFAULT 0");

  // Phase 3 pins the compatibility facts used by explicit reattachment and records the
  // actual provider/model selected when each Persona attempt starts. Existing Phase 1/2
  // databases can contain table shells but no executable bindings, so empty identity
  // defaults truthfully mean "not captured by an executable build".
  addColumn(d, "workflow_bindings", "session_agent", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "workflow_bindings", "session_name", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "workflow_bindings", "session_cwd", "TEXT");
  addColumn(d, "workflow_bindings", "session_repo_root", "TEXT");
  addColumn(d, "workflow_node_attempts", "runner_id", "TEXT");
  addColumn(d, "workflow_node_attempts", "model_id", "TEXT");
  // Phase 6 retention markers are nullable because pre-retention rows contain full
  // evidence and delivery payloads. The sweep fills them only after its transaction
  // has appended the durable audit event and compacted that exact run family.
  addColumn(d, "workflow_runs", "evidence_pruned_at", "INTEGER");
  addColumn(d, "workflow_deliveries", "payload_pruned_at", "INTEGER");
  // The optional post-selection Workflow handoff snapshot. Editing the CREATE TABLE block above
  // is not enough - it is IF NOT EXISTS, so an operator upgrading from a Phase 3-5 build keeps
  // the ensemble_runs they already have, and every run write would fail on a column that never
  // appeared. Nullable with no default: a run created before handoffs existed genuinely pinned
  // none, and NULL is exactly that.
  addColumn(d, "ensemble_runs", "workflow_handoff_json", "TEXT");
  // The create-request idempotency fingerprint. NOT NULL DEFAULT '' so a pre-feature row reads as
  // "no recorded fingerprint"; a replay against such a run compares against '' and, when the new
  // request carries a real fingerprint, is a conflict rather than a silent adoption of a stranger.
  addColumn(d, "ensemble_runs", "request_fingerprint", "TEXT NOT NULL DEFAULT ''");

  // `queued` -> `backlog`: the task backlog stopped calling itself a queue, so
  // "queue" now only ever means a session's work queue. Rows persisted before the
  // rename still say 'queued', and `loadActiveTasks` would silently drop them from
  // the backlog on the next start. `tasks.status` is bare TEXT with no CHECK
  // constraint, so rewriting the value in place is safe.
  d.exec(`UPDATE tasks SET status='backlog' WHERE status='queued';`);

  // `priority` / `labels`: the optional triage fields, added to `tasks` long after it
  // shipped - so every existing install only gets them through these ALTERs, and
  // without them every task write on an upgraded db would fail. Both nullable with no
  // default, which reads truthfully rather than merely harmlessly: a task filed before
  // triage existed has no priority and no labels, and NULL is exactly that. It is also
  // a different answer from `low` and from `[]`-set-deliberately, which is why the
  // column is not `TEXT NOT NULL DEFAULT ''`.
  addColumn(d, "tasks", "priority", "TEXT");
  addColumn(d, "tasks", "labels", "TEXT");
  addColumn(d, "tasks", "dependencies", "TEXT");
  addColumn(d, "tasks", "workflow_id", "TEXT");
  // `enabled`: the backlog's autopilot toggle. NOT NULL DEFAULT 1, which is the whole
  // migration - every task already in an operator's backlog was schedulable before this
  // column existed, so backfilling anything else would park their backlog on upgrade
  // and the autopilot would go quiet with nothing on screen to explain it.
  addColumn(d, "tasks", "enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumn(d, "tasks", "terminal_resource_id", "TEXT");
  // Recurring Missions provenance. Editing the CREATE TABLE block above is not enough:
  // it is `IF NOT EXISTS`, so an operator upgrading into this build keeps the table they
  // already have and every task write would fail on three columns that never appeared.
  // All three nullable with no default, and no backfill: there were no scheduled tasks
  // before this feature, so NULL is the true answer for every existing row rather than a
  // placeholder standing in for one.
  addColumn(d, "tasks", "schedule_id", "TEXT");
  addColumn(d, "tasks", "schedule_occurrence_id", "TEXT");
  addColumn(d, "tasks", "scheduled_for", "INTEGER");
  // The one index in this file that cannot live beside its table. The CREATE TABLE block
  // runs BEFORE migrate(), so on an upgrading database this statement would reference a
  // column the ALTER above has not added yet and openDb() would throw on first start -
  // for every existing operator, not just for a fresh install nobody would notice.
  //
  // The overlap check ("is this schedule's previous work still in flight?") runs once per
  // due instant per tick and is bounded by schedule, so it wants the pair. Nullable
  // columns are fine here: unlike the occurrence ledger's UNIQUE index this one is never
  // conflicted against, so SQLite treating NULLs as distinct costs nothing.
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(schedule_id, status);`);
  addColumn(d, "session_work_episodes", "awaiting_agent_rebind", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_work_episodes", "rebind_from_transcript_path", "TEXT");
  addColumn(d, "session_work_episodes", "merged_at", "INTEGER");
  addColumn(d, "session_work_episodes", "prompted_at", "INTEGER");
  addColumn(d, "task_work_episode_bindings", "merged_at", "INTEGER");
  d.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY
          CASE WHEN dispatched_at IS NULL THEN 1 ELSE 0 END,
          dispatched_at DESC,
          created_at DESC,
          updated_at DESC,
          id DESC
      ) AS position
      FROM tasks
      WHERE session_id IS NOT NULL
    )
    UPDATE tasks SET session_id = NULL
    WHERE id IN (SELECT id FROM ranked WHERE position > 1);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_session
      ON tasks(session_id) WHERE session_id IS NOT NULL;
  `);

  // Usage provenance and immutable pricing metadata. Old rows are Claude's reported
  // telemetry, so the defaults are the truthful migration rather than a placeholder.
  addColumn(d, "usage_ledger", "cost_basis", "TEXT NOT NULL DEFAULT 'reported'");
  addColumn(d, "usage_ledger", "cost_known", "INTEGER NOT NULL DEFAULT 1");
  addColumn(d, "usage_ledger", "pricing_version", "TEXT NOT NULL DEFAULT ''");
  addColumn(d, "usage_ledger", "reasoning_output", "INTEGER NOT NULL DEFAULT 0");
  // Every row that predates headless spend accounting came from a session's own stream, so
  // 'session' is the truthful backfill rather than an unknown bucket. The one population it
  // gets wrong is the orphan OTel rows a `claude -p` Foreman run left behind before this
  // existed; those stay counted as session spend, because relabelling them would mean
  // guessing which uuid was a headless run from the shape of its rows.
  addColumn(d, "usage_ledger", "spend_kind", "TEXT NOT NULL DEFAULT 'session'");
  // Created HERE, not in the CREATE TABLE block, because that block runs first and an
  // upgraded database has no spend_kind column until the line above. Automation rows are a
  // small minority of the table, but every fleet read now filters on them - twice, since
  // the session total also has to exclude their OTel twins.
  d.exec("CREATE INDEX IF NOT EXISTS idx_ledger_kind ON usage_ledger(spend_kind, ts)");
  addColumn(d, "usage_sources", "discard_partial", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "usage_sources", "file_id", "TEXT NOT NULL DEFAULT ''");

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

  // `prompted_goal`: the resolved intent episode the `prompted` wrap-up trigger last
  // handled. The historical column name remains, but new writes store an opaque
  // `intent:<objectiveVersion>:<promptRevision>` guard rather than goal text.
  // Same exposure as the two ALTERs above: added to the CREATE TABLE after
  // `foreman_queues` shipped, and CREATE TABLE IF NOT EXISTS will not add a column to
  // an existing table, so without this every queue write on an upgraded db would fail.
  //
  // Nullable with no default, and that reads correctly rather than merely harmlessly:
  // NULL means "this checkout has never had a prompted wrap-up", which is the truthful
  // answer for every row written before the trigger existed. It leaves the trigger
  // ARMED on those checkouts, which is right - the whole point is to fire once the
  // human turns it on - and the verify step still has to agree before anything types.
  addColumn(d, "foreman_queues", "prompted_goal", "TEXT");

  // `decisions`: the structured questions of a `plan-decisions` review, as a JSON
  // array. Added to `reviews` after it shipped, so an upgraded DB only gets it via
  // this ALTER. Nullable with no default: every existing review, and every review of
  // another kind, reads as "no decisions" - which is exactly what they are.
  addColumn(d, "reviews", "decisions", "TEXT");

  // `resolved_by`: who decided the episode, split back out of `sent_by`. Unlike the
  // ALTERs above this covers a window rather than a shipped release - `foreman_episodes`
  // is new enough that the only dbs carrying it are the ones this feature was developed
  // against - but the CREATE TABLE above still won't add the column to them, and every
  // episode write would fail on a db that has the table without it. Nullable with no
  // default, so an episode written before the split reads as "still open", which is the
  // only honest answer: its `sent_by` cannot say whether a human dismissed it.
  addColumn(d, "foreman_episodes", "resolved_by", "TEXT");

  // `cheap_action` / `divergence`: what the cheap tier decided under `shadow`, and how it
  // compared with the full review. Same exposure as `resolved_by` above - the INSERT names
  // both columns, so without these every episode write on an existing db would fail.
  //
  // Nullable with no default, and null is a CLAIM here rather than a gap: "not measured".
  // Every row written before this shipped has no answer, and neither does any row written
  // under `off` (no cheap call is made) or `on` (the cheap tier decided, so there is no
  // second opinion to compare it against). Defaulting either to 'agree' would manufacture
  // evidence for the one question this measurement exists to answer.
  addColumn(d, "foreman_episodes", "cheap_action", "TEXT");
  addColumn(d, "foreman_episodes", "divergence", "TEXT");

  // The index `recentEpisodes` needs: the fleet-wide read has no `note_key` predicate, so
  // `idx_foreman_episodes_key` cannot serve it and the query is a full scan plus a sort.
  //
  // It lives HERE, under the ALTERs, and NOT beside the CREATE TABLE, which is the rule
  // `idx_tasks_schedule` exists to demonstrate: the CREATE block runs in full before
  // `migrate()` does. An index there naming a column an ALTER has not added yet throws in
  // `openDb()` on first start - for every existing operator, and never on the fresh install
  // it was tested against. This one indexes `created_at` only, which the CREATE block does
  // define, so it would have survived that ordering by luck; it sits here with the columns
  // it was added for so the next person moves the pair together. Test: `foreman-episodes-db.test.ts`.
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_foreman_episodes_recent
       ON foreman_episodes(created_at DESC, id DESC)`,
  );

  // `model`: the per-task model override, added to `tasks` after it shipped - so on an
  // upgraded db this ALTER is the only way the column arrives, and without it EVERY
  // task write would fail (the INSERT names the column). Nullable with no default, and
  // that reads correctly rather than merely harmlessly: NULL means "no override, follow
  // the harness default", which is the truthful answer for every task dispatched before
  // a model could be chosen at all.
  addColumn(d, "tasks", "model", "TEXT");
  // `effort`: the per-task reasoning override. NULL follows the launch-time harness
  // default, which is also the truthful value for every task created before it existed.
  addColumn(d, "tasks", "effort", "TEXT");

  // `source_id` / `external_id` / `source_url`: where a task source swept a task from,
  // added to `tasks` long after it shipped. Same exposure as `model` above and the same
  // consequence - the INSERT names all three, so without these EVERY task write on an
  // upgraded db would fail, human-typed ones included. All nullable with no default,
  // which reads truthfully: NULL means "nobody swept this", the right answer for every
  // task filed before sources existed and for every one a human will ever type.
  //
  // Note what these are NOT: they are the link back, not identity. De-duplication is
  // decided against `task_source_seen`, whose rows outlive the task (see its comment) -
  // so nothing here is ever read to answer "have we filed this before?".
  addColumn(d, "tasks", "source_id", "TEXT");
  addColumn(d, "tasks", "external_id", "TEXT");
  addColumn(d, "tasks", "source_url", "TEXT");

  // `home_name`: the terminal home a dispatched agent lives in, renamed from the
  // tmux-specific `tmux_session` now that the name is resolved against ANY backend
  // (`killHome` / `homeAlive`), not assumed to be tmux. This is the destructive one: the
  // name drives `teardownWorktree`'s kill and `reconcileOnStartup`'s reclaim, and a real
  // user's upgraded db carries live agents' home names in the old column. So this is a
  // schema migration, not just a rename.
  //
  // Nullable with no default: NULL is "no home yet" (a backlog task, or one whose home was
  // reclaimed), a distinct and truthful answer that `homeName ? … : …` reads directly.
  //
  // The backfill runs EXACTLY ONCE - gated on the migration having just added the column -
  // and never again. `tmux_session` becomes a frozen fossil after this rename (no write
  // path names it), so re-running the copy on every open would RESURRECT a home name onto a
  // task that had since been reclaimed to NULL, re-aiming its teardown at a stranger. Gated
  // on the add, it copies each live name across on the one start after upgrade and then the
  // fossil is inert forever. `hasColumn` guards the pre-triage-fresh-db path where
  // `tmux_session` never existed to copy from.
  migrateTaskHomeName(d);

  // `fail_count` / `next_attempt_at`: the Inspector's retry backoff. Same window as
  // `foreman_episodes.resolved_by` above - `inspector_prs` has never shipped, so the
  // only dbs carrying it are the ones this feature was developed against - but CREATE
  // TABLE IF NOT EXISTS still will not add a column to a table that exists, and the
  // INSERT names both, so without these every adoption on such a db would fail.
  //
  // `fail_count` defaults to 0 and `next_attempt_at` is nullable, so a row written
  // before the backoff existed reads as "no failures, due now" - which is the truthful
  // answer for a row nothing had yet counted failures for.
  addColumn(d, "inspector_prs", "fail_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "inspector_prs", "next_attempt_at", "INTEGER");
  // `last_attempt_sha`: the head a backoff was earned on, so a new push can cut the wait
  // short. Same unshipped-table window as the two above, and nullable for the same
  // reason - a row written before it existed has attempted nothing we can name, and the
  // backoff on it stays fully in force until something does.
  addColumn(d, "inspector_prs", "last_attempt_sha", "TEXT");
  // `last_fail_kind`: which of the two failure classes earned the wait now in force, so
  // the push-escape can be unlimited for the class a push is the remedy for and capped
  // for the class it cannot touch. Same unshipped-table window as the three above.
  // Nullable, and NULL reads as "nothing has failed" - which is also the safe reading if
  // it somehow survives alongside a non-zero `fail_count`, since an unnamed class falls
  // under the cap rather than escaping it.
  addColumn(d, "inspector_prs", "last_fail_kind", "TEXT");
  // `merged_at` / `merge_block`: YOLO mode's half of the ledger - when we landed a PR
  // ourselves, and why we have not. Both nullable, and NULL reads as "never merged by us,
  // and nothing has evaluated it yet", which is the truthful answer for every row written
  // before the feature existed. Unlike the four above these DO land on shipped databases,
  // so the migration is not optional: the adoption INSERT names both columns.
  addColumn(d, "inspector_prs", "merged_at", "INTEGER");
  addColumn(d, "inspector_prs", "merge_block", "TEXT");
  // A current live setting must not retroactively promote a dry-run review. Nullable is
  // fail-closed for rows written by older builds: their reviewed head must be run again
  // before it can authorize a merge.
  addColumn(d, "inspector_prs", "review_posture", "TEXT");
  // Finding bodies were historically posted and then discarded locally. Persist only
  // the already-scrubbed planner output; NULL truthfully identifies legacy rows.
  addColumn(d, "inspector_comments", "body", "TEXT");

  // Whether a parked repair round resumes itself. NULLABLE with NO default on purpose: a
  // NULL is the truthful record of a draft authored, or a version PUBLISHED, by a build
  // that had no such setting, and the store reads it as `manual` so every already-published
  // version keeps behaving exactly as it was published (see
  // `LEGACY_WORKFLOW_RESUMPTION_POLICY`). A `DEFAULT 'auto'` here would have rewritten that
  // history in place and started resubmitting runs on every machine that upgraded. No index:
  // the resumption observer sweeps the handful of non-terminal runs it already holds and
  // never selects on this column.
  addColumn(d, "workflow_definitions", "resumption_policy", "TEXT");
  addColumn(d, "workflow_versions", "resumption_policy", "TEXT");

  // `inspector_comments(pr_key)` is the leftmost prefix of the unique index on
  // (pr_key, fingerprint), so it can serve no query that one cannot. Dropped rather
  // than merely removed from the CREATE, or a db created before this build keeps
  // paying for it forever. `comment_id` / `thread_id` are left where they are: SQLite
  // column drops are the expensive kind of migration, the columns are nullable, and
  // every INSERT names its columns, so a leftover one is inert.
  d.exec(`DROP INDEX IF EXISTS idx_inspector_comments_pr;`);

  // Goal intent was originally one sentence plus the latest prompt. Keep the existing row as
  // the best recoverable objective and let the next prompt reconcile it. Numeric defaults make
  // legacy rows explicitly pre-versioned rather than inventing a prompt history they never had.
  addColumn(d, "session_goals", "objective", "TEXT");
  addColumn(d, "session_goals", "focus", "TEXT");
  addColumn(d, "session_goals", "relationship", "TEXT");
  addColumn(d, "session_goals", "rationale", "TEXT");
  addColumn(d, "session_goals", "objective_version", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_goals", "prompt_revision", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_goals", "resolved_prompt_revision", "INTEGER NOT NULL DEFAULT 0");
  addColumn(d, "session_goals", "pending_prompts", "TEXT NOT NULL DEFAULT '[]'");
  //
  // `usage_sources` is new; its defensive cursor-state migrations above also make
  // intermediate development databases safe to reopen. `usage_ledger` does need a user
  // migration: its provenance/pricing defaults identify every old Claude row as reported
  // rather than retroactively estimating or repricing it.

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

function migrateTaskHomeName(d: DatabaseSync): void {
  try {
    d.exec("BEGIN IMMEDIATE;");
    if (addColumn(d, "tasks", "home_name", "TEXT") && hasColumn(d, "tasks", "tmux_session")) {
      d.exec(`UPDATE tasks SET home_name = tmux_session WHERE home_name IS NULL AND tmux_session IS NOT NULL;`);
    }
    d.exec("COMMIT;");
  } catch (err) {
    try {
      d.exec("ROLLBACK;");
    } catch {}
    throw err;
  }
}

/** Whether a table already has a column. The building block of an idempotent migration. */
function hasColumn(d: DatabaseSync, table: string, column: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Add a column unless it's already there. The idempotent half of a migration.
 *
 * Returns whether it ADDED the column (false when it was already present), so a caller can
 * hang a one-time data backfill off "the column is new" rather than re-running it on every
 * open - see the `home_name` migration.
 */
function addColumn(d: DatabaseSync, table: string, column: string, decl: string): boolean {
  if (hasColumn(d, table, column)) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  return true;
}

interface ReviewRow {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  response: string | null;
  decisions: string | null;
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
    decisions: parseDecisions(r.decisions),
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * Decode the `decisions` column. A malformed blob returns null rather than throwing:
 * one corrupt row must not take down `loadPendingReviews` and every review with it, and
 * "no decisions" is the safe degradation - the card renders as a plain plan.
 */
function parseDecisions(raw: string | null): PlanDecision[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PlanDecision[]) : null;
  } catch {
    return null;
  }
}

export function insertReview(r: ReviewItem): void {
  openDb()
    .prepare(
      `INSERT INTO reviews (id, session_id, kind, title, body, status, response, decisions, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.sessionId,
      r.kind,
      r.title,
      r.body,
      r.status,
      r.response,
      r.decisions && r.decisions.length ? JSON.stringify(r.decisions) : null,
      r.createdAt,
      r.resolvedAt,
    );
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

/** Human-resolved plan/input records retained as workflow intent evidence. */
export function loadResolvedWorkflowReviews(sessionId: string, limit = 100): ReviewItem[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM reviews
        WHERE session_id = ?
          AND kind IN ('plan', 'plan-decisions', 'input')
          AND status IN ('approved', 'rejected', 'answered')
        ORDER BY resolved_at DESC, created_at DESC
        LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as ReviewRow[];
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
 * Longest pane capture kept per episode.
 *
 * A pane is a whole terminal screen and the only copy of a terminal ask, so this is
 * generous - but it is not unbounded, because a pane is whatever the child happened
 * to be printing and a scrolling build log would otherwise land here in full. The
 * ask is at the BOTTOM of a pane (the dialog is the foreground - see
 * `parsePaneDialog`), so when this bites, the tail is the half worth keeping.
 */
const MAX_EPISODE_PANE = 16_000;

/** Longest free-text field (question / brief / recommendation / sent text) per episode. */
const MAX_EPISODE_TEXT = 8000;

/** What the worker records once it has acted on a waiting episode. */
export interface EpisodeWrite {
  noteKey: string;
  sessionId: string;
  marker: string;
  situation: string;
  surface: string;
  question: string;
  pane: string | null;
  menu: PaneDialogSummary | null;
  reviewId: string | null;
  purpose: string | null;
  brief: string | null;
  recommendation: string | null;
  classification: string | null;
  confidence: number | null;
  tier: number | null;
  /** The shadow measurement. Both null unless the posture was `shadow`. */
  cheapAction: CheapAction | null;
  divergence: Divergence | null;
  disposition: NoteDisposition;
  lastAction: string | null;
  sentText: string | null;
  sentOption: { number: number; label: string } | null;
  /** Who authored what reached the child; null when nothing was delivered. */
  sentBy: EpisodeAuthor | null;
  createdAt: number;
  resolvedAt: number | null;
  /** Who decided the episode; null while it is still waiting on someone. */
  resolvedBy: EpisodeAuthor | null;
}

/** Clamp a nullable free-text field to what the DB carries. */
function episodeText(v: string | null | undefined, max = MAX_EPISODE_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Record what Foreman was asked and what it did about it.
 *
 * Upserts on (note_key, marker) rather than always inserting, and the distinction
 * matters: the pair is unique by construction (the worker refuses to re-handle a
 * marker it has stamped), so a second write for the same pair is not a second
 * episode - it is the SAME episode reaching a later state, which is exactly what a
 * human's Approve does minutes after Foreman escalated. Inserting there would split
 * one decision across two rows, the second holding the outcome and the first the
 * question, with nothing in the UI to rejoin them.
 *
 * `created_at` is therefore preserved on conflict while everything else is
 * overwritten: the episode began when Foreman first faced it, not when the human got
 * round to it.
 */
export function recordEpisode(e: EpisodeWrite): number {
  const res = openDb()
    .prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, pane, menu, review_id,
          purpose, brief, recommendation, classification, confidence, tier, cheap_action,
          divergence, disposition,
          last_action, sent_text, sent_option, sent_by, created_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key, marker) DO UPDATE SET
         session_id     = excluded.session_id,
         situation      = excluded.situation,
         surface        = excluded.surface,
         question       = excluded.question,
         pane           = COALESCE(excluded.pane, foreman_episodes.pane),
         menu           = COALESCE(excluded.menu, foreman_episodes.menu),
         review_id      = excluded.review_id,
         purpose        = excluded.purpose,
         brief          = excluded.brief,
         recommendation = excluded.recommendation,
         classification = excluded.classification,
         confidence     = excluded.confidence,
         tier           = excluded.tier,
         -- Overwritten wholesale, NOT coalesced like pane/menu above, and the split is
         -- deliberate. Those two are the captured ASK, which a later write may simply not
         -- have re-read - so keeping the earlier copy is keeping evidence. These two are
         -- part of the ANSWER, beside classification/confidence/tier: they describe the
         -- verdict this row now stores. Coalescing them would leave a measurement taken
         -- under shadow attached to a decision later re-made under off, which reads as
         -- a divergence nobody measured. (No backticks in here: this is a template
         -- literal, and one would end it mid-statement.)
         cheap_action   = excluded.cheap_action,
         divergence     = excluded.divergence,
         disposition    = excluded.disposition,
         last_action    = excluded.last_action,
         sent_text      = excluded.sent_text,
         sent_option    = excluded.sent_option,
         sent_by        = excluded.sent_by,
         resolved_at    = excluded.resolved_at,
         resolved_by    = excluded.resolved_by`,
    )
    .run(
      e.noteKey,
      e.sessionId,
      e.marker,
      e.situation,
      e.surface,
      episodeText(e.question) ?? "",
      episodeText(e.pane, MAX_EPISODE_PANE),
      e.menu ? JSON.stringify(e.menu) : null,
      e.reviewId,
      episodeText(e.purpose),
      episodeText(e.brief),
      episodeText(e.recommendation),
      e.classification,
      e.confidence,
      e.tier,
      e.cheapAction,
      e.divergence,
      e.disposition,
      episodeText(e.lastAction),
      episodeText(e.sentText),
      e.sentOption ? JSON.stringify(e.sentOption) : null,
      e.sentBy,
      e.createdAt,
      e.resolvedAt,
      e.resolvedBy,
    );
  return Number(res.lastInsertRowid);
}

/**
 * Stamp the human's answer onto an episode Foreman left open.
 *
 * Separate from `recordEpisode` because the caller is different in kind: the worker
 * writes a whole episode from everything it has in hand, while the dashboard knows
 * only the marker and what the human just did. Routing the UI through the full write
 * would make it invent a question and a pane it never saw, and the COALESCE above
 * would then be load-bearing for correctness rather than for belt-and-braces.
 *
 * A marker with no row is a no-op: an episode written before this shipped (or swept)
 * has nothing to stamp, and failing the Approve over a missing audit row would put a
 * bookkeeping gap in front of the human's actual decision.
 */
export function resolveEpisode(p: {
  noteKey: string;
  marker: string;
  disposition: NoteDisposition;
  sentText: string | null;
  /** Who decided it. Whether they SENT anything is read off `sentText`, not asserted. */
  resolvedBy: EpisodeAuthor;
  resolvedAt: number;
}): void {
  const sent = episodeText(p.sentText);
  openDb()
    .prepare(
      `UPDATE foreman_episodes
          SET disposition = ?, sent_text = ?, sent_by = ?, resolved_at = ?, resolved_by = ?
        WHERE note_key = ? AND marker = ?`,
    )
    .run(
      p.disposition,
      sent,
      // Derived, never taken from the caller: a dismissal resolves the episode without
      // delivering anything, so there is no author to name. Attributing a send that
      // never happened is how the record came to claim the human had approved something
      // they had in fact thrown away.
      sent === null ? null : p.resolvedBy,
      p.resolvedAt,
      p.resolvedBy,
      p.noteKey,
      p.marker,
    );
}

/** The columns both episode reads select, so the two cannot drift apart. */
const EPISODE_COLUMNS = `id, note_key, session_id, marker, situation, surface, question, pane,
        menu, review_id, purpose, brief, recommendation, classification, confidence, tier,
        cheap_action, divergence, disposition, last_action, sent_text, sent_option, sent_by,
        created_at, resolved_at, resolved_by`;

/**
 * One stored row back to the wire shape.
 *
 * Shared by `episodesFor` and `recentEpisodes` rather than written twice: the per-field
 * `?? 0` / `typeof` defence below is the point of it. These rows outlive the daemon that
 * wrote them, so every field is read as "whatever is actually there" rather than trusted,
 * and a second copy of that reasoning would be a second place for it to be got wrong.
 */
function episodeFromRow(r: Record<string, unknown>): ForemanEpisode {
  return {
    id: Number(r.id ?? 0),
    noteKey: String(r.note_key ?? ""),
    sessionId: String(r.session_id ?? ""),
    marker: String(r.marker ?? ""),
    situation: String(r.situation ?? ""),
    surface: r.surface === "input-review" ? "input-review" : "terminal",
    question: String(r.question ?? ""),
    pane: typeof r.pane === "string" ? r.pane : null,
    menu: parseMenu(r.menu),
    reviewId: typeof r.review_id === "string" ? r.review_id : null,
    purpose: typeof r.purpose === "string" ? r.purpose : null,
    brief: typeof r.brief === "string" ? r.brief : null,
    recommendation: typeof r.recommendation === "string" ? r.recommendation : null,
    classification: typeof r.classification === "string" ? r.classification : null,
    confidence: typeof r.confidence === "number" ? r.confidence : null,
    tier: typeof r.tier === "number" ? r.tier : null,
    // Unknown reads as null - "not measured" - never as a nearest match. A row written by
    // a newer build with a divergence kind this one has no word for must render blank
    // rather than be rounded to `agree`, which is the one reading that would flatter the
    // cheap tier on exactly the evidence an operator is using to decide whether to trust it.
    cheapAction: readCheapAction(r.cheap_action),
    divergence: readDivergence(r.divergence),
    disposition: episodeDisposition(r.disposition),
    lastAction: typeof r.last_action === "string" ? r.last_action : null,
    sentText: typeof r.sent_text === "string" ? r.sent_text : null,
    sentOption: parseSentOption(r.sent_option),
    sentBy: r.sent_by === "foreman" || r.sent_by === "you" ? r.sent_by : null,
    createdAt: Number(r.created_at ?? 0),
    resolvedAt: typeof r.resolved_at === "number" ? r.resolved_at : null,
    resolvedBy: r.resolved_by === "foreman" || r.resolved_by === "you" ? r.resolved_by : null,
  };
}

/** Every episode recorded for one session key, newest first. */
export function episodesFor(noteKey: string, limit = 100): ForemanEpisode[] {
  const rows = openDb()
    .prepare(
      `SELECT ${EPISODE_COLUMNS}
         FROM foreman_episodes WHERE note_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(noteKey, limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(episodeFromRow);
}

/**
 * The newest episodes ACROSS every session, for the Foreman settings ledger.
 *
 * The cross-session counterpart to `episodesFor`, and the direct analogue of
 * `loadInspectorInspections`. Until this existed the table could only be read one
 * `note_key` at a time, so the richest record in the app - what Foreman was asked, what it
 * concluded, and what reached the child - was visible only by opening one session's drawer
 * at a time, and the fleet-wide question ("what has Foreman been doing?") had no answer.
 *
 * Ordered `created_at DESC, id DESC`, matching `episodesFor`: `created_at` is preserved
 * across the upsert, so two episodes recorded in the same millisecond still come back in
 * the order they were written rather than in whatever order the scan happens to reach them.
 *
 * **Returns a SUMMARY, not the stored row, and that is the point.** The first cut reused
 * `episodeFromRow` and therefore put up to a hundred captured terminal screens on a
 * 4-second poll: on a real 631-episode database `pane` was 50.6% of the response and the
 * drawer-only fields came to 82KB per poll, about 72MB an hour with the Settings page
 * open. That is the same cost this feature already refused to pay on the SSE channel (see
 * `Registry.recordEpisode`), just reached by a different transport - a poll is not a
 * loophole in that argument. The pane and menu are still READ here, because the ask is
 * derived from them, but they are reduced to one line by the shared `askPreview` and only
 * that line is returned. The full capture stays on `episodesFor`, which is the read for a
 * surface that shows one decision at a time.
 */
export function recentEpisodes(limit = 100): ForemanEpisodeSummary[] {
  const rows = openDb()
    .prepare(
      `SELECT id, note_key, marker, question, pane, menu, purpose, tier, cheap_action,
              divergence, disposition, resolved_by, created_at
         FROM foreman_episodes ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(
    (r): ForemanEpisodeSummary => ({
      id: Number(r.id ?? 0),
      noteKey: String(r.note_key ?? ""),
      marker: String(r.marker ?? ""),
      // Reduced HERE rather than in the browser, which is the whole saving: the inputs
      // are the two biggest columns in the table and the output is one clipped line.
      ask: askPreviewForWire({
        pane: typeof r.pane === "string" ? r.pane : null,
        menu: parseMenu(r.menu),
        question: String(r.question ?? ""),
      }),
      purpose: typeof r.purpose === "string" ? r.purpose : null,
      tier: typeof r.tier === "number" ? r.tier : null,
      cheapAction: readCheapAction(r.cheap_action),
      divergence: readDivergence(r.divergence),
      disposition: episodeDisposition(r.disposition),
      resolvedBy: r.resolved_by === "foreman" || r.resolved_by === "you" ? r.resolved_by : null,
      createdAt: Number(r.created_at ?? 0),
    }),
  );
}

/**
 * A stored disposition back to the union, defaulting to `skipped`.
 *
 * `skipped` and not `escalated` on an unrecognised value: these rows outlive the
 * daemon that wrote them, so a disposition minted by a newer build is a real
 * upgrade-window state. Reading it as `escalated` would put a decision in front of
 * the human that nothing established was theirs to make, and the strip would show a
 * live Approve for it. "Left for you" is the claim that stays true either way.
 */
function episodeDisposition(v: unknown): NoteDisposition {
  return v === "answered" || v === "pending" || v === "escalated" ? v : "skipped";
}

/** A stored `menu` blob back to its rows; a bad blob costs the menu, not the read. */
function parseMenu(raw: unknown): PaneDialogSummary | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as PaneDialogSummary;
    if (!v || !Array.isArray(v.options)) return null;
    return {
      options: v.options
        .filter((o) => o && typeof o.number === "number" && typeof o.label === "string")
        .map((o) => ({ number: o.number, label: o.label })),
      highlighted: typeof v.highlighted === "number" ? v.highlighted : 0,
    };
  } catch {
    return null;
  }
}

/** A stored `sent_option` blob back to the row that was selected. */
function parseSentOption(raw: unknown): { number: number; label: string } | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { number?: unknown; label?: unknown };
    if (typeof v?.number !== "number" || typeof v?.label !== "string") return null;
    return { number: v.number, label: v.label };
  } catch {
    return null;
  }
}

/**
 * Age out episodes. Returns how many rows went.
 *
 * Aged rather than session-scoped for the same reason as `pruneGateReplies`: the
 * record is most interesting once the session is over, so dropping it when the
 * session exits would delete it exactly when it starts being read. Panes make these
 * rows fatter than a gate reply, so the retention window is the shorter of the two.
 */
export function pruneEpisodes(cutoff: number): number {
  return Number(
    openDb().prepare(`DELETE FROM foreman_episodes WHERE created_at < ?`).run(cutoff).changes,
  );
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
 * the sessions. The synthetic id is tty+pid+start, so it's stable across a restart for
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
  priority: string | null;
  labels: string | null;
  dependencies: string | null;
  enabled: number;
  model: string | null;
  effort: string | null;
  workflow_id: string | null;
  source_id: string | null;
  external_id: string | null;
  source_url: string | null;
  repo_root: string;
  worktree_path: string | null;
  branch: string | null;
  provider: string | null;
  home_name: string | null;
  terminal_resource_id: string | null;
  session_id: string | null;
  schedule_id: string | null;
  schedule_occurrence_id: string | null;
  scheduled_for: number | null;
  status: string;
  outcome: string | null;
  outcome_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}

/** Read a `tasks.labels` blob back as a clean string array; anything unusable is none. */
function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeLabels(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return [];
  }
}

/** Read dependency JSON defensively: one stale row must not take down the backlog. */
function parseTaskDependencies(raw: string | null): Task["dependencies"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Task["dependencies"] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      const selectedAt = typeof row.selectedAt === "number" ? row.selectedAt : null;
      const satisfiedAt = typeof row.satisfiedAt === "number" ? row.satisfiedAt : null;
      if (row.type === "task" && typeof row.taskId === "string" && typeof row.title === "string") {
        const key = `task:${row.taskId}`;
        if (!seen.has(key)) {
          out.push({
            type: "task",
            taskId: row.taskId,
            title: row.title,
            sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
            episodeId: typeof row.episodeId === "string" ? row.episodeId : null,
            agentSessionId: typeof row.agentSessionId === "string" ? row.agentSessionId : null,
            branch: typeof row.branch === "string" ? row.branch : null,
            prUrl: typeof row.prUrl === "string" ? row.prUrl : null,
            selectedAt,
            satisfiedAt,
          });
        }
        seen.add(key);
      } else if (
        row.type === "session" &&
        typeof row.sessionId === "string" &&
        typeof row.title === "string"
      ) {
        const key = `session:${row.sessionId}`;
        if (!seen.has(key)) {
          out.push({
            type: "session",
            sessionId: row.sessionId,
            title: row.title,
            episodeId: typeof row.episodeId === "string" ? row.episodeId : null,
            agentSessionId: typeof row.agentSessionId === "string" ? row.agentSessionId : null,
            branch: typeof row.branch === "string" ? row.branch : null,
            prUrl: typeof row.prUrl === "string" ? row.prUrl : null,
            selectedAt,
            satisfiedAt,
          });
        }
        seen.add(key);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** A stale/newer effort value cannot be trusted as a harness launch option. */
function parseEffort(agent: Task["agent"], raw: string | null): Task["effort"] {
  return raw && supportsEffort(agent, raw as NonNullable<Task["effort"]>)
    ? (raw as Task["effort"])
    : null;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    intent: r.intent,
    kind: r.kind as TaskKind,
    agent: r.agent as Task["agent"],
    priority: r.priority as TaskPriority | null,
    // Re-normalized on the way out, not merely parsed. The column is plain TEXT and
    // this row may predate the cap (or have been written by an older build), so the
    // shared cleaner is what guarantees a caller never sees a duplicate or an
    // unbounded tag. A malformed blob reads as no labels rather than throwing - one
    // bad row must not take out `listTasks` and with it the whole backlog.
    labels: parseLabels(r.labels),
    dependencies: parseTaskDependencies(r.dependencies),
    // Only an explicit 0 parks a task. A row written by an older build, or one whose
    // column somehow reads NULL, is schedulable - the direction that degrades to the
    // behaviour every install already had rather than to a silently frozen backlog.
    enabled: r.enabled !== 0,
    model: r.model,
    effort: parseEffort(r.agent as Task["agent"], r.effort),
    workflowId: r.workflow_id,
    // Both key columns or nothing: half a provenance would render as a link to an item
    // nobody can name, and `source_id` alone cannot be matched back to anything.
    source:
      r.source_id && r.external_id
        ? { sourceId: r.source_id, externalId: r.external_id, url: r.source_url }
        : null,
    repoRoot: r.repo_root,
    worktreePath: r.worktree_path,
    branch: r.branch,
    provider: r.provider as WorktreeProvider | null,
    homeName: r.home_name,
    terminalResourceId: r.terminal_resource_id,
    sessionId: r.session_id,
    scheduleId: r.schedule_id,
    scheduleOccurrenceId: r.schedule_occurrence_id,
    scheduledFor: r.scheduled_for,
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

export function upsertTask(t: Task): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    // `session_id` is "currently executing on" (see `Task.sessionId`), and this is where
    // that is made EXCLUSIVE: writing the pointer onto one task takes it off every other
    // row in the same transaction, so a session names at most one task at a time and the
    // pointer simply MOVES when an agent takes its next task. It is a pointer and not a
    // record: what the displaced task produced is its own row's outcome and its own work
    // episodes, neither of which this touches. `idx_tasks_session` (a partial UNIQUE index)
    // is the same rule stated where it cannot be skipped; this statement is what keeps the
    // write from hitting it. The ids are returned so the caller can unbind those rows in
    // memory too - a Registry that kept a stale pointer would draw a card for a task the
    // database says is no longer running there.
    const displaced = t.sessionId
      ? (d
          .prepare(`SELECT id FROM tasks WHERE session_id = ? AND id <> ?`)
          .all(t.sessionId, t.id) as unknown as Array<{ id: string }>).map((row) => row.id)
      : [];
    if (t.sessionId) {
      d.prepare(`UPDATE tasks SET session_id = NULL WHERE session_id = ? AND id <> ?`).run(
        t.sessionId,
        t.id,
      );
    }
    d.prepare(
      `INSERT INTO tasks (
         id, title, intent, kind, agent, priority, labels, dependencies, enabled, model, effort,
         workflow_id, source_id, external_id, source_url, repo_root, worktree_path, branch,
         provider, home_name, terminal_resource_id, session_id,
         schedule_id, schedule_occurrence_id, scheduled_for,
         status, outcome, outcome_url, error,
         created_at, updated_at, dispatched_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, intent=excluded.intent, kind=excluded.kind, agent=excluded.agent,
         priority=excluded.priority, labels=excluded.labels, dependencies=excluded.dependencies,
         enabled=excluded.enabled, model=excluded.model, effort=excluded.effort,
         workflow_id=excluded.workflow_id,
         source_id=excluded.source_id, external_id=excluded.external_id,
         source_url=excluded.source_url,
         repo_root=excluded.repo_root, worktree_path=excluded.worktree_path, branch=excluded.branch,
         provider=excluded.provider, home_name=excluded.home_name,
         terminal_resource_id=excluded.terminal_resource_id, session_id=excluded.session_id,
         schedule_id=excluded.schedule_id,
         schedule_occurrence_id=excluded.schedule_occurrence_id,
         scheduled_for=excluded.scheduled_for,
         status=excluded.status, outcome=excluded.outcome, outcome_url=excluded.outcome_url,
         error=excluded.error, updated_at=excluded.updated_at, dispatched_at=excluded.dispatched_at,
         completed_at=excluded.completed_at`,
    ).run(
      t.id, t.title, t.intent, t.kind, t.agent, t.priority,
      // Stored as NULL rather than "[]" when empty, so the column reads the same for a
      // task filed before labels existed and one filed today with none - there is no
      // third state to tell apart, and `parseLabels` maps both back to [].
      t.labels.length > 0 ? JSON.stringify(t.labels) : null,
      t.dependencies.length > 0 ? JSON.stringify(t.dependencies) : null,
      t.enabled ? 1 : 0,
      t.model,
      t.effort,
      t.workflowId,
      t.source?.sourceId ?? null, t.source?.externalId ?? null, t.source?.url ?? null,
      t.repoRoot, t.worktreePath, t.branch, t.provider,
      t.homeName, t.terminalResourceId, t.sessionId,
      t.scheduleId, t.scheduleOccurrenceId, t.scheduledFor,
      t.status, t.outcome, t.outcomeUrl, t.error, t.createdAt,
      t.updatedAt, t.dispatchedAt, t.completedAt,
    );
    if (ownsTransaction) d.exec("COMMIT");
    return displaced;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function getTask(id: string): Task | undefined {
  const r = openDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as unknown as
    | TaskRow
    | undefined;
  return r ? rowToTask(r) : undefined;
}

export function taskIdForSession(sessionId: string): string | null {
  const row = openDb()
    .prepare(
      `SELECT id FROM tasks
       WHERE session_id = ? AND status NOT IN ('backlog', 'cancelled')`,
    )
    .get(sessionId) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface SessionWorkEpisode {
  episodeId: string;
  sessionId: string;
  agentSessionId: string;
  branch: string | null;
  prUrl: string | null;
  prHeadSha: string | null;
  mergedAt: number | null;
  promptedAt: number | null;
  awaitingAgentRebind: boolean;
  rebindFromTranscriptPath: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface TaskWorkEpisodeBinding {
  taskId: string;
  episodeId: string;
  sessionId: string;
  agentSessionId: string;
  branch: string | null;
  prUrl: string | null;
  prHeadSha: string | null;
  mergedAt: number | null;
  boundAt: number;
  updatedAt: number;
}

type SessionWorkEpisodeRow = {
  episode_id: string;
  session_id: string;
  agent_session_id: string;
  branch: string | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  merged_at: number | null;
  prompted_at: number | null;
  awaiting_agent_rebind: number;
  rebind_from_transcript_path: string | null;
  started_at: number;
  updated_at: number;
};

type TaskWorkEpisodeRow = {
  task_id: string;
  episode_id: string;
  session_id: string;
  agent_session_id: string;
  branch: string | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  merged_at: number | null;
  bound_at: number;
  updated_at: number;
};

function sessionWorkEpisodeFromRow(row: SessionWorkEpisodeRow): SessionWorkEpisode {
  return {
    episodeId: row.episode_id,
    sessionId: row.session_id,
    agentSessionId: row.agent_session_id,
    branch: row.branch,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    mergedAt: row.merged_at,
    promptedAt: row.prompted_at,
    awaitingAgentRebind: Boolean(row.awaiting_agent_rebind),
    rebindFromTranscriptPath: row.rebind_from_transcript_path,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function taskWorkEpisodeFromRow(row: TaskWorkEpisodeRow): TaskWorkEpisodeBinding {
  return {
    taskId: row.task_id,
    episodeId: row.episode_id,
    sessionId: row.session_id,
    agentSessionId: row.agent_session_id,
    branch: row.branch,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    mergedAt: row.merged_at,
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}

export function sessionWorkEpisodeFor(sessionId: string): SessionWorkEpisode | null {
  const row = openDb()
    .prepare(`SELECT * FROM session_work_episodes WHERE session_id = ?`)
    .get(sessionId) as unknown as SessionWorkEpisodeRow | undefined;
  return row ? sessionWorkEpisodeFromRow(row) : null;
}

export interface TaskDependencyRewrite {
  taskId: string;
  dependencies: Task["dependencies"];
  updatedAt: number;
}

function writeSessionWorkEpisode(d: DatabaseSync, episode: SessionWorkEpisode): void {
  d.prepare(
    `INSERT INTO session_work_episodes
       (session_id, episode_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, prompted_at,
        awaiting_agent_rebind, rebind_from_transcript_path, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       episode_id       = excluded.episode_id,
       agent_session_id = excluded.agent_session_id,
       branch           = excluded.branch,
       pr_url            = excluded.pr_url,
       pr_head_sha       = excluded.pr_head_sha,
       merged_at         = excluded.merged_at,
       prompted_at       = excluded.prompted_at,
       awaiting_agent_rebind = excluded.awaiting_agent_rebind,
       rebind_from_transcript_path = excluded.rebind_from_transcript_path,
       started_at       = excluded.started_at,
       updated_at       = excluded.updated_at`,
  ).run(
    episode.sessionId,
    episode.episodeId,
    episode.agentSessionId,
    episode.branch,
    episode.prUrl,
    episode.prHeadSha,
    episode.mergedAt,
    episode.promptedAt,
    episode.awaitingAgentRebind ? 1 : 0,
    episode.rebindFromTranscriptPath,
    episode.startedAt,
    episode.updatedAt,
  );
  if (episode.promptedAt !== null) {
    d.prepare(
      `INSERT OR IGNORE INTO session_work_episode_prompts
         (session_id, episode_id, prompted_at)
       VALUES (?, ?, ?)`,
    ).run(episode.sessionId, episode.episodeId, episode.promptedAt);
  }
}

function writeTaskDependencyRewrites(
  d: DatabaseSync,
  rewrites: TaskDependencyRewrite[],
): void {
  const update = d.prepare(
    `UPDATE tasks SET dependencies = ?, updated_at = ? WHERE id = ?`,
  );
  for (const rewrite of rewrites) {
    const result = update.run(
      rewrite.dependencies.length > 0 ? JSON.stringify(rewrite.dependencies) : null,
      rewrite.updatedAt,
      rewrite.taskId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`task disappeared during dependency rebind: ${rewrite.taskId}`);
    }
  }
}

function invalidateTaskOwnershipInTransaction(
  d: DatabaseSync,
  sessionId: string,
  at: number,
): string[] {
  const rows = d
    .prepare(
      `SELECT task_id FROM task_work_episode_bindings WHERE session_id = ?
       UNION SELECT id AS task_id FROM tasks WHERE session_id = ?`,
    )
    .all(sessionId, sessionId) as unknown as Array<{ task_id: string }>;
  // KNOWN GAP, deliberately left: this is the ONE binding-deleting path that does not
  // archive first. `bindTaskWorkEpisode` archives on both of its keys precisely so a
  // task's merge evidence outlives a rebind, and the same argument reads as if it applied
  // here - a task whose pull request merges after its session's work identity rotated has
  // no current binding and no historical one, so `mergedPrFor` reads null, the row this
  // statement just cancelled can never be upgraded, and `taskPrPollTargets` does not even
  // watch the url. Archiving here was tried and reverted: it makes exactly that upgrade
  // happen, and `complete(..., satisfyDependents)` then releases EVERY dependent of the
  // upgraded task - including edges the selection-time boundary in
  // `reconcileWorkEpisodeMerge` deliberately refuses, which is a different rule about who
  // a merge speaks for. Reconciling those two is a decision in its own right and not one
  // to make as a side effect. See `task-dependencies.test.ts`, which pins the boundary.
  d.prepare(`DELETE FROM task_work_episode_bindings WHERE session_id = ?`).run(sessionId);
  d.prepare(
    `UPDATE tasks SET
       session_id = NULL,
       status = CASE WHEN status IN ('dispatching', 'running') THEN 'cancelled' ELSE status END,
       completed_at = CASE
         WHEN status IN ('dispatching', 'running') THEN COALESCE(completed_at, ?)
         ELSE completed_at
       END,
       updated_at = MAX(updated_at, ?)
     WHERE session_id = ?`,
  ).run(at, at, sessionId);
  return rows.map((row) => row.task_id);
}

export function replaceSessionWorkEpisodeWithDependencies(
  episode: SessionWorkEpisode,
  rewrites: TaskDependencyRewrite[],
  invalidateOwnershipSessionId: string | null = null,
): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const invalidatedTaskIds = invalidateOwnershipSessionId === null
      ? []
      : invalidateTaskOwnershipInTransaction(d, invalidateOwnershipSessionId, episode.updatedAt);
    writeSessionWorkEpisode(d, episode);
    writeTaskDependencyRewrites(d, rewrites);
    if (ownsTransaction) d.exec("COMMIT");
    return invalidatedTaskIds;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function replaceSessionWorkEpisode(episode: SessionWorkEpisode): void {
  replaceSessionWorkEpisodeWithDependencies(episode, []);
}

export function deleteSessionWorkEpisodeWithOwnership(
  sessionId: string,
  at = Date.now(),
): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const invalidatedTaskIds = invalidateTaskOwnershipInTransaction(d, sessionId, at);
    d.prepare(`DELETE FROM session_work_episodes WHERE session_id = ?`).run(sessionId);
    if (ownsTransaction) d.exec("COMMIT");
    return invalidatedTaskIds;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export interface PendingSessionWorkEpisodeRebindResult {
  rebound: boolean;
  invalidatedTaskIds: string[];
}

export function rebindPendingSessionWorkEpisodeWithDependencies(
  sessionId: string,
  episodeId: string,
  agentSessionId: string,
  now: number,
  rewrites: TaskDependencyRewrite[],
  invalidateOwnershipSessionId: string | null = null,
): PendingSessionWorkEpisodeRebindResult {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const pending = d
      .prepare(
        `SELECT 1 FROM session_work_episodes
         WHERE session_id = ? AND episode_id = ? AND awaiting_agent_rebind = 1`,
      )
      .get(sessionId, episodeId);
    if (!pending) {
      if (ownsTransaction) d.exec("COMMIT");
      return { rebound: false, invalidatedTaskIds: [] };
    }
    const invalidatedTaskIds = invalidateOwnershipSessionId === null
      ? []
      : invalidateTaskOwnershipInTransaction(d, invalidateOwnershipSessionId, now);
    const result = d
      .prepare(
        `UPDATE session_work_episodes
         SET agent_session_id = ?, awaiting_agent_rebind = 0,
             rebind_from_transcript_path = NULL, updated_at = ?
         WHERE session_id = ? AND episode_id = ? AND awaiting_agent_rebind = 1`,
      )
      .run(agentSessionId, now, sessionId, episodeId);
    if (Number(result.changes) !== 1) {
      throw new Error(`pending work episode disappeared during rebind: ${sessionId}`);
    }
    if (invalidateOwnershipSessionId === null) {
      d.prepare(
        `UPDATE task_work_episode_bindings
         SET agent_session_id = ?, updated_at = ?
        WHERE session_id = ? AND episode_id = ?`,
      ).run(agentSessionId, now, sessionId, episodeId);
    }
    writeTaskDependencyRewrites(d, rewrites);
    if (ownsTransaction) d.exec("COMMIT");
    return { rebound: true, invalidatedTaskIds };
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function rebindPendingSessionWorkEpisode(
  sessionId: string,
  episodeId: string,
  agentSessionId: string,
  now: number,
): boolean {
  return rebindPendingSessionWorkEpisodeWithDependencies(
    sessionId,
    episodeId,
    agentSessionId,
    now,
    [],
  ).rebound;
}

export function deleteSessionWorkEpisode(sessionId: string): void {
  openDb().prepare(`DELETE FROM session_work_episodes WHERE session_id = ?`).run(sessionId);
}

export function deleteWorkEpisodePrompts(sessionId: string, episodeId: string): void {
  openDb()
    .prepare(
      `DELETE FROM session_work_episode_prompts WHERE session_id = ? AND episode_id = ?`,
    )
    .run(sessionId, episodeId);
}

export function workEpisodePromptIdentities(): Array<{
  sessionId: string;
  episodeId: string;
}> {
  const rows = openDb()
    .prepare(
      `SELECT DISTINCT session_id, episode_id FROM session_work_episode_prompts`,
    )
    .all() as unknown as Array<{ session_id: string; episode_id: string }>;
  return rows.map((row) => ({ sessionId: row.session_id, episodeId: row.episode_id }));
}

export function bindTaskWorkEpisode(binding: TaskWorkEpisodeBinding): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    // Archive the outgoing binding before this write overwrites it. On a rollover the SAME
    // task_id row is upserted with a NEW episode_id, so the episode the task is rolling OFF
    // - and the pr_url / merged_at that are the only durable proof its work landed - would
    // be lost. `mergedPrFor` reads current AND historical bindings precisely so that a merge
    // on a rolled-past episode still completes the task; that read is inert unless the old
    // binding is preserved here. Only a row that actually changes episode and carries a PR
    // is worth keeping - a PR-less binding is no completion evidence, and
    // `cleanupDependencyProvenance` prunes it anyway. (#167 archived here too, then dropped
    // it when dependency provenance moved onto the edges; durable completion is the new
    // reader that needs it back.) COALESCE keeps a merge already recorded on the historical
    // row rather than letting a re-archival clear it.
    d.prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       SELECT task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
              merged_at, bound_at, updated_at
       FROM task_work_episode_bindings
       WHERE task_id = ? AND episode_id <> ? AND pr_url IS NOT NULL
       ON CONFLICT(task_id, episode_id) DO UPDATE SET
         session_id       = excluded.session_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = COALESCE(excluded.merged_at, historical_task_work_episode_bindings.merged_at),
         bound_at         = excluded.bound_at,
         updated_at       = excluded.updated_at`,
    ).run(binding.taskId, binding.episodeId);
    // And archive any OTHER task's PR-carrying binding that the cross-task DELETE below is
    // about to drop. A session rebound from task A to task B removes A's current binding
    // here; if A's PR had merged while A was still active, losing that row leaves A with
    // neither a current nor a historical merge, so a later departure fails it. This is the
    // same durable-record contract as the rollover archival above, on the other key
    // (session_id, task_id <>) - #167 archived by both keys for exactly this reason.
    d.prepare(
      `INSERT INTO historical_task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       SELECT task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
              merged_at, bound_at, updated_at
       FROM task_work_episode_bindings
       WHERE session_id = ? AND task_id <> ? AND pr_url IS NOT NULL
       ON CONFLICT(task_id, episode_id) DO UPDATE SET
         session_id       = excluded.session_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = COALESCE(excluded.merged_at, historical_task_work_episode_bindings.merged_at),
         bound_at         = excluded.bound_at,
         updated_at       = excluded.updated_at`,
    ).run(binding.sessionId, binding.taskId);
    d.prepare(
      `DELETE FROM task_work_episode_bindings WHERE session_id = ? AND task_id <> ?`,
    ).run(binding.sessionId, binding.taskId);
    d.prepare(
      `INSERT INTO task_work_episode_bindings
         (task_id, episode_id, session_id, agent_session_id, branch, pr_url, pr_head_sha,
          merged_at, bound_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         episode_id       = excluded.episode_id,
         session_id       = excluded.session_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = excluded.merged_at,
         bound_at         = excluded.bound_at,
         updated_at       = excluded.updated_at`,
    ).run(
      binding.taskId,
      binding.episodeId,
      binding.sessionId,
      binding.agentSessionId,
      binding.branch,
      binding.prUrl,
      binding.prHeadSha,
      binding.mergedAt,
      binding.boundAt,
      binding.updatedAt,
    );
    if (ownsTransaction) d.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function taskWorkEpisodeForSession(sessionId: string): TaskWorkEpisodeBinding | null {
  const row = openDb()
    .prepare(
      `SELECT b.* FROM task_work_episode_bindings b
       JOIN tasks t ON t.id = b.task_id
       WHERE b.session_id = ? AND t.status NOT IN ('backlog', 'cancelled')`,
    )
    .get(sessionId) as unknown as TaskWorkEpisodeRow | undefined;
  return row ? taskWorkEpisodeFromRow(row) : null;
}

export function taskWorkEpisodeForTask(taskId: string): TaskWorkEpisodeBinding | null {
  const row = openDb()
    .prepare(`SELECT * FROM task_work_episode_bindings WHERE task_id = ?`)
    .get(taskId) as unknown as TaskWorkEpisodeRow | undefined;
  return row ? taskWorkEpisodeFromRow(row) : null;
}

export function historicalTaskWorkEpisodeBindings(): TaskWorkEpisodeBinding[] {
  const rows = openDb()
    .prepare(`SELECT * FROM historical_task_work_episode_bindings ORDER BY updated_at DESC`)
    .all() as unknown as TaskWorkEpisodeRow[];
  return rows.map(taskWorkEpisodeFromRow);
}

export function historicalTaskWorkEpisodeBindingsForTask(
  taskId: string,
): TaskWorkEpisodeBinding[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM historical_task_work_episode_bindings
       WHERE task_id = ? ORDER BY bound_at DESC`,
    )
    .all(taskId) as unknown as TaskWorkEpisodeRow[];
  return rows.map(taskWorkEpisodeFromRow);
}

export function deleteHistoricalTaskWorkEpisodeBinding(
  taskId: string,
  episodeId: string,
): void {
  openDb()
    .prepare(
      `DELETE FROM historical_task_work_episode_bindings
       WHERE task_id = ? AND episode_id = ?`,
    )
    .run(taskId, episodeId);
}

export function updateWorkEpisodePr(
  sessionId: string,
  episodeId: string,
  branch: string,
  prUrl: string,
  prHeadSha: string | null,
  now: number,
): boolean {
  const d = openDb();
  const result = d
    .prepare(
      `UPDATE session_work_episodes
       SET branch = ?, pr_url = ?, pr_head_sha = ?, updated_at = ?
       WHERE session_id = ? AND episode_id = ? AND (pr_url IS NULL OR pr_url = ?)`,
    )
    .run(branch, prUrl, prHeadSha, now, sessionId, episodeId, prUrl);
  if (Number(result.changes) === 0) return false;
  d.prepare(
    `UPDATE task_work_episode_bindings
     SET branch = ?, pr_url = ?, pr_head_sha = ?, updated_at = ?
     WHERE session_id = ? AND episode_id = ? AND (pr_url IS NULL OR pr_url = ?)`,
  ).run(branch, prUrl, prHeadSha, now, sessionId, episodeId, prUrl);
  return true;
}

export function recordWorkEpisodePrompt(
  sessionId: string,
  episodeId: string,
  promptedAt: number,
): boolean {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const result = d.prepare(
      `UPDATE session_work_episodes
       SET prompted_at = MAX(COALESCE(prompted_at, 0), ?), updated_at = MAX(updated_at, ?)
       WHERE session_id = ? AND episode_id = ?`,
    ).run(promptedAt, promptedAt, sessionId, episodeId);
    if (Number(result.changes) > 0) {
      d.prepare(
        `INSERT OR IGNORE INTO session_work_episode_prompts
           (session_id, episode_id, prompted_at)
         VALUES (?, ?, ?)`,
      ).run(sessionId, episodeId, promptedAt);
    }
    if (ownsTransaction) d.exec("COMMIT");
    return Number(result.changes) > 0;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function firstWorkEpisodePromptAfter(
  sessionId: string,
  episodeId: string,
  after: number,
): number | null {
  const row = openDb()
    .prepare(
      `SELECT prompted_at FROM session_work_episode_prompts
       WHERE session_id = ? AND episode_id = ? AND prompted_at > ?
       ORDER BY prompted_at ASC
       LIMIT 1`,
    )
    .get(sessionId, episodeId, after) as { prompted_at: number } | undefined;
  return row?.prompted_at ?? null;
}

export function markWorkEpisodeMerged(
  sessionId: string,
  episodeId: string,
  prUrl: string,
  now: number,
): boolean {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const session = d
      .prepare(
        `UPDATE session_work_episodes
         SET merged_at = COALESCE(merged_at, ?), updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    const binding = d
      .prepare(
        `UPDATE task_work_episode_bindings
         SET merged_at = COALESCE(merged_at, ?), updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    // The SAME stamp over the historical row, in this one transaction. A binding that
    // rolled to a new episode before the merge was seen keeps its provenance ONLY here -
    // the current binding was overwritten with the new episode, and session_work_episodes
    // followed it - so a by-URL merge observed for that old episode (Phase 2's harvest)
    // would land nowhere durable without this. `mergedAt` is COALESCEd so an id that
    // already recorded the merge is never restamped. No column check is needed:
    // `merged_at` has been in this table's CREATE block since it shipped (#167).
    const historical = d
      .prepare(
        `UPDATE historical_task_work_episode_bindings
         SET merged_at = COALESCE(merged_at, ?), updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND episode_id = ? AND pr_url = ?`,
      )
      .run(now, now, sessionId, episodeId, prUrl);
    if (ownsTransaction) d.exec("COMMIT");
    return (
      Number(session.changes) > 0 ||
      Number(binding.changes) > 0 ||
      Number(historical.changes) > 0
    );
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function invalidateTaskWorkEpisodeBindings(sessionId: string): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const taskIds = invalidateTaskOwnershipInTransaction(d, sessionId, Date.now());
    if (ownsTransaction) d.exec("COMMIT");
    return taskIds;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function deleteTask(id: string): void {
  const d = openDb();
  d.prepare(`DELETE FROM task_work_episode_bindings WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM historical_task_work_episode_bindings WHERE task_id = ?`).run(id);
  d.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
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
 * The most recent terminal tasks (done/failed/cancelled), so the roundup report's
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
 * Terminal tasks that still hold resources (a task awaiting reclaim, or a
 * failed-but-alive dispatch). Loaded regardless of the recent cap so their live
 * resources are always reconciled on start rather than orphaned once newer terminal
 * tasks push them past the cap.
 */
export function loadResourceHoldingTerminalTasks(): Task[] {
  const rows = openDb()
    .prepare(
       `SELECT * FROM tasks
       WHERE status IN ('done','failed','cancelled')
         AND (worktree_path IS NOT NULL OR home_name IS NOT NULL)`,
    )
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/**
 * Terminal tasks a merged pull request could still complete: `failed` or `cancelled`,
 * carrying a pull request on some work episode of theirs.
 *
 * The same argument as `loadResourceHoldingTerminalTasks` above, about a different kind of
 * loose end. That one keeps a task whose RESOURCES still need reconciling; this one keeps a
 * task whose OUTCOME does. A reclaimed `failed` row holds no worktree, so once fifty newer
 * terminal tasks exist it is not loaded at all - and then nothing polls the pull request it
 * left behind, nothing observes the merge, and it stays a `stopped` blocker over every
 * dependent for work that shipped. `running` and `dispatching` candidates need no query of
 * their own: `loadActiveTasks` already loads every one of them.
 *
 * Both binding tables, because a merge can land on an episode the task rolled past long
 * before anyone looked. `done` is excluded (its outcome is recorded) and so is `backlog`
 * (a rescheduled task is being re-run, so its previous attempt's pull request is not this
 * run's outcome) - the same rule `completableByMerge` states for the harvest itself.
 */
export function loadPrPendingTerminalTasks(): Task[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM tasks t
       WHERE t.status IN ('failed','cancelled')
         AND EXISTS (
           SELECT 1 FROM task_work_episode_bindings b
           WHERE b.task_id = t.id AND b.pr_url IS NOT NULL
           UNION ALL
           SELECT 1 FROM historical_task_work_episode_bindings h
           WHERE h.task_id = t.id AND h.pr_url IS NOT NULL
         )`,
    )
    .all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

/**
 * Does this task carry a pull request on any of its work episodes?
 *
 * What `pruneTerminalTasks` asks before dropping a terminal row from memory: a task with an
 * unresolved pull request is one the completion reconciler is still waiting on, so evicting
 * it would silently stop the polling that was going to settle it - undoing the load above
 * on the very next terminal task to arrive.
 */
export function taskHasPrCarryingBinding(taskId: string): boolean {
  const row = openDb()
    .prepare(
      `SELECT 1 AS present FROM task_work_episode_bindings
       WHERE task_id = ? AND pr_url IS NOT NULL
       UNION ALL
       SELECT 1 AS present FROM historical_task_work_episode_bindings
       WHERE task_id = ? AND pr_url IS NOT NULL
       LIMIT 1`,
    )
    .get(taskId, taskId) as { present: number } | undefined;
  return row !== undefined;
}

// ---- task sources: what has already been filed ----
//
// Read the `task_source_seen` CREATE TABLE above before touching any of this. The one
// rule: a seen row outlives the task it produced, so nothing here consults `tasks`.

/**
 * Every external id this source has already filed, as one set.
 *
 * Read whole rather than probed per candidate, for the reason `getSkillsAcks` is: it
 * keeps the dedupe in `ingest.ts` a pure decision over data the caller already holds,
 * with no I/O in the middle of the loop. One source's set is a handful of short strings
 * per item it has ever filed.
 */
export function seenExternalIds(sourceId: string): Set<string> {
  const rows = openDb()
    .prepare(`SELECT external_id FROM task_source_seen WHERE source_id = ?`)
    .all(sourceId) as unknown as Array<{ external_id: string }>;
  return new Set(rows.map((r) => r.external_id));
}

/** How many items this source has filed and will not file again - the panel's figure. */
export function countTaskSourceSeen(sourceId: string): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM task_source_seen WHERE source_id = ?`)
    .get(sourceId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Record that this source has filed this item.
 *
 * Upserts rather than inserts, so a re-file after "Forget seen items" cannot fail on a
 * row a concurrent sweep had already put back.
 */
export function recordTaskSourceSeen(
  sourceId: string,
  externalId: string,
  url: string | null,
  now = Date.now(),
): void {
  openDb()
    .prepare(
      `INSERT INTO task_source_seen (source_id, external_id, url, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET url=excluded.url, seen_at=excluded.seen_at`,
    )
    .run(sourceId, externalId, url, now);
}

/**
 * Forget everything one source has filed, so its items can be filed again. The
 * deliberate act that answers "a task you deleted stays deleted" - the only way back.
 *
 * Also what retires a source's rows when it is removed from the config: without that,
 * deleting and re-adding a source under the SAME id would file nothing at all, forever.
 */
export function forgetTaskSourceSeen(sourceId: string): number {
  const before = countTaskSourceSeen(sourceId);
  openDb().prepare(`DELETE FROM task_source_seen WHERE source_id = ?`).run(sourceId);
  return before;
}

/**
 * Run `fn` inside one SQLite transaction, rolling back if it throws.
 *
 * Written for ingest, where the seen row and the task row have to land together: a task
 * with no seen row is re-filed on every sweep forever, and a seen row with no task is an
 * item silently swallowed. Neither is fixed by retrying, so they are not allowed to
 * happen separately.
 */
export function inTransaction<T>(fn: () => T): T {
  const d = openDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    // Guarded like `reorderQueueItems`': if the BEGIN itself never took there is no
    // transaction to roll back, and an unguarded ROLLBACK throws over the original
    // error - which is the one the caller needs to see.
    try {
      d.exec("ROLLBACK");
    } catch {}
    throw err;
  }
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
  objective: string | null;
  prompt: string | null;
  focus: string | null;
  relationship: string | null;
  rationale: string | null;
  objective_version: number;
  prompt_revision: number;
  resolved_prompt_revision: number;
  pending_prompts: string;
  updated_at: number;
}

function pendingGoalPrompts(r: SessionGoalRow): SessionGoal["pendingPrompts"] {
  const promptRevision = r.prompt_revision || (r.prompt ? 1 : 0);
  const resolvedRevision =
    r.resolved_prompt_revision || (r.prompt && r.source === "model" ? 1 : 0);
  try {
    const parsed = JSON.parse(r.pending_prompts || "[]") as unknown;
    if (Array.isArray(parsed)) {
      const valid = parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const revision = (entry as { revision?: unknown }).revision;
        const prompt = (entry as { prompt?: unknown }).prompt;
        return Number.isInteger(revision) && Number(revision) > 0 &&
          (typeof prompt === "string" || prompt === null)
          ? [{ revision: Number(revision), prompt }]
          : [];
      });
      const unresolved = valid
        .filter((entry) => entry.revision > resolvedRevision && entry.revision <= promptRevision)
        .sort((a, b) => a.revision - b.revision)
        .filter((entry, index, entries) => index === 0 || entry.revision !== entries[index - 1]!.revision);
      if (unresolved.length > 0) return unresolved;
    }
  } catch {
    // Fall through to the conservative legacy reconstruction below.
  }

  if (promptRevision <= resolvedRevision) return [];
  if (promptRevision === resolvedRevision + 1) {
    return [{ revision: promptRevision, prompt: r.prompt }];
  }
  // Older builds retained only the latest prompt. The missing earlier instruction cannot be
  // reconstructed safely, so preserve an unresolved barrier instead of allowing the latest
  // prompt to mark the whole gap complete against a potentially stale objective.
  return [
    { revision: resolvedRevision + 1, prompt: null },
    ...(r.prompt ? [{ revision: promptRevision, prompt: r.prompt }] : []),
  ];
}

function rowToGoal(r: SessionGoalRow): SessionGoal {
  return {
    noteKey: r.note_key,
    text: r.text,
    // Narrowed, not cast blind: a row written by a newer build (or hand-edited) could carry
    // a source this build doesn't know, and typing it as one we do would put an unrenderable
    // value on a card. An unknown source reads as "no source", which the UI handles already.
    source: r.source === "heuristic" || r.source === "model" ? r.source : null,
    objective: r.objective ?? r.text ?? r.prompt,
    prompt: r.prompt,
    focus: r.focus,
    relationship:
      r.relationship === "initial" || r.relationship === "steer" ||
        r.relationship === "amend" || r.relationship === "replace" ||
        r.relationship === "unclear"
        ? r.relationship
        : null,
    rationale: r.rationale,
    objectiveVersion: r.objective_version || (r.text || r.prompt ? 1 : 0),
    promptRevision: r.prompt_revision || (r.prompt ? 1 : 0),
    resolvedPromptRevision:
      r.resolved_prompt_revision || (r.prompt && r.source === "model" ? 1 : 0),
    pendingPrompts: pendingGoalPrompts(r),
    updatedAt: r.updated_at,
  };
}

export function upsertSessionGoal(g: SessionGoal): void {
  openDb()
    .prepare(
      `INSERT INTO session_goals
         (note_key, text, source, objective, prompt, focus, relationship, rationale,
          objective_version, prompt_revision, resolved_prompt_revision, pending_prompts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         text=excluded.text, source=excluded.source, objective=excluded.objective,
         prompt=excluded.prompt, focus=excluded.focus, relationship=excluded.relationship,
         rationale=excluded.rationale, objective_version=excluded.objective_version,
         prompt_revision=excluded.prompt_revision,
         resolved_prompt_revision=excluded.resolved_prompt_revision,
         pending_prompts=excluded.pending_prompts,
         updated_at=excluded.updated_at`,
    )
    .run(
      g.noteKey, g.text, g.source, g.objective, g.prompt, g.focus, g.relationship,
      g.rationale, g.objectiveVersion, g.promptRevision, g.resolvedPromptRevision,
      JSON.stringify(g.pendingPrompts), g.updatedAt,
    );
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
 * `liveKeys` is `noteKeyFor` over the registry's live sessions.
 *
 * An EMPTY `liveKeys` means "liveness unknown", never "nothing is live", and so deletes
 * nothing. The distinction is the whole safety of the call: an empty set read as a fact turns
 * this into `WHERE updated_at < ?`, which is precisely the query the paragraph above says must
 * never run - and every caller is one await away from that state, because a daemon holds a
 * full goal table from `loadSessionGoals` before it has discovered a single session. Refusing
 * here costs one sweep on genuinely no sessions (there is nothing to strand anyway, and the
 * next hour retries); reading it as a fact costs a parked session its goal, permanently, since
 * only a new prompt rebuilds one.
 */
export function pruneSessionGoals(liveKeys: Iterable<string>, olderThan: number): number {
  const keys = [...new Set(liveKeys)];
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const r = openDb()
    .prepare(
      `DELETE FROM session_goals WHERE updated_at < ? AND note_key NOT IN (${placeholders})`,
    )
    .run(olderThan, ...keys);
  return Number(r.changes);
}

// ---- usage ledger (API-equivalent estimates and token usage) ----

/**
 * The columns an OTel datapoint may land in, keyed by the name the ingest uses.
 *
 * A WHITELIST, and the only reason `upsertUsageCell` can interpolate a column name into
 * SQL at all: the value is looked up here, never taken from the wire. A `type` attribute
 * the exporter invents tomorrow finds no entry and is dropped, which is the right answer
 * for a tier we cannot price into a column that does not exist.
 */
const USAGE_COLS = {
  costUsd: "cost_usd",
  input: "input",
  output: "output",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
} as const;
export type UsageCol = keyof typeof USAGE_COLS;

/** The identity of one export window, as the ingest resolves it. */
export interface UsageCell {
  noteKey: string;
  /** Provenance only - which live session we believed this key belonged to. */
  sessionId: string | null;
  agent: string;
  /** Empty string when the datapoint carried no such attribute; never null. See the table. */
  modelId: string;
  querySource: string;
  /** The datapoint's dedup identity, as text. Never parsed as a JS number. */
  windowEndNs: string;
  /** Window end in epoch ms, derived with BigInt division. */
  ts: number;
}

/**
 * Record one metric's value for one export window.
 *
 * REPLACE on conflict, never SUM, and the direction is the whole point. OTel delta
 * datapoints carry a unique `(start, end)` window, so a retried or duplicated POST
 * arrives with the same `window_end_ns` and overwrites the row with an identical value -
 * it cannot double-count. An additive upsert would double-count on exactly that retry,
 * which is the failure this is here to make impossible. The cumulative total is `SUM`
 * over rows at read time.
 *
 * One COLUMN at a time, because `cost.usage` and `token.usage` are separate metrics
 * sharing one window: each datapoint updates only its own column, which makes the writes
 * order-independent and lets a partial export (cost arrived, tokens didn't) still be
 * correct for what it carried.
 *
 * `ts` is also refreshed, so a cumulative series - whose rows are replaced rather than
 * accumulated - still reports the freshness of its LATEST export rather than of its first.
 */
export function upsertUsageCell(k: UsageCell, col: UsageCol, value: number): void {
  const c = USAGE_COLS[col];
  if (!c) throw new Error(`refusing to write an unknown usage column: ${String(col)}`);
  openDb()
    .prepare(
      `INSERT INTO usage_ledger
         (note_key, session_id, agent, model_id, query_source, window_end_ns, ts, ${c})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key, model_id, query_source, window_end_ns)
         DO UPDATE SET ${c} = excluded.${c},
                       ts = MAX(usage_ledger.ts, excluded.ts),
                       session_id = COALESCE(excluded.session_id, usage_ledger.session_id)`,
    )
    .run(k.noteKey, k.sessionId, k.agent, k.modelId, k.querySource, k.windowEndNs, k.ts, value);
}

export interface UsageSourceCursor {
  offset: number;
  modelId: string | null;
  discardPartial: boolean;
  fileId: string | null;
}

export interface DurableUsageEvent {
  identity: string;
  ts: number;
  modelId: string | null;
  querySource: string;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
  pricingVersion: string;
}

/** Last committed byte position for a harness-owned usage stream. */
export function usageCursorFor(sourceKey: string): UsageSourceCursor {
  const row = openDb()
    .prepare(`SELECT offset, model_id, discard_partial, file_id FROM usage_sources WHERE source_key = ?`)
    .get(sourceKey) as { offset: number; model_id: string; discard_partial: number; file_id: string } | undefined;
  return row
    ? {
      offset: row.offset,
      modelId: row.model_id || null,
      discardPartial: row.discard_partial === 1,
      fileId: row.file_id || null,
    }
    : { offset: 0, modelId: null, discardPartial: false, fileId: null };
}

/** Keep an observed source's cursor alive without changing its committed byte position. */
export function touchUsageSource(sourceKey: string, observedAt: number): boolean {
  return openDb()
    .prepare(`UPDATE usage_sources SET updated_at = ? WHERE source_key = ?`)
    .run(observedAt, sourceKey).changes > 0;
}

/**
 * Commit request events and their new cursor atomically.
 *
 * Event identity is immutable economic history: a replay may fill missing live-session
 * provenance, but never recalculates tokens or dollars with a newer price snapshot.
 */
export function commitUsageRead(input: {
  sourceKey: string;
  noteKey: string;
  sessionId: string | null;
  agent: string;
  cursor: UsageSourceCursor;
  events: DurableUsageEvent[];
  updatedAt: number;
}): void {
  const d = openDb();
  const insert = d.prepare(
    `INSERT INTO usage_ledger
       (note_key, session_id, agent, model_id, query_source, window_end_ns, ts,
        cost_usd, cost_basis, cost_known, pricing_version, input, output,
        reasoning_output, cache_read, cache_write)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_key, model_id, query_source, window_end_ns)
       DO UPDATE SET session_id = COALESCE(usage_ledger.session_id, excluded.session_id)`,
  );
  try {
    d.exec("BEGIN IMMEDIATE;");
    for (const event of input.events) {
      insert.run(
        input.noteKey,
        input.sessionId,
        input.agent,
        event.modelId ?? "",
        event.querySource,
        event.identity,
        event.ts,
        event.costUsd ?? 0,
        event.costUsd === null ? "unpriced" : "api-equivalent",
        event.costUsd === null ? 0 : 1,
        event.pricingVersion,
        event.input,
        event.output,
        event.reasoningOutput,
        event.cacheRead,
        event.cacheWrite,
      );
    }
    d.prepare(
      `INSERT INTO usage_sources
         (source_key, agent, offset, model_id, discard_partial, file_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET
         offset = excluded.offset,
         model_id = excluded.model_id,
         discard_partial = excluded.discard_partial,
         file_id = excluded.file_id,
         updated_at = excluded.updated_at`,
    ).run(
      input.sourceKey,
      input.agent,
      input.cursor.offset,
      input.cursor.modelId ?? "",
      input.cursor.discardPartial ? 1 : 0,
      input.cursor.fileId ?? "",
      input.updatedAt,
    );
    d.exec("COMMIT;");
  } catch (err) {
    try { d.exec("ROLLBACK;"); } catch {}
    throw err;
  }
}

/** One model's usage from a headless run, already valued by its runner. */
export interface AutomationUsageRow {
  modelId: string;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  /** Null when the runner declined to value it; stored as cost_known = 0. */
  costUsd: number | null;
  basis: string;
  pricingVersion: string;
}

/**
 * Record one finished headless run: a row per model, keyed to the ROLE that spent it.
 *
 * `note_key` is the role rather than a session, which is the whole point - these runs have
 * no card, and until they had a key of their own their spend was either absent from the
 * ledger (Codex, which exports nothing from an ephemeral run) or present under a uuid
 * belonging to nothing (Claude, whose headless runs still export OTel under a fresh session
 * id). Either way it was unanswerable. A stable key per role makes "what does the Inspector
 * cost" a query.
 *
 * `session_id` is NULL by construction. The column is provenance - which live card we
 * believed the key belonged to - and asserting one here would be inventing the very link
 * this whole path exists because it does not exist.
 *
 * ON CONFLICT DO NOTHING, unlike `upsertUsageCell`'s replace and `commitUsageRead`'s
 * provenance fill. The conflict target is (note_key, model_id, query_source, window_end_ns)
 * and `window_end_ns` holds the RUN's own id, so a conflict means precisely "this exact run
 * was already recorded" - which happens when the Foreman worker retries a POST it never saw
 * the response to. The row is immutable economic history and the retry carries identical
 * numbers, so the correct action is to keep the first and add nothing.
 */
export function recordAutomationUsage(input: {
  role: string;
  agent: string;
  runId: string;
  ts: number;
  models: AutomationUsageRow[];
}): void {
  const d = openDb();
  const insert = d.prepare(
    `INSERT INTO usage_ledger
       (note_key, session_id, agent, model_id, query_source, window_end_ns, ts,
        cost_usd, cost_basis, cost_known, pricing_version, input, output,
        reasoning_output, cache_read, cache_write, spend_kind)
     VALUES (?, NULL, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'automation')
     ON CONFLICT(note_key, model_id, query_source, window_end_ns) DO NOTHING`,
  );
  try {
    d.exec("BEGIN IMMEDIATE;");
    for (const m of input.models) {
      insert.run(
        input.role,
        input.agent,
        m.modelId,
        input.runId,
        input.ts,
        m.costUsd ?? 0,
        m.costUsd === null ? "unpriced" : m.basis,
        m.costUsd === null ? 0 : 1,
        m.pricingVersion,
        m.input,
        m.output,
        m.reasoningOutput,
        m.cacheRead,
        m.cacheWrite,
      );
    }
    d.exec("COMMIT;");
  } catch (err) {
    try { d.exec("ROLLBACK;"); } catch {}
    throw err;
  }
}

/**
 * The SQL predicate for "this row is a card's spend, not the app's own".
 *
 * Two clauses, and the second is the subtle one. Excluding automation rows is obvious. The
 * subquery excludes their TWINS: a headless `claude -p` run is Claude Code, so it exports
 * OTel exactly as a human's session does, under the fresh session id it minted for itself.
 * Those datapoints arrive with a real `session.id`, so `applyOtelMetrics` accepts them - as
 * it should, it cannot tell - and they land as ordinary session rows under a note key that
 * matches no card and never will. They were being counted as fleet session spend before
 * this existed; now that the same run is recorded properly under its role, counting them
 * too would bill it twice.
 *
 * Matching on `window_end_ns` is what makes this exact rather than a heuristic: an
 * automation row stores the run's own id there, and that id IS the note key its OTel twin
 * arrived under. No prefix guessing, no timing assumption - the twin can arrive before or
 * after the report, since this is resolved at read time.
 *
 * `sessionCostFor` applies the first clause only. A card cannot hold a role as its note key,
 * so the filter is belt-and-braces rather than load-bearing - but it makes "automation
 * spend never appears on a card" a property of the query instead of a property of what
 * callers happen to pass. The twin subquery is deliberately NOT added there: that is a
 * per-card read on a hot path, and a twin's note key is a uuid no session ever holds.
 */
const SESSION_SPEND_ONLY =
  `spend_kind = 'session'
     AND note_key NOT IN (SELECT window_end_ns FROM usage_ledger WHERE spend_kind = 'automation')`;

/** One role's headless spend over a window. */
export interface AutomationRoleSpend {
  role: string;
  costUsd: number | null;
  tokens: number;
  runs: number;
}

/**
 * What each role spent since `tsMs`, newest-heaviest first.
 *
 * Grouped by role rather than returned as one figure because the roles are the answerable
 * unit: "the loops cost $9 today" prompts no action, while "Foreman verify cost $6 of it"
 * points at the 106 KB prompt that did it. `runs` counts DISTINCT run ids rather than rows,
 * since a run that used two models writes two.
 *
 * Cost is null for a role whose window contains an unpriced row, on exactly the rule
 * `fleetEstimatedCostSince` uses: a subtotal of the priced rows would read as a total.
 */
export function automationSpendSince(tsMs: number): AutomationRoleSpend[] {
  const rows = openDb()
    .prepare(
      `SELECT note_key AS role,
              SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) AS cost,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS unknown,
              SUM(input + output + cache_read + cache_write) AS tokens,
              COUNT(DISTINCT window_end_ns) AS runs
         FROM usage_ledger
        WHERE spend_kind = 'automation' AND ts >= ?
        GROUP BY note_key
        ORDER BY cost DESC, tokens DESC`,
    )
    .all(tsMs) as unknown as Array<{
      role: string; cost: number | null; unknown: number | null; tokens: number | null; runs: number;
    }>;
  return rows.map((r) => ({
    role: r.role,
    costUsd: (r.unknown ?? 0) > 0 ? null : (r.cost ?? 0),
    tokens: r.tokens ?? 0,
    runs: r.runs,
  }));
}

/**
 * One session's estimated API-equivalent cost, or null when the ledger has never heard
 * of its key.
 *
 * Null rather than a zeroed summary, deliberately: "we have not been told" and "it cost
 * nothing" are different claims, and only the first is ever true of a session with no
 * rows. A card that showed `$0.00` for an untracked session would be asserting the one
 * of the two that is false.
 *
 * The per-field `?? 0` is the same defence `episodesFor`'s row mapper takes: these rows
 * outlive the daemon that wrote them, so a column added later reads as absent on an old
 * row rather than as `undefined` arriving on the wire.
 */
export function sessionCostFor(noteKey: string): SessionCost | null {
  const rows = openDb()
    .prepare(
      `SELECT cost_basis, cost_known, cost_usd, input, output, reasoning_output,
              cache_read, cache_write, model_id, pricing_version, ts
         FROM usage_ledger WHERE note_key = ? AND spend_kind = 'session'`,
    )
    .all(noteKey) as unknown as Array<{
      cost_basis: string; cost_known: number; cost_usd: number; input: number; output: number;
      reasoning_output: number; cache_read: number; cache_write: number; model_id: string;
      pricing_version: string; ts: number;
    }>;
  if (!rows.length) return null;
  const bases = new Set(rows.map((r) => r.cost_basis));
  const mixed = bases.size !== 1;
  const rawBasis = mixed ? "unpriced" : rows[0]!.cost_basis;
  const basis: CostBasis = rawBasis === "reported" || rawBasis === "api-equivalent"
    ? rawBasis
    : "unpriced";
  const known = !mixed && rows.every((r) => r.cost_known === 1);
  return {
    costUsd: known ? rows.reduce((n, r) => n + r.cost_usd, 0) : null,
    basis: known ? basis : "unpriced",
    pricingModels: [...new Set(rows.map((r) => r.model_id).filter(Boolean))].sort(),
    pricingVersions: [...new Set(rows.map((r) => r.pricing_version).filter(Boolean))].sort(),
    input: rows.reduce((n, r) => n + r.input, 0),
    output: rows.reduce((n, r) => n + r.output, 0),
    reasoningOutput: rows.reduce((n, r) => n + r.reasoning_output, 0),
    cacheRead: rows.reduce((n, r) => n + r.cache_read, 0),
    cacheWrite: rows.reduce((n, r) => n + r.cache_write, 0),
    updatedAt: Math.max(...rows.map((r) => r.ts)),
  };
}

/**
 * Fleet-wide API-equivalent estimate since `tsMs`, regardless of who calculated it.
 *
 * Null when even one row is unpriced: returning the sum of known rows would present a
 * partial subtotal as the fleet's total. Zero remains the truthful answer for no rows.
 *
 * SESSION spend only. The autonomous loops' own runs are reported separately by
 * `automationSpendSince` and deliberately not folded in here: session cost is work an
 * operator asked for, and the loops are overhead they did not. Adding the two into one
 * headline would make the number that answers "what is my fleet costing me" move when
 * nobody asked for anything, and there would be no way to see which half had moved.
 */
export function fleetEstimatedCostSince(tsMs: number): number | null {
  const r = openDb()
    .prepare(
      `SELECT SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) c,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) unknown
         FROM usage_ledger WHERE ts >= ? AND ${SESSION_SPEND_ONLY}`,
    )
    .get(tsMs) as { c: number | null; unknown: number | null } | undefined;
  if ((r?.unknown ?? 0) > 0) return null;
  return r?.c ?? 0;
}

/**
 * The same estimate over automation rows, as one figure for the strip's headline.
 *
 * Separate from the per-role breakdown because the strip asks a different question of it -
 * one number beside the fleet's - and because summing the breakdown in TypeScript would
 * have to re-derive the unpriced rule, which is the sort of duplication that eventually
 * disagrees.
 */
export function automationEstimatedCostSince(tsMs: number): number | null {
  const r = openDb()
    .prepare(
      `SELECT SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) c,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) unknown
         FROM usage_ledger WHERE ts >= ? AND spend_kind = 'automation'`,
    )
    .get(tsMs) as { c: number | null; unknown: number | null } | undefined;
  if ((r?.unknown ?? 0) > 0) return null;
  return r?.c ?? 0;
}

/** Automation tokens since `tsMs`, every tier summed. The token twin of the figure above. */
export function automationTokensSince(tsMs: number): number {
  const r = openDb()
    .prepare(
      `SELECT SUM(input + output + cache_read + cache_write) t
         FROM usage_ledger WHERE ts >= ? AND spend_kind = 'automation'`,
    )
    .get(tsMs) as { t: number | null } | undefined;
  return r?.t ?? 0;
}

/**
 * Fleet-wide tokens since `tsMs`, every tier summed.
 *
 * A separate query from `fleetEstimatedCostSince` rather than one row carrying both, because the
 * two are asked at different times: cost is also read per session, and the strip is the
 * only caller that wants tokens. Two indexed scans of the same rows cost less than the
 * coupling.
 */
export function fleetTokensSince(tsMs: number): number {
  const r = openDb()
    .prepare(
      `SELECT SUM(input + output + cache_read + cache_write) t
         FROM usage_ledger WHERE ts >= ? AND ${SESSION_SPEND_ONLY}`,
    )
    .get(tsMs) as { t: number | null } | undefined;
  return r?.t ?? 0;
}

/**
 * How many pull requests we PROVED we opened since `tsMs`.
 *
 * `adopted_at` is the right column and the only one: a row exists here because a hook
 * caught the `gh pr create` or a no-mistakes run reported its own `pr:` line, which is
 * exactly the provenance rule the Inspector posts under. Counting `inspector_prs` rows by
 * any other date - or counting `prUrl` off live sessions - would fold in pull requests we
 * merely stood next to.
 */
export function prsOpenedSince(tsMs: number): number {
  const r = openDb()
    .prepare(`SELECT COUNT(*) n FROM inspector_prs WHERE adopted_at >= ?`)
    .get(tsMs) as { n: number } | undefined;
  return r?.n ?? 0;
}

/** True when the ledger holds any reported or locally-derived usage row. */
export function usageLedgerHasRows(): boolean {
  const r = openDb().prepare(`SELECT 1 AS x FROM usage_ledger LIMIT 1`).get() as
    | { x: number }
    | undefined;
  return Boolean(r);
}

/** True only after Claude's reported session telemetry has arrived; Codex rows are automatic. */
export function reportedUsageLedgerHasRows(): boolean {
  const r = openDb()
    .prepare(
      `SELECT 1 AS x FROM usage_ledger
        WHERE cost_basis = 'reported' AND spend_kind = 'session' LIMIT 1`,
    )
    .get() as { x: number } | undefined;
  return Boolean(r);
}

/**
 * Age out ledger rows. Returns how many went.
 *
 * Pruned by AGE and nothing else, on the `pruneGateReplies` precedent and for the same
 * reason: these are keyed to a session that will be long gone, and the record becomes
 * interesting PRECISELY once it is - "what did last week cost?" is a question you ask
 * about finished work. Session-scoped pruning would delete the answer at the moment it
 * started to matter.
 */
export function pruneUsageLedger(cutoff: number): number {
  return Number(openDb().prepare(`DELETE FROM usage_ledger WHERE ts < ?`).run(cutoff).changes);
}

/** Cursor retention is independent of event retention and deliberately age-only. */
export function pruneUsageSources(cutoff: number): number {
  return Number(openDb().prepare(`DELETE FROM usage_sources WHERE updated_at < ?`).run(cutoff).changes);
}

// ---- Foreman session work queues ----

interface QueueRow {
  note_key: string;
  cwd: string | null;
  branch: string | null;
  wrapup_asked_at: number | null;
  wrapup_answer: string | null;
  prompted_goal: string | null;
  updated_at: number;
}

/**
 * One row -> object mapping, for the four readers that need it.
 *
 * Spelled once because it was spelled four times, and a column added to the table
 * reached whichever copies its author happened to grep: a `prompted_goal` missing
 * from `listQueueRows` alone would leave the orphan sweep reading every queue as
 * never-wrapped-up, which is the state that FIRES the trigger.
 */
function toQueueRow(r: QueueRow): Omit<SessionQueue, "items"> {
  return {
    noteKey: r.note_key,
    cwd: r.cwd,
    branch: r.branch,
    wrapupAskedAt: r.wrapup_asked_at,
    wrapupAnswer: r.wrapup_answer,
    promptedGoal: r.prompted_goal,
    updatedAt: r.updated_at,
  };
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
      `INSERT INTO foreman_queues
         (note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET
         cwd=excluded.cwd, branch=excluded.branch, wrapup_asked_at=excluded.wrapup_asked_at,
         wrapup_answer=excluded.wrapup_answer, prompted_goal=excluded.prompted_goal,
         updated_at=excluded.updated_at`,
    )
    .run(q.noteKey, q.cwd, q.branch, q.wrapupAskedAt, q.wrapupAnswer, q.promptedGoal, q.updatedAt);
}

export function getQueueRow(noteKey: string): Omit<SessionQueue, "items"> | undefined {
  const r = openDb().prepare(`SELECT * FROM foreman_queues WHERE note_key = ?`).get(noteKey) as
    | unknown as QueueRow | undefined;
  return r ? toQueueRow(r) : undefined;
}

/** Every stored queue (without items) - for the orphan sweep + the session list. */
export function listQueueRows(): Omit<SessionQueue, "items">[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queues ORDER BY updated_at DESC`)
    .all() as unknown as QueueRow[];
  return rows.map(toQueueRow);
}

/** Queues recorded at one cwd - the re-attach hint's question, asked as a lookup. */
export function listQueueRowsForCwd(cwd: string): Omit<SessionQueue, "items">[] {
  const rows = openDb()
    .prepare(`SELECT * FROM foreman_queues WHERE cwd = ? ORDER BY updated_at DESC`)
    .all(cwd) as unknown as QueueRow[];
  return rows.map(toQueueRow);
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
 *
 * The second branch collects rows that hold NOTHING - no items at all, and none of the
 * three wrap-up fields set - regardless of age. `ensureQueue` mints a row for any
 * session whose wrap-up state is merely touched, and the `prompted` trigger touches
 * every session it ever considers, so this is now the common shape of a row rather than
 * a rarity. Waiting out `cutoff` for a row with nothing in it buys no safety: there is
 * no backlog to resume, no ask to answer and no episode to keep retired, and if the
 * session comes back `ensureQueue` mints it again for free. The `liveKeys` guard still
 * applies to both branches, which is what keeps this away from the row a live session is
 * mid-write on - `ensureQueue` and the `promptedGoal` stamp that follows it are two
 * writes, and between them the row is legitimately empty.
 */
export function pruneDeadQueues(liveKeys: Set<string>, cutoff: number): number {
  const db = openDb();
  const states = TERMINAL_ITEM_STATES.map((s) => `'${s}'`).join(",");
  const dead = db
    .prepare(
      `SELECT note_key FROM foreman_queues q
        WHERE (
                q.updated_at < ?
                AND NOT EXISTS (
                  SELECT 1 FROM foreman_queue_items i
                   WHERE i.note_key = q.note_key AND i.state NOT IN (${states})
                )
              )
           OR (
                q.wrapup_asked_at IS NULL
                AND q.wrapup_answer IS NULL
                AND q.prompted_goal IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM foreman_queue_items i WHERE i.note_key = q.note_key
                )
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
 * Clear a whole queue on demand - every item AND the row - in ONE transaction.
 *
 * The bulk clear a session RESET needs, and deliberately unlike its two neighbours:
 * `deleteQueue` drops only the row, and `pruneDeadQueues` only ever collects a queue
 * whose session is already gone AND whose items are all terminal. This drops OPEN and
 * even IN-FLIGHT items too, because a reset is the explicit "discard this task" action
 * - the branch the items targeted is gone and the agent's context is /cleared, so
 * there is nothing left to run them against. (A bare /clear is the opposite case: its
 * backlog survives, orphaned, for the re-attach affordance.)
 *
 * All-or-nothing, like `pruneDeadQueues`: a row outliving its items is a card claiming
 * a batch it can't show, and items outliving their row are invisible to every reader
 * here (all of which start from the row). Returns true when anything was cleared.
 */
export function clearQueue(noteKey: string): boolean {
  const db = openDb();
  db.exec("BEGIN");
  try {
    const items = db.prepare(`DELETE FROM foreman_queue_items WHERE note_key = ?`).run(noteKey);
    const queue = db.prepare(`DELETE FROM foreman_queues WHERE note_key = ?`).run(noteKey);
    db.exec("COMMIT");
    return Number(items.changes) + Number(queue.changes) > 0;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
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

// ---- skills acks (which generation each session has been told about) ----

/**
 * Every session's acked generation, as one map.
 *
 * Read whole rather than per-session because the reload loop's selector is a pure
 * function over the sessions and wants no I/O inside it - the same discipline
 * `decideQueueTick` holds. The table is one row per session ever seen, integers
 * only, so reading it on a 1.5s tick is noise.
 */
export function getSkillsAcks(): Map<string, number> {
  const rows = openDb().prepare(`SELECT note_key, generation FROM skills_acks`).all() as unknown as
    Array<{ note_key: string; generation: number }>;
  return new Map(rows.map((r) => [r.note_key, r.generation]));
}

/**
 * Record that a session has been told about `generation`.
 *
 * Also the ROLLBACK: pass the prior value to undo an ack written before a delivery
 * that turned out never to reach the pane. Absent and 0 are the same fact ("never
 * acked"), because generation 0 means the symlink set has never changed and so
 * nothing is owed to anybody.
 */
export function setSkillsAck(noteKey: string, generation: number, now = Date.now()): void {
  openDb()
    .prepare(
      `INSERT INTO skills_acks (note_key, generation, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(note_key) DO UPDATE SET generation=excluded.generation, updated_at=excluded.updated_at`,
    )
    .run(noteKey, generation, now);
}

export function setAppConfig(key: string, value: unknown): void {
  openDb()
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

// ---- Inspector: the adoption + provenance ledgers ----
//
// Everything below is read and written ONLY by the Inspector (daemon-side). The two
// tables answer the two questions that make automated PR review safe to run at all:
// "is this PR ours to comment on?" and "is this comment ours to resolve?".

interface InspectorPrRow {
  key: string;
  url: string;
  owner: string;
  repo: string;
  number: number;
  repo_root: string | null;
  cwd: string | null;
  session_id: string | null;
  source: string;
  state: string;
  head_sha: string | null;
  review_posture: string | null;
  round: number;
  last_reviewed_at: number | null;
  last_error: string | null;
  fail_count: number;
  last_fail_kind: string | null;
  next_attempt_at: number | null;
  last_attempt_sha: string | null;
  merged_at: number | null;
  merge_block: string | null;
  adopted_at: number;
  updated_at: number;
}

function rowToInspectorPr(r: InspectorPrRow): InspectorPr {
  return {
    key: r.key,
    url: r.url,
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    repoRoot: r.repo_root,
    cwd: r.cwd,
    sessionId: r.session_id,
    source: r.source as InspectorSource,
    state: r.state as InspectorPrState,
    headSha: r.head_sha,
    reviewPosture: (r.review_posture as InspectorPr["reviewPosture"]) ?? null,
    round: r.round,
    lastReviewedAt: r.last_reviewed_at,
    lastError: r.last_error,
    failCount: r.fail_count,
    lastFailKind: (r.last_fail_kind as InspectorFailKind | null) ?? null,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptSha: r.last_attempt_sha,
    mergedAt: r.merged_at,
    mergeBlock: r.merge_block,
    adoptedAt: r.adopted_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Adopt a PR for review, idempotently. Returns true when this call is what adopted it.
 *
 * `DO NOTHING` rather than an upsert, and that is the whole design of the function:
 * adoption is a fact about the past ("we opened this"), so a later sighting must never
 * be able to rewrite it. Both signals - the hook's `gh pr create` and no-mistakes' own
 * `pr:` line - land here, and the second one to arrive is a no-op instead of a
 * re-adoption that would reset the head sha and re-review a PR from scratch.
 */
export function adoptInspectorPr(pr: InspectorPr): boolean {
  const res = openDb()
    .prepare(
      `INSERT INTO inspector_prs
         (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
          head_sha, review_posture, round, last_reviewed_at, last_error, fail_count, last_fail_kind,
          next_attempt_at, last_attempt_sha, merged_at, merge_block, adopted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(
      pr.key,
      pr.url,
      pr.owner,
      pr.repo,
      pr.number,
      pr.repoRoot,
      pr.cwd,
      pr.sessionId,
      pr.source,
      pr.state,
      pr.headSha,
      pr.reviewPosture,
      pr.round,
      pr.lastReviewedAt,
      pr.lastError,
      pr.failCount,
      pr.lastFailKind,
      pr.nextAttemptAt,
      pr.lastAttemptSha,
      pr.mergedAt,
      pr.mergeBlock,
      pr.adoptedAt,
      pr.updatedAt,
    );
  return Number(res.changes) > 0;
}

/**
 * Refresh the mutable half of a ledger row after a tick.
 *
 * `cwd` and `repo_root` are deliberately NOT writable here. They record where the PR was
 * opened from, which is a fact about the past; the worktree behind `cwd` gets reaped and
 * pooled worktrees get reused, so the value is only ever a hint. Resolving a directory
 * that still exists is the tick's job, once per pass, and it falls back to `repo_root`
 * because git's common dir outlives any worktree of the repo - see `liveDir` in
 * `inspector/worker.ts`. Identity columns (key/owner/repo/number/source/adopted_at) are
 * untouched by construction.
 */
export function updateInspectorPr(
  key: string,
  patch: {
    state?: InspectorPrState;
    headSha?: string | null;
    reviewPosture?: InspectorPr["reviewPosture"];
    round?: number;
    lastReviewedAt?: number | null;
    lastError?: string | null;
    failCount?: number;
    lastFailKind?: InspectorFailKind | null;
    nextAttemptAt?: number | null;
    lastAttemptSha?: string | null;
    mergedAt?: number | null;
    mergeBlock?: string | null;
  },
  now: number,
): void {
  const cur = getInspectorPr(key);
  if (!cur) return;
  const next = { ...cur, ...patch };
  openDb()
    .prepare(
      `UPDATE inspector_prs
          SET state = ?, head_sha = ?, review_posture = ?, round = ?,
              last_reviewed_at = ?, last_error = ?, fail_count = ?, last_fail_kind = ?,
              next_attempt_at = ?, last_attempt_sha = ?,
              merged_at = ?, merge_block = ?, updated_at = ?
        WHERE key = ?`,
    )
    .run(
      next.state,
      next.headSha,
      next.reviewPosture,
      next.round,
      next.lastReviewedAt,
      next.lastError,
      next.failCount,
      next.lastFailKind,
      next.nextAttemptAt,
      next.lastAttemptSha,
      next.mergedAt,
      next.mergeBlock,
      now,
      key,
    );
}

export function getInspectorPr(key: string): InspectorPr | null {
  const r = openDb().prepare(`SELECT * FROM inspector_prs WHERE key = ?`).get(key) as
    | InspectorPrRow
    | undefined;
  return r ? rowToInspectorPr(r) : null;
}

/** Every PR still worth polling - what the tick iterates. */
export function loadOpenInspectorPrs(): InspectorPr[] {
  const rows = openDb()
    .prepare(`SELECT * FROM inspector_prs WHERE state = 'open' ORDER BY adopted_at ASC`)
    .all() as unknown as InspectorPrRow[];
  return rows.map(rowToInspectorPr);
}

interface InspectorCommentRow {
  id: string;
  pr_key: string;
  fingerprint: string;
  path: string | null;
  line: number | null;
  title: string;
  body: string | null;
  severity: string;
  round: number;
  status: string;
  replies: number;
  answered_comment_id: number | null;
  created_at: number;
  updated_at: number;
}

function rowToInspectorComment(r: InspectorCommentRow): InspectorComment {
  return {
    id: r.id,
    prKey: r.pr_key,
    fingerprint: r.fingerprint,
    path: r.path,
    line: r.line,
    title: r.title,
    body: r.body,
    severity: r.severity as InspectorSeverity,
    round: r.round,
    status: r.status as InspectorCommentStatus,
    replies: r.replies,
    answeredCommentId: r.answered_comment_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Record (or re-record) one issue on one PR.
 *
 * The conflict target is `(pr_key, fingerprint)` - the ISSUE's identity - so a finding
 * the reviewer raises again in a later round updates its row instead of minting a
 * second one. That is also what lets a resolved-then-regressed issue come back: the
 * row flips out of `resolved` and gets a fresh comment id, rather than being blocked
 * by a primary key it can't reuse.
 */
export function upsertInspectorComment(c: InspectorComment): void {
  openDb()
    .prepare(
      `INSERT INTO inspector_comments
         (id, pr_key, fingerprint, path, line, title, body, severity,
          round, status, replies, answered_comment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr_key, fingerprint) DO UPDATE SET
         path = excluded.path,
         line = excluded.line,
         title = excluded.title,
         body = excluded.body,
         severity = excluded.severity,
         round = excluded.round,
         status = excluded.status,
         replies = excluded.replies,
         answered_comment_id = excluded.answered_comment_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      c.id,
      c.prKey,
      c.fingerprint,
      c.path,
      c.line,
      c.title,
      c.body,
      c.severity,
      c.round,
      c.status,
      c.replies,
      c.answeredCommentId,
      c.createdAt,
      c.updatedAt,
    );
}

export function loadInspectorComments(prKey: string): InspectorComment[] {
  const rows = openDb()
    .prepare(`SELECT * FROM inspector_comments WHERE pr_key = ? ORDER BY created_at ASC`)
    .all(prKey) as unknown as InspectorCommentRow[];
  return rows.map(rowToInspectorComment);
}

/**
 * Every ledger row with its finding tallies - the settings panel's list, and what the
 * per-session chip is derived from.
 *
 * One grouped query rather than a load-then-count-per-row loop: this runs on the
 * daemon's single synchronous SQLite handle, the same one serving hook ingest and SSE,
 * and the panel polls it.
 *
 * `limit` is OPTIONAL, and the default is "all of them", because the two callers want
 * different things. The settings panel is a display and wants the recent slice; the
 * registry builds the per-session chip out of this and must not be truncated - rows are
 * never deleted, so a cap would eventually drop live PRs off the bottom, and an absent
 * chip is documented in three places as meaning "that PR came from somewhere else".
 */
export function loadInspectorInspections(limit?: number): InspectorInspection[] {
  const rows = openDb()
    .prepare(
      `SELECT p.*,
              COALESCE(SUM(CASE WHEN c.status IN ('open','drafted','posting') THEN 1 ELSE 0 END), 0) AS open_findings,
              COALESCE(SUM(CASE WHEN c.status = 'open' THEN 1 ELSE 0 END), 0) AS posted_open_findings,
              COALESCE(SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved_findings
         FROM inspector_prs p
         LEFT JOIN inspector_comments c ON c.pr_key = p.key
        GROUP BY p.key
        ORDER BY COALESCE(p.last_reviewed_at, p.adopted_at) DESC
        LIMIT ?`,
    )
    .all(limit ?? -1) as unknown as (InspectorPrRow & {
    open_findings: number;
    posted_open_findings: number;
    resolved_findings: number;
  })[];
  return rows.map((r) => ({
    ...rowToInspectorPr(r),
    openFindings: Number(r.open_findings),
    postedOpenFindings: Number(r.posted_open_findings),
    resolvedFindings: Number(r.resolved_findings),
  }));
}
