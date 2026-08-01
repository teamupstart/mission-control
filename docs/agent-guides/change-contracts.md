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
  `SESSION_ACTION_BLOCK_CODES`) - these reach a waiting attempt's `output_json`

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
- Refusal, lost authorization, an exited session or an infrastructure failure BLOCK the run with
  an action-specific code. They never become a Persona verdict, a repair packet, or a spent
  repair round.

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

Route every server-side reset through `resetSession` in `src/server/reset.ts`; it owns server-side queue, workflow, work-episode, and cache cleanup. The UI reset callback separately clears message drafts, transcript history, file buffers, and reply attachments. Keep durable removal cleanup on `session_remove`, not `state === "exited"`.

## Overlays and shortcuts

Register overlays in `OVERLAY_IDS` and render through `OverlayHost`. Use `overlays.anyOpen` and `overlays.onlyOpen`; do not maintain a second list. The overlay owns Escape.

Keyboard shortcuts are registered through `ActionId` and `ACTIONS`, dispatched in `App.tsx`, surfaced in the command bar, documented in README, and tested.

A fourth layout also requires render selection, expansion state, Escape handling, expand shortcuts, command bar behavior, `layoutNav.ts`, and `LayoutPanel`.

## Registries

Extend existing registries instead of adding parallel lists:

- Settings: `SETTINGS_CATEGORIES`, `renderCategory`, panel component, and search anchors
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

- `matchCheckoutPaths(text, paths)` — the transcript's. Membership decides, so every listed file is reachable with no excluded extension, shape, or length; longest match wins; candidates go through the same `normalizeRelative` a written href does, and absolute candidates are refused because normalization would otherwise read `/a` as the listed `a`.
- `detectPathTokens(text)` — the fallback for a caller that cannot ask, which is the ensemble scorecard rendering a rationale before any file union is fetched. It guesses from shape and therefore misses every extensionless name, dotfile, and spaced path.

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

Built-in personas are generated from `docs/personas/*.md`, and built-in session actions from
`docs/session-actions/*.md`. Edit the Markdown and run the generator (`npm run personas`,
`npm run session-actions`) instead of editing the `.generated.ts` module. Both share the
reader and renderer in `scripts/builtin-markdown.ts`, and both have a drift test that
imports the generator rather than re-implementing it.

Plans live at `docs/plans/<name>/plan.md` with a self-contained HTML companion when the planning workflow requires it.
