# Database and migrations

SQLite holds the state the operating system cannot rediscover: tasks, workflows, queues,
reviews, schedules, settings, and other durable records. It does not hold the live session
map. On startup, the daemon rebuilds live sessions from terminal discovery and SDK restore,
then reconciles durable records against that observed state.

[`src/server/db.ts`](../src/server/db.ts) is both the schema and the upgrade path. It opens
the database, creates base tables, and applies additive migrations for existing installs.
The daemon composition root acquires `$MISSION_HOME/daemon.lock` before calling `openDb()` or
running any migration. That process-lifetime OS lock, rather than the API port, makes the daemon
the only SQLite writer for a state home. If ownership is unavailable, startup reports the
current owner's PID and port and exits without opening the database. Other processes, including
Foreman and MCP, use loopback HTTP.

The practical implication is that a schema change is not just a new-table change: it must
also open safely against an operator's existing database. Keep the migration beside the
schema and create dependent indexes only after the columns exist.

`claude_rate_limit_cache` holds one validated snapshot of Claude's last reported subscription
windows, including each window's recording time. The Registry restores it before serving a
snapshot; terminal statusLine and SDK usage reports update the same record. Expired readings
remain available as explicitly historical UI data and are excluded from current quota. This is
independent of the usage ledger and never contributes dollars or tokens.

`session_blockers` (schema 25) holds one durable [session blocker](sessions.md#blocked-sessions)
per note key, the same key that carries notes, goals, invites and standing instructions across
restarts, with the bound `task_id` recorded for reference. It is created in `migrate()`, so a
schema 24 database gains an empty table on its next open. The Registry loads it at
construction, moves a row on every note-key rotation, deletes it when the task it was reported
for reaches a terminal status, and prunes a key no session has held for the goal pruning window.
`last_held_at` records when a live session was last seen holding the key, so that window counts
observed absence and a restart does not reset it.

`session_awaitings` (schema 44) holds one [declared wait on a background process](sessions.md#sessions-awaiting-a-background-process-preview)
per note key, with the bound `task_id` recorded for the terminal-task clear. It is created in
`migrate()`, so an older database gains an empty table on its next open. The Registry loads it at
construction, moves a row on every note-key rotation as it moves a blocker, and deletes a row on
the session's next turn, when the session is removed after it exits, after three minutes with no
live session holding its key, on a clear, when its task reaches a terminal status, and when the
`session-awaiting` preview is off. A blocker replacing a wait deletes the wait's row in the same
transaction that writes the blocker.
`settled_at` records when the declaring turn was seen to end, which is what tells the wake from
the rest of that turn: a reading that leaves the session's turn for idle, or, for a wait declared
while the session already read idle, the first time its hooks or its transcript report it idle
after the declaration. `pending_nudges` holds one entry for each delivery Mission Control's own
automation claimed into the session while the wait stood, or in the ten minutes before it was
declared with its prompt not yet back from the session, and that has not yet started its turn,
with the delivered text's fingerprint, so the turn whose prompt it is reads as that nudge rather
than as the wake, even when deliveries overlap, another message starts a turn first, or the
daemon restarts in between. A delivery that provably never landed is removed. An entry carries
`contestedBy`, the ids of a person's own messages in exactly the same words sent through Mission
Control while it was pending, and while any stands the turn whose prompt matches it is read as the
wake. A message that provably never landed removes only its own id, so a duplicate that fails,
even after a daemon restart, leaves an earlier message's claim in place. `undecided_turn`
marks a turn that started while a delivery was pending and whose prompt has not been reported
yet, so a restart before that prompt arrives can still decide whose turn it was.
`redeclared_in_turn` marks that the session declared its wait again during that turn: the turn
is still decided, so a delivery that started it is used up, but it no longer ends the wait.
`session_id` is the last session seen holding the wait, so a clear with no live holder (a prune
after a restart, the preview switched off) still files its `session_awaiting_cleared` row under a
session.
`judged_turn_at` is the transcript time of the latest turn start the wait has already judged,
so a transcript turn marker is compared in the transcript's own time rather than against when a
sweep happened to look, and a turn already judged is not judged again after a restart.

## Full-database recovery points

Mission Control creates verified recovery points for normal operation and schema upgrades. See
[Backup and restore](sqlite-database.html#backup) in the database field guide for the authoritative
backup, retention, validation, failure-handling, and offline-restore procedure.

Backup status appears on the Backups tab of **Settings > Storage**: the interval, the count, age
and size limits, the copies that are always kept, Back up now, the last success and last failure of
each kind, and the kept copies with their total size. The Overview tab's Problems list names a failing
capture until a capture of either kind succeeds. See [Storage](storage.md).

## Recovering the product database

Use the supported recovery command from a current Mission Control checkout. Pass the absolute
path to the candidate's `harness.db`; adjacent `-wal` and `-shm` files are included when present.

```sh
npm run recover:database -- /absolute/path/to/backup/harness.db
```

The command requires the managed-install receipt and verifies that its app bundle has the exact
identifier `com.mission-control.app`. It stages and validates a copy with SQLite `quick_check` and
`foreign_key_check` before disturbing the app. It then discovers the current daemon from fresh
`daemon.lock` metadata plus `/api/health`, proves that daemon is a descendant of the exact
receipt-verified app process, and signals only that freshly re-identified PID after asking the app
to quit. It does not inspect or infer a launchd configuration.

Recovery waits for the daemon to close SQLite and release the kernel-held state lock, then holds
that same lock while it snapshots and replaces the database. This is the only supported offline
exception to the daemon-only writer boundary. A bounded operation lock serializes complete
recovery invocations through relaunch health, while a separate kernel-held ledger lock serializes
every ledger mutation, including health and retention bookkeeping after the daemon lock is
released for the relaunched app. A bounded ledger under
`$MISSION_HOME/database-recovery/` prevents the same successfully applied candidate from being
applied twice, permits a byte-identical retry after a failed attempt rolled back, and keeps rollback
material for the five most recent recoveries. The command attempts one app launch and reports the
dynamically observed daemon PID, port, and version only after health succeeds. A failed install
restores the prior files, relaunches the app once, and confirms health. A failed relaunch restores
the prior files without launching a second time. A later rollback-retention or ledger-cleanup
failure is reported as a warning and never reverts a database whose health was already confirmed.
The same non-reverting warning policy applies when the final applied-state ledger write fails after
health confirmation; the ledger stays fail-closed at `installed` instead of stopping a healthy app.

To deliberately restore the retained pre-recovery snapshot, use the recovery id printed by the
first command. Rollback goes through the same validation, stop proof, one-launch, and health path.

```sh
npm run recover:database -- --rollback <recovery-id>
```

The ledger fails closed at 100 attempts instead of discarding idempotency history, so both retained
material and supported recovery volume have explicit bounds. The flow runs as the current user and
neither installs a privileged helper nor changes database ownership.

This page is an orientation aid. The authoritative requirements for database changes,
append-only identifiers, and ledgers are [Database changes](agent-guides/change-contracts.md#database-changes),
[Persisted identifiers](agent-guides/change-contracts.md#persisted-identifiers), and
[Ledger tables](agent-guides/change-contracts.md#ledger-tables).

One family of tables is deliberately not durable state. `archives`, `archive_artifacts`,
and `archive_search_segments` are a derived index of the [archive library](archives.md) on
disk: they hold no foreign keys to tasks or sessions, no evidence bytes, and nothing that is
not already in a bundle. Deleting them - or the whole database - costs a background rebuild
and nothing else. A label, annotation, or ownership flag stored only in those rows would be
lost the first time the index was rebuilt, which is why none may be added.

`pipeline_runs` is in that same family and arrived with the same rule. It projects what an
external SDLC engine's own state files say about each feature it is driving, for the
repositories an operator consented to - so every column is derived from files still on disk
under that engine's control, and deleting the table costs one refresh pass. Nothing may be
stored there that is not already in those files: an operator's own note or label would be
lost the first time the projection was rebuilt, and belongs on a task. It declares no foreign
key, holds rows only while consent stands, and is described in [Pipelines](pipelines.md).

`pipeline_events` sits beside it and is the exception in that family: an append-only ledger of
every engine event Mission Control has observed, and the one thing the pipelines integration
keeps that its files cannot re-derive. The engine persists 76 of its 104 event kinds to disk,
so for the other 28 an event pushed to `/ingest/conductor` is the only Mission Control record
anywhere. It is still bounded and still consent-scoped: rows are retired with the run they
describe and with the repository whose consent authorised writing them, plus a per-run cap.
Nothing in the projection is derived from it - a run's group, steps, halt and cost all come
from the engine's files - which is what keeps a duplicate row a diagnostic wart rather than a
wrong figure, and what settles every convergence question in favour of an extra row over a
dropped event. Its key is in
[Persisted identifiers](agent-guides/change-contracts.md#persisted-identifiers).

The `pipeline_commissions`, `pipeline_commission_attempts`, and
`pipeline_commission_events` tables are durable state of a different kind. They preserve one
Mission Control-owned task commission across ordered provider Engineer attempts, keep one
run-local replay cursor per attempt, and retain a bounded opaque authoring ledger. The attempt
table keeps the full audit, while commission JSON and SSE projections carry only the 20 most
recent attempts. Their projection can be reconciled through the provider's sanctioned replay
command, but it is not rebuildable from implementation worktrees and must not be treated as a
disposable cache.

`task_source_writeback` is a ledger of a third kind: one row per write-back a
[task source](dispatch-and-backlog.md#writing-back-to-the-source) owes an item it swept.
Its rows deliberately **outlive the tasks that caused them**, and hold no foreign key to
one. A delivery is enqueued when a fact is observed - a pull request linked, a task
completed - and attempted later, by a worker, possibly after a restart; the task may be
gone by then, and "a pull request opened for this" stays true regardless. So the payload is
a snapshot of what was true at observation rather than a pointer to a live row, and nothing
on this table joins back to `tasks`. That is the same stance `task_source_seen` takes for a
different reason: there it is "a task you deleted stays deleted", here it is "a fact you
observed stays true". Its unique index over
`(source_id, external_id, signal, action, dedupe_key)` is the idempotency guarantee that
makes a restart, a re-observed pull request and a repeated poller tick all cost nothing, and
`signal` and `action` are therefore
[append-only identifiers](agent-guides/change-contracts.md#persisted-identifiers): renaming
one orphans every undelivered row written under the old spelling.

`archive_capture_jobs` sits beside them and is a different kind of table again: local
coordination for archives this daemon is still WRITING, one row per archive a task work episode
owes, holding the reserved archive identity, the directory that row covers, and the checkout
locators a resumed capture needs. A scout episode owes exactly one, so its row covers the
episode; a plan task owes one per plan directory it wrote. It refers to
task and session ids as values and has no foreign key or cascade to either, because a published
archive has to outlive both. Losing it loses the ability to resume an unfinished capture, never
the ability to read a finished one.

## Idle online backup completion

`database-backups/online.ts` wraps the native SQLite backup used by captures and restore
verification. On 2026-11-20, a standalone `node:sqlite` probe on macOS 26.6.2 with Homebrew
Node 26.7.0 observed a completed native copy at one second while the await continuation
had not run. The await resumed after a JavaScript callback at about 1002 ms. This observation
is specific to that verified environment; it does not establish the same timing on other
platforms or Node versions.

A referenced 10 ms timer exists only while the
backup is pending and is cleared on success or failure. This preserves the online snapshot
and its WAL semantics; it neither changes the scheduling clock nor times out a still-active
SQLite operation. `test/database-backup-idle.test.ts` exercises an otherwise quiet child
process with a parent watchdog and verifies that the helper leaves no timer behind.
