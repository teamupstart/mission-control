# P0. Product questions and telemetry data contract

Design contract. Parent: [OpenTelemetry planning brief](../plan.html). The operator approved both user-owned export and product analytics with separate opt-ins, deeper planning across all six areas, restart-safe local capture in v1 and scheduling through the [phased plan](../phased-plan.html). Its phase tasks own the implementation sequence and verification gates.

## Decision this area owns

Define the meaning, grain, identity, allowed attributes and audiences of every signal before instrumentation begins. The other five areas consume this contract. A signal is accepted into the catalog only when it has an analysis question, an authoritative owner, a clear denominator and a bounded payload.

Propose three priority levels: **core** for session/workflow outcomes, persona verdicts, recovery, execution attribution and errors; **breadth** for the remaining primary-action inventory; **diagnostic** for optional detailed timing. The first release is not “all actions covered” until the breadth inventory is complete, even if core insights become useful earlier.

## Questions, units and acceptance signals

| Question | Unit of analysis | Minimum required facts | Signal of useful coverage |
| --- | --- | --- | --- |
| What models and features are used? | Execution segment; successful logical action | Model/effort observation, task kind, feature, actor, origin, app version | Unknown attribution is reported; exposure is separate from use |
| Which workflows work efficiently? | Logical workflow run and review round | Start/end, immutable workflow version, elapsed state intervals, repair rounds | Parallel work is not added into fictitious wall time |
| Which personas send work back? | Executed review, finding, delivered repair packet | Verdict, execution disposition, reason, causal links | Invalid responses, skipped passes and actual work rejection stay separate |
| How often must people intervene? | Distinct run plus successful intervention | Explicit human provenance, action intent, cause, workflow start boundary | Recovery, required decisions and voluntary steering have separate rates |
| How does work end? | Session observation, work episode, task, repository PR | Termination observation, completion provenance, continuation links, PR visibility | Unknown outcome is never relabeled as failure or abandonment |
| Did an update improve things? | Comparable installation/task/workflow cohort | Event-time release, workflow/persona revision, model exposure, observation coverage | Late exports do not move old work into a new release cohort |

Installation-level identity supports repeat-use and within-installation comparisons. It does not measure unique people. No account lookup, cross-device identity join or fingerprinting is proposed.

## Four records with different jobs

| Record | Grain | Owner and lifespan |
| --- | --- | --- |
| Domain event | One accepted semantic fact | Minimized local capture; immutable, versioned, bounded retention |
| Context snapshot | One immutable execution/association context | Telemetry projection of existing owners; retained while referenced, then expires |
| Metric point | One instrument, dimension set, resource and collection interval | Deterministic projection of domain facts, or an explicitly separate live operational instrument |
| Trace span | One bounded operation | Correlated timing/outcome view; never the source of metric denominators |

The journal is not a new task/workflow history API. Existing managers remain authoritative. Metrics describe populations; traces explain individual operations. The same fact may contribute to both, but it contributes to each declared metric only once.

Proposed local envelope, with synthetic IDs and model names:

```json
{
  "schema_version": 1,
  "event_id": "evt-example-review-1",
  "name": "workflow.review.finished",
  "occurred_at": "2026-09-12T15:00:00.000Z",
  "observed_at": "2026-09-12T15:00:00.020Z",
  "resource_snapshot_id": "resource-example-v1",
  "context_snapshot_id": "context-example-segment-2",
  "actor": { "kind": "workflow", "origin": "daemon", "basis": "owner" },
  "refs": { "run": "run-example", "submission": "submission-example", "attempt": "attempt-example" },
  "facts": {
    "execution_disposition": "executed",
    "review_verdict": "fail",
    "response_validity": "valid",
    "reviewer_model_key": "catalogued-reviewer-model",
    "reason_categories": ["test_coverage"],
    "reason_provenance": "structured"
  }
}
```

This is a domain example, not an OTLP request. An event-specific schema rejects undeclared fields. Internal correlation identities are translated to destination-scoped identities before export. A serializer cannot spread an internal Session, Task, WorkflowEvent or exception object into this envelope.

## Identity and idempotency contract

- Capture dedupe uses a source kind plus an authoritative source identity and semantic revision, when one exists. A workflow attempt completion is not identified by arrival time or model output text.
- A logical user action has one operation ID across its network retries. Its HTTP attempts may be measured separately, but a successful replay cannot become a second intervention.
- A source record amended later emits a new fact or revision. It does not mutate an already delivered historical event. Retractions/late corrections need a separately versioned projection rule.
- Local sequence numbers order journal processing. They are not event time. Out-of-order source observations retain their timestamps and provenance.
- Destination event IDs are stable for retries within one audience/configuration epoch. Different audiences use different keys, so their identifiers are not trivially joinable.
- A collection reset creates a new telemetry identity epoch. Runtime task/session identity is untouched. Backlog policy must be resolved before old telemetry identities are destroyed.

Existing optional workflow event IDs demonstrate a useful dedupe seam, but some current events lack them. Coverage cannot be assumed globally. [Workflow event writer](../../../../src/server/workflows/store.ts).

## Actor and origin contract

Actor kinds: `human`, `agent`, `foreman`, `workflow`, `scheduler`, `recovery`, `unknown`. Origins: `dashboard`, `mcp`, `cli`, `daemon`, `external_observation`, `unknown`. Actor basis: `owner`, `app_context`, `declared`, `inferred`, `unknown`.

These fields describe attribution, not authorization. Existing permission decisions must not start trusting a telemetry field. A dashboard operation context provides application-level attribution, not cryptographic proof of a person. Existing `by`/`origin` flags on some routes can be retained as declared provenance until a stronger context is present. Unmarked API requests, direct terminal input and unclear external changes remain unknown. P4 owns the propagation design.

## Audience policies

| Data | Local capture | User-owned backend | Product analytics |
| --- | --- | --- | --- |
| App version, task kind, harness/runtime, bounded action/outcome | Yes, when collection enabled | Yes | Yes, with product opt-in |
| Catalogued model/effort and builtin workflow/persona identity | Yes | Yes | Yes |
| Session/run/attempt relationships | Opaque local correlation | Destination-scoped IDs on traces | Separately scoped IDs on approved outcome traces |
| Custom entity identity/revision | Opaque ID, no name or content | Opaque ID by default | `custom` category; opaque per-installation correlation only where needed for approved queries |
| Installation pseudonym | Local random seed | Separate destination identity if requested | Stable within the consent epoch, with reset support |
| Error detail | Bounded codes and sanitized app frames | Same default | Bounded code/category; no free-text detail by default |
| Prompt, code, path, branch, repository/PR URL, rationale, headers, terminal output | No new telemetry copy | No | No |

Keep all export schemas minimized. A later diagnostic mode is a new explicit scope, not a hidden switch to ship raw objects. Local capture must disclose that it can retain data before an endpoint is configured. Enabling product analytics authorizes new product data from that point, not automatic historical sharing.

## Metric catalog contract and cardinality

Each instrument declares name, description, unit, type, contribution event, exact predicate, dimension allowlist, histogram boundaries where applicable, unknown policy, audience, schema revision and owner. No caller invents metric names from an action string.

Suggested specialized views rather than one giant label set:

| Instrument | Proposed dimensions | Excluded dimensions |
| --- | --- | --- |
| `mission.persona.verdicts` | Persona family, reviewer model key, verdict | Author model, session ID, node ID, free-text reason |
| `mission.workflow.interventions` | Workflow family, action kind, intervention intent | Operation/run IDs, actor free text |
| `mission.workflow.completed_by_author` | Workflow family, task kind, author model, author effort | Reviewer matrix, individual persona |
| `mission.action.count` | Feature/action ID, outcome, actor class | Raw route, query string, all session metadata |
| `mission.errors` | Component, error family, handled state | Stack, message, fingerprint, individual entity IDs |

Cross-dimensional author/reviewer comparisons belong in traces or a supported analytical projection. Do not silently omit the user's desired joins and then claim metrics alone cover them.

The selected local Grafana/Prometheus deliverable in [P5](../p5-analysis-delivery/plan.html) also requires bounded analytical snapshot gauges for distinct-run recovery, horizon outcomes and repeat feature use. P5 defines reducer and panel requirements; Phase 6 implements reducers and Phase 7 implements panels. P0 owns their catalog entries, cohort definitions and dimension budgets. Keep window/horizon enums bounded, timestamp bounds as values, and individual run/operation IDs out of metric labels. Raw action counters do not substitute for these cohort summaries.

Illustrative cardinality, not a measurement: 12 persona families × 8 models × 2 verdicts = 192 active dimension combinations. Adding 8 author models × 6 efforts × 20 workflow revisions makes 184,320 combinations before resource identity. Histogram buckets and backend resource-to-label promotion add further series. P5 measures the real budget.

Candidate limits for design testing: 256 bytes per ordinary string, 16 KiB per canonical event, bounded 64 reference links and 16 reason categories, 32 catalogued model keys per profile, 2,000 active series per instrument and 10,000 per installation/profile. These are proposal limits to validate, not all safe defaults at once. Truncating links/categories carries omitted counts; exceeding a metric dimension budget folds into explicit overflow/other categories and never silently changes a denominator. Unknown values remain visible.

## Versioning and adoption

Maintain independent event schema, metric catalog, reason taxonomy and audience-policy versions. Additive fields are optional to old readers; persisted enum IDs remain append-only. A changed metric meaning gets a new instrument/version, not a retroactive relabeling. Queue records carry the schema/policy that created them; unknown future versions are quarantined or expired with visible counts, never interpreted optimistically.

Use a launch-date cutover watermark. Do not bulk export historical operational tables by default: they predate consent, lack complete context, and may contain private data. A future explicit import must preserve `historical_import` provenance and be excluded from live adoption counts by default.

## Acceptance examples and gates

1. Retrying one successful resubmit request produces one intervention, two HTTP attempts if measured, and one new semantic review round.
2. A valid failing review contributes one executed rejection; a malformed response followed by that review contributes one response error as a separate fact.
3. Product-only opt-in cannot produce a user-backend batch or include a private fixture string.
4. Changing an app default does not alter previously captured model/effort context.
5. An unknown terminal actor does not count as a confirmed human action or confirmed automation.
6. Core outcome metrics remain correct if diagnostic trace sampling is disabled or reduced.

P0 is sufficiently specified for the remaining draft designs. Implementation gates remain the final registry/limits review and proof that each proposed event has a source seam. Selected audience policy is confirmed; proposed field names, limits and identity lifetime are recommendations for review.
