---
name: grill
description: Interview the human in rounds of selectable decisions before any plan is drafted, asking every question that can be asked now with a recommended answer, until nothing is left to ask. Use when any task was dispatched with Grill me first, or whenever you are asked to grill, stress-test, or interview someone about a plan, idea, or decision before writing it down.
metadata:
  mission:
    category: planning
    enforcement: triggered
---

# Grill

Interview the human until you share one understanding of the work, and only then write
anything down. A plan drafted before its decisions are made is a plan built on guesses, and
the guesses are the part nobody reviews.

This skill adapts Matt Pocock's `grilling` skill (MIT License, Copyright (c) 2026 Matt Pocock,
<https://github.com/mattpocock/skills>). The method is his. What changes here is the delivery
channel: every round is a Mission Control decision form instead of a chat message.

## The method

1. **Map the work as a design tree.** Every decision branches into the decisions that hang off
   it. Settling "where does this live?" is what makes "what is it called there?" askable.
2. **Work the tree in rounds.** The **frontier** is every decision whose prerequisites are
   already settled: the questions you can ask now without guessing at an answer you have not
   heard yet. Ask the whole frontier in one round. A question that depends on another
   question still open in this round belongs to a later round.
3. **Recompute after every round.** Each answer reshapes the tree. Settled decisions push the
   frontier outward and unblock the questions that waited on them.
4. **Facts are your job; decisions are the human's.** When a frontier question needs a fact
   from the repository, the tools, or the environment, find it yourself or hand it to a
   subagent. Never ask the human for something you could look up. Do not block the round on
   it: a running lookup is an unsettled prerequisite, so only the questions downstream of it
   wait. Ask the rest of the frontier now.
5. **Stop when the frontier is empty.** Every branch visited, nothing silently assumed.

## Every round is one decision form

Ask each round with the Mission Control MCP tool **`request_plan_decisions`**, never in prose.
One call per round, carrying the whole frontier:

- `title`: what is being decided, and the round number (`Round 2: export format`).
- `plan`: a short markdown summary of what is settled so far and what this round decides.
  The human reads it above the questions, so it is where the context for them lives.
- `decisions`: one entry per frontier question.
  - `id`: a stable kebab-case id for the question.
  - `question`: the question itself, with enough context to answer it without scrolling.
  - `options`: the answers you can see. Put the one you recommend **first** and set
    `recommended: true` on it. Use `detail` for the one-line trade-off.
  - `allowOther: true` on **every** decision, so the human is never boxed into your options.
  - `multiSelect: true` only when several answers can genuinely hold at once.

The tool blocks until the human submits or dismisses the round, then returns their answers.

Do not count on the form opening on your recommendation. It may open with nothing selected,
so the human picks every answer, and `recommended: true` only marks your advice. An answer is
what they selected or wrote, nothing else.

- **Submitted:** record each answer, including any Other text, as settled, and compute the
  next frontier.
- **A question marked `→ Chat about it`:** the human moved it to chat, so it is not settled.
  Explain it in your next message and end the turn; do not ask it again in a form until the
  conversation has settled what was unclear, and never answer it with your recommendation.
- **Dismissed:** stop the session. A dismissed round is not an answer. Never infer a
  selection from it, never fall back to your recommendations, and never continue to a plan.
  Say that the interview was dismissed and end the turn.

## At least one round, always

Grilling is never skipped. A detailed request still hides decisions its author made without
noticing, and one round is how they surface. When the request really does settle almost
everything, the round is short: confirm the load-bearing assumptions you would otherwise make
silently, each as a decision with your reading recommended.

## When the frontier is empty

Summarize the settled decisions and hand them to whatever asked for the interview. A task
dispatched with Grill me first carries on with its own work, unchanged, with the settled
decisions as part of its request. Record every decision, with the answer the human gave, in
whatever the task produces - a plan or a document - so the review that follows reads the
decisions rather than rediscovering them.

## What not to do

- Do not ask a question whose answer you could find yourself.
- Do not ask one question per form. A round is the whole frontier.
- Do not ask a question that depends on another one still open in the same round.
- Do not draft the plan, or any file, before the frontier is empty.
- Do not treat silence, a dismissal, or your own recommendation as the human's answer.
