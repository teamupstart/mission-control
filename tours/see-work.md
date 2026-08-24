# See the work

## Fleet and the Line
<!-- stage: line -->

The Line summarizes the whole work pipeline: intake → backlog → working → review → decide → shipped. Amber means there is something you can move.

## Board View
<!-- stage: board -->

The Board places backlog beside session-state columns. Column height shows the fleet’s shape, and opening a tile reveals that session’s operating detail.

## Session detail
<!-- stage: session-detail -->

Conversation, Work queue, Workflows, Diff, and Files make one session’s desk: talk, queued work, checks, changes, and the working tree in one place.

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

## Brief ready
<!-- stage: dispatch-input -->

The tour filled the real task input with its read-only demo brief. Repo and Crew show the full launch contract: Ship on Codex with GPT-5.6 Terra. Your own saved Dispatch draft remains untouched underneath this temporary one.

## Choose what follows
<!-- stage: dispatch-workflow -->

Workflows run reusable review and follow-up steps after an agent finishes. None leaves the session with you instead. This demo selects None because its Needs You request comes directly from the task.

## Dispatch the task
<!-- stage: dispatch-submit -->

The launch contract is ready. Click Dispatch now in the modal to schedule the Terra task. The rest of the form stays visible so you can review it before the task leaves.

## Working
<!-- stage: working -->

The scheduled task appears under Working while Terra starts its turn. Its tile is the live summary; opening it returns to the same session desk you just saw.

## Needs You
<!-- stage: needs-you -->

When the task asks through Mission Control’s review channel, its same tile moves to Needs You. The state change is the prompt to review, not a separate notification workflow.

## Choose and submit
<!-- stage: review -->

Pick one option in the real review dialog and submit it. The tour pauses here; your answer unblocks the session and no choice is made for you.

## Idle
<!-- stage: idle -->

After the answer returns, the task settles under Idle. The session is still available for another instruction, but this demo deliberately sends none.

## Complete or run a retro
<!-- stage: actions -->

Complete records an outcome and closes the session. A retro keeps the task open while the session proposes memories for you to review. Next opens the real completion dialog; this tour will not run a retro.

## Complete the tour
<!-- stage: complete -->

The real Complete dialog records an optional outcome before closing the session. “Tour demo” is prefilled as a generic note. Run a retro first would keep the work open; Complete & close would finish it. The guide’s Complete tour button performs that fixed completion safely.
