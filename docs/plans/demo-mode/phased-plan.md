# Demo mode - phased implementation plan

Source plan: [plan.md](plan.md) (rendered: [plan.html](plan.html)). This index turns the
approved investigation into implementation units that separate agents can execute and
merge safely.

## Incorporated human decisions (submitted 2026-08-04 via Mission Control)

These are requirements, not open questions:

1. **Build path: Phases A then B.** The launcher plus scenario-player fakes ship first as
   one unit; the pre-seeded lived-in fleet follows.
2. **Demo state: persistent `~/.mission-control-demo` with a `--fresh` flag** that
   rebuilds it from scratch.
3. **Foreman: the demo runs the real Foreman with the real `claude` bin** in Foreman's own
   environment, so it genuinely reasons about the fake fleet. Foreman tokens are allowed.
4. **Follow-up: this phased plan.** Option C (in-product `--demo`) is rejected; Option D
   (record/replay) is deferred and not scheduled.

## Investigated findings the phases rely on

Verified against the repository at commit `45521e02`:

- Every model interaction is a spawned CLI resolved through one chain
  (`resolveBinSpec`, `src/server/harness/bin.ts`; `MISSION_<AGENT>_BIN` et al.), and the
  SDK runtime uses the same chain (`src/server/harness/claude/sdk-deps.ts` pins
  `pathToClaudeCodeExecutable`). Nothing in `src/` reaches a model HTTP API.
- `MISSION_HOME` moves the DB, token, logs, and dispatch worktrees as a unit
  (`stateDir()`, `src/shared/harness-runtime.mjs`); `migrate-state.ts` is a no-op under an
  explicit override. `HOME` must be overridden separately: Claude transcript paths derive
  from `homedir()` as `~/.claude/projects/<mangled cwd>/<session id>.jsonl`
  (`resolveTranscriptPath`, `src/server/harness/claude/transcript.ts`).
- `e2e/fixtures/daemon.ts` (`startDaemon()`) is a working isolated boot: temp
  `MISSION_HOME`+`HOME`, free loopback port, `writeFakeAgents`, a real seeded git repo,
  the full isolation env block, an `/api/health` pid identity check, a
  db-landed-under-home check, and a `PUT /api/harnesses/config` flip to the SDK runtime.
  Its `startForeman()` spawns the real worker (`src/server/foreman/worker.ts`) against the
  same env.
- `e2e/fixtures/fake-claude.mjs` speaks both protocols: `claude -p --output-format json`
  one-shots (`headlessAnswer()`) and the SDK session control protocol (`runSession()`),
  and it writes the JSONL transcript file itself (`appendTurn()`). The driver reads only
  four frame kinds: `system`/`init`, new `session_id`, `assistant`, `result`.
  `writeFakeAgents` (`e2e/fixtures/fake-agents.ts`) copies fakes to extension-less paths
  because the vendored SDK runs `node <path>` only for known JS extensions.
- Diff and Files are computed live from git in the session cwd (`src/server/diff.ts`,
  `src/server/session-files.ts`); nothing is persisted. Conversation is read from the
  JSONL file, not the control wire. The transcript parser normalizes arbitrary
  `tool_use` blocks into tool chips (`src/server/harness/claude/transcript.ts`).
- Two sweeps are NOT scoped by `MISSION_HOME` and must be disabled in the demo daemon:
  `MISSION_POLL_MS=0` (terminal discovery adopts the operator's real sessions) and
  `MISSION_POOL_REAP_MS=0` (reaps the shared treehouse worktree pool).
- `fleetCost`/`lineSummary`/`settingsStatus` are recomputed from `usage_ledger` rows and
  `app_config` blobs on every snapshot; turn attribution is in-memory only
  (`src/server/injections.ts`), so origin chips exist only for live deliveries.
- `sdk_sessions` rows in `suspended` status are restored at daemon startup as resumable
  session cards (`src/server/sdk/store.ts`, supervisor `restore()`).

## Phases

| Phase | File | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | [phase-1-demo-launcher-and-scenario-player.md](phase-1-demo-launcher-and-scenario-player.md) | `npm run demo`: isolated daemon + dashboard on `~/.mission-control-demo`, scenario-player fakes (tool chips, worktree file writes, waiting states), real Foreman, `--fresh` | none |
| 2 | [phase-2-seeded-lived-in-fleet.md](phase-2-seeded-lived-in-fleet.md) | `--fresh` rebuilds a lived-in fleet: task history, reviews, workflow runs, cost ledger, suspended sessions with transcripts, dirty worktrees | Phase 1 |

## Dependency graph and merge order

```
Phase 1  ->  Phase 2
```

Serial. Phase 2 consumes files, env contracts, and the `--fresh` hook that Phase 1 owns,
so there are no concurrency groups. Merge order equals phase order.

## Cross-phase contracts

Phase 1 fixes these and Phase 2 (and any later work) must not change them:

- **Demo state root:** `~/.mission-control-demo`, used as BOTH `MISSION_HOME` and `HOME`
  for the demo daemon. Layout owned by the launcher: `workspace/` (seeded repos),
  `bin/` (installed fakes), `scenarios/` (scenario tables), plus whatever the daemon
  creates (`harness.db`, `token`, `worktrees/`).
- **Launcher entry point:** `scripts/demo/launch.mjs`, exposed as `npm run demo`.
  Flags: `--fresh` (delete and rebuild the state root before boot; Phase 2 attaches the
  seeder here), `--no-foreman` (skip the real Foreman, which is otherwise started),
  `--port <n>` (override the fixed default), `--check` (boot, assert identity and
  isolation, exit; Phase 2 extends it with a reduced seed assertion). The launcher
  factors boot-and-wait apart from open-and-attach so Phase 2's seeder can boot
  quietly.
- **Scenario contract:** scenario tables are JSON files in `<state root>/scenarios/`,
  sourced from `scripts/demo/scenarios/` at install time; the player receives the
  directory via `MISSION_DEMO_SCENARIO_DIR`. The scenario schema is owned by
  `scripts/demo/` and documented in the phase 1 file.
- **Foreman environment split:** the demo daemon's env carries the fake bins,
  `HOME=<state root>`, and `ANTHROPIC_API_KEY=""`; the Foreman child's env carries the
  REAL `claude` resolution (no `MISSION_CLAUDE_BIN` override), the operator's real
  `HOME` (its CLI credentials live there), and the demo's `MISSION_HOME`/`MISSION_PORT`
  so it reaches the demo daemon and token.
- **Identity guards:** the launcher refuses to proceed unless `/api/health` reports the
  spawned child's pid and `harness.db` exists under the state root after boot.

## Decisions recorded against the repository

- **The demo player is a separate file, not an edit to the e2e fixture.**
  `e2e/fixtures/fake-claude.mjs` is a deliberately minimal, determinism-critical test
  asset; growing scenario features inside it would couple the e2e suite to demo behavior.
  Phase 1 creates `scripts/demo/fake-claude.mjs` (and codex/pi equivalents) derived from
  the e2e fixtures, with a header comment naming the derivation so drift is a documented
  contract, not an accident. If the implementing agent finds a clean extraction of the
  shared protocol core (transcript writer + control loop) that leaves the e2e fixture
  byte-for-byte equivalent in behavior, that is preferred; duplication is the accepted
  fallback because the protocol surface is four frame kinds.
- **Seeding strategy (Phase 2): replay through real routes, not handwritten DB rows.**
  The seeder boots the daemon quietly and drives the same public HTTP routes the e2e
  specs use (tasks, dispatch, reviews, workflows, schedules), letting the scenario player
  generate transcripts, worktree edits, and completions; the state root that remains IS
  the lived-in fleet. Direct SQLite writes are a documented fallback for surfaces no
  route feeds (for example `usage_ledger` rows for the cost chip), performed only while
  the daemon is stopped. This respects the daemon-is-the-only-writer boundary at runtime.
- **Port:** a fixed default distinct from the dev daemon (7317) and the smoke port
  (7519), overridable via `--port`. The exact default is the implementer's choice within
  that constraint.

## Final verification strategy

After both phases merge:

1. `npm run build && npm run demo -- --fresh` boots the demo daemon; the dashboard opens
   onto a lived-in fleet (tasks in several states, a waiting prompt, workflow history,
   a nonzero cost chip).
2. Dispatching a new task from the UI cuts a real worktree, plays a scenario with tool
   chips, live file edits visible in Diff/Files, a waiting-on-you question, and a
   completion - with `MISSION_CLAUDE_BIN` pointing at the player throughout (no tokens).
3. The real Foreman holds its lease against the demo daemon and its decisions appear in
   the dashboard.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run smoke`
   stay green; `npm run test:e2e` stays green untouched (the e2e fixtures are not
   modified).
5. The operator's real `~/.mission-control` and `~/.claude` are untouched; the demo
   daemon adopts no real sessions.
