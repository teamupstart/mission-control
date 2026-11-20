# Phase 1: file and continue

Part of `docs/plans/async-input-inbox/phased-plan.md`. Source plan: `plan.md` beside this file.

## 1. Outcome

With the `async-input` preview flag on, `request_input` returns at once with a receipt and the
agent keeps working. A session that then stops with a question open shows as waiting and is not
completed by automation. A resident keeps iterating. An answer from the inbox wakes the agent
through the existing outbox. With the flag off nothing changes.

## 2. Entry criteria

The planning pull request is merged. No phase dependencies.

## 3. Scope and non-goals

In scope: the flag, the cross-phase contracts, the ask path, what an open question holds,
alerts, the resident loop, agent instructions, docs for all of it.

Not in this phase: answer wording, authorship and coalescing, merge closure, the snoozed-question
hold, the open-question bound and the two new tools (Phase 2); the card status line, badge chip,
conversation entry, Remind me later copy and Residents drawer (Phase 3).

## 4. Repository findings

- `request_input` creates then long-polls: `src/mcp/server.ts:885-911`, `189-236`.
- `POST /mcp/reviews` returns `{ id, sessionId }`: `src/server/routes.ts:5151-5204`, schema
  `CreateReviewSchema` in `src/shared/protocol.ts:661-700`.
- `ReviewManager.create` and `retriesReplacedBy`: `src/server/reviews.ts:280-361`.
- `insertReview` and the review migrations: `src/server/db.ts:5220-5239`, `4257-4276`.
- `Registry.countPending` and `refreshPendingCount`: `src/server/registry.ts:7235-7240`,
  `7306-7315`. `report_blocker` refusal: `:8882-8889`.
- `reportBucket`, `needsYouReason`: `src/shared/session.ts:405-445`. Its hand mirror:
  `src/web/lib/format.ts:307-345`. A session's task kind: `TaskSummary.kind`,
  `src/shared/types.ts:2759-2767`.
- Direct `pendingReviews` readers: `src/server/ensembles/manager.ts:99-101`,
  `src/server/ensembles/finalize-deps.ts:95`, `src/server/tasks.ts:4950`, `5165`.
- Alerts: `src/shared/alerts.ts:253-267`.
- Resident wake hold reads the bucket: `src/server/residents/loop.ts:142`, `179`, `209`, `247`.
  Loop prompt: `src/shared/residents.ts:347`. Agent Shepherd source:
  `residents/agent-shepherd.md`.
- Continuation eligibility excludes Foreman: `src/server/db.ts:5384`, `5407`;
  `isConversationResolvedReview` in `src/shared/review-item.ts`.
- Flag gates: `docs/feature-flags.md`, `src/server/feature-flags/index.ts`.

## 5. Implementation steps

1. **Flag.** Add `async-input` (`preview`) to `src/shared/feature-flag-registry.ts`. As the
   first real flag, add the browser assertion the flag guide requires.
2. **Contracts.** In `src/shared/types.ts` add `ReviewItem.waitMode`, `meanwhile`,
   `closedReason`, the `withdrawn` status and `Session.openQuestions`, as listed in
   `phased-plan.md`. Give `withdrawn` a branch wherever statuses are switched on
   (`reviewToolResult`, draft settling). Handle `openQuestions` being absent in an older
   snapshot as zero.
3. **Storage.** Add `wait_mode`, `meanwhile`, `closed_reason` with `addColumn` beside the snooze
   columns; write and read them. A message-mode insert sets `mcp_wait_detached_at` to its
   creation time in the same statement.
4. **Shared module.** Create `src/shared/async-input.ts` (browser-safe): the wait-mode decision
   as a pure function of flag, kind, `snoozable`, `asyncCapable` and messageability, and the
   receipt text with the four points in source plan section 2.
5. **Route and manager.** `CreateReviewSchema` accepts `asyncCapable` and `meanwhile` (one line,
   at most 300 characters, `input` only). `createMcpReview` decides the mode with
   `featureEnabled("async-input")` and `canMessage(session)` and returns
   `{ id, sessionId, wait, receipt? }`. `ReviewManager.create` stores the mode; an exact
   duplicate still returns the open row; `retriesReplacedBy` ignores message-mode rows on
   either side.
6. **MCP child.** `request_input` takes `meanwhile`, sends `asyncCapable: true`, returns the
   receipt when told `wait: "message"` and long-polls otherwise. Reword the tool description to
   be true in both modes.
7. **Counts.** `countPending` excludes message-mode rows; a sibling count feeds
   `Session.openQuestions`; one `session_upsert` carries both. The `report_blocker` refusal
   applies to call-mode questions only.
8. **Holds.** Add the idle clause to `reportBucket` and `needsYouReason` ("waiting on your
   answer") and mirror it in `unpausedStateDisplay`. The clause does not apply to a resident
   session (`task.kind === "resident"`): it wakes on its own cadence, so open questions alone
   never make it `needs-you`. Make the direct `pendingReviews` readers in section 4 count
   `openQuestions` too.
9. **Any-actor delivery.** For message-mode rows, admit `foreman` and `standing-approval` in
   both eligibility predicates and in the continuation gate in `publishSettled`.
10. **Alerts.** Raise the review alert when `openQuestions` grows, titled by whether the session
    is working ("has a question, still working") or stopped ("needs your answer").
11. **Residents.** With the exemption in step 8 the loop's existing `needs-you` hold and its
    `resume()` refusal no longer cover open message-mode questions, while call-mode reviews,
    gates and pane dialogs still hold. Pin both with tests rather than adding a second
    predicate. Add the one-sentence reminder to `RESIDENT_LOOP_PROMPT`. Update
    `residents/agent-shepherd.md` and regenerate the built-in profiles.
12. **Instructions and docs.** Reword the ask-channel redirect, the Codex developer instruction,
    the `mockups` skill line and the comments that say the call always blocks. Update
    `docs/sessions.md`, `docs/residents.md`, `docs/attention-and-alerts.md`, `docs/overview.md`
    and document the flag.

## 6. Compatibility

- New columns are nullable with no default: an existing row is a call-mode question.
- An older MCP child sends no `asyncCapable` and is answered `wait: "call"`.
- Turning the flag off leaves open message-mode questions answerable and delivered.
- Persisted status ids are append-only: `withdrawn` is appended, nothing is renamed.

## 7. Tests and verification

- Unit: wait-mode decision table; receipt text; migration from version 35 with an open review;
  born-detached insert; duplicate re-attach; no reworded-retry withdrawal; counts;
  `reportBucket` and `unpausedStateDisplay` agree for working, idle, unconfirmed and resident
  sessions; each direct reader; Foreman answer queued; alert trigger; resident wake not held by
  an open question and still held by a call-mode review; the attention-pill invariant holds.
- HTTP: mode negotiation for flag off, old child, unmessageable session.
- MCP bundle: receipt without a long poll; long poll when told `call`.
- Playwright: flag Settings row and second-window toggle; with the flag on, a fake-agent session
  asks, is not amber while working, turns amber when it stops, and resumes after an answer from
  the inbox; a resident wakes on cadence with a question open. No model tokens.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## 8. Exit criteria

Flag off: every existing test passes unchanged. Flag on: the Playwright flows above pass and no
consumer listed in source plan section 4 acts on a stopped session with a question open.

## 9. Downstream handoff

Phases 2 and 3 rely on every contract in `phased-plan.md` and must not rename them. Known and
left for Phase 2: an answer is still operator-authored text and may be captured as a Goal; a
merge closes questions only at eviction and records no reason. Left for Phase 3: no working-tone
chip, no conversation entry for an open question, and a resident with open questions is not yet
listed in the drawer's needs-you group.

## 10. Cross-phase audit

- Written first. Owns every shared name used by Phases 2 and 3.
- After Phase 2: any-actor delivery moved here from Phase 2 so the flag is safe alone;
  `closed_reason` and `withdrawn` declared here though produced in Phase 2.
- After Phase 3: the amber label and idle clause stay here; Phase 3 adds only the working-tone
  chip to the same function. The snooze instruction rule moved to Phase 3 with its sheet copy.
  The resident exemption was added here once the drawer's grouping was read: it groups by
  attention tone, so Phase 3 owns listing a resident's questions.
- Final audit: every source-plan section 1, 2, 4, 6, 8 and 9 requirement is owned here, except
  the drawer line of section 6 (Phase 3) and the two completion rules of section 4 (Phase 2).
