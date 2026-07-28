# AGENTS.md

Mission Control: a local control plane for Claude Code / Codex / Pi sessions across terminal
backends and embedded runtimes.

This file lists the **surfaces that have to move together**. For what the product does and
how to run it, read `README.md`.

## IMPORTANT

NEVER RERUN no-mistakes skill after it passes and you are addressing inspector feedback. Instead, always fix the inspector 
issues, resolve merge any conflicts, push the code, monitor the CI / PR for new inspector comments or conflicts, and repeat, conflicts, and repeat it's green.

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
| `src/server/terminal` | `registry.ts` | Terminal backends behind multiplexer/emulator interfaces. Mechanism only; the write policy stays in `actions.ts`. |
| `src/server/sdk` | `supervisor.ts` | Owns sessions the daemon RUNS (`runtime: "sdk"`). In the daemon, for the Inspector's reasons. |
| `hooks/` | `harness-hook.mjs`, `codex-hook.mjs` | One bare node per hook event, one bridge per hook-capable harness. POSTs to the daemon. |

- The Foreman is a separate process and **never touches the DB**. If it needs state, add a
  route.
- The **Inspector is in the daemon**, deliberately: Electron never starts the Foreman
  worker, so a packaged build would silently not have the feature, and every piece of its
  state has to survive a restart. Do not move it.
- The **SdkSupervisor is in the daemon too, for the Inspector's two reasons**: Electron never
  starts the Foreman worker, so a packaged build would silently not have the feature, and
  every piece of its state has to survive a restart. It is the second and only other producer
  of Registry sessions (the Registry remains the map's owner), and it has three invariants.
  `restore()` completes BEFORE
  `startPoller(registry)` (`src/server/index.ts`), because every restart twin hangs off
  `onSessionsObserved` and a session registered after the first completed sweep is invisible
  to the reconciliation that would settle its task. `applyDiscovery`'s unseen-means-exited
  loop is scoped to `runtime === "terminal"`, because "no process on a tty matched" is no
  information at all about a session that has no tty. And a driver-run session leaves through
  the SAME `beginEviction` a vanished pane does - see "A session going away".
  Two more arrived with the first driver. **A shutdown SUSPENDS, it does not exit**:
  `stopAll` sets `shuttingDown`, which is the only thing deciding whether the pump writes
  `exited` or `suspended`, and an embedded subprocess is OUR child - recording a restart as
  `exited` makes every clean one indistinguishable from an agent that finished, and
  `reconcileOnStartup` would then run `git worktree remove --force` over work that was
  merely interrupted. **`taskLiveness` answers from the ROW, not the handle map**, because
  it is consulted during startup reconciliation, which runs before `restore()` has
  relaunched anything. **Interrupted work is a ROW fact too**: `turn_in_progress` is set
  when the driver accepts work (with `state: working` as a backstop), cleared as work emits
  `turn_done` or when a confirmed successful context reset establishes an idle replacement,
  and preserved through `suspended`. Restore first reattaches the SAME
  conversation with an empty launch prompt, then sends the cautious continuation through
  the ordinary serialized handle only for a row carrying that bit. Do not infer it from
  `status === "running"` - idle handles have that status too - and do not nudge every
  restored session, because an intentionally idle conversation must remain idle.
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
fails if an agent id turns up in the stylesheet again. It must also say which RUNTIMES it
offers (`runtimes`, `@shared/harness-capabilities.ts`) and, if `"sdk"` is one of them, hold a
driver behind it (`Harness.sdk`) - one fact in two files, pinned by `harness-sdk.test.ts`.
`["terminal"]` with `sdk: null` is the honest answer for a harness nobody has written a
driver for. Resuming a conversation in an interactive CLI is a separate capability:
`Harness.resume` holds a `ResumeSpec`, while `HarnessCapabilities.resumes` is its
browser-readable mirror, pinned together by `harness-resume.test.ts`. Keep it off
`SdkSpec`: a harness can reopen its own conversation without having an embedded driver.
The handoff and session-launch routes reach the argv through the harness registry, never
by testing `session.agent`.

**A driver's transport is spoken in ONE module and its deps module, and nowhere else.**
Claude's is `@anthropic-ai/claude-agent-sdk` behind `ClaudeSdkDeps.query`; Codex's is
`codex app-server` JSON-RPC behind `CodexSdkDeps.connect`. Both seams exist so a test drives
the REAL adapter - every projection, the pending-request bookkeeping, the answer mapping -
on a scripted stream with no agent binary on the machine, and both are the `PaneDeps.pane`
pattern. Codex's protocol is EXPERIMENTAL upstream, which is exactly why its bindings are
generated and committed rather than hand-typed: `scripts/codex-app-server-bindings.mjs`
runs `codex app-server generate-ts`, takes the transitive closure of the roots declared in
it, and flattens that into `harness/codex/app-server/protocol.ts` with the generating
version stamped in. The full generator output is 617 files and 2.5MB of accounts, app
marketplace and realtime-voice types nothing imports; pruning is what makes a version bump a
diff a human reads. `codex-app-server-bindings.test.ts` fails if a second module starts
naming app-server methods.

**A driver's SANDBOX is not the same kind of setting as its approval policy, and Codex is
where that bites.** `CODEX_POSTURES` (`harness/codex/sdk.ts`) is the single statement of
Codex mode posture for embedded sessions, and it is the exact inverse of
`parseRolloutPermissionModeRead` (`codex/rollout.ts`) - the card's chip is rendered from the
rollout, so a posture the reader cannot map back is a session whose chip shows a mode nobody
picked. `codex-sdk-modes.test.ts` drives one against the other. Measured against codex-cli
0.145.0: approval policy, reviewer, model and effort are per-TURN overrides and apply on the
next `turn/start`; the sandbox is fixed for the life of a thread, and `thread/resume`
silently REJOINS a running thread rather than reconfiguring it, so a mode needing a
different sandbox is refused rather than reported as applied. `approvalsReviewer` is on the
table because it is the only thing separating `askForApproval` from `approveForMe`.

**A pane fact must not gate a pane-less session, and the effort route is the worked
example.** `sessionEffortTargetResult` (`actions.ts`) refuses a level more than one
keystroke from the current one, which is the truth about a `shortcuts` picker and says
nothing about `turn/start`'s `effort` parameter. `driverEffortTargetResult` beside it is the
SDK arm: the level has to be one the harness offers for that model, and nothing else. This
was invisible while Claude was the only driver, because its picker is `horizontal` and that
narrowing is a no-op.

## Layout parity

**Dropdowns** → Native single `<select>` controls inherit the shared `select:not([multiple])`
rule in `styles.css`; it owns the dark open menu, chrome, focus and disabled states. Scoped
rules may size or place a dropdown, not repaint it; a deliberate exception needs a test.

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
- **Runtime location is one shared fact in three vocabularies.** `SessionWhere` supplies the
  card and detail runtime chip (or terminal source), `RuntimeTileFlag` supplies the Board
  overview flag, and `runtimeRailMark` supplies the rail's `◈`. Change them together in
  `session-bits.tsx`; `session-leaf-parity.test.ts` pins all four session drawings.
- The backlog's scheduling toggle is one shared `ScheduleSwitch` in `session-bits.tsx`,
  used by both the Board card and Sitrep row. Test: `backlog-enabled-render.test.ts`.
- **Three mark vocabularies still disagree**: `RailRow` glyphs, `SessionTile` `.tile-flag`
  chips, `SessionCard` chips (+ `queueChipView` in `lib/queue.ts`). A new session-level signal
  must be added to all three. Known gap, next thing worth unifying. `CostChip` is the worked
  example: the figure in three surfaces, an `≈$` glyph in the rail's `marks`, and one shared
  `costIsNotable` (`@shared/cost.ts`) deciding where the line sits - not three thresholds.
- Console detail CSS reaches into shared components with descendant selectors
  (`.detail-conv > .pane-dialog`, `.detail-conv > .transcript`, `.detail-foot .actions`).
  Changing `PaneDialogPrompt`, `TranscriptPanel`, or `ActionBar` DOM can break console/board
  with no compile-time signal.
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

## A session going away

`session_remove` is the durable signal, and the ONLY one: Registry emits it from its eviction
timer, 8s after a completed sweep stopped seeing the process, so a session marked `exited` by
one sweep and rediscovered by the next never reaches it. Anything keyed to `state === "exited"`
instead fires on that hiccup.

**There are two ways a session can stop existing and ONE sequence for both.**
`beginEviction` (`registry.ts`) is it - exited emitted now, `remove` after the linger - and it
is shared by the discovery sweep's unseen loop and by the SdkSupervisor's `exited` driver
event. A second teardown that skipped it would be a card that vanishes from the dashboard
while its task stays `running` for ever, because the durable subscribers below are keyed on that
event and on nothing else. Correspondingly, the sweep's loop is scoped to
`runtime === "terminal"`: it reads the process table, and a driver-run session was never in
it. Do not add an eviction path, and do not widen that scope. Three subscribers today -
`WorkflowManager` orphans its bindings, `TaskManager.reconcileTasksBoundTo` settles the task
that session was running, and `ReviewManager` orphans its pending reviews - and a fourth
piece of durable state bound to a session belongs here rather than in a poller of its own.

**Each has a restart twin, and both halves are needed.** Sessions are rebuilt from the process
table, so nothing bound to one is reconcilable until the first completed sweep says what is out
there; `registry.onSessionsObserved` is that moment (`reconcileTasksWithNoLiveSession`,
`reconcileBindingsAfterDiscovery`, `orphanReviewsWithNoLiveSession`). The startup loop in
`TaskManager`'s constructor is NOT that twin - it visits only tasks still holding a worktree or
home, so an assigned task, which owns neither, was invisible to it on every restart and stayed
`running` forever. SDK sessions have no process-table twin, so `SdkSupervisor.restore()`
registers or evicts every resumable row BEFORE `startPoller(registry)` can produce that first
completed sweep. A failed resume still takes the shared `beginEviction` path, which lets the
same `session_remove` subscribers settle its durable bindings.

**Settling is not tearing down.** `agentWentAway` marks the task `done` when any of its work
episodes produced a merged PR (using the newest merge when several did), and `failed` only
when none did; either way it KEEPS the worktree, branch and home for the operator's confirmed
Clean up (`reclaim`). The asymmetry with
`reconcileOnStartup`, which does reclaim, is the point: that path is collecting rows nobody can
see, this one makes the row visible the instant it happens. `git worktree remove --force`
belongs behind a human click here, the same rule `complete` states ("Mark done must not discard
work"). Test: `task-session-orphan.test.ts`, `task-merge-settles.test.ts`,
`task-durable-merge.test.ts`.

**`Task.sessionId` is "currently executing on", and it MOVES.** A session runs tasks
SERIALLY over its life, so the field is a pointer, never a biography - which agent produced
a piece of work is a question for that task's work-episode bindings, and a completion is
decided from them (`mergedPrFor`). The pointer is EXCLUSIVE: `idx_tasks_session` is a partial
UNIQUE index and `upsertTask` (`db.ts`) unbinds every other row in the same transaction, so a
terminal row keeps naming its session only until the agent takes its next task. Two
consequences to write code by. A liveness reader filters on STATUS (`running` /
`dispatching`), not on the bare pointer - `agentIsFree` and `TaskManager.assign` are the two
enforcement points of "at most one non-terminal task per session", and a third caller that
binds the pointer needs the same check or it silently strands the row it displaces. And
`Registry.activeTaskFor` states its own order (executing row first, then newest terminal)
rather than resting on the index, because `publishEpisodeTaskChanges` writes the task map
directly. Test: `task-multi-session.test.ts`.

**KNOWN GAP beside it**: `invalidateTaskOwnershipInTransaction` (`db.ts`) is the one
binding-deleting path that does not archive first. Its local comment owns the unresolved
tension between durable merge evidence and dependency-release boundaries.

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

**A harness's hook events are declared ONCE**, on the harness: `claudeHooks.events` /
`.matcherEvents` (`src/server/harness/claude/hooks.ts`), `CODEX_HOOK_EVENTS`
(`src/server/harness/codex/hooks.ts`), which is both that spec's `events` and what
`prepareCodexLaunch` writes overrides for. Claude's two installers - `hooks/install.mjs` and
`src/main/integrations.ts` - import its spec, and `harness-hooks.test.ts` fails if either
names an event itself again. A new event is that list plus a `toState` case beside it, plus
whatever that harness's bridge in `hooks/` has to lift out of its payload. Keep those
bridges importing only types and pure functions: the Electron main bundle reaches them, and
must not pull the daemon (and `node:sqlite`) in behind nine strings, which is why both
installers import the spec's module directly rather than `harness/index.ts`.

**Codex's hooks are LAUNCH-scoped, and the asymmetry with Claude's is the design.** Claude's
are installed once into `~/.claude/settings.json` and reach every session on the machine.
Codex's are `-c hooks.<Event>=[...]` overrides that `prepareCodexLaunch`
(`src/server/harness/codex/launch.ts`) injects into the argv of a session WE dispatch, so a
Codex session an operator started themselves still pushes nothing and is still read
passively. The `--dangerously-bypass-hook-trust` riding with them is why it has to stay that
way: it is process-wide for that launch, so it also clears whatever hooks the checkout's own
Codex config declares, and it is spent only on a dispatch into an allowlisted repo. The
function returns the overrides and the flag together or neither - never a lone trust bypass -
and reports `instrumented` so the dispatcher knows whether a later silence is evidence of
anything.

**The Codex hook bridge path is resolved by `codexHookPath()` in `src/server/config.ts`**,
and it lives THERE for exactly the reason `mcpServerPath()` documents: esbuild collapses the
daemon into `dist/server/index.mjs`, so only a module already two levels down in the source
tree resolves `../../dist/satellites/codex-hook.mjs` the same before and after bundling.
Written from `harness/codex/launch.ts` it pointed four levels above the bundle, `existsSync`
failed, and every packaged build silently launched Codex uninstrumented - the designed
fallback firing for a reason that is not the designed one.

**Launch-scoped MCP is declared ONCE, in `src/server/mission-mcp.ts`.** One descriptor -
`mcpServerPath()` plus a runtime and its env - rendered into whichever launch grammar the
harness speaks: Claude's `--mcp-config` JSON file (written atomically, still at
`<state>/ask-channel/mcp.json` because renaming it would orphan the file every installed
argv already points at) and Codex's three `-c mcp_servers.mission-control.*` TOML
overrides. All three of Codex's keys or none: a `command` with no `args`, or an Electron
runtime with no `ELECTRON_RUN_AS_NODE`, is a server that looks registered and never starts.
`MISSION_MCP_TOOLS` is the tool vocabulary a caller REQUIRES by name, and a name that does
not match what `src/mcp/server.ts` publishes pre-approves nothing while looking as if it
did - `mission-mcp.test.ts` scrapes that file's `registerTool` calls and fails on drift.
`askChannelArgs` consumes the descriptor and stays all-four-or-none; a required tool widens
its `--allowed-tools` rather than adding a second registration. None of this touches what
`claude mcp add` / `codex mcp add` wrote machine-wide (`src/main/integrations.ts`), and none
of it reaches a session an operator started. Test: `mission-mcp.test.ts`.

**A dispatch branches ONCE on the runtime, after provisioning, and everything the terminal
path does after that branch is absent on the other side rather than skipped.** No home (so
`Task.homeName` stays null and teardown has nothing to kill), no `waitForSessionAtCwd` (we
are holding the session), no `awaitReady` (the driver's `bound` IS readiness, and it cannot
be missed), no `deliverIntent` (the intent is turn one). `resolveDispatchRuntime`
(`harnesses.ts`) is the only reader of the stored choice, and it composes
`resolveSessionRuntime` (`@shared/harness-capabilities.ts`), which the settings panel
narrows through too - the daemon and the card must not disagree about which runtime is in
force. An unreadable stored value, or one naming a runtime the harness declares no driver
for, falls back to `"terminal"` and REPORTS what it dropped; a build with no supervisor
FAILS the dispatch rather than quietly taking the terminal path, because the operator asked
for one thing and would have got another. The three-valued liveness contract gains its SDK
arm here: `taskLiveness` is asked BEFORE `homeAlive`, because an embedded task has no
`homeName` at all and the terminal reading of that absence is a confident "gone" over a
worktree an agent is working in. Test: `dispatcher-runtime.test.ts`.

**A handoff TRANSFERS a task's binding; it must not settle it.** `handOffToTerminal`
(`sdk/handoff.ts`) clears `Task.sessionId` BEFORE stopping the driver, not after: the stop
begins the eviction, `session_remove` is what settles a task, and relying on the 8s linger
to outrun a patch would work today and be a silent `failed` on the day it does not. It then
waits for the pump (so the harness has closed its session file before another process opens
the same conversation), spawns through the SAME `spawnUniquely` a dispatch uses, records the
home name so teardown can still find it, and rebinds to whatever discovery adopts. The argv
comes from `resumeArgvFor` through `Harness.resume`, never composed at the route. Test:
`sdk-answer-http.test.ts`.

**A dispatch may pin its input commit, and that is mechanism with no policy in it.**
`TaskDispatchOptions` (`src/server/dispatcher.ts`) is ephemeral and server-only - nothing on
it is persisted on a Task, because a caller that needs a relaunch to make the same request
has to hold that request in its own durable state anyway. `verifyPinnedBase` takes FULL
commit ids only: a ref name resolves fine and means something different an hour later, which
is the drift a pin exists to remove. Both providers converge on that commit - the git
fallback cuts from it instead of `HEAD`, a pool lease is hard-reset to it after
`pinLeasedWorktree` proves the tree belongs to this repository - and both then re-read `HEAD`
to prove it took. A pinned provisioning failure unwinds what it created (return the lease,
tear down the worktree) before throwing, because it throws before the Dispatcher records the
path and nothing downstream could ever find it. Test: `dispatch-pinned-base.test.ts`,
`dispatcher-cleanup.test.ts`.

**A worktree is captured through a TEMPORARY index, never the real one.**
`src/server/git/ensemble-snapshot.ts`: `read-tree` / `add -A` / `write-tree` / `commit-tree`
under `GIT_INDEX_FILE`, then one ref under `refs/mission-control/ensembles/<uuid>/<uuid>`.
That is what leaves the member's staged/unstaged split, HEAD, branch and working tree
byte-identical - a capture that committed through the real index would silently rewrite the
staging area of an agent that is still working. Ref components are validated as generated
UUIDs before they reach `update-ref`. `resetWorktreeToCommit` is the ONE owner of "hard
reset, then `clean -fd` and never `-fdx`", shared by pinned provisioning and artifact
restore: `-x` would delete the ignored warm dependencies a pooled tree exists to keep.
Diffs are `baseSha..snapshotSha` DIRECTLY, never through a merge-base walk, because a member
may amend or rebase and the snapshot is still an exact artifact; truncation reports its
omitted byte count, and a patch too large to buffer is refused rather than given an invented
one. Test: `ensemble-snapshot.test.ts`.

**`applyHook`'s attribution guard compares against `discoveredIdentity`, and nothing else.**
That map (`src/server/registry.ts`) holds what PASSIVE DISCOVERY read off the live process -
the rollout an exact pid holds open - which a hook cannot contradict. `Session.agentSessionId`
is a different claim: it is the last binding we LEARNED, from a hook or from
`lastAgentBinding` after a restart, and a `/clear` mints a new agent session id on the same
pane. Guard on the session field and the event that is supposed to REBIND the card is the one
refused, leaving its note, queue and goal on a dead key no later hook can move either. A
sweep that could not read the rollout this tick says nothing rather than retracting last
tick's reading, so one failed `lsof` does not briefly disarm the guard. Test:
`queue-orphan-sweep.test.ts`.

**MCP tool args are validated twice** - hand-written zod in `src/mcp/server.ts` duplicating
`src/shared/protocol.ts`. Change both. Hand-kept; nothing catches drift.

**A prompt that DESCRIBES a session's screen asks that session's harness.** Foreman's
reviewer and router prompts are the one place the harness and runner axes legitimately
meet: which model judges is settled before the prompt is built, but what is being judged is
a session of some harness, and the menu grammar ("you MUST fill answer.option", "it
discards typed characters") is a claim about that harness's TUI. `ReviewInput.session.agent`
is required for this, and `promptHarness` (`foreman/prompt.ts`) is the projection - a small
pure shape. Pi declares `tui: null`, so its sessions take the no-menu branch rather than
being described in another harness's dialog vocabulary. Test:
`foreman-prompt-harness.test.ts`.

**New mutating route** → add a zod schema in `protocol.ts` and go through `parseBody`. Never
hand-parse a body.

**PR provenance is two signals, and `prUrl` is not one of them.** `prUrl` (hook sniff) and
the `gh pr list` poller both match PRs we did not open; only `prCreated` (the hook matching
the `gh pr create` COMMAND) and `NmRunSummary.prUrl` (no-mistakes reporting its own `pr:`
line) prove authorship, and only those reach `adoptPr`. Loosening that means commenting on
strangers' pull requests. Test: `inspector-adoption.test.ts`.

**New column on an existing table** → editing the `CREATE TABLE IF NOT EXISTS` block is not
enough. Add an `addColumn` call in `migrate()` (`src/server/db.ts`). New tables need nothing.
**An INDEX over that new column cannot live beside its table**: the CREATE block runs
BEFORE `migrate()`, so on an upgrading database the statement references a column the ALTER
has not added yet and `openDb()` throws on first start - for every existing operator, and
never on the fresh install you tested. `idx_tasks_schedule` is the worked example; it sits
in `migrate()` under the `addColumn` calls it depends on. Test: `schedule-db.test.ts`,
which seeds a pre-feature database rather than a fresh one for exactly this reason.

**No backticks inside `openDb()`'s SQL block.** It is one template literal, so a backtick in
a `--` comment ends it and the file stops parsing. Name identifiers bare.

**A `UNIQUE` index you `ON CONFLICT` against must have no nullable columns.** SQLite treats
NULLs as distinct, so the upsert silently becomes an insert and the row multiplies on every
retry. `usage_ledger.model_id` / `query_source` are `NOT NULL DEFAULT ''` for this reason.

**New build entry point** → the `package.json` script, the `build` chain, the
`--alias:@shared` flag, the `files:` allowlist in `electron-builder.yml`, and the hard-coded
`dist/` paths in `src/main/index.ts`, `src/main/integrations.ts` and the two resolvers in
`src/server/config.ts` - `mcpServerPath()` (the MCP bundle the ask channel points a dispatch
at) and `codexHookPath()` (the bridge a dispatched Codex session is told to run). The `@shared`
alias is declared in four places that must agree: `tsconfig.json`, `vite.config.ts`, and the
esbuild flags.

**Never enable asar**, and never move `skills/` into `dist` - the agents launch
`dist/satellites/hook.mjs`, `dist/satellites/codex-hook.mjs` and `dist/mcp/server.mjs` with
an external node, and `skills/` is reached through a symlink.

**Append-only**, since old values persist on users' machines: skill directory prefixes in
`src/shared/skills.ts`, the task source kind ids in `TASK_SOURCE_KINDS`
(`src/shared/task-source.ts`), the background-job ids in `LLM_JOB_IDS`
(`src/shared/llm-jobs.ts`), the six schedule enums in `@shared/schedules.ts`
(`SCHEDULE_EXECUTION_MODES` / `_OVERLAP_POLICIES` / `_MISSED_POLICIES` / `_TRIGGER_KINDS` /
`_DECISION_KINDS` / `_OCCURRENCE_STATUSES`), every id and status tuple in
`@shared/ensemble.ts` (`ENSEMBLE_STRATEGY_IDS` / `_SOURCE_KINDS` / `_DRIVER_KEYS` /
`_ARTIFACT_KINDS`, plus the run / member / attempt / artifact / stage / evaluation /
decision statuses), and the `MISSION_` / `FLEET_` / `HARNESS_` env fallback chain in
`src/shared/harness-runtime.mjs`.

**Foreign keys are ON, and the ensemble family is the only one that declares any.** The
pragma sits beside `journal_mode` in `openDb()`, and it is safe there precisely because
nothing else in that file has a `REFERENCES` clause - it constrains only what asks to be
constrained, and a clause added to an older table becomes live the moment it is written. A
declared foreign key with the pragma off is a comment that looks like a constraint, which is
why `ensemble-db.test.ts` asserts an orphan INSERT actually throws. Every `TEXT PRIMARY KEY`
in that family also says `NOT NULL` explicitly: on a non-STRICT rowid table SQLite does not
imply it, so `PRIMARY KEY` alone admits several NULL ids.

**A persisted enum this build cannot read is a `null`, never a nearest match.** The schedule
store (`src/server/schedules/store.ts`) is where that is worked out: a row written by a
NEWER build still loads - a schedule nobody can see is one nobody can fix - but every field
that could carry an unknown value is `T | null` on `MissionSchedule` / `ScheduleRevision`,
so a caller cannot reach a policy without saying what it does when there isn't one.
`scheduleIsRunnable` / `revisionIsRunnable` are the single narrowing gates that answer it,
and the row reports `unreadable` and derives `attention`. The failure this shape rules out
is specific: reading an unknown `execution_mode` as `local-catchup` would create work on
THIS laptop that the operator scheduled for a different host, and a default in the mapper
is how that happens silently. Note the catalog reads the schedule row and the claim reads
the revision, so each has to refuse independently. Test: `schedule-db.test.ts`.

**The scheduler's decision path is four modules and each owns one question**, and a change
belongs to the one whose question it answers: `schedules/recurrence.ts` says WHEN a cadence
is due (the only consumer of `cron-parser`), `schedules/policy.ts` says WHAT should happen
to the instants it produced - pure, no clock and no database - `schedules/store.ts` owns
the claim transaction that makes a decision exactly-once, and `schedules/manager.ts`
sequences those three and copes with the ledger REFUSING a decision. A new policy written
into the manager is one no test can reach without manufacturing time; a cadence question
answered anywhere but `recurrence.ts` is a second answer that agrees with the first only by
luck. Test: `schedule-policy.test.ts`, `schedule-manager.test.ts`.
Three of its rules are the ones worth restating. **Missed policy is applied BEFORE
overlap**: reversed, a catch-up under `skip-active` blocks on its first instant and
coalesces nothing, so a fortnight away files one task and records the rest as
`skipped_overlap` - the same visible outcome as `coalesce-latest`, reached by accident and
logged as the wrong reason. **The claim owns the cursor**, in one transaction, which is why
Run now passes `advanceCursor: false` rather than writing the old value back. **Recovery
reads the OCCURRENCE row**, never the schedule's current revision: the decision kind, the
revision and the preallocated task id were all reserved before the crash, and recomputing
policy from a revision the operator has since edited silently rewrites what last night's
run was for.

**`TaskManager.create`'s second argument is the only internal door, and the refusals live
behind it, not at the caller.** `InternalCreateOptions` (`src/server/tasks.ts`) supplies a
preallocated id, plus schedule provenance only for the scheduler; ensemble ownership stays
normalized in `ensemble_members`. A retry returns the existing task untouched only when its
owner-specific identity still matches - the same schedule occurrence, or the same ensemble
member Task inputs - and anything else throws `TaskIdCollisionError` rather than adopting a
stranger's task. That idempotency is what closes both recovery windows, so it must stay in
`TaskManager`; a caller-side check will eventually drift. Every internal create must first
persist a titled `backlog` Task. A schedule stops there (Foreman remains its only autonomous
dispatch path); the ensemble engine dispatches separately through `TaskManager` only after
the complete wave exists. Ordinary callers pass no second argument and are unchanged. Test:
`schedule-task-create.test.ts`, `ensemble-engine.test.ts`, `ensemble-recovery.test.ts`.

**Append-only, and it lives on GitHub, not on this machine**: the Inspector's comment
marker `mission-inspector:v1` (`src/server/inspector/marker.ts`). Comments carrying it are
live on pull requests right now. Changing the prefix does not migrate them, it ORPHANS
them - each becomes unrecognisable, so it is never resolved and its issue is re-posted as a
duplicate. A new format gets a new version tag parsed **alongside** this one.

## Registries - extend these, do not start a parallel list

- **Settings panels**: `SETTINGS_CATEGORIES` in `lib/settings-registry.ts` + a `case` in
  `renderCategory` (`components/SettingsPage.tsx` - settings is a page, not a modal) + a
  sibling `<Name>SettingsPanel.tsx`, whose control rows carry `data-anchor="<category>/<slug>"`
  and whose entries in `lib/settings-search.ts` point at those anchors.
  `settings-sidebar-render.test.ts` asserts nav count equals array length, contiguous
  grouping, and that every anchor is unique and names a real category. State App also renders
  is passed in as props; state only the page uses is a hook owned by the page.
- **Keyboard shortcuts**: `ActionId` + `ACTIONS` in `lib/keybindings.ts` (array order is panel
  order), plus a dispatch branch in `App.tsx`, usually an `ActionBarHandle` method and its
  registration, a `CommandBar` keycap, a README table row, and a `keybindings.test.ts` case. A
  new group also needs a `GROUPS` entry in `KeyboardPanel`.
- **Harnesses (the agent axis)**: **two records, split by purity, and a new agent must fill
  in both.** `HARNESS_CAPABILITIES` (`@shared/harness-capabilities.ts`) holds what can be
  answered without a `node:` import - permission modes, skills, work queue, reasoning
  effort, context clearing, MCP - because the dashboard decides most of these in the
  browser and cannot import a spec that calls `statSync`. The server-side `HARNESSES`
  record (`src/server/harness/index.ts`) spreads that record in and adds what needs one
  (`transcript`, `hooks`, `control`, plus a spec per capability under
  `src/server/harness/<agent>/`); `Harness extends HarnessCapabilities`, so a server call
  site holding a harness still reads every slot off one object. The two
  `Record<AgentType, …>`s are the enforcement - a new agent id that declares nothing does
  not compile - and they ask disjoint questions, so neither is a copy of the other. Do not
  put a pure capability in the server record or a filesystem-reading one in shared.
  **`null` is a first-class answer, never a stub - and it is an answer that has to be
  MEASURED.** Five of Codex's were not, and all five were wrong. `transcript.messages`,
  `hooks`, `clearContext`, `skills` and `mcp` are non-null now: a rollout's `event_msg`
  records carry `user_message` / `agent_message` verbatim (`parseCodexMessages`), Codex
  fires ten PascalCase events once a launch asks it to, `/clear` is Codex's own slash
  command as well as Claude's (measured against 0.144.x), it reads `~/.agents/skills`, and
  `codex mcp add <name> --env K=V --` registers our server - `scope: null` being the real
  difference there, since Codex writes one registration and has no `-s user|project` to
  choose between. `GOAL_UNSUPPORTED.codex` (`@shared/goal.ts`) went null with the first of
  those: an entry there and its harness's `messages` capability are ONE fact in two files,
  and `harness-transcript.test.ts` fails until they agree. Codex now has no top-level null
  in this shared record; `permissionModes` declares its measured `/permissions` menu.
  The nulls on this axis that ARE still true are the ones someone pointed at a real install:
  `control.pastePlaceholder` (below), and `skills.reloadCommand`, which is the whole
  difference between "this harness has no skills" and "this harness needs no nudge" - Codex
  watches its own skills directory. What each of them buys is that every reader takes the
  one already-tested "unavailable" path instead of, say, an empty transcript window that
  reads as "this session said nothing".
  **`skills.invoke` is the same shape at the other end: how a skill NAME becomes the one
  line typed to RUN it**, which is a third thing again from where skills live and who
  needs a nudge. It is a LINE, not a token, because the invocation also has to SUBMIT:
  Claude's `/no-mistakes` and pi's `/skill:no-mistakes` do, but a bare `$no-mistakes` at
  the end of Codex's composer leaves its skill-mention popup open and that popup eats the
  Enter - and Codex declares `pastePlaceholder: null`, so delivery spends exactly one and
  has no evidence to retry on. Only whitespace closes that popup (a trailing `.` is read as
  part of the name), which is why Codex's line carries a trailing clause. Foreman's wrap-up
  is the caller: it names the SKILL (`wrapupNoMistakes`, `@shared/queue.ts`) and never a
  sigil. It was one constant carrying Claude's slash command typed at every agent, so a
  Codex session ran the gate only if the model reached for the skill unprompted. Changing a
  spelling RETIRES a payload - see `RETIRED_WRAPUP_PAYLOADS`. Test:
  `harness-skill-invoke.test.ts`.
  `src/server/transcript.ts`'s `JsonlMessagesSpec` is where that landed for the second
  reader: a UNION, exactly one of `parse` or `parseBatch`, because a harness whose turns are
  independent lines supplies the first while one whose tool records extend the turn before
  them (Codex's rollout) needs the whole window and supplies the second. Two optional fields
  instead let a harness pass a `parse: () => null` stub beside the real batch parser to
  satisfy the type - dead code that reads like a live contract, with nothing in the
  interface saying which of the two would have won.
  **The three degradations Codex's `hooks: null` used to drive are still the contract, and
  Pi now exercises the null capability.** `applyHook` refuses an ingest whose
  harness declares no hooks rather than reading it in Claude's vocabulary; the pane-keyed
  overlay is agent-scoped; `awaitReady` skips its 20s wait. The middle one got MORE
  load-bearing, not less - Claude and Codex write overlays, so `overlayFor` scoping on
  `HookOverlay.agent` is the only thing stopping the card Codex started in a vacated pane
  from inheriting Claude's last state. The third is now gated on `prepareCodexLaunch`'s
  `instrumented` as well as on the capability, because an uninstrumented Codex launch will
  never produce that signal either.
  `HARNESS_CAPABILITIES.codex.workQueue` is non-null now too: Codex's launch-scoped hooks
  report pickup/completion, its rollout supplies the verification transcript, and the
  harness-neutral injection path reaches its keystroke control spec. That last path has a
  measured degradation rather than a guessed success: Codex renders no collapsed-paste
  placeholder, so delivery spends one Enter and reports `submitVerified: false`; it never
  retries on evidence this TUI cannot produce. An operator-started Codex that has never
  reported a hook still takes the per-session refusal, with the launch-scoped remedy, rather
  than accepting a batch it cannot verify. **`detect`, `bin` and `control`
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
  for dispatched sessions, headless runs and embedded ones alike; it lived in `config.ts`
  while `claude-cli.ts` kept a second chain, and the two disagreed. The CHAIN itself is
  `resolveBinSpec` (`harness/bin.ts`) so a module this record imports - the Claude driver,
  which has to pin its subprocess to the operator's own `claude` rather than the copy inside
  the npm package - can resolve a spec it already holds without closing an import cycle
  around the registry. A `clearContext: null` still
  degrades reset to the byte-identical `cleared: false` a pane-less session produces, but no
  shipped harness declares one any more: `codex.clearContext` was null on the assertion that
  `/clear` was Claude's alone and would land in Codex's prompt as text, and it is Codex's own
  command. An absence a HUMAN sees needs its
  sentence composed from the capability (`workQueueUnsupportedWhy`), not typed at each
  refusing surface. The work queue's driver arm is runtime-scoped in both halves -
  `foremanAutomationAuthorized` (`harness/index.ts`) and `workQueueBlockedReason`
  (`@shared/harness-capabilities.ts`) - because an SDK session is instrumented by the handle
  the supervisor owns, regardless of whether that harness also declares hooks.
  `HARNESSES.codex.tui` was the FIRST counter-example, and is still the
  one to read before declaring any capability `null` - the five corrections above are what
  taking it seriously cost. It is NOT null. The guard it replaced said
  `agent !== "claude"`, with a comment above it asserting Codex "doesn't render these
  dialogs" - and because the guard
  skipped the parse, nothing ever tested that claim. It is false. Codex renders the same
  numbered, single-cursor menus and differs by ONE token, the cursor glyph (U+203A against
  U+276F), so `DialogSpec` carries the glyph and `discovery/pane-dialog.ts` stays
  harness-neutral machinery - the same split `transcript.ts` makes. Note the restatement
  that came before it, `capabilitiesFor(s.agent).permissionModes`, was not a fix: Codex had
  no mode-line capability, so gating the DIALOG on it skipped exactly the sessions whose
  dialogs are the only signal they could produce. **A capability is null only after you
  point it at a real capture**; `test/fixtures/codex-panes.ts` is what that costs, and those
  fixtures are verbatim, never hand-written. Getting it wrong is expensive in one specific
  way here, and hooks narrowed that rather than removing it: Codex's hooks are launch-scoped,
  so for a Codex session an OPERATOR started `activePaneDialog` is still the only "needs you"
  evidence there is, and one parked on a command-approval prompt read as merely
  unconfirmed. Reach a capability through a registry (`capabilitiesFor`,
  `harnessFor`, `sessionMessages`, `transcriptFor`, `hooksFor`, `tuiFor` / `dialogSpecFor` /
  `modeLineSpecFor`, `controlFor`), never by testing `s.agent`; each phase of
  `docs/plans/pluggable-integrations/plan.md` adds a slot. Test:
  `harness-capabilities.test.ts`, `harness-transcript.test.ts`, `harness-hooks.test.ts`,
  `harness-tui.test.ts`, `harness-control.test.ts`, `detection.test.ts`,
  `harness-bin.test.ts`, `process-background-filter.test.ts`, `session-contracts.test.ts`.
- **A fold over a harness capability iterates `AGENT_TYPES`, and chooses its filter
  deliberately.** `skillsDirs()` (`src/server/skills/reconcile.ts`) is every harness
  declaring a `skills` capability, de-duplicated - the loop the single-directory version
  said would be needed when a second harness declared one, and Codex is that harness
  (`~/.agents/skills`). Until the fold existed the declaration was inert: `skillsDirFor`
  had one caller, `claudeSkillsDir`, so every reconcile, blocker, drift and uninstall pass
  walked Claude's directory alone, the panel showed the skill on, and one of the two
  harnesses on the machine silently never had it. It is deliberately **NOT**
  `skillsAgents()`, which filters on `reloadCommand` because it answers a different
  question - who the pane reload BROADCAST is about - and Codex needs no nudge. Installing
  a skill and making a running session notice are two capabilities, and one selector
  serving both is how a harness gets the nudge it does not need and none of the skills it
  does. `applyMcp` (`src/main/integrations.ts`) is the same shape and used to be the other
  half of the defect: a hand-written `["claude", "codex"]` tuple, which would have left Pi
  out with nothing failing. Test: `skills-multi-harness.test.ts`
  (the fold), `skills-reconcile.test.ts` (the walk), `skills-config.test.ts`.
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
  and a throw there takes all of them down over a preference. The Foreman worker still never
  touches the DB, and its runner is a TWO-step ladder: Foreman's own `cfg.runner` when the
  operator chose one there, else `client.llmRunner()` - that is `/api/llm/status`, the
  app-wide config-then-env-then-default resolution only the daemon can see. It fell back to
  a literal `"claude"`, which silently dropped the env layer for the one subsystem that runs
  in its own process; and when the daemon cannot answer it holds the last known runner
  rather than resetting to the default, because a blip must not move the cheap tier onto a
  provider nobody picked. `foremanStatus` (`src/server/foreman/config.ts`) resolves the same
  ladder server-side and reports it as `ForemanStatus.runner`, so the panel prints the
  provider actually in force instead of re-deriving `config.runner ?? "claude"`. Test:
  `llm-runner-contract.test.ts`,
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
  `Multiplexer` has named sessions and a copy-mode probe, while a `TerminalEmulator` raises
  windows and has no persistence. Most multiplexer spawns are detached; cmux is the declared
  exception because its sessions are never without a window. Optional capabilities are
  `T | null` and null is a declaration - Ghostty cannot read its own screen or retitle a tab,
  so `capture` and `retitle` are legitimately null. **Declare a null only after pointing the
  capability at a real install.** This line used to say Ghostty "has no scripting CLI, so
  `list` / `write` / `capture` are all legitimately null", which was three wrong claims read
  off release notes: the CLI is useless, and the AppleScript dictionary enumerates, focuses,
  spawns and types. `todo/ghostty-emulator.md` is what checking costs. **`hostProcess` is the
  second correlation key**, and the field Ghostty had to add to this interface: `tty` was the
  only join, and an emulator can answer every other `EmulatorPane` field and still not know
  which tty a pane is on. It declares argv0 basenames of the GUI process - DATA, matched at
  argv0 only, for the `DetectSpec` reason - and `terminal/host.ts` walks ancestry generically.
  Null means "my panes carry their own ttys", which both other backends declare. It also
  gates the sweep: an Apple Events backend LAUNCHES its terminal by being asked anything, so
  a non-running host is skipped rather than started every 1500ms. Correlation pairs a
  tty-less pane only where exactly one pairing is possible (cwd agreement, then last one
  standing) and DECLINES otherwise, because a wrong pairing does not degrade, it types into a
  stranger's tab. Writes bind to the innermost handle (`bindPane`);
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
  subprocess (real arguments and stdin) or a hand-built pane (capability nulls no shipped
  backend declares yet).
  **PIPE PAYLOADS through `TerminalExec.input` wherever the backend allows it.** tmux and
  WezTerm pipe all human- or model-authored text; bounded key names remain arguments. The
  current cmux and Ghostty mechanisms are documented exceptions that still have an `ARG_MAX`
  ceiling, so `run` must turn a synchronous spawn refusal into `outcomeUnknown: false`: no
  process existed and nothing was written. The adapter comments own the backend-specific
  transport and flag invariants. Tests: `exec-outcome.test.ts`,
  `terminal-registry.test.ts`, `terminal-adapters.test.ts`, `terminal-enumerate.test.ts`,
  `correlate.test.ts`, `pane-write-capabilities.test.ts`, `pane-copy-mode.test.ts`,
  `terminal-host-join.test.ts`, `terminal-ghostty.test.ts`.
  **Conversation launch targets are a composition, not an installed-backend check.**
  `terminal/targets.ts` is the owner: an emulator must be able to spawn a tab, while a
  detached multiplexer such as tmux is usable only when an installed emulator can run its
  `attachArgv`. A multiplexer whose sessions are never windowless declares
  `attachArgv: null` and stands alone. `unavailable` is a sentence, never a boolean, and
  `glyph` is required on both adapter interfaces so a new backend cannot compile without
  describing its row. Test: `terminal-target-contract.test.ts`.
  **Lifecycle is composition, and it is the reason there are two interfaces.** Focus is
  `Multiplexer.select` (decides what the session SHOWS, raises nothing) then an emulator
  raise - host tab via the `hostPanesFor` client-tty join, else the session's own emulator
  handle, else `spawn.tab(attachArgv)`. Rename moves the multiplexer session name AND
  retitles every hosting tab. `MuxSessions.kill` is NULLABLE and that is load-bearing:
  "has a killable group" was the else-branch of `if (session.tmux)`, so a second
  multiplexer would silently have inherited the tab path. **Where a dispatched agent
  lands is `terminal/home.ts`**, and its rule is that the axis is chosen ONCE
  (`homeBackends` - multiplexers if any is installed, emulators only if none is) so
  launch, name-uniqueness, liveness and teardown cannot disagree about which backend
  holds the home. `homeAlive` returns `boolean | null` and **null is not `false`**: null
  means no installed backend could tell us, and only `false` may reclaim a worktree -
  `reconcileOnStartup` runs `git worktree remove --force` on that branch, so an adapter
  lookup that misses must never arrive there by omission. A missing `Task.homeName` also
  maps to null during startup reconciliation; the dispatcher's live failure path keeps
  false because that process knows whether it spawned a home. `killHome` reports `asked`
  beside `ok` for the same reason. **Name rules belong to
  the adapter** (`NameRules`, both directions): tmux's target grammar was written out
  twice, as rejections in `validateSessionName` and as coercion in `sessionLabel`, and the
  two had already drifted by one character class - `terminal-name-rules.test.ts` pins that
  whatever a backend sanitizes, the same backend accepts. Tests: `focus-composition.test.ts`,
  `terminal-home.test.ts`, `terminal-name-rules.test.ts`, `rename.test.ts`, `kill.test.ts`.
  **A name is not an address**: `MuxPane.sessionName` is what a human sees, `MuxTarget.session`
  is what `kill` / `rename` resolve, and they are the same string only on tmux - so
  `killHome` maps one to the other through `held` rather than passing the recorded name to a
  backend addressed by UUID. **Migration complete for this axis** - discovery, pane I/O, the
  `Session` model and the lifecycle operations all go through the registries, and nothing
  outside `src/server/terminal/` names a backend. `tmuxOnly` / `weztermOnly` and their
  `noDriver(backend: never)` default are gone with the shelling-out they guarded. Persisted
  task ownership is `Task.homeName` / `home_name`; the former `tmux_session` column is an
  inert migration source. See `docs/plans/pluggable-integrations/plan.md` phase 3.
- **"Open in" targets (handing a checkout file OUT to another application)**: the same
  purity split again. `OPEN_TARGET_INFO` (`@shared/open-targets.ts`) holds what the files
  toolbar can answer in the browser - label, blurb, glyph - and `OPEN_TARGETS`
  (`src/server/open-targets/index.ts`) spreads that in and adds `resolve`, the one call
  that has to look at the machine. Both are `Record<OpenTargetId, …>`, so an id appended
  to `OPEN_TARGET_IDS` does not compile until something can launch it. **A target
  RESOLVES the application; it never shells the file at the platform's default handler.**
  `open <file>` / `xdg-open <file>` route by FILE TYPE, so they honour a "Browser" row for
  `.html` and open Xcode for `.ts` - and the files list holds every file in the checkout,
  which makes that the common case. `resolve` answers "which application, and what argv"
  ONCE per menu draw and returns a pure `command(file)`, which is what lets a test assert
  the exact argv for a platform it is not running on (`OpenDeps` is the seam, the
  `PaneDeps` shape). An unavailable target is a SENTENCE, never a boolean: "not supported
  on win32 yet" and "install xdg-utils" are different things for the human to do. The
  daemon launches a local application against a local path and never SERVES the file -
  serving it would put checkout-controlled HTML on the daemon's own origin, inside every
  action route on that port. Containment is `resolveSessionFilePath`
  (`src/server/session-files.ts`), the same `rootAndTarget` walk a read gets, never a
  second one. The menu is a fold over the daemon's report, so a new target needs no
  component and no stylesheet rule. Test: `open-target-contract.test.ts`,
  `open-file-http.test.ts`, `open-in-menu.test.ts`, `open-in-freshness.test.ts`.
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
- **Built-in Personas (the review roles that ship with the app)**: the documents are
  `docs/personas/*.md`, and they reach a build through `scripts/builtin-personas.ts` into
  the committed `builtin-personas.generated.ts` - **compiled in, never read at runtime**, for
  `mcpServerPath()`'s reason: `docs/` is not in the packaged app and esbuild collapses the
  daemon, so a runtime read resolves in the checkout and silently nowhere else. Name and
  description are DERIVED from the document (`personaNameFromMarkdown` /
  `personaDescriptionFromMarkdown`, `@shared/workflow.ts`). **Import .md** shares only the
  heading-to-name rule and leaves description empty. Existing shipped slugs must not be
  renamed because `builtinPersonaId` reaches durable storage as a draft's `personaId` and a
  published version's `sourcePersonaId`. Removing a document removes its id from the catalog.
  Published versions remain intact because they carry their own guidance copy, but a draft
  naming that id stops validating until its node is replaced.
  **A built-in is not a row, and the merge lives in `WorkflowStore`** - one seam for the
  addressable catalog used by draft validation and Publish's guidance snapshot. The Registry
  and SSE carry that complete catalog. `personasForDisplay` (`@shared/workflow.ts`) applies
  live-row shadowing only where the server or browser presents Personas to choose from. Not
  being a row is what makes "always the Markdown this build was made from" true without a
  seeding step that could half-run, and the write refusals
  (`reason: "builtin"`) sit beside the merge for the same reason. A stored Persona SHADOWS a
  built-in of the same normalized name, and only history can produce one: an operator who
  imported the document before it shipped reserved that name durably, so their copy - which
  they may have edited and which their versions name - keeps it, while `create` and rename
  refuse a built-in's name so no new shadow appears. The shadowed built-in stays addressable
  by id. `Persona.builtin` is the wire half: it is what the editor reads to open read-only
  and offer Duplicate instead of Archive. Test: `builtin-personas.test.ts`,
  `personas-http.test.ts`, `persona-editor-render.test.ts`.
- **Ensemble strategies (how a GROUP of agents is run)**: the same purity split again.
  `ENSEMBLE_STRATEGY_INFO` (`@shared/ensemble-strategies.ts`) holds what the dashboard can
  answer in the browser, and `ENSEMBLE_STRATEGIES`
  (`src/server/ensembles/strategies/index.ts`) adds the pure compiler that turns config into
  a durable plan. Both are exhaustive `Record<EnsembleStrategyId, …>` registries, so a new id
  cannot compile until both halves exist. Execution is split across three more exhaustive
  `Record<EnsembleDriverKey, … | null>` registries keyed by the compiled plan's DRIVER KEY,
  never the strategy id - `REVIEW_DRIVERS` (`ensembles/reviews/index.ts`), `DECISION_DRIVERS`
  (`ensembles/decisions/index.ts`) and `FINALIZERS` (`ensembles/finalizers/index.ts`), each
  key claimed by at most one - plus `ARTIFACT_ADAPTERS` (`Record<EnsembleArtifactKind, …>`)
  and the web-only `ENSEMBLE_RESULT_RENDERERS` (`src/web/ensembles/results/index.ts`), the
  ONE strategy-keyed surface, presentation only. The authoritative extension contracts live
  beside those registries; read the applicable one before changing strategy ids, driver
  keys, compilation, persistence, or execution rather than duplicating them here.
  **The surfaces that move together for a genuinely new strategy** are: the two strategy
  halves; the versioned driver/adapter/renderer keys (append-only `id@version`); the compact
  `EnsembleSummary` SSE event pair (`ensemble_upsert` / `ensemble_remove` in
  `useEventStream.ts`) and the bounded HTTP detail; the nested `TaskSummary.ensemble`
  projection (NOT a top-level `Session` field, so no `SESSION_FIELD_COMPARATORS` entry) and
  the four session renderers' `E` mark; the double-validated MCP submit contract
  (`submit_ensemble_result`, mirrored in `src/mcp/server.ts` and `@shared/protocol.ts`);
  Reset, which removes a workflow binding but never an ensemble ref; append-only private-ref
  retention (`refs/mission-control/ensembles/<uuid>/<uuid>`, deleted only by an explicit
  confirmed action); and the Workflow ownership boundary. A strategy composed only from
  existing primitives needs NONE of these - it is a descriptor plus a compiler, and if it
  seems to need a column, route, event, Session field, layout mark or action, that is the
  signal it introduced a new PRIMITIVE, which belongs in its owning registry, not a
  strategy branch. **Two invariants are merge-blocking**
  (`ensemble-extension-contract.test.ts`): `EnsembleEngine` contains **no branch on a
  strategy id** - it dispatches on driver keys and executes the stored plan, never a fresh
  compilation - and the **Workflow graph contains no Ensemble node** (they compose only at
  promotion, across the external-binding boundary). Ensemble transitions extend the shared
  alert engine (`@shared/alerts.ts` `AlertKind`/`AlertScope`, threaded through App's scope and
  the daemon Away watcher), not a second notifier; member agent cost is captured at submission
  into the artifact metadata and read back with unknown preserved as unknown
  (`aggregateEnsembleAgentCost`, `@shared/ensemble.ts`). Test:
  `ensemble-strategy-catalog.test.ts`, `ensemble-best-of-n.test.ts`,
  `ensemble-contracts.test.ts`, `ensemble-store.test.ts`, `ensemble-db.test.ts`,
  `ensemble-sse.test.ts`, `ensemble-comparative-review.test.ts`, `ensemble-extension.test.ts`,
  `ensemble-extension-contract.test.ts`, `ensemble-fault-matrix.test.ts`,
  `ensemble-mixed-harness.test.ts`, `ensemble-adversarial.test.ts`, `ensemble-cost.test.ts`,
  `ensemble-alerts.test.ts`. Operator and extension reference: `docs/ensembles.md`.
- **Tones**: `TONE_ORDER` / `TONE_GROUPS` in `lib/tone.ts` drive grid sort, rail sections,
  board columns and board arrow-nav. Also needs a `--<tone>` token and `.tone-*` / `.badge-*`
  rules.
- **Shared predicates**: `repoAllowlisted` (`@shared/allowlist.ts`, re-exported as
  `foremanAllowlisted` from `@shared/foreman.ts` for Foreman's own callers), `composeWrapup`
  (`@shared/queue.ts`), `costTone` / `costIsNotable` (`@shared/cost.ts`), and the backlog
  autopilot's `plannableBacklog` / `readyBacklog` / `blockersIn` / `nextUpTaskId`
  (`@shared/backlog.ts`) are shared so every surface, and the server, decides identically.
  Do not copy them into a component. Any additional consent gate extends `allowlist.ts`; it
  does not start a matcher.
- **Which model a headless call spawns with**: one ladder, `resolveModelChoice`
  (`@shared/model-choice.ts`) - config, then env, then a NAMED fallback - and the roles stay
  with their subsystem: `FOREMAN_MODEL_SPECS` (Foreman's four), `INSPECTOR_MODEL_SPEC` (the
  Inspector's one), `LLM_JOB_SPECS` (`@shared/llm-jobs.ts` - the daemon's own
  operator-configurable jobs). Three sets of roles, one ladder, and a fourth resolver is the
  thing not to write. A `claude -p` that
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
  **`canMessage` is the other half of that question and they must not be conflated.**
  `canWriteTo` is about a PANE - focus, rename, the write lock, Shift+Tab, capture
  tolerance, `canCycleMode` - and `canMessage` (`canWriteTo(s) || s.runtime === "sdk"`) is
  about a CONVERSATION: the Send box, the queue's `hasPane`, `clearsContext`, Foreman's
  `canSend`, the mode and effort pickers. They answer identically for every session that has
  a pane, so getting one wrong fails silently: a delivery site left on `canWriteTo` greys out
  a driver-run session it could have reached, and a pane site widened to `canMessage` offers
  Rename on a session with no terminal to rename. `canMessage` takes
  `PaneHandles & { runtime }`, which is what keeps `DiscoveredSession` consumers (the
  `paneDialog` stickiness fallback) on the predicate that needs no field they have.
  Test: `session-terminals.test.ts`, `pane-predicates.test.ts`, `pane-lock.test.ts`,
  `terminal-registry.test.ts`.
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

`src/web/styles.css` is one large file: no preprocessor, no modules, no Tailwind. A
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

CI runs `npm run typecheck`, `npm test`, `npm run build`, and the bundle smoke check on Node 24
(the supported floor) and Node 26 (the current release). The test runner uses two concurrent,
isolated test-file workers; there is no linter.

That matrix runs on **Blacksmith** (`blacksmith-4vcpu-ubuntu-2404`), and the two things to know
before editing `.github/workflows/ci.yml` are the size and the actions. The size is 4 vCPU by
choice, not by default: it is parity with the `ubuntu-latest` it replaced, and the sequential
ordering of the gates after `npm test` is tuned to that budget - widening the runner without
widening the test concurrency speeds up only the non-test gates. And **no `useblacksmith/*`
action fork belongs in this file**: Blacksmith's cache is transparent to the upstream actions, so
`actions/setup-node`'s `cache: npm` already reaches it, and the forks are archived upstream -
adding one adopts an unmaintained action for no cache gain. The macOS `package` job deliberately
stays on GitHub's `macos-14`: it is off the PR path, Blacksmith's macOS runners are billed per
minute, and Blacksmith publishes no macos-14 image, so moving it would change the OS the shipped
dmg is built on. One failure mode to recognise: a job whose runner label Blacksmith does not
serve does not fail, it queues forever - so the Blacksmith GitHub App has to be installed on this
repository's account.

## House rules

- **Never use the em dash.** Plain dash only.
- Branches `mancej/<kebab-slug>`; commits `type(scope): sentence` (`feat`, `fix`, `docs`,
  `refactor`, `test`), or a plain sentence for larger changes.
- Never add an agent name as commit co-author.
- Never hand-edit `CHANGELOG.md` or anything auto-generated.
- Prefer quality, simplicity, and long-term maintainability over development cost.
- Start a bug fix by reproducing it end to end, the way a user hits it.
