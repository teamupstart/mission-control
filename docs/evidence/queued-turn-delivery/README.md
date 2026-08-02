# Queued turn delivery evidence

Four frames from one green run of `e2e/specs/queued-turn-delivery.spec.ts`, taken between the
assertions that spec already makes. They are photographs of the run that passed, not of a
scripted walk staged to look like it: the same test that asserts the row leaves takes the
pictures, so a frame exists only because the assertions under it held.

The spec runs the identical flow against **both** embedded harnesses. That pairing is the
point rather than thoroughness for its own sake: the fix rests on the claim that the outbox
never branches on the agent, and two harnesses arriving at the same two frames is how that
stops being a code-reading argument. The drivers disagree underneath it - Claude's `send`
accepts a second turn into its own queue, Codex's would turn one into a `turn/steer` - and the
row has to survive the idle transition on each.

The behaviour is the fix for a queued conversation turn that never left the editable outbox on
an Agent SDK session. The outbox armed its delivery timer only when the session was already
*settled* idle, but a driver reports idle with `lastActivity` set to that same instant, so a
session is never settled at the moment it announces going idle. The one event that should have
armed the timer cancelled it instead. An embedded session has no poller to ask again, so the
row stayed queued for the life of the session.

## Codex

The fake holds `hold the current turn open` for five seconds, so the second message meets a
genuinely busy driver and lands in the durable outbox. The card reads **working**, the held
turn is a real `YOU` turn, and the queued message is a `YOU · QUEUED` row with its **Edit**
affordance. This state is legitimate and expected - it is the state the bug never left.

![A queued turn on a Codex session while the agent is working](codex-queued-while-working.png)

The held turn finishes, the driver emits its single idle transition, and the settle window
elapses. The queued row leaves the outbox as an ordinary `YOU` turn - no `QUEUED` badge, no
pending styling - and Codex answers it. The card reads **idle**.

![The queued turn delivered and answered in a Codex conversation](codex-delivered-and-answered.png)

Before the fix the second frame never arrived: the reply to the held turn appeared, the card
went idle, and the `QUEUED` row from the first frame simply stayed there.

## Claude

The same two moments on the other embedded harness.

![A queued turn on a Claude session while the agent is working](claude-queued-while-working.png)

![The queued turn delivered and answered in a Claude conversation](claude-delivered-and-answered.png)

## The run

Verbatim, from the repository root after `npm run build`:

```
$ MC_E2E_EVIDENCE=1 npx playwright test --config e2e/playwright.config.ts e2e/specs/queued-turn-delivery.spec.ts --reporter=list

Running 2 tests using 2 workers

  ✓  2 [chromium] › e2e/specs/queued-turn-delivery.spec.ts:62:1 › a queued conversation turn is delivered once the claude agent goes idle (10.6s)
  ✓  1 [chromium] › e2e/specs/queued-turn-delivery.spec.ts:62:1 › a queued conversation turn is delivered once the codex agent goes idle (10.7s)

  2 passed (11.1s)
```

That command also regenerates all four PNGs. Without `MC_E2E_EVIDENCE` the spec asserts
exactly the same things and writes nothing, so an ordinary `npm run test:e2e` does not rewrite
the binaries - the same bargain `docs/evidence/workflow-session-action-authoring/` strikes.

## That these frames are load-bearing

Restore the pre-fix manager and run the same two tests, and both fail on the assertion that
the outbox is empty - Codex included:

```
$ git show 32fccb43:src/server/pending-turns.ts > src/server/pending-turns.ts && npm run build
$ npx playwright test --config e2e/playwright.config.ts e2e/specs/queued-turn-delivery.spec.ts

  ✘  1 … › a queued conversation turn is delivered once the claude agent goes idle (24.5s)
  ✘  2 … › a queued conversation turn is delivered once the codex agent goes idle (25.0s)
    Error: expect(locator).toHaveCount(expected) failed

  2 failed
```

## Neither run spends a token

Both sessions are driven by fakes. `e2e/fixtures/fake-codex.mjs` speaks `codex app-server`
JSON-RPC over stdio and writes the rollout JSONL the dashboard renders the conversation from;
`e2e/fixtures/fake-claude.mjs` does the equivalent for Claude's control protocol. The cards
above are real embedded sessions - real subprocess, real pid, real `bound` event, real
transcript file - with no model behind either of them.
