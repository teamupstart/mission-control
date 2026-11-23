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
`requestId`. The incremental event is deliberately absent from `LINE_INPUT_EVENTS`: it does not
carry configuration or execution state, and it never causes the Line to refold. The reconnect
snapshot carries only the latest event's same three public scalars as a bounded marker. A fresh
window baselines that marker because it already loaded current settings; a reconnecting window
compares it with the marker from before the stream gap and recovers a missed invalidation.

The request id separates two window behaviors. The initiating window suppresses the notice,
hydrates its UI configuration cache, and reloads. Any other open window records the latest event
and draws a persistent **Reload now** notice without changing Library state or discarding drafts.
If the initiating request's HTTP result was ambiguous, the same request-id ownership check applies
to a changed reconnect marker, so that window hydrates and reloads instead of becoming a peer.
No snapshot payload, setting value, prompt, command, allowlist, or path crosses the event stream.

The loopback HTTP surface is likewise bounded:

| Route | Result |
| --- | --- |
| `GET /api/settings-backups` | Public metadata, compatibility, retention, and last backup status |
| `GET /api/settings-backups/:id/preview` | Digest-bound redacted changes, exclusions, warnings, and blockers |
| `POST /api/settings-backups/:id/restore` | Phase 2 transaction result after exact confirmation and reconciliation |

These routes consume the verified snapshot service. They do not parse snapshot payloads or repeat
digest, preflight, transaction, rollback, or reconciliation logic at the HTTP boundary.

## Pausing

A session's pause rides on the session itself, as `Session.pause` in `session_upsert` and the
snapshot's `sessions`. Its `phase` is what the dashboard shows; its `stopped` says whether any of
the agent's processes are stopped right now, and is what every write gate refuses on, because a
freeze a restart interrupted leaves stopped processes under a `pending` phase. The fleet-wide half (Pause all and the priority session) is the
`pause_state` event, which carries the whole `PauseState` from `src/shared/pause.ts`: two
nullable singletons, so it is bounded by construction. The reconnect snapshot carries the same
value as `pause`, and a snapshot from an older daemon without it reads as nothing paused.
`PauseManager` (`src/server/pause/manager.ts`) is the only writer of both, and the registry
emits `pause_state` only when the state changed. It is deliberately absent from
`LINE_INPUT_EVENTS`, because the Line has no stage for a fleet-wide control.
See [Pause and resume a session](sessions.md#pause-and-resume-a-session).

## Storage health

`storage_health` carries the whole storage aggregate from `src/shared/storage-health.ts`: backup
status per kind, the kept copies with their sizes, the total size, the state directory's last
measurement by category (and its pools, at most `STORAGE_USAGE_POOL_LIMIT`), the volume's free
space, the storage limits it was judged against, and the current problems. The daemon's
`StorageHealthService` recomputes it after every database backup capture and prune, measurement,
volume check that moved, and limits save, and emits the event only when the result changed. The
aggregate is bounded: eight categories, at most 64 pools, and no per-slot sizes, which stay in the
daemon for `GET /api/storage/pool-caches`. The
reconnect snapshot carries the same value as `storageHealth`, or null before the service has
computed it once, and `GET /api/storage` returns it with the backup config. Settings > Storage
shows whichever of the two arrived last, so its re-read after a write is not hidden by an older
stream value while the stream is down. Each problem's id names one occurrence and is built only from durable
state, so a daemon restart never changes it. See [Backup and restore](sqlite-database.html#backup).

Saving the indexed directories through `PUT /api/repo-index` emits `repo_index_changed`,
carrying only the new index identity: a 16-character hash of the effective directories and
depth limit, also sent as `x-repo-index-identity` on every `GET /api/repos` answer. Each open
window drops the repository list it keeps for the Dispatch picker unless that list answers for
the announced identity, and a Dispatch form already open lets go of it at once and asks again.
`settings_restored` drops the list outright, since a restore can replace the directories too.

The snapshot carries the same `repoIndexIdentity`, which is what a window disconnected during
the save relies on: it never saw `repo_index_changed`, so on reconnect it compares its list
against the snapshot's identity and drops it on a mismatch. A reconnect with nothing changed
keeps the list - a daemon under load drops connections, which is exactly when the picker needs
the list it already has. When the daemon cannot read its index config, the snapshot logs why and
carries `REPO_INDEX_IDENTITY_UNKNOWN` instead of omitting the field: the window drops its list,
since nothing vouches for it, and takes the next real answer.

The backup config is not part of that aggregate. Saving it through
`PUT /api/storage/backups/config` emits the content-free `storage_config_changed`, and the
hook's `storageConfigRevision` counter, bumped on that event and on every reconnect, makes each
open Settings > Storage re-read the route. `storage_health` cannot carry that signal: a save
that prunes nothing leaves the aggregate unchanged, so no frame is sent. A re-read replaces only
the fields not edited in that window, and Save sends only the fields edited there.

## Feature flags

`feature_flags` carries `{ config }`, the machine's full `{ enableAll, overrides }` setting.
The reconnect snapshot carries it as `featureFlags`, and `MissionState.featureFlags` is the
only browser owner. `useFeatureFlag` resolves against that state; before a snapshot it uses
defaults. The record is bounded to 512 overrides with ids at most 64 characters, below 40 KiB
when serialized even at the maximum. Identical frames are suppressed by comparing the master
and every override, independent of key order. It is not a `LINE_INPUT_EVENTS` member: no Line
stage consumes flags. Writes and settings restores publish after persistence, without polling.
See [Feature flags](feature-flags.md).

## Task shaping

`shaping_config` carries `{ config }`, Task shaping's config view: `caller`, `limits`, `shapers`,
`overrides` and `order`, where each shaper this build understands appears in full and an entry it
cannot run appears only as `{ id, label, unsupported }`. Its raw stored envelope never leaves the
daemon. The event and the reconnect snapshot's `shaping` field are both behind the `task-shaping`
flag. While it is off, the snapshot has no `shaping` field, no frame carries a config, and nothing
reads the stored shapers; the only frame is `{ config: null }`. That clearing frame is sent when
the flag turns off, so every open window drops the config, and once at daemon start when the flag
is already off. Repeats are suppressed. Turning the flag on sends the current config, so an open
window fills Settings > Task shaping with no reload.
`MissionState.shaping` is the only browser owner, null before the snapshot and while the flag is
off. `wireShapingConfigEvents` in `src/server/shaping/events.ts` is the one bridge, wired once at
daemon start, so every write through the shaping store and every settings restore reaches open
windows through it. Identical frames are suppressed by canonical JSON. The config is bounded by
`SHAPING_LIMITS`, 32 shapers of at most 16 KiB and 128 choices, below 560 KiB serialized at the
maximum. It is not a `LINE_INPUT_EVENTS` member: shapers are read at dispatch, and no Line stage
folds them. See [Task shaping](task-shaping.md#settings).

## Voice

`voice_state` carries `{ state }`, the whole voice state (`VoiceState` in `src/shared/voice.ts`):
`mode`, `reasons`, `capabilities`, `hotkeyError`, `model` and `roster`. It is sent whenever the
state changes: a flag or the voice config changed, a listener's hello or a shell report arrived,
or one of them lapsed, which a daemon timer publishes with no request, or the speech model's
state moved. A model download publishes its progress at most every 250 ms, so a download is a
few frames a second for as long as it runs. The reconnect snapshot's
`voice` field is present only while the `voice` flag is on, computed at that moment. While the
flag is off no frame is sent, except one with the mode `off` when it is switched off: the desktop
shell reads no feature flag, so that frame is how it learns voice is off. Identical frames are
suppressed by a canonical form. `MissionState.voice` is the only browser owner, null before the
snapshot and while the flag was off at connect time. `wireVoiceStateEvents` in
`src/server/voice/state.ts` is the one bridge, wired once at daemon start. The state is a handful
of scalars, at most seven capabilities with bounded reasons, and the roster. It is not a
`LINE_INPUT_EVENTS` member.

`voice_card` carries `{ card }` whenever an utterance opens a card or changes its state.
Consumers replace the card by id. A card the model step is still settling is sent as `resolving`
only once the step has taken a second, so a quick answer arrives as `pending` or `unsure` with no
frame before it; a split is one card whose `parts` name two targets. A reconnect snapshot carries the open cards in `voiceCards`
while voice is enabled. The daemon drops them and the dashboard clears its map when voice turns
off. Recently heard stays in daemon memory and is read separately through the voice routes.

`voice_roster` carries `{ roster }`, who can be addressed (`SpokenName[]` in
`src/shared/voice-names.ts`), whenever it changes: a resident profile or run, a task's call sign,
or a session starting or stopping a task with a call sign. It replaces `VoiceState.roster` and
nothing else, and a roster change sends no `voice_state` frame: the canonical form that suppresses
repeated states leaves the roster out, so the shell, which follows the mode, is not woken by an
agent starting. Each `voice_state` frame still carries the roster as it stands. Sent only while the
`voice` flag is on, and only when the roster changed. `wireVoiceNameEvents` in
`src/server/voice/names.ts` is the one bridge. It is bounded by the live resident profiles (at most
200) and the launched tasks with a call sign that are running, hibernated, or recently stopped and
still kept by the roster's retention rules ([who can be addressed](voice.md#who-can-be-addressed)):
a hibernated task stays however long it sleeps, and a stopped one leaves when its retention ends
or sooner when another agent takes its name. It
is not a `LINE_INPUT_EVENTS` member: the Line reads the task and session frames it is computed
from. See [Voice addressing](voice.md#spoken-names).

## Agent reports

`report_upsert` carries `{ report }`, one whole `ReportItem` (`src/shared/reports.ts`), whenever a
report is posted, first opened, marked read, or replaced; when its notification wording is
stamped (`announcedAs`, which is what raises its notification); and when an Away return digest
marks it counted (`countedInDigestAt`, so no window notifies about it afterwards). There is no
remove frame: a report is never deleted and outlives the session that posted it, so a read or
replaced report is upserted with its new state, and the dashboard drops it from its state on that
frame (`withReportUpserted` in `src/web/lib/report-state.ts`). An open window therefore holds only
the reports waiting to be read, however many it has seen. Replacing a report sends two frames, the
replaced report with its `supersededBy` set and then its successor.

The reconnect snapshot's `reports` field holds every report waiting to be read: unread, and the
latest of its chain. It is bounded by what the operator has not read yet. A session's whole
history, older versions and read reports included, is read on demand from
`GET /api/sessions/:id/reports` rather than carried here.

Both are behind the `inbox` flag. While it is off the snapshot has no `reports` field and no
`report_upsert` is sent. Turning the flag on sends a `report_upsert` for every report waiting to be
read, so an open window fills its Reports section and **to read** figure with no reload.
`report_mutes` carries `{ mutes }`, the whole list of muted report authors (`ReportMute` in
`src/shared/reports.ts`), after every mute and unmute. It is sent whole because the list is small
and applying it twice ends in the same state. The snapshot's `reportMutes` field holds the same
list. A muted author's reports still arrive in `reports` and `report_upsert`: the dashboard's
inbox fold leaves them out, so an unmute lists them again without a fetch. Both follow the
`inbox` flag like `reports`; turning the flag on sends `report_mutes` before the reports it
resends. `MissionState.reportMutes` is their only browser owner.

`MissionState.reports` is the only browser owner. It is not a `LINE_INPUT_EVENTS` member: no Line
stage folds reports.
