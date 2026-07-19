# CLAUDE.md

Mission Control: a local, auto-refreshing control plane for Claude Code / Codex sessions
running across wezterm tabs and tmux sessions.

This file is about **cross-cutting concerns** - the places where a change that looks local
is not. Most defects this repo has had to fix in a second pass were not wrong logic; they
were correct logic applied to one of several surfaces that had to move together. What
follows is the list of those surfaces.

For what the product does and how to run it, read `README.md`. It is long, it is current,
and it is faster than guessing.

## Orientation

Several processes, one daemon that owns all state:

| Where | Entry | What it is |
|---|---|---|
| `src/server` | `index.ts` | The daemon on loopback `:7317`. **The only writer of the SQLite DB.** |
| `src/web` | `main.tsx` | The dashboard. HTTP plus one `EventSource`. |
| `src/shared` | - | Wire types and zod schemas, imported by everyone via `@shared/*`. |
| `src/main` + `src/preload` | `index.ts` | The Electron shell. Spawns the daemon. |
| `src/mcp` | `server.ts` | MCP tools, a stdio child of Claude Code. Reaches the daemon over HTTP. |
| `src/server/foreman` | `worker.ts` | The auto-responder. A **separate process**; HTTP only. |
| `hooks/` | `harness-hook.mjs` | Bare node, once per Claude hook event. POSTs to the daemon. |

Two consequences worth stating outright:

- **The Foreman never touches the DB.** It is a different process. If it needs state, add a
  route, not a `db.ts` import.
- **The live channel is SSE, and only SSE.** The web app does not poll. `sseHandler`
  (`src/server/sse.ts`) sends a snapshot on connect, then streams `ServerEvent`s.

## The changes that fail silently

Ranked by how quietly they break. The first two produce no error, no failing test, and a UI
that is simply wrong.

### 1. A new `Session` field must be added to `sessionEqual`

`src/server/registry.ts` - `sessionEqual()`.

Sessions are emitted over SSE only when `sessionEqual` returns false. **A field added to the
`Session` interface but not to `sessionEqual` will never reach the UI when it changes.** It
renders correctly on first load, from the snapshot, and then never updates again.

Convention: scalars with `===`, nested objects with `JSON.stringify`. Read the comment above
the `queue` / `orphanedQueue` comparisons before adding a denormalized field. It records a
real instance of this bug where the changed value depended on *other* sessions, so the
session that needed to re-emit was itself unchanged by every other measure.

### 2. A new `ServerEvent` variant must get a `case` in the web switch

`src/web/useEventStream.ts` - the `switch (msg.type)`.

**There is no `default` branch.** An event the daemon emits and the switch does not handle
is silently dropped. If the variant adds a top-level collection, also extend the `snapshot`
case, `registry.snapshot()`, and `MissionState`.

### 3. Layout parity: one behavior set, four rendering surfaces

`src/web/lib/layout.ts` defines `LAYOUTS`: `grid` (Cards), `console`, `board`. `App.tsx` owns
all session state; a layout arranges and never decides.

The prop bundle is spelled once, in `src/web/components/layouts/types.ts` -
`SessionViewProps` and `cardProps()`. That file's comment explains why: three hand-written
copies of an eighteen-prop card is three places for a layout to quietly stop passing one and
start lying about stale state. **Add a layout-visible prop there, never to an individual
view**, or `GridView` will silently drop it.

But the sharing stops at the prop bundle. **A session is drawn by four different components,
and only one of them is `SessionCard`:**

| Component | Used by |
|---|---|
| `SessionCard.tsx` | Cards only. It is the sole caller. |
| `layouts/ConsoleDetail.tsx` | Console and Board detail pane (tabbed: conversation / queue / gate / diff) |
| `layouts/BoardView.tsx` `SessionTile` | The board overview tile |
| `layouts/RailRow.tsx` | The console rail, and the board's drilled-in column |

So **an affordance added to `SessionCard.tsx` appears in exactly one of three layouts.**
Before calling a card-level change done, open all three and look. This has come back as a bug
report from the running app more than once ("compare the cards on the board layout to the
ones in the cards layout"; "this send box in console view makes no sense").

Three specific traps inside that:

- **`SessionCard` re-implements three components that already exist in `session-bits.tsx`.**
  It imports `AGENT_LABEL`, `ChecksFailedIcon`, `GoalLine`, `PrStateIcon`, `RenameEditor`,
  `RuntimeMetaRow`, `subtitle` - but **not** `PrChip`, `StateBadge`, or `SessionTitle`, which
  it inlines its own copies of. Fixing one of those three in `session-bits.tsx` fixes the
  console and board and **leaves the card broken**. If you touch them, touch both.
- **There are three separate vocabularies for "what does this session want?"** - `RailRow`'s
  glyph strings, `BoardView`'s `.tile-flag` chips, and `SessionCard`'s chips (plus
  `queueChipView` in `lib/queue.ts`). They encode the same underlying facts with no shared
  module. A new session-level signal must be added to all three or it is invisible in two
  layouts.
- **The console detail styles reach into shared components with descendant selectors**
  (`.detail-conv > .transcript`, `.detail-foot .actions`, `.detail-head .agent-dot`, and
  more). Changing the DOM of `TranscriptPanel` or `ActionBar` can break the console and board
  layout with no compile-time signal.

Adding a *fourth* layout is not just a `LAYOUTS` entry: `App.tsx` dispatches on the layout
literal in several places (the render switch, `expandedForView`, Escape's collapse branch,
the expand chord, `CommandBar`), `layoutNav.ts` falls through to the grid branch for
unhandled modes, and `LayoutPanel`'s glyph ternary falls through to the board glyph.

README states the invariant that shortcuts hold everywhere: *"Every shortcut works in every
layout."* Keep that true.

### 4. Compose surface parity

Four places a human types. They are expected to behave alike, and each of the behaviors below
had to be retrofitted across them one at a time because it landed on one box first: image
drag / drop / paste, draft persistence across unmount, Enter submits with Shift+Enter for a
newline, Escape blurs, and clearing on reset.

| Surface | Draft kind | Images |
|---|---|---|
| Transcript reply box (`TranscriptPanel.tsx`) - the real composer | `reply` | yes |
| Work queue add box (`WorkQueue.tsx`) | `queue` | yes |
| Dispatch modal task field (`DispatchModal.tsx`) | owned by `DispatchLayer` | yes |
| Action bar send box (`ActionBar.tsx`) - the collapsed-card fallback | `send` | no, deliberately: it is an `<input>` |

"The three compose boxes" in the docs means the first three. They are exactly the three
`useImageDrop` call sites.

**One compose box per session surface, and the transcript's reply box wins.** Stated in
`ActionBar.tsx`, `ConsoleDetail.tsx`, and `TranscriptPanel.tsx`. Four things keep it true and
all four must stay wired: the panel reports its own presence up via `onReplyBox`, the parent
holds `hasReply` and passes it down, `ActionBar` force-closes its own box when `hasReply`
flips true, and `startSend()` calls `onFocusReply()` first and only opens its own box if that
returns false. **A new compose box must report its presence upward and route the send chord
through `ActionBarHandle.startSend`, or you get two boxes.**

**Drafts outlive their component.** `src/web/lib/drafts.ts` is a module-level map, not React
state, because every mount that could hold the text can end under it - a card collapses, the
nav filter drops it, Escape closes the box. Read its header before touching it. Also:

- `DraftKind` is `"queue" | "reply" | "send"`. A new compose box means a new kind.
- `clearDraft` may be called **only on a successful send**. Escape, close, and collapse must
  not clear.
- `dropSessionDrafts` is driven only by the `session_remove` event, which is the one signal
  that positively means gone rather than not-yet-re-added. The file explicitly forbids
  replacing this with an absence-based prune; that was tried and reverted.

**The reset nonce chain.** Because the boxes are uncontrolled, clearing the draft map does not
empty a box that is already open. `App.tsx` bumps `resetNonces`, which flows through
`SessionViewProps` and `cardProps` to a `key` on the textarea and to the attachment flush.
**A new uncontrolled compose box needs its own link in that chain.**

**Attachments** are caller-owned by design. A new attach-capable box wires all six pieces from
`ImageDrop.tsx` (state, `useImageDrop`, `dropProps`, `AttachmentStrip`, `onPaste`, drop veil),
sends through `withAttachments`, and **guards the Enter key on uploading, not just the
disabled button**. Whether to `revokeAttachments` on unmount is a real decision: the reply and
queue boxes do, the dispatch modal deliberately does not because its draft outlives the modal.

### 5. Reset clears everything session-scoped

A reset must leave nothing from the session's previous life: work queue, compose drafts, reply
attachments, message log. Each of those was originally missed and reported separately. If you
add anything else scoped to a session that survives across prompts, clear it on reset too.

### 6. Overlays must be registered in App's two guard lists

There is **no shared `<Modal>` component**. `ReviewModal`, `ResetModal`, `DispatchModal`,
`SettingsModal`, `ReportPanel`, and `DiffViewer` each hand-roll backdrop,
`stopPropagation`, and their own Escape handler, sharing only the `.modal-*` class
vocabulary.

Because App stands down while an overlay is up, **the overlay owns its own Escape**. And a new
overlay must be added to **both** hand-enumerated lists in `App.tsx`'s global key handler -
the sitrep-toggle guard and the stand-down guard - plus that effect's dependency array, plus
the "session disappeared" reconciliation effect if it is session-bound. Miss one and grid
shortcuts drive a card behind the open overlay.

### 7. An Electron capability is four files

1. `src/main/index.ts` - `ipcMain.handle("mission:...")`
2. `src/preload/index.ts` - the `contextBridge` entry
3. `src/web/mission-desktop.d.ts` - the interface, **hand-mirrored, no codegen**
4. The call site, which **must guard on `window.missionDesktop?`** because the plain browser
   build leaves it undefined

Push-direction channels (main to renderer) additionally need a `webContents.send` site and a
subscribe/unsubscribe pair in preload.

### 8. Claude hook events are declared in two places

`hooks/install.mjs` and `src/main/integrations.ts` each hold their own `EVENTS` and
`MATCHER_EVENTS` - one for `npm run install-hooks`, one for the packaged app. They are in sync
today. **Adding an event means editing both arrays**, plus handling in `hooks/harness-hook.mjs`
and `hookToState` in `registry.ts`.

### 9. MCP tool arguments are validated twice

`src/mcp/server.ts` registers tools imperatively with hand-written zod input schemas that
duplicate the server-side schemas in `src/shared/protocol.ts` (`request_plan_decisions` and
`PlanDecisionSchema` are the clearest pair). Change one, change the other.

Every mutating route goes through `parseBody(c, XSchema)` with a schema from `protocol.ts`.
Add the schema; do not hand-parse a body.

### 10. `CREATE TABLE IF NOT EXISTS` will not add a column

`src/server/db.ts`. New tables need nothing extra. **Adding a column to an existing table means
editing the `CREATE` block *and* adding an `addColumn` call in `migrate()`** - the DB already on
disk will otherwise never grow the column.

### 11. Build entry points and the packaging constraints

`build:web`, `build:server`, `build:main` (two entries: main and preload), `build:mcp`,
`build:hook`. A new entry point touches the `package.json` script, the `build` chain, the
`--alias:@shared` flag, the `files:` allowlist in `electron-builder.yml`, and the hard-coded
`dist/` paths in `src/main/index.ts` and `src/main/integrations.ts`.

The `@shared` alias is declared in four places that must agree: `tsconfig.json` paths,
`vite.config.ts` `resolve.alias`, and the esbuild `--alias` flags.

Two load-bearing constraints, both documented in `electron-builder.yml`:

- **Never enable asar.** Claude launches `dist/satellites/hook.mjs` and `dist/mcp/server.mjs`
  with an *external* node that cannot read inside an archive, and `skills/` is reached through
  a symlink, which resolves to nothing inside one.
- **`skills/` ships as source**, not through `dist`.

Append-only, because old values still exist on users' machines: the skill directory prefixes
in `src/shared/skills.ts`, and the `MISSION_` / `FLEET_` / `HARNESS_` env fallback chain in
`src/shared/harness-runtime.mjs`. Never remove an entry from either.

## Registries worth knowing

Some things in this codebase *are* centralized. Use them rather than adding a parallel list.

- **Settings panels**: `SETTINGS_CATEGORIES` in `SettingsModal.tsx`, plus a `case` in
  `renderCategory`. `test/settings-sidebar-render.test.ts` asserts the rendered nav item count
  equals the array length, so adding one without the other fails the test. Ownership rule: state
  App also renders is passed in as props (a second `useLayoutMode()` here would be a second copy
  of the same localStorage key); state only the modal uses is instantiated locally.
- **Keyboard shortcuts**: `lib/keybindings.ts` `ActionId` + `ACTIONS` (array order is panel
  order). A new binding also needs a dispatch branch in `App.tsx`, usually an `ActionBarHandle`
  method and its registration, a `CommandBar` keycap, a README table row, and a
  `test/keybindings.test.ts` case. `KeyboardPanel` renders from `ACTIONS`, but its `GROUPS` needs
  an entry for a new group.
- **Tones**: `lib/tone.ts` `TONE_ORDER` and `TONE_GROUPS` drive grid sort, console rail
  sections, board columns, and board arrow-nav. A new tone also needs a `--<tone>` token and
  `.tone-*` / `.badge-*` rules in `styles.css`.
- **Shared predicates**: `foremanAllowlisted` (`@shared/foreman.ts`) and `composeWrapup`
  (`@shared/queue.ts`) are shared with the *server* on purpose, so the dashboard and the Foreman
  decide and send identically. Do not copy either into a component.

## Styles

`src/web/styles.css` is one 5,700-line file: no preprocessor, no CSS modules, no Tailwind. A
`:root` token block, then roughly sixty sections in feature order delimited by
`/* ---- name ---- */`. Class names are `block-element` with hyphens, with terse per-feature
prefixes (`wq-`, `nm-`, `rt-`, `qc-`, `tf-`, `board-`, `console-`, `rail-`, `detail-`).

- **Delete the CSS when you delete the markup.** There is no linter, no stylelint, no
  unused-CSS check, and no test that touches this file. Dead and duplicate CSS has been caught
  by the review gate in at least five separate fix commits in a single week. When you remove or
  rename a `className` in a `.tsx`, grep `styles.css` for it in the same change; nothing else
  will tell you.
- Put new rules in the matching section, not at the end.
- Layout state is expressed as root and parent classes plus data attributes (`.app-${layout}`,
  `.board[data-focus="<tone>"]`, `.card.expanded`), not per-layout files.
- `--topbar-h` and `--cmdbar-clearance` are measured in JS and set as custom properties. If you
  change the topbar or command bar, check them.

## Definition of done

The `/no-mistakes` pipeline gates this repo and will send back all three of these:

1. **The README is part of the change.** It was edited 44 times in the last four days and is
   the highest-churn file in the repo. A new capability needs a section, a new env var a line
   under Configuration, a new `make` target a line under Commands, a new shortcut a row under
   Keyboard shortcuts. Stale docs are a rejected change, not a follow-up.
2. **Tests.** `node:test` + `node:assert/strict`, no vitest or jest, flat in `test/` as
   `<feature>-<aspect>.test.ts`. React components are tested with `renderToStaticMarkup` from
   `react-dom/server` - no jsdom, no testing-library. Route tests call `buildApp(...)` directly
   with stub registries. Open each file with a comment about what is at stake, not what the test
   does; that is the house style.
3. **Plans.** `docs/plans/<name>/plan.md` is the source of truth, with a self-contained
   `plan.html` rendered beside it (see `skills/html-plans/SKILL.md`). When a plan has open
   choices, ask through the `request_plan_decisions` MCP tool rather than in prose. `todo/*.md`
   is for in-flight working notes and is a different thing.

**A written plan is not an implementation.** A review round on this repo returned "No code was
written. Only plan docs were added." If the task was to build it, build it.

## Verifying a change

Do not report a UI change as working on the strength of the diff.

- `make start` runs the whole stack; `make stop-all` then `make restart` if it is wedged.
- **Vite on `:5173` serves whichever checkout started it, usually the main one and not your
  worktree.** Confirm you are looking at your own build before concluding anything.
- Sessions run in pooled worktrees under `~/.treehouse/` (see `treehouse.toml`), so "it works
  here" and "it works in the app" are genuinely different claims.
- Be picky about what you see. If something looks off next to what you changed, fix it or say
  so; screenshots in this repo's history are mostly the human catching things the diff hid.

CI runs `npm run typecheck`, `npm test`, and `npm run build` on Node 24 and 25. There is no
linter.

## House rules

- **Never use the em dash.** Use a plain dash. This is enforced and has cost a fix round.
- Branches are `mancej/<kebab-slug>`; commits are `type(scope): sentence` (`feat`, `fix`,
  `docs`, `refactor`, `test`), or a plain sentence for larger changes.
- Never add an agent name as commit co-author.
- Never hand-edit `CHANGELOG.md` or anything marked auto-generated.
- Prefer quality, simplicity, and long-term maintainability over development cost.
- Start a bug fix by reproducing it end to end, the way a user hits it. The fix that follows a
  real reproduction is the one that holds.
