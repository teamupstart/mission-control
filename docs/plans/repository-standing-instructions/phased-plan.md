# Repository standing instructions - implementation index

Implementation plan for [`plan.md`](plan.md), approved with all four review decisions taken.
Two phases, one pull request each.

- **Source plan:** [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html))
- **Phase 1:** [`phase-1-store-and-delivery.md`](phase-1-store-and-delivery.md)
- **Phase 2:** [`phase-2-settings-panel.md`](phase-2-settings-panel.md)

---

## Incorporated human decisions

These were submitted at the plan review and are **requirements, not options**. A phase that
re-opens one is doing the wrong work.

| Decision | Adopted |
|---|---|
| `editor-home` | A new **Standing instructions** settings category, in the *Sessions* group with a `This machine` scope badge |
| `delivery` | **Capability-declared**: out-of-band where the harness and runtime have a channel, prompt text where they do not. Wiring Claude's SDK `systemPrompt.append` and Codex's `developerInstructions` is in scope. |
| `reach` | **Mission-Control-launched sessions only** - dispatch and assignment. No injection into adopted sessions. |
| `standards-bundle` | **Sessions only.** Standing instructions do **not** join the standards bundle read by Foreman, the Inspector and workflow Personas. |
| `implementation-follow-up` | Create this phased plan and schedule its tasks. |

---

## Repository findings that change the plan

The source plan was written from a reading of the code; three of its claims did not survive a
closer look. Each is recorded here as a decision, and each is owned by Phase 1.

### Finding 1 - a second `--append-system-prompt` flag would silently discard the first

The plan's delivery table reads `claude · terminal` → `--append-system-prompt` → "in use", which
invites the obvious implementation: contribute a second flag beside the ask channel's. **That is
wrong and it fails silently.**

Verified against the `claude` binary on this machine (2.1.239): `--append-system-prompt <prompt>`
is declared as a **single-value** option, not variadic - contrast `--betas <betas...>` two lines
below it in the same help output. The binary carries an explicit guard for the sibling conflict
(`Cannot use both --append-system-prompt and --append-system-prompt-file`) but **no** collector or
error for the flag repeated against itself, so a repeat is last-wins and the earlier value is
dropped without a word.

The failure mode is the worst available: on Claude the text never appears in the transcript
anyway, so a dropped standing instruction is indistinguishable from one that was never set.

**Decision:** the Claude terminal path composes **one** `--append-system-prompt` value from every
contributor. Phase 1 owns the composer.

There is a documented precedent for getting this exact class of thing wrong here:
`docs/plans/ask-channel/plan.md:185-219` records that the codebase previously probed `--help`
prose for flag support and guessed wrong, disabling the ask channel on every dispatch.

### Finding 2 - folding into `askChannelArgs` would inherit its all-or-nothing failure

`askChannelArgs` (`src/server/ask-channel.ts:165-206`) returns `[]` on **any** failure - a missing
MCP bundle (`:172-181`) or the blanket `catch` (`:196-205`). Its own contract comment says "ALL
FOUR FLAGS OR NONE". Its result is spliced unconditionally into the argv at
`src/server/dispatcher.ts:520-529`.

That contract is correct for what it guards: an agent with `AskUserQuestion` removed and no
replacement is worse than one with the built-in intact. But a standing instruction has **nothing to
do with the MCP bundle**, and hanging it inside that function would mean an unbuilt `dist` silently
drops the operator's instruction too.

**Decision:** Phase 1 extracts the system-prompt append into its own contributor that emits
independently of the MCP registration, and composes the ask-channel redirect and the standing
instruction into its single value. The redirect keeps its existing all-or-nothing tie to the MCP
flags; the standing instruction does not acquire one.

### Finding 3 - Codex's `developerInstructions` is gated on `opts.mcp`

`src/server/harness/codex/sdk.ts:1429` wraps the whole `config/read` + merge block in
`if (opts.mcp)`. With no `missionMcp` the block is skipped, `config.developerInstructions` stays
`null` (initialised at `:1409`), and `threadStartParams` (`:1333-1348`) omits the key entirely.

That gate is coherent for the current payload - `MISSION_CONTROL_REVIEW_INSTRUCTION` tells the
agent to call an MCP tool that would not exist - but a standing instruction hung off the same
channel would silently never be sent on any ordinary dispatch, which is most of them.

**Decision:** Phase 1 ungates the `config/read` + merge for the standing-instruction case, so the
channel arms whenever there is text to send. The existing review instruction keeps its `opts.mcp`
gate.

Note the value must survive `clearContext`, which rebuilds params from the same mutated
`LaunchConfig` (`codex/sdk.ts:569`).

### Confirmed as written

- **Claude SDK `systemPrompt.append` exists and is unused.** Type at `@anthropic-ai/claude-agent-sdk@0.3.220`:
  `systemPrompt?: string | string[] | { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }`.
  A bare `string` **replaces** the Claude Code prompt, so the preset+append object is the only
  non-destructive form. `src/server/harness/claude/sdk.ts:1114-1181` passes no `systemPrompt` at
  all. `settingSources: ["user","project","local"]` (`:1176`) loads CLAUDE.md and settings - it is
  not a prompt-append channel and does not overlap.
- **`withTaskKindContract` is the single composition seam**, at `src/server/task-contract.ts:133`,
  reached from `dispatcher.ts:417` and `tasks.ts:2970`. Every `TaskKind` passes through it -
  `chat` and `pipeline` return `null` from `KIND_CONTRACT` rather than bypassing.
- **`app_config` needs no migration.** Six config modules carry the same sentence: a
  schema-validated blob over that KV, with zod defaults applying on every read.
- **Longest-match on `repo_root` is an established pattern**, `workflow_command_overrides`
  (`src/server/db.ts:1106-1112`), and boundary matching already exists in
  `src/shared/allowlist.ts`.
- **Pi's turn one rides the argv** (`preparePiLaunch` returns `["--session-id", uuid, message]`),
  which makes the prompt-text path e2e-assertable through the fake's argv record.

### Environment note

`node_modules` is not installed in this worktree. The implementing agent runs `npm install` first;
the Playwright browser additionally needs `npx playwright install chromium` once per machine.

---

## Sizing and phase count

**Estimate: 1,200-1,800 gross non-test implementation lines**, centred near 1,500. Counted as
production lines added or materially changed, excluding tests and documentation.

Assumptions behind the estimate, anchored on measured comparables in this repository:

| Area | Estimate | Anchor |
|---|---|---|
| Shared schemas and harness capability | 130 | `WorktreesConfigSchema` + patch is ~60 lines; capability specs run 15-25 lines per harness |
| Server store, ETag, longest-match resolve | 160 | `src/server/foreman/instructions.ts` is 112 lines for the single-document version |
| Composition and block rendering | 130 | `intentWithRepoManifest` + `withRepoMemoryPointer` are comparable |
| Routes | 55 | measured GET/PUT pairs run 25-70 |
| Delivery wiring across 5 harness · runtime pairs | 120 | includes the Finding 1 and 2 refactor |
| Settings panel component | 400 | ConductorPanel +326, TaskSourcesPanel +303, WorktreeSettingsPanel +382 at introduction |
| React hook with reconcile guard | 180 | useConductor +157, useWorktrees +168, useTaskSources 221 |
| Registry, SettingsPage, search index, api client | 70 | measured: 9-24 + 6-8 + 7-27 + 15 |
| Per-session delivery snapshot | 110 | table plus `moveStandingInstructionsKey` across the seven sites `moveForemanInviteKey` is called from |
| Assignment replay path | 40 | reads the snapshot at `tasks.ts:2970`; no new channel |
| Dispatch and session markers | 90 | two small read-only surfaces |
| CSS | 110 | 60-300 depending on reuse of `.kb-row` / `.settings-hint` |

The rows above are the phase estimates: 130 + 160 + 130 + 55 + 120 + 110 + 40 = **745** for Phase 1,
and 400 + 180 + 70 + 90 + 110 = **850** for Phase 2. They are stated to the row rather than rounded,
so a later change to one of them moves a number a reader can check.

Tests are additional and substantial - roughly 420-740 lines across a panel render test, an HTTP
test, sidebar-render additions and one e2e spec.

**Two phases.** Above the 200-line one-shot threshold by roughly sevenfold, so the question is
whether one task or two. Two, because:

- The two halves have **different risk profiles and different verification**. Phase 1's risk is
  prompt-composition correctness across five launch paths and two SDK adapters, provable entirely
  by `node:test`. Phase 2's risk is a browser state machine and an e2e spec. One agent doing both
  would be switching between them rather than finishing either.
- The merge boundary is **independently testable and real**. Phase 1 ends with the daemon
  delivering standing instructions correctly, exercisable over HTTP with no UI at all. That is a
  genuine checkpoint, not a chapter break.
- Phase 1 touches three **controlled paths** - `src/shared/`, `src/server/harness/`,
  and the dispatch composition seam. Phase 2 touches none of them. Reviewing a ~1,500-line diff
  that spans both is materially worse than reviewing two.

**Why not three.** The obvious third cut - store and routes as one phase, delivery as another -
would leave Phase 1 with a config nothing reads: a dead surface and a second source of truth about
what "delivered" means, which the sizing rubric explicitly warns against. Splitting the two
read-only markers out of Phase 2 would produce a phase of roughly 90 lines that cannot be tested
without the panel that writes the value it displays.

**Why Phase 1 leaving no UI is acceptable.** The stored default is empty and resolution returns
nothing for every repository, so Phase 1 merges with **zero behavior change** to any existing
session. It is not a half-built feature sitting in the product; it is an inert mechanism awaiting
its editor.

---

## Phases

| # | Phase | Delivers | Direct prerequisites | Est. impl. lines |
|---|---|---|---|---|
| 1 | [Store and delivery](phase-1-store-and-delivery.md) | The `app_config` store, longest-match resolution, the routes, delivery on all five harness · runtime pairs, and the per-session launch snapshot | none | ~745 |
| 2 | [Settings panel](phase-2-settings-panel.md) | The Standing instructions settings category, the dispatch and session markers, and the e2e spec | Phase 1 | ~850 |

### Dependency graph

```
Phase 1 (store, resolution, routes, delivery, launch snapshot)
   │
   └──► Phase 2 (settings category, markers, e2e)
```

Strictly serial. Phase 2 consumes Phase 1's wire contract (`StandingInstructionsView`, the routes,
the ETag semantics), its resolved-text route and its per-session launch snapshot, so there is
nothing to run concurrently.
Both phases are single-repository; neither needs sibling repositories attached.

### Merge order

Phase 1, then Phase 2. Each task additionally depends on this planning session, so both stay
backlogged until this plan's own pull request merges the artifacts to the default branch.

---

## Cross-phase contracts

Phase 1 fixes these and Phase 2 consumes them without changing them.

**Wire types** (`src/shared/protocol.ts`):

```ts
export const STANDING_INSTRUCTIONS_MAX_LENGTH = 8_000;
export const STANDING_INSTRUCTIONS_MAX_REPOSITORIES = 200;

/** Stored shape. `default` applies to any repo with no block of its own. */
export const StandingInstructionsConfigSchema: z.ZodType<{
  default: string;
  repositories: Record<string, string>;
}>;

/** What GET returns, and what a PUT must echo back its etag from. */
export interface StandingInstructionsView {
  default: string;
  repositories: Record<string, string>;
  /** Opaque CAS token over the whole document. */
  etag: string;
}

/** One repository's effective answer, and how it will be delivered. */
export interface ResolvedStandingInstructions {
  /** Effective text, "" when nothing applies. */
  text: string;
  /** Which stored key produced it, or null when the default did. */
  matchedKey: string | null;
  source: "repository" | "default" | "none";
}
```

**Routes:**

| Method | Path | Semantics |
|---|---|---|
| `GET` | `/api/instructions` | `StandingInstructionsView` |
| `PUT` | `/api/instructions` | `{ expectedEtag, default?, repositories? }` → `200` view, `409` `{error, code, current}`, `413` over `bodyLimit` |
| `GET` | `/api/instructions/resolved?repoPath=&agent=&runtime=` | `ResolvedStandingInstructions` plus the delivery mechanism for a given agent and runtime. **Live config: what a session *would* get** |
| `GET` | `/api/sessions/:id/standing-instructions` | The immutable snapshot of what *that* session received at launch, or `404`. **What a session *did* get** |

**Behavioural invariants Phase 2 may rely on and must not change:**

1. **In the stored document**, an **absent** repository key means "inherit the default" and a key
   present with `""` means "send nothing for this repository".

   **In a PUT body** `repositories` is a *patch*, following `WorktreesConfigPatchSchema`
   (`src/shared/protocol.ts:2182-2208`): an absent key leaves the stored value alone, a string sets
   it, and `null` removes it. A caller therefore saves one repository by sending that one key, and
   **must not** send its whole draft map - doing so persists every other repository's unsaved text
   as though the operator had committed to it.
2. Resolution is longest-path-match on the **canonical repo-rooted path**, boundary-matched. Both
   the stored key and the lookup argument are `resolveRepoPath(...).path`, never `.repoRoot` -
   collapsing to the root on either side makes a monorepo package key unreachable, and on the write
   side silently overwrites the parent's rule with it.
3. The PUT is compare-and-swap on `expectedEtag`; a stale caller gets `409` with the current view
   and performs no write.
4. `resolveStandingInstructions` is a pure function exported from shared code. Phase 2 calls the
   route, never reimplements the matching.
5. **Exactly one delivery per occasion, and a launch is the only occasion that resolves.**

   *At launch*: a harness · runtime pair with an out-of-band channel gets the block there and is
   **not** also prefixed into turn one; a pair without one is prefixed and has no out-of-band send.
   Never both - the agent would read the same rule twice in its first turn.

   *At assignment* into a live session (`tasks.ts:2970`): nothing is resolved. A pair with a channel
   gets **nothing**, because the block is still installed on that process; a pair without one gets
   the **snapshot's** text prefixed again, because a prefix does not govern later turns; a session
   with no snapshot gets nothing.

   Whether a pair has a channel is read from `StandingInstructionsSpec` in one place, so the
   composer, the resolved route and the dispatch marker cannot disagree.
6. The resolved route requires `agent` and `runtime`, because the mechanism is a property of the
   pair rather than of the repository. An unknown `agent`, or a `runtime` the harness does not
   offer, is a `400` rather than a default.
7. **What a session received is recorded, not re-resolved.** Phase 1 writes the **composed block
   exactly as delivered** - every attached repository's labelled block, in manifest order - together
   with its mechanism and one provenance entry per contributing repository, to a per-session row at
   launch, keyed by `noteKeyFor(s)`, once and never updated. Editing or removing the configuration
   afterwards does not change or delete any existing session's row. The session header chip reads
   that snapshot and **only** that snapshot; the resolved route is for the pre-launch dispatch note,
   where live config is the right answer. The row follows **every** note-key rotation, not only the
   first bind - the `moveForemanInviteKey` policy, not `moveLaunchTurnOnInitialBind`'s - and it is
   what an assignment replays, not merely what the chip reads.
8. A **save writes exactly one field**: one repository's key, or `default`. Combined with (7), the
   two ways an operator could be shown or sent an instruction they never wrote are both closed - an
   unsaved draft cannot be persisted by a neighbouring save, and a saved change cannot rewrite the
   history of a session that already launched.
9. **A session keeps the standing instructions it launched with.** An edit takes effect on the next
   session, not a running one. This follows from (5): a live process's system prompt cannot be
   rewritten, so the alternative is not "edits reach running sessions" but edits reaching them on
   two of the five pairs and not the other three, for the same feature. Phase 2 renders the sentence
   in the panel.

---

## Final verification strategy

Per phase, in its own file. Across both:

- `npm run typecheck` and `npm run lint` clean.
- `npm test` green, including the settings registry walks that a new category must satisfy.
- `npm run build` then `npm run test:e2e` green, with the new spec proving a rule written in
  Settings reaches the very next dispatch's command line - the assertion shape
  `e2e/specs/harness-defaults-propagate.spec.ts` already uses against the fake agents' argv records.
- The decisive regression guard, owned by Phase 1 and re-run in Phase 2: **a repository with no
  standing instructions produces a byte-identical prompt and argv to today.**

---

## Documentation

Both phases update the docs they change, per the repository's working rules. Two specifics:

- `docs/skills-and-settings.md` gains the new category. Note that its section at lines 237-250 is
  already **stale** - it still calls Conductor "the one category that is conditional", which
  contradicts both the current registry and `docs/agent-guides/change-contracts.md:747-755`. Correct
  it while editing that file.
- `docs/configuration.md` gains the `app_config` key and the character cap.
