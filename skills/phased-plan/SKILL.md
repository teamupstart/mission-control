---
name: phased-plan
description: Investigate an existing product or engineering plan against the repository, turn it into compatible merge-aware implementation phases, write the phase documents beside the source plan, and schedule one dependency-linked Mission Control task per phase. Use when a user asks to phase, sequence, decompose, operationalize, or schedule an existing plan, including after selecting the phased-plan follow-up in an html-plans review.
metadata:
  mission:
    category: planning
    enforcement: triggered
---

# Phased Plan

Turn an approved plan into implementation units that separate agents can execute and merge safely.
Treat the source plan and its recorded human selections as requirements, then verify those
requirements against the repository before deciding the phase boundaries.

## Establish the source of truth

1. Resolve the source plan to an absolute Markdown path. Prefer the `plan.md` beside a supplied
   `plan.html`; the Markdown remains authoritative.
2. Read the entire source plan, its submitted decision response, and every repository instruction
   file that governs the plan's scope. Incorporate resolved human choices as requirements, not open
   questions. If the choices have not yet been written into the source plan, update it before
   decomposing and refresh its HTML rendering.
3. Inspect the current implementation deeply enough to test the plan's assumptions. Trace the
   affected contracts, persistence, migrations, server routes, workers, browser state, UI surfaces,
   build/package entries, and tests. Use history or related plans where they clarify compatibility.
4. Record discrepancies between the proposed design and the code as explicit decisions in the
   phased plan. Do not copy speculative filenames or APIs from the source plan after the repository
   disproves them.

## Design the dependency graph

Choose the fewest coherent phases that keep each pull request reviewable and leave the repository in
a valid, testable state. A phase is an implementation and merge unit, not a chapter split.

- Put shared schemas, durable storage, migrations, and foundational interfaces before consumers.
- Keep a vertical slice together when splitting it would create a dead surface or a temporary second
  source of truth.
- Separate independent work when its contracts are already fixed. Two phases may run concurrently
  when neither consumes files, migrations, APIs, generated assets, or decisions owned by the other.
- Name the exact merge prerequisites for every phase. Use direct prerequisites only; transitive
  prerequisites are implied by the graph.
- Treat tests, migration compatibility, documentation, packaging, layout parity, and cleanup/reset
  behavior as implementation work in the phase that introduces the behavior, not as a final catch-all.
- End each phase with an operable repository and concrete exit criteria. Do not rely on an unmerged
  later phase to repair a knowingly broken intermediate state.

Number phase files in a topological presentation order. Numbering does not imply serialization:
independent `phase-2-*` and `phase-3-*` files may both depend only on Phase 1 and run concurrently.

## Write the artifacts beside the source plan

Create these files in the source plan's directory:

- `phased-plan.md`: the implementation index, including the source plan, incorporated human
  decisions, investigated findings, phase table, dependency graph, concurrency groups, merge order,
  cross-phase contracts, and final verification strategy.
- `phase-<n>-<slug>.md`: one detailed implementation plan per phase.

Each phase file must contain:

1. outcome and user-visible or engineering value;
2. entry criteria and direct phase dependencies;
3. scope and explicit non-goals;
4. repository findings and the contracts inherited from earlier phases;
5. file- and component-level implementation steps in execution order;
6. data/API/migration and compatibility details where applicable;
7. tests and verification commands appropriate to the risk;
8. merge and exit criteria;
9. a downstream handoff describing what later phases may rely on and must not change;
10. a cross-phase audit record.

Apply the `html-plans` rendering contract to `phased-plan.md` when that skill is available. Keep the
phase Markdown files as the detailed sources linked from that rendered index; the parent review owns
the phased-plan follow-up, so do not recursively ask whether each generated phase should itself be
phased again.

## Audit compatibility after every phase

Write phase files one at a time in dependency order. Before starting the next phase:

1. Re-read the source plan, `phased-plan.md` draft, and every phase file written so far.
2. Compare the new phase's decisions against earlier schemas, names, ownership boundaries,
   migrations, APIs, tests, and exit criteria.
3. Edit any earlier phase whose contract would otherwise be incompatible. Prefer moving the decision
   into the earliest phase that must own it rather than adding a later workaround.
4. Append the reconciliation to the affected files' cross-phase audit records.
5. Re-check dependency directions and concurrency claims before proceeding.

After the last phase, perform the same audit over the complete set. Confirm that every source-plan
requirement and submitted selection is owned by exactly one phase, every consumer follows its
prerequisite, concurrent phases can merge in either order, and the final state matches the source
plan without depending on undocumented cleanup.

## Schedule the implementation tasks

Create tasks only after every Markdown/HTML artifact has been written and the final audit passes.
Use the Mission Control MCP tool `create_task` once per phase, in the same topological order as the
index. The tool deliberately creates a ship task in the backlog with the default agent and no model
or effort override.

For each call:

- Set `title` to `Implement <plan name> - Phase <n>: <phase name>`.
- Set `intent` to instruct the agent to read the source-plan, phased-plan, and phase-file paths;
  implement only that phase; preserve the named cross-phase contracts; run its specified
  verification; and open a reviewable pull request whose merge can release dependent phases. Include
  repo-relative paths and embed the complete phase Markdown under an `Authoritative phase
  instructions` heading so the task remains executable if the planning worktree is later reclaimed.
- Set `dependsOnTaskIds` to the returned task ids of that phase's direct prerequisites. Do not flatten
  the graph into a serial chain. Parallel phases should share prerequisites and not depend on one
  another.
- Set `dependsOnCurrentSession` to `true` on every call. The planning session owns the phase
  artifacts until its pull request merges; making it a direct prerequisite prevents implementation
  agents from starting before they can pull those artifacts from the default branch. Mission Control
  resolves the calling session and normalizes it to its task when it has one, so do not guess or copy
  a session id into `dependsOnTaskIds`.
- Save the returned task id before creating any dependent task.

If task creation fails, stop creating tasks that depend on it. Report the failure and every task id
already created; never recreate successful tasks speculatively, because duplicate implementation
tasks are worse than an incomplete graph.

## Ship the artifacts and watch the pull request

The scheduled tasks are gated on the planning session, so the plan is not delivered until the
artifacts reach the default branch. After task creation succeeds:

1. Commit every artifact this run created or updated (the source plan and its HTML, the phased-plan
   index and its HTML, every phase file) on a branch following the repository's branch and commit
   conventions, and open a pull request containing exactly that work. Follow the repository's PR
   skill where one exists (for Mission Control sessions, `mission-pull-request`). The description
   names the approved decisions, the phase-to-task-id map, and states that the backlogged phase
   tasks are released by this PR's merge.
2. Watch the pull request until CI passes. Fix failures this PR caused; a failure that reproduces on
   the base branch is reported, not chased. Do not stop at "pushed" - the deliverable is a green,
   merged PR.
3. Address Inspector (or other automated reviewer) comments **if and only if both hold**: the
   comment is valid - it identifies a real defect in the artifacts, verified against the repository
   rather than taken on faith - AND fixing it does not change the intended behavior of the scoped
   work as the user defined it (the approved plan and its submitted decisions). A valid comment
   whose fix would alter an approved decision or the plan's scope is surfaced to the human as a
   question, never silently applied. An invalid comment gets a reply stating why, with evidence,
   and its thread resolved - do not churn the artifacts to appease a wrong review. After each fix:
   push to the same branch, resolve any conflicts, and keep monitoring CI and review threads until
   the PR is green with no unresolved actionable comments. Never weaken a phase's contracts or exit
   criteria to satisfy a reviewer without recording the change in the affected cross-phase audit
   records.
4. When the human has asked for it (or the repository's conventions authorize it), merge once green;
   otherwise hand the green PR to the human for merge. Merging is what releases the dependent phase
   tasks.

Finish by reporting the artifact paths, the phase-to-task-id map, the direct dependency edges
(including the active planning-session edge on every task), which tasks may execute concurrently,
and the pull request URL with its CI and merge state.
