# Phase 2: Prompted completion cutover

## Outcome and value

Prompted automatic completion consumes the durable work-cycle generation introduced in Phase 1.
After an incomplete check, a later background continuation under unchanged human intent becomes a
new completion opportunity exactly once. Intent revisions and evidence fingerprints keep their
existing objective, proof, and idempotency roles but no longer act as lifecycle turn identity.

The worker also rejects verifier results that became stale because work restarted, a newer turn
completed, the logical session key rotated, or intent changed during the model call.

## Entry criteria and direct dependencies

- Phase 1 has merged and its final shared type, persistence accessor, Registry transition, and
  restart invariants are available on the default branch.
- The planning artifacts have merged to the default branch.
- The tactical incident fix has landed or was explicitly superseded before Phase 1, and Phase 2 has
  inspected its changed files and retained valid regression coverage.

## Scope

- Replace prompted intent/evidence re-arming with work-cycle generation selection and consumption.
- Add durable consumed-generation state and legacy migration behavior to Foreman's queue row.
- Recheck generation, logical key, resolved intent, settled idle, and human-attention state after
  verification.
- Make direct hold, Ask, direct wrap-up, and workflow claim paths consume the expected generation
  exactly once.
- Rekey bounded verifier-failure tracking to the completion generation.
- Remove the prompted workflow-delivery guard reset once natural turn completion owns re-arming.
- Update behavior docs and focused worker/workflow coverage.

## Non-goals

- Do not change the Phase 1 definition of a work cycle.
- Do not modify queue-drain ownership, item states, repair prompting, or drain workflow re-arming.
- Do not replace the verifier, alter its prompt, or change gap severity policy.
- Do not broaden Live authorization, direct shipping, workflow binding, or task-completion policy.
- Do not add user-visible UI.
- Do not keep the legacy intent/evidence trigger active as a permanent fallback.

## Repository findings and inherited contracts

- `SessionQueue.promptedGoal` and the persisted `foreman_queues.prompted_goal` currently store an
  opaque intent episode, despite the historical name. The new consumed generation needs its own
  additive field; do not silently change the old column's value type again.
- `decidePromptedWrapup` owns structural candidate policy. It should compare the current work-cycle
  summary to the queue's consumed-generation marker while retaining all existing gates and the
  queue-overlap rule.
- `processPromptedWrapup` owns evidence I/O and ordering. It currently re-reads session and goal after
  verification but checks only intent currency. It must also require Phase 1's same generation and a
  still-settled session before reaching workflow claim or direct action.
- `PromptedFailureTracker` is currently keyed to an intent episode. The bounded retry unit becomes one
  completion generation so a later genuine turn can recover from an earlier generation's verifier
  failures without hot-looping the failed one.
- Workflow store claim logic already validates current intent and retires a guard transactionally.
  Extend that compare-and-set boundary to the expected work-cycle generation rather than adding an
  out-of-transaction worker write.
- `rearmPromptedCompletionForDelivery` clears `prompted_goal` because the current model has no natural
  turn token. After cutover, a delivered prompt's later normalized turn end advances the Phase 1
  generation and makes this reset unnecessary. Drain re-arm remains unchanged.
- `promptedCompletionClaim` already includes intent and evidence in its marker. Add the expected
  completion identity to the proof so idempotency distinguishes later turns under the same intent.
- The direct wrap-up payload loop guard remains necessary because injected authorship is not durable.

## Implementation steps

1. Add an additive consumed-generation field to the Foreman queue schema, shared queue type, row
   mapping, CRUD paths, rekey paths, pruning predicates, routes, clients, and every fixture that owns
   the full queue shape. Name it for completion generation rather than overloading `promptedGoal`.
2. Implement one daemon-owned compare-and-set operation that consumes an expected generation for a
   logical session key. It must refuse when the current Phase 1 generation differs, the queue already
   consumed it, or the logical key no longer resolves to the same session. Direct retire/Ask writes
   should use this operation.
3. Define legacy bootstrap in the daemon read/write boundary. If `prompted_goal` matches the current
   resolved intent and no new consumed-generation value exists, initialize the current work-cycle
   generation as consumed. If no legacy guard exists, leave the latest completed generation eligible.
   The migration must be idempotent and fail closed on missing Phase 1 state.
4. Update prompted candidate selection to require an unconsumed completed generation in addition to
   all existing structural, capability, queue-overlap, intent, instrumentation, and settled-idle
   gates. An intent revision no longer re-arms by itself; it changes what a later generation is judged
   against.
5. Carry the logical key and expected generation through evidence gather, failure tracking, plan, and
   claim builders. Empty diff and artifact-ineligible paths consume the expected generation without a
   model call. Incomplete and contradictory verdicts consume it without injecting fix work.
6. After the verifier returns, re-fetch live session state and intent. Require the same resolved
   intent, logical key, Phase 1 generation, settled idle state, and no human-attention bucket before
   any consume or action. A stale result returns without consuming either the old or new generation.
7. Extend workflow completion claim validation and its transaction to compare and consume the
   expected generation. Include the generation in the claim marker and workflow event evidence. A
   stale or duplicate claim fails closed and cannot fall through to unreviewed direct wrap-up.
8. Preserve mark-before-type ordering for direct wrap-up. Ask-card creation and generation
   consumption remain one daemon write where the current route already makes prompted guard and card
   atomic. A failed injection never replays automatically.
9. Remove prompted delivery's explicit `prompted_goal` clear and update the exactly-one re-arm choice:
   queue-backed deliveries still re-arm drain; queue-less prompted work waits for the delivered
   turn's natural completed generation. Session-action deliveries remain excluded.
10. Stop reading `prompted_goal` as the active guard after compatibility bootstrap. Keep its column
    and safe row mapping for database compatibility, but remove comments and tests that claim a new
    human prompt is the only re-arm. Do not leave an evidence-fingerprint or intent-revision fallback.
11. Update `docs/work-queues.md`, `docs/workflows.md`, and any architecture reference touched by Phase
    1 so operator and technical documentation describe once-per-completed-work-cycle behavior and the
    natural repair-delivery loop.

The named files and operations are the investigated route, not a specification. Follow the Phase 1
contract as merged and adapt to the tactical fix where repository reality differs, recording any
deviation and reasoning in the pull request.

## Data, API, migration, and compatibility

- Add the consumed-generation column through both fresh schema and `addColumn` migration paths.
- Keep `prompted_goal` persisted and readable for upgrade bootstrap. Do not delete or rename it in
  this phase because historical databases and older rows still carry it.
- Bootstrap must not replay a legacy retired session. It must also not mark a never-handled session
  consumed merely because it has a resolved intent.
- Once bootstrap resolves a row, current code reads and writes only the consumed-generation field for
  prompted lifecycle decisions.
- An HTTP-only Foreman worker never writes SQLite. All consume and workflow-claim mutations remain
  daemon routes backed by daemon-owned transactions.
- The workflow claim transaction must compare the submitted generation with the current Phase 1 row,
  not only with the worker's session snapshot.
- Coalesced generations are intentional. If generation N+2 is current before N+1 was evaluated, judge
  N+2 once and consume it; do not replay stale intermediate turns.
- Missing Phase 1 state, key mismatch, state drift, or transaction failure fails closed without direct
  wrap-up fallback.

## Tests and verification

Add or update focused tests that prove:

- `Stop N` is verified incomplete and consumed; a machine task notification leaves intent unchanged;
  `Stop N+1` causes one later verification and one workflow claim at most;
- the same generation is checked once across worker ticks and daemon restart;
- a newer generation under the same intent re-arms;
- a human intent revision without a later completed work cycle does not fire by itself;
- idle notification, passive refresh, external edit, and duplicate turn end do not re-arm;
- empty diff consumes the generation without a verifier call;
- work beginning during verification discards a complete verdict and consumes nothing;
- a newer completion during verification discards the old verdict and leaves the latest generation
  eligible;
- logical key rotation or intent reconciliation during verification discards the result;
- verifier failures retry only to the existing cap for one generation, never hot-loop, and a later
  generation starts with a fresh bounded counter;
- direct Ask and direct wrap-up consume before action and never double-offer or double-push;
- workflow claims validate and consume generation atomically and remain idempotent;
- one confirmed Live repair delivery no longer clears the legacy prompted guard, yet its later
  completed turn opens exactly one next workflow round;
- queue-backed sessions still choose drain and never prompted completion;
- legacy matching `prompted_goal` bootstraps as consumed, while a null legacy guard remains eligible;
- upgraded databases and restart recovery preserve the new guard.

Run at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/prompted-wrapup.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/prompted-wrapup-worker-e2e.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-foreman-claim.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-repair-cycle.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-resumption.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
```

Also run focused queue database, queue HTTP, migration, and workflow store files changed by the final
implementation. If any visible UI changes despite the non-goal, add and run the required Playwright
spec under `e2e/`.

## Merge and exit criteria

- One pull request performs migration, cutover, atomic consume, stale-result protection, workflow
  simplification, documentation, and all regression coverage together.
- No permanent intent-revision or evidence-fingerprint prompted trigger remains active.
- The background-task incident reproducer passes for terminal Claude and the generic contract remains
  covered for Codex and SDK.
- Queue-drain, direct Ask/wrap-up, workflow claim, repair resumption, empty-diff, and verifier-failure
  behavior remain green.
- The full unit suite, typecheck, lint, build, and smoke pass.
- CI is green and all valid review findings are resolved before merge.
- Documentation states that prompted completion is once per completed work cycle, not once per human
  prompt.

## Downstream handoff

After this phase merges, later work may rely on:

- work-cycle generation as the only active re-arm identity for prompted completion;
- intent as the objective and staleness guard, never the completed-turn id;
- evidence fingerprints as proof and claim idempotency, never the lifecycle trigger;
- atomic expected-generation consumption for workflow and direct action paths;
- natural repair-delivery re-arm through the delivered turn's completion;
- queue drain remaining a separate, higher-precedence trigger when items exist.

Later work must not restore `prompted_goal` clearing, add output-change fallback triggers, or bypass
the post-verifier work-cycle currency check without a new approved design.

## Cross-phase audit record

- Initial audit against Phase 1: this phase consumes the shared summary, durable accessor, logical-key
  semantics, and duplicate/restart invariants exactly as handed off. It adds no raw event handling.
- Migration audit: legacy `prompted_goal` is retained only to initialize the new consumed generation.
  There is no merged dual-trigger state, satisfying the source plan's replacement decision.
- Ownership audit: daemon transactions own mutation; the external Foreman worker remains HTTP-only and
  never touches SQLite.
- Trigger audit: queue drain retains precedence and its own repair re-arm. Prompted delivery's manual
  reset is removed only after Phase 1's completed-turn path proves the natural re-arm.
- Final-scope audit: every remaining source-plan behavior belongs here or Phase 1. No test,
  documentation, migration cleanup, or fallback removal is deferred to another phase.
