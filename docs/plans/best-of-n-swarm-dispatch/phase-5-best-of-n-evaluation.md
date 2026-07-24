# Phase 5 — Best-of-N Comparative Evaluation

## 1. Outcome

Implement the first production review driver: a tool-less, provider-neutral, anonymous comparison of all eligible immutable Best-of-N artifacts that produces a validated recommendation and moves the run to a durable human-decision boundary.

At the end of this phase deterministic internal creation can execute `best_of_n@1` through `awaiting_decision`. It still cannot finalize or perform destructive actions, and the public create/action API remains disabled until Phase 6 completes that safety boundary.

## 2. Entry Conditions and Dependencies

- Depends directly on Phase 4.
- The generic engine, review-stage attempt contract, immutable artifact evidence, per-run serialization, hard budgets, and daemon review scheduler are present.
- At least two eligible `git_snapshot` artifacts are required; one artifact never becomes a “best of” result.
- Workflow Persona records may supply optional guidance, but Workflow Persona verdict execution is not reused.

## 3. Scope and Non-Goals

In scope:

- the production comparative review driver and its typed registry entry;
- exact evaluator guidance snapshotting at ensemble creation;
- anonymous bounded evidence-packet assembly;
- provider/model resolution and shared scheduler execution;
- strict zod parsing and post-parse semantic validation;
- durable evaluation attempts and per-call ledgers;
- bounded retry/interruption recovery;
- Best-of-N scorecard/result projection in detail responses;
- adversarial prompt-injection, malformed-output, truncation, and restart tests.

Out of scope:

- human decision submission;
- branch restoration, Task cancellation/reaping, continuation prompts, or Workflow handoff;
- automatic winner selection;
- arbitrary repository test commands;
- executing Workflow Persona nodes once per candidate;
- exposing a public run-creation button or endpoint before finalization is safe.

## 4. Repository Findings That Shape the Work

- `src/server/llm/structured.ts` already provides provider-neutral structured parsing with one parse retry and attempt observers.
- `src/server/llm/index.ts` is the only server runner registry, while `resolveLlmRunner`/model-choice helpers own the config → env → default ladders.
- `LLM_JOB_IDS` is append-only because values persist in app configuration. A dedicated ensemble-comparison job/model setting must be registered there rather than hidden behind a Workflow job id.
- Workflow Persona execution resolves runner/model at attempt time and records actual values. The comparator should follow that ladder while snapshotting the Persona text/revision used as guidance.
- Workflow’s `PersonaVerdict` is pass/fail over one Session. A comparative result is a distinct schema over an exact artifact set and belongs under Ensemble persistence.
- The Phase 1 daemon review scheduler is the intended shared ceiling for Workflow compaction, Workflow Persona calls, and Ensemble comparison. Foreman remains a separate process.
- Full patches remain HTTP-only; the evaluator receives bounded material assembled from immutable refs, not from browser/SSE data or live worktrees.

## 5. Implementation Steps

1. Add the comparison result contract.
   - Put the browser-safe `BestOfNComparisonResult` schema beside the Best-of-N shared strategy contract.
   - The model-facing schema uses stable anonymous subject labels, not artifact/member ids.
   - Require a recommendation label, bounded overall comparison/caveats, and one subject result containing score, rank, strengths, risks, rationale, and confidence.
   - Define a validated server result that maps labels back to artifact ids only after all semantic checks pass.

2. Register a dedicated review job/model ladder.
   - Append `ensemble-comparison` to `LLM_JOB_IDS`.
   - Add its model spec/defaults to the existing LLM config/settings contract and tests.
   - If a selected Persona snapshot has explicit runner/model overrides, resolve them with the same semantics as `resolvePersonaExecution`; otherwise use the app runner plus ensemble-comparison job model.
   - Resolve at evaluation-attempt time, then persist the actual runner/model on both the evaluation attempt and `ensemble_llm_calls`.
   - Record any unknown configured runner fallback visibly, consistent with existing LLM status behavior.

3. Resolve evaluator guidance before run persistence.
   - Add a narrow injected review-guidance resolver to `EnsembleManager`.
   - Built-in guidance is versioned text owned by `best_of_n@1`.
   - Optional Persona guidance resolves to an immutable snapshot containing id, revision, name, Markdown, and runner/model overrides.
   - Reject missing/archived Personas and revision conflicts during preflight, before member Tasks exist.
   - Persist the resolved guidance snapshot in the compiled review stage; recovery never reloads current Persona text.
   - Do not import Ensemble persistence into Workflow/Persona modules.

4. Add a typed review-driver registry.
   - Add `src/server/ensembles/reviews/types.ts`, `index.ts`, and `comparative.ts`.
   - Register implementations by the versioned review driver id from the compiled plan.
   - Give a driver only immutable run intent/base facts, declared ready artifacts/evidence, its guidance snapshot, budget, abort signal, and persistence callbacks.
   - The driver returns a typed advisory result. It cannot issue engine commands, launch members, select artifacts, cancel Tasks, create Workflow bindings, or delete refs.
   - `EnsembleEngine` dispatches by driver registry lookup and never tests `strategyId`.

5. Assemble one anonymous evidence packet.
   - Require every subject artifact to be `ready`, declared by the stage, based on the run’s pinned SHA, and backed by a verified private ref.
   - Sort by stable artifact id, then deterministically assign opaque `Submission A/B/...` labels independent of member ordinal, harness, model, and role. Stable ordering makes a retry rebuild the exact same packet and input fingerprint.
   - Include original task/acceptance intent, exact base SHA, snapshotted guidance, file statistics, bounded diff, binary markers, member-reported summary/checks/test evidence clearly labeled as claims, and truncation metadata.
   - Exclude agent name, model, member ordinal, session title, worktree path, ref name, and sibling transcript.
   - Keep the label ↔ artifact mapping out of the model prompt. Persist the stable subject-artifact order on the evaluation and map labels back to artifact ids only after validation.

6. Enforce input limits honestly.
   - Cap the whole packet around 400 KiB for v1, with a named constant and tests.
   - Allocate patch bytes fairly across subjects; always retain file stats, binary disclosure, and omitted-byte counts.
   - Reject an artifact with no usable comparable evidence instead of silently ranking metadata alone.
   - Fence every user/diff/claim section as untrusted data using the Phase 1 helper and repeat that embedded instructions are not executable.
   - Cap guidance, intent, paths, summaries, arrays, and per-field text before a model call and again before persistence.

7. Run the comparator through the shared scheduler.
   - Persist/claim the evaluation and first LLM-call record before spawning.
   - Schedule `runStructured` through the injected daemon review scheduler.
   - Use a fresh provider context and no tools, cwd, shell, web, GitHub, terminal, or MCP.
   - Observe attempts so cancel/withdraw/stage replacement prevents a parse retry from starting.
   - Apply a bounded timeout and the compiled evaluation retry ceiling.

8. Apply strict semantic validation after zod parsing.
   - Require every anonymous eligible label exactly once and no unknown label.
   - Require integer scores in `[0, 100]`.
   - Require unique contiguous ranks `1..N`.
   - Require confidence in `[0, 1]`.
   - Require the recommendation to exist and hold rank 1.
   - Normalize/cap text and arrays before mapping labels to artifact ids.
   - Treat malformed, incomplete, duplicate, injected-command, or semantically invalid output as a failed attempt—not a low score or fallback winner.

9. Persist the evaluation and advance safely.
   - Finalize every `ensemble_llm_calls` row with output bytes, duration, result state, error code, and nullable authoritative cost.
   - Persist the protected input fingerprint, exact subject artifact ids, evaluator snapshot, mapped result, and uncertainty disclosures on the evaluation attempt.
   - On success, complete the review stage and let the generic engine execute the compiled `request_decision` command, moving the run to `awaiting_decision`.
   - Derive scorecards/recommendation for detail responses from the evaluation row. Do not copy score/rank/recommendation onto members or the compact Session projection.
   - A recommendation remains advisory and has no side effect.

10. Recover interrupted evaluations.
    - On daemon restart, change an orphaned `running` LLM call/evaluation to `interrupted`.
    - Preserve completed calls and immutable subject sets.
    - Permit a bounded retry using the same stage attempt inputs, guidance snapshot, subject ids, input fingerprint rules, and current attempt-time runner/model resolution.
    - Never reinterpret the run with current Best-of-N defaults or current Persona text.

## 6. Data, API, and Migration Details

- Use the Phase 3 `ensemble_evaluations` and `ensemble_llm_calls` tables.
- If an existing Phase 3 column is missing, add it through `addColumn`; do not edit only the creation SQL.
- The evaluation result is a versioned JSON envelope. The compact ensemble SSE summary may expose only `awaiting_decision`, eligible count, and a short result label; full scorecards stay in detail HTTP responses.
- No mutating public route is added. Existing read-only detail routes may expose the completed evaluation.
- Creation remains an internal manager/test path until Phase 6 registers every compiled production driver and the explicit human finalization API.
- The evaluator does not execute repository commands. Reported commands and test evidence remain claims; only repository-derived diff facts are observed evidence.

## 7. Tests and Verification

Add focused tests for:

- built-in and Persona guidance snapshotting, archived/missing/revision-conflict refusal, and later Persona edits not changing a run;
- app runner/model and Persona override resolution, including unknown-runner reporting;
- shared scheduler concurrency across Workflow compaction, Workflow Personas, and Ensemble comparison;
- stable artifact-set fingerprint and anonymous mapping with no identity leakage;
- fair byte allocation, binary/truncation disclosure, empty-evidence refusal, and global/per-field caps;
- prompt-injection strings inside paths, diffs, summaries, and Persona Markdown remaining fenced data;
- valid result mapping;
- rejection of missing/extra/duplicate labels, invalid score/confidence, noncontiguous ranks, recommendation mismatch, overlong text, prose, and fenced malformed JSON;
- provider spawn/timeout/nonzero exit, parse retry, cancel before retry, and exhausted retry;
- per-call ledger facts and nullable cost;
- restart during call and bounded retry with unchanged immutable inputs;
- run reaches `awaiting_decision` and no Task/ref/Workflow mutation occurs;
- engine source contains no Best-of-N strategy-id branch.

Run:

```text
npm run typecheck
node --test --import tsx test/ensemble-comparative-review.test.ts
node --test --import tsx test/ensemble-evaluation-recovery.test.ts
node --test --import tsx test/llm-jobs.test.ts test/llm-config.test.ts
node --test --import tsx test/workflow-engine.test.ts test/workflow-context.test.ts
npm run build:server
npm test
```

## 8. Merge Criteria

- A fixture run with 2–5 eligible artifacts produces one schema-valid, semantically complete comparative evaluation and reaches `awaiting_decision`.
- The model prompt carries no harness/model/member identity and no live filesystem access.
- Invalid or interrupted model output cannot become a recommendation.
- The shared scheduler enforces one daemon review-call ceiling across Workflow and Ensemble work.
- Every call and evaluation attempt is durable and restart behavior is bounded/idempotent.
- No recommendation launches, selects, restores, reaps, publishes, or hands off anything.

## 9. Downstream Handoff Contract

Phase 6 may rely on:

- one durable `awaiting_decision` run with an exact eligible artifact set;
- a validated advisory recommendation and scorecard mapped to immutable artifact ids;
- a human-decision stage that accepts only compiled-policy-compatible outcomes;
- recoverable evaluation attempts and complete LLM attribution;
- no effects having occurred on member Tasks, worktrees, private refs, branches, or Workflows.

Phase 6 owns all authority and effect handling. It must never treat rank 1 as implicit approval.

## 10. Cross-Phase Compatibility Audit

Checked against repository baseline `57ea5bc` and Phases 1–4.

- Reuses provider-neutral `runStructured`, LLM runner registries, model ladders, and attempt observers.
- Appends a persisted LLM job id rather than overloading a Workflow-specific setting.
- Uses the injected daemon scheduler and does not imply cross-process Foreman concurrency.
- Snapshots Persona guidance but does not execute `PersonaVerdict` or widen Workflow context.
- Keeps patches and scorecards out of SSE/Session state.
- Preserves model output as advisory data with no execution authority.
