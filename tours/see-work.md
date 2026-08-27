# See the work

## Fleet and the Line
<!-- stage: line -->

The Line summarizes the whole work pipeline: intake → backlog → working → review → decide → shipped. Amber means there is something you can move.

## Board View
<!-- stage: board -->

This is your 10,000 foot view of your agents. If an agent is blocked waiting for you, it'll be in "Needs You". If it's idle, it's run out of work to do.

## Session detail
<!-- stage: session-detail -->

Chat with your agent (Conversation), queue up work that will be verified by Foreman before scheduling more (Work queue), see workflow status, the code diff, or any file in the worktree.

## Open Dispatch
<!-- stage: dispatch -->

Dispatch turns an intent into a live session. Next opens the real form so you can see the work contract before anything is scheduled.

## Choose the kind
<!-- stage: dispatch-kind -->

Kind sets the outcome you expect from the agent. The tour’s fixed demo uses Ship.

- **Chat:** Have an open-ended conversation without a planned artifact.
- **Scout:** Investigate and report findings without producing a diff.
- **Plan:** Produce a reviewed plan and optionally schedule the work.
- **Ship:** Deliver a reviewable change with a completion path.
- **Pipeline:** Start an ai-conductor engineering workflow (requires ai-conductor installed)

## Brief ready
<!-- stage: dispatch-input -->

The tour filled the real task input with its read-only demo brief. This is the first intent for the session. What do you want this agent to do?

## Choose what follows
<!-- stage: dispatch-workflow -->

Workflows run reusable review and follow-up steps after an agent finishes its work. None leaves the session with you instead.

## Dispatch the task
<!-- stage: dispatch-submit -->

The launch contract is ready. Click Dispatch now in the modal to schedule the task.

## Working
<!-- stage: working -->

The scheduled task appears under Working while the agent gets started. Its tile is the live summary; opening it opens the conversation window with the agent.

## Needs You
<!-- stage: needs-you -->

When the task asks through Mission Control’s review channel, its same tile moves to Needs You. The state change is the prompt to review, not a separate notification workflow.

## Choose and submit
<!-- stage: review -->

If an agent needs your input, you'll get a Needs You prompt. Open your catalog of blocking reviews with (e). Pick anything to continue.

## Idle
<!-- stage: idle -->

After the answer returns, the task settles under Idle. The session is still available for another instruction. If a task is idle, it means the agent, and your Foreman thinks the work is complete.

## Complete or run a retro
<!-- stage: actions -->

Complete records an outcome and closes the session. A retro keeps the task open while the session proposes memories for you to review.

## Complete the tour
<!-- stage: complete -->

The real Complete dialog records an optional outcome before closing the session. “Tour demo” is prefilled as a generic note. Run a retro first would keep the work open; Complete & close would finish it. The guide’s Complete tour button performs that fixed completion safely.
