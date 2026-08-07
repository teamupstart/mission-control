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
