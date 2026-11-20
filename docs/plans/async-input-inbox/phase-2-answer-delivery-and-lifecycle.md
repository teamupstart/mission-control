# Phase 2: answer delivery and question lifecycle

Part of `docs/plans/async-input-inbox/phased-plan.md`. Source plan: `plan.md` beside this file.

## 1. Outcome

An answer to a message-mode question reaches the agent as one self-contained message that the
daemon wrote, never as operator-typed text. Questions are bounded per session, and the agent
that asked can list its open questions and withdraw one it no longer needs.

## 2. Entry criteria

Phase 1 is merged. May run concurrently with Phase 3.

## 3. Scope and non-goals

In scope: answer text, authorship, coalescing, the open-question bound, `list_open_questions`,
`withdraw_question`. No dashboard changes. The steer and interrupt timings are not changed.
Call-mode reviews and the gates keep today's text and authorship.

Not in this phase, because Phase 1 owns them: the completion hold and the merge closure, for
every outstanding `request_input` question in either wait mode. This phase must not narrow
either.

## 4. Repository findings and inherited contracts

- Inherited from Phase 1: `waitMode`, `meanwhile`, `closedReason` (written by Phase 1),
  `withdrawn` (declared by Phase 1, written here), `Session.openQuestions`,
  `src/shared/async-input.ts`, the `review-continuation:` prefix, both completion rules.
- Answer text today: `ReviewManager.continuationText`, `src/server/reviews.ts:172-189`, built on
  `reviewToolResult` in `src/shared/review-item.ts`. For an open-ended ask it carries only the
  answer.
- Authorship: `daemonAuthorOf` marks only snooze instructions as `harness`
  (`src/server/pending-turns.ts:147-149`); other rows take `expectHumanEcho` and
  `captureAcceptedPrompt` (`:961-1012`).
- Outbox insert and its transaction: `queueReviewPendingTurn`, `src/server/db.ts:5399-5488`.
  Escalation: `nextDelivery` and `canDrain`, `src/server/pending-turns.ts:639-722`.
- `Registry.outstandingReviews` returns pending and snoozed (`src/server/registry.ts:7276`).
- MCP tool registration pattern: `src/mcp/server.ts`; route validation per
  `docs/agent-guides/change-contracts.md`.

## 5. Implementation steps

1. **Answer text.** In `src/shared/async-input.ts` add the answer message for message-mode
   questions: the question in full, the agent's `meanwhile` line, how long ago it was asked, the
   answer from `reviewToolResult`, then the instruction to reconcile, or to keep what it chose
   on a dismissal, and to resume anything this message interrupted. `continuationText` uses it
   for message-mode rows only.
2. **Authorship.** Give message-mode answer rows daemon authorship so they skip the human echo
   and Goal capture and are not drawn as an operator turn. Keep the turn id under the
   `review-continuation:` prefix. Pin with a test that these rows still steer at 60 s and
   interrupt at 180 s.
3. **Coalescing.** Answers queued for one conversation and not yet claimed are delivered as one
   message. Preferred route: at enqueue, fold the new answer into the unclaimed answer row for
   that conversation inside the transaction that stamps `continuation_queued_at`. Idempotency
   per review id must survive a daemon restart.
4. **Bound.** At most 10 open message-mode questions per session, as a constant in the shared
   module. The next ask is refused with the open titles; the MCP child returns that as an error
   result that tells the agent to work on what it can or end its turn.
5. **Tools.** `list_open_questions` returns the calling session's outstanding `request_input`
   questions in either wait mode (id, title, asked time, `meanwhile`, pending or snoozed).
   `withdraw_question(id, reason)` settles one of the caller's own open message-mode questions
   as `withdrawn` with the reason, queues no answer, and is refused for any other session's
   question and for a call-mode question, whose call is still waiting on it. A withdrawn
   question is no longer outstanding, so it stops holding completion. Both tools are gated by
   the flag at the daemon. The receipt names the question id and both tools.
6. **Docs.** `docs/sessions.md` (review channel), `docs/foreman.md`,
   `docs/observability-action-manifest.md` if the new routes belong in it.

## 6. Compatibility

- Call-mode detached answers keep their present text and operator authorship.
- A queued answer row written by Phase 1 code before upgrade must still deliver.
- `withdrawn` rows never count as human resolutions and never light the retro offer.

## 7. Tests and verification

- Unit: answer text for answered, dismissed, chat-about-it and open-ended asks; authorship not
  captured as a Goal and not echoed; escalation unchanged; coalescing of two and of five
  answers, across a restart, and with one already claimed; the bound at 10 and 11; tool
  ownership and call-mode refusals; withdrawal leaves no owed turn and releases Phase 1's
  completion hold; Phase 1's completion-rule table still passes unchanged.
- HTTP: the two tool routes, flag off and on.
- MCP bundle: both tools; the bound's error result.
- No Playwright spec: no dashboard surface changes. If the conversation's rendering of the
  delivered turn changes visibly, add one.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## 8. Exit criteria

An answer is never recorded as a Goal revision; several answers wake a session once; a session
cannot exceed the bound; an agent can list and withdraw its own questions; both of Phase 1's
completion rules behave exactly as Phase 1 left them.

## 9. Downstream handoff

Phase 3 renders `withdrawn` (with its reason in `response`) and must not change how it is
written.

## 10. Cross-phase audit

- Against Phase 1: any-actor delivery is Phase 1's; this phase must not re-add or narrow it.
  The bound and answer text extend Phase 1's shared module without renaming its exports.
- Against Phase 3: no shared files except `docs/sessions.md` and `src/server/db.ts`, where
  Phase 3 edits only `snoozeReviewRow`. Either merge order is safe.
- Plan validation round 1: the merge closure and the snoozed-question hold left this phase for
  Phase 1, and were widened there to every outstanding `request_input` question in either wait
  mode. This phase now only depends on them: a withdrawal must release the hold, and the tools
  list questions in both wait modes.
- Final audit: owns source-plan section 3 (except any-actor delivery), and the bound and tools
  in section 7.
