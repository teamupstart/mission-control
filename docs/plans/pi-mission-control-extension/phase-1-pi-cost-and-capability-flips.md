# Phase 1: Pi cost, and the two capability flips

Part of [Pi parity](plan.md) - see [phased-plan.md](phased-plan.md) for the graph.

## Outcome

A dispatched Pi session reports what it spent, on its card and in the cost ledger, the way a
Claude or Codex session already does. Pi also stops declaring two capabilities it was measured
to have: Foreman's work queue stops claiming a permanent incapacity and starts stating a
current fact (it becomes a fixable-install refusal later, once an install exists to point at -
see the handoff), and a multi-repo task may be dispatched to Pi.

## Entry criteria and dependencies

- **Direct prerequisite:** the planning session's pull request, which publishes this file.
- No other phase. This may run concurrently with Phases 2 and 3.

## Scope

1. `HARNESSES.pi.usage` - a `UsageSpec` reading Pi's session JSONL.
2. `HarnessUsageEvent` widened with a vendor-reported cost, and `UsageSpec.estimate` passing it
   through for Pi.
3. `MultiRepoDispatchSpec` turned into a discriminated union, with Pi declaring `no-boundary`.
4. `HARNESS_CAPABILITIES.pi.workQueue` flipped from `null` to `{ uninstrumentedWhy }`.
5. The tests and the one e2e spec that currently pin the old answers.

### Non-goals

- **Hand-run Pi cost.** Not reachable here; it belongs to Phase 4. See the finding below.
- Any change to how Claude or Codex usage is read or priced.
- `HARNESSES.pi.hooks`, which stays null until Phase 4.
- The Foreman worker's behavior. This phase changes what the capability *says*; Phase 4 is what
  makes a Pi queue actually run.

## Repository findings

### The usage poller is already harness-neutral, and needs `agentSessionId`

`startUsagePoller` (`src/server/usage.ts`) names no harness. It asks `usageFor(session)` and
`transcriptFor(session)`, skips a session with no `agentSessionId`, reads forward from a
per-source byte cursor, and refuses a source whose header id contradicts the session's
(`read.sourceId !== source.session.agentSessionId`). A Pi `UsageSpec` is a drop-in.

**Measured, and this is what bounds the phase.** `preparePiLaunch` passes
`--session-id <randomUUID>`, and Pi writes that id verbatim into both the filename and the
transcript's first line:

```
requested session-id: 591ab9d6-c481-43e9-8cc6-2ce639602117
file: 2026-09-10T11-37-03-987Z_591ab9d6-c481-43e9-8cc6-2ce639602117.jsonl
header: {"type":"session","version":3,"id":"591ab9d6-c481-43e9-8cc6-2ce639602117",
         "timestamp":"2026-09-10T11:37:03.987Z","cwd":"/private/tmp/pi-probe"}
```

So `read.sourceId` is that header's `id`, and a dispatched session attributes exactly.

A **hand-run** session has no `agentSessionId`, and cannot be given one passively.
`annotateCodexRollouts` (`src/server/discovery/codex-rollouts.ts`) is built entirely on the
rollout file the Codex process holds open, and Pi was measured **not to hold its session file
open**: driven over `--mode rpc` until `agent_settled`, with the file present on disk,
`lsof -a -p <pi pid> -Fn | grep jsonl` returned nothing. A cwd-plus-newest-file fallback is
rejected - the poller's own comment sets the rule ("cwd and a synthetic discovery id are never
enough to attach dollars to a card"), and two Pi sessions in one checkout are
indistinguishable under it. Phase 4's extension knows the id exactly
(`ctx.sessionManager.getSessionId()`), so hand-run cost waits for it.

### Pi's records already carry disjoint tokens and a priced cost

Measured, one assistant record:

```json
{"input":11,"output":22,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":33,
 "cost":{"input":0.000011,"output":0.000044,"cacheRead":0,"cacheWrite":0,"total":0.000055}}
```

Two consequences. Pi's tiers are **already disjoint**, so none of Codex's
`fullInput - cacheRead - cacheWrite` reconciliation applies - `codexTokenSplit` exists because
Codex reports `input_tokens` inclusive of the cached tiers, and copying that subtraction here
would understate every Pi row. And the cost is already computed.

### Pi cannot be re-priced locally

`MODEL_CATALOG.pi` (`src/shared/model.ts:138`) carries **no rates** - id, label, hint, provider,
context window, reasoning, input modes - and Pi is multi-provider across the thirty-odd
providers `pi --help` lists. A Mission Control price table for Pi would have to track all of
them, and would be wrong for any provider it missed. Pi's own `cost.total` is the only viable
source.

`UsageSpec.estimate(event)` receives only a `HarnessUsageEvent`, which has no cost field, so
the contract widens. `codex/usage.ts:109` and `llm/codex.ts:429` are the only two existing
constructors of that type.

### The empty `multiRepoDispatch` grant fails an existing test on purpose

`test/multi-repo-policy.test.ts:118` asserts that any non-null spec renders at least one flag
naming every directory, because "a spec that renders no flags would be a harness advertising a
grant it does not make, which is worse than declaring null". A literal `launchArgs: () => []`
fails it, and the test is right to fail it.

The decision (Pi is offered for multi-repo tasks) is kept; the shape changes so Pi declares
*why* it needs no flags. Consumers: `dispatcher.ts:366` and `codex/sdk.ts:1421` call
`launchArgs`; `DispatchModal.tsx:1196`, `task-repository-preparation.ts:78` and `tasks.ts:3120`
only test for null.

### Flipping `workQueue` is safe today

`foremanAutomationAuthorized` (`src/server/harness/index.ts:350`) refuses a terminal session
whose harness has `hooks: null`, which Pi still does after this phase. The browser half,
`workQueueBlockedReason`, returns `uninstrumentedWhy` while `hooksSeen` is false, so the panel
hides its add box - the two agree, which that function's comment requires. `hooksSeen` cannot
become true for Pi: `Registry.applyHook` returns immediately when `hooksFor(evt.agent)` is null
(`src/server/registry.ts:2890`).

`test/harness-capabilities.test.ts:156` keeps `BY_FIXTURE`, the list of capabilities with no
real null declarer. `workQueue` loses its last one here and must **move into** that list with a
`withCapabilityNull` fixture. The test is designed to fail first and say so; answer it, do not
edit around it.

## Implementation steps

### 1. `src/server/harness/types.ts` - widen the usage event

Add one optional field to `HarnessUsageEvent`:

```ts
/**
 * The cost the HARNESS itself computed for this request, when it publishes one.
 *
 * Null for a harness Mission Control prices from its own table, which is both shipped
 * harnesses: `estimateStandardApiUsage` values Codex from `STANDARD_TOKEN_PRICES`, and a
 * second source for the same row is how two numbers end up disagreeing on screen.
 *
 * Non-null only for a harness Mission Control CANNOT price. Pi is multi-provider across
 * every provider its installation is signed in to, and `MODEL_CATALOG.pi` carries no rates
 * at all - so a local table would have to track thirty providers and be wrong for the
 * thirty-first. Pi computes the cost from its own catalog and writes it into the record
 * this reader is already walking, which makes passing it through the only honest option.
 */
vendorCostUsd: number | null;
```

Not optional-with-a-default: the `Record`-style discipline in this repository is that a new
field forces every constructor to answer. Set it to `null` explicitly at
`codex/usage.ts:109` and `llm/codex.ts:429`.

### 2. `src/server/harness/pi/usage.ts` - the reader

New file, modelled on `codex/usage.ts` but simpler. Export `piUsage: UsageSpec`.

`read(path, cursor, maxBytes)`:

- Reuse the file-identity discipline `codex/usage.ts` already implements: hash or `fstat` the
  head to build the `cursor.fileId`, and return `reset: true` when the file is shorter than the
  cursor offset or its identity changed. Do not invent a second convention; lift the shared
  parts rather than copying them if that is cleaner.
- `sourceId` is the first line's `id`, from the `{"type":"session"}` record. Return `null`
  while that line has not been read rather than guessing - the poller treats null as "skip this
  pass", and a wrong id gets the source quarantined for the daemon's lifetime.
- Pin `version: 3`. A record shape from a future Pi version is a reason to return no events,
  not to misread the ones it has.
- Walk `{"type":"message"}` records whose `message.role === "assistant"` and which carry
  `message.usage`. Map straight across - `input`, `cacheRead`, `cacheWrite`, `output`,
  `reasoning -> reasoningOutput` - with **no** subtraction. Reject a record with a negative or
  non-finite tier the way `nonNegativeNumber` does.
- `identity` is the header `id`; `ts` is the record's `timestamp`; `querySource` is `"main"`
  (Pi has no subagent notion to distinguish).
- `modelId` is carried forward from the most recent `{"type":"model_change"}` record, which
  precedes the first message. Compose it as Pi spells it, `provider/modelId`, so it matches
  `MODEL_CATALOG.pi`'s provider-qualified ids.
- `vendorCostUsd` is `message.usage.cost.total` when it is a finite non-negative number, else
  null.

`estimate(event)` returns `null` when `vendorCostUsd` is null, else
`{ costUsd: event.vendorCostUsd, pricingModel: event.modelId ?? "", pricingVersion: PI_PRICE_VERSION }`.

`PI_PRICE_VERSION` names the source rather than a snapshot date, because the number is not
ours: something like `"pi-reported-v3"`, keyed to the session-format version this reader pins.
Whatever it is, it is immutable once a row carries it.

### 3. `src/server/harness/index.ts` - wire it

`usage: piUsage` on the `pi` entry, replacing `usage: null` at line 198.

### 4. `src/shared/harness-capabilities.ts` - the union and the two flips

`MultiRepoDispatchSpec` becomes:

```ts
export type MultiRepoDispatchSpec =
  | { kind: "flags"; launchArgs: (dirs: readonly string[]) => string[]; sdk: boolean }
  | { kind: "no-boundary"; why: string; sdk: boolean };
```

Claude and Codex gain `kind: "flags"` and are otherwise unchanged. Pi declares:

```ts
multiRepoDispatch: {
  kind: "no-boundary",
  why: "Pi has no sandbox and no write boundary to widen: measured against 0.85.1, its own `write` tool wrote an absolute path in a sibling directory from a session whose cwd was elsewhere, with no flag, no grant and no refusal. A secondary worktree is therefore writable by construction rather than by a grant - which is why this declares the reason instead of rendering flags that would not exist.",
  sdk: false,
},
```

`sdk: false` is honest and costs nothing: Pi has no embedded driver
(`HARNESSES.pi.sdk === null`), so no dispatch can resolve to it.

`workQueue` becomes:

```ts
workQueue: {
  // A STATEMENT OF FACT, not an instruction, and that is deliberate for as long as this
  // phase can merge alone. Nothing installable exists until the extension and its
  // reconciler land, so an operator who reads "install the Pi integrations" in the gap
  // is being told to press a button that is not anywhere in the app - which is worse
  // than the permanent-incapacity sentence this replaces, because at least that one was
  // true. The remedy arrives with the install; see the handoff below for who owns the
  // rewrite.
  uninstrumentedWhy:
    "Pi doesn't report its work lifecycle to Mission Control yet, so Foreman can't tell when a Pi session picks work up or finishes it, and anything queued here would never move.",
},
```

**The sentence must not name a remedy that does not exist yet.** This phase is scoped to merge
independently of Phases 4 to 6, so between this merging and the install shipping there is a
window in which Pi's queue is refusable and nothing can be done about it. State the fact and
stop. It must also not promise that a queue works today.

### 5. Update the two `launchArgs` call sites

`dispatcher.ts:366` and `codex/sdk.ts:1421` branch on `kind === "flags"` before calling
`launchArgs`. Neither should silently render nothing for a `no-boundary` spec - a
`no-boundary` harness needs no flags, and that is a different statement from a builder that
failed to produce them.

### 6. Answer the tests that were designed to fail

- `test/multi-repo-policy.test.ts` - the flag invariant applies only to `kind: "flags"`; assert
  that a `no-boundary` spec carries a non-empty `why`; replace the `pi === null` assertion at
  line 149 with the new declaration; leave the `["claude","codex"]` `sdk === true` loop alone.
- `test/multi-repo-dispatch.test.ts:293` and its comment at 225 - Pi is no longer the harness
  that refuses. Either repoint them at a fixture harness with `multiRepoDispatch: null`, or
  assert the new Pi behavior; do not delete the refusal coverage.
- `test/harness-capabilities.test.ts:156` - move `workQueue` into `BY_FIXTURE` and add its
  `withCapabilityNull` fixture. Update the comment, which currently says pi declares
  `workQueue` and `mcp` null "for real" - `mcp` still does, `workQueue` no longer.
- `test/repo-memory.test.ts:161` - its comment asserts Pi declares no `multiRepoDispatch`;
  correct it.
- `e2e/specs/multi-repo-dispatch.spec.ts:233` - **this is the UI change.** The dispatch modal
  now offers Pi for a multi-repo task. Update this spec to assert the new visible behavior, by
  role/label, and keep a case covering a harness that still cannot.

### 7. New tests

- `test/pi-usage.test.ts` - a fixture JSONL (header, `model_change`, user, assistant with
  usage, `toolResult`, second assistant) read forward from offset 0, then resumed from the
  returned cursor with one record appended. Assert the tiers are **not** subtracted, that
  `sourceId` is the header id, that `estimate` returns Pi's own `cost.total`, and that a
  shortened file returns `reset: true`.
- A case pinning that a `version` other than 3 yields no events.
- A case pinning that `foremanAutomationAuthorized` still refuses a Pi terminal session, and
  that `workQueueBlockedReason` returns `uninstrumentedWhy` for it - the two halves agreeing is
  the safety argument for this flip and should not rest on reading the code.

## Data and compatibility

No migration. `usage_ledger` rows gain Pi entries with `pricing_version = PI_PRICE_VERSION`; a
row's pricing version is already per-row, so nothing existing is reinterpreted.
`HarnessUsageEvent` is an in-process type, not a persisted shape.

`MultiRepoDispatchSpec` is a pure in-memory capability. `multiRepoDispatch` is not persisted,
so widening its type strands no stored value.

## Verification

```sh
npm run typecheck
npm run lint
node --test --import ./test/setup-state.mjs --import tsx test/pi-usage.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/multi-repo-policy.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/harness-capabilities.test.ts
npm test
npm run build && npm run test:e2e -- multi-repo-dispatch
```

Additionally, prove the reader against a **real** Pi session rather than only a fixture: run a
dispatched Pi task, then show the `usage_ledger` rows it produced beside the `cost` figures in
its session JSONL. A fixture proves the parser; only that comparison proves the mapping.

## Merge and exit criteria

- A dispatched Pi session's card shows a cost, and its ledger rows match Pi's own figures.
- A hand-run Pi session shows no cost, and that is documented as expected here rather than
  filed as a defect.
- `capabilitiesFor("pi").workQueue` is non-null; a Pi terminal session is still refused a queue,
  with the install sentence.
- The dispatch modal offers Pi for multi-repo tasks, covered by an updated e2e spec.
- Every check above passes; no assertion was deleted to make one pass.

## Downstream handoff

Later phases may rely on:

- `MultiRepoDispatchSpec` being a discriminated union with exactly these two variants. A third
  harness adds a variant only if it genuinely has a third answer.
- `HarnessUsageEvent.vendorCostUsd` existing and being `null` for Claude and Codex. **Phase 4
  must not populate it from the extension** - the transcript is the source, and a second writer
  would double-count.
- `HARNESS_CAPABILITIES.pi.workQueue` being non-null. Phase 4 flips `HARNESSES.pi.hooks` to a
  real spec, and that is what makes the queue reachable.
- **`uninstrumentedWhy` staying a statement of fact until a supported install actually exists.**
  Phase 4 produces the artifact but does not install it, so it stays factual there too.
  **Phase 5 is the earliest phase that may make this sentence actionable**, because it is the
  one that creates the install path; Phase 6 then refines it to name the Setup row. No phase
  may point an operator at an install that its own merge does not deliver.
- `piUsage` reading the transcript `locate` resolves. Phase 4's hand-run identity work is what
  makes `locate` answer for a hand-run session, and it needs no change here.

Later phases must not:

- Reintroduce an unconditional `launchArgs` on `MultiRepoDispatchSpec`.
- Price Pi from a local table.

## Cross-phase audit record

- **Written first**, so nothing precedes it to reconcile against.
- After Phase 2: no overlap. Phase 2 touches `standingInstructions` and the launch composer;
  the only shared file is `src/shared/harness-capabilities.ts`, where the two add disjoint
  slots to the same record.
- After Phase 3: no contradiction. Phase 3 adds `MissionToolsSpec` to the same record and does
  not read `workQueue`, `usage` or `multiRepoDispatch`.
- After Phase 4: one reconciliation, and it was moved **into** this phase rather than patched
  later. `uninstrumentedWhy` was originally drafted here as Codex's sentence ("Start Pi through
  Mission Control so its launch-scoped hooks are attached"), which would have been wrong twice
  over - Pi's hooks are machine-scoped once installed, and no install exists yet.
- **Review correction (r2).** The replacement for that sentence then named the Pi install, which
  has the same defect one step removed: this phase can merge alone, so an operator reading it
  before Phase 5 is told to do something with no button or command anywhere in the app. The
  sentence is now a statement of current fact, and ownership of the transition to an actionable
  one is stated in the handoff above rather than left to whichever later phase noticed. The
  same wording was corrected in `plan.md`, Phase 4 and Phase 6.
- After Phase 4: the hand-run cost gap is recorded here as a non-goal and owned there, so no
  requirement is unowned.
