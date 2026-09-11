# Conditional CI follow-through for workflow Pull Request actions

Status: implemented and verified in this session. Focused tests, typecheck, lint, build, smoke, and the checkbox-to-packet browser checks pass. Implementation evidence is registered with Mission Control.

## Goal

When Foreman's **Keep sessions on track with CI** setting is selected, a workflow's Pull Request action should tell its session to follow the existing PR's CI through completion, repair actionable failures on the same branch, and keep watching after a repair push. When the setting is off, Mission Control must add no CI follow-through instruction.

Use the existing `ForemanConfig.trackCiFailures` preference as the single source of truth. This is a conditional instruction change, not a new CI gate or scheduler.

## Scope and the incident boundary

The accepted scope is one implementation in this checkout: runtime prompt policy, the built-in action's stopping language, the existing setting's explanation, documentation, and focused tests.

The Phase 2 investigation established a separate failure: CI was already passing, while a post-review rebase caused `published_content_changed`. The blocked workflow retained session ownership and sent no recovery instruction, so Foreman suppressed Inspector follow-through.

**This CI instruction change alone will not recover that blocked run or resolve its Inspector finding.** CI repairs can also change the reviewed content tree and encounter the same existing guard after the agent finishes. Automatically routing changed published content through a fresh review is a separate workflow lifecycle change. The accepted scope keeps that recovery work separate.

## Expected behavior

| Situation when the action packet is prepared | Mission Control instruction |
| --- | --- |
| Workflow action has `completion.kind = pull_request`, CI setting on | Add the bounded CI follow-through policy. |
| Same action, CI setting off | Add no CI policy; preserve the normal PR handoff. |
| Any other completion kind, or an action outside a workflow | Add no CI policy. |
| Review-comment setting on or off | Do not use it to decide CI instructions. |
| Foreman worker disabled, stopped, dry-run, or outside its allowlist | The CI preference still determines prompt content; existing workflow delivery authorization independently determines whether the packet may be sent. |
| Setting changes after the packet is prepared | Preserve the recorded packet for preview, retry, and restart. Newly prepared action attempts use the new setting. |

The preparation-time boundary is intentional: the existing delivery ledger preserves the exact payload and digest. This work will not rewrite a queued or delivered instruction after an operator has inspected it.

## The instruction to add when enabled

The runtime policy should communicate these requirements in plain language:

1. Opening or updating the PR starts the CI follow-through portion of this action. Do not report the action complete solely because the PR exists.
2. Observe checks on the PR and repository this action owns. Wait for pending checks, inspect failing check logs, and distinguish passing checks from unavailable or absent CI results.
3. Repair actionable failures within the task's scope on the same branch. Run tests specific to the issue, then commit and push the repair. Do not rerun the full local test suite before every repair commit.
4. Observe checks for the newly pushed head, rather than relying on an earlier green result. Repeat until the checks pass or a concrete external blocker prevents authorized progress.
5. Report the PR, checked head, final CI outcome, and any blocker accurately. Register useful new verification evidence when the workflow supports it, then end the turn so the workflow can continue.
6. Leave Inspector review ownership and merge authority with their existing owners. CI tracking does not authorize merging, changing CI infrastructure, bypassing checks, expanding repository scope, or automatically handling review comments.

If a genuine blocker requires operator action, the instruction should identify it rather than promise unbounded retries. No new timeout setting is proposed.

## Implementation approach

### Read the existing preference at the daemon boundary

Add a narrow injected preference reader to `WorkflowManagerOptions`, wired from the daemon's existing Foreman configuration getter in [src/server/index.ts](../../../src/server/index.ts). Read it while [prepareSessionAction](../../../src/server/workflows/manager.ts) prepares a new packet. Tests can supply the value without contacting the Foreman worker or operator state.

Classify applicability through the action's existing completion contract, not its display name or workflow title. This covers the built-in Pull Request action and custom or duplicated actions with the same completion kind, including already-published workflow versions when they prepare a new delivery.

### Compose trusted runtime policy without editing frozen instructions

Extend [renderSessionAction](../../../src/server/workflows/feedback.ts) with explicit, typed policy input. Render the CI section in the runtime envelope before the exact frozen authored prompt, alongside the existing authorization contract. Preserve the skill invocation's first-line position, sanitization, whole-packet size refusal, and payload digest.

The enabled policy must explicitly extend the post-publication stopping boundary even if a historical built-in snapshot says that opening the PR is the whole job. It must not replace or rewrite the snapshot's authored content. The runtime policy changes CI follow-through only; unrelated authored restrictions retain their meaning.

Update [actions/pull-request.md](../../../actions/pull-request.md) so newly published snapshots defer to a supplied runtime CI policy and otherwise retain their existing stopping point. Regenerate `src/server/workflows/builtin-session-actions.generated.ts` with `npm run session-actions`. Do not hand-edit generated output or mutate existing workflow versions.

### Preserve delivery durability

Continue to use the existing `prepareDelivery` payload and digest as the record of what was instructed. Preview must show the same bytes that a later send uses. A retry or daemon restart reuses the stored packet instead of rereading the preference and silently changing the action. No new database column, completion kind, workflow state, event type, or configuration field is introduced. The packet envelope reserves 18,000 bytes for CI policy and metadata, including the full 4,096-character repository root at its maximum UTF-8 size. Action packets and their delivery rows use a 76,000-byte limit; other delivery kinds retain the existing 64,000-byte read bound. The authored and published prompt ceiling remains 58,000 bytes, preserving existing snapshots. A regression test proves maximum-size authored prompts remain deliverable with CI policy.

### Explain the behavior where the setting lives

Keep the checkbox label and persistence key. Update its tooltip in [ForemanBar.tsx](../../../src/web/components/ForemanBar.tsx) to explain both existing idle-session nudges and CI instructions for newly prepared workflow PR actions. Update [work-queues.md](../../work-queues.md) and [workflows.md](../../workflows.md) with the timing, independent delivery authorization, and unchanged reviewed-content guard.

## Data and instruction flow

Before: Foreman's stored CI preference is consumed by the Foreman worker to nudge eligible idle sessions; a workflow independently delivers its frozen Pull Request prompt, which tells the agent to stop after publishing.

After: the daemon also reads the stored CI preference when preparing a workflow PR action. The renderer conditionally adds CI policy, the delivery ledger freezes the exact packet, and the existing workflow delivery path sends it to the session. The session observes GitHub checks and performs scoped CI repairs when instructed. When the turn ends, the existing workflow capture and content-tree validation still decide whether the run can advance.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 260" role="img" aria-label="Stored CI setting reaches workflow action preparation, durable delivery, the session, and GitHub checks; workflow content validation remains after the turn">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
<g fill="none" stroke="currentColor"><rect x="10" y="20" width="195" height="78" rx="8"/><rect x="255" y="20" width="225" height="78" rx="8"/><rect x="530" y="20" width="180" height="78" rx="8"/><rect x="760" y="20" width="190" height="78" rx="8"/><rect x="760" y="165" width="190" height="75" rx="8"/><rect x="255" y="165" width="455" height="75" rx="8"/></g>
<g fill="currentColor" font-family="system-ui,sans-serif" font-size="15"><text x="25" y="50">Stored Foreman setting</text><text x="25" y="76">trackCiFailures</text><text x="270" y="50">Workflow preparation</text><text x="270" y="76">Conditional CI policy</text><text x="545" y="50">Delivery ledger</text><text x="545" y="76">Frozen exact packet</text><text x="775" y="50">Session runs action</text><text x="775" y="76">Scoped CI follow-through</text><text x="775" y="195">GitHub checks</text><text x="775" y="221">Current PR head</text><text x="270" y="195">After the turn: existing workflow capture</text><text x="270" y="221">Published content still requires matching review proof</text></g>
<g fill="none" stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"><path d="M205 59H250"/><path d="M480 59H525"/><path d="M710 59H755"/><path d="M855 98V160"/><path d="M760 202H715"/></g>
</svg>

## Acceptance criteria and verification

| ID | Criterion | Proof |
| --- | --- | --- |
| ci-policy-on | Enabled PR actions carry actionable CI waiting, focused repair, same-branch push, and current-head verification instructions. | Renderer tests and captured runtime delivery. |
| ci-policy-off | Disabled PR actions and all non-PR actions receive no injected CI tracking requirement. | On/off and completion-kind matrix; review-setting independence. |
| immutable-delivery | Old frozen action text remains intact; prepared payloads survive preference changes, retries, previews, and restart unchanged. | Focused manager/durability tests using the persisted delivery. |
| policy-boundaries | Existing workflow authorization, repository scope, packet size refusal, merge restrictions, and content-tree validation remain effective. | Runtime and adapter regression tests. |
| setting-to-prompt | Changing the existing checkbox affects the next prepared workflow PR action and its visible packet; the explanation describes the new behavior. | Playwright against fake agents and fake GitHub only. |

Extend the existing focused suites around `session-action-durability`, `session-action-runtime`, `builtin-session-actions`, and `foreman-settings-render`, and use an existing PR-action E2E fixture for the checkbox-to-packet regression. Cover true and false settings, old built-in stopping language, unrelated action kinds, review-setting independence, and a toggle after preparation. No real model calls or GitHub writes are needed.

Run the affected unit files with the repository's required test preload, `npm run typecheck`, and `npm run lint`. Regenerate action sources, run `npm run build` and `npm run smoke`, and run the affected Playwright specs against the built daemon. Capture the user-visible tooltip/packet evidence and register focused outputs, image evidence, and criterion coverage through Mission Control. Full-suite repair reruns are not part of this plan.

## Accepted scope and handoff

The operator's completion-review instruction authorizes implementing the conditional CI policy in this session. Published-content recovery remains outside this change. No separate phase tasks are needed, and no scope decision remains open.

After focused verification, register evidence and hand completion back to Mission Control. Commit, push, PR creation, merge, and repository scope expansion are excluded from this implementation turn.

## Verification result

- 136 focused unit tests passed, including preference gating, frozen historical instructions, retry/restart durability, the existing PR proof boundaries, and maximum authored prompt delivery.
- Three focused Playwright tests passed against the built daemon with fake agents. Both checkbox states change the next visible PR-action packet, and subsequent setting changes preserve the prepared packet.
- Typecheck, lint, build, and bundle smoke passed. Lint reports existing warnings.
- Focused command evidence and four inspected dashboard screenshots are registered with Mission Control, covering all five implementation acceptance criteria.
