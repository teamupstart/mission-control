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

Not everything crosses this stream. Detailed or unbounded history - the Ship log's day feed,
Workflow runs, [archives](archives.md) - stays out of both the snapshot and the
incremental frames, and is fetched on demand by the view that owns it. Where the daemon still
needs to say that such a collection moved, it emits a content-free invalidation frame
(`harnesses_config_changed`, `archive_changed`) and the hook keeps a revision counter
that the owning view watches. Those counters are bumped on reconnect as well as on the event,
because a collection that rides no snapshot has nothing for a reconnect to restore.
