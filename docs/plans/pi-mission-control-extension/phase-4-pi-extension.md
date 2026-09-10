# Phase 4: the Mission Control extension for Pi

Part of [Pi parity](plan.md) - see [phased-plan.md](phased-plan.md) for the graph.

The largest phase, and the one the project is named for.

## Outcome

A Pi session - **including one an operator started themselves** - can call Mission Control's
tools, reports its state to the dashboard, reports its live model, effort and context
percentage, and attributes its cost. The card stops being a process with a transcript and
becomes a card.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 3.** Its `missionTools` capability and the
  `deps.piExtensionInstalled` seam are what this phase fills.
- Phase 1 and Phase 2 need not have merged. If Phase 1 has, the hand-run identity work here
  makes its `UsageSpec` answer for hand-run sessions too, which is Phase 1's stated non-goal
  arriving.

## Scope

1. `src/pi/extension.ts`, built to `dist/pi-extension/index.js` by `build:pi-extension`, with an
   atomic publish.
2. **Tools:** an MCP stdio client against `dist/mcp/server.mjs`, registering every tool the
   server publishes.
3. **Instrumentation:** Pi's lifecycle mapped to `POST /hooks/:event`, plus `POST /statusline`.
4. **Identity:** the extension reports its session id, which is what makes a hand-run Pi
   session attributable at all.
5. `HARNESSES.pi.hooks` set to a real `HookSpec`, and `piExtensionPath()` in `config.ts`.
6. `HARNESS_CAPABILITIES.pi.workQueue.uninstrumentedWhy` made more specific about what is
   missing - still without naming a remedy, because this phase does not install anything.

### Non-goals

- **Installing it.** Phase 5. This phase produces the artifact and can be exercised with
  `pi -e <path>` or a hand-made link; it must not write into the operator's home.
- The Setup row and the staleness check. Phase 6.
- `permissionModes`, the `sdk` runtime, TUI polish while a tool blocks.

## Repository findings

### The transport is already vendor-neutral; only the mapper is new

`postHookEvent` (`src/shared/hook-bridge.mjs`) states its own contract: "Nothing in this file
knows an event name, a payload key or a vendor." `HookIngestSchema` (`src/shared/protocol.ts:205`)
already carries `agent: z.enum(AGENT_TYPES)`, defaulted to `claude` only because the oldest
installed bridge predates the field. `POST /hooks/:event` is token-guarded and calls
`registry.applyHook` (`src/server/routes.ts:3834`).

So this is a `HookSpec` plus a payload mapper - the shape `harness/codex/hooks.ts` is, at 62
lines - not a pipeline.

**One difference from both existing bridges, and it is an advantage.** Claude's and Codex's
bridges are separate processes spawned per event; this is in-process. There is no per-event
spawn cost, state can be held between events, and `postHookEvent`'s 800 ms timeout can be
reconsidered. Do not reconsider it casually: the contract "be fast, write nothing to stdout,
swallow every error" still applies, and stdout is worse here than for a hook script - anything
written goes into the operator's TUI.

### Credentials are read at event time, not baked

`harness-hook.mjs` calls `readClientToken()` and uses `BASE_URL` from
`@shared/harness-runtime.mjs` on every event. The extension does the same. The consequence is
the argument for the whole distribution design: **the only value an install bakes is the path to
the bundle**, so the staleness check has exactly one thing to check. Claude's OTel block, by
contrast, bakes a token into `~/.claude/settings.json`.

### The event mapping, measured

Every event below was observed in one `-p` run against a local fake provider (see `plan.md` P5):

| Pi event | Ingest as | Reading |
| --- | --- | --- |
| `session_start` | `SessionStart` | `idle`, "started (reason)" |
| `input`, `source` in {`interactive`,`rpc`} | `UserPromptSubmit` | `working`, prompt text; `work_started`; `promptText` |
| `tool_execution_start` | `PreToolUse` | `working`, "running `<tool>`" |
| `tool_execution_end` | `PostToolUse` | `working`; PR-URL sniff on `bash` |
| `ui_prompt_start` | `PermissionRequest` | `awaiting_input`, from `kind` and `title` |
| `ui_prompt_end` | `PostToolUse` | back to `working` |
| `session_before_compact` / `session_compact` | `PreCompact` / `PostCompact` | `working` |
| `agent_settled` | `Stop` | `idle`; **`turn_completed`** |
| `session_shutdown` | `SessionEnd` | `exited`, "ended (reason)" |
| `model_select`, `thinking_level_select`, `turn_end` | `POST /statusline` | model, effort, context % |

Two of these are better than what the shipped harnesses have, and the phase should not level
them down:

- **`ui_prompt_start` is structured.** Claude's needs-you signal is `isIdleNudge`, a regex over a
  notification string whose own spec documents it as untrustworthy. Pi publishes `kind`
  (`select`/`confirm`/`input`/`editor`/`custom`) and a `title`, and its docs state the events
  exist "so host/status integrations can report 'waiting for user' instead of just 'running'".
- **`agent_settled` means settled, not merely ended.** Pi's docs: `agent_end` fires "but Pi may
  still auto-retry, auto-compact and retry, or continue with queued follow-up messages". Measured
  `isIdle=false` on `agent_end` and `isIdle=true` on `agent_settled`. Map `Stop` from
  `agent_settled`; **do not** map it from `agent_end`, which would report idle mid-retry.

`input` carries `source`, so `source === "extension"` must be skipped - an extension-injected
message is not a human's ask. That is the discrimination `substantivePrompt` performs for Claude
by inspecting scaffolding, available here as a field.

### Hand-run identity: this phase is the only one that can supply it

`startUsagePoller` and `locatePiTranscript` both require `session.agentSessionId`, and a hand-run
Pi session has none. Codex's passive annotator works by `lsof`-ing the rollout the process holds
open; **Pi was measured not to hold its session file open** (`plan.md` P7), so that mechanism has
no Pi analogue.

The extension knows the answer exactly: `ctx.sessionManager.getSessionId()`. Every hook ingest
already carries `sessionId` and `transcriptPath` in `HookIngestSchema`, and
`findSessionByEnv` (`src/server/registry.ts`) resolves a session by pane key, then by
`agentSessionId`, then by a **unique** cwd match. So the first ingest from a hand-run session
binds it by cwd and carries the id, and every later one matches on the id directly.

Note the guard at `registry.ts` that refuses a hook whose `sessionId` contradicts what discovery
witnessed, and that it compares against `discoveredIdentity` rather than
`target.agentSessionId` deliberately. Pi has no discovered identity to contradict, so this
should pass cleanly - verify it rather than assume.

### Registration derives from the server, and Pi takes the schema raw

Measured (`plan.md` P2-P5): `initialize` + `tools/list` against `dist/mcp/server.mjs` returns 15
tools; each `inputSchema` can be passed **verbatim** as `parameters`; Pi validates against it
strictly, including `additionalProperties: false` and `required` two levels inside an array
item; `tools/call` round-trips; every Mission tool returns exactly one text block.

Three adapter details:

- `parameters: tool.inputSchema` - no conversion. `pi-ai`'s validator checks for
  `Symbol.for("TypeBox.Kind")` and takes a plain-JSON-Schema path when it is absent, so this is
  supported rather than accidental.
- MCP `{ content: [{ type: "text", text }] }` maps onto Pi's `AgentToolResult.content` directly.
- MCP `isError: true` must **throw**. Pi's contract: "Returning a value never sets the error flag
  regardless of what properties you include."

`promptSnippet` is what puts a tool in Pi's `Available tools` section; without it a custom tool
is omitted from that section. Measured cost of all fifteen: 900 bytes of system prompt.

No name collides: Pi's built-ins are `read bash powershell edit write grep find ls`.

### The build output must be `.js`, self-contained, and published atomically

`isExtensionFile` accepts only `.ts` and `.js`. `import.meta.url` resolves to the **link** path
for a symlinked extension, so bare-specifier imports would resolve from the operator's home -
the artifact must be a self-contained bundle, which esbuild produces.

`config.ts` already holds `mcpServerPath()` and `codexHookPath()`, and `codexHookPath`'s comment
records exactly why a path must be resolved there and not from the harness module: esbuild
collapses the server into `dist/server/index.mjs`, so a specifier written from
`harness/codex/launch.ts` resolves four levels above the repo root, `existsSync` fails, and the
launch silently degrades. `piExtensionPath()` goes beside them.

Atomic publish, because the failure is severe: a bundle that exists but fails to load makes
**every Pi session on the machine exit 1**. `scripts/build-state-lock-native.mjs` already stages
into a private directory and publishes with one atomic rename so "a daemon starting up never
loads a half-written addon", and `test/native-state-lock-provisioning.test.ts` pins it. Copy
both.

## Implementation steps

### 1. `src/server/config.ts`

`piExtensionPath()` beside `codexHookPath()`, honouring an env override the way both neighbours
do, resolving `dist/pi-extension/index.js`.

### 2. `package.json`

`build:pi-extension` with esbuild - `--bundle --platform=node --format=esm --target=node22`,
`--alias:@shared=./src/shared`, output `dist/pi-extension/index.js`. **`.js`, not `.mjs`**, or Pi
will not discover it. Add it to the `build` chain and to `scripts/smoke-bundles.mjs`, which
exists because a bundle can fail in ways its source cannot.

Publish via a staging directory and one rename, following
`scripts/build-state-lock-native.mjs`. A test pins it, as its neighbour's does.

### 3. `src/pi/extension.ts` - the extension

Structure it so nothing can throw where a throw is fatal:

- **Module scope:** nothing but imports and the default export. A module-scope throw is Pi's
  exit-1 case.
- **Factory:** register tools and subscribe handlers only. No process, socket, watcher or timer -
  Pi's own guidance is that "extension factories may run in invocations that never start a
  session", and the MCP child is a session-scoped resource.
- **`session_start`:** start the MCP child; record the session id; send the first ingest.
- **`session_shutdown`:** idempotently tear the child down.
- **Every handler:** wrapped so a throw cannot escape. A runtime throw is survivable (measured:
  `Extension error (…)` on stderr, session continues) but it costs that event, and the operator
  sees a line they cannot act on.

**Tools.** On `session_start`, spawn `piExtensionPath`'s sibling `dist/mcp/server.mjs` (resolved
by the daemon and passed in, or resolved relative to the extension - decide and document which,
because a symlinked extension's `import.meta.url` is the link), `initialize`, `tools/list`, and
`pi.registerTool` per published tool. `pi.registerTool` works after startup and "New tools are
refreshed immediately in the same session", so this need not block the factory.

Bound the child the way `mission-mcp.ts` bounds its probe: a handshake timeout, a maximum
unterminated stdout frame, and a kill grace. Those constants exist there with measured
justifications; reuse the reasoning rather than inventing new numbers.

**Blocking tools.** `request_input` and `request_plan_decisions` block until the human answers.
Measured: a 12-second tool completed with no timeout and `signal.aborted === false`, so Pi
imposes none. Pass Pi's `signal` through to the MCP call so an aborted turn cancels the wait.

**Instrumentation.** Map the table above; POST through `postHookEvent`, adding `agent: "pi"`,
`sessionId` from `ctx.sessionManager.getSessionId()`, `cwd` from `ctx.cwd`, `transcriptPath`, and
`captureTerminalEnv()` for the pane key. Statusline from `ctx.model`, `ctx.thinkingLevel` and
`ctx.getContextUsage()` - measured to return `{tokens, contextWindow, percent}`.

**PR sniffing.** On `tool_execution_end` for the `bash` tool, run `pullRequestUrlsIn` and
`opensPullRequest` from `@shared/pr-command.mjs` over the result and the command. Both are
already vendor-neutral. Send `prUrls` and `prCreated`; never send the command itself, which is
the rule `harness-hook.mjs` states and for the reason it states.

**Standing instructions.** Per Phase 2's handoff: `before_agent_start` may deliver the operator's
text **only** when the launch did not. A dispatched session carries
`--append-system-prompt`; delivering again would have the agent read the rule twice. The
simplest correct rule is to deliver only when the launch argv carried no such flag - which the
extension can see via `event.systemPromptOptions.appendSystemPrompt`.

### 4. `src/server/harness/pi/hooks.ts` - the `HookSpec`

`scope: "machine"`. `events` is the vocabulary the extension sends. `toState`,
`workCycleSignal` (`work_started` on the prompt and tool events, `turn_completed` on `Stop`) and
`promptText`, following `codex/hooks.ts` arm for arm. Wire it into `HARNESSES.pi.hooks`.

`scope: "machine"` is what makes `foremanAutomationAuthorized` accept a Pi terminal session
without waiting for `hooksSeen` - re-read that function and confirm the arm you land on.

### 5. `src/shared/harness-capabilities.ts`

Revisit `workQueue.uninstrumentedWhy`, which Phase 1 wrote as a statement of current fact. With
`scope: "machine"`, a session that has never reported a hook now means the extension is not
loaded on this machine - so the sentence can become more specific about *what* is missing.

**It must still not name a remedy.** This phase produces the artifact; Phase 5 is what installs
it, so between this merging and that one there is still nothing an operator can press. Keep the
sentence factual and leave the actionable rewrite to Phase 5, per Phase 1's handoff.

### 6. Phase 3's seam

Fill `deps.piExtensionInstalled` with a probe of `piExtensionPath()`. Mark it temporary: Phase 6
owns the reading, and two things must not both decide.

## Tests and verification

Unit (`test/`):

- The MCP stdio client: `initialize`/`tools/list`/`tools/call` against a stub server; a server
  that never answers; a server that emits an unterminated frame; `isError: true` becoming a
  thrown error.
- The payload mapper: each Pi event to its `HookIngest`, and `source === "extension"` producing
  nothing.
- `piHooks.toState` and `workCycleSignal` per event, including that `agent_end` does **not**
  produce `turn_completed` and `agent_settled` does.
- The PR sniff over a real `gh pr create` output shape.
- A bundle smoke case in `scripts/smoke-bundles.mjs`.

Live, and this is the part a fixture cannot replace - run against the installed Pi with
`pi -e dist/pi-extension/index.js` and a daemon:

1. A hand-run Pi session appears on a card with a state that moves.
2. It calls `request_input`; the question reaches the dashboard; answering resumes it.
3. Its model, effort and context percentage render.
4. With Phase 1 merged, its cost appears - the hand-run case Phase 1 could not deliver.

Keep the model spend near zero by driving the tool call through a locally registered provider,
the way `plan.md`'s probes did, rather than asking a real model to choose the tool.

**UI:** cards gain state, statusline and cost for Pi sessions, so an `e2e/` spec is required.
Assert by role/label. `e2e/fixtures/fake-agents.ts` already redirects every agent binary at a
fake - the Pi fake must load this extension, or the spec proves nothing about it.

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- A hand-run Pi session reports state, model, effort, context and (with Phase 1) cost.
- Mission tools are callable in a hand-run Pi session, and a blocking one blocks.
- `dist/pi-extension/index.js` is published atomically, pinned by a test.
- The extension writes nothing to stdout and nothing into the operator's home.
- A daemon that is down costs an event and nothing else.

## Downstream handoff

Phase 5 may rely on `piExtensionPath()` and on the artifact being a single self-contained `.js`
reachable by a `.js`-named symlink. Phase 6 may rely on the artifact carrying a build marker -
**add one in this phase**, because Phase 6's version-drift arm has nothing to compare without
it, and retrofitting it means an installed extension from this phase can never be recognised as
stale.

Phase 5 must not relocate the artifact; Phase 6 must not repair it.

## Cross-phase audit record

- After Phase 3: consistent. This phase fills the seam Phase 3 declared and does not add a
  second decider.
- Reconciliation applied **backwards into Phase 1**: `uninstrumentedWhy` had to be written for
  the pre-extension state there and revised here, which is recorded in both files rather than
  left as a sentence that silently becomes wrong.
- **Review correction (r2).** This phase previously said the sentence "should name the Setup
  install". It must not: this phase ships no install, so naming one repeats Phase 1's defect one
  step later. Phase 5 owns the actionable rewrite.
- Reconciliation applied **backwards into Phase 2**: the double-delivery gate is stated in Phase
  2's handoff, because that is where the channel is defined.
- **Build marker moved into this phase** from Phase 6, where it was first noticed. Phase 6 can
  only compare a marker that the artifact already carries, so the producer must add it - a
  version check introduced after the fact cannot recognise anything installed before it.
- Reconfirmed: nothing here sets `mcp` non-null for Pi.
