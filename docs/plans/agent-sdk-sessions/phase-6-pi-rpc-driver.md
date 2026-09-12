# Phase 6: the pi RPC driver

> **Superseded.** The [Pi Bedrock phases](../pi-bedrock-models/phased-plan.md) shipped the
> TypeScript SDK transport using Pi's `AgentSessionRuntime`, including structured UI and
> managed Work Queue support. There is no production RPC driver. The proposal below is
> retained as historical context; [managed Pi documentation](../../sessions.md#what-a-managed-pi-session-does-differently)
> describes the supported behavior and remaining exclusions.

## Historical proposed outcome

The Harnesses toggle appears for pi; flipping it makes the next dispatched pi session
run over `pi --mode rpc`: streaming state, structured dialogs (whatever pi's configured
extensions raise), acked sends, resume, and - for the first time on any pi session -
work-queue eligibility, because the driver is the pickup/completion channel pi's
`hooks: null` could never provide.

## Entry criteria and dependencies

- Direct prerequisite: phase 3 merged (this phase leans on C9's runtime-aware
  `foremanAutomationAuthorized` and the runtime-generic Foreman/queue machinery; the
  supervisor and toggle arrive transitively via phase 2).
- Runs concurrently with phases 4 and 5 (disjoint files; README adjacency with 5 only).

## Scope

In: the pi RPC adapter, `extension_ui_request` projection, capability revisions
(`runtimes`, `workQueue`), clearContext via `new_session`, resume via `--session`,
handoff, tests.

Non-goals: pi permission-mode modeling (pi's vocabulary still does not map onto the
closed `PermissionMode` union - `setPermissionMode` stays null, the tested degradation;
widening the union is out of scope per the source plan's pi note); building or bundling
a pi permission extension (we project whatever dialogs the operator's pi config raises).

## Repository findings and inherited contracts

Inherits C1-C9 (and C11 is owned here). Findings:

- **Transport**: `pi --mode rpc`, strict LF-delimited JSONL over stdio. pi's own docs
  warn Node `readline` is non-compliant (it splits on U+2028/U+2029) - frame manually on
  `\n` bytes. Strip inherited `TMUX_PANE`, `WEZTERM_PANE`, and `TERM_PROGRAM` before
  spawning, matching the first driver's attribution guard. Commands carry optional `id`
  for correlation; responses are `{type: "response", command, success, data | error}`.
- **Command set** (verify against the pinned pi version): `prompt` (with images and
  `streamingBehavior`), `steer`, `follow_up`, `abort`, `new_session`,
  `switch_session`, `fork`, `get_state`, `set_model`, `set_thinking_level`, `compact`,
  `set_session_name`, `get_last_assistant_text`.
- **Events**: `agent_start` / `agent_end` / `agent_settled`, message/turn/tool streams,
  `extension_ui_request` (`select` / `confirm` / `input`, answered by
  `extension_ui_response` matched on `id`, with optional timeout auto-resolve).
- **pi today in this repo**: `hooks: null`, `tui: null`, `workQueue: null`,
  `permissionModes: null`, transcript non-null with messages, launch-scoped
  `--session-id` identity (`preparePiLaunch`, `bindLaunchedAgentSession`) - the pattern
  the whole SDK design generalized. The current terminal launch contract is owned by the
  [README](../../dispatch-and-backlog.md#dispatch-an-agent); the RPC launch replaces that terminal
  arm for SDK-runtime dispatches.
- **Sessions**: `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`; RPC mode still
  writes them, so `piTranscript.locate` works once `bound` supplies the session id
  (C5's read-path guarantee). Resume: `--session <path|id>`; interactive takeover uses
  the same flag.
- **pi is YOLO by default**: no built-in approvals; `extension_ui_request` is raised by
  extensions (e.g. a permission extension) when the operator has one configured. The
  driver projects whatever arrives and claims nothing more.

## Implementation steps

1. **`src/server/harness/pi/sdk.ts`** over the injectable transport seam:
   - `launch(opts)`: spawn `resolveAgentBin("pi")` with
     `["--mode", "rpc", ...effort launchArgs]` in `opts.cwd`; on start, `get_state` →
     `bound` (session file id as `agentSessionId`; `transcriptPath` from
     `piSessionFileForIdentity`). Deliver `opts.prompt` as the first `prompt` command.
     pi has no MCP client (`mcp: null`) - `opts.mcp` is refused upstream (the dispatcher
     already never renders MCP for pi).
   - `agent_start` / `agent_end` / `agent_settled` → `state` events;
     tool/message streams → activity ticker; `agent_end` → `turn_done` (map pi's
     stats where available, else null usage).
   - `extension_ui_request` → C3 projection: `select` → options list (single-select),
     `confirm` → two options, `input` → a free-text question. `answer()` sends
     `extension_ui_response` matched on the request id. A timed-out request (pi
     auto-resolved to its default) emits `request_resolved` so the card clears - never
     answer after timeout.
   - `send()` → `prompt` (or `steer`/`follow_up` per `streamingBehavior` when a turn is
     in flight - pick the measured behavior and record it); `interrupt()` → `abort`;
     `setModel` → `set_model`; `setEffort` → `set_thinking_level`;
     `clearContext()` → `new_session` + re-emit `bound` with the new session file;
     `setPermissionMode: null`.
   - `pr_created`: watch tool-execution events for `opensPullRequest` command matches.
   - Exit → `exited { resumable: true }`; resume relaunches with
     `["--mode", "rpc", "--session", <id>]`.
2. **Capabilities**: pi `runtimes: ["terminal", "sdk"]`; `HARNESSES.pi.sdk = piSdk`
   (C4 contract test moves them together). Revisit `workQueue`: replace the null with a
   `WorkQueueSpec` whose `uninstrumentedWhy` covers terminal pi sessions ("terminal pi
   sessions report no pickup signal; dispatch pi through the Agent SDK runtime to queue
   work") - C9's runtime arm authorizes SDK-runtime pi sessions, and terminal pi
   sessions hit the per-session refusal exactly as uninstrumented Codex does. Update
   `workQueueUnsupportedWhy` expectations in `harness-capabilities.test.ts`
   (pi moves from harness-refused to session-refused for terminal, allowed for SDK).
3. **Handoff**: implement `Harness.resume.argv(agentSessionId)` as
   `["--session", agentSessionId]`; the phase 2 route prepends `resolveAgentBin("pi")`
   without a pi-specific branch.
4. **Dispatcher**: nothing pi-specific to add - the phase 2 branch covers it; preserve
   the terminal Pi launch contract documented in the
   [README](../../dispatch-and-backlog.md#dispatch-an-agent) when the toggle is off.
5. **Tests**: `pi-sdk-adapter.test.ts` on scripted JSONL frames (LF framing incl. a
   U+2028-in-content case, ui request/response matching, timeout resolution,
   new_session rotation, resume argv), capability/contract updates, queue authorization
   matrix (terminal pi refused with the sentence; SDK pi authorized), handoff argv.

## Data and compatibility

No schema changes. Terminal Pi dispatch (toggle off) remains byte-identical to the
contract documented in the [README](../../dispatch-and-backlog.md#dispatch-an-agent).

## Verification

Unit suites, plus E2E: flip the pi toggle, dispatch into an allowlisted repo; card
streams state; queue an item and watch pickup/verify (the first queued work on a pi
session ever - confirm the sentence changes in the panel too); `set_model` and effort
from the card; daemon restart resumes; handoff opens interactive pi on the same session.
If a pi permission extension is installed, raise a dialog and answer it from the card;
otherwise assert the no-dialog path stays quiet.

## Merge / exit criteria

CI green; E2E checklist demonstrated; pi's capability changes reflected in every
computed sentence (panel scope lines, `workQueueBlockedReason`) with no hand-typed
prose; README pi row updated in this PR.

## Downstream handoff

Terminal (final phase). What the repository may rely on afterward: three
`SdkSpec` implementations proving the transport seam (subprocess SDK, JSON-RPC,
raw JSONL), and the capability doctrine extended with its first runtime-conditional
work-queue answer.

## Cross-phase audit record

- 2026-07-24: initial version. Depends on 3 (not just 2) because step 2's work-queue
  revisit is only sound on top of C9's runtime arm - moving that arm here was
  considered and rejected (phase 3 owns Foreman contracts; splitting authorization
  across phases is how the two halves drift). Concurrency with 4 and 5 re-checked
  against their file lists; README adjacency with 5 noted in both.
