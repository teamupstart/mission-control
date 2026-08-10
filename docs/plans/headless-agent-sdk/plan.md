# Headless calls on the Agent SDK

Every model call the app makes for itself - Foreman's four, the Inspector's two, workflow
Personas, ensemble reviews, and the background jobs - spawns `claude -p --output-format json`
through one function, `runClaudeText` (`src/server/claude-cli.ts:136`). Meanwhile the daemon
already drives *interactive* sessions through `@anthropic-ai/claude-agent-sdk`
(`src/server/harness/claude/sdk.ts`). This plan asks whether the headless callers should move
to the same SDK, and what it would cost.

The short answer is that the question contains a false premise, and the plan is organised
around correcting it before proposing anything.

## The premise: "shelling out" is not the alternative to the SDK

The Agent SDK spawns the `claude` CLI as a subprocess. It is Claude Code packaged as a
library, not a client for a remote API:

```
$ grep -o "spawn\|child_process\|--input-format\|stream-json" \
    node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs | sort | uniq -c
   5 child_process
  47 spawn
   2 stream-json
```

This repo pins that subprocess to the operator's own binary rather than the copy vendored
inside the npm package, deliberately, so an embedded session and a dispatched pane are the
same build (`src/server/harness/claude/sdk-deps.ts:28-40`).

So both paths spawn the same binary. The choice is a wire protocol:

| | `claude -p` (today) | Agent SDK `query()` |
|---|---|---|
| Process | spawn `claude` | spawn `claude` |
| Protocol | one-shot, `--output-format json` on stdout | held-open stdio, `--input-format stream-json` |
| Context | empty by construction (no `--resume`/`--continue`/`--session-id`) | empty unless `resume`/`sessionId` are passed |
| Reply | one JSON envelope | a frame stream to project |
| Cancellation | SIGKILL the detached process group | `abortController` |

## The decisive finding: two of the three wins need no migration

The three arguments for the SDK were structured output, live progress, and first-class tool
permissions. The operator's pinned CLI is version 2.1.223, and it already has the first two on
the `-p` path:

```
$ claude --help | grep -A2 json-schema
  --json-schema <schema>     JSON Schema for structured output validation.
  --max-budget-usd <amount>  Maximum dollar amount to spend on API calls (only works with --print)

$ claude --help | grep -A3 output-format
  --output-format <format>   "text" (default), "json" (single result), or "stream-json" (realtime streaming)
```

- **`--json-schema`** would delete `runStructured`'s re-prompt ladder
  (`src/server/llm/structured.ts:94-117`) and `parseModelJson`'s fence handling today, on the
  current transport.
- **`--output-format stream-json`** means even live progress is reachable without the SDK. The
  SDK would be doing the frame reading for us, which is real work, but it is not a capability
  we lack.

What the SDK genuinely adds over a maximally-configured `claude -p` is narrower than it first
appears, and is set out under [What the SDK actually buys](#what-the-sdk-actually-buys).

## Scope: 14 call sites, three processes' worth of constraints

Every site below reaches `runClaudeText` through `LlmRunner.run` on `claudeRunner`
(`src/server/llm/claude.ts:105-175`), the only importer of `claude-cli.ts`.

| # | Site | Process | Model | Timeout | Tools | Structured | Gate | Spend `role` |
|---|---|---|---|---|---|---|---|---|
| A1 | Foreman full review (`foreman/review.ts:50`) | worker | `claude-opus-5` | 120s (default) | none | yes | serial loop | yes |
| A2 | Foreman queue verify (`foreman/queue-verify.ts:176`) | worker | `claude-opus-5` | 120s (default) | none | yes | serial loop | yes |
| A3 | Foreman backlog planner (`foreman/backlog-plan.ts:313`) | worker | `claude-sonnet-5` | scales with backlog | none | yes | serial loop | yes |
| A4 | Foreman Tier 1 triage (`foreman/worker.ts:2145`) | worker | `claude-haiku-4-5` | 30s | none | **no** | serial loop | yes |
| B1 | Inspector review (`inspector/worker.ts:820`) | daemon | `claude-sonnet-5` | 600s | **Read,Grep,Glob** | yes | `createLimiter(1)` | yes |
| B2 | Inspector reply (`inspector/worker.ts:723`) | daemon | `claude-sonnet-5` | 300s | **Read,Grep,Glob** | **no** | `createLimiter(1)` | yes |
| C1 | Workflow Persona (`workflows/engine.ts:896`) | daemon | persona's or balanced default | 600s | none | yes | review scheduler (3) | no |
| C2 | Workflow context compaction (`workflows/context.ts:196`) | daemon | `claude-haiku-4-5` | 45s | none | yes | review scheduler, `capture` priority | no |
| D1 | Ensemble comparative (`ensembles/reviews/packet.ts:443`) | daemon | `claude-haiku-4-5` | 120s | none | yes | review scheduler | no |
| D2 | Ensemble panel judges (`ensembles/reviews/panel.ts:276`) | daemon | per judge | 120s | none | yes | review scheduler, per judge | no |
| E1 | Dispatch titler (`task-title.ts:119`) | daemon | `claude-haiku-4-5` | 15s | none | yes | `createLimiter(2)` | no |
| E2 | Goal refiner (`goal/refiner.ts:204`) | daemon | `claude-haiku-4-5` | 30s | none | yes | `createLimiter(2)` | no |
| E3 | Away digest (`away/digest.ts:79`) | daemon | `claude-haiku-4-5` | 20s | none | **no** | none | no |

Three facts from this table shape everything below.

1. **The Foreman is a separate process.** It is started by `npm run foreman`
   (`package.json:34`), never spawned by the daemon, forbidden from opening SQLite, and
   reports spend over HTTP with a durable outbox (`foreman/worker.ts:274-286`). Any transport
   must work there, or the migration covers two subsystems out of three.
2. **Only six sites are `role`-tagged**, and `claudeSpendReport` only fires when `role` is set
   (`llm/claude.ts:130-133`). The other eight already discard their cost accounting.
3. **Exactly one caller holds tools.** The Inspector's grant is paid for with four other
   defence layers (`inspector/worker.ts:255-307`), and the deny-glob rendering is byte-pinned
   against the Inspector's own constants by `test/llm-runner-contract.test.ts:313-331`.

## What the SDK actually buys

Verified present in `@anthropic-ai/claude-agent-sdk@0.3.220` (`sdk.d.ts`) and unused by this
repo:

| Capability | Option | What it replaces today |
|---|---|---|
| Structured output | `outputFormat: {type:'json_schema', schema}` → `structured_output` on the result frame (`sdk.d.ts:929, 1726, 4314`) | `runStructured`'s two-attempt ladder and `parseModelJson`'s envelope/fence handling. **Also reachable via `--json-schema`.** |
| Disable every tool | `tools: []` (`sdk.d.ts:1424-1432`) | `--tools ""` |
| Cancellation | `abortController` (`sdk.d.ts:1327`) | `killTree` SIGKILL of a detached process group (`claude-cli.ts:288-295`) |
| Hard spend ceiling | `maxBudgetUsd` (`sdk.d.ts:1691`) | nothing |
| stderr visibility | `stderr: (data) => void` (`sdk.d.ts:1943`) | stderr is only read on a non-zero exit |
| Determinism | `settingSources: []` (`sdk.d.ts:1874`) | nothing - today's headless runs inherit whatever the CLI loads |
| Turn ceiling | `maxTurns: 1` (`sdk.d.ts:1685`) | nothing |

**`abortController` replaces a SIGKILL that cannot be trusted.** Today a timeout kills a
detached process group and the parent cannot guarantee it landed; `claude-cli.ts:69-76`
concedes that a `SIGKILL` of the daemon leaks children outright. This is the largest single
gain, because it is the one capability with no equivalent on the `-p` path at any flag.

`persistSession: false` was the other candidate - it would have deleted `goal/prune.ts` and its
hourly sweep outright. **It is not adopted**; see [Decisions](#decisions). Headless runs keep
writing transcripts, which turns transcript continuity into a phase 2 requirement rather than
something a later phase deletes.

What the SDK does **not** buy, because a one-shot does not need it: multi-turn steering,
`interrupt()`, live `setModel`/`setPermissionMode`, session resume, the permission callback
loop, hooks, and the MCP ask-channel. All of that is `sdk.ts`'s reason for existing and none
of it applies here (`sdk.ts` items 1-14 of its long-lived-session surface).

## Tradeoffs

### Lost or changed

| What | Today (`claude -p`) | Under the SDK transport | Severity |
|---|---|---|---|
| Bundling | `claude-cli.ts` spawns a binary; nothing to bundle | the worker and the daemon both import the SDK. `sdk-deps.ts` lazily `import()`s it precisely so the vendor bundle stays out of the eager path; the Foreman worker bundle has never carried it | **Medium - the top risk.** `scripts/smoke-bundles.mjs` is the check that would catch it |
| Headless run visibility | a `.jsonl` transcript per run, prunable, readable after the fact | unchanged - persistence stays on, so the transcript and the sweep both survive | None, by decision |
| Settings inheritance | whatever the CLI loads by default | `settingSources: []` makes runs deterministic and stops them reading the operator's CLAUDE.md | Low, but it is a **behaviour change to verdict inputs** and must be measured, not assumed |
| Failure vocabulary | `claude exited <code>: <stderr>` | SDK errors and `TerminalReason` values | Low; the ledger's `error_code` column already distinguishes infrastructure from parse |
| One fewer moving part | `claude-cli.ts` is 296 lines of heavily-argued spawn | replaced by SDK option construction, with the arguments migrating into the new module | Neutral - the comments are the asset, and they must move rather than be deleted |

### Gained

- One transport for one binary instead of two, with the tool grant expressed as data rather
  than a hand-built `--settings` JSON string.
- Structured output that the provider validates, removing a whole retry attempt from every
  structured call site (12 of 14).
- Real cancellation, a spend ceiling, and stderr the caller can see.
- A path to live progress for the ten-minute Persona and Inspector calls, which today are
  opaque until they exit.

### Unchanged by design

- **The `LlmRunner` seam and every call site above it.** All 14 sites already go through
  `runner.run(prompt, opts)`. If the transport changes underneath, none of them change.
- **Spend accounting.** `claudeEnvelopeModels` (`harness/claude/envelope.ts`) is *already*
  shared between the `-p` envelope and the SDK's `result` frame, because the CLI serialises one
  struct for both. `session_id`, `total_cost_usd`, `usage`, and `modelUsage` all arrive the
  same way, so `claudeSpendReport` survives nearly untouched. This is the single biggest
  de-risking fact in the plan.
- **Context isolation.** Guaranteed today by three absent flags; guaranteed under the SDK by
  not passing `resume`/`sessionId`/`forkSession`. Same property, and it must be pinned by the
  same kind of test.
- **The pane-identity subtraction.** `headlessEnv()` and `sdkSubprocessEnv()` already do the
  same job for their respective paths.
- **Headless transcripts and the pruner.** Persistence stays on, so `goal/prune.ts` keeps
  working and keeps being needed. The SDK one-shot must therefore spawn in `HEADLESS_CWD` like
  its predecessor, or its transcripts land where the sweep does not walk.

## Architecture: a transport behind the runner id, never a third runner

The tempting shape is a third `LlmRunnerId` - `"claude-sdk"` beside `"claude"` and `"codex"`.
It is the wrong shape, and the survey of the contract says why in six places:

1. `providerModelDefault` (`src/shared/model.ts:153-161`) branches `codex` vs *everything
   else*, so a third id silently inherits Claude's model ids for every tier - feeding the
   background jobs, all four Foreman roles, the Inspector, and every Persona.
2. `AGENT_IDENTITY[runner]` in `InspectorSettingsPanel.tsx:333,351` indexes an `AgentType` map
   with an `LlmRunnerId`. It compiles today only because `LlmRunnerId ⊂ AgentType` by accident.
   A third id yields `undefined` and `.label` **throws** in the panel.
3. `LlmRunnerId` is **persisted**: `personas.runner`, the `llm` app-config blob, and
   `usage_ledger` rows carry it.
4. Six `?? "claude"` sites in Foreman and the Inspector would keep pinning the old transport.
5. `litter` is declared on the interface but consumed by nothing - `goal/prune.ts` hardcodes
   Claude's directory and `.jsonl`, and exactly one pruner is started.
6. The contract test is name-specific except for two blocks, so a third runner's behaviour
   would go unasserted by default.

This mirrors the decision the interactive migration already made: *the axis is how this
particular call is driven, not a new identity* (`docs/plans/agent-sdk-sessions/plan.md`,
"The axis is a per-session runtime, not a new harness"). So:

```ts
// src/server/llm/claude.ts - one runner, two transports
export type ClaudeTransport = "print" | "sdk";
```

`claudeRunner.run` selects a transport, defaulting from config with an env override, and
delegates to either `runClaudeText` (today's module, unchanged) or a new
`runClaudeSdkOneShot`. `id` stays `"claude"`, so no persisted value moves, no settings picker
changes, and no `providerModelDefault` branch is reachable.

### Request flow, before and after

```mermaid
flowchart LR
  subgraph Callers
    F[Foreman worker<br/>4 sites]
    I[Inspector<br/>2 sites]
    P[Personas / ensembles / jobs<br/>8 sites]
  end
  F --> R[LlmRunner.run<br/>claudeRunner]
  I --> R
  P --> R
  R -->|transport: print| CP[runClaudeText<br/>claude -p --output-format json]
  R -->|transport: sdk| SD[runClaudeSdkOneShot<br/>query with tools:[] maxTurns:1]
  CP --> BIN[claude binary 2.1.223]
  SD --> BIN
  CP --> ENV[claudeEnvelopeModels]
  SD --> ENV
  ENV --> LED[spend ledger]
```

The seam is `LlmRunner.run`; the join is `claudeEnvelopeModels`, which both transports already
share. Nothing above the seam and nothing below the join has to change.

## Decisions

Resolved by the operator on review of this plan. These are settled, not open.

| Decision | Choice |
|---|---|
| How far to move | **Transport swap behind `claudeRunner`.** Structured output arrives through `outputFormat`, plus `abortController`, `maxBudgetUsd`, `stderr` and `settingSources: []`. One transport for one binary. |
| Headless transcripts | **Keep them, keep the pruner.** `persistSession` stays on. The transcript is the only record of what a headless run did, and nothing else covers that debugging case yet. |
| The latent driver bug | **Fix now, in its own PR.** It affects interactive sessions today and is not gated on any phase here. |
| After this plan | **Phase it and schedule the work.** |

Two shapes were considered and are not being built:

- **Stay on `claude -p` and only add `--json-schema`.** It is the cheapest real win and it is
  still how phase 1 starts, but stopping there leaves SIGKILL cancellation in place - the one
  capability with no `-p` equivalent at any flag.
- **A live progress UI over intermediate frames.** The thing that would have made the Persona
  timeout easy to diagnose, and the natural sequel, but it is a UI feature with its own
  protocol surface and e2e specs rather than part of a transport change. Phase 2 leaves the
  frame stream available for it.

The phases below are written so that stopping after any one of them leaves the tree better than
it started, with no half-migrated transport in place.

## Phases

Each phase is independently mergeable and independently revertible.

### Phase 1 - capability probe and the `schema` option

Add `schema?: object` to `LlmRunOptions`. Render it as `--json-schema` in `claudeRunner`; ignore
it in `codexRunner` (which must keep its own extraction). Teach `runStructured` to skip its
second attempt when the runner reports the shape was provider-validated.

Also: a probe that records the operator's CLI version and whether it accepts `--json-schema`,
because every later phase depends on the **operator's** binary rather than the npm package.

Delivers the whole `--json-schema` win on the existing transport. Exit criteria: the parse-retry attempt disappears from
`workflow_llm_calls` rows for structured sites; `test/llm-runner-contract.test.ts` gains a
generic block asserting the flag is rendered.

### Phase 2 - `runClaudeSdkOneShot`, daemon-only, off by default

A new module beside `claude-cli.ts` implementing one tool-less `query()`: `tools: []`,
`settingSources: []`, `maxTurns: 1`, `abortController` wired to the caller's `timeoutMs`,
`cwd: HEADLESS_CWD`, and `pathToClaudeCodeExecutable` / `env` from the existing `sdk-deps.ts`
helpers. Behind `ClaudeTransport`, defaulting to `"print"`.

Session persistence stays **on**, per the decision above, which makes transcript continuity an
exit criterion rather than an afterthought: the run must land a `.jsonl` in the same encoded
project directory `headlessTranscriptDir()` derives, or the hourly sweep silently stops
covering these runs. `claudeSdkTranscriptPath` (`sdk.ts:159-166`) already derives that path the
same way for interactive sessions, so this is an assertion to write, not a mechanism to invent.

The load-bearing comments in `claude-cli.ts:155-183` - why context isolation is a correctness
property, why the pane env is stripped, why the tool default is empty - **move**, they do not
get summarised. A test asserts the SDK path passes no `resume`, no `sessionId`, no
`forkSession`, mirroring `test/llm-runner-contract.test.ts:119-132`.

Exit criteria: with the flag on, the eight daemon-side tool-less sites produce identical
verdicts and identical ledger rows to the `print` transport on the same prompts, and
`pruneHeadlessTranscripts` still finds and ages out what they wrote.

### Phase 3 - the Inspector's grant

Render the grant as SDK options and prove the deny rules are enforced identically. The existing
byte-equality test (`test/llm-runner-contract.test.ts:313-331`) is the anchor: whatever the SDK
path sends must reduce to the same permission set, or `grantRefusal` must refuse it.

This phase is separate because it is the only one where getting it wrong leaks a secret rather
than producing a bad verdict.

### Phase 4 - the Foreman worker

The worker's four sites must produce ledger rows the daemon still prices identically, through
the HTTP outbox rather than a direct write. Investigation retired the bundling half of this
phase: there is no worker bundle to fix.

Only once this and phase 3 are both done is `"sdk"` a defensible default, which is why the flip
is its own unit in the decomposition.

Retiring `goal/prune.ts` is deliberately **not** a phase. It was the only work that depended on
turning persistence off, and that is not being done.

The decomposition in [`phased-plan.md`](./phased-plan.md) splits phase 4 in two once the
repository is consulted: the Foreman worker needs no bundling work at all, so proving it and
flipping the default apart from each other buys real parallelism against the Inspector's grant.
That index is authoritative for the implementation graph; this section states the intent it
decomposes.

## Risks

1. **The operator's CLI, not the npm package, gates every capability.** `sdk-deps.ts` pins the
   operator's binary on purpose. A machine on an older `claude` gets an SDK that offers
   `outputFormat` and a binary that ignores it. Phase 1's probe exists for this.
2. ~~**Bundling the SDK into the Foreman worker.**~~ **Investigated and largely retired.** There
   is no `build:foreman` - the worker runs from TypeScript source under `tsx`
   (`package.json:34`), so it resolves `node_modules` directly and needs no bundle work. The
   daemon bundle already carries the SDK as a lazy dynamic-import specifier rather than inlined
   vendor code, and the interactive driver proves that resolution works in the packaged app.
   What survives is smaller: `zod-to-json-schema` is currently a **phantom dependency**,
   present only transitively through `@modelcontextprotocol/sdk`, so phase 1 must declare it
   before importing it.
3. **`settingSources: []` changes what the model reads.** Today's headless runs may be
   inheriting the operator's CLAUDE.md. Making them deterministic is right, but it changes
   verdict inputs and must be A/B'd on real prompts, not assumed neutral.
4. **Transcript continuity, which replaces the risk of losing transcripts.** Persistence stays
   on, so the risk inverts: if the SDK one-shot writes its `.jsonl` anywhere other than where
   `headlessTranscriptDir()` looks, the sweep quietly stops covering headless runs and the
   directory grows forever. Silent in exactly the way `prune.ts:48-54` documents from the last
   time this went wrong.
5. **`spendReportIsRecordable` drops a report with no `runId`.** The SDK's `session_id` must be
   captured off the result frame, or six role-tagged sites stop appearing in the automation
   line silently.

## Adjacent findings, not in scope

- **A latent bug in the live SDK driver - now owned, fixed in its own PR.** `SDK_PERMISSION_MODES`
  (`sdk.ts:135-142`) accepts `bypassPermissions`, but the vendor requires that mode to be paired
  with `allowDangerouslySkipPermissions` (`sdk.d.ts:1777`), which the driver never passes. This
  affects interactive sessions today, is not gated on any phase here, and by decision ships
  separately rather than riding this migration.
- **Six `?? "claude"` sites** in Foreman and the Inspector drop the `MISSION_LLM_RUNNER` env
  layer, contradicting a rule the codebase states explicitly three times
  (`foreman/config.ts:180-183`). Worth its own small change.
- **`LlmLitterSpec` is declared and never consumed.** Either wire `goal/prune.ts` to it or
  delete it; today it is documentation that type-checks.
</content>
</invoke>
