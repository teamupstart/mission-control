# Demo mode

`npm run build && npm run demo` boots a second, fully isolated Mission Control - real daemon,
real dashboard, real git, real Foreman - where every agent binary is a scripted scenario
player instead of the real `claude`/`codex` CLI. Nothing it does spends a token: dispatch a
task from the dashboard and watch a convincing session play out - paced assistant turns,
`Edit`/`Write`/`Bash`/`TodoWrite` tool chips, real file edits you can see in Diff and Files, a
waiting-on-you question, then completion - all driven by a scenario script, not a model API.

`npm run demo -- --fresh` goes further: it rebuilds the state root and **seeds a lived-in
fleet** first, so the dashboard opens onto work already in progress rather than an empty
board. See [The seeded fleet](#the-seeded-fleet) below.

State lives at `~/.mission-control-demo` (separate from `~/.mission-control`), used as both
`MISSION_HOME` and `HOME` for the demo daemon, on its own port (7417 by default, distinct
from the dev daemon's 7317 and the smoke test's 7519). It persists across runs - seeded
repos, worktree edits, and all - so a curated demo survives a restart; pass `--fresh` to
delete and rebuild it.

Flags:

- `--fresh` - delete the state root, rebuild it, and seed a lived-in fleet before booting.
  **Takes a few minutes**, because it is not writing fixtures: it replays real work through
  the real routes and waits for it. Without this flag an existing state root boots exactly
  as you left it, which is the point of a persistent demo.
- `--no-seed` - with `--fresh`, rebuild the state root but skip the seeder. An empty fleet in
  seconds instead of a populated one in minutes.
- `--no-foreman` - skip starting the real Foreman worker.
- `--no-open` - do not open a browser. For a remote machine, or for inspecting the seeded
  fleet from a script without stealing focus.
- `--port <n>` - override the default port.
- `--check` - boot, run the identity and isolation assertions, run a **reduced seed** (one
  dispatched session, one review, one ledger day), reboot over it, assert the residue, then
  shut down and exit 0 (no browser, no Foreman). The CI-shaped smoke test for the launcher
  and its seeder, in the spirit of `npm run smoke`. It uses its own throwaway root
  (`~/.mission-control-demo-check`, removed afterwards) so it never bulldozes a curated demo.

**The one deliberate exception to "spends no tokens" is Foreman.** Unless `--no-foreman` is
passed, the launcher starts the real `src/server/foreman/worker.ts` against the demo daemon
with the real `claude` CLI resolution and the operator's own `HOME` (where its login lives),
so Foreman genuinely reasons about the fake fleet and its own token spend is real. The daemon
itself never reaches a model: `MISSION_CLAUDE_BIN`/`MISSION_CODEX_BIN`/`MISSION_PI_BIN` point
at the scenario players installed under `~/.mission-control-demo/bin/`, and
`ANTHROPIC_API_KEY` is blanked in the daemon's env as a second line of defense.

Two sweeps that are not scoped to `MISSION_HOME` are switched off unconditionally
(`MISSION_POLL_MS=0`, `MISSION_POOL_REAP_MS=0`) - without them the demo daemon would walk
every process on the machine and adopt the operator's real sessions, Kill/Reset buttons
included, or reap a shared treehouse worktree pool it does not own. With discovery off, the
demo fleet is SDK-runtime sessions only: the launcher flips `claude`/`codex` to `sdk` through
`PUT /api/harnesses/config`, the same route the Settings panel uses.

**A demo daemon opens on the Board.** The launcher writes `layout: "board"` through
`PUT /api/ui/config` on every boot, beside the runtime override above and for the same reason: it
asserts the demo's configuration rather than hoping a persistent state root still holds it. The
Board because a demo is read before it is driven - a column per state answers "what is this fleet
doing" in one look, and the seeded fleet is arranged for exactly that reading. Switching layout
during a demo sticks for as long as that daemon runs; the next `npm run demo` opens on the Board
again.

Two layers cover it, and neither is prose. `test/demo-launch.test.ts` pins the parts that can be
decided without a daemon: that `DEMO_LAYOUT` is a layout this build actually ships, that the body
parses under the route's own `UiConfigPatchSchema` and mentions **only** `layout` (the patch is a
plain `.partial()`, so a body naming `keybindings` would replace them), and that the launcher
accepts only an echo of the stored value - a misspelled key is valid input that answers 200 and
sets nothing. `npm run demo -- --check` then boots a real demo daemon, reboots over it, and reads
the layout back from `GET /api/ui/config`. Launching the demo from `e2e/` is deliberately not
attempted: those specs drive their own throwaway daemon, while the launcher owns a fixed port and
the `~/.mission-control-demo*` roots that `--check` already uses.

### The seeded fleet

`--fresh` runs `scripts/demo/seed.mjs`, and what it leaves behind is the first paint:

- **Five session cards**, each restored from suspension with its whole conversation intact -
  paced assistant turns, tool chips, `TodoWrite` narration - and a **dirty worktree** behind
  it, so Diff and Files are full the moment you click a card. Two of them are **waiting on a
  question you can answer**, and each asks about its own work: a continuation is routed by the
  scenario it continues (`"continues"` in a scenario file), because the prompt a restored session
  receives is identical for every card and matching on it alone can only ever reach one.
- **A card with a queue behind it.** **UI Polish** is parked on a question with **three messages
  waiting in its outbox**, queued through the composer's own route (`POST /api/sessions/:id/inject`,
  whose `origin: "human"` + `buffer: true` defaults are what route a message to
  `PendingTurnManager` instead of typing it at the session). They are durable `pending_turns` rows,
  so they survive the seeder's shutdown exactly as the conversation does - and they stay queued
  because `canDrain` requires `paneDialog === null`: a card holding a question holds its outbox.
  Answer the question and the three drain in order, which is the whole point of the affordance.
- **Ten tasks across every state a board really shows**: `done`, four `running`, `cancelled`,
  and four in `backlog` - one of them blocked on another, one parked (`enabled: false`). Note
  that "blocked" and "parked" are not statuses; there are only six of those, and neither is
  among them.
- **Reviews**: one pending `plan-decisions` prompt with selectable options, plus an approved
  plan and an answered question in a session's resolved history.
- **One clean end-to-end Workflow run**, bound to a session, so the story a run tells is visible
  from both ends: the card wears its `⌁ Approved` chip and the Runs page has the whole pipeline
  behind it. The graph is the built-in **No-Mistakes Review**'s version 3, stage for stage - the
  deterministic `typecheck`/`test` gate first, then Intent Conformance alone as the cheap judge,
  then Code Risk, Test Evidence, Documentation and the seeded custom Persona in parallel behind it,
  all-pass join, End. `test/demo-seed.test.ts` pins that shape against the built-in's own published
  graph, so a change to the flagship fails there rather than drifting silently. The run went
  through it on round one: both checks cleared (`skipped` - a fresh demo root configures no check
  commands, exactly as the built-in behaves on any repository before its operator configures them),
  every reviewer passed, no repair round, no retries. The seeder refuses to finish if the run is
  anything less (`reviewOutcome`), because "a completed run" and "a run that reviewed something and
  agreed" are not the same claim.

  **The one stage it does not carry is the Inspector completion gate**, and that is a property of
  the machine rather than a shortcut. `WorkflowManager.enterInspectorGate` records a gate entered
  with the Inspector off as `blocked` - and the Inspector is off by default - so a run bound to the
  built-in itself would put "Workflow blocked" on the demo's showcase card. Armed, the gate then
  needs a pull request adopted into the Inspector's store and a fresh observation of its head, and
  every read of that goes through `gh` against a real GitHub: nine call sites in
  `src/server/inspector/github.ts`, no env override, while this demo reaches no network and its
  repositories are local `git init` directories with no remote. `dry-run` mode does not change it -
  it still adopts and still reviews. So the seeded copy carries `completionPolicy: {kind:"none"}`
  and ends where its End node says it does.
- **Two Recurring Missions** on the schedule spine, in your own timezone.
- **A nonzero cost chip**, built the way a real fleet's is. Each card's own spend comes from the
  usage its scripted CLI reports on every finished turn's `result` frame - the same figure
  `claudeTurnUsage` reads off a real embedded session, written by the same driver path - so the
  per-card figures and the topbar agree because they are the same rows. Behind them: spend from
  earlier today, several days of history, and the automation line the Foreman and Inspector loops
  populate. Seeded spend cannot be attributed to a card through `/v1/metrics` at all, and that is
  not a limitation of the seeder: Claude session spend has one writer per conversation, the driver
  wins for an embedded session, and the OTLP ingest deliberately drops every datapoint naming a
  driven session (`sdkOwnedNoteKey`) so a card cannot be charged twice.

**It is all replay, not fabrication.** The seeder boots the daemon quietly, drives the same
public routes the dashboard and the e2e specs drive (`POST /api/tasks`, `/dispatch`,
`/mcp/reviews`, `/api/reviews/:id/resolve`, `/api/workflows` → `/publish` →
`/api/workflow-bindings` → `/submit`, `/api/schedules`, `/api/personas`), and then stops.
Every row was written by the real daemon; the transcripts were written by the scenario
players; the worktrees are real `git worktree` checkouts with real uncommitted edits.
**Nothing writes to SQLite behind the daemon's back**, including the cost ledger - `/v1/metrics`
stamps each row from the datapoint's own `timeUnixNano` rather than from `Date.now()`, and
`/api/usage/automation` takes an arbitrary `ts`, so backdating is a property of the ingest
routes themselves.

The suspended cards are the same story. An embedded session whose daemon shuts down cleanly is
recorded `suspended`, and the next daemon relaunches it as a resumable card - so the seeder
gets its cards by dispatching real sessions and then stopping the daemon over them. A session
that was still mid-question at that shutdown keeps its `turnInProgress` bit, and the restore
sends it a continuation turn asking it to raise anything it still needs; that is how the fleet
has a genuinely waiting-on-you card at first paint rather than only a durable review row.

Three gaps, all deliberate, and all for the same underlying reason where it applies - a seed
can only contain what the daemon durably stores:

- **No origin chips on seeded turns.** Turn attribution (the foreman/workflow badges on a
  conversation) is in-memory only, keyed by a hash of the turn text (`src/server/injections.ts`),
  so it exists for live deliveries and cannot survive a restart. Seeded history carries none.
- **No captured Goal on seeded sessions**, so the seeded run's "Captured intent and evidence"
  panel reads `(No captured goal)`. A Goal exists only once a prompt has been captured from a
  hook event (`Registry.captureGoalPrompt` is reached only from `applyHook`), and the scripted
  CLIs install no hook bridge - so the refiner has nothing to reconcile. The instruction itself is
  still there, under "Human decisions and rationale", read out of the transcript.
- **No quota runway on the cost chip.** The rate-limit windows a session reports through
  `/statusline` live in a private in-memory field on the registry that nothing persists, so
  seeding one would simply be undone by the seeder's own shutdown. The chip still appears and
  still opens - it has the money and token rows, just no forward-looking one until a live
  session reports its windows.
- **No pull-request or Inspector history.** Out of scope for demo mode - both act outside the
  machine against real repositories, which is also what keeps the seeded run's graph one stage
  short of the built-in it copies (see the Workflow bullet above).

### Scenarios

Each `*.json` file under `scripts/demo/scenarios/` (installed into `<state root>/scenarios/`
on every launch, read by the players via `MISSION_DEMO_SCENARIO_DIR`) is one scripted
session:

```json
{
  "title": "Fix the retry/abort race",
  "match": ["flaky", "retry", "bug", "fix", "race"],
  "default": true,
  "steps": [
    { "kind": "assistant", "text": "...", "delayMs": 700 },
    { "kind": "tool", "name": "Bash", "input": { "command": "npm test -- retry" }, "delayMs": 900 },
    { "kind": "editFile", "path": "src/retry.ts", "content": "...", "delayMs": 200 },
    { "kind": "ask", "questions": [ { "question": "...", "header": "...", "options": [{ "label": "...", "description": "..." }] } ] },
    { "kind": "result" }
  ]
}
```

The player matches the dispatched intent against every scenario's `match` substrings
(case-insensitive, checked against the task text only - never the surrounding prompt
boilerplate, which would otherwise self-match on a RULES block's own worked examples); the
scenario flagged `"default": true` runs when nothing matches. Steps play in order, each after
its own `delayMs`, with the turn held open the whole time so the card stays "working."
`assistant` steps update the activity line; `tool` steps append a tool-use chip (`name` is any
string - `Edit`, `Write`, `Bash`, and `TodoWrite` render specially, but nothing enforces the
set); `editFile` steps write real content into the session's cwd - the actual git worktree
the dispatch cut - so Diff and Files fill in for real (the path must stay inside the cwd);
`ask` steps raise an `AskUserQuestion` card and block until the dashboard answers it through
`/api/sessions/:id/submit-options`; a scenario ends on its own `"result"` step or simply when
it runs out of steps.

Ten scenarios ship, in three groups. **Three are for live dispatch** from the dashboard, paced
theatrically so there is something to watch: a bug fix (edits two files, runs a Bash "test",
completes), a rate-limit design question that blocks mid-turn on you, and a longer multi-step
migration. **Five are the seeded fleet's** (`seed-*.json`), paced fast because their output is
history rather than a performance - nobody watches a seed run. **Two are restart continuations**
(`resume-*.json`), played when the daemon relaunches a session whose turn was still open.
A seeded intent must reach its own scenario and never fall through to the default;
`test/demo-seed.test.ts` pins that routing, because a `match` list that shadows another
produces a card whose conversation is plausibly about the wrong task and nothing errors.

**A continuation is routed by the work it continues, not by its own text.** Every restored
session receives the same prompt word for word ("Mission Control restarted while your previous
turn…"), so matching on that text can only ever reach one scenario - which is why the demo could
hold exactly one waiting-on-you card before this: a second one came back re-asking the first one's
questions. A scenario declares `"continues": "<the original scenario's title>"`, and the player
identifies the original by reading its own transcript's first human turn (`firstUserPrompt`), which
is the only record of what the session was ever about that survives a restart. A session whose
work declares no continuation still falls back to the generic `resume-continuation.json`.

**The player also answers the daemon's own headless calls**, which is the half of a demo nothing
on screen credits. `claude -p` is how the daemon titles an untitled dispatch, reconciles a Goal,
compacts a workflow's intent - and how every Persona in a Workflow run reviews. That last one has
no fallback: a verdict the daemon cannot parse is an infrastructure failure, and three of those
block the run, so a seeded review workflow would end `Workflow blocked` rather than `⌁ Approved`.
The player answers a review with a schema-valid **pass** that names the reviewer, and a Persona
whose guidance contains `DEMO_FAIL_VERDICT` gets a **fail** with a requested change instead -
which is how a future scenario can show a repair round. The marker is read from the quoted
guidance only, never from the diff or transcript the prompt also carries, so the reviewed work
cannot vote on itself.

**Every finished turn also reports what it cost**, in the `result` frame's own
`modelUsage`/`total_cost_usd` shape. That is the demo's per-card spend, and it has to arrive this
way: the driver owns an embedded session's ledger and the OTLP ingest drops every datapoint naming
a driven session, so a card's cost cannot be posted in from outside.

**A resumed player continues its session rather than starting a new one.** Given
`--resume=<id>` it adopts that id, appends to the transcript already at that path instead of
truncating it, and carries on its record numbering. All three matter: the driver re-binds the
card on any new `session_id`, so a fresh one would repoint it at a transcript this process had
just created empty - the card would come back with its whole conversation gone. A resumed
session that is owed no continuation turn also emits a `result` shortly after `init`, because
that frame is the only thing that moves a card off `starting`, and a restored card claiming to
be starting up for the rest of the demo is both ugly and untrue.

Codex sessions play the same
schema over the `codex app-server` protocol, with one gap: Codex's real "waiting on you"
moment is an approval request, not `AskUserQuestion`, and this phase does not implement it -
an `ask` step on a Codex session narrates the question as prose instead of blocking, so a
scenario written for Claude does not stall a Codex run.

**`pi` plays scenarios too** (`fake-pi.mjs`), writing pi's own real transcript shape - one
JSON `message` record per line under `~/.pi/agent/sessions/--<encoded cwd>--/`, exactly the
path and record shape `src/server/harness/pi/transcript.ts` reads back (verified directly
against that module's own `piToMessage` and `computePiSessionActivity`, not assumed). pi has
no control wire at all (`hooks: null`, `sdk: null`), so there is nothing to speak on stdio -
the transcript file is the *entire* channel, and this player writes real turns, real tool
calls, and real file edits into it, the same scenario schema as its Claude and Codex siblings.
An `ask` step degrades to narration for the same reason it does on Codex: pi has no
`AskUserQuestion`-equivalent channel to block a turn on.

**What playing a scenario cannot do anything about: getting the resulting session adopted
onto the dashboard.** This is a hard architectural floor, confirmed against the actual code
rather than assumed, and it is orthogonal to whether the player itself works (it does):

1. `pi`'s harness registry entry sets `sdk: null` (`src/server/harness/index.ts`), whose own
   comment says plainly: "Phase 6 fills this with pi's `--mode rpc` adapter." That adapter
   does not exist yet, for `pi` in any mode, real dispatch or demo - building one belongs
   under `src/server/harness/pi/`, an unrelated, unscoped harness-roadmap feature this task's
   "do not modify `src/`" rule puts out of reach.
2. `pi`'s only real path is a terminal pane a person types into. But `Dispatcher`'s terminal
   branch (`src/server/dispatcher.ts`) waits for a dispatched pane via
   `registry.waitForSessionAtCwd`, fed by the same passive discovery sweep this plan calls a
   *non-negotiable* isolation guard (`MISSION_POLL_MS=0`) - turned back on, the demo daemon
   would walk every process on the machine and adopt the operator's real sessions, Kill/Reset
   buttons included, for every agent in the demo, not only `pi`.

So a `pi` task dispatched from the demo dashboard today will not appear as a live card, even
though `fake-pi.mjs` genuinely executes the scenario behind it (confirmed by running it
standalone and parsing its output with pi's own product parser). This was investigated across
three review rounds; the last two insisted on a literal player regardless of the adoption
gap, so this final round built one - but closing the adoption gap itself would mean either
building the unbuilt RPC adapter above or reopening the isolation hazard `MISSION_POLL_MS=0`
exists to close, neither of which this phase should do unilaterally.
