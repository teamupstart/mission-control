# Workflow run posture: make "no action needed" unmistakable

**Adopted 2026-09-18: Option A - posture banner with the override demoted in place,
implemented in the same session.** The selection was made by the operator through the
Mission Control dashboard's plan-decision form (`request_plan_decisions`), which blocks
until the human submits or dismisses; the submitted response chose
"A - Posture banner, override demoted in place" for the mockup and
"Implement now in this session" for the follow-up. The verbatim decision record is
registered as workflow evidence and kept (gitignored) at
`e2e/.artifacts/workflow-run-posture/plan-decision-record.txt`. Options B and C below are
retained as the record of what was considered. The implementation landed `runPosture` in
`src/web/workflows/run-model.ts`, the banner and demotion in
`src/web/workflows/WorkflowRuns.tsx`, unit rows in `test/workflow-run-next-move.test.ts`,
and the browser proof in `e2e/specs/workflow-run-posture.spec.ts`; the operator-facing
description lives in `docs/workflows.md`.

## The problem

The run page states a run's status but never states whose move it is. When a repair round
is parked and the bound session is working on the feedback, the header shows:

- a status chip ("Waiting for the session"),
- a small parked sentence ("The session is still working. The next round opens once it
  settles."), and
- a filled primary button: **Start repair round 2**.

The button is the strongest visual signal on the page, so the page reads as "click me"
during exactly the state where clicking is unnecessary and mildly harmful (it interrupts
the session's repair and spends a round). The same ambiguity holds while reviewers or
commands are running and while a session action (such as the PR handoff) is executing:
the pipeline strip moves, but nothing says plainly "you are not needed here".

Action is genuinely required only when the session is idle, the workflow is not running,
and the only way forward is an operator decision (start the next round, review unchanged
work, resolve a delivery, grant rounds, cancel).

## What the daemon already knows

No new server state is required. The posture is derivable in the browser from data the run
detail already streams:

- `run.status`: `capturing` and `running` mean the workflow itself is executing;
  `waiting_for_session` means a round is parked. `waiting_for_action` is conditional and
  is split by the next bullet's wait reason rather than classified by status alone.
- `summary.actionWait` for `waiting_for_action`: the shared
  `sessionActionWaitsOnOperator` predicate decides the split. `needs_operator` and the two
  `pull_request_wrong_*` reasons render "Your move"; every other reason (preparing / sent /
  working / awaiting proof and so on) renders "No action needed".
- `detail.resumption` (the resumption observer's withheld ledger): `session_busy` and
  `packet_undelivered` with `resumesItself: true` mean the loop closes itself;
  `session_needs_you` means the session is stuck on a prompt; `policy_manual` and
  `resumesItself: false` mean the next round is the operator's to start.
- `summary.resumptionPolicy` and the binding's `deliveryMode`, through
  `workflowRunResumesItself`, for a parked round the ledger has not written an entry
  for yet.

## The shared posture model (all options build on this)

A new derivation in `run-model.ts`, `runPosture(detail)`, returning one of three postures
plus a sentence:

1. **`auto`** - no action needed. The workflow is executing, a session action is running
   on a machine-side wait reason, or the parked round resumes on its own once the session
   settles. Where such a run still carries a derived move it demotes to a labelled
   override; a run that is actively moving has no move and shows no resubmission control.
2. **`yours`** - action required. The session is idle, nothing is running, and the run
   does not move without an operator decision - including a session action whose wait
   reason only a person can end (`needs_operator`, a wrong-repository or wrong-branch
   pull request).
3. **`none`** - terminal runs, which keep today's rendering.

Exactly one posture per run, derived and tested like `runNextMove` / `runNoMoveReason`.
All three options below render this same model; they differ in how loudly the page says it
and where the override lives.

## Option A - Posture banner, override demoted in place

A full-width banner at the top of the run header, above the identity block.

- **auto**: a calm blue banner with a pulsing dot. Eyebrow "NO ACTION NEEDED", one
  sentence of what is happening and what happens next ("The session is working on round 1
  feedback. Round 2 starts on its own when it settles."). When the run still carries a
  derived move - a parked round's "Start repair round 2", a gate's "Check again" - that
  button stays in the action row but demotes from `btn-primary` to a ghost button with an
  explicit override tag and a tooltip that opens "Not required". Only a resubmission's
  tooltip goes on to say it interrupts the session's repair and spends a round; every
  other demoted move, such as the gate recheck, keeps its own tooltip after that prefix
  because it spends nothing. An actively running state (evidence capturing, reviewers and
  commands executing, a session action in flight) has no derived move, so it shows no
  resubmission control at any weight; Cancel run remains offered.
- **yours**: an amber banner, eyebrow "YOUR MOVE", sentence naming why ("The session is
  idle and this review does not resume on its own."). The button stays the familiar
  filled primary.

Trade-offs: smallest change to the existing layout; every control stays where operators
know it; the banner and button tone always agree because both read one posture. The
override is still one click away, which preserves "force anything" but keeps it visible
enough that a hurried reader might still click it.

## Option B - "Who has the ball" strip, overrides behind a disclosure

A three-segment ownership strip (Session / Reviewers / You) under the run title. The
segment that currently owns the run is lit with the pulse; the others dim. One line of
prose under the strip says what the owner is doing.

- When the ball is with Session or Reviewers, the action row collapses to a single quiet
  "Override" disclosure. Expanding it reveals Start round N now / Cancel run, each
  labelled as an interruption.
- When the ball is with You, the strip's "You" segment lights amber, the disclosure is
  gone, and the primary button renders exactly as today.

Trade-offs: the strongest at-a-glance answer to "whose move is it", and it teaches the
run's whole lifecycle (session -> reviewers -> you) as a picture. Costs the most new UI
vocabulary, and the overrides are two clicks away instead of one.

## Option C - Live status card replaces the primary slot

The action row itself becomes posture-aware. When no action is needed, the primary slot
renders a non-interactive status card (spinner plus "Session addressing round 1 feedback -
resumes automatically"), and every mutating control moves into a "Force..." menu at the
row's end. When action is required, the card is replaced by the familiar filled primary
button and the menu collapses to just Cancel.

Trade-offs: the empty-primary-slot rule ("a button exists only when clicking it is the
right move") is the cleanest mental model, and misclicks become nearly impossible. The
menu hides the overrides most aggressively, and the row changes shape between states,
which moves controls out from under a pointer when a session settles.

## Scope of the implementation (whichever option is selected)

- `runPosture` derivation plus unit cases in `test/workflow-run-next-move.test.ts`,
  beside the next-move table that shares its fixture.
- Header rendering in `WorkflowRuns.tsx` (and the session-detail workflow header if it
  repeats the pattern), CSS in `styles.css` using the existing tone tokens
  (`--working`, `--attention`).
- The parked sentence, refusal sentence, and no-move sentence keep their jobs; the
  posture states who moves next, not what happened.
- A Playwright spec in `e2e/` driving a run through: reviewers running -> parked with
  session working (no primary / demoted primary, per option) -> session idle (action
  offered), plus the override path.
