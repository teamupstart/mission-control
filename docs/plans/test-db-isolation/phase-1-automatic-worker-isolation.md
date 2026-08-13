# Phase 1: Automatic worker isolation and fail-closed database access

## Outcome and engineering value

Make operator database pollution impossible through the repository's standard Node test commands.
Every worker receives disposable state before imports, existing file-owned migration fixtures keep
working, and unsafe or late database setup fails before SQLite is opened.

This is the only implementation phase.

## Entry criteria and dependencies

- Direct dependency: the planning session and its pull request containing `plan.md`,
  `phased-plan.md`, and this phase file must be merged.
- Required baseline: the default branch after that planning merge.
- Governing context: the repository root `AGENTS.md`, the source plan, and the phased index in this
  directory.
- Freshness condition: no newer test-runner or state-path change has superseded the findings below.

## Scope

- Add an early plain-JavaScript test-worker state bootstrap.
- Load it from the full Node suite, focused Electron suite, and documented focused command.
- Strengthen the `openDb()` test isolation assertion, including singleton revalidation.
- Add focused regression coverage for setup ordering and alias precedence.
- Update command documentation.
- Run the focused and repository-wide verification gates.

## Non-goals

- No deletion or mutation of the operator's currently polluted `Bypass` rows.
- No consolidation or removal of existing file-local test homes.
- No shared test database and no reduction of test concurrency.
- No production state-dir, database schema, migration, route, browser, Electron, CI, or E2E behavior
  change.
- No generated-file edits.

## Repository findings and inherited contracts

### State resolution is module-load sensitive

`src/shared/harness-runtime.mjs` resolves `envVar("HOME")` in this durable order:
`MISSION_HOME`, `FLEET_HOME`, `HARNESS_HOME`. `src/server/config.ts` evaluates `stateDir()` into
`STATE_DIR` and `DB_PATH` at module load. Therefore, the bootstrap must execute before `tsx` loads
any test TypeScript and must express state only through the existing environment contract.

### Lowest-priority fallback is required

The suite has 128 files that set `HARNESS_HOME` and 102 that set `MISSION_HOME`. An experimental
preloader that set `MISSION_HOME` caused `test/workflow-check-provider-column.test.ts` to bypass its
hand-built pre-migration database. The safe bootstrap deletes inherited `MISSION_HOME` and
`FLEET_HOME`, then sets a fresh `HARNESS_HOME`. A test's later `MISSION_HOME` or `HARNESS_HOME`
assignment wins without further ceremony.

### The DB singleton must not bypass validation

`src/server/db.ts` currently returns `db` before calling `assertTestStateIsolation()`. Move or
structure validation so every test-runner call is checked before either a new or cached connection
is returned. Production must retain the immediate no-op branch when `NODE_TEST_CONTEXT` is absent.

### Cleanup ownership must be exact

The bootstrap removes only the directory it created. It must not resolve an environment variable at
exit and delete that value, because a test may have replaced `HARNESS_HOME` or set `MISSION_HOME` in
the meantime. Capture the created path in a lexical constant and clean that explicit path.

## Implementation steps

### 1. Add the worker bootstrap

Add a plain `.mjs` module under `test/`, proposed as `test/setup-state.mjs`, using only Node built-ins.
When `NODE_TEST_CONTEXT` is present:

1. create a unique directory with `mkdtempSync(join(tmpdir(), "mission-test-state-"))`;
2. delete inherited `MISSION_HOME` and `FLEET_HOME`;
3. set `HARNESS_HOME` to the created directory;
4. register synchronous exit cleanup for that exact directory; and
5. avoid opening the database or importing application modules.

The phase document is a proposed route, not a specification. If current Node behavior shows a more
reliable lifecycle hook or module location, adapt it while preserving unique worker ownership,
precedence, early execution, and exact cleanup.

### 2. Wire every repository Node test command

Update `package.json` so `test` and `test:electron` import the state bootstrap before importing
`tsx`. Do not change concurrency defaults or test globs.

Update the canonical single-file command in `AGENTS.md` to load the bootstrap. Update the Commands
section of `docs/configuration.md` with a focused-test example and a short statement that the
bootstrap creates disposable worker state. Explain that `HARNESS_HOME` is deliberately the
lowest-priority fallback; do not imply contributors should prefer the legacy name in production.

Search for other published raw `node --test --import tsx test/...` commands that users or agents are
expected to copy. Update current command documentation in scope, but do not churn archived plans or
historical evidence.

### 3. Harden the database boundary

In `src/server/db.ts`, preserve `DB_PATH` as the connection target and keep `envVar("HOME")` as the
alias authority. Under `NODE_TEST_CONTEXT`:

- require a current explicit override;
- require the frozen `DB_PATH` to be exactly the `harness.db` selected by that current override,
  using path-aware equality rather than raw prefix matching;
- require the selected state to live inside the platform temporary directory or an equivalently
  strong test-owned location;
- reject known/default operator state even when inherited through an explicit alias;
- validate before returning the cached singleton, catching late override changes; and
- throw before directory creation or SQLite open.

Keep steady-state validation cheap. Canonicalize or perform filesystem identity work at most on the
first open; subsequent validation should be environment and normalized-path comparison only. Do not
add repeated directory walks, `stat`, or `realpath` calls to every `openDb()` helper path.

Use path containment that cannot confuse siblings such as `/tmp/state-1` and `/tmp/state-10`, and
account for macOS temporary-directory canonicalization without weakening the refusal.

### 4. Expand focused regression coverage

Extend `test/db-isolation.test.ts` or add a tightly related test file. Continue testing through real
child processes with a jailed OS `HOME`, so the regression cannot damage operator state even if the
guard is broken. Cover:

- missing override refuses before creating a database;
- bootstrap-only worker state opens under its unique temp directory;
- two worker processes receive different fallback directories;
- inherited `MISSION_HOME` and `FLEET_HOME` are removed by bootstrap;
- a file-local `MISSION_HOME` overrides the fallback before server imports;
- a file-local `HARNESS_HOME` overrides the fallback because no higher-priority alias remains;
- an operator-looking or non-temp explicit override is refused;
- an override applied after configuration resolves is refused; and
- an override changed after the first `openDb()` remains refused despite the cached singleton.

Keep or explicitly rerun `test/workflow-check-provider-column.test.ts`. Its legacy row must still be
read as `treehouse`; that proves the bootstrap did not steal the fixture path.

Avoid asserting implementation-only names when process behavior, selected paths, and absence of
live writes provide a stronger contract.

### 5. Verify scope and performance

Run the focused cases before the full suite. Inspect `git diff` for accidental changes to generated,
production, or unrelated test files. Record full-suite wall time in the pull request evidence, but
do not claim a precise performance percentage from one run.

If the full suite regresses by more than one or two seconds across repeated samples, investigate
whether the bootstrap accidentally opens SQLite, performs filesystem validation per helper call,
or changes fixture precedence. The measured direct create/remove cost is about 110 ms across 596
files and the paired startup projection is about 0.9 seconds at concurrency two.

## Data, API, migration, and compatibility details

- No persisted data, database schema, or migration change.
- No HTTP, SSE, MCP, or browser contract change.
- Environment alias order remains append-only and unchanged.
- `HARNESS_HOME` continues to work as a legacy alias. Its use by the bootstrap is internal test
  compatibility, not a new operator recommendation.
- Existing test-local state paths remain primary when set before application imports.
- The bootstrap directory lifecycle is process-local and must not become durable configuration.

## Verification commands

Run from the repository root with Node 24 or newer:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/db-isolation.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-provider-column.test.ts
npm run typecheck
npm run lint
npm test
```

On macOS with `CODEX_SANDBOX=seatbelt`, run `npm test` with the repository-prescribed scoped
outside-sandbox approval so the Electron geometry tests execute honestly.

No Playwright spec is required because this phase has no UI-visible behavior. Run build or smoke
only if implementation unexpectedly changes a bundled/runtime surface, and record why scope
expanded.

## Merge and exit criteria

- The focused isolation and provider-column regression tests pass.
- Typecheck, lint, and the complete test suite pass.
- Standard and documented focused commands load the bootstrap.
- The guard refuses missing, late, non-temp, operator-looking, and post-singleton override drift.
- Existing `MISSION_HOME` and `HARNESS_HOME` fixture tests retain their intended databases.
- No test worker shares its fallback state directory with another worker.
- Production path resolution and database behavior remain byte-for-byte in contract outside the
  test runner.
- Documentation explains the safe focused invocation and low-priority alias choice.
- A reviewable pull request records checks, observed suite time, tradeoffs, and any deviation from
  this proposed route.

## Downstream handoff

There are no later phases. Future test authors may rely on standard Node test commands supplying a
unique fallback state directory, but must still set their own fresh home before imports when they
need to seed or inspect a particular database. Future `openDb()` changes must retain validation
before the singleton return.

Do not use this safety boundary as justification to let E2E daemons, demo processes, skill
reconciliation, worktree pool sweeps, or agent binaries inherit operator state. Those surfaces have
separate isolation contracts.

## Cross-phase audit record

- 2026-08-13: Reconciled the single phase against the source plan, alias resolver, module-load DB
  path, existing refusal, package commands, migration fixture, and suite performance evidence.
- 2026-08-13: Kept runner bootstrap, DB guard, tests, and docs in one merge unit because no partial
  subset establishes the requested safety boundary.
- 2026-08-13: Confirmed no later-phase consumer, concurrency edge, schema owner, UI surface, or
  multi-repository dependency exists.
- 2026-08-13: Rephrased entry criteria as descriptive prerequisites during review. Dependency,
  governing context, and freshness requirements are unchanged.
