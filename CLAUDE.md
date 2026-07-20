# CLAUDE.md

Mission Control: a local control plane for Claude Code / Codex sessions across wezterm tabs
and tmux sessions.

This file lists the **surfaces that have to move together**. For what the product does and
how to run it, read `README.md`.

## Architecture

| Where | Entry | What |
|---|---|---|
| `src/server` | `index.ts` | Daemon on loopback `:7317`. The only writer of the SQLite DB. |
| `src/web` | `main.tsx` | Dashboard. HTTP plus one `EventSource`. |
| `src/shared` | - | Wire types and zod schemas, imported via `@shared/*`. |
| `src/main` + `src/preload` | `index.ts` | Electron shell. Spawns the daemon. |
| `src/mcp` | `server.ts` | MCP tools, stdio child of Claude Code. Reaches the daemon over HTTP. |
| `src/server/foreman` | `worker.ts` | Auto-responder. Separate process, HTTP only. |
| `hooks/` | `harness-hook.mjs` | Bare node per Claude hook event. POSTs to the daemon. |

- The Foreman is a separate process and **never touches the DB**. If it needs state, add a
  route.
- The live channel is SSE only. The web app does not poll.

## Compiler-enforced contracts

Both fail typecheck now. Know the right answer when you hit the error.

**New `Session` field** → give it a comparator in `SESSION_FIELD_COMPARATORS`
(`src/server/registry.ts`). `byValue` for scalars, `byJson` for nested objects. `alwaysEqual`
only for fields that cannot change for the life of a map entry, and it needs a comment saying
why - do not use it to silence the error. Read the `queue` / `orphanedQueue` entries and the
`KNOWN GAP` note before adding a denormalized field. Test: `session-contracts.test.ts`.

**New `ServerEvent` variant** → add a `case` in `src/web/useEventStream.ts`. If it adds a
top-level collection, also extend the `snapshot` case, `registry.snapshot()`, and
`MissionState`.

## Layout parity

`LAYOUTS` in `src/web/lib/layout.ts`: `grid` (Cards), `console`, `board`. `App.tsx` owns all
session state; layouts arrange, never decide.

A session is drawn by **four** components, only one of which is `SessionCard`:

| Component | Used by |
|---|---|
| `SessionCard.tsx` | Cards only |
| `layouts/ConsoleDetail.tsx` | Console and Board detail pane |
| `layouts/SessionTile.tsx` | Board overview tile |
| `layouts/RailRow.tsx` | Console rail, and Board's drilled-in column |

- **An affordance added to `SessionCard` appears in one layout of three.** Open all three
  before calling a card change done.
- **Add layout-visible props to `SessionViewProps` / `cardProps`** (`layouts/types.ts`), never
  to an individual view, or `GridView` silently drops it.
- **Shared leaf pieces live in `session-bits.tsx`** (`AgentDot`, `PrChip`, `StateBadge`,
  `SessionTitle`, `RuntimeMetaRow`, `GoalLine`). Put new ones there; do not inline a variant.
  Test: `session-leaf-parity.test.ts`.
- **Three mark vocabularies still disagree**: `RailRow` glyphs, `SessionTile` `.tile-flag`
  chips, `SessionCard` chips (+ `queueChipView` in `lib/queue.ts`). A new session-level signal
  must be added to all three. Known gap, next thing worth unifying. `CostChip` is the worked
  example: the figure in three surfaces, a `$` glyph in the rail's `marks`, and one shared
  `costIsNotable` (`@shared/cost.ts`) deciding where the line sits - not three thresholds.
- Console detail CSS reaches into shared components with descendant selectors
  (`.detail-conv > .transcript`, `.detail-foot .actions`). Changing `TranscriptPanel` or
  `ActionBar` DOM can break console/board with no compile-time signal.
- A **fourth layout** also needs: the render switch, `expandedForView`, Escape's collapse
  branch, the expand chord and `CommandBar` in `App.tsx`; `layoutNav.ts`; `LayoutPanel`'s glyph
  ternary. All three fall through to grid/board defaults for unknown modes.

Keep the README's invariant true: every shortcut works in every layout.

## Compose parity

| Surface | Draft kind | Images |
|---|---|---|
| Transcript reply (`TranscriptPanel.tsx`) - the real composer | `reply` | yes |
| Work queue add box (`WorkQueue.tsx`) | `queue` | yes |
| Dispatch modal task field (`DispatchModal.tsx`) | `DispatchLayer` | yes |
| Action bar send box (`ActionBar.tsx`) - collapsed-card fallback | `send` | no, it is an `<input>` |

These behave alike: image drop/paste, draft persistence across unmount, Enter submits with
Shift+Enter for newline, Escape blurs, cleared on reset. Changing one, state which others you
changed and why the rest were left alone.

- **One compose box per surface; the reply box wins.** A new box must report presence upward
  via `onReplyBox` and route the send chord through `ActionBarHandle.startSend`, or you get two.
- **Drafts live in `lib/drafts.ts`**, a module-level map, not React state. `DraftKind` is
  `"queue" | "reply" | "send"` - a new box means a new kind. `clearDraft` only on successful
  send, never on Escape/close/collapse. `dropSessionDrafts` is driven only by `session_remove`;
  an absence-based prune was tried and reverted.
- **Reset nonce chain**: boxes are uncontrolled, so `App.tsx` bumps `resetNonces` → through
  `SessionViewProps`/`cardProps` → a `key` on the textarea and the attachment flush. A new
  uncontrolled box needs its own link.
- **Attachments**: wire all six pieces from `ImageDrop.tsx` (state, `useImageDrop`,
  `dropProps`, `AttachmentStrip`, `onPaste`, drop veil), send via `withAttachments`, and guard
  the Enter key on uploading, not just the disabled button. Decide `revokeAttachments` on
  unmount deliberately: reply and queue do, dispatch does not.

## Reset

A reset leaves nothing session-scoped behind: work queue, compose drafts, reply attachments,
message log. Anything else you add that is session-scoped and survives prompts, clear it too.

## Overlays

Register in `OVERLAY_IDS` and the host (`src/web/components/Overlay.tsx` - `OverlayHost`,
`useOverlayHost`). App uses `overlays.anyOpen` to stand down and `overlays.onlyOpen(...)` for
self-toggling chords. **Do not reintroduce a hand-kept list.** Test: `overlay-registry.test.ts`.

The overlay owns its own Escape. The host exposes a hook for extra keys. A session-bound
overlay still needs the "session disappeared" reconciliation effect in `App.tsx`.

## Changes that span files

**Electron capability = 4 files**: `ipcMain.handle` in `src/main/index.ts`, the
`contextBridge` entry in `src/preload/index.ts`, the hand-mirrored interface in
`src/web/mission-desktop.d.ts`, and a call site guarded on `window.missionDesktop?` (undefined
in the browser build). Push-direction channels also need `webContents.send` plus a
subscribe/unsubscribe pair in preload.

**Claude hook events are declared twice** - `EVENTS` and `MATCHER_EVENTS` in both
`hooks/install.mjs` and `src/main/integrations.ts`. Edit both, plus `hooks/harness-hook.mjs`
and `hookToState` in `registry.ts`. Hand-kept; nothing catches drift.

**MCP tool args are validated twice** - hand-written zod in `src/mcp/server.ts` duplicating
`src/shared/protocol.ts`. Change both. Hand-kept; nothing catches drift.

**New mutating route** → add a zod schema in `protocol.ts` and go through `parseBody`. Never
hand-parse a body.

**New column on an existing table** → editing the `CREATE TABLE IF NOT EXISTS` block is not
enough. Add an `addColumn` call in `migrate()` (`src/server/db.ts`). New tables need nothing.

**No backticks inside `openDb()`'s SQL block.** It is one template literal, so a backtick in
a `--` comment ends it and the file stops parsing. Name identifiers bare.

**A `UNIQUE` index you `ON CONFLICT` against must have no nullable columns.** SQLite treats
NULLs as distinct, so the upsert silently becomes an insert and the row multiplies on every
retry. `usage_ledger.model_id` / `query_source` are `NOT NULL DEFAULT ''` for this reason.

**New build entry point** → the `package.json` script, the `build` chain, the
`--alias:@shared` flag, the `files:` allowlist in `electron-builder.yml`, and the hard-coded
`dist/` paths in `src/main/index.ts` and `src/main/integrations.ts`. The `@shared` alias is
declared in four places that must agree: `tsconfig.json`, `vite.config.ts`, and the esbuild
flags.

**Never enable asar**, and never move `skills/` into `dist` - Claude launches
`dist/satellites/hook.mjs` and `dist/mcp/server.mjs` with an external node, and `skills/` is
reached through a symlink.

**Append-only**, since old values persist on users' machines: skill directory prefixes in
`src/shared/skills.ts`, and the `MISSION_` / `FLEET_` / `HARNESS_` env fallback chain in
`src/shared/harness-runtime.mjs`.

## Registries - extend these, do not start a parallel list

- **Settings panels**: `SETTINGS_CATEGORIES` in `SettingsModal.tsx` + a `case` in
  `renderCategory`. `settings-sidebar-render.test.ts` asserts nav count equals array length.
  State App also renders is passed in as props; state only the modal uses is local.
- **Keyboard shortcuts**: `ActionId` + `ACTIONS` in `lib/keybindings.ts` (array order is panel
  order), plus a dispatch branch in `App.tsx`, usually an `ActionBarHandle` method and its
  registration, a `CommandBar` keycap, a README table row, and a `keybindings.test.ts` case. A
  new group also needs a `GROUPS` entry in `KeyboardPanel`.
- **Tones**: `TONE_ORDER` / `TONE_GROUPS` in `lib/tone.ts` drive grid sort, rail sections,
  board columns and board arrow-nav. Also needs a `--<tone>` token and `.tone-*` / `.badge-*`
  rules.
- **Shared predicates**: `foremanAllowlisted` (`@shared/foreman.ts`), `composeWrapup`
  (`@shared/queue.ts`), `costTone` / `costIsNotable` (`@shared/cost.ts`), and the backlog
  autopilot's `readyBacklog` / `blockersIn` / `nextUpTaskId` (`@shared/backlog.ts`) are shared
  so every surface, and the server, decides identically. Do not copy them into a component.
- **`~/.claude/settings.json` writers**: `hooks/install.mjs`, `src/main/integrations.ts`, and
  the daemon (via `src/server/cost.ts`). The telemetry `env` block has ONE definition in
  `@shared/claude-settings.ts` - three copies of six keys is how half a block gets left
  behind that nothing owns. Keep `src/shared/claude-settings.ts` free of daemon imports:
  the Electron main bundle imports it, and must not pull `node:sqlite` in transitively.
  Test: `telemetry-env.test.ts`.

## Styles

`src/web/styles.css` is one 5,700-line file: no preprocessor, no modules, no Tailwind. A
`:root` token block, then ~60 sections in feature order marked `/* ---- name ---- */`. Classes
are `block-element` with per-feature prefixes (`wq-`, `nm-`, `rt-`, `qc-`, `tf-`, `board-`,
`console-`, `rail-`, `detail-`).

- **When you remove or rename a `className`, grep `styles.css` for it in the same change.** No
  linter, no stylelint, no unused-CSS check, no test touches this file.
- New rules go in the matching section, not at the end.
- Layout state is root/parent classes and data attributes (`.app-${layout}`,
  `.board[data-focus="<tone>"]`, `.card.expanded`), not per-layout files.
- `--topbar-h` and `--cmdbar-clearance` are measured in JS. Check them if you change the topbar
  or command bar.

## Done means

1. **README updated in the same change.** New capability → a section; new env var → a line
   under Configuration; new `make` target → Commands; new shortcut → the Keyboard table. Stale
   docs are a rejected change, not a follow-up.
2. **Tests.** `node:test` + `node:assert/strict`, flat in `test/` as `<feature>-<aspect>.test.ts`.
   React via `renderToStaticMarkup` from `react-dom/server` - no jsdom, no testing-library.
   Route tests call `buildApp(...)` with stub registries. Open each file with a comment about
   what is at stake, not what the test does. A test that touches the db or state dir must set
   `HARNESS_HOME` to a fresh temp dir **before importing anything that resolves it** (the
   ui-config-store.test.ts preamble); `openDb` refuses the real state dir under the test
   runner, so skipping this fails loudly instead of wiping the operator's live settings.
   Test: `db-isolation.test.ts`.
3. **Plans.** `docs/plans/<name>/plan.md` is the source of truth with a self-contained
   `plan.html` beside it (`skills/html-plans/SKILL.md`). Open choices go through the
   `request_plan_decisions` MCP tool, not prose. `todo/*.md` is in-flight notes, a different
   thing.

**A written plan is not an implementation.** If the task was to build it, build it.

## Verifying

Do not report a UI change as working on the strength of the diff.

- `make start` runs the stack; `make stop-all` then `make restart` if wedged.
- **Vite on `:5173` serves whichever checkout started it, usually main and not your worktree.**
  Confirm you are looking at your own build.
- Sessions run in pooled worktrees under `~/.treehouse/` (`treehouse.toml`), so "works here"
  and "works in the app" are different claims.
- Be picky. If something looks off next to what you changed, fix it or say so.

CI runs `npm run typecheck`, `npm test`, `npm run build` on Node 24 and 25. There is no linter.

## House rules

- **Never use the em dash.** Plain dash only.
- Branches `mancej/<kebab-slug>`; commits `type(scope): sentence` (`feat`, `fix`, `docs`,
  `refactor`, `test`), or a plain sentence for larger changes.
- Never add an agent name as commit co-author.
- Never hand-edit `CHANGELOG.md` or anything auto-generated.
- Prefer quality, simplicity, and long-term maintainability over development cost.
- Start a bug fix by reproducing it end to end, the way a user hits it.
