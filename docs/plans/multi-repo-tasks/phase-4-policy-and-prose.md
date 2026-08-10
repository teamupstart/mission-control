# Phase 4: Policy and prose

Source plan: [plan.md](plan.md) - Index: [phased-plan.md](phased-plan.md)

## 1. Outcome

The remaining per-session assumptions that degrade quietly on multi-repo tasks are lifted: review follow-through nudges track each PR instead of wiping each other's history, and every agent-facing instruction surface (skills, session-action prompts, agent guides) states the multi-repo contract - one PR per repository you changed - so agents stop being steered into single-PR behavior on multi-repo work.

## 2. Entry criteria and dependencies

- Direct prerequisite: **Phase 3** merged (phases 1 and 2 arrive transitively). Follow-up marks need phase 2's per-repo PR truth; prose describes phase 3's per-repo runs.

## 3. Scope and non-goals

In scope:

- Foreman review follow-through: per-PR `FollowupMark`s.
- Skill prose: `skills/pull-request/SKILL.md`, `skills/phased-plan/SKILL.md` (and its `agents/openai.yaml` if it restates the contract).
- Session-action prompt: `actions/pull-request.md` (regenerate via `npm run session-actions`; never hand-edit the generated module).
- Agent guides: root `AGENTS.md` review-workflow rule and `docs/agent-guides/` where they say "the PR" about a session.
- Final README sweep for the feature.

Non-goals:

- Any schema, gate, or scheduling change (all landed in phases 1-3).
- Deferred v1 exclusions (ensembles, schedules, task sources, MCP `create_task`, drag-to-assign, Pi).

## 4. Repository findings this phase builds on

- Follow-through: `src/server/foreman/review-followup.ts` - `FollowupMark { prKey, findingsRound, ciNudged }` is one mark per session (`:73-80`), so a new PR resets the sibling's nudge history; the gate at `:164` requires the scalar `session.prUrl`; the payload at `:258` instructs "Do NOT open a new pull request - push your fixes to this same branch." That instruction is correct per PR and wrong per session once a session legitimately owns N PRs.
- Prose with single-PR assumptions (from scoping): `skills/pull-request/SKILL.md:84-90` ("Open a new pull request... verify its current description"); `skills/phased-plan/SKILL.md:33-34,137-148,200-239` (one phase = one PR = one repo, rooted at `process.cwd()`); `actions/pull-request.md:5-11` ("turn the work... into one open pull request... Do this once."); `AGENTS.md:53` ("monitor the existing PR").
- Generated files contract: built-in session actions are generated from `actions/*.md` via `npm run session-actions`, with a drift test importing the generator.

## 5. Implementation steps

1. **Follow-through** (`src/server/foreman/review-followup.ts`): key marks per `(session, prKey)`; iterate the session's open adopted PRs (through the existing ledger readers - no new provider poller) instead of gating on the scalar `session.prUrl`; the payload keeps its "same branch, no new PR" instruction but names the PR it is about. One nudge outstanding per session at a time, consistent with phase 3's delivery serialization.
2. **`skills/pull-request/SKILL.md`**: the deliverable becomes "one open pull request per repository whose worktree you changed"; verify-or-update applies per repo; reporting lists every PR with its repo.
3. **`actions/pull-request.md`** + `npm run session-actions`: the action's prompt is delivered per run, and phase 3 made runs per-repo - rewrite "Do this once" to bind to the run's repository ("one open pull request for this repository and branch; update it rather than opening a second one for the same branch").
4. **`skills/phased-plan/SKILL.md`**: acknowledge multi-repo tasks exist: a phase remains one merge unit, and where a phase must land in several repositories it is one task with attached repos producing one PR per repo. Keep the single-repo path primary.
5. **`AGENTS.md` and `docs/agent-guides/`**: the review rule speaks per PR ("monitor the existing PR for that repository"); architecture/change-contract sentences that say a session has "a PR" gain the per-repo qualifier where phase 3 did not already update them.
6. **README sweep**: one pass confirming dispatch, completion, and workflow sections tell the whole multi-repo story coherently.

## 6. Data and compatibility

- No schema changes. Follow-up marks are in-memory/config state per current implementation; if they turn out to be persisted, extend additively and note it in the PR.

## 7. Tests and verification

- Unit: `test/foreman-review-followup.test.ts` extended - two open PRs on one session hold independent marks; a nudge on PR A does not reset PR B's `findingsRound`; one outstanding nudge per session. Prose drift: `npm run session-actions` output committed and its drift test green.
- e2e: existing follow-up-adjacent specs stay green; no new UI surface is introduced by this phase (prose and server policy only), so no new spec is required unless implementation adds one.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`, `npm run test:e2e`.

## 8. Merge and exit criteria

- Section 7 green in CI.
- Grep-audit: no remaining agent-facing instruction tells a multi-repo session to open or track exactly one PR.
- README and guides consistent with phases 1-3 as merged (not as planned - re-read them).

## 9. Downstream handoff

- Feature complete for v1. Deferred items (ensembles, schedules, task sources, MCP `create_task` multi-repo, drag-to-assign, Pi capability, coordinated merges) start from the source plan's out-of-scope list, not from this phase.

## 10. Cross-phase audit record

- 2026-08-05 (scoping): allowlist AND rule moved out of this phase into phase 1 (consent ships with capability).
- 2026-08-05 (scoping): follow-through nudging aligned with phase 3's one-outstanding-delivery-per-session rule rather than defining its own concurrency.
- 2026-08-10 (citation re-verification): the `FollowupMark` premise holds - it is still `{ prKey, findingsRound, ciNudged }` and still one mark per session id in the Foreman worker, so the per-PR rekey this phase performs is still the change it describes.
- 2026-08-10 (citation re-verification): **three prose targets moved after scoping and the steps below must be re-aimed when implemented.** (1) The session-action sources are no longer under `docs/session-actions/`; they live at root `actions/`, generated into `src/server/workflows/builtin-session-actions.generated.ts`. That directory also holds `actions/README.md`, which the generator already excludes via `NON_SESSION_ACTION_DOCUMENTS`, so step 3 must not add a second exclusion. (2) `skills/pull-request/SKILL.md` was rewritten to carry a `## For Humans` / `## For Agents` description contract; step 2's per-repo deliverable edit must preserve that structure rather than the older flat prose. (3) The README no longer holds the dispatch, completion, and workflow sections step 6 sweeps - they were split into `docs/dispatch-and-backlog.md`, `docs/tasks-and-scheduling.md`, `docs/workflows.md`, `docs/workflow-system.md`, `docs/inspector-and-shipping.md`, and siblings indexed by `docs/README.md`. Step 6 is a `docs/*.md` sweep now, not a README sweep.
- 2026-08-10 (citation re-verification): `docs/agent-guides/change-contracts.md` gained a PR-adoption-ledger contract section that already speaks in ledger terms and names `pull_request_wrong_repository` as a state, and `docs/agent-guides/architecture.md` now documents the Inspector poll as the single reader of remote PR state. Both postdate scoping and overlap what step 5 planned to qualify, so step 5 must re-read them rather than assume the older per-session "a PR" phrasing is still in place.
