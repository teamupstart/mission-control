# Primary actions, feature use, automation and errors

Phase 5 adds source observations to the existing durable telemetry facility. Collection remains off by default. Local collection and the user and product export policies keep their separate consent epochs, retention, source deduplication, and salted references. This phase changes neither the analytical reducers nor the database schema.

## Reading the signals

| Signal | Meaning | Counting rule |
| --- | --- | --- |
| `mission.action.result` / `mission.action.count` | An observed primary operation, including a refusal, failure or pending acknowledgement | Only `observation=initial` adds an operation. Later outcomes use `outcome_update`; a successful outcome is final. |
| `mission.feature.used` | A successful Phase 5 use, by feature and actor | One applied result. Settings, setup, and the explicit configuration/preview exclusions in `PRIMARY_NON_USE_ACTIONS` do not contribute. |
| `mission.feature.entry` / `mission.feature.entries` | An intentional visit, selection, filter, search outcome, dismissal or successful report copy | Only a transition or explicit gesture; no render, input, heartbeat or SSE snapshot counter. |
| `mission.automation.transition` / `mission.automation.actions` | A normalized owner outcome, separate from the configuration that enabled it | Once per business identity, attempt/round where available, action and outcome. It is an outcome counter, not a count of every poll or state oscillation. |
| `mission.error.occurrence` / `mission.errors` | An authoritative daemon or provider error | One occurrence across catches of the same exception. The route returns its opaque occurrence header so the browser does not recount it. |
| `mission.renderer.error` / `mission.renderer.errors` | A renderer exception, rejected action transport, or lost live connection | Same error object once, then bounded loop suppression. Suppression summaries contribute only to `mission.renderer.errors.suppressed`. |
| `mission.connection.recovered` / `mission.connection.recoveries` | Recovery of the live channel after a witnessed connection loss | One recovery per outage, with bounded elapsed duration in `mission.connection.downtime`. |

Browser self-reports retain Phase 2's operator-only, metric-only contract: local collection and the user backend can see them, while product export and spans require authoritative sources. The daemon action, automation and error events support both audience policies.

These are different questions: creating a queue item completes an enqueue action; delivering or verifying it completes a queue outcome. Creating an ensemble does not declare its evaluation complete. Opening an installer reports a terminal launch, not installation. An acknowledged pipeline start stays pending until its existing commission owner observes admission or failure; completion of the external run is a separate observation. A Workflow completion claim records claiming the existing run, not passing that run's review.

The Phase 4 envelope keeps its event name/version and existing fields and meanings. Feature/action IDs, operation surfaces, `pending`/`cancelled` outcomes and `outcome_update` are additive source vocabulary. Existing Phase 4 `initial` and `applied_update` facts remain readable, and workflow intervention counting still requires the Phase 4 workflow/persona owner and human provenance. No Phase 6 registration, state, migration or cohort code is changed.

## Attribution, identity and privacy

Browser mutations carry a fresh app operation context; an explicit transport retry can pass the same operation to `actionFetch`. Existing domain `requestId` and ensemble `sourceKey` remain the idempotency authority; they do not replace the correlation operation ID. Routes without either a retained domain key or a repeated operation header cannot identify independently issued requests as a retry. A fresh explicit user gesture is a new action.

MCP and Foreman clients declare their entry surface and actor. A scheduler stamps owner provenance. External pipeline observations remain unknown actor with `external_observation` coverage. Missing or conflicting declarations stay unknown. This metadata never grants authorization. Queued conversation delivery retains only the original actor and operation ID through the existing bounded source-state store; Phase 3 still owns its single delivery observation. Unknown older turns remain unknown.

The browser keeps at most 32 pending records, sends one at a time through Phase 2's ingress, and drops records after three transport attempts or five minutes. It retries on a later observation, online event or live-channel recovery. Phase 2 still enforces eight records, 8 KiB, its admission rate, clock skew, event allowlist and strict fact schemas. The buffer is volatile: closing an offline tab can lose observations before admission.

Navigation identity (including a locally selected file) stays only in a bounded in-memory map. Emitted values are declared feature/action IDs. Query text, selected paths, file contents, messages, names, settings values, provider output and error prose are neither exported nor hashed as substitute attributes. References pass through the existing audience-specific minimizer. Errors allow only component, family, code, retryability, handled state, suppressed count and a fingerprint of `unknown` or same-origin application bundle line/column coordinates. No stack, symbol or URL is exported. Unknown provider failures are `unavailable`; only a typed timeout is classified as such. No message matching guesses authentication or quota failures.

Renderer loops keep at most 32 fingerprints, allow one occurrence per fingerprint/code per minute, and emit a suppression summary when the window closes. A departed page may lose that summary. Expected validation/policy refusals and semantic review rejection are domain results, not application exceptions. The next startup describes an unclean predecessor as `termination_unknown`; fatal errors retain their normal propagation. Exporter/ingress errors stay on the existing self-health path, avoiding recursive reporting.

## Coverage across the 21 groups

`src/shared/telemetry-sources/primary-actions.ts` is the executable operation manifest and derives the primary feature vocabulary from its routes. `action-exclusions.ts` names every excluded mutation and its reason. The manifest test compares these and Phase 4's route registry with every mutating route in `routes.ts`, refusing overlaps, missing operations and nonexistent hooks. [The operation manifest](observability-action-manifest.md) links these authoritative route registries and maps browser, MCP and background callers to their semantic owners.

| Group | Semantic owner and source | Verification / limit |
| --- | --- | --- |
| Setup and integrations | Setup owners' install/service/configuration results; repository scan/resolve and registration adapters | Real installer launch in `telemetry-primary-actions.test.ts`; a terminal launch is not proof of installation. Detection GETs are reads, not repeated use. |
| Task intake and backlog | `TaskManager.create` plus the explicit task/source route results | Real task creation/edit and scheduled creation; route and owner do not double count. |
| Dispatch | Phase 3 dispatcher and task outcome sources | `telemetry-dispatch-attribution.test.ts`; only missing client context is supplied. |
| Conversation | Phase 3 delivery/driver source, with retained outbox context; Phase 5 attachment/retry/resolve routes | `telemetry-session-attribution.spec.ts`; no second send success counter. |
| Session management | Phase 3 lifecycle, stop/handoff owners; Phase 5 rename/focus/terminal/retro results | Real embedded rename and existing session attribution suite; terminal activity without positive attribution stays unknown. |
| Model and effort | Phase 3 requested/effective selection; Phase 5 default configuration results | Existing session attribution spec and tests. No second selection result. |
| Permissions and attention | Review resolution/mode owners; Phase 3 driver question answers | Real review resolution in the owner fixture. Refusal and semantic rejection stay domain results. |
| Workflows | Phase 4 workflow actions and mutation observers | `telemetry-workflows.test.ts`, unchanged counting contracts. |
| Persona control | Phase 4 persona actions/execution observer | `telemetry-workflows.test.ts`; no parallel execution source. |
| Runs inspection | Page, worklist, record-pane and round-filter transitions; evidence registration/removal results | Browser Runs specs and strict manifest fixtures. Evidence bytes/captions are excluded. |
| Files and Diff | Console tab/file-selection transitions; file write/comment owners | Real comment fixture, file browser specs; local file-selection key never leaves the page. |
| Library | Phase 4 workflow/persona/command owners; Phase 5 session-action catalog and validation results | Real catalog creation plus failed-save/retry browser spec. |
| Search and command navigation | Palette open/select/no-results/dismiss | Browser offline continuation, bounded ingress, no query export; repeat Enter then dismiss does not recount no-results. |
| Queues and schedules | `QueueManager.write`, schedule occurrence claim/finish, administration routes | Real queue verification and scheduled task; `queue-manager.test.ts`, `schedule-http.test.ts`. Configuration does not prove an occurrence. |
| Ensembles | Generic manager publication of run/member/stage/handoff states; domain action variants | Real cancel/decision-state fixture and extension tests. No strategy-name branches. |
| Pipelines | Normalized provider refresh, commission event commit/bind/cancel/failure, HTTP control variants | Projection and commission fixtures, pending-to-failed settlement and replay. Provider step snapshots expose no attempt identity; they count each normalized outcome once per run/step, not unseen external retries. |
| Foreman and away | Configuration, invite, episode, claims and recovery route results; Phase 3 automated delivery | Real invite/withdraw/away fixture; automation surface is never upgraded to human. Worker remains HTTP-only with no SQLite sink. |
| Shipping and Inspector | Phase 3 verified PR outcomes; Inspector completed analysis/failure and resolution owner | Real fake-provider Inspector loop, including lost review response recovery. A completed analysis does not claim a published review or merged PR. |
| Archives and reports | Archive administration results, page/report entry and successful clipboard copy | Real archive cleanup fixture and report browser test; document contents excluded. |
| Settings and help | Explicit configuration/restore/worktree/tour results; section route transitions | Real appearance update, route manifest fixtures and tour route tests. Entering a section is not saving its settings. |
| Telemetry | Phase 2 control facts, typed ingress and self-health | `telemetry-ingress.test.ts`; deliberately excluded from primary-action/error recursion. |

## Owner and recovery boundaries

Synchronous APIs record the owner's normalized response after it completes, not just a click. The middleware only inspects a request body already consumed by the route, preserving streaming body-limit refusals. Exceptional 5xx responses become safe route errors; unexpected observation failures never change a business response. Task creation, queue writes, schedule occurrences, ensemble publication, pipeline persistence and Inspector review work also have owner hooks for background execution.

These hooks use the existing journal, source identities and bounded source state. Accepted facts replay after restart without recounting within the common retention/dedupe bounds. There is no historical scan or new outbox in Phase 5. A crash between a business commit and its observation can leave a gap; the source registration states that limitation. Ensemble/provider snapshots can later recover their current normalized outcomes, but not an unobserved intermediate transition or its actor. An error object identity only links catches within a process; a new process cannot reconstruct a lost exception's cause.

## Verification and handoff decisions

Focused tests exercise catalog/manifest completeness, real owners, pending/final/repeated outcomes, two audience policies, actor conflicts, private sentinels, unavailable telemetry, and correlated propagation. The browser specs exercise actual saved results and visible recovery, offline use, reconnect, development StrictMode, report copying and bounded errors. The Phase 5 filtered case in `telemetry-stack.integration.ts` checks exact counters and a shared action/error Tempo trace after restart/replay independently for user and product policies, without stopping the shared stack.

Deviations from the proposed route, for the eventual pull request:

- Use an explicit route-to-owner result manifest for synchronous operations and owner hooks for background transitions. Adding a wrapper to every synchronous manager would duplicate the already authoritative response contracts and route refusals.
- Keep exhaustive route inventories in their executable registries and link them from the coverage documentation. The primary feature vocabulary derives from its registry, so adding an operation does not require a second feature list or a copied documentation row.
- Preserve Phase 2's operator-only and metric-only browser boundary rather than promoting self-reported navigation or errors into authoritative product spans.
- Preserve Phase 2's existing ingress budgets rather than P4's larger draft values. The browser needs no new persistence or common migration.
- Extend source vocabulary additively for pending/cancelled updates while retaining Phase 4 meanings. Reuse existing source state for pending pipeline/outbox attribution; no Phase 6 dependency or shared-state migration is introduced.
- Name ensemble and pipeline control verbs from their existing generic registries. External snapshots without attempt or actor evidence explicitly retain that limitation.
- Classify provider errors conservatively from typed evidence. The optional process-local observer keeps the standalone Foreman worker free of database imports.
- Run only the Phase 5 local-stack scenario so concurrent work using the shared collector is not interrupted. It verifies both policies and replay rather than changing stack/dashboard configuration.

Phase 6 may consume these source events after merge but remains independent. Phase 7 can use this inventory and the source metrics when its prerequisites land. No dashboards, cohorts, hosted service, release configuration or analytical reducer are part of this change.
