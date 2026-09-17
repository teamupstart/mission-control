# Bounded analytical telemetry

Phase 6 exports exact populations over accepted telemetry facts through the normal durable
OTLP outbox. It does not query operational task history, complete tasks, release dependencies,
or require Grafana or a warehouse. Enable collection and a destination as described in
[Observability](observability.md). Dashboards and broad feature instrumentation belong to
Phases 7 and 5 respectively.

The instrument contract is `mission.analytics.v1.<view>.<field>`, registered in
[`src/shared/telemetry-projections/index.ts`](../src/shared/telemetry-projections/index.ts).
These are **gauges**, including counts. Do not use `rate()` or `increase()` on them. Ordinary
source counters remain the event-time activity view and are not an exact cohort census.

## Time and population contract

At calculation time T, run and task starts qualify in `[T - 14 days, T - 7 days)`. Outcomes,
actions, reviews and attributed usage qualify from each start through its start plus seven
days, including that final instant. The declared `window="7d"` and `horizon="7d"` are bounded
enums, not user-selected durations. Recent runs are `immature`; observed runs without a start
are `left_censored`, excluded from the eligible denominator. A missing terminal fact is
`pending`, not success or failure.

Repeat use compares `[T - 14 days, T - 7 days)` with `[T - 7 days, T)`. Quality covers the whole
14-day observation interval. PR `merged` and task `with_merged_pr` also include positively
observed merges through T for the same task-start cohort; the separately named
`merged_within_horizon` and `with_merged_pr_within_horizon` retain the seven-day outcome boundary.
A late merge does not turn an unknown task outcome into a completed task.

| View | Grain and numerator | Denominator and important exclusions |
| --- | --- | --- |
| `runs` | One observed workflow run; outcome at horizon, human actions and distinct confirmed recovery operations | `eligible` for completion and `with_recovery`; `automation_eligible` for known `human_free` completions. Pending and cancelled runs stay in the population. |
| `reviews` | One executed semantic review attempt; `pass`, `fail`, `first_pass`, `resolved` | Rejection uses `fail / executed`; first pass uses `first_pass / first`; repair resolution uses `resolved / failed_with_next`. `no_next` is coverage, never a resolved review. |
| `reasons` | General finding categories attached to qualifying executed attempts | `findings` counts findings, `reviews` counts distinct reviews with findings. Category review counts overlap when a review has several categories; do not add them to derive distinct reviews. |
| `tasks` | One task's first observed launched dispatch or observed session start; recorded outcome at horizon | `eligible` includes unfinished work. A failed departure with missing completion evidence is `unknown`, not proven failure. Multiple repositories do not multiply tasks. |
| `prs` | One actual repository/PR identity associated with a qualifying task | `associated` is the observed PR population. Creation requires `creation_verified`; an existing association is separate. This is not a denominator of all PR-eligible tasks. |
| `features` | One installation/consent epoch, plus separate feature slices | `first_period`, `second_period`, `repeat_eligible`, `repeated` are 0/1 indicators. Repeat eligibility requires successful first-period use and continuous observation across both periods. |
| `usage` | Canonical usage contributions for qualifying tasks within their outcome horizon | `qualifying_outcomes` is recorded completed tasks in the same cohort. Cost includes unfinished work. Every work-role and cost-basis slice repeats this same outcome denominator, so its ratio is that slice's contribution per outcome. |
| `quality` | Retained observations in the 14-day interval | Known model/effort shares use `model_observations`/`effort_observations`. `unknown_actor` includes facts for which an actor is unknown, not a count of human interventions. |

`recovery_operations` deduplicates operation identity. Only an applied recovery with
`coverage=owner_result` and a human actor established by the owner or application context
qualifies. Required decisions, steering, termination, refusals and declared/unknown actors
cannot become successful human recovery. All observed human actions can disqualify a run from
`human_free`, including session controls linked through its session. Human-free means no
observed human action through Mission Control's instrumented controls; terminal typing and
activity outside the application are not observed.

Automation eligibility is frozen at run creation using the application's existing resumption
predicate. Preview delivery or manual resumption is a designed `human_gate`. Old source facts
without eligibility remain `eligibility_unknown`. Unknown actors, missing join context, capture
gaps, state rejection, or observation beginning after a run started prevent a known human-free
claim. `mixed_author` means at least two known author models at submission; known plus unknown
stays unknown. Reviewer attribution always comes from the execution, not the author.

Invalid responses, reused passes and delivered repair packets have separate counts and never
enter `executed`. First and next reviews are ordered by execution fact time within run/node.
Equal timestamps that make first/next order ambiguous increment `ordering_unknown`, mark the
view incomplete, and do not invent a successful resolution. Packets have unknown reviewer
context because a packet may combine several reviewers.

## Gaps are part of the result

- **PR production:** the current sources prove positive creation/association/merge facts but
  do not declare a task's PR requirement or adequate negative observation of every repository.
  `pr_eligible` is reserved at zero, and diff-producing tasks increment
  `pr_visibility_unknown` with `complete=0`. Display verified positives and unknown coverage;
  do not divide `with_new_pr` by `eligible` or the reserved zero to claim a PR-production rate.
- **Abandonment:** `early_exit` records an open-work departure, excluding shutdown/handoff.
  After seven days, no observed continuation, recorded completion or merge can produce
  `abandonment_candidate`. It always marks the task view incomplete. It is evidence for
  investigation, not proof that work was abandoned. A late continuation or merge revises it.
- **Usage:** `usage_missing` and `usage_unfinished` are task counts. Unattributed usage rows,
  unpriced rows and tasks without usage make cost coverage incomplete. `cost` sums priced
  contributions only, split into `reported` and `api-equivalent`; neither is subscription
  billing. Token components preserve the canonical ledger's meanings.
- **Feature observation:** only features declared by the standard action schema can appear.
  On this base those are workflow and persona. Reserved features without facts emit
  `observed=0, complete=0`; Phase 5 can supply callers independently. Operations are distinct
  IDs; an operation that failed then succeeded counts once in `operations` and in both
  outcome subsets. `affected_installation` is 0/1, not a unique-person count.
- **First use:** `first_observed_at` for features retains the first accepted successful use in
  this consent epoch, even after its supporting detailed facts expire. It is not first-ever
  use. Zero means no qualifying observation. For other views it is the first qualifying
  observation in the current population, or zero where that view has no such timestamp.
- **Continuity:** completeness requires an observed full interval, a drained accepted journal,
  no relevant recorded loss and no omitted joining context. Recorded gaps are conservatively
  shared across audiences. This cannot prove absence of failures before durable capture;
  the capture boundary and unknown-gap detector retain their Phase 1 limitations.

## Dimensions and comparison rules

All views carry `audience`, `window`, `horizon`, `slice_by`, `slice`. Always select one audience
and exactly one slice axis. The `slice_by="all", slice="all"` row is a whole population,
not an additional category to sum with the slices.

| View | Supported axes in addition to `all` |
| --- | --- |
| runs | workflow, author_model, author_effort, app_version |
| reviews | reviewer_model, reviewer_effort, app_version |
| tasks | task_kind, app_version |
| features | feature |
| reasons | category |
| usage | work_role, cost_basis |
| prs, quality | none |

Axes are independent marginal views, not a cross-product. There is no persona, workflow
revision or arbitrary joint filter in v1. A dashboard must state where a filter does not apply.
Models use the shared catalog with `other`, `unknown` and `unsupported` categories; workflow
families are builtin/custom/unknown. A bounded `overflow:__overflow__` slice is incomplete and
must not be treated as a particular model or version. Overflow can combine several axes, so
it is diagnostic only, not an additive denominator for any one axis.

The app-version slice uses the immutable resource on the start (runs/tasks) or execution
(reviews), so replay by a newer binary does not rewrite attribution. OTLP `service.version`
identifies the binary producing the calculation. These have different meanings. Original
source events, resources, times and trace context stay immutable; cohort gauges contain no
run/task/session/PR IDs. Use source traces and their audience-scoped `mission.ref.*` attributes
for drill-down, filtered by time, environment and installation. Sampled/missing traces never
change the metric denominator.

## Receiver names and coherent queries

The pinned reference Collector/Prometheus path translates:

| OTLP instrument | Prometheus name |
| --- | --- |
| mission.analytics.v1.runs.eligible | mission_analytics_v1_runs_eligible |
| mission.analytics.v1.runs.calculated_at | mission_analytics_v1_runs_calculated_at_seconds |
| mission.analytics.v1.runs.complete | mission_analytics_v1_runs_complete_ratio |
| mission.analytics.v1.usage.cost | mission_analytics_v1_usage_cost_USD |

Each view emits every declared field, including real zeros, plus `calculated_at`,
`window_start`, `window_end`, `horizon`, `complete`, `expected_points`, `first_observed_at`,
and `consent_epoch`. Times/durations are seconds as values, never timestamp labels.
Every point has the same sample timestamp as `calculated_at`.

Use the shared query builders in
[`queries.ts`](../src/shared/telemetry-projections/queries.ts), verified against the real
receiver. `analyticalValueQuery(view, field, labels)` retrieves the most recent point within
two hours. `analyticalCoherenceQuery(view, labels)` requires every declared point, matching
calculation timestamps, matching expected point count, and age in `[0, 2 hours)`. It also
selects the newest calculation when an app upgrade leaves overlapping `service_version`
series for one installation. Never prefilter that guard to an old producer version. Labels
are trusted dashboard selectors, not arbitrary user input.

For example, with a selector including `audience="user"`, environment, installation scope,
`window="7d",horizon="7d",slice_by="all",slice="all"`:

```ts
const numerator = analyticalValueQuery("runs", "with_recovery", labels);
const denominator = analyticalValueQuery("runs", "eligible", labels);
const guard = analyticalCoherenceQuery("runs", labels);
const observedRecovery = `(${numerator} / ${denominator}) and (${denominator} > 0) and (${guard})`;
```

`complete` is separate from coherence. A coherent incomplete snapshot still shows observed
counts and explicit gaps, such as the oracle's ambiguous R6. Label a ratio from it as observed
and incomplete, or additionally require `complete == 1` for a complete-only panel. A zero
denominator renders no eligible observations; missing guard renders absent/stale/partial, never
zero. Never use `or vector(0)` to disguise missing data. For multi-installation summaries,
apply the guard and coverage policy separately to numerator and denominator before summing.
Keep missing producer counts visible. Installation-weighted results require per-installation
ratios; event-weighted results divide population sums.

The coherence guard uses a 30-second subquery grid, which may withhold a newly delivered
snapshot briefly. Timestamp is evaluated on each raw field selector before adding its field
label: doing it after `label_replace` would inspect query evaluation time instead of the
stored point. The two-hour range survives Prometheus's default five-minute instant lookback
without presenting a stopped producer indefinitely as current.

## Durability, bounds and integration adaptations

The existing atomic transaction commits minimal reducer state, checkpoint, series and immutable
outbox batches together. Restart/replay cannot increment gauges again. Snapshots wait for the
whole accepted journal prefix; the intermediate page of a large replay never exports a partial
calculation. State v1 resets via the engine's unsupported-schema gap if it cannot migrate.
Changed metric meaning requires a new namespace/version, not relabeling historical output.

Each profile retains at most 4,096 compact normalized facts for 30 days, below the engine's
8 MiB per-state limit and shared 256 MiB budget. Join IDs are hashes; raw envelopes, text,
paths, URLs and findings are not retained here. At most 24 slices per view plus all/overflow
are remembered so departed populations emit zeros. Bounded first-use timestamps and slice
vocabulary last until consent/identity reset. A quota rejection or out-of-retention/future fact
marks the following 14-day observation coverage incomplete; ordinary 30-day expiry cannot
remove facts needed by the current 14-day cohort. Seven-day unsent-payload retention remains
separate. Existing per-instrument/profile series limits still apply.

Changed state refreshes no more often than every 30 seconds; quiet producers refresh hourly
so cohorts mature, expire and publish zeros without invented source events. No source actions
are emitted by the reducer. Local, user and product state remain isolated; a new opt-in starts
at the journal head with its own timestamp and cannot inherit another audience's history.

The proposed guide assumed common interfaces that this base did not yet expose. This phase
makes small additive adaptations, which reviewers should retain in the PR rationale:

1. Optional idle snapshots, consent-time initialization, caught-up/gap context and immutable
   event resources were added to the existing projection seam. They are needed for truthful
   expiry, cohort coverage and app-version attribution; existing projectors keep their behavior.
2. The workflow telemetry source adds an optional, default-unknown automation eligibility fact,
   frozen from its existing resumption predicate at creation. Without this observation an
   authored human gate cannot be separated safely. No workflow behavior or DB migration changes.
3. PR-production eligibility and final abandonment remain explicitly unavailable, as described
   above, rather than inventing source facts or changing task ownership. Broad Phase 5 hooks,
   Grafana panels, public hosting and arbitrary retrospective joins remain outside this phase.

## Verification and Phase 7 handoff

The shared schema-valid six-run fixture yields eight executed reviews (six pass, two fail),
four completed runs, one pending, one cancelled, one run with confirmed recovery, five
automation-eligible runs and only R2 known human-free. R6 is ambiguous. Focused tests also
consume the real Phase 4 fake-agent repair fixture and Phase 3 retained PR observation after
ownership invalidation, including restart and a merge after the outcome horizon. Neither
late facts nor replay change operational task status or restore ownership.

Run the focused tests with the root `AGENTS.md` test-runner contract:

```sh
node --test --test-concurrency=4 --import ./test/setup-state.mjs --import tsx test/telemetry-*.test.ts
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run observability:up
node --test --import ./test/setup-state.mjs --import tsx test/telemetry-analytics-stack.integration.ts
```

The real-stack test checks immutable outbox replay, receiver name translation, identical
calculation metadata, rejected partial snapshots, recovered full snapshots, quiet/stale
producers and overlapping app versions. It uses an isolated synthetic installation with
environment `test`; it does not reset the receiver. Phase 7 can reuse the catalog, query
builders and golden fixture. Its release still requires both Phase 5 and Phase 6 to merge.
