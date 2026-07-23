# Pi harness - Phase 5 spike + adapter

The pluggable-integrations acceptance test (`docs/plans/pluggable-integrations/plan.md`,
Phase 5): add a third harness, `pi`, written *only* against the `Harness` interface. The
criterion is that adding it touches nothing outside the adapter and its registration - and
where it does, that touch is a **finding about the interface**, recorded here and in the PR,
not a workaround.

Spiked the way `codex-instrumentation.md` did: establish what the tool exposes before writing
an adapter. The JSONL format is fully readable, and Mission Control dispatches pi with its
native `--session-id` so that exact UUID binds the launched process to its file. An
operator-started pi supplies no identity and stays on the safe discover / name / focus / type
degradation with no attributed transcript. That injected UUID identifies the initial context:
if pi creates a newer session file after `/new` or resume, the binding declines until an
identity source establishes the replacement.

## What pi is

`@earendil-works/pi-coding-agent`, `pi` `0.80.10`. A Node CLI coding agent
(`/opt/homebrew/bin/pi` -> `.../pi-coding-agent/dist/cli.js`), architecturally close to Claude
Code: a project-keyed session store of one JSONL file per session, `--print`, `--session-id`,
`--continue`/`--resume`, an interactive `pi-tui`, an `--mode text|json|rpc` control surface,
skills, extensions. Multi-provider (`--provider`, default google; this install has openai and
ran `gpt-5.5`).

State dir: `~/.pi/agent/` (`settings.json`, `auth.json`, `models-store.json`, `sessions/`,
`skills/`).

## Capability-by-capability findings

### detect - REQUIRED, non-null

`cli.js` sets `process.title = APP_NAME` ("pi") before dispatching, so on the process table a
live pi session shows as literally **`pi`** (argv0 basename `pi`), verified against `ps` - it
matches `commands: ["pi"]` directly, like a native binary, cleaner than Codex's node-shim.
`--mode rpc` sets `process.title = "pi-rpc"`, which naturally does not match.

- `commands: ["pi"]`
- `argvSignatures: ["pi-coding-agent/dist/cli.js", "@earendil-works/pi-coding-agent"]` - a
  defensive fallback for a launch snapshotted before `process.title` lands, or a
  `node .../cli.js` invocation. Same accepted false-positive class as Codex's package-name
  signature (an `npm i -g @earendil-works/pi-coding-agent` line matches transiently).
- `background: { subcommands: [], flags: [] }` - pi has no daemon and no MCP-server role, so
  there is nothing to exclude. **Limitation, stated not hidden:** because `process.title`
  rewrites the command to `pi`, the management subcommands (`config`, `update`, `install`,
  `list`) are also invisible in `ps`, so `BackgroundSpec` *cannot* see them to exclude them.
  They are short-lived (except `config`) and rare, so the phantom-card risk is low and
  transient. `BackgroundSpec` is the wrong tool for it anyway - these are foreground commands,
  not background roles.

### bin - REQUIRED, non-null

`{ env: "PI_BIN", legacyEnv: [], command: "pi" }`. Bare on PATH, resolved through the one
`resolveAgentBin`.

### transcript - non-null, and RICHER than Codex

pi writes one JSON record per line to
`~/.pi/agent/sessions/--<cwd>--/<ISO-ts>_<uuid>.jsonl`. Records: a `session` header
(`{type,version,id,timestamp,cwd}`), `model_change` (`{provider,modelId}`),
`thinking_level_change` (`{thinkingLevel}`), then `message` records
(`{type:"message",id,parentId,timestamp,message:{role,content:[parts],usage,model,stopReason,...}}`).

- **`messages` is non-null.** user content is `[{type:"text",text}]`; assistant content is
  `[{type:"thinking"},{type:"text"},...]` and tool calls arrive as `tool_call` content parts.
  So `GOAL_UNSUPPORTED.pi` is null (paired, `harness-transcript.test.ts`). Pi validates the
  two capability slots independently: it has readable turns like Codex, but unlike Codex it
  declares `hooks: null`.
- **`passiveRead` gives both meta AND activity** (unlike Codex, whose rollout has no turns to
  read activity off). model from `message.model` / `model_change`; context tokens from
  `usage.input + cacheRead + cacheWrite`; thinking from `thinking_level_change`. Activity:
  `stopReason` is `"stop"` on a clean turn (idle) and `"aborted"` on an interrupt - only
  `"stop"` reads idle, everything else works, matching Claude's conservative bias.
- **cwd -> dir munge, verified from source** (`session-manager.js`):
  `` `--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--` ``. Dots are NOT replaced (only
  `/ \ :`), unlike Claude's `[/.]`. `/Users/jordanmance` -> `--Users-jordanmance--`,
  `/private/tmp` -> `--private-tmp--`, both confirmed against the real store.
- `metaSource: "transcript"` - reused, not a new `MetaSource` member. The union's only
  authority-ranked value is `"statusline"`; `"transcript"` means "our passive read of the
  JSONL", which is exactly what pi's is. No shared edit. (Codex has its own `codex-rollout`
  only because its file is not a turn log.)
- **Identity correlation is exact or absent.** `locate` binds only when `agentSessionId` equals
  the UUID in a candidate filename. The exact file is accepted only while no strictly newer
  session file exists in that project directory; this freshness check can only decline the
  known file, never substitute another. A `/new`, resume, or short-lived sibling therefore
  removes the attributed transcript rather than risking stale or foreign state. Misses and
  freshness are rescanned without reading file contents. There is no timestamp correlation,
  cwd-occupancy, or persistence fallback.
- **Instrumentation is launch-scoped.** `preparePiLaunch()` injects pi's native
  `--session-id <uuid>`, and the dispatcher records that UUID on the discovered session. A
  dispatched pi therefore gets transcript, metadata, activity, goal, and safe idle reload from
  exact identity. An operator-started pi supplies no `agentSessionId`, so all five degrade to
  visible absence rather than guessed ownership. Dispatch also waits for the matching session
  file to appear before sending the first prompt; a missing file is an unverified launch and
  fails instead of falling through to blind terminal input.

### control - REQUIRED, non-null

`{ kind: "keystroke", settleMs: 400, pastePlaceholder: null, collapses: () => false }` -
identical shape to Codex. pi's composer does NOT collapse a multi-line paste into a
placeholder (verified live: pasted lines render expanded), and the package has no
`[Pasted text #N]` equivalent, so `pastePlaceholder: null` and submit verification has no
on-screen evidence -> `submitVerified: false`, one Enter, no retry. `settleMs` is Claude's
inherited measurement, unverified against pi.

### hooks - null

pi's extensions are **in-process TypeScript modules** loaded via `--extension` / discovery -
a plugin API (subscribe to lifecycle events, register tools, drive the UI), NOT a shell-out
hook like Claude's `settings.json` hooks or Codex's launch-scoped `-c hooks.*` overrides. pi
pushes NOTHING at us through any mechanism we have wired, so `hooks: null` is honest and
first-class. Discovery alone cannot safely select a transcript for `passiveRead`; dispatched pi
instead uses its native launch session id. Wiring a pi extension that POSTs to the daemon would
be the follow-on required to instrument operator-started sessions.

Consequence, same as an uninstrumented Codex: `workQueue` is null (no pickup/finish signal to
verify), and the 20s hook wait is skipped.

### tui - null, but MEASURED (both sub-capabilities absent/parked)

pi's screen IS readable - captured its footer (`0.0%/272k (auto) ... gpt-5.5 • medium`) and
its `/model` selector live, cursor glyph **`→` U+2192** (Claude U+276F, Codex U+203A). But
neither thing the app reads off a screen is wired for pi:

- `modeLine`: absent - **verified.** Shift+Tab cycles pi's THINKING level (medium->high->xhigh),
  not a permission mode. pi's `(auto)` footer token is an approval mode (`manual`/`auto`/
  `readonly`, cycled by a separate key), not a Shift+Tab permission-mode footer in the app's
  vocabulary - see `permissionModes` below.
- `dialog`: **parked, not assumed.** The `/model` capture is a filter-list, not the numbered
  permission/approval prompt `activePaneDialog` exists to read, and pi's tool-approval dialogs
  fire only after the model requests a tool - which needs a provider login this machine does
  not have (`auth.json` is `{}`, the same blocker Codex's spike hit). Declaring a numbered-menu
  grammar against an unverified approval-prompt shape risks a false reading.

So `tui: null`. This is NOT the assumed-not-measured mistake the interface doc warns against -
pi's screen was measured, its cursor recorded (so the follow-up, once pi is logged in, is the
one-token confirmation Codex's turned out to be). It is that the codebase's canonical form for
"nothing to parse off the screen today" IS `tui: null`: `harness-tui.test.ts` forbids a `tui`
spec with BOTH sub-capabilities null, because `annotatePaneState` would then capture the pane
every tick to run zero parses. Both-null must be `tui: null`, so pi is. The cost is the
hookless "needs you" signal, exactly as for a pre-measurement Codex.

### permissionModes - null (FINDING: interface encodes a Claude assumption)

pi HAS an approval-mode concept - `manual` / `auto` / `readonly`, with a `cycleMode` - so
`null` under the doc's letter ("no such concept at all") slightly understates it. But the
app's `PermissionMode` is a CLOSED union of **Claude's own mode strings** (`default`, `plan`,
`acceptEdits`, `auto`, `dontAsk`, `bypassPermissions` - types.ts says so: "the exact strings
Claude reports on its hook payloads"). pi's `manual`/`auto`/`readonly` do not map onto it, and
its modes are cycled by a non-Shift+Tab key with a `(auto)`-style footer, not Claude's
mode-line grammar. Supporting them would require either widening the shared `PermissionMode`
union with pi's vocabulary or making mode identifiers harness-defined - a shared-interface
change. The acceptance criterion forbids that quietly, so `permissionModes: null` (visibly
disabled: no chip, routes 400, dispatcher arms nothing) and this is **the harness axis's
main interface finding**, the counterpart to Ghostty's `HostProcessSpec` on the emulator axis.

### skills - non-null

pi loads skills from the SKILL.md Agent-Skills standard (agentskills.io), verified reading
BOTH `~/.agents/skills` (the shared standard dir, same as Codex) AND its own
`~/.pi/agent/skills` (probed live with a temp skill). Declared with pi's OWN dir so it does
not collide with Codex in `skillsDirs()`:

- `homeDir: [".pi", "agent", "skills"]` - verified pi reads it; parallel to `~/.claude/skills`
  and `~/.agents/skills`. The reconciler's `skillsDirs()` fold picks pi up with ZERO code
  change (the fold the single-dir version predicted a second declarer would need - pi is the
  third).
- `reloadCommand: "/reload"`, `reloadIdleSource: "transcript"` - pi has no skills-dir watcher.
  A dispatched session's exact transcript supplies the settled idle signal, and its `tui: null`
  means the reloader uses that passive readiness directly. A session without a current exact
  transcript binding is neither counted nor typed into.
- `dirEnvVar: "PI_SKILLS_DIR"`, `isolatedDirName: "pi-skills"`.

### mcp - null

pi has **no MCP client** (grep of the whole package found only a coincidental substring in a
vendor file - no `mcpServers`, no `mcp add`). It extends via its own extensions, not MCP. So
`mcp: null`: the installer says so rather than shelling out to a CLI that was never going to
exist.

### clearContext - non-null

`{ command: "/new" }` - **verified**: `/new` starts a fresh session in-place ("✓ New session
started", no confirmation prompt), which is pi's equivalent of Claude's `/clear`. (pi also has
`/compact`, which summarizes rather than clears; there is no `/clear`.) The new conversation
UUID no longer matches the injected launch UUID, so the exact binding fails closed rather than
following a different file heuristically.

### effort - non-null

`{ levels: THINKING_LEVELS, launchArgs: (level) => ["--thinking", level] }`. pi's `--thinking`
accepts `off|minimal|low|medium|high|xhigh|max`; the app's `THINKING_LEVELS` (`low..max`) are
a subset pi accepts verbatim.

### cost (COST_UNSUPPORTED) - null (cost IS supported)

Unlike Codex (a single unpriced `tokens_used` scalar), pi records real per-message `usage`
with token tiers AND dollar cost (`usage.cost.total`) in every assistant record. So
`COST_UNSUPPORTED.pi = null` and the passive read populates token usage.

### models (MODEL_CATALOG) - provider-qualified ids (FINDING, then FIXED)

pi is multi-provider and its true model ids are `provider/id` (`openai/gpt-5.5`), so a bare
`gpt-5.5` would resolve against pi's DEFAULT provider (google), not OpenAI - the Inspector
caught this on the PR. `ModelIdSchema` (protocol.ts) rejected `/`, because Claude's and Codex's
ids are single tokens (each harness IS a provider). **Fixed** once the launch integration made a
dispatched pi real: `ModelIdSchema` now admits `/` in the INTERIOR only
(`/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/`), so a leading `/`, a `../` traversal, or a `-flag` still
fails while `openai/gpt-5.5` passes and no shell metacharacter is admitted; and
`MODEL_CATALOG.pi` carries provider-qualified ids (`openai/gpt-5.5-pro`, `openai/gpt-5.5`,
`openai/gpt-5-codex`, `openai/gpt-5-mini`) so `--model openai/gpt-5.5` selects the intended
model deterministically. `coreModelId` strips the provider prefix so labels and window inference
still read `gpt-5.5`. Test: `dispatch-model.test.ts` (the catalog-passes-schema loop now
includes pi, plus an interior-slash-yes / leading-slash-and-traversal-no case).

## The interface findings (what the acceptance test surfaced)

The CORE holds: pi discovers, names, focuses, and types through declarative registry entries.
The one deliberate `agent === "pi"` branch is launch preparation, where identity must be
chosen before the process starts; transcript polling remains heuristic-free. The transcript
parser is live for launched sessions and correctly degrades without identity. The couplings
that remain:

1. **`PermissionMode` is a closed union of Claude's mode strings.** pi has real approval modes
   that don't fit it. Handled by `permissionModes: null` (visible degradation). The one place
   the Harness axis still bakes in a Claude assumption. NOT fixed here - a legitimate null.
2. **`ModelIdSchema` rejected `/`,** so pi's provider-scoped ids could not be expressed.
   **Fixed** (the Inspector flagged the bare-id stopgap): the schema now admits an interior
   `/`, and `MODEL_CATALOG.pi` uses provider-qualified ids - see the models section above.
3. **Reload readiness assumed hooks plus a readable mode line.** pi has neither but does have
   an exactly attributed passive transcript for dispatched sessions. **Fixed** by declaring
   `reloadIdleSource` on `SkillsSpec`: the reloader preserves Claude's hook and mode-line path,
   while transcript-driven sessions require a current binding and skip the nonexistent TUI
   read. `skillsAgents()` returns `AgentType[]` because pi also needs a pane nudge.
4. **`process.title = "pi"`** erases subcommands from `ps`, so `BackgroundSpec` can't exclude
   management commands. Honest `background: {[],[]}`, low/transient risk. Not an interface gap,
   a pi quirk worth stating.
5. **tui.dialog parked** pending a pi provider login (cursor `→` captured), mirroring Codex's
   original spike.
6. **Terminal multiplexers were wrongly in the detection `WRAPPERS` list.** Found by the live
   E2E, not the diff: running `discover()` against a real pi session produced a PHANTOM pi card
   from `tmux attach -t "P5 pi harness adapter"` - the tmux session name (this very task's
   name) contains `pi` as a space-delimited word, and `tmux` being a wrapper made the bare-token
   scan over the whole command line match it. The risk is symmetric for every agent
   (`tmux attach -t "fix claude bug"`), but pi's short common name makes it routine. **Fixed** by
   removing `tmux`/`screen` from `WRAPPERS` (`discovery/processes.ts`): an agent inside a
   multiplexer ALWAYS also appears as its own native process on the pane's tty, so the wrapped
   match over the multiplexer's command line buys no real detection and is pure false-positive
   surface. This is the same "a short token in text nobody controls" hazard `BackgroundSpec`
   documents, one layer up - and the strongest argument for the acceptance test's "verify against
   the real tool, not the diff" rule, since no fixture would have named a tmux session after the
   task. `detection.test.ts` pins it.

7. **Declaring pi's skills capability made a test pollute the operator's real home.** Also found
   by verification, not the diff: after a full test run, `~/.pi/agent/skills` appeared in the
   REAL home with a `mission-alpha` symlink into a test's temp catalog. `skills-multi-harness.test.ts`
   reconciles through the default `skillsDirs()` fold and pinned only `CLAUDE_SKILLS_DIR` /
   `CODEX_SKILLS_DIR` - so pi's newly-declared dir resolved to `~/.pi/agent/skills`. Codex had
   the same gap but its `~/.agents/skills` already existed, so it went unnoticed; pi's did not.
   **Fixed** by pinning `PI_SKILLS_DIR` (and adding it to the `beforeEach` cleanup), the same
   `db-isolation` discipline `openDb` enforces for the state dir - a new skills-declaring harness
   must be pinned wherever a test reconciles. The other two files a bisect implicated
   (`skills-reconcile`, `terminal-home`) were confirmed clean in isolation - concurrent runs in
   this live Mission Control environment had contaminated the bisect.

8. **Launch identity scopes pi's reload capability.** A command existing in pi is not enough
   to authorize an autonomous keystroke. Dispatched sessions have an exact current transcript
   and can use `/reload` after settled idle; operator-started and post-`/new` sessions have no
   current binding and are refused. A newer file invalidates the initial binding before its
   stale idle state can authorize a reload. Claude remains hook-gated and mode-line checked
   byte-for-byte.

9. **`providerModelDefault(AgentType)` conflated the harness and runner axes.** Adding pi
   widened the parameter even though every caller supplies `LlmRunnerId`, allowing a harness
   that is not an offline provider to silently receive Claude's fallback. **Fixed** by narrowing
   the helper to `LlmRunnerId`; harness model catalogs continue to use `AgentType`.

10. **A hookless transcript has no provable discovery identity.** Newest-file, live-occupancy,
    process-start, delay-window, and persistence heuristics all admit foreign files under
    ordinary sibling, resume, or `/new` races. **Fixed** by exact filename UUID correlation
    only. `preparePiLaunch` supplies that UUID for dispatched sessions; operator-started
    sessions visibly lack transcript, meta, activity, goal, and live reload. This launch-scoped
    capability accepts the initial exact file only while it remains the newest, so a context
    change declines instead of retaining stale state. Symmetric with Codex's launch-scoped
    hooks, this is the acceptance test's most valuable finding.

11. **Harness launch preparation is a documented dispatcher footprint.** Exact identity cannot
    be recovered inside a transcript adapter after launch. pi therefore adds
    `harness/pi/launch.ts`, and the dispatcher composes its returned argv and records its
    session id just as it composes Codex's launch-scoped hook preparation. The matching file's
    appearance is also pi's launch-scoped readiness proof: dispatch waits for it and refuses an
    unverified launch rather than typing after the generic fixed delay. Readiness and prompt
    acceptance remain separate: immediately before delivery the dispatcher records that exact
    file's byte size, and only a user turn appended beyond that boundary acknowledges the
    prompt. Metadata-only growth and generic `working` state are refused. The integration is
    per-harness launch data, not transcript attribution special-casing.

**The E2E that found #6, in full.** A live pi session in a tmux pane, run through the daemon's
real `discover()`: the true session cards correctly (`nameSource: tmux`, cwd, pid), detection
classifies the `pi` process as native off its `process.title`, and after the WRAPPERS fix no
phantom card survives a multiplexer session named with a `pi` token. The captured transcript
still proves the parser independently through a known fixture path.

Every implementation touch outside the forced `Record<AgentType,...>` maps and the pi adapter
is accounted for above, including launch preparation and the reload-readiness contract. The two contract-test lines
that assert `agent: "pi"` is REJECTED (the authors anticipated this - the probe agent is
`probeagent`, not `pi`) were updated to a still-invalid id.

## Pointers

- Adapter: `src/server/harness/pi/{detect,bin,control,transcript,meta,launch}.ts`, registered in
  `src/server/harness/index.ts`.
- Forced maps: `AGENT_TYPES` (types.ts), `AGENT_IDENTITY` (agent.ts), `HARNESS_CAPABILITIES`
  (harness-capabilities.ts), `HARNESSES` (harness/index.ts), `COST_UNSUPPORTED` (cost.ts),
  `MODEL_CATALOG` (model.ts), `GOAL_UNSUPPORTED` (goal.ts), `BACKLOG_TASK_MODEL_SPECS`
  (ForemanSettingsPanel.tsx).
- Fixtures: `test/fixtures/pi-sessions.ts` (verbatim capture), `test/pi-harness.test.ts`.
- Reusable pipeline confirmed agent-agnostic (as `codex-instrumentation.md` predicted):
  discovery, `transcript.ts` byte windowing, `runtime-meta.ts`, the pane read/write path.
