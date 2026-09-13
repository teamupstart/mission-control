# Phase 3: session attribution, lifecycle and verified outcomes

## Outcome and value

Make session activity explainable by the model/effort that actually ran, runtime/terminal, task kind and associated work. Export distinct lifecycle, turn, usage, task-completion and PR observations so users can investigate early exits and efficiency without rewriting history after settings change.

Read [the source plan](plan.md), [the index](phased-plan.md), [P2](p2-session-lifecycle/plan.md) and the P0/P1 contracts. This guide is the proposed route; adapt to current code and explain deviations in the PR while preserving the requested behavior.

## Entry, dependencies and scope

Direct prerequisite: Phase 2 merged, plus the planning PR. Repository: Mission Control only. Phase 1 durable capture and Phase 2 complete controls/operation context are available.

Own dispatch/launch, discovered/restored sessions, conversation/turn boundaries, effective/pending model and effort, terminal context, canonical usage/cost, session departure, task outcome and verified per-repository PR facts. Include the corresponding semantic actions from P4's inventory and source contracts required by workflow attribution. Workflow attempt/reason/repair events belong to Phase 4; other feature actions/errors to Phase 5; abandonment/cohort calculations to Phase 6.

## Repository findings and contracts

`src/shared/types.ts` separates SessionMeta, pending effort, Registry identity, native agent session identity, runtime and terminal handles. The effort route distinguishes current state from next-turn selection. `src/server/dispatcher.ts`, `src/server/sdk/supervisor.ts`, Registry and harness adapters own execution observations. Extend capability/registry patterns rather than branching on concrete agent names.

`src/server/registry.ts` owns all eviction through `beginEviction`; `session_exit` is provisional and `session_remove` is the durable removal signal. `src/server/tasks.ts` may settle departed work as failed when true completion is unknown. `src/server/db.ts` work episodes and PR associations retain repository-grained provenance. `src/server/usage.ts` and `src/server/spend-ledger.ts` prevent duplicate usage across ingest paths.

## Implementation sequence

1. Implement immutable session/context snapshots and execution-segment identity through Phase 1. Keep installation/boot/session/conversation/work episode/task/segment distinct, using internal references only locally and destination-scoped opaque export IDs. Preserve absent, unknown and unsupported terminal/model fields.
2. Hook actual dispatch admission/preparation/launch/readiness and session creation/discovery/restore at their owners. Restoring a persisted session or reconnecting the dashboard cannot emit a second creation. Record source provenance and start-observation coverage so pre-opt-in sessions do not enter complete-from-start cohorts.
3. Capture requested, pending and effective model/effort changes. Freeze effective context at observed turn/segment boundaries and workflow submission handoff. A high-effort selection accepted for the next turn must leave the current medium-effort turn unchanged. Use harness capability adapters; unsupported/missing observations stay explicit.
4. Instrument send/queued/edit/cancel/interrupt/question-response and turn completion at authoritative delivery/driver seams. Reuse operation IDs and actor basis; user-role messages do not prove a human sender. Produce bounded operation spans with cross-turn/conversation links, not one open SDK span retained for days.
5. Project usage from canonical ledger facts once, carrying usage origin, cost basis and observation coverage. Separate authoring and automation usage. Do not sum raw Claude OTLP reports with the same driver's ledger entries or represent API-equivalent cost as subscription billing.
6. Observe confirmed Registry removal and explicit kill/cancel intent separately. Pair session-end evidence with task/work-episode state without inferring cleanup from `exited`. Capture interrupted boot/restore outcomes only when owners establish them. Preserve uncertainty in sleep/restart durations.
7. Emit task outcome and per-repository PR-created/associated/updated/merged/closed observations from verified owners. A prose claim or association with an existing PR is not verified creation. Keep late merges as later facts, count a multi-repository task once, and preserve unknown PR visibility.
8. Freeze source event/schema/metric views consumed by Phase 4 and Phase 6: session segments, author context at submission, task/PR facts, semantic operation result, coverage and usage. Add a local technical guide mapping each event to its owner, dedupe identity and recovery limit. Use the stack to inspect actual spans and metrics without waiting for final dashboards.

## Data, API and compatibility

Persist the minimum event-time context needed for restart recovery through the telemetry owner; add operational fields only where the source owner truly needs them. Any migration uses the existing upgrade path. A recovery scan cannot recreate old effective models from today's SessionMeta.

Reuse the existing task-kind vocabulary (`ship`, `scout`, `plan`, `pipeline`, `chat`). Multiplexer/emulator type belongs in allowed context; pane/PID/tty, names, prompts, paths and PR URLs do not. Full model/workflow joins belong in traces/declared summaries, not a metric label cross-product.

Keep collection and failure policy from Phases 1/2. Do not alter Registry cleanup timing, task success semantics, dispatch permissions, terminal write policy or usage ownership merely to make observation easier. Source behavior and emitted evidence quality are separate.

## Tests and verification

Use root `AGENTS.md` for focused unit commands. Add fixtures for discovered versus created/restored sessions, failed dispatch versus readiness, duplicate owner observations, pending effort timeline, mixed segments, harness unknown capability, message replay, kill intent without observed end, rediscovery during linger, task completion without PR and late/multiple PR outcomes. Relevant existing session-contract, session eviction, usage-ledger, dispatch and work-episode tests must pass where touched.

Run `npm run typecheck`, `npm run lint`, `npm run build` and `npm run smoke`; replay isolated source events through Phase 1's real-stack fixture. New source context attached to browser actions is verified with a focused Playwright dispatch/conversation/effort flow and fake agents. Any changed visible behavior needs its own `e2e/` coverage; no agent tokens or operator DB access.

Assert immutable attribution before/after restart, one source contribution after replay, canonical usage totals, expected unknown coverage and absence of privacy sentinels in both profiles. Duration tests distinguish wall time from observed execution rather than manufacturing exactness across sleep.

## Merge, exit and handoff

Exit with source-owned session, effective context, usage and verified outcome facts exported as metrics/traces, passing recovery/dedupe/privacy tests and current app behavior preserved. This phase does not declare abandonment; it emits the facts Phase 6 can classify.

Phase 4 consumes author-at-submission context and semantic operation identities. Phase 6 consumes session/task/PR/usage facts and coverage flags. Phase 5 must reuse the dispatch/session/model/conversation/PR actions already instrumented here and only add missing surfaces. Document the owner map so a second hook cannot create an extra successful action.

Open a reviewable PR, resolve valid scoped feedback/conflicts and meet the verification bar. Its merge releases Phase 4 subject to normal operator/review policy.

## Cross-phase audit

2026-09-13: re-read source/index and Phases 1-2. This phase consumes immutable context and operation IDs instead of new consent or delivery storage. Effective/pending effort and unknown completion remain separate as P2 requires. Session-linked coverage stays here; Phase 4 only adds workflow facts. Registry and Settings changes are serialized through Phase 2, and analytics receives stable source identities rather than mutable session joins.
