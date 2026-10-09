# Plan storage policy: phased implementation

Source: [plan.md](plan.md). Operator selection: daemon-managed placement with generated HTML excluded from commits by default. This PR publishes the plan; the two scheduled tasks implement the complete feature.

## Planning handoff and phase scope

The planning branch contains only the five Markdown inputs listed in the task briefs. The
operator will merge this PR, releasing Phase 1. Phase 2 waits for both this planning PR and
Phase 1 to merge. Keep the existing tasks and their original goal-level briefs; no replacement
or narrowed follow-up tasks are needed.

- Phase 1 implements managed repository plan storage, Markdown-only commits by default, HTML
  opt-in, durable previews, archive integration, stable skills, settings, and verification.
- Phase 2 implements local storage, both-location discovery, exact structured task references,
  local approval/publication with compatible workflows, and safe artifact prerequisite release.

No feature implementation from the planning session is included. An uncommitted prototype was
preserved locally and excluded from delivery. Implement against the merged repository and
recheck the findings below; do not rely on prototype files or earlier implementation claims.

## Sizing and phase-count rationale

Estimated total: **2,100 to 3,600 gross non-test implementation lines**, including materially changed existing code. This is a planning range, not a quota. It assumes reuse of current configuration, MCP attribution, workflow, task, archive, and preview mechanisms, with no new generic workflow engine or plan editor.

| Phase | Estimated non-test lines | Why it is one coherent release |
| --- | --- | --- |
| 1. Managed repository plans and HTML policy | 1,000 to 1,700 | Saves reviewable repository plans with Markdown-only commits by default, an HTML opt-in, durable previews, and unchanged merge-based publication. |
| 2. Local plans and dependable task handoff | 1,100 to 1,900 | Enables the whole-plan local option only when discovery, pinned task references, workflow completion, and dependency release work together. |

Two phases are justified by separate correctness boundaries. Phase 1 changes artifact placement, provenance, preview, and capture while retaining Git publication. Phase 2 changes readiness and task execution without reworking the storage writer. Combining them would put filesystem recovery, UI behavior, wire compatibility, and workflow/dependency migrations in one large change. Splitting either by application layer would leave an unusable feature or a visible option that cannot fulfill its promise.

## Repository findings and reconciled decisions

All paths below were inspected in this checkout. The confidence numbers describe the source observation, not a prediction that the proposed implementation will be defect-free.

| Finding | Evidence | Confidence | Plan consequence |
| --- | --- | --- | --- |
| Skills preferences already use schema-validated app-config data and per-field backup classification. Reload generation follows symlink changes. | `src/shared/protocol.ts` Skills schemas; `src/shared/app-config-entries.ts`; `src/server/skills/config.ts` | 100% | Add preferences to that owner; policy writes do not rewrite skills or advance reload generation. |
| Skills UI state is projected explicitly, not spread from persisted config. | `src/server/routes.ts` skillsView; `src/web/useSkills.ts`; `src/web/components/SkillsPanel.tsx` | 100% | Update view types, API projection, optimistic state, search anchors, and browser coverage together. |
| Plan prompts and completion rules currently require checkout artifacts and commit/push before scheduling. | `src/server/plans/prompt.ts`; `src/shared/task-completion.ts`; `skills/phased-plan/SKILL.md` | 100% | Phase 1 differentiates Markdown publication from local preview retention; Phase 2 introduces local publication without a Git requirement. |
| Plan capture is discovered through Git diffs and rejects ignored HTML as the primary page. | `src/server/plans/capture-scopes.ts`; `src/server/plans/capture-plan.ts`; `src/server/archives/manager.ts` | 100% | Integrate registered revision capture in Phase 1. Do not simply ignore HTML and leave capture broken. |
| The session file reader is checkout-confined; archives use opaque keys and a guarded reader. | `src/server/session-files.ts`; archive routes in `src/server/routes.ts`; `src/web/lib/api.ts` | 100% | Give local previews scoped identity, preserving the file-read security boundary. |
| Fresh dispatch and live assignment share the task contract composer; the current plan appendix applies only to plan tasks. | `src/server/task-contract.ts`; `src/server/dispatcher.ts`; `src/server/tasks.ts` | 100% | Phase 2 adds discovery for all managed task kinds at both seams. |
| Canonical repo resolution walks linked worktrees to their owner. | `src/server/repos.ts` resolveRepoRoot | 100% | Namespace by canonical identity beneath a readable repo-name directory. |
| Session dependencies normalize to task edges, whose satisfaction persists separately from a target row's status. | `src/server/tasks.ts` resolveDependencies and satisfyDeclaredEdgesTo; `src/shared/types.ts` TaskDependency; `src/shared/backlog.ts` | 100% | Add a distinct artifact-publication prerequisite. Never invoke broad task-edge satisfaction for a local plan. |
| Publication ownership is current workflow binding authority, independent of whether Personas exist. Its schema is strict. | `src/shared/plan-publication.ts`; `src/server/workflows/manager.ts` planPublicationContext; `src/server/foreman/plan-publication.ts` | 100% | Preserve binding/version guards; put storage/readiness in a distinct compatible contract instead of silently adding unrecognized fields to the old response. |
| The current built-in Plan Validation workflow includes a pull-request action. | `src/server/workflows/builtin-workflows.ts` Plan Validation versions | 100% | Phase 2 must provide an explicit local publication path, not assume validation can already finish without a PR. |

The earlier report described a complete bundle and atomic publication generally. This plan makes the limit precise: an immutable revision manifest can publish atomically, but checkout, state-home files, Git publication, and SQLite do not share one transaction. A recoverable intent plus verification owns that boundary. A preview's presence is not approval, workflow success, or publication.

## Dependency graph and repository scope

All implementation is in the current `mission-control` repository. There are no attached implementation or context-only repositories, and each phase produces one PR in this repository.

| Phase | Direct prerequisites | Detailed guide |
| --- | --- | --- |
| 1 | This planning session's publication | [phase-1-managed-repository-plans.md](phase-1-managed-repository-plans.md) |
| 2 | This planning session's publication; Phase 1 merged | [phase-2-local-plans-and-task-handoff.md](phase-2-local-plans-and-task-handoff.md) |

```mermaid
flowchart LR
  P[Planning artifacts published] --> A[Phase 1: repository plans and HTML policy]
  P --> B[Phase 2: local plans and task handoff]
  A --> B
```

Execution order is Phase 1, then Phase 2. There is no parallel phase group: both phases extend shared plan contracts, MCP, task contracts, and skills, and Phase 2 consumes the tested writer and revision model from Phase 1. Every task retains a durable planning-session prerequisite. The operator must merge these Markdown inputs before that prerequisite is released.

## Cross-phase contracts

| Contract | Owner introduced in Phase 1 | Phase 2 use |
| --- | --- | --- |
| Namespace | Canonical owner identity; readable repo name plus collision-safe key | Same store across worktrees and repository attachments |
| Policy | Pinned repository artifact policy and `commitPlanHtml: false` default | Add `planStorage: repository/local`, default repository; local overrides HTML eligibility |
| Revision | Stable plan id, immutable revision, bounded file inventory and digests | Exact task input; no newest-revision or filename substitution |
| Operational ledger | Plan owner/episode, pinned policy, saved revision and recoverable write state | Approval, publication receipts, and reference bindings; daemon remains only SQLite writer |
| Writer | Writes policy-eligible outputs only; rejects traversal, symlinks, conflict and corruption | Local-only destination selection uses the same writer |
| Preview and capture | Exact saved revision through guarded reader and existing archive owner | Full local bundles use the same preview and capture path |
| Git publication | Required Markdown paths, plus HTML only when enabled | Unchanged for repository mode and implementation code |
| Skill procedure | Resolve, save, review, and cite managed references; static skill text | Local scheduling branch consumes the same returned policy and references |

Wire/tool names inside phase steps are proposals. Their semantics and compatibility obligations are fixed; implementers can adapt names or factor helpers when they record the reason. Do not add an unused local setting in Phase 1, or expose local mode before its completion contract exists.

## Coverage and final verification

Phase 1 owns PS-01 through PS-05, the namespace/retention foundation for PS-07, and its PS-12 browser/evidence coverage. Phase 2 owns PS-06 and PS-08 through PS-11, extends PS-07 to complete local bundles, and completes PS-12. Shared criteria have explicit baseline and extension responsibilities, not duplicate competing owners.

Final integration demonstrates:

1. New installation and upgrade both use repository Markdown with HTML excluded.
2. HTML opt-in changes eligible files; local mode overrides it without losing the preference.
3. Preview, archive, and phase links remain usable after the authoring checkout is removed.
4. Pinned inputs are delivered through dispatch and assignment; same-name repositories and extra repository scopes cannot cross-read.
5. A reviewed local plan releases only its artifact prerequisites after exact workflow success, without a PR; Phase 1/Phase 2 code dependencies still wait for their merges.
6. Failed writes, missing revisions, stale approvals, incompatible workflows, and restart do not turn partial work into publication.

Run the focused tests named in each phase, plus repository-required typecheck, lint, build/smoke, and UI E2E checks as applicable. Initial implementation verification follows the repository definition of done. CI/workflow repair rounds run only issue-specific tests before pushing, as the standing instructions require. Register exact completed outputs and rendered UI evidence with the native evidence tool; do not commit evidence files.

## Scheduling state

Both implementation tasks were created successfully through Mission Control on 2026-10-06. Their exact submitted intents are in [task-briefs.md](task-briefs.md). The tool confirmed the canonical repository `$REPO_ROOT` (the owning `mission-control` checkout), no additional repositories, and backlog status for both tasks.

On 2026-10-08 the operator explicitly requested this plans-only PR and retained merge ownership.
Commit and push only the five Markdown sources; rendered HTML, the earlier design report,
implementation drafts, and workflow evidence remain local. Before reporting the PR, verify
that every path in the task briefs resolves from the pushed commit and that the PR contains
no implementation files. Both tasks retain their planning-session merge prerequisite, and
Phase 2 retains its direct Phase 1 prerequisite.

| Phase | Task id | Registered direct dependencies | State |
| --- | --- | --- | --- |
| 1 | `2e139a96-2975-40f0-89a8-7e2f31925b20` | Current planning session | Backlog; waits for planning publication |
| 2 | `aea2ba2d-61cc-4601-a5e2-b0e8a760aaf4` | Current planning session; Phase 1 task `2e139a96-2975-40f0-89a8-7e2f31925b20` | Backlog; waits for planning publication and Phase 1 merge |

The original task briefs and registered dependencies remain the intended execution graph.
This planning handoff supersedes earlier claims that the feature was delivered in this task.
Implementation and its required runtime evidence belong to the two scheduled phases.

## Final cross-phase audit

- The HTML default is false in the source, Phase 1, and Phase 2; local mode overrides the stored preference only in effective output policy.
- Phase 1 is a working repository-mode feature, not unused infrastructure. Phase 2 does not need a temporary schema or a second writer.
- Default settings do not migrate tracked historical HTML. Both phases preserve legacy plan publication.
- Phase tasks read Markdown, so excluding HTML never makes a required Git path disappear.
- Archive changes are included with artifact relocation in Phase 1, not deferred until after that relocation breaks capture.
- Local mode, exact task references, approval/workflow receipts, and plan-only completion land together in Phase 2.
- Existing task/session merge edges are never reinterpreted as plan-publication edges. Mixed tasks do not receive an empty-PR exception for their code.
- Both phase tasks retain a direct dependency on this planning session, and Phase 2 additionally depends on Phase 1. Their instructions are goal-level briefs, with implementation detail in the phase files.
- There are no overlapping independent phases, omitted migrations, test-only phases, or hidden follow-up work required to make either release operable.
