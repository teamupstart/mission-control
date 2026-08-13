# Automatic test database isolation: phased implementation

## Source and approved decisions

Source plan: [`plan.md`](plan.md).

The source plan is approved for scheduling. It fixes the outcome and boundaries: automatic unique
state per Node test worker, precedence-preserving compatibility with existing file-local fixtures,
defense-in-depth refusal in `openDb()`, updated focused commands, and no live-data cleanup.

## Repository findings

- `src/shared/harness-runtime.mjs` owns the durable alias order: `MISSION_HOME`, then `FLEET_HOME`,
  then `HARNESS_HOME`. The test bootstrap must not introduce a parallel resolver.
- `src/server/config.ts` freezes `STATE_DIR` and `DB_PATH` at module evaluation, so worker setup must
  run before `tsx` loads a test's TypeScript graph.
- `src/server/db.ts` owns the single database connection and is the correct write boundary for the
  refusal. Its existing guard currently runs after the singleton return.
- `package.json` has two Node test entry points: `test` and `test:electron`. Both require the same
  bootstrap. The canonical one-file command is also published in `AGENTS.md`.
- `test/db-isolation.test.ts` already tests the refusal through jailed child processes and is the
  natural owner for the expanded safety matrix.
- `test/workflow-check-provider-column.test.ts` is the compatibility canary: its hand-built database
  is selected with `HARNESS_HOME` and failed when an experimental bootstrap set higher-priority
  `MISSION_HOME`.
- There is no UI, HTTP, SSE, schema, migration, generated-file, package, or multi-repository surface.

## Phase table

| Phase | Name | Outcome | Direct dependencies | Merge unit |
|---|---|---|---|---|
| 1 | Automatic worker isolation and fail-closed DB access | Every Node test worker starts with disposable state while existing migration fixtures retain ownership, and `openDb()` refuses unsafe paths | Planning session | One pull request in this repository |

## Dependency graph and merge order

```text
planning artifacts merged
          |
          v
Phase 1: bootstrap + DB guard + tests + docs
          |
          v
       complete
```

There is one implementation phase and therefore no internal concurrency group or phase-to-phase
merge edge. Its task depends directly on the planning session so it remains backlogged until these
documents merge to the default branch.

## Why this is one phase

The bootstrap and guard are complementary halves of one safety boundary. Landing the bootstrap
alone leaves nonstandard commands and late imports dependent on convention. Landing the guard alone
still makes every test author repeat the correct setup. The regression tests and command
documentation must ship with the behavior they define. The combined diff remains narrow and
reviewable, with no migration or UI work that would justify a second merge unit.

## Cross-phase contracts

With one phase, these are implementation invariants rather than handoffs:

- `envVar("HOME")` remains the only alias resolver; the bootstrap supplies environment, not a
  second application configuration path.
- `MISSION_HOME` remains the preferred production/current alias. `HARNESS_HOME` is used only as the
  test bootstrap fallback because it has the lowest precedence.
- Each test file/worker owns one fallback temp root; tests may replace it with another fresh temp
  root before importing state resolution.
- `openDb()` remains the sole database writer boundary and validates test isolation before returning
  either a new or existing connection.
- Production pays no filesystem-validation cost because the refusal exits immediately outside
  `NODE_TEST_CONTEXT`.
- No implementation phase deletes live operator rows or changes production state migration.

## Final verification strategy

The single phase runs focused child-process tests first, the provider-column migration canary next,
then typecheck, lint, and the full suite. The full run exercises the command bootstrap across all 596
tracked test files and the repository's configured file concurrency. Its pull request reports the
observed wall time without treating one local sample as a stable benchmark.

No `npm run build`, smoke, or Playwright E2E run is required unless implementation expands into a
runtime or UI surface beyond this plan. If scope expands that far, stop and revise the plan rather
than absorbing it silently.

## Complete-plan audit

- Every required source-plan behavior is owned by Phase 1.
- No requirement is deferred to undocumented cleanup.
- The phase is independently operable and mergeable.
- Existing alias precedence, file-local migration fixtures, production DB resolution, and test
  concurrency remain intact.
- The task may rely on the three plan paths only after this planning pull request merges.

Audit result: one phase is sufficient; no compatibility conflict or missing downstream consumer
requires another phase.

