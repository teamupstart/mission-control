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
- 2026-07-25: implemented. Seven notes for later phases, four of them corrections to this
  file written against a tree (and an SDK) that has since moved:
  - **`SdkSpec` gained a second member, `resumeArgv(agentSessionId)`.** Step 11 spells the
    handoff argv as a literal `["--resume", agentSessionId]`, which would have put a
    harness-specific command line in a harness-neutral route - the one thing the whole
    registry doctrine forbids (`Reach a capability through a registry, never by testing
    s.agent`). Phase 4 and phase 6 fill it for their harness; `codex resume <threadId>` and
    pi's equivalent are the same shape. C4 is extended, not changed.
  - **`SdkSessionHandle` gained nullable `setEffort(effort)`.** Like
    `setPermissionMode`, this is a live, session-scoped capability; Claude implements it
    through the Agent SDK query's `applyFlagSettings({ effortLevel })`. Later drivers must
    implement a real control or declare `null`, and callers must treat that null as a
    refusal rather than a successful no-op.
  - **Restart resolution and pending asks belong to the supervisor/registry seams.** A
    resumed launch re-resolves the Mission MCP descriptor instead of persisting it, and a
    descriptor failure degrades only that capability rather than losing the conversation.
    Concurrent driver requests remain ordered behind the registry's one visible
    `PaneDialog`; resolving one promotes the next.
  - **PR authorship is a `PreToolUse` + `PostToolUse` PAIR, not `PreToolUse` alone.** Step 2
    names only the pre-hook, but `applyDriverEvent`'s `pr_created` arm is gated on
    `evt.url`, so a pre-hook on its own emits an event nothing consumes. Both halves are
    what the shell bridge already carries (`harness-hook.mjs`): the COMMAND is the
    authorship evidence `adoptPr` accepts, the URL is what there is to adopt. Phase 3, which
    owns provenance, inherits both.
  - **`SDK_SESSION_STATUSES` gained `suspended`** (append-only, so this is allowed). Without
    it a clean daemon restart is indistinguishable from an agent that finished, and
    `reconcileOnStartup` reclaims the worktree of work that was merely interrupted - which
    would have made "resume on restart" true only after a crash. `stopAll` sets the flag the
    pump reads; `sdkSessionIsLive` treats it as live.
  - **`/submit-options` grew a second body shape** (`answers`, one entry per question),
    because a driver form genuinely is not a flat row list: `AskUserQuestion` carries up to
    four questions, each numbering its options from 1, and `driverDialog` refuses to flatten
    them. C3 said the route "carries the full answers map" without saying it needed a
    schema; it does. The pane shape is unchanged and the two are refused for each other's
    runtime rather than coerced.
  - `dispatchPermissionModeArgs` was split into `dispatchPermissionMode` (the mode, which
    the embedded launch takes) and the argv renderer, whose extra `launchArgs` gate belongs
    to the renderer alone.
  - The subprocess env DROPS `TMUX_PANE` / `WEZTERM_PANE` / `TERM_PROGRAM`. Machine-installed
    `~/.claude/settings.json` hooks fire inside the SDK subprocess too, and a daemon started
    from a terminal would hand its own pane down - `findSessionByEnv` prefers a pane key over
    everything else, so every embedded session's hooks would key to one stranger's card.
    Phases 4 and 6 need the same subtraction if their transports inherit the daemon's env.
  - **`/send` and `/inject` needed a driver arm and step 5 does not mention one.** Step 10
    asserts the worker's send paths "go through routes that work"; they did not - both went
    straight to `sendText` / `injectPrompt`, which refuse a session with no pane, so the
    card's own Send button was enabled (`canMessage`) and failed. `sdk/deliver.ts` is that
    arm, and it is where the acked send's consequence is stated once: both of
    `InjectResult`'s ambiguous states (`pasted` on a failure, an unverifiable
    `submitVerified`) are UNREACHABLE for an embedded session, which is what makes C9's
    "no `mayHaveLanded` arm" true rather than merely unused.
  - **Reset stays phase 3's, and the E2E line about it needs one more thing than that
    phase's file says.** `resetToOrigin`'s `/clear` tail types at a pane, so for an embedded
    session it degrades to the already-tested `cleared: false` - honest, and no worse than
    a pane-less session has ever been. But routing it through `handle.clearContext()` is
    only half: the work-episode rebind is gated on `clear_start`-shaped evidence that
    `resetSession` pre-arms with `awaitingAgentRebind`, and `applyDriverBinding` reports
    `driver_identity`, which `canResolvePending` does not accept. Phase 3 needs a
    driver-sourced clear evidence kind, or the rotation drops task ownership - which is
    what a bare `/clear` does on BOTH runtimes today (verified end to end), and why Reset
    rather than a typed `/clear` is the supported path.
  - **Packaging needed no change.** The SDK bundles cleanly into `dist/server/index.mjs`
    (3.8MB, up from ~780KB) and its subprocess spawn was verified against the bundled copy,
    so it is not marked external and `electron-builder.yml` is untouched. Its optional
    platform package (~250MB of native CLI) is installed by npm and never used: the adapter
    always pins `pathToClaudeCodeExecutable` to `resolveAgentBin("claude")`, because running
    the copy inside the package would silently be a different Claude Code build from the one
    the operator logged in with. A `zod` peer conflict (the SDK wants ^4, this repo is on ^3)
    is resolved by a `package.json` `overrides` entry rather than a zod upgrade; the SDK
    inlines its own zod and imports nothing but node builtins at runtime.
