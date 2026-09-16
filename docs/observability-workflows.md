# Workflow telemetry and the Phase 5/6 handoff

Phase 4 observes existing workflow owners. It does not change graph traversal, verdicts,
response retries, evidence readiness, delivery policy or repair budgets. Collection stays
opt-in. All new facts use the existing durable journal and independent audience queues.

## Source ownership and counting

| Fact | Authority and identity | Contribution |
| --- | --- | --- |
| Definition/version/binding | Store mutation, immutable version or binding identity and checkpoint revision | Asset observations; no workflow execution |
| Run | Creation and decoded lifecycle transitions, run plus observation revision | One observed start and one terminal outcome; blocked is not terminal |
| Submission | `insertSubmissionInTransaction`, submission id | One evidence segment; one repair round per run/round, regardless of segment count |
| Node | Durable attempt identity at eligibility, claim and completion | Executed, disabled, reused, cancelled and infrastructure dispositions remain separate |
| Provider response | `workflow_llm_calls` id | One provider execution at start; validity at completion, including parse/contract errors and interruptions |
| Review | Completed Persona attempt with a semantic verdict | Only executed pass/fail enters the acceptance denominator |
| Finding | Attempt plus finding ordinal | Bounded category and basis; never title, rationale, path, quote or raw response |
| Stage | Immutable version, projected member ids and submission | Activation to the stage barrier, including parallel overlap |
| Delivery | Existing delivery id plus transition revision | Only confirmed `persona_feedback`/`inspector_feedback` delivery counts as a repair packet |
| Repair cause | Delivery plus causing attempt | Every contributing review can link to one packet without increasing its count |
| Action result | Mutation route result, subject, logical operation/request id and outcome | One logical applied/refused/failed result; repeated owner request ids deduplicate |

`persona_contract_outcome=accepted` and advisory `persona_verdict` events never contribute
another review. A valid fail is a successful review of work that needs changes. Disabled
and reused synthetic passes do not contribute reviews or provider executions. Results that
arrive after cancellation remain audit observations without a new executed verdict.

The reason vocabulary is `WORKFLOW_FINDING_REASONS`, revision 1. It is requested through the
maintained shared Persona prompt. Normalization accepts older/custom Personas and treats an
invalid supplied category as `unknown`. No category changes response validity or triggers a
classification call. Finding basis (`substantive`, `coverage_registration`, `evidence_access`)
is orthogonal. Category provenance is `structured` or `unknown`.

## Context, timing and gaps

Submission creation freezes the Phase 3 session observer's effective author model, effort,
quality and association refs. Pending effort is excluded. The reviewer model comes from the
attempt/call's resolved execution, including overrides. The current LlmRunner interface has
no observed reviewer effort, so that field is `unknown`. Custom model identifiers are folded
to `other`; operator text does not enter the new source facts. Identities/revisions appear
only as destination-scoped trace refs, never metric labels.

Stage identity uses `projectStages`; an unprojectable graph still emits node facts with
`stage_projection=unavailable`. Parallel duration ends at the join, not at the sum of child
durations. Queue timing is available for observed eligible attempts; a retry's backoff is
not reported as eligible queue time. Persisted timing is explicitly `wall_clock`, including
sleep/restart, and never labelled active CPU time.

Wait classification consumes `decodeWorkflowRunLifecycle`. Known session repair/action waits
are agent waits, Inspector dependencies are external waits, explicit budget/capture/cleanup
gates are human waits, and otherwise ambiguous blocks remain unknown. There is no inference
that every blocked run needs a human. Session actions already retain packet pickup and child
continuation evidence; those observations yield pickup and repair intervals. General Persona
repair packets do not have a proven pickup timestamp in the current owner, so their pickup
remains unknown. No new session watcher or competing pickup algorithm was introduced.

The workflow/persona action manifest is `src/shared/workflow-actions.ts`. Browser requests use
Phase 2 operation context. Unmarked clients and declared-only humans never count as confirmed
human interventions. Foreman and agent actions cannot become human recovery. A manual or
Preview resubmission is a required decision; a human resubmission of an automatically resumable
run is recovery. This is an observed manual advancement, not a claim that automation was
broken. Directives remain optional steering; cancellation is termination. Unavailable policy
or attribution stays unknown. Authored approvals have no separate workflow-node owner in this
build; ordinary session questions remain owned by their existing session/Phase 5 sources.

## Commit boundary and recovery

The guide proposed reconciliation of post-commit gaps. This implementation instead captures
workflow facts inside their source transaction, using a telemetry savepoint. The journal,
minimal source checkpoint and business mutation commit together. A refused capture or storage
error rolls back only the telemetry savepoint and records a bounded gap; it cannot change the
business result. A source rollback removes its telemetry too. No workflow history scan or
second workflow history table is needed. Accepted facts replay without current model/graph
lookups and without another metric increment.

`WorkflowStore.mutate` is the store-owned write and observation boundary. Writers return typed
domain notices through `workflows/mutations.ts`; they do not import telemetry or select
telemetry observers. That interface supplies a read view of current workflow state and isolates
each synchronous observer in a savepoint. Bootstrap registers the telemetry adapter once;
`telemetry/workflows.ts` alone translates notices into source facts, including bulk cancellation
and event-related delivery observations. An unregistered observer has no effect on persistence.
New observed writes use this same mutation boundary and domain notice contract. This replaces
the original per-method telemetry callbacks and removes the store's concrete backend dependency.

`telemetry_source_state` stores only bounded source checkpoints: frozen author context, last
observed lifecycle/disposition and stage activation. Rows are at most 16 KiB, share the global
byte budget, expire after 30 days, and clear when global collection changes. Workflow checkpoints
and frozen author context are scoped by audience and consent epoch. Withdrawing one audience
does not reset the others. Re-enrollment starts a fresh checkpoint namespace; old author context
and timing baselines cannot cross into it. A source failure before
acceptance remains a reported gap. Historical pre-consent activity and observations lost before
acceptance are not reconstructed from current settings. Action-result capture follows the
completed route and therefore retains the documented pre-acceptance crash window.

Observation revisions have a persisted window identity, so collection restarting cannot collide
with an earlier window's revisions. Terminal run outcomes and confirmed deliveries retain their
permanent identities per audience across windows. Context unavailable after withdrawal is not
reconstructed. Workflow capture writes a separate journal fact for each eligible audience so
their contexts can differ. Its explicit `profiles` selection only narrows current consent and
the event's audience allowlist. Consumers still receive one fact per business identity in their
own audience; a permanent outcome already captured for that audience is never recounted after
re-enrollment.

These are deviations to carry into the Phase 4 PR: atomic savepoint capture replaces source
reconciliation; existing session-action evidence supplies the available pickup coverage;
unknown reviewer effort is retained; and manual/Preview resubmit is distinguished from
recovery through the existing resumption policy. These choices follow current owners without
changing execution behavior.

## Independent extension points

- Phase 4 owns the workflow/persona sources in `src/shared/telemetry-sources/workflows.ts`,
  their server observations, the action middleware in `src/server/telemetry/workflow-actions.ts`,
  and the browser callers in `src/web/workflows/workflowApi.ts` and
  `src/web/workflows/personaApi.ts`. It also establishes the shared action-result contract in
  `src/shared/telemetry-sources/actions.ts` and the workflow/action registrations in
  `src/shared/telemetry-sources/index.ts`.
- Phase 5 adds the remaining non-workflow source/action/error/browser instrumentation and its
  coverage guide. It adds feature-local sources under `src/shared/telemetry-sources/` through
  the existing registry, preserving Phase 4's workflow/persona registrations and callers.
  The current `ACTION_RESULT_SCHEMA` in `src/shared/telemetry-sources/actions.ts` accepts only
  `workflow` and `persona` features, and action IDs from `WORKFLOW_ACTION_ROUTES`. Registering
  another source alone does not widen these allowlists. Before emitting additional action
  families through `mission.action.result`, Phase 5 must extend both bounded feature and action
  allowlists with its feature-local IDs, preserving existing IDs and workflow/persona counting
  semantics. This is an additive source-contract extension, not a common database migration.
  The shared fields remain feature, action, outcome, `duration_ms`, surface, coverage, intent and
  cause, plus actor/operation identity and event time in the standard envelope. Phase 5 must
  verify that the new families validate and existing workflow/persona facts retain their
  meaning; it does not re-emit those operations or edit analytical reducers. Additional
  action-family definitions and callers remain outside Phase 4's scope.
- Phase 6 owns `src/shared/telemetry-projections/` for instruments and
  `src/server/telemetry/projections/` for reducer registration. The service already calls that
  registration entry point. It consumes immutable facts; it does not edit routes, worker owners,
  browser state or source definitions.
- `TelemetryProjection` supplies versioned state, migrations, ordered reduction and a snapshot
  hook. State, checkpoint, cumulative series and output batches commit atomically. Each state
  is capped at 8 MiB within the existing global budget. Oversized state rolls back the projection
  pass. No common migration is required by either downstream phase. Each reducer must prune its
  own cohort membership to the declared 30-day horizon and report incomplete coverage.

The shared golden fixture is `test/helpers/workflow-telemetry.ts`. It executes the actual engine
with fake providers: A malformed then fail, B pass, one confirmed packet and human recovery,
A pass and B reused. Expected totals are 3 reviews, 2 passes, 1 fail, 4 provider executions,
1 invalid response, 1 reuse, 1 packet, 1 repair round and 1 recovery. Unit tests prove replay,
privacy for both audiences, transaction isolation, unknown attribution and parallel timing.
The focused real-stack test checks Prometheus totals and a searchable scoped Tempo trace.
The existing persona-control Playwright spec also verifies browser action attribution and
resubmission without spending model tokens.
