# Filed plan decisions - Phase 1: Filed gate core

Source plan: `docs/plans/filed-plan-decisions/plan.md`. Index:
`docs/plans/filed-plan-decisions/phased-plan.md`. Line numbers are as of `7626494d8`; re-verify
them before editing. This file is the proposed route, not a specification.

## Outcome

With `filed-plan-decisions` and `async-input` both on, `request_plan_decisions` returns a receipt
at once and holds no MCP call open. The form is still a gate: the session is amber in Needs you
and counted in `to answer` from filing, nothing completes the task past it except a merge, and
the answer reaches the agent as one message restating the plan and each decision. Managed final
approval, standing approval and publication work on the filed path. The agent can list and
withdraw its filed form. With either flag off, behavior is exactly today's.

## Entry criteria and dependencies

- The planning pull request has merged, so these paths resolve on the default branch.
- No phase dependency. The `async-input` machinery this builds on is already on `main`.

## Scope

In scope: the flag, shared predicates, wait negotiation in both branches of `createMcpReview`,
session counts, completion hold, merge closure, alerts, receipt and answer text, the MCP child,
withdraw and list for plan forms, agent instructions (tool description, plan prompt, four
skills), gate wording in the dashboard, tests, an e2e spec and documentation.

Not in scope: `revises` and the Revision tag (Phase 2); any snooze on plan forms; any change to
the ten-question limit; any cross-session cap; converting a blocking call into a filed one;
`request_review` or other blocking tools; enforcing read-only preparation.

## Repository findings

- `request_plan_decisions` calls `createReview` then `waitForResolution`
  (`src/mcp/server.ts:544-545`). `request_input` already uses `postReview` with `asyncCapable`
  and returns the receipt (`:1059-1063`). `postReview` treats a response without `wait` as `call`
  (`:155-158`), so a newer child against an older daemon keeps long-polling.
- `createMcpReview` (`src/server/routes.ts:5181-5253`): the managed branch (5189-5227) creates the
  review with no options and returns no `wait`; the unbound branch decides the wait at 5232.
- `ReviewManager.create` stores `waitMode` only for a snoozable `input`
  (`src/server/reviews.ts:343-348`). The limit block (`:358-369`) and `openQuestions` (`:381-383`)
  are `isRequestInputQuestion`-scoped. `continuationText` picks `asyncInputAnswer` for any
  message-mode row (`:199-200`). `mergeClosure` filters by `questionHoldsCompletion` (`:815`).
- The body of `withdrawQuestion` (`src/server/reviews.ts:385-398`) is today the one place that
  writes the review status `withdrawn`, and `withdraw_question` is its only entry. It admits only
  the calling session's own ask, refuses a call-mode row and records no actor.
- Counts: `countPending` and `countOpenQuestions` (`src/server/registry.ts:7370-7383`);
  `completionHeldByQuestion` (`:7396-7400`). The three completion gates also refuse a `needs-you`
  bucket (`src/server/registry.ts:10589-10594`, `src/server/workflows/manager.ts:5492-5494`,
  `:8424-8427`).
- `reportBucket` returns `needs-you` on `pendingReviews > 0` before any state reading
  (`src/shared/session.ts:412`); the dashboard mirror is `unpausedStateDisplay`
  (`src/web/lib/format.ts:308-314`). Neither needs a change once the count is right.
- The resident loop holds on the bucket (`src/server/residents/loop.ts:162`, `:203`).
- Alerts split the newest pending review by `waitMode` (`src/shared/alerts.ts:187-195`).
- Dashboard readers of "the agent kept working": `questionStatusLine`, `stoppedOnQuestions`,
  `allMessageMode`, `questionWait` (`src/web/lib/async-questions.ts:97-130`, `:232-240`). The
  Asked entry is drawn for every message-mode row (`src/web/lib/episodes.ts:42`) and prints
  question text only for `input` (`src/web/components/AskedQuestion.tsx:98-101`).
- Remind me later is offered only when `canSnoozeReview` passes, which reads `snoozable`
  (`src/web/components/ReviewModal.tsx:172`). A plan form never has it, so decision 2 needs no
  dashboard change, only a test.
- An owner can add a line to a continuation (`addContinuationAddendum`,
  `src/server/reviews.ts:177`; the resident registration is at `src/server/routes.ts:1876`).
- `test/feature-flags.test.ts:71` pins the registry module's export names, so the flag constant
  lives in `src/shared/async-input.ts`, beside `ASYNC_INPUT_FLAG`.
- `test/async-input-daemon.test.ts:324` asserts a merge "leaves gates alone".

## Implementation steps

1. **Flag.** Add `filed-plan-decisions` to `FEATURE_FLAGS` after `async-input`
   (`src/shared/feature-flag-registry.ts:74-82`), stage `preview`. Suggested label "File plan
   decisions"; the description says the plan is filed, the agent stops and waits, the answer
   arrives as a message, and it needs Ask without stopping. Export `FILED_PLAN_DECISIONS_FLAG`
   from `src/shared/async-input.ts`.
2. **Predicates and scope** in `src/shared/async-input.ts`:
   - `isFiledGate(review)`: `kind === "plan-decisions"` and `waitMode === "message"`.
   - `agentKeepsWorking(review)`: `waitMode === "message"` and not a filed gate.
   - `isAgentAsk(review)`: `isRequestInputQuestion(review) || isFiledGate(review)`.
   - `decideWaitMode` takes `gateFlagOn`. It answers `message` when `asyncCapable`, `messageable`
     and `flagOn` hold and either the ask is a snoozable `input`, or it is `plan-decisions` and
     `gateFlagOn` holds.
   - `questionHoldsCompletion` also returns true for an outstanding filed gate, with no flag
     condition (it exists only because both flags were on).
3. **Text**, in the same module:
   - `filedPlanReceipt(review, { bundleApproved? })`, four points in order: filed and not
     answered, with the review id; this is a gate, so no edits, commits, pushes, task creation or
     other outward action until the answer arrives, while read-only preparation is fine; do not
     file it again or poll, the answer arrives as a message, and `withdraw_question` with this id
     and a reason takes it back if the operator says scope changed or it is no longer needed;
     when preparation is done, say what is waiting and end the turn. With `bundleApproved`, a
     leading line says the final bundle was approved automatically and only the remaining
     decisions are filed.
   - `filedPlanAnswer(review, now)`: a lead naming the review id and how long ago it was filed;
     `Plan: <title>`; the plan body cut at a line boundary to about 2,000 characters with a
     marker saying how much was cut; `reviewToolResult(review).text`, which already restates each
     decision with its choice, notes and "Chat about it"; then what to do. Answered: the gate is
     lifted for what was decided. Dismissed: nothing was selected or approved, so do not proceed
     as if it were.
4. **MCP child** (`src/mcp/server.ts:491-547`): the handler calls `postReview` with
   `kind: "plan-decisions"`, `managedPlan` and `asyncCapable: true`; told `message` it returns the
   receipt, otherwise it long-polls as today. Rewrite the description's "BLOCK until" sentence in
   the two-outcome form `request_input` uses (`:973-978`). Update the `list_open_questions` and
   `withdraw_question` descriptions to include filed plan forms.
5. **Wait negotiation** in `createMcpReview`: decide the wait once, before the managed branch,
   from `featureEnabled(ASYNC_INPUT_FLAG)`, `featureEnabled(FILED_PLAN_DECISIONS_FLAG)`, the kind,
   `asyncCapable` and `canMessage(session)`. Then:
   - Managed, operator approval needed: pass `waitMode` and `callerPolls` to `reviews.create`,
     keep `bindPlanReview` and `standingApprovalEligible` as they are, and answer with `wait` and
     the receipt when the stored row is filed.
   - Managed, standing approval, nothing remaining: unchanged row; answer `wait: "call"`
     explicitly, so the child's one poll returns the recorded approval.
   - Managed, standing approval with remaining decisions: the follow-up is created filed, and
     its receipt is built with `bundleApproved`.
   - Unbound: pass the kind and `gateFlagOn`; choose the receipt by kind.
   Read the stored row's mode for the response, as line 5247 does, because an identical re-ask
   re-attaches to the open row.
6. **Review manager** (`src/server/reviews.ts`): store `waitMode` for `plan-decisions` when
   asked; never store `snoozable` or `meanwhile` for it. In `continuationText`, use
   `filedPlanAnswer` for a filed gate. Add `openAsks(sessionId)` (outstanding reviews passing
   `isAgentAsk`) and move `withdrawQuestion` and the list route to it; leave `openQuestions` and
   the limit block alone. `withdrawQuestion` keeps its two refusals (a review that is not the
   calling session's own, and a call-mode row). Its body stays the one place that writes the
   status `withdrawn`, and `withdraw_question` stays that write path's only entry in this phase:
   this phase adds no second writer and no second entry. (Phase 2 adds the path's second entry,
   the `revises` replacement, and no second writer; see the contract in `phased-plan.md`.) The
   list route (`src/server/routes.ts:5494-5504`) adds `kind` to each row.
7. **Managed identity in the answer.** Register a continuation addendum from
   `src/server/plans/publication.ts` that, for a review bound in `managed_plan_reviews`, names the
   plan id, slug and revision the form approved or refused. Register it where the resident
   addendum is registered.
8. **Counts** (`src/server/registry.ts:7370-7383`): `countPending` counts pending reviews
   without `agentKeepsWorking`; `countOpenQuestions` counts pending reviews with it. Update both
   comments and the field comments in `src/shared/types.ts:812-824`.
9. **Alerts** (`src/shared/alerts.ts:187-195`): split by `agentKeepsWorking`, so a filed gate
   raises the existing "needs review" alert with its title.
10. **Dashboard wording** (`src/web/lib/async-questions.ts`): `questionStatusLine` returns a gate
    line for a filed gate ("Waiting on your decisions", stopped styling, "filed <relative time>",
    never a meanwhile line); `stoppedOnQuestions` and `allMessageMode` use `agentKeepsWorking`;
    `questionWait` returns `call` for a filed gate, whose copy already says the agent keeps
    waiting. In `AskedQuestionCard`, a filed gate reads as a filed plan (for example "Plan filed"
    and an Open button whose tooltip says it opens the plan to decide) and prints no plan body.
11. **Agent instructions.** `src/server/plans/prompt.ts:123-125`: the tool either returns the
    answer or a receipt; on a receipt the agent ends its turn after read-only preparation and the
    answer arrives as a message; a dismissal still ends the work. Make the same change in
    `skills/html-plans/SKILL.md` (around line 129 and its "Always" sections),
    `skills/grill/SKILL.md:53` (each round may be filed; the answer message starts the next
    round), `skills/retro/SKILL.md:131-132`, and wherever `skills/phased-plan/SKILL.md` describes
    waiting for final approval. Run `npm run session-actions` and commit the regenerated
    `src/server/workflows/builtin-session-actions.generated.ts`; never hand-edit it.
12. **Documentation.** `docs/sessions.md`: the `request_plan_decisions` entry (line 2676) and a
    "Filed plan decisions" part under "Asking without stopping" (line 3063) covering the gate,
    what holds, withdraw, the flag pair and what switching a flag off does to open forms.
    `docs/feature-flags.md`: the intro list and a paragraph. `docs/managed-plans.md`: approval on
    the filed path (near line 218). `docs/attention-and-alerts.md` (lines 42-64): a filed plan
    form is amber and counted from filing.

## Compatibility

- No migration. `reviews.wait_mode` already stores `message` for any kind.
- An older MCP bundle never sends `asyncCapable` and blocks. Adding the behavior needs
  `npm run build:mcp`; sessions on an older bundle keep blocking until relaunched.
- An older child that re-asks a filed form word for word is handed the open row and long-polls
  it; `attachCall` turns it into a call-mode form. Keep that path working for plan forms.
- Either flag switched off: new asks block; an open filed form stays filed, answerable and
  withdrawable only while `async-input` is on, since the two question routes stay behind it.
  Switching a flag off closes nothing: no open form is withdrawn by it.
- Call-mode plan forms are unchanged in every reader: not held by `questionHoldsCompletion`,
  not closed by a merge, not withdrawable.

## Tests and verification

Extend the existing suites rather than adding parallel ones:

- `test/async-input.test.ts`: the `decideWaitMode` matrix with `gateFlagOn`; the three
  predicates; `questionHoldsCompletion` for filed gates; receipt and answer wording, including
  dismissal, truncation and `bundleApproved`.
- `test/async-input-daemon.test.ts`: negotiation on both routes for each flag combination, an
  older child and an unmessageable session; a filed gate is a pending review and never an open
  question; prompted completion, workflow resumption and evidence preparation refuse while it is
  open, working or idle; a resident is held; the limit neither counts nor refuses a plan form
  (ten questions open, a plan form is accepted; many plan forms, an eleventh question is still
  judged on questions alone); list and withdraw for plan forms, including that another session's
  `withdraw_question` on the form answers 409 and leaves it open; a merge closes a filed gate
  with `merged` and still leaves a call-mode gate alone (rewrite the test at line 324).
- `test/async-input-mcp.test.ts`: the tool returns the receipt and makes no `/wait` request; an
  older daemon's response long-polls.
- `test/async-input-lifecycle.test.ts`: the answer row is daemon-authored, coalesces with a
  queued question answer at the tail, and carries the managed identity addendum.
- `test/async-input-merge.test.ts`: merge-driven completion closes a filed gate in the task's
  transaction.
- `test/local-plan-publication.test.ts` and `test/plan-standing-approval.test.ts`: on a filed
  review, approval publishes; a withdrawn or dismissed review never approves; a home-approval
  approves and its answer is delivered; standing approval with nothing remaining answers
  `wait: "call"`; the follow-up is filed with its note; the standing grant commits from a filed
  form.
- `test/plan-decisions-http.test.ts`: with either flag off the route's response and the wait
  are unchanged.
- `test/async-input-dashboard.test.ts`: the gate status line, row order and badge.
- `test/plan-prompt.test.ts`, `test/skills-catalog.test.ts`, `test/grill-first.test.ts`,
  `test/feature-flags.test.ts`: updated pins.
- New `e2e/specs/filed-plan-decisions.spec.ts` (read `e2e/README.md` first; model it on
  `e2e/specs/async-input-dashboard.spec.ts`): the flag's Settings row appears; with both flags on
  a `plan-decisions` ask posted with `asyncCapable` answers `wait: "message"`; the session reads
  "to review" and the inbox counts it while the agent is still working; the form shows the gate
  line, Submit and Dismiss, and no Remind me later; a half-filled form cannot be submitted;
  submitting delivers the answer to the session as a message; with `filed-plan-decisions` off the
  same ask answers `wait: "call"`. Select by role and label; add no `data-testid`.

Commands: the focused files with
`node --test --import ./test/setup-state.mjs --import tsx <file>`, then `npm run typecheck`,
`npm run lint`, `npm run build`, `npm run smoke` and `npm run test:e2e`.

## Merge and exit criteria

- Every test above passes, and the existing async-input, plan-decisions, publication and
  standing-approval suites pass unchanged with both flags off.
- With both flags on, no reader lets a task complete, a workflow resume, a resident wake or a
  session hibernate past an open filed form; a merge closes it with `merged`.
- No surface describes the agent behind a filed form as working, and no plan form offers a snooze.
- The limit code is untouched and no cross-session cap exists.
- The status `withdrawn` is still written in one place, and `withdraw_question` is that write
  path's only entry when this phase merges.
- Documentation matches the behavior. The pull request records any deviation from this file.

## Downstream handoff

Phase 2 may rely on the contracts listed in `phased-plan.md` under "Cross-phase contracts, owned
by Phase 1", including the one write path for `withdrawn`, which makes a `withdrawn` review one
its own agent withdrew. Phase 2 adds one sentence to `filedPlanReceipt`, an option to
`ReviewManager.create`, and the second entry to that write path (the `revises` replacement). It
must not add a second place that writes `withdrawn`, a second reader of the flag, a change to
the counts, or a change to who is held.

## Cross-phase audit record

- Written first. Checked against the source plan's design, its managed-approval table and its
  reader table: every row is owned here except the `revises` rows.
- After Phase 2 was written: the receipt here must not mention `revises`, which does not exist
  until Phase 2. Step 3 was corrected to describe withdraw only; Phase 2 adds the sentence.
- After Phase 2 was written: `openAsks` was named here so Phase 2's validation can reuse it.
- Plan validation round 1: Phase 2's revision rule needs "withdrawn" to mean "withdrawn by its
  own agent". Recorded here as a finding, a constraint in step 6, a compatibility note (a flag
  switch withdraws nothing), a test and an exit criterion, so Phase 1 cannot widen it unnoticed.
- Plan validation round 2: round 1 worded that constraint as "`withdrawQuestion` is the only
  writer", which contradicted Phase 2's replacement of an open form. The constraint is now the
  contract's: one write path, whose only entry in this phase is `withdraw_question`, and to
  which Phase 2 adds the `revises` entry. The finding, step 6, the exit criterion and the
  handoff were reworded to say exactly that.
