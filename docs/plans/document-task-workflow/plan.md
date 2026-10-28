# Document tasks and Documentation Review

Status: implementation authorized; fresh review after repairs selected.

## Intent and scope

- Implement the approved documentation-verification concept in this checkout. Add the document task kind, Documentation Review as its default workflow, and two new built-in Personas: Documentation Consistency Judge and Conciseness & Reference Judge. Keep Documentation Steward as the authority for accuracy and placement.

- The global default task kind remains ship. Explicit workflow choices and None continue to win. Documentation is a reviewable, backlog-eligible, harness-launched task whose initial turn ends before commit, push, PR, and CI. This task implements and verifies locally, then hands off to Mission Control.

- Optional Reader Journey and Example & Procedure judges are deferred. Do not change release/CI configuration or clean up unrelated documents. Do not commit the earlier report.html or evidence. No separate phase tasks are requested: the operator explicitly asked to plan and implement here.

## Acceptance criteria

- AC1: document is offered through registry-driven task surfaces, accepted by the API and durable stores, supports per-kind model defaults and scheduling, and produces a reviewable diff.

- AC2: omitted workflow selection resolves to Documentation Review; explicit choices and None survive kind switches and persistence. Other kinds retain their defaults.

- AC3: Documentation Review runs a configurable documentation Check, Intent Conformance, then Documentation Steward, Documentation Consistency, and Conciseness & Reference together behind an All-pass Join, then the existing verified Pull Request action.

- AC4: the documentation Check uses the existing command catalog, repository overrides, trust, process supervision, and Not run behavior. No generic npm command or full test suite is hard-coded.

- AC5: both new judges have non-overlapping, evidence-grounded guidance. Consistency compares relevant current documents; Conciseness asks for useful reductions and precise references without word quotas. Historical documents, essential context, and unrelated pre-existing debt are handled explicitly.

- AC6: delivered document task instructions establish documentation scope, one-owner reference policy, focused verification, completion handoff, and current complete document/reference evidence for tool-less Personas. Dispatch and live assignment share the existing contract composer.

- AC7: the repair-review choice below is carried through persistence, graph editing and execution if selected; legacy graphs retain their current behavior.

- AC8: focused unit/integration tests, browser coverage, typecheck, lint, build, and bundle smoke pass; documentation and generated Persona bytes match the implementation. Register current evidence before handoff.

## Architecture and compatibility

- Extend TASK_KINDS append-only and the existing exhaustive registries in src/shared/task.ts, task-completion.ts, task-contract.ts, mission-mcp.ts, archive mapping, Foreman wrap-up and guided dispatch. Reuse the default workflow resolver and shipping completion path; do not add a parallel task lifecycle.

- Append the documentation command slot to WORKFLOW_CHECK_SLOTS and its purpose registry. Existing command storage seeds catalog slots from that tuple and uses the current command supervisor. This is a configured gate, not built-in Markdown parsing or implicit command execution.

- Author new Persona sources in personas/ and regenerate through npm run personas. Do not change shipped Persona guidance or old workflow graphs; this avoids silently revising existing bindings. The new workflow freezes its own new version and uses current repository model routing.

- Document tasks exempt their intentional documentation diff from the review-artifact classifier, like plan tasks, and use existing PR shepherding. They do not receive scout archives or plan-only publication behavior.

- Evidence follows the existing submit_workflow_evidence transport. The new contract requests current changed document text plus complete relevant sections from unchanged owners, inventories, scope, hashes/revisions, and completed focused checks. Missing context is disclosed; it is not fabricated into a substantive defect.

- Adopted repair policy: the operator selected Fresh review after repairs. Add an optional recheckAfterRepair flag to Persona nodes, preserve it through draft/published schemas, stage projections, publication and UI edits, and have the generic engine skip pass reuse for flagged nodes. Enable it on the new workflow only; absence preserves legacy behavior.

## Implementation sequence

- 1. Add failing focused assertions for document-kind registry/default/completion behavior and a browser spec for choosing document, preserving None, listing the new workflow and judges, and configuring the documentation command.

- 2. Extend the kind and completion registries. Add a concise document contract and evidence appendix using the existing task composer. Cover API creation, persistence, live-assignment composition, per-kind defaults, and wrap-up eligibility.

- 3. Write the two Persona sources, append the documentation Check slot, and define the new built-in workflow with stable node/edge identities, current model routing, automatic resumption, and a bounded repair budget. Regenerate Persona output.

- 4. Implement fresh review after repairs. Cover schema rejection, legacy omission, stage/publish round trips, graph and pipeline controls, and engine behavior across repair rounds while the machine reuse policy is enabled.

- 5. Update the authoritative workflow/task documentation and Persona index. Replace adjacent outdated summaries with links where appropriate instead of copying the detailed new contract across guides.

- 6. Run focused tests, typecheck and lint; build; run smoke and relevant Playwright specs with fake agents. Inspect rendered UI screenshots, fix failures, register the exact final output and screenshots, and hand off without committing or opening a PR.

## Validation and evidence

- Unit/integration coverage: task-kinds, task-kind persistence/defaults/creators, task-completion, document prompt, built-in workflows and store, command catalog/config/store, generated Persona drift, and Foreman wrap-up. Add focused repair-policy coverage for the selected fresh-review behavior.

- Browser coverage: new document-kind workflow spec plus affected review presets, command library, and registry option-count assertions. Use roles, labels and placeholders; use expectContentClearsBorder for opened modals. All harness paths remain faked.

- Run npm run typecheck, npm run lint, npm run build, npm run smoke, and npm run test:e2e with the affected spec paths. Run Node tests with the required setup-state preload. No new tests should merely assert prose constants when behavior or a graph path can be exercised.

- Keep plan evidence, command logs and successful UI screenshots under gitignored .evidence/ or e2e/.artifacts/. Register coverage for AC1-AC8 with exact completed command output, report the honest scope of each check, and retain the full saved plan Markdown for the next Persona.

## Grounding and decisions

- The operator approved the three-judge concept and requested planning plus implementation in this checkout. Managed plan policy is repository storage with commitPlanHtml=false. Repository plans and the complete managed catalog were checked; no dedicated documentation-verification plan was discovered.

- Verified source owners: src/shared/types.ts: TASK_KINDS; src/shared/task.ts: taskDefaultWorkflowId and exhaustive kind registries; src/server/task-contract.ts: both delivery seams' common composer; src/shared/workflow.ts: command slots and graph contracts; src/server/workflows/builtin-workflows.ts: append-only catalog; src/server/workflows/engine.ts: machine-level pass reuse; personas/documentation-steward.md and personas/slop-filter.md: current review boundaries.

- The earlier report is context, not shipped code or a pinned implementation input. All implementation will follow current source and repository contracts. The operator selected Fresh review after repairs through Mission Control request_input. This revision records that decision before its dependent implementation.
