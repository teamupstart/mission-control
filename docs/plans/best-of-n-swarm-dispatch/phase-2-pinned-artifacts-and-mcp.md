# Phase 2: Pinned Artifacts and Mission MCP Launch Seam

## Outcome

Task dispatch can opt into one verified input commit, Claude and Codex can receive the same
launch-scoped Mission MCP server, and a worktree can be captured into a restorable private Git
artifact without mutating its branch, working tree, or real index.

Normal single dispatch remains unchanged when these options are absent.

## Entry criteria and dependencies

- Direct dependency: the active planning session and its merged plan artifacts.
- May execute and merge independently of Phase 1.
- Existing Dispatcher cleanup, Treehouse pool, ask-channel, Codex hook, and packaged MCP tests are
  green before work begins.

## Scope

Included:

- durable caller-supplied launch options flowing TaskManager → Dispatcher;
- pinned-base Git and Treehouse provisioning with post-provision verification;
- exact base-to-snapshot evidence helper;
- temporary-index immutable commit/ref capture and restore primitives;
- shared launch-scoped Mission MCP runtime/descriptor;
- Claude ask-channel reuse of that descriptor;
- Codex TOML MCP registration composed with hooks/auto-mode;
- packaged-path and exact-argv tests.

Non-goals:

- Ensemble tables, state machine, attribution, or submission tool schema;
- strategy policy in Dispatcher;
- arbitrary cleanup commands or ignored-cache deletion;
- changing global Claude/Codex MCP registration;
- changing operator-started sessions;
- public routes or web UI.

## Repository findings and inherited contracts

- Worktree provisioning and teardown are both in `src/server/dispatcher.ts`.
- `TaskManager.DispatchOptions` currently carries only `defaultModel`, and
  `TaskManager.dispatch` invokes `Dispatcher.dispatch(id)` without forwarding options.
- Git fallback provisions with `git worktree add ... -b ... HEAD`.
- Treehouse leases return an existing checkout/branch and preserve ignored warm dependencies.
- Dispatcher re-reads and patches Task state between every effect; cancellation/restart cleanup
  ownership must remain there.
- Claude launch-scoped MCP config/runtime writing is inside `ask-channel.ts`.
- Codex `prepareCodexLaunch(auto)` currently composes sandbox/approval flags and launch-scoped hook
  overrides as one all-or-nothing hook/trust unit.
- `mcpServerPath()` is the packaged-safe resolver and must remain the one server path.

## Implementation steps

1. Define a server-only `TaskDispatchOptions` shape with optional `defaultModel`, `baseSha`, and
   `missionMcp` requirements. The latter describes required Mission tools/capabilities, not raw
   client-supplied argv.
2. Forward options through `TaskManager.dispatch` into `Dispatcher.dispatch`. Preserve the current
   rule that a task-pinned model wins and a supplied default is persisted only for an otherwise
   unpinned backlog Task.
3. Validate `baseSha` as a full commit in the declared `repoRoot` before provisioning. Dispatcher
   treats it as mechanism only; Ensemble policy will choose it in Phase 4.
4. Extend `provisionWorktree` in `dispatcher.ts`:
   - Git fallback uses the verified commit instead of `HEAD`;
   - Treehouse verifies repository ownership, runs an argument-array hard reset to the commit,
     removes nonignored untracked files while preserving ignored caches, and retains its provider
     semantics;
   - every path re-reads `HEAD` and fails if it differs from the requested commit.
5. Keep cancellation and failure cleanup in Dispatcher. A pinned provisioning failure must not
   leave an unrecorded worktree or return a live Treehouse lease incorrectly.
6. Add `src/server/git/ensemble-snapshot.ts` with:
   - a temporary-index capture using `read-tree`, `add -A`, `write-tree`, `commit-tree`, and
     generated `refs/mission-control/ensembles/...`;
   - ref/commit verification before returning;
   - `finally` cleanup for the temporary index;
   - exact `baseSha..snapshotSha` materialization with file stats, binary markers, bounded patch,
     truncation, and omitted-byte count;
   - restore/reset helpers that operate only on validated generated ids/refs.
7. Refactor MCP runtime resolution/config serialization from `ask-channel.ts` into a focused
   `src/server/mission-mcp.ts`. It returns one descriptor for `mcpServerPath()` plus runtime/env and
   can render harness-specific launch arguments.
8. Keep `askChannelArgs` atomic: Claude receives MCP registration, tool preapproval, built-in
   disallow, and redirect prompt together or none. It consumes the shared descriptor rather than
   maintaining a second server/runtime config.
9. Extend Codex launch preparation to compose:
   - existing hook overrides plus trust bypass as one unit;
   - existing auto sandbox/approval flags;
   - optional `mcp_servers.mission-control.command`, `args`, and `env` TOML overrides.
   Missing MCP preparation must not produce partial registration, and a missing hook bridge must
   still never produce a lone hook trust bypass.
10. Add exact argv/config fixtures for Claude and Codex, including spaces/quotes in absolute paths,
    Electron-as-node env, missing bundle degradation, and packaged bundle paths.

## Data, API, migration, and compatibility

- No database schema changes.
- Launch options are internal and supplied from durable Ensemble member input in Phase 4. They are
  not stored as nullable columns on Task.
- On daemon restart, existing Task reconciliation remains authoritative. Ensemble recovery later
  retries from its durable member input after a clean failed launch; it never assumes an ephemeral
  options object survived.
- `git clean -fd`-equivalent behavior must remove only nonignored files. Do not use `-x`.
- Refs contain generated UUID components only.
- Snapshot and diff helpers use the existing argument-array runner, never shell interpolation.
- No new build entry point is required; the existing MCP bundle is reused.

## Tests and verification

Add focused tests for:

- normal dispatch still provisions from current HEAD when `baseSha` is absent;
- source HEAD movement between member launches does not change the pinned input;
- Git fallback command and post-provision verification;
- Treehouse lease reset, clean behavior, repository check, ignored-cache preservation, and fallback;
- cancellation/failure during pinned provisioning leaves no unsafe resource;
- snapshot includes committed-after-base, staged, unstaged, deletions, renames, binary, and
  nonignored untracked content;
- real index bytes, HEAD, branch, and working tree are unchanged after snapshot;
- ref survives worktree teardown and restores the exact tree;
- exact diff caps/truncation are honest;
- Claude ask channel remains all-four-or-none;
- Codex combines MCP, hooks, trust, and auto flags without losing existing behavior;
- missing bundle/runtime degrades without aborting normal dispatch.

Commands:

```text
node --test --import tsx test/ask-channel.test.ts
node --test --import tsx test/dispatcher-cleanup.test.ts test/dispatch-model.test.ts
node --test --import tsx test/harness-hooks.test.ts test/harness-control.test.ts
npm run typecheck
npm run build:mcp
npm run build:server
npm run smoke
```

## Merge and exit criteria

- Two worktrees can be provisioned from one full SHA after source HEAD moves.
- Snapshot and restore round-trip the complete tree without real-index mutation.
- Claude and Codex exact launch fixtures contain one scoped Mission MCP registration.
- Existing ask-channel and Codex hook safety invariants remain green.
- Normal dispatch without new options is behaviorally unchanged.

## Downstream handoff

Phase 4 receives:

- the forwarded pinned dispatch option;
- verified worktree input behavior;
- capture/materialize/restore helpers;
- a strategy-neutral way to require Mission MCP for a launched Task.

Downstream phases must not teach Dispatcher about Ensemble ids, stages, barriers, or policies, and
must not duplicate MCP runtime/config resolution.

## Cross-phase audit record

- 2026-07-23: Corrected the root plan's speculative `worktree.ts` ownership to
  `src/server/dispatcher.ts`.
- 2026-07-23: Separated the MCP launch descriptor from the future submission tool schema so this
  phase can merge independently of Ensemble persistence.
- 2026-07-23: Kept launch options internal and restart behavior in the future Ensemble manager
  rather than adding denormalized Task columns.
