# Multi-repo tasks - phased implementation plan

**Source plan:** [plan.md](plan.md) ([rendered](plan.html))
**Rendered index:** [phased-plan.html](phased-plan.html)
**Status:** All four phases merged, in order: #491 (dispatch), #493 (pull request tracking and completion), #494 (per-repo review runs), and the policy-and-prose phase this line was written by. Phases written 2026-08-05; citations re-verified against `main` 2026-08-10.

## Incorporated decisions

Submitted by the operator on 2026-08-05 (recorded in the source plan and treated as requirements):

1. **Completion:** a multi-repo task auto-completes only when every changed repo's PR has merged.
2. **Review workflows:** per-repo workflow runs - one session supports N concurrent runs, one full review per changed repo; unchanged repos skipped.
3. **Harnesses:** Claude and Codex in v1 behind a `HARNESS_CAPABILITIES` flag; Codex sandbox writable roots for secondary worktrees.
4. **Auto-merge:** independent per-PR merges; no coordinated-merge mechanism (this decision removes a workstream rather than adding one).
5. Recommended defaults not overridden: primary-cwd session layout; additive `task_repos` data shape; dispatch-modal-only creation in v1; dispatch-only assignment.

## Investigated findings that shaped the split

- The additive primary-plus-secondaries data shape makes phase 1 self-contained: every existing single-repo consumer keeps a meaningful scalar, so dispatch can ship before any PR or workflow surface changes.
- The pool reaper spares only pinned worktrees; pins for secondary worktrees are therefore inside phase 1's provisioning change, never a follow-up (destructive if split).
- The Foreman allowlist AND rule moved from the polish phase into phase 1: without it, Foreman could auto-dispatch an agent into a secondary repo the operator never allowlisted. Consent ships with capability.
- Secondary-repo PRs are only reliably *adopted* once multi-URL sniffing and poller fan-out exist (phase 2), and per-repo workflow runs prove their PRs against the adoption ledger - so phase 3 depends on phase 2, and the graph is serial. An earlier concurrency claim was withdrawn during the audit.
- The workflow subsystem's single-repo contracts (the `pull_request` adapter, evidence identity, wait/block vocabulary) are never widened; phase 3 moves concurrency to the binding/run layer instead, per decision 2.
- `provisionWorktree`/`teardownWorktree` live in `src/server/dispatcher.ts` (760/925), pins in `src/server/pool.ts` (242/257) - one scoping report misattributed the file; phase files carry the verified locations.
- The exact Claude Agent SDK additional-directories option and the Codex writable-roots config key could not be verified at scoping time (no `node_modules` in the planning worktree; Codex needs a live installation). Phase 1 names both as verify-first steps, and the Codex capability ships as `null` if unverified rather than guessed.
- Re-verification on 2026-08-10 closed the SDK half of that unknown in the plan's favor: `Options.additionalDirectories` exists at the pinned `@anthropic-ai/claude-agent-sdk@0.3.220`, so phase 1 needs no permission-mode fallback. The Codex writable-roots key is still the one genuine unknown in the feature.
- Re-verification also found that a number of the original `file:line` citations were wrong when written, not merely drifted: several cited files are byte-identical to the scoping-time tree yet carried numbers off by as much as 95 lines, and real per-file drift ranged from 0 to +480 lines. Citations are corrected throughout, and each phase's audit record now says to locate constructs by symbol name rather than trusting an unverified number.

## Phases

| # | File | Delivers | Direct prerequisites |
|---|---|---|---|
| 1 | [phase-1-multi-repo-dispatch.md](phase-1-multi-repo-dispatch.md) | `task_repos` schema and the additive `tasks.base_sha` primary baseline, contracts, per-repo provisioning with pins and rollback, capability flag, Claude/Codex write access, intent manifest, dispatch modal chips, allowlist AND rule, assignment refusal | - |
| 2 | [phase-2-multi-pr-tracking.md](phase-2-multi-pr-tracking.md) | Multi-URL sniffing, poller fan-out, `work_episode_prs`, all-merged completion quorum, per-repo PR projection and UI | Phase 1 |
| 3 | [phase-3-per-repo-workflow-runs.md](phase-3-per-repo-workflow-runs.md) | Binding repository dimension, lazy per-changed-repo run creation, per-repo evidence scoping, submission routing, cross-run delivery serialization, merge-veto membership, workflow chip fan-out | Phase 2 |
| 4 | [phase-4-policy-and-prose.md](phase-4-policy-and-prose.md) | Per-PR review follow-up marks, skills and session-action prompt updates, agent-guide and `docs/*.md` sweep | Phase 3 |

## Dependency graph and merge order

```
Phase 1 -> Phase 2 -> Phase 3 -> Phase 4
```

Serial; merge order equals numbering. No concurrency groups: the audit found each later phase consumes a behavior the previous one introduces (worktrees and base_sha; adoption reliability; per-repo runs). Every phase leaves the repository operable, with single-repo behavior proven unchanged by the existing suites.

## Cross-phase contracts

- `task_repos` columns and PK, plus the additive `tasks.base_sha` column holding the primary's baseline; `base_sha` is a full oid recorded at cut time for every repo including the primary (phase 1, consumed by 2 and 3). The primary has no `task_repos` row, so its baseline must be read from `tasks`.
- `TaskRepoEntry` declares `prUrl`/`prState`/`mergedAt` in phase 1 (null); phase 2 populates them - the wire shape never changes after phase 1.
- The changed-set predicate (episode PR present, or head differs from `base_sha`) lives in `src/shared`, introduced in phase 2, imported by phase 3's run creation - one definition of "changed". It covers the primary as well as the secondaries; a version that iterates `task_repos` rows alone silently excludes the primary and makes both the quorum and run creation unsound.
- Session cwd is always the primary worktree; multi-repo tasks are dispatch-only (phase 1, relied on by everything).
- Every attached repo gets a distinct, stable worktree path. The git fallback derives it from the entry's `position` (slot 0 keeps the legacy `WORKTREES_DIR/<taskId>`), pool paths come from each repo's own pool. Phase 3 reads per-repo worktrees for evidence capture, so nothing may renumber a provisioned entry's `position` without moving its tree.
- One workflow run = one repository; binding uniqueness `(note_key, repo_root)` with the primary stored explicitly; one outstanding delivery per session (phase 3, relied on by phase 4's nudging).
- `Session.prUrl` stays the scalar current-branch PR everywhere.

## Final verification strategy

- Per phase: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`, `npm run test:e2e`, each with the phase's own specs (see each file's section 7).
- Feature acceptance after phase 4: a two-repo dispatch on the e2e daemon yields two worktrees, two PRs, two repo-labeled workflow runs with independent repair budgets, completion only when both PRs merge, and byte-identical single-repo behavior across the pre-existing suites.
- Migration: every phase with schema changes carries a pre-feature-database upgrade test per the change contract.
