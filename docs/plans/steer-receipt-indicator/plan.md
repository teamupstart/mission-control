# Show a steered message until the agent receives it

## Decisions

The operator chose these in the Mission Control plan-decisions form after reviewing the three
mock-ups. Nothing was implemented until the form was submitted.

- **Design:** mock-up A. The row stays in the log, and a pill is pinned to the log's edge while you scroll.
- **Terminals:** they share the visual now. A terminal `sending` row reads
  `sent · waiting for <agent> to pick it up`. Real terminal steering is a follow-up task.
- **Follow-up:** implemented in the same session; no phased plan.

## Problem

When a queued message steers into a running turn ("Steer now", or the automatic one-minute
stage), the queued row disappears from the conversation the moment the driver accepts it.
The message itself only appears in the log once the agent actually reads it, which for
Claude Code is its next step boundary (after the running tool finishes) and can be minutes
later. Between those two moments nothing on screen says the message exists. It reads as lost.

## What the investigation found

### Where the gap comes from

- `PendingTurnManager.deliverSdk` (`src/server/pending-turns.ts`) calls
  `deleteClaimedPendingTurn` as soon as `supervisor.send` resolves. For a steer, that
  resolves with the disposition `steered`: the driver accepted the input into the active
  turn. It does not mean the model has read it.
- The conversation log is read from the agent's own transcript file (Claude JSONL, Codex
  rollout, Pi session file). The agent writes the user message there only when it consumes
  it, so the row is gone before its replacement exists.
- The composer's one-shot flash ("Sent - added to the agent's current turn") is the only
  acknowledgement, and it fades after a few seconds.

### Does steering work for terminals?

No. It is unique to embedded (Agent SDK) sessions today.

- Every harness declares `steering: { runtimes: ["sdk"] }` in
  `src/shared/harness-capabilities.ts` (Claude, Codex and Pi). `canSteerMessage` reads
  that, so a terminal session shows no **Steer now** button and its delivery schedule
  skips the one-minute steer stage: it waits for the turn to finish, then interrupts at
  three minutes. `docs/sessions.md` states the same rule.
- Terminal sessions do not have this gap. A terminal delivery keeps its row in the log as
  `You · sending` until Mission Control sees prompt-pickup evidence (hook, transcript or
  rollout state), then retires it. The message is on screen the whole time.
- The agent CLIs themselves do accept typing while a turn runs (Claude Code folds it into
  the running turn; the Codex and Pi TUIs steer or queue on Enter while busy). That is
  inferred from vendor behaviour, not verified in this repository. Mission Control
  deliberately pastes only into an idle composer, because its pickup proof and its
  `delivery uncertain` recovery both assume an idle prompt. Steering a terminal would need
  a new pickup proof (the transcript line appearing) and a per-harness check of what Enter
  does while busy.

### How receipt can be detected

The same signal works for every runtime: the agent's transcript gains a user message whose
text matches the steered message, timestamped no more than five seconds before acceptance
(the agent can write the line just before the driver's acknowledgement returns). `originOf` in
`src/server/injections.ts` already matches transcript user lines to delivered text this way.
Fallbacks clear the indicator if receipt is never seen: the turn ends and a new turn begins,
the session resets or exits.

## Proposal (shared by all three mock-ups)

1. When an SDK steer is accepted, the daemon keeps a small **awaiting receipt** record
   (message id, text, accepted-at) on the session instead of forgetting the message. It is
   separate from the editable outbox, so it never blocks later deliveries or offers Edit.
2. The daemon clears the record when the transcript shows the message, or on a fallback above.
   It reads the transcript tail while a steer is waiting, so the browser renders the record
   as given and never re-decides receipt.
3. The browser renders the record with one of the three designs below. It shows elapsed
   time since acceptance and a line saying when the agent will read it.
4. Terminal rows in `sending` use the same visual, so both runtimes read the same way while a
   message is on its way.

## Mock-up A: the row stays in the log, pinned while you scroll

The queued row does not disappear when it steers. It changes state in place:
`You · steered · waiting for Claude to read it`, with a pulsing marker, elapsed time, and
"Claude reads steering at its next step". If you scroll up, the row collapses into a
one-line pill stuck to the bottom edge of the log, so it never leaves view. When the agent
reads it, the row shows "Received" for a moment, then the real transcript turn replaces it.

- Strength: one continuous object. The row you queued is the row you watch until it lands.
- Cost: sticky positioning inside the log scroller and a collapse rule when scrolled up.

## Mock-up B: a tray docked above the reply box

The row leaves the log as it does today, but a tray docked to the reply box shows
"Steering sent · waiting for Claude · 0:42" with a one-line preview. The reply box is
always visible, so the tray is too. Several steers stack as one tray with a count. When the
agent reads it, the tray item shows "Received" and the new turn in the log flashes.

- Strength: always in view with no scroll logic; sits where you just typed.
- Cost: the message is visually separated from the conversation while it waits.

## Mock-up C: a status chip in the header and on the session card

A chip in the session header ("Steer pending 0:42") and the same chip on the session's card
in the board. Hovering shows the message; clicking scrolls the log to a dim placeholder row
below the current step. When the agent reads it, the chip turns into "Received" briefly
and disappears.

- Strength: visible from the board without opening the session; good when steering several
  sessions at once.
- Cost: the chip is small, and the header is already dense.

## Terminal scope

The indicator design above applies to terminals immediately through their existing
`sending` state. Adding real steering to terminal sessions is a separate change: it needs a
spike per harness to prove what Enter does while a turn runs, and a transcript-based pickup
proof. Recommended as a follow-up task rather than part of this change.

## Tests

- Unit: the awaiting-receipt record is created on `steered`, cleared by a matching
  transcript user line, and cleared by each fallback; it never blocks the outbox drain.
- E2E (`e2e/`): steer a queued message on a fake SDK session, assert the indicator is
  visible while the turn runs (including after scrolling up for A), and gone once the fake
  transcript writes the message.
