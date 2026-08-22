# Phase 2: Pre-PR shepherd recovery loop and controls

## Outcome and value

Keep every eligible, invited task-owned `ship` session moving until its first task-owned pull
request. Foreman waits for a settled 20-minute quiet period, determines the stalled lifecycle state,
claims one durable recovery attempt, and either sends the structurally known next action or uses one
tool-less model call for an ambiguous non-empty implementation. Three attempts are allowed at 20,
40, and 80 minute delays; exhaustion becomes visible human attention.

The dashboard exposes the permission and threshold, and the existing session drawer and fleet ledger
explain each recovery. Once any task-owned pull request is observed, existing Workflow, Inspector,
CI, and review follow-through owners take over.

## Entry criteria and direct dependencies

- Phase 1 is merged and its exact `TaskCompletionContract`, prompted outcome vocabulary,
  `SessionQueue.promptedDecision`, and atomic disposition writes are available on the default branch.
- The source and phased plans are merged to the default branch.
- Direct dependencies: Phase 1 and this planning session.
- Start from Phase 1's merged names. If implementation had to choose different filenames or field
  names, consume those names and record the mapping in the pull request rather than creating aliases.

## Scope

- Durable recovery projection and compare-and-set attempt claim/release operations.
- A pure ship-shepherd eligibility and action policy.
- One fleet-level Foreman pass with fresh rechecks and one-pane-per-pass coordination.
- Structural held-gap, empty-diff, and direct-handoff recovery.
- One tool-less recovery reviewer for ambiguous non-empty implementation stalls.
- Fixed three-attempt backoff and visible exhaustion.
- Foreman master permission and first-wait setting.
- Existing drawer and fleet-ledger recovery visibility.
- Unit, migration, route, worker, UI, and Playwright coverage.
- Full Foreman, work-queue, attention, architecture, and change-contract documentation.

## Non-goals

- No supervision of `scout`, `plan`, `pipeline`, `chat`, or personal uninvited sessions.
- No replacement for queue drain, Workflow repair/resumption, parked-run attention, Inspector,
  review follow-through, Shipping, or the GitHub observer.
- No automatic merge and no recovery-model authority to commit, push, merge, delete, create tasks,
  or expand repository scope.
- No second recovery dashboard, transcript poller, raw hook interpreter, PR poller, or worker-side
  database access.
- No inference about which secondary repository still needs a pull request after the first observed
  task-owned PR. The shepherd stops there.

## Repository findings and inherited contracts

- Phase 1's current prompted decision is the authority for a completed generation. Recovery fields
  may refer to it but never alter its outcome, summary, or gaps.
- `src/server/foreman/review-followup.ts` provides the required decide, refresh, stamp-before-send,
  conservative delivery, and one-session-per-pass structure. Extract shared PR/session predicates
  where needed instead of copying its remote-state logic.
- `runReviewFollowup` currently returns the sessions it touched so the per-target loop cannot also
  wrap them up. The shepherd must participate in the same pass-wide set.
- `settledIdle` is the shared idle ordering predicate. `shipRecoveryMinutes` changes its threshold
  for this feature only; Away alert settings do not authorize typing.
- Full `SessionQueue` is available over the existing queue API while card summaries intentionally
  omit large text. The worker can read Phase 1's bounded decision without widening SSE payloads.
- Workflow ownership already has a shared non-terminal predicate. Failure to read Workflow runs is a
  hold, not permission to type.
- `ForemanConfigSchema` defaults old stored objects field-by-field. `keepShipTasksMoving` defaults
  true, but global `enabled`, Live mode, repository allowlist, and per-session invite remain mandatory,
  so a fresh installation still cannot type anywhere.
- Existing `ForemanEpisode` fields already carry situation, purpose, recommendation/delivery,
  marker, disposition, and escalation. Extend an append-only field only if recovery attempt metadata
  cannot be represented honestly; do not create a second ledger table.

## Implementation steps

### 1. Add durable recovery state beside the Phase 1 decision

1. Define an append-only recovery-reason vocabulary for at least `held_gaps`, `idle_empty`,
   `idle_ambiguous`, `direct_handoff_missing_pr`, and `verification_failed`.
2. Add a nullable validated `PromptedRecoveryState` to the queue projection with task id, logical
   key, work-cycle generation, decision generation/outcome where applicable, reason, deterministic
   marker, attempt number, claimed time, next eligible time, last delivery state, and bounded last
   payload summary.
3. Add fresh-schema and migration columns beside Phase 1's prompted decision columns. Old rows have
   no recovery state. Unknown, partial, mismatched, or malformed state is not actionable.
4. Keep recovery current-state only. Every action also writes an append-only `foreman_episodes`
   record for history.
5. Make task terminalization, task/session rebinding, context-key rotation, a newer work-cycle
   generation, and an observed open task-owned PR render the old marker inert. Eager cleanup is
   optional; eligibility must not depend on cleanup having run.

### 2. Add daemon-owned claim and release boundaries

1. Add shared Zod request/response schemas and loopback routes for a ship-recovery claim and a
   confirmed-non-delivery release. Foreman never sends SQL-shaped fields or writes SQLite.
2. The claim request names the expected session, task id, logical key, generation, prompted decision
   identity, reason, attempt, and marker. The daemon re-resolves all current state before one
   compare-and-set write.
3. The daemon refuses unless the task is currently bound, kind `ship`, status `running` or
   `dispatching`; the work cycle is inactive and exact; there are no queue items or pending turns;
   there is no pending human review/input state; no non-terminal Workflow owns the session; and no
   task-owned open PR is currently projected.
4. Store the claim before injection. A worker restart sees it as spent/uncertain and never resends.
5. Permit release only when the daemon positively knows the injection did not land and the expected
   claim is still current. Lost responses and unknown outcomes remain claimed.
6. Calculate the next-at boundary from server time. Attempt 1 becomes due after the configured
   initial wait, attempt 2 after 40 more minutes, and attempt 3 after 80 more minutes. The next due
   event escalates without injection.

### 3. Build a pure decision core

1. Add `src/server/foreman/ship-shepherd.ts` with a pure input and exhaustive decision union. Inject
   `now`; perform no I/O or model calls in this file.
2. Gate in this order: feature permission; current invited task-owned ship binding; drivable and
   hook-instrumented live session; no human attention; no queue/pending turn; no Workflow owner; no
   task-owned open PR; inactive exact work cycle; settled idle past threshold; readable due recovery
   state; attempt budget.
3. Reuse or extract `hasPane`, `settledIdle`, active Workflow ownership, and the existing
   multi-repository PR projection. No scalar-only absence test is acceptable for an attached task.
4. Map state to one action:
   - Phase 1 `held` with blocking gaps: relay those bounded gaps;
   - no decision plus empty current diff: ask the session to re-read the durable objective and begin
     or resume implementation;
   - no decision plus non-empty current diff: request the bounded recovery reviewer;
   - `direct_handoff` with no observed PR: send an idempotent same-branch shipping continuation that
     first checks whether a PR already exists;
   - `verification_failed`: escalate without another model call;
   - unconsumed/retryable completion capture, `asked`, `workflow_claimed`, `retired`, active or parked
     Workflow, or current human decision: skip and name the owner.
5. A legacy consumed generation with no Phase 1 decision may use current diff shape after every other
   gate passes. It must not invent historical verifier gaps.

### 4. Add the bounded recovery reviewer

1. Add a dedicated tool-less prompt builder for only `idle_ambiguous`. Supply the durable objective,
   latest focus, bounded current diff, bounded recent transcript, repository standards, task
   completion contract, idle age, and prior recovery summary.
2. Ask for a closed structured result: `continue` with one bounded next-turn instruction, or
   `escalate` with a bounded reason. The instruction may resume implementation or verification only.
3. State forbidden authority in both prompt and post-parse policy: no commit, push, PR creation,
   merge, destructive cleanup, new task, human-answer substitution, or cross-repository expansion.
4. Use the configured Foreman runner and `reviewModel`. Add a stable append-only usage role such as
   `foreman-ship-recovery` if the ledger requires purpose-specific attribution; update every registry
   and exact-string reader together.
5. A spawn, timeout, parse, or policy failure consumes no new attempt unless the claim already may
   have led to a delivery. Record a bounded failure and retry on a later unclaimed pass; cap any
   pre-claim model failures to avoid a token hot loop and escalate at the fixed recovery budget.

### 5. Orchestrate one fleet-level pass

1. Add `runShipShepherd` beside backlog autopilot, pipeline triage, and review follow-through. It
   scans the full live fleet because the target is deliberately a parked session.
2. Run PR follow-through first, then the pre-PR shepherd. Union both returned session-id sets with a
   pass-wide `touchedThisPass`; the ordinary per-target loop skips every touched pane.
3. For each candidate, read the full queue decision, Workflow runs, goal, diff shape, and any pending
   owner state needed by the pure policy. Cheap structural gates precede transcript or model work.
4. Immediately before claiming, re-read config, session, queue, task/PR projection, Workflow runs,
   work cycle, and idle state. Immediately before injecting, confirm leader lease and pane identity.
5. Claim through the daemon, then inject one origin-`foreman` prompt. On confirmed non-delivery,
   release the exact claim. On success or unknown outcome, retain it.
6. Write one episode per recovery or escalation with a stable marker, situation, purpose, reason,
   attempt, drafted/delivered text, delivery outcome, idle age, and Phase 1 decision summary.
7. Stop after at most one instruction per session per pass. New activity naturally fails the next
   settled-idle check and a later completed generation starts a new reason-specific sequence.

### 6. Add operator controls and existing-surface visibility

1. Extend `ForemanConfigSchema` with `keepShipTasksMoving: boolean = true` and
   `shipRecoveryMinutes: integer 1..1440 = 20`. Old configs inherit defaults through parsing; no
   `app_config` migration is needed.
2. Update all complete config fixtures and server/client parsing tests. Keep the retry budget and
   later delays fixed constants, not new settings.
3. Add “Keep pre-PR ship tasks moving” near completion and pull-request follow-through in the
   Foreman popover. The control changes permission only; it does not bypass Live mode, trust, or
   invite gates.
4. Add the numeric threshold and explanatory text in Settings > Foreman. Use the existing number
   field saver so optimistic edits, validation, and server round trips follow current behavior.
5. Render recovery episodes through `ForemanDrawer` and the existing fleet ledger. Add concise labels
   for reason, attempt, next wait/exhaustion, and delivery outcome without adding a new collection or
   dashboard.
6. Copy must say the feature covers invited managed `ship` tasks in Live trusted repositories and
   stops when any task-owned PR appears.

### 7. Update documentation and operational contracts

1. Update `docs/foreman.md` with authority, eligibility order, config defaults, recovery actions,
   model use, backoff, uncertain delivery, and ledger entries.
2. Update `docs/work-queues.md` with the boundary between prompted completion, ship shepherd,
   Workflow ownership, direct shipping, and PR follow-through.
3. Update `docs/attention-and-alerts.md` with `verification_failed` and exhausted-recovery attention.
4. Update `docs/agent-guides/architecture.md` with the fleet-level pass and daemon-owned recovery
   projection.
5. Update `docs/agent-guides/change-contracts.md` with claim-before-inject, append-only ids, full
   multi-repository PR absence, and one-instruction-per-pane-per-pass obligations.

## Data, API, migration, and compatibility details

- Recovery identity is `(task id, logical key, work-cycle generation, reason, attempt)`. The stored
  marker is deterministic from that tuple and is the episode idempotency key.
- Phase 1's decision generation may be older than the current generation after a direct-shipping
  instruction completed. The direct-handoff reason retains the recorded decision identity and also
  compares the current settled cycle, so a new human intent or task binding cannot inherit it.
- A row from before Phase 1 or Phase 2 remains consumed and does not replay completion. It becomes a
  recovery candidate only after all current task, PR, ownership, idle, and diff gates pass.
- Full gap and payload text stays bounded and off compact SSE summaries. The queue detail and episode
  detail routes carry it on demand.
- Configuration defaults grant only feature-level permission. `enabled`, `mode === "live"`,
  `repoAllowlist`, `foremanInvite`, and reachability remain independent mandatory gates.
- The daemon claim must use its own current Registry, task manager, queue manager, Workflow manager,
  and PR projections. Trusting the worker's earlier eligibility booleans would turn a stale snapshot
  into write authority.
- Confirmed release does not decrement attempt history. It makes the same attempt eligible again
  only if the claim definitely did not reach a pane. Unknown delivery advances the budget.
- Episode markers and any new outcome/reason/usage ids are append-only.

## Tests and verification

### Pure policy

Add table-driven `test/foreman-ship-shepherd.test.ts` coverage for every gate, precedence rule,
outcome/action mapping, exact threshold boundary, all attempt transitions, legacy decision absence,
`verification_failed`, multi-repository PR presence, and structural-versus-model selection.

### Persistence, routes, and worker

Cover:

- fresh schema and migration from Phase 1 and pre-feature rows;
- malformed recovery JSON or partial scalar groups failing closed;
- exact compare-and-set claim, restart restoration, context rotation, rebinding, task terminalization,
  new activity/generation, and newly observed PR invalidation;
- confirmed non-delivery release and unknown delivery retention;
- attempts due at 20, 40, and 80 minutes followed by one escalation and no fourth injection;
- held gaps relayed once without a model call;
- empty diff and direct handoff using structural payloads;
- ambiguous diff making exactly one tool-less recovery call;
- model refusal/failure, forbidden-output rejection, and bounded escalation;
- active Workflow, parked Workflow, queue item, pending turn, human ask, off config, dry-run,
  off-allowlist, missing invite, working session, and any open task-owned PR suppressing delivery;
- a new completion after recovery returning to ordinary prompted verification;
- one pass never delivering both ship recovery and PR follow-through or ordinary wrap-up.

### UI and browser

- Extend `test/provider-config.test.ts`, `test/foreman-settings-render.test.ts`, number-setting tests,
  and episode/ledger render tests for defaults, persistence, accessible labels, and compact recovery
  state.
- Extend the existing Foreman configuration flow in `e2e/specs/dispatch-and-converse.spec.ts` rather
  than adding a settings-only duplicate. Prove the master toggle and threshold round-trip.
- In the built daemon with fake agents, drive an invited Live allowlisted ship task through settled
  idle, one recovery, agent pickup, and open-PR suppression. Select only by role, label, and visible
  text. Do not add `data-testid` and do not spend model tokens.

Run at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/foreman-ship-shepherd.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/queue-db.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/prompted-wrapup-worker-e2e.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/provider-config.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/dispatch-and-converse.spec.ts --workers=1
```

If implementation changes Electron geometry, also run `npm run test:electron` with the repository's
required sandbox approval. Otherwise the built Playwright flow is the required runtime proof.

## Merge and exit criteria

- Every approved recovery action and refusal is represented by the pure decision table.
- Live injection requires all global, repository, invite, task, idle, ownership, PR-absence, due,
  and attempt gates at the final daemon claim.
- The exact incident can no longer stall silently: Phase 1 normally advances to Workflow; a genuine
  held gap is re-delivered after the quiet threshold.
- Three attempts occur at the approved delays and then stop with visible human attention.
- Structural cases spend no model tokens; only ambiguous non-empty implementation uses the bounded
  tool-less reviewer.
- The toggle, threshold, session drawer, and fleet ledger agree with daemon-owned state.
- Unit, typecheck, lint, build, smoke, and focused Playwright gates pass, with evidence attached to
  the pull request and not committed.
- One reviewable pull request merges with no unresolved actionable comments.

## Downstream handoff

After this phase merges, later work may rely on:

- one pre-PR shepherd covering all invited task-owned ship sessions until any task-owned PR appears;
- one daemon-owned recovery projection and CAS claim/release protocol;
- a default 20-minute first wait, fixed 40- and 80-minute later waits, and escalation afterward;
- structural recovery for known states and exactly one bounded model path for ambiguity;
- existing drawer and ledger surfaces as the recovery audit;
- current Workflow, queue, human-input, PR, Inspector, Shipping, and review-follow-through owners
  retaining precedence.

Later changes must not broaden the task-kind scope, add unbounded retries, bypass Live/trust/invite
gates, infer PR absence from only the primary repository, or let a model authorize shipping actions
without a new explicit product decision.

## Cross-phase audit record

- Entry audit: every name consumed from Phase 1 is a direct dependency. This phase adds recovery state
  beside the decision and never rewrites completion truth.
- Policy audit: all approved choices are implemented here: all managed ship tasks, structural plus
  targeted model, 20-minute initial threshold, and three attempts with 20/40/80 timing.
- Ownership audit: review follow-through runs first, the shepherd runs second, and both share the
  pass-wide touched set. Queue, Workflow, pending-turn, and human owners all win before recovery.
- Compatibility audit: legacy consumed rows have no invented verdict and can only take current-state
  empty/ambiguous/direct paths after every modern gate passes.
- Safety audit: claim-before-inject, conservative unknown delivery, daemon-only writes, existing PR
  observation, full multi-repository absence, and one instruction per pane are all explicit exit
  criteria rather than implementation suggestions.
- Final full-set audit: Phase 1 owns completion boundary and decision; Phase 2 owns attempts, delivery,
  controls, audit, and escalation. Every source-plan requirement is owned exactly once, there is no
  undocumented cleanup phase, and the final repository is operable after either merge.
