# Decision dialog: "Chat about it"

Issue: [#1351](https://github.com/teamupstart/mission-control/issues/1351)

## Problem

When an agent blocks on `request_input` or `request_plan_decisions`, the review modal offers
only **Submit** (every question answered) or **Dismiss** (nothing answered). Neither one fits
"I can answer two of these, but I need to talk the third one through first":

- **Close (esc)** leaves the review pending. The agent stays blocked, the session keeps
  needing attention, and the human ends up dismissing a stale card later, which can confuse
  the agent.
- **Dismiss** returns `Decision request dismissed without a response.` The agent may then
  pick something on its own and carry on.

Claude Code's own question menu always offers a way out into conversation. Mission Control's
dialog should too, per question, so the human can answer what they can and move the rest to
chat in one submission.

## Behavior

1. Every question in an option-carrying form (`request_plan_decisions`, and `request_input`
   with options) can be marked **Chat about it**. A marked question counts as answered, so
   Submit enables once every question is either answered or marked.
2. A free-text `request_input` (no options) gets a **Chat about it** button beside
   Dismiss and Send answer.
3. Submitting resolves the review as `answered`, so the agent unblocks with one tool result
   carrying both the real answers and the list of questions moved to chat. The modal closes,
   so the session no longer needs attention for that card.
4. The agent's tool result names each moved question and tells it what to do:

   ```text
   Plan decisions submitted:

   • Where should review drafts persist?
     → localStorage

   • Should the migration ship in this PR?
     → Chat about it

   • Name the setting
     → reviewDrafts.enabled

   The human wants to discuss this decision with you in conversation before choosing:
   - Should the migration ship in this PR?

   Do not choose it yourself, and do not ask it again with request_input or
   request_plan_decisions. Act on the other answers only where they do not depend on it.
   Then, in your next message, explain it in plain terms: the context behind it, the trade-off
   you cannot settle on your own, and what you would need to know to decide. End your turn
   after that message so the human can reply in this session.
   ```

   (The last three sentences are wrapped here for width; the agent receives them as two
   lines.)

5. The structured record keeps the fact: `PlanDecisionAnswer` gains an optional
   `chat: true`. `formatResponse`, `isAnswered`, the review schema, the Foreman delegated
   answer path (`control_session`), and `ReviewAnswerCard` (conversation replay, shown as a
   "Moved to chat" tag on that question) all honor it. Records without the field read exactly
   as before, so no migration is needed.
6. Scope: the review modal and the attention inbox, which both render `ReviewCard`. The
   SDK-runtime native `AskUserQuestion` pane and diff/plan approve-reject reviews are out of
   scope.

## Option A: a "Chat about it" row in every question

Each question gets one extra choice at the bottom of its options, styled apart from the
agent's options (dashed border, chat glyph, muted text). Picking it is exclusive: it clears
the question's other picks, and picking a real option clears it. The footer gains a
**Chat about all** button that marks every question and submits. Submit's label becomes
**Submit & chat (1)** while any question is marked.

```text
┌ Where should review drafts persist? ──────────────┐
│ (•) localStorage · recommended                    │
│ ( ) Server-side table                             │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ ( ) 💬 Chat about it                               │
└───────────────────────────────────────────────────┘
[Dismiss]                 [Chat about all] [Submit & chat (1)]
```

Trade-off: the most discoverable, and it reads exactly like the Claude Code menu. Costs one
row per question, and it lives inside the agent's options list, so it must be visually
unmistakable as ours.

## Adopted decisions

Chosen in the plan review on 2026-11-04:

1. **Layout**: Option A, a "Chat about it" row in every question. Options B (header toggle)
   and C (footer only) were not adopted.
2. **What the agent does with a moved question**: explain it (context, the trade-off it
   cannot settle, what it would need to know) in its next message, then end its turn and wait.
3. **After submitting**: close the dialog (even with other reviews pending) and focus the
   session's message composer.
4. **Follow-up**: implement in this session; no phased plan.

## Implementation outline

- `src/shared/types.ts` and the review resolve schema: optional `chat` on
  `PlanDecisionAnswer`.
- `src/shared/review-item.ts`: `formatResponse` prints `→ Chat about it` and appends the
  instruction trailer. `isAnswered` (`src/web/lib/reviews.ts`) treats `chat` as answered.
- `src/web/components/PlanDecisions.tsx`: the Chat about it row, Chat about all, and the
  Submit & chat (N) label;
  `src/web/lib/review-drafts.ts` keeps the mark in the parked draft.
- `src/web/components/ReviewModal.tsx`: free-text `input` gets **Chat about it**; a moved
  answer closes the modal and focuses the composer through `src/web/lib/composer-focus.ts`,
  consumed by `ConsoleDetail`.
- `src/web/components/ReviewAnswer.tsx`: "Moved to chat" in conversation replay.
- `src/mcp/server.ts`: tool descriptions mention that a question may come back moved to chat.
- `src/mcp/product-issues.ts`: a confirmation moved to chat publishes nothing and returns
  `outcome=cancelled reason=chat published=false` with the instruction.
- Tests: `test/` for `formatResponse`, `isAnswered`, schema, and markup; an `e2e/` spec that
  answers one question, moves another to chat, submits, and asserts the agent-facing response
  and the conversation replay.
