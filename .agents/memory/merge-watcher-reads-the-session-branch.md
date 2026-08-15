---
category: recovery-procedure
date: 2026-08-14
source-session: sdk:4abfdc3c-97cf-47e5-956e-633d9d154a68
times-confirmed: 1
---

# A recovery branch strands every task that depends on it

`reconcileMergedTasks` completes a task - including a `cancelled` or `failed` one, which a
merge outranks - from the pull request recorded on its work-episode binding, and that binding
is found from the branch the bound session is standing on. A session that continues someone
else's pull request under a different local branch name is therefore invisible to it: the
branch it reports carries no pull request, the merge is never attributed, and every declared
dependency on that task stays unsatisfied while the work is demonstrably on `main`.

This is the ordinary shape of a recovery, because the original branch is usually still checked
out in another worktree and git will not hand it to a second one. It happened twice in one job
here - once for the cancelled original task, once for the recovery task that finished it.

Repair through the daemon, never by writing the database: `POST /api/tasks/:id/complete` with
`{"outcome":"merged <pr-url>","outcomeUrl":"<pr-url>","satisfyDependents":true}`. That is the
same call the automatic sweep makes, it is accepted on a `cancelled` row, and
`satisfyDependents` is the part that closes the declared edges pointing at the task. Afterwards
check the dependent's edge actually carries a `satisfiedAt`.
