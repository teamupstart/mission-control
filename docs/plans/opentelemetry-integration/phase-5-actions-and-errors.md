# Phase 5: primary actions, automation and safe errors

## Outcome and value

Complete application-wide visibility into meaningful feature use, attempted/successful actions, automation and user-visible failures. The result distinguishes human activity from agents and automatic recovery, while preserving the privacy and action identities already established.

Read [the source plan](plan.md), [the index](phased-plan.md), [P4](p4-interactions-errors-settings/plan.md) and the Phase 4 handoff. This is the proposed implementation route; use current repository owners and document justified deviations in the PR.

## Entry, dependencies and scope

Direct prerequisite: Phase 4 merged, plus the planning PR. Repository: Mission Control only. Phase 6 may run concurrently. Own source/action/error instrumentation, feature-local definitions, browser signal callers, relevant owner/worker adapters and the action coverage guide. Do not edit analytical reducer code/registration/state, common telemetry migrations or Phase 6's docs/tests. The Phase 4 action envelope and registration seams are fixed inputs.

Own the remaining P4 inventory after prior phases: setup/integration use; task intake/backlog administration; permissions/attention; Runs/Files/Diff/Library/search navigation and mutations; queues/schedules; ensembles/pipelines; Foreman/away; Inspector/review operations beyond existing PR facts; archives/reports; general Settings/help. Audit all 21 groups, referencing telemetry-control facts from Phase 2, dispatch/conversation/session/model/PR facts from Phase 3 and workflow/persona facts from Phase 4 rather than re-emitting them.

No per-keystroke/render telemetry, raw content collection, new authorization policy, hosted product service, cohort algorithms or final dashboard implementation.

## Repository findings

`src/server/routes.ts` and `src/web/lib/api.ts` span many features; HTTP requests alone do not establish successful use. Domain owners in task/queue/schedule/ensemble/pipeline modules and `src/server/actions.ts` know when work finishes. `src/mcp/server.ts` and Foreman HTTP calls share entry points but have different actor provenance. Generic ensemble/provider registries must remain the source of strategy and pipeline behavior.

The daemon is the sole SQLite writer, the browser's live channel is SSE, and terminal writes remain under action policy. Observe these owners through Phase 1/2 APIs. Direct terminal activity may have unknown actor; do not fabricate complete human-activity coverage.

## Implementation sequence

1. Enumerate exported browser API actions, relevant MCP methods and source-owner operations against P4's 21 feature groups. Commit an operation-level coverage manifest with event ID, semantic owner, existing phase owner or new hook, success/refusal lifecycle, actor source, privacy exclusions and test. An operation is either covered or explicitly excluded with a reviewed reason; broad labels such as “other actions” do not close coverage.
2. Add missing semantic source hooks at successful owner transitions and corresponding refused/failed/cancelled outcomes. Preserve logical operation IDs across network retries and pending-to-completed transitions. Reuse generic registry/capability patterns; never infer success from a 200 response that only queues work.
3. Propagate actor/surface/basis/causal context through browser, MCP and server-owned automation. Register app-context observations through Phase 2's typed ingress and owner results through the common facade. Missing/conflicting provenance stays unknown and never changes authorization. Earlier phase actions receive only missing surface context, not another success event.
4. Instrument meaningful feature entry, navigation, search selection/no-results and abandoned UI actions through the bounded browser buffer. Prevent render/remount/SSE reconnect duplication. Exclude query strings, selected filenames, contents and settings values; record declared stable feature/action IDs.
5. Add queue/schedule/ensemble/pipeline/Foreman/Inspector observations at normalized owner transitions. Separate configuration from actual use, human decisions from automated answers, and author work from automation work. For external provider observations, keep explicit capability/coverage limits.
6. Implement safe correlated errors: one authoritative occurrence ID across propagation layers, bounded component/family/code/retryability/handled attributes, sanitized app-frame fingerprints and suppression counts for loops. Expected refusals and semantic review rejection remain domain results. A process death observed by the supervisor/restart path has unknown cause unless evidence establishes it.
7. Wire renderer exception/rejected-action reporting to the existing typed ingress and daemon observation paths without swallowing fatal exceptions or allowing telemetry failure to break an action. Keep exporter self-health separate to prevent recursion. Never export raw error messages/stacks/paths or hash private text as a substitute for minimization.
8. Complete the source coverage guide and fixture cases for every owned group. Exercise the emitted metrics/traces against the local reference stack and both audience policies. Leave broad analytical state to Phase 6 and panel queries to Phase 7.

## API, data and concurrency contract

Use the Phase 4 standard action/error envelopes and Phase 1 bounded dedupe/state facility. New feature-local definitions register through the source entry point; this phase does not modify the analytical registration subtree or common schema. Operational persistence remains at its existing owner.

If a discovered primary action cannot fit the agreed contract without a common schema/migration change, stop the affected parallel work, record the discrepancy and coordinate a prerequisite/edge revision. Do not silently invalidate Phase 6's base or make it import this unmerged branch. Preserve every unaffected action and finish its tests.

## Tests and verification

Use root `AGENTS.md` for focused unit commands and isolated state. Add manifest/schema tests plus real owner/HTTP fixtures for every newly instrumented action family. Assert logical replay once, truthful pending/completed outcomes, human versus Foreman/MCP/unknown actor, source privacy sentinels and error propagation once. Test unavailable telemetry independently of successful business behavior.

Add Playwright coverage for changed browser actions/navigation/error ingress using fake agents and accessible selectors. Cover reconnect/remount without duplicate navigation, bounded ingress refusal, offline continuation and user-visible error recovery. Each changed UI behavior must have an `e2e/` spec, not only a manifest assertion.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, focused Playwright specs and local-stack source replay. Verify generic queue/ensemble/pipeline/automation tests relevant to touched owners. Do not run a full suite repeatedly during CI repair; use focused issue checks and push according to repository policy.

## Merge, exit and handoff

Exit with every primary operation accounted for once, all owned groups producing meaningful outcomes, safe bounded errors, clear unknown-actor coverage and passing owner/UI tests. The manifest must point to actual hooks and evidence, not just desired metric names.

Phase 7 consumes the manifest and source metrics to populate adoption/reliability/model/workflow panels. Phase 6 can consume these events when this phase lands, but its stable action schema and tests must already work on Phase 4. The two phases can merge in either order; neither duplicates the other's source or reducer.

Open a reviewable PR, reconcile current main and valid feedback, and meet the phase verification bar. Phase 7 remains blocked until both this phase and Phase 6 merge.

## Cross-phase audit

2026-09-13: re-read source/index and Phases 1-4. Partitioned all P4 action groups against prior source owners; no extra workflow/session/telemetry success counter is introduced. This phase's write set excludes projection registration, state migrations and analytics docs. Its broad action schema was completed in Phase 4, so Phase 6 does not depend on this phase's code or decisions.
