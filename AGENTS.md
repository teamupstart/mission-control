# AGENTS.md

## Project overview

Mission Control is a local control plane for Claude Code, Codex, and Pi sessions, built with Node.js 24+, TypeScript 5.7, React 19, Vite 6, Electron 43, Hono 4, Zod 3, and SQLite.

Read the [documentation index](docs/README.md) for product behavior and setup. Before changing a subsystem, read:

- [Architecture and lifecycle](docs/agent-guides/architecture.md)
- [Change contracts](docs/agent-guides/change-contracts.md)
- [Ensemble extension guide](docs/ensembles.md)
- [Original agent guide backup](docs/archive/backups/AGENTS.old) for historical detail

## Commands

Run commands from the repository root with Node.js 24 or newer.

```sh
npm install
npm run dev
npm run build
npm run typecheck
npm run lint
npm test
npm run test:electron
npm run test:e2e
npm run smoke
npm run package
```

`npm run smoke` and `npm run test:e2e` both require a successful `npm run build` first. `npm run test:e2e` additionally needs the Playwright browser, which `npm install` does not fetch - run `npx playwright install chromium` once per machine. `npm run package` builds the macOS application.

Run one test file with the same loader as the full suite:

```sh
node --test --import tsx test/session-contracts.test.ts
```

`--test-concurrency` is deliberately not in that command. It caps how many test *files* run
at once, so naming a single file makes it inert, and carrying it here implied a single-file
run reproduces the suite's concurrency when it cannot.

`npm test` runs two files at a time. `MISSION_TEST_CONCURRENCY` changes that, and CI sets it
to 6, which is where the suite stops getting faster on a 4 vCPU runner. A failure that only
appears under that contention needs the whole suite, not one file:

```sh
MISSION_TEST_CONCURRENCY=6 npm test
```

On macOS, `npm test` includes real Electron geometry tests. If `CODEX_SANDBOX=seatbelt`, run `npm test` or `npm run test:electron` with scoped outside-sandbox approval. Do not bypass the preflight or add Chromium flags.

CI runs three jobs in parallel, reporting as five checks: `gates` (typecheck and lint, on a
GitHub-hosted runner), `unit (node 24)` and `unit (node 26)` (tests, build, and bundle smoke,
on Blacksmith), and `e2e (shard 1/2)` and `e2e (shard 2/2)` (the `e2e/` Playwright suite, on
Node.js 24 only). Lint is now a CI job rather than a local-only check, so a lint failure now
turns CI red - `main` carries no branch protection, so that is a signal to act on and not a
mechanical block. `.github/workflows/ci.yml` documents how each runner size and worker count
was measured - read it before changing one.

## Working rules

1. Inspect `git status` before editing. Preserve unrelated changes.
2. Follow existing module ownership and registry patterns. Do not create parallel sources of truth.
3. Update README documentation in the same change when behavior, configuration, commands, or shortcuts change.
4. Add focused tests for behavior changes and regressions.
5. Validate in proportion to the change. UI changes require runtime or visual verification, not diff inspection alone.
6. New UI features and UI behavior changes require a Playwright spec in `e2e/`. See below.
7. Commit only task-related files on a feature branch.
8. A task that attaches more than one repository produces one pull request per repository it changed, and none for a repository it left alone. Each is reviewed, gated, and merged on its own; the task finishes when all of them have merged. See [dispatch and the backlog](docs/dispatch-and-backlog.md#attaching-more-than-one-repository).

When a review workflow passes, do not rerun it to address Inspector feedback. Fix the feedback, resolve conflicts, push, and monitor that pull request and its CI until green - per pull request, so a session holding one in each of several repositories follows through on each.

## Code style and examples

Use schemas and shared registries instead of hand-parsing or branching on concrete agents.

Correct:

```ts
const parsed = await parseBody(c, CreatePersonaSchema);
if (!parsed.ok) return parsed.res;

const harness = harnessFor(session.agent);
const permissionModes = harness.permissionModes;
```

Incorrect:

```ts
const input = await c.req.json();
if (session.agent === "claude") {
  // agent-specific behavior copied into a route
}
```

Keep persisted schema migrations next to their upgrade path.

Correct:

```ts
addColumn(d, "tasks", "schedule_id", "TEXT");
d.exec("CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(schedule_id, status)");
```

Incorrect:

```ts
// Fails on an existing database because CREATE runs before migrate().
CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(schedule_id);
```

Use shared predicates and exhaustive event handling.

Correct:

```ts
if (canMessage(session)) renderComposer();

switch (msg.type) {
  case "session_upsert":
    setSessions((prev) => new Map(prev).set(msg.session.id, msg.session));
    break;
  case "session_remove":
    dropSessionDrafts(msg.id);
    break;
}
```

Incorrect:

```ts
if (session.tmux || session.wezterm || session.runtime === "sdk") {
  renderComposer();
}
```

Tests use `node:test` and `node:assert/strict`. React rendering tests use `renderToStaticMarkup`; do not introduce jsdom or Testing Library without an explicit project decision.

Browser end-to-end tests are the one exception, and they live apart: `e2e/` uses `@playwright/test` and runs under `npm run test:e2e`, never `npm test`. Everything in `test/` runs against `src/` and must pass on a fresh checkout; `e2e/` drives the BUILT dashboard served by the BUILT daemon, so it needs `npm run build` first. That is the same line `scripts/smoke-bundles.mjs` already draws.

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("falls back when a harness does not offer the stored runtime", () => {
  assert.deepEqual(resolveSessionRuntime("pi", "sdk"), {
    runtime: "terminal",
    unknown: null,
    unsupported: "sdk",
  });
});
```

## UI changes require an end-to-end spec

Read [e2e/README.md](e2e/README.md) before writing one.

**Every new UI feature and every UI change requires a Playwright spec in `e2e/`.** There are
no exemptions. If the change is visible to a person using the dashboard, it is covered here
before it lands.

The three older UI layers each assert something real and none of them can see whether the
thing works: `renderToStaticMarkup` asserts markup shape, the in-process HTTP tests assert
routes without a browser, and the Electron tests measure laid-out geometry. Only `e2e/`
connects a click to a route to a server event and back to the DOM.

This includes, and is not limited to:

- A new control, form, modal, or view.
- A change to what an existing control does, what it sends, or what it renders in response.
- Markup, styling, copy, and layout changes. Assert the user-visible consequence - the text
  a person reads, the control they can reach, the element that is now present or gone.
- A fix for a bug that reproduced through the UI. Write the failing spec first.

The other layers are additions to this requirement, never substitutes for it. Reach for them
alongside a spec when they say something a browser cannot: `renderToStaticMarkup` to pin an
exact markup shape, and the Electron geometry tests to measure used height for overflow and
clipping, which no assertion on markup can produce.

Changes with no UI surface - pure functions, reducers, selectors, formatting helpers, route
edge cases - are not UI changes and belong in `test/`, where a case costs milliseconds.

Two standing constraints:

- **Never spend model tokens.** Every agent binary is redirected at a fake by
  `e2e/fixtures/fake-agents.ts`. A dispatch launches the CLI through two unrelated paths -
  the one-shot `claude -p` runner and the Agent SDK session - and both must stay faked.
- **Never add `data-testid`.** Select by role, label, or placeholder. The app has 229
  `aria-label`s and 155 `role`s already, and selecting through them keeps the accessible
  names honest.

## Boundaries

- Never commit secrets, tokens, credentials, local state, or operator data.
- Never commit evidence artifacts. Proof-of-work screenshots and transcripts attach to the pull request. Evidence produced for or submitted to workflow personas is also never committed: produce it in a gitignored location and attach it to the pull request. Committed documentation imagery in `docs/images/` is documentation, not evidence.
- Never modify production, signing, release, CI, or deployment configuration unless the task explicitly requires it.
- Never let the Foreman worker touch SQLite. The daemon is the only database writer.
- Never add a second session-eviction path. Terminal and SDK sessions leave through `Registry.beginEviction`.
- Never infer durable cleanup from `state === "exited"`; use `session_remove`.
- Never enable Electron `asar` or move `skills/` into `dist`.
- Never hand-edit generated files. Change their source or generator and regenerate them.
- Never hand-edit `CHANGELOG.md`.
- Never rename or reorder persisted append-only IDs. See the change contracts before extending them.
- Never use `git reset --hard`, force-push, or remove worktrees unless the user explicitly requests it and the target is verified.
- Never add an agent name as a commit co-author.
- Never use an em dash in project prose.

Treat these paths as controlled:

- `src/shared/`: wire contracts and browser-safe shared logic only; no `node:` imports.
- `src/server/db.ts`: schema and migrations; upgrading databases must keep opening safely.
- `src/server/registry.ts`: session ownership, comparators, and eviction.
- `src/server/harness/`: harness-specific capabilities and protocol adapters.
- `src/server/terminal/`: terminal backend mechanisms only; write policy remains in `actions.ts`.
- `src/web/useEventStream.ts`: exhaustive handling for every `ServerEvent`.
- `.github/workflows/` and `electron-builder.yml`: release infrastructure, change only when in scope.
- `dist/` and generated protocol or persona files: outputs, not primary edit targets.

## Definition of done

- Relevant tests pass.
- `npm run typecheck` passes.
- `npm run lint` passes.
- `npm run build` and `npm run smoke` pass when build or runtime surfaces changed.
- `npm run test:e2e` passes when UI surfaces changed, with a spec covering the new behavior.
- README and linked technical docs match the implementation.
- The worktree contains no unrelated edits.
- Requested PR and CI work is complete before reporting completion - for every pull request the task opened, one per repository it changed.

Plans belong in `docs/plans/<name>/plan.md`; a written plan is not an implementation.
