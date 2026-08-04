# Phase 1 - Demo launcher and scenario-player fakes

Part of [phased-plan.md](phased-plan.md); source plan [plan.md](plan.md). Read both
before starting. This file is the proposed route, not a specification: follow it where
the repository agrees, use your own judgement where it does not, and record deviations in
the pull request.

## 1. Outcome and value

`npm run demo` boots a fully isolated Mission Control - real daemon, real dashboard,
real git, real Foreman - where every agent binary is a scenario player that spends zero
tokens. An operator can dispatch a task from the UI and watch a convincing session:
paced assistant turns, Edit/Write/Bash/TodoWrite tool chips, files actually changing in
the Diff and Files views, a waiting-on-you question, then completion. This is the whole
of Option A from the approved plan, and it is the demo Jordan asked for: "the UI
working, conversation history, diffs, files, showing, and the ability to dispatch a
task".

## 2. Entry criteria and dependencies

- No phase prerequisites; this is the root phase.
- Requires a successful `npm run build` at runtime (the launcher runs
  `dist/server/index.mjs` and serves `dist/web`), exactly like `npm run smoke` and
  `npm run test:e2e`.

## 3. Scope and non-goals

In scope:

- `scripts/demo/launch.mjs` (launcher), `scripts/demo/fake-claude.mjs` and
  `scripts/demo/fake-codex.mjs` (scenario players), `scripts/demo/scenarios/*.json`
  (two or three starter scenarios), `npm run demo` script entry, README section.

Non-goals:

- No pre-seeded history (Phase 2 owns the lived-in fleet and hooks into `--fresh`).
- No changes under `src/` and none under `e2e/` - the e2e fixtures stay untouched.
- No packaged-app entry point (Option C was rejected).
- No PR/Inspector demo behavior (out of scope per the source plan).

## 4. Repository findings and inherited contracts

- The complete isolated-boot recipe exists at `e2e/fixtures/daemon.ts:130-341`
  (`startDaemon()`): state dir creation, `seedRepo()` (real `git init` + commit),
  `writeFakeAgents()`, the isolation env block (lines 142-186), spawn of
  `dist/server/index.mjs`, `/api/health` poll with pid identity check (lines 278-303),
  the db-under-home assertion (lines 312-318), and the SDK-runtime config flip
  (lines 328-338). The launcher is this function with a persistent home, a fixed port,
  and no teardown.
- `startForeman()` (`e2e/fixtures/daemon.ts:205-250`) spawns
  `src/server/foreman/worker.ts` via `--import tsx` and waits for
  `[foreman] acquired the lease` in its log. The demo reuses the wait but flips the env
  split described below.
- The fake protocol is documented inline in `e2e/fixtures/fake-claude.mjs`: the driver
  reads only `system`/`init`, new `session_id`, `assistant`, `result`
  (header comment, lines 16-30); the transcript is a FILE the fake writes
  (`appendTurn()`, lines 195-233); `-p` one-shots are a separate protocol
  (`headlessAnswer()`, lines 147-191); `AskUserQuestion` travels up as `can_use_tool`
  (`ask()`, lines 295-306). `e2e/fixtures/fake-agents.ts` shows the extension-less-copy
  trick the vendored SDK requires.
- The transcript parser (`src/server/harness/claude/transcript.ts`) already renders
  arbitrary `tool_use` blocks as tool chips and reads `TodoWrite` narration; the player
  only has to emit the blocks.
- `scripts/smoke-bundles.mjs` is the minimal built-daemon boot and the precedent for a
  script that requires `npm run build` first.

## 5. Implementation steps

1. **`scripts/demo/launch.mjs`** - plain Node ESM, no build step of its own:
   - Resolve the state root: `~/.mission-control-demo` (realpath after creation; macOS
     `/var` vs `/private/var` matters for transcript paths). `--fresh` removes it first.
     `--port <n>` overrides the fixed default (pick one that is neither 7317 nor 7519).
   - If missing, create `workspace/` and seed a demo repo the way
     `e2e/fixtures/daemon.ts:106-120` does, but with a few source files and a second
     commit so the Diff view's merge-base math has something to show. Consider two repos
     so the repo picker is non-trivial.
   - Install the players: copy `scripts/demo/fake-claude.mjs` to
     `<root>/bin/claude` (extension-less, chmod 0o755) and likewise for codex; `pi` gets
     the loud exit-1 stub, mirroring `writeFakeAgents`.
   - Copy `scripts/demo/scenarios/` into `<root>/scenarios/`.
   - Build the daemon env: `HOME=<root>`, `MISSION_HOME=<root>`, `MISSION_PORT`,
     `MISSION_WORKSPACE_DIRS=<root>/workspace`, `MISSION_WEB_DIR=<repo>/dist/web`,
     `MISSION_CLAUDE_BIN`/`MISSION_CODEX_BIN`/`MISSION_PI_BIN=<root>/bin/*`,
     `MISSION_DEMO_SCENARIO_DIR=<root>/scenarios`, `MISSION_POLL_MS=0`,
     `MISSION_POOL_REAP_MS=0`, `MISSION_DISPATCH_SETTLE_MS=0`,
     `MISSION_WORKFLOW_SWEEP_MS=1000`, `ANTHROPIC_API_KEY=""`. Every line of that block
     is justified in `e2e/fixtures/daemon.ts:142-186`; keep the two unscoped-sweep
     zeroes non-negotiable.
   - Spawn `dist/server/index.mjs`; fail with the daemon log if `dist/` is missing
     (point at `npm run build`). Poll `/api/health`; verify `service` AND `pid`; then
     assert `harness.db` exists under the root. Refuse loudly otherwise.
   - `PUT /api/harnesses/config {"sessionRuntime":{"claude":"sdk","codex":"sdk"}}` -
     the demo fleet is SDK-runtime by construction (discovery is off).
   - Unless `--no-foreman`: spawn the real Foreman
     (`node --import tsx src/server/foreman/worker.ts`) with the env split:
     start from the DAEMON env (so `MISSION_HOME`, `MISSION_PORT`, and the token path
     match), then restore the operator's real `HOME` (the real CLI's credentials live
     under it), drop `MISSION_CLAUDE_BIN`/`MISSION_CODEX_BIN`/`MISSION_PI_BIN`, and drop
     the blanked `ANTHROPIC_API_KEY` so the real CLI authenticates however the operator
     normally does. Wait for `[foreman] acquired the lease`.
   - Print the dashboard URL and `open` it on macOS. Forward SIGINT/SIGTERM to both
     children; do not delete the state root on exit (it is persistent by decision).
2. **`scripts/demo/fake-claude.mjs`** - derived from `e2e/fixtures/fake-claude.mjs`
   (name the derivation in the header). Keep both protocols and the transcript-file
   writing. Replace the echo/sentinel behavior with a scenario player:
   - On session start, load `MISSION_DEMO_SCENARIO_DIR/*.json`. Match the incoming
     user prompt against each scenario's `match` (substring or regex); fall back to a
     `default` scenario.
   - Scenario schema (owned here, documented in the README section): a `title` (also
     returned by the `-p` titler so cards get scenario names instead of "E2E Mock
     Session"), and `steps`, each one of:
     `{"kind":"assistant","text":...,"delayMs":...}`,
     `{"kind":"tool","name":"Edit"|"Write"|"Bash"|"TodoWrite","input":...,"delayMs":...}`,
     `{"kind":"editFile","path":...,"content":...}` (actually writes into the session
     cwd so Diff/Files populate; paths must stay inside the cwd),
     `{"kind":"ask","questions":[...]}` (raises `can_use_tool` and blocks the turn),
     `{"kind":"result"}`.
   - Between steps, keep the card visibly "working" by pacing with `delayMs` while the
     turn stays open; emit `assistant` frames so the activity line updates. Tool steps
     append `tool_use` blocks (and matching `tool_result` user records) to the
     transcript.
   - Keep `-p` answers schema-valid for the same callers the e2e fake handles (titler,
     goal reconciliation, Persona verdicts); scenario titles feed the titler reply.
3. **`scripts/demo/fake-codex.mjs`** - the same treatment for the Codex app-server
   protocol, derived from `e2e/fixtures/fake-codex.mjs`. It may ship as a thin
   echo-level port (scenario support optional) if time-boxing demands; say so in the PR.
4. **Starter scenarios** - two or three under `scripts/demo/scenarios/`: a bug-fix
   narrative (edits two files, runs "tests" via a Bash tool chip, completes), a
   waiting-on-you narrative (asks a question mid-turn), and a long-running one (held
   turn) so the fleet shows mixed states.
5. **`package.json`**: add `"demo": "node scripts/demo/launch.mjs"`.
6. **README**: a "Demo mode" section - what it is, `npm run build && npm run demo`,
   the flags, the state root, the token guarantees, and the Foreman token caveat.

## 6. Data, API, and compatibility

- No schema changes, no route changes, no `src/` changes. The launcher configures the
  daemon exclusively through env vars and public routes.
- `MISSION_DEMO_SCENARIO_DIR` is read only by the players (processes the launcher
  spawns), never by `src/` - the same pattern as `MC_E2E_RECORD_DIR`.

## 7. Tests and verification

- `npm run typecheck` and `npm run lint` (lint covers `scripts/`).
- `npm test` unaffected but run it; `npm run test:e2e` must stay green untouched -
  this phase must not modify `e2e/`.
- Add a launcher self-check mode `npm run demo -- --check`: boot, run the identity and
  isolation assertions, dispatch nothing, shut down, exit 0. This is the smoke-bundles
  pattern and gives CI-shaped proof without a browser.
- Manual verification for the PR (this is a runtime feature; diff inspection is not
  enough): boot the demo, dispatch a task against a starter scenario, and screenshot the
  conversation with tool chips, the Diff view showing the scenario's edits, the Files
  view, and the waiting-on-you card. Confirm `~/.mission-control` and `~/.claude`
  mtimes are untouched and no real session was adopted.
- No Playwright spec is required: the dashboard UI is unchanged (the e2e rule covers UI
  features and behavior changes; this phase adds an operator script and fixtures).
  State this reasoning in the PR.

## 8. Merge and exit criteria

- `npm run demo -- --check` passes locally after `npm run build`.
- All Definition of done checks in AGENTS.md that apply (typecheck, lint, tests, build,
  smoke, README updated).
- The PR carries the manual-verification screenshots and the token-safety argument
  (which bins were redirected, what asserts isolation).

## 9. Downstream handoff

Phase 2 may rely on, and must not change:

- The state-root layout (`workspace/`, `bin/`, `scenarios/`) and the launcher flags
  (`--fresh`, `--no-foreman`, `--port`, `--check`).
- The scenario schema and `MISSION_DEMO_SCENARIO_DIR`.
- The env split between daemon and Foreman.
- The identity and isolation assertions.

Phase 2 will extend `--fresh` to run the seeder after the state root is rebuilt; the
launcher should keep the fresh-build path a single function so that hook is a one-line
insertion.

## 10. Cross-phase audit record

- 2026-08-04: initial version. Contracts mirrored into `phased-plan.md`. No earlier
  phases exist to reconcile against. Checked against Phase 2's draft: the seeder needs
  a quiet (non-opening, non-Foreman) boot mode; `--check`'s no-browser boot already
  provides the shape, so the launcher should factor boot-and-wait apart from
  open-and-attach rather than assuming they always run together.
