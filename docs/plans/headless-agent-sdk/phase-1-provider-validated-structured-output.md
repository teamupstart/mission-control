# Phase 1 - Provider-validated structured output on the existing transport

## Outcome

A caller can hand `LlmRunner.run` a JSON Schema and have the **provider** guarantee the reply's
shape, instead of asking the model twice and hoping. On the `claude` runner this renders to
`--json-schema`, which the operator's CLI already supports. The two-attempt re-prompt ladder in
`runStructured` stops firing for the call sites whose schema can be rendered faithfully.

Engineering value: every structured headless call loses a wasted round trip on a JSON-syntax
miss, and the option that later phases need in order to pass `outputFormat` to the SDK comes
into existence here, on a transport that is already proven.

## Entry criteria and dependencies

- **Direct phase dependencies: none.** This is the root of the graph.
- Requires no SDK work and no transport work. It ships entirely on `claude -p`.

## Scope

In scope:

1. Declare `zod-to-json-schema` as a real dependency.
2. Add an optional `schema` to `LlmRunOptions` and render it on the `claude` runner.
3. Give `runStructured` a way to skip its second attempt.
4. Adopt it at the call sites whose Zod schema renders faithfully.

Explicit non-goals:

- **The Agent SDK.** Not imported, not referenced. Phase 2 owns it.
- **The three expensive schemas.** `VerdictSchema` (Foreman review), `PersonaVerdictSchema`,
  `TitleSchema` and `GoalSchema` are deliberately left on the existing ladder - see the findings
  below. Converting them is not this phase's job and may never be worth it.
- **Removing `parseModelJson` or its `safeParse`.** See the correctness finding below; this is
  the single most important thing this phase must not do.
- **Any UI.** The option is a server-side capability with no settings surface.
- `codexRunner` behaviour beyond ignoring the new option.

## Repository findings

These were measured against the tree, and two of them contradict what a reasonable reading of
the source plan would suggest.

### `zod-to-json-schema` is a phantom dependency

`zod-to-json-schema@3.25.2` resolves today at `node_modules/zod-to-json-schema`, but only as a
transitive dependency of `@modelcontextprotocol/sdk` (`package-lock.json:2001`). It is **not** in
`package.json` `dependencies`. Importing it without declaring it would work locally and on CI and
break the day the MCP SDK drops it. `npm run build:server` bundles with esbuild, so the code
would be inlined into `dist/server/index.mjs` with no import error to warn anyone.

Zod 4's built-in `z.toJSONSchema` is not an option: the repo imports classic v3 everywhere and
`require("zod").toJSONSchema` is `undefined` on the installed `zod@3.25.76`.

### The provider guarantees the INPUT shape; callers consume the OUTPUT type

This is the correctness constraint that shapes the whole phase. `parseModelJson`
(`src/server/llm/structured.ts:138-150`) ends in `schema.safeParse`, and several schemas produce
their value through transforms the provider cannot run:

- `TitleSchema` clamps through `titleLine` (`src/server/task-title.ts:63-65`).
- `GoalSchema` clamps four fields (`src/server/goal/prompt.ts:26-32`).
- `QueueVerdictSchema` sorts, slices and dedupes gaps (`src/server/foreman/queue-verify.ts:123-149`).
- `InspectorVerdictSchema` clamps through three `z.preprocess` calls (`src/server/inspector/verdict.ts:24,34,35`).

A schema-valid reply is therefore **still not** the value the caller wants. `safeParse` stays,
unconditionally, on every path.

### A schema-valid reply can still fail validation

`zodToJsonSchema` silently drops `.refine`, `.preprocess` and `.transform`. Measured against the
installed versions:

| Zod construct | Renders as | Lost |
|---|---|---|
| `.refine(fn)` | the base object | the predicate |
| `.preprocess(fn, inner)` | `inner` only | the preprocessing |
| `.transform(f).pipe(Y)` | `{"allOf":[input, Y]}` | the transform |
| `.catch(v).default(v)` | `default` keyword, field becomes non-required | - |
| `z.discriminatedUnion` | top-level `anyOf` | - |

So cross-field rules still fail after the provider is satisfied - `VerdictSchema`'s
`action:"answer" implies answer.text` (`src/server/foreman/verdict.ts:121-123`),
`PersonaVerdictSchema`'s byte cap (`src/shared/protocol.ts:2742`), and the post-transform
`min(1)` in `TitleSchema`/`GoalSchema` whose entire purpose is to make a whitespace reply fail
rather than be stamped `source:"model"` (`src/server/goal/prompt.ts:19-24`).

**Therefore the retry ladder is trimmed per call site, never globally.**

### Which schemas render faithfully

| Schema | Location | Verdict |
|---|---|---|
| `BacklogReportSchema` | `foreman/backlog-plan.ts:95-104` | clean |
| `CompactionSchema` | `workflows/context.ts:42-45` | clean |
| `PanelBallotSchema` | `shared/ensemble-strategies/panel-vote.ts:423-429` | clean |
| `BestOfNComparisonResultSchema` | `shared/ensemble-strategies/best-of-n.ts:284-289` | clean |
| `ConsensusResultSchema` | `shared/ensemble-strategies/consensus.ts:275-282` | clean |
| `TriageReportSchema` | `foreman/triage.ts:61-89` | lossy but safe (one `preprocess`) |
| `InspectorVerdictSchema` | `inspector/verdict.ts:23-48` | lossy but safe (output-side clamps) |
| `QueueVerdictSchema` | `foreman/queue-verify.ts:123-149` | lossy but safe (output-side transforms) |
| `TitleSchema`, `GoalSchema` | `task-title.ts:63`, `goal/prompt.ts:26` | **excluded** - `.pipe` idiom |
| `VerdictSchema`, `PersonaVerdictSchema` | `foreman/verdict.ts:101`, `protocol.ts:2721` | **excluded** - cross-field refines, discriminated union |

The five clean ones cover the entire ensemble review surface plus the backlog planner and
workflow context compaction. The three lossy-but-safe ones are worth adopting because the loss is
output-side only and `safeParse` still applies it.

### The envelope landmine

`unwrapEnvelope` (`src/server/llm/structured.ts:161-170`) returns `env.result` **only when it is
a string**, else hands back the input unchanged. If a `--json-schema` run ever returns `result`
as an object rather than a JSON string, this silently returns the whole envelope and
`parseModelJson` then matches the *envelope* against the reply schema. That must be pinned by a
test in this phase, because every later phase inherits it.

## Implementation steps

1. **`package.json`** - add `zod-to-json-schema` to `dependencies` at the version already in the
   lockfile. Do not add it to `devDependencies`; it ships in the daemon bundle.

2. **`src/shared/llm.ts`** - add to `LlmRunOptions`:
   ```ts
   /**
    * A JSON Schema the PROVIDER validates the reply against, when it can.
    *
    * It guarantees the reply's INPUT shape and nothing else: a caller still runs its own Zod
    * parse, because every clamp, sort and cross-field rule lives in a `.transform` or
    * `.refine` no provider can execute. A runner that cannot enforce a schema ignores this
    * rather than refusing - unlike `grant`, a dropped schema costs a retry, not a secret.
    */
   schema?: Record<string, unknown>;
   ```
   Keep it browser-safe: no `node:` imports, no Zod import here. The rendering happens at the
   call site, not in `shared`.

3. **`src/server/claude-cli.ts`** - accept `schema?: string` on `ClaudeRunOptions` and push
   `--json-schema <json>` into `args`. Document beside the existing flag argument why this one is
   safe to add where `--resume` is not: it constrains the output, never the context.

4. **`src/server/llm/claude.ts`** - render `opts.schema` to a JSON string and pass it through.

5. **`src/server/llm/codex.ts`** - ignore `opts.schema` with a comment saying why: `codex exec`
   has no equivalent flag, and a caller that silently got no validation still gets a correct
   answer through `safeParse`, so this degrades rather than refuses.

6. **`src/server/llm/structured.ts`** - append a sixth optional parameter:
   ```ts
   opts?: { shapeGuaranteed?: boolean }
   ```
   used only to trim `attempts` at `:94-97` to a single entry. Positional and last, so all
   eleven existing call sites compile unchanged. Do not thread the Zod schema through this
   module - `extract` is a caller-owned ladder by design (`:82-85`) and three callers pass
   something that is not `parseModelJson(raw, X)`.

7. **Adopt at the clean call sites**, each rendering its schema once at module scope with
   `zodToJsonSchema(S, { $refStrategy: "none" })` and passing both `schema` (into the bound run
   function's options) and `shapeGuaranteed: true`:
   - `src/server/ensembles/reviews/packet.ts:443-453`
   - `src/server/ensembles/reviews/panel.ts:276-283`
   - `src/server/foreman/backlog-plan.ts:313-323`
   - `src/server/workflows/context.ts:196-215`

8. **Adopt at the lossy-but-safe sites**, passing `schema` but **not** `shapeGuaranteed`, so the
   ladder still covers a `.refine` miss:
   - `src/server/inspector/worker.ts:820-826`
   - `src/server/foreman/queue-verify.ts:176-181`
   - `src/server/foreman/triage.ts:606-611` - note this one bypasses `runStructured` entirely and
     calls `parseModelJson` directly, so it gets the schema and no ladder change.

## Tests and verification

Add to `test/llm-runner-contract.test.ts`, which already drives both runners against fake
binaries that record argv:

- a run with `schema` renders `--json-schema` with the exact JSON, and a run without it renders
  no such flag;
- the Codex runner ignores `schema` and spawns anyway, asserted on argv;
- `unwrapEnvelope` returns the envelope's `result` string, and - the landmine - an envelope whose
  `result` is an **object** does not silently become the reply.

Add to a structured-output test:

- `runStructured` with `shapeGuaranteed: true` calls `run` exactly once on a parse miss and
  returns `failed`, where the default still calls it twice.

Commands:

```sh
node --test --test-concurrency=2 --import tsx test/llm-runner-contract.test.ts
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
```

`npm run build` and `npm run smoke` are required rather than optional here: this phase adds a
dependency that lands in `dist/server/index.mjs`, and `scripts/smoke-bundles.mjs` is the check
that the bundle still boots.

## Merge and exit criteria

- Every command above passes.
- `zod-to-json-schema` appears in `package.json` `dependencies`.
- The four clean call sites make one model call rather than two on a JSON-syntax miss,
  observable as a single `attempt: 1` row in `workflow_llm_calls` for compaction and in the
  ensemble evaluation rows.
- No call site's verdict shape changed. This phase adds a guarantee; it does not change what any
  reviewer decides.
- `docs/configuration.md` needs no change - nothing here is operator-configurable.

## Downstream handoff

Later phases may rely on:

- **`LlmRunOptions.schema` exists and is provider-agnostic.** Phase 2 renders the same value into
  the SDK's `outputFormat` rather than a CLI flag. Its type is deliberately
  `Record<string, unknown>` - a rendered JSON Schema, not a Zod schema - so the SDK path needs no
  conversion of its own.
- **`shapeGuaranteed` means "the provider validated the input shape".** It does not mean "skip
  `safeParse`", and no phase may reinterpret it that way.
- **The per-call-site adoption list.** A later phase must not globally set `shapeGuaranteed`,
  because the excluded schemas depend on the ladder.

Later phases must not change:

- `parseModelJson`'s `safeParse`, or any caller's `extract` function.
- The `StructuredAttemptObserver` contract - the ensemble and workflow ledgers classify
  `invalid_output` versus `infrastructure` off `finish()`.

## Cross-phase audit record

- **Initial (this phase).** Root of the graph; nothing to reconcile.
- Recorded against the source plan: the plan's phase 1 said "delivers Option A in full". The
  repository narrows that - three of twelve schemas cannot be rendered faithfully, so the ladder
  survives for them by design rather than by omission. The plan's framing that `--json-schema`
  "would delete `runStructured`'s re-prompt ladder" is true per call site, not globally.
</content>
