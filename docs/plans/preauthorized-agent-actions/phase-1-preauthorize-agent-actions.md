# Phase 1: preauthorize agent actions

## Outcome and value

Mission Control-delivered execution prompts make the operator's existing authorization explicit. An agent creates or updates a pull request when its scoped task or workflow asks for one, registers eligible workflow evidence with the issued file locator and repository scope, and completes a repair without asking the human for a second approval or for workflow resubmission.

This eliminates the observed Codex stall while preserving every existing repository, evidence, sandbox, no-PR, and no-merge boundary.

## Entry criteria and direct dependencies

- Direct dependency: the planning session's pull request is merged to the default branch.
- Read first:
  - `docs/plans/preauthorized-agent-actions/plan.md`;
  - `docs/plans/preauthorized-agent-actions/phased-plan.md`;
  - this phase file;
  - root `AGENTS.md`, `docs/agent-guides/architecture.md`, and `docs/agent-guides/change-contracts.md`.
- Confirm the three plan paths resolve on the default branch before editing.
- Confirm the worktree is clean or identify and preserve unrelated user changes.

There are no earlier implementation phases and no cross-repository dependencies.

## Scope

- Add one server-owned renderer for conditional PR, workflow-evidence, and workflow-resubmission authorization language.
- Apply it to all task kinds through the existing task contract composer used by dispatch and assignment.
- Strengthen the Persona workflow evidence appendix with explicit scoped tool-call authorization.
- Apply the same policy to newly rendered Persona, Inspector, unchanged-evidence, legacy PR, workflow SessionAction, and on-demand SessionAction packets.
- Preserve truncation behavior, SessionAction packet bounds, frozen authored Markdown, and prepared-delivery durability.
- Update focused unit tests and operator documentation.

## Explicit non-goals

- No setting, opt-out, new Settings category, or dashboard UI.
- No Playwright spec because the approved change has no user-visible dashboard surface.
- No MCP tool, schema, route, storage, or allowlist change.
- No Codex full-access posture, global approval bypass, or automatic answer to arbitrary permission prompts.
- No edit to `actions/pull-request.md` or its generated module.
- No new or rewritten No-Mistakes workflow version.
- No database migration.
- No automatic PR creation or automatic evidence discovery by the daemon. The agent still acts only when its task or workflow calls for the action.
- No authorization to merge.

## Repository findings and inherited contracts

### Task contract ownership

`withTaskKindContract` in `src/server/task-contract.ts` is the only composer shared by the two ways a task intent reaches an agent. `src/server/dispatcher.ts` supplies the multi-repository manifest and workflow-evidence eligibility before calling it; `src/server/tasks.ts` calls it when assigning a task to a live session. Do not add authorization at either call site.

The current comments and tests claim ship intents remain byte-identical. That is intentionally superseded. The new stable contract is:

1. exact operator intent prefix;
2. shared conditional authorization;
3. more-specific kind contract;
4. eligible workflow-evidence instructions.

The last applicable instruction remains the narrowest one. In particular, the scout contract's `Do NOT open a pull request` must remain after the broad statement that PR creation is authorized only when another instruction asks for it.

### Workflow evidence ownership

`workflowEvidenceContractAppendix` in `src/server/workflows/agent-contract.ts` is added only for ship tasks whose selected current immutable graph contains a Persona. `kindMissionMcpRequirement` already requires `submit_workflow_evidence` for the same eligibility. Do not broaden the tool to tasks without that binding.

The appendix must state that the operator already authorizes the exact class of server-validated call: task-produced, checkout-relative artifacts, the repository slot issued in the task, and `repositoryScope: "all"` only when issued. It must tell the agent to call directly, not request approval for the payload or Mission Control destination, and not ask the human to resubmit the workflow.

### Workflow packet ownership

`finalizePacket` in `src/server/workflows/feedback.ts` owns the suffix preserved through deterministic truncation. Compose the execution authorization into that suffix rather than the truncatable evidence body.

`renderSessionAction` deliberately bypasses `finalizePacket`. Keep the skill invocation first, insert platform authorization in the runtime envelope, and keep sanitized `promptMarkdown` as the final exact bytes. Do not mutate the snapshot and do not append policy after it.

`WORKFLOW_LIMITS.sessionActionEnvelopeBytes` is 2,000 bytes and already reserves headroom around a maximum 58,000-byte prompt in a 60,000-byte packet. Keep the authorization concise and update the durability test's envelope calculation to include its UTF-8 size. If the measured envelope no longer fits, reduce or restructure the platform wording rather than loosening the packet limit or silently shrinking an existing persisted contract.

### Capability boundary

Mission MCP launch registration and preapproval are already covered by `test/mission-mcp.test.ts`. `WorkflowManager.stageAgentEvidence` remains the authority for live-session attribution, selected Persona binding, issued roots, paths, types, and limits. Prompt authorization must never claim that the agent can bypass those checks.

### Resubmission boundary

Automatic workflow versions resume through the daemon's resumption observer after repository bytes or staged evidence change. Manual and Preview versions remain controlled in the Runs UI. The common agent instruction is therefore procedural, not a claim that every workflow auto-resumes: repair the work, register new evidence if useful, stop, and do not ask the human to resubmit.

## Implementation steps

1. Add a focused server module near the task and workflow prompt owners that renders the authorization from explicit context. Keep exact policy prose in this one module. Include constants or narrow helpers if they make the UTF-8 envelope cost directly testable.
2. Update `src/server/task-contract.ts` to compose the shared authorization for every task kind without changing the operator's intent prefix. Revise the comments that promise byte-identical ship delivery and document the new ordering contract.
3. Update `src/server/workflows/agent-contract.ts` so Persona workflow evidence includes explicit permission for issued locators and scopes, direct tool use, and no request for resubmission. Reuse the shared renderer or its evidence-specific arm rather than duplicating a second policy paragraph.
4. Update `src/server/workflows/feedback.ts` so every daemon-authored workflow continuation receives the appropriate policy:
   - keep it in the non-truncatable suffix for normal feedback renderers;
   - provide evidence eligibility where the renderer needs to decide whether to name the tool;
   - put runtime authorization before frozen SessionAction Markdown;
   - keep the authored Markdown as the final exact bytes;
   - retain current sanitization, hashing, byte limits, and refusal behavior.
5. Thread only the minimum eligibility facts from `WorkflowManager` call sites that already hold the immutable version. Do not make renderers query stores or introduce a new workflow capability source.
6. Update tests:
   - replace byte-identical ship assertions with exact-prefix plus authorization assertions in `test/scout-prompt.test.ts`, `test/plan-prompt.test.ts`, and `test/task-assign.test.ts`;
   - cover all task kinds and prove scout no-PR ordering;
   - cover scoped evidence wording and prove `kindMissionMcpRequirement` remains unchanged;
   - cover normal and truncated feedback, Inspector feedback, unchanged-evidence nudges, legacy PR handoffs, workflow SessionActions, and on-demand Retro SessionActions;
   - prove `promptMarkdown` remains the final exact bytes and that the expanded envelope stays within its reserved budget;
   - keep control-character sanitization and exact payload hashing assertions green.
7. Update `docs/sessions.md` and `docs/workflows.md` with the operator-visible contract. Explain that prompt authorization differs from sandbox approval posture and does not authorize merge or arbitrary external writes.
8. Review the final diff for accidental edits to `actions/pull-request.md`, generated action sources, built-in workflow graphs, MCP registration, protocol schemas, and Settings/UI files.

## Data, API, migration, and compatibility details

- Data model: unchanged.
- HTTP and MCP API: unchanged.
- Database migration: none.
- Persisted identifiers: unchanged.
- Workflow graph and published version ids: unchanged.
- SessionAction snapshot bytes: unchanged.
- Existing prepared workflow delivery payloads: unchanged in storage and replay.
- New task and workflow deliveries: include the authorization at render time.
- Backward compatibility: installations with older tasks or workflow bindings receive the policy on their next newly rendered execution turn without rewriting historical rows.

## Tests and verification commands

Run focused tests first:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/scout-prompt.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/plan-prompt.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-assign.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-feedback.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-inspector-feedback.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-security.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/session-action-durability.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/retro-session-action.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/mission-mcp.test.ts
```

Then run the repository gates:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
```

No new Playwright spec is required because no dashboard surface changes. If implementation unexpectedly adds any visible setting, copy, layout, or control, stop and reconcile that scope change with the approved plan before proceeding.

## Merge and exit criteria

- All approved behavior is implemented in one reviewable pull request.
- Focused tests and full gates pass.
- Original task intent remains the exact prefix on both task-delivery paths.
- Every workflow continuation retains authorization through truncation or exact SessionAction envelope composition.
- Scout no-PR and Pull Request action no-merge constraints remain explicit and later than broad authorization.
- Evidence calls remain limited to the existing selected Persona workflow and issued repository locators.
- `actions/pull-request.md`, generated action sources, built-in workflow versions, MCP/API schemas, and Settings/UI files are unchanged.
- Documentation matches the behavior.
- The pull request records any justified deviation from this proposed route and explains why the repository required it.

## Downstream handoff

There are no later phases. After this pull request merges, all consumers may rely on one server-owned authorization renderer being present in both initial task prompts and later workflow packets. They must not create a second authorization source or weaken the existing capability checks.

## Cross-phase audit record

- 2026-08-17: This is the only implementation phase. It owns every approved root-plan requirement and no requirement is deferred.
- 2026-08-17: Audited task delivery against both call sites and preserved the human-intent prefix while intentionally retiring byte-identical ship delivery.
- 2026-08-17: Audited workflow delivery against truncation and SessionAction packet bounds. Policy is runtime envelope data, not a mutation of frozen action Markdown.
- 2026-08-17: Audited persisted and append-only contracts. No schema, identifier, generated source, action source, or built-in workflow version changes are needed.
