---
category: repo-convention
date: 2026-08-14
source-session: sdk:4abfdc3c-97cf-47e5-956e-633d9d154a68
times-confirmed: 1
---

# Do not merge while a review workflow is still running

A task carrying `builtin-workflow:no-mistakes-review` gets repair rounds after its pull
request goes green, and each round asks for changes on *that* pull request. Merge before the
run finishes and every later round becomes unanswerable: a merged pull request takes no new
commits and cannot be closed, so "push the fix here" and "close the duplicate" are both
impossible, and the loop repeats the demand it cannot get.

Observed: a phase pull request merged the moment its checks went green, the first repair
packet arrived 39 minutes later, and the third round's whole finding was that the repairs had
landed as follow-up pull requests rather than on the merged one. The fixes themselves were
correct and already on `main`; only the vehicle was wrong, and the vehicle could no longer be
changed.

The task prompt may itself say the phase is not complete until the pull request is merged.
That instruction and the review workflow disagree, and this order satisfies both: let the run
finish its rounds, then merge. If it is already merged when a round lands, say so with the
merge timestamp, land the substance as a follow-up, and consolidate the record onto the
original pull request - there is nothing else available.
