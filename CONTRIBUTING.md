# Contributing to Mission Control

Thank you for helping improve Mission Control. This guide covers the public contribution
workflow and the clone-to-green path. Automated coding agents must also follow
[AGENTS.md](AGENTS.md).

## Ways to contribute

- Search existing issues before filing a bug or proposing a feature.
- Use the bug and feature request templates so maintainers receive enough context to respond.
- Open an issue before starting a substantial behavior or architecture change. Focused fixes
  and documentation improvements can go directly to a pull request.
- Do not report suspected vulnerabilities in a public issue. Follow the private process in
  [SECURITY.md](SECURITY.md).

## Clone to green

Prerequisites:

- Node.js 24 or newer. Check with `node --version`.
- npm, supplied with Node.js.
- Playwright Chromium for browser tests. It is a one-time download per machine and
  is intentionally not installed by `npm install`.

```sh
git clone https://github.com/teamupstart/mission-control.git
cd mission-control
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
`MISSION_TEST_CONCURRENCY` to override that local worker count. CI uses ephemeral GitHub-hosted
runners with an explicit worker and shard allocation so its behavior does not depend on the local
fallback and fork pull requests never execute on shared self-hosted infrastructure.

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

## Submitting a change

1. Fork the repository and create a focused branch from the latest `main`.
2. Make one coherent change and add focused tests for behavior changes.
3. Run the checks that cover the change. Documentation-only changes do not require the full
   runtime suite, but links, commands, and formatting must still be verified.
4. Open a pull request using the repository template. Explain the outcome, tradeoffs, known
   gaps, verification, and any follow-up work.
5. Respond to review feedback with additional commits. Maintainers will squash the pull
   request when it is ready to merge.

Please keep discussions respectful, specific, and focused on improving the project. Harassment,
personal attacks, and discriminatory behavior are not acceptable in project spaces.

## Contribution licensing

Unless you explicitly state otherwise, contributions intentionally submitted for inclusion in
Mission Control are provided under the [Apache License 2.0](LICENSE), as described in section 5
of that license. You must have the right to submit the work. Do not include code, assets, or
documentation whose license is incompatible with this repository.

## Pull requests

Before opening a pull request, run the checks that cover your change. At minimum, code changes
are expected to pass `npm run typecheck`, `npm run lint`, and `npm test`. Changes to build or
runtime surfaces also need `npm run build` and `npm run smoke`; UI changes also need
`npm run test:e2e` with a matching spec.

CI runs typechecking, linting, unit tests on the supported Node.js releases, production builds,
bundle smoke tests, and the browser suite. See [the CI runner allocation](README.md#ci-runner-allocation)
before changing runner labels, worker counts, or shard counts.

Use the pull request template. Its human-facing section explains why, what changed,
tradeoffs, known gaps, proof of work, and follow-up work. Its agent-facing section
records the goal, design decisions, implementation details, tests, and deliberate
edge cases. Attach review evidence to the pull request rather than committing it.
See the [documentation index](docs/README.md) for product and engineering reference.
