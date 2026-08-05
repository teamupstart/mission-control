# Phase 1: Multi-repo dispatch

Source plan: [plan.md](plan.md) - Index: [phased-plan.md](phased-plan.md)

## 1. Outcome

An operator can attach secondary repositories to a task in the dispatch modal and dispatch it. One agent session starts with its cwd in the primary repo's worktree, one additional provisioned worktree per secondary repo, write access to all of them (Claude and Codex), and an intent manifest telling it where each repo lives and that each changed repo gets its own PR. Everything downstream (PR tracking, workflows, completion) still behaves exactly as today: the session's first PR is the one Mission Control tracks. That is deliberate; phases 2 and 3 lift it.

## 2. Entry criteria and dependencies

- No phase prerequisites. This is the foundation phase.
- The planning PR (this plan's artifacts) must be merged so this file resolves on the default branch.

## 3. Scope and non-goals

In scope:

- `task_repos` table, migration, and upgrade test.
- Shared contracts: `TaskRepoEntry`, `Task.extraRepos`, `DispatchSchema.extraRepoRoots`, `UpdateTaskSchema.extraRepoRoots`.
- Per-repo provisioning and teardown with all-or-nothing rollback; `base_sha` recorded per secondary.
- Pool pins covering secondary worktrees (same change as provisioning - destructive if split).
- `HARNESS_CAPABILITIES` flag `multiRepoDispatch`; Claude additional directories; Codex sandbox writable roots.
- Intent manifest prepended to the dispatched intent.
- Dispatch modal repo chips; draft and lastRepo storage as lists.
- Foreman allowlist AND rule over the repo set (consent gate ships with the capability, not after it).
- Assignment refusal: multi-repo tasks are dispatch-only.
- README and e2e coverage.

Non-goals (owned by later phases):

- Any change to PR sniffing, episode PR storage, poll targets, or completion rules (phase 2).
- Any change to workflow bindings, runs, gates, or session actions (phase 3).
- Review follow-up marks and skill prose (phase 4).
- Ensembles, schedules, task sources, MCP `create_task`, board drag-to-assign (out of scope for v1 entirely).

## 4. Repository findings this phase builds on

Verified against the repo at scoping time (2026-08-05):

- `tasks` table: `src/server/db.ts:131-181`; `repo_root TEXT NOT NULL` at 155, `worktree_path`/`branch`/`provider` at 156-158. `addColumn`/`hasColumn` helpers near db.ts:1929. `TaskRow` ~2578, `rowToTask` ~2691, `upsertTask` ~2740 - the single write path.
- `Task` interface: `src/shared/types.ts:1434-1620`; repo fields 1508-1514. `Task` travels whole over `task_upsert` (`types.ts:2138`), so no new `ServerEvent` is needed.
- `DispatchSchema`: `src/shared/protocol.ts:563-591` (`repoRoot` at 565). `UpdateTaskSchema` at 695-714. `isAnnotationOnlyUpdate` (717-719) counts patch keys - a new repo field is automatically a provisioning change, refused after backlog. Note: `protocol.ts` needs `grep -a` (binary-detection quirk).
- `resolveTaskRepoRoot`: `src/server/repos.ts:215-230` - the validating door every task-creating route uses. Its walk-back to the owning checkout is why worktree paths are refused as roots.
- `TaskManager.create`: `src/server/tasks.ts:1011-1116` (`CreateTaskInput.repoRoot` at 57). `assign` repo-equality refusal at tasks.ts:1487-1495.
- `provisionWorktree`: `src/server/dispatcher.ts:739` (pool arm 773-839, git fallback 841-867, branch `harness/<slug>-<shortId>`); `teardownWorktree`: `dispatcher.ts:899` (treehouse return without `--force`, git fallback removes + deletes only `harness/`-prefixed branches). `verifyPinnedBase` at 675 demands a full 40-char sha. Runtime branch at dispatcher.ts:206; SDK arm passes `cwd: wt.path, gitRoot: wt.path` (~410-432).
- Pool pins: `src/server/pool.ts:208` (`occupiedCwds`), `pool.ts:223` (`poolPins` - `sessionCwds`, `taskWorktrees`, `checkLeasePaths`). The doc comment on `provisionWorktree` warns an under-populated spared set silently disarms the reaper gate.
- Capabilities: `HARNESS_CAPABILITIES` at `src/shared/harness-capabilities.ts:377` (browser-safe), `HARNESSES` in `src/server/harness/index.ts` (process side). Adding a field to the capabilities type forces a measured value per agent via the exhaustive `Record`.
- Claude SDK launch: `src/server/harness/claude/sdk.ts:900-948` - single `cwd`, `settingSources: ["user","project","local"]` at 940. `SdkLaunchOptions` in `src/server/harness/types.ts:597-609`. **Unverified at scoping time** (node_modules absent): the exact Agent SDK option for additional directories (`@anthropic-ai/claude-agent-sdk@0.3.220` in package.json). Verify it first; if the SDK genuinely lacks one, the terminal path's `--add-dir` still works and the SDK path may need permission-mode configuration instead - record whichever is true in the PR.
- Codex launch: `src/server/harness/codex/launch.ts:71` - `--sandbox workspace-write`. Writable-roots config key must be verified against a real Codex installation before the capability is declared true (change-contracts: `null` is a measured unsupported capability, not a placeholder).
- Foreman gates: `src/server/foreman/backlog-machine.ts:302,315` - `cwdAllowlisted(t.repoRoot, cfg.allowlist)`; agent matching at 231.
- Dispatch modal: `src/web/components/DispatchModal.tsx` - `repoField` at 861-877, submit gates at 773/1411/1467, `api.dispatch` body at 817-831, `rememberDispatchRepo` at 847, ensemble compose at 571-585. The Dependencies chips pattern to copy is at 1308-1369. Draft type: `src/web/lib/task-draft.ts` (`DispatchDraft.repoRoot` at 26). `RepoCombobox`: `src/web/components/RepoCombobox.tsx` (free text is load-bearing; keep it).
- e2e: `e2e/fixtures/daemon.ts:106` (`seedRepo`, already name-parameterized; single call at 140). The shared dispatch helper other specs copy: `e2e/specs/dispatch-and-converse.spec.ts:132-161`.
- Names `task_repos`, `extraRepoRoots`, `extraRepos` are unused in `src/` today (verified by grep).

## 5. Implementation steps

Execution order; adjust where the repository disagrees and record the deviation in the PR.

1. **Schema** (`src/server/db.ts`): add `task_repos` to the fresh `CREATE TABLE IF NOT EXISTS` block and mirror it in `migrate()`; per the change contract, indexes referencing it are created after the migration step, and no backticks go inside the `openDb()` template literal.

   ```sql
   CREATE TABLE IF NOT EXISTS task_repos (
     task_id       TEXT NOT NULL,
     repo_root     TEXT NOT NULL,
     worktree_path TEXT,
     branch        TEXT,
     provider      TEXT,
     base_sha      TEXT,
     position      INTEGER NOT NULL,
     PRIMARY KEY (task_id, repo_root)
   );
   CREATE INDEX IF NOT EXISTS idx_task_repos_worktree ON task_repos(worktree_path);
   ```

   Add load/replace helpers beside the task row functions; `upsertTask` callers write the collection in the same transaction. Delete rows with the task.
2. **Shared types** (`src/shared/types.ts`): `TaskRepoEntry { repoRoot, worktreePath, branch, provider, baseSha, prUrl, prState, mergedAt }` (PR fields null until phase 2 populates them; declaring them now keeps the wire shape stable across phases). `Task.extraRepos: TaskRepoEntry[]`. No new `ServerEvent`.
3. **Protocol** (`src/shared/protocol.ts`): `extraRepoRoots: z.array(z.string().min(1)).max(8).default([])` on `DispatchSchema` and `UpdateTaskSchema`. Cap of 8 is a sanity bound, not a product limit; state it in a comment.
4. **Routes and manager** (`src/server/routes.ts`, `src/server/tasks.ts`): resolve every entry through `resolveTaskRepoRoot`, dedupe, refuse an entry equal to the primary, 400 on any refusal. `CreateTaskInput.extraRepoRoots`. `TaskManager.assign` refuses tasks with a non-empty repo set (clear error naming the reason). Task update follows the existing repo-move resolution pattern at routes.ts:3131-3138.
5. **Capability** (`src/shared/harness-capabilities.ts`, `src/server/harness/index.ts`): add `multiRepoDispatch` to the capabilities type; the compiler enumerates the records to fill. Claude: verified value. Codex: true only after the writable-roots key is verified live; otherwise null and the modal simply never offers multi-repo for Codex (ship the phase either way; flipping the value later is a one-line follow-up with its measurement). Pi: null.
6. **Provisioning** (`src/server/dispatcher.ts`): loop `[primary, ...extras]` through `provisionWorktree` with the same slug/shortId; record each secondary's cut commit as `base_sha` (`git -C <wt> rev-parse HEAD` right after provisioning; full 40-char oid). On mid-loop failure, tear down already-provisioned entries provider-aware and fail the dispatch through the existing error path. Patch the task with the primary triple plus the collection. `teardownWorktree`/`teardownTaskResources` and startup reconciliation loop the collection and null it with the scalars.
7. **Pool pins** (`src/server/pool.ts`): `taskWorktrees` in `poolPins` unions `extraRepos[].worktreePath`. Same commit as step 6.
8. **Agent handoff** (`src/server/dispatcher.ts`, `src/server/harness/claude/sdk.ts`, `src/server/harness/codex/launch.ts`, `src/server/harness/types.ts`): `SdkLaunchOptions` gains `extraDirs: string[]`; the Claude driver maps it to the verified SDK option, the terminal argv builder to `--add-dir` per entry, Codex to its verified writable-roots config. Prepend the intent manifest (repo table: path, branch, primary marker; instructions: read each repo's AGENTS.md/CLAUDE.md before touching it, commit and push per repo, one PR per repo actually changed). The manifest is part of the delivered intent on both runtime paths.
9. **Foreman consent** (`src/server/foreman/backlog-machine.ts`): schedulability requires `cwdAllowlisted` for the primary and every extra root (AND). Agent matching at 231 is untouched - multi-repo tasks are dispatch-only, and free-agent assignment already can't reach them after step 4.
10. **UI** (`src/web/components/DispatchModal.tsx`, `src/web/lib/task-draft.ts`, `src/web/lib/lastRepo.ts`, `src/web/components/layouts/BacklogColumn.tsx`): repo chips + `RepoCombobox` adder following the Dependencies pattern; first chip marked primary; adder hidden when the selected harness lacks `multiRepoDispatch` (read capability via the browser-safe record). Draft field `extraRepoRoots: string[]`; `draftsEqual`, `taskUpdatePatch`, `draftFromTask`, empty/fresh helpers updated. `lastRepo` remembers the full list. `canAcceptTask` returns false for multi-repo tasks. Backlog card shows a small repo-count chip.
11. **README**: dispatch section documents multi-repo attach, which harnesses support it, and the one-PR-per-repo expectation.

## 6. Data and compatibility

- A single-repo task has zero `task_repos` rows; `extraRepos` serializes as `[]`. Old databases open unchanged; the upgrade test seeds a pre-feature database and asserts both open and task load.
- `repo_root` scalar semantics are untouched everywhere. No persisted IDs are added or renamed.
- `isAnnotationOnlyUpdate` needs no change: the new key makes any repo-set patch non-annotation by construction. Add a test pinning that.

## 7. Tests and verification

- Unit (`test/`): migration upgrade from pre-feature DB; create/update validation (dedupe, primary-collision, resolve refusal); provisioning rollback on mid-loop failure (inject a failing provider); pins include extras (extend the reap-planning test); assignment refusal; manifest content; capability record completeness (compiler does most of it).
- e2e (`e2e/`): add a second `seedRepo` to the daemon fixture; new spec: open dispatch, add two repos via the chips UI, dispatch, assert the session card appears and both worktrees exist under the state dir; assert the fake agent's recorded launch got both directories. Update the shared `dispatch()` helper only if the chips change its selector dance; keep other specs passing.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- All of section 7 green in CI.
- A multi-repo dispatch on a real machine (or the e2e fake-agent equivalent) produces N worktrees, a live session at the primary, and teardown/complete cleans all of them.
- Single-repo dispatch behavior byte-identical (existing specs prove it).
- README updated in the same PR.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- `task_repos` columns and primary key as written above; `base_sha` is a full oid recorded at cut time.
- `TaskRepoEntry` field names including the reserved `prUrl`/`prState`/`mergedAt` (null in this phase).
- `Task.extraRepos` riding `task_upsert`; order is `position`.
- The session's cwd is always the primary worktree; secondary worktree paths come only from `task_repos`.
- Multi-repo tasks are dispatch-only; no code may assume a multi-repo task reached a session via `assign`.
- The capability flag name `multiRepoDispatch`.

## 10. Cross-phase audit record

- 2026-08-05 (scoping): allowlist AND rule moved here from phase 4 - a consent gate ships with the capability that needs it.
- 2026-08-05 (scoping): `TaskRepoEntry` PR fields declared in this phase (null) so phase 2 does not change the wire shape.
