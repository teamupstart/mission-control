# Event stream

The dashboard starts from an HTTP snapshot and stays current through one Server-Sent Events
connection. This makes live state a server-owned stream rather than a collection of browser
pollers. The daemon's [`/events` route](../src/server/routes.ts) forwards Registry events;
the React [event-stream hook](../src/web/useEventStream.ts) applies them to the local view.

Events are compact changes such as a session upsert, a session removal, or a catalog update.
The hook handles every known `ServerEvent` variant explicitly. When a version-skewed daemon
sends an unknown event, the hook warns once rather than silently treating it as a supported
state transition.

The result is a clear recovery model: reconnects obtain the server's current snapshot, and
incremental frames keep it current afterward. Detailed resources that would be too large
for the fleet stream are fetched on demand by the views that need them.

For the browser and process boundary, read [Process boundaries](agent-guides/architecture.md#process-boundaries).
For the shared wire types that must evolve with both server and client, use the
[Shared types and events contract](agent-guides/change-contracts.md#shared-types-and-events).
The user-facing dashboard context is in [User interface](ui.md).

A collection may also be bounded by CONSENT rather than by size. `pipelineRuns` - the
projection of an external SDLC engine's work, see [Pipelines](pipelines.md) - is empty on
every fleet that has enabled no repository, which is the shipped configuration: the daemon
emits no pipeline frame, and the browser holds an array it never renders. Enabling a
repository is what starts the traffic, and withdrawing consent retires it through
`pipeline_remove` in the same request rather than on a later tick.

A collection may instead be bounded by a SESSION LIFETIME. `fileCommentThreads` - the
line-anchored comment threads of the [Files workspace](ui.md) - carries every thread the
daemon holds for a session it still knows about, each with its own messages so a thread
renders from one frame rather than needing a second fetch. A thread belongs to exactly one
session and ends with it: when the session is removed its threads are settled to `orphaned`
by UPDATE and leave the collection through `file_comment_thread_remove`, and a throttled
prune finally deletes settled rows whose session is gone. Nothing accumulates.

Two frames carry it. `file_comment_thread_upsert` carries the WHOLE thread - a thread is
read as one picture of one conversation on one line, so a patch could draw a marker whose
state came from one instant and whose replies came from another. `file_comment_thread_remove`
carries only an id, because there is nothing left to draw; for the orphan case it is a
statement about the live collection and not about the row, which survives.

The bound is stated twice and pinned once. Per thread, the anchored quote is capped
(`FILE_COMMENT_QUOTE_MAX`) and the reply list is capped
(`FILE_COMMENT_THREAD_MESSAGE_CAP`), with `messageCount` reporting the true total so a
surface can tell it is looking at a tail and fetch the whole thread from
`GET /api/file-comments/:id`. Per fleet, a review is normally tens of comments and most
sessions have none, so the realistic ceiling is a few hundred threads;
`test/file-comments-sse.test.ts` measures one realistic thread and states the arithmetic.
When a surface needs more than the budget allows, fetch the one thread that is open - never
widen the collection.

Not everything crosses this stream. Detailed or unbounded history - the Ship log's day feed,
Workflow runs, [archives](archives.md) - stays out of both the snapshot and the
incremental frames, and is fetched on demand by the view that owns it. Where the daemon still
needs to say that such a collection moved, it emits a content-free invalidation frame
(`harnesses_config_changed`, `archive_changed`) and the hook keeps a revision counter
that the owning view watches. Those counters are bumped on reconnect as well as on the event,
because a collection that rides no snapshot has nothing for a reconnect to restore.

Settings restore uses a separate invalidation-only frame. After the restore transaction has
committed and synchronous catalog reconciliation has completed, the route emits exactly one
`settings_restored` event containing only `snapshotId`, `restoredAt`, and the initiating
`requestId`. It is deliberately absent from the reconnect snapshot and from `LINE_INPUT_EVENTS`:
it does not carry configuration or execution state, and it never causes the Line to refold.

The request id separates two window behaviors. The initiating window suppresses the notice,
hydrates its UI configuration cache, and reloads. Any other open window records the latest event
and draws a persistent **Reload now** notice without changing Library state or discarding drafts.
No snapshot payload, setting value, prompt, command, allowlist, or path crosses the event stream.

The loopback HTTP surface is likewise bounded:

| Route | Result |
| --- | --- |
| `GET /api/settings-backups` | Public metadata, compatibility, retention, and last backup status |
| `GET /api/settings-backups/:id/preview` | Digest-bound redacted changes, exclusions, warnings, and blockers |
| `POST /api/settings-backups/:id/restore` | Phase 2 transaction result after exact confirmation and reconciliation |

These routes consume the verified snapshot service. They do not parse snapshot payloads or repeat
digest, preflight, transaction, rollback, or reconciliation logic at the HTTP boundary.
