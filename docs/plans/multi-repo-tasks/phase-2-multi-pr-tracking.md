# Phase 2: Multi-PR tracking and completion

Source plan: [plan.md](plan.md) - Index: [phased-plan.md](phased-plan.md)

## 1. Outcome

A multi-repo task's pull requests are all discovered, tracked, and shown - one per changed repo - and the task auto-completes only when every changed repo's PR has merged (the adopted all-merged quorum). Cards and the report show per-repo PR state instead of collapsing to one link.

## 2. Entry criteria and dependencies

- Direct prerequisite: **Phase 1** merged (`task_repos`, `base_sha`, `Task.extraRepos` with reserved PR fields, secondary worktrees provisioned and pinned).
- Phase 3 depends on this phase: per-repo workflow runs prove their PRs against the adoption ledger, and secondary-repo PRs are only reliably adopted once this phase's multi-URL sniffing and poller fan-out exist. Do not weaken those two behaviors.

## 3. Scope and non-goals

In scope:

- Multi-URL PR sniffing in hooks and drivers.
- Branch-poller targets for secondary worktrees.
- `work_episode_prs` table: per-repo episode PR acceptance, merge marking.
- All-merged completion quorum in the task reconciler.
- Per-repo PR state projected onto `Task.extraRepos` (filling the fields phase 1 reserved).
- UI: per-repo PR list on `SessionCard`/`ConsoleDetail` task area, report panel repo lines, e2e.

Non-goals:

- Workflow bindings/runs/gates (phase 3).
- Review follow-up marks and skills prose (phase 4).
- Any change to auto-merge: each PR keeps today's independent per-PR verdict (adopted decision 4).
- `Session.prUrl` semantics: it stays the scalar "current branch's PR" and the session PR chip is unchanged.

## 4. Repository findings this phase builds on

Verified against the repo at scoping time (2026-08-05), citations re-verified against `main` (2026-08-10):

- Sniffing: `src/shared/pr-command.mjs` - `pullRequestUrlIn` returns the FIRST match only (`:51-53`); `PR_URL_RE` at 48. Hook carriers: `hooks/harness-hook.mjs:31-59` (scalar `prUrl`, `prCreated`), `hooks/codex-hook.mjs:23`. SDK drivers: `src/server/harness/claude/sdk.ts:747-778`, `src/server/harness/codex/sdk.ts:1097-1120`.
- Session PR scalars: `src/shared/types.ts:528-542,600`; writers `registry.applyHook` (~1778), `applyDriverPrCreated` (~1718), `reconcilePrs` (~3212) - all overwrite.
- Episodes: `session_work_episodes` (PK `session_id`) and `task_work_episode_bindings` (PK `task_id`, unique per session) at `src/server/db.ts:183-235`, scalar `branch`/`pr_url`/`pr_head_sha`/`merged_at`. `acceptPrForEpisode` refuses a second PR (`registry.ts:3059`); the SQL guard is `WHERE ... (pr_url IS NULL OR pr_url = ?)` (`db.ts:3413-3436`). `historical_task_work_episode_bindings` is the only existing many-PRs-per-task shape, reachable only sequentially via rollover.
- Adoption ledger: `inspector_prs` keyed `owner/repo#number` with `repo_root`/`cwd`/`observed_*` (`db.ts:989-1024`) - already multi-PR. `announcePrOpened` (`registry.ts:1757-1774`) deliberately allows a session's second PR.
- Branch poller: `src/server/pr.ts` - one `gh pr list --head <branch>` per distinct cwd (`:263-272`); targets from `registry.prPollTargets` (~3112: one cwd+branch per session). URL poller `queryPrUrl` (`:150-165`) needs no cwd; URL harvesters `dependencyPrPollTargets`/`taskPrPollTargets` (~3284-3357) are already flat URL sets.
- Completion: `completableByMerge` (`registry.ts:5896`), `reconcilePrMerges` -> `markWorkEpisodeMerged` (`registry.ts:2707`, SQL `db.ts:3483-3531`), `TaskManager.reconcileMergedTasks` (`tasks.ts:581-607`) - one merged PR (`mergedPrFor`, newest `mergedAt`) completes the task. `outcome`/`outcomeUrl` scalars (`types.ts:1626-1627`).
- UI: single outcome link on `SessionCard.tsx:377-411` and `ConsoleDetail.tsx:412-439`; `prChipView` (`session-bits.tsx:1139`) is the one seam for the session chip (unchanged here); `LabelChips` (`session-bits.tsx:1676`) is the chips-with-overflow primitive; report repo line `ReportPanel.tsx:109-117`.
- Name `work_episode_prs` unused (verified by grep).

## 5. Implementation steps

1. **Sniffing** (`src/shared/pr-command.mjs`, both hooks, both SDK drivers, ingest schema): add `pullRequestUrlsIn(text): string[]` returning all matches; keep `pullRequestUrlIn` delegating to its first element (existing callers unbroken). Hook ingest and driver events carry the list; every URL flows to `announcePrOpened` and adoption.
2. **Schema** (`src/server/db.ts`): `work_episode_prs (episode_id TEXT NOT NULL, repo_root TEXT NOT NULL, pr_url TEXT NOT NULL, pr_head_sha TEXT, merged_at INTEGER, PRIMARY KEY (episode_id, repo_root))` in the fresh block and `migrate()`; upgrade test. Existing scalar episode columns remain the primary repo's entry (write-through both during this phase; the scalar is authoritative for the primary, the table for extras - one owner per repo, no dual truth).
3. **Acceptance** (`src/server/registry.ts`): `acceptPrForEpisode` routes by repo - resolve the PR's repo via the adoption row's `repo_root` (walked to the owning root the same way task roots are), match it to the task's repo set, and apply the existing refusal guard per `(episode, repo)`: a repo that already holds a different PR still refuses a replacement. A PR whose repo is not in the task's set keeps today's behavior for the primary and is otherwise ignored (the ledger still tracks it; it just isn't this task's deliverable).
4. **Poll targets** (`src/server/registry.ts`, `src/server/pr.ts`): for each session bound to a multi-repo task, `prPollTargets` adds one `(extra worktree cwd, extra branch)` pair per entry - still one `gh` call per distinct cwd. Found PRs route through the same acceptance as step 3. Skip default-branch entries as today.
5. **Merge reconciliation** (`src/server/registry.ts`, `src/server/db.ts`): `markWorkEpisodeMerged` stamps the matching `(episode, repo)` row (or the scalar for the primary); `task_pr_merged` fires per PR unchanged.
6. **Completion quorum** (`src/server/tasks.ts`): for a multi-repo task, `reconcileMergedTasks` completes only when every repo in the changed set has a merged PR. Changed set = repos with an episode PR, union repos whose worktree head differs from `base_sha` (heads read at reconcile time from the still-pinned worktrees; a torn-down worktree with no episode PR counts as unchanged). Closed-unmerged does not satisfy. `outcome` lists every merged PR; `outcomeUrl` stays the primary's PR. Single-repo tasks keep today's exact behavior.
7. **Projection** (`src/server/registry.ts`): when emitting a task, fill `extraRepos[].prUrl/prState/mergedAt` from episode rows plus ledger observations. This is the one place the reserved phase 1 fields become live.
8. **UI** (`src/web/components/SessionCard.tsx`, `src/web/components/layouts/ConsoleDetail.tsx`, `src/web/components/ReportPanel.tsx`): the task area renders one PR line per repo (repo short name, PR state chip, link), using the existing chip primitives; single-repo tasks render exactly today's markup. Report lines list the repo set.
9. **README**: completion semantics documented ("a multi-repo task completes when every changed repo's PR merges").

## 6. Data and compatibility

- No persisted IDs added or renamed. `work_episode_prs` is additive; pre-feature databases open unchanged.
- The scalar episode columns' meaning ("the primary repo's PR") is a narrowing, not a change, for every existing single-repo row.
- `task_pr_merged` event shape unchanged.

## 7. Tests and verification

- Unit: multi-URL sniffing (one command opening two PRs yields both); per-repo acceptance and per-repo refusal of a replacement; poll-target fan-out; quorum - completes on all-merged, holds on one-open, holds on closed-unmerged, exempts unchanged repos, upgrades `failed`/`cancelled` per `completableByMerge`; single-repo regression (existing tests such as `test/task-durable-merge.test.ts`, `test/task-completion-reconciler.test.ts` updated deliberately, not deleted); projection rendering via `renderToStaticMarkup` for the per-repo PR list.
- e2e: fake-agent flow where the agent "opens" PRs in both seeded repos (seed `inspector_prs` rows as `ship-log.spec.ts` already does); the card shows both PR chips; marking both merged completes the task, marking one leaves it running.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- Section 7 green in CI; single-repo behavior proven unchanged by existing specs.
- A two-repo task on the e2e daemon shows two PR lines and completes only on the second merge.
- README updated in the same PR.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- `work_episode_prs` columns and primary key; the per-`(episode, repo)` refusal guard.
- The changed-set rule (episode PR present, or head differs from `base_sha`) - phase 3 reuses the same rule for run creation; the shared predicate lives in `src/shared` and both consumers import it.
- `Task.extraRepos` PR fields are populated from this phase on.
- `Session.prUrl` remains the scalar current-branch PR; nothing downstream may repurpose it as "the task's PR".

## 10. Cross-phase audit record

- 2026-08-05 (scoping): the changed-set predicate is declared shared with phase 3 and placed in `src/shared` so run creation and completion cannot drift.
- 2026-08-05 (scoping): scalar episode columns retained as the primary repo's entry rather than migrated, keeping phase 1's "primary stays on existing columns" data shape consistent across tables.
- 2026-08-05 (scoping): concurrency claim with phase 3 withdrawn - phase 3's `pull_request` proofs need this phase's adoption reliability, so the graph is serial through this phase.
- 2026-08-10 (citation re-verification): all section 4 citations re-verified against `main`. All four load-bearing premises hold: `pullRequestUrlIn` still returns only the first url (non-global `PR_URL_RE.exec(text)?.[0]`), `inspector_prs` is still keyed `owner/repo#number` with a per-row `repo_root`, task completion is still "newest merged PR wins" via `mergedPrFor`, and the per-episode single-PR refusal still exists in both the registry check and the `AND (pr_url IS NULL OR pr_url = ?)` SQL guard. `work_episode_prs` is still an unused name. Every step below is therefore still the change it claims to be.
- 2026-08-10 (citation re-verification): per-file offsets ranged from 0 to +480 lines, so no uniform drift correction is valid here. Several citations were also wrong when first written rather than drifted - `session-bits.tsx`, `ConsoleDetail.tsx`, `codex/sdk.ts`, and `pr-command.mjs` are each byte-identical to the scoping-time tree yet all had incorrect line numbers, one by roughly 95 lines. Treat any citation not re-verified above as suspect and locate constructs by symbol name.
