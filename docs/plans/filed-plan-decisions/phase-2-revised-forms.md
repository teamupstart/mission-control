# Filed plan decisions - Phase 2: Revised forms

Source plan: `docs/plans/filed-plan-decisions/plan.md`. Index:
`docs/plans/filed-plan-decisions/phased-plan.md`. Line numbers are as of `7626494d8` and will have
moved after Phase 1; re-verify them. This file is the proposed route, not a specification.

## Outcome

When scope changes, the agent files a revised plan that names the form it replaces. The operator
sees one card, tagged "Revision 2" (then 3, and so on), with a way to read the earlier version.
An earlier form that is still open is withdrawn in the same step, so two cards for one plan never
sit in the inbox together.

## Entry criteria and dependencies

- Phase 1 has merged. This phase consumes its predicates, `openAsks`, `filedPlanReceipt`, the
  route response and the rule that a `withdrawn` review was withdrawn by its own agent, as listed
  in `phased-plan.md`.

## Scope

In scope: the `revises` argument on `request_plan_decisions`, its wire field, validation, the
atomic replacement, two nullable review columns and their migration, the `ReviewItem` field, the
Revision tag on the card, the inbox row and the conversation entry, the earlier-version view,
tests, an e2e spec and documentation.

Not in scope: inferring a revision the agent did not name; carrying an approval from one form to
its revision; revising a `request_input` question; revising a form that anyone but its own agent
closed; any change to who is held, the counts or the flag gate.

## Repository findings and inherited contracts

- `CreateReviewSchema` (`src/shared/protocol.ts:665-719`) is the wire contract for both review
  routes; the MCP tool's own input schema is in `src/mcp/server.ts:504-540`.
- `ReviewManager.create` already commits a new card and the withdrawal of older ones in one
  transaction and publishes only after the commit (`src/server/reviews.ts:352-376`,
  `retriesReplacedBy`). The replacement here follows that shape.
- **Who can withdraw a review.** The status `withdrawn` has exactly one writer,
  `ReviewManager.withdrawQuestion` (`src/server/reviews.ts:385-398`). It looks the review up among
  the calling session's own open asks, so no other session, the operator, Foreman or the daemon
  can produce the status, and it refuses a call-mode row. It records no actor: `resolvedBy` is
  null on a withdrawn row. Every other closure writes a different status: an answer (`answered`,
  `approved`, `rejected`), `dismissed`, `orphaned` (eviction, merge, runtime-transfer settle) and
  `superseded` (a reworded retry). Phase 1 keeps this as a contract.
- A settled review stays in the live registry until the daemon restarts; afterwards only pending
  and snoozed rows are restored (`loadPendingReviews`, `src/server/db.ts:5878`). `getReview`
  (`src/server/registry.ts:7408`) is therefore not enough to validate a withdrawn target, and no
  load-by-id reader exists in `src/server/db.ts` today.
- Review columns are added with `addColumn` beside the async-input columns
  (`src/server/db.ts:4431-4439`), mapped in `rowToReview` (`:5373-5402`) and written by
  `insertReview` (`:5453-5477`). The schema version is 40 (`:287`).
- The route maps `OpenQuestionLimitError` to 409 and everything else through `planFailure`
  (`src/server/routes.ts:5250-5253`).
- A withdrawn filed form already has a conversation entry reading "Withdrawn by the agent" with
  its reason (`questionOutcome`, `src/web/lib/async-questions.ts:198-222`), admitted on reload by
  `conversationQuestionRecordSql` (`src/server/db.ts:5675`).
- The card's tags are `kind-tag` spans in the modal header
  (`src/web/components/ReviewModal.tsx:265-268`).
- The dashboard has no route that returns one settled review by id; `GET /api/reviews` returns
  the live snapshot (`src/server/routes.ts:4408`).

## Implementation steps

1. **Wire and tool.** Add optional `revises` (a review id) to `CreateReviewSchema`, refused for
   any kind but `plan-decisions`. Add it to the tool's input schema with a description saying
   when to pass it, and send it through `postReview`. Add one sentence to `filedPlanReceipt`:
   after withdrawing, or instead of withdrawing, file the revised plan with `revises` set to
   this id.
2. **Persistence.** Add nullable `reviews.revises_review_id TEXT` and `reviews.revision INTEGER`
   with `addColumn`; map them in `rowToReview` and `insertReview`; add a load-by-id reader for
   one review row. Raise `CURRENT_DATABASE_SCHEMA_VERSION` to the next free number with its
   comment line (41 unless another plan has taken it; then the next one). An existing row reads
   as a form that revises nothing.
3. **Type.** `ReviewItem.revision?: { number: number; previousId: string }` in
   `src/shared/types.ts`, absent on every row that revises nothing.
4. **Validation and replacement** in `ReviewManager.create`, behind a new `revises` option.
   - **The rule.** The target must be a `plan-decisions` review of the same session that was
     filed (it has, or had, `waitMode: "message"`), and it must be in one of exactly two states:
     still open, or withdrawn by its own agent. This is the source plan's rule, unchanged.
   - **Who withdrew it.** Decide the second state through one named predicate,
     `withdrawnByItsAgent(review)`, beside the Phase 1 predicates, never through a bare
     `status === "withdrawn"` at the call site. Together with the same-session check it must be
     true only for a form its own agent took back. With `withdrawQuestion` the status's only
     writer (the finding above), the predicate can read the status and the absent actor. Before
     relying on that, search for writers of the status `withdrawn`; if any writer other than the
     agent's own withdrawal exists by then, record who withdrew the row and make the predicate
     read that record, so a form withdrawn by anyone else is refused.
   - **Refusals.** Refuse, with a reason the agent can act on and nothing written, when the
     target: is unknown; belongs to another session; is not a plan form; was a call-mode form
     (its call returns its answer); was answered, dismissed, orphaned by an eviction or a merge,
     or superseded; is `withdrawn` but not by its own agent; or is already revised by another
     form, which includes a form this path itself replaced.
   - **Numbering and replacement.** The new row's number is the target's number plus one, where
     a form that revises nothing is 1. An open target is settled `withdrawn` with a reason naming
     the new revision, in the same transaction as the insert; publish both after the commit, as
     `create` does for replaced retries. That withdrawal is the agent's own act (its `revises`
     names the form), and the replaced form is afterwards refused as already revised. An ask
     identical to an open form still re-attaches to it and changes nothing.
5. **Route.** Pass `revises` through both branches of `createMcpReview`, including the standing
   follow-up. Map the refusal to 409 with its message, so the tool result tells the agent why.
   A managed revision is a new plan revision with its own `bindPlanReview`; the link never
   carries an approval forward, and withdrawing the earlier form leaves its
   `managed_plan_reviews` row as an unapproved record.
6. **Earlier-version read.** Add a small dashboard read for one review by id, from the registry
   or the new reader, guarded like the other `/api` review routes.
7. **Dashboard.** Show a "Revision N" tag in the review modal header, on the inbox row's
   question and on the conversation entry of the revised form. Beside the tag, an "Earlier
   version" control shows the earlier form read-only: its title, when it was filed, the
   withdrawal reason, its plan text and its decisions, with no Submit. If that view is a new
   modal, it follows the modal inset rule in `CLAUDE.md`.
8. **Documentation.** `docs/sessions.md`: `revises` in the tool entry and in the filed plan
   decisions part Phase 1 wrote, including the refusal cases. `docs/attention-and-alerts.md`: the
   Revision tag. `docs/database-and-migrations.md` if it lists schema versions.

## Compatibility

- Both columns are nullable with no default, so an upgraded database opens unchanged and a
  downgraded daemon ignores them.
- `revises` is optional. An agent on an older MCP bundle cannot send it and keeps the Phase 1
  flow: withdraw, then file a new, unlinked form.
- The new ask may be filed or blocking. The target must have been filed; the link does not
  depend on how the new form waits.
- The sibling inbox plan also changes the schema. Whichever merges second rebases and takes the
  next version number; neither migration depends on the other.

## Tests and verification

- `test/async-input-daemon.test.ts` or a new `test/filed-plan-revision.test.ts`:
  - accepted targets: a form its agent withdrew with `withdraw_question` links and numbers; a
    revision of an open form withdraws it in one transaction, and a failed insert leaves the
    earlier form open; a chain reaches 3; a target withdrawn before a daemon restart still
    validates; an identical re-ask re-attaches;
  - refused targets, each answering 409 with its reason and writing nothing: unknown; another
    session's form, including one that other session's agent withdrew; a `request_input`
    question; a call-mode form; an answered form; a form the operator dismissed; a form closed by
    a merge; a form orphaned by an eviction; a superseded form; a form already revised;
  - who withdrew it: `withdrawnByItsAgent` is true for a form withdrawn through
    `withdraw_question` by its own session and false for every other terminal status; a row that
    is `withdrawn` but fails the predicate (built directly in the fixture, since no current path
    produces one) is refused as a target; and each path that closes a filed plan form without its
    agent (operator Dismiss, an answer, merge closure, eviction, runtime-transfer settle, a flag
    switched off) leaves a status other than `withdrawn`, so none of them can make a form a valid
    target.
- `test/local-plan-publication.test.ts`: approving a revised managed form publishes its own
  revision, and the withdrawn earlier form never approves.
- `test/async-input-migration.test.ts`: the new columns on a database at the previous version.
- `test/async-input-mcp.test.ts`: the tool sends `revises` and returns a refusal as an error.
- `test/async-input-dashboard.test.ts`: the tag text and where it renders.
- New `e2e/specs/filed-plan-revision.spec.ts` (read `e2e/README.md` first): with both flags on,
  file a form, then a second with `revises`; the inbox shows one card tagged "Revision 2"; the
  earlier-version control shows the first form's title and reason and offers no Submit; the
  conversation shows the first form as withdrawn. If the earlier version opens in a new modal,
  call `expectContentClearsBorder` from `e2e/fixtures/modal-inset.ts`. No `data-testid`.

Commands: the focused files with
`node --test --import ./test/setup-state.mjs --import tsx <file>`, then `npm run typecheck`,
`npm run lint`, `npm run build`, `npm run smoke` and `npm run test:e2e`.

## Merge and exit criteria

- Every test above passes, and Phase 1's suites pass unchanged.
- A revised form never coexists in the inbox with the form it replaces.
- The only valid targets are an open filed plan form of the same session and one its own agent
  withdrew. A form closed by anyone or anything else is refused.
- An invalid `revises` files nothing and says why.
- A database written by the previous version opens and behaves as before.
- The pull request records any deviation from this file.

## Downstream handoff

The voice plan may rely on: a revised form being an ordinary filed form with one extra field;
`ReviewItem.revision` naming the chain; and the earlier form being settled `withdrawn`. Later
work must not reuse `revises` to carry approvals or answers forward. Later work that adds another
writer of the status `withdrawn` (an operator withdrawal, a flag-off sweep) must record who
withdrew the row and keep `withdrawnByItsAgent` false for it.

## Cross-phase audit record

- Written second. Compared with Phase 1: it consumes `isFiledGate`, `openAsks`,
  `filedPlanReceipt` and the route response, and adds no reader of the flag and no change to
  counts or holds.
- Found: Phase 1's first draft of the receipt mentioned `revises`. Moved here as step 1's added
  sentence, and Phase 1 was corrected.
- Found: validating a withdrawn target needs a database read, since the registry drops settled
  rows at restart. Recorded as step 2's load-by-id reader, which step 6 reuses.
- Decision 3 was re-checked against step 4: the replacement touches no limit code, and a
  revision is never refused for the number of open asks.
- Plan validation round 1: the first version of step 4 accepted any target whose status was
  `withdrawn`, which dropped the source plan's condition that its own agent withdrew it. Step 4
  now states the rule in the source plan's words, names the predicate that decides it, lists the
  refusal, and the tests and exit criteria cover who withdrew the target. The finding that makes
  the rule decidable (one writer of the status) is recorded above and as a Phase 1 contract.
