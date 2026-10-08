# Plan storage policy: backlog task briefs

These are the exact goal-level intents submitted in the two successful `create_task` calls. Both tasks target `/Users/jordanmance/workspace/mission-control`, with no attached repositories or model/effort override. Both retain `dependsOnCurrentSession: true`; Phase 2 also depends on Phase 1. They remain in the backlog until their publication prerequisites are satisfied.

The operator's 2026-10-08 plans-only PR instruction retains these original briefs without
narrowing either task. Their phase documents describe full implementation scope; this PR
provides planning inputs only. The state above is the successful scheduling response from
2026-10-06, not a substitute for Mission Control's live task status.

## Phase 1

Task id: `2e139a96-2975-40f0-89a8-7e2f31925b20`.

Title: Plan storage policy - Phase 1: Managed repository plans and HTML policy

```text
Give Mission Control daemon-managed repository plans that commit Markdown by default, keep rendered HTML available locally for review, and include HTML in Git only when the operator enables it. Preserve existing tracked plans and keep repository publication based on the planning PR's merge.

Read docs/plans/plan-storage-policy/plan.md, docs/plans/plan-storage-policy/phased-plan.md, and docs/plans/plan-storage-policy/phase-1-managed-repository-plans.md first. The phase file is the proposed route, not a specification: follow it where the repository agrees, use your own judgment where it differs or a better implementation emerges, and record deviations and their reasoning in the PR. Only the goal is fixed.

Implement only Phase 1 and preserve its contracts for the later local-storage and task-handoff phase. Run the verification the phase file specifies and provide the required workflow evidence. Follow the task's completion handoff, then its authorized workflow to a reviewable PR whose merge releases Phase 2.
```

## Phase 2

Task id: `aea2ba2d-61cc-4601-a5e2-b0e8a760aaf4`.

Title: Plan storage policy - Phase 2: Local plans and dependable task handoff

```text
Let users keep complete plans under Mission Control's local repository-scoped plan store instead of Git. Tell receiving tasks to check both plan locations and give scheduled phases exact readable plan references. Local plan-only publication should release its artifact prerequisites after approval and applicable validation without an empty PR, while code and implementation-phase dependencies keep their normal merge requirements. Local mode overrides the HTML-commit preference without losing it.

Read docs/plans/plan-storage-policy/plan.md, docs/plans/plan-storage-policy/phased-plan.md, and docs/plans/plan-storage-policy/phase-2-local-plans-and-task-handoff.md first. The phase file is the proposed route, not a specification: follow it where the repository agrees, use your own judgment where it differs or a better implementation emerges, and record deviations and their reasoning in the PR. Only the goal is fixed.

Implement only Phase 2 on the merged Phase 1 foundation and preserve its storage, revision, preview, and archive contracts. Run the verification the phase file specifies and provide the required workflow evidence. Follow the task's completion handoff, then its authorized workflow to a reviewable PR.
```
