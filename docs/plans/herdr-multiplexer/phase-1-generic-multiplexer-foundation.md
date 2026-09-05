# Phase 1: Generic multiplexer foundation

## Outcome and value

Mission Control gains two backend-neutral contracts needed by Herdr without exposing an incomplete
Herdr integration:

1. A tty-less multiplexer pane can correlate to an agent through an exact shell-PID ancestry match.
2. Multiplexer session creation distinguishes background dispatch from an operator-requested visible
   terminal.

Existing tmux behavior remains unchanged. Operator-created cmux workspaces now request focus, while
background cmux dispatches remain non-disruptive. The repository is fully operable after this phase
merges and contains no `herdr` registry entry yet.

## Entry criteria and direct dependencies

- The planning PR containing `docs/plans/herdr-multiplexer/plan.md`, `phased-plan.md`, and this file
  is merged to the default branch.
- The approved decisions in the root plan remain unchanged.
- Direct implementation-phase dependencies: none.
- The Mission Control task for this phase depends on the planning session so these paths resolve
  before work begins.

## Scope

- Add exact PID-ancestry correlation for multiplexer panes that report no tty.
- Add `select: boolean` to `DetachedSessionSpec` and thread it through every construction site.
- Make background home creation pass `false` and operator terminal creation pass `true`.
- Keep tmux behavior unchanged and map cmux selection to its existing `--focus` flag.
- Update fakes, contract tests, adapter tests, and browser E2E coverage for the changed behavior.
- Keep comments and architecture documentation adjacent to the contracts accurate.

## Non-goals

- Do not add `herdr` to `MULTIPLEXER_IDS` or any registry.
- Do not create a Herdr socket client, start a Herdr server, or add a Herdr fake.
- Do not alter terminal handle wire shapes, persisted schemas, focus composition, or emulator APIs.
- Do not add cwd or PID-proximity heuristics.
- Do not change multiplexer ordering.
- Do not edit `CHANGELOG.md` or generated files.

## Repository findings and inherited contracts

- `src/server/discovery/correlate.ts` builds agent tty groups first, then indexes terminal panes by
  tty. Its host-process uniqueness fallback is intentionally limited to emulator panes and must stay
  separate from the new exact multiplexer join.
- `Proc` already contains `pid` and `ppid`, so the parent chain can be derived from the same process
  snapshot with no new subprocess, persistence, or async work.
- `MuxPane` already carries `panePid: number | null`, but current comments describe it as unused and
  tty as the only multiplexer join. Those comments are part of this phase's contract update.
- `DetachedSessionSpec` is internal server-side TypeScript. Making `select` required is the desired
  compile-time inventory of every session-creation call and fake.
- `homeBackends` is the single dispatch-home path. `launchTerminal` is the explicit operator launch
  path. They are the two owners of selection intent.
- tmux creates detached sessions and later attaches through an emulator, so internal selection at
  creation has no additional visible effect. cmux currently passes `--focus false` unconditionally.
- The fake cmux in `e2e/fixtures/fake-agents.ts` already records workspace argv. Existing conversation
  and terminal-launch E2E paths can prove the user-visible focus flag without launching a real app.

## Implementation steps

### 1. Define exact multiplexer PID correlation

Update `src/server/discovery/correlate.ts` with a small pure helper over the existing `Proc[]` and
terminal enumerations:

1. Build a PID lookup from the current process snapshot.
2. Starting at the representative agent process, walk `ppid` links with a visited set so malformed
   or cyclic input terminates safely.
3. Consider only `kind: "multiplexer"` panes with `tty: null` and non-null, positive `panePid`.
4. Keep direct tty candidates exactly as they are. Never replace or compete with a candidate from
   the same backend that reported the agent tty.
5. Within one backend, select the pane whose `panePid` is the closest actual ancestor. If two panes
   remain at the same distance or the chain cannot establish a unique relationship, add no handle
   for that backend.
6. Add successful candidates in terminal-enumeration order so registry priority remains the naming
   rule across backends.
7. Do not apply emulator host-process/cwd uniqueness to multiplexers and do not apply PID ancestry to
   emulators.

Update the `MuxPane.tty` and `panePid` comments in `src/server/terminal/types.ts` to state the strong
tty key, the exact ancestry fallback, and the decline-on-ambiguity behavior.

### 2. Pin correlation safety with focused tests

Extend `test/correlate.test.ts` with process snapshots that prove:

- a Herdr-shaped null-tty pane binds when its shell PID is on the agent's parent chain;
- an unrelated, missing, or recycled PID does not bind;
- a cycle or broken parent link terminates and produces no guessed handle;
- the closest unique ancestor wins within one backend;
- an equal-distance or otherwise ambiguous same-backend result is declined;
- a direct tty candidate for a backend wins over that backend's PID candidate;
- tmux remains the name and innermost handle when an agent is observable through both inner tmux and
  outer Herdr-shaped multiplexer panes in registry order.

Use an existing multiplexer ID in pure test enumerations until Phase 2 adds `herdr` to the shared
union. The behavior under test is the axis contract, not the vendor string.

### 3. Add session selection intent

Add required `select: boolean` to `DetachedSessionSpec` in `src/server/terminal/types.ts` with these
semantics:

- `true` asks the multiplexer to select the newly created session internally;
- `false` preserves the operator's current multiplexer selection;
- the flag never promises to raise an operating-system window.

Thread the field through the complete construction inventory:

- `src/server/terminal/home.ts`: `HomeBackend.open` passes `select: false` when calling
  `sessions.spawnDetached`.
- `src/server/terminal/targets.ts`: `launchTerminal` passes `select: true` through both the first
  unique-name attempt and its retry.
- `src/server/terminal/tmux.ts`: accept the field but keep the existing detached creation and
  side-pane selection behavior unchanged.
- `src/server/terminal/cmux.ts`: replace hardcoded `--focus false` with the string form of
  `spec.select`.
- Test builders and recorders that construct `DetachedSessionSpec` must state their intent instead
  of receiving a default.

Do not add an optional field or default it inside adapters. Requiring every caller to choose is the
compile-time protection against a future dispatch stealing focus.

### 4. Verify existing adapter and lifecycle behavior

Update focused tests in:

- `test/terminal-home.test.ts` to prove background homes pass `select: false` through fallback and
  retry paths;
- `test/terminal-target-contract.test.ts` to prove operator launches pass `select: true`, including a
  name-collision retry and cleanup path;
- `test/terminal-adapters.test.ts` to prove tmux accepts both values without changing its argv;
- `test/cmux-adapter.test.ts` to prove cmux emits `--focus false` for dispatch and `--focus true` for
  operator launch;
- `test/helpers/terminal-fakes.ts` and any compile-failing fixture to carry the required field.

Add or extend a Playwright case in the existing terminal-launch flow, preferably
`e2e/specs/continue-in-terminal-mode.spec.ts`, to click the cmux row and assert the fake cmux record
contains `--focus true`. Keep a unit-level home test for `false`; E2E must not dispatch a real agent
or open a real terminal.

### 5. Reconcile comments and boundaries

Update nearby comments in `correlate.ts`, `types.ts`, `home.ts`, `targets.ts`, `tmux.ts`, and `cmux.ts`
where they state tty-only correlation or unconditional background creation. Do not create a new
general architecture document for these narrow contract changes.

## Data, API, migration, and compatibility details

- No HTTP, SSE, browser, or SQLite schema changes.
- `DetachedSessionSpec` is an internal required-field change. Typecheck is the exhaustive migration.
- Session terminal handles are unchanged. A newly correlated tty-less multiplexer still produces the
  existing `MuxHandle` shape.
- The same process snapshot supplies both agent and pane ancestry evidence. No PID relationship is
  cached across discovery ticks.
- cmux launch behavior changes only for operator-requested terminals. Background dispatch remains
  `--focus false`.

## Tests and verification

Run focused tests with the repository's required preload:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/correlate.test.ts \
  test/terminal-home.test.ts \
  test/terminal-target-contract.test.ts \
  test/terminal-adapters.test.ts \
  test/cmux-adapter.test.ts
```

Then run the phase gates:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Inspect the built E2E result closely enough to confirm the cmux terminal row still reads correctly,
the launch menu closes after selection, and no unexpected terminal window opens.

## Merge and exit criteria

- All focused and repository-wide gates above pass.
- PID fallback never creates a handle without an actual, unique parent-chain relationship.
- TTY matches and registry priority remain unchanged.
- Every `DetachedSessionSpec` construction states `select` explicitly.
- Background home creation records `false`; operator terminal launch records `true`.
- tmux argv is unchanged and cmux maps the requested flag.
- The Playwright test proves the user launch through the built app.
- The pull request contains only this phase's code, tests, and directly adjacent comments.
- No `herdr` ID, adapter, socket code, docs claim, or partial menu row lands in this phase.

## Downstream handoff

Phase 2 may rely on:

- `MuxPane.panePid` being an exact ancestry key when tty is absent;
- tty remaining stronger than PID and registry order remaining authoritative;
- `DetachedSessionSpec.select` being required, with `false` for dispatch and `true` for operator
  launch;
- cmux and tmux already conforming to that creation contract.

Phase 2 must not rename the field, weaken ambiguity handling, add a Herdr-specific correlation path,
or make background dispatch selectable. It owns the Herdr implementation and all new backend-visible
surfaces.

## Cross-phase audit record

- Initial audit: this phase owns only the two reusable contracts and the existing cmux behavior they
  correct. It introduces no identifier or partial Herdr surface that Phase 2 must hide.
- Dependency audit: Phase 2 consumes both contracts directly, so it depends on Phase 1 and cannot run
  concurrently.
- Compatibility audit: the required field is internal and exhaustive at typecheck; the correlation
  result preserves the existing terminal-handle wire shape.
