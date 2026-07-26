# Multi-agent ensembles: operator and extension guide

An **ensemble** runs a group of ordinary dispatched tasks under one versioned *strategy* and owns
the group-level facts a single task cannot: one pinned base commit, member roles, immutable
submitted artifacts, evaluations, a human decision, and a terminal outcome. Three strategies are
enabled: **Best of N**, which ranks and promotes one; **Consensus**, which mines what the attempts
disagreed about and promotes nothing; and **Panel vote**, which ranks through independent
single-lens ballots and surfaces their disagreement. This document is the operator's reference for
what an ensemble does, how to recover one, what it keeps and what it costs, and the contract a future
strategy extends.

The product overview lives in the [README](../README.md#multi-agent-ensembles); the design
rationale is in [`docs/plans/best-of-n-swarm-dispatch/plan.md`](plans/best-of-n-swarm-dispatch/plan.md).

## What Best of N does

1. From **Dispatch**, switch the header's launch mode from *Single agent* to *Ensemble* and pick
   **Best of N** in the strategy control. Configure two to five candidate lanes (agent, model,
   effort, optional approach hint; repeats are allowed), an optional evaluator Persona, and an
   optional [workflow](../README.md#workflows-and-personas) to hand the winner to. The **Launch
   plan** strip shows the pinned base, the lanes, the comparison and the human gate before you
   commit.
2. **Review launch** posts a side-effect-free preview (member count, concurrency, waves, comparison
   calls, and whether the chosen workflow mode is executable). Any later edit invalidates it, so
   **Launch N agents** confirms exactly what you reviewed. The launch is idempotent on a stable
   request id: a lost response and a retry return the same run, never a second fleet.
3. The daemon pins **one full base commit** and launches 2-5 ordinary member tasks from it - every
   candidate starts byte-identical. Each is a normal session in Cards, Console and Board, marked
   with an **E** chip that opens the run.
4. Each candidate implements and tests alone. Its prompt forbids pushing, opening a PR, or running
   the shipping gate, and tells it to **submit** when ready.
5. A member submits through the launch-scoped `submit_ensemble_result` MCP tool (or the manual
   Submit action in the run detail). The daemon attributes the submission from the calling
   session -> its task -> its active member; a member never names itself, so a guessed id reaches
   nothing. Submission captures the working tree as an **immutable private Git commit** (see refs
   below) and records reported checks, observed diff statistics, and the member's agent cost.
6. When every live member has submitted or terminated and **at least two** produced a snapshot, one
   tool-less comparison ranks the immutable submissions and parks the run at a durable human
   decision boundary. The comparison is anonymous (agent, model, ordinal, ref and worktree stripped)
   and **recommends** a winner - it never promotes one.
7. You confirm one eligible submission (or declare **no consensus**). Only then does anything
   destructive run.

### Where the selected result lands

Confirming a winner never re-implements it. The chosen submission is an immutable commit, and
promotion makes that exact commit available in one of two ways:

- **Restored** - the winner's own session is reset to its snapshot and handed a continuation. One
  session, the one you were already watching.
- **Replacement** - if that session is gone, busy, uninstrumented or holding a parked review, it
  cannot be safely reused, so the run launches exactly one new task, `<run title> - selected
  result`, provisioned at the winner's snapshot. Its checkout already contains the winning work;
  its opening prompt carries the original task, the winner's own summary and the reviewer's
  caveats, and asks it to check and ship - not to rebuild.

On the replacement path the winner's original task is settled **done**, recording the task it was
promoted into. Its agent, worktree and branch are deliberately **kept**: it may have done work
after submitting, and that work exists nowhere else. Free it with a confirmed **Clean up** when you
have looked. Until that click you will see two sessions for the winner - the promoted one, which is
live, and the original, which now has no task.

## What Consensus does differently

Steps 1-5 are identical - three to five attempts (not two), isolated, from one pinned commit,
submitting the same immutable Git snapshots. The run diverges at step 6:

6. When every live attempt has settled and **at least three** produced a snapshot, one tool-less
   anonymous pass compares what the submissions **decided** rather than how good they are. What all
   of them did the same way is filed as an **agreement**; each thing they did differently becomes an
   open **question** carrying one option per position actually taken, attributed to the attempts
   that took it. The pass may not rank, score or recommend anything. Its reply is refused - a failed
   attempt, retried against the same evidence - if it reported nothing at all, named a submission
   the packet never contained, put one submission on two sides of one question, or left one of the
   attempts out of every option. Question and option ids are assigned by the daemon after
   validation, never by the model.
7. You answer the questions: take a position, or write your own. **Nothing destructive runs at all.**
   The run terminates `retained` with every snapshot kept and restorable, every member `retained`,
   and your answers recorded on the decision and on the decision stage's attempt. The questions you
   were asked are persisted when the stage opens and your answers are validated against exactly
   those, so a re-run evaluation cannot turn a recorded answer into an answer to a question you
   never saw.

Use it when the disagreement is the point. Its evaluation shares the same review-call ceiling and
the same **Settings -> Models -> Ensemble evaluation** job as the Best-of-N comparison.

## What Panel vote does

Steps 1-5 are Best of N's, unchanged: the same 2-5 candidate roster, the same pinned base commit,
the same isolated members and the same submission path. The difference is step 6.

6. When every live member has submitted or terminated and **at least two** produced a snapshot, the
   daemon convenes a **panel**: two to five judges, each scoring *every* submission from one lens
   alone. A lens is a built-in rubric (Correctness, Maintainability, Risk, Evidence, Scope) or an
   operator-authored Persona pinned to an exact revision at creation. All the judges are asked in
   **parallel** against ONE shared anonymous evidence packet built once, so a judge that disagrees
   is disagreeing about the submissions rather than about what it happened to be shown. Two judges
   may not share a built-in lens - a panel that agrees by construction is not a panel. Repeating an
   operator-authored Persona is allowed when the operator deliberately wants multiple samples of
   the same guidance.
7. Each judge that reaches a provider call gets its own `ensemble_evaluations` row: its lens
   snapshot, the runner and model actually resolved, its bounded input fingerprint, and its typed
   per-artifact scores. A malformed reply or provider failure fails **that row only**. A lens this
   build cannot resolve fails its judge before a row or call is opened. Either way the panel
   continues, and nothing malformed becomes a score.
8. The stage succeeds when at least **two** judges returned a usable ballot (the *quorum*, compiled
   into the plan). Below quorum it fails and is retried whole against the same immutable
   submissions up to the attempt cap; a panel that never reaches quorum fails the run. One
   surviving ballot is never the answer - its disagreement measure is vacuously zero, which reads
   as unanimity.
9. The ranking is a pure aggregation over the ballots - Borda points over each judge's RANKS, never
   over the 0-100 scores, since a score is a private scale and a rank is a comparison between the
   same subjects. It is computed, never stored, by one shared function the daemon and the dashboard
   both call, so the stage label and the result view cannot disagree. A submission missing from a
   judge's readable ballot contributes nothing from that judge; absence is not converted into a
   worst-place score.
10. The run detail shows the aggregate ranking, a **disagreement figure** (the share of submission
    pairs two judges ordered differently, averaged over every pair of judges), a **Contested** mark
    and per-judge ranks on any submission the judges placed differently, an explicit notice when
    the top two could not be separated, and each judge's full ballot. A tie is declared, not
    resolved.

Step 7 of Best of N (the human-confirmed select-one finalization) is then identical. The panel
**recommends and cannot promote**, exactly as the comparison cannot.

Costs: one model call per judge rather than one per run, which the preview states before launch.
Every other limit, ref, retention, alert and recovery behaviour in this document applies unchanged.

## States

`planning -> running -> waiting -> evaluating -> awaiting_decision -> finalizing -> completed`, plus
`cancelling`, `cancelled` and `failed`. A run parks at `awaiting_decision` until a person acts, and
at `finalizing` if a destructive step needs retrying. Terminal states are `completed`, `cancelled`
and `failed`. A run written by a **newer build** loads but reports itself *unreadable* and refuses
to run rather than being executed as something adjacent.

## Artifacts and private refs

Each submission is captured through a **temporary Git index**, never the member's real index, so its
staged/unstaged split, HEAD, branch and working tree are left byte-identical. The immutable commit is
stored under a generated private ref:

```
refs/mission-control/ensembles/<ensemble-id>/<artifact-id>
```

Both id components are validated as generated UUIDs before they reach a ref name. These refs are the
recoverable evidence for every candidate, winner and loser alike, and they survive task
cancellation and worktree teardown.

## Retention and deletion

Finalization reaps loser **worktrees** but never loser **refs** - every candidate's snapshot is
kept after completion or cancellation, and a **Restore** action can create a fresh task from any of
them. The **winner's** worktree is never reaped by finalization at all, on either promotion path.
There is **no time-based pruning** in v1: a snapshot is deleted only through the explicit **Delete
ensemble** action (confirmed by echoing the run id), which removes the run's private refs and
history. **Deletion is irreversible** - the refs are the only copy of a loser's work. Deleting an
ensemble never touches a task or any linked workflow state, and it resumes the same remaining refs
after a crash.

## Costs

- **Candidate (agent) cost** is summed from each member's session telemetry **at submission** and
  frozen into its immutable artifact, so it survives the session exiting. The run detail shows the
  aggregate, attributed per member. A runner that reports no cost is shown as **unreported**, never
  `$0.00`; a run where some members reported and others did not shows the partial total and how many
  reported.
- **Evaluator cost** is a separate figure on its own ledger. Best of N records one comparison
  evaluation; Panel vote records one evaluation per judge. Call count, provider, model, duration and
  byte counts are always shown; the **monetary** cost appears only when the runner reports it
  authoritatively, and stays *Not reported* otherwise.
- **Linked workflow review cost** is owned by the workflow subsystem and shown separately, labelled
  *Workflow-owned*. It is never folded into the ensemble's evaluation cost.

The member agents' own token use is not estimated before launch: it is unbounded work, and inventing
a number for it would be the dishonest half of an honest estimate.

## Alerts

Ensemble transitions feed the same shared alert engine every other "needs you" flows through - there
is no separate ensemble notifier or preferences panel. A transition into `awaiting_decision`, a run
turning **unreadable**, or a `finalizing` run holding an error each raise an **attention** alert
(delivered even in Away mode); completion, cancellation and failure are **informational** and land in
the Away digest. Each is edge-triggered by stable run identity, so a reconnect or a recovery never
re-announces a decision you already saw. An ensemble toast deep-links to
`#/workflows/ensembles/<id>`.

## Restart and recovery

Every effect is persist-before-act, so a daemon restart resumes rather than restarts:

- A wave is durable before its first dispatch; recovery reconciles surviving agents without
  recreating their tasks and never launches a second fleet.
- An interrupted review becomes `interrupted` (not `failed`) and retries against the **exact same
  immutable subjects** and evaluator snapshot. Best of N leaves a completed comparison untouched.
  Panel vote retries the whole panel when a crash leaves its rows unsettled, but if the rows were
  settled and reached quorum before the stage receipt was written, recovery completes the stage
  from those durable ballots instead of paying for the calls again.
- A `finalizing` run resumes from its persisted per-step receipt - it does not re-verify a decision,
  re-materialize a winner, or send a continuation twice.
- A pairwise or multi-wave run resumes only its missing work; completed evaluations and launched
  waves are never duplicated.

## Cancellation, failure and restoration

- **Cancel ensemble** cancels every launching or active member task through TaskManager; submitted
  refs survive.
- **Cancel/withdraw member** marks that member withdrawn after its task is cleaned up.
- If work settles with **fewer than two** eligible artifacts, the run fails with an explanation and
  offers **Retry member**, **Restore result**, or **Cancel** - a competition is never manufactured
  from one artifact.
- A cleanup step that cannot finish leaves the run `finalizing` with an actionable error, resumed by
  **resolve finalization**.

## The Workflow handoff (Preview-only baseline)

If a run pins a published workflow version at creation, finalization binds that exact version to the
winning session and submits its clean snapshot through the same server-owned external boundary any
other source uses - idempotent on a stable source key, so a restart returns the same binding and
run. It requires the winner's HEAD to equal the chosen snapshot and its tree to be clean; a drift is
healed by restoring the winner and resuming the *same* submission. Only **Preview + manual** is
executable today; a note-key conflict, an unavailable mode, or a Live/Foreman selection blocks
visibly and is never silently downgraded - you retry after resolving it or skip the handoff. An
ensemble reaching `completed` does **not** mean the work is approved or shipped; the workflow owns
post-selection review, and neither ensemble completion nor a rank-1 recommendation means approved.

## Security and resource limits

- Creating an ensemble authorises launching an exact count or bounded range of **local** agents; the
  preview shows initial, maximum, concurrency, waves and evaluation calls before you confirm.
- Hard ceilings no strategy config or driver output may exceed: **16** members, **8** concurrent,
  **8** waves, **5** stage attempts. Strategy-specific candidate, judge, result, and material bounds
  are listed below.
- Every evaluator result is advisory and tool-less: it cannot launch, promote, publish, cancel, reap
  or delete. Every destructive finalization requires an explicit human confirmation. A Consensus
  run performs no destructive finalization at all, and still requires the human answer before it
  can terminate - its recorded answers ARE the outcome.
- Refs and branches are generated from UUIDs; every Git/process call uses argument arrays, never a shell.
- **Evaluator anonymity is not configurable.** Every evaluator packet relabels its subjects
  `Submission A`, `Submission B`, … and strips the ref, snapshot/tree/head shas and worktree paths,
  on every strategy and every path. Compiled plans record `anonymizeSubjects: true` to state that;
  no form offers a control for it, because a de-anonymised packet is a different safety story - one
  where a candidate's own diff can impersonate a sibling's identity label - and would need its own
  design rather than a boolean.
- Sibling isolation is **behavioural, not a sandbox**: the worktrees share one Git repository and a
  local agent can find its siblings if it goes looking. The UI never claims otherwise.

## Current strategy limits, surfaced before launch

Best of N and Panel vote accept 2-5 candidates (default 3), default to at most 3 candidates building
concurrently, and use about 400 KiB of evaluation material. Panel vote additionally accepts 2-5
judges (default 3). Consensus accepts 3-5 attempts (default 3, with the same concurrency and material
budget), and caps its result at 12 agreements and 8 questions, each with at most one option per
attempt. Preview shows exact member count, max concurrency, waves, artifact type, evaluation calls,
finalization and the hard budgets before you confirm; the information-sharing rule (isolated) and
the no-push/no-PR publishing rule are shown alongside.

---

## Extending the kernel: what a new strategy costs

A strategy is a browser-safe descriptor plus one pure compiler that turns a validated config into an
immutable **plan** of generic stages. The engine executes stage kinds and driver keys and **never**
asks what strategy a run is, so a materially different pattern is a new plan - not a new table, route,
event, Session field, layout, or engine branch. Compose along these independent axes:

| Axis | Existing options | Adds a new primitive only when |
|---|---|---|
| Roster / launch count | fixed roster, matrix, waves, adaptive range | you need runtime spawn-more decisions (a bounded driver) |
| Information flow | isolated; shared parent artifacts | you need directed critique/debate visibility |
| Artifact adapter | `commit` (git snapshot) | members submit something other than a Git tree |
| Evaluation schedule | one comparative call; one panel stage with parallel judge calls; several sequential stages | a genuinely new evaluator (tests gate, aggregation) needs a driver |
| Advancement / barrier | members-settled, stages-succeeded, human-decision | a new dependency shape is required |
| Decision authority | human select-one / no-consensus; answer-divergences | a new operator authority extends the action schema |
| Finalization outcome | select one (`select_one_finalize@1`); retain all (`retain_all_finalize@1`) | top-K or a synthesized outcome needs a finalizer |
| Workflow placement | optional after-selection handoff | before-comparison per-member review is wanted |

### When a change is descriptor-only, and when it is not

- **Descriptor/config only** (no engine, store, route, event, or layout change): a new roster shape,
  a different number or arrangement of review/decision/finalize stages, matrix or multi-wave launch,
  parent-artifact inputs, a different information policy value, or a new preset. Six such shapes -
  fixed matrix, successive halving, pairwise, panel, synthesis, retain/no-consensus - are exercised
  end to end in `test/ensemble-extension.test.ts` using only the existing primitives.
- **A new bounded driver, artifact adapter, or result renderer** is warranted only for genuinely new
  *behaviour* or *presentation*: an adaptive spawn-more decision, a non-Git artifact, a tests/gate
  evaluator, or a strategy-specific result view. **Consensus is the worked example**: it needed a
  review driver (a different question), a decision driver, a finalizer (a non-destructive terminal),
  and a result renderer - and nothing else. Its decision driver is also where the kernel's one
  extension to decision *rendering* landed: `DecisionDriver.openStage` composes the decision stage
  attempt's persisted input when the stage opens, and `DecisionContext.stageInput` is what an answer
  is validated against - so a stage can ask a question an evaluator derived, and an answer is
  always checked against what the operator was actually shown. Both are strategy-neutral.
  Drivers and adapters are versioned append-only keys
  (`id@version`) in exhaustive `Record` registries; a review/decision/finalize driver key is claimed
  by exactly one registry. The result renderer registry (`ENSEMBLE_RESULT_RENDERERS`) is the one
  strategy-keyed surface and is presentation-only - it imports no server code.
- **A new operator authority** (something beyond retry / withdraw / decide / resolve-finalization /
  cancel / restore) extends the single `EnsembleAction` union and the one `/actions` route. Needing
  one is the signal a proposal is a new primitive, not merely a new strategy.

### What a new strategy must do

Add or extend a browser-safe descriptor and a pure compiler; reuse existing stage/driver/adapter
primitives wherever possible; add a bounded driver or result renderer only for genuinely new
behaviour or presentation; declare its exact launch range, budgets, information flow, artifacts,
evaluation, decision, finalization and workflow compatibility; add registry and extension-contract
tests; and require a **separate product decision** before it becomes enabled. It must **not** add a
parallel multi-agent manager, database family, route family, EventSource, Session field,
layout-specific state machine, or a node in the Workflow graph.

### The two load-bearing invariants

- **No strategy branch in `EnsembleEngine`.** The engine dispatches on a compiled stage's
  `driverKind`/`driverKey`, never on a strategy id. Persisted append-only ids, versioned compiled
  plans, and exhaustive driver registries are what keep this true; recovery executes the stored plan,
  never a fresh compilation with today's defaults.
- **No Ensemble node in the Workflow graph.** A workflow reviews exactly one session; an ensemble is
  the selection stage over several. They compose only at promotion, across the server-owned external
  binding boundary - an Ensemble graph node would force multi-subject bindings and a second
  orchestration engine hidden inside the review engine.

Both invariants are enforced by `test/ensemble-extension-contract.test.ts`.
