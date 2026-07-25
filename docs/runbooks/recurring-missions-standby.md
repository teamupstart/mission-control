# Runbook: Recurring Missions standby / catch-up

This is the operator checklist for proving the one thing automated tests cannot: that a real
daemon restart and a real laptop **sleep/wake** produce exactly one late catch-up occurrence,
with the actual delay visible in history.

The deterministic correctness of catch-up - restarts, forward/backward clock jumps, DST
transitions, coalescing, the create-all cap, and both crash-recovery windows - is already
pinned by fake-clock tests (`test/schedule-manager.test.ts`, `test/schedule-policy.test.ts`,
`test/schedule-recurrence.test.ts`, `test/schedule-db.test.ts`). Those are the merge gate.
The sleep/wake observation below is a **rollout receipt**: run it once on a real machine and
record the numbers. It is not a reason to hold a pull request open.

Do not change the system clock by hand to fake any of this. The point is to observe the real
timers pausing and resuming; a hand-set clock proves nothing about standby.

## What "durable local catch-up" promises, and does not

- **Guarantee:** if Mission Control runs again, every due instant is accounted for exactly
  once, and the catalog shows how late it was.
- **Non-guarantee:** no work runs while the machine is asleep or powered off. The task is
  created *late*, on resume. There is no wall-clock promise; that needs an always-on runner,
  which is a separate project.

## Checklist

Use a disposable or low-risk repo, and a **scout** schedule (investigate/report, no PR) so a
late run costs nothing if it fires.

1. **Create, Save paused.** Open **Missions** → **Create mission**. Fill in a name, the test
   repo, a task title and intent, agent, and a cadence a few minutes out. For an hourly
   schedule, use Advanced `<next-minute> * * * *` (for example, `17 * * * *`); alternatively,
   pick Daily at a time soon. Set overlap to **allow**, so a task from one observation cannot
   make the next occurrence skip. Click **Save paused**. Confirm it appears in the catalog as
   **paused** with no next run.

2. **Preview the expected instants.** Select it → **Preview**. Confirm the next occurrences
   list local time, UTC, and any DST shift, and that they match what you intended. Optionally
   enter a sleep window in **Simulate standby** and confirm the missed-run policy's decision
   (coalesce / create-all / skip) reads the way you expect.

3. **Enable a low-risk scout schedule.** Either **Save & enable** from the editor (it
   re-previews first) or **Resume** from the detail. Confirm health goes **healthy** and a
   next run appears.

4. **Verify a normal occurrence.** Wait for one due instant while the machine is awake.
   Confirm exactly one backlog task is filed with its schedule provenance mark, and that
   History shows one `created` occurrence with an on-time (≤1m) delay.

5. **Restart the daemon across a due instant.** Stop Mission Control (`make stop-all`) a
   little before a due instant; start it again (`make start` / `make restart`) a little
   after. Confirm the overdue timer fires on startup, files exactly one task, and History
   records the occurrence with the real delay. No duplicate appears on the next tick.

6. **Sleep the laptop across a due instant.** Close the lid (or `pmset sleepnow`) before a due
   instant and wake it after. On resume, confirm one catch-up task is filed and History shows
   the occurrence with the actual `claimedAt - scheduledFor` delay (e.g. `2h 14m late`).
   Record the delay you observed here: `__________`.

7. **Confirm one task / one occurrence.** For each of steps 4-6, confirm there is exactly one
   backlog task and one terminal occurrence per due instant - never two - even after several
   scheduler ticks. Under `coalesce-latest`, a multi-instant sleep should file **one** task
   and record the earlier instants as `coalesced`, each naming the run that covered it.

8. **Pause / archive cleanup.** **Pause** the schedule (or **Archive** it, which keeps its
   history). Confirm an archived schedule leaves the catalog but its generated tasks and its
   History remain reachable via the provenance deep link on any generated task.

9. **Capture failures honestly.** If a run fails (e.g. the repo was renamed at fire time),
   confirm the occurrence is recorded `failed` with the reason, the schedule shows
   **attention**, and no doomed task was created. Do not paper over it by adjusting the clock;
   record what actually happened.

## Recording the receipt

When you have run steps 5 and 6 on a real machine, note the observed delays and the date in
the pull request or a follow-up, so "local catch-up" can be marked stable with evidence
rather than on the strength of the fake-clock suite alone.
