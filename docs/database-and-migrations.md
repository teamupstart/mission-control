# Database and migrations

SQLite holds the state the operating system cannot rediscover: tasks, workflows, queues,
reviews, schedules, settings, and other durable records. It does not hold the live session
map. On startup, the daemon rebuilds live sessions from terminal discovery and SDK restore,
then reconciles durable records against that observed state.

[`src/server/db.ts`](../src/server/db.ts) is both the schema and the upgrade path. It opens
the database, creates base tables, and applies additive migrations for existing installs.
The daemon composition root calls `openDb()` before it starts services, making the daemon
the only SQLite writer. Other processes, including Foreman and MCP, use loopback HTTP.

The practical implication is that a schema change is not just a new-table change: it must
also open safely against an operator's existing database. Keep the migration beside the
schema and create dependent indexes only after the columns exist.

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
run-local replay cursor per attempt, and retain a bounded opaque authoring ledger. Their
projection can be reconciled through the provider's sanctioned replay command, but it is not
rebuildable from implementation worktrees and must not be treated as a disposable cache.

`archive_capture_jobs` sits beside them and is a different kind of table again: local
coordination for archives this daemon is still WRITING, one row per archive a task work episode
owes, holding the reserved archive identity, the directory that row covers, and the checkout
locators a resumed capture needs. A scout episode owes exactly one, so its row covers the
episode; a plan task owes one per plan directory it wrote. It refers to
task and session ids as values and has no foreign key or cascade to either, because a published
archive has to outlive both. Losing it loses the ability to resume an unfinished capture, never
the ability to read a finished one.
