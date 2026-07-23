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
- Save the returned task id before creating any dependent task.

If task creation fails, stop creating tasks that depend on it. Report the failure and every task id
already created; never recreate successful tasks speculatively, because duplicate implementation
tasks are worse than an incomplete graph.

Finish by reporting the artifact paths, the phase-to-task-id map, the direct dependency edges, and
which tasks may execute concurrently.
