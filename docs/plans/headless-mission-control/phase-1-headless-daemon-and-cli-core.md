# Phase 1: Headless daemon and CLI core

Part of [Headless Mission Control](plan.md). The phase index is [`phased-plan.md`](phased-plan.md).

## Outcome

After this phase:

- `mission-control serve` starts a daemon that needs no Electron and no dashboard.
- That daemon keeps Foreman running itself.
- `mission-control status` and `mission-control doctor` say what works on this machine.
- Phases 2, 3 and 4 get a stable CLI framework (registry, client, output, actor rule) to add
  commands to.

## Entry criteria

- The planning PR that adds `docs/plans/headless-mission-control/` has merged.
- No phase dependency.

## Scope

1. A `headless` launch mode.
2. A Foreman supervisor that the daemon owns.
3. A readiness route.
4. The `src/cli/` framework, with the `serve`, `status`, `doctor` and `logs` commands.
5. `build:cli`, `bin`, and a smoke entry.
6. `scripts/install-service.mjs --headless`.
7. The skeletons for `skills/headless/SKILL.md` and `docs/headless.md`.

**Non-goals:**

- Operator commands (Phase 2).
- Attention and alerts (Phase 3).
- Touch ID (Phase 4).
- Any change to the dashboard.
- A network listener.

## Repository findings this phase relies on

- `launchMode` is chosen at `src/server/index.ts:992`, and `configureOrganizationLaunchMode`
  consumes it at `:998`. Find every consumer of the `desktop`/`daemon`/`dev` union before you
  widen it. Some may switch on it exhaustively.
- `GET /api/health` (`src/server/routes.ts:1867`) returns `{ok, service, version, pid,
  capabilities}`. Add `launchMode` to it, and do not rename the existing fields.
- `src/main/utility-supervisor.ts` imports `electron`. Its restart delay is
  `Math.min(500 * restarts, 5000)` (line 47). The Foreman lease and its standby behaviour are
  described in `src/main/foreman.ts:17-21`.
- The daemon entry for launchd is `scripts/start-service.mjs`, and the installer is
  `scripts/install-service.mjs`.
- `BASE_URL` is in `src/shared/harness-runtime.mjs`.
- `build:mcp` in `package.json` is the template for an esbuild bundle. `scripts/smoke-bundles.mjs:500`
  lists the bundles that smoke checks.

## Implementation steps

1. **Restart policy.** Create `src/shared/restart-backoff.ts` with `restartDelayMs(restarts)`.
   It must have no `node:` import. Make `src/main/utility-supervisor.ts` use it, so there is
   one copy of the policy.
2. **Headless mode.** Widen the launch-mode type to include `"headless"`. It is selected when
   `MISSION_HEADLESS=1` is set, or when the CLI `serve` command starts the daemon in-process.
   Report it in `GET /api/health` as `launchMode`. Handle every consumer of the union
   explicitly.
3. **Foreman supervisor.** Create `src/server/foreman-supervisor.ts`. Only in headless mode,
   it `child_process.fork`s the Foreman worker:
   - the bundled `dist/server/foreman-worker.mjs` when it exists, otherwise
     `src/server/foreman/worker.ts` through `tsx`;
   - with `executableChildEnv()` (as in `src/main/foreman.ts`), a private log file next to
     the daemon log, and restarts paced by `restartDelayMs`.

   On daemon shutdown it stops the child before the HTTP server closes. It never takes the
   lease itself; the worker's heartbeat lease decides which worker acts. `MISSION_FOREMAN=off`
   disables the supervisor.
4. **Readiness.** Add `GET /api/readiness`. Put its schema in `src/shared/protocol.ts`. It
   returns one entry per check, each `{id, ok, detail}`:
   - a multiplexer is installed, using the terminal backend registry
     (`src/server/terminal/registry.ts`);
   - which harnesses have an SDK runtime enabled;
   - the Mission MCP probe result;
   - the Foreman lease holder (`pid` and whether it is the supervised child);
   - the token path;
   - the launch mode.

   A missing multiplexer is `ok: false` with a detail that names the runtimes that still work.
   It is not a startup failure.
5. **CLI framework.** Create these files in `src/cli/`:
   - `main.ts` holds the argv parser (`node:util` `parseArgs`, no new dependency) and command
     dispatch. With no subcommand it behaves as `serve`, so the current `bin` behaviour holds.
   - `commands/index.ts` holds the registry: an array of `CommandGroup`.
   - `client.ts` provides `request` (it parses the response with the given Zod schema; a
     schema failure exits 1 with the route name) and `stream` (an SSE reader over `fetch`).
   - `actor.ts` provides `actorHeaders()`, which returns `{"x-mission-operation-actor":
     "agent"}` when the environment shows a managed session, and nothing otherwise. Find the
     variable names the daemon actually injects into managed launches (the harness token and
     session id) and test against those names.
   - `output.ts` owns `--json`, the 80-column tables, and the exit codes 0, 1, 2 and 3.
6. **Daemon commands** (`commands/daemon.ts`):
   - `serve` sets headless mode and imports the server entry in-process, which is what
     `scripts/start-service.mjs` does.
   - `status` reads `/api/health`.
   - `doctor` reads `/api/readiness`, prints each check, and exits 1 if any check fails.
   - `logs` tails the daemon log path the daemon reports. If the daemon does not report one,
     add it to readiness.
7. **Build and packaging:**
   - Add `build:cli` (esbuild, the same flags as `build:mcp`, writing
     `dist/cli/mission-control.mjs`) and add it to `build`.
   - Point `bin.mission-control` at a small `bin/mission-control.mjs` shim. The shim loads
     `dist/cli/mission-control.mjs` when it exists, and otherwise `src/cli/main.ts` through `tsx`.
   - Add the bundle to `scripts/smoke-bundles.mjs`, and smoke-run `--help` and `status --json`
     against the booted daemon.
8. **LaunchAgent.** `scripts/install-service.mjs --headless` writes `MISSION_HEADLESS=1` into
   the plist environment. Without the flag, it writes exactly what it writes today.
9. **Skeletons:**
   - `skills/headless/SKILL.md` covers what the CLI is, `--json`, exit codes, the rule that
     answering or approving is the human's job, and one `##` section per command group, with
     Daemon filled in now.
   - `docs/headless.md` covers start modes, `serve`, `doctor`, the LaunchAgent, SSH
     forwarding (`ssh -L 7317:127.0.0.1:7317`), and the same per-group sections.
   - Link it from `docs/README.md` and `docs/overview.md`.

## Compatibility

- `bin` with no arguments still starts the daemon.
- `/api/health` only gains a field.
- Electron's adopt-or-spawn logic (`src/main/daemon.ts`) is unchanged. If Electron adopts a
  headless daemon, it also starts its own Foreman, and the lease makes the extra worker a
  standby. Pin this with a test.

## Tests and verification

- `test/restart-backoff.test.ts`: the delay curve.
- `test/foreman-supervisor.test.ts`: it starts only in headless mode, restarts after a crash
  with backoff, stops on shutdown, and respects `MISSION_FOREMAN=off`. Use an injected fork
  function, not a real worker.
- `test/readiness-route.test.ts`: the in-process app with a missing multiplexer, and the schema
  parses.
- `test/cli-core.test.ts`: argv parsing, the no-argument fallback to `serve`, exit codes,
  `--json` output, the actor header with and without the managed-session environment, and
  exit 3 on an unreachable daemon.
- Run `node --test --import ./test/setup-state.mjs --import tsx test/cli-core.test.ts` (and
  the same command for each new file), then `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build` and `npm run smoke`.
- Manual check: with Electron closed, `mission-control serve`, then `mission-control doctor`.
  `pgrep -f foreman` shows the supervised worker.

## Exit criteria

- The headless daemon runs Foreman with no Electron, and `doctor` reports accurately.
- The CLI framework contracts below exist and have tests.
- All gates pass, and the docs and skill skeletons are linked.

## Downstream handoff

Later phases may rely on these, and must not change their shape:

- `CommandGroup` and the `commands/index.ts` array (add one line per group);
- `request` and `stream`;
- `actorHeaders()`;
- the `output.ts` exit codes and `--json`;
- `launchMode` in `/api/health`;
- the per-group `##` sections in `skills/headless/SKILL.md` and `docs/headless.md`.

## Cross-phase audit

- The source plan's section 1 is fully owned here.
- From section 2, this phase owns the framework, the actor rule and the Daemon commands.
- The audit against Phases 2 to 4 found that none of them edits `main.ts`, `client.ts`,
  `actor.ts` or `output.ts`. They only add group files.
- `stream` is consumed by Phase 2 (`tail`) and Phase 3 (`watch`).
- In the final audit, `stream` was confirmed to accept a query string, because Phase 3 uses
  `/events?client=cli`. Group names are unique across phases: `daemon`, `sessions`,
  `control`, `tasks`, `review`, `plan`, `blocker`, `dialog`, `config`, `attention`, `alerts`
  and `grants`.
