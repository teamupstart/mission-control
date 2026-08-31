# Phase 1: Record Live Engineer Progress and Preserve Artifact Identity

## Outcome

A managed Codex or other no-hook Engineer host follows an executable provider contract: it records
live, evidence-backed authoring transitions in the reserved Engineer run and names feature artifacts
with the exact worktree-reserved slug. An approved PRD becomes observable before land, and the
reproduced artifact-stem refusal does not occur when the canonical skill is followed.

## Entry criteria and dependencies

- Source plan: `docs/plans/engineer-progress-and-refusal-visibility/plan.md` in the attached Mission
  Control checkout.
- Phased index: `docs/plans/engineer-progress-and-refusal-visibility/phased-plan.md`.
- Direct phase dependencies: none.
- Scheduling dependency: the Mission Control planning session and plan PR must merge first.
- Start from current `origin/main` in `/Users/jordan.mance/workspace/upstart/ai-conductor`.

## Repository scope

### Primary: `/Users/jordan.mance/workspace/upstart/ai-conductor`

Implement, test, document, commit, push, and open the AI Conductor pull request.

### Attached context-only: Mission Control

Read the diagnosis and existing consumer contract. Do not edit Mission Control. A Mission Control
diff makes this phase incomplete rather than multi-repository.

## Scope

- Make `skills/engineer/SKILL.md` capture and reuse the exact worktree command output.
- Define when no-hook hosts issue each supported `engineer run-record` transition.
- Preserve accepted-result and deterministic-artifact completion evidence.
- Bind feature-scoped artifact filenames to the returned slug before authoring and before land.
- Describe refusal repair and retry in the retained authoring worktree.
- Pin the canonical skill contract in automated tests and maintained reference documentation.

## Non-goals

- No Mission Control terminology or behavior in the provider contract.
- No new event type, schema version, lifecycle store, visualizer, replay API, or completion evidence.
- No automatic inference from conversation text or arbitrary file presence.
- No weakening or removal of land's deterministic artifact-stem validation.
- No build, merge, or implementation-daemon behavior change.

## Verified repository findings and inherited contracts

- `engineer worktree` already prints one JSON object containing `engineerRunId`, `slug`, `branch`,
  and `worktreePath`, and writes `.pipeline/engineer-run.json` with the same identity.
- Worktree creation already records run-started, routing-selected, and worktree-created mechanical
  transitions. The host must not double-record them.
- `engineer run-record` accepts the full authoring step vocabulary and validates step state changes.
- Generic completion accepts `accepted_result` and `artifact_validation`; `land_reconciliation` is
  reserved for the deterministic land path.
- The lifecycle reducer appends retries and refuses illegal terminal reopen.
- `land-spec.ts` validates every idea-attributable PRD, stories, plan, conflict, and coherence path
  against the reserved feature identity before staging `.docs`.
- Provider skill contract tests already inspect the canonical shared skill source loaded by Claude
  and Codex.

## Implementation steps

### 1. Add one authoritative run-context block to the Engineer skill

Immediately after successful worktree creation, require the host to parse and retain
`engineerRunId`, `slug`, `branch`, and `worktreePath`. State that:

- the returned run id is used for every later lifecycle command;
- the returned slug is the feature and plan stem for the artifact families enforced by land;
- the returned path is the working directory for authoring, lifecycle calls, land, and handoff;
- the engine has already recorded the mechanical start, route, and worktree events.

Include recovery from the durable marker only as a resume path. Do not teach name inference from the
idea, title, branch, or directory.

### 2. Make the no-hook lifecycle sequence executable

Add a compact, canonical command pattern for hosts without structured Engineer hooks. Around each
applicable Engineer authoring step:

1. record `step_started` with the exact run id, canonical step, and provider when known;
2. run the owning workflow and its human acceptance loop;
3. record `step_completed` only with `accepted_result` or `artifact_validation` evidence;
4. record `step_skipped` with a bounded reason when track, tier, or workflow applicability skips it;
5. record `step_failed` when the host can establish failure, then `step_retried` before another
   attempt in the same run.

Map the Engineer skill's actual workflow stages to the existing lifecycle vocabulary, including the
pre-DECIDE `bootstrap`, `memory`, and `assess` stages where the canonical workflow performs them.
Avoid fabricated completion for a stage the workflow did not actually perform. Let land reconcile
only what its deterministic validation can prove.

The skill must fail closed on a lifecycle command error: preserve the worktree, report the exact
error, and do not silently continue producing invisible work.

### 3. Bind artifact names before content is authored

Change every feature-scoped output example and checklist entry so it names the returned slug:

- `.docs/specs/<slug>.md` on the product track;
- `.docs/stories/<slug>.md`;
- `.docs/plans/<slug>.md`;
- `.docs/complexity/<slug>.md`;
- `.docs/conflicts/<slug>.md` when applicable;
- `.docs/coherence/<slug>.md` when applicable.

Preserve established architecture and ADR naming contracts when they are not feature-stem families.
Before land, require an explicit filename audit against the retained slug. Do not rename unrelated
or pre-existing artifacts.

### 4. Define refusal and resume behavior

When land refuses:

- keep the current run and worktree;
- show the exact deterministic reason;
- repair only the named artifact or gate failure;
- record retry/failure transitions when they correspond to an authoring step;
- rerun land with the same path and identity.

Do not create a successor run or a fresh slug for an in-place recoverable land refusal. Terminal
failure/cancellation and later retry continue to use the existing successor-run contract.

### 5. Pin the contract with mutation-resistant checks

Extend the existing provider/skill contract shell tests with focused predicates over the entire
Engineer skill. Assert the presence and relationship of:

- parsed `engineerRunId` and returned `slug` as authoritative values;
- no-hook `run-record` start, complete, skip, fail, and retry behavior;
- the two allowed generic completion evidence values and the prohibition on tool-return proof;
- exact feature-scoped filename patterns based on the returned slug;
- keep-on-failure repair with the same run and worktree.

Use helper predicates and negative mutation fixtures where practical so a nearby mention cannot
satisfy the test accidentally. Keep current CLI lifecycle and land-spec tests as executable behavior
coverage rather than duplicating them in shell.

### 6. Align maintained documentation

Update the Engineer and lifecycle reference pages only where needed to make the host contract
discoverable and consistent with the canonical skill. Document that worktree creation emits the
mechanical transitions, the host owns no-hook authoring transitions, and land reconciles final
artifact evidence. Do not edit `CHANGELOG.md` or generated files by hand.

## Compatibility details

- Claude hooks may continue to provide structured transitions where they actually exist.
- Direct and uncommissioned Engineer runs still receive the same worktree JSON and lifecycle store.
- Existing event discriminants, revision cursors, replay, marker schema, and visualizer contracts are
  unchanged.
- Existing land validation remains the final defense when a host ignores or incompletely follows the
  skill.
- A lifecycle command failure cannot be hidden as successful authoring progress.

## Tests and verification

Run focused checks while implementing, then the full required suite from AI Conductor root:

```sh
test/test_provider_skill_contracts.sh
test/test_skill_pipeline_contract.sh
test/test_harness_integrity.sh
cd src/conductor
npm run typecheck
npm run typecheck:test
npm run lint
npm test
npm run build
```

Add or run focused Vitest coverage for `engineer-lifecycle-cli`, `land-spec`, and the agent-hosted
Engineer path if implementation touches their executable behavior. Tests must fake model, GitHub,
and third-party boundaries.

## Merge and exit criteria

- The canonical Engineer skill makes the Codex/no-hook lifecycle and slug contract executable.
- Contract tests fail for each omission reproduced by this incident.
- Existing lifecycle and land tests remain green.
- Maintained documentation agrees with the skill and CLI.
- Only AI Conductor is changed, and its pull request is reviewable and green.

## Downstream handoff

Mission Control may continue to rely on the existing event family and commission reducer. It must
not depend on wording in the Engineer skill, add duplicate lifecycle commands to its host prompt, or
infer completion from artifacts.

## Cross-phase audit record

- 2026-08-31, identity audit: the returned slug is authoritative; idea-derived short names are not.
- 2026-08-31, event audit: mechanical worktree transitions stay engine-owned; no-hook authoring
  transitions stay host-recorded through the existing validated CLI.
- 2026-08-31, completion audit: tool return remains insufficient; only accepted result, artifact
  validation, or land reconciliation may complete a step.
- 2026-08-31, repository audit: Mission Control is context-only and must remain unchanged.
