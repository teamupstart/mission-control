# Focused test run: role-attributed automation usage

The end-to-end claim this change makes is narrow and specific: a headless spend report is
accepted through `/api/usage/automation`, recorded under its synthetic ROLE key rather than
a session, and read back per role. An aggregate "N pass" says nothing about whether that
path was exercised, so this is the focused run, verbatim.

```
$ node --test --test-concurrency=2 --import tsx \
    test/automation-usage-http.test.ts test/automation-usage.test.ts
```

```
[spend] cannot record foreman:review usage from unknown runner some-future-runner
✔ a recordable report is acknowledged and refreshes the strip (61.880583ms)
✔ a runner this daemon cannot value is REFUSED, not acknowledged (1.589125ms)
✔ a report with no usage at all is acknowledged rather than refused (0.480834ms)
✔ a malformed body is rejected at the boundary (0.681625ms)
[spend] cannot record foreman:review usage from unknown runner some-future-runner
✔ a headless run lands under its role and reads back per role (2.112916ms)
✔ role spend stays out of the fleet's session figures (0.389166ms)
✔ a role key is never mistaken for a card (0.125833ms)
✔ a retried report records the run once (0.624ms)
✔ an unpriced model refuses to report a subtotal as a total (0.570125ms)
✔ a claude run's OTel twin leaves the session total with it (0.53525ms)
✔ a report is priced by its own runner before it is written (0.394417ms)
✔ a claude report keeps the cost the provider itself calculated (0.218583ms)
✔ a run that spent nothing is not recorded at all (0.322834ms)
✔ a run with no id is dropped rather than recorded unattributably (0.136375ms)
✔ a runner this build cannot value is refused, not silently accepted (0.633792ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1016.83875
```

## What each case proves

`automation-usage-http.test.ts` drives the real Hono route:

- **a recordable report is acknowledged and refreshes the strip** - the POST is accepted (204)
  and the fleet strip is recomputed, which is the path a live Foreman worker takes.
- **a runner this daemon cannot value is REFUSED, not acknowledged** - 422 rather than 204, so
  the worker keeps its durable copy instead of deleting spend that never reached the ledger.
- **a report with no usage at all is acknowledged rather than refused** - the other half: a
  zero-token run has nothing to lose, so holding it would be a recovery with nothing to recover.
- **a malformed body is rejected at the boundary** - the schema is the first gate.

`automation-usage.test.ts` drives the ledger itself:

- **a headless run lands under its role and reads back per role** - the headline claim. Two runs
  are recorded and read back grouped by `inspector:review` and `foreman:review` with their own
  cost, tokens and distinct-run counts.
- **role spend stays out of the fleet's session figures** - the separate-line decision, asserted
  in both directions: a card's spend still counts, and it does not leak into automation.
- **a role key is never mistaken for a card** - `sessionCostFor("foreman:review")` is null.
- **a retried report records the run once** - the run id is the dedup identity, so a worker
  retrying a POST it never saw the response to cannot double-count.
- **a claude run's OTel twin leaves the session total with it** - the pre-existing double count
  this change also fixes.
- **a report is priced by its own runner before it is written** - the real Standard API snapshot,
  including its long-context multiplier, rather than a rate reimplemented in the test.
