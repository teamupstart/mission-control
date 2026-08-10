# Phase 4 - The Foreman worker on the SDK transport

## Outcome

Foreman's four headless calls - the Tier 2 full review, the work-queue verify, the autopilot
backlog planner and the Tier 1 triage router - can run on the SDK transport, in the separate
worker process, with spend still landing in the ledger through the HTTP outbox.

Engineering value: the last of the three subsystems moves, so the transport is no longer a
daemon-only capability with a Foreman-shaped hole in it.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 2.** The transport, the config switch and
  `runClaudeSdkOneShot` must exist.
- **Not dependent on Phase 3**, and runs **concurrently with it**. Foreman holds no tool grants
  on any of its four sites, so nothing here touches the grant path. The two phases share no
  files: this one owns `src/server/foreman/`, Phase 3 owns `src/server/inspector/` and the grant
  branch of `claude-sdk.ts`.

## Scope

In scope: proving the SDK transport works in the worker process, and the four Foreman call sites
(A1-A4).

Explicit non-goals:

- **Changing the default transport.** Phase 5, and only after Phase 3 has also landed.
- **Tool grants.** Foreman has none and must not acquire any here.
- **The worker's serial loop, lease, or posture logic.** Untouched.
- **Fixing the six `?? "claude"` sites.** Real, adjacent, and out of scope - see the source
  plan's adjacent findings.

## Repository findings

### The bundling risk the source plan named does not exist

This phase was described as "the bundling phase" and "most likely to fail late". Investigation
retired that:

- **There is no `build:foreman`.** `npm run build` is `build:web`, `build:server`, `build:main`,
  `build:mcp`, `build:hook`, `build:codex-hook` (`package.json:23`). The worker is not among them.
- **The worker runs from TypeScript source**: `"foreman": "tsx src/server/foreman/worker.ts"`
  (`package.json:34`), plus `dev:foreman` (`:20`) and the demo launcher. So it resolves
  `node_modules` at runtime like any `tsx` entry point and needs no bundle work at all.
- **The daemon bundle already carries the SDK correctly**, as a lazy dynamic-import specifier
  rather than inlined vendor code, and the interactive driver proves that resolution works in the
  packaged app.

What survives is not bundling but **process topology**, below.

### The worker is a different process with a different spend sink

This is the real constraint, and it is documented in the code:

- The worker is **forbidden from opening SQLite**. It talks to the daemon over HTTP through
  `ForemanClient` (`src/server/foreman/client.ts`).
- Spend goes `reportLlmSpend` → the worker's sink (`worker.ts:274`) → `client.reportSpend` →
  `POST /api/usage/automation` (`routes.ts:3023-3043`) → `recordSpendReport`. **Pricing happens on
  the daemon only** (`spend-ledger.ts:35-45`) - "the worker reports tokens; the daemon values
  them" - so a restart of one process cannot make the two price differently.
- The route distinguishes `recorded` → 204, `empty` → 204, `unsupported` → **422**, so a worker
  newer than its daemon keeps the report in its durable outbox rather than deleting spend that
  never landed (`worker.ts:280-306`).
- No limiter or scheduler can span the two processes, because module-level counters are
  per-process (`llm/structured.ts:47-51`, `llm/review-scheduler.ts:10-16`).

None of that changes with the transport. It is listed because a change that accidentally made
the worker write the DB, or price its own tokens, would be a serious regression that no test in
this phase would otherwise be looking for.

### The worker reads its runner over HTTP, not from the DB

`worker.ts:330` refreshes the runner once per outer loop pass from `cfg.runner ?? client.llmRunner()`
(`client.ts:912`, backed by `GET /api/llm/status`). The transport switch must reach the worker the
same way or through `envVar` - it cannot read `app_config` directly.

**This is the one genuine design decision in this phase.** Two workable answers:

1. **`envVar` only for the worker.** Simplest, honest, and matches how the worker already gets
   every other machine-wide knob. Cost: an operator toggling the transport in Settings changes it
   for the daemon and not for Foreman, which is a confusing split.
2. **Surface it on `GET /api/llm/status`** beside `runner`, and have the worker read it per pass
   exactly as it reads the runner today. Cost: a field on `LlmStatus` (`src/shared/types.ts:2056-2061`),
   which is a wire-contract change.

Prefer (2) - it keeps one operator-visible answer to "which transport is this machine using" -
but (1) is acceptable if (2) turns out to need UI work this phase should not own. Record the
choice and the reasoning in the PR either way.

### Two of the four sites bypass `runStructured`

Tier 1 triage calls `deps.runModel` then `parseModelJson` directly (`triage.ts:606-611`), with no
ladder and no observer. Phase 1 already gave it a schema; this phase must not accidentally route
it through the ladder while changing transports.

### The Foreman's own timeouts are unchanged

A1 and A2 pass no `timeoutMs` and inherit `claude-cli.ts`'s default; A3 scales with backlog size;
A4 is 30s. Under the SDK transport these must map to the abort controller with the same values.
The full review blocking for up to `2 × REVIEW_TIMEOUT_MS` is a stated property of the serial
loop (`worker.ts:217, 950`), so a transport that changed the effective ceiling would change the
worker's latency contract silently.

## Implementation steps

1. **Decide and implement how the worker learns the transport** - the design decision above.
   If (2): add the field to `LlmStatus`, populate it in `llmStatus()`
   (`src/server/llm/config.ts:82`), read it in `client.ts` beside `llmRunner()`, and refresh it in
   the same once-per-pass place (`worker.ts:330`).

2. **Verify the SDK resolves in the worker process.** A `tsx`-run entry point importing a lazily
   `import()`ed ESM package is the case to prove, not assume. If it does not resolve, the fix is
   in `sdk-deps.ts` and belongs here.

3. **Confirm `killLiveLlmRuns` still covers the worker.** `worker.ts:257` calls it inside
   `installShutdown`. Phase 2 made `claudeRunner.killLiveRuns` cover both transports; assert it
   from the worker's side too, because detached `-p` children and in-flight SDK queries fail
   differently and only one of them was ever exercised here.

4. **Leave all four call sites' options alone** apart from what the transport switch changes.
   Their models, timeouts and roles are correct today.

## Data, API and compatibility

- If the `LlmStatus` route gains a field, an older worker paired with a newer daemon simply does
  not read it and stays on `print` - correct degradation, no version negotiation needed.
- A newer worker paired with an older daemon gets `undefined` and must fall back to `envVar` then
  `"print"`, never to `"sdk"`.
- **No migration.** No persisted shape changes in this phase beyond what Phase 2 already added.

## Tests and verification

- **`test/foreman-codex-runner.test.ts`** is the model: it proves Foreman's structured review
  really routes through a chosen runner with the selected model. Add the transport twin.
- **`test/foreman-spend-delivery.test.ts`** (20 tests) covers the outbox. Assert an SDK-transport
  run produces a report the daemon prices identically - same `role`, a non-empty `runId`, the
  same model breakdown. A report with no `runId` is dropped by `spendReportIsRecordable`
  (`llm/spend.ts:82-87`), so this is the assertion that catches the silent-vanish failure mode.
- **A test that the worker never opens the database**, if one does not already exist in this
  area. The constraint is stated in the repository instructions and is exactly the kind of thing
  a transport change could violate by importing a module with a side effect.

```sh
node --test --test-concurrency=2 --import tsx test/foreman-codex-runner.test.ts
node --test --test-concurrency=2 --import tsx test/foreman-spend-delivery.test.ts
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
```

Beyond the automated suite, run the worker for real against a live daemon with the transport on
(`npm run foreman`) and confirm a review completes and its spend appears in the automation line.
The worker's HTTP path is not exercised by the unit tests end to end.

## Merge and exit criteria

- All four Foreman sites complete on the SDK transport with verdicts of the same shape.
- Ledger rows appear with roles `foreman:review`, `foreman:verify`, `foreman:backlog`,
  `foreman:triage`, each with a `runId`, priced by the daemon.
- The worker still opens no database and still holds its lease correctly.
- The default transport is **still `print`**. This phase proves the worker can; Phase 5 decides
  that it does.

## Downstream handoff

Phase 5 may rely on:

- **All four Foreman sites working on `sdk`**, so the flip does not strand the worker.
- **However the worker learns the transport** - Phase 5 flips a default, and must flip it in a
  way both processes observe. If this phase chose `envVar`-only, Phase 5 inherits the split and
  must say so in its documentation rather than pretend the toggle is unified.

Later phases must not change:

- The worker's read-only relationship to the database.
- Pricing living on the daemon.
- The 422/204 outbox semantics.

## Cross-phase audit record

- **Written fourth.** Reconciled against Phase 2: this phase adds no branch to
  `runClaudeSdkOneShot`, so it cannot conflict with Phase 3's grant branch. Both depend on Phase 2
  alone and merge in either order.
- Reconciled against Phase 3: confirmed no shared file. Phase 3 touches
  `src/server/inspector/` and the grant path; this phase touches `src/server/foreman/` and
  possibly `LlmStatus`. If Phase 3 also needed `LlmStatus` it would be a conflict - it does not.
- Recorded against the source plan: the plan called this "the bundling phase". The repository
  disproves it. The phase kept its place in the graph because the process-topology work is real,
  but its risk profile and its exit criteria were rewritten from the code rather than the plan.
- **Reconciled after Phase 5 was written:** the transport-discovery decision in step 1 is
  consumed by Phase 5's flip. Phase 5 was written to depend on whichever answer this phase
  records, rather than assuming the `LlmStatus` route.
</content>
