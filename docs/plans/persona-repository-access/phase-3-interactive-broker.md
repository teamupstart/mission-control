# Phase 3 - The interactive query broker, provider parity, and the review it changes

Source plan: `docs/plans/persona-repository-access/plan.md` (rendered at `plan.html`).
Index: `docs/plans/persona-repository-access/phased-plan.md`.

## Outcome

A Persona published with `repositoryAccess: "read"` reviews the change with the repository in
front of it. It asks for typed repository operations, ai-harness answers them against the exact
submitted state, and the reviewer returns its verdict having actually opened the files it cites.
Claude and Codex do this identically. If the repository is not available the attempt retries and
then blocks - it never quietly reviews the prompt alone. Every operation, denial and truncation is
visible in run detail.

## Entry criteria and dependencies

- **Direct phase dependencies: Phase 1 and Phase 2.** Both must be merged.
- From Phase 1: `PersonaSnapshot.repositoryAccess`, non-optional after parse.
- From Phase 2: `createRepositoryReader({ ..., audit: { runId, submissionId, nodeAttemptId }, recordQuery, ... })`
  and `execute(query, { round })`, the query/result/denial vocabulary, `REPOSITORY_QUERY_LIMITS`,
  and `WorkflowSubmission.reviewSnapshotOid`. **One reader per Persona attempt**: it carries the
  audit identity, so building it once per attempt rather than once per round or once per query is
  part of the contract, not an optimisation.

## Scope

In scope:

- The round envelope contract and its schema.
- The broker round loop, its budget accounting, its cancellation checks and its termination rule.
- Engine wiring: which attempts use the broker, and how a failure is classified.
- `workflow_llm_calls.round`.
- The `repository_access_unavailable` blocked phase and its operator-facing label.
- The `reviewContract` access-on variant and the Persona prompt's capability section.
- The built-in Persona Markdown correction and its regeneration.
- Run-detail rendering of the per-attempt repository summary.
- Bounded per-round `workflow_events` aggregates.
- Documentation for the behaviour, the cost model and the observability.
- Unit, runner-contract, integration and browser tests.

Explicit non-goals:

- No new repository operation, no change to a denial code, no change to validation or bounds. Those
  are Phase 2's and must not be re-implemented here.
- No `LlmToolGrant`, no `LlmRunOptions` field, no `runInThread`, no MCP wire. The whole point of
  the design is that none of these is needed.
- No change to the Persona setting, the override table, the snapshot schema or the publish path.
  Phase 1's.

## Repository findings this phase must respect

Re-verify at implementation; these were true at planning time.

- **The Persona attempt is one `runStructured` call** at
  `src/server/workflows/engine.ts:1018`, with `runner.run(request, { model, timeoutMs: PERSONA_TIMEOUT_MS, images })`,
  a `parsePersonaVerdict` extractor, and a `StructuredAttemptObserver` whose `start` hook already
  returns `false` once the run or submission stops being `running` - the cancellation seam this
  loop needs. `PERSONA_TIMEOUT_MS` is `envVar("WORKFLOW_PERSONA_TIMEOUT_MS") ?? 600_000`, and it
  is a **per-call** budget; a multi-round attempt needs an attempt-wide wall-clock budget as well,
  or eight rounds can hold a review-scheduler slot for eighty minutes.
- **Neither runner offers a second turn.** `runInThread` is `null` on both
  (`src/server/llm/claude.ts:168`, `src/server/llm/codex.ts:430`). The default Claude transport is
  the Agent SDK (`src/shared/llm.ts:72`), which pins `maxTurns: 1` for a tool-less schema-less run
  and budgets extra turns only when a schema is attached (`claude-sdk.ts:253`, and
  `test/claude-sdk-oneshot.test.ts:308` pins that). `codex exec` is one turn by construction.
  Attaching the round schema therefore *also* buys the turns the Claude SDK needs to emit a
  `StructuredOutput` call, which is a second reason to attach it rather than only a shape guarantee.
- **`structuredOutput` differs by provider**: `claudeRunner.structuredOutput` is
  `{ guaranteesInputShape: true }`, `codexRunner.structuredOutput` is `null`.
  `runStructured`'s `opts.shapeGuaranteed` is what skips the redundant JSON re-prompt; Codex falls
  back to the existing two-attempt ladder. `providerJsonSchema` (`src/server/llm/json-schema.ts`)
  is how a Zod schema becomes a provider schema.
- **`runStructured` is a two-attempt ladder over one prompt**, not a loop. This phase adds a loop
  *around* it, once per round, rather than modifying it - it is shared with Foreman, the Inspector,
  ensembles and context compaction.
- **`handleInfrastructureFailure`** records the attempt `error`, retries to
  `MAX_INFRA_ATTEMPTS = 3` with `retryBaseMs * 4 ** (attempt - 1)`, then fails the submission and
  sets the run `blocked` with a phase string. `CHECK_CLEANUP_UNRESOLVED_PHASE`
  (`engine.ts:92`) is the precedent for a distinct phase; `BLOCKED_PHASE_CLAUSES`
  (`src/web/workflows/run-model.ts:864`) is the label map, and an unmapped code degrades to raw
  text rather than `undefined`.
- **A verdict must never come from an infrastructure problem.** `parsePersonaVerdict` returning
  `null` is a parse failure, not a fail verdict, and `runStructured`'s `failed` arm is routed to
  `handleInfrastructureFailure`. The loop must preserve that separation exactly.
- **The prompt is `buildPersonaPrompt`** (`src/server/workflows/prompt.ts:30`), composing
  `reviewContract` (`src/shared/review.ts:79`), the persona guidance bounded by
  `REVIEW_LIMITS.guidance`, and evidence through `untrustedBlock` / `untrustedJsonBlock`.
  `REVIEW_SNAPSHOT_ONLY` currently says "do not look anything up". `reviewContract` is shared by
  four reviewers across two providers.
- **The shipped built-in guidance contradicts access.** `personas/code-quality-judge.md` states
  "You have no repository tools and the pull request does not exist yet". The Markdown is authored
  source compiled by `scripts/builtin-personas.ts` into
  `src/server/workflows/builtin-personas.generated.ts` via `npm run personas`; changing it changes
  `guidanceMarkdown`, which makes published snapshots of that built-in read as outdated through
  `personaSnapshotIsOutdated` (`test/builtin-personas-web.test.ts:153` pins that comparison), and
  `builtin-workflows.ts:75-79` requires a shipped workflow referencing a changed document to append
  a new built-in workflow version in the same commit.
- **The fake Claude already has the two mechanisms an e2e broker test needs**: behaviour steered by
  a marker planted in the Persona's published guidance (the `-p` prompt embeds
  `"# Published Persona guidance"` verbatim), and a per-invocation counter persisted in a file
  under `MISSION_HOME` "because each review call is its own process". It discriminates the two
  headless transports on `--setting-sources=` versus `-p`, so a round loop must be answered on
  **both** paths.
- **Run detail** is `src/web/workflows/WorkflowRuns.tsx` with `run-model.ts` behind it, and
  `workflow_events` payloads are bounded by `WORKFLOW_LIMITS.eventPayloadBytes` (64,000).

## Implementation steps

### 1. The round envelope - `src/shared/repository-query.ts` and `src/shared/protocol.ts`

- `PersonaReviewReply = { action: "query"; queries: RepositoryQuery[] } | { action: "verdict"; verdict: PersonaVerdict }`,
  in shared, beside the query vocabulary Phase 2 established.
- The Zod schema for it, reusing `PersonaVerdictInputSchema`'s tolerant shape from
  `src/server/workflows/verdict.ts` for the verdict arm so a reply that would have parsed as a
  bare verdict still parses inside the envelope. Bound `queries` by
  `REPOSITORY_QUERY_LIMITS.maxQueriesPerRound`.
- A **backward-compatible extractor**: a raw reply that is a bare `PersonaVerdict` (no `action`
  key) is read as `{ action: "verdict", verdict }`. Two reasons, and the second is the important
  one: it keeps a Persona with access **off** on a byte-identical prompt and a byte-identical parse
  path, and it means a model that ignores the envelope on the final round still lands its verdict
  instead of burning the attempt.

### 2. The broker - `src/server/workflows/repository-broker.ts` (new)

`runBrokeredPersonaReview({ basePrompt, runner, runOptions, reader, budget, observer, cancelled, audit })`
returning the same `StructuredResult<PersonaVerdict>` shape the engine already handles, so the
engine's success and failure paths do not fork.

The loop:

1. Round 1 prompt is `basePrompt`. Later rounds append a bounded, `untrustedBlock`-fenced
   transcript of prior `{ queries, results }` pairs.
2. Before each round: if `cancelled()` return a `failed` result naming cancellation; if the
   attempt-wide wall clock or `maxAttemptBytes` is exhausted, move to the forced-verdict round.
3. Call `runStructured` for that round with the envelope schema, `shapeGuaranteed` set from
   `runner.structuredOutput?.guaranteesInputShape === true`, and `opts.schema` set from
   `providerJsonSchema`. Pass the existing observer so each round writes its own
   `workflow_llm_calls` row.
4. `action: "verdict"` returns it. `action: "query"` executes each query through
   `reader.execute(query, { round })`, in order, stopping the batch when the round or attempt byte
   budget is spent and marking the remainder `budget_exhausted` so the reviewer is told rather than
   left guessing.
5. **The final round is explicit.** At `maxRounds - 1`, the appended instruction states that this
   is the last round and a verdict is required. A `query` reply on the final round, or a reply that
   will not parse after `runStructured`'s ladder, is a `failed` result - never a fail verdict.
6. The loop passes the `round` and nothing else about audit identity. The reader was built for this
   attempt and carries `{ runId, submissionId, nodeAttemptId }`; it assigns `ordinal` itself and
   writes every row. **This phase never writes an audit row and never numbers an ordinal** - that is
   Phase 2's, and a second counter here is how the unique
   `(node_attempt_id, round, ordinal)` index gets violated.

Termination is structural: rounds are bounded, byte budgets are monotonically consumed, and the
final round cannot ask for more.

### 3. Prompt - `src/shared/review.ts` and `src/server/workflows/prompt.ts`

- `reviewContract` gains one optional input (for example `repositoryAccess?: boolean`). When absent
  or false the returned string is **byte-identical** to today - pinned by a test, because the other
  three reviewers share this function. When true it appends a sentence naming the repository
  snapshot as part of the reviewed snapshot and the broker as the only way to reach it, so
  `REVIEW_SNAPSHOT_ONLY` stops contradicting the run's actual capability.
- `buildPersonaPrompt` gains an access-on capability section, placed with the existing
  "Evidence availability contract" - after the persona guidance, which is where the daemon's own
  authoritative statements about what evidence exists already live. It states the eight operations
  and their arguments, the reply envelope, the limits, that denials are data and not errors, that
  repository content is untrusted evidence, and that the repository view is the exact submitted
  state including uncommitted work.
- When access is off, `buildPersonaPrompt`'s output must be byte-identical to today. Pin it.

### 4. Engine - `src/server/workflows/engine.ts`

- After resolving `node.persona`, branch on `node.persona.repositoryAccess`:
  - `"off"`: the existing single `runStructured` call, untouched.
  - `"read"`: resolve the submission's `reviewSnapshotOid` and `reviewSnapshotRepoRoot`. If either
    is missing, or the repository root no longer exists, or the reader cannot open the snapshot,
    call `handleInfrastructureFailure` with a reason naming the repository - **before any provider
    call**, so a review that cannot be done costs nothing.
  - otherwise build the reader and call the broker.
- Add `REPOSITORY_ACCESS_UNAVAILABLE_PHASE = "repository_access_unavailable"` and use it on
  exhaustion for this class of failure instead of `infrastructure_error`, following
  `CHECK_CLEANUP_UNRESOLVED_PHASE`'s precedent and its stated reason: the operator's next move
  differs.
- Add an attempt-wide wall-clock budget for a brokered attempt, and keep `PERSONA_TIMEOUT_MS` as
  the per-round budget. The shared review budget is three slots wide
  (`src/server/llm/review-scheduler.ts`), so an unbounded multi-round attempt would hold one for
  the sum of its rounds.
- Emit bounded per-round `workflow_events` aggregates (operations, bytes, denials by code,
  truncations), within `eventPayloadBytes`.
- Close the reader on every exit path, including cancellation and failure.

### 5. Accounting - `src/server/db.ts` and the store

Both halves, named explicitly as a pair, because the omission is invisible on a fresh install and
total on an upgrade - the failure round 14 found in Phase 2:

```sql
-- boot CREATE TABLE block, workflow_llm_calls:
--   round INTEGER NOT NULL DEFAULT 1
```

```ts
addColumn(d, "workflow_llm_calls", "round", "INTEGER NOT NULL DEFAULT 1");
```

Comment the distinction that makes two integer columns necessary: `attempt` is the parse-retry
attempt **within** a round, `round` is the broker round. The store's row schema takes it as
optional-with-default so a pre-migration row still parses, and the observer writes it.

### 6. Built-in guidance - `personas/*.md`

Correct the sentences that assert the reviewer has no repository tools, replacing them with a
deferral to the runtime capability statement rather than a new claim in the other direction - the
document must read correctly whether or not an operator turned access on. Regenerate with
`npm run personas`. Because this changes `guidanceMarkdown`:

- published snapshots of those built-ins correctly read as outdated, and that is the honest signal;
- follow `builtin-workflows.ts:75-79` and append a new built-in workflow version in the same commit
  for any shipped workflow referencing a changed document;
- update `test/builtin-personas.test.ts`'s generated-module assertion and
  `test/seed-personas.test.ts` if either pins affected prose.

### 7. Run detail - `src/web/workflows/`

- `BLOCKED_PHASE_CLAUSES` gains `repository_access_unavailable: "repository unavailable"`.
- A per-attempt repository summary on the attempt detail: rounds, operations, bytes, denials by
  code, truncations, and the operation list with paths. This is what makes decision 11 usable
  rather than merely stored.
- A route to read the audit rows for an attempt, following the existing run-detail read shape.

### 8. Documentation

`docs/workflows.md`: what an access-enabled review does, the round and byte limits, the blocked
phase and its remedy, and the audit surface. `docs/models.md`: the round-loop cost model - a
brokered attempt makes up to `maxRounds` provider calls with a growing prompt, and prompt caching
absorbs most of the repeat. `docs/security.md`: the prompt-side half of the boundary (untrusted
fencing on fetched content, scrubbing, and the fact that a denial is reported to the reviewer).
`docs/event-stream.md` if the aggregate event kinds are enumerated there.

## Tests

- `test/workflow-contracts.test.ts`: the envelope union is exhaustive over `action`; a bare verdict
  extracts as a verdict arm; a `queries` array over the per-round bound is refused.
- `test/review-contract.test.ts` (or the nearest existing home): `reviewContract` with access off
  is **byte-identical** to the current string; with access on it names the repository and the
  broker; `buildPersonaPrompt` with access off is byte-identical to today.
- `test/llm-runner-contract.test.ts`: a brokered round passes **no** `grant` and **no** tools to
  either runner - the regression test that stops this feature sliding into a provider-tool grant;
  `shapeGuaranteed` is set from the runner's own `structuredOutput` and not from its id; the same
  envelope schema drives Claude and Codex, which is decision 2's regression test.
- `test/repository-broker.test.ts` (new), with a stub runner and the real reader over a fixture
  repository:
  - a two-round exchange - query, then verdict - produces the verdict and two
    `workflow_llm_calls` rows with `round` 1 and 2;
  - the loop terminates at `maxRounds` and a `query` reply on the final round is an infrastructure
    failure, never a fail verdict;
  - a reply that will not parse after the ladder is an infrastructure failure;
  - cancellation between rounds stops the loop and starts no further provider call;
  - per-round and per-attempt byte budgets stop a batch mid-way and mark the remainder
    `budget_exhausted`;
  - the audit rows carry the attempt's `{ runId, submissionId, nodeAttemptId }` and a `(round,
    ordinal)` sequence that is dense and unique - asserted by reading the rows back, and by
    checking the loop passes only `round` to `execute` so a second ordinal counter cannot appear
    here;
  - the reader is closed on success, failure and cancellation.
- `test/workflow-engine.test.ts`:
  - an access-off Persona takes the existing single-call path, byte-identically;
  - an access-on Persona with a valid snapshot completes a brokered review;
  - an access-on Persona whose submission has no snapshot oid never calls the provider, retries to
    `MAX_INFRA_ATTEMPTS`, and blocks in `repository_access_unavailable`;
  - the same for a repository root that no longer exists;
  - **no path produces a verdict without the repository** for an access-on Persona - the assertion
    decision 8 exists for;
  - a brokered attempt respects the attempt-wide wall clock.
- `test/workflow-security.test.ts`: fetched repository content arrives inside an `-untrusted`
  fence; a denial is present in the prompt as data with its code; no host path appears in any
  prompt section.
- **The boot-block/migration pair check and the general guard**, the same two Phase 1 and Phase 2
  carry: assert `round` appears in the `workflow_llm_calls` `CREATE TABLE` block **and** in a
  matching `addColumn`; and assert a migrated pre-feature database's `PRAGMA table_info` column set
  for that table **equals** a fresh database's. The second names no column and so cannot go stale.
- `test/workflow-db.test.ts` and a migration test: `workflow_llm_calls.round` exists on a fresh
  create and via migration, a pre-migration row reads as `1`, and two opens are idempotent.
- `test/builtin-personas.test.ts`, `test/builtin-personas-web.test.ts`,
  `test/builtin-workflows.test.ts`: the regenerated module matches the authored Markdown, and the
  outdated comparison behaves as expected for the changed documents.
- `e2e/specs/workflow-persona-repository-review.spec.ts` (new): create a Persona with access on and
  a guidance marker, bind and submit a workflow, and see the run reach a verdict that cites a file
  the diff never contained - the whole loop through the browser. Steer the fake with the existing
  marker channel and its per-invocation counter file, and answer the round protocol on **both**
  headless paths (`-p` and the SDK's `--setting-sources=`), because production uses the SDK by
  default. Also assert the run-detail repository summary shows the operations, and a second spec
  that a run blocked in `repository_access_unavailable` reads as "repository unavailable" rather
  than a raw phase code. Spend no model tokens.

Verification: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`,
`npm run test:e2e`. Focused runs use the loader preamble
`--import ./test/setup-state.mjs --import tsx`.

On macOS under `CODEX_SANDBOX=seatbelt`, `npm test` includes real Electron geometry tests: use the
repository-prescribed scoped outside-sandbox approval rather than bypassing the preflight or adding
Chromium flags. `npm run test:e2e` needs a successful `npm run build` first, and the Playwright
browser, which `npm install` does not fetch - `npx playwright install chromium` once per machine.

Spend no model tokens in `e2e/`: every agent binary is redirected at a fake, and a broker exchange
must be answered on **both** headless paths, since the fake discriminates `--setting-sources=` (the
Agent SDK one-shot, which is the production default) from `-p` (the print escape hatch).

## Merge and exit criteria

- An access-enabled Persona reviews with the repository, on both Claude and Codex, through the same
  code path.
- An access-off Persona's prompt and parse path are byte-identical to before this feature.
- A missing or unreadable snapshot retries and then blocks in `repository_access_unavailable`, with
  a readable operator label, and never produces a verdict.
- The loop terminates, is cancellable, and respects per-query, per-round, per-attempt and
  wall-clock budgets, marking every truncation.
- Run detail shows the operations, bytes, denials and truncations for a brokered attempt.
- Built-in guidance no longer asserts a capability the run may contradict, and the built-in
  workflow catalog is consistent with the regenerated documents.
- Documentation matches the implementation.
- All verification commands green.

## Downstream handoff

This is the final phase. What it establishes for future work:

- The broker loop is the only path from a reviewer to a repository, and adding a capability means
  adding an op to Phase 2's vocabulary and its reader - never widening a provider grant.
- `repositoryAccess` remains a two-value enum; a third mode is an append to
  `PERSONA_REPOSITORY_ACCESS_MODES` and a new branch in the engine, with no snapshot migration.
- Extending access to another reviewer (Inspector, ensemble, Check) reuses the reader and the
  broker; neither is Persona-specific by construction.
- The envelope's bare-verdict tolerance is a compatibility affordance and should not be removed
  without a replacement, because it is what keeps an access-off review on the historical path.

## Cross-phase compatibility audit

- **Against Phase 1**: consumes `PersonaSnapshot.repositoryAccess` and adds nothing to the
  snapshot, so the `.default("off")` compatibility argument is not re-opened. It owns the built-in
  Markdown correction and the `reviewContract` variant, which Phase 1 deliberately left alone so
  the drift signal fires with the behaviour that justifies it rather than a phase early.
- **Against Phase 2**: consumes the reader and the vocabulary without re-implementing a check,
  a bound, a scrub or an audit write. It **supplies** the attempt identity when it builds the
  reader and the `round` on each `execute`; it writes no row and assigns no `ordinal`. It converts
  Phase 2's non-fatal snapshot failure into a fatal one **only** for an access-enabled Persona -
  the asymmetry both files record, and the reason Phase 2 could merge first without risking an
  existing run.
- **Schema ordering**: `workflow_llm_calls.round` is the only migration here, appended after both
  earlier phases' entries. All three are `addColumn`/`CREATE TABLE IF NOT EXISTS`, so the composed
  `migrate()` is order-independent and idempotent, and a database upgraded across all three in one
  step lands the same schema as one upgraded phase by phase.
- **Reconciliation record**: the attempt-wide wall-clock budget was added here rather than in
  Phase 2 because it is a property of the loop, not of a read. `PERSONA_TIMEOUT_MS` keeps its
  meaning as a per-call budget so no existing single-call review changes.
