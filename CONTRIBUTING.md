# Contributing to Mission Control

Mission Control is an internal repository. Start here for a clone-to-green path,
then use [AGENTS.md](AGENTS.md) for the agent-facing engineering contracts.

## Clone to green

Prerequisites:

- Node.js 24 or newer. Check with `node --version`.
- npm, supplied with Node.js.
- Playwright Chromium for browser tests. It is a one-time download per machine and
  is intentionally not installed by `npm install`.

```sh
git clone <repository-url>
cd ai-harness
make init
npx playwright install chromium
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

To have bootstrap check Chromium too, use `make init ARGS="--with-e2e"`. If the
browser is missing, it stops with the command that installs it. `make init` is
idempotent: it installs dependencies, builds the application, configures Claude
status hooks, and installs or configures treehouse worktrees. `make setup` is the
smaller compatibility path for dependencies, build, and hooks only.

For the fuller first-run walkthrough, including state, desktop, hooks, and demo
mode, see [docs/setup.md](docs/setup.md).

## Commands

| Command | Use it for |
| --- | --- |
| `make init` | Full first-run bootstrap. |
| `make setup` | Dependencies, build, and hooks without treehouse setup. |
| `npm run dev` | Daemon and Vite dashboard in development. |
| `npm run dev:desktop` | Daemon, dashboard, and Electron shell. |
| `npm run build` | Production web, server, Electron, MCP, and hook bundles. |
| `npm run typecheck` | TypeScript validation. |
| `npm run lint` | Oxlint over source, hooks, tests, scripts, and e2e. |
| `npm test` | Full Node test suite, including Electron geometry checks on macOS. |
| `npm run test:electron` | Focused Electron geometry checks. |
| `npm run test:e2e` | Playwright browser tests against built application bundles. |
| `npm run smoke` | Boots built bundles after `npm run build`, and checks the MCP bundle publishes exactly the tools `MISSION_MCP_TOOLS` declares. |
| `npm run package` | Builds the macOS application package. |
| `npm run demo` | Starts a token-free demo. Build first. |
| `npm run docs:screenshots` | Regenerates the committed README screenshots from the token-free demo. Build first. |

`make build`, `make check`, `make test`, `make lint`, and `make smoke` install or
refresh dependencies through the repository's stamp file. On macOS, `npm test`
uses real Electron geometry tests. In the Codex Seatbelt sandbox, run Electron
tests with the required scoped outside-sandbox approval; do not bypass the
preflight or add Chromium flags.

`npm test` runs six test files concurrently by default. Set
`MISSION_TEST_CONCURRENCY` to override that local worker count. CI pins its own
two-worker value in `.github/workflows/ci.yml`, so the hosted runner tuning does
not depend on the local fallback.

## Test layers

The repository has four complementary test layers:

1. **Unit and contract tests** in `test/` exercise server and shared behavior
   directly with Node's test runner. Add focused coverage for non-UI behavior.
2. **Static React markup tests** use `renderToStaticMarkup` to pin markup shape.
   They do not prove browser behavior.
3. **Electron geometry tests** measure real layout, overflow, and clipping on
   macOS. Use them when those physical properties matter.
4. **Playwright end-to-end tests** in `e2e/` drive the built dashboard, daemon,
   routes, and server events together. Read [e2e/README.md](e2e/README.md) before
   adding one.

Every new UI feature or visible UI behavior change requires a Playwright spec in
`e2e/`. This includes controls, markup, styling, copy, layout, and UI bug fixes.
The spec must never spend model tokens: agent binaries are redirected to the fake
agents in `e2e/fixtures/fake-agents.ts`. Do not add `data-testid`; select by role,
label, or placeholder.

## Working well in this repository

- Inspect `git status` before editing and keep unrelated work out of your change.
- Follow the owner of the subsystem and its shared registries or schemas. Do not
  create a parallel source of truth.
- Update user documentation in the same change when behavior, configuration,
  commands, or shortcuts change.
- Keep durable migrations beside their upgrade path and add focused regression
  coverage for behavior changes.
- Do not commit secrets, local state, generated outputs edited by hand, or PR
  evidence. Put evidence under gitignored `e2e/.artifacts/<topic>/` and attach it
  to the pull request.

## Pull requests

Before opening a pull request, run the checks that cover your change. At minimum,
the expected bar is `npm run typecheck`, `npm run lint`, and `npm test`. Changes to
build or runtime surfaces also need `npm run build` and `npm run smoke`; UI changes
also need `npm run test:e2e` with a matching spec.

CI runs three jobs in parallel, reporting as five checks: `gates` (typecheck and lint),
`unit (node 24)` and `unit (node 26)` (tests, build, and smoke), and `e2e (shard 1/2)`
and `e2e (shard 2/2)` (the browser suite, on Node 24 only). Lint is a CI job, so it no
longer passes silently when it is skipped locally.

Use the pull request template. Its human-facing section explains why, what changed,
tradeoffs, known gaps, proof of work, and follow-up work. Its agent-facing section
records the goal, design decisions, implementation details, tests, and deliberate
edge cases. Attach review evidence to the pull request rather than committing it.
See the [documentation index](docs/README.md) for product and engineering reference.
