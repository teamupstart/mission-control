# P4. Primary actions, errors and telemetry settings

Draft design recommendation. Parent: [planning brief](../plan.html). Depends on [P0 contract](../p0-data-contract/plan.html), [P1 durable export](../p1-durable-export/plan.html) and [P3 interventions](../p3-workflow-insights/plan.html).

Confirmed: user-backend and product sharing have separate opt-ins; accepted core telemetry survives restarts. This area defines how those behaviors appear in the app and how actions are measured across dashboard, MCP, worker and terminal paths.

## Decision this area owns

Capture user intent where it is observable, record authoritative results once, and make collection/export understandable and controllable. Route timing alone cannot say whether a user successfully used a feature; browser click counts alone cannot say whether the requested work happened.

## One logical action through several layers

Proposed flow:

```text
Dashboard gesture -> app-issued operation context -> existing action API
Agent/MCP/worker action -> caller/owner context -> existing action API
  -> authoritative owner outcome -> canonical telemetry -> durable profiles

Dashboard-only feature entry / error -> bounded typed telemetry ingress
  -> validation and minimization -> canonical telemetry

Profile state and export health -> API snapshot / SSE -> Settings
```

Use one operation ID across a logical request's retries. Record `requested`, `refused`, `failed`, `cancelled`, `completed` or `pending` according to the operation's real lifecycle. A 200 response acknowledging queued work is not completion. Existing operations that already carry request IDs retain them; do not add a competing idempotency system.

The browser can report a gesture/feature entry, while the server records the result. These are related facts, not duplicate success counters. An idempotent replay contributes no second successful action; optional HTTP-attempt metrics can still describe transport retries.

The existing workflow routes already return idempotency results for resubmit/retry and repair-round grants. The shared browser API module is a useful origin/correlation seam, but it cannot infer all feature semantics from URLs. [Workflow routes](../../../../src/server/routes.ts), [browser API](../../../../src/web/lib/api.ts).

## Primary-action coverage inventory

This inventory is the starting acceptance map. During implementation, enumerate exported browser API actions, relevant MCP methods and owner entry points against these rows. Each primary operation receives a catalog entry or an explicit exclusion; an unreviewed operation cannot disappear behind “etc.”

| Feature group | Semantic actions to cover | Result owner / special rule |
| --- | --- | --- |
| Setup and integrations | Detection, configure, connect, disconnect, installation requested/result | Setup/integration owner; installed is separate from used |
| Task intake and backlog | Create, import, edit, prioritize, reorder, assign, retry, cancel | Task/source owner; no title, issue text or search query |
| Dispatch | Request, preparation, launch, readiness, failure, dependency refusal | Dispatcher; scheduled/automatic dispatch is not human adoption |
| Conversation | Send, queue, edit/cancel pending message, interrupt, respond to question | Delivery/driver owner; no message contents |
| Session management | Resume, takeover/handoff, kill, rename, archive/reclaim where available | Existing session/task owners; rename value excluded |
| Model and effort | Configure defaults, select model/effort, accepted/rejected/pending/applied | P2 distinguishes requested from effective |
| Permissions and attention | Permission answer, explicit approval, dismiss, Foreman invite/withdraw | Actor and decision intent required |
| Workflows | Bind, unbind, start, resubmit, retry, cancel, restart, grant rounds | Workflow owner; source operation ID determines uniqueness |
| Persona control | Disable/enable node, edit directive, override readiness, recheck | Mutation result and blocked context at action time |
| Runs inspection | Enter run detail, open stage/attempt/evidence, filter | Browser-only navigation; one entry event per actual transition |
| Files and Diff | Open meaningful view, preview, save, compare, comment, resolve comment | UI entry plus authoritative mutation result; paths/content excluded |
| Library | Create/edit/publish/clone/import/archive workflow/persona/action/command | Catalog owner; IDs classified builtin/custom, no prose |
| Search and command navigation | Open, execute selection, no-results, dismiss | Counts/category only; no query or result text |
| Queues and schedules | Configure, enable/disable, enqueue/dequeue, dispatch occurrence | Queue/scheduler owner; config change separate from occurrence |
| Ensembles | Create, candidate results, evaluate, human decision, apply/cancel, workflow handoff | Ensemble generic stage/driver owners; avoid strategy-name branches |
| Pipelines | Start/adopt, stage observation, action, recovery, completion | Provider-owned normalized records; unknown external actions remain unknown |
| Foreman and away mode | Configure/invite, automated answer, handoff, completion claim, user correction | Explicit automation role and outcome |
| Shipping and Inspector | PR action, verification, review observation, repair, merge/close observation | Verified per-repository source; no URL or comment body |
| Archives and reports | Open, restore/export where supported, cleanup | Existing owner; document content excluded |
| Settings and help | Enter section, save/reset, restore settings, help/tour meaningful completion | Section/action IDs, no arbitrary setting values |
| Telemetry | Configure profile, enable/disable, pause, retry, purge, test connection | Self-diagnostics bounded; exporting does not create recursive action telemetry |

Every row distinguishes feature exposure, meaningful entry, attempted use and successful use. Repeated renders, background refreshes, SSE replay, heartbeat traffic, cursor movement and every keystroke are excluded. Active use may include a bounded foreground visit; it must not be implemented as a continuous input stream.

## Actor attribution without changing authorization

Propose an operation context carrying ID, initiating surface, declared actor, provenance basis and causal parent. Server-owned automation stamps its actor at the owner. Browser action code stamps the app context. MCP identifies the agent entry surface; it does not make all subsequent responses agent-authored, because a human may resolve the request in the dashboard later.

Existing `by`/`origin` fields on several routes already separate human, Foreman and workflow behavior. These are not uniform across all operations. Preserve them as declared attribution where appropriate; unknown or conflicting provenance remains unknown. Do not retrofit an authorization decision to trust new telemetry metadata. [Action/Foreman boundary](../../../../src/server/routes.ts).

Direct terminal keystrokes are outside this action pipeline. Hooks/driver/transcript observations may establish a turn or model change, but may not establish who initiated it. Report that limitation in manual-intervention coverage. Do not infer a human merely because a new user-role transcript message appeared; automation also sends messages.

## Browser-only signal ingress

Propose one small typed ingress for feature navigation, abandoned UI operations and renderer errors, using existing daemon authentication/origin protections. Proposed request contains schema version, client instance, event/operation IDs, event type, bounded event time and event-specific allowed fields. It never accepts an arbitrary attribute dictionary.

Candidate budgets: 64 KiB per ingress batch, 32 events per batch, and a short bounded in-memory browser buffer with per-client rate limits. The receiver validates IDs/types and applies its own clock/size checks. These are proposed values to verify against actual payloads. Reject unsupported fields/types with a bounded result, never echo private payloads in an error.

No browser persistence is required initially. A gesture lost before daemon acceptance is outside the restart-safe guarantee; an accepted event is persisted by P1. Show this honestly in coverage. The browser must remain usable while telemetry ingress is disconnected and must not replay navigation events on every SSE reconnect or React mount.

An ingress acknowledgement may report an event as accepted only after its durable commit. “Saved locally” in status has the same meaning; an in-memory staging buffer is not saved. Telemetry refusal/loss does not change a separately successful application action into a failure.

## Error taxonomy and deduplication

| Error family | Examples | Measurement |
| --- | --- | --- |
| `validation` / `policy_refusal` | Invalid input, stale request, denied capability | Expected operation refusal; separate from unexpected application error |
| `provider` | Auth, quota, throttle, timeout, unavailable model | Bounded provider code, retryability, role, actual model context if known |
| `execution` | Check/command process failure, malformed persona response | Attempt state and stable class; not an executed work rejection |
| `workflow` | Capture/delivery/engine error, unreadable state | Correlated run/attempt, decoded state and source code |
| `storage` / `filesystem` | Failed persistence or artifact access | Operation failure; no path or SQL text |
| `transport` | Daemon/API disconnect, lost SSE connection | User-visible interruption and recovery duration |
| `renderer` | Unhandled UI error or rejected action promise | App build, bounded app-frame fingerprint and operation link |
| `process` | Daemon/worker/driver crash or failed restoration | Observed termination/recovery, not an invented exception |
| `export` | Telemetry endpoint/replay failure | Dedicated bounded self-health path |

Assign a shared error occurrence ID when the same failure crosses layers. Record one authoritative error occurrence plus propagation observations if needed. Do not count the same provider failure at runner, workflow manager, route and browser as four distinct incidents. Independent retries are separate executions, linked to the same logical operation.

Default error payload: timestamp, component, operation kind, stable code/family, handled/unhandled, retryability, occurrence identity and allowed context. An optional fingerprint uses sanitized application frames and bounded type codes, not hashes of raw messages that contain private paths/text. Export raw stack/message details only under a future separately designed diagnostic policy.

Expected work rejection is a domain result, not an exception. Refused permission is not a crash. Preserve normal failure semantics: telemetry observation must not catch-and-continue an unhandled fatal error or prevent process exit. A dead daemon cannot reliably report its own death; the supervisor/next startup can report an interrupted boot with unknown cause. Native crash dumps and core files are out of scope.

Standalone errors can be represented by short error spans linked to an operation when available. Keep the payload compatible with a future OTLP log projection, but metrics and traces remain the v1 requirement. Use a bounded repetition rate and suppressed-occurrence counts for a renderer error loop so telemetry cannot amplify a failure.

## Settings experience

Propose a Telemetry section with three explicit controls: local capture, user-owned export, and product analytics sharing. Explain the relationships in ordinary language: local capture can work offline; each export destination is optional; sharing one profile does not enable the other.

| UI state | What the person sees | Behavior |
| --- | --- | --- |
| Off | Collection off; no pending export | No new telemetry capture or export |
| Local capture only | Saved locally; storage use and oldest record | Records survive restart up to configured limits |
| Export configured and healthy | Destination summary, last accepted export, queued size/age | Background drain under P1 budget |
| Temporarily offline | Retaining locally; last success and retry state | Automatic bounded retry; no repeated modal |
| Paused | Export paused; capture policy shown | Buffer within limit, do not send |
| Configuration/auth problem | Actionable bounded explanation | Pause affected destination; other profile continues |
| Storage/retention loss | Records expired/dropped and coverage gap | Explain limit; never present queue-empty as complete delivery |

User-backend configuration: endpoint, signal availability, credential reference and necessary TLS/proxy settings. Require HTTPS for credential-bearing non-loopback exports; support local loopback HTTP Collectors and prefer HTTPS for other remote exports. Validate the rule in the daemon as well as the form, and never disable TLS verification globally. Secrets are write-only in the UI after save; status reports only that a credential is configured. Redirects must not forward credentials to a changed destination.

“Test connection” sends a clearly identified synthetic diagnostic payload after configuration, not live buffered history. A successful test establishes endpoint acceptance, not that the user's dashboard has indexed the data. Product endpoint details and enrollment are a separate service contract; no secret embedded in the distributed app can serve as private service authentication.

Proposed API operations, subject to the existing route/schema review: read configuration/status; update profile configuration with revision check; set collection/export state; test connection; retry bounded drain; purge unsent profile data; reset telemetry identity. Keep secrets out of status and ordinary settings backup payloads. Classify consent, identities, queue state and endpoint generations explicitly in the existing configuration registry. A restored settings snapshot cannot silently opt in another installation. [Configuration classification](../../../../src/shared/app-config-entries.ts).

Queue health uses an initial API snapshot and bounded SSE updates. Add the exhaustive shared event/client handling and comparison rules only where the current architecture requires it. Do not add browser polling or ship every queued record through the SSE snapshot.

## Important user flows

1. Enable local capture while offline, perform an action, restart the app, and see retained data with no endpoint configured.
2. Configure a personal endpoint and choose whether compatible local history should be sent. Product sharing remains off.
3. Enable product analytics separately. Explain its minimized fields and that new sharing starts now; prior local activity is not silently uploaded.
4. Pause one destination while the other continues. Show separate lag and a combined storage budget.
5. Change endpoint. Keep pending data pinned to the old generation until the user chooses keep, discard or a permitted transfer.
6. Withdraw product consent. Stop new sends, purge unsent product data and explain that already accepted remote data is not recalled by a local purge.
7. Purge or reset identity using the app's ordinary explicit destructive-action affordance. Do not delete sessions, tasks, usage or workflow history.

## Verification and unresolved details

Every new or changed visible behavior needs Playwright coverage: consent independence, local-only restart, status updates, connection test, pause/retry, purge, endpoint change, disabled operation, secret masking and offline interaction. Tests select by role/label and fake every agent. New modals use the existing inset helper. See [E2E guide](../../../../e2e/README.md).

Focused contract tests cover field allowlists, malicious/oversized ingress, repeated error suppression, operation replay, unknown actors, settings restore and privacy sentinels in every destination. Runtime tests verify failed telemetry never blocks the real action.

Implementation gates: complete the owner/action manifest, choose credential storage consistent with daemon-only and packaged modes, define exact settings defaults/limits, and verify the bounded SSE schema. The policy and interaction semantics are specified here; final UI layout and all endpoint paths remain reviewable implementation design.
