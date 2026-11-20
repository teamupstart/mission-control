# Phase 6: Repository task skills (WP8)

Source: `plan.md`, `phased-plan.md`. Common rules: `phased-plan.md` section 3. Spec v18.

**1. Outcome.** A repository can add `.claude/skills/{kind}/SKILL.md`, and its text is added, when `headless-mode` is on, to a worker's first prompt for every origin, never replacing Mission Control's own.

**2. Entry and dependencies.** Direct prerequisite: P2.

**3. Scope.** `src/server/instructions/repo-task-skill.ts` and `composeTurnOne` in `src/server/dispatcher.ts` (spec 7.15, D20). Non-goals: any other dispatcher change, routing (FR-04), duplicate native discovery (Q6 stays documented).

**4. Findings.** `composeTurnOne` is a hot file: the task-shaping plan's Phase 2 also edits it (spec 12.2). Whichever merges first wins; the other rebases. This phase stays separate for that reason. A repository skill is repository content and untrusted input; apply the same symlink and size rules as memory.

**5. Steps.** Read spec 7.15 and 12.1. Locate and size-cap the skill file, ignore symlinks leaving the repository, append it after Mission Control's own first-prompt text, and include it for dashboard, `mctl` and home-session origins alike. Name the task-shaping plan in the pull request.

**6. Data and API.** No schema or route change.

**7. Tests.** Prompt composition for each kind with and without a skill, ordering, oversize and symlink cases, and an assertion that the prompt for a repository without a skill is byte-identical to today's.

**8. Merge and exit.** Behavior is flag-independent for repositories with no skill; with the flag off no skill text is added to any prompt, which keeps today's behavior.

**9. Handoff.** Nothing downstream depends on it except docs (P17) and the full loop (P18).

**10. Cross-phase audit.** Only P6 edits `composeTurnOne`. No shared file with P3 or P5.
