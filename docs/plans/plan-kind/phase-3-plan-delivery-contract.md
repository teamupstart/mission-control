# Phase 3: The plan delivery contract

Source plan: [`plan.md`](./plan.md), rendered at [`plan.html`](./plan.html).
Index: [`phased-plan.md`](./phased-plan.md).

## 1. Outcome and value

A `plan` task now changes what the agent is told. Its delivered intent carries a contract
appendix that invokes the `html-plans` skill, its launch is granted the MCP tools the plan review
and the phased follow-up require, and a dispatch that could not honour the contract is refused up
front with a message naming what to switch on. A completed plan task is offered ordinary wrap-up
instead of being retired as a review artifact.

This is the phase where the feature becomes real for a person: pick **plan**, describe the work,
and get a rendered plan for review followed by a buttoned question about phasing it.

## 2. Entry criteria and direct phase dependencies

**Direct dependency: Phase 2.** This phase needs the kind to exist (C-K1) and needs the after-work
predicate already expressed over kinds (C-K3).

It does **not** depend on Phase 1. Nothing here touches storage, the manifest, or the validator,
so this phase may merge while Phase 1 is still in flight.

## 3. Scope and explicit non-goals

In scope:

- The plan contract appendix and its injection at both delivery seams.
- Generalizing the launch MCP requirement from scout-only to kind-dispatched.
- Refusing a plan dispatch or assignment when the required skills cannot be invoked.
- Exempting the plan kind from the Foreman review-artifact classifier.
- Documentation and a Playwright spec.

Explicit non-goals:

- **No archive capture.** Phase 4 owns it. After this phase a plan's artifacts live in its
  worktree and its pull request, which is a coherent, shippable state.
- **No restatement of the skills' procedure.** The appendix invokes; it does not duplicate the
  rendering rules, the decision schema, or the diagram guidance. This is the approved decision and
  is the deliberate difference from the scout appendix.
- **No change to `skipScoutWrapup`** or to how scout tasks are classified.
- **No new skill.** `html-plans` and `phased-plan` ship as they are.

## 4. Repository findings and inherited contracts

Verified against the planning checkout. Re-check before editing.

**The two delivery seams.** `withScoutReportContract` is called at
`src/server/dispatcher.ts:262` for a fresh launch and at `src/server/tasks.ts:2074` for a backlog
task assigned to a live session. `test/scout-prompt.test.ts:253-254` asserts both call sites exist
by regex, so the generalization must keep both discoverable.

**Two different skill resolvers, and the difference is load-bearing.**
`src/server/skills/invoke.ts` exports both:

- `skillInvocationForAgent(agent, id)` (`:57-96`) - the launch-time ladder: master switch and
  per-skill toggle, catalog readability, harness invocability, symlink health. Returns
  `{ ok: true, command } | { ok: false, message }` and never throws.
- `requiredSkillCommand(session, id)` (`:106-133`) - the same ladder **plus** a reload-watermark
  rung that refuses while a live session has not yet picked up the current symlink generation.

A fresh dispatch has no session yet and must use the first. An assignment to a live session must
use the second, or it will type a skill invocation into a session whose skill set is stale. This
distinction is the single most likely thing to get wrong in this phase.

**The invocation is per-harness and must not be hardcoded.** `skillCommand(agent, name)`
(`src/shared/harness-capabilities.ts:923`) renders Claude `/html-plans`, Codex
`$html-plans - run this skill now.` (the trailing clause closes the mention popup so one Enter
submits), and Pi `/skill:html-plans`. Note it is fed the SKILL.md frontmatter **name**, not the
catalog directory id (`invoke.ts:84`).

**The refusal precedent.** `dispatchRetroTask` (`src/server/retro.ts:224-262`) resolves the skill
*before* creating anything and returns `{ kind: "refused", status: 409, error: … }` where the
error is the resolver's own message plus a sentence explaining the consequence. The route surfaces
it at `src/server/routes.ts:2785-2804`. `src/server/tasks.ts:1921-1928` is the equivalent
precedent inside task assignment, refusing a scout when the MCP bundle is not built.

**The MCP requirement seam.** `scoutMissionMcpRequirement(task, requested)`
(`src/server/mission-mcp.ts:83-91`) derives the launch requirement from the durable kind and
returns a ship task's requirement unchanged, `null` included, so existing argv stays
byte-identical. `MISSION_MCP_TOOLS` (`:39-48`) already contains `request_plan_decisions` and
`create_task`.

**The wrap-up classifier catches a plan task twice.** `automaticWrapupBlock`
(`src/server/foreman/wrapup-eligibility.ts:129-157`) has three ordered branches. The scout branch
is keyed on kind. The other two are the review-artifact classifier:

- The **objective** half (`objectiveRequestsReviewArtifacts`, `:96-116`) matches
  `REVIEW_ARTIFACT_REQUEST`, whose vocabulary includes `plans?`. An objective saying "write a
  plan" matches regardless of where files land.
- The **diff** half (`diffContainsOnlyReviewArtifacts`, `:118-120`) tests every changed path
  against `REVIEW_ARTIFACT_PATH` (`:69-71`), which matches a `plans/` path segment at any depth.
  A `docs/plans/**`-only diff matches every path and blocks.

Both halves must be exempted for the kind, or the approved "ordinary wrap-up" decision is not
delivered. `changedPaths` is supplied only at the two `worker.ts` call sites (`:1077`, `:1273`);
`queue-machine.ts:383` and `prompted-wrapup.ts:204` pass none, which is why the objective half
matters independently.

## 5. Implementation steps, in execution order

1. **Write the plan appendix.** Add a plan prompt module beside the scout one. It composes, after
   the operator's intent and separated by a stable marker:
   - what a plan task is for and what "delivered" means;
   - the resolved skill invocation for this task's harness, obtained from the caller rather than
     computed inside the appendix, so the module stays pure and testable;
   - where the artifacts belong (`docs/plans/<name>/plan.md` and `plan.html`);
   - that the review and the phased follow-up are asked through `request_plan_decisions`, and that
     a dismissal ends the work rather than being inferred as a choice.
   Keep it compact for the reason the scout appendix records: it competes with the operator's own
   request, and a page of rules is read like a page of none.
2. **Generalize the contract composer.** Replace `withScoutReportContract` with a kind-dispatched
   composer that returns the intent unchanged for `ship`, appends the scout contract for `scout`,
   and appends the plan contract for `plan`. Keep one function called at both seams so the
   ordering stays deterministic and `test/scout-prompt.test.ts`'s call-site assertion still has a
   single symbol to find.
3. **Resolve the skill at the right seam with the right resolver.** The dispatcher path
   (`dispatcher.ts:262`) uses `skillInvocationForAgent(task.agent, …)`. The assignment path
   (`tasks.ts:2074`) uses `requiredSkillCommand(session, …)`. Both refuse rather than degrade.
4. **Refuse the dispatch when the contract cannot be honoured.** Resolve `html-plans` and
   `phased-plan` before provisioning anything, mirroring `dispatchRetroTask`'s ordering. Return
   the resolver's message plus a sentence naming the consequence, in the shape
   `tasks.ts:1921-1928` already uses for a scout. `phased-plan` is required because the follow-up
   the human is offered is unanswerable without it, and refusing before the work starts is better
   than refusing after they have chosen to phase it.
5. **Generalize the MCP requirement.** Rename `scoutMissionMcpRequirement` to a kind-dispatched
   function that unions `submit_scout_artifacts` for a scout and `request_plan_decisions` plus
   `create_task` for a plan, and returns a ship task's requirement untouched. Update the identity
   assertion at `test/scout-prompt.test.ts:201-217`.
6. **Exempt the kind from the review-artifact classifier.** In `automaticWrapupBlock`, gate both
   review-artifact branches so they do not apply to a `plan` task. Keep the scout branch and its
   flag exactly as they are. Express the exemption as a statement about the kind rather than as a
   negation sprinkled into two conditions, and record in the comment why a plan is not a review
   artifact in the sense that setting means: a mockup is produced *for* a review and discarded,
   while a plan's landing on the default branch is what releases the phase tasks that depend on
   it.
7. **Document it.** `docs/dispatch-and-backlog.md` carries the Kind table at `:42` and the
   scout-specific behaviour at `:204-214`; both need the plan kind. `docs/skills-and-settings.md`
   states that a scout task does not depend on the `html-report` toggle - add the contrasting
   statement for plan, because the opposite is true and a reader who generalizes from scout will
   be wrong. `docs/foreman.md:169` covers wrap-up.

## 6. Data, API, and compatibility

- **No schema change and no migration.**
- **No wire contract change.** The requirement generalization changes launch argv only for plan
  tasks; ship and scout argv stay byte-identical, which the existing identity test pins.
- **A new dispatch failure mode.** A plan dispatch can now be refused for a reason that has
  nothing to do with the repository. The message must name the toggle and where to find it, or it
  reads as a bug. This is the compatibility cost of the approved "point at the skills" decision
  and is stated in the plan as a known risk.
- **Harness coverage.** All three harnesses declare a skills directory and an `invoke`, so a plan
  task is dispatchable on each. A future harness that declares `skills: null` will refuse plan
  dispatch through the existing ladder, with the message
  `"<label> cannot invoke the required html-plans skill."` - correct behaviour that needs no new
  code.

## 7. Tests and verification

- New prompt tests mirroring `test/scout-prompt.test.ts`: the marker's position after the
  operator's intent, the intent passing through unchanged for ship and scout, and the resolved
  invocation string appearing verbatim.
- A test per harness asserting the appendix carries that harness's own invocation syntax. This is
  the regression that a hardcoded `/html-plans` would cause, and it is invisible on Claude.
- A test asserting the assignment seam uses the watermark-aware resolver: with a stale skills
  generation and a live session, the assignment refuses rather than typing a stale invocation.
- Refusal tests for both seams with the skill toggled off, asserting the message names the toggle.
- `test/foreman-wrapup-eligibility.test.ts`: a plan task with a `docs/plans/**`-only diff is
  **not** blocked; a plan task whose objective says "write a plan" is **not** blocked; a ship task
  with the same diff and the same objective **is** still blocked. That last case is what proves
  the exemption is keyed on the kind and did not weaken the classifier.
- **Playwright spec** (required): dispatch a plan task against the fake agents and assert the
  delivered opening prompt carries the contract, and that a dispatch with the skill disabled
  surfaces the refusal in the UI. Every agent binary is redirected by
  `e2e/fixtures/fake-agents.ts` and both the one-shot runner and the SDK session must stay faked -
  never spend model tokens. Select by role, label or placeholder; never add a `data-testid`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run test:e2e`.

## 8. Merge and exit criteria

- A dispatched plan task receives its intent followed by the contract, with the correct
  per-harness invocation.
- A plan dispatch and a plan assignment both refuse cleanly when the required skills are off, with
  a message naming the toggle.
- A plan launch can call `request_plan_decisions` and `create_task`; ship and scout launches are
  byte-identical to before.
- A completed plan task reaches ordinary wrap-up; a ship task producing only mockups still does
  not.
- The Playwright spec passes without spending model tokens.

## 9. Downstream handoff

Later phases may rely on:

- **C-P1**: A kind-dispatched contract composer is called at both delivery seams, and adding a
  kind's contract means adding a branch there and nowhere else.
- **C-P2**: A kind-dispatched MCP requirement function derives launch capabilities from the
  durable kind.
- **C-P3**: A plan task is guaranteed to have been dispatched with `html-plans` and `phased-plan`
  invocable, so Phase 4 may assume the artifacts follow the skill's layout.

Later phases must not:

- Restate the skills' procedure in the appendix.
- Use the launch-time resolver on a live session, or the watermark resolver at launch.
- Re-block the plan kind in the review-artifact classifier.

## 10. Cross-phase audit record

- **Against Phase 2:** consumes C-K1 and C-K3. Phase 2 deliberately left the prompt seams and the
  MCP requirement untouched so this phase owns that generalization wholly. Confirmed compatible:
  Phase 2's `afterWorkForKind` predicate is a UI concern and is not re-read here.
- **Against Phase 1:** disjoint. No file is touched by both. Verified against Phase 1's step list:
  it touches `src/shared/scouts.ts`, `src/server/scouts/**`, `db.ts`, `registry.ts`,
  `useEventStream.ts`, `routes.ts` archive routes and the archive docs; this phase touches
  `dispatcher.ts`, `tasks.ts`, `mission-mcp.ts`, `wrapup-eligibility.ts`, the prompt modules and
  the dispatch docs. `src/server/tasks.ts` is touched by Phase 4 as well but not by Phase 1.
- **Against Phase 4:** Phase 4 consumes C-P3. Note the ordering consequence recorded there: Phase
  4 needs Phase 1 *and* this phase, and is the only point where the two lines of work meet.
- **Reconciliation applied while writing this file:** the initial route resolved the skill
  invocation inside the appendix module. That was moved to the caller after the finding that the
  two seams require *different* resolvers - a pure appendix that resolved its own skill would have
  to pick one, and picking either is wrong at the other seam. Recorded because the simpler shape
  is the one a reviewer will suggest.
- **Deferred decision surfaced here:** whether `phased-plan` should be required at dispatch or
  only when the human chooses to phase. Step 4 resolves it as required at dispatch, because the
  alternative refuses after the human has already made a choice, which is the worse moment. An
  implementer who finds this too strict must raise it rather than silently downgrading it to a
  warning, since a warning that the agent cannot act on is not a safeguard.
