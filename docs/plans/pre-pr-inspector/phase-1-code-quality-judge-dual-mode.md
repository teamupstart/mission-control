# Phase 1: Code Quality Judge dual mode

## Outcome and value

No-Mistakes Review runs a built-in Code Quality Judge Persona after its existing deep-review stage
and before its verified Pull Request action. A failed judgment returns actionable findings to the
session through the existing Workflow repair loop. A pass allows the Pull Request action to publish
and verify the branch, after which the workflow completes without waiting for a remote review.

The existing remote service remains behaviorally unchanged and optional. Its user-facing name
becomes GitHub Inspector so an operator can distinguish its push polling, public review comments,
thread handling, and Shipping proof from the local Code Quality Judge.

The implementation task for this phase must run with Codex 5.6 Sol at xhigh reasoning effort.

## Entry criteria and dependencies

- Direct phase dependencies: none.
- Delivery dependency: the planning pull request containing
  `docs/plans/pre-pr-inspector/plan.md`, `phased-plan.md`, and this phase file must merge before the
  implementation task can start. The scheduled task carries `dependsOnCurrentSession: true`.
- The implementation starts from a default branch where No-Mistakes Review v8 is current and its
  Pull Request session action is already proven by the workflow engine.
- One repository only: this Mission Control checkout. No cross-repository merge unit is required.

## Scope

### In scope

- A compiled built-in Persona named **Code Quality Judge**, with a durable id derived from
  `personas/code-quality-judge.md`.
- An append-only No-Mistakes Review v9 whose order is checks, Intent Conformance, the existing
  parallel deep reviewers, Code Quality Judge, Pull Request, End.
- A v9 completion policy of `{ kind: "none" }`, so v9 does not enter the post-End Inspector gate.
- User-facing naming that consistently distinguishes **Code Quality Judge** from **GitHub
  Inspector** in Settings, Trust, Shipping prerequisites, Workflow final-gate surfaces, session
  status, search, alerts, and current documentation.
- Focused unit, integration, browser, and generated-source coverage for the new Persona, v9 graph,
  repair ordering, verified PR handoff, completion behavior, and renamed UI.

### Non-goals

- No change to GitHub polling, PR adoption, inline comments, replies, finding fingerprints, thread
  resolution, retry/backoff, or the Inspector review worker.
- No change to Shipping predicates or exact-head provenance.
- No local read-tool grant. Code Quality Judge is a normal Workflow Persona and receives only the
  bounded captured evidence Workflow Personas receive today.
- No new setting that injects or skips Code Quality Judge. The immutable workflow graph owns the
  local stage.
- No database migration and no rename of routes, schemas, config keys, table/column names, event
  values, CSS hooks, workflow completion kind `inspector`, or marker `mission-inspector:v1`.
- No edit to the graph, completion policy, defaults, or snapshots of No-Mistakes Review versions 1
  through 8.
- No cleanup of archived plans, reports, screenshots, or fixture prose that intentionally records
  an older version or historical product language.

## Repository findings and inherited contracts

1. `scripts/builtin-personas.ts` compiles every `personas/*.md` file except `FOREMAN.md`,
   `INSPECTOR.md`, and `README.md`. Adding `code-quality-judge.md` requires no new registry or
   schema. Run `npm run personas`; never edit
   `src/server/workflows/builtin-personas.generated.ts` by hand.
2. A built-in Persona filename is durable identity. The selected slug must remain
   `code-quality-judge`, yielding `builtin:code-quality-judge`. Future wording changes may edit the
   document but must not rename the file without a compatibility migration.
3. Workflow Personas are intentionally tool-less. `WorkflowEngine.runAttempt` calls the selected
   runner with model and timeout only. The prompt already contains raw and refined intent, recorded
   decisions, constraints, acceptance criteria, prior Persona feedback, local diff, transcript,
   standards, dirty/untracked status, and the evidence fingerprint.
4. No-Mistakes Review v8 is assembled in `src/server/workflows/builtin-workflows.ts` from the
   `NO_MISTAKES_REVIEW_V4` pipeline literal. The pipeline constant number describes graph evolution,
   while the list position creates the durable published version number. Append a new literal and a
   ninth list entry; do not refactor older stage arrays into shared mutable composition.
5. Stable node and edge ids are persisted in attempts and receipts. Add a new named node such as
   `nmr-code-quality-judge`; reuse every unchanged v8 node id. Let `compileBuiltinGraph` derive edge
   ids from route tuples.
6. `{ kind: "none" }` already has complete engine, schema, export, editor, and recovery support.
   When End passes under that policy, the submission and run complete directly. No new completion
   policy type is needed.
7. The v8 Pull Request action already runs after all prior Persona passes and reaches End only after
   it observes an open PR at the continuation's captured commit. v9 inserts Code Quality Judge before
   this action and preserves that verified publication contract.
8. The current Settings route, API routes, hooks, config, ledger, worker, and trust column all use
   stable internal `inspector` identifiers. The rename is presentation only. Hashes such as
   `#/settings/inspector` and anchors such as `inspector/enabled` remain valid.
9. Old published workflows and custom workflows may still use the `inspector` completion policy.
   Their footer, run-detail actions, wait reasons, and alerts should say **GitHub Inspector** after
   this phase, while their stored values and behavior remain unchanged.
10. Shipping still consumes the remote service's published current-head review. Its prerequisite
    copy must say GitHub Inspector, but its decision code and Inspector ledger stay untouched.

## Implementation steps

### 1. Author and compile Code Quality Judge

- Add `personas/code-quality-judge.md` with the exact level-one heading `Code Quality Judge` and a
  first paragraph that becomes its catalog description.
- Adapt the judgment goals from `personas/INSPECTOR.md` to local Workflow evidence. Keep concrete
  correctness, security, resource lifetime, error handling, compatibility, and regression-test
  concerns. Remove GitHub comment formatting, PR-thread behavior, severity theater, and any
  instruction to open repository files.
- Make the verdict discipline fit the shared `PersonaVerdict` contract: a pass names what was
  checked; every failure identifies a material reachable defect, cites supplied evidence, and asks
  for the smallest repair without expanding human scope. Treat missing context as uncertainty, not
  permission to invent a failure.
- Update `personas/README.md` from four to five compiled Workflow Personas and name the new file.
- Run `npm run personas` and commit the regenerated
  `src/server/workflows/builtin-personas.generated.ts`.

### 2. Append No-Mistakes Review v9

- In `src/server/workflows/builtin-workflows.ts`, add the durable Code Quality Judge node id and a
  new pipeline literal copied from the complete v8 pipeline, with a one-member evaluation stage for
  `builtin:code-quality-judge` between `nmr-depth-join` and `nmr-pull-request`.
- Append the ninth version entry with source draft revision 8, automatic resumption, the current
  live binding defaults, and `completionPolicy: { kind: "none" }`.
- Update only the current built-in definition's description so it accurately names five review
  roles, the Code Quality Judge before PR creation, and the absence of a required remote final gate.
  Earlier version objects and their frozen snapshots remain byte-for-byte equivalent.
- Do not alter the Pull Request action, engine, PR adapter, Inspector manager, or Shipping worker
  unless a failing regression proves the existing contract differs from the repository findings
  above. If that happens, document the discrepancy and keep the smallest compatible fix in this
  phase rather than introducing a second mechanism.

### 3. Separate the two names in user-visible product copy

- Keep component, hook, route, type, and storage identifiers named `Inspector`/`inspector` where
  they are implementation contracts. Change words a person reads when they refer to the remote
  service.
- In `src/web/lib/settings-registry.ts` and `src/web/lib/settings-search.ts`, label the category and
  its controls **GitHub Inspector** while preserving category id `inspector`, search ids, and
  anchors.
- In `src/web/components/InspectorSettingsPanel.tsx`, title the console GitHub Inspector and update
  its enablement, posture, model, trust, ledger, resolve, and brief-location prose. The panel must
  still state that `personas/INSPECTOR.md` and root `INSPECTOR.md` configure the remote reviewer.
- Update remote dependency wording in `ShippingSettingsPanel.tsx` and `TrustPanel.tsx`, plus the
  settings rail/topbar status phrases in `SettingsPage.tsx` and `App.tsx`.
- Audit other rendered remote-review strings, especially `src/shared/alerts.ts`,
  `src/shared/inspector.ts`, `src/web/useInspector.ts`, `src/web/components/session-bits.tsx`, and
  the workflow components below. Change only strings visible to the operator, not identifiers.
- In Workflow authoring and run surfaces, rename the legacy/custom completion choice and fixed
  footer to **GitHub Inspector approval** / **GitHub Inspector**. Cover
  `WorkflowProperties.tsx`, `pipeline-bits.tsx`, `WorkflowRuns.tsx`, `WorkflowLadderPeek.tsx`, and
  `run-actions.ts`; use search to catch any other rendered gate action or wait sentence.
- Do not rename historical API paths, CSS classes, state enums, database columns, event names, or
  exported TypeScript symbols merely to make source identifiers match the label.

### 4. Update current documentation without rewriting history

- Update `docs/README.md`, `docs/inspector-and-shipping.md`, `docs/skills-and-settings.md`,
  `docs/workflows.md`, `docs/workflow-system.md`, and `docs/agent-guides/architecture.md` where they
  describe the current product.
- Document No-Mistakes Review v9 as current, show Code Quality Judge before Pull Request, and state
  that workflow completion does not wait for optional GitHub Inspector.
- Preserve the v8 history: v8 still owns the authored Pull Request stage plus the post-End
  `inspector` policy. Do not rewrite archived plans, prior evidence reports, or screenshots whose
  purpose is to describe v8.
- Keep `personas/INSPECTOR.md` documented as the remote GitHub Inspector brief. Code Quality Judge
  guidance is compiled and immutable per build; GitHub Inspector guidance remains repository-owned
  runtime input.

### 5. Pin behavior and compatibility in tests

- Extend `test/builtin-personas.test.ts` and `test/builtin-personas-web.test.ts` to prove the exact
  generated source, durable id, catalog visibility, built-in read-only behavior, and displayed Code
  Quality Judge name.
- Extend `test/builtin-workflows.test.ts`, `test/builtin-workflows-store.test.ts`,
  `test/session-action-legacy-pr.test.ts`, and relevant workflow HTTP/store tests to pin:
  - every version id through `builtin-workflow:no-mistakes-review@9` resolves;
  - versions 1 through 8 retain their original graph, completion policy, defaults, and snapshots;
  - v9's exact node/edge order is deep reviewers, Code Quality Judge, Pull Request, End;
  - v9 freezes the Code Quality Judge guidance and Pull Request action snapshots;
  - v9 uses `completionPolicy: { kind: "none" }` and keeps automatic resumption/live defaults.
- Add a focused engine/manager regression that uses faked Persona and session-action execution. A
  Code Quality Judge failure must return to the session without opening the PR; a fresh repaired
  submission that passes must reach the Pull Request action; verified action completion must reach
  End and complete with no GitHub Inspector gate state.
- Update render and pure-data expectations for visible GitHub Inspector labels, including focused
  tests for the Inspector panel, settings registry/search/sidebar, Shipping warnings, Trust matrix,
  alerts, workflow properties/footer/run actions, and session status text.
- Update `e2e/specs/workflow-session-action-evidence.spec.ts` to assert and visually capture Code
  Quality Judge before Pull Request and the absence of a post-End footer in the current built-in.
  Update `e2e/specs/inspector-brief-location.spec.ts` to assert the **GitHub Inspector** panel and
  switch while retaining both brief paths. These specs must use the fake agents and fake `gh` path;
  no model tokens and no GitHub writes.

## Data, API, migration, and compatibility details

- Database: no schema or data migration.
- HTTP/SSE: no route or payload changes. `/api/inspector/*`, `inspector_*` events, and settings
  status fields stay stable.
- Configuration: no key changes. Existing enable, dry-run/live, provider/model, and repository
  allowlist values continue to configure GitHub Inspector.
- Workflow persistence: retain completion kind `inspector` and all historical built-in ids. Add
  only `builtin:code-quality-judge`, `nmr-code-quality-judge`, and built-in workflow version 9.
- GitHub marker: retain `mission-inspector:v1` parsing and writing exactly as-is.
- Packaging: the generated built-in Persona module carries Code Quality Judge; no new runtime asset
  is required. `personas/INSPECTOR.md` packaging behavior stays unchanged.
- Shipping: no predicate changes. It continues to require a published clean GitHub Inspector review
  of the exact current PR head.

## Verification

Run from the repository root with Node.js 24 or newer. Single-file node tests must retain the
required preload.

```sh
npm run personas
node --test --import ./test/setup-state.mjs --import tsx test/builtin-personas.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/builtin-personas-web.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/builtin-workflows.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/builtin-workflows-store.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/session-action-legacy-pr.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/inspector-panel.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/shipping-panel-warnings.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/trust-panel.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-search.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-sidebar-render.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-builder-render.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/workflow-session-action-evidence.spec.ts e2e/specs/inspector-brief-location.spec.ts
npm run test:e2e
```

Also perform a rendered-text audit after the focused tests:

- search current source and current docs for user-facing bare `Inspector` labels and classify each
  remaining occurrence as an internal compatibility name, historical statement, or defect;
- visually inspect the No-Mistakes Review pipeline at desktop width and confirm Code Quality Judge,
  Pull Request, and End remain legible in order;
- visually inspect Settings, Shipping prerequisites, Trust, and a legacy/custom GitHub Inspector
  final gate; and
- attach screenshots and transcripts from successful Playwright evidence runs to the pull request,
  never to the repository.

## Merge and exit criteria

- One reviewable pull request lands the whole vertical slice. Do not merge a state that introduces
  Code Quality Judge without the matching GitHub Inspector distinction, or vice versa.
- Generated Persona bytes match the authored Markdown.
- No-Mistakes Review v9 is current and operable, and v1 through v8 compatibility tests pass.
- A failed Code Quality Judge blocks PR creation through the existing repair loop; a pass precedes
  the verified Pull Request action; End completes without a remote final gate.
- GitHub Inspector still polls, reviews, comments, resolves, records exact-head provenance, and
  feeds Shipping exactly as before when enabled.
- All current user-facing surfaces use Code Quality Judge for the local stage and GitHub Inspector
  for the remote service, while stable internal identifiers remain untouched.
- Relevant focused checks, full unit suite, typecheck, lint, build, smoke, and full Playwright suite
  pass. Required visual evidence is attached to the implementation pull request.

## Downstream handoff

This is the only implementation phase. After it merges, future work may rely on:

- `builtin:code-quality-judge` as the shipped local review Persona id;
- `builtin-workflow:no-mistakes-review@9` as the current dual-mode workflow version;
- Code Quality Judge owning local pre-PR judgment and the normal Workflow repair loop;
- GitHub Inspector remaining the existing optional remote service and sole source of its exact-head
  review/Shipping proof; and
- every existing `inspector` storage and wire identifier remaining compatible.

Future retirement of GitHub review behavior, a neutral PR observer, local commit attestations, or
privileged Persona tools is a new product decision. It must not be smuggled into maintenance of this
phase.

## Cross-phase audit record

- 2026-08-15, initial audit: the approved dual-mode choice, Code Quality Judge name, GitHub
  Inspector name, immutable workflow ownership, tool-less Persona constraint, verified Pull Request
  action, optional remote behavior, Shipping preservation, docs, tests, and e2e evidence are all
  owned by this phase.
- 2026-08-15, dependency audit: there are no later phases and no cross-repository consumers. One
  phase avoids an intermediate product state with ambiguous Inspector naming or a default workflow
  that changes completion semantics without explaining them.
