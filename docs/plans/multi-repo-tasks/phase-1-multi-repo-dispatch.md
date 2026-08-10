# Phase 1: Multi-repo dispatch

Source plan: [plan.md](plan.md) - Index: [phased-plan.md](phased-plan.md)

## 1. Outcome

An operator can attach secondary repositories to a task in the dispatch modal and dispatch it. One agent session starts with its cwd in the primary repo's worktree, one additional provisioned worktree per secondary repo, write access to all of them (Claude and Codex), and an intent manifest telling it where each repo lives and that each changed repo gets its own PR. Everything downstream (PR tracking, workflows, completion) still behaves exactly as today: the session's first PR is the one Mission Control tracks. That is deliberate; phases 2 and 3 lift it.

## 2. Entry criteria and dependencies

- No phase prerequisites. This is the foundation phase.
- The planning PR (this plan's artifacts) must be merged so this file resolves on the default branch.

## 3. Scope and non-goals

In scope:

- `task_repos` table plus the additive `tasks.base_sha` column, migration, and upgrade test.
- Shared contracts: `TaskRepoEntry`, `Task.extraRepos`, `DispatchSchema.extraRepoRoots`, `UpdateTaskSchema.extraRepoRoots`.
- Per-repo provisioning and teardown with all-or-nothing rollback; a per-repo git-fallback worktree destination so two non-pool repos on one task do not collide; `base_sha` recorded for every repo, primary included.
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

Verified against the repo at scoping time (2026-08-05), citations re-verified against `main` (2026-08-10):

- `tasks` table: `src/server/db.ts:131-181`; `repo_root TEXT NOT NULL` at 155, `worktree_path`/`branch`/`provider` at 156-158. `addColumn`/`hasColumn` helpers near db.ts:2026. `TaskRow` ~2674, `rowToTask` ~2787, `upsertTask` ~2836 - the single write path.
- `Task` interface: `src/shared/types.ts:1485-1634`; repo fields 1558-1565. `Task` travels whole over `task_upsert` (`types.ts:2259`), so no new `ServerEvent` is needed.
- `DispatchSchema`: `src/shared/protocol.ts:583-611` (`repoRoot` at 585). `UpdateTaskSchema` at 730-749. `isAnnotationOnlyUpdate` (753-755) counts patch keys - a new repo field is automatically a provisioning change, refused after backlog. Note: `protocol.ts` needs `grep -a` (binary-detection quirk).
- `resolveTaskRepoRoot`: `src/server/repos.ts:215-230` - the validating door every task-creating route uses. Its walk-back to the owning checkout is why worktree paths are refused as roots.
- `TaskManager.create`: `src/server/tasks.ts:1011-1121` (`CreateTaskInput.repoRoot` at 57). `assign` repo-equality refusal at tasks.ts:1543-1549.
- `provisionWorktree`: `src/server/dispatcher.ts:760` (pool arm 799-865, git fallback 867-893, branch `harness/<slug>-<shortId>`). **The git-fallback destination is `join(WORKTREES_DIR, taskId)` at dispatcher.ts:868 - it is keyed on the task alone, so two repos on one task collide.** The pool arm does not: each repo has its own pool and hands back a lease path the caller never chooses. Step 6 must therefore make the fallback destination per repo, and must not touch pool paths; `teardownWorktree`: `dispatcher.ts:925` (treehouse return without `--force`, git fallback removes + deletes only `harness/`-prefixed branches). `verifyPinnedBase` at 696 demands a full 40-char sha. Runtime branch at dispatcher.ts:206; SDK arm passes `cwd: wt.path, gitRoot: wt.path` (~425-441).
- Pool pins: `src/server/pool.ts:242` (`occupiedCwds`), `pool.ts:257` (`poolPins` - `sessionCwds`, `taskWorktrees`, `checkLeasePaths`). The doc comment on `provisionWorktree` warns an under-populated spared set silently disarms the reaper gate.
- Capabilities: `HARNESS_CAPABILITIES` at `src/shared/harness-capabilities.ts:377` (browser-safe), `HARNESSES` in `src/server/harness/index.ts` (process side). Adding a field to the capabilities type forces a measured value per agent via the exhaustive `Record`.
- Claude SDK launch: `src/server/harness/claude/sdk.ts:956-1024` - single `cwd`, `settingSources: ["user","project","local"]` at 1016. `SdkLaunchOptions` in `src/server/harness/types.ts:608-620`. **Resolved 2026-08-10** (unverified at scoping time only because `node_modules` was absent from the planning worktree): the Agent SDK does expose the option. `Options.additionalDirectories?: string[]` at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1332`, documented as "Additional directories Claude can access beyond the current working directory. Paths should be absolute." `package.json` still pins `@anthropic-ai/claude-agent-sdk@0.3.220`. Step 8's "verified SDK option" therefore resolves to `additionalDirectories`, and the permission-mode fallback this bullet used to hedge on is not needed. One detail that confirms the launch-time approach: a directory added at runtime through the `addDirectories` control request must be a strict subdirectory of cwd or of a launch-time directory (`sdk.d.ts:3665`), so a sibling repo is reachable only by passing it at launch.
- Codex launch: `src/server/harness/codex/launch.ts:71` - `--sandbox workspace-write`. Writable-roots config key must be verified against a real Codex installation before the capability is declared true (change-contracts: `null` is a measured unsupported capability, not a placeholder).
- Foreman gates: `src/server/foreman/backlog-machine.ts:317,330` - `cwdAllowlisted(t.repoRoot, cfg.allowlist)`; agent matching at 246.
- Dispatch modal: `src/web/components/DispatchModal.tsx` - `repoField` at 1128-1144, submit gates at 1040/1744/1796, `api.dispatch` body at 1084-1098, `rememberDispatchRepo` at 1114, ensemble compose at 703-717. The Dependencies chips pattern to copy is at 1609-1670. Draft type: `src/web/lib/task-draft.ts` (`DispatchDraft.repoRoot` at 26). `RepoCombobox`: `src/web/components/RepoCombobox.tsx` (free text is load-bearing; keep it).
- e2e: `e2e/fixtures/daemon.ts:121` (`seedRepo`, already name-parameterized; single call at 155). The shared dispatch helper other specs copy: `e2e/specs/dispatch-and-converse.spec.ts:133-162`.
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

   Also add the primary's baseline as an additive column on `tasks`, in the same migration step and per the same contract (`addColumn(d, "tasks", "base_sha", "TEXT")`, nullable so existing rows upgrade cleanly):

   ```ts
   addColumn(d, "tasks", "base_sha", "TEXT");
   ```

   The primary's baseline lives on `tasks` rather than in a `task_repos` row so that "a single-repo task has zero `task_repos` rows" stays true and no existing single-repo consumer changes shape. Without it the phase 2 quorum and the phase 3 run-creation predicate cannot see primary changes at all - see section 10.

   Add load/replace helpers beside the task row functions; `upsertTask` callers write the collection in the same transaction. Delete rows with the task.
2. **Shared types** (`src/shared/types.ts`): `TaskRepoEntry { repoRoot, worktreePath, branch, provider, baseSha, prUrl, prState, mergedAt }` (PR fields null until phase 2 populates them; declaring them now keeps the wire shape stable across phases). `Task.extraRepos: TaskRepoEntry[]` and `Task.baseSha: string | null` for the primary, so every repo's baseline reaches consumers through one shape. No new `ServerEvent`.
3. **Protocol** (`src/shared/protocol.ts`): `extraRepoRoots: z.array(z.string().min(1)).max(8).default([])` on `DispatchSchema` and `UpdateTaskSchema`. Cap of 8 is a sanity bound, not a product limit; state it in a comment.
4. **Routes and manager** (`src/server/routes.ts`, `src/server/tasks.ts`): resolve every entry through `resolveTaskRepoRoot`, dedupe, refuse an entry equal to the primary, 400 on any refusal. `CreateTaskInput.extraRepoRoots`. `TaskManager.assign` refuses tasks with a non-empty repo set (clear error naming the reason). Task update follows the existing repo-move resolution pattern at routes.ts:3539-3547.
5. **Capability** (`src/shared/harness-capabilities.ts`, `src/server/harness/index.ts`): add `multiRepoDispatch` to the capabilities type; the compiler enumerates the records to fill. Claude: verified value. Codex: true only after the writable-roots key is verified live; otherwise null and the modal simply never offers multi-repo for Codex (ship the phase either way; flipping the value later is a one-line follow-up with its measurement). Pi: null.
6. **Provisioning** (`src/server/dispatcher.ts`): loop `[primary, ...extras]` through `provisionWorktree` with the same slug/shortId.

   **Give each repo its own git-fallback destination first, or the loop cannot work.** Today the fallback path is `join(WORKTREES_DIR, taskId)` (dispatcher.ts:868), keyed on the task alone, so the second non-pool repo on a task hits `git worktree add` against a directory that already exists and the dispatch fails. Extend `provisionWorktree` with an explicit slot discriminator - the loop index, which is exactly the `position` the entry gets in `task_repos` - and derive the destination from it:

   - slot 0 (the primary) keeps `join(WORKTREES_DIR, taskId)` exactly as today, so single-repo dispatch, existing tasks, and startup reconciliation are byte-identical;
   - slot n greater than 0 uses `join(WORKTREES_DIR, taskId + "-" + n)`.

   Default the parameter to slot 0 so every existing caller is unchanged. Key the suffix on `position`, not on the repo's basename: two attached repos can share a basename (`~/a/api` and `~/b/api`) and a name-derived path would collide again or need sanitizing, while `position` is unique by construction and already persisted, so the path stays stable across restarts. The branch name stays `harness/<slug>-<shortId>` for every repo - branches live in different repositories, so they do not collide, and one branch name across the set is what makes the PRs legible as one task. Leave the pool arm alone: pool paths come from each repo's own pool and are already distinct.

   Then record every repo's cut commit as `base_sha` (`git -C <wt> rev-parse HEAD` right after provisioning; full 40-char oid) - the primary's onto `tasks.base_sha`, each secondary's onto its `task_repos` row. Record the primary's on single-repo dispatches too: it costs one column write, keeps one code path, and gives phase 3 a baseline for the ordinary case. On mid-loop failure, tear down already-provisioned entries provider-aware and fail the dispatch through the existing error path. Patch the task with the primary triple plus the collection. `teardownWorktree`/`teardownTaskResources` and startup reconciliation loop the collection and null it with the scalars.
7. **Pool pins** (`src/server/pool.ts`): `taskWorktrees` in `poolPins` unions `extraRepos[].worktreePath`. Same commit as step 6.
8. **Agent handoff** (`src/server/dispatcher.ts`, `src/server/harness/claude/sdk.ts`, `src/server/harness/codex/launch.ts`, `src/server/harness/types.ts`): `SdkLaunchOptions` gains `extraDirs: string[]`; the Claude driver maps it to the verified SDK option, the terminal argv builder to `--add-dir` per entry, Codex to its verified writable-roots config. Prepend the intent manifest (repo table: path, branch, primary marker; instructions: read each repo's AGENTS.md/CLAUDE.md before touching it, commit and push per repo, one PR per repo actually changed). The manifest is part of the delivered intent on both runtime paths.
9. **Foreman consent** (`src/server/foreman/backlog-machine.ts`): schedulability requires `cwdAllowlisted` for the primary and every extra root (AND). Agent matching at 246 is untouched - multi-repo tasks are dispatch-only, and free-agent assignment already can't reach them after step 4.
10. **UI** (`src/web/components/DispatchModal.tsx`, `src/web/lib/task-draft.ts`, `src/web/lib/lastRepo.ts`, `src/web/components/layouts/BacklogColumn.tsx`): repo chips + `RepoCombobox` adder following the Dependencies pattern; first chip marked primary; adder hidden when the selected harness lacks `multiRepoDispatch` (read capability via the browser-safe record). Draft field `extraRepoRoots: string[]`; `draftsEqual`, `taskUpdatePatch`, `draftFromTask`, empty/fresh helpers updated. `lastRepo` remembers the full list. `canAcceptTask` returns false for multi-repo tasks. Backlog card shows a small repo-count chip.
11. **README**: dispatch section documents multi-repo attach, which harnesses support it, and the one-PR-per-repo expectation.

## 6. Data and compatibility

- A single-repo task has zero `task_repos` rows; `extraRepos` serializes as `[]`. Old databases open unchanged; the upgrade test seeds a pre-feature database and asserts both open and task load.
- `repo_root` scalar semantics are untouched everywhere. No persisted IDs are added or renamed.
- `isAnnotationOnlyUpdate` needs no change: the new key makes any repo-set patch non-annotation by construction. Add a test pinning that.

## 7. Tests and verification

- Unit (`test/`): migration upgrade from pre-feature DB; create/update validation (dedupe, primary-collision, resolve refusal); **two non-pool repos on one task provision to distinct paths and both succeed** (this is the case that fails outright before the slot change, so write it first and watch it fail); slot 0 still resolves to exactly `join(WORKTREES_DIR, taskId)` so single-repo paths are unchanged; provisioning rollback on mid-loop failure (inject a failing provider) **including the mixed-provider orderings - pool primary with git secondary and git primary with pool secondary - asserting the lease is returned and the git tree removed**; pins include extras (extend the reap-planning test); assignment refusal; manifest content; capability record completeness (compiler does most of it); `base_sha` recorded as a full 40-char oid for the primary on `tasks` and for every secondary on its row, on both single-repo and multi-repo dispatch, since phases 2 and 3 are unsound if the primary baseline is missing.
- e2e (`e2e/`): add a second `seedRepo` to the daemon fixture; new spec: open dispatch, add two repos via the chips UI, dispatch, assert the session card appears and both worktrees exist under the state dir; assert the fake agent's recorded launch got both directories. Update the shared `dispatch()` helper only if the chips change its selector dance; keep other specs passing.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- All of section 7 green in CI.
- A multi-repo dispatch on a real machine (or the e2e fake-agent equivalent) produces N worktrees, a live session at the primary, and teardown/complete cleans all of them.
- Single-repo dispatch behavior byte-identical (existing specs prove it).
- README updated in the same PR.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- `task_repos` columns and primary key as written above; `base_sha` is a full oid recorded at cut time, on `tasks.base_sha` for the primary and on the `task_repos` row for each secondary. Later phases must read the primary's baseline from `tasks.base_sha` and must not assume the primary has a `task_repos` row.
- `TaskRepoEntry` field names including the reserved `prUrl`/`prState`/`mergedAt` (null in this phase).
- `Task.extraRepos` riding `task_upsert`; order is `position`.
- The git-fallback worktree path scheme: slot 0 is `join(WORKTREES_DIR, taskId)` and slot n is `join(WORKTREES_DIR, taskId + "-" + n)`, where the slot is the entry's `position`. Teardown and startup reconciliation read the recorded `worktree_path` rather than recomputing it, so nothing may renumber an entry's `position` after provisioning without moving its tree.
- The session's cwd is always the primary worktree; secondary worktree paths come only from `task_repos`.
- Multi-repo tasks are dispatch-only; no code may assume a multi-repo task reached a session via `assign`.
- The capability flag name `multiRepoDispatch`.

## 10. Cross-phase audit record

- 2026-08-05 (scoping): allowlist AND rule moved here from phase 4 - a consent gate ships with the capability that needs it.
- 2026-08-05 (scoping): `TaskRepoEntry` PR fields declared in this phase (null) so phase 2 does not change the wire shape.
- 2026-08-10 (citation re-verification): all section 4 citations re-verified against `main`. No premise broke - every cited symbol still exists under the same name with the same described behavior, and `task_repos`/`extraRepoRoots`/`extraRepos` are still unused in `src/`, `test/`, and `e2e/`. `provisionWorktree` still takes the `pins` callback with its "no empty default" warning, `teardownWorktree` still returns leases unforced and still deletes only `harness/`-prefixed branches, and `verifyPinnedBase` still demands a 40-char oid.
- 2026-08-10 (citation re-verification): the Claude Agent SDK unknown is **closed in the plan's favor** - `additionalDirectories` exists at the pinned SDK version, so step 8 needs no fallback. The Codex writable-roots key remains the one genuine unknown, and the capability still ships as `null` for Codex if it cannot be measured.
- 2026-08-10 (citation re-verification): three original citations pointed at unrelated code rather than merely drifting - `routes.ts:3131-3138` (the "existing repo-move resolution pattern") pointed at the `/api/inspector/prs` route, `pool.ts:208/223` pointed at JSDoc lines, and `db.ts:1929` pointed at a blank line. Locate constructs by symbol name, not by trusting a number.
- 2026-08-10 (citation re-verification): `seedRepo` is now exported from `e2e/fixtures/daemon.ts:121` (it was module-private at scoping time), which makes step 7's second-repo fixture work easier than planned.
- 2026-08-10 (review): the git-fallback worktree destination is now per repo. The loop as first written reused `join(WORKTREES_DIR, taskId)` for every repo, so a task with two non-pool repositories provisioned the primary and then failed on the secondary against an existing directory. The slot discriminator defaults to 0, which is the legacy path, so single-repo dispatch is byte-identical. The suffix is keyed on `position` rather than the repo basename because two attached repos can share a basename. The pool arm is untouched: those paths come from each repo's own pool and are already distinct.
- 2026-08-10 (review): added the primary baseline (`tasks.base_sha`) to this phase. As originally written, `base_sha` was recorded for secondaries only, and since the primary has no `task_repos` row the changed-set rule could never see primary changes. Two downstream consequences, both unsound: phase 2's quorum could complete a task on a merged secondary PR while changed primary work sat unmerged, and phase 3 would never create a workflow run for the primary, so primary changes would ship unreviewed. Recording the primary's baseline on `tasks` fixes both without giving the primary a `task_repos` row, which would have broken the zero-rows-for-single-repo invariant.
