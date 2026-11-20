# Phase 2: answer delivery and question lifecycle

Part of `docs/plans/async-input-inbox/phased-plan.md`. Source plan: `plan.md` beside this file.

## 1. Outcome

An answer to a message-mode question reaches the agent as one self-contained message that the
daemon wrote, never as operator-typed text. Questions have a complete life: bounded per session,
listable and withdrawable by the agent, held against automatic completion even when snoozed,
and closed with a recorded reason when a merge completes the task.

## 2. Entry criteria

Phase 1 is merged. May run concurrently with Phase 3.

## 3. Scope and non-goals

In scope: answer text, authorship, coalescing, merge closure, the snoozed-question hold, the
open-question bound, `list_open_questions`, `withdraw_question`. No dashboard changes. The
steer and interrupt timings are not changed. Call-mode reviews and the gates keep today's text
and authorship.

## 4. Repository findings and inherited contracts

- Inherited from Phase 1: `waitMode`, `meanwhile`, `closedReason`, `withdrawn`,
  `Session.openQuestions`, `src/shared/async-input.ts`, the `review-continuation:` prefix.
- Answer text today: `ReviewManager.continuationText`, `src/server/reviews.ts:172-189`, built on
  `reviewToolResult` in `src/shared/review-item.ts`. For an open-ended ask it carries only the
  answer.
- Authorship: `daemonAuthorOf` marks only snooze instructions as `harness`
  (`src/server/pending-turns.ts:147-149`); other rows take `expectHumanEcho` and
  `captureAcceptedPrompt` (`:961-1012`).
- Outbox insert and its transaction: `queueReviewPendingTurn`, `src/server/db.ts:5399-5488`.
  Escalation: `nextDelivery` and `canDrain`, `src/server/pending-turns.ts:639-722`.
- Merge completion and session close: `settleIfEpisodeFinished` and `closeMergedSession`,
  `src/server/tasks.ts:1706-1754`, `2467-2500`. Orphaning: `src/server/reviews.ts:680-701`.
- Daemon completion gates: `Registry.consumePromptedGeneration`
  (`src/server/registry.ts:10308-10320`); workflow holds, `src/server/workflows/manager.ts:8027`
  and `:5282`. `Registry.outstandingReviews` returns pending and snoozed (`:7276`).
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
4. **Merge closure.** When merge-driven completion closes a session, settle its outstanding
   message-mode questions as `orphaned` with `closed_reason = 'merged'` before the session is
   stopped. `settleIfEpisodeFinished` gains no review check; say so in a comment and a test.
5. **Snoozed hold.** `consumePromptedGeneration` and the two workflow-manager holds also refuse
   while the session has an outstanding message-mode question, snoozed ones included. A
   resident session is not held this way. No worker-side check: the Foreman worker reads no
   SQLite.
6. **Bound.** At most 10 open message-mode questions per session, as a constant in the shared
   module. The next ask is refused with the open titles; the MCP child returns that as an error
   result that tells the agent to work on what it can or end its turn.
7. **Tools.** `list_open_questions` returns the calling session's outstanding questions (id,
   title, asked time, `meanwhile`, pending or snoozed). `withdraw_question(id, reason)` settles
   one of the caller's own open message-mode questions as `withdrawn` with the reason, queues no
   answer, and is refused for any other session's question. Both are gated by the flag at the
   daemon. The receipt names the question id and both tools.
8. **Docs.** `docs/sessions.md` (review channel), `docs/foreman.md`,
   `docs/observability-action-manifest.md` if the new routes belong in it.

## 6. Compatibility

- Call-mode detached answers keep their present text and operator authorship.
- A queued answer row written by Phase 1 code before upgrade must still deliver.
- `withdrawn` rows never count as human resolutions and never light the retro offer.

## 7. Tests and verification

- Unit: answer text for answered, dismissed, chat-about-it and open-ended asks; authorship not
  captured as a Goal and not echoed; escalation unchanged; coalescing of two and of five
  answers, across a restart, and with one already claimed; merge closure sets status and reason
  and removes the row from pending; snoozed question refuses prompted completion and workflow
  resumption; the bound at 10 and 11; tool ownership refusals; withdrawal leaves no owed turn.
- HTTP: the two tool routes, flag off and on.
- MCP bundle: both tools; the bound's error result.
- No Playwright spec: no dashboard surface changes. If the conversation's rendering of the
  delivered turn changes visibly, add one.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.

## 8. Exit criteria

An answer is never recorded as a Goal revision; several answers wake a session once; a merge
leaves no pending question behind and records why; a snoozed question cannot be completed past.

## 9. Downstream handoff

Phase 3 renders `closedReason: "merged"` and `withdrawn` (with its reason in `response`) and
must not change how either is written.

## 10. Cross-phase audit

- Against Phase 1: any-actor delivery is Phase 1's; this phase must not re-add or narrow it.
  The bound and answer text extend Phase 1's shared module without renaming its exports. The
  snoozed hold follows Phase 1's resident exemption.
- Against Phase 3: no shared files except `docs/sessions.md` and `src/server/db.ts`, where
  Phase 3 edits only `snoozeReviewRow`. Either merge order is safe.
- Final audit: owns source-plan section 3 (except any-actor delivery), the two completion rules
  in section 4, and the bound and tools in section 7.
