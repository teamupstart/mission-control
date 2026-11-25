# AGENTS.md

## Project overview

Mission Control is a local control plane for Claude Code, Codex, and Pi sessions, built with Node.js, TypeScript, React, Vite, Electron, Hono, Zod, and SQLite. See [package.json](package.json) for supported versions and [package-lock.json](package-lock.json) for the resolved dependencies.

Read the [documentation index](docs/README.md) for product behavior and setup. Before changing a subsystem, read:

- [Architecture and lifecycle](docs/agent-guides/architecture.md)
- [Change contracts](docs/agent-guides/change-contracts.md)
- [Ensemble extension guide](docs/ensembles.md)
- [Original agent guide backup](docs/archive/backups/AGENTS.old) for historical detail

## Commands

The CI gates job runs `scripts/check-doc-links.mjs` for local documentation links.

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

`npm run smoke` and `npm run test:e2e` both require a successful `npm run build` first. `npm run test:e2e` additionally needs the Playwright browser, which `npm install` does not fetch - run `npx playwright install chromium` to install the matching browser. `npm run package` builds the macOS application.

Run one test file with the same loader as the full suite:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/session-contracts.test.ts
```

Include `--import ./test/setup-state.mjs` in hand-typed test commands. Keep the preload
contract here and link to it from other guides. It gives each test worker its own
`mission-test-state-*` directory before the test module loads and removes it on normal
exit. Both `npm test` and `npm run test:electron` include the preload.

A test worker must load the preload or inherit its capture for `openDb` to accept even
a temp home. An operator can configure a live state home inside the temp directory.
If you export `MISSION_HOME` before running a test, the preload records that path as
live operator state and `openDb` refuses to use it as a fixture. If a test needs
a fixture home, set it in the file body before dynamically importing modules that
resolve the state directory. See `test/ui-config-store.test.ts` for the pattern.

**Where this stops.** `openDb` is not a sandbox. A test that spawns plain `node` and strips
`NODE_TEST_CONTEXT`, `MISSION_TEST_STATE` and the inherited home has not disguised itself as
something else - it has built the daemon's own launch, byte for byte, and no signal can refuse
one without refusing the other. A test can also skip all of this and call
`new DatabaseSync(...)` from `node:sqlite` directly, which never reaches `openDb`. Both are
pinned in `test/db-isolation.test.ts` so the boundary is stated rather than assumed. What the
guard closes is the accident - the missing preamble, the hoisted import, the override applied
one line too late. A child that inherits the worker's environment also inherits its
disposable state home and the preload's capture.

The preload clears inherited `MISSION_HOME` and `FLEET_HOME` and seeds `HARNESS_HOME`.
`envVar` checks those names in that order. Seeding the lowest-priority name lets tests
that set `HARNESS_HOME` select their own fixture database. Use **`MISSION_HOME`** for new
test fixtures and for daemon and operator configuration.

Under the test runner, `openDb` in `src/server/db.ts` opens only the `harness.db` named by the state home set *right now*, and only
when that home resolves - through symlinks, not just as spelled - to somewhere inside the temp
dir. A missing override, one applied after the path was already frozen, and one naming a real
state dir - under any of its historical names, or wherever the daemon was configured to keep
it - are refused before SQLite is touched at all. An override changed after a connection is
already open is the one case where SQLite has necessarily been opened, by that first call; it
is refused before the cached connection is handed back, so nothing is written through it under
the new home. Outside the test runner the check returns immediately and the daemon opens the
operator's state exactly as it always has.

`--test-concurrency` is deliberately not in that command. It caps how many test *files* run
at once, so naming a single file makes it inert, and carrying it here implied a single-file
run reproduces the suite's concurrency when it cannot.

A spec that launches `src/server/index.ts` needs `dist/native/state-lock.node` before
the daemon starts. The `pretest` script builds the addon. A direct single-file run skips
npm lifecycle scripts, so import and call `ensureNativeStateLockAddon` from
`test/helpers/native-state-lock.ts` before launching the daemon. The helper rebuilds if
its probe fails to load the addon or validate its required exports. This lets the spec
run on its own or in any shard.

Provisioning is therefore concurrent by design, and `scripts/build-state-lock-native.mjs`
owns that: it stages the addon sources into a private directory instead of letting `node-gyp
rebuild` delete and recreate `build/` under another builder, and it hands the result to
`scripts/native-addon-publish.mjs` so a daemon starting up never loads a half-written addon.
`test/native-state-lock-provisioning.test.ts` holds both lines.

Publishing is a rename, never a copy onto the published path, and that rule belongs to every
native addon rather than to one builder. Rewriting an addon in place while a live process has
it mapped invalidates macOS's code-signature bookkeeping for that inode, and from then on
every process that loads it is `SIGKILL`ed with an empty stderr - no exception, no log line.
`npm run build:native` runs on every `make start`, so one restart with the previous daemon
still up is enough to make a worktree unable to start a daemon at all. The native builders publish
through `publishNativeAddon`, and `test/native-addon-publish.test.ts` refuses a builder that
copies its own artifact into `dist/native` again.

To reproduce a failure that depends on parallel test files, run `npm test` with
`MISSION_TEST_CONCURRENCY` set to the value in the failing CI job.
[package.json](package.json) defines the local default.

On macOS, `npm test` includes real Electron geometry tests. If `CODEX_SANDBOX=seatbelt`, run `npm test` or `npm run test:electron` with scoped outside-sandbox approval. Do not bypass the preflight or add Chromium flags.

[CI](.github/workflows/ci.yml) runs on pushes to `main`, version tag pushes, and pull
requests. Its Linux jobs use ephemeral GitHub-hosted runners. Each job that consumes a
`node_modules` cache depends on the producer for its Node.js version. The workflow
defines the unit and E2E shard matrices. The [shared unit steps](.github/actions/run-unit-shard/action.yml)
run the tests, build, and smoke-check the bundles. The dedicated Linux voice job restores the pinned recognition and synthesis models and exercises both helpers. Typecheck and lint run in the gates job.
See the [contributor lint guidance](CONTRIBUTING.md#commands) for what lint enforces.

The [pull request title workflow](.github/workflows/pull-request-title.yml) checks titles
for Release Please. Keep macOS packaging on manual CI dispatch. A packaging failure
on a tag push would block signing because [signed distribution](.github/workflows/distribution.yml)
requires successful push CI for the release commit and ref.

## Working rules

Route new session-initiated requests for operator input or approval, including MCP session control requests, to the attention inbox. Keep their decision controls out of the conversation window.

For new or changed settings, declare the stable searchable key, read/write behavior and access
policy at the owner. Share dashboard validation and mutation effects. Record the reason for
protected or operational controls and update coverage. The fixed `mission_settings` tool supports
find, get and set. See the [setting onboarding contract](CONTRIBUTING.md#onboard-a-setting).

New user-facing features land behind a preview feature flag. Follow [Feature flags](docs/feature-flags.md) for live gates, tests and the preview, default-on, and retirement stages.


1. Inspect `git status` before editing. Preserve unrelated changes.
2. Follow existing module ownership and registry patterns. Do not create parallel sources of truth.
3. Add focused tests for behavior changes and regressions.
4. Validate in proportion to the change. UI changes require runtime or visual verification, not diff inspection alone.
5. New UI features and UI behavior changes require a Playwright spec in `e2e/`. See below.
6. Commit only task-related files on a feature branch.
7. A task that attaches more than one repository produces one pull request per repository it changed, and none for a repository it left alone. Each is reviewed, gated, and merged on its own; non-chat tasks finish when all of them have merged. Chat tasks remain open after all their pull requests merge and end when the operator completes them. See [dispatch and the backlog](docs/dispatch-and-backlog.md#attaching-more-than-one-repository) and [chat merge behavior](docs/inspector-and-shipping.md#when-a-tasks-pull-request-merges).

When a review workflow passes, do not rerun it to address Inspector feedback. Fix the feedback, resolve conflicts, push, and monitor that pull request and its CI until green - per pull request, so a session holding one in each of several repositories follows through on each.

## Code style and examples

Use schemas and shared registries instead of hand-parsing or branching on concrete agents.
Oxlint requires request JSON parsing through `src/server/http-body.ts` (`repository/parse-request-body`)
and keeps direct agent equality comparisons and switch cases under `src/server/harness/`
(`repository/agent-comparison`).

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

A modal's content inset belongs to the shell, never to its children. `.modal` declares
`--modal-inset` once and applies it as `padding-inline`, so anything rendered into a modal at
any depth clears the border without asking. A band that must reach the border - it draws a
background, a divider, or its own scrollport - carries `.modal-bleed` and keeps its own
padding; `.modal-head`, `.modal-body` and `.modal-foot` already do. Never re-declare the
horizontal inset on a child, and never assume a wrapper supplies it.

Correct:

```tsx
<Overlay className="modal si-session-modal" /* … */>
  <h3>Standing instructions this session received</h3>
  <div className="modal-bleed dispatch-body">{fields}</div>
  <footer className="modal-foot">{actions}</footer>
</Overlay>
```

Incorrect:

```tsx
// Flush against the border: the inset was opt-in per region, and `.modal-actions`
// never had a CSS rule at all.
<Overlay className="modal workflow-binding-dialog" /* … */>
  <p>Bind an immutable version.</p>
  <footer className="modal-actions">{actions}</footer>
</Overlay>
```

Tests in `test/` use `node:test` and `node:assert/strict`. React rendering tests use
`renderToStaticMarkup`. Oxlint bans jsdom, Testing Library, Vitest, Jest, and bare
`node:assert` in `test/` and `e2e/` (`repository/test-imports`).

Browser specs in `e2e/` use `@playwright/test` and run only under `npm run test:e2e`.
They drive the built dashboard served by the built daemon, so run `npm run build`
first. Tests in `test/` run under `npm test` and must pass on a fresh checkout.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionRuntime } from "../src/shared/harness-capabilities.ts";

test("honors a stored Pi SDK runtime", () => {
  assert.deepEqual(resolveSessionRuntime("pi", "sdk"), {
    runtime: "sdk",
    unknown: null,
    unsupported: null,
  });
});
```

## UI changes require an end-to-end spec

Read [e2e/README.md](e2e/README.md) before writing one.

**Every new UI feature and every UI change requires a Playwright spec in `e2e/`.** There are
no exemptions. If the change is visible to a person using the dashboard, it is covered here
before it lands.

Browser specs connect a user action to a route, a server event, and the resulting DOM
update. Static rendering tests check markup, in-process HTTP tests exercise routes, and
Electron tests measure laid-out geometry.

This includes, and is not limited to:

- A new control, form, modal, or view.
- A change to what an existing control does, what it sends, or what it renders in response.
- Markup, styling, copy, and layout changes. Assert the user-visible consequence - the text
  a person reads, the control they can reach, the element that is now present or gone.
- A fix for a bug that reproduced through the UI. Write the failing spec first.

The other layers are additions to this requirement, never substitutes for it. Reach for them
alongside a spec to check an exact markup shape with `renderToStaticMarkup` or to measure
height, overflow, and clipping in Electron.

Changes with no UI surface - pure functions, reducers, selectors, formatting helpers, route
edge cases - belong in `test/`.

- **Never spend model tokens.** Use the E2E fixtures for agent binaries and SDK sessions.
  Keep both the one-shot Claude CLI and Agent SDK paths faked. Managed Pi sessions load
  the fake SDK through `MISSION_PI_SDK_MODULE`.
- **Never add `data-testid` or `getByTestId`** (Oxlint `repository/no-test-ids`). The app already labels its controls. Select by role,
  label, or placeholder so the spec exercises the names users rely on.

A spec that opens a new modal calls `expectContentClearsBorder` from
`e2e/fixtures/modal-inset.ts`. It compares the content and panel rectangles to check the inset.

## Boundaries

- Never commit secrets, tokens, credentials, local state, or operator data.
- Never commit evidence artifacts. Proof-of-work screenshots and transcripts attach to the pull request. Evidence produced for or submitted to workflow personas is also never committed: produce it in a gitignored location and attach it to the pull request. Committed documentation imagery in `docs/images/` is documentation, not evidence.
  The CI pull request policy gates new image paths outside `docs/images/` and established product asset locations.
- Never modify production, signing, release, CI, or deployment configuration unless the task explicitly requires it.
- Never let the Foreman worker touch SQLite. The daemon is the only database writer.
- Never add a second session-eviction path. Terminal and SDK sessions leave through `Registry.beginEviction`.
  Oxlint reserves `session_remove` construction and `sessions.delete` for the registry
  (`repository/registry-eviction`).
- Never infer durable cleanup from `state === "exited"`; use `session_remove`.
- Never enable Electron `asar` or move `skills/` into `dist`.
- Never hand-edit generated files. Change their source or generator and regenerate them.
- Never hand-edit `CHANGELOG.md`. The CI pull request policy requires a Release Please PR.
- Never rename or reorder persisted append-only IDs. See the change contracts before extending them.
- Never use `git reset --hard`, force-push, or remove worktrees unless the user explicitly requests it and the target is verified.
- Never add an agent name as a commit co-author. The CI pull request policy checks incoming commit trailers.
- Never use an em dash in project prose.

Treat these paths as controlled:

- `src/shared/`: wire contracts and browser-safe shared logic only. Oxlint bans `node:` imports (`no-restricted-imports`).
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

In repository storage mode, plan Markdown belongs at `docs/plans/<name>/plan.md`.
In local mode, keep the complete plan bundle in Mission Control's repository-scoped local
plan store, with no checkout files. Follow the [managed-plans guide](docs/managed-plans.md)
for the pinned storage policy and managed tools. A written plan is not an implementation.

Read `.agents/memory/MEMORY.md` (this repository's agent memory) before starting work, and
any entry it links that bears on your task.
