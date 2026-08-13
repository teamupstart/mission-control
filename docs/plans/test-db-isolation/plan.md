# Automatic test database isolation

## Status and decision record

Approved for implementation and scheduling on 13 August 2026. The implementation is one cohesive
merge unit because the runner bootstrap, database refusal, regression coverage, and documented test
commands must land together to provide a usable safety boundary.

The following decisions are resolved:

- Isolate every Node test worker automatically, including the ordinary suite and the focused
  Electron suite.
- Seed the lowest-priority legacy `HARNESS_HOME` alias after clearing inherited `MISSION_HOME` and
  `FLEET_HOME`. This protects tests that omit local setup without outranking a test's deliberate
  file-local state directory.
- Keep one temporary state root per test file/worker. Never share one SQLite database across the
  concurrent suite.
- Retain and strengthen `openDb()`'s refusal as defense in depth. Automatic setup must not turn a
  missing or late override into silent access to operator state under a nonstandard test command.
- Preserve existing file-local homes. Migration and filesystem tests own carefully seeded paths and
  must continue opening those fixtures.
- Keep the expected suite-wide overhead below one second on the measured 596-file local suite. A
  larger regression indicates changed behavior rather than the intended directory bootstrap.

## Problem

`test/workflow-inspector-bypass.test.ts` inserts a workflow named `Bypass` with sentinel IDs `w`
and `v`. Those exact IDs, plus binding `b`, run `run`, and submission `full-1`, were found in the
operator database at `~/.mission-control/harness.db`. That proves test-fixture data reached live
state at some point.

The current test file is correctly isolated: it creates a temporary directory, sets `MISSION_HOME`
before dynamically importing server modules, and deletes the directory after the test process.
The broader safety contract is still fragile because isolation is repeated file by file. The state
path is resolved at module load, so one missing preamble, one value import above it, or one runner
that does not expose `NODE_TEST_CONTEXT` can fall back to the operator directory.

`src/server/db.ts` already refuses an unredirected open under Node's test runner, but the check runs
after the database singleton early return and accepts any current home override whose raw string is
a prefix of the resolved DB path. It prevents the common omission but is not a complete guarantee.

## Evidence and constraints

The repository scan and local performance measurements established:

| Evidence | Result | Consequence |
|---|---:|---|
| Tracked `*.test.ts` files | 596 | The bootstrap executes widely, so its fixed cost must stay tiny. |
| Files containing `openDb()` | 159 | SQLite initialization already belongs to these tests; the bootstrap must not open it elsewhere. |
| Files assigning a state-home alias | 225 | Existing file-local fixtures remain authoritative. |
| Files assigning `HARNESS_HOME` | 128 | A global `MISSION_HOME` would outrank and break these fixtures. |
| Files assigning `MISSION_HOME` | 102 | A low-priority fallback is naturally superseded. |
| Files assigning `FLEET_HOME` | 0 | Clear an inherited value so it cannot outrank the fallback. |
| Sequential create/remove pairs | 0.185 ms mean per file | Direct filesystem cost is about 110 ms for all 596 files. |
| Paired one-file worker launches | about 3 ms median delta | Projected local wall cost at concurrency two is about 0.9 s. |
| Green full-suite samples | 262.32 s, 281.36 s with bootstrap, 371.73 s | The bootstrap result is inside a 109 s unchanged-baseline spread. |

The first experimental bootstrap set `MISSION_HOME`. It caused
`test/workflow-check-provider-column.test.ts` to open the bootstrap's blank database instead of its
hand-built pre-migration fixture selected through `HARNESS_HOME`; the suite correctly failed. The
same bootstrap changed the meaning of up to 128 test files. The precedence-preserving bootstrap
cleared inherited `MISSION_HOME`/`FLEET_HOME`, set only `HARNESS_HOME`, passed that migration test,
and passed the full suite.

## Required behavior

### Automatic worker bootstrap

Every test process launched by the repository's Node test commands receives a unique, temporary
state root before its test module graph loads. The bootstrap:

1. acts only when Node identifies the process as a test worker;
2. clears inherited higher-priority `MISSION_HOME` and `FLEET_HOME` values;
3. replaces `HARNESS_HOME` with its fresh temporary root;
4. does not import TypeScript or server configuration;
5. removes only the directory it created when that worker exits; and
6. never opens SQLite itself.

The ordinary suite and `test:electron` load this bootstrap before `tsx`. The documented focused
test command does the same, so copied commands exercise the production safety contract.

### Database refusal

Under Node's test runner, `openDb()` may open only the `harness.db` selected by the current explicit
state-home override, and that state must be in a temporary test location. Validation happens before
returning an existing database singleton so a late environment mutation cannot silently retain a
connection to another state root.

Production behavior is unchanged: the live daemon may continue opening the operator state resolved
by `stateDir()`. The steady-state test validation must remain string/path comparison work, without a
filesystem traversal or repeated `stat`/`realpath` calls on every database helper call.

## Flow change

Today, each test file is responsible for setting a state override before its imports reach
`config.ts`; omission falls toward the operator state and relies on `openDb()` noticing. After this
change, the Node test runner loads a process-local bootstrap first. The bootstrap supplies a unique
low-priority temporary home, the test may replace it with a more specific fixture home, `config.ts`
freezes the selected path, and `openDb()` validates that selection before either opening or returning
a connection. Production startup bypasses the test-only bootstrap and refusal.

```text
Node test runner -> test-state bootstrap -> optional file-local override
                 -> config.ts path resolution -> openDb test validation -> temporary harness.db

Production daemon -> config.ts path resolution -> openDb -> operator harness.db
```

### Compatibility

- A test that assigns `MISSION_HOME` after bootstrap and before importing state resolution opens its
  chosen fixture.
- A test that assigns `HARNESS_HOME` after bootstrap keeps working because no higher-priority alias
  remains inherited.
- A test that constructs a pre-migration `harness.db` continues opening and upgrading that exact
  file.
- A test with no local setup uses the worker's fallback directory.
- A missing, late, operator-looking, or non-temporary override fails before creating or mutating a
  database.
- Concurrent test files never share state or fixture IDs.
- The deliberate child processes in `test/db-isolation.test.ts` remain jailed even while simulating
  failures in the guard.

## Verification

The implementation adds focused child-process coverage for bootstrap ordering, alias precedence,
unique worker homes, missing/late overrides, operator-looking overrides, and singleton revalidation.
The existing provider-column migration test is an explicit regression check for precedence.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/db-isolation.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-provider-column.test.ts
npm run typecheck
npm run lint
npm test
```

`npm run test:electron` is covered through the changed command and may be run separately when
diagnosing Electron-only behavior. No browser E2E spec is required because this has no UI surface.

The implementing pull request records wall time for the full suite, but timing is a guardrail rather
than a precise benchmark. Compare against more than one recent run before attributing a small delta;
the measured unchanged baseline varied by 41.7%.

## Documentation

Update the single-file test command in `AGENTS.md` and the Commands section of
`docs/configuration.md` so contributors and agents load the bootstrap for focused runs. Document why
the bootstrap uses the legacy alias: it is a deliberate low-priority fallback, not a preference for
the old name.

## Non-goals

- Do not delete the polluted `Bypass` rows from the operator database. That is a destructive,
  separately authorized cleanup operation.
- Do not rewrite all 225 file-local test homes. They express fixture ownership and make migration
  tests readable.
- Do not share one suite-wide test database or serialize database tests.
- Do not change production state-directory precedence or filenames.
- Do not change UI, wire contracts, persisted schema, migrations, CI concurrency, Electron runtime
  behavior, or E2E daemon isolation.

## Success criteria

- Standard and focused repository test commands cannot mutate the operator database.
- Existing migration fixtures still open their intended hand-built databases.
- A future DB test with no local state preamble receives isolated state automatically.
- A direct or malformed test setup fails closed instead of silently reaching live state.
- The full suite, typecheck, and lint pass, with no meaningful performance regression attributable
  to the bootstrap.
