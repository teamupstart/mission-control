# AGENTS.md

## Project overview

Mission Control is a local control plane for Claude Code, Codex, and Pi sessions, built with Node.js 24+, TypeScript 5.7, React 19, Vite 6, Electron 43, Hono 4, Zod 3, and SQLite.

Read [README.md](README.md) for product behavior and setup. Before changing a subsystem, read:

- [Architecture and lifecycle](docs/agent-guides/architecture.md)
- [Change contracts](docs/agent-guides/change-contracts.md)
- [Ensemble extension guide](docs/ensembles.md)
- [Original agent guide backup](docs/backups/AGENTS.old) for historical detail

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
npm run smoke
npm run package
```

`npm run smoke` requires a successful `npm run build` first. `npm run package` builds the macOS application.

Run one test file with the same concurrency and loader as the full suite:

```sh
node --test --test-concurrency=2 --import tsx test/session-contracts.test.ts
```

On macOS, `npm test` includes real Electron geometry tests. If `CODEX_SANDBOX=seatbelt`, run `npm test` or `npm run test:electron` with scoped outside-sandbox approval. Do not bypass the preflight or add Chromium flags.

CI runs typecheck, tests, build, and bundle smoke tests on Node.js 24 and 26. Lint is a required local check but is not currently a CI job.

## Working rules

1. Inspect `git status` before editing. Preserve unrelated changes.
2. Follow existing module ownership and registry patterns. Do not create parallel sources of truth.
3. Update README documentation in the same change when behavior, configuration, commands, or shortcuts change.
4. Add focused tests for behavior changes and regressions.
5. Validate in proportion to the change. UI changes require runtime or visual verification, not diff inspection alone.
6. Commit only task-related files on a feature branch.

When using no-mistakes, follow its gate until it passes. After it passes, do not rerun it to address Inspector feedback. Fix the feedback, resolve conflicts, push, and monitor the existing PR and CI until green.

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

## Boundaries

- Never commit secrets, tokens, credentials, local state, or operator data.
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
- README and linked technical docs match the implementation.
- The worktree contains no unrelated edits.
- Requested PR and CI work is complete before reporting completion.

Plans belong in `docs/plans/<name>/plan.md`; a written plan is not an implementation.
