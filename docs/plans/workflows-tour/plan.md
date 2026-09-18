# Workflows tour: "Follow the review"

A fourth guided tour that walks a person through one run of the built-in No-Mistakes
Review, in the order the run itself executes, and teaches the handful of moves an operator
actually makes: pick a workflow at dispatch, bind one by hand, trigger one manually, and
read a run without hunting.

This document is the review mockup: the flow layout first, then the exact copy for every
stop. Nothing here is implemented yet.

## What the tour must teach

From the request, in the tour's own order:

1. What a workflow is.
2. How workflows are attached based on the dispatch kind.
3. How to bind a workflow.
4. How to manually trigger a workflow.
5. The run itself, stage by stage: evidence, evidence readiness, Commands, Personas as
   judges, repair rounds, session actions, and the pull request plus GitHub Inspector
   gates.

The existing "Author what runs" tour covers authoring Personas, Actions, Commands, and
workflow definitions, and only briefly reads a finished run. This tour deliberately does
not repeat the authoring story. It owns the run story: the Evidence tab, evidence
readiness, the repair loop, manual triggering, and the Completion tab, none of which any
existing tour visits.

## Shape of the tour

- Tour id `workflows`, registered beside `see-work`, `library`, and `setup`.
- Title: **Follow the review** (adopted).
- 13 stops. "See the work" has 14 and "Author what runs" has 15, so this is normal size.
- Entry route: the Runs page. Exit leaves the operator on the Runs page.
- The tour writes nothing: no binding created, no run started, no task dispatched, no
  model call. It walks the newest existing run of the built-in No-Mistakes Review,
  preferring a finished one, and every run-anchored stop carries fallback copy for a
  machine that has never run one. This is the same discipline the "Author what runs" tour
  already follows.
- Copy lives in `tours/workflows.md` and compiles through `npm run tours`, exactly like
  the three existing tours. Behavior lives in `src/web/tour/tours/workflows.ts` with a
  `workflows:*` target namespace.

## The flow

The narrative arc is lifecycle order: what a workflow is, how one gets attached to work,
then one real run walked in the order the run executes.

| # | Stop id | Where it points | Concept |
|---|---------|-----------------|---------|
| 1 | `workflows` | Centered card | What a workflow is |
| 2 | `after-work` | Dispatch modal, the After work field | Attachment by dispatch kind |
| 3 | `binding` | A session's workflow binding chip | What a binding is |
| 4 | `bind-dialog` | The Bind workflow dialog | Binding one by hand |
| 5 | `pipeline` | Runs page, the run's stage strip | The five stages at a glance |
| 6 | `evidence` | The run's Evidence tab | Evidence: the frozen submission |
| 7 | `readiness` | The Evidence tab's readiness verdict | Evidence readiness |
| 8 | `commands` | Stage 1 in the stage strip | Commands as deterministic gates |
| 9 | `judges` | The reviewer stages in the strip | Personas as judges |
| 10 | `rounds` | The round scrubber | Repair rounds |
| 11 | `pull-request` | The Pull Request action in the strip | Session actions and the PR |
| 12 | `inspector` | The run's Completion tab | The GitHub Inspector final gate |
| 13 | `close` | The Runs page state filter chips | Where to watch, and finish |

Stops 5 through 12 all live on one run's detail page, so the second half of the tour
settles in one place and moves between the strip, the tabs, and the scrubber rather than
between pages.

## The copy

This is the full authored text, in the exact format `tours/*.md` uses. An H2 is the
stop's popover title; the body is the popover copy; a `- **Label:** text` list renders as
the term list under the copy. House style: second person, declarative, no exclamation
marks, and the last sentence names what Next does when the stop changes surface.

### 1. Work gets reviewed

When an agent finishes a task, Mission Control does not take its word for it. A workflow
is post-work verification - a published chain of stages that judges the finished work and
walks it to a shipped pull request. Every run is durable and lives on the Runs page. This
tour follows one run of the built-in No-Mistakes Review from frozen evidence to shipped.

### 2. Dispatch picks the workflow

Every dispatch provides a choice for "After work". After work is a workflow that executes
when a session has finished its work and Foreman has validated it is completed. Depending
on the task Kind, different tasks have different After work workflows configured by
default. You may always override them manually, and change the "ship" Kind default in
Settings → Workflows.

- **Ship:** Uses the machine default - No-Mistakes Review out of the box.
- **Bugfix:** Defaults to Bug Fix Review, which adds a root-cause judge.
- **Plan:** Defaults to Plan Validation, which reviews the plan instead of a diff.
- **None:** Opts this one task out of review entirely.

### 3. A binding pins the version

When a workflow attaches, the session wears this chip. A session that changed several
repositories gets one binding, and one review, per repository.

### 4. Bind one yourself

Manually bind your own workflow here.

- **Trigger:** Manual means you must manually trigger the workflow. Foreman complete
  means the workflow automatically runs when Foreman judges work as complete.
- **Delivery:** Preview only reads. Live may send repair instructions to the session.
- **Max repair rounds:** How many times failed reviews may send the work back.

Bind and submit is also a manual trigger: it reviews the session's current work right now.

### 5. A run walks its stages

This is a real No-Mistakes Review run. The strip draws its five stages in order -
commands first, then three waves of reviewers, then the Pull Request action - with the
fixed GitHub Inspector gate after End. A stage moves on only when every member in it
passes, and any failure returns the work to the session.

### 6. Evidence is frozen first

Every run begins by freezing one submission: the diff, the transcript, and the proof the
session registered - screenshots, logs, and completed command output. Every reviewer
judges exactly this snapshot. What the session never registered, no reviewer can see.

### 7. Readiness comes before judges

Before any reviewer runs, a preflight evidence readiness check runs. This ensures the
session submitted sufficient evidence to be judged. If insufficient evidence has been
submitted, the check will send a repair packet back to the session to fix the evidence.

### 8. Commands fail fast

Commands are deterministic code run by the workflow. Like tests, lint, build, and type
checks.

### 9. Personas judge the work

The next stages hold Personas - reusable review roles with authored standards. Everyone
in a stage reads the same frozen submission and returns a verdict: Passed, or Changes
requested with the exact changes it wants. One dissent holds the whole stage.

### 10. Changes requested come back as rounds

Changes requested does not end the run. Mission Control delivers the requested changes to
the session as a repair packet, and when the session finishes, the pipeline runs again as
the next round. This scrubber keeps every round inspectable. Rounds are budgeted, so if
the session can't satisfy all the judges across the configured number of repair rounds,
the workflow parks for human intervention.

### 11. An action ships the pull request

Not every stage judges. A session action stage sends one instruction to the session
instead - here, the Pull Request action tells it to open the pull request, and completes
only when Mission Control holds durable proof that one opened. The session saying so is
not proof. Next opens the run's final gate.

### 12. GitHub Inspector holds the door

After every stage passes, one gate remains. GitHub Inspector reviews the exact pull
request head this run produced, and the run completes only when that review comes back
clean. Its findings live here on the Completion tab, beside the controls to recheck the
gate, grant more rounds, or cancel.

### 13. Where to watch

You never have to hunt for a review. These chips filter every run, and Needs you is your
queue. Each session shows its bound run on a Workflows tab, and Settings, Workflows leads
with the runs that need attention. Finish leaves you here on the Runs page.

## Discovery copy

The picker, the Settings rail, and the command palette all draw from one `TourEntry`.

- Picker summary: "Follow one No-Mistakes Review run from frozen evidence to a shipped
  pull request."
- Picker outcomes: "Know what each stage of a review is doing", "Bind or trigger a
  review yourself", "Read evidence, rounds, and the GitHub Inspector gate".
- Settings heading: "Follow the review", hint: "Walk one real No-Mistakes Review run,
  stage by stage."
- Palette row: "Start Follow the review tour", keywords: workflow, review, run,
  evidence, inspector, no-mistakes.

## Behavior notes for implementation

- **Run selection.** The tour always targets the seeded demonstration run, never the
  operator's own history, so every machine walks the identical record. The daemon seeds it
  on the first start (`POST /api/tours/workflows/seed-run`,
  `src/server/workflows/tour-demo-run.ts`): a completed run named "Tour demo" with every
  stage passed and a clean GitHub Inspector gate, fabricated through the workflow store
  with no session, task, or model call, durable under a fixed id and idempotent across
  starts. The tour never starts a real review to demo itself, because that would spend
  real reviewer model calls.
- **Stops 2 through 4 fall back too.** Stop 2 opens the real Dispatch modal and closes it
  on leaving, the way "See the work" already does. Stops 3 and 4 prefer a session that
  holds a binding, then any session's unarmed chip, then fallback copy. Stop 4 opens the
  real Bind workflow dialog read-only and closes it without binding (decision below).
- **Engine seams.** New `TourId` member, `tours/workflows.md` plus `npm run tours`,
  `src/web/tour/tours/workflows.ts`, a `workflows:*` entry in the target namespace
  registry, `useTourTargetRef` calls on the owning components (dispatch After work field,
  binding chip, binding dialog, run strip, Evidence tab pane, readiness
  region, round scrubber, Completion pane, state filter chips), a `TourEntry`, and the
  App binding plus navigation object. No server-side tour recipes: this tour creates no
  tasks.
- **Vocabulary guardrails baked into the copy.** Stage, never phase. Command, never
  check. Changes requested, never fail or kickback. GitHub Inspector by full name.
  Session action, distinct from GitHub Actions. No em dashes.
- **Tests.** A new `e2e/specs/workflows-tour.spec.ts`: both entry points start the tour, the
  full walk over a seeded finished run, every fallback stop renders its fallback copy on
  an empty machine, Exit restores the pre-tour route, and no write or model call happens
  (fake agents as always). Unit tests mirror `library-tour.test.ts` for the run selector
  and stop table. `docs/ui.md` gains this tour's stop list.

## Adopted decisions

Resolved in the operator's review of this mockup on 2026-09-18:

1. **Tour title:** Follow the review.
2. **Stop 4 depth:** the tour opens the real Bind workflow dialog read-only and closes it
   without binding.
3. **Follow-up:** implemented directly in the same session. The tour, its unit tests
   (`test/workflows-tour.test.ts`), its browser spec (`e2e/specs/workflows-tour.spec.ts`),
   and the documentation (`docs/ui.md`) ship together.
4. **Deterministic run (added after walking the tour):** the tour auto-seeds one
   demonstration No-Mistakes run directly in the database, in live mode, and ALWAYS targets
   it - even when real history exists - so every machine walks the identical record. The
   seeder is `src/server/workflows/tour-demo-run.ts` behind
   `POST /api/tours/workflows/seed-run`, guarded by `test/workflow-tour-demo-run.test.ts`
   (coherent completed record, orphaned demo session, idempotence, and clean retention
   compaction thirty days later).
5. **Binding stops on an empty fleet (added after walking the tour):** with no live session
   to wear the chip, the tour starts the fixed temporary Chat conversation its server
   recipe describes (`WORKFLOWS_PREVIEW` in `src/server/tours.ts`, the See the work preview
   pattern) so the chip and Bind workflow dialog stops point at a real desk, and closes it
   on exit through the tour complete route. It is deliberately not the session behind the
   seeded run.
