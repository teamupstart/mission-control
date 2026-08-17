# Phased implementation: preauthorized PR and workflow actions

Status: Ready to publish

## Source plan and approved decisions

- Source: [`plan.md`](plan.md)
- Approved on 2026-08-17.
- The PR and workflow-evidence authorization is an always-on Mission Control execution contract. There is no setting or opt-out UI.
- Produce a phased implementation plan and schedule its implementation after these artifacts are committed and pushed.

## Repository investigation

The implementation has one shared policy and two delivery families.

### Initial task delivery

`src/server/task-contract.ts` composes the delivered task text through `withTaskKindContract`. Fresh dispatch in `src/server/dispatcher.ts` and assignment in `src/server/tasks.ts` both use that composer, so changing it reaches both task entry paths without adding another source of truth.

The existing contract deliberately returns a ship task's intent byte-identically when it has no workflow-evidence appendix. That historical invariant is pinned in `test/scout-prompt.test.ts`, `test/plan-prompt.test.ts`, and `test/task-assign.test.ts`. The approved behavior intentionally replaces it with a narrower invariant: the operator's intent remains the exact prefix, followed by the Mission Control authorization and any more-specific kind contract.

`src/server/workflows/agent-contract.ts` owns the existing evidence appendix for Persona-backed ship workflows. It already names `submit_workflow_evidence`, gitignored artifacts, repository slots, and no-commit behavior. It needs explicit authorization for the issued payload and destination plus the no-resubmit rule, while the tool and daemon continue to enforce the actual boundary.

### Workflow continuations

`src/server/workflows/feedback.ts` renders every daemon-authored execution turn after the opening task:

- Persona repair through `renderWorkflowFeedback`;
- Inspector repair through `renderInspectorFeedback`;
- unchanged-evidence nudges through `renderUnchangedEvidenceNudge`;
- the legacy PR handoff through `renderPrHandoff`;
- authored workflow and on-demand Retro actions through `renderSessionAction`.

`finalizePacket` preserves its final instruction and truncation notice when the body exceeds the 8,000-byte feedback budget. The new authorization must join that guaranteed suffix so truncation cannot remove the rule that prevents another stop.

SessionAction Markdown is different. A published workflow stores `SessionActionSnapshot.promptMarkdown` as immutable authored bytes, and `renderSessionAction` refuses rather than truncates a packet over 60,000 bytes. The runtime envelope currently consumes a 2,000-byte allowance and places the authored Markdown at the end of the packet. The authorization belongs in that envelope before the snapshot, preserving both the exact stored Markdown and the property that it remains the packet's final instruction. The existing envelope headroom is expected to cover the short authorization block; the durability tests must measure that explicitly.

Editing `actions/pull-request.md` would change the built-in action that No-Mistakes Review v8-v10 snapshot. This phase must not edit or regenerate that source, and it must not append a workflow version. The platform envelope applies to newly rendered deliveries while already-prepared durable delivery rows retain their stored payload.

### Capability boundary

`src/server/mission-mcp.ts`, `src/server/ask-channel.ts`, and the Codex launch adapters already register and preapprove the required MCP tool at launch. `WorkflowManager.stageAgentEvidence` still attributes the live session server-side and validates the active Persona binding, issued repository root, relative path, type, and bounds. This phase changes prompt authority only. It must not change sandbox posture, MCP registration, evidence schemas, routes, or storage.

## Compatibility decisions

- Preserve the original human intent as the exact prefix of every delivered task prompt.
- Place broad PR authorization before more-specific task-kind contracts so a scout's later no-PR rule remains authoritative.
- Preserve `SessionActionSnapshot.promptMarkdown` byte-for-byte and at the end of its packet. Add policy only to the runtime envelope.
- Preserve old durable delivery payloads. New code changes only newly rendered turns.
- Keep No-Mistakes Review v1-v10 and `actions/pull-request.md` unchanged.
- Keep all MCP, sandbox, evidence-validation, and repository-scope enforcement unchanged.
- Treat resubmission as engine or Runs UI ownership. The agent repairs, stages new evidence when useful, and stops without asking the human to resubmit.

## Sizing and phase-count rationale

Estimated non-test production change: **90-160 lines**.

Assumptions:

- one small server-side authorization renderer;
- a focused composition change in `task-contract.ts`;
- short evidence-contract wording changes;
- focused integration into workflow feedback finalization and SessionAction envelopes;
- no schema, migration, UI, MCP, or workflow-graph changes.

This estimate is below the 200-line threshold, so the implementation is exactly one phase and one one-shot task. Splitting initial task prompts from workflow continuations would leave one class of Codex stops unfixed between merges and create two review units for one wording contract. Tests and documentation land with the behavior they verify.

## Phase table

| Phase | Outcome | Direct prerequisite | Estimated production lines | Implementation plan |
|---|---|---|---:|---|
| 1 | Agents act directly on already-scoped PR and workflow-evidence instructions without requesting duplicate permission | This planning session's pull request merged | 90-160 | [`phase-1-preauthorize-agent-actions.md`](phase-1-preauthorize-agent-actions.md) |

## Dependency graph and merge order

```text
Planning session PR merged
  -> Phase 1: preauthorize agent actions
```

There are no parallel implementation groups and no cross-repository phase. The planning pull request publishes the paths the task names. Phase 1 starts only after that merge, then produces the single implementation pull request.

## Cross-phase contracts

There is only one implementation phase. Its internal contract is still explicit:

- the central authorization renderer owns the wording;
- task and workflow prompt families consume that renderer rather than copying prose;
- narrow task and action instructions remain later and authoritative;
- capability enforcement remains outside the prompt.

No later phase may be assumed to repair a temporary prompt or compatibility gap.

## Final verification strategy

Phase 1 must run the focused task-contract, assignment, workflow-feedback, SessionAction, and Mission MCP tests named in its phase file, then the full unit suite, typecheck, lint, build, and bundle smoke. The implementation has no dashboard UI surface, so no new Playwright spec is required.

The implementation pull request is reviewable when it demonstrates all of the following:

- all task kinds receive the shared conditional authorization while preserving the original intent prefix;
- scout no-PR and SessionAction no-merge rules still win;
- evidence registration names issued paths and scopes as already authorized;
- workflow packets never ask the human to resubmit;
- truncation retains the authorization;
- frozen workflow and SessionAction source bytes are unchanged;
- no sandbox or MCP capability was widened.

## Cross-phase audit record

- 2026-08-17: Audited the approved root plan against task delivery, workflow feedback, SessionAction durability, MCP launch preapproval, and workflow resumption ownership. One phase owns every approved requirement.
- 2026-08-17: Reconciled the proposed PR-action wording with append-only workflow contracts. Runtime envelope composition replaces an edit to `actions/pull-request.md`, so published No-Mistakes versions remain unchanged.
- 2026-08-17: Rechecked the one-phase boundary. The production estimate remains below 200 lines, no independent merge boundary reduces risk, and all consumers depend on the same wording contract.
