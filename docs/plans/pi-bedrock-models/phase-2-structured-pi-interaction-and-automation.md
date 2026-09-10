# Phase 2: Structured Pi interaction and automation

## Outcome

Managed Pi sessions resolve project trust safely, project extension UI questions into Mission
Control, and participate in Work Queue automation with deterministic completion and pull-request
provenance. No Pi extension promise can hang after its session is stopped or replaced, and terminal Pi
remains excluded from SDK-only automation.

## Entry criteria and direct dependencies

- Direct dependency: the Phase 1 backlog task is completed and its pull request is merged.
- Phase 1's adapter, injected SDK boundary, event normalization, restart restore, clear replacement,
  stop/dispose, and terminal handoff contracts are green on the default branch.
- Pi advertises the SDK runtime but still declares `workQueue: null`.
- Project-local executable resources remain excluded unless already durably trusted.

## Scope

- Resolve Pi's project trust through a fail-closed, user-visible managed-session flow.
- Implement the Pi SDK `ExtensionUIContext` bridge for `select`, `confirm`, `input`, `editor`, and
  bounded notifications/status diagnostics.
- Correlate every blocking prompt with the existing SDK question/answer protocol and settle it exactly
  once on answer, timeout, replacement, or stop.
- Enable the existing Work Queue contract for Pi's managed runtime after its eligibility signals are
  proven.
- Normalize reliable pull-request creation provenance from observed Pi tool completion.
- Complete product, architecture, and supersession documentation.

## Non-goals

- Work Queue or structured UI for terminal Pi.
- A generic renderer for extension widgets, headers, footers, themes, custom TUI components,
  keybindings, raw terminal input, or editor paste state.
- Pi MCP client support, Mission MCP-required task kinds, permission modes, or multi-repository
  dispatch.
- Automatic AWS login, SSO refresh, credential storage, or Bedrock model curation.
- A second question store, queue runner, lifecycle owner, or PR detection path.

## Findings and contracts

### Pi UI host surface

Pi's public `ExtensionUIContext` includes `select`, `confirm`, `input`, `editor`, `notify`, status and
working indicators, widgets, header/footer/title, raw terminal input, and custom TUI components.
Mission Control needs only the blocking value-returning methods for behavioral correctness.

Implement one dashboard UI context and bind it through the SDK session's public extension binding.
The bridge maps:

| Pi method | Mission Control projection | Cancellation value |
| --- | --- | --- |
| `select(title, options, opts)` | Single-choice SDK question with ordered options | `undefined` |
| `confirm(title, message, opts)` | Yes/no SDK question | `false` |
| `input(title, placeholder, opts)` | Single-line free-text SDK question | `undefined` |
| `editor(title, prefill)` | Multi-line free-text SDK question preserving initial text | `undefined` |
| `notify(message, type)` | Bounded activity/system message; never blocking | None |
| status/working setters | Optional bounded activity projection, last-write-wins | None |

For unsupported presentation methods, return a stable no-op or documented cancellation only where Pi's
interface permits it. A method that returns a value must never remain pending. Raw terminal input and
custom components are unsupported in SDK mode and must report a diagnostic if an extension requires
them.

### Question ownership and teardown

Use the existing SDK question event and answer route. Do not persist a second Pi-specific question.
The adapter owns only the in-memory resolver keyed by the shared correlation id. The first terminal
condition wins:

1. a matching answer settles the prompt;
2. an SDK timeout settles it with the method's cancellation value;
3. runtime replacement settles every prompt owned by the old Pi session;
4. stop/dispose settles every remaining prompt before resources are released.

Late or duplicate answers are refused or ignored by the existing shared semantics and must never
resolve a later prompt. Queue eligibility is false while any Pi question is outstanding.

### Project trust

Use Pi's `ProjectTrustContext` and public settings/service APIs. Project trust is about loading
checkout-local executable resources, not about Mission Control repository attachment. A previously
recorded Pi trust decision may be honored if the SDK exposes it through its settings manager. An
undecided checkout triggers a structured confirm question before local extensions load. Denial
continues with local executable resources disabled where Pi supports that mode; otherwise it refuses
launch with a clear explanation.

The decision is persisted only by Pi through its normal trust store. Mission Control may persist the
question transcript but never creates its own competing trust database.

### Work Queue eligibility

Change Pi's `workQueue` capability from null only for the managed runtime and only after tests prove:

- one attributable start signal when queue text is accepted;
- stable busy/idle state;
- exactly one terminal `turn_done` for success, interruption, and error;
- no unresolved question;
- a send acknowledgement that distinguishes refused, queued, and accepted input;
- reset/clear and stop cannot cause a previous queue item to complete a later one.

Use the shared Work Queue manager and skill invocation (`/skill:<name>`) already declared for Pi. Do
not create Pi hooks or infer completion from transcript prose.

### Pull-request provenance

Emit the existing PR-created event only from an observed successful tool invocation that identifies a
repository and pull-request URL/number under the shared provenance rules. Do not scan assistant text
for `github.com` and do not infer that a command attempted to create a PR. If Pi's typed tool result
cannot supply reliable provenance, leave `opensPullRequest` unsupported and keep any workflow that
requires it ineligible, documenting the measured gap rather than guessing.

## Ordered implementation

1. **Add the host UI context.** Create a focused Pi bridge implementing the bounded subset above.
   Translate Pi option order, title/message/placeholder/prefill, and optional timeout into shared
   question events without adding Pi vocabulary to shared protocol schemas.
2. **Bind before extensions start.** Ensure the UI context and trust handlers are attached before the
   SDK emits project-resource or extension startup events. Rebind them on runtime new/resume/reload
   replacement using the Phase 1 replacement hook.
3. **Implement exact settlement.** Maintain one resolver per correlation id. Answer validation,
   timeout, replacement, stop, and disposal all converge on one idempotent settle function. Emit the
   shared resolved/cancelled state before releasing the Pi promise.
4. **Resolve project trust.** Read Pi's public trust state. Ask once when undecided, write the decision
   through Pi, and reload project resources only after approval. Denial must not execute any
   checkout-local extension code.
5. **Project nonblocking UI safely.** Map notification severity and simple working/status messages to
   bounded activity. Rate/size bound them so an extension cannot flood SSE. Treat widgets and custom
   TUI features as unsupported diagnostics, not durable app UI.
6. **Prove queue signals.** Extend Pi event normalization only as needed to give the shared queue one
   attributable accepted start and exactly one finish. Add provider-neutral supervisor changes only
   when every adapter benefits from the same missing contract.
7. **Enable Pi Work Queue.** Populate the existing capability record for SDK only, reuse shared send,
   acknowledgement, retry, wrap-up skill, interrupt, and clear behavior, and keep terminal refusal.
8. **Add PR provenance when proven.** Normalize successful `gh pr create` tool output through the
   existing provenance helper/event. If evidence is insufficient, retain a capability gap and keep
   PR-dependent automation disabled.
9. **Close documentation drift.** Update `docs/sessions.md`, Work Queue/Foreman guidance, and
   `docs/plans/agent-sdk-sessions/phase-6-pi-rpc-driver.md` to say the focused Pi Bedrock plan shipped
   the SDK transport instead. Preserve historical context but remove any statement that RPC is still
   the active implementation route.

## Data, API, migration, and compatibility

- Reuse the existing SDK question schemas, routes, events, and persisted question shape. No Pi-specific
  table or route is expected.
- If the existing shared question schema cannot represent editor prefill or a timeout without loss,
  extend it additively and update all exhaustive browser/server consumers. Do not overload unrelated
  fields.
- Reuse existing Work Queue records and acknowledgements. Pi adapter code emits normalized facts; it
  does not write queue state.
- Pi trust persistence stays in Pi's settings store. Mission Control records no duplicate trust bit.
- Runtime replacement updates in-memory UI resolvers and the existing driver session identity
  atomically from the host's perspective.
- Existing managed Claude/Codex questions and Work Queue behavior remain unchanged and gain shared
  regression coverage for any protocol extension.
- Terminal Pi continues to show no Work Queue controls.

## Test and evidence plan

### Focused automated tests

- UI bridge unit tests for select/confirm/input/editor values, option order, empty values, prefill,
  timeout, notification bounds, and unsupported UI diagnostics.
- Correlation tests for correct answer, wrong id, duplicate answer, late answer after timeout, two
  sequential questions, replacement while blocked, stop while blocked, and daemon-side disconnect.
- Project-trust tests for remembered allow, remembered deny, undecided allow, undecided deny, malformed
  trust state, and proof that a local extension factory does not execute before allow.
- Queue tests for accepted start, busy state, question blocking, success, provider failure,
  interruption, clear replacement, stop, retry, and exactly-once completion.
- Wrap-up tests for Pi's `/skill:<name>` invocation over SDK input and shared acknowledgement.
- PR provenance tests with typed fake tool results, false-positive assistant prose, failed `gh`
  command, unrelated repository, duplicate result, and unavailable-evidence fallback.
- Shared protocol/exhaustiveness tests for any additive question field.

### Browser end-to-end

Using only fake Pi SDK and fake command results:

1. dispatch a managed Pi session with a fake Bedrock model;
2. receive and answer select, confirm, input, and multi-line editor questions;
3. prove the question clears on answer and that a timed-out/stopped question cannot affect the next;
4. encounter project trust before a project extension loads, deny once, then approve in an isolated
   scenario and see the extension become available only afterward;
5. enqueue work, observe pickup only when idle/question-free, run the wrap-up skill, and see one
   completion acknowledgement;
6. interrupt or clear during queue work and prove no false completion;
7. surface a PR-created event only from the fake successful tool result;
8. confirm terminal Pi still refuses Work Queue.

Use accessible selectors and run the modal inset geometry helper for any new modal. Capture safe
screenshots of the trust/question and queue states for the pull request; no credential or real model
content may appear.

### Required commands

- Focused Node tests with the repository's test preload.
- Focused Playwright spec after a fresh build.
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run smoke`
- `npm run test:e2e`
- `npm run package` if Phase 1 established it as necessary for Pi assets.

## Merge and exit criteria

- Every blocking Pi UI method settles exactly once under answer, timeout, replacement, and stop.
- Project-local executable resources cannot load before a positive Pi-owned trust decision.
- Managed Pi enters Work Queue only under the shared eligible state, with attributable pickup and
  exactly-once completion. Terminal Pi remains ineligible.
- PR-created provenance is evidence-based or explicitly left unsupported; prose cannot trigger it.
- Browser evidence covers the visible question/trust and queue paths using fakes.
- Full required checks pass on top of merged Phase 1.
- Documentation names SDK as the shipped transport and accurately states remaining Pi limitations.

## Downstream handoff

This is the terminal phase. Future work starts from explicit separate plans for Pi MCP, permission
modes, multi-repository grants, or richer extension presentation. None is implied by completion of this
feature.

The final implementation report should record:

- the exact pinned Pi SDK version;
- whether PR provenance was proven and enabled;
- the supported ExtensionUIContext subset;
- the project-trust persistence owner;
- the managed-versus-terminal Work Queue boundary;
- full test, build, smoke, E2E, package-if-required, and PR/CI evidence.

## Cross-phase audit

- Phase 2 consumes the adapter, lifecycle, and event invariants from Phase 1 and does not replace them.
- All remaining source-plan requirements are covered here or explicitly excluded.
- Question, trust, queue, and PR state each retain one existing owner.
- The final system has one Pi SDK transport and one terminal transport, with no hidden RPC lifecycle.
