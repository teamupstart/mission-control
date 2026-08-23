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
- The three configuration HTTP routes, plus the snapshot read route.
- Composition into the dispatch and assignment prompt seam, which are different occasions and not one.
- Delivery on all five live harness · runtime pairs, including the two channels not currently used.
- A per-session snapshot of what was actually delivered, written at launch and never rewritten.
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

`repositories` is keyed by a canonical repo-rooted path - a repository root, or a path beneath one
for a monorepo package - `max(4_096)` per key,
bounded by `STANDING_INSTRUCTIONS_MAX_REPOSITORIES`.

Reading this file: the Bash grep wrapper misdetects it as binary and returns zero matches silently.
Use `command grep -a` or `sed -n`.

### 2. Resolution - a pure, shared function

Export `resolveStandingInstructions(config, repoPath)` returning `ResolvedStandingInstructions`.

- **`repoPath`, not `repoRoot`, and the name is load-bearing.** The argument is the *canonical
  repo-rooted path* of the checkout being matched, which is a repository root only when the
  operator named one. A session in `~/ws/mono/packages/api` must be matched as
  `~/ws/mono/packages/api`; hand this function that session's repository root instead and
  `~/ws/mono` is the only key that can ever match, which makes the longest-match rule below
  decorative. Callers get the argument from `resolveRepoPath(cwd).path` (step 7), never from
  `resolveRepoRoot`.
- **The `cwd` is the session's, not the task's.** A task is always rooted at a repository's main
  checkout, so resolving against `Task.repoRoot` would make every subdirectory key unreachable
  even after step 7 stores it correctly. `src/server/workflows/checks.ts:217-231` already answers
  this exact question for check commands, and its comment is the instruction here: it uses
  `resolveRepoPath` *"so Settings and resolution agree about what 'inside the repository' means;
  **they were two answers to one question before.**"* Take both `cwd` and `repoRoot` the way
  `defaultCheckoutSubpath` does, discard a `cwd` whose repository is not the session's, and match
  on the re-rooted path.
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
intent. The manifest tells the agent which checkouts exist; the instructions are about them - which
is why the order is asserted as all three positions and not just "above the intent".

#### Launch resolves. Assignment repeats.

The rule above is about a **launch**. `withTaskKindContract` is reached from two seams and only one of
them is one: `dispatcher.ts:417` starts a process, `tasks.ts:2970` injects into a session that is
already running. An assignment has no argv to append to, no `query()` options to set and no
`thread/start` to carry a value - so step 6 has nothing to hook, and the rule as stated so far would
send an assigned task **no standing instruction at all** on the three pairs that have a channel.

The fix is not a second out-of-band path. It is that an assignment does not resolve anything:

| Occasion | What happens |
|---|---|
| **Launch** (`dispatcher.ts:417`) | Resolution runs. Out of band if the pair has a channel, prefix if it does not. The result is recorded in the snapshot (step 8). |
| **Assignment**, pair **has** a channel | Compose nothing. The block is still installed on that process and that checkout - that is what "durable" means, and it is the same fact that makes the snapshot survive `/clear`. |
| **Assignment**, pair has **none** | Prefix **the snapshot's text**, not a fresh resolution. A prefix is turn-one prose that can be compacted away and does not govern later turns - the approved decisions table says exactly this - so it has to be repeated, and it has to be repeated *unchanged*. |
| **Assignment**, no snapshot row | Nothing. A session launched without a standing instruction does not acquire one mid-life. |

**Why an assignment must not re-resolve.** The repository cannot have changed: `assign` refuses a
multi-repo task and resolves the session's own checkout (`tasks.ts:2953-2956`). The only thing that
can have changed is the configuration - and a live process's system prompt cannot be rewritten, so
re-resolving would give `claude · terminal` one mid-session semantic and `pi · terminal` another, for
the same feature, with the reach block left to explain the difference. One boundary instead, stated
product-wide:

> **A session keeps the standing instructions it launched with. An edit takes effect on the next
> session, not a running one.**

Phase 2 renders that sentence in the panel. It is also what makes the session chip true by
construction: the snapshot is not a parallel record of what was delivered, it **is** what an
assignment delivers.

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

Three configuration routes, modelled on `/api/foreman/instructions` (`routes.ts:2895-2915`).
The snapshot read route is step 8's, and sits with the session routes rather than here:

- `GET /api/instructions` → the view.
- `PUT /api/instructions` under `bodyLimit` with a `413` handler; `409` with `{error, code, current}`
  on a stale `expectedEtag`.
- `GET /api/instructions/resolved?repoPath=…&agent=&runtime=` → a `StandingInstructionsDelivery`.

  **`repoPath` repeats, once per attached repository, in the launch manifest's order.** A launch
  composes a labelled block for *every* attached repository that has rules (step 4), so a route
  that previewed only the one the operator picked would tell a two-repo dispatch that nothing will
  be sent while the launch sends the second repository's rules - a marker lying in the one
  direction that costs an operator the most, because a marker saying "nothing" is the reason they
  stop looking. Compose the response with the **same `compose.ts`** the launch uses, over the same
  ordered list, so the preview cannot drift from the delivery. Zero `repoPath` values is a `400`;
  more than the manifest's own cap is a `400`.

  **The response is the same type the snapshot stores.** That is deliberate: `what will be sent`
  and `what was sent` are one shape, so Phase 2 renders both markers through one component and
  neither can acquire a field the other lacks.

  **`agent` and `runtime` are required, and validated.** The mechanism is a property of the pair,
  not of the repository - the same text is a system prompt on `claude · terminal`, developer
  instructions on `codex · sdk`, and turn-one prose on `pi · terminal` - so a route that took only
  `repoPath` could not answer the question Phase 2's dispatch marker asks it. Reject an unknown
  `agent` with `400` rather than defaulting, and reject a `runtime` the harness does not offer:
  `resolveSessionRuntime` already owns that degradation and the answer must not be invented here.
  The mechanism comes from the same `StandingInstructionsSpec` the composer reads, so the marker
  and the delivery can never disagree.

**Every repository key written through the PUT is resolved through `resolveRepoPath`
(`src/server/repos.ts:146-177`), and the stored key is its `.path`, never its `.repoRoot`.**

This is one sentence and it is the whole of the rule, because the two functions differ in exactly
the way that breaks this feature. `resolveRepoRoot` (`repos.ts:121`) is lossy by design and its
sibling's docstring says so:

> resolving to a repository is lossy in one direction that a caller may need back:
> `/repo/packages/web` resolves to `/repo`, and a caller configuring a per-package command has no
> way to recover the package from the root alone.

Store `.repoRoot` and `~/ws/mono/packages/api` collapses to `~/ws/mono` on the way in - so the
package-level rule silently becomes the monorepo rule, overwrites whatever was there, and the
longest-match behaviour the store advertises cannot be configured at all. `POST /api/repos/resolve`
(`routes.ts:2762-2770`) is the door Phase 2's picker already goes through, and its own comment
records the trap: *"Existing callers read `repoRoot` and ignore the rest."* This caller must not.

`.path` still carries the guard that matters: `resolveRepoPath` re-roots the subpath onto the
**owning main checkout**, so a session standing in `~/.treehouse/<pool>/16/mono/packages/api`
stores `<main>/packages/api` and a pool path never reaches durable config. The two answers are
equal exactly when the operator named a repository root.

Refuse a key that does not resolve with a `400`, the way `PUT /api/pipelines/config` already does
(`routes.ts:5087-5100`).

The resolved route is what Phase 2's preview and dispatch marker read, so that the browser never
reimplements the matching rule. It answers *what will a session get*, and it is **not** an answer
about a session that has already launched - see step 8.

### 8. The per-session snapshot - what this session actually received

> **A session outlives the setting that launched it.** The resolved route reads live config, so a
> session header that called it would quote a running session text it never saw the moment the
> operator edits the rule - or show nothing at all once the override is removed. The chip exists so
> nobody debugs an instruction they cannot see; a chip that lies is worse than no chip, because it
> sends the operator looking for the cause of a behaviour in a rule that was not in effect.

So the delivered text is **recorded at launch** and read back by identity, never re-resolved.

**Where it lives.** A new table, keyed exactly like `session_notes`, `session_goals` and
`session_launch_turns` - `noteKeyFor(s)` (`src/server/registry.ts:7854-7856`), which is
`agentSessionId ?? s.id`. Its own row rather than a column on one of those, for the reason
`session_goals`' own comment in `src/server/db.ts:884-887` gives: a second writer sharing another
table's `updated_at` and disposition corrupts both meanings.

```
note_key   TEXT PRIMARY KEY   -- noteKeyFor(s)
text       TEXT NOT NULL      -- the composed block EXACTLY as delivered, multi-repo included
mechanism  TEXT NOT NULL      -- which channel carried it, from StandingInstructionsSpec
sources    TEXT NOT NULL      -- JSON, manifest order: [{ repoPath, matchedKey | null }, ...]
created_at INTEGER NOT NULL
```

**`text` is the composed block, not one repository's resolution.** A multi-repo dispatch delivers
one labelled block per attached repository that has rules, in the manifest's order (step 4), so a
snapshot holding a single `repoPath` and a single resolved text could not represent what the agent
actually read. Store the output of the composer, byte for byte.

**One row, not one per repository.** Per-repository rows would leave the chip re-assembling the
labelled blocks in the browser, which is a second implementation of `compose.ts` and free to drift
from what was sent - the same reason the panel is forbidden from re-deriving the longest-path match.
The provenance the operator still needs, *which stored key produced each repository's block*, is the
`sources` array beside it; `session_goals.pending_prompts` (`src/server/db.ts:900`) is the existing
precedent for a small ordered JSON column in this schema. Keeping it to one row also keeps the move
and prune below identical to `session_launch_turns`', rather than a fan-out that has to stay
consistent.

**No `updated_at`, and no second write.** The row is a record of something that happened. A row
that can be updated is a row that can be made to disagree with the launch it describes, which is
the whole finding. Write it once, at the moment the delivery is composed, and only when the
composed block is non-empty - a session with no standing instruction has no row and no chip.

**It must ride the key changing under it.** The row is written while argv is being composed, before
the agent has reported its own session id, so it is keyed on `s.id`. When `agentSessionId` arrives,
`noteKeyFor` starts returning a different key and the row is orphaned - the chip would silently empty
out a few seconds into every Claude terminal session. And a `/clear` rotates the key again, for as
long as the process lives.

**Copy `moveForemanInviteKey`, not `moveSessionLaunchTurn`.** This is the trap in this step, because
the launch turn is the nearer-looking neighbour and the wrong one. `moveSessionLaunchTurn`'s only
caller is `Registry.moveLaunchTurnOnInitialBind` (`src/server/registry.ts:6487`), whose guard
`if (fromKey !== previous.id) return` its own docstring calls *"the whole method"*: it fires only on
the first bind and deliberately **strands** the row on a native-to-native rotation, because carrying a
launch turn into a new conversation would let the projection swallow a real message. Attaching the
snapshot to that path gives it exactly the behaviour this step forbids - the chip goes blank on the
first `/clear` while the instruction it described is still governing the session.

That same docstring names the right one:

> The guard is the whole method, and it is what separates this from `moveForemanInviteKey`, **which
> moves on every rotation.**

So define `moveStandingInstructionsKey(fromKey, toKey)` beside `moveForemanInviteKey`
(`src/server/registry.ts:6867`), with no initial-bind guard and the same last-write-wins on the
destination, and call it from the same six rotation sites (`registry.ts:1930`, `:2313`, `:2581`,
`:2733`, `:4715`, `:4812`) plus `resetSession` in `src/server/reset.ts`, which is why that method is
public.

**Why the two policies differ, in one line.** A launch turn is a *projection into one conversation*
and must not be carried into the next. The snapshot is a *record of what governs the process* -
`--append-system-prompt` is a flag on the running CLI, and Codex's value lives on the mutated
`LaunchConfig` that survives `clearContext` (`codex/sdk.ts:569`) - and `/clear` does not end the
process.

**Prune it with its neighbours.** `pruneSessionLaunchTurns(liveKeys, olderThan)` is called from
`src/server/registry.ts:6549`; the snapshot prunes on the same pass and the same liveness set.
Otherwise an 8,000-character row per dead session accumulates forever.

**Route.** `GET /api/sessions/:id/standing-instructions` → the snapshot, or `404` when there is
none. A dedicated fetch rather than a field on the session wire type: the text is up to 8,000
characters and `session_upsert` is broadcast over SSE for every session on every change, so a field
would put the whole corpus on the wire repeatedly to serve one detail view. The session header is a
single-session surface; it can afford one request.

## Tests

Add to `test/`, using `node:test` and `node:assert/strict`. Run a single file with the loader the
suite uses:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
```

`--import ./test/setup-state.mjs` is not optional - see `AGENTS.md`.

| Area | Cases |
|---|---|
| Keys | a PUT naming `<root>/packages/api` stores **that path**, not `<root>` - the case that makes longest-match configurable at all; a key inside a pool tree stores its main-checkout equivalent; a non-repository key is `400`; a session in `<root>/packages/api` matches the package key rather than the root's |
| Resolution | longest match wins; `/repo-backup` does not match `/repo`; empty-string override beats the default; absent key inherits; the character cap |
| Composition | the block sits **below the repo manifest and above the intent**, asserted as that exact three-way order - "above the intent" alone is also satisfied by placing it above the manifest, which inverts the reason for the order, since the manifest names the checkouts the instructions are about; **a repo with no rules produces a byte-identical prompt to today**; multi-repo emits one labelled block per attached repo in manifest order |
| Delivery | each of the five harness · runtime pairs carries the text by its declared mechanism; **exactly one `--append-system-prompt` flag is emitted**; the standing instruction still ships when `askChannelArgs` returns `[]`; Codex's merge preserves a configured value and arms without `opts.mcp` |
| **Assignment** | an assigned task on a pair **with** a channel composes nothing and the session's installed block still governs; on a pair **without** one it carries the **snapshot's** text; editing the configuration between launch and assignment changes neither; a session with no snapshot row is assigned a byte-identical prompt to today |
| **Exactly-once** | for every one of the five pairs, the block appears in **exactly one** channel: a pair with an out-of-band channel has it there and **not** in turn one, a pair without has it in turn one and nowhere else. Assert on the composed prompt and the launch payload together, so neither a double send nor a silent drop can pass |
| Store | ETag changes with the document; a stale `expectedEtag` performs no write; empty-vs-absent round-trips |
| Routes | `409` carries the current view; oversize body is `413`; an unresolvable repo key is `400`; an unknown `agent` or an unsupported `runtime` is `400`; the resolved route's reported mechanism matches what the composer actually did for that same pair |
| **Resolved route** | one `repoPath` and several behave the same way the launch does, byte for byte against `compose.ts`; a two-repo preview where only the *second* repository has rules returns that repository's block rather than nothing; order follows the manifest; zero `repoPath` values is a `400` |
| **Snapshot** | the row records exactly the text and mechanism the launch delivered, for each of the five pairs; **a multi-repo dispatch's row holds the whole composed block and one `sources` entry per contributing repository, in manifest order**; **editing the config afterwards does not change it, and removing the repository's override does not delete it**; a session with no standing instruction writes no row and the route is `404`; the row survives the first `agentSessionId` bind **and every subsequent native-to-native rotation**, and is reachable under the new key each time - drive at least two `/clear`s, because a hook copied from `moveLaunchTurnOnInitialBind` passes the first move and fails the second; a pruned session's row goes with it |

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
- An assigned task on a live session delivers by replaying its snapshot, never by re-resolving, and
  never twice on a pair whose channel is durable.
- A repository with no standing instructions dispatches a byte-identical prompt and argv to `main`.
- The configuration routes behave as the cross-phase contract states, including CAS and the size
  limit.
- A launch snapshot records what was delivered - the whole composed block for a multi-repo dispatch,
  not one repository's share - survives the first agent-session bind, and does not move when the
  configuration is later edited or removed.
- `docs/configuration.md` documents the `app_config` key and the cap.
- Typecheck, lint, tests, build and smoke green; one reviewable pull request merged.

## Downstream handoff

Phase 2 may rely on, and must not change:

- The wire types and the four routes exactly as the cross-phase contract states them.
- Absent-means-inherit, empty-means-send-nothing, `null`-in-a-patch-removes.
- Longest-path-match on the canonical repo-rooted path, boundary-matched - `.path` from
  `resolveRepoPath`, on both the write and the read side.
- Compare-and-swap on `expectedEtag`, with `409` carrying the current view.
- `resolveStandingInstructions` as the one matching implementation. Phase 2 calls the resolved
  route; it does not re-derive the match in the browser.
- The launch snapshot and `GET /api/sessions/:id/standing-instructions`. This is the **only** source
  the session header chip may read; the resolved route is for the pre-launch dispatch note, where
  live config is the correct answer.
- **Launch resolves, assignment repeats**, and the panel states the boundary that follows from it:
  a session keeps the standing instructions it launched with.

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
- The launch snapshot was pulled **into** this phase after review rather than left to Phase 2. Phase
  2 could not have built it: the only moment the delivered text and its mechanism are both known is
  the moment this phase composes them, and a browser reading live config cannot reconstruct it
  afterwards. It is inert on merge like the rest of the phase - the resolved text is empty
  everywhere, so no row is ever written.
