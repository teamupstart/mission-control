import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, envVar } from "./config.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import type {
  EpisodeAuthor,
  ForemanEpisode,
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
      model         TEXT,
      effort        TEXT,
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
      completed_at          INTEGER
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
      delivered_at   INTEGER
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

  // `prompted_goal`: the session goal the `prompted` wrap-up trigger last fired on -
  // its once-per-episode guard, and what re-arms it when a genuinely new prompt lands.
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

  // `inspector_comments(pr_key)` is the leftmost prefix of the unique index on
  // (pr_key, fingerprint), so it can serve no query that one cannot. Dropped rather
  // than merely removed from the CREATE, or a db created before this build keeps
  // paying for it forever. `comment_id` / `thread_id` are left where they are: SQLite
  // column drops are the expensive kind of migration, the columns are nullable, and
  // every INSERT names its columns, so a leftover one is inert.
  d.exec(`DROP INDEX IF EXISTS idx_inspector_comments_pr;`);

  // Goals need no migration: `session_goals` is a NEW table, and CREATE TABLE IF NOT EXISTS
  // creates it on an upgraded db exactly as on a fresh one. An existing install simply has no
  // goals until its sessions take their next prompt, which is the truthful answer for a
  // session whose prompts were all seen before goals existed. (This is the payoff of a
  // separate table over columns on `session_notes`: no ALTER, and no row written before
  // this build that has to be reasoned about.)
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
          purpose, brief, recommendation, classification, confidence, tier, disposition,
          last_action, sent_text, sent_option, sent_by, created_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

/** Every episode recorded for one session key, newest first. */
export function episodesFor(noteKey: string, limit = 100): ForemanEpisode[] {
  const rows = openDb()
    .prepare(
      `SELECT id, note_key, session_id, marker, situation, surface, question, pane, menu,
              review_id, purpose, brief, recommendation, classification, confidence, tier,
              disposition, last_action, sent_text, sent_option, sent_by, created_at,
              resolved_at, resolved_by
         FROM foreman_episodes WHERE note_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(noteKey, limit) as unknown as Array<Record<string, unknown>>;
  return rows.map(
    (r): ForemanEpisode => ({
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
      disposition: episodeDisposition(r.disposition),
      lastAction: typeof r.last_action === "string" ? r.last_action : null,
      sentText: typeof r.sent_text === "string" ? r.sent_text : null,
      sentOption: parseSentOption(r.sent_option),
      sentBy: r.sent_by === "foreman" || r.sent_by === "you" ? r.sent_by : null,
      createdAt: Number(r.created_at ?? 0),
      resolvedAt: typeof r.resolved_at === "number" ? r.resolved_at : null,
      resolvedBy: r.resolved_by === "foreman" || r.resolved_by === "you" ? r.resolved_by : null,
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
  model: string | null;
  effort: string | null;
  source_id: string | null;
  external_id: string | null;
  source_url: string | null;
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
          out.push({ type: "task", taskId: row.taskId, title: row.title, selectedAt, satisfiedAt });
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

/** A stale/newer effort value cannot be trusted onto tmux's shell command line. */
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
    model: r.model,
    effort: parseEffort(r.agent as Task["agent"], r.effort),
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

export function upsertTask(t: Task): string[] {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
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
         id, title, intent, kind, agent, priority, labels, dependencies, model, effort,
         source_id, external_id, source_url, repo_root, worktree_path, branch,
         provider, tmux_session, session_id, status, outcome, outcome_url, error,
         created_at, updated_at, dispatched_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, intent=excluded.intent, kind=excluded.kind, agent=excluded.agent,
         priority=excluded.priority, labels=excluded.labels, dependencies=excluded.dependencies,
         model=excluded.model, effort=excluded.effort,
         source_id=excluded.source_id, external_id=excluded.external_id,
         source_url=excluded.source_url,
         repo_root=excluded.repo_root, worktree_path=excluded.worktree_path, branch=excluded.branch,
         provider=excluded.provider, tmux_session=excluded.tmux_session, session_id=excluded.session_id,
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
      t.model,
      t.effort,
      t.source?.sourceId ?? null, t.source?.externalId ?? null, t.source?.url ?? null,
      t.repoRoot, t.worktreePath, t.branch, t.provider,
      t.tmuxSession, t.sessionId, t.status, t.outcome, t.outcomeUrl, t.error, t.createdAt,
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

export function replaceSessionWorkEpisode(episode: SessionWorkEpisode): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(
      `INSERT INTO session_work_episodes
         (session_id, episode_id, agent_session_id, branch, pr_url, pr_head_sha, merged_at, prompted_at,
          awaiting_agent_rebind, rebind_from_transcript_path, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         episode_id       = excluded.episode_id,
         agent_session_id = excluded.agent_session_id,
         branch           = excluded.branch,
         pr_url           = excluded.pr_url,
         pr_head_sha      = excluded.pr_head_sha,
         merged_at        = excluded.merged_at,
         prompted_at      = excluded.prompted_at,
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
    d.prepare(
      `DELETE FROM session_work_episode_prompts
       WHERE session_id = ? AND episode_id <> ?`,
    ).run(episode.sessionId, episode.episodeId);
    if (episode.promptedAt !== null) {
      d.prepare(
        `INSERT OR IGNORE INTO session_work_episode_prompts
           (session_id, episode_id, prompted_at)
         VALUES (?, ?, ?)`,
      ).run(episode.sessionId, episode.episodeId, episode.promptedAt);
    }
    if (ownsTransaction) d.exec("COMMIT");
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
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    const result = d
      .prepare(
        `UPDATE session_work_episodes
         SET agent_session_id = ?, awaiting_agent_rebind = 0,
             rebind_from_transcript_path = NULL, updated_at = ?
         WHERE session_id = ? AND episode_id = ? AND awaiting_agent_rebind = 1`,
      )
      .run(agentSessionId, now, sessionId, episodeId);
    if (Number(result.changes) > 0) {
      d.prepare(
        `UPDATE task_work_episode_bindings
         SET agent_session_id = ?, updated_at = ?
         WHERE session_id = ? AND episode_id = ?`,
      ).run(agentSessionId, now, sessionId, episodeId);
    }
    if (ownsTransaction) d.exec("COMMIT");
    return Number(result.changes) > 0;
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function deleteSessionWorkEpisode(sessionId: string): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(`DELETE FROM session_work_episode_prompts WHERE session_id = ?`).run(sessionId);
    d.prepare(`DELETE FROM session_work_episodes WHERE session_id = ?`).run(sessionId);
    if (ownsTransaction) d.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function bindTaskWorkEpisode(binding: TaskWorkEpisodeBinding): void {
  const d = openDb();
  const ownsTransaction = !d.isTransaction;
  if (ownsTransaction) d.exec("BEGIN IMMEDIATE");
  try {
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
    if (ownsTransaction) d.exec("COMMIT");
    return Number(session.changes) > 0 || Number(binding.changes) > 0;
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
    const rows = d
      .prepare(
        `SELECT task_id FROM task_work_episode_bindings WHERE session_id = ?
         UNION SELECT id AS task_id FROM tasks WHERE session_id = ?`,
      )
      .all(sessionId, sessionId) as unknown as Array<{ task_id: string }>;
    d.prepare(`DELETE FROM task_work_episode_bindings WHERE session_id = ?`).run(sessionId);
    d.prepare(`UPDATE tasks SET session_id = NULL WHERE session_id = ?`).run(sessionId);
    if (ownsTransaction) d.exec("COMMIT");
    return rows.map((row) => row.task_id);
  } catch (error) {
    if (ownsTransaction && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

export function deleteTask(id: string): void {
  const d = openDb();
  d.prepare(`DELETE FROM task_work_episode_bindings WHERE task_id = ?`).run(id);
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
         FROM usage_ledger WHERE note_key = ?`,
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
 */
export function fleetEstimatedCostSince(tsMs: number): number | null {
  const r = openDb()
    .prepare(
      `SELECT SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) c,
              SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) unknown
         FROM usage_ledger WHERE ts >= ?`,
    )
    .get(tsMs) as { c: number | null; unknown: number | null } | undefined;
  if ((r?.unknown ?? 0) > 0) return null;
  return r?.c ?? 0;
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
      `SELECT SUM(input + output + cache_read + cache_write) t FROM usage_ledger WHERE ts >= ?`,
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

/** True only after Claude's reported telemetry has arrived; Codex rows are automatic. */
export function reportedUsageLedgerHasRows(): boolean {
  const r = openDb()
    .prepare(`SELECT 1 AS x FROM usage_ledger WHERE cost_basis = 'reported' LIMIT 1`)
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
         (id, pr_key, fingerprint, path, line, title, severity,
          round, status, replies, answered_comment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pr_key, fingerprint) DO UPDATE SET
         path = excluded.path,
         line = excluded.line,
         title = excluded.title,
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
              COALESCE(SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved_findings
         FROM inspector_prs p
         LEFT JOIN inspector_comments c ON c.pr_key = p.key
        GROUP BY p.key
        ORDER BY COALESCE(p.last_reviewed_at, p.adopted_at) DESC
        LIMIT ?`,
    )
    .all(limit ?? -1) as unknown as (InspectorPrRow & {
    open_findings: number;
    resolved_findings: number;
  })[];
  return rows.map((r) => ({
    ...rowToInspectorPr(r),
    openFindings: Number(r.open_findings),
    resolvedFindings: Number(r.resolved_findings),
  }));
}
