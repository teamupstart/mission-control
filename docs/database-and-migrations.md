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

One family of tables is deliberately not durable state. `scout_archives`, `scout_artifacts`,
and `scout_search_segments` are a derived index of the [scout library](scout-archives.md) on
disk: they hold no foreign keys to tasks or sessions, no evidence bytes, and nothing that is
not already in a bundle. Deleting them - or the whole database - costs a background rebuild
and nothing else. A label, annotation, or ownership flag stored only in those rows would be
lost the first time the index was rebuilt, which is why none may be added.
