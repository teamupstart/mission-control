# Phase 2 - `runClaudeSdkOneShot` behind a transport switch, off by default

## Outcome

The `claude` runner gains a second transport. The same eight daemon-side tool-less call sites can
run through one `query()` from `@anthropic-ai/claude-agent-sdk` instead of `claude -p`, selected
by config with an environment override, defaulting to today's behaviour. Turning it on buys real
cancellation, a spend ceiling, visible stderr, and deterministic settings.

Engineering value: one transport for one binary, and the end of a SIGKILL the daemon cannot
guarantee landed.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 1.** `LlmRunOptions.schema` must exist, because the SDK path
  renders that same rendered JSON Schema into `outputFormat`. Without it this phase would either
  invent a parallel option or ship an SDK path weaker than the `-p` path it is meant to replace.

## Scope

In scope: the new module, the transport switch and its config, and adoption by the tool-less
daemon-side callers (C1, C2, D1, D2, E1, E2, E3 in the source plan's table).

Explicit non-goals:

- **Tool grants.** `runClaudeSdkOneShot` refuses `opts.grant` outright in this phase. Phase 3
  owns it. Refusing is safe and loud; silently ignoring a grant is neither.
- **The Foreman worker.** Phase 4. Its four sites keep using `print` regardless of config until
  then.
- **Changing the default.** Phase 5.
- **Live progress.** The frame stream is read only far enough to find the result; intermediate
  `assistant` frames are deliberately not projected anywhere.
- **A settings UI.** Server-side config plus `envVar` only.

## Repository findings

### There is no bundling problem

The source plan called this the top risk. Investigation retired most of it:

- There is no `build:foreman`; `npm run build` bundles the daemon, Electron main/preload, the MCP
  server and the hooks (`package.json:23-31`).
- The daemon bundle already references the SDK as a lazy dynamic-import specifier rather than
  inlined vendor code - `grep -o "claude-agent-sdk[^\"']*" dist/server/index.mjs` yields
  `claude-agent-sdk/sdk.mjs`, which is the `import()` in `sdk-deps.ts:73` surviving esbuild.
- The interactive driver already ships in the packaged app, so that resolution is proven in
  production rather than assumed.

### The seam to reuse, not rebuild

`src/server/harness/claude/sdk-deps.ts` already owns the three things this module needs, and is
the only importer of the vendor package:

- `claudeExecutable()` (`:28-40`) - the pinned operator binary, throwing rather than degrading.
- `sdkSubprocessEnv()` (`:54-62`) - `process.env` minus `TMUX_PANE`, `WEZTERM_PANE`,
  `TERM_PROGRAM`, which is the same pane-identity subtraction `headlessEnv()` performs for the
  `-p` path and for the same reason.
- the lazy `query` import (`:72-101`).

Reuse them. A second importer of `@anthropic-ai/claude-agent-sdk` would fork the "which binary,
which env" answer that both paths must give identically.

### Transcript continuity is a requirement, not a side effect

Per the approved decision, `persistSession` stays on. `goal/prune.ts` derives the swept directory
from `HEADLESS_CWD` through `headlessTranscriptDir()` (`:59-67`), and the `realpathSync` in there
is load-bearing - macOS `tmpdir()` is a symlink, and without resolving it the sweep walks a
directory that does not exist, removes nothing, reports nothing and looks like it works
(`prune.ts:48-54`).

So the SDK one-shot must pass `cwd: HEADLESS_CWD`. If it spawns anywhere else, its transcripts
land outside the sweep and the directory grows forever, silently, in exactly the documented way.

### Context isolation changes mechanism

On `-p` the guarantee is three absent flags (`claude-cli.ts:155-176`). Under the SDK it is three
absent options: `resume`, `sessionId`, `forkSession`. Same property, different enforcement, and
it needs its own assertion because the existing one greps argv.

### Config conventions

- Read side `LlmConfigSchema` (`src/shared/protocol.ts:1757-1781`) uses `.catch(x).default(x)` so
  a blob written by a newer build degrades instead of throwing - `getLlmConfig()` is on the path
  of the settings route, the titler, the goal refiner and the digest at once.
- Write side `LlmConfigPatchSchema` (`:1789-1802`) is declared separately and strictly, so an
  unknown value is a 400 rather than a silent no-op. A new field must be added there explicitly
  or PATCHes carrying it are dropped.
- `getLlmConfig()` re-parses on every read (`src/server/llm/config.ts:30`), so an existing blob
  gains the new key with no migration.
- `LlmSettingsPanel.tsx` never enumerates config keys - it reads `config?.models[job]`,
  `status?.runner`, `status?.runners` - so an optional field with a `.default()` ships
  server-only without a UI change or a compile break.

## Implementation steps

1. **`src/shared/llm.ts`** - `export type ClaudeTransport = "print" | "sdk";` plus a
   `CLAUDE_TRANSPORT_ENV = "CLAUDE_TRANSPORT"` constant beside `LLM_RUNNER_ENV` (`:60`), following
   that split so the printed spelling cannot drift off the working one.

2. **`src/shared/protocol.ts`** - add to `LlmConfigSchema`:
   `claudeTransport: z.union([z.enum(["print","sdk"]), z.literal("")]).catch("").default("")`,
   and the strict twin in `LlmConfigPatchSchema`. Empty string means "not chosen here", matching
   how `runner` models the same idea.

3. **`src/server/llm/config.ts`** - a `claudeTransportChoice()` resolving config, then
   `envVar(CLAUDE_TRANSPORT_ENV)`, then `"print"`. Resolve **per call**, never at module load, so
   a settings edit takes effect on the next call rather than the next restart - the reason
   `llmRunnerChoice` is written that way (`:63-65`).

4. **`src/server/llm/claude-sdk.ts`** (new) - `runClaudeSdkOneShot(prompt, opts)`:
   - throws immediately if `opts.grant` is set, with a message naming phase 3;
   - `query({ prompt, options: { tools: [], settingSources: [], maxTurns: 1, cwd: HEADLESS_CWD,
     pathToClaudeCodeExecutable: await claudeExecutable(), env: sdkSubprocessEnv(),
     ...(opts.model && { model: opts.model }),
     ...(opts.schema && { outputFormat: { type: "json_schema", schema: opts.schema } }),
     abortController, stderr }})`;
   - an `AbortController` aborted by a `setTimeout(opts.timeoutMs ?? DEFAULT)`, replacing
     `killTree`;
   - iterates to the `result` frame, reads `structured_output` when a schema was passed and the
     result text otherwise;
   - registers itself in a module-level `live` set with a `killLiveRuns` that aborts every
     controller, and hooks `process.on("exit")` once - the same shape as `claude-cli.ts:67-87`
     and `codex.ts:13-41`, because `LlmRunner.killLiveRuns` is required, not optional.

   **Move, do not summarise, the load-bearing comments** from `claude-cli.ts:155-183`: why
   context isolation is a correctness property rather than a tidy default, why the pane env is
   stripped, why the tool default is empty. They are the asset; a rewrite loses the arguments.

5. **`src/server/llm/claude.ts`** - `claudeRunner.run` consults `claudeTransportChoice()` and
   delegates. Spend accounting is unchanged in shape: `claudeSpendReport` needs `session_id`,
   `total_cost_usd`, `usage` and `modelUsage`, all of which the SDK's `result` frame carries -
   `claudeEnvelopeModels` (`harness/claude/envelope.ts`) is already shared between the two
   transports because the CLI serialises one struct for both.

6. **`src/server/llm/index.ts`** - no change. `killLiveLlmRuns` iterates `LLM_RUNNER_IDS` and
   `claudeRunner.killLiveRuns` must now kill both transports' in-flight work.

7. **`docs/configuration.md`** - one row for `MISSION_CLAUDE_TRANSPORT`.

## Data, API and compatibility

- **No migration.** The config blob is a single `app_config` KV row re-parsed on every read.
- **No wire break.** `LlmStatus` is unchanged in this phase; the panel is untouched.
- **Downgrade safety.** An older build reading a blob containing `claudeTransport` drops it
  through `.catch("")` and runs `print`, which is the correct degradation.

## Tests and verification

- **`test/llm-runner-contract.test.ts`** - the existing fake-binary tests must still pass
  unchanged with the default config, proving `print` is untouched.
- **A new `test/claude-sdk-oneshot.test.ts`**, modelled on `test/claude-sdk-adapter.test.ts`'s
  `fakeDeps()`/`FakeQuery` pattern (`:37-134`), which scripts frames by hand and spends no tokens:
  - the options object passed to `query()` contains `tools: []`, `settingSources: []`,
    `maxTurns: 1`, and `cwd` equal to `realpathSync(HEADLESS_CWD)`;
  - it contains **no** `resume`, **no** `sessionId`, **no** `forkSession` - the SDK mirror of
    `test/llm-runner-contract.test.ts:119-132`;
  - `opts.schema` becomes `outputFormat: {type:"json_schema", schema}`;
  - a grant is refused before `query()` is called at all, asserted by the fake never being
    invoked;
  - a timeout aborts the controller rather than leaving the query running;
  - a `result` frame produces the same `LlmSpendReport` the `-p` envelope produces, asserted
    against the same captured fixture `test/llm-runner-contract.test.ts:207-254` uses.
- **Transcript continuity** - assert that the path the run reports is inside
  `headlessTranscriptDir()`, so `pruneHeadlessTranscripts` will find it. This is the exit
  criterion the approved transcript decision creates.

```sh
node --test --test-concurrency=2 --import tsx test/claude-sdk-oneshot.test.ts
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
```

## Merge and exit criteria

- All commands pass with the default (`print`) config, proving no behaviour changed for anyone
  who does not opt in.
- With `MISSION_CLAUDE_TRANSPORT=sdk`, the eight daemon-side tool-less sites produce verdicts of
  the same shape and ledger rows with the same roles, runIds and model breakdowns as `print`.
- `pruneHeadlessTranscripts` finds and ages out what an SDK run wrote.
- A grant is refused, loudly, with a message that names phase 3.

## Downstream handoff

Later phases may rely on:

- **`ClaudeTransport` and `claudeTransportChoice()`** as the single selector. Phase 3 and Phase 4
  extend what `sdk` covers; neither introduces a second switch.
- **`runClaudeSdkOneShot` refusing grants.** Phase 3 replaces that refusal with an
  implementation, and is the only phase permitted to.
- **The `live` set and `killLiveRuns` covering both transports.**
- **`cwd: HEADLESS_CWD`** as a fixed property. A later phase that changes it (phase 3 must, for
  the Inspector) owes the pruner an answer, exactly as the `-p` path already owes one
  (`claude-cli.ts:180-183`).

Later phases must not change:

- The absence of `resume`/`sessionId`/`forkSession`. This is a correctness property, not a
  default.
- `claudeEnvelopeModels` or the `role` semantics of `claudeSpendReport`.

## Cross-phase audit record

- **Written second.** Reconciled against Phase 1: this phase consumes `LlmRunOptions.schema`
  exactly as Phase 1 defines it - a rendered JSON Schema, not a Zod schema - which is why Phase 1
  types it `Record<string, unknown>`. No edit to Phase 1 was needed.
- Recorded against the source plan: the plan listed bundling as the top risk of phase 4 and
  implied this phase would carry `persistSession: false`. Both were corrected before writing -
  there is no worker bundle, and the approved decision keeps persistence on, which converts a
  phase-5 deletion into this phase's transcript-continuity exit criterion.
</content>
