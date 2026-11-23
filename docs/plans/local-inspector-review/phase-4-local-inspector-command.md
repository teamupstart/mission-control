# Phase 4: Local Inspector Command

Source plan: `docs/plans/local-inspector-review/plan.md`. Index:
`docs/plans/local-inspector-review/phased-plan.md`.

## 1. Outcome

A workflow can contain a Local Inspector stage. It runs the Inspector review on the submitted
work before any push, always with read access to the whole submitted worktree, and returns its
findings to the session as a repair packet. The GitHub Inspector is unchanged, so the operator
can measure how many GitHub rounds remain after a local pass.

## 2. Entry criteria and dependencies

- Direct dependency: Phase 3 (Persona and Workflow integration) is merged.
- The repository workload executor, the exact-state artifact service and the capture predicate
  exist as amendments A6 and A7 in the index describe.

## 3. Scope and non-goals

In scope: the review core, the `inspector` slot and its interpreter, the engine check path, the
`localReview` setting, the preview flag, the Library row, the run card, tests and docs.

Not in scope: any built-in workflow version, the completion gate, the Inspector worker's
behavior on GitHub, the merge predicate. Those are Phases 5 and 6.

## 4. Repository findings and inherited contracts

- `reviewRound` in `src/server/inspector/worker.ts` mixes the review (brief, standards, prompt,
  run, parse, plan) with GitHub work (diff fetch, posting, thread resolution).
- `runCheck` in `src/server/workflows/checks.ts` dispatches `coderabbit` to its own interpreter
  before the argv ladder. The new slot follows that branch.
- `docs/agent-guides/inspector-prompt-bytes.md` governs changes to the Inspector prompt.
- Inherited from Phases 1 to 3: the workload executor, the artifact claim, the result kind
  union, and the rule that repository bodies never leave the workload.

## 5. Implementation steps

1. Declare the preview flag `local-inspector` in `src/shared/feature-flag-registry.ts`. Every
   surface and the stage itself are gated on it.
2. Add `localReview` (boolean, default false) to `InspectorConfigSchema` in
   `src/shared/protocol.ts`. It reads as false while the flag is off.
3. Extract the review core from `reviewRound` into `src/server/inspector/review-core.ts`. The
   worker calls it for GitHub reviews with a byte-identical prompt.
4. Add the local subject: a prompt variant in `src/server/inspector/prompt.ts` that says
   findings go to the author's session, carries the run's goal in place of a pull request
   description, and lists the previous attempt's unresolved findings.
5. Give `planReview` in `src/server/inspector/verdict.ts` a local mode: fingerprints, the
   changed-file rule and scrubbing stay; line anchoring, the comment cap and posting states do
   not apply; a blocking severity decides pass or fail.
6. Append `inspector` to `WORKFLOW_CHECK_SLOTS` with interpreter `inspector`, defaults of 10
   runs, a 10 minute timeout and Block on exhaustion, and a blocking severity tuning shaped
   like `CodeRabbitTuning`, default major and above. Carry it through `protocol.ts`,
   `commands.ts`, `store.ts`, `db.ts`, `routes.ts` and `settings-backups/restore.ts` the way
   `coderabbit` is carried.
7. Append the result kind `inspector_verdict` to the workload contract.
8. Write `src/server/workflows/local-inspector.ts` and dispatch to it from `runCheck`. In
   order: skip when the flag, Inspector or `localReview` is off or Commands consent is
   missing; reserve a run; resolve base and merge base with the resolver CodeRabbit uses;
   build the diff under the Inspector's byte cap; block when the submission has no active
   artifact claim; dispatch one workload with the Inspector's provider, model and the
   `inspector:review` spend role; parse, plan and return the outcome. A provider failure, an
   oversize diff and a missing artifact claim block for the operator and spend no repair
   round. A spent allowance follows the slot's exhaustion policy.
9. Extend the capture predicate so a pinned graph with an `inspector` node captures the
   artifact, with the `localReview` decision frozen per submission. The capture does not
   depend on the Persona access flag of amendment A5.
10. In `src/server/workflows/engine.ts`, pass the previous attempt's unresolved findings to the
    stage and render a failed outcome's findings with `findings-text.ts`. Retain normalized
    findings through `command-artifacts.ts`.
11. UI: the Local review control in `src/web/components/InspectorSettingsPanel.tsx`, the
    Local Inspector row in `src/web/workflows/CommandLibrary.tsx`, the stage in the editor's
    Command choices, and the run card in `WorkflowRuns.tsx` with findings and a statement that
    the review read the worktree.
12. Document the stage in `docs/workflows.md`, `docs/inspector-and-shipping.md` and
    `docs/feature-flags.md`.

## 6. Data, API and compatibility

- No table is added. The setting lives in the `inspector` config blob. The slot id, result
  kind and flag id are appended and never renamed.
- Catalogs and graphs written before this phase stay readable. A build without the flag skips
  the stage with a note.
- There is no diff-only path. An unavailable workload or artifact is an operator block, never
  a pass and never a prompt-only review.

## 7. Tests and verification

- New focused tests: review core (local diff, finding carry, resolution, threshold, off-diff
  drop, scrubbing), interpreter ladder (each skip and block reason), engine (stage ordering,
  repair loop, allowance, restart), GitHub prompt bytes unchanged.
- A fake-provider test in which a Codex Local Inspector review makes repository queries.
- Playwright: `e2e/specs/local-inspector.spec.ts` covering the setting, the Library row and a
  run card with findings. A spec that opens a modal calls `expectContentClearsBorder`.
- Run `npm run typecheck`, `npm run lint`, the focused tests, `npm run build`,
  `npm run smoke` and `npm run test:e2e`.

## 8. Merge and exit criteria

- With the flag and setting on, a duplicated workflow with the stage before the Pull Request
  action returns findings without a push and lets the action run after a pass.
- With either off, the stage skips with a note and nothing else changes.
- No code path lets the stage pass without repository access.
- A run's local findings and its pull request's GitHub findings are both recorded, so the
  operator can compare them and count the GitHub rounds that remain after a local pass.

## 9. Downstream handoff

Later phases may rely on the slot id, the result kind, the flag id, `localReview`, and the
recorded outcome with its publication tree, base ref, merge base and findings. They must not
change what "passed" means.

## 10. Cross-phase audit record

- 2026-11-23: checked against the index and amendments A6 and A7. Phase 4 appends to the
  result kind union and the capture predicate. It does not redefine either.
- 2026-11-23: checked against Phases 5 and 6. Neither needs a field this phase does not record.
- 2026-11-23: reconciled with the source plan. The blocking severity default (D3), the
  operator blocks of design item 2 and the modal inset check are stated here.
