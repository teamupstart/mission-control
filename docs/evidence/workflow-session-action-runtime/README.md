# A session action executing against a real session

Runtime evidence for Phase 2 of the SessionAction plan. This phase adds no visible control -
authoring is still withheld - so the thing worth showing is not a screen but a sequence: an
authored instruction reaching a real agent's pane, that turn being observed to finish, and the
run resuming downstream on evidence captured afterwards.

It is proved by `e2e/specs/workflow-session-action-run.spec.ts`, which is the only layer in
the repository where that whole sequence is real. The `node:test` runtime suite drives the
real Registry, store, engine and manager, but it stubs the pane, so the packet never leaves
the process.

```sh
npm run build
npx playwright test --config e2e/playwright.config.ts \
  e2e/specs/workflow-session-action-run.spec.ts --reporter=list
```

```
Running 2 tests using 2 workers

  ✓  2 [chromium] › workflow-session-action-run.spec.ts:160:1 › Live types the authored instruction once and resumes on a fresh child segment (17.0s)
  ✓  1 [chromium] › workflow-session-action-run.spec.ts:250:1 › Preview prepares the identical packet and types nothing at all (23.1s)

  2 passed (23.6s)
```

## What is real in that run

The dispatch cuts a real git worktree of the seeded repository. The session is a real
SDK-runtime session with a real child process behind it. The workflow is created, published,
bound and submitted through the same HTTP routes the dashboard uses - nothing is seeded into
SQLite, because a fixture that writes a row proves the row rather than the path an operator
takes to it. The only substitution is the model: `MISSION_CLAUDE_BIN` points at a fake that
speaks Claude Code's control protocol and writes a real transcript, which is what makes the
suite free to run.

The published graph is `Session -> Tidy (session action) -> End`, and the action's completion
adapter is `session_turn` - the one this build can prove. A `pull_request` graph is still
refused at Publish, which `e2e/specs/workflow-session-action.spec.ts` pins.

## The Live proof

Both consent gates are set the way an operator would set them, through
`PUT /api/workflows/config`: the machine-wide Workflows switch, and this exact repository on
the allowlist. Without the second the packet is prepared and refused with
`live_not_authorized`, which is correct behaviour and a different test.

The spec then asserts, in order:

- exactly one `session_action` delivery reaches `delivered`, and it names the attempt that
  owns it - so two action nodes in one submission could never be collapsed into one packet;
- its payload carries the authored Markdown verbatim after a small envelope, ending in the
  exact prompt bytes rather than a summary the daemon composed;
- the run sits in `waiting_for_action` / `session_action`, its own status, so nothing mistakes
  an action turn for a parked repair round;
- the action attempt completes - polled on the ATTEMPT, not on the child row, because the
  continuation reserves its segment before it captures;
- the child submission is `(round 1, segment 1)` with the parent's id, the action's node id
  and the action's attempt id on it, and the run summary still reports `round 1`: an action
  spends no repair budget however many of them a round executes;
- exactly one action attempt exists, completed, still scoped to the PARENT submission it ran
  against;
- the child carries exactly one receipt - the action's own `complete` edge, sourced from that
  parent attempt. Session is not re-submitted into the child, which is the difference between
  a continuation and a repair round;
- the run reaches `completed`, and exactly one packet ever reached the pane;
- and the instruction is visible in the session's own conversation, which is the difference
  between a packet the daemon wrote down and a packet the agent received.

## The Preview proof

Live is fully authorized in this arm too, so nothing is refused for want of consent. The only
reason no text is typed is that the binding is Preview - which is the whole promise.

The packet is prepared and readable, byte-identical to what Live would send, and its state
stays `prepared`. The session is then allowed to settle back to idle and left alone for
twenty seconds, because a settled idle session is the ORDINARY state of a Preview target: the
risk being tested is that unrelated later activity gets read as the action having run. After
that wait the delivery is still `prepared`, the attempt is still `waiting`, there is still
exactly one submission, and the conversation carries no trace of the instruction.

## The stale-idle rule this depends on

The session is normally idle at the instant a packet is typed, so idleness proves nothing on
its own. A confirmed send persists a transcript/harness anchor; a pickup signal strictly newer
than that anchor is required; only then does `settledIdle` count, and `needs-you` is an
operator wait rather than a settled turn. That rule is exercised directly, including its
negative cases, in `test/session-action-runtime.test.ts`.
