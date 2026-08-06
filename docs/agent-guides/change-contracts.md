# Change contracts

This guide lists project-specific surfaces that must move together. It is intentionally more detailed than the root `AGENTS.md` and shorter than the archived historical guide.

## Shared types and events

When adding a `Session` field:

1. Add its comparator to `SESSION_FIELD_COMPARATORS` in `src/server/registry.ts`.
2. Use `byValue` for scalars and `byJson` for nested values.
3. Use `alwaysEqual` only for a truly immutable map-entry field and document why.
4. Check whether the value belongs on a task, episode, or binding instead of denormalizing it onto a session.

When adding a `ServerEvent`:

1. Add an exhaustive case in `src/web/useEventStream.ts`.
2. If it adds a top-level collection, update `MissionState`, the snapshot event, and `registry.snapshot()`.

MCP arguments are deliberately validated twice: in `src/shared/protocol.ts` and `src/mcp/server.ts`. Change both.

Every mutating route requires a Zod schema in `protocol.ts` and `parseBody`. Do not hand-parse JSON.

## Database changes

For a new column on an existing table:

1. Update the fresh `CREATE TABLE IF NOT EXISTS` definition.
2. Add `addColumn` in `migrate()` in `src/server/db.ts`.
3. Create indexes that reference the new column after `addColumn`, not in the initial SQL block.
4. Add an upgrade test seeded with a pre-feature database.

Do not place backticks inside the `openDb()` SQL template literal.

Columns used by a `UNIQUE` index targeted by `ON CONFLICT` must be non-null. SQLite treats nulls as distinct.

The daemon is the sole database writer. Foreman and MCP reach it through HTTP.

## Persisted identifiers

Persisted ID tuples are append-only. Never rename, reorder, or reuse values. This includes:

- Agent and harness IDs
- Skill directory prefixes
- Task source kinds
- LLM job IDs
- LLM spend roles (`LLM_SPEND_ROLES`) - these are written into `usage_ledger.note_key` and
  queried back by exact value, so a rename orphans every historical row it wrote
- Usage ledger writer names (`usage_ledger.writer`: `otel`, `driver`, `rollout`, `report`) -
  which ingest produced a row, and the only thing that tells Claude's two session writers apart,
  since both are `spend_kind = 'session'` with `cost_basis = 'reported'`. One place queries it by
  exact value and must not be allowed to drift: `sdkOwnedNoteKey` in `src/server/db.ts`, whose
  `writer = 'driver'` clause is what makes the OTel ingest yield for a key a driver already
  reported. A miss there double-counts a driven session's turn. Empty string means the row
  predates the column; nothing writes it.

  Note what does NOT read this column: whether Claude Code's exporter is working. That is judged
  on export ARRIVAL (`lastOtelExportSeenAt` and `hasClaudeSessionUsageSince`, combined in
  `exporterSilentWhileActive` in `src/server/cost.ts`), because rows are the wrong evidence in
  both directions - a driven session's datapoints are deliberately dropped, so a healthy exporter
  may write none, and rows outlive an exporter that stopped by up to the 180-day retention
- Schedule enum values
- Ensemble strategy, driver, artifact, source, run, and member values
- Inspector marker versions
- Workflow graph node kinds, source and target ports, and SessionAction completion kinds
  (`SESSION_ACTION_COMPLETION_KINDS`) - these reach draft graphs, immutable published
  versions, and `session_actions.completion_kind`, and a completion kind is read STRICTLY:
  an unknown value fails its row rather than degrading, so renaming one makes history
  unreadable instead of migrating it
- Workflow run statuses, node-attempt states, and delivery kinds
  (`WORKFLOW_RUN_STATUSES`, `WORKFLOW_NODE_ATTEMPT_STATES`, `WORKFLOW_DELIVERY_KINDS`) -
  these are `workflow_runs.status`, `workflow_node_attempts.state` and
  `workflow_deliveries.kind` on operators' machines
- SessionAction wait reasons and block codes (`SESSION_ACTION_WAIT_REASONS`,
  `SESSION_ACTION_BLOCK_CODES`) - these reach a waiting attempt's `output_json`. Each one is a
  `Record` key in `src/web/workflows/run-model.ts`, so adding one fails typecheck until
  somebody says what it means to a human. That is the intended cost, not an obstacle to route
  around with a default arm.
- Built-in workflow version ids (`builtinWorkflowVersionId`) - bindings and runs store
  `builtin-workflow:<slug>@<n>` durably. Improving a shipped workflow APPENDS a version;
  editing one rewrites the graph every existing binding pinned to it. The literal node and
  edge tables in `test/builtin-workflows.test.ts` exist to fail when that happens.

Search for the owning constant and its contract tests before extending a tuple.

## Workflow evidence identity

A workflow submission is identified by `(round, segment)`, and the two answer to different
budgets:

- `round` counts REPAIR. Only a fail/repair transition increments it, it restarts the graph at
  Session, and `maxRepairRounds` compares this and nothing else.
- `segment` counts the immutable evidence snapshots inside one repair round. A completed
  SessionAction creates `segment + 1`, captures fresh evidence, and activates only the routes
  reachable from that action's `complete` port. It never spends repair budget.

Every attempt, receipt, context snapshot and verdict is scoped to exactly one submission. Order
submissions by `(round, segment)` and never by insertion time - a continuation is reserved
before its evidence is captured, so `created_at` says when work started, not which evidence is
current. Use `submissionForRepairRound`, `submissionForSegment` or `latestSubmissionForRun`
rather than an ambiguous latest-by-run query.

One receipt may cross submissions, and only one: the attempt a child segment names in
`continuation_node_attempt_id`. `WorkflowStore.addReceipt` enforces that, because any other
cross-submission source would let a node activated on one evidence snapshot advance a graph
running on another.

## Session actions

A SessionAction is a durable side effect, not an evaluator:

- The engine activates it as one `waiting` attempt carrying its published snapshot. It enqueues
  no runnable work, occupies no model execution slot, and writes no receipt until its
  continuation is captured.
- The manager owns the one delivery, through the existing Workflows switch, repository
  allowlist, note identity, pane lock and uncertain-write policy. Preview prepares and never
  types.
- Idle is not proof of completion. The target session is normally idle at the instant the
  packet is typed, so a confirmed send persists an anchor, a pickup signal newer than that
  anchor is required, and only then does `settledIdle` count. `needs-you` is an operator wait,
  never a settled turn.
- Completion is adapter-owned. `src/server/workflows/session-action-adapters.ts` is the closed
  registry; `SESSION_ACTION_COMPLETION_CAPABILITIES` in `src/shared/workflow.ts` is the one
  answer the validator, the daemon and the browser all read. An adapter reported unavailable
  refuses at Publish and again before anything is typed.
- An adapter is CODE with proof and recovery tests, never a string an operator types or a skill
  they name. Adding one means: an append-only entry in `SESSION_ACTION_COMPLETION_KINDS`, a
  capability, a `decide`/`validateSnapshot`/`validateCapture` implementation, an arm of
  `SessionActionContinuationExpectation` if its proof has to survive to the capture, a sentence
  for every wait reason and block code it introduces, and tests for the restart at each
  boundary. It must not reach for a provider directly - see the pull request adapter below for
  why the one poller that does is the one that keeps doing it.
- Adapters are PURE decisions over stated evidence. Everything they need - the checkout's root,
  branch and full HEAD oid, the adoption ledger, the commit a reserved child already captured -
  is supplied on `SessionActionAdapterContext` by the manager, which is where git and SQLite
  live. An adapter that fetched its own facts could not be tested without arranging them on a
  real machine, and "we could not look" would stop being distinguishable from "the answer is
  no". Null means unknown, and unknown always means wait.

### The `pull_request` adapter

- Its proof is: an OPEN pull request in Mission Control's adoption ledger, on the same
  repository root and branch as the bound checkout, whose last observed remote head is the
  exact commit the continuation captured. `Session.prUrl` is a lookup hint and satisfies
  nothing; neither does a branch name, nor a pull request merely existing.
- It never talks to a provider. The Inspector poller is the only thing that does, and
  `inspector_prs.observed_head_sha` / `observed_state` / `head_ref_name` are the durable form
  of what it saw. A second poll loop would double the API cost of every open pull request to
  answer a question the first one already answers.
- Heads are compared as FULL object ids on both sides. Evidence capture records
  `git rev-parse --short HEAD`, so a captured abbreviation goes through
  `resolveCapturedCommit` (`src/server/workflows/commit-id.ts`), which enumerates the object
  database by prefix and consults no ref. Prefix-matching a captured head against a provider's
  40-character id is not this comparison - see that module for the ref-shadowing case it closes.
- When the checkout moves between the proof and the capture, the adapter is re-asked against
  the head the CHILD holds, not the live one. Re-deciding against a moving HEAD sets an
  expectation the immutable child can never satisfy, and the action waits forever while the
  head keeps moving.
- Only a closed or merged pull request AT the reviewed commit blocks. Everything else waits,
  including a provider that could not be reached: waiting is recoverable and a block is not.
- The adapter's view of the ledger is NOT `loadOpenInspectorPrs()`. The poller records a closure
  and retires the row in the next statement, so the open set loses a pull request on the very
  tick the adapter needed to see it closed - and the one state that blocks becomes unreachable,
  leaving a durable contradiction reported as an ordinary missing-PR wait for ever. Read through
  `loadAdoptedInspectorPrsSince(deliveredAt)`, which keeps retired rows visible for exactly the
  window this action has been waiting. Widening that bound is not free: the caller resolves a
  repository identity per distinct root, and each one is a git subprocess.
- A stray pull request is a NAMED state, not the absence of one. `pull_request_wrong_repository`
  and `pull_request_wrong_branch` separate "this turn produced nothing yet" from "this turn
  produced one somewhere else", which look identical from the ledger and are opposite problems.
  Both require positive proof: adopted from the bound session at or after the delivery instant,
  with a repository root or branch that is KNOWN and differs. A row the poller has not reached
  carries neither, and unknown must read as waiting - reporting an unobserved adoption as a
  mismatch accuses an operator's session of a mistake it did not make.
- Refusal, lost authorization, an exited session or an infrastructure failure BLOCK the run with
  an action-specific code. They never become a Persona verdict, a repair packet, or a spent
  repair round. A REFUSED packet blocks (`delivery_refused`) because nothing was typed and
  waiting cannot change that; an UNCERTAIN one blocks (`delivery_uncertain`) because an
  action's contract is that its exact instruction ran once, and the runtime will not guess in
  either direction. `resolveDelivery`'s `mark_delivered` is the operator's answer and reopens
  the attempt. Recovery never re-prepares a refused packet - that would retry, on every daemon
  start, a write nobody re-authorized.
- The authored prompt ceiling is DERIVED (`sessionActionPromptBytes` = `sessionActionPacketBytes`
  less `sessionActionEnvelopeBytes`), never set beside it. An action packet is the operator's
  own instruction frozen into an immutable version, so it is refused when it cannot be sent
  whole rather than truncated - a prefix of an instruction is a different instruction, and
  delivering one would change the requested operation without failing the run. Stored rows keep
  a looser read bound (`sessionActionPromptReadBytes`) so nothing already written becomes
  unreadable; the snapshot schema is what keeps an undeliverable prompt out of every version.
- Two actions ready at ONCE are refused, not serialized. Running one and holding the other
  looks safe and silently loses it: the continuation seeds the child segment with only the
  completed action's routes, so the held sibling's activating receipt stays behind in the
  parent. A chain (`A -> B`) is supported and is the shape a pipeline authors.

### What the browser may and may not decide about one

- **Addability is the daemon's answer, never the bundle's.** Every add control filters through
  `addableSessionActions(catalog, available)`, and `available` comes from
  `GET /api/session-actions/capabilities`. Reading `SESSION_ACTION_COMPLETION_CAPABILITIES`
  directly in a component would make the offer a property of the loaded JavaScript rather than
  of the process that will refuse the publish. A failed capability read offers **nothing**; it
  must never fall back to the shared table.
- **Nameable is wider than addable.** An archived source, a shadowed built-in, or an adapter
  this build cannot run stays in a picker as a RETAINED option when a node already names it. A
  `<select>` whose value is absent from its options paints something else as chosen, and the
  next change event rewrites a draft nobody meant to edit.
- **An action never borrows an evaluator's vocabulary.** `sessionActionStatus` is its own chip
  table beside `reviewerStatus` and `checkStatus`, and no arm of it says Passed, Failed or
  Changes requested. `stageStatus` takes the stage kind for the same reason: folding a
  singleton action stage through the all-pass logic headed it "Passed" one line above a member
  chip that refuses to make that claim.
- **A CAS conflict offers three routes, and Reapply is a three-way merge.** Reload discards
  the draft, Duplicate keeps it on a different row, and Reapply lands it on the same row at
  the revision that now exists. The merge is what makes the third one safe: the patch is
  measured from `baselineRef` - the seed the draft STARTED at - not from the row the conflict
  reported and not from the `action` prop, which the raising SSE upsert has already replaced
  with the other tab's state. Measured either of those ways, a reapply sends back every field
  the other tab changed at the values this editor loaded before they changed them, silently
  reverting their save. `sessionActionSaveTarget` states the whole rule: Save and Reapply
  differ in exactly one thing, the expected revision.
- **Wait state is read, not derived.** `actionWait` and the durable `SessionActionAttemptState`
  in the attempt's `output_json` are the runtime's own answers. The distinction between a stale
  idle and a finished turn is a transcript byte offset the daemon recorded; nothing in a
  summary can reconstruct it, and no surface may try.
- **Round and segment are different facts and are displayed as such.** The repair budget counts
  `round` only. A surface that derived a round by counting submissions would report a run as
  closer to its limit every time an action finished.
- **A continuation's source action is shown with the child segment.** The attempt stays on the
  parent - that is what keeps upstream work from claiming it reviewed evidence it never saw -
  so `continuationSourceAttempt` reads the submission's own `continuationNodeId` /
  `continuationNodeAttemptId` columns and verifies both ends. This is the one deliberate
  cross-submission read, and it is provenance the runtime wrote rather than a relationship
  inferred from ordering.

## The Inspector footer

Inspector is `WorkflowCompletionPolicy`, and it gains no node, no id and no edge. `InspectorFooter`
in `src/web/workflows/pipeline-bits.tsx` is the one projection of it, rendered after End by the
Pipeline editor, the run pipeline, published version detail and the Board ladder. It returns
`null` for a `none` policy, which is why every call site passes the policy unconditionally.

Two things about it are load-bearing. It reads the **version's** policy on a run surface and the
**workflow's** on a draft surface, so a run pinned to an older version shows the gate that
version was published with. And `none` beneath an Inspector policy means "the run has not
reached the gate", not "there is no gate" - `inspectorFooterStatus` exists so the footer does
not contradict its own sentence for most of a live run's life.

## Ledger tables

A settings panel whose subject keeps an append-only record - Inspector, Shipping, Foreman today - draws that record with `ConsoleTable` from `src/web/components/settings-console.tsx`, and never assembles a table of its own out of the `sc-` leaves. The component owns the heading, the column-name row, the bounded scroller, the pager and the caption; a panel supplies its filtered rows, its columns, its `renderRow` and its copy.

Three properties come with it, and all three are the component's rather than the panel's:

- **A height budget on the table, not on the rows.** `.sc-table` is capped at `62vh` and `.sc-scroll` takes what is left. Bounding the rows alone leaves the pager below the table's budget and, on a short window, below the fold - which `overscroll-behavior: contain` then makes unreachable by continuing to scroll.
- **One page of rows, at `CONSOLE_PAGE_SIZE`.** Slice through `consolePage`, which clamps: every one of these ledgers is polled and filtered, so the row count moves underneath an operator sitting on the last page. The pager is absent, not disabled, when everything fits on one page.
- **The count strip is the filter, and the pager restarts with it.** Tiles fold over one bucket function so a tally and the rows it selects cannot disagree, and changing the filter is a new list, so it opens at its first page.
- **Paging keeps the keyboard's place.** Reaching the first or last page disables the button that was just pressed, and a browser blurs a control that becomes disabled; the focus is handed to the button that can still act. Two pages is the ordinary case here, so this fires on most page changes rather than at an edge.

This is a rule because the drift it prevents is invisible in a one-file diff. The three panels shared a vocabulary of leaves and each assembled its own table, so they diverged on the one thing a class name says nothing about - how much of a list they will put on screen. Foreman grew a budget at its 100-row cap; Inspector and Shipping reached 50 and grew nothing, running the settings page on for screens of table beside a control column a quarter of their height, with the filter strip scrolled out of reach.

Ledger reads stay capped server-side (`loadInspectorInspections(50)`, `recentEpisodes(100)`); the pager pages what the panel was served and its total says so. A new bucket needs a strip tile and an `EMPTY_FILTER` sentence, both `Record`-typed so the compiler asks.

Tests: `test/settings-console.test.ts` for the fold and the rendered page, `e2e/specs/settings-ledger-pagination.spec.ts` for the bounds and the paging, `e2e/specs/foreman-decision-ledger.spec.ts` for the ledger it was taken from.

Feeds and logs that are not settings ledgers - the Ship log's day feed, `WorkflowRuns`' cursor-paginated list - keep their own shapes. This contract is about the settings console, not about every list in the app.

## Harness changes

Add an agent ID only to `AGENT_TYPES`. The resulting type errors identify the exhaustive records that need real values:

- `AGENT_IDENTITY`
- `HARNESS_CAPABILITIES`
- `HARNESSES`
- model and cost support
- runtime support and optional SDK driver
- resume support

`null` is a measured unsupported capability, not a placeholder. Verify it against a real installation or fixture.

Driver transports stay in one adapter module and one dependency seam. Codex app-server bindings are generated by `scripts/codex-app-server-bindings.mjs`; do not hand-type protocol methods elsewhere.

Codex sandbox posture and approval policy are different settings. Sandbox is fixed for a thread; turn approval, reviewer, model, and effort are per-turn overrides.

Hook event vocabularies have one owner per harness. Launch-scoped Codex hooks and machine-wide Claude hooks are intentionally different.

## Layout and compose parity

The three layouts are `grid`, `console`, and `board`. `App.tsx` owns session state; layouts arrange it.

A session appears in four components:

- `SessionCard.tsx`
- `layouts/ConsoleDetail.tsx`
- `layouts/SessionTile.tsx`
- `layouts/RailRow.tsx`

Add layout-visible props through `SessionViewProps` and `cardProps`. Shared leaves belong in `session-bits.tsx`. A new session signal must cover card chips, tile flags, and rail marks.

Compose surfaces:

| Surface | Draft kind | Images |
|---|---|---|
| Transcript reply | `reply` | yes |
| Work queue add | `queue` | yes |
| Dispatch task | dispatch-owned | yes |
| Action bar send | `send` | no |

Drafts live in `lib/drafts.ts` and survive unmounts. Successful submission clears only the submitted draft. A successful reset calls `dropMessageDrafts` to clear `send` and `reply` while preserving the `queue` draft; uncontrolled message boxes participate in the reset nonce chain. Durable `session_remove` calls `dropSessionDrafts` to clear every draft kind. Image-enabled composers wire all `ImageDrop.tsx` pieces and block Enter while uploads are pending.

Human conversation composer submissions enter the durable pending-turn outbox. Only its newest `queued` row is recallable. A `sending` row has crossed the delivery boundary and cannot be recalled; an `uncertain` row requires an explicit retry or resolution.

Route every server-side reset through `resetSession` in `src/server/reset.ts`; it owns pending-turn, work-queue, workflow, work-episode, and cache cleanup. It raises the registry reset marker before asking `PendingTurnManager` to settle a claimed SDK or terminal delivery. A turn refused before runtime acceptance is safe to discard. A turn that may have crossed that boundary is retained as `uncertain` through successful reset cleanup for explicit operator resolution. The UI reset callback separately clears message drafts, transcript history, file buffers, and reply attachments. Keep durable removal cleanup on `session_remove`, not `state === "exited"`.

## Overlays and shortcuts

Register overlays in `OVERLAY_IDS` and render through `OverlayHost`. Use `overlays.anyOpen` and `overlays.onlyOpen`; do not maintain a second list. The overlay owns Escape.

Keyboard shortcuts are registered through `ActionId` and `ACTIONS`, dispatched in `App.tsx`, surfaced in the command bar, documented in README, and tested.

A fourth layout also requires render selection, expansion state, Escape handling, expand shortcuts, command bar behavior, `layoutNav.ts`, and `LayoutPanel`.

## Registries

Extend existing registries instead of adding parallel lists:

- Settings: `SETTINGS_CATEGORIES`, `renderCategory`, panel component, and search anchors
- ⌘K palette: `PALETTE_PROVIDERS` and `PALETTE_KIND_INFO` in `src/web/lib/palette-index.ts`. A new
  searchable kind is a provider over an existing client SSE store, never a second index, a
  server-side search endpoint, or a fetch. Its rows may target only routes the router already
  publishes and affordances that already exist in one step elsewhere
- Harnesses: `HARNESS_CAPABILITIES` and `HARNESSES`
- LLM runners: `LLM_RUNNER_IDS` and `LLM_RUNNERS`
- Terminal backends: ID tuples and `MULTIPLEXERS` or `EMULATORS`
- Open targets: `OPEN_TARGET_INFO` and `OPEN_TARGETS`
- Task sources: `TASK_SOURCE_KIND_INFO` and `TASK_SOURCES`
- Ensemble strategies: shared strategy info and server compiler registry
- Shared model choice: `resolveModelChoice`
- Shared predicates: keep one implementation in `src/shared`

Exhaustive `Record<Id, Value>` registries are intentional compiler enforcement.

"That word is a file path" is two questions, both answered in `src/web/lib/workspaceLinks.ts`, and which one you get depends on whether you hold a list of real files:

- `matchCheckoutPaths(text, paths)` - the transcript's. Membership decides, so every listed file is reachable with no excluded extension, shape, or length; longest match wins; candidates go through the same `normalizeRelative` a written href does, and absolute candidates are refused because normalization would otherwise read `/a` as the listed `a`.
- `detectPathTokens(text)` - the fallback for a caller that cannot ask, which is the ensemble scorecard rendering a rationale before any file union is fetched. It guesses from shape and therefore misses every extensionless name, dotfile, and spaced path.

Do not reach for the shape matcher while holding a listing, and do not add a third: they already share the word-boundary and `:line[:column]` rules, and the copies that preceded them had drifted.

## Electron and build surfaces

An Electron capability spans:

1. `ipcMain.handle` in `src/main/index.ts`
2. `contextBridge` in `src/preload/index.ts`
3. `src/web/mission-desktop.d.ts`
4. A browser-safe call site guarded by `window.missionDesktop?`

Push channels also need `webContents.send` plus preload subscribe and unsubscribe functions.

A new build entry point requires:

- A `package.json` script and the main build chain
- The `@shared` esbuild alias
- `electron-builder.yml` file allowlist
- Any relevant hard-coded `dist/` resolver paths

The `@shared` alias must agree across TypeScript, Vite, and esbuild. Never enable `asar`. Agents execute satellite and MCP bundles with external Node, and `skills/` remains outside `dist`.

## Styles and documentation

`src/web/styles.css` is a single tokenized, sectioned stylesheet. Add rules to the matching section. When removing or renaming a class, search for its CSS in the same change.

Harness colors come from `AGENT_IDENTITY` through `--agent-accent`; never name an agent in CSS.

In Electron, the top bar is a drag region. New floating interactive layers need the desktop `no-drag` rule.

Update README in the same change:

- New capability: feature section
- New environment variable: Configuration
- New command: Commands
- New shortcut: Keyboard table

Built-in personas are generated from `personas/*.md`, and built-in session actions from
`actions/*.md`. Edit the Markdown and run the generator (`npm run personas`,
`npm run session-actions`) instead of editing the `.generated.ts` module. Both share the
reader and renderer in `scripts/builtin-markdown.ts`, and both have a drift test that
imports the generator rather than re-implementing it.

`personas/` also holds the two operator briefs the daemon reads as files at runtime -
`FOREMAN.md` (the seed for Foreman's standing instructions) and `INSPECTOR.md` (this repo's
brief for the Inspector) - plus a `README.md`. The generator globs the whole directory, so
those three are excluded by name in `NON_PERSONA_DOCUMENTS`; anything else added there becomes
a built-in Persona. A persona filename is the durable `builtin:<slug>` id that published
workflow versions reference, so adding and removing documents is safe and renaming one is a
migration.

`actions/` is the same shape with one exclusion, `README.md`, named in
`NON_SESSION_ACTION_DOCUMENTS` - it states that the directory holds Mission Control session
actions and not GitHub Actions, which is prose worth keeping and therefore prose worth
excluding. Action filenames are durable ids on the same terms; `pull-request` additionally
keys the enforced contract table in `src/server/workflows/builtin-session-actions.ts`, which
is where a built-in's required skill and completion live rather than in its Markdown.

Plans live at `docs/plans/<name>/plan.md` with a self-contained HTML companion when the planning workflow requires it.
