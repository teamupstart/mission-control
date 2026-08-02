# Plan: Session Runtime Metadata - Model, Thinking Level, Context %

Status: implemented
Owner: ai-harness
Notes: Shipped as described, with one improvement (passive transcript effort scrape, see
"Implemented deviation" below) and one packaging boundary from the Electron move: the
packaged desktop app auto-wires only the passive path (transcript + Codex rollout, zero
config); the statusLine wrapper stays **CLI-opt-in** (`npm run install-statusline`) so the
app never silently rewrites a user's `statusLine` in `~/.claude/settings.json`.
Related: ccstatusline (the terminal status line we already read these values from);
[`../mission-report/plan.md`](../mission-report/plan.md) (the report can surface the same
fields once they exist on `Session`). Current user-facing behavior for the runtime row,
including its live effort picker, is owned by the README's
[Status line](../../README.md#status-line-optional) section.

## Goal

Show three new per-session facts on every card, the same ones ccstatusline shows in the
Claude Code terminal:

1. **Model** - e.g. `Opus 4.8` (with a `1M` marker for long-context variants).
2. **Thinking level** - the live reasoning effort: `low | medium | high | xhigh | max`,
   reflecting mid-session `/effort` changes.
3. **Context used** - the share of the context window consumed, as a percentage with a
   small pressure meter (green -> amber -> red as it fills).

These make the sessions legible at a glance: which agents are on the expensive model, who is
running hot on context (about to compact), and who is thinking hard. All three already
exist somewhere Claude Code / Codex can hand us - this plan is about **sourcing them
correctly per agent** and threading them onto the card with no new heavyweight machinery.

## Where each value comes from (the crux)

ccstatusline does not compute most of this; **Claude Code hands it over** on the statusLine
command's stdin. Codex has no such mechanism, so we tail its rollout file. Summary:

| Value            | Claude - primary (statusLine payload)        | Claude - fallback (transcript JSONL)                          | Codex (rollout JSONL)                                             |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Model            | `model.display_name` / `model.id`            | `message.model` (id only)                                     | `turn_context.payload.model`                                     |
| Thinking level   | `effort.level`, `thinking.enabled`           | **not available** (not in the transcript)                     | `turn_context.payload.effort`                                    |
| Context %        | `context_window.used_percentage` (exact)     | sum `usage` input+cache / window size (approximate)           | `token_count` `info.total_token_usage.total_tokens / model_context_window` |
| Context window   | `context_window.context_window_size`         | infer from `[1m]` suffix, else 200000                         | `token_count` `info.model_context_window`                        |

Key facts that drive the design:

- The **statusLine stdin payload** is the gold source for Claude: it carries all three,
  pre-computed and live, keyed by `session_id`. `context_window.used_percentage` matches
  Claude Code's own accounting exactly (the transcript sum is a slight underestimate - it
  misses system-prompt + tool-schema overhead). `effort.level` is the **only** reliable
  source of thinking level; the transcript does not contain it. (ccstatusline itself only
  gets thinking level by scraping a `Set model to ... with X effort` line out of the
  transcript, which it documents as unreliable with multiple concurrent sessions and which
  misses `xhigh`. Our payload is keyed by `session_id`, so we avoid that ambiguity.)
- The **transcript JSONL** (`~/.claude/projects/<slug>/<id>.jsonl`) is a good *passive*
  fallback we already read (`src/server/transcript.ts`). It yields Model + an approximate
  Context% with zero install, but never thinking level.
- **Codex** exposes all three in its rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`),
  but we have no reader today - this is the long-deferred "codex transcript tailing".

**Precedence:** statusLine (authoritative, live) > transcript (approximate). We record the
`source` + `updatedAt` on the metadata so the passive transcript poller never clobbers a
fresh statusLine value. Codex has a single source.

## Data model

```ts
// src/shared/types.ts
export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type MetaSource = "statusline" | "transcript" | "codex-rollout";

export interface SessionMeta {
  /** Friendly model name for the chip, e.g. "Opus 4.8". Null if unknown. */
  model: string | null;
  /** Raw id, e.g. "claude-opus-4-8[1m]" / "gpt-5-codex" (tooltip + 1M inference). */
  modelId: string | null;
  /** true when the model runs a 1M context window (drives the "1M" marker). */
  longContext: boolean;
  /** Live reasoning effort; null when the model has no effort parameter. */
  thinkingLevel: ThinkingLevel | null;
  /** Whether extended thinking is on (Claude statusLine only; null otherwise). */
  thinkingEnabled: boolean | null;
  /** Share of the context window used, 0-100, rounded to an int (null if unknown). */
  contextPct: number | null;
  /** Absolute tokens in context + window size, for the tooltip. */
  contextTokens: number | null;
  contextWindow: number | null;
  source: MetaSource;
  /** epoch ms these values were observed (drives fallback precedence + TTL). */
  updatedAt: number;
}
```

Add to `Session` (`src/shared/types.ts:42`):

```ts
  /** Model / thinking-level / context-usage, from statusLine, transcript, or rollout. */
  meta: SessionMeta | null;
```

`contextPct` is stored **rounded to an integer** so the value only changes (and only emits
an SSE update) when the displayed percentage actually moves - no churn from sub-percent
drift.

## Backend changes

### 1. Claude - statusLine forwarder (primary; opt-in install)

Claude Code runs the configured statusLine command on every UI render and pipes the rich
JSON on stdin. We register a tiny **wrapper** that forwards the fields we want and then
delegates to the user's real status line so the terminal is visually unchanged.

- **`src/shared/harness-statusline.mjs` (new)** - reads stdin JSON once, then does two
  things with it:
  1. Fire-and-forget `POST ${BASE_URL}/statusline` with `{ sessionId, cwd, env, model,
     contextWindow, effort, thinking, ts }` (token header + `captureTerminalEnv()`, reusing
     `src/shared/harness-runtime.mjs` exactly as the hook does). Same contract as the hook:
     be fast (<~300ms abort), swallow all errors, never block the terminal.
  2. Exec the **wrapped** status line command (default `npx -y ccstatusline@latest`,
     configurable / auto-detected from the existing `statusLine.command`), re-feeding it the
     same stdin, and pass its stdout straight through - so what the user sees is byte-for-byte
     what they see today. If the wrapped command is missing/fails, print a minimal fallback
     line and still exit 0.
- **`hooks/install.mjs`** - extend the (opt-in, idempotent, non-destructive) installer to
  set `statusLine` in `~/.claude/settings.json`:
  - Read any existing `statusLine.command`; **store it** so the wrapper delegates to it
    (if it's already ccstatusline, we wrap ccstatusline; if custom, we wrap that).
  - Write `statusLine.command` = our wrapper, `statusLine.type = "command"`.
  - Record the original in the installer's backup block so **uninstall restores it exactly**.
  Guardrail: same opt-in path as hooks; a test run uses a temp settings file, never the
  user's real one.
- **`POST /statusline` route** (`src/server/routes.ts`, next to `/hooks/:event`) - token
  guarded via the same middleware. Validate with a new `StatusLineIngestSchema`
  (`src/shared/protocol.ts`, mirroring `HookIngestSchema` + `EnvSchema`), then call
  `registry.applyStatusLine(parsed.data)`.
- **Binding** to a discovered session: prefer exact match on `session_id` -> `agentSessionId`;
  fall back to the tmux/wezterm pane env (`EnvSchema`), exactly like `applyHook`. As a side
  benefit this also stamps `agentSessionId` / `instrumented` for sessions the hooks haven't
  bound yet.

### 2. Claude - transcript fallback (passive; zero install)

Extend `src/server/transcript.ts` (which already resolves + tail-reads the transcript):

- **`readRuntimeMeta(path): { modelId, contextTokens, contextWindow, contextPct } | null`** -
  bounded tail read (reuse `readRange` + the `TODO_TAIL_BYTES` pattern), scan newest-first for
  the most recent **main-chain** assistant record (skip `isSidechain` and `isApiErrorMessage`,
  like `toMessage` at `transcript.ts:87`). From `message.model` + `message.usage` compute
  `contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  (output excluded, matching ccstatusline's "context length") and
  `contextPct = round(min(100, contextTokens / contextWindow * 100))`.
- **`parseContextWindowSize(modelId): number` (new, exported, pure)** - infer the window from a
  delimited suffix in the id (`[1m]`, `(1M)`, `1M context`, `200k context`): `k -> ×1e3`,
  `m -> ×1e6`; default `200000`. Also returns `longContext` (>= 1e6). Unit-tested. (Mirrors
  ccstatusline's inference; the statusLine path doesn't need it because the window size is
  in the payload.)

**Implemented deviation - the transcript *does* yield a thinking level.** The plan
originally assumed effort was unavailable passively. In practice Claude Code writes a
`Set effort level to <level>` (from `/effort`) or `Set model to … with <level> effort`
(from `/model`) echo into the transcript, so `latestEffortLevel` scrapes it newest-first -
the same heuristic ccstatusline uses. So a passive Claude session shows all three fields
when it has set effort explicitly. Caveats (why statusLine is still the authoritative
source): the echo can scroll out of the bounded tail we scan on a long session (then it
reads null = unknown, never wrong), and it only reflects an *explicit* `/effort`, not the
account default. Model + Context% are always in the tail, so those stay reliable passively.

### 3. Codex - rollout reader (net-new)

### 4. A single runtime-meta poller

### 5. `registry.ts`

Serialization is automatic: `registry.snapshot()` -> `JSON.stringify` already ships whatever
is on `Session` to the client (no DTO layer), so no SSE/endpoint change beyond the above.

## Frontend changes

- **`src/web/components/SessionCard.tsx`** - add a compact runtime row beneath the
  `card-meta` `<dl>` (`SessionCard.tsx:106`), only when `session.meta` is non-null:

  ```
  [ Opus 4.8 · 1M ]   [ ▸ xhigh ]   [ ███░░░░ 34% ]
  ```

  - **Model pill** - `session.meta.model`, with a subtle `1M` tag when `longContext`.
  - **Thinking pill** - `session.meta.thinkingLevel` (hidden when null, e.g. transcript-only
    Claude or a no-effort model); a small brain/spark glyph, tone rising with the level.
  - **Context meter** - a slim inline bar + `NN%`; tone `ok`/`warn`/`high` from `contextPct`
    (e.g. >= 70 amber, >= 90 red) to telegraph an impending compaction. Tooltip:
    `123k / 200k tokens`.
- **`src/web/lib/format.ts`** - `modelLabel(id): string` (map `claude-opus-4-8` -> `Opus 4.8`,
  `gpt-5-codex` -> `GPT-5 Codex`, strip the `[1m]` suffix into the separate `1M` tag),
  `thinkingLabel(level)`, `contextTone(pct)`. Pure + unit-tested. (The daemon can also set
  `meta.model` directly from `display_name` when statusLine provides it; `modelLabel` is the
  fallback for transcript/rollout ids that carry no display name.)
- **`src/web/styles.css`** - pill + meter styles on the existing palette, themed for light
  and dark. Meter is a 2-color track (used / free) with the tone applied to the fill.

## Edge cases

- **Un-instrumented Claude** (no statusLine, discovered passively): transcript fallback still
  lights up Model + approximate Context%; thinking pill simply absent. Sessions with no
  transcript yet -> `meta` null -> row hidden (no empty scaffolding).
- **statusLine must never break the terminal**: the wrapper passes the wrapped command's
  stdout through verbatim, swallows all errors, exits 0, and uninstall restores the original
  `statusLine.command` exactly. If ccstatusline isn't installed we still print a minimal line.
- **1M window inference (transcript path only)**: if a transcript's `message.model` lacks the
  `[1m]` suffix but the session is really on a 1M model, the transcript-derived context% reads
  ~5x too high. The statusLine payload's `context_window_size` avoids this entirely and takes
  precedence; the fallback is best-effort and labeled as such in the tooltip.
- **SSE churn**: `contextPct` rounded to int + `sessionEqual` gate => at most one update per
  whole-percent move.
- **Codex same-cwd ambiguity**: bind to the nearest-start rollout and cache; documented
  limitation.
- **On exit**: freeze the last-known `meta` (it's a historical read); the poller stops
  visiting exited sessions, so nothing goes stale-then-wrong.
- **Payload/version drift**: `context_window`, `effort`, and `thinking` are relatively new
  Claude Code fields; treat each as optional in `StatusLineIngestSchema` and degrade field by
  field (older CC -> no context_window -> we still take model, and the transcript poller fills
  context%).

## Testing

- **Unit**
  - `parseContextWindowSize`: `[1m]`, `(1M)`, `1M context`, `200k context`, bare id -> default.
  - `readRuntimeMeta` over a synthetic transcript: picks the most-recent main-chain assistant,
    excludes sidechain + api-error records, correct token math, correct pct + window.
  - `readRolloutMeta` over a synthetic rollout: latest `turn_context` model/effort + latest
    `token_count` -> pct; ignores earlier turns.
  - `StatusLineIngestSchema` accepts the real payload and rejects junk; partial payloads
    (missing `context_window`/`effort`) degrade cleanly.
  - Precedence: fresh `statusline` meta is not overwritten by a `transcript` tick; a stale one
    is refreshed.
  - `modelLabel` / `thinkingLabel` / `contextTone` mappings.
- **E2E (guardrailed - never touch the user's real `~/.claude/settings.json` or live sessions)**
  - Transcript path: point the resolver at a fixture transcript for a throwaway session;
    assert the card shows Model + Context%.
  - statusLine forwarder: pipe a captured real payload into `harness-statusline.mjs` against
    the daemon; assert the POST lands, the card shows all three (incl. thinking), **and** the
    wrapped command's stdout is emitted unchanged (terminal unaffected). Installer test targets
    a temp settings file and verifies backup/restore round-trips the original command.
  - Codex: fixture rollout under a temp `CODEX_HOME`; assert Model + effort + Context%.

## Rollout / install

- **Zero-install baseline**: Claude gets Model + approximate Context% from the transcript;
  Codex gets all three from its rollout. Works the moment the daemon runs.
- **Opt-in upgrade for Claude**: `npm run install-hooks` (extended) also installs the
  statusLine wrapper, unlocking the exact Context% and the thinking level, and is fully
  reversible. Consistent with the project's "active reporting is opt-in" guardrail.

## Out of scope (future)

- Cost / `$` and rate-limit gauges (also in the statusLine payload) - a natural follow-up
  once `SessionMeta` exists.
- Context-over-time sparkline; per-turn token deltas.
- Surfacing model/thinking/context in the roundup report markdown (trivial once on `Session`).
