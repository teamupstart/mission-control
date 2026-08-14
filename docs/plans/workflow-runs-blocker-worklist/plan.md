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
finding on every commit. The worklist adopts the same rule for the same reason.

**Adopted:** identity is `path` (empty when absent) plus the normalized title, lowercased,
stripped of backticks, quotes and emphasis, whitespace-collapsed and trailing-punctuation
trimmed. It is **not hashed** - `marker.ts` uses `node:crypto`, which the browser bundle
cannot take, and a UI grouping key has no need to be a digest.

**Known failure mode, accepted:** a reviewer that rewords its own title produces a new key, so
the change reads as newly raised and its predecessor reads as resolved. This is the same
trade-off `marker.ts` already makes.

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

### `repeatOffenders` is already in the payload

`WorkflowStore.runDetail` emits it (`src/server/workflows/store.ts:5997-6024`) and
`WorkflowRunView` ignores it. Rendering the stalemate card needs no server work at all.

## Success criteria

1. Opening a run that has requested changes shows those changes as a worklist without
   scrolling past any passing reviewer.
2. A change still open from an earlier round says which round it was first raised in and how
   many rounds it has been open.
3. A change that stopped being raised says which round resolved it.
4. When two reviewers have failed consecutive rounds, the page says so.
5. A person can copy one change, open its file, give its reviewer feedback, or disable that
   reviewer, without leaving the worklist.
6. The pipeline, header, round scrubber and run rail are byte-for-byte unchanged in behavior.

## Non-goals

- Deep-linking to a selected change.
- Any change to the pipeline diagram, the header, the scrubber or the rail.
- Server, schema, migration or wire-contract changes.
- The other five mockups. C's round matrix and F's round delta were explicitly not selected.
- Reworking "Captured intent and evidence". It is the other half of the measured wall and is
  left for separate work.
