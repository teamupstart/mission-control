# Phase 1 - Durable Identity and Safe Git-Ref Evidence

## Outcome and value

Mission Control shows one truthful path and branch for the active Engineer attempt. When the provider worktree is gone, Diff and Files remain useful through a pinned, read-only Git commit instead of returning a raw repository error. Every mutating or host-opening action stays disabled unless the exact live worktree is revalidated.

This phase delivers value with the current ai-conductor release. It does not require explicit retirement events.

## Entry criteria and dependencies

- The planning artifacts in `docs/plans/pipeline-attempt-recovery/` are merged to the default branch.
- No implementation phase is a prerequisite.
- Repository scope: Mission Control only.

## Scope

- Preserve provider-emitted authoring branch and plan slug in the commission projection.
- Add attempt origin, durable evidence commit, and evidence provenance with safe migration defaults.
- Introduce the browser-safe workspace view and one server-side resolver/capability policy.
- Validate live paths at request time.
- Add exact commit-backed Diff and read-only Files access after worktree loss.
- Correct branch labels, Diff error labels, and manual workflow evidence checkout selection.
- Move the Pipeline caller credential out of Codex process arguments.
- Add focused unit, route, migration, UI, and Playwright coverage.

## Non-goals

- Do not add provider lifecycle events, readiness, retention, or ownership behavior. Phase 2 owns those.
- Do not classify terminal failures or add recovery actions. Phases 3 and 4 own those.
- Do not infer successful handoff from a branch or pull request.
- Do not create a second workspace registry or store Git tree contents in SQLite.
- Do not enable edits, comments, external open, or shell launch against a Git-ref view.

## Repository findings and inherited contracts

- `engineer_worktree_created` already contains `worktreePath`, `branch`, and `planSlug` in `src/shared/pipeline.ts`; `reduceKnownEvent` in `src/server/pipelines/commissions.ts` retains only the path.
- Commission bounded projection lives in `pipeline_commissions.state_json`. Attempts are also normalized in `pipeline_commission_attempts`; attempt origin therefore belongs in that table, with a migration beside its upgrade path.
- `sessionWorkspaceRoot` in `src/shared/session.ts` falls back to `cwd`. That behavior is acceptable for ordinary sessions but unsafe once a Pipeline session has provider workspace authority.
- Diff and Files routes already converge on `sessionWorkspaceRoot`, which makes a central replacement feasible.
- `src/server/diff.ts` already separates commit and working-tree diff contracts. A ref request needs a distinct function so it cannot fall through to a working-tree diff.
- Workflow evidence chooses its checkout in `src/server/workflows/context.ts` and currently may use `session.cwd`.
- Codex MCP registration serializes descriptor environment values into launch arguments in `src/server/mission-mcp.ts`.
- `Session.cwd` remains process identity and must not be rewritten.

## Implementation steps

### 1. Extend shared commission and session contracts

In `src/shared/pipeline.ts`:

- Add `PipelineAttemptOrigin = "mission_control" | "provider_reconciled"`, `origin`, `evidenceCommit`, and bounded `evidenceCommitProvenance` to `PipelineCommissionAttempt`.
- Add nullable `authoringBranch` and `planSlug` to `PipelineCommission`.
- Add `PipelineWorkspaceAvailability`, bounded reason codes, capabilities, and `PipelineWorkspaceView` with authority, kind, availability, reported path, branch, pinned commit, plan slug, attempt, provider revision, and reason.
- Keep the view browser-safe and free of `node:` dependencies.

In `src/shared/types.ts` and the corresponding protocol schemas:

- Add an optional structured workspace view to `Session` for rolling compatibility.
- Retain `workspaceRoot` during migration, but derive it only from an available view for managed Pipeline sessions.
- Add explicit workspace capabilities rather than asking React to infer permissions from availability strings.

Use append-only enum additions. Bound all identity, path, and reason strings through existing limits or new shared limits.

### 2. Persist identity and attempt origin compatibly

In `src/server/pipelines/commissions.ts`:

- Retain branch and plan slug from `engineer_worktree_created`.
- Keep them consistent with the later handoff event and reject or surface identity conflict rather than overwriting silently.
- Set new reserved attempts to `origin: "mission_control"`.

In `src/server/db.ts`:

- Add `origin`, `evidence_commit`, and `evidence_commit_provenance` columns to `pipeline_commission_attempts` beside the existing migration using `addColumn`.
- Backfill or decode missing or null origin as `mission_control`; missing evidence commit and provenance remain null.
- Treat an unknown non-null origin or provenance as an unsupported attempt projection with a bounded named reason. Degrade the owning commission to its existing `unsupported` lifecycle rather than coercing the value to `mission_control` or dropping the attempt.
- Update attempt inserts, selects, upserts, validation, and degraded-row reconstruction.
- Allow absent nullable commission fields in old `state_json`, then normalize them in memory. Do not let an old row degrade to unsupported solely because it lacks the new fields.
- Add an index only if a measured query requires one. Origin and evidence commit are not lookup keys in this phase.

### 3. Build one daemon-owned workspace resolver

Create a focused module under `src/server/pipelines/` that accepts the session, task, commission, linked run, and repository root and returns `PipelineWorkspaceView` plus the validated live root when available.

Resolution order:

1. available linked implementation worktree;
2. active commission authoring worktree;
3. explicit pending provider workspace;
4. missing provider worktree with a resolvable authoring branch;
5. missing or pending with no valid branch.

Rules:

- Use provider attempt and revision from the commission, never SDK host branch state.
- Treat a reported path as `available` only after resolving symlinks and proving it is the expected registered Git worktree for the task repository and branch.
- Require `.pipeline/engineer-run.json`, when the provider contract says it should exist, to match the active engineer run ID, repository, plan slug, and branch. A reused path, stale marker, mismatched registration, regressed provider revision, or HEAD outside the recorded attempt lineage cannot authorize writes, shell, or external open.
- Add the marker shape to the existing provider state reader as corroborating identity without making discovery authoritative over the commission.
- While the authoring worktree is live, validate its branch and HEAD and durably advance the attempt's last validated evidence commit only when the new commit belongs to the same attempt and is a descendant of the prior validated commit.
- Freeze the evidence commit at handoff. If a legacy attempt disappeared before any commit was captured, resolve its known branch once within the task repository, persist the resulting SHA with `legacy_branch_resolution` provenance, and never re-resolve it for later requests.
- Reject ambiguous revision syntax, non-commit objects, history rewrites, or identity conflicts. Those create explicit drift or unavailable-evidence state.
- Never return `session.cwd` as the Pipeline workspace fallback.
- Revalidate before every operation that writes, opens a shell, or exposes a host path externally.

Update `Registry.workspaceRootFor` and session projection to delegate managed Pipeline sessions to this resolver while preserving existing behavior for other sessions.

### 4. Add ref-backed Diff and Files adapters

In `src/server/diff.ts`:

- Add a ref-scoped diff sibling to `computeSessionDiff` and `computeCommitDiff`.
- Load the stored attempt evidence commit, resolve the source to its own SHA, compute their merge base, and diff only those pinned endpoints.
- Return both resolved endpoint identities through the existing `baseSha` and `headSha` response contract, plus an exact human label such as `spec/name vs main`.
- Fail closed for missing, ambiguous, unrelated, unborn, or garbage-collected objects. Never re-resolve the branch or substitute uncommitted changes.

In a focused Git tree module used by `src/server/session-files.ts` or beside it:

- List tree entries from the pinned commit.
- Read blobs by repository-relative path with size and binary guards matching live Files behavior.
- Preserve path traversal protections.
- Return explicit read-only capability metadata.
- Do not materialize a temporary checkout and do not add write support.

Update Diff and Files routes in `src/server/routes.ts` to authorize through the resolver:

- available: current live behavior against the revalidated path;
- retired or missing with pinned commit: ref diff and read-only list/read;
- pending, invalid, or missing ref: stable named response for the UI;
- write, comment, external open, and shell actions: reject unless available.

### 5. Align all current workspace consumers

- Board and Console labels read branch and path from the structured view.
- `DiffViewer` uses the server-provided scope and prints no `uncommitted changes` label when scope is unresolved.
- Files renders a clear read-only banner and disables or removes actions that cannot work.
- standards discovery follows the same live or pinned evidence source where it is read-only; any standard mutation remains live-worktree-only.
- `workflowCheckoutPath` and evidence capture use the resolved live workspace. If only a Git ref exists and workflow capture cannot consume immutable ref evidence, withhold manual workflow binding with a named reason.
- Shell launch and external file open use the validated live root only.

Do not add browser-side filesystem or Git checks.

### 6. Move the caller credential to a restricted file

Replace Codex inline environment serialization for `MISSION_PIPELINE_CALLER_CREDENTIAL` with a launch-scoped credential file or descriptor file under a restricted Mission Control directory:

- mode `0600`;
- unpredictable launch-specific name;
- passed as a path, not a secret value, in arguments;
- removed on failed launch and normal session eviction;
- bounded expiry independent of file mode, plus daemon-start reconciliation that removes expired or unowned launch files left by `SIGKILL`, host restart, or a crashed prior daemon;
- no secret in logs, errors, snapshots, or test output.

Reuse existing secure descriptor and cleanup patterns where possible. Keep the loopback bearer and caller validation semantics unchanged.

## Data, API, migration, and compatibility

- Database migration: additive nullable/defaulted `origin`, `evidence_commit`, and `evidence_commit_provenance` columns on `pipeline_commission_attempts`.
- Commission `state_json`: additive optional fields with normalization of old rows.
- Session wire contract: additive optional workspace view; mixed browser/server versions retain current `workspaceRoot` fallback for non-Pipeline sessions.
- Diff and Files responses: additive discriminated scope/capability metadata. Preserve existing live response shapes where feasible to avoid broad client churn.
- Unknown provider retirement remains represented as filesystem-observed `missing`, never falsely as provider-confirmed `retired`.
- A moving branch cannot change an existing fallback view. Every response uses the attempt's stored commit, and an unavailable object produces an explicit state.

## Tests and verification

Add or extend focused tests:

- `test/pipeline-commission.test.ts`: retain branch and plan slug, reject conflict, default and persist attempt origin, advance a live descendant commit, freeze at handoff, and reject a rewrite.
- `test/pipeline-migration.test.ts` and DB tests: old rows, new attempt columns, malformed origin or provenance, null legacy evidence, and degraded projection safety.
- registry and projection tests: Pipeline sessions never fall back to host `cwd`; ordinary sessions still do.
- `test/diff.test.ts`: merge-base commit diff, returned `baseSha` and `headSha`, persisted head despite a moved branch, source ref movement between requests, missing and ambiguous source, unrelated history, unborn branch, garbage-collected commit, and no working-tree fallback.
- `test/session-files.test.ts`: Git tree list/read, binary and size handling, traversal rejection, and strict read-only behavior.
- route tests: live, missing with commit, missing without commit, stale HEAD, reused path, mismatched marker or registration, symlink escape, and every disabled mutation.
- `test/workflow-per-repo-runs.test.ts`: Pipeline evidence uses the commissioned workspace or is withheld.
- `test/conductor-engineer-provider.test.ts` or provider-state tests: Engineer marker discovery is corroboration only.
- `test/conductor-plugin.test.ts` and MCP launch tests: caller credential absent from argv, file permissions, normal cleanup, expired and unowned startup cleanup after abnormal termination, bounded expiry, and no secret in failure output.

Add Playwright coverage in `e2e/` against built assets and fake agents:

- active Engineer worktree shows matching path and branch and supports live Diff and Files;
- removed worktree shows the pinned branch diff and read-only Files;
- invalid or missing ref shows a named empty state;
- mutation, comment, external open, shell, and manual workflow actions are unavailable in ref mode;
- Diff error header makes no false scope claim.

Run from the repository root:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-commission.test.ts test/pipeline-migration.test.ts test/diff.test.ts test/session-files.test.ts test/workflow-per-repo-runs.test.ts test/conductor-engineer-provider.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

If Electron geometry changes, also run `npm run test:electron` through the repository-approved macOS sandbox path.

## Merge and exit criteria

- All scoped checks pass and the Playwright spec covers the visible behavior.
- A current provider event preserves path, branch, plan slug, and the last validated attempt commit through restart and SSE projection.
- The same Pipeline session cannot display a provider path with the host checkout branch.
- Removed worktrees produce read-only Diff and Files from the stored attempt commit, not a re-resolved branch or raw Git error.
- Every mutation and host-opening route fails closed without an available revalidated worktree.
- Existing non-Pipeline sessions retain their current workspace behavior.
- Caller credentials are absent from process arguments and cleaned up with the launch/session lifecycle.
- Documentation in the source plan remains accurate if implementation names differ.

## Downstream handoff

Phase 3 may rely on the workspace view, capability matrix, authoring branch and plan slug, attempt origin storage, ref adapters, and resolver as stable contracts. It may add explicit provider retirement and failure reasons but must not bypass the resolver or weaken read-only authorization.

Phase 4 may write `provider_reconciled` origin and use the resolver during recovery, but it must not change the meaning of existing origins or authorize writes from Git-ref evidence.

## Cross-phase audit record

- Initial audit: Phase 1 owns workspace identity and authorization. Phase 2 can merge before or after it because it changes only ai-conductor and emits additive evidence.
- Compatibility correction: attempt origin and immutable evidence commit require normalized table migrations, not only `state_json` fields, because attempts are reloaded from `pipeline_commission_attempts`.
- Compatibility correction: current Mission Control can store unknown provider event kinds, so Phase 1 does not need placeholder event parsing for Phase 2.
- Later phases must preserve `missing` as filesystem-observed and reserve `retired` for explicit provider evidence.
- Final audit: Phase 4 writes `provider_reconciled` only through the origin column and decoder established here; no later phase introduces a competing attempt identity store.
- Inspector correction: commit identity is durable on the attempt and frozen at handoff or retirement; later ref-backed requests never follow a moved branch.
- CodeRabbit audit: unknown non-null attempt origins degrade explicitly; available-path authorization rejects stale or reused identities; ref diffs return both endpoint SHAs; credential files have startup reconciliation and bounded expiry.
