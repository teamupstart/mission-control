# Multi-agent ensembles

An **ensemble** is a group of ordinary [dispatched tasks](dispatch-and-backlog.md#dispatch-an-agent) run together
under one versioned *strategy*, plus the group-level facts a single task cannot express: one
pinned base commit, member roles, immutable submitted artifacts, evaluations, a human
decision, and a terminal outcome. Three strategies ship: **Best of N** - two to five agents
implement the same task alone from the same commit, one tool-less comparison ranks what they
submitted, and you confirm the winner; **Consensus**, which ends in questions rather than a
winner; and **Panel vote**, the Best-of-N roster judged by independent single-lens judges whose
disagreement is shown rather than averaged away. See [Additional strategies](#additional-strategies)
below and the [operator guide](ensembles.md) for the full strategy, judging, and quorum
semantics.

**Start one from Dispatch, watch it under Workflows.** Open the dispatch modal and flip the
header's launch mode from **Single agent** to **Ensemble** (the modal widens so a candidate
lane holds one line). The same title/repo/intent/attachment compose area serves both; below
it, a descriptor-driven segmented **Strategy** control renders the chosen strategy's own
form - candidate lanes choosing their own agent, model, effort and optional approach hint,
steppers for the tuning knobs, the strategy's judging Persona or panel, and an optional
[workflow](workflows.md#workflows-and-personas) where the strategy supports one. A **Launch plan** strip
draws what pressing Launch starts - the pinned base, the isolated lanes, the evaluation, and
the human gate - with the estimate figures beside it. **Review launch** sits in the footer's
primary slot and posts a side-effect-free preview (member count, concurrency, waves,
evaluation calls, and whether the chosen workflow mode is executable); once it verifies, a
green **Reviewed** chip appears and **Launch N agents** takes the slot. Any edit after that
invalidates the review, so the launch always confirms exactly what you reviewed. The launch is idempotent on a stable request id: a lost
response and a retry return the same run, never a second fleet. Every candidate wears a distinct
**E** mark (separate from a workflow's **W**) that opens the run and says what the member's own
standing is - `E 3/5 · working`, or an attention-toned **needs an answer** the moment that
candidate is waiting on you. Siblings are drawn *together*: the Board and the Console rail
group them under a header carrying the run's title, its stage word,
one dot per member of the roster and an **N needs you** rollup - see
[Layout](ui.md#layout-console-or-board-in-settings). The **Ensembles** tab beside Workflows, Personas and
Runs is the monitoring, evidence, decision, recovery and history surface: it wears a badge
counting the runs the daemon marks as needing attention, and lists runs attention-first from the
one live SSE stream with their shared progress dots and `submitted/roster` counts (plus the
launched count while a wave is still opening),
and fetches a selected run's bounded detail. A **Launch -> Work -> Review -> Decide -> Promote**
pipeline names the active stage in operator words and explains a waiting barrier (“waiting for 1
more submission” or “waiting on you”). Live members render as lanes with session tone, activity,
goal, elapsed time, last-event age and live cost; a blocked member's review form and verified
pane/driver dialog are answerable there without leaving the run, while attempt and artifact
histories fold behind a disclosure. The rest of the bounded detail carries immutable artifacts and
their on-demand diffs, the stage/evaluation timeline, the strategy's own result view (Best of N's candidate columns,
Consensus's agreements and divergence cards, Panel vote's rank matrix and ballots), and the decision
that strategy asks for - over HTTP, refetching when that run's summary revises rather than polling.
The strategy-neutral runtime pins one base commit, launches
bounded *waves* of ordinary member tasks (creating every task in a wave before dispatching the
first, and never launching past the concurrency the plan authorizes), accepts an explicit
submission from each member, captures its working tree as an immutable private Git commit, advances
barriers off ready artifacts rather than off a task going idle, and resumes safely after a daemon
restart. A member submits through a dedicated `submit_ensemble_result` MCP tool (with a manual
operator fallback), and the daemon decides *which* member from the calling session, its task and its
worktree - a member never names itself, so a guessed id reaches nothing.

**Best of N evaluation.** When every live member has submitted or terminated and at least two
produced a snapshot, the daemon runs one tool-less, provider-neutral **comparison** of the immutable
submissions and parks the run at a durable human-decision boundary. The judge is deliberately
blind: it is handed the task, bounded base-to-snapshot diffs, per-file statistics and each member's
own reported claims (labelled as claims), but every agent name, model, member ordinal, ref name,
snapshot commit id and worktree path is stripped and each submission is relabelled anonymously, so
brand and order cannot bias the ranking. Truncated diff evidence is disclosed in the result. Every
candidate-authored section is fenced as untrusted data. The reply is validated strictly - exactly
the eligible submissions once each, integer scores, contiguous ranks, a recommendation that holds
rank 1 - and a malformed, incomplete, or injected reply is a *failed attempt*, never a low score or
a fallback winner. The built-in rubric scores only the submitted artifact's correctness,
maintainability, repository fit, scope discipline, regression surface and security risk. A member's
report is context only: the judge checks any load-bearing claim against the artifact and ignores
claims it cannot establish, without rewarding or penalizing the thoroughness or accuracy of the
report. The comparison shares the one daemon review-call ceiling with Workflow review,
resolves its runner and model per call (a judging Persona's own overrides, else the
`ensemble-comparison` job model), records every call on a durable ledger, and recovers a call
interrupted by a restart by retrying it against the exact same evidence. It **recommends** a winner;
it cannot promote one.

**The decision is made from a dossier, not from three sections of the page.** When a run parks at
`awaiting_decision` its Result section leads with **At stake** - the run's own intent, the one
commit every candidate started from, the elapsed time and what the fleet has spent (unknown stays
unknown, never `$0.00`) - and then draws one column per candidate composing what that candidate
*reported*, what Mission Control *observed* (diffstat), what it cost, and how it was ranked, with
**Evidence** opening its diff. Panel vote adds a judges x candidates **rank matrix** marking every
cell where a judge broke with the panel, and quotes the ballot that ranked the winner worst in that
judge's own words. The decision form sits at the bottom, after the evidence, and says before the
click that a decision is recorded **once**. Afterwards the dossier persists read-only as the
durable "why we picked B" record - what was promoted, the operator's rationale, and a **Restore**
beside each losing column, which is where the fact that every loser's snapshot was *kept* finally
becomes discoverable. The run's decision is also one click from the
[attention inbox](attention-and-alerts.md#attention-inbox-one-place-to-drain-what-needs-you).

Below the live Members lanes, **Compare** opens when two ready snapshots exist. Pick two or three
candidates to get a churn-sorted file-touch matrix with rename/binary/“only #N” marks, an aligned
claims strip (summary, checks, frozen cost and any score/rank/confidence), and synchronized
side-by-side panes for one exact file. Scorecard rationale paths open the matching matrix row; if
the selected candidates did not touch that path, Compare says so explicitly. See
[Comparing snapshots file by file](ensembles.md#comparing-snapshots-file-by-file) for the
selection, evidence and truncation behavior.

**Finalization begins from a durable human decision and nothing else.** You confirm one eligible
submission (or an explicit *no consensus*) through `POST /api/ensembles/:id/actions`; the decision
carries a stable request id, the run state it expects, and an explicit destructive confirmation, so
a lost response returns the same decision and a wrong-state or ineligible pick is refused rather
than acted on. For a selected result, only then does anything destructive run, and it runs
restart-safe in this order:
re-verify the winner's private ref still resolves to its snapshot (a missing ref blocks *all*
cleanup); make one exact winner available - either the original member's checkout reset to the
snapshot through the same session-reset that clears its queue, drafts and context, or, if that
session is gone or busy, exactly one replacement task launched at the snapshot (never two, across
any restart); reap every loser through the normal task cancellation that reclaims its worktree;
reconcile a superseded original winner as described in
[Where the selected result lands](ensembles.md#where-the-selected-result-lands); then either
hand the winner to a workflow or type it one continuation - never both. A step that cannot finish
leaves the run *finalizing* with an actionable error and is resumed by
`resolve_finalization`; the run reaches *completed* only once the winner is exact, every loser is
reconciled, and any workflow submission is captured. Every loser's private snapshot survives.

**The optional Workflow handoff is the N-to-one boundary.** If a run pins a published
[workflow](workflows.md#workflows-and-personas) version at creation, finalization binds that exact version to
the winning session and submits its clean snapshot through the same server-owned external boundary
any other source uses - idempotent on a stable source key, so a restart returns the same binding
and run. It requires the winner's HEAD to equal the chosen snapshot and its tree to be clean; a
drift is healed by restoring the winner and resuming the *same* submission. A note-key conflict, an
unavailable mode, or a Live/Foreman selection (only Preview is executable today) blocks visibly and
is never downgraded or adopted - you retry after resolving it or explicitly skip the handoff and
finish with the normal continuation. A session cannot be bound to a workflow manually while its
ensemble member is active; finalization marks the selected member retained before it uses the same
binding boundary for the handoff. Ensemble and Workflow lifecycles stay separate: a workflow reset
removes its binding but never an ensemble ref, and a completed ensemble never recreates a reset run.

### Additional strategies

Every strategy runs on the unchanged engine above - the same pinned base, the same member waves,
the same immutable artifacts, the same durable human-decision boundary. What a strategy chooses is
which question its evaluation asks, what the person is asked to decide, and what the terminal
outcome does.

**Consensus** turns three to five independent attempts into *questions instead of a winner*. The
members work exactly as Best-of-N's do; the difference is what happens next. One tool-less,
anonymous, provider-neutral pass compares what the submissions **decided** rather than how good
they are: what all of them did the same way is filed as an **agreement**, and each thing they did
differently becomes an open **question** with one option per position actually taken, attributed to
the attempts that took it. The pass may not rank, score or recommend, and the reply is validated as
strictly as a comparison is - a pass that reported nothing at all, named a submission the packet
never contained, put one submission on two sides of the same question, or silently ignored one of
the attempts is a *failed attempt*, never a question set. Question and option ids are assigned by
the daemon after validation, so your recorded answer names an id no candidate's diff could have
influenced.

You then answer the questions: pick the position you want, or write your own. Nothing is promoted
and **nothing is reaped** - every attempt's snapshot is kept and restorable, the run terminates
*retained*, and the answers are recorded with the decision. The questions you are asked are
persisted when the decision stage opens and your answers are validated against exactly those, so a
re-run evaluation can never turn a recorded answer into an answer to a question you never saw. Use
it when the disagreement is the point - an unfamiliar area, a design with real forks in it, a task
where you want to know what the choices are before you pick one. Its evaluation shares the one
daemon review-call ceiling and the same **Settings → Models → Ensemble evaluation** job as the
Best-of-N comparison.

The public API is one localhost surface: `GET /api/ensembles` (compact summaries),
`POST /api/ensembles/preview` (a side-effect-free launch/budget/handoff estimate that shares
create's exact validation), `POST /api/ensembles` (idempotent create and launch on a stable request
id), `GET /api/ensembles/:id` (bounded detail), `POST /api/ensembles/:id/actions` (one discriminated
action covering decide, resolve-finalization, retry, withdraw, cancel, failed-run dismissal and
restore), the bounded
artifact evidence/patch and manual-member-submission routes under that run, and
`DELETE /api/ensembles/:id` (explicit terminal-history-and-ref deletion, confirmed by echoing the
run id, which never deletes a task or linked workflow state and resumes the same remaining refs
after a crash). The dashboard drives all of it from that one surface; on a machine that never
starts an ensemble the tables stay empty and the product behaves exactly as before. The operator
and extension reference is [`docs/ensembles.md`](ensembles.md) (states, private refs,
retention and deletion, costs, restart, recovery, security limits, and how a new strategy composes);
the design plan is
[`docs/plans/best-of-n-swarm-dispatch/plan.md`](plans/best-of-n-swarm-dispatch/plan.md).

<a id="ensemble-strategies"></a>
### Strategies

A strategy is a versioned recipe, not a fork of the runtime: it validates a configuration,
compiles it once into a plan of generic stages, and contributes a result view. Everything below
runs on the same engine, tables, routes and layout marks described above.

**Best of N** (`best_of_n`) - two to five candidates, one comparison, one winner. Described in
full above; it is the default the dispatch modal opens on.

**Panel vote** (`panel_vote`) - the same two-to-five roster, judged by a **panel** of two to five
independent single-lens judges instead of one comparison. The dashboard shows their aggregate,
their individual ballots, and how far their rankings disagreed; at least two usable ballots are
required, and the human still confirms the outcome. The
[ensemble operator guide](ensembles.md#what-panel-vote-does) owns the detailed lens,
aggregation, failure, quorum and recovery contracts.

**Attention and cost are honest.** Ensemble transitions feed the same
[alert engine](attention-and-alerts.md#alerts--away-mode) every other "needs you" flows through - a run reaching its
decision, turning unreadable, or stuck finalizing interrupts you; completion, cancellation and
failure land in the Away digest - with no separate notifier. Each candidate's agent cost is summed
from its session telemetry at submission and frozen into its immutable artifact, so the run detail
shows an aggregate attributed per member; a runner that reports no cost is shown as *unreported*,
never `$0.00`, and the evaluator's own model cost and any linked workflow review cost are reported
separately rather than folded in. Hard ceilings no strategy can exceed - 16 members, 8 concurrent, 8
waves, 5 stage attempts - sit above each strategy's own 2-5 candidates, and the preview shows the
exact figures before you launch.

Four decisions are worth knowing now, because everything later is built on them:

- **Every member is an ordinary task.** Ensembles add no second dispatcher, worktree
  provisioner or cancellation path; the group owns what a task cannot own, and nothing else.
  The member link nests inside the task summary a session already carries instead of adding
  another field to the session itself, which is what the **E** mark on every layout reads to
  say which candidate a card is and how the group ranked it.
- **Evaluators recommend; they never promote.** Every evaluation is advisory and runs without
  tools. Anything destructive - resetting a branch to a chosen snapshot, reaping the losing
  worktrees - waits for an explicit human confirmation, and the compiled plan carries that
  requirement as a type the schema will not let a strategy opt out of.
- **A run executes the plan it was created with.** Its strategy, version and compiled plan
  are snapshotted at creation, so a strategy whose defaults change later cannot silently
  re-aim work that is already running. A run written by a *newer* build still loads and
  remains covered by the generic cancel and delete contracts. It reports which piece this
  build does not have and refuses to run rather than substituting something adjacent.
- **Members will not push or open pull requests.** Publishing happens after a winner is
  chosen, through the normal [shipping](inspector-and-shipping.md#shipping-yolo-mode) flow, so an ensemble never
  leaves N branches and N pull requests behind. Note the isolation between members is
  behavioural, not a sandbox: they share one Git repository and a local agent can find its
  siblings if it goes looking.

Ensembles are deliberately separate from [Workflows](workflows.md#workflows-and-personas). A workflow
reviews exactly one session; an ensemble is the selection stage over several. They compose
at promotion - a confirmed winner can be handed to a published workflow version - and that
handoff crosses the same server-owned boundary any external result does.

## Multi-agent ensembles: operator and extension guide

An **ensemble** runs a group of ordinary dispatched tasks under one versioned *strategy* and owns
the group-level facts a single task cannot: one pinned base commit, member roles, immutable
submitted artifacts, evaluations, a human decision, and a terminal outcome. Three strategies are
enabled: **Best of N**, which ranks and promotes one; **Consensus**, which mines what the attempts
disagreed about and promotes nothing; and **Panel vote**, which ranks through independent
single-lens ballots and surfaces their disagreement. This document is the operator's reference for
what an ensemble does, how to recover one, what it keeps and what it costs, and the contract a future
strategy extends.

The product reference is [above](#multi-agent-ensembles); the design
rationale is in [`docs/plans/best-of-n-swarm-dispatch/plan.md`](plans/best-of-n-swarm-dispatch/plan.md).

## What Best of N does

1. From **Dispatch**, switch the header's launch mode from *Single agent* to *Ensemble* and pick
   **Best of N** in the strategy control. Configure two to five candidate lanes (agent, model,
   effort, optional approach hint; repeats are allowed), an optional evaluator Persona, and an
   optional [workflow](workflows.md#workflows-and-personas) to hand the winner to. The **Launch
   plan** strip shows the pinned base, the lanes, the comparison and the human gate before you
   commit.
2. **Review launch** posts a side-effect-free preview (member count, concurrency, waves, comparison
   calls, and whether the chosen workflow mode is executable). Any later edit invalidates it, so
   **Launch N agents** confirms exactly what you reviewed. The launch is idempotent on a stable
   request id: a lost response and a retry return the same run, never a second fleet.
3. The daemon pins **one full base commit** and launches 2-5 ordinary member tasks from it - every
   candidate starts byte-identical. Each is a normal session in Console and Board, marked
   with an **E** chip that opens the run. Its task title starts with **Candidate N -** so sibling
   tasks remain identifiable wherever titles are truncated or scanned in a list.
4. Each candidate implements and tests alone. Its prompt forbids pushing, opening a PR, or running
   the shipping gate, and tells it to **submit** when ready.
5. A member submits through the launch-scoped `submit_ensemble_result` MCP tool (or the manual
   Submit action in the run detail). That tool is a launch **precondition**: a member launch is
   refused before the agent spawns unless Mission Control's MCP bundle both registers and
   actually publishes it, checked by a real handshake against the built bundle, because a member
   that runs to completion and cannot signal it is ready stalls the whole run (see
   [Adding or changing a tool means rebuilding the bundle](sessions.md#review-channel-mcp)).
   The daemon attributes the submission from the calling
   session -> its task -> its active member; a member never names itself, so a guessed id reaches
   nothing. Submission captures the working tree as an **immutable private Git commit** (see refs
   below) and records reported checks, observed diff statistics, and the member's agent cost.
6. When every live member has submitted or terminated and **at least two** produced a snapshot, one
   tool-less comparison ranks the immutable submissions and parks the run at a durable human
   decision boundary. The comparison is anonymous (agent, model, ordinal, ref and worktree stripped)
   and **recommends** a winner - it never promotes one.
7. You confirm one eligible submission (or declare **no consensus**) from the run's
   [decision dossier](#deciding-the-dossier). Only then does anything destructive run.

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
   alone. A lens is a strategy rubric (Correctness, Maintainability, Risk, Evidence, Scope) or a
   Persona from the catalog, including an app-owned built-in, snapshotted exactly at creation. All
   the judges are asked in **parallel** against ONE shared anonymous evidence packet built once, so
   a judge that disagrees is disagreeing about the submissions rather than about what it happened
   to be shown. Two judges may not share a strategy rubric - a panel that agrees by construction is
   not a panel. Repeating a Persona is allowed when the operator deliberately wants multiple
   samples of the same guidance.
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

## Monitoring a live run

The selected run begins with an ordered **Launch -> Work -> Review -> Decide -> Promote**
pipeline. Those are operator words for the compiled stage kinds, so a strategy remains free to
name its durable stages and drivers without making the header read like `stage-2-review`. The
active step carries the count that matters there: members launched, snapshots submitted and
members blocked during Work, or the current attempt during Review. A completed run keeps the
whole walked pipeline visible as part of its record.

`waiting` is always paired with its barrier. A member barrier says exactly how many more
submissions its `minEligible` still needs; once the artifact minimum is met, it says that the
remaining members still need to settle. A decision barrier says **waiting on you**. These words
come from one pipeline projection, so later comparison views must consume them rather than invent
a second explanation.

The **Members** section is live while its ordinary sessions are live. A joined member becomes a
lane showing the session tone and status, current activity, goal, elapsed time, honest
**last event** age, and the session's live cost estimate. “Last event” is deliberate: the
registry has one timestamp shared by hook, passive and driver events, not a dedicated activity
timestamp, and no stall deadline is inferred from it. The immutable artifact's candidate cost
remains the separate, frozen at-submission figure used by the dossier and aggregate.

Each lane keeps Withdraw, Retry, Submit, Open session and Open task exactly where the durable
member card offered them. Attempt and artifact histories fold behind **Attempt & artifact
history** for a live member, opening automatically on failure; a member with no joined session
stays the full record card, so terminal histories and restored snapshots do not pretend to be
live. If a member asks through `request_input`, the same review form used by the session modal
appears under **Candidate N asks**. If its pane or embedded driver is showing a dialog, that
dialog's verified buttons or form appears beside the review. They remain two protocols and use
their existing routes; the lane only composes them in the run context.

## Layout signals: where a run shows up in the fleet

A member is an ordinary session, so it appears in Console and Board like any other. What
the ensemble adds is drawn from two facts and nothing else - the run's live `EnsembleSummary` and
the member link that rides on that session's task - so no surface re-derives a state the daemon
already decided.

**One vocabulary for where a run is.** `planning` reads as *launching*, `running` as *working*,
`evaluating` as *reviewing*, `awaiting_decision` as **waiting on you**, `finalizing` as
*promoting*, then *done* / *cancelled* / *failed*. A run written by a newer build is *unreadable*,
never a nearest match. The same words appear on a cluster header and in a chip's hover copy; the
run detail expands that vocabulary into the ordered pipeline above.

**One progress rendering.** A row of squares, one per lane of the roster: waiting on you (amber),
submitted (green), working (blue), lost (red), and an outlined box for a lane the run has not
opened yet. The counts are pairwise disjoint on the wire - a member that submitted and is *now*
holding a question is counted once, as blocked - so the row is exactly `maxMembers` wide and never
double-counts. They are **counts, not positions**: the third square does not mean candidate 3, and
the hover copy says so. The same row is drawn by the Board's cluster header, the Console rail's,
and the Ensembles list row. A cluster header states the row in words as part of its own accessible
name rather than leaving the dots to announce themselves - a labelled button hides its subtree
from assistive tech, so the states the squares carry would otherwise reach nobody using one.

**Clusters.** Sibling members are ordered adjacent in every layout, under a header that opens the
run - at two densities, which carry deliberately different fields. The **Board** frame's header
has room for all of them: title, strategy, stage word, dots, attention rollup. The **Console
rail** (and the Board's drill-in, which is the same rail) carries title, stage word, dots and a
compact attention count, and **deliberately drops the strategy label**; it is the one header field
a reader can also get from any member row's own chip, and at the rail's 260px floor adding it cuts
the run's own name to a handful of characters ("Stabilize parser rollout" becomes "Stabi…").
The strategy stays in the header's hover copy. A cluster **never crosses a Board tone column**:
a member waiting on your
answer sits in *needs you* with the run's header repeated there, and its working siblings stay in
*working*. Moving them all would dilute the column whose whole job is "these are the things to act
on"; the repeated header is what ties the halves back together.

Because the header is repeated, its rollup says two different things. A solid **N needs you**
means a member *in this frame* is holding a question - the tiles below it are what to click. An
outlined **N elsewhere** means the run has one and it is in another column: a pointer, not an
instruction. One badge for both would put an amber call to action over the *gone* column's failed
candidate.

**Member marks.** The chip / tile flag / rail glyph each say the member's own standing from one
shared decision: `needs an answer` (attention-toned) beats everything, then the run's own
`resultLabel` ("rank 1", "retained"), then the member status. *Submitted* is deliberately **not**
attention-toned - the run is working on it and nothing is asked of anyone.

**The Ensembles tab badge** counts runs whose `attention` the daemon raised, and the topbar's
**to answer** count opens the **attention inbox**, where those runs are listed by name. Between
them nothing depends on catching the single `awaiting_decision` toast.

## Answering a member's question

A member is an ordinary session, so it asks the ordinary way - `request_input` over the mission
MCP becomes a review, and a TUI or driver prompt becomes a pane dialog. Both now reach the
**attention inbox** as well as the member's own card.

**Reviews are answered in the inbox**, on the same card the per-session review modal draws, under
a header line carrying the run context: *Best of N "Fix the parser" - candidate 3 of 5*. That
sentence is the point of listing them there. The answer surfaces say nothing about the run, so an
operator answering a question could not tell they were steering **one competitor of a
comparison** - which matters both for fairness (a nudge tilts the result) and for effort (is this
question worth answering, or should the member be withdrawn?).

**A pane dialog is listed but NOT answered in the inbox, deliberately.** A review is a durable row with
an id and a resolve route; a pane dialog is a menu re-read off a terminal screen every poll,
answered by keystrokes aimed at that exact pane, and a stale one is answered by a cursor that has
since moved. They are two wire protocols, and unifying them behind one inbox button would mean
deciding what a stale menu does to it. So the inbox says which member is parked and on what, and
deep-links to the session card. The run's live member lane is also a valid answer surface: it
renders the existing `PaneDialogPrompt` against that exact session and lets its existing
screen-recheck refusal protect the click.

## Deciding: the dossier

At `awaiting_decision` the run detail's **Result** section becomes a decision dossier. The
material was never missing, it was scattered: a candidate's claims lived under Members, its score
under Result, its diff under Artifacts, so comparing two of five meant scrolling among three
sections and holding the difference in your head - and then confirming a winner reset one checkout
and reaped the others.

- **At stake** leads: the run's own **intent** (which appeared nowhere on the page before), the one
  commit every candidate started from - which is what makes them comparable at all - the elapsed
  time, and the aggregate candidate spend. A member whose runner reported no cost stays *not
  reported*; a partial total says how partial it is. Neither is ever coalesced into `$0.00`.
- **One column per candidate** composes what that candidate **reported** (its summary and checks,
  labelled as claims), what Mission Control **observed** (the diffstat we computed), what it cost,
  and how it was ranked - score and confidence for Best of N, Borda points and mean score for Panel
  vote, with the per-judge rank strip. **Evidence** opens that candidate's diff in the Artifacts
  section below.
- **Panel vote adds the judges' own reasoning**: a judges x candidates **rank matrix** whose cells
  are marked wherever a judge broke with the panel's conclusion, and a **dissent** line quoting the
  ballot that ranked the winner *worst*, in that judge's words. The full ballots stay below,
  collapsible, unchanged. Understanding why the panel disagreed no longer means opening every one.
- **The decision form is last**, after the evidence rather than beside it. It is one shared form
  for both strategies (the strategies supply only the choices and how they word an override), and
  it still requires a rationale, still confirms the destructive effect by hand, and still offers
  **No consensus**. It now says *before* the click what the server has always enforced: a decision
  is recorded **once**, and a second `decide` is refused on `expectedStatus` rather than applied.

**After the decision the dossier persists, read-only.** The columns stay, and beside them the
record: what was promoted, the operator's own rationale, and the statement that this is not
revisable. Each **losing** column grows a **Restore** button - the same `restore_artifact` action
the Artifacts section runs. That is where the least discoverable fact in the feature finally
surfaces: every loser's snapshot ref was **kept**, so a change of mind is a checkout reset, not a
second decision. A no-consensus run offers Restore on every column, because nothing was promoted.

Two states are deliberately excluded. While a run is `finalizing` the answer is in flight, so the
record is not yet drawn - offering Restore there would ask to reset a checkout the finalizer is at
that moment resetting itself. And a decision stored in a vocabulary this build cannot read says
that a decision was made and offers no Restore at all, rather than guessing which column lost.

## Comparing snapshots file by file

The **Compare** section sits between Members and Artifacts and is available once at least two
ready `commit` snapshots exist. Before that it says exactly what it is waiting for. Select two or
three snapshots; the selection belongs to this visit to the run and is not persisted.

The claims strip keeps each column's reported summary, number of claimed checks, frozen candidate
cost, and any score/rank/confidence the durable evaluations provide aligned over that candidate's
evidence. An unreported cost remains *not reported*; a real reported zero remains `$0.00`.

The file-touch matrix is built from the union of the selected snapshots' **complete** file lists,
ordered by total churn. Each cell carries insertions/deletions, binary and rename provenance;
files touched by only one candidate are marked **only #N**. Clicking a row opens the same exact
path in synchronized side-by-side panes. Each pane scrolls horizontally on its own and discloses
when its byte-bounded patch was truncated.

Scorecard rationale recognizes exact repo-relative, path-shaped tokens without guessing against
the matrix. Clicking one establishes an eligible pair, scrolls Compare into view and opens that
path. Validation happens there, after the complete file lists load: if none of the selected
candidates touched the named path, the matrix keeps an explicit **Not touched by the selected
candidates** row instead of hiding the claim or inventing a match. A run with no distinct second
ready snapshot renders the rationale as ordinary text, not a dead control.

Compare uses the [single-path artifact evidence contract](#artifacts-and-private-refs): matrix
population requests the complete file list without patch bytes, and an open row requests that one
exact path per selected artifact under the existing byte bound. This keeps request headers bounded
and makes every pane's truncation receipt about one unambiguous file. The Artifacts section retains
its separate lazy whole-artifact cache and continues to work independently.

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

A candidate's diff is re-derived on demand from its immutable commit, never stored, and can be asked
for in three sizes: the whole patch, one file's hunks (`?path=` - one path per request, taken
literally, so a filename that reads as a flag or as pathspec magic is still just that file), or the
file list with no patch body at all (`?filesOnly=1`). A directory passed as `?path=` is refused
whether or not anything under it changed, and so is a name that identifies more than one changed
entry - refused rather than answered with whichever git happened to list first; either side of a
rename selects that one rename diff, while a file absent from the difference returns an empty
patch. The **statistics are complete in every answer** - a narrower request
narrows the patch text and nothing else, so which files a candidate touched is read from the file
list rather than from what happens to be in the patch.

## Retention and deletion

Finalization reaps loser **worktrees** but never loser **refs** - every candidate's snapshot is
kept after completion or cancellation, and a **Restore** action can create a fresh task from any of
them. The **winner's** worktree is never reaped by finalization at all, on either promotion path.
There is **no time-based pruning** in v1: a snapshot is deleted only through the explicit **Delete
ensemble** action. The dashboard opens a confirmation dialog that names the run and the exact
consequence without asking the operator to type its internal id; the API still requires the URL id
echoed in the body as a defense-in-depth contract. Deletion removes the run's private refs and
history and is **irreversible** - the refs are the only copy of a loser's work. Deleting an ensemble
never touches a task or any linked workflow state, and it resumes the same remaining refs after a
crash.

## Costs

The member agents' own token use is not estimated before launch: it is unbounded work, and inventing
a number for it would be the dishonest half of an honest estimate.

## Alerts

Ensemble transitions feed the same shared alert engine every other "needs you" flows through - there
is no separate ensemble notifier or preferences panel. A transition into `awaiting_decision`, a run
turning **unreadable**, or a `finalizing` run holding an error each raise an **attention** alert
(delivered even in Away mode); completion, cancellation and failure are **informational** and land in
the Away digest. Each is edge-triggered by stable run identity, so a reconnect or a recovery never
re-announces a decision you already saw. An ensemble toast deep-links to
`#/ensembles/<id>`.

A run needs your attention when it is an **unacknowledged failure**, **cancelling**, parked on a
**decision**, **unreadable** - or when **a member is waiting on your answer**. **Dismiss failure**
keeps the terminal run, its timeline and its snapshot refs while retiring only that failed-run
attention signal; the acknowledgment is durable across restarts. That last member-owned cause is a
question on a member's own session (a review from the ask channel, or a dialog on its pane), and it
lights the run up wherever attention is read: the run row's dot, its attention-first sort, and the
Away digest's count. It closes the disagreement where the candidate's card was red and asking a
question while the run it belongs to still reported *working*.

**A blocked member deliberately raises no alert of its own.** That member's session already fires
the ordinary session-level review / needs-input alert, so a second ensemble notification would be
the same fact asking to be dismissed twice. The signal is carried by the run's attention state
instead - visible whenever you look, silent when you are not being interrupted. A member being
**lost** (failed, withdrawn, eliminated) is likewise counted but never alerted: retry and restore
are on the run's own surfaces, and a barrier that can no longer be met fails the run, which does
alert.

## Restart and recovery

Every effect is persist-before-act, so a daemon restart resumes rather than restarts:

- A wave is durable before its first dispatch; recovery reconciles surviving agents without
  recreating their tasks and never launches a second fleet.
- An interrupted review becomes `interrupted` (not `failed`) at every level - the LLM call, the
  evaluation, and the stage attempt itself - and retries against the **exact same immutable
  subjects** and evaluator snapshot. An interruption spends none of the evaluator's attempt
  budget, because nothing answered: that budget counts how many times a MODEL may answer badly,
  and a daemon that exited says nothing about the evaluator. Best of N leaves a completed
  comparison untouched.
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
- If work settles with **fewer than two** eligible artifacts, the run **fails** with an explanation
  naming the barrier that can no longer be met - a competition is never manufactured from one
  artifact. That failure is terminal and is a hard stop, not a pause: every member's agent is
  stopped and its worktree reclaimed on the way out, so there is no member to retry (a terminal run
  refuses `retry_member`), no live checkout left to restore a result into, and nothing still running
  to cancel. What survives is the evidence - each submitted snapshot remains a private ref under
  `refs/mission-control/ensembles/`, and its diff is re-derived from the shared git dir, so the
  Artifacts and comparison views keep working for as long as the run is retained. The way on from a
  failed run is to read those artifacts and start a new run, not to revive this one. Once the
  failure has been seen, **Dismiss failure** removes it from the Library and Decide attention
  rollups without deleting that retained evidence.
- A review that cannot **reach** a model - a spawn failure, a timeout, a provider blip - spends its
  own bounded budget rather than the evaluator's, waits longer before each retry (1s, then 4s), and
  after three of them **parks** the run instead of failing it. This is the one review outcome that
  is a pause rather than a hard stop, and the distinction is the point: nothing reached a model, so
  nothing was learned about the candidates, and the expensive, irreplaceable part of a run is the
  candidate work already on disk. The pipeline marks that stage *paused* rather than failed - amber,
  naming how many infrastructure errors it took and leaving the evaluator count untouched - because
  red would say the candidates were gone when they are not. **Retry stage** grants one further
  attempt per press, however the last one settled, and a restart that interrupts a granted attempt
  leaves the stage parked and still asking for you. Only a person ends a parked run. A review that
  DOES reach a model and comes back unusable is the evaluator's failure, spends its attempt budget,
  and fails the run when that budget runs out.
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
  **8** waves, **5** stage attempts. That last one bounds a stage two ways: the attempts it may
  charge to its budget, and the number of times it may be **interrupted** without settling - so a
  daemon crash loop cannot spin free attempts forever even though restarts are never charged. It
  counts interruptions rather than rows because the two retry budgets already bound themselves,
  and at the shipped defaults they sum to exactly this ceiling: a bound on rows would leave a
  stage no room to be interrupted at all. Strategy-specific candidate, judge, result, and material
  bounds are listed below.
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
  binding boundary. An Ensemble graph node would force multi-subject bindings and a second
  orchestration engine hidden inside the review engine.

Both invariants are enforced by `test/ensemble-extension-contract.test.ts`.
