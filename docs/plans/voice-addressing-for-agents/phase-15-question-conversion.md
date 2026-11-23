# Phase 15: converting a blocking question

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V25.

## 1. Outcome

A spoken message reaches an agent that is blocked inside a question: the question is filed, the
agent is released with a receipt, and the message is delivered. A session whose MCP child cannot
understand this keeps waiting and delivery still reports `held`.

## 2. Entry criteria

Phase 5 is merged. (Filed Phase 1 is already behind it.)

## 3. Scope and non-goals

In scope: contract K, the MCP child's capability, the conversion, the filed plan's contract
sentence, docs and tests. Not in scope: typed messages, which do not convert; any dashboard
change.

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- The child loops in `waitForResolution` (`src/mcp/server.ts:220`) on `GET
  /mcp/reviews/:id/wait` (`src/server/routes.ts:5528`) while the row is pending. `wait`
  (`src/server/reviews.ts:695`) re-attaches a message-mode row as a call at `:723`.
- A filed ask is created with a receipt from `asyncInputReceipt` (`src/shared/async-input.ts:67`),
  which the child returns as the tool result (`src/mcp/server.ts:1074`).
- The daemon knows a child's abilities per request (`asyncCapable`, `src/mcp/server.ts:139`), not
  per session.
- The filed plan's contract: the wait mode is decided at insert, with one conversion, from filed
  to call, and no path from call to filed. That plan leaves this conversion to voice.
- Inherited: the `held` outcome (contract F). Phase 6 draws a card for that outcome; this phase
  does not depend on it and checks the outcome only.

## 5. Implementation steps

1. **Capability.** The MCP child adds `convertible=1` to each wait poll. The review manager
   records, per waiting poll, whether it said so.
2. **Conversion.** `ReviewManager.convertToFiled(reviewId)`: for a pending call-mode `input` or
   `plan-decisions` review whose current waiter is convertible, set the row to message mode and
   stamp a new column, `filed_by_voice_at`, in one transaction, then answer the waiter with the
   row plus `converted { receipt }`. The receipt is the text a filed ask would have received and
   is rebuilt from the row, so it is the same each time. It returns false, and changes nothing,
   when the waiter is not convertible or the row is no longer pending.
3. **A lost response.** The answer to the waiter can be lost: the long poll may time out or its
   connection may drop as the transaction commits. So the conversion is durable for the waiter.
   While a row is pending with `filed_by_voice_at` set, a wait poll that says `convertible=1`
   gets the `converted` receipt again and `wait` does not call `attachCall` for it. A poll that
   does not say so is handled as today.
4. **Child.** On a wait response with `converted`, the child returns the receipt as the tool
   result and stops polling. If it never received the first response it polls again, and step 3
   gives it the receipt then.
5. **Delivery.** Phase 5's deliverer calls `convertToFiled` for each pending call-mode ask of the
   target before it submits. When each converts, the outcome is `queued` or `sent` and the
   open-questions note lists the converted asks. When one does not, the outcome stays `held`.
6. **Contract sentence.** In the code comment and document that state the filed plan's wait-mode
   rule, add: voice converts a call to a filed ask when the waiting child asked for it; from then
   on the row is a filed ask for each rule of that plan (listed, withdrawable, held by completion,
   closed by a merge).
7. **Docs.** `docs/voice.md`, `docs/attention-and-alerts.md`, `docs/database-and-migrations.md`.

## 6. Data and compatibility

One migration: a nullable column `reviews.filed_by_voice_at`, so an existing database opens
unchanged. It takes the next schema number at merge time. An older child sends no
`convertible`, is not converted, and behaves as today. A newer child against an older daemon
sends a query the daemon ignores.

## 7. Tests and verification

- `test/voice-conversion.test.ts`: a convertible waiter is released with the receipt and the row
  is filed; a non-convertible waiter is untouched; a row answered in the same moment is not
  converted; a converted ask is listed by `list_open_questions` and can be withdrawn; with the
  first `converted` response dropped, the next convertible poll receives the same receipt, the
  row stays in message mode and `attachCall` is not called.
- A database upgrade test for the column.
- `test/mcp-wait-conversion.test.ts`, with the real MCP child against a test daemon: the tool
  call returns the receipt and makes no further poll.
- Additions to `test/voice-delivery-http.test.ts`: blocked and convertible gives `queued`; blocked
  and not convertible gives `held`.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the tests.

## 8. Merge and exit criteria

A spoken message unblocks a current session and is delivered. For an older session nothing
changes: delivery still reports the `held` outcome, as section 7's tests assert.

## 9. Downstream handoff

None inside this plan. Typed messages could use `convertToFiled` later; that is not planned here.

## 10. Cross-phase audit record

- This phase changes one sentence of the filed plan's contract, as that plan's coordination note
  and this plan's source both state. No rule of that plan reads what a row's mode used to be, so
  a converted row needs no extra column.
- The held card's words are Phase 6's; this phase changes how often the `held` outcome occurs
  and so how often that card appears.
- Pull request review: a `converted` response lost in transit would have let the child's next
  poll re-attach the ask as a call while the message had already been reported delivered. Step 3
  and `filed_by_voice_at` make the conversion durable, and a test drops the first response.
- Pull request review, third round: the exit criterion named Phase 6's held card, which this
  phase's one prerequisite, Phase 5, does not build. It now names the `held` outcome, which
  Phase 5 owns and section 7 tests, so this phase can merge before or after Phase 6.
