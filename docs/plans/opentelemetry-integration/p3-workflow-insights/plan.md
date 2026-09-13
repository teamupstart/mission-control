# P3. Workflow stages, persona verdicts and interventions

Draft design recommendation. Parent: [planning brief](../plan.html). Contracts: [P0 events](../p0-data-contract/plan.html) and [P2 execution attribution](../p2-session-lifecycle/plan.html).

## Decision this area owns

Make every stage and repair loop measurable without changing the workflow engine's meaning. The analysis should identify costly waiting, repeated repair and avoidable human recovery while distinguishing a strict useful reviewer from a broken or overly demanding one.

## Grain and ownership

| Object | What one record means | Existing authority |
| --- | --- | --- |
| Workflow definition/version | One reusable process and one immutable graph | Workflow catalog/store |
| Binding | One association between process and work | Workflow manager/store |
| Run | One invocation of a pinned version | Run lifecycle decoder plus manager/store |
| Submission | One captured evidence context/round segment | Capture and submission store |
| Stage occurrence | One projected graph stage in a submission | Existing stage projection; not a new persisted graph |
| Node attempt | One engine attempt at one graph node | Attempt store |
| Model execution | One provider call, including invalid-response retries | Workflow LLM call observer/ledger |
| Review verdict | One completed executed semantic judgment | Attempt verdict and outgoing receipts |
| Repair packet | One feedback delivery toward the session | Delivery ledger |
| Intervention | One successful logical human action | Mutation owner with operation identity and actor context |

Run status is not a sufficient wait classifier. The existing `decodeWorkflowRunLifecycle` interprets status, phase and gate state together. `blocked` is not generally terminal, and `waiting_for_session` can mean agent repair rather than human waiting. Telemetry consumes that decoder; it must not introduce a second list of phase-string rules. [Lifecycle decoder](../../../../src/shared/workflow-lifecycle.ts).

## A review has four outcomes, not one

Proposed normalized vocabulary:

| Axis | Values | Counting rule |
| --- | --- | --- |
| Execution disposition | Executed, reused pass, disabled/bypassed, cancelled, infrastructure error | Only executed completed pass/fail reviews enter acceptance denominator |
| Response validity | Valid, parse failure, contract violation, unavailable | One per provider response/execution as applicable |
| Work verdict | Pass, fail, none | Fail is a successful review operation finding work to repair |
| Delivery outcome | Prepared, delivered, refused, uncertain, cancelled | Only delivered feedback contributes to confirmed send-back packet counts |

Current engine behavior already supports these distinctions: disabled nodes and compatible earlier passes can complete without a new call; reviewer resolution occurs after that skip decision; invalid/contract-violating responses can be retried before a verdict is stored. [Attempt execution](../../../../src/server/workflows/engine.ts).

Do not use the existing `persona_contract_outcome=accepted` as a work-approval event. It means the response passed its contract, even when its verdict is fail.

## Event set and canonical contribution rules

| Proposed event | Required correlation | Metric contribution |
| --- | --- | --- |
| `workflow.run.started` / `.finished` | Run, version, trigger, frozen context | One start and one authoritative terminal outcome per run |
| `workflow.wait.changed` | Run, prior/new decoded wait class, observation times | Close previous wait interval and open next; no click count |
| `workflow.node.started` / `.finished` | Submission, graph node, stage, attempt | Queued/execution duration and actual disposition |
| `workflow.review.response` | Attempt, provider execution ordinal | Validity/error count, not review acceptance |
| `workflow.review.finished` | Attempt, persona revision, author/reviewer contexts | One executed pass/fail if eligible |
| `workflow.review.skipped` | Attempt, reuse source or disable action | Saved executions and bypass/reuse counts, no executed verdict |
| `workflow.repair.delivery` | Delivery, contributing review attempts, run/round | One delivered packet after confirmed transition |
| `workflow.repair.pickup` / `.resubmitted` | Delivery/round and work-cycle or submission proof | Separate delivery-to-pickup and pickup-to-resubmission intervals |
| `workflow.intervention` | Logical operation, run, actor/basis, intent/cause | One successful human action; separate refused/failed operation facts |

Derive stable capture identity from the source grain, not just run ID. Multiple stage occurrences can use the same persona; node ID distinguishes them. A run may include several submission segments within one repair round, so round number alone is not a submission key.

The store's transactional verdict/receipt completion is the semantic boundary; the later advisory `persona_verdict` event alone is insufficient as an exactly-once hook. P1's capture design must account for that gap. Never attach a telemetry transaction that blindly nests the store's existing `BEGIN IMMEDIATE` transaction.

## Stage timing and traces

Within a bounded submission trace, stage spans group node spans; node spans group model/check calls. Parallel nodes have overlapping real timestamps. Later repair and resumption traces link to the causing attempts and stable run identity. Multi-day runs do not require a live multi-day root span.

Stage identity consists of immutable graph version plus the existing projection's occurrence/node membership. A label such as “stage 2” is display context, not a durable identity across graph versions. An unprojectable custom graph still gets node timing with `stage_projection=unavailable`; it must not disappear from telemetry.

Record ready/eligible time only if the owner actually observes it. If the queue entry's creation time precedes dependency readiness, it cannot stand in for ready time. Missing eligible timing is unknown.

| Duration | Boundaries | Important qualification |
| --- | --- | --- |
| Node queue wait | Eligible to execution start | Requires an actual eligibility observation |
| Node execution | Start to terminal attempt result | Provider retries may be nested; retained disposition explains failure |
| Stage wall time | Stage activation to barrier settlement | Includes overlap correctly; does not sum child durations |
| Feedback pickup delay | Confirmed delivery to proven agent pickup | Delivery uncertainty and absent pickup evidence stay separate |
| Repair cycle | Pickup to next accepted submission | Work may include user activity; do not label CPU or human effort |
| Human wait | Explicit human-blocking state entered to resolution | Not every blocked/waiting state is human-owned |
| External wait | Known PR/CI/review dependency wait interval | Separate from model execution and manual recovery |

Use monotonic elapsed time within a process when available, wall-clock boundaries for cross-process observations, and a time-quality field across restart/sleep. Do not silently subtract overnight gaps and call the result active work.

## General rejection reasons

Keep the existing finding basis as an orthogonal field: `substantive`, `coverage_registration`, `evidence_access`. It answers whether the finding is about the work, how proof was registered, or access to proof. It does not replace a general topic category. [Finding contract](../../../../src/shared/workflow.ts).

Proposed category vocabulary v1:

| Category | Example meaning | Exclusion |
| --- | --- | --- |
| `requirements` | Missing or incorrect requested behavior | Reviewer scope expansion belongs in later feedback analysis |
| `correctness` | Defect in behavior or failure handling | Provider/tool crash is infrastructure |
| `test_coverage` | Missing meaningful behavioral/regression test | Failure to attach existing test output is execution evidence |
| `execution_evidence` | Missing proof a relevant command/test ran | Not automatically a missing test |
| `visual_evidence` | Missing runtime/rendered evidence | Not a UI correctness finding by itself |
| `maintainability` | Unnecessary complexity or duplication | Not every style preference |
| `architecture` | Ownership or contract violation | Not an arbitrary reviewer preference |
| `security` | Concrete security issue | Keep details out of the export |
| `performance` | Resource/latency concern | Timing of the reviewer itself is not a finding |
| `documentation` | Missing or inconsistent required docs | No document names/text |
| `delivery` | Missing verified PR/delivery condition | External CI timeout remains infrastructure |
| `other` / `unknown` | Valid uncategorized finding / no reliable category | Preserve both rather than guessing |

Preferred source: a bounded optional category on each structured requested change, with schema version and backward-compatible unknown for older personas. Use explicit deterministic codes for evidence readiness and infrastructure. An inference fallback is permissible only as a separately versioned, measured classifier, with confidence/unknown support. No extra model call per rejection is proposed.

General category is advisory telemetry; a missing/invalid category must not by itself convert a historically valid review into a failure or retry. Prompt/schema changes belong in the existing persona source/generation path. Raw verdict text remains in its current local workflow store under existing policy; the new telemetry journal receives only normalized categories and counts.

## Human interventions and cause

Classify intent as `required_decision`, `recovery`, `optional_steering`, `termination`, or `unknown`. Keep cause separate from action:

| Action | Default interpretation when explicit evidence supports it |
| --- | --- |
| Resume/resubmit after agent completed repair but automation did not advance | Recovery; missing automatic progress |
| Retry provider/check/capture after known error | Recovery; infrastructure class from owner |
| Grant additional repair rounds | Recovery/budget expansion; reason is not automatically reviewer defect |
| Disable persona / override evidence readiness | Bypass; recovery or steering according to the actual blocked context |
| Set persona directive | Optional steering unless explicitly answering a recovery gate |
| Answer an authored human approval gate | Required decision |
| Restart entire workflow | Recovery or deliberate rerun; retain explicit cause/unknown |
| Cancel run | Termination, not successful recovery |

Automatic resumption, Foreman answers and workflow-generated messages never become human intervention counts merely because they use the same route. Browser retries with the same operation ID count once. The UI may record failed attempts separately to reveal friction.

Measure cause from decoded state and authoritative error/decision codes at action time. A later recovered state must not erase why the user intervened. Do not export rationale text or infer motivation from a button label alone.

## Worked example: two reviewers, one repair

Synthetic run R uses two reviewers in parallel. Reviewer A returns malformed output, retries, then fails for test coverage. Reviewer B passes. One combined feedback packet is delivered. The author repairs the work; automatic advance stalls and a human resubmits. In the next round, A executes and passes while B's previous pass is reused. R completes.

Expected contributions:

- Executed reviews: 3; passes: 2; fails: 1. Executed rejection rate: 1/3.
- Provider executions: 4. Invalid response count: 1. Reused-pass count: 1.
- Delivered repair packets: 1. Repair rounds: 1. Successful recovery interventions: 1.
- Runs with human recovery: 1. Human-free completions: 0 for this run.
- Test-coverage findings: the actual number on A's fail verdict, not the number of deliveries/retries.
- Stage wall time: the measured parallel interval in each round, not A's duration plus B's.

This example becomes one shared golden fixture for P1 replay, P3 contribution logic and P5 queries. If a design produces different totals, resolve the contract before implementation.

## Review usefulness and fairness

Always present rejection rate with review volume, task/workflow cohort, next-executed-review resolution, bypass/directive incidence, wait burden and unknown-category share. A high rejection rate may reflect difficult work, useful rigor or poor instructions. It is not enough to rank personas by quality.

Track repeated categories by run as a burden signal. Identifying the same underlying defect across rounds requires a separate finding-identity design; hashes of titles or raw rationale do not reliably establish it. Explicit user feedback such as “not relevant” would be a future product feature, not inferred ground truth.

## Acceptance and remaining gates

Required focused scenarios: golden example; disabled node before claim; disable after start; changed directive preventing reuse; explicit recheck superseding a previous pass; result arriving after cancellation; interrupted provider execution; multiple personas in one packet; delivery uncertainty then resolution; same persona appearing twice; unprojectable custom graph; multi-segment round; PR-only repair; missing actor provenance.

This area adds no new lifecycle authority or execution branch. Implementation gates are the category schema compatibility decision, eligibility/pickup observation coverage, and the complete action-to-cause mapping reviewed against the owners.
