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
| `src/server/inspector` | `worker.ts` | Reviews the PRs we opened. In the daemon, not the Foreman. |
| `src/server/terminal` | `registry.ts` | tmux/wezterm behind two interfaces. Mechanism only; the write policy stays in `actions.ts`. |
| `hooks/` | `harness-hook.mjs` | Bare node per Claude hook event. POSTs to the daemon. |

- The Foreman is a separate process and **never touches the DB**. If it needs state, add a
  route.
- The **Inspector is in the daemon**, deliberately: Electron never starts the Foreman
  worker, so a packaged build would silently not have the feature, and every piece of its
  state has to survive a restart. Do not move it.
- The live channel is SSE only. The web app does not poll.

## Compiler-enforced contracts

These all fail typecheck now. Know the right answer when you hit the error.

**New `Session` field** → give it a comparator in `SESSION_FIELD_COMPARATORS`
(`src/server/registry.ts`). `byValue` for scalars, `byJson` for nested objects. `alwaysEqual`
only for fields that cannot change for the life of a map entry, and it needs a comment saying
why - do not use it to silence the error. Read the `queue` / `orphanedQueue` entries and the
`KNOWN GAP` note before adding a denormalized field. Test: `session-contracts.test.ts`.

**New `ServerEvent` variant** → add a `case` in `src/web/useEventStream.ts`. If it adds a
top-level collection, also extend the `snapshot` case, `registry.snapshot()`, and
`MissionState`.

**New agent id** → add it to `AGENT_TYPES` (`src/shared/types.ts`) and nowhere else: the
`z.enum` in `protocol.ts`, `DispatchInput`, the dispatch modal's `<option>`s and the
Harnesses rows all derive from it. `AgentType` is that array's element type, so every
`Record<AgentType, …>` then fails to compile until the new harness has said what it is
called AND what colour it wears (`AGENT_IDENTITY`, `@shared/agent.ts`), which models it
offers, which of its capabilities exist at all - including how its process is recognised
and which binary it launches (`HARNESSES`, `src/server/harness/index.ts`) - and how it
answers goals and cost. Fill each in rather than defaulting one. Nothing in `styles.css`
and no component needs editing: the accent is a literal colour that reaches CSS as one
inline `--agent-accent`, and every sentence naming which agents a feature reaches is
computed (`agentList`, `skillsAgents`, `autoModeAgents`). Test:
`session-contracts.test.ts`, which pins that list, and `agent-accent.test.ts`, which
fails if an agent id turns up in the stylesheet again.

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
The server-side cleanup has one owner, `resetSession` (`src/server/reset.ts`) - route a new
reset caller through it, never copy the cleanup into a handler.

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

**Claude hook events are declared ONCE**, on the harness: `claudeHooks.events` /
`.matcherEvents` (`src/server/harness/claude/hooks.ts`). Both installers - `hooks/install.mjs`
and `src/main/integrations.ts` - import it, and `harness-hooks.test.ts` fails if either
names an event itself again. A new event is that list plus a `toState` case beside it, plus
whatever `hooks/harness-hook.mjs` has to lift out of its payload. Keep that file importing
only types and pure functions: the Electron main bundle reaches it, and must not pull the
daemon (and `node:sqlite`) in behind nine strings, which is why both installers import the
spec's module directly rather than `harness/index.ts`.

**MCP tool args are validated twice** - hand-written zod in `src/mcp/server.ts` duplicating
`src/shared/protocol.ts`. Change both. Hand-kept; nothing catches drift.

**A prompt that DESCRIBES a session's screen asks that session's harness.** Foreman's
reviewer and router prompts are the one place the harness and runner axes legitimately
meet: which model judges is settled before the prompt is built, but what is being judged is
a session of some harness, and the menu grammar ("you MUST fill answer.option", "it
discards typed characters") is a claim about that harness's TUI. `ReviewInput.session.agent`
is required for this, and `promptHarness` (`foreman/prompt.ts`) is the projection - a small
pure shape, so the no-menu branch is reachable from a test before a harness declaring
`tui: null` exists. Both shipped harnesses draw dialogs, so that branch has no agent id to
reach it. Test: `foreman-prompt-harness.test.ts`.

**New mutating route** → add a zod schema in `protocol.ts` and go through `parseBody`. Never
hand-parse a body.

**PR provenance is two signals, and `prUrl` is not one of them.** `prUrl` (hook sniff) and
the `gh pr list` poller both match PRs we did not open; only `prCreated` (the hook matching
the `gh pr create` COMMAND) and `NmRunSummary.prUrl` (no-mistakes reporting its own `pr:`
line) prove authorship, and only those reach `adoptPr`. Loosening that means commenting on
strangers' pull requests. Test: `inspector-adoption.test.ts`.

**New column on an existing table** → editing the `CREATE TABLE IF NOT EXISTS` block is not
enough. Add an `addColumn` call in `migrate()` (`src/server/db.ts`). New tables need nothing.

**No backticks inside `openDb()`'s SQL block.** It is one template literal, so a backtick in
a `--` comment ends it and the file stops parsing. Name identifiers bare.

**A `UNIQUE` index you `ON CONFLICT` against must have no nullable columns.** SQLite treats
NULLs as distinct, so the upsert silently becomes an insert and the row multiplies on every
retry. `usage_ledger.model_id` / `query_source` are `NOT NULL DEFAULT ''` for this reason.

**New build entry point** → the `package.json` script, the `build` chain, the
`--alias:@shared` flag, the `files:` allowlist in `electron-builder.yml`, and the hard-coded
`dist/` paths in `src/main/index.ts`, `src/main/integrations.ts` and `mcpServerPath()` in
`src/server/config.ts` (the MCP bundle the ask channel points a dispatch at). The `@shared`
alias is declared in four places that must agree: `tsconfig.json`, `vite.config.ts`, and the
esbuild flags.

**Never enable asar**, and never move `skills/` into `dist` - Claude launches
`dist/satellites/hook.mjs` and `dist/mcp/server.mjs` with an external node, and `skills/` is
reached through a symlink.

**Append-only**, since old values persist on users' machines: skill directory prefixes in
`src/shared/skills.ts`, the task source kind ids in `TASK_SOURCE_KINDS`
(`src/shared/task-source.ts`), the background-job ids in `LLM_JOB_IDS`
(`src/shared/llm-jobs.ts`), and the `MISSION_` / `FLEET_` / `HARNESS_` env fallback
chain in `src/shared/harness-runtime.mjs`.

**Append-only, and it lives on GitHub, not on this machine**: the Inspector's comment
marker `mission-inspector:v1` (`src/server/inspector/marker.ts`). Comments carrying it are
live on pull requests right now. Changing the prefix does not migrate them, it ORPHANS
them - each becomes unrecognisable, so it is never resolved and its issue is re-posted as a
duplicate. A new format gets a new version tag parsed **alongside** this one.

## Registries - extend these, do not start a parallel list

- **Settings panels**: `SETTINGS_CATEGORIES` in `SettingsModal.tsx` + a `case` in
  `renderCategory`. `settings-sidebar-render.test.ts` asserts nav count equals array length.
  State App also renders is passed in as props; state only the modal uses is local.
- **Keyboard shortcuts**: `ActionId` + `ACTIONS` in `lib/keybindings.ts` (array order is panel
  order), plus a dispatch branch in `App.tsx`, usually an `ActionBarHandle` method and its
  registration, a `CommandBar` keycap, a README table row, and a `keybindings.test.ts` case. A
  new group also needs a `GROUPS` entry in `KeyboardPanel`.
- **Harnesses (the agent axis)**: **two records, split by purity, and a new agent must fill
  in both.** `HARNESS_CAPABILITIES` (`@shared/harness-capabilities.ts`) holds what can be
  answered without a `node:` import - permission modes, skills, work queue, context
  clearing, MCP - because the dashboard decides most of these in the browser and cannot
  import a spec that calls `statSync`. `HARNESSES` (`src/server/harness/index.ts`) spreads
  that record in and adds what needs one (`transcript`, `hooks`, `control`, plus a spec per
  capability under `src/server/harness/<agent>/`); `Harness extends HarnessCapabilities`, so
  a server call site holding a harness still reads every slot off one object. The two
  `Record<AgentType, …>`s are the enforcement - a new agent id that declares nothing does
  not compile - and they ask disjoint questions, so neither is a copy of the other. Do not
  put a pure capability in the server record or a filesystem-reading one in shared.
  **`null` is a first-class answer, never a stub**: `HARNESSES.codex.transcript.messages`
  is null because a rollout carries metadata and no turns, and every reader then takes the
  one already-tested "unavailable" path instead of an empty window that reads as "this
  session said nothing". `HARNESSES.codex.hooks` is null for the same kind of reason -
  Codex pushes nothing at us - and a null there is load-bearing in three places: the
  ingest is refused rather than read by Claude's event vocabulary, the pane-keyed hook
  overlay is agent-scoped so the card Codex started in a vacated pane does not inherit
  Claude's last state, and `awaitReady` skips its 20s wait. **`detect`, `bin` and `control`
  are the three that are NOT nullable**: a harness nothing can find on the process table has
  no card at all, one that names no binary cannot be dispatched, and one we cannot talk to
  is not one we can dispatch to. Inside `control`, though, `pastePlaceholder: null` is
  first-class again - it says this TUI renders no collapsed-paste placeholder, so submit
  verification has no evidence to read, which is NOT the same claim as "the composer is
  clear"; the delivery path spends one Enter and reports `submitVerified: false`.
  `discovery/processes.ts`
  iterates `detect` and names no vendor - including the background roles, which are TOKENS
  matched at argv[1]/argv[2] and never substrings of a command line carrying an operator's
  paths and a 1.2KB prompt. `resolveAgentBin` (`harness/index.ts`) is the ONE bin resolver,
  for dispatched sessions and headless runs alike; it lived in `config.ts` while
  `claude-cli.ts` kept a second chain, and the two disagreed. `codex.clearContext` is null
  because `/clear` is Claude's slash command, and reset degrades to the byte-identical
  `cleared: false` a pane-less session produces. An absence a HUMAN sees needs its
  sentence composed from the capability (`workQueueUnsupportedWhy`), not typed at each
  refusing surface. `HARNESSES.codex.tui` is the counter-example, and the one to read
  before declaring any capability `null`: it is NOT null. The guard it replaced said
  `agent !== "claude"`, with a comment above it asserting Codex "doesn't render these
  dialogs" - and because the guard
  skipped the parse, nothing ever tested that claim. It is false. Codex renders the same
  numbered, single-cursor menus and differs by ONE token, the cursor glyph (U+203A against
  U+276F), so `DialogSpec` carries the glyph and `discovery/pane-dialog.ts` stays
  harness-neutral machinery - the same split `transcript.ts` makes. Note the restatement
  that came before it, `capabilitiesFor(s.agent).permissionModes`, was not a fix: Codex has
  no permission modes, so gating the DIALOG on them skipped exactly the sessions whose
  dialogs are the only signal they can produce. **A capability is null only after you point
  it at a real capture**; `test/fixtures/codex-panes.ts` is what that costs, and those
  fixtures are verbatim, never hand-written. Getting it wrong is expensive in one specific
  way here: Codex sends no hooks, so `activePaneDialog` is the ONLY "needs you" evidence it
  can ever produce, and a Codex session parked on a command-approval prompt read as merely
  unconfirmed. Reach a capability through a registry (`capabilitiesFor`,
  `harnessFor`, `sessionMessages`, `transcriptFor`, `hooksFor`, `tuiFor` / `dialogSpecFor` /
  `modeLineSpecFor`, `controlFor`), never by testing `s.agent`; each phase of
  `docs/plans/pluggable-integrations/plan.md` adds a slot. Test:
  `harness-capabilities.test.ts`, `harness-transcript.test.ts`, `harness-hooks.test.ts`,
  `harness-tui.test.ts`, `harness-control.test.ts`, `detection.test.ts`,
  `harness-bin.test.ts`, `process-background-filter.test.ts`, `session-contracts.test.ts`.
- **Offline model providers**: `LLM_RUNNER_IDS` (`@shared/llm.ts`) + an entry in
  `LLM_RUNNERS` (`src/server/llm/index.ts`). The `Record<LlmRunnerId, LlmRunner>` is the
  enforcement - a new id that is not implemented does not compile, and every capability is
  either implemented or explicitly `null`. This is the *model provider* axis, orthogonal to
  which agent a card runs: keep it out of anything Harness-shaped, or you cannot review a
  Codex session with Claude. The contract is context isolation, not just the call shape -
  read `LlmRunner`'s doc before adding one. WHICH runner a call uses is one ladder,
  `resolveLlmRunner` (`@shared/llm.ts`), config then env then `DEFAULT_LLM_RUNNER_ID` - and
  unlike the model ladder it VALIDATES, because a model id is free text the CLI resolves
  while a runner id has to name something in `LLM_RUNNERS` or there is nothing to spawn. An
  unresolvable one falls back and REPORTS what it dropped (`ResolvedLlmRunner.unknown`);
  swallowed, a stored id from a newer build is indistinguishable from an unset one and the
  panel renders the fallback as the operator's own choice. The config schema `.catch()`es for
  the same reason - `getLlmConfig` is on the path of every titling, goal refresh and digest,
  and a throw there takes all of them down over a preference. The Foreman worker reads its
  runner off `/api/llm/status`, never the DB. Test: `llm-runner-contract.test.ts`,
  `llm-jobs.test.ts`, `llm-config.test.ts`. WHICH model a given call uses is a different
  question - see the model ladder below.
- **Terminal backends**: the ids are `MULTIPLEXER_IDS` / `EMULATOR_IDS`
  (`@shared/terminal.ts`) and the adapters are `MULTIPLEXERS` / `EMULATORS`
  (`src/server/terminal/registry.ts`), typed `Record<MultiplexerId, …>` /
  `Record<EmulatorId, …>`, so a new id fails typecheck until its adapter is complete. The
  ids are in `shared` for the `HARNESS_CAPABILITIES` reason - `NameSource` derives from
  them and the browser renders it - and **an id is added there and nowhere else**. Those
  two arrays are ORDERED, and the order is naming priority: `enumerateTerminals` sweeps
  multiplexers then emulators, and the first backend holding a pane on a session's tty
  names it. **They are two axes, not one**: a tmux pane lives *inside* a wezterm pane, so a
  `Multiplexer` has named sessions and a copy-mode probe and cannot raise a window, while a
  `TerminalEmulator` raises windows and has no persistence. Optional capabilities are
  `T | null` and null is a declaration - Ghostty has no scripting CLI, so `list` / `write` /
  `capture` are all legitimately null. Writes bind to the innermost handle (`bindPane`);
  focus walks outward via `clients` -> `hostPanesFor` -> `spawn(attachArgv)`. Adding a `Key`
  fails typecheck in every adapter's `Record<Key, string>` until it says what that key looks
  like in its own convention (tmux `BTab`, wezterm `\x1b[Z`). **A `BinSpec` is how a
  backend's CLI is reached, all three parts**: `env` override, `candidates`, and `dropEnv` -
  inherited vars to drop, applied by `binEnv` to EVERY command that adapter runs. An empty
  `dropEnv` is a declaration, not a gap: wezterm drops `WEZTERM_UNIX_SOCKET` because that pin
  goes stale when a GUI restarts, and tmux drops nothing because `TMUX` names a live server
  and the eleven un-migrated inline `run("tmux", …)` calls still inherit it - enumerate on
  one socket and act on another and the pane ids do not mean the same thing. `binPresent`
  answers "installed?" from the filesystem so a registered-but-absent adapter costs no spawn
  on the 1500ms tick. **Pane I/O goes through `bindPane`** (`registry.ts`), which applies the
  composition rule once and hands back a `BoundPane` a caller cannot ask the vendor of - so
  `actions.ts` branches on CAPABILITY (`!pane.write`, `!pane.write.paste`, `!pane.mode`) and
  never on an id, and a refusal names the backend from `pane.label`. `pane.mode` is the
  copy-mode probe, and its two nulls are different claims: null CAPABILITY means the backend
  has no such state (every emulator), null ANSWER means we asked and the pane is in none -
  read the first as the second and a new multiplexer's keystrokes are swallowed silently.
  The seam for all of it is `PaneDeps.pane`, so a test drives the real adapter on a fake
  subprocess (real argv) or a hand-built pane (capability nulls no shipped backend declares
  yet). Tests:
  `terminal-registry.test.ts`, `terminal-adapters.test.ts`, `terminal-enumerate.test.ts`,
  `correlate.test.ts`, `pane-write-capabilities.test.ts`, `pane-copy-mode.test.ts`.
  **Migration in progress** - discovery, pane I/O and the `Session` model are through the
  registries; focus, rename, kill and spawn still shell out to `tmux` / wezterm by name.
  They no longer branch on a field per vendor, though: each takes its handle from
  `tmuxOnly` / `weztermOnly` (`actions.ts`), whose `noDriver(backend: never)` default makes
  a second backend on either axis a TYPECHECK ERROR there rather than a Ghostty tab handed
  to `activateWeztermPane`. See `docs/plans/pluggable-integrations/plan.md` phase 2.
- **Task sources (what pulls work INTO the backlog)**: the same purity split as the
  harnesses. `TASK_SOURCE_KIND_INFO` (`@shared/task-source.ts`) holds what the settings
  panel can answer in the browser - the name, the blurb, the config schema - and
  `TASK_SOURCES` (`src/server/task-sources/index.ts`) spreads that in and adds
  `preflight` / `sweep`, the two calls that leave the process. Both are
  `Record<TaskSourceKind, …>`, so an id appended to `TASK_SOURCE_KINDS` does not compile
  until something can sweep it. **Those ids are APPEND-ONLY** - they are persisted inside
  the `taskSources` blob in `app_config`, and renaming one orphans every source configured
  under the old spelling: it stops matching a registered kind and silently never sweeps
  again, which is indistinguishable from an upstream with no new work. A source RETURNS
  candidates and writes nothing; `task-sources/ingest.ts` is the only writer, and it is
  what makes "the daemon is the only writer of the DB" true by construction rather than by
  each implementer remembering it. **De-duplication is `task_source_seen`, never the
  `source_id`/`external_id` columns on `tasks`**: a seen row outlives the task, so deleting
  a swept task does not un-see it - dedupe against live tasks would make Delete a no-op
  that re-files on the next sweep. A source never types into a pane, which is why it needs
  none of the skills reload loop's `settledIdle` + pane-read + `withPaneLock` gate; if one
  ever can, that argument has to be redone. Test: `task-source-contract.test.ts`,
  `task-source-ingest.test.ts`, `github-issues-map.test.ts`, `task-sources-panel.test.ts`.
- **Tones**: `TONE_ORDER` / `TONE_GROUPS` in `lib/tone.ts` drive grid sort, rail sections,
  board columns and board arrow-nav. Also needs a `--<tone>` token and `.tone-*` / `.badge-*`
  rules.
- **Shared predicates**: `repoAllowlisted` (`@shared/allowlist.ts`, re-exported as
  `foremanAllowlisted` from `@shared/foreman.ts` for Foreman's own callers), `composeWrapup`
  (`@shared/queue.ts`), `costTone` / `costIsNotable` (`@shared/cost.ts`), and the backlog
  autopilot's `readyBacklog` / `blockersIn` / `nextUpTaskId` (`@shared/backlog.ts`) are shared
  so every surface, and the server, decides identically. Do not copy them into a component. A
  third consent gate extends `allowlist.ts`; it does not start a matcher.
- **Which model a headless call spawns with**: one ladder, `resolveModelChoice`
  (`@shared/model-choice.ts`) - config, then env, then a NAMED fallback - and the roles stay
  with their subsystem: `FOREMAN_MODEL_SPECS` (Foreman's four), `INSPECTOR_MODEL_SPEC` (the
  Inspector's one), `LLM_JOB_SPECS` (`@shared/llm-jobs.ts` - the daemon's own background
  jobs: the titler, the goal refiner, the away digest). Three sets of roles, one ladder, and
  a fourth resolver is the thing not to write. A `claude -p` that
  passes no `--model` inherits whatever the local CLI defaults to, which is the priciest tier
  and unanswerable from inside the app; every spec's `fallback` is what rules that out, so a
  new one is filled in rather than left blank. The panel PRINTS the resolution, source and
  all, which is why the daemon reports it (`/api/foreman/status`, `/api/inspector/status`)
  instead of the browser re-deriving `config || default` over an env layer it cannot see.
  One input renders it, `ModelField.tsx`. Blank is "cleared", never `--model ""`, at every
  layer - including the config schema, which must ADMIT the empty string or the field cannot
  be cleared at all. `LLM_JOB_IDS` are **append-only**: they are persisted as the KEYS of the
  `models` map in the `llm` blob, so renaming one orphans an operator's override rather than
  migrating it. A daemon job calls `runJob` / `runJobStructured` (`src/server/llm/jobs.ts`),
  which resolves runner and model per call so a Settings edit lands on the next call rather
  than the next restart; it never names a model or a provider itself. Test:
  `foreman-models.test.ts`, `inspector-model.test.ts`, `llm-jobs.test.ts`,
  `llm-config.test.ts`.
- **A session's terminal handles**: `Session.terminals` is a LIST of `TerminalHandle`
  (`@shared/terminal.ts`), one per backend, discriminated on the AXIS (`multiplexer` /
  `emulator`) and never on the vendor. It replaced `Session.tmux` / `Session.wezterm`,
  which made "how many backends are there" a fact of the type. Read it through
  `@shared/pane.ts`, never by hand: **`canWriteTo`** answers "is there a composer to type
  into?" - the question ~20 call sites across both processes were spelling as
  `Boolean(s.tmux || s.wezterm)` - and `innermostPane` / `paneToken` answer which pane a
  write lands on (multiplexer first: its pane is the agent's, the emulator's is the client
  showing it). `muxHandle` / `emulatorHandle` are for the questions that genuinely ARE
  about one axis - a named session to kill or rename, a tab to raise - and for nothing
  else. `bindPane` (`terminal/registry.ts`) defers to `innermostPane` rather than
  restating it, so the write lock guards the pane the write reaches by construction.
  Test: `session-terminals.test.ts`, `pane-lock.test.ts`, `terminal-registry.test.ts`.
- **Pane token**: `paneToken` (`@shared/pane.ts`) spells the key every pane-scoped map uses -
  the write lock, the hook overlay, the capture-miss counter, the Foreman's send guard. There
  were four copies in two spellings (`wezterm:` and `wez:`); each subsystem only compared the
  token against itself, so the fifth copy is where that becomes a session whose hooks bind to
  nothing. No token is persisted, which is what keeps the spelling changeable. Test:
  `pane-lock.test.ts`.
- **`~/.claude/settings.json` writers**: `hooks/install.mjs`, `src/main/integrations.ts`, and
  the daemon (via `src/server/cost.ts`). The telemetry `env` block has ONE definition in
  `@shared/claude-settings.ts` - three copies of six keys is how half a block gets left
  behind that nothing owns. Keep `src/shared/claude-settings.ts` free of daemon imports:
  the Electron main bundle imports it, and must not pull `node:sqlite` in transitively.
  Test: `telemetry-env.test.ts`.

## Styles

`src/web/styles.css` is one 7,800-line file: no preprocessor, no modules, no Tailwind. A
`:root` token block, then ~60 sections in feature order marked `/* ---- name ---- */`. Classes
are `block-element` with per-feature prefixes (`wq-`, `nm-`, `rt-`, `qc-`, `tf-`, `board-`,
`console-`, `rail-`, `detail-`).

- **When you remove or rename a `className`, grep `styles.css` for it in the same change.** No
  linter, no stylelint, no unused-CSS check catches a class that lost its rule.
- **No vendor is named in this file, and no token is named after one.** A harness's colour is
  declared on the harness (`AGENT_IDENTITY`) and arrives as an inline `--agent-accent`; rules
  read `var(--agent-accent, var(--neutral))`. Foreman is `--foreman`, its own token, because
  it borrowed `--claude` for five rules and a retune of one silently restyled the other.
  Test: `agent-accent.test.ts`, which fails on any agent id appearing here.
- **In the desktop shell the topbar IS the title bar**, so it carries
  `-webkit-app-region: drag`. The property's initial value is `none`, which is not `no-drag` -
  only an explicit `no-drag` subtracts from the region, so painting a layer over the bar does
  NOT take its own clicks back: the OS keeps the mousedown and the renderer never sees it, and
  the layer hovers correctly while refusing to fire. **A new floating layer** (fixed, or a
  `z-index` above the topbar's 10) **goes in the `.is-desktop` no-drag rule**, or is exempted
  in the test with a reason the test re-checks. Test: `desktop-drag-region.test.ts`, which is
  the only thing that reads this file.
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
