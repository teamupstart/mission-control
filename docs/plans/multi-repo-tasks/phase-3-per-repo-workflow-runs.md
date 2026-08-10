# Phase 3: Per-repo workflow runs

Source plan: [plan.md](plan.md) - Index: [phased-plan.md](phased-plan.md)

## 1. Outcome

A multi-repo task's session runs one full review workflow (for example no-mistakes-review) per repo that has changes, concurrently, with unchanged repos skipped. Each run pins that repo's PR, reviews that repo's evidence, spends its own repair budget, and gates that repo's merge - the workflow subsystem's single-repo contracts stay closed per run. The operator sees one workflow chip per run on the session's surfaces.

## 2. Entry criteria and dependencies

- Direct prerequisite: **Phase 2** merged (secondary-repo PRs reliably adopted via multi-URL sniffing and poller fan-out; the shared changed-set predicate exists in `src/shared`). Phase 1 arrives transitively.

## 3. Scope and non-goals

In scope:

- Repository dimension on workflow bindings; per-`(note_key, repo)` active uniqueness.
- Lazy run creation: one run per changed repo at trigger time; unchanged repos never get a run.
- Per-repo evidence capture and context snapshots against the run's repo worktree.
- Submission routing: an evidence submission names its run/repo.
- Cross-run delivery serialization: at most one outstanding delivery per session.
- UI: workflow chip fan-out (one per run), run surfaces labeled with their repo.
- e2e and README.

Non-goals:

- Any change to the `pull_request` adapter's proof rules, evidence identity `(round, segment)`, gate wait/block vocabulary semantics, or the Inspector poller. Single-repo runs behave byte-identically.
- Coordinated merges (decision 4: independent).
- Review follow-up marks and skills prose (phase 4).

## 4. Repository findings this phase builds on

- Bindings: `workflow_bindings` with scalar `session_cwd`/`session_repo_root` and `CREATE UNIQUE INDEX idx_workflow_bindings_active_note ON workflow_bindings(note_key) WHERE state='active'` (`src/server/db.ts:460-477`; index at 476, verified). One active binding per session note is the invariant to widen, not delete.
- Runs: `workflow_runs.inspector_pr_key` / `inspector_head_sha` scalars (`db.ts:490-491`); `workflow_submissions.pr_head_sha` (`db.ts:537`). Gate state `WorkflowInspectorGateState` (`src/shared/workflow.ts:1263-1274`) is one PR per gate; the pin-switch refusal is `src/server/workflows/manager.ts:2611-2623` (`inspector_pr_switch_refused`); candidate resolution reads the scalar `session.prUrl` (`manager.ts:2603-2609`, `:1622-1624`).
- The `pull_request` session action: adapter at `src/server/workflows/session-action-adapters.ts:293-403`; repository facts are supplied by the manager on `SessionActionAdapterContext` (`:23-60`); repo identity via `readWorkflowRepositoryHead`/`readWorkflowRepositoryId` (`src/server/workflows/context.ts:584-656`, `--git-common-dir`). `adoptedPullRequestsForAction` (`manager.ts:3902-3934`) already resolves a repository identity per distinct `pr.repoRoot` - the one existing multi-repo-aware reader.
- Evidence and contracts: `docs/agent-guides/change-contracts.md` sections "Workflow evidence identity", "Session actions", "The pull_request adapter", and "What the browser may and may not decide about one" are binding. Wait reasons and block codes are append-only `Record` keys in `src/web/workflows/run-model.ts` - each new one requires a human sentence and fails typecheck until added. Two actions ready at once within a run are refused, never serialized; that contract is per run and stays.
- Merge veto: `blocksMerge(prKey)` (`manager.ts:1694-1716`) holds YOLO merge while a run's gate pins that key.
- UI: `WorkflowChip`/`workflowRunTone`/`workflowRunLabel` (`src/web/components/session-bits.tsx:142-198`); run surfaces under `src/web/workflows/` (`run-model.ts` is the vocabulary owner). `useEventStream.ts` handles `workflow_run_upsert`/`_remove` (`:272-282`).
- The changed-set predicate is shared with phase 2's completion quorum and lives in `src/shared` (phase 2 handoff).

## 5. Implementation steps

1. **Bindings** (`src/server/db.ts`, `src/server/workflows/`): add a nullable `repo_root` column to `workflow_bindings` (null = the session's primary/only repo, which keeps every existing row valid). Replace the active-uniqueness index with `UNIQUE(note_key, repo_root)` semantics; since the columns feed an `ON CONFLICT`-adjacent uniqueness and SQLite treats nulls as distinct in unique indexes, use the existing contract's answer: store the primary explicitly (the resolved repo root string) rather than null in new writes, backfill existing active rows in `migrate()`, and keep the partial index on `(note_key, repo_root) WHERE state='active'`. Upgrade test with a pre-feature database holding an active binding.
2. **Run creation** (`src/server/workflows/manager.ts`): at trigger time, evaluate the shared changed-set predicate over the primary and every secondary (head vs `base_sha`, read from the pinned worktrees; the primary's baseline comes from `tasks.base_sha`, not from a `task_repos` row, which the primary does not have); create one run per changed repo, each bound to its repo entry; a single-repo session creates exactly one run through the unchanged path. The primary must be evaluated here or a changed primary gets no run and its changes ship unreviewed. Unchanged repos are skipped silently and never surface a run.
3. **Per-repo scoping** (`manager.ts`, `context.ts`): a run's context snapshots, evidence capture, and repository facts execute against its repo's worktree; `readWorkflowRepositoryId` of that worktree is the identity every proof compares. Candidate PR resolution stops reading `session.prUrl` for repo-scoped runs and instead filters adopted PRs by the run's repository identity through `adoptedPullRequestsForAction`'s existing per-root resolution. The adapter itself is untouched.
4. **Submissions** (`src/shared/protocol.ts`, `src/mcp/server.ts`, `manager.ts`): the submit surface gains an optional repo discriminator (both validation layers, per the MCP double-validation contract). When absent and exactly one run is active, route to it (today's behavior); when absent and several are active, route by which repo's head moved since that run's capture; ambiguous submissions are refused with a message naming the runs, never guessed.
5. **Delivery serialization** (`manager.ts` and the delivery manager): at most one run's delivery (repair packet or session action) outstanding per session; other runs hold in an explicit queued wait state with an append-only wait reason (name it at implementation time; add its `Record` sentence in `run-model.ts`). Within a run, the existing two-actions-refuse contract is unchanged. Recovery on daemon restart re-derives the queue from persisted attempt states - no delivery is re-prepared that was refused, per the existing recovery contract.
6. **Merge veto** (`manager.ts`): `blocksMerge` answers over every active run's pinned key (membership across runs), so repo B's PR cannot YOLO-merge while repo B's run is unfinished. Runs never veto sibling repos' PRs (decision 4).
7. **UI** (`session-bits.tsx`, `src/web/workflows/`, `useEventStream.ts`): `WorkflowChip` fans out to one chip per run, labeled with the repo's short name when the session has more than one run; run detail surfaces show the run's repository; the run list groups a session's runs. No new event types expected (runs already upsert individually); if one proves necessary, `useEventStream.ts` exhaustiveness enforces the handling.
8. **README** and `docs/agent-guides/change-contracts.md`: document per-repo runs - binding uniqueness, run scoping, serialization - in the workflow sections that currently state one run per session.

## 6. Data and compatibility

- `workflow_bindings.repo_root` backfill keeps every existing binding and run valid; a pre-feature run replays identically.
- No persisted vocabulary values are renamed. New wait reasons/block codes are appended with sentences per the change contract.
- `workflow_runs.inspector_pr_key`/`inspector_head_sha` stay scalar per run - correct by construction now that a run is per repo. `workflow_submissions.pr_head_sha` likewise.

## 7. Tests and verification

- Unit: binding uniqueness per `(note_key, repo)` incl. upgrade/backfill; run creation skips unchanged repos and creates one run per changed repo, **including a run for the primary when only the primary changed** (a predicate that iterates `task_repos` rows alone would create none); per-repo evidence capture (facts come from the run's worktree); submission routing (explicit, single-active implicit, head-moved inference, ambiguous refusal); serialization (second run's delivery queues, dequeues on completion, survives restart); `blocksMerge` membership; single-repo regression across the existing workflow suites (`test/workflow-inspector-gate.test.ts` and siblings updated deliberately).
- e2e: two-repo task with the fake agent; both runs appear with repo-labeled chips; seeded observations pass one run while the other waits; the passed repo's PR merge-veto lifts while the waiting repo's holds.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- Section 7 green in CI; single-repo workflow behavior proven unchanged.
- A two-repo e2e task shows two independent runs with independent repair budgets and serialized deliveries.
- README and change-contracts updated in the same PR.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- One workflow run = one repository; the adapter and evidence contracts remain single-repo per run.
- The binding uniqueness key `(note_key, repo_root)` with the primary stored explicitly.
- The session-level delivery queue: one outstanding delivery per session, explicit wait state for the rest.
- Submission routing rules exactly as step 4 states them; ambiguity is refused, never guessed.

## 10. Cross-phase audit record

- 2026-08-05 (scoping): moved from "concurrent with phase 2" to depending on it - secondary-PR adoption reliability is a hard input to the `pull_request` proofs.
- 2026-08-05 (scoping): reuses phase 2's shared changed-set predicate rather than defining its own, so run creation and completion cannot disagree about "changed".
- 2026-08-05 (scoping): `repo_root` on bindings stores the resolved primary explicitly instead of null to honor the change-contract rule that `ON CONFLICT`/unique-index columns must be non-null.
- 2026-08-10 (review): run creation now states that the changed-set predicate covers the primary, whose baseline comes from `tasks.base_sha` rather than a `task_repos` row. As originally written the predicate was evaluated "per task repo entry", which excludes the primary, so a task whose primary changed would have produced no run for it and shipped primary changes unreviewed.
- 2026-08-10 (citation re-verification): all section 4 citations re-verified against `main`. All three load-bearing premises hold: the active-binding uniqueness index is still `UNIQUE(note_key) WHERE state = 'active'`, bindings still carry scalar `session_cwd`/`session_repo_root`, and `inspector_pr_switch_refused` is still the pin-switch refusal. Drift was not uniform (`db.ts` +22, `manager.ts` +115, `session-bits.tsx` 0), so no global offset can be assumed for any citation not listed.
- 2026-08-10 (citation re-verification): four citations were mis-bounded at scoping time rather than merely drifted, and are now bounded exactly: `SessionActionAdapterContext` (the old range pointed into `SessionActionRepositoryFacts`), the `useEventStream.ts` run-event cases (pointed at the persona cases), `WorkflowInspectorGateState` (digit transposition), and the `pull_request` adapter range (ended at the old file's last line).
