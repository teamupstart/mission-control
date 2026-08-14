# Workflow runs: the Blocker Worklist

## Goal

Replace the "Reviewer verdicts" section of the Workflow runs reader pane with a **blocker
worklist**: a list of the changes a run is actually asking for, on the left, and the full
detail of the selected one on the right. Everything that is not currently blocking moves
behind a segmented control.

The header, round scrubber and stage pipeline above it do not change.

## Why

The reader pane is a chronological archive presented as a decision surface. Measured on a
live run (No-Mistakes Review v8, run `955694c7`, round 10 of a 9-round budget), the two
sections a person actually reads render **11,445 characters to convey about 480**:

| Section | Rendered characters | Decision-relevant content |
| --- | --- | --- |
| Reviewer verdicts, the 4 passing cards | 1,984 | None. A pass needs a count, not a card. |
| Reviewer verdicts, the 2 failing cards | 2,663 | 3 change titles, 3 paths, 2 summaries. |
| Captured intent and evidence | 6,798 | Effectively none. The operator wrote the goal. |
| **Total on screen** | **11,445** | **~480** |

Volume is the symptom. The causes are structural:

1. **Passes cost the same as failures.** Four of six reviewers passed; each still renders a
   header, a summary, an approval rationale and an evidence list.
2. **The decisive facts are not on the page at all.** `detail.repeatOffenders` arrives in the
   payload and says *Code Risk Reviewer: 10 rounds, Test Evidence Auditor: 10 rounds*.
   `WorkflowRunView` never renders it; only `WorkflowLadder` does.
3. **A change has no continuity.** Each round re-renders its verdicts from scratch, so a
   finding raised in round 1 and still open in round 10 looks identical to one raised
   moments ago. Nothing on the page says a run is stuck.

## Approved design

The human reviewed six mockups in
[`docs/reports/workflow-runs-triage-mockups/report.html`](../../reports/workflow-runs-triage-mockups/report.html)
and selected **Mockup B, the Blocker Worklist**. That selection is a requirement of this
plan, not an open question.

### Recorded human decisions

| Decision | Selection |
| --- | --- |
| Which direction | **Mockup B, Blocker Worklist** |
| The stage pipeline, run header and round scrubber | **Keep unchanged.** The redesign is strictly below them. |
| The run rail (list of runs on the left) | **Keep unchanged.** |
| Next step | **Create a phased implementation plan and schedule the work.** |

### The surface

Below the existing pipeline, the reader pane becomes a two-column worklist.

**Left rail (the agenda)**

- A segmented control: `Blocking N` / `Passed N` / `Archive`.
- Under `Blocking`, one row per open requested change: title, path, and the reviewer plus
  the round it was first raised in.
- Resolved changes stay visible with a green rail and a "Resolved in round N" line, so
  progress is legible rather than silently disappearing.
- A stalemate card at the foot of the rail when `detail.repeatOffenders` is non-empty:
  *"Code Risk and Test Evidence have failed all 10 rounds."*

**Right pane (the selected change)**

- The reviewer's own summary, its confidence, runner and model.
- A facts row: file, first raised, rounds open, evidence-reference count.
- "What the reviewer wants": the change rationale in full.
- Cited evidence quotes.
- Actions: Copy this change, Open file, Give this reviewer feedback, Disable that reviewer
  for this run, and previous/next to walk the list.

### What this does not change

- The stage pipeline, its stage cards, its per-node menus and the seam labels.
- The run header, its action row and the round scrubber.
- The run rail and its filters.
- Any server route, database schema, migration or wire contract. Everything the worklist
  needs is already in `WorkflowRunDetail`.

## Repository findings that shape the design

These were verified against the code and override the mockup where they disagree.

### A requested change has no identity, and none is computed anywhere

`RequestedChange` (`src/shared/workflow.ts:2932-2938`) is `{ title, rationale, evidence,
path?, line? }`. It has no id, no key and no fingerprint. Nothing in `run-model.ts` or on the
server correlates verdict *content* across rounds; the only cross-round facts are inheritance
by `nodeId` and the server-written continuation pointers.

So "open since round 4" and "resolved in round 9" have to be **derived**, and the derivation
is the subtle part of this work. The prior art is `src/server/inspector/marker.ts:140`, which
fingerprints a PR finding over `path` plus a normalized title and **deliberately excludes the
line number**, because the next push moves the line and the reviewer would re-raise every
finding on every commit. The worklist adopts **that** rule for that reason, and departs from
the rest of it - see the author paragraph below.

**Adopted:** identity is the **owning persona node id**, plus `path` (empty when absent), plus
the normalized title - lowercased, stripped of backticks, quotes and emphasis,
whitespace-collapsed and trailing-punctuation trimmed. It is **not hashed** - `marker.ts` uses
`node:crypto`, which the browser bundle cannot take, and a UI grouping key has no need to be a
digest.

**Where the `marker.ts` analogy stops: the author.** There is only ever one Inspector raising
findings on a pull request, so `path` plus title is a sufficient identity there and no
cross-author collision is possible. A workflow run has several personas reviewing at once, and
two of them can independently object about the same file in words that normalize identically -
"attach completed test output" is exactly the kind of sentence two reviewers write. Keyed
without the author they would fold into one row, and because the row carries a single `nodeId`
the losing reviewer's evidence would vanish and its objection would become un-actionable from
the worklist: "Disable {persona}" and "Give this reviewer feedback" both act on the surviving
node. Two reviewers wanting the same thing are two objections, separately actionable, and the
identity has to say so.

Including the node costs nothing for the job the key exists to do. A persona's `nodeId` is
stable across rounds within a run's immutable workflow version, so cross-round matching for a
single reviewer is unaffected; the node component only prevents cross-reviewer merging.

**Known failure mode, handled:** a reviewer that rewords a title it keeps raising produces a new
key, so the old key stops appearing. `marker.ts` accepts exactly this and can afford to, because
nothing sits beside it contradicting the result. This surface is different: the stalemate card
at the foot of the same rail is derived from `repeat-offender.ts`, which keys on `nodeId` and
pass/fail and never reads a title. Left alone, the rail would show an Archive row saying
*"Resolved in round 5"* directly above a card saying *"Test Evidence Auditor has failed 10
rounds running"* - about the same reviewer. That is precisely the on-screen disagreement this
plan cites to justify sharing the round-folding rule, so it does not get to be an exception.

**Adopted:** a change has three states, not two. A key that stops appearing while its owning
persona **keeps failing** is `superseded` - the objection did not go away, it got rephrased. A
key that stops appearing because its persona stopped objecting is `resolved`. Both live in
Archive and are labelled differently, so no row ever claims a reviewer is satisfied while
another part of the same rail says it is not.

This is derivable inside the worklist from data it already walks, so it needs no reference to
`repeatOffenders` and does not inherit that signal's `rounds >= 2` threshold - which exists for
alerting and has nothing to do with this question.

### Rounds are not submissions

`src/server/workflows/repeat-offender.ts` folds submissions to one entry per **round** before
walking, keeping each node's newest attempt across that round's segments, because a session
action can split one round into several evidence segments. Walking submissions directly
"would see two rows of the same round, decide the sequence had broken, and report a reviewer
that has failed five rounds running as having failed one".

**Adopted:** the worklist derivation reuses that exact round-folding rule. If it did not, the
rail's "open 7 rounds" and the stalemate card's "failed 10 rounds" would disagree on the same
screen, which is worse than either being absent.

### Not every change has a path

`path` is optional on `RequestedChange`, and the e2e fail fixture
(`e2e/fixtures/fake-claude.mjs:259`) emits a change with **no path at all**. The mockup drew
every row with a file under it.

**Adopted:** a pathless change renders its row without the path line and groups under the key
`"" + title`. The right pane shows "No file cited" rather than an empty monospace slot.

### Sub-run selection is not routed, and will not be

The selected round is **not** in the URL - `WorkflowRunView` takes `roundId` as a prop driven
by local state (`WorkflowRuns.tsx:452`). There is no precedent for a sub-run selection in
`MissionRoute`, and adding one means touching `parseMissionRoute`, `missionRouteHash` and the
`onFilters` handler in `App.tsx`, which silently drops any route field it does not spread.

**Adopted:** the selected blocker is local component state, exactly like the selected round.
Deep-linking to an individual change is a deliberate non-goal. This removes all route work
from the plan.

### The stalemate fact is in the payload, but latest-anchored

`WorkflowStore.runDetail` emits `repeatOffenders` (`src/server/workflows/store.ts:5997-6024`)
and `WorkflowRunView` ignores it, so the fact never reaches this page. No server work is needed
to fix that.

It cannot be rendered straight from the payload field, though. `repeatOffenders(submissions,
attempts)` is called with the **whole run's** submissions and anchors on the newest one, so the
value is always "as of the latest round" and the `asOfRound` window cannot re-scope it. Rendered
directly, scrubbing back to round 4 of a 10-round run would leave a card reading *"failed 10
rounds running"* beneath segments correctly describing round 4 - a fact from six rounds in the
reader's future, sitting in the one place this design keeps insisting must not disagree with
itself.

**Adopted:** the worklist derives its own windowed stalemate signal from the folded rounds it
already walks, and the card renders that. At the default window it equals `detail.repeatOffenders`
by construction, which a test pins. The payload field keeps serving the ladder and the alert
engine, which genuinely do want the latest-anchored answer.

## Success criteria

1. Opening a run that has requested changes shows those changes as a worklist without
   scrolling past any passing reviewer.
2. A change still open from an earlier round says which round it was first raised in and how
   many rounds it has been open.
3. A change that stopped being raised says which round resolved it.
4. When two reviewers have failed consecutive rounds, the page says so.
5. A person can copy one change, open its file, give its reviewer feedback, or disable that
   reviewer, without leaving the worklist.
6. A failed command gate is a blocker too, and keeps the exit code and output tail the current
   page shows. A run stopped only by a failed check never presents as having nothing
   outstanding.
7. A change is only ever shown as resolved once its own reviewer has re-run and stopped raising
   it, never because a different reviewer moved the run to a new round.
8. The worklist answers for the round the scrubber points at. Scrubbing back shows what that
   round was asking for, and all three segment counts move together.
9. The pipeline, header, round scrubber and run rail are byte-for-byte unchanged in behavior.
   The scrubber keeps the meaning it has today and now governs the worklist as well as the
   pipeline; it does not grow a section that ignores it.

## Non-goals

- Deep-linking to a selected change.
- Any change to the pipeline diagram, the header, the scrubber or the rail.
- Server, schema, migration or wire-contract changes.
- The other five mockups. C's round matrix and F's round delta were explicitly not selected.
- Reworking "Captured intent and evidence". It is the other half of the measured wall and is
  left for separate work.
