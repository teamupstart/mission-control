# Follow the review

## Work gets reviewed
<!-- stage: workflows -->

When an agent finishes a task, Mission Control does not take its word for it. A workflow is post-work verification - a published chain of stages that judges the finished work and walks it to a shipped pull request. Every run is durable and lives on the Runs page. This tour follows one run of the built-in No-Mistakes Review from frozen evidence to shipped.

## Dispatch picks the workflow
<!-- stage: after-work -->

Every dispatch provides a choice for "After work". After work is a workflow that executes when a session has finished its work and Foreman has validated it is completed. Depending on the task Kind, different tasks have different After work workflows configured by default. You may always override them manually, and change the "ship" Kind default in Settings → Workflows.

- **Ship:** Uses the machine default - No-Mistakes Review out of the box.
- **Bugfix:** Defaults to Bug Fix Review, which adds a root-cause judge.
- **Plan:** Defaults to Plan Validation, which reviews the plan instead of a diff.
- **None:** Opts this one task out of review entirely.

## A binding pins the version
<!-- stage: binding -->

When a workflow attaches, the session wears this chip. A session that changed several repositories gets one binding, and one review, per repository.

## Bind one yourself
<!-- stage: bind-dialog -->

Manually bind your own workflow here.

- **Trigger:** Manual means you must manually trigger the workflow. Foreman complete means the workflow automatically runs when Foreman judges work as complete.
- **Delivery:** Preview only reads. Live may send repair instructions to the session.
- **Max repair rounds:** How many times failed reviews may send the work back.
- **Bind and submit:** Also a manual trigger - it reviews the session's current work right now.

## A run walks its stages
<!-- stage: pipeline -->

This is a demonstration No-Mistakes Review run, seeded so every machine reads the same record. The strip draws its five stages in order - commands first, then three waves of reviewers, then the Pull Request action - with the fixed GitHub Inspector gate after End. A stage moves on only when every member in it passes, and any failure returns the work to the session.

## Evidence is frozen first
<!-- stage: evidence -->

Every run begins by freezing one submission: the diff, the transcript, and the proof the session registered - screenshots, logs, and completed command output. Every reviewer judges exactly this snapshot. What the session never registered, no reviewer can see.

## Readiness comes before judges
<!-- stage: readiness -->

Before any reviewer runs, a preflight evidence readiness check runs. This ensures the session submitted sufficient evidence to be judged. If insufficient evidence has been submitted, the check will send a repair packet back to the session to fix the evidence.

## Commands fail fast
<!-- stage: commands -->

Commands are deterministic code run by the workflow. Like tests, lint, build, and type checks.

## Personas judge the work
<!-- stage: judges -->

The next stages hold Personas - reusable review roles with authored standards. Everyone in a stage reads the same frozen submission and returns a verdict: Passed, or Changes requested with the exact changes it wants. One dissent holds the whole stage.

## Changes requested come back as rounds
<!-- stage: rounds -->

Changes requested does not end the run. Mission Control delivers the requested changes to the session as a repair packet, and when the session finishes, the pipeline runs again as the next round. This scrubber keeps every round inspectable. Rounds are budgeted, so if the session can't satisfy all the judges across the configured number of repair rounds, the workflow parks for human intervention.

## An action ships the pull request
<!-- stage: pull-request -->

Not every stage judges. A session action stage sends one instruction to the session instead - here, the Pull Request action tells it to open the pull request, and completes only when Mission Control holds durable proof that one opened. The session saying so is not proof. Next opens the run's final gate.

## GitHub Inspector holds the door
<!-- stage: inspector -->

After every stage passes, one gate remains. GitHub Inspector reviews the exact pull request head this run produced, and the run completes only when that review comes back clean. Its findings live here on the Completion tab, beside the controls to recheck the gate, grant more rounds, or cancel.

## Where to watch
<!-- stage: close -->

You never have to hunt for a review. These chips filter every run, and Needs you is your queue. Each session shows its bound run on a Workflows tab, and Settings → Workflows leads with the runs that need attention. Finish leaves you here on the Runs page.
