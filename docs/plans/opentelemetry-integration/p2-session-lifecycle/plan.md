# P2. Session, task and execution attribution

Draft design recommendation. Parent: [planning brief](../plan.html). Shared terms and audience policy: [P0 data contract](../p0-data-contract/plan.html).

## Decision this area owns

Preserve what was actually known about a session when work happened. Model choice, session existence, task completion and PR creation are independent facts. Telemetry must follow the current lifecycle owners while retaining enough context to compare results across changes.

## Identity graph

| Identity | Meaning | Transition rule |
| --- | --- | --- |
| Telemetry installation/consent epoch | One opted-in installation identity period | Reset/re-consent can rotate it; never a person/account ID |
| Daemon boot | One running process | Changes on restart; useful for operational errors and gauges |
| Session instance | One Registry-owned runtime entry | A new entry for SDK-to-terminal handoff; not derived remotely from PID/tty |
| Logical conversation | Harness conversation identity | May rotate on context clear; unknown until observed |
| Work episode | Provenance of work across current bindings | Reuse the existing episode owner; do not equate with every work turn |
| Task | Durable intended work | May span sessions and multiple repositories |
| Execution segment | Time interval with stable effective execution metadata | Opens on meaningful observed change, not every metadata refresh |
| Workflow binding/run | One association or one execution of a workflow version | Several may attach to one session/task; use explicit links |
| Repository PR association | Proven per-repository delivery outcome | Late updates survive the original session's removal |

The current Session interface explicitly distinguishes Registry ID, runtime and harness session ID. Work-episode interfaces retain PR and merge facts. These are verified source contracts. [Session types](../../../../src/shared/types.ts), [work episodes](../../../../src/server/db.ts).

Proposed relationships: task -> work episode -> session instance; session instance -> logical conversation and execution segments; workflow run -> frozen submission context -> relevant work episode/segments; task/work episode -> one or more repository PR associations. Persist only the telemetry projection of these links, not another binding mechanism.

## Launch, discover and resume are different observations

Emit `session.created` for an app-owned launch after actual runtime creation, linked to the dispatch operation. Emit `session.first_observed` for a discovered external session. Do not manufacture its original start time: record process-reported timing separately with source quality, and report an observation window.

A reconnecting dashboard and an SSE snapshot emit neither event. A daemon restart that re-adopts the same proven session updates observation continuity, not new-user or new-session adoption. When identity cannot be proven across restart, report a new observation with continuity unknown rather than deduping by directory/name.

Managed restoration is a separate operation with requested/succeeded/failed results. An inert restoring projection is not yet a usable session. Record restoration duration and outcome at the supervisor, and only measure usable-session counts after Registry admission.

Dispatch records requested/default-resolved choices at the dispatcher's model/effort resolution boundary, then actual runtime and first authoritative execution metadata later. A launch request that fails never becomes a started session.

## Requested, pending and effective execution

The source already exposes observed model ID, `thinkingLevel`, `nativeEffort`, metadata source and observation time. It also distinguishes a successful effort selection from when that selection takes effect: some driver changes are next-turn pending. [Effort route](../../../../src/server/routes.ts), [Registry effort reconciliation](../../../../src/server/registry.ts), [dispatcher resolution](../../../../src/server/dispatcher.ts).

Proposed execution snapshot fields:

| Field group | Fields and semantics |
| --- | --- |
| Request | Model/effort requested, inherited/default-resolved value, resolution source, requested time |
| Acceptance | Accepted/rejected, pending/current applicability, acceptance time |
| Effective | Catalogued model ID, normalized effort, optional allowlisted native effort, observed time and source |
| Quality | `observed`, `launch_resolved`, `unknown`, `unsupported`; freshness at capture |
| Scope | Harness, runtime, segment ID, conversation identity, work-turn identity when known |

Do not set `effective_effort=high` merely because the API accepted a request. Example timeline:

| Time | Event | Attribution |
| --- | --- | --- |
| 10:00 | Turn A starts on medium effort | Segment S1: medium |
| 10:01 | User selects high; driver accepts for next turn | Selection event: high pending; S1 still medium |
| 10:02 | Turn A completes | Duration/tokens attributed to medium |
| 10:03 | Turn B reports high | Open S2: high observed; clear pending |
| 10:04 | Default setting changes globally | Existing S2 stays high; future launches may differ |

Segment changes follow Registry's reconciled values, not raw hook races. Repeated identical observations refresh quality without creating new segments. Conversation rotation always ends the old segment; a model/effort value never migrates to an unrelated conversation by accident.

If a provider does not expose effective effort, retain the launch-resolved choice with its weaker provenance. Never translate unsupported/unknown into low or zero.

## Which author model belongs on a review?

Freeze the authoring context when a submission is captured. The reviewer model comes from the attempt's own execution resolution. These are two distinct roles.

For a submission built across multiple authoring segments, retain the segment links, a bounded set of model/effort pairs, and `author_execution=mixed`. If a simple chart uses the last observed author segment at submission time, name that dimension `author_model_at_submission`, not “the model that produced all the work.” Do not duplicate one review into each model cohort and inflate the total.

Model-specific token and turn-duration comparisons use execution segments with proven attribution. A mixed workflow-run outcome goes in a mixed/unknown bucket unless the analysis explicitly allocates it using an approved method. No attribution by filename, cost guessing or transcript text classification is proposed.

## Terminal and task context

Read backend IDs through terminal registries and Session terminal handles. Record multiplexer and emulator independently because one can nest inside the other. SDK runtime is `not_applicable`; an unintegrated terminal is `unknown`, not no terminal. Never capture tty, process ID, pane token, tab name or command.

Task kinds remain the existing `ship`, `scout`, `plan`, `pipeline`, `chat`. A personal discovered session can have no task kind; use an explicit no-task state instead of inventing `chat`. Capture task source, dispatch source, queue/schedule linkage, configured workflow selection and frozen run version at their respective times. A later task assignment starts a new association interval.

For multi-repository work, expose repository count and opaque per-repository association on traces. Model/task counters must not multiply by repository count.

## Session endings and task outcomes

Use two orthogonal records: `session.end_observed` and `task.outcome_recorded`. A kill request is an action fact before either. The session event contains observation reason and supporting provenance; it does not overwrite the task's authoritative status.

| Observed circumstance | Session measurement | Task/analysis treatment |
| --- | --- | --- |
| Explicit kill requested and confirmed by owner | Operator/automation termination, with actor provenance | Task outcome remains independently observed |
| Temporary terminal discovery miss | Observation interruption only | Not ended, abandoned or failed |
| Registry durable removal with no known reason | End observed, reason unknown/lost as supported | Missing completion evidence remains unknown |
| App shutdown suspends a managed session | Suspension/restoration episode | Not task abandonment |
| SDK-to-terminal handoff | Source entry replaced/handoff; link successor | One continuous task if existing owners bind it that way |
| Task explicitly completes while session stays open | No session end yet | Successful task, session continues |
| Session vanishes with no recorded outcome | Unknown work completion | Preserve operational task status but do not infer a verified failed task result |
| Late verified PR merge | Separate later delivery fact | Can update cohort outcome; historical session-end observation stays unchanged |

The distinction in the unknown row is necessary: `TaskManager.agentWentAway` may settle an uncompleted departed task as failed while documenting that a clean exit cannot be distinguished from a crash. Export `task_status=failed` and `completion_evidence=missing` together; product dashboards should not turn this into a measured correctness failure. [Task departure handling](../../../../src/server/tasks.ts).

Registry's `session_exit` fires before the removal timer and still has access to the session snapshot; durable `session_remove` occurs later. Use the early signal only to stage context, with a cancellation path if the session is rediscovered. Count final removal at the durable boundary. Startup reconciliation needs the matching path, after restoration/observation, to prevent omissions. [Registry eviction](../../../../src/server/registry.ts).

## Early exit and abandonment

`ended_while_work_open` is an observed relationship at departure, not a moral judgment or a failed outcome. “Abandoned” is an optional derived cohort: ended work with no completion or linked continuation after a proposed seven-day grace period. Display the horizon and observation quality, and exclude known suspensions/handoffs. Later continuation can revise the cohort result without rewriting raw events.

Do not emit abandonment as a one-way counter from a timer. A count that cannot be corrected when a user returns is unsuitable for retention/cohort analysis. P5 defines the classification contract; Phases 6 and 7 implement the corresponding summaries and queries.

## PR and completion provenance

Use the existing work-episode/per-repository PR ledger, action verification and merge observations. Proposed PR facts are `associated_existing`, `creation_verified`, `updated`, `merged`, `closed_unmerged`, and visibility unknown. An action requested or a session saying it opened a PR does not satisfy creation verified.

### Preserving late delivery observations

Phase 3 owns the preservation and polling needed for late PR facts. The current implementation does not guarantee them after every ownership change: `invalidateTaskOwnershipInTransaction` deletes current task bindings without archiving them. `mergedPrFor` and `taskPrPollTargets` then lose that association. Existing historical bindings survive ordinary rebinds, but copying invalidated bindings into that table would also make them eligible for operational task completion and could release dependencies outside the selection-time boundary. [Ownership invalidation](../../../../src/server/db.ts), [completion lookup](../../../../src/server/tasks.ts), [dependency boundary tests](../../../../test/task-dependencies.test.ts).

For opted-in capture, Phase 3 retains a minimal, bounded telemetry projection of each verified task/work-episode/repository/PR association when first observed, while its source ownership still exists. Persist it through P1's durable capture/projection facility, with the original context and a local-only PR lookup reference. This is observation state, with no authority to bind a session or complete a task. It survives ownership invalidation and restart until the declared late-outcome horizon expires; acceptance failures or expired associations produce incomplete coverage. PR URLs remain local polling metadata and are excluded from exported telemetry.

Extend the existing daemon PR poller with a distinct telemetry observation reason, deduplicating URLs with operational poll targets. An observation-only result emits the verified late-delivery fact into P1 and the Phase 6 cohort input lookup; it does not enter `mergedPrFor`, call task completion, or satisfy dependencies. When a URL also has operational provenance, the existing operational reconciliation still applies its own eligibility and selection-time rules. Do not archive invalidated bindings into `historical_task_work_episode_bindings` merely to enable telemetry. Changing operational late-merge completion policy is outside this telemetry phase.

Completion is task-kind aware. Chat/plan/scout success requires its own contract and need not create a PR. For eligible shipping work, count one task with any verified PR and separately the number of unique PR associations. Preserve zero-observed versus observation-unavailable. Do not export the PR URL, repository owner, branch or commit SHA to product analytics.

## Acceptance examples and remaining gates

Focused tests should cover the timeline above; unchanged metadata; context clear; external discovery followed by adoption; failed restoration; transient exit and reappearance; explicit kill versus actual termination; task completion without session exit; clean unknown exit; handoff; multiple workflow bindings; multiple PRs and late merge.

Phase 3 must capture a verified open-PR association, remove or rotate session ownership through the real invalidation path, restart, then observe its later verified merge through the shared poller. Assert one late-delivery fact and an updated cohort-input lookup with original attribution, unchanged session-end evidence and operational task status, and no newly satisfied dependency edge. Include dependencies selected before and after the ownership boundary, a URL with both polling reasons, duplicate observations, expired capture and no-consent cases. Phase 6 adds the corresponding final cohort-snapshot assertion.

All exact capture points need an owner-by-owner implementation review. Historical rows before the cutover remain unattributed unless an explicit historical-import feature is later designed. This area defines telemetry semantics; it does not change Registry eviction, task completion policy, effort application or terminal behavior.
