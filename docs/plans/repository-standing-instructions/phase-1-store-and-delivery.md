# Phase 1 - Store, resolution, and delivery

Part of [Repository standing instructions](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

The daemon can hold a machine-wide default plus per-repository standing instructions, resolve the
effective text for any checkout, and deliver it to every session Mission Control launches - by
system prompt where the harness and runtime have one, and as a prompt prefix where they do not.

At the end of this phase there is no dashboard editor; the store is driven over HTTP. That is
deliberate, and it is safe: the shipped default is empty and resolution returns nothing for every
repository, so **this phase merges with zero behavior change to any existing session**. Phase 2
adds the editor.

## Entry criteria and dependencies

- Direct phase dependencies: **none**. This is the first phase.
- `npm install` in the worktree (`node_modules` is not checked in).
- Read [`plan.md`](plan.md) for the approved goal and [`phased-plan.md`](phased-plan.md) for the
  three repository findings that correct it. Findings 1, 2 and 3 are owned here.

## Scope

- Shared schemas, constants and the resolved-view type.
- A `StandingInstructionsSpec` capability on the harness registry.
- The `app_config` store: read, compare-and-swap write, ETag.
- Longest-path-match resolution, boundary-safe.
- The three HTTP routes.
- Composition into the dispatch and assignment prompt seam.
- Delivery on all five live harness · runtime pairs, including the two channels not currently used.
- Tests for all of the above, and the docs those changes touch.

## Non-goals

- **Any browser code.** No settings category, no panel, no hook, no `api.ts` client, no CSS.
  Phase 2 owns all of it.
- **The standards bundle.** Decision `standards-bundle` is *sessions only*: do not touch
  `src/server/standards.ts` or its consumers in Foreman, the Inspector, or workflow personas.
- **Adopted sessions.** Decision `reach` is *Mission-Control-launched only*. Do not add an
  injection path into a live session, and do not modify `POST /api/sessions/:id/inject`.
- **The dashboard composer.** Messages typed into a running session stay untouched.
- A per-session or per-task override. Explicitly out of scope in the approved plan.

## Repository findings

Read [`phased-plan.md`](phased-plan.md) for the evidence. The three that shape this phase:

1. **A second `--append-system-prompt` flag silently discards the first.** The flag is
   single-value, not variadic, and the CLI has no self-repetition guard. Compose one value.
2. **`askChannelArgs` is all-or-nothing** (`src/server/ask-channel.ts:165-206`, returns `[]` on any
   failure) and is spliced unconditionally at `src/server/dispatcher.ts:520-529`. A standing
   instruction folded inside it would vanish whenever the MCP bundle is missing.
3. **Codex's `developerInstructions` is gated on `opts.mcp`** (`src/server/harness/codex/sdk.ts:1429`),
   so it is skipped on ordinary dispatches.

## Implementation steps

### 1. Shared contracts - `src/shared/protocol.ts`

Add the constants and schemas named in the phased plan's cross-phase contracts section. Follow
`WorktreesConfigSchema` / `WorktreesConfigPatchSchema` (`protocol.ts:2143-2208`) for shape,
`.strict()` usage, and the `null`-removes-an-override convention. Follow the Foreman instructions
block (`protocol.ts:1736-1790`) for the conflict message, conflict code and update schema.

`repositories` is keyed by resolved repository root or a path beneath one, `max(4_096)` per key,
bounded by `STANDING_INSTRUCTIONS_MAX_REPOSITORIES`.

Reading this file: the Bash grep wrapper misdetects it as binary and returns zero matches silently.
Use `command grep -a` or `sed -n`.

### 2. Resolution - a pure, shared function

Export `resolveStandingInstructions(config, repoRoot)` returning `ResolvedStandingInstructions`.

- Longest matching key wins. `~/ws/mono/packages/api` beats `~/ws/mono`.
- Match on the path **boundary**, not `startsWith`, so `/repo-backup` never matches `/repo`. Reuse
  the rule `src/shared/allowlist.ts` already defines rather than writing a second one.
- A key present with `""` resolves to `source: "repository"` and empty text - "send nothing here",
  which must beat the default. A key that is **absent** falls through to the default. This
  distinction is the same one `foreman/instructions.ts:82-88` documents for its stored-empty case;
  get it wrong and clearing a repository's box quietly reinstates the machine-wide text.

Keep it in shared, browser-safe code with no `node:` imports, so Phase 2 could render a preview
from the same function if it needed to. Phase 2 is nonetheless required to call the route.

### 3. The store - `src/server/instructions/config.ts` (new)

Model directly on `src/server/foreman/instructions.ts` (112 lines), which is the closest existing
thing: an `app_config` key, a SHA-256 ETag over a namespaced digest of the exact document, and a
synchronous compare-and-swap with no `await` between the read, the comparison and the write.

- `CONFIG_KEY = "instructions.standing"`.
- Hash with `utf16le` for the reason `foreman/instructions.ts:56-60` records: UTF-8 encoding
  collapses distinct lone surrogates onto the same replacement bytes, which would let two different
  documents share a CAS token.
- No migration. `app_config` is a schema-validated blob and zod defaults apply on every read.

### 4. Block rendering - `src/server/instructions/compose.ts` (new)

One function that turns resolved text into the delivered block, and one that composes the
multi-repo case.

- Heading: `## Standing instructions for this repository`.
- Multi-repo: one labelled block per attached repository that has rules, in the manifest's order.
  `intentWithRepoManifest` (`src/server/dispatcher.ts:1984-2024`) already emits that order; read it
  rather than re-deriving. Sending only the primary repository's rules would be the same laundering
  `taskReposAllowlisted` refuses for consent.
- Empty resolved text renders nothing at all - not an empty heading. A repository with no rules
  must produce a byte-identical prompt to today.

### 5. Composition into the prompt seam - the fallback path only

> **Exactly one delivery per session.** The block reaches an agent either out of band (step 6) or
> as a turn-one prefix (this step), **never both**. A pair with an out-of-band channel must not
> also be prefixed: the agent would read the same rule twice in its first turn, which is noise at
> best and, for a rule phrased as a prohibition, an invitation to treat the repetition as emphasis
> about something the operator only said once.

`withTaskKindContract` (`src/server/task-contract.ts:133`) is the single seam, reached from
`dispatcher.ts:417` and `tasks.ts:2970`. Every `TaskKind` passes through it.

So the composition is **conditional on the resolved harness and runtime**:

- The pair **has** an out-of-band channel (claude terminal, claude sdk, codex sdk) - compose
  nothing here. Step 6 carries it.
- The pair has **none** (codex terminal, pi terminal) - the block is a **prefix above the intent**,
  in the same position and for the same reason as the repo manifest: `task-contract.ts:127-133`
  states that the operator's own words stay the exact prefix and server-owned material follows.
  This text *is* the operator's words.

Order within the prefix, when it applies: repo manifest, then standing instructions, then the
intent. The manifest tells the agent which checkouts exist; the instructions are about them.

**One decision, read once.** Whether a pair has a channel is `StandingInstructionsSpec` (step 6),
so this step must ask that spec rather than re-deriving the answer from an agent name or a runtime
string. Two independent readings of "does this pair have a channel" are exactly how a future
harness ends up either double-delivered or silently undelivered - the same drift
`dispatcher.ts:490-506` already warns about for Pi's text, and the reason
`extraDirArgs` reads its spec once instead of asking twice.

The runtime is known before this runs: `dispatcher.ts` resolves it before provisioning and forks to
`dispatchEmbedded` at `:458-469`, so both arms can pass the resolved pair into composition.

### 6. Delivery - the harness capability

Add `StandingInstructionsSpec` to `src/shared/harness-capabilities.ts` beside
`PermissionModeSpec` and `EffortSpec`, keyed by runtime:

```ts
export interface StandingInstructionsSpec {
  /**
   * How this harness carries operator text that is not a conversation turn, per runtime.
   * A runtime absent from the record has no such channel - the text is composed into turn one.
   */
  outOfBand: Partial<Record<SessionRuntime, OutOfBandDelivery>>;
}
```

Never branch on an agent name at the call site. The whole point of the registry is that
`harnessFor(agent)` answers this.

Then wire the five pairs:

**`claude · terminal` - the Finding 1 and 2 refactor.** Extract the system-prompt append from
`askChannelArgs` so that:
- exactly **one** `--append-system-prompt` flag is ever emitted, carrying a composed value;
- the ask-channel redirect keeps its existing all-or-nothing tie to the MCP flags - that contract
  is correct and must not be weakened;
- the standing instruction is emitted **even when the ask channel bails**, because a missing MCP
  bundle has nothing to do with it.

The cleanest shape is a small composer above the argv assembly at `dispatcher.ts:520-529` that
collects prompt-append contributions and renders the single flag, with `askChannelArgs` returning
its redirect text separately from its MCP/tool flags. Preserve the `missionMcpRegistered` check at
`dispatcher.ts:539` - it reads `askArgs.includes("--mcp-config")` and must keep working.

Extend `test/ask-channel.test.ts` (141 lines) rather than starting a new file.

**`claude · sdk`.** Pass `systemPrompt: { type: "preset", preset: "claude_code", append: text }`
in the options object at `src/server/harness/claude/sdk.ts:1114-1181`. A bare `string` **replaces**
the Claude Code prompt - the preset object is the only non-destructive form. Omit the option
entirely when there is no text; do not pass an empty `append`.

**`codex · sdk`.** Join the existing merge at `src/server/harness/codex/sdk.ts:1443-1444`, which
already composes the operator's configured `developer_instructions` with Mission Control's review
text. Per Finding 3, **ungate the `config/read` + merge for the standing-instruction case** so it
arms whenever there is text; keep the existing review instruction gated on `opts.mcp`. The value
lives on the mutated `LaunchConfig`, so it survives `clearContext` (`codex/sdk.ts:569`) and
`thread/resume` (`:1456`) for free - verify that, do not assume it.

**`codex · terminal` and `pi · terminal`.** No channel. The text is already in the composed prompt
from step 5; confirm nothing strips it. Pi's turn one rides the argv via `preparePiLaunch`, which is
what makes it assertable in Phase 2's e2e spec.

### 7. Routes - `src/server/routes.ts`

Three routes, modelled on `/api/foreman/instructions` (`routes.ts:2895-2915`):

- `GET /api/instructions` → the view.
- `PUT /api/instructions` under `bodyLimit` with a `413` handler; `409` with `{error, code, current}`
  on a stale `expectedEtag`.
- `GET /api/instructions/resolved?repoRoot=&agent=&runtime=` → the resolved text, the matched key,
  and the delivery mechanism.

  **`agent` and `runtime` are required, and validated.** The mechanism is a property of the pair,
  not of the repository - the same text is a system prompt on `claude · terminal`, developer
  instructions on `codex · sdk`, and turn-one prose on `pi · terminal` - so a route that took only
  `repoRoot` could not answer the question Phase 2's dispatch marker asks it. Reject an unknown
  `agent` with `400` rather than defaulting, and reject a `runtime` the harness does not offer:
  `resolveSessionRuntime` already owns that degradation and the answer must not be invented here.
  The mechanism comes from the same `StandingInstructionsSpec` the composer reads, so the marker
  and the delivery can never disagree.

Every repository key written through the PUT must be resolved through the same door every other
per-repo config uses: `resolveRepoPath` / `resolveRepoRoot` (`src/server/repos.ts:119-151`). That is
what keeps a `~/.treehouse/...` pool path out of durable config. Refuse a key that does not resolve
with a `400`, the way `PUT /api/pipelines/config` already does (`routes.ts:5087-5100`).

The resolved route is what Phase 2's preview and dispatch marker read, so that the browser never
reimplements the matching rule.

## Tests

Add to `test/`, using `node:test` and `node:assert/strict`. Run a single file with the loader the
suite uses:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
```

`--import ./test/setup-state.mjs` is not optional - see `AGENTS.md`.

| Area | Cases |
|---|---|
| Resolution | longest match wins; `/repo-backup` does not match `/repo`; empty-string override beats the default; absent key inherits; the character cap |
| Composition | the block is a prefix above the intent and below nothing; **a repo with no rules produces a byte-identical prompt to today**; multi-repo emits one labelled block per attached repo in manifest order |
| Delivery | each of the five harness · runtime pairs carries the text by its declared mechanism; **exactly one `--append-system-prompt` flag is emitted**; the standing instruction still ships when `askChannelArgs` returns `[]`; Codex's merge preserves a configured value and arms without `opts.mcp` |
| **Exactly-once** | for every one of the five pairs, the block appears in **exactly one** channel: a pair with an out-of-band channel has it there and **not** in turn one, a pair without has it in turn one and nowhere else. Assert on the composed prompt and the launch payload together, so neither a double send nor a silent drop can pass |
| Store | ETag changes with the document; a stale `expectedEtag` performs no write; empty-vs-absent round-trips |
| Routes | `409` carries the current view; oversize body is `413`; an unresolvable repo key is `400`; an unknown `agent` or an unsupported `runtime` is `400`; the resolved route's reported mechanism matches what the composer actually did for that same pair |

The byte-identical case is the decisive regression guard for the whole feature. Write it first.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
```

`npm run build` and `npm run smoke` because runtime surfaces changed. No e2e in this phase - there
is no UI yet; Phase 2 owns the browser proof.

## Merge and exit criteria

- All five harness · runtime pairs deliver by their declared mechanism, each proven by a test.
- A repository with no standing instructions dispatches a byte-identical prompt and argv to `main`.
- The three routes behave as the cross-phase contract states, including CAS and the size limit.
- `docs/configuration.md` documents the `app_config` key and the cap.
- Typecheck, lint, tests, build and smoke green; one reviewable pull request merged.

## Downstream handoff

Phase 2 may rely on, and must not change:

- The wire types and the three routes exactly as the cross-phase contract states them.
- Absent-means-inherit, empty-means-send-nothing, `null`-in-a-patch-removes.
- Longest-path-match on the resolved repository root, boundary-matched.
- Compare-and-swap on `expectedEtag`, with `409` carrying the current view.
- `resolveStandingInstructions` as the one matching implementation. Phase 2 calls the resolved
  route; it does not re-derive the match in the browser.

Phase 2 owns everything under `src/web/`, the settings registry entry, the search index entry, the
two read-only markers, and the e2e spec.

## Cross-phase audit record

- **Initial pass.** Phase 1 owns all three repository findings, because each is a daemon-side
  correction and Phase 2 cannot compensate for any of them from the browser.
- The `resolveStandingInstructions` placement in shared, browser-safe code was chosen so Phase 2 has
  the option of a local preview, while the handoff still requires it to call the route - keeping one
  answer on the wire and one implementation of the rule.
- The store's empty-vs-absent distinction is fixed here rather than in Phase 2 because the panel's
  `override` / `inherited` chip and its **Use global default** button are a direct rendering of it.
  Deciding it later would mean a browser control inventing a semantic the store does not have.
- Composition order (manifest, then instructions, then intent) is fixed here so Phase 2's
  **Preview** button and dispatch marker can quote the delivered text without guessing.
