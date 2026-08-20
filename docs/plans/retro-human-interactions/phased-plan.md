# Phased implementation: Count human review interactions toward Retro

## Source and approved decision

Source plan: [`plan.md`](plan.md)

The human explicitly selected phased implementation planning on 20 August 2026. The fixed product
goal is that dashboard-mediated human decisions count toward Retro eligibility live and after a
daemon restart, without weakening the existing authorship, Inspector, or skill gates.

There are no unresolved product choices.

## Repository findings

1. `ReviewManager` owns both human review resolution paths:
   - `resolve` and `settle` handle MCP-created `plan`, `diff`, `input`, and `plan-decisions` rows.
   - `record` writes an SDK `AskUserQuestion` answer after the driver accepted it.
2. `isHumanResolvedReview` already defines the exact accepted actor and terminal statuses for both
   the durable conversation query and the live browser projection.
3. Pure SDK and MCP tool results are intentionally removed from parsed transcripts, so the
   transcript scanner cannot recover these human answers.
4. The Registry owns `Session.retro`, holds the current correction signal in memory, and already
   removes it on `session_remove`.
5. Resolved human reviews are durable but are not restored into the Registry at startup. The
   conversation reads them on demand through `loadHumanResolvedReviews`.
6. New session rows enter through two owning paths: terminal `applyDiscovery` and SDK
   `registerSdkSession`. Restart restoration can query only at those introduction points and avoid
   loading all historical review session ids.
7. The UI offer predicate is already correct once `Session.retro` is populated. The behavior change
   is server-side projection plus accurate reason copy, with one required browser regression spec.

## Discrepancies resolved during investigation

- The initial diagnosis focused on Claude SDK `AskUserQuestion`, but the same protocol gap affects
  terminal `request_input`, plan decisions, and other human-resolved review kinds. The phase fixes
  the shared review lifecycle rather than one route.
- Marking only at live settlement would fail again after a daemon restart. The phase includes
  bounded per-session durable restoration.
- Loading every historical human review session id into the Registry constructor would violate the
  collection-bound contract. Restoration is scoped to newly introduced live session rows.
- No new `RetroReason` is needed. The existing `corrections` value remains the compatible wire id,
  with its documented meaning clarified to human steering beyond the opening brief.

## Sizing and phase-count rationale

Estimated non-test implementation effort: **55 to 110 production lines**.

Assumptions:

- one focused database existence helper with no migration;
- one Registry hydration seam shared by terminal and SDK session introduction;
- one ReviewManager publication helper or equivalent calls through the existing Registry signal;
- small copy and documentation edits;
- no shared wire schema, route, database schema, or new UI component.

The work is moderately sensitive because ordering, restart reconstruction, and actor attribution are
load-bearing, but it is one compact vertical slice. The total is well below 200 non-test lines, so
the phased-plan contract requires exactly one implementation phase and one one-shot task. Splitting
storage restoration from live review settlement would leave one merged state knowingly incomplete
and would duplicate the same eligibility contract across pull requests.

## Phase table

| Phase | Outcome | Direct dependencies | Execution |
|---|---|---|---|
| 1. Human review interactions make Retro eligible | Live and restored sessions derive the existing `corrections` reason from authoritative human-resolved reviews; the browser proves the offer appears after a clean Inspector review | None beyond this planning session and its merged plan artifacts | One-shot |

Detailed phase: [`phase-1-human-review-retro-worthiness.md`](phase-1-human-review-retro-worthiness.md)

## Dependency graph and concurrency

```mermaid
flowchart LR
  P[Planning PR merged] --> I[Phase 1 implementation task]
  I --> F[Feature PR merged]
```

There are no parallel groups because there is one phase. The implementation task depends directly on
this planning session so it remains backlogged until the plan paths are available on the default
branch.

## Merge order

1. Merge the planning pull request containing `plan.md`, `plan.html`, `phased-plan.md`,
   `phased-plan.html`, and the Phase 1 Markdown file.
2. Mission Control releases the single implementation task.
3. Merge the implementation pull request only after its focused tests, typecheck, lint, build,
   smoke, browser spec, CI, and review gates pass.

## Cross-phase contracts

Although there is only one phase, these contracts constrain the implementation and any follow-up:

- `isHumanResolvedReview` is the authorship authority for review-backed eligibility.
- The review row must be durably settled before the Registry is marked.
- Restart restoration is per introduced live session and is removed with that session row.
- The transcript scanner remains the text-turn source and feeds the same Registry signal.
- `Session.retro` and `RetroReason = "corrections"` remain wire-compatible.
- The browser continues to use `retroOffer`; it does not independently inspect review history.
- Inspector cleanliness remains a separate timing gate.

## Final verification strategy

The implementation phase owns all verification because no later phase exists:

1. Focused Node tests cover live review settlement, SDK question recording, actor/status negatives,
   failed delivery or persistence, restart hydration, and eviction cleanup.
2. Existing transcript-scanner and offer-predicate suites prove the original path and gate remain
   intact.
3. A Playwright case uses the fake SDK agent to answer `AskUserQuestion`, observes
   `Session.retro.reasons`, supplies the existing fake clean Inspector review, and asserts
   **Run retro** appears without a composer correction.
4. Typecheck, lint, build, smoke, and the targeted browser spec run locally; CI runs the repository's
   complete gate matrix.

## Phase-count audit

- Every requirement in `plan.md` is owned by Phase 1.
- No test-only, documentation-only, migration-only, or cleanup phase exists.
- No intermediate merge can create a second source of truth or a half-restored eligibility signal.
- No cross-repository work is required.

## Cross-phase audit record

- **20 August 2026, initial audit:** Confirmed the single phase owns live review settlement,
  restart restoration, compatible reason semantics, negative actor/status cases, documentation, and
  browser proof. With one phase there are no conflicting phase contracts, transitive dependencies,
  or unsafe concurrency claims.
