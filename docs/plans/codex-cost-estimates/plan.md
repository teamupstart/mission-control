# Unified Claude and Codex API-equivalent cost estimates

Status: implemented
Owner: ai-harness (Mission Control)
Rendered: `plan.html` beside this file - open that for the review layout and data-flow diagram.

## Outcome

Mission Control should show one defensible API-equivalent estimate across Claude and Codex
without claiming that a Pro, Max, or ChatGPT subscription incurred that dollar charge.

The product term is **API-equivalent estimate**. Every priced card reads `≈$1.24`. Claude Code
calculates its request estimate and reports it over OTel; Mission Control applies a versioned
OpenAI Standard API price snapshot to Codex rollout usage. The fleet strip combines both into
`estimated cost today`, `estimated rate`, and `cost / PR`, while retaining estimator provenance
on each session and ledger row.

Both sources are estimates. With subscription authentication they are replacement value, not
a bill. With API-key authentication they are closer to billed cost but remain non-authoritative.
Claude can include provider-priced server tools; Codex rollouts do not preserve every billing
modifier or separately billed hosted-tool charge.

## Decisions

### D1 - call the figure API-equivalent, never spend

Chosen: add a cost basis to every session and ledger summary:

```ts
export type CostBasis = "reported" | "api-equivalent" | "unpriced";
```

- Claude OTel dollars are `reported`, meaning client-calculated API equivalent.
- Priced Codex rollout usage is `api-equivalent`.
- Codex usage whose model has no known standard rate is `unpriced` and continues to render as
  tokens.

The UI uses `≈` for both priced variants. No tooltip, label, alert, or aggregate calls either
one "spent". The basis records who estimated the row, not a different economic meaning.

### D2 - ingest requests, not the latest cumulative total

Chosen: each Codex `token_count.info.last_token_usage` becomes one durable ledger event.

The existing live chip reads `total_token_usage`, which is correct for a cumulative token
badge but insufficient for pricing. Request-level records are required because:

- a `/model` change can put several model rates in one rollout;
- GPT-5.6's long-context multiplier is decided per request;
- daily and hourly totals need the event's timestamp rather than the last time the cumulative
  counter happened to be polled;
- cache writes and cache reads need separate rates; and
- summing `reasoning_output_tokens` separately would double-charge it because it is already
  included in `output_tokens`.

### D3 - rollouts are the primary source; Codex OTel is not required

Chosen: extend the passive rollout integration already used for model, context, messages,
activity, tokens, and quota.

Codex can emit OpenTelemetry logs, including response-completed token counts, but Mission
Control currently receives Claude metrics at `/v1/metrics`; it has no `/v1/logs` receiver and
does not edit `~/.codex/config.toml`. Requiring that opt-in would lose operator-started Codex
sessions and duplicate data already in the rollout. OTel can be revisited if it later exposes
an authoritative cost or service-tier field that rollouts do not.

### D4 - combine estimates; keep quota separate

Chosen fleet vocabulary:

| Figure | Included data |
|---|---|
| `estimatedCostToday` / `estimatedBurnPerHour` | every known Claude and Codex estimate |
| `tokensToday` | every priced or unpriced Claude and Codex ledger event |
| `cost / PR` | combined estimate over every proven PR opened by either agent |
| plan runway | provider quota windows only; never derived from dollars |

Claude's exported dollar metric is also a locally calculated API/provider-rate estimate, not
subscription spend. Combining the two therefore gives one coherent replacement-cost total.
If any row in a time window is unpriced, the total is null and the UI says `partial` rather
than presenting the known subtotal as complete.

### D5 - no new opt-in switch

Chosen: ingest and estimate whenever Mission Control can read a Codex rollout.

The existing Cost toggle is off by default because it edits the user's Claude settings. Codex
rollouts are already read every four seconds and their token count already appears on cards.
Applying a local rate table adds no new external write, credential, network call, or telemetry
export. Settings should explain the estimate, not gate it behind a second switch.

### D6 - unknowns fail visibly, not through fallback prices

Chosen:

- An unknown model remains `unpriced`; never price it as Sol, as the current catalog default,
  or as the nearest name.
- Standard service tier is the explicit assumption. Do not inspect global auth state and call
  the result actual.
- Unattributed subagent rollouts may contribute to a separate fleet bucket only after the
  rollout proves their identity; they never attach to a parent card by cwd or timing.
- A price-table update is append-only by version. Existing ledger rows retain the dollars and
  pricing version calculated when they were ingested.

## Evidence that motivated the implementation

### What Codex records

Current Codex 0.145.0 rollout `token_count` records contain both cumulative and last-request
objects with:

```jsonc
{
  "input_tokens": 32258,
  "cached_input_tokens": 28416,
  "cache_write_input_tokens": 0,
  "output_tokens": 695,
  "reasoning_output_tokens": 475,
  "total_tokens": 32953
}
```

`turn_context` supplies the exact model and reasoning effort. `session_meta` supplies the
conversation id, model provider, cwd, source, and subagent marker. The rate-limit object
supplies plan/quota state, but not a per-session dollar charge.

### What Mission Control did before this implementation

- `src/server/harness/codex/rollout.ts::parseRolloutUsage` reads the newest cumulative usage,
  separates cached input, output, and reasoning output, hardcodes cache writes to zero, and
  returns `costUsd: null`.
- `src/server/runtime-meta.ts` sends that passive usage to
  `Registry.applyPassiveUsage`.
- `Registry.applyPassiveUsage` deliberately updates only the live in-memory `Session.cost`;
  it never writes `usage_ledger`.
- `CostChip` renders an unpriced `48k tok` pill in Cards, Console/Board detail, and the Board
  tile. The rail has no notable-cost mark while dollars are absent.
- Fleet cost, rate, token, and cost/PR queries read only `usage_ledger`, so Codex contributed
  to none of them.
- `README.md`, `Session.cost` comments, and `COST_UNSUPPORTED` still claim Codex has one opaque
  `tokens_used` scalar. That prose predates the richer rollout reader and is now false.

### Standard pricing assumptions

The first price snapshot supports the models currently offered by `MODEL_CATALOG.codex`:

| Model id | Input / MTok | Cached input / MTok | Output / MTok |
|---|---:|---:|---:|
| `gpt-5.6-sol` | $5.00 | $0.50 | $30.00 |
| `gpt-5.6-terra` | $2.50 | $0.25 | $15.00 |
| `gpt-5.6-luna` | $1.00 | $0.10 | $6.00 |
| `gpt-5.5` | $5.00 | $0.50 | $30.00 |

GPT-5.6 cache writes cost 1.25x uncached input. Requests above 272K input use the model's
documented long-context input/output multipliers. The table is intentionally not derived from
the picker: a model being launchable and a model having a measured price are different facts.

Official sources for this snapshot: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5), and
[GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).
Codex's distinction between ChatGPT and API-key billing comes from the official
[authentication guide](https://learn.chatgpt.com/docs/auth).

## Scope

### In scope

- Per-request Codex usage parsing from append-only rollout JSONL.
- A versioned standard API price registry and pure estimator.
- Durable, retry-safe Codex rows in `usage_ledger`.
- Exact session attribution through `session_meta.id` / discovered `agentSessionId`.
- A 30-second final drain window after a rollout stops being live.
- Session cost provenance and pricing-version metadata.
- One completeness-aware Claude + Codex fleet estimate and combined cost/PR.
- Cards, Console, Board detail, Board tile, Console/Board rail marks, Settings copy, and README.
- Current-day/hour aggregation across daemon restarts.
- Honest degradation for unknown models, malformed records, file replacement, missing session
  identity, and unprovable subagent ownership.

### Out of scope

- Claiming ChatGPT plan credit consumption in dollars.
- Fetching live prices from the internet or storing an OpenAI API key.
- Reconciling estimates against an organization invoice or Usage dashboard.
- Estimating separately billed hosted-tool calls.
- Backfilling all historical rollouts on first install.
- Repricing persisted history when OpenAI changes a rate.
- Guessing a parent for an unlinked subagent by cwd, start time, or nearest process.
- Changing cost attention/danger thresholds.

## Architecture

```mermaid
flowchart LR
  C[Claude OTel\nclient estimate] --> L
  R[Codex rollout JSONL] --> U[Harness usage reader\nbyte cursor + active model]
  U --> E[Usage events\nlast_token_usage]
  E --> P[Versioned standard\nAPI estimator]
  P --> L[(usage_ledger\nbasis + price version)]
  E --> L
  L --> S[Session summary\nreported | API eq. | unpriced]
  L --> F[Fleet rollup\ncombined or partial]
  S --> B[Shared CostChip\nall three layouts]
  S --> M[Rail notable-cost mark]
  F --> T[FleetStrip]
```

The existing runtime metadata poll remains harness-neutral. It asks a new optional server-side
usage capability on the selected harness; it never tests `session.agent`. Claude declares the
capability `null` because Claude's writer remains OTLP metrics. Codex supplies the JSONL reader
and estimator.

## Detailed design

### 1. Shared cost vocabulary

Change `SessionCost` in `src/shared/types.ts`:

```ts
export type CostBasis = "reported" | "api-equivalent" | "unpriced";

export interface SessionCost {
  costUsd: number | null;
  basis: CostBasis;
  pricingModels: string[];
  pricingVersions: string[];
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningOutput?: number;
  updatedAt: number;
}
```

Invariants:

- `reported` has a non-null `costUsd`, no pricing versions, and represents Claude Code's
  client-calculated API-equivalent estimate.
- `api-equivalent` has a non-null `costUsd` and lists every exact model and pricing version
  represented in the session. Arrays are required because `/model` can change one rollout and
  a long-lived session can cross a price-table release.
- `unpriced` has `costUsd: null`; `pricingModels` still names every observed model and
  `pricingVersions` lists any priced rows present before the unknown one.
- `reasoningOutput` is informational and remains a subset of `output`.

Replace the split fleet fields with:

```ts
estimatedCostToday: number | null;
estimatedBurnPerHour: number | null;
```

These fields combine every known Claude and Codex row. Null means at least one row in the
window is unpriced; zero means there were no priced or unpriced rows in the window.

This changes an existing event payload, not the `ServerEvent` discriminant. The existing
`cost_fleet` case remains valid, but fixtures and snapshot defaults must supply the fields.

`Session.cost` remains the one existing session field, so no new comparator is needed;
`SESSION_FIELD_COMPARATORS.cost = byJson` already covers the nested additions.

### 2. Harness usage capability

Add a server-only capability in `src/server/harness/types.ts`:

```ts
export interface UsageCursor {
  offset: number;
  modelId: string | null;
  discardPartial: boolean;
}

export interface HarnessUsageEvent {
  identity: string;
  ts: number;
  modelId: string | null;
  querySource: "main" | "subagent" | "auxiliary";
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoningOutput: number;
}

export interface UsageRead {
  events: HarnessUsageEvent[];
  cursor: UsageCursor;
  more: boolean;
  reset: boolean;
}

export interface UsageSpec {
  read(path: string, cursor: UsageCursor, maxBytes: number): UsageRead;
  estimate(event: HarnessUsageEvent): PricedUsage | null;
}
```

Add `usage: UsageSpec | null` to `Harness`, not to shared browser capabilities: it performs
filesystem reads and has no browser consumer. `HARNESSES.claude.usage = null` and
`HARNESSES.codex.usage = codexUsage` make support compiler-enforced. Add a `usageFor(session)`
selector beside `transcriptFor` and `hooksFor`.

Do not overload `TranscriptPassiveRead.usage`. That field remains the cheap latest-cumulative
summary used by the live token chip during rollout. Durable ingestion has cursors, multiple
events, retry identity, and catch-up behavior; pretending those are the same answer would make
the hot metadata read own database state.

### 3. Incremental rollout reader

Create `src/server/harness/codex/usage.ts`.

The reader:

1. Reads forward from a byte offset, capped at 1 MiB per tick.
2. Stops at the last complete newline and advances only across complete records.
3. Carries the last `turn_context.model` in the cursor so a restart at a nonzero offset can
   price the next token event without rescanning the head.
4. Emits one event for each `event_msg/token_count` with a non-null `last_token_usage`.
5. Computes uncached input as
   `input_tokens - cached_input_tokens - cache_write_input_tokens`, clamped at zero.
6. Preserves cached reads, cache writes, output, and reasoning output separately.
7. Uses the record timestamp for `ts`.
8. Builds the event identity from a SHA-256 of the record timestamp and exact raw line. The
   ledger's conflict key also includes the proven conversation id as `note_key`, so replaying
   a chunk upserts the same row without allowing two conversations to collide.
9. Treats a shorter file as `reset: true`. The orchestrator starts a new generation only when
   the session header proves a different conversation id. A shorter file with the same id is
   refused and logged for inspection; it never assumes an in-place rewrite is the same stream.
10. Skips malformed/incomplete lines and negative/non-finite token values without taking the
    whole session down.
11. Persists `discardPartial` while stepping over any non-usage record larger than the read
    budget, so one large tool payload cannot strand every later token event.

The first read for a live rollout starts at byte zero so a daemon restart recovers that active
session's earlier requests. The 1 MiB cap prevents a multi-megabyte rollout from blocking the
daemon; `more` schedules another chunk immediately rather than waiting a full poll interval.

### 4. Price registry and estimator

Create `src/server/harness/codex/pricing.ts` with no network or filesystem dependency.

```ts
export const CODEX_PRICE_VERSION = "openai-standard-2026-07-22";

interface StandardTokenPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
  cacheWriteMultiplier: number;
  longContextAfter: number | null;
  longInputMultiplier: number;
  longOutputMultiplier: number;
}
```

Use an exact `Record` for the four catalogued model ids plus explicit aliases/snapshots that
official pricing says are identical. Do not normalize unknown slugs heuristically.

Estimator rules:

- Select the rate from `event.modelId`; return null if absent/unknown.
- Decide long-context pricing from that event's full `input_tokens`, before tier subtraction.
- Price uncached input, cached reads, cache writes, and output once each.
- Include reasoning output only in the tooltip breakdown; never add it to output cost.
- Round only for display. Persist the full JS-number result, matching Claude OTel behavior.
- Store `pricingVersion` and `pricingModel` on every priced row.

One test fixture should be hand-checkable arithmetic for every model. Another should use a
>272K request and a nonzero cache write so the two easiest omissions cannot pass silently.

### 5. Durable cursors and ledger rows

Add a new table in `src/server/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS usage_sources (
  source_key   TEXT PRIMARY KEY, -- agent + conversation id
  agent        TEXT NOT NULL,
  offset       INTEGER NOT NULL,
  model_id     TEXT NOT NULL DEFAULT '',
  discard_partial INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
```

New tables need no migration. The cursor table contains no prompt, cwd, email, account id, or
tool data.

Add four columns to `usage_ledger`'s create block and, because it is an existing table, four
matching `addColumn` calls in `migrate()`:

```sql
cost_basis     TEXT NOT NULL DEFAULT 'reported',
cost_known     INTEGER NOT NULL DEFAULT 1,
pricing_version TEXT NOT NULL DEFAULT '',
reasoning_output INTEGER NOT NULL DEFAULT 0
```

Existing Claude rows become reported/known automatically. A Codex event writes all token
columns atomically with:

- `note_key`: proven conversation id;
- `session_id`: the current synthetic session id when live, provenance only;
- `agent`: `codex`;
- `model_id`: the model active for that request;
- `query_source`: `main`; separate subagent rollouts are not ingested in this version;
- `window_end_ns`: `codex:<event identity>`; text is already the dedup key;
- `ts`: rollout event timestamp;
- `cost_usd`: estimated value or zero when unpriced;
- `cost_basis`: api-equivalent or unpriced;
- `cost_known`: 1 or 0;
- `pricing_version`: the estimator snapshot or empty.

Add `commitUsageRead` rather than issuing six `upsertUsageCell` calls. It performs each
all-column event insert in one transaction with the cursor advance. On identity conflict, it
preserves the original tokens, dollars, basis, and pricing version and updates only missing
live-session provenance. That makes a replay safe and prevents a later rate-table release from
silently repricing history. A crash produces either both the event rows and new cursor or neither.

`sessionCostFor` returns `costUsd: null` if any row for the session has `cost_known = 0`.
Showing a partial dollar total as complete would be worse than retaining the honest token-only
chip. It still sums every token tier. It derives `basis`, the distinct pricing-model list, and
the distinct pricing-version list, and refuses a reported/API-equivalent mixed-basis note key
rather than silently naming one. An API-equivalent session with any unknown row summarizes as
`unpriced`; this is not the same invalid mixture as reported plus API-equivalent rows.

Ledger pruning remains age-only at 180 days. Prune `usage_sources` only when its source has not
updated for 180 days; an active source is never removed because its oldest event aged out.

### 6. Orchestration and session lifetime

Create `src/server/usage.ts` as the harness-neutral orchestrator and start it from
`src/server/index.ts` beside the runtime metadata poller.

Each tick:

1. Ask `registry.liveSessions()`.
2. Resolve the session's transcript and `usageFor(session)` through registries.
3. Require a path and proven `agentSessionId`; no synthetic/cwd fallback writes durable money.
4. Load the cursor by `agent + conversation id`.
5. Read and atomically persist one chunk.
6. Re-denormalize `Session.cost` through the existing `syncSessionsForCost(noteKey)`.
7. Recompute the fleet strip only when ledger-visible values changed.

Keep the last path/id binding for 30 seconds after a session leaves `liveSessions()` and keep
draining it during that window. This catches a final `token_count` written immediately before
or shortly after process exit. The grace map is bounded to recently live sessions and drops at
the TTL.

This poller is separate from `runtime-meta.ts`: catch-up reads can consume several chunks and
write SQLite, while metadata promises one bounded passive read per live session. Both still
ask harness registries and neither contains an agent-id branch.

### 7. Fleet queries

Replace the basis-specific dollar sums with one completeness-aware query:

```sql
SELECT SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) AS estimate,
       SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS unknown
FROM usage_ledger
WHERE ts >= ?
```

`fleetTokensSince` remains every row and therefore begins including Codex. Do not make token
visibility depend on price coverage. Return null when `unknown > 0`; never show the known
subtotal as a complete estimate.

Update `Registry.fleetCostNow` and recompute suppression for both unified fields.

### 8. UI and layout parity

Refactor `CostChip` to branch on `cost.basis`, not on agent:

- `reported`: `≈$1.24`; tooltip says Claude Code calculated the API-equivalent estimate.
- `api-equivalent`: `≈$1.24`; same tone thresholds; tooltip says Mission Control calculated it,
  model, price snapshot, tier counts, and that ChatGPT-plan billing differs.
- `unpriced`: existing `48k tok`; tooltip names the unsupported/unknown model rather than the
  false generic "Pricing unavailable."

Because `CostChip` is already the shared leaf, the figure reaches:

- `SessionCard` (Cards);
- `ConsoleDetail` (Console and Board detail); and
- `SessionTile` (Board overview).

The rail already asks `costIsNotable`; use one `≈$` mark for either estimator and do not create
a second threshold.

In `FleetStrip`:

- Show one `estimated cost today`, `estimated rate`, and combined `cost / PR`.
- Show `tokens today` when either provider has token rows, even if estimated cost is zero.
- Update `fleetStripHasContent`; an all-Codex fleet must not leave the fold toggle empty.
- If the daily estimate is null, show `partial`, retain tokens, and withhold cost/PR.
- Preserve the `view` ordering contract: plan meters can lead, but estimated dollars never
  masquerade as a plan meter.

Update `CostSettingsPanel` copy. The Claude switch still edits only Claude's settings; beneath
it, add a non-interactive explanation that both harnesses contribute API-equivalent estimates,
Codex estimates come from local rollouts automatically, and plan quota remains separate.

### 9. Subagents and unattributed usage

The main rollout is fully attributable through the discovered conversation id. Subagent
rollouts are separate files and are intentionally excluded from terminal-session discovery.

For this change:

- Ingest a subagent into a parent card only when Codex exposes an explicit parent-child edge or
  parent conversation id.
- Use `query_source = 'subagent'` and the parent's note key when that proof exists.
- If a subagent has its own session id but no proven parent, do not attach it to a card. A later
  fleet-only scanner may count it under its own key, but that is a follow-up and must dedup
  against anything the live collector already wrote.
- Never join on cwd, repo, model, timestamp proximity, or shared rollout directory. Wrong
  attribution is worse than an undercount.

The Codex tooltip says "main session" until attributed child usage is implemented and covered.
That limitation should be visible rather than buried in README prose.

### 10. Documentation cleanup

Update together:

- `README.md` Cost telemetry section: Claude OTel, Claude statusLine, and Codex rollouts priced
  by the versioned standard-rate snapshot, with one fleet meaning and API-equivalent caveat.
- `src/shared/types.ts` comments on `SessionCost` and `Session.cost`.
- `src/shared/cost.ts::COST_UNSUPPORTED`: Codex no longer unsupported; document unknown-model
  degradation instead of the obsolete scalar claim.
- `CostSettingsPanel` copy.

Do not describe the estimate as OpenAI-reported cost. OpenAI reports tokens; Mission Control
does the price arithmetic.

## File-by-file implementation map

| File | Change |
|---|---|
| `src/server/harness/types.ts` | Add server-only usage capability/event/cursor contracts. |
| `src/server/harness/index.ts` | Fill `usage` for every harness; export `usageFor`. |
| `src/server/harness/codex/usage.ts` | Parse append-only request usage with stable identities and byte cursors. |
| `src/server/harness/codex/pricing.ts` | Versioned standard rates and pure estimator. |
| `src/server/usage.ts` | Generic collector, chunk catch-up, final grace drain. |
| `src/server/index.ts` | Start/stop the collector. |
| `src/server/db.ts` | Ledger migration, cursor table, atomic event upsert, completeness-aware combined query. |
| `src/server/registry.ts` | Cost sync entry point, basis-aware session summary, unified fleet fields/equality. |
| `src/shared/types.ts` | `CostBasis`, provenance fields, nullable combined fleet estimate. |
| `src/shared/cost.ts` | Correct Codex support prose; keep one threshold decision. |
| `src/web/components/session-bits.tsx` | Basis-aware shared chip and tooltip. |
| `src/web/components/layouts/RailRow.tsx` | Basis-aware notable-cost mark/accessibility. |
| `src/web/components/FleetStrip.tsx` | Unified estimate/rate/cost-per-PR and partial state. |
| `src/web/components/CostSettingsPanel.tsx` | Explain both estimators and their shared meaning. |
| `README.md` | Replace obsolete no-tier/no-price claims and document semantics. |

No new route, Electron capability, overlay, build entry point, or `ServerEvent` variant is
needed.

## Verification

### Pure pricing tests - `test/codex-pricing.test.ts`

- Exact hand-calculated request for Sol, Terra, Luna, and GPT-5.5.
- Cached input uses the discounted rate.
- Cache writes use 1.25x input for GPT-5.6.
- >272K input applies long-context multipliers to that request only.
- Reasoning output is not added to output twice.
- Unknown, empty, and near-match model ids return unpriced.
- Pricing version is pinned.

### Rollout parsing tests - `test/codex-usage.test.ts`

- `last_token_usage`, not cumulative total, produces one event.
- Sequential requests sum correctly.
- A `turn_context` model switch prices later requests under the later model.
- Cursor resumes on a complete-line boundary and carries the active model.
- A record split across chunks is emitted once after completion.
- Replay emits the same identity.
- Cache-write tokens are separated from uncached input.
- Malformed, negative, non-finite, and missing-timestamp records degrade safely.
- File truncation/replacement returns reset rather than replaying against a stale cursor.

### Ledger tests - extend `test/usage-ledger.test.ts`

- Existing rows migrate to reported/known.
- One Codex event atomically advances cursor and upserts all tiers/cost metadata.
- Identical replay does not double count.
- Same timestamp with different raw records does not collide.
- Unknown-model tokens persist while session dollars remain null.
- Any unknown row prevents a partial session dollar total.
- Claude- and Codex-calculated rows enter one fleet sum.
- Any unpriced row makes that window's fleet estimate null rather than partial.
- Tokens include both bases and unpriced rows.
- Hour/day boundaries use event timestamps.
- Cursor pruning cannot remove an active source.

### Registry and lifecycle tests

- Add `test/usage-poller.test.ts` for catch-up,
  immediate session sync, multi-chunk drain, restart, `/clear` conversation rotation, and the
  final post-exit grace drain.
- Keep the existing regression that a hook cannot blank passive Codex usage.
- Prove missing `agentSessionId` never writes a durable money row.
- Prove a subagent without explicit parent evidence never lands on the root card.

### UI tests

- `test/session-leaf-parity.test.ts`: reported, API-equivalent, and unpriced `CostChip` output
  reaches all applicable layouts through the shared leaf.
- `test/fleet-strip.test.ts`: an all-Codex fleet renders the same estimate; combined cost/PR
  includes it; an unpriced row produces `partial` and withholds cost/PR.
- `test/agent-accent.test.ts`: no agent-specific CSS selector is introduced.
- Settings render test: Claude install switch remains scoped to Claude and Codex explanation is
  present.
- Accessibility assertions: `≈` chip and rail mark have complete labels without relying on
  hover.

### Repository gates

Run, in order:

```sh
npm test -- test/codex-pricing.test.ts test/codex-usage.test.ts test/usage-ledger.test.ts
npm test -- test/runtime-meta.test.ts test/fleet-strip.test.ts test/session-leaf-parity.test.ts
npm run typecheck
npm test
npm run build
```

## Rollout sequence

1. Add shared cost provenance and fleet fields, updating fixtures so typecheck describes every
   consumer.
2. Add the pure Codex price registry and exhaustive arithmetic tests.
3. Add the Codex usage reader and chunk/cursor tests.
4. Add ledger migration, cursor table, atomic upsert, and combined completeness-aware query.
5. Add the harness capability and generic collector with restart/final-drain coverage.
6. Replace the live cumulative-only writer with the ledger-backed session summary, retaining
   the unpriced fallback for unknown models.
7. Update `CostChip`, rail mark, unified FleetStrip, Settings copy, and layout/parity tests.
8. Update README and stale inline comments.
9. Run focused tests, full typecheck/test/build, then inspect one real live Codex card and
   compare its token arithmetic by hand against its rollout.

Steps 1-6 can land behind no new UI behavior until the basis-aware chip is ready. Do not briefly
ship API-equivalent dollars through the old Claude-only tooltip.

## Acceptance criteria

- A supported-model Codex session shows `≈$…` in every figure-bearing layout.
- The tooltip names standard API-equivalent semantics, exact model, token tiers, and pricing
  snapshot.
- An unknown-model session shows tokens and an explicit unsupported-price explanation.
- Model changes within one rollout price each request under the model that served it.
- Cache reads, cache writes, long-context requests, and reasoning output are treated correctly.
- Restarting the daemon or replaying a rollout chunk does not change totals.
- A completed session's rows remain in the 180-day ledger and its events contribute to the
  correct day/hour.
- Estimated cost today and rate include every known Claude and Codex row.
- Every priced card and rail mark uses the same `≈` vocabulary while retaining provenance in
  its tooltip.
- Tokens today includes both harnesses, including unpriced rows.
- Cost/PR uses the combined estimate and every proven PR opened by either agent.
- A window with any unpriced row reads partial and exposes no misleading dollar subtotal.
- No cwd/timing heuristic attributes a subagent to a parent.
- No new external config edit, credential, network dependency, vendor-specific UI branch, or
  duplicated layout leaf is introduced.

## Known limitations after implementation

- ChatGPT credits and plan quotas still cannot be converted to a per-session actual dollar
  charge.
- Standard rates do not represent API Priority, Batch, Flex, enterprise agreements, or future
  price changes.
- Separately billed hosted-tool calls are not included.
- Unlinked subagent work remains outside the parent card.
- Sessions that start and end while the daemon is completely stopped are not backfilled in v1.
- Rollout JSONL is an observed Codex contract rather than a public billing API; parser failures
  must remain isolated and observable.

These are tooltip/documentation facts, not reasons to weaken the estimate's provenance or fill
gaps with guesses.
