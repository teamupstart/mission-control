# Phase 2: the Claude driver, behind the toggle

## Outcome

Flipping "Session runtime: Agent SDK" for Claude in the Harnesses panel makes the next
dispatched Claude session run through `@anthropic-ai/claude-agent-sdk`: registered by the
supervisor, streaming its state and structured asks onto the card, answerable from the
dashboard, resumable across daemon restarts, and hand-off-able to a real terminal. The
default stays `"terminal"`; with the toggle off, nothing changes.

## Entry criteria and dependencies

- Direct prerequisite: phase 1 merged (C1-C5 exist).

## Scope

In: the Claude adapter, supervisor start/resume/stop with per-session send serialization,
the dispatch branch, `sessionRuntime` config + panel control, answer-route branching,
runtime rendering in all four session-drawing components, the "Continue in terminal"
handoff, packaging.

Non-goals: Foreman/queue/reset/skills parity (phase 3 - Foreman treats SDK sessions as
review-only until then and must degrade safely, see step 10), Codex (phase 4), pi
(phase 6), any default flip (never - resolved decision).

## Repository findings and inherited contracts

Inherits C1-C5. Additional findings binding this phase:

- Dispatch argv assembly is inline in `dispatcher.ts:154-190`; the same inputs
  (`resolveDispatchModel`, `resolveDispatchEffort`, the auto-mode permission spec,
  `mission-mcp.ts`'s descriptor) parameterize `SdkLaunchOptions` - no new launch module.
- `askChannelArgs` (`ask-channel.ts:167`) disables `AskUserQuestion` and injects a
  redirect prompt for terminal dispatches. SDK dispatches DROP both (native questions
  render on the card - source plan, Architecture) but still render the MCP descriptor
  into `options.mcpServers` so `report_status` etc. keep working.
- The Agent SDK spawns the `claude` CLI; pin the binary to `resolveAgentBin("claude")`
  (verify the SDK's executable-path/env mechanism against the installed version - the
  docs' surface has changed before). Auth is the operator's existing login; no new env.
- `HarnessesConfigSchema` (`protocol.ts:1291-1345`) uses hand-written per-agent patch
  blocks - follow that pattern, never `.partial()`.
- Session decorations rebind through `noteKeyFor` (`registry.ts:4644`,
  `agentSessionId ?? id`); a `/clear` rotates `agentSessionId` - the `bound` event must
  re-fire on rotation so the existing rebind machinery (work episodes, queue, goal)
  tracks it, the same way hooks do today.
- Packaging: esbuild daemon bundle + `electron-builder.yml` `files:` allowlist + asar
  disabled (AGENTS.md build contract). Add the SDK to `dependencies`; confirm the
  bundle smoke check passes with it (the SDK subprocess-spawns and must not be broken by
  bundling - if esbuild mangles it, mark it external and add it to the packaged files).

## Implementation steps

1. **Dependency**: add `@anthropic-ai/claude-agent-sdk` to `package.json`; verify
   `npm run build` + bundle smoke on both Node floors.
2. **`src/server/harness/claude/sdk.ts`** - the adapter, over an injectable factory (the
   `PaneDeps` seam pattern) so tests script the SDK's message stream without a real CLI:
   - `launch(opts)`: `query()` in streaming-input mode with `cwd`, `model`,
     `permissionMode` (map `default` ↔ the CLI's spelling exactly as
     `PermissionModeSpec.launchArgs` does), effort via the SDK's thinking options,
     `mcpServers` from the descriptor, `resume` when reattaching. The first yielded user
     message is `opts.prompt`.
   - `system:init` → `bound` (session id; `transcriptPath` via the existing
     `resolveTranscriptPath` derivation until the SDK reports one).
   - Message flow → `state` events (assistant/tool activity → `working` with a ticker
     line; `result` → `turn_done` + `idle`).
   - `canUseTool` → C3 request projection: ordinary tools → `kind: "permission"` with
     options built from `suggestions`; `AskUserQuestion` → `kind: "question"` with
     `questions[]`; `ExitPlanMode` → `kind: "plan"`. The pending resolver is held until
     `answer()` maps the selection back (allow / allow+updatedPermissions / deny /
     `updatedInput.answers` for questions). Emit `request` / `request_resolved`.
   - In-process `PreToolUse` hook → `pr_created` when the Bash input satisfies
     `opensPullRequest` (`@shared/pr-command.mjs`) - authorship evidence for C-provenance
     (consumed in phase 3; emitting it here costs nothing and needs the hook anyway).
   - `send()` yields into the streaming input (text + base64 images); `interrupt()`,
     `setPermissionMode`, `setModel` delegate to the SDK; `clearContext()` sends
     `/clear` and expects a session-id rotation (re-emit `bound`).
   - Subprocess exit / stream error → `exited { resumable }`.
3. **Supervisor** (`src/server/sdk/supervisor.ts`): implement `start` (mint `sdk:<uuid>`,
   persist row, `registerSdkSession`, pump events → `applyDriverEvent`, update row on
   `bound`/exit), per-session FIFO send queue, `stop`, and `restore()` = for each
   persisted `running` row whose harness declares `sdk`, relaunch with
   `resume: agent_session_id`; on failure register + mark exited so
   `reconcileTasksBoundTo` settles the task visibly (C5). Register a daemon-shutdown
   hook that stops every handle gracefully (interrupt, brief drain, subprocess exit) so
   a restart interrupts as little in-flight work as possible - the source plan's
   graceful-drain mitigation is owned here.
4. **Config (C6)**: `sessionRuntime` in `HarnessesConfigSchema` + patch schema +
   `resolveDispatchRuntime(agent)` in `src/server/harnesses.ts` (config value gated on
   `HARNESSES[agent].sdk !== null`; unknown stored values → `"terminal"`, reported).
5. **Dispatch (C7)**: branch in `Dispatcher.dispatch` after worktree provisioning:
   sdk → `supervisor.start({...})`; skip home spawn, `waitForSessionAtCwd`, `awaitReady`,
   `deliverIntent`. Task records no `homeName`; extend the task-liveness path so SDK
   sessions answer through the supervisor (true/false, never null) wherever
   `homeAlive` is consulted for reconciliation.
6. **Answer routes (C3)**: `/select-option` and `/submit-options` branch on
   `session.runtime`: sdk → verify against the pending request (`optionRowMiss` on the
   projected options; exact labels), `supervisor.answer(...)`; 409 on
   mismatch/expiry exactly as the pane path does.
7. **Panel**: runtime control on the per-agent card in `HarnessesPanel.tsx`, rendered
   only when `capabilitiesFor(agent).runtimes.includes("sdk")`; absence sentence composed
   from the capability. Wire GET/PUT through the existing harnesses config route.
8. **Capability flip**: claude `runtimes: ["terminal", "sdk"]` +
   `HARNESSES.claude.sdk = claudeSdk` (the C4 contract test forces both together).
9. **UI runtime rendering** (all four components - AGENTS.md layout parity):
   `paneSubtitle` (`session-bits.tsx`) renders an `sdk` chip where a mux pane string
   would be; `RailRow` marks, `SessionTile` tile-flags, and `SessionCard` chips each gain
   the runtime signal (the three-vocabularies rule); send boxes/pickers already follow
   `canMessage`. "Focus in terminal" hides for SDK sessions; "Continue in terminal"
   (step 11) takes its place.
10. **Foreman safety before phase 3**: SDK sessions must not be half-driven. The
    worker's send paths go through routes that work (`/send`, `/inject` → supervisor
    `send`), and its menu answers go through `/select-option` (works via step 6). The one
    gap is prompt fidelity (`promptHarness` still claims pane grammar) - acceptable
    interim, but gate the QUEUE: `foremanAutomationAuthorized` is not yet runtime-aware
    (that is C9/phase 3), so queues on SDK sessions stay refused via the existing
    `hooksSeen`-independent path only if one exists - verify, and if a queue would be
    accepted, explicitly refuse `runtime === "sdk"` here with a sentence, removed in
    phase 3.
11. **Handoff (C8)**: `POST /api/sessions/:id/handoff` → supervisor graceful stop →
    `launchHome` (existing `terminal/home.ts`) in the session cwd with
    `[resolveAgentBin("claude"), "--resume", agentSessionId]` → respond with the home
    name; discovery adopts the new process. Card/detail action + keyboard entry +
    README keyboard table row (AGENTS.md shortcut registry: `ActionId`, `ACTIONS`,
    dispatch branch, `CommandBar` keycap, `keybindings.test.ts`).
12. **Tests**: `claude-sdk-adapter.test.ts` (scripted message stream: init→bound,
    canUseTool→request→answer→resolution, AskUserQuestion multi-select answers map,
    /clear rotation, exit), `sdk-supervisor.test.ts` (start/persist/restore/resume-fail
    settles task), `dispatcher-runtime.test.ts` (branch selection, toggle gating,
    unknown-value fallback), `harnesses-config.test.ts` additions, panel render test,
    answer-route branching test, handoff test (stubbed home deps).

## Data and compatibility

- `sessionRuntime` lives inside the existing `harnesses` `app_config` blob - no
  migration. Rows in `sdk_sessions` gain their first writers.
- With the toggle off (default), every dispatch takes the terminal path byte-identically.

## Verification

Unit suites above, plus E2E: `make start`, flip the Claude toggle, dispatch a task into
an allowlisted repo; confirm on the real dashboard - card appears (starting → working),
transcript streams, a permission ask renders and answers from the card, `/clear` reset
rotates identity without orphaning the queue, daemon restart resumes the session,
handoff opens a live terminal continuing the conversation. Then flip the toggle off and
dispatch again to confirm the terminal path is unchanged. Be picky about the card UI.

## Merge / exit criteria

CI green; E2E checklist above demonstrated; README "Session runtimes" section + handoff
row landed in the same PR; default remains `"terminal"`.

## Downstream handoff

Phases 3/4/6 may rely on: the supervisor's start/answer/send/stop/restore semantics, the
dispatch branch, C6's resolver, the answer-route runtime branching, and the Claude
adapter as the reference `SdkSpec` implementation. They must not: bypass the supervisor
to reach a handle, or add per-dispatch runtime selection (resolved decision).

## Cross-phase audit record

- 2026-07-24: initial version. Step 10's interim queue refusal is explicitly temporary;
  phase 3 (C9) owns removing it - recorded in both files.
- 2026-07-24 (phase 4 audit): the step 10 refusal must be RUNTIME-scoped
  (`runtime === "sdk"`), never agent-scoped, because phase 4 may merge before phase 3
  and its Codex SDK sessions need the same interim guard without an edit.
