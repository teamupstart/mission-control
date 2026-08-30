# Fast installed-app session bootstrap: phased implementation

## Source and approved decisions

Source plan: [`plan.md`](plan.md).

The operator approved the startup direction in conversation and directly requested phased planning
and scheduling. The fixed outcome is to serve the Board before SDK driver restoration finishes,
render persisted live SDK rows as inert restoring cards, replace them with real cards as adoption
completes, and preserve the existing first-discovery reconciliation gate.

Resolved decisions:

- The ordinary daemon-served React app is the startup surface. There is no separate packaged
  `file://` loading application.
- Restoring rows use a dedicated transient projection. They are not synthetic `Session` entries and
  do not reuse dispatching `Task` rows as authority.
- HTTP serving moves before awaited SDK restoration, while terminal discovery remains after it.
- SDK restoration stays serial. This plan removes it from first paint but does not attempt provider
  concurrency.
- The snapshot-to-subscription SSE gap is fixed as part of the same change because background
  startup mutations make it a correctness boundary.

## Investigated repository findings

- `src/server/index.ts` owns state-home locking, database open, every manager, SDK restore, poller
  startup, route construction, static serving, and shutdown. The merged exclusive state-home lock
  must remain before SQLite and before HTTP.
- `SdkSupervisor.restore()` queries readable live `sdk_sessions` rows and awaits each `resume()` in
  order. Its actual invariant is registration or eviction before the first completed terminal
  observation, not before HTTP bind.
- `Registry` loads active tasks synchronously from SQLite, while the supervisor can derive names and
  repository context for persisted SDK rows before a driver exists.
- `StartingStrip` intentionally renders tasks outside the real session collection. Its visual
  grammar is reusable, but its `dispatching && sessionId === null` projection cannot represent
  restored SDK sessions.
- `Registry.snapshot()` and `useEventStream` are the whole browser bootstrap. A new transient
  collection must update the shared event union, Registry snapshot, browser reducer, and explicit
  Line-event decision together.
- `src/server/sse.ts` snapshots before subscribing. Concurrent background restoration could land an
  event between those operations, so the handler must queue before it captures the snapshot.
- `e2e/specs/sdk-idle-restore.spec.ts` already proves built-daemon crash/restart restoration against
  fake agents and the disposable fixture database. It is the closest working example and can share
  a resume-delay fixture contract with the new browser regression.
- The current `shutdown()` sequence assumes `restore()` finished before a signal can arrive. Early
  serving invalidates that assumption, so the supervisor must own the in-flight restore promise and
  stop boundary.
- The change has one repository, no schema migration, no generated-file owner, and no external
  service contract.

## Sizing estimate

Estimated non-test implementation: **420-620 gross lines** added or materially changed.

Assumptions behind the range:

- 70-110 lines for the shared transient projection, snapshot/events, and browser reducer;
- 140-210 lines for supervisor preparation, projection retirement, restore ownership, and shutdown;
- 80-130 lines for server startup reordering and race-free SSE bootstrap;
- 100-140 lines for Board projection, transition rules, and styles; and
- 30-50 lines for architecture and packaged-startup documentation.

Tests are excluded from the estimate. Focused supervisor/SSE coverage plus built Playwright restart
coverage is expected to be comparable in size to the production change because concurrency and
negative action eligibility need direct proof.

## Phase-count rationale

This plan has exactly one implementation phase even though the estimate exceeds 200 lines.

The transient wire projection, early HTTP bind, restore ownership, browser card, and SSE ordering
form one vertical startup boundary. Splitting them would create one of three invalid intermediate
states:

- a published restoring projection that can never appear because restore still blocks HTTP;
- an early-serving daemon whose Board falsely says no sessions exist; or
- a visible ghost surface whose events can be lost during the initial SSE snapshot.

The work is concentrated in existing owners with no migration and one established E2E restart
fixture. One agent can implement and verify the complete transition more safely than two agents
handing off a temporary startup protocol. A second observability or parallel-restore phase would add
scope rather than complete the selected outcome.

## Phase table

| Phase | Name | Outcome | Direct dependencies | Merge unit |
|---|---|---|---|---|
| 1 | Serve the Board while SDK sessions restore | The packaged app paints an inert restoring-session Board before serial SDK adoption completes, without weakening reconciliation, SSE, or shutdown correctness | Planning session | One pull request in this repository |

## Dependency graph and merge order

```text
planning artifacts merged
          |
          v
Phase 1: early serve + restoring projection + safe handoff
          |
          v
       complete
```

There is one implementation task. It depends directly on this planning session and remains in the
backlog until the planning pull request publishes all three Markdown paths to the default branch.
There is no phase-to-phase concurrency group or internal merge edge.

## Cross-phase contracts

With one phase, these are implementation invariants and future handoff constraints:

- `acquireStateOwnership()` stays before `openDb()`, and both stay before route serving.
- `Registry.sessions` contains only sessions with an owned terminal process or adopted SDK driver.
- The transient restoring collection is rebuilt from existing SDK rows, bounded by readable live
  rows, and never persisted.
- Real session identity wins over a provisional projection with the same id.
- A restore failure continues through `registerAndEvict()` and `Registry.beginEviction`; there is no
  second teardown or durable cleanup signal.
- Terminal discovery begins only after every prepared SDK row has settled through success or
  existing failure handling.
- The SSE initial delivery subscribes before snapshot capture and tolerates duplicate idempotent
  events rather than risking a missing event.
- Restoring rows do not enter session-derived Line, Sitrep, alert, notification, Foreman, Workflow,
  search-count, drag/drop, selection, or action logic.
- Shutdown prevents new restore launches, settles the in-flight launch, cleans disposable resources,
  and stops adopted handles through the supervisor.
- `/api/health` means the daemon is serving, not that every restored conversation is ready.
- Restoration remains serial until separately measured and approved work changes that policy.

## Final verification strategy

The implementation task runs focused supervisor, session-runtime, and SSE tests before the full
suite. It then builds the production bundles and drives a real built daemon through crash/restart
with a resume-only delayed fake SDK agent. The browser must observe the provisional Board while the
driver is still blocked, prove the cards are inert, and then observe an exact one-for-one handoff to
real sessions.

Required gates:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/sdk-supervisor.test.ts test/session-runtime.test.ts test/sse-initial-delivery.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/sdk-startup-bootstrap.spec.ts
npx playwright test e2e/specs/sdk-idle-restore.spec.ts
```

The focused SSE file is intentionally new because the repository does not currently have a generic
test owner for `src/server/sse.ts`. A final pull request must include captured built-Board evidence
for both restoring and settled states.

## Complete-plan audit

- Every selected behavior in `plan.md` is owned by Phase 1.
- The phase is independently operable and leaves no dead contract for a later phase.
- No source-plan requirement relies on a schema migration, external repository, or undocumented
  cleanup.
- The phase inherits the merged state-home lock and isolated agent subprocess state rather than
  proposing parallel ownership.
- The projection, startup, UI, lifecycle, failure, shutdown, SSE, documentation, and E2E obligations
  agree on one stable session id and one real-session authority.
- No concurrent phase can merge out of order because there is no second phase.
- The task may rely on the source plan, phased index, and phase guide only after this planning pull
  request merges.

Audit result: **one phase is sufficient and required for a truthful vertical slice**.

## Cross-phase audit record

- 2026-08-30: Reconciled the operator-selected restoring-card approach against current `main` after
  state-home ownership, Pipeline commission recovery, and agent subprocess isolation merged.
- 2026-08-30: Kept HTTP bind after exclusive state ownership and database initialization, but moved
  awaited SDK adoption behind serving while retaining the first-discovery gate.
- 2026-08-30: Rejected synthetic `Session` entries because existing shared action predicates would
  make a driverless card actionable.
- 2026-08-30: Folded SSE bootstrap ordering into Phase 1 because concurrent restore events make the
  existing snapshot-before-subscribe gap load-bearing.
- 2026-08-30: Kept serial driver restoration and excluded a second optimization phase because the
  approved goal is immediate Board bootstrap, not provider concurrency.
