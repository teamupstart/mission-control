# Phase 1: Managed Pi Bedrock runtime

## Outcome

Mission Control offers Pi's managed SDK runtime beside its existing terminal runtime. An operator can
select a Pi-discovered `amazon-bedrock/*` model, launch a managed session, observe its work and usage,
send follow-ups, interrupt it, clear it, survive daemon restart, and hand the same Pi conversation to
a terminal. Pi remains the exclusive owner of provider credentials and model resolution.

This phase is independently usable for direct operator-driven sessions. It does not claim structured
extension UI or Work Queue eligibility, which arrive in Phase 2.

## Entry criteria and direct dependencies

- The planning pull request containing `docs/plans/pi-bedrock-models/plan.md`, `phased-plan.md`, and
  this brief is merged, so every cited path resolves on the default branch.
- No phase task dependency beyond the planning session.
- Pi's published SDK must still expose the capabilities pinned by the plan. If the selected exact
  version differs from the investigated 0.85.1 surface, verify its types and record the deviation in
  the pull request before implementation.

## Scope

- Pin `@earendil-works/pi-coding-agent` as a production dependency and prove it loads in the server
  bundle and packaged environment.
- Add an injected, lazy-loaded Pi SDK dependency seam.
- Implement a Pi `SdkSpec` adapter for model/session construction, core event normalization, usage,
  controls, resume/restore, and cleanup.
- Register the adapter and advertise `terminal` plus `sdk` through the shared capability registry.
- Preserve exact provider-qualified model ids in terminal and SDK launches.
- Provide actionable Pi/Bedrock credential and model-access diagnostics.
- Update runtime/model setup copy and product documentation for the behavior delivered here.

## Non-goals

- Project-local extension execution that needs a structured trust question.
- Structured extension `select`, `confirm`, `input`, or `editor` prompts.
- Work Queue, Foreman automation, workflow participation, or PR-created provenance.
- Mission MCP support inside Pi.
- Pi permission modes, multi-repository dispatch, direct AWS SDK calls, Bifrost, or a hardcoded
  Bedrock model list.
- Removing or changing Pi's terminal runtime.

## Findings and contracts

### Existing Mission Control seams

- `src/server/harness/types.ts` owns `SdkSpec`, `SdkLaunchOptions`, `SdkSessionHandle`, and `SdkEvent`.
- `src/server/sdk/supervisor.ts` owns managed session persistence, state, restore, send, and stop.
- `src/server/harness/index.ts` is the server registry and currently sets Pi `sdk: null`.
- `src/shared/harness-capabilities.ts` is the browser-safe capability source and currently lists only
  `terminal` for Pi. `test/harness-sdk.test.ts` keeps these two facts aligned.
- `src/server/dispatcher.ts` resolves model and effort before the runtime branch and passes those same
  values to either embedded or terminal launch.
- `src/server/harness/pi/model-catalog.ts` already returns opaque `provider/model` ids, including
  nested model id segments, under strict response bounds.
- `src/server/harness/pi/launch.ts` already creates exact Pi terminal session ids for later resume.

### Pi SDK contract to pin

Use the public package entrypoint only. The dependency seam should expose the minimum interfaces the
adapter consumes rather than leaking vendor types throughout Mission Control:

- `createAgentSessionServices`, `createAgentSessionFromServices`, and
  `createAgentSessionRuntime`, or the smallest equivalent public composition that builds an
  `AgentSessionRuntime` with a chosen `SessionManager`;
- `ModelRuntime` against Pi's normal agent directory and its stored credentials;
- `SessionManager.create(cwd)` for a new durable session and `SessionManager.open(path)` or the public
  version-equivalent for exact resume;
- model lookup using the provider/model id from `SdkLaunchOptions.model`;
- typed `AgentSessionEvent` subscription;
- `prompt`, `steer`, `followUp`, `abort`, `setModel`, `setThinkingLevel`, runtime `newSession`, and
  runtime `dispose`.

Do not import Pi internal files or parse its JSONL when a public SDK method supplies the same fact.
Do not use RPC in production beside the SDK.

### Model and credential ownership

Split the Mission model id exactly once at the first `/` only to ask Pi's `ModelRuntime` for the
model. Preserve the original string in Mission Control. An absent id lets Pi follow its configured
default. An explicit but unavailable id is a launch failure, not a fallback.

Use Pi's default agent directory resolution so its `/login amazon-bedrock` credential is visible.
Never read `auth.json` directly in Mission code. Never copy credential values into a disposable
Mission state home. The existing `agentSubprocessEnv` isolation is for Mission state and subprocess
boundaries, not an instruction to relocate Pi's provider configuration.

### Project trust boundary for Phase 1

Phase 1 must not silently load project-local executable extensions before Phase 2 can ask the
operator. Configure the SDK resource/service layer to exclude project-local extensions and any other
executable local resource unless Pi already has a durable trusted decision that can be consumed
without prompting. Global Pi configuration and built-in coding tools remain available.

If Pi's public SDK cannot distinguish those sources at the pinned version, fail managed launch in a
checkout with untrusted project-local executable resources and explain that terminal mode can resolve
trust. Do not infer trust from the repository already being attached to Mission Control.

## Ordered implementation

1. **Pin and prove the package.** Add one exact Pi SDK dependency. Inspect its package exports and
   asset/loading behavior under the repository's server esbuild configuration. Extend bundle smoke
   before writing the adapter if the package cannot load from `dist/server/index.mjs`.
2. **Create `sdk-deps.ts`.** Follow the Claude/Codex adapter pattern: lazy import the public Pi package,
   project a narrow dependency interface, and allow complete fake injection in tests. No module-load
   access to credentials, cwd, or session files.
3. **Resolve model and session inputs.** Build Pi's services for `opts.cwd`, use Pi's normal agent
   directory, resolve an explicit provider/model through `ModelRuntime`, clamp/apply the shared
   thinking level, and construct either a new durable `SessionManager` or the exact stored session.
4. **Build the managed runtime.** Create `AgentSessionRuntime`, subscribe before delivering the first
   prompt, and return a handle only after the Pi session id/file is bound. Compose repository memory
   and standing-instruction fallbacks through the same dispatcher-owned text contract terminal Pi
   already receives. Refuse non-null Mission MCP and non-empty `extraDirs` instead of dropping them.
5. **Normalize core events.** Map session start, turn start/end, message deltas/finals, thinking,
   built-in and extension tool execution, retry/compaction activity, provider errors, usage, and
   shutdown into existing `SdkEvent` variants. Deduplicate deltas/finals and emit exactly one
   `turn_done` per accepted turn.
6. **Implement controls.** Map idle send to `prompt`, busy send to the existing steer/follow-up policy,
   interrupt to `abort`, effort/model controls to session-local setters, clear to runtime
   `newSession`, and stop to runtime disposal. Protect each operation from use after replacement or
   disposal.
7. **Persist and restore exactly.** Expose Pi's stable session id/path as `driverSessionId`; ensure
   supervisor persistence is updated after new-session replacement; reopen the exact session on
   daemon restart. A missing/corrupt/incompatible session is an explicit failed restoration.
8. **Preserve handoff.** Confirm the existing Pi `resume.argv` reopens the SDK-created session through
   `pi --session <id-or-path>`. If the SDK returns a path where terminal resume expects an id, persist
   the canonical Pi identity accepted by both surfaces.
9. **Register capability.** Set Pi's server `sdk` spec and add `sdk` to the shared Pi runtime list in
   one change. Change interrupt and effort driver capability only when the handle implements them.
   Leave permission modes, Work Queue, MCP, and multi-repo null.
10. **Classify failures.** Translate SDK load, missing provider login, expired AWS auth, access denied,
    unavailable region/model, resume corruption, and ordinary provider failure into bounded messages.
    Redact raw credential material and do not log Pi auth contents.
11. **Update visible guidance.** Make Pi provider sign-in copy provider-neutral and explicitly mention
    `/login amazon-bedrock` for Bedrock. Document terminal versus managed runtime and credential
    refresh behavior in `docs/sessions.md` and the appropriate model/setup page.

## Data, API, migration, and compatibility

- No new HTTP route or SQLite column is expected.
- Reuse the existing task/session `runtime`, `agent_session_id`, usage, and lifecycle records.
- The full provider/model string remains within existing `ModelIdSchema` and model fields.
- Existing stored Pi terminal sessions remain terminal sessions. Do not migrate runtime values.
- Stored `sdk` for Pi becomes supported only after capability registration; older builds continue to
  apply their existing unsupported-runtime fallback if a database is opened after downgrade.
- Claude and Codex adapters must not acquire Pi branches. Any shared supervisor change is
  provider-neutral and covered by all-adapter regression tests.
- Terminal Pi argv remains byte-equivalent except for any deliberately improved, tested error copy.

## Test and evidence plan

### Focused automated tests

- New Pi adapter unit tests with injected SDK fakes for fresh launch, exact resume, missing resume,
  provider/model split, unavailable explicit model, default model, thinking level, prompt delivery,
  steer/follow-up, interrupt, clear replacement, stop/dispose, and use-after-dispose refusal.
- Event tests for text/thinking deltas, tool lifecycle, activity, retry/compaction, usage/cost mapping,
  exactly one turn completion, provider error, and exit.
- Credential/error tests use synthetic errors and assert redaction plus repair guidance. They never
  read Pi auth files.
- Harness registry contract tests prove Pi's shared/server runtime declarations agree, SDK interrupt
  and effort controls match the handle, while permission modes, MCP, work queue, and multi-repo stay
  unavailable.
- Supervisor/startup tests prove driver id persistence, daemon restart restoration, clear-context id
  replacement, stop, terminal handoff, and one Registry eviction.
- Existing Pi model-catalog tests gain representative `amazon-bedrock/deepseek.v3.2` and nested ids.
  Terminal launch tests prove the exact id reaches `--model` unchanged.
- Bundle smoke proves the pinned Pi SDK loads from the built server. Add packaged-app coverage when
  public package resources are not fully bundled.

### Browser end-to-end

Extend the shared fake-agent infrastructure and add a Playwright path that:

1. opens a Pi dispatch with fake Bedrock catalog entries;
2. selects `amazon-bedrock/deepseek.v3.2` and the managed runtime;
3. dispatches and sees a bound/working/idle lifecycle plus usage;
4. sends a follow-up, interrupts a long fake turn, and sees the session remain usable;
5. clears context and confirms later input belongs to the replacement Pi session;
6. reloads the daemon/browser fixture and observes exact restore;
7. hands off to terminal and proves the fake Pi argv reopens the same session.

Select by role, label, or visible text. Add no `data-testid`. The fake must fail if a code path attempts
network access or touches the operator's Pi home.

### Required commands

- Focused Node tests with `--import ./test/setup-state.mjs --import tsx`.
- Focused Playwright spec after `npm run build`.
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run smoke`
- `npm run test:e2e`
- `npm run package` if package asset behavior requires it.

An optional manual real-Bedrock prompt may supplement the fake proof. It must be harmless, use the
operator's existing Pi configuration, and be clearly identified as non-CI evidence.

## Merge and exit criteria

- All focused and required checks pass at the phase head.
- Browser evidence shows a fake Bedrock model launched through managed Pi and the core control path.
- The server bundle loads the exact pinned Pi SDK without relying on the global Pi installation.
- No credential value, Pi auth file, real transcript, local state, or model output is committed.
- Pi advertises SDK only when the real server adapter is registered.
- Work Queue and structured extension UI remain unavailable and are documented as Phase 2 work.
- The pull request description names the direct SDK choice, the project-resource restriction, and any
  deviation from public Pi APIs.

## Downstream handoff to Phase 2

Phase 2 may rely on one stable adapter owner with:

- a durable current `AgentSessionRuntime` and driver session identity;
- normalized idle/busy, activity, tool, usage, and exactly-once `turn_done` events;
- replacement-safe subscription and disposal hooks;
- a narrow vendor dependency seam suitable for fake UI/trust injection;
- SDK capability registered but Work Queue still null;
- project-local executable resources still excluded unless already durably trusted.

If any item is not true at merge, Phase 1 is incomplete and Phase 2 must not start.

## Cross-phase audit

- Every Phase 1 change is needed for direct managed use or as a prerequisite to safe structured UI.
- Phase 1 does not pre-implement queue eligibility or question projection.
- Phase 2 does not need to replace the transport, session store, or event vocabulary.
- No schema, credential, MCP, permission, or multi-repository work is hidden in the handoff.
