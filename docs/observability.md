# Observability and telemetry

The [six Grafana dashboards and isolated demo](observability-dashboards.md) are the local
operator experience. That guide covers setup, query semantics, trace drill-down and Phase 7 verification.

Mission Control can capture what it does as OpenTelemetry signals, keep them on disk until a
backend is reachable, and export them over OTLP/HTTP. This page covers what it collects, how to
turn it on, the local Grafana stack that ships with the repository, and the measured costs.

**Everything here is off by default.** An upgraded installation gains some empty tables, records
nothing, mints no identity and contacts nothing until an operator says otherwise.

This is the OUTBOUND facility. It is unrelated to the inbound `/v1/metrics` receiver that ingests
Claude Code's own cost metrics - see [Configuration](configuration.md) for that one. The two share
no storage, no configuration and no queue, and Mission Control refuses an export endpoint that
points back at its own address.

## What state it is in

Phases 1, 2 and 3 of the [OpenTelemetry plan](plans/opentelemetry-integration/plan.md) established
the durable path, the export protocol, the consent model, the local reference stack,
a compatibility diagnostic, the **Settings > Telemetry** panel that drives all of it, and
session attribution - how sessions start, the model and effort known for each turn with explicit
attribution quality, what they spend, how they end, and which pull requests verifiably landed.
When execution metadata is unavailable, attribution can be launch-resolved or unknown.

Phase 7 adds the [six product dashboards and isolated demo](observability-dashboards.md),
including cohort views and trace drill-down. They consume the workflow, action and error sources
from Phases 4 and 5 and the analytical projections from Phase 6.

The initial Phases 1-3 scope captured sixteen events: the daemon's own start, the synthetic connection probe,
telemetry control actions, the one browser-originated fact the daemon cannot observe for itself,
and [the twelve session, model, task and pull request facts below](#session-model-and-outcome-sources).
The following sections describe that foundation; additional sources use the registration seams
described below.

## Turning it on

Collection and export are separate decisions, and so are the two audiences.

| Mode | What it means |
| --- | --- |
| Off | The default. No journal row is written. |
| Local only | Collection on with no endpoint. Facts are captured, projected into local aggregates, retained and visible through the health API. Nothing leaves the machine. |
| Your own backend | Local only, plus export to an OTLP/HTTP endpoint you choose. |
| Product analytics | A second, independent destination carrying a narrower set of facts - only those that mean something off this machine, never the diagnostics that are only about your installation. Mission Control hosts no public analytics service, so no address is baked in: point it at a collector you run. Until an address is configured it reports `unavailable` and the daemon refuses to enable it, because switching it on with nowhere to send would claim to be sharing while queueing for an address that cannot answer. |

**Settings > Telemetry** is the control surface. It carries the master collection switch, the
per-destination opt-ins, the endpoint and credential fields, a connection test, per-destination
queue health, and the two irreversible operations (discard a queue, reset the installation
pseudonym). Both consent switches always open the panel rather than flipping from a search result,
because the copy beside them is the substance of the decision.

Everything the panel does is also reachable over the loopback API:

```sh
# Local-only collection.
curl -X PUT localhost:7317/api/telemetry/config \
  -H 'content-type: application/json' -d '{"enabled":true}'

# Local collection plus export to the local reference stack.
curl -X PUT localhost:7317/api/telemetry/config \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"user":{"enabled":true,"endpoint":"http://127.0.0.1:14318"}}'

# A Datadog-compatible delta destination. networkGate and lateAfterMs are API-only controls;
# Metric temporality is also editable in Settings > Telemetry.
curl -X PUT localhost:7317/api/telemetry/config \
  -H 'content-type: application/json' \
  -d '{"user":{"temporality":"delta","networkGate":"cloudflare-edge","lateAfterMs":3600000}}'

# The cost-bounded Datadog export shape. Also editable in Settings > Telemetry; see
# "Export shapes" below for what it leaves out and what changing it resets.
curl -X PUT localhost:7317/api/telemetry/config \
  -H 'content-type: application/json' -d '{"user":{"exportShape":"datadog-lean"}}'

curl localhost:7317/api/telemetry/health          # queue depth, bytes, gaps, pause reasons
curl -X POST localhost:7317/api/telemetry/probe -d '{"profile":"user"}' \
  -H 'content-type: application/json'             # a real OTLP request, plus a captured fact
curl -X POST localhost:7317/api/telemetry/drain   # run one cycle now instead of waiting 30s

# The three maintenance operations. `purge` and `retry` need a profile; the identity reset is
# installation-wide by definition.
curl -X POST localhost:7317/api/telemetry/operation \
  -H 'content-type: application/json' -d '{"action":"retry","profile":"user"}'
curl -X POST localhost:7317/api/telemetry/operation \
  -H 'content-type: application/json' -d '{"action":"purge","profile":"user"}'
curl -X POST localhost:7317/api/telemetry/operation \
  -H 'content-type: application/json' -d '{"action":"reset_identity"}'
```

A `PUT /api/telemetry/config` may carry `ifRevision`, the `config.revision` the edit was composed
against. When it is supplied and no longer matches, the write is refused with a 409 and
`{"conflict": true}` rather than merged - two dashboards on one daemon is ordinary, and the loser
of a last-writer-wins race on consent is somebody who believes they turned sharing off. A save that
stores an identical configuration is not a change: it does not move the revision, does not bump a
destination generation and does not invalidate another tab's open edit.

`retry` clears a pause the daemon applied to itself and brings every backed-off batch forward to
now. It does not reset the attempt count, so holding the button cannot turn a dead endpoint into a
tight retry loop. `purge` drops one destination's undelivered batches and its projections and
touches nothing else - not the other destinations, and nothing outside telemetry. `reset_identity`
mints a new pseudonym and discards every queue with it, because a batch already built carries the
old pseudonym inside its serialized resource and cannot be rewritten.

Disabling is not pausing. Pausing stops sending and keeps the backlog; disabling stops capture and
purges that profile's unsent batches and projections. Withdrawing consent cannot recall data a
backend already accepted, and the app does not pretend otherwise.

Clearing a product address is a withdrawal rather than a half-configured state: the switch goes off
with it, and re-entering an address does not resume sharing until somebody switches it back on. The
two alternatives were both worse - refusing the write leaves an operator who emptied the field
staring at an error telling them to fill in the field, and keeping `enabled` over an empty address
leaves a switch reading "on" that would silently resume the moment an address was typed back in.

Queue health reaches the dashboard on the settings-status channel every browser already holds open,
not through a poll: a destination that pauses itself has no other symptom anywhere in the app, and
a panel polling for it would be a second store of the same facts drifting by up to one interval.
The rail's Telemetry dot turns red when a destination stopped or is not getting through, green when
something is actually being exported, and stays dark for local-only - which is a complete state, not
a half-finished setup. An edge-gated destination whose Cloudflare edge refuses the current network
is different: it keeps its queue active, retries with a base backoff capped at five minutes plus
up to 25 percent positive jitter, reports `waitingForNetwork` and `waitingSince`, and shows a
neutral dot rather than a failure. A successful send clears the wait without a manual resume.

`lateAfterMs` does not discard an old point. Once the destination accepts the batch, Mission
Control increments the durable `latePointsSent` counter and records a `late_points` gap so a
backend's age-window exposure is visible. Failed attempts do not count, and an accepted retry
that aged past the cutoff while queued counts the batch once. If a partial-success response does
not identify which points were rejected, the counter records the conservative lower bound that
must have been both late and accepted.
The point remains subject to that backend's own historical-ingestion policy.

### The browser telemetry ingress

`POST /api/telemetry/ingress` is the one endpoint that accepts a fact from the dashboard, and it is
deliberately narrow, because a page is not a trusted subsystem:

- only catalog entries declared `ingress: "browser"` - a property of the catalog, so no call site
  can widen it, and a console cannot forge a daemon start or a workflow verdict by naming one;
- only inside that entry's own strict fact schema;
- at most 8 records per request, 8 KiB per body and 120 records per rolling minute across every
  browser talking to the daemon. The byte ceiling is measured off the request stream and the
  connection is dropped the moment the running total passes it, rather than being read off
  `Content-Length` - that header is caller-supplied, absent on a chunked request and free to
  understate, so enforcing against it would bound only the callers who were going to behave;
- attribution from the request's operation context, never from the body.

It always answers 200 with a per-record result, even when everything was refused: the application
action that produced the record already succeeded, and a telemetry refusal must not surface as a
failed action. An oversized or malformed body is the exception, and is a 4xx.

Requests may carry `x-mission-operation-id`, `x-mission-operation-surface` and
`x-mission-operation-actor`. Together they identify one logical thing a person asked for, so an
HTTP retry or a replayed submission collapses into one fact instead of two. They are attribution
and never authority: the daemon records an `actor.basis` of `app_context`, `declared` or `unknown`
alongside them, no header can mint the daemon's own `owner` basis, and no authorization decision
anywhere reads them.

### What travels, and what never does

Captured: app version, launch mode, bounded outcome enums, durations, token counts, an
installation pseudonym, and - from Phase 3 - the harness, runtime, task kind, multiplexer and
emulator TYPES a session ran on, plus reported model ids. Every event is validated against a
strict schema that rejects undeclared fields, so an internal object cannot be spread into a record
by accident.

Usage metrics retain separate model labels only for ids in the shipped model catalog.
Off-catalog ids share `model_id=other`; missing ids use `model_id=unknown`. Each metric's model
dimension therefore has at most the number of shipped ids plus two values, regardless of
stored defaults or live model discovery. Token and cost totals stay intact. Source facts and
session/dispatch traces retain the reported ids for detailed attribution.

Missing or unrecognized harness, runtime, task-kind and effort values are `unknown`. Explicit
`unsupported` capability evidence stays distinct; neither value is replaced with a real harness,
runtime, task kind or effort level. A personal session with no task remains `none`.

Never captured: prompts, code, file paths, branches, repository or PR URLs, terminal output,
rationale text, headers or free-text error detail. Nor, specifically: tty, process id, pane token,
multiplexer session name, window or tab title, or session and task names. Sessions, tasks,
conversations, repositories and pull requests are correlatable on traces through opaque
per-destination identifiers derived with a profile salt, so the same session reaches two audiences
under two unrelated ids and neither can be turned back into the thing it came from.

Every record carries a `deployment.environment.name` resource attribute, `local` by default and
overridable with `MISSION_TELEMETRY_ENVIRONMENT`. On a Mac an organization manages, the
organization's preset environment (`corp` for Upstart) replaces `local`, and the variable still
wins over it. It exists so demo, development and test signals can be kept out of adoption analysis
rather than filtered out afterwards by guesswork.

The installation pseudonym is a local random seed. It supports repeat-use and within-installation
comparison, and nothing else - there is no account lookup, no cross-device join and no
fingerprinting. Resetting it starts a new installation epoch, which downstream legitimately reads
as a new installation.

Export credentials live in a daemon-owned table, never in the config blob. They are resolved at
send time and appear in no read path, no settings snapshot and no exported payload. Telemetry
configuration is deliberately excluded from settings snapshots altogether: consent is not a
portable setting, and restoring a snapshot from another machine must not be able to turn
collection on.

### Where a credential may travel

Enforced identically at configuration time and at the wire boundary, because a rule checked in
only one of those places is a rule an operator can save past:

- A credential-bearing export to a non-loopback endpoint requires HTTPS.
- A loopback HTTP Collector is supported, credential or not. Every local Collector is one.
- A remote plaintext endpoint with no credential is allowed and flagged.
- Credentials in the URL are refused; use the header field.
- A redirect that changes origin, or downgrades to remote plaintext, drops the credential.
- `OTEL_*` environment variables are never mutated, so no agent subprocess inherits an exporter
  endpoint or credential.

## Organization defaults

On a machine an organization's device management identifies, Mission Control manages the
**Product analytics** destination for that organization. Off by default still holds everywhere
else. Today the only organization is Upstart, and [Running Mission Control at
Upstart](upstart.md#telemetry-to-upstarts-datadog) covers what is detected and how pilot
volunteers enroll. Everything an organization contributes - its device management hosts, its
preset, its rollout - is one entry in `src/server/environment/organizations.ts`.

**Detection** runs once at daemon start, before the telemetry cycle starts, and again on
**Re-check** (`POST /api/telemetry/organization/recheck`). The result is cached in memory, so no
request runs a subprocess. `MISSION_ORGANIZATION=none` turns detection off.
`MISSION_ORGANIZATION=<id>` forces an organization only when `MISSION_ORGANIZATION_ENDPOINT` is
a loopback URL, which then replaces the preset endpoint. Otherwise the force is ignored and
logged. Both are diagnostic overrides, not Settings controls.

**Apply.** The first time an organization is recognized, the whole previous Product analytics
destination and the master switch are kept in the `telemetry.organization` record. In the same
transaction, the destination is replaced by the preset (endpoint, temporality, network gate,
acceptance window and export shape) and switched **off**, whatever it was. The endpoint change
bumps the destination generation, which fences batches queued for the old endpoint, and the
switch-off drops them, so nothing queued for the previous collector can reach the
organization's gateway. The master switch does not move. Every write goes through the same
`setTelemetryConfig` path as a person's edit, attributed to the daemon.

**Keep in step.** Every later start and Re-check writes every preset field again, so a newer
preset version replaces the old one. An identical configuration stores nothing. While the
rollout is `pilot`, the destination is on exactly when the Mac has joined the pilot
(`POST /api/telemetry/organization/pilot` with `{"enrolled": true}`). Joining also turns the
master switch on. Leaving turns the destination off and puts the master switch back to its
value before first application.

**Withdraw.** When a Mac that has a record is no longer recognized, the previous destination,
including its own switch, and the previous master switch are restored in one write, and the
record is deleted. A destination that was on before is on again, under a new consent epoch.
Data a backend already accepted is not recalled. In the rare case that the old destination no
longer passes the transport rules, it is cleared and left off rather than leaving the
organization's preset in place. A record this build cannot read (corrupted, or written by a
newer build) still proves the destination was managed, so withdrawal clears and switches off
the Product analytics destination before deleting it. On a Mac that is still managed, such a
record is rebuilt with a cleared, switched-off destination as what withdrawal will restore,
never the gateway configured at that moment.

If the withdrawal write itself fails (a full or locked disk, say), the Mac stays locked until a
later start or **Re-check** succeeds. The daemon publishes "unmanaged" only once the record is
gone, so settings stay view-only over a destination that may still name the gateway. Settings
shows "Removing <organization>'s telemetry settings", the pilot route answers 409, and Product
analytics export is suspended so nothing reaches the gateway in the meantime. Local collection
and the person's own backend keep running.

More generally, while an organization holds the lock, Product analytics sends only when its stored
endpoint is the organization's managed endpoint. If the first application's write fails, the
person's previous destination stays stored, but nothing is sent to it while the panel says the
Mac is managed. The next successful start or **Re-check** writes the preset.

**The lock.** While an organization is active, `PUT /api/telemetry/config` and the `purge` and
`reset_identity` operations answer 403 with
`{"error": "Telemetry settings on this Mac are managed by <organization>", "managedBy": "<id>"}`,
and Settings > Telemetry renders view-only. The `retry` operation, the connection probe, the
pilot route and Re-check still work, because none of them is a settings edit. The daemon's own
apply path is not a request, so the lock never blocks it. Nothing outside Settings > Telemetry
is locked. `GET /api/telemetry/config` reports the active organization as `organization`, or
`null`. These routes, and the pilot route, wait for any detection still in flight, including
the startup detection. A managed Mac therefore never shows an editable panel or accepts a
write in the moment between the daemon listening and its recognition finishing. Detection is
bounded at two seconds, so this delays an answer and never withholds one.

## The durable path

```text
owner completes its work
  -> capture(): validate, minimize, attach immutable context, commit a journal row   [accepted]
  -> projection: reduce a bounded slice into durable cumulative state + immutable batches
  -> delivery: lease one batch per destination and signal, send, record the result
  -> OTLP/HTTP endpoint
```

**Accepted means committed.** `capture()` returns `accepted` only after a journal row is durably
written, does no network I/O, and never throws: a source hook sees accepted, duplicate, disabled or
refused, and a telemetry failure never rewrites a successful business result.

**There is a pre-acceptance gap, and it is not closed.** A crash between a business commit and the
capture call loses that fact. Closing it would mean attaching telemetry work to every business
transaction, which the design rejects; the honest alternative is to measure the gap, which is what
the `capture_refused` and `unknown_gap` counters in the health view are for.

**The journal is processed once.** Cumulative totals live in a durable table keyed by profile,
consent epoch, resource and dimensions. Retries operate on immutable batches. Nothing replays
journal events through live counters, which is the failure that would double every metric on every
reboot.

**Deduplication outlives the payload.** Source identities live in their own table with a longer
window than the payloads, because a unique key on a row that later gets pruned is not durable
deduplication - the same expired historical source would be admitted again as fresh activity.

Crash boundaries covered by `test/telemetry-durability.test.ts` and
`test/telemetry-transport.test.ts`: crash after journal commit and before projection; crash inside
a projection pass; crash after remote acceptance and before local acknowledgement; upgrade with
batches still queued; one destination offline and the other healthy; consent withdrawal with work
in flight; a long offline period under age and byte pressure; partial success; a poison batch; an
unknown schema version; and a controlled shutdown.

### Extension seams

Later phases add coverage through two separate registries, and neither writes into the other's
tables:

- `registerTelemetrySource` - an owner that captures facts. It must declare what a restart can
  recover and what becomes permanently unknown; a post-restart scan of a current session cannot
  reconstruct the model it was running an hour ago, and saying so at the registration site is what
  keeps the next phase from assuming otherwise.
- `registerTelemetryProjection` - a bounded, versioned, checkpointed reducer over the journal, with
  its own namespaced state rows and its own state migration. Phase 6's analytical reducers register
  here; the `snapshot` hook is where cohort gauges are published.

A reducer is handed a `TelemetryEnvelope` - the semantic record - and never the stored journal row
the engine hydrated it from. A reducer that compiled against the stored row would have to be edited
whenever the journal's storage or hydration changed, despite having no opinion about either, and
nothing would stop it reading `seq`, `profiles` or `epochs`: engine bookkeeping that answers "which
pass, and under which consent epoch" rather than "what happened". The engine converts once, before
it calls anything registered here, and keeps that bookkeeping to itself.

Event and instrument definitions live in `src/shared/telemetry-catalog.ts`. Every feature group
across all six design areas is already declared there with its owning phase, so a later phase adds
entries to an existing group rather than coining a parallel taxonomy. Instruments declare an exact
dimension allowlist; unbounded identities and content-bearing keys are refused by a catalog test
rather than by review.

### Workflow sources

[Workflow telemetry](observability-workflows.md) documents Phase 4 ownership, counting,
reason categories, actor coverage, transaction boundaries and the independent Phase 5/6
extension points.

### Session, model and outcome sources

Phase 3's owner map. Every row states three things a later phase needs and cannot infer: which
code owns the observation, what identity it deduplicates on, and what a restart cannot rebuild.
The last column is the one worth reading before building anything on top of these: a post-restart
scan of a live session reports the model it is running NOW, and nothing durable records what it
was running an hour ago.

| Event | Owner | Deduplicates on | What a restart cannot rebuild |
| --- | --- | --- | --- |
| `mission.session.started` | `telemetry/sessions.ts` observer | `start:<session id>` | A session that started and ended while capture was off. Re-adopting a live session after a restart updates continuity rather than counting a second session, because the identity is durable. |
| `mission.session.restore.finished` | `sdk/supervisor.ts` | `restore:<session id>:<at>` | A restoration whose result was never captured. |
| `mission.dispatch.finished` | `dispatcher.ts` | `<task id>:<attempt start>` | The resolved model and effort. They are computed in memory at launch and persisted nowhere a scan could read. |
| `mission.session.segment.opened` | `telemetry/sessions.ts` observer | `segment:<session id>:<observation id>:<sequence>` | Segments during a gap. Each adoption opens a new observation interval with a random id, so its first segment cannot collide with one captured before restart. Repeated metadata within that interval opens no segment. |
| `mission.session.effort.selected` | `routes.ts` `POST /api/sessions/:id/effort` | `effort:<session id>:<at>:<level>` | A selection that was never captured. It is an operator action, not a durable record. |
| `mission.session.operation` | `routes.ts` send, interrupt and the two option routes | `op:<session id>:<operation>:<at>:<n>` | The same. |
| `mission.session.turn.finished` | `telemetry/sessions.ts` observer | `turn:<session id>:<observation id>:<n>` | A turn spanning a gap is reported with `observation_bounded`, which makes its duration a lower bound rather than a measurement. The observation id prevents post-restart turns from colliding with earlier turns. |
| `mission.session.ended` | `telemetry/sessions.ts` observer, on `session_remove` | `end:<session id>` | A departure during a gap. |
| `mission.session.kill.requested` | `routes.ts` `POST /api/sessions/:id/kill` | `kill:<session id>:<at>` | An uncaptured request. |
| `mission.usage.recorded` | `usage.ts`, `spend-ledger.ts`, `registry.ts` - the three ledger writers | The ledger's own conflict target | Rows committed while capture was off. They are deliberately not re-read: a later opt-in may not widen the audience of facts captured before it. |
| `mission.task.outcome` | `telemetry/sessions.ts` observer, on `task_upsert` | `<task id>:<durable observation interval>` | Which intermediate statuses a task passed through while collection was off. The terminal row is recovered on its next publication. |
| `mission.pr.observed` | `telemetry/pr-observations.ts` | `<task id>:<pr key>:<fact>` | An association made while capture was off. A retained association itself survives restarts in its own table until the late-outcome horizon. |

Three rules hold this together and are worth stating separately, because each of them is a
number a dashboard would otherwise get confidently wrong.

**Effective is not requested.** A level the driver accepted for the NEXT turn does not move the
running turn's attribution. Each turn freezes its effort, quality, segment and conversation
when it first enters `working`; later metadata updates apply to subsequent turns. Segments
open on an OBSERVED change only, `quality` says how strongly the value is known, and `unknown`
and `unsupported` are never narrowed into a level - a harness with no effort knob and a
session nobody has read yet are different answers. Dispatch model and resolution source
come from one evaluation of the shared model ladder.
Changing collection consent clears in-memory observation windows. After opt-in, the next
publication of an existing session opens a bounded first observation and segment. Turns and
launch intents from before consent are not replayed, and re-consent does not count another
session adoption.

**A session ending is not a task outcome.** They are separate events with separate owners.
`TaskManager` settles a departed task as `failed` while documenting that a clean exit cannot be
told from a crash, so that row exports `status=failed` with `completion_evidence=missing`, and a
product dashboard must not turn the pair into a measured correctness failure.
For terminal handoffs, `sdk/handoff.ts` marks the departure after preflight and before stopping
the driver, so removal during that stop still records `reason=handoff`. A failed stop with a
surviving driver clears the marker. A stopped driver retains its handoff reason even if the
terminal fails to open; the task outcome describes that failure separately.
An accepted kill remains an action fact even when the session survives. Its departure marker
clears on stop-failure restoration, cancelled eviction, or a later handoff, and otherwise
correlates removal for at most one minute. Later unexplained departures retain `unknown`.
Failed and superseded dispatches discard unused launch intents so a retry cannot inherit
their model, effort, or task. A non-terminal task publication clears its prior settlement
marker so a retry's departure can report that work is still open.
`telemetry_task_outcome_state` preserves each task's current observation interval across
restarts. Reopening or changing dispatch time rotates it; terminal cleanup updates retain it,
even if they rewrite completion timestamps. An immediate cancellation after reopening gets
its own outcome. This source state is charged to the telemetry byte budget and expires after
the same 30-day inactivity window as deduplication state.
Restored SDK sessions retain the supervisor row's durable task association for session,
segment, turn, usage and departure facts. A missing task row preserves the ID with unknown
task kind; it does not turn the session into a taskless one. Restoration also preserves any
unrelated dispatch intent waiting for a new session in the same checkout.

**Late delivery survives ownership invalidation, and gains no authority by doing so.**
`invalidateTaskOwnershipInTransaction` deletes a task's work-episode binding without archiving it,
so after a rotation `mergedPrFor` reads nothing and `taskPrPollTargets` stops harvesting the URL.
Telemetry retains its own bounded observation of each verified association, keyed by a digest, and
the daemon's existing pull request poller asks about those URLs on the same cadence -
deduplicated, so a pull request wanted by both harvests still costs one `gh` call. An
observation-only result emits the late-delivery fact and nothing else: it does not enter
`mergedPrFor`, complete a task, or satisfy a dependency edge. The URL never leaves the daemon;
`test/telemetry-pr-late-outcome.test.ts` pins both halves.
Live delivery requires the retained author's current task/session binding to own that PR;
secondary repositories also match the current episode and repository. Another task or a
dependency polling the same URL does not make an old author's observation live.
Merge observations remain pollable until capture is durably accepted or recognized as a
duplicate. A transient capture refusal or failed completion stamp can therefore retry after
a restart without losing or double-counting the merge.
The retained context also freezes the initial association fact and its capture status. A
later sighting or the shared poll cadence retries a pending association using its original
time, author and creation evidence, even if the merge has already been captured. Retries
remain bounded by the same retention horizon and 500-row poll limit.
Retained PR URLs, frozen context and row metadata count toward the total telemetry byte
budget, including the cached admission estimate immediately after insertion.
Expiry removes settled observations without reporting a gap. Only an uncaptured association
or a missing merge verdict counts as incomplete coverage at the late-outcome horizon.
Changing collection consent retires retained PR observation windows in the same transaction.
Re-enabling cannot resume their polling or pending capture across the gap. Previously captured
facts and operational PR ownership remain intact; a fresh association starts a new window.

## The local reference stack

Four pinned long-running containers, all published on loopback only, plus a one-shot
`queue-permissions` initializer that runs to completion before the Collector starts and then exits.
It reuses the Grafana image to `chown` the Collector's persistent queue volume, because the
Collector runs as uid 10001 and refuses to start rather than falling back to an in-memory queue.

The stack is optional, independent of the app's lifecycle, and not part of the Electron package:
Mission Control goes on capturing when the whole thing is stopped.

```sh
npm run observability:up       # start, then wait until every component reports ready
npm run observability:status
npm run observability:verify   # validate compose + prometheus config/rules with the pinned tooling
npm run observability:down     # stop; data volumes survive
npm run observability:reset    # stop AND destroy every data volume
```

| Component | Version | Host address |
| --- | --- | --- |
| OpenTelemetry Collector (contrib) | `0.160.0` | `http://127.0.0.1:14318` (OTLP/HTTP) |
| Prometheus | `v3.14.0` | `http://127.0.0.1:19090` |
| Grafana Tempo | `2.10.8` | `http://127.0.0.1:13200` |
| Grafana | `12.4.10` | `http://127.0.0.1:13000` |

Point Mission Control at `http://127.0.0.1:14318` and open
`http://127.0.0.1:13000/d/mission-adoption`. The compatibility diagnostic remains available at
`/d/mission-telemetry-diagnostics`. Both data sources and all dashboards are
provisioned from files; nothing is imported by hand, and dashboards are not editable in place so a
browser edit cannot silently diverge from the repository.

From the app, that is four steps in **Settings > Telemetry**:

1. Switch on **Collect telemetry on this machine**. Nothing leaves yet.
2. Put `http://127.0.0.1:14318` in **Endpoint** and press **Save destination**. A loopback
   Collector over plain HTTP is the supported case, credential or not.
3. Switch on **Send to your own backend**.
4. Press **Test connection**. It sends a real, empty OTLP request and captures its own result
   through the durable path, so a green answer is evidence about the whole pipeline rather than
   about a separate code path that happens to speak HTTP. The trace id it hands back is the one
   Tempo will store, so it is searchable once the next export lands.

The probe is synthetic, and the panel says so where it reports the result: it is a connection
check, not a record of anything the app did. The daemon does not create an event per export
attempt. Bounded destination-health gauges are captured at most once per 30-second bucket,
under the same consent and storage limits as other telemetry.

Container-to-container traffic uses service names (`http://collector:4318`); the host uses the
published ports above. Mixing the two up is the most common way this stack appears broken.

### Settings that are load-bearing

- **Prometheus OTLP receiver** is off by default and enabled with `--web.enable-otlp-receiver`.
  Without it `/api/v1/otlp/v1/metrics` returns 404, which the exporter reports as a configuration
  fault and which looks exactly like a wrong URL.
- **Metric name translation is pinned** to `UnderscoreEscapingWithSuffixes`, so
  `mission.daemon.starts` lands as `mission_daemon_starts_total`. `promMetricName` states the same
  mapping in code and a unit test asserts it, so a receiver default moving fails a test instead of
  emptying a panel.
- **`out_of_order_time_window: 8d`** is one day longer than the app's queue. Without it a laptop
  that was offline for a week drains successfully, gets 200s the whole way, and has every sample
  silently refused as too old.
- **The Collector's queues are persistent**, backed by a volume, with no asynchronous batch
  processor before persistence. An in-memory buffer would add a loss window after an ACK.
- **Tempo's `max_duration`, `block_retention` and WAL `ingestion_time_range_slack`** reach past
  the app's queue window, or an old trace can be missed by time-bounded search after block flush.

### Verifying it end to end

```sh
MC_OBSERVABILITY_MODE=test npm run observability:up
MC_OBSERVABILITY_MODE=test npm run test:telemetry-stack # actual backends in the isolated test project

npm run build
MC_OBSERVABILITY_MODE=test MC_E2E_OBSERVABILITY=1 npm run test:e2e -- \
  e2e/specs/telemetry-diagnostics-dashboard.spec.ts --workers=1
```

Neither skips silently. The integration test fails with the command to start the stack; the browser
spec skips only when `MC_E2E_OBSERVABILITY` is unset and says so, because ordinary CI has no Docker.

## Measured costs

Measured on an Apple M-series laptop, Node.js 26, 5,000 synthetic events with collection on and one
export destination configured. These are this build's numbers, not a guarantee.

| Measure | Candidate target | Measured |
| --- | --- | --- |
| Capture p95, collection off | - | 0.007 ms |
| Capture p95, collection on | under 2 ms added | **0.65 ms** (0.64 ms added) |
| Capture p99, collection on | - | 0.85 ms |
| Projection cost | - | 0.14 ms per event |
| Logical bytes per event | - | **728 B** (journal, batches, aggregates, contexts, resources, delivery bookkeeping and durable dedupe) |
| Physical database growth per event | - | ~1.0 kB including WAL |
| Local stack, idle | - | ~290 MiB RSS total, ~1% CPU (Tempo 103, Grafana 101, Prometheus 51, Collector 36 MiB) |

At 728 B per event the 256 MiB logical budget holds roughly 370,000 events, which the seven-day age
limit will normally reach first. The figure covers every table the budget charges, including the
durable dedupe identities - the one table that keeps growing after payloads are pruned, since it is
retained for 30 days against the payload window's 7.

### Retention and limits

| Limit | Value | Why |
| --- | --- | --- |
| Payload retention | 7 days | Bounds the bytes: journal facts and undelivered batches are the large objects. Settled delivery bookkeeping is swept on the same window, so the per-batch `accepted`, `rejected` and `expired` counts in the health view describe the retention window rather than the installation's whole history. |
| Reducer/dedupe state retention | 30 days | Bounds the identities. The rolling cohorts later phases need a 30-day lookback for, and an expired source must not be importable again as fresh activity. |
| Total logical budget | 256 MiB | Charged across contexts, journal, aggregates and both destination queues. |
| Series per instrument / per profile | 2,000 / 10,000 | Beyond it, dimension values fold into an explicit overflow bucket. The total stays correct; only the breakdown degrades, and a gap counter says so. On a budgeted destination, a retired app version's idle series are pruned after 30 days, so they stop counting. |
| Weighted series per budgeted destination | 1,500 under `datadog-lean` | Live at once, and exported in any clock hour. See [Export shapes](#export-shapes). |
| Event payload | 16 KiB | |
| Request payload | 1 MiB | Prevented at build time rather than split afterwards. |
| Collection and export cadence | 30 s | |
| Retry backoff | 1 s to 60 s, jittered, `Retry-After` honoured | |

A batch parked for a superseded endpoint keeps its payload so Phase 2 can offer the keep,
discard or transfer choice, and is released on the same seven-day window once that choice has
gone stale.

The stricter of age and capacity wins. Shedding under capacity pressure re-checks the budget
between every drop and stops as soon as it is back under the mark, so a brief overshoot costs
the oldest batch or two rather than the whole queue. Loss is always counted and visible in the
health view - and
where a failure prevented even the counter from being written, recovery reports an **unknown** gap
rather than claiming a precise number.

That invariant reaches exactly as far as the daemon can see, and where it ends is worth saying
plainly. A batch is accepted, and its copy released, the moment the Collector returns 200 - the
Collector owns it from there, and nothing it does afterwards can reach the health view. So the
reference stack retries transient backend failures with **no elapsed-time ceiling**
(`max_elapsed_time: 0`). A ceiling would expire queued items during a long Prometheus or Tempo
outage - a Docker Desktop restart, a sleeping host, a maintenance window - and that loss would
appear only in the Collector's own logs while the health view still read zero gaps. Retrying
indefinitely turns the same outage into backpressure instead: the persistent queue fills, enqueue
begins failing, the OTLP receiver answers the daemon with an error, and the daemon keeps its own
copy. Permanent downstream rejection and storage failure can still lose data after an ACK;
those failures are visible in Collector logs, not retrospectively in the daemon's accepted count.
The [dashboard acceptance guide](observability-dashboards.md#storage-and-delivery-limits) describes
the tested boundaries.

A different backend, configured by an operator, keeps its own promises. The daemon's guarantee is
about what it accepted and has not yet handed over.

A logical quota inside `harness.db` is not a hard cap on the file or its WAL. Deletes free pages
for reuse without shrinking the file, and no whole-database compaction is ever run to reclaim
telemetry space while sessions are active.

## Decisions worth knowing

### Why the exporter does not use a MetricReader

The obvious integration - attaching a durable queue as a `metricProducers` entry on a
`MetricReader` - is wrong here, and quietly so. That option is experimental and its documented
behaviour is that the reader REPLACES an additional producer's resource with its own. A batch
queued before an upgrade and drained after one would therefore be exported stamped with the running
binary's `service.version`, moving yesterday's work into today's release cohort - the exact
misattribution the design forbids.

Instead the exporter uses `@opentelemetry/otlp-transformer`'s public `ProtobufMetricsSerializer`
and `ProtobufTraceSerializer`, which accept a `ResourceMetrics` and a `ReadableSpan[]`. A persisted
batch is rehydrated into those shapes with its OWN resource and its OWN timestamps. No SDK
internals are deep-imported and no OTLP protobuf is hand-written. The package versions are pinned
exactly, because this leans on the shape of two public interfaces and a caret range is how that
stops being true quietly.

`test/telemetry-contract.test.ts` asserts the resource and timestamps survive; the stack test
asserts a historical `service.version` arrives at Prometheus as its own stream.

### Why telemetry lives in `harness.db`

A separate telemetry file buys one thing - an independently enforceable disk quota - and costs
four: its own version, recovery, upgrade and backup lifecycle, its own ownership story, and the
property the whole design rests on, that a projection checkpoint, its aggregate state and its
output batch commit in ONE transaction with the writer that already serializes every other write in
the process.

The quota argument is also weaker than it looks, since a logical quota in a shared file is not a
hard cap on the file either way. The measured envelope above - 728 logical bytes per event against
a 256 MiB budget - is small enough that the budget plus the retention sweep bounds it adequately.
If a later phase needs a hard disk cap, the store interface is the seam to move; nothing above it
names a file.

### Why cumulative, and what a duplicate delivery does

The durable aggregate is cumulative with a preserved stream start time, so a restart continues the
stream rather than looking like a reset. It also makes the ambiguous-acknowledgement case - a crash
after the server accepted a request and before the local acknowledgement - idempotent by
construction: replaying the same immutable snapshot writes the same value. The stack test asserts
exactly that against a real Prometheus.

A changed app version is a different OTLP resource and therefore a different stream with its own
start time. A new line appearing on a chart at an upgrade is correct behaviour.

Delta is an explicit per-destination alternative for backends such as Datadog. Counters and
histograms are differenced against a durable per-series watermark; zero deltas are omitted. Gauges
are sent when they change and at least hourly while their source remains current. Each delta window
starts at the previous exported end and ends at the projection pass clock, so a late fact belongs
to the pass that projected it rather than reopening an earlier time window. Changing an endpoint or
switching to delta advances the destination generation and baselines existing series, so the new
destination never receives the installation's cumulative history.

Delta gives up cumulative replay's overwrite behavior. A delta batch lost to expiry, pressure,
permanent rejection, partial success, or a stale-generation fence is lost data. Re-sending a delta
batch after an ambiguous acknowledgement repeats that delta unless the backend overwrites the same
series and timestamp. Those cases remain visible through existing retry and gap accounting; the
exporter does not guess or reconstruct. Destinations that do not opt in remain cumulative, and
their durable batch JSON and earlier delivery guarantees are unchanged.

### Export shapes

Each remote destination names an **export shape** (`exportShape`), which changes what that
destination receives without changing what the local store, the other destination, or any span
receives. Settings > Telemetry has an Export shape select beside Metric temporality for both
destinations. The registry is `src/shared/telemetry-export-shapes.ts`, and
`exportedInstruments(shapeId)` is the only statement of what a shape exports. Anything that needs
the list, such as a dashboard validator, reads it from there rather than restating it.

- **`full`** is the default and the identity. A destination that never names a shape exports
  exactly what it exported before shapes existed, byte for byte, and
  `test/telemetry-export-shape-projection.test.ts` pins that against a fixture taken from the
  earlier build.
- **`datadog-lean`** bounds what a Datadog destination is billed for. Datadog bills each distinct
  metric name and tag combination in every hour it reports, so this shape cuts the combinations
  rather than the facts:
  - **No cohort gauges.** `mission.analytics.v1.*` is left out. Those gauges serve the Grafana
    dashboards' PromQL coherence checks. They report every hour by design, and they dominated the
    estimated bill.
  - **Labels trimmed on the largest activity metrics.** Removed from `mission.dispatches`:
    `resolution_source` and `resolved_effort`. Removed from `mission.action.count` and
    `mission.automation.actions`: `actor`. Removed from `mission.sessions.ended`:
    `ended_while_work_open`. Removed from `mission.session.segments`: `quality` and `reason`.
    Removed from `mission.sessions.started`: `start_observation`. Removed from
    `mission.session.operations`: `actor_basis`. Removed from `mission.session.turns`: `quality`.
    Removed from `mission.session.effort.selections`: `applies`. Contributions that differ only
    in a dropped label aggregate into one series. Every dropped label is still on the matching
    span, either as a span attribute or, for `actor`, as `mission.actor.kind`, which every span
    carries. A test refuses a shape that drops a label no span carries.
  - **Distributions only where percentiles matter.** `mission.session.turn.duration`,
    `mission.dispatch.duration`, `mission.workflow.duration` and `mission.workflow.node.duration`
    stay histograms. Every other histogram is exported as a `<name>.sum` counter, in the
    histogram's unit, and a `<name>.count` counter, in `1`. Those still give averages, at 2
    custom metrics per combination instead of a distribution's 9. For the product audience, that
    is seven histograms. `mission.connection.downtime` is operator-only, so it is split only for a
    lean destination of your own.
  - **One constant host.** Every metrics batch, and the connection probe, carries the resource
    attribute `datadog.host.name = mission-control`. Without it, Datadog tags each point with
    whichever gateway pod received it, and one installation's series split across pods.
    Installations stay distinct through `service.instance.id`. Spans are not changed.
  - **A series budget of 1,500 weighted series.** A distribution weighs 9, a sum-and-count pair
    2, and a counter or gauge 1. The distribution weight is 9 while the gateway keeps
    `send_aggregation_metrics: true`, and 5 if it is turned off; it is one number in the shape
    record.

**The live-series budget.** A series is live while its last contribution or export, measured on
the projection pass clock, is within the 7-day payload window. Every series that is not live
right now must be admitted, whether it is new or a stored series that aged out and reports again.
Each `(resource, instrument)` pair has at most one overflow series, with every kept label set to
`__overflow__`. A pair with a live series reserves that overflow series' weight until the
overflow series is live itself. A series is admitted only if live weight, plus reservations, plus
its own weight, plus its pair's reservation if the pair has none yet, stays within the budget.
What does not fit folds into its pair's overflow series, which is already paid for, and records
`series_overflow`. If the pair has neither a live series nor a live overflow series, the
contribution is dropped and counted as `budget_exhausted`. A refused resume leaves its stored row
untouched, so once it is admitted again, its next delta excludes everything that went to overflow
meanwhile. Committed weight is read from `idx_telemetry_series_live` at a pass's first admission,
never kept as a running counter, so a series that ages out frees its room without a sweep. A
stored series that is carried into a pass without a contribution, because it is waiting or due a
heartbeat, is admitted the same way before it is exported, since exporting it makes it live again.
If there is no room it keeps waiting, with its watermark untouched. The 2,000 and 10,000
ceilings above still apply to every shape.

**The hourly export ledger.** The live budget bounds one shape and one consent epoch. Datadog
counts an hour, and a shape change or a consent change part-way through it does not start the hour
again. So a budgeted destination also records, in `telemetry_export_hours`, each distinct series
it exported in each UTC clock hour of point time, and its weight. The ledger is keyed by profile
and hour, never by shape or epoch, and it survives restarts. A point for a series already in the
hour's ledger always goes out. A point for a new series goes out only if the hour stays within the
budget. Otherwise it waits: its watermark does not move, so a counter's delta arrives whole in a
later hour, and a waiting gauge sends its then-current value. Each wait is counted once as
`hourly_cap_deferred`. Waiting series are carried by later passes even when nothing new happens.
A waiting cumulative point is sent stamped with the pass clock rather than its latest event time.
Otherwise every retry would ask the same full hour for room. Its value is unchanged, because the
total at that moment is the total at its latest event. A series takes room in an hour's ledger only
when its batch is actually queued, and a cumulative export keeps a budgeted series live just as a
delta export does.
A cumulative point carries its latest event's time, so a fact projected hours late still lands in
the hour it happened in. The ledger therefore keeps each hour for
`TELEMETRY_LIMITS.exportLedgerRetentionMs`, the 7-day payload window plus one hour. That is as long
as a captured fact can still be projected into it, so a delayed fact is charged against what its
hour already used. A cumulative point whose hour is older than that is stamped with the pass clock
and charged to the current hour, whose allowance is on record, with its value unchanged. Retention
sweeps older rows, and every row is charged to the byte budget: at most one row per distinct series
exported in each hour. The one case the ledger cannot control is how Datadog attributes a backlog
delivered late, for example after a day offline with Historical Metrics Ingestion enabled.

**Changing a shape** starts that destination's metric series again from zero, and Settings says so
under the select before you save. In the same transaction as the config write, the destination
generation advances, which fences queued batches of the old shape exactly as an endpoint change
does. The profile's `telemetry_series` rows are also deleted, and a `shape_changed` gap is
recorded. That is a complete reset because every counter and histogram total, and every delta
watermark, lives in those rows. The catalog projection holds no reducer state, and a projection
may not keep cumulative totals in its own state; the rule is on `registerTelemetryProjection`.
Projection checkpoints are kept, so facts already projected are not counted again, and facts
captured but not yet projected count once, under the new shape. The analytical projection's
gauges are recomputed from its retained facts, so they return with their current values when a
destination switches back to `full`. The consent epoch does not move, and the hourly ledger is
kept.

**Pruning.** For a destination whose shape has a series budget, retention deletes series whose
resource is not the running process's resource and whose last activity is older than the 30-day
reducer window. A resource is an app version, so these are series a running build can no longer
contribute to, and otherwise they would count against that destination's ceilings forever. The
running resource's series are never pruned, at any age. Each pass reports the count as
`prunedSeries`. A `full` destination and local-only collection are never pruned. A pruned series
whose version runs again, for example after a rollback, restarts its cumulative stream from zero,
and only a budgeted destination accepts that, because it needs the room. For any other destination
a retired version's series still count toward the 10,000-series profile ceiling, as they always
have.

### What is not proven

- Only Prometheus and Tempo at the pinned versions above have been tested, on macOS on Apple
  silicon, with Docker. Other backends, other architectures and other versions are unverified.
- Metric exemplars are not claimed. The Grafana data source is provisioned for them so drill-down
  works the moment the exporter and receiver path is shown to carry them; today trace navigation
  goes through the Tempo search panel.
- The 30-day reducer window is enforced but has not been exercised over a real 30 days.
- Throughput was measured single-process and synthetically, not under a fleet of live sessions.

## Troubleshooting

**A panel says "no exports yet".** That is different from a zero. It means nothing matched the
query in the selected range - commonly because the installation filter is pinned to an installation
that has not exported that metric. `GET /api/telemetry/health` reports this installation's id, its
queue depth and any pause reason, which tells a stopped export apart from a quiet installation.

**Nothing arrives, and health shows a growing queue.** Check `pausedReason`. `auth` and
`configuration` mean the destination refused and the daemon stopped rather than hammering it; fix
the endpoint or credential and clear the pause by saving the configuration again. `quota` means it
throttled ten attempts in a row, with or without a `Retry-After` to say for how long; reduce what
is being exported or raise the backend's limit, then save the configuration again to resume. A
plain outage or server fault never pauses, so the backlog drains by itself when the link returns.
If `waitingForNetwork` is true, a configured Cloudflare edge recognized the current network as
outside its allowed path. No credential pause was applied; reconnect to the required network and
the queue will retry on its own.

**A backlog drained but old samples are missing.** Prometheus refuses samples older than its
out-of-order window. Eight days is configured here. For other destinations, set `lateAfterMs` to
their documented window and inspect `latePointsSent` plus the `late_points` gap. These points are
still sent, and the counter makes exposure beyond the configured age window visible. Whether the
backend accepts historical points remains the backend's decision.

**`docker compose` hangs with no output at all.** Docker Desktop's CLI hints and interactive
Compose menu make network calls before running the command, and a machine where those calls hang
produces exactly this. `npm run observability:up` already disables both; a raw `docker compose`
invocation may need `DOCKER_CLI_HINTS=false COMPOSE_MENU=false`.

**The Collector refuses to start over its queue directory.** That refusal is correct - it will not
fall back to an in-memory queue. The `queue-permissions` one-shot service in `compose.yaml` gives
the volume to the Collector's user; if you removed it, put it back.

See [primary actions and safe errors](observability-actions.md) for Phase 5 source semantics, the operation inventory and coverage limits.
