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

### Size the work before splitting it

Estimate the total implementation effort before drawing phase boundaries. Use gross lines of
production code expected to be added or materially changed, excluding tests. Record the estimate as
a range with its assumptions in `phased-plan.md`; it is a planning signal, not a promise of exact
diff size.

Judge the phase count with this rubric:

- **Total effort:** estimated non-test implementation lines across the whole feature, including work
  in shared contracts, migrations, server code, workers, and browser code. Count all layers together
  rather than treating each layer as a separate unit.
- **Complexity:** expected edge cases, compatibility and migration risks, state transitions,
  concurrency concerns, uncertainty in existing contracts, and the breadth and setup cost of the
  required tests.
- **Execution fit and order:** the smallest coherent sequence that a mid-tier model can implement,
  verify, and explain reliably. Prefer a vertical slice that produces working behavior over
  horizontal layer-by-layer handoffs.

Apply these rules:

- When the estimate is **200 or fewer non-test implementation lines**, create exactly one phase and
  schedule exactly one one-shot implementation task. Multiple application layers, files, test cases,
  or review specialties do not override this threshold.
- Above 200 lines, still default to one phase. Add a phase only when the combined task would be too
  large or complex for a mid-tier model, or when an independently testable merge boundary materially
  reduces implementation risk.
- An application-layer boundary is not by itself a phase boundary. Keep schemas, persistence, routes,
  browser state, and UI together when they form one coherent feature slice.
- Do not create small preparation, test-only, documentation-only, or cleanup phases to make the graph
  look balanced. Keep that work with the behavior it supports.
- For every additional phase, state why combining it with an adjacent phase would make the work less
  achievable, less reviewable, or less safe. If that case is weak, combine the phases.

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

### A phase that targets or lands in another repository

Nearly every plan lives in one repository and every phase produces one pull request; that is the
case above and it is unchanged. Occasionally a phase cannot be made operable inside one
repository (a contract and the consumer that has to move with it), and then the phase is still
**one merge unit**, delivered by one Mission Control task with the other repositories attached to
it. Its agent works in every attached checkout in one session and opens **one pull request per
repository it actually changed**; the phase is done when all of them have merged, which is what
the task waits for. Do not split such a phase into one task per repository: that is two agents
editing two halves of one contract with no shared context, and each half is unreviewable alone.

Resolve each phase's repository set while writing the plan:

- Say so in the phase file. Name every repository the phase touches, and state per repository what
  lands there and what breaks if it merges without its siblings. The phase's exit criteria cover
  the whole set.
- A phase implemented only in the source-plan repository omits `repository`; current-repository
  behavior remains the default.
- A phase implemented only in repository B sets B as `repository`. When its plan files live in
  source repository A, add A to `additionalRepositories`, mark A context-only in the phase file and
  task intent, and require no changes there. The attachment makes the published plan paths readable
  without turning context into implementation scope.
- An inseparable A+B phase is one task with a deliberate primary in `repository` and the remaining
  repositories in `additionalRepositories`. It still opens one pull request per repository it
  actually changes and completes only after all of those pull requests merge.
- Selectors may be absolute local checkout paths or unique repository directory names. Never guess
  between duplicate names, fall back to A, or omit an attachment after a resolution or capability
  refusal.

## Write the artifacts beside the source plan

Create these files in the source plan's directory:

- `phased-plan.md`: the implementation index, including the source plan, incorporated human
  decisions, investigated findings, sizing estimate and phase-count rationale, phase table,
  dependency graph, concurrency groups, merge order, cross-phase contracts, and final verification
  strategy.
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

The phase file is the only place this detail lives. The task scheduled for the phase points at the
file rather than restating it, so write each phase file to stand on its own for an agent that arrives
with nothing but its path, and treat publishing it to the default branch as part of delivering the
phase rather than as follow-up.

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

A task carries paths instead of content, so the paths must be real before the task exists. Create
tasks only after all of the following hold:

1. every Markdown/HTML artifact has been written and the final audit passes;
2. those artifacts are committed and pushed on this session's branch - not merely present in the
   worktree, which can be reclaimed;
3. you have confirmed that each path you are about to name resolves in the pushed commit, spelled
   exactly as the task will state it and relative to the repository root.

If you cannot commit and push the artifacts, do not create the tasks. Report why instead: an
unpublished plan with scheduled tasks is worse than no tasks, because a concise task whose paths do
not resolve carries no instructions at all.

Then use the Mission Control MCP tool `create_task` once per phase, in the same topological order as
the index. The tool deliberately creates a ship task in the backlog with the default agent and no
model or effort override. Its result echoes the canonical primary and attached repository paths;
check those paths against the phase before creating anything that depends on the task.

For a one-shot plan, create exactly one task for Phase 1. Keep the normal index, phase file, task
pointers, publication gate, and verification contract; one-shot changes the execution count, not the
durability of its instructions.

### Keep the task text at goal altitude

A task's `intent` is delivered verbatim as the implementing agent's opening prompt, and it becomes
that session's recorded human goal. Conformance review then treats it as the requesting human's
explicit requirement, judged as written: a required behavior that the change omits is a failure.
Every step pasted into the task therefore hardens into a contract clause, so an agent that finds the
repository disagrees with a planned step and adapts is failed for it, even though the human only
asked for the feature. Keep the requirement in the task and the route in the plan.

Two mechanics make a bulk paste actively harmful rather than merely verbose. Review sees only the
recorded goal text, the diff, and a transcript window - it cannot open a path the intent names, so a
referenced plan is never read as requirements while an inlined one always is. And the recorded goal
is truncated to its opening and closing fragments, so a pasted phase document loses its middle and
promotes whatever detail happens to land at the edges into the requirement.

Write the `intent` as a short brief - the goal, the pointers, the boundaries, the bar - and never as
a copy of the phase document. Keep it well under 3000 characters.

Pointers replace content only because a delivery chain makes them resolvable, and closing that chain
is part of this skill's work, not an assumption it may make. The chain has three links: the artifacts
are committed and pushed before any task is created, every task depends on this planning session, and
that dependency releases the task only when this session's pull request merges the artifacts to the
default branch. The gate is what makes concision safe - an unmerged plan leaves its phase tasks
backlogged rather than dispatching an agent against paths that do not exist. Verify each link below;
a broken one means the task must not be created yet.

Schedule before the merge, not after it. Waiting for the merge to create the tasks would also work
and would even be simpler to verify, but it requires this planning session to still be alive at merge
time. Scheduling first lets the tasks wait in the backlog and release themselves whenever the human
merges, which is the behavior this skill is for.

For each call:

- Set `title` to `Implement <plan name> - Phase <n>: <phase name>`.
- Set `intent` to a brief containing exactly these four parts:
  1. **the goal** - one or two sentences naming the user-visible or engineering outcome this phase
     delivers, written the way the human would ask for it;
  2. **the pointers** - repo-relative paths to the source plan, `phased-plan.md`, and this phase's
     file, with an instruction to read them first and follow the phase file as the implementation
     guide;
  3. **the boundaries** - implement only this phase, keep the cross-phase contracts the phase file
     names, and leave later phases' scope alone;
  4. **the bar** - run the verification the phase file specifies and open a reviewable pull request
     whose merge can release dependent phases.
- State plainly in the `intent` that the phase document is the proposed route, not a specification:
  the agent follows it where the repository agrees, uses its own judgement where the repository
  disagrees or a better implementation presents itself, and records any deviation and its reasoning
  in the pull request. Only the goal is fixed.
- Keep implementation detail out of the task text. Do not embed the phase Markdown, file inventories,
  numbered step lists, schema or API definitions, or acceptance checklists. Those live in the phase
  file, which the agent reads.
- Set `repository` and `additionalRepositories` from the phase's repository analysis:
  - omit both for work wholly in the source-plan repository;
  - for B-only work whose plan lives in A, set B as primary and attach A as context-only;
  - for inseparable multi-repository work, choose the primary deliberately and attach every other
    repository the implementation must change.
- Confirm the canonical repository set returned by `create_task` matches the intended set. A short
  name can be accepted only when Mission Control finds exactly one local repository with that
  directory name.
- Set `dependsOnTaskIds` to the returned task ids of that phase's direct prerequisites. Do not flatten
  the graph into a serial chain. Parallel phases should share prerequisites and not depend on one
  another.
- Set `dependsOnCurrentSession` to `true` on every call. The planning session owns the phase
  artifacts until its pull request merges; making it a direct prerequisite prevents implementation
  agents from starting before they can pull those artifacts from the default branch. Mission Control
  resolves the calling session and normalizes it to its task when it has one, so do not guess or copy
  a session id into `dependsOnTaskIds`.
- Save the returned task id before creating any dependent task.

A well-formed `intent` reads like a person asking for the feature:

> Give Mission Control durable schedules, so a recurring mission survives a daemon restart and still
> fires exactly once per due window.
>
> Read `docs/plans/recurring-missions/plan.md` for the approved goal,
> `docs/plans/recurring-missions/phased-plan.md` for how the work is split, and
> `docs/plans/recurring-missions/phase-1-durable-schedule-foundation.md` for this phase. That phase
> file is the proposed route, not a specification: follow it where the repository agrees, use your own
> judgement where it does not or where a better implementation presents itself, and record any
> deviation and its reasoning in the pull request.
>
> Implement only this phase and preserve the cross-phase contracts it names; later phases own the
> scheduling UI and the catalog. Run the verification that phase file specifies, then open a
> reviewable pull request - its merge releases the dependent phase tasks.

For a phase implemented in `docs-site` whose plan files live in `mission-control`, the corresponding
call keeps the same concise intent and adds repository scope rather than copying the phase document:

```text
create_task({
  title: "Implement Documentation Publishing - Phase 2: Render published guides",
  intent: "Render the approved guides in docs-site. Read docs/plans/documentation-publishing/plan.md, docs/plans/documentation-publishing/phased-plan.md, and docs/plans/documentation-publishing/phase-2-render-published-guides.md in the attached mission-control checkout first. The phase file is the proposed route, not a specification; adapt with judgement and record deviations in the pull request. Mission-control is context-only and must not be changed. Implement only Phase 2, preserve its contracts, run its verification, and open the reviewable docs-site pull request.",
  repository: "docs-site",
  additionalRepositories: ["mission-control"],
  dependsOnTaskIds: ["<phase-1-task-id>"],
  dependsOnCurrentSession: true,
})
```

If repository resolution, harness capability validation, or task creation fails, stop creating tasks
that depend on it. Report the unscheduled phase, the exact failure, and every task id already
created. Never fall back to the source repository, drop an attachment, or recreate successful tasks
speculatively, because a wrongly scoped or duplicate implementation task is worse than an incomplete
graph.

## Ship the artifacts and watch the pull request

The scheduled tasks are gated on the planning session, so the plan is not delivered until the
artifacts reach the default branch. Merging is the act that publishes the paths every task names.
After task creation succeeds:

1. Open a pull request containing exactly the artifact commit this run pushed before scheduling (the
   source plan and its HTML, the phased-plan index and its HTML, every phase file), on a branch
   following the repository's branch and commit conventions. Commit and push anything the run
   produced after that point, so the branch holds every artifact the tasks reference. Follow the
   repository's PR skill where one exists (for Mission Control sessions, `mission-pull-request`). The
   description names the approved decisions, the phase-to-task-id map, and states that the backlogged
   phase tasks are released by this PR's merge.
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
4. Before the merge, re-verify every path the scheduled tasks name against the branch as it now
   stands. Review can rename, move, or split an artifact, and each task holds only a path. Any path
   that no longer resolves is repaired in the affected task's intent - or by restoring the path -
   before that task is released.
5. When the human has asked for it (or the repository's conventions authorize it), merge once green;
   otherwise hand the green PR to the human for merge. Merging is what releases the dependent phase
   tasks and publishes the referenced files to the default branch. If the PR is instead abandoned,
   say so and cancel the scheduled tasks; leaving them backlogged against unpublished paths strands
   them.

Finish by reporting the artifact paths, the phase-to-task-id map, the direct dependency edges
(including the active planning-session edge on every task), which tasks may execute concurrently,
and the pull request URL with its CI and merge state.
