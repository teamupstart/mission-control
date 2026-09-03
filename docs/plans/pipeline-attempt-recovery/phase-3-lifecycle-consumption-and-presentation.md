# Phase 3 - Lifecycle Consumption and Unified Presentation

## Outcome and value

Mission Control consumes the provider's readiness, retention, retirement, typed failure, and ownership capabilities and projects them consistently across Board, Console, Line, alerts, Diff, and Files. A blocked or failed commission becomes `needs you` even when its managed SDK host is idle, and Engineer progress no longer counts future implementation work as unfinished authoring.

This phase turns the safe workspace foundation from Phase 1 and the provider evidence from Phase 2 into one truthful user experience. It does not yet create retry or adoption attempts.

## Entry criteria and dependencies

- Phase 1 is merged in Mission Control.
- Phase 2 is merged in ai-conductor.
- Both are direct prerequisites.
- Repository scope: Mission Control only.

## Scope

- Parse and reduce the new provider capabilities and lifecycle evidence.
- Activate Mission Control ownership on newly created Engineer correlations.
- Invoke provider readiness before initial host launch and expose recheck without creating an attempt.
- Map explicit provider retirement and typed failures into the Phase 1 projection.
- Make every Pipeline surface use the same workspace, attention, and status model.
- Add commission and status-drift attention.
- Segment Engineer and implementation progress.
- Present safe remedy, recheck, evidence, and successor-review entry points.
- Preserve explicit mixed-version behavior.

## Non-goals

- Do not append retry or adopted attempts. Phase 4 owns those transactions.
- Do not evict or launch recovery hosts.
- Do not auto-settle a task from repository branch or PR evidence.
- Do not duplicate provider failure classification in browser or daemon string matching.
- Do not change the Phase 1 capability matrix or authorize writes against Git refs.
- Do not create a second provider event ingestion channel.

## Repository findings and inherited contracts

- Phase 1 owns commission branch and plan identity, attempt origin storage, the workspace resolver, ref-backed Diff and Files, and route authorization.
- Phase 2 owns independent capabilities for readiness, retirement, retained worktrees, and integration ownership.
- `parseEngineerEvent` already distinguishes known, unknown, and unsupported events while preserving monotonic identity.
- Unknown current-schema events advance provider revision without changing projection. This remains the correct behavior for features the current build does not understand.
- `PipelineEngineerLifecycle` in `src/server/pipelines/types.ts` and the ai-conductor adapter in `src/server/pipelines/conductor/engineer.ts` already expose capability, create, inspectCorrelation, replay, and cancel.
- `src/web/pipelines/pipeline-run-model.ts` synthesizes commission-backed runs and currently hardcodes unclassified failure and a full-pipeline denominator.
- `src/web/lib/attention.ts` considers provider pipeline runs but not failed commissions.
- Shared report bucketing and state display already have attention precedence contracts. Extend shared predicates instead of adding component-specific conditions.
- Provider-owned Pipeline completion remains distinct from SDK host idle or exit.

## Implementation steps

### 1. Extend the Mission Control provider contract

In `src/shared/pipeline.ts` and `src/shared/protocol.ts`:

- Add the provider readiness and worktree retirement event kinds to the append-only known Engineer event registry and discriminated schema.
- Add the bounded structured terminal failure fields while retaining required raw `error`.
- Add stable readiness statuses, failure classes, remedy codes, and retirement reasons exactly as shipped by Phase 2.
- Add bounded commission projections for readiness, structured failure, explicit retirement, and integration ownership presence.
- Keep new fields optional during decode and normalize absent values to explicit legacy state.

In `src/server/pipelines/types.ts`:

- Extend provider capability results with independent feature flags.
- Add a typed non-mutating readiness method and optional integration owner on `create`.
- Do not add separate discovery or telemetry methods. Existing inspect and replay remain the lineage path.

In `src/server/pipelines/conductor/engineer.ts`:

- Parse the expanded capability response strictly and cache it under the existing probe lifecycle.
- Implement readiness by invoking the Phase 2 CLI and validating bounded JSON.
- Pass the commission identity as the opaque integration owner on initial create when the provider advertises owned attempts.
- Preserve exact existing behavior for a provider that reports only `engineerLifecycleEventsV1`.

### 2. Reduce provider evidence into the commission projection

In `src/server/pipelines/commissions.ts`:

- Reduce readiness into a bounded current result attached to the active attempt.
- Reduce explicit worktree retirement only when path, branch, plan slug, retained commit, attempt, and provider revision match the active workspace identity. Persist the provider commit when none exists; surface drift rather than overwrite a conflicting frozen commit.
- Reduce typed terminal failure without discarding raw error evidence.
- Preserve retired state through restart and replay.
- Treat a contradictory event as mismatch or drift evidence rather than silently replacing identity.
- Keep unknown events monotonic and non-projecting.

Update DB projection validation and degraded-row handling in `src/server/db.ts` for additive optional structures. Avoid new normalized tables unless query or atomicity requirements prove they are needed; these are bounded current projections backed by the event ledger.

Update the Phase 1 resolver:

- explicit retirement maps to `availability: "retired"` and its stable reason;
- a vanished path without retirement remains `missing`;
- a retained, revalidated path remains `available` after handoff;
- the same capability matrix continues to govern every route.

### 3. Gate initial dispatch on provider readiness

In the Pipeline dispatch path in `src/server/dispatcher.ts`:

1. reserve the commission and initial attempt as today;
2. create or recover the exact provider run with integration ownership when supported;
3. invoke provider readiness before launching the managed host;
4. ingest or reduce the readiness result through the same commission event path;
5. launch only when status is ready or when provider policy explicitly permits an inconclusive read-only result;
6. leave the task and commission addressably blocked without consuming model tokens when status is blocked.

Add a recheck route/action that repeats readiness for the same created attempt. It must not append an attempt, mutate predecessor identity, or launch a host. A successful recheck may enable a separate initial-start action if no host ever launched; keep that path distinct from Phase 4 retry of a terminal failed attempt.

When the provider lacks readiness or ownership capabilities, retain current initial dispatch behavior but mark the guarantee as legacy. Do not expose automatic retry later for such a commission.

### 4. Derive one Pipeline attention and task-drift model

Add shared, exhaustive predicates that derive Pipeline attention from both provider runs and commissions. Precedence:

1. exact external-successor candidate or status drift;
2. blocked readiness or terminal typed failure;
3. missing workspace that prevents the next permitted action;
4. other existing held/blocker states;
5. SDK host activity as secondary status.

Carry the same result through Board bucketing, Console status, Line, alerts, sitrep/report, and any session status counts. Do not rewrite the raw SDK session state.

Detect task/commission contradictions read-only:

- task done while commission is authoring, blocked, failed, or lacks completion-compatible provider state;
- task running after explicit terminal commission cancellation or abandonment evidence;
- task linked to a commission or provider run with mismatched repository identity.

Render a named `status_drift` attention item. Phase 4 owns any corrective write.

### 5. Make failure and readiness actionable without premature retry

In the commission-backed pipeline model and UI:

- map provider failure class and remedy code to bounded product copy;
- show raw diagnostic as expandable evidence, redacted and bounded by the provider;
- offer `Check again` for readiness;
- offer safe guidance or terminal access only when the workspace resolver permits it;
- offer branch Diff and read-only Files when available;
- show `Retry Engineer` as unavailable until Phase 4 or hide it behind the Phase 4 capability;
- add a review-only external-successor entry point when exact correlation inspection detects a candidate, without mutating active state.

For authentication and authorization failures, Mission Control may show copyable diagnostic commands but must not install keys, alter remotes, or run interactive credential setup automatically.

### 6. Correct progress and timeline semantics

Replace the single synthetic full-pipeline denominator for a commission-backed run:

- During authoring, progress is over the canonical Engineer/DECIDE steps applicable to the chosen track and tier.
- At successful handoff, the Engineer segment is complete.
- Implementation is a separate gated segment that begins only after specification merge and provider run linkage.
- Skipped steps count according to the provider reconciliation event, not UI inference.
- Failure and readiness states do not inflate completion.

Use the existing canonical step registry and reducer evidence. Do not create a second frontend-only step table.

### 7. Verify every visible surface

Update the smallest shared UI model needed so these surfaces agree:

- Board task tile
- Console detail and header
- Line and attention inbox
- alerts and report/sitrep
- Pipeline detail timeline and halt/recovery panel
- Diff and Files states from Phase 1

If a new panel changes vertical geometry or clipping, add or extend the Electron geometry tests in addition to Playwright.

## Data, API, migration, and compatibility

- Event registry and protocol: append new known kinds and optional known-event fields without renaming existing types.
- Commission `state_json`: additive optional readiness, failure, retirement, and ownership projection, normalized on load.
- Provider capability cache: distinguish absent, false, and probe failure. Probe failure is not evidence that a feature is unsupported.
- Initial create: pass owner only when capability is present; existing provider behavior remains unchanged otherwise.
- Mixed-version provider: unknown failure, inferred missing worktree, legacy initial dispatch, and automatic recovery disabled.
- Live ingest and replay must produce byte-equivalent commission state for the same ordered events.
- SSE remains the only browser synchronization path. No polling is added.

## Tests and verification

Add or extend:

- `test/conductor-engineer-provider.test.ts`: expanded capabilities, readiness JSON, owner create argument, malformed provider responses, and legacy provider behavior.
- `test/pipeline-commission.test.ts`: readiness, retirement, typed failure, identity conflicts, unknown events, and live/replay equivalence.
- `test/pipeline-events-upgrade.test.ts`: old and new event registries, optional terminal fields, and unknown future kinds.
- `test/pipeline-migration.test.ts`: old commission rows normalize without unsupported degradation.
- `test/pipeline-attention.test.ts`, report, alert, and status tests: commission failure and drift outrank host idle consistently.
- `test/pipeline-phase-meter.test.ts` and run-model tests: Engineer segment denominator, handoff completion, skipped steps, and gated implementation.
- dispatcher and route tests: initial readiness ready, blocked, inconclusive, provider probe failure, recheck, no model host launch on block, and owner activation.
- workspace resolver tests: explicit retired versus inferred missing.

Add Playwright specs in `e2e/` with fake agents/provider:

- blocked readiness produces `needs you`, a remedy, and no host/model launch;
- recheck changes the state through SSE;
- typed failed commission outranks green idle host state;
- retained review worktree stays interactive;
- explicit retirement switches to read-only ref evidence;
- status drift appears in Board, Console, Line, and attention views;
- progress reaches Engineer completion at handoff and gates implementation;
- legacy provider state is named honestly and has no automatic recovery action.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/conductor-engineer-provider.test.ts test/pipeline-commission.test.ts test/pipeline-events-upgrade.test.ts test/pipeline-migration.test.ts test/pipeline-attention.test.ts test/pipeline-phase-meter.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Run `npm run test:electron` with the approved macOS sandbox handling when geometry coverage applies.

## Merge and exit criteria

- All focused and full Mission Control gates pass.
- New provider events reduce identically through live ingest and replay.
- New commissions created with a capable provider carry integration ownership.
- A blocked readiness result prevents managed host launch and model spend.
- Failed or blocked commission attention outranks host idle on every surface.
- Explicit retirement and inferred missing remain distinguishable but share the Phase 1 read-only authorization.
- Legacy providers remain usable with explicit unknown state and no approximate retry guarantee.
- Engineer progress completes at handoff without counting BUILD or SHIP steps.
- No repository or PR observation rewrites provider lifecycle.
- The UI behavior has Playwright coverage, with Electron geometry coverage where applicable.

## Downstream handoff

Phase 4 may rely on:

- a central recovery-ready commission projection with current attempt, run ID, provider revision, readiness, structured failure, ownership support, workspace capabilities, and drift state;
- provider methods for capability, readiness, create, inspectCorrelation, replay, and cancel;
- a shared attention model that can accept retry or adoption actions;
- attempt origin storage from Phase 1.

Phase 4 must not change provider lifecycle semantics, bypass capability checks, auto-adopt, or settle from branch/PR observation alone.

## Cross-phase audit record

- Initial audit: Phase 3 depends directly on both Phase 1 and Phase 2 and is not safe to start with either missing.
- Compatibility refinement: Phase 3 activates provider integration ownership on new initial creates; Phase 2 only supplies and enforces the provider side.
- Compatibility refinement: pre-launch readiness occurs after exact provider run creation so its evidence has immutable run identity, but before managed host launch or model spend.
- Scope boundary: Phase 3 may inspect exact correlation for a review-only candidate, but only Phase 4 can persist or adopt a new attempt.
- Authorization audit: explicit `retired` and inferred `missing` both consume Phase 1 commit adapters and cannot enable writes or follow a branch after the attempt commit is frozen.
- Final audit: Phase 4 consumes the current attempt, revision, capability, readiness, failure, and candidate projection as guarded inputs and does not redefine their meaning.
