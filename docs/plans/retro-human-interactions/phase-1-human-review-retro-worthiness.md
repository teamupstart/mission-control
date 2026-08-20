# Phase 1: Human review interactions make Retro eligible

## Outcome and value

A human decision made through any Mission Control review surface becomes authoritative
retro-worthiness evidence for its session. The session gains the existing `corrections` reason
immediately, regains it after a daemon restart, and shows **Run retro** once the unchanged Inspector
timing gate is clean.

This fixes the observed **Add keybinding for To review button** session and the sibling MCP review
paths that fail for the same protocol reason.

## Entry criteria and dependencies

- Direct phase dependencies: none.
- Planning dependency: the pull request publishing
  [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md), and this phase file must merge before
  implementation dispatch.
- The implementation starts from the default branch containing those artifacts.
- Read the repository root `AGENTS.md`, `.agents/memory/MEMORY.md`,
  `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`, and
  `e2e/README.md` before editing.

## Scope

### In scope

- Review-backed live retro eligibility through the existing Registry projection.
- Durable, bounded reconstruction when a terminal or SDK session is introduced after restart.
- Exact human authorship through `isHumanResolvedReview`.
- Accurate tooltip and documentation language for human steering.
- Focused unit, integration, and browser regression coverage.

### Explicit non-goals

- A new database table, column, or migration.
- A new `RetroReason`, `Session` field, ServerEvent, API route, or browser-side review lookup.
- Automatic retro delivery.
- Any change to Inspector cleanliness, post-merge follow-up routing, or skill enablement.
- Counting runtime permission prompts, Foreman answers, orphaned reviews, failed answers, or pending
  questions as human steering.
- Teaching transcript parsers to render raw tool results.

## Repository findings and inherited contracts

### Review lifecycle

- `src/server/reviews.ts` owns durable settle and publish order.
- `ReviewManager.record` is the born-settled SDK question path.
- `ReviewManager.resolve` and its private `settle` path own human and Foreman resolution for MCP
  reviews.
- `src/shared/review-item.ts:isHumanResolvedReview` is already used by live conversation rendering
  and the durable SQLite query. Reuse it instead of spelling actor/status rules again in server code.

### Retro projection

- `src/server/registry.ts` owns the one-way in-memory signal and derives `Session.retro` through
  `retroSummaryFor`.
- `src/server/retro-worthiness.ts` remains the transcript-text producer.
- `src/web/lib/retro-offer.ts` remains the only browser eligibility predicate.
- `corrections` stays the wire id. Its broadened documented meaning is human steering beyond the
  opening brief, not only a corrective prose message.

### Durability and bounds

- Resolved human reviews already survive restart in SQLite and are queried by
  `loadHumanResolvedReviews` for the conversation.
- Registry startup restores only pending reviews, so review-backed retro eligibility needs its own
  focused existence read.
- Do not preload all historical review session ids. Query when `applyDiscovery` first introduces a
  terminal row and when `registerSdkSession` first introduces an SDK row, or use an equivalent
  central new-session seam with the same bound.
- Eviction through `Registry.beginEviction` and `session_remove` remains the only cleanup path. The
  existing retro signal deletion stays there.

## Implementation steps

### 1. Add a durable per-session existence predicate

In `src/server/db.ts`, add a focused helper that answers whether one session has at least one review
matching the durable SQL form of `isHumanResolvedReview`:

- the requested `session_id`;
- `resolved_by = 'human'`; and
- a status in `HUMAN_REVIEW_STATUSES`.

Use `SELECT 1 ... LIMIT 1` or an equivalent bounded existence query. Reuse the shared status set so
the query cannot silently drift from `loadHumanResolvedReviews`. No schema or migration changes are
needed.

Add database coverage showing human answered, approved, rejected, and dismissed rows match, while
pending, Foreman, orphaned, and legacy unattributed rows do not.

### 2. Restore review-backed eligibility when a live session is introduced

In `src/server/registry.ts`, route first-time terminal and SDK session creation through a small shared
hydration helper or equivalent logic:

1. query the durable predicate once for the new session id;
2. seed the existing in-memory retro interaction flag when it matches; and
3. derive the initial `Session.retro` projection after the seed, before the first emitted session
   payload.

Do not run the query on every discovery sweep or every session update. Do not retain ids for sessions
that were never introduced. Keep normal `session_remove` cleanup authoritative.

If implementation clarity benefits from renaming internal `retroCorrections` or
`recordRetroCorrections` symbols to describe human interaction, do so consistently across the
poller and tests. Do not rename the wire reason.

Add a restart-style test that persists a human-resolved review, constructs a fresh Registry,
reintroduces the same terminal or SDK session, and observes `retro.reasons = ["corrections"]` on its
first projection. Assert a session without such a row remains ineligible and eviction clears the
live flag.

### 3. Mark successful live human review settlement

In `src/server/reviews.ts`, centralize the post-commit publication step used by both `record` and
`settle`, or make equivalent explicit calls:

1. persist the complete settled row;
2. publish it with `registry.upsertReview`;
3. when `isHumanResolvedReview(updated)` is true and the owning session row still exists, mark that
   session through the Registry's existing one-way retro signal; and
4. preserve the existing waiter and Foreman-note ordering.

The mark must happen only after successful delivery where applicable and after the database write
commits. A thrown transaction, refused SDK answer, Foreman resolution, orphan settle, or resolution
of a dangling review with no session row must not retain or emit a retro interaction signal.

Extend focused tests around `ReviewManager` and the SDK answer routes:

- human MCP review resolution marks the session;
- human SDK form and single-option answers mark the session;
- Foreman answers do not;
- permission and refused driver requests record nothing and do not mark;
- failed born-settled transactions do not mark;
- repeated human settles remain idempotent.

### 4. Clarify reason copy and product documentation

Update `src/web/lib/retro-offer.ts` so the `corrections` explanation describes the common concept,
for example “you steered it during the work,” rather than claiming every qualifying review corrected
an error.

Update the owner documentation in `docs/repository-memory.md` to state that the worthiness half can
come from either an unattributed human transcript turn beyond the brief or a durable
human-resolved review. Update the retro evidence section in `e2e/README.md` if its description of
the proof changes.

Do not duplicate the eligibility algorithm in general UI documentation. Keep the detailed rule in
the repository-memory owner document and link to it where necessary.

### 5. Prove the browser consequence

Extend `e2e/specs/retro-offer.spec.ts` with a regression that uses the existing fake Claude
`AskUserQuestion` behavior:

1. enable the Retro skill before dispatch;
2. dispatch the marker that makes the fake SDK agent ask its linter questions;
3. answer the form through the dashboard;
4. prove the session acquires `retro.reasons = ["corrections"]` without typing a composer reply;
5. prove **Run retro** is still absent before review completion;
6. announce a fake pull request and install the existing fake clean Inspector round;
7. prove **Run retro** appears over SSE and its accessible explanation uses the updated steering
   language.

Keep the existing typed-correction browser case. The two cases prove the two evidence sources feed
one session projection instead of replacing one another. Continue using fake agents and the local
Inspector ledger so the test spends no model tokens and reaches no external service.

## Data, API, migration, and compatibility details

- Database: one read helper only. No migration and no new index are justified for a lookup by
  `session_id` on a bounded per-live-session introduction path; confirm query shape against the
  existing `idx_reviews_session` index.
- API: unchanged. Existing session snapshots and SSE upserts carry the newly derived existing field.
- Wire: unchanged `RetroSummary` and `RetroReason` shapes. Keep `corrections` append-compatible.
- Browser: unchanged `retroOffer` control flow. Only its reason copy changes.
- Restart: durable review rows restore the same flag that live settlement sets. There must not be a
  separate persisted retro flag that could drift from review history.
- Cleanup: `session_remove` remains the boundary that forgets in-memory eligibility.

## Tests and verification

Run focused tests with the repository's mandatory preload:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/review-answer-db.test.ts \
  test/driver-question-record.test.ts \
  test/plan-decisions-http.test.ts \
  test/retro-worthiness.test.ts \
  test/retro-offer.test.ts \
  test/session-exit-signal.test.ts
```

Then run the project gates appropriate to the server, projection, documentation, and visible UI
change:

```sh
npm run typecheck
npm run lint
npm run build
npm run smoke
npx playwright test --config e2e/playwright.config.ts e2e/specs/retro-offer.spec.ts
```

CI remains responsible for the complete unit matrix on Node.js 24 and 26 and both Playwright shards.
If a focused local test exposes an unrelated base-branch failure, verify it against the base branch
and report it rather than changing unrelated code.

## Merge and exit criteria

The phase is ready to merge only when:

- every human-resolved review path marks the owning live session after successful durable settle;
- Foreman, pending, orphaned, permission, refused, failed, and dangling-session paths remain
  ineligible;
- a fresh Registry reconstructs review-backed eligibility for a reintroduced session without
  preloading historical ids;
- the existing transcript path still works and automated injections remain excluded;
- the browser spec shows the Retro offer after a dashboard answer and clean Inspector review;
- product copy and owner documentation describe human steering accurately;
- focused tests, typecheck, lint, build, smoke, targeted e2e, CI, and review gates pass; and
- the pull request contains no unrelated changes or evidence artifacts.

## Downstream handoff

There is no later planned phase. After merge, downstream work may rely on these contracts:

- any review that `isHumanResolvedReview` admits makes its live session retro-worthy;
- that eligibility is reconstructed from the durable review on restart;
- transcript text and review settlement feed one Registry signal; and
- consumers continue to read only `Session.retro`.

A later feature that introduces another human-decision store must either project into a
human-resolved review or feed the same Registry signal after establishing equally strong actor and
delivery evidence. It must not add a browser-only eligibility branch.

## Cross-phase audit record

- **20 August 2026, initial audit:** Reconciled the source goal with the repository's two review
  settlement paths, two session-introduction paths, durable conversation query, Registry cleanup,
  and required browser coverage. All behavior, compatibility, documentation, and verification work
  is owned here. No later phase is expected to repair an intermediate state.
