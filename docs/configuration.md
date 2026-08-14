# Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `MISSION_PORT` | `7317` | daemon / dashboard port |
| `MISSION_HOME` | `~/.mission-control` | state dir (db, token, logs, dispatch worktrees) |
| `MISSION_WORKSPACE_DIRS` | `~/workspace` | colon-separated roots scanned for the dispatch repo picker, and for the treehouse pools the leaked-lease sweep visits |
| `MISSION_POLL_MS` | `1500` | discovery interval |
| `MISSION_AGENTS_SHADOW_MS` | `0` (off) | how often to take a [shadow reading](sessions.md#shadow-reading-claudes-own-session-state) of `claude agents --json` and log where it disagrees with our own discovery. Diagnostic only - it never feeds the registry. `0` or any non-positive value disables it; anything under `5000` is clamped up, since one reading spawns the full `claude` binary |
| `MISSION_POOL_REAP_MS` | `300000` | how often to sweep treehouse pools for leaked leases. `0` (or any non-positive value) turns the background sweep off; an unparseable value falls back to the default; anything under `30000` is clamped up to it, and anything over `604800000` (7d) clamped down to it, since past ~24.8d `setTimeout` overflows into a hot loop |
| `MISSION_DISPATCH_READY_MS` | `30000` | dispatch: how long to wait for the agent's pane to be discovered before failing |
| `MISSION_DISPATCH_SETTLE_MS` | `2000` | terminal-runtime dispatch: how long a discovered pane with no usable hook readiness signal must remain live before dispatch continues. This starts immediately for Pi, whose positional launch message needs no pane injection, and after a hook wait times out for a still-live session. An observed exit fails instead. Agent SDK dispatch does not use a settle delay |
| `MISSION_DISPATCH_HOOK_READY_MS` | `20000` | terminal-runtime dispatch: how long to wait for the exact discovered session's first hook when that launch can produce one. Hook silence falls back to the settle above if the session is still live; an observed exit ends the wait immediately. The wait is skipped for hookless harnesses such as Pi and when a particular Codex launch could not install its [hook bridge](sessions.md#precise-status-for-codex-hooks-that-ride-on-the-dispatch) |
| `MISSION_TASK_TITLE_MODEL` | `claude-haiku-4-5` | [dispatch](dispatch-and-backlog.md#dispatch-an-agent): the model that names a task whose Title was left blank. **Settings → Models → Task title** wins where it is set, then this, then the shipped default |
| `MISSION_WORKFLOW_CONTEXT_MODEL` | provider's cheap model | [Workflows](workflows.md#workflows-and-personas): compacts one Preview submission's preserved raw evidence, with one fresh 45-second attempt after an unparsable reply and deterministic fallback on failure. **Settings → Models → Workflow context** wins where it is set, then this, then the selected provider's cheap default |
| `MISSION_WORKFLOW_PERSONA_MODEL` | provider's balanced model | [Personas](workflows.md#workflows-and-personas): runs a fresh, tool-less Persona review. A Persona's own model override wins, then this variable, then the selected provider's balanced default |
| `MISSION_WORKFLOW_PERSONA_TIMEOUT_MS` | `600000` | [Personas](workflows.md#workflows-and-personas): hard cap on one Persona call. Sized with `MISSION_INSPECTOR_TIMEOUT_MS` rather than with the 120s default below, because a Persona reads the same shape of evidence - a diff and a transcript window - and the cost of the budget being too small is paid three times: a timeout is an infrastructure failure, and the engine retries one twice more before failing the submission |
| `MISSION_ENSEMBLE_COMPARISON_MODEL` | provider's cheap model | [Ensembles](ensembles.md#multi-agent-ensembles): the model behind every ensemble evaluation - the Best-of-N comparison, the Consensus divergence pass, and each Panel-vote judge's ballot. An explicit evaluator or judge model wins, then a judging Persona's model override; otherwise **Settings → Models → Ensemble evaluation**, then this variable, then the provider's cheap default |
| `MISSION_TASK_TITLE_TIMEOUT_MS` | `15000` | dispatch: hard cap on one titling attempt - a timeout isn't retried, so a missing or slow `claude` costs this once and the first-line title stands. Sized above Haiku's measured 7-8s; a successful call returns as soon as the model does, so lowering it only buys a faster failure |
| `MISSION_LLM_RUNNER` | `claude` | [Models](models.md#models-what-the-apps-own-model-work-runs-on): which provider does the app's own offline work - the background jobs, Foreman's cheap tier. **Settings → Models → Provider** loses to this where it is set, and the panel says so. An id this build does not have falls back to the default rather than failing, and the panel names what it dropped |
| `MISSION_CLAUDE_TRANSPORT` | `sdk` | Claude's headless wire protocol: `sdk` uses one fresh Agent SDK `query()` with deterministic setting sources and AbortController cancellation; `print` uses `claude -p`. Tool-less calls keep every tool disabled; Inspector reviews and replies keep their existing `Read,Grep,Glob` grant and provider-enforced deny rules. The stored `llm.claudeTransport` choice wins where set, then this environment fallback, then `sdk`. The daemon resolves that ladder and shares the result with the separate Foreman worker over `/api/llm/status`, so Foreman's review, queue verify, backlog planner, and Tier 1 triage calls follow the same choice without opening the database. Pin `print` to diagnose an SDK compatibility problem or temporarily roll back the transport while preserving every caller above it |
| `MISSION_SKILLS_DIR` | app's `skills/` | [skills](skills-and-settings.md#skills-every-session-mixed-reload-behavior) catalog dir (the symlinks' target) |
| `MISSION_FOREMAN_INSTRUCTIONS` | app's `personas/FOREMAN.md` | the seed for [Foreman's standing instructions](foreman.md#its-standing-instructions-foremanmd). Only the DEFAULT - once saved through the API the stored value wins, and this is what a reset restores |
| `MISSION_MCP_SERVER` | app's `dist/mcp/server.mjs` | path to the bundled MCP server that dispatched sessions are pointed at through [the ask channel](sessions.md#the-ask-channel)'s `--mcp-config`. What a bad path costs depends on what the launch asked for. An ordinary dispatch degrades quietly: the channel is skipped entirely and the session keeps Claude's built-in menu. A launch that **requires** Mission MCP tools - every scout, every ensemble member - is refused before the agent spawns instead, because a session that cannot submit its result cannot finish its task at all. Both failures are refusals for such a launch: a path that does not exist, and a bundle that exists but does not publish a required tool. The daemon also reports the second at startup - see [Adding or changing a tool means rebuilding the bundle](sessions.md#review-channel-mcp) |
| `MISSION_TASK_SOURCE_TICK_MS` | `30000` | [Task sources](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog): how often the sweeper wakes to ask which sources are due. Not the sweep interval - that is per source, and clamped to 1 minute - 24 hours. Floored at `5000` |
| `MISSION_TASK_SOURCE_TIMEOUT_MS` | `60000` | Task sources: hard cap on one sweep, so a hung source cannot wedge its own schedule. Floored at `5000` |
| `JIRA_API_TOKEN` | unset | [Jira task sources](dispatch-and-backlog.md#jira): the API token the REST fallback authenticates with when the `jira` CLI is not on the daemon's `PATH` (or cannot answer). Read **bare**, without the `MISSION_` prefix, because it is the same variable `jira-cli` and Atlassian's own shell helpers already use - so a machine set up for either needs nothing new. Never stored in Mission Control's database; read from the daemon's environment when it sweeps, so a variable exported after the daemon started needs a restart to reach it |
| `JIRA_EMAIL` | unset | Jira task sources: the account the token belongs to. Jira basic auth is the **pair** - one without the other is reported by name in the source's preflight rather than failing as a bad password |
| `JIRA_ALLOWED_HOSTS` | unset (Jira Cloud only) | [Jira task sources](dispatch-and-backlog.md#jira): extra hosts the REST rung may send `JIRA_API_TOKEN` to, comma-separated; `*.example.internal` allows a whole domain. Without it the credential goes only to `*.atlassian.net`, so a lookalike host - or a config written by something other than you, since the config route is localhost-reachable and dispatched agents share the machine - cannot aim the token elsewhere. Read bare, like the credential itself: widening the target and holding the token are then the same act of trust. Does not affect the `jira` CLI, which uses its own credentials |
| `MISSION_SCOUT_RECONCILE_MS` | `60000` | [Scout archives](scout-archives.md): how often the daemon rescans `$MISSION_HOME/scouts` for new, changed, or removed bundles. The scan is the AUTHORITY - a filesystem watcher runs beside it as a latency hint, and watchers drop events on exactly the synchronised directories foreign bundles arrive through. Each pass is jittered by up to 20% so several daemons, or a daemon and a sync tool, do not settle into lockstep. An unchanged bundle costs one `stat`, so the steady-state cost is proportional to the number of archives rather than their size. `0` (or any non-positive value) turns recurring reconciliation off, leaving only the bootstrap pass and the watcher; an unparseable value falls back to the default |
| `MISSION_SKILLS_SETTLE_MS` | `10000` | skills: how long a session must sit idle before the daemon types `/reload-skills` into it |
| `MISSION_RETRO_SCAN_MS` | `10000` | [Repository memory](repository-memory.md#when-the-dashboard-offers-one): how often to look for a human turn beyond a live session's opening brief, which is half of whether the dashboard offers that session a retro. Far cheaper than the interval suggests: a session that has already flipped is never read again, and one whose transcript has not grown costs a single `stat`. `0` switches transcript scanning off entirely - the other half of the condition, resolved Inspector findings, comes out of a ledger query that runs anyway and keeps working |
| `CLAUDE_SKILLS_DIR` | `~/.claude/skills` | skills: where Claude's symlinks are written; set, it wins outright. Overridable so tests never touch your real one - though setting `MISSION_HOME` is the better isolation, because it covers every harness at once and so covers the ones added later. Left unset, a daemon on an explicit `MISSION_HOME` writes to `<MISSION_HOME>/claude-skills` instead - it doesn't own the machine's shared dir, and reconciling that dir against an isolated daemon's own (empty) skills config would unlink the real install's links. Under the `node --test` runner a reconcile pass over any of the three real directories below is **refused outright**, whatever the config says: pinning one variable and forgetting the others is how `npm run test` came to silently uninstall the machine's live Codex and Pi skills on every run |
| `CODEX_SKILLS_DIR` | `~/.agents/skills` | the same override for Codex's skills directory; on an explicit `MISSION_HOME` it falls back to `<MISSION_HOME>/codex-skills`, for the same reason. Point both at one path and the reconciler still walks it once |
| `PI_SKILLS_DIR` | `~/.pi/agent/skills` | the same override for Pi's skills directory; on an explicit `MISSION_HOME` it falls back to `<MISSION_HOME>/pi-skills`. Pi loads SKILL.md skills from the same standard as Claude and Codex, so the reconciler links the catalog into this dir too. Identity-bound Pi sessions dispatched by Mission Control receive `/reload` when idle; operator-started Pi sessions need a launch or restart |
| `MISSION_CLAUDE_BIN` | `claude` | Claude CLI path override - for dispatched agents and every headless Claude call, whether its wire transport is `claude -p` or Agent SDK `query()` (Foreman's review and Tier 1 router, the [Goal](sessions.md#goal) refiner, the untitled-[dispatch](dispatch-and-backlog.md#dispatch-an-agent) titler, the [Inspector](inspector-and-shipping.md#inspector-automated-pr-review)'s review and reply) |
| `MISSION_CLAUDE_TIMEOUT_MS` | `120000` | default hard cap on a single headless Claude call through either transport; callers that set their own budget (the Tier 1 router, the Goal refiner, the dispatch titler, the Inspector - see `MISSION_INSPECTOR_TIMEOUT_MS`) pass it instead |
| `MISSION_INSPECTOR_POLL_MS` | `90000` | [Inspector](inspector-and-shipping.md#inspector-automated-pr-review): how often to look at the adopted PRs. Slow by design - a review is expensive and a push isn't frequent. Also the base of the retry backoff: a PR that keeps failing is retried at twice the previous delay, up to six hours. A new push cuts that wait short for the first few failures, after which it waits like any other attempt - unless the failure is one only a push can fix (a diff too large to buffer), where the next push always cuts it short. The tick does nothing at all while the Inspector is off |
| `MISSION_INSPECTOR_MODEL` | `claude-sonnet-5` | Inspector: the model both the review and the follow-up replies run on. **Settings → Inspector → Model** wins where it is set, then this, then the shipped default. Named rather than left to the `claude` CLI: an unset `--model` inherits whatever that CLI defaults to, which is the priciest tier available and is not recorded anywhere |
| `MISSION_INSPECTOR_TIMEOUT_MS` | `600000` | Inspector: hard cap on one review. Far larger than the Foreman reviewer's 120s because this one has tool round-trips inside it: a 10KB five-file diff measured 225s on Opus and 272s on Sonnet, so a wire near either is a guaranteed failure rather than a safety net - the run is killed, the head never advances, and the PR climbs the retry backoff having produced nothing |
| `MISSION_INSPECTOR_REPLY_TIMEOUT_MS` | `300000` | Inspector: hard cap on one follow-up reply - a smaller job than a review, but the same shape (the diff in the prompt, the same read-only tools), so it moves with the review's ceiling rather than sitting at a fraction of it |
| `INSPECTOR_MAX_DIFF_BYTES` | `400000` | Inspector: cap on the diff put in a prompt, in UTF-8 **bytes** - so a diff of CJK, emoji or box-drawing content counts the 3-4 bytes each of those costs, and the cut lands on a character boundary rather than halfway through one. Read bare, unlike every other row here; `MISSION_INSPECTOR_MAX_DIFF_BYTES` (and the `FLEET_` / `HARNESS_` forms) still work and win where both are set. A refactor past this isn't reviewable in one pass anyway; the prompt says it was truncated so the model never concludes anything from the absence. Separately, a diff too large to hold in memory at all (16MB) is declined rather than reviewed - the PR is parked, and a later push that shrinks it below the ceiling gets reviewed |
| `MISSION_CODEX_BIN` | `codex` | Codex CLI path override - both for dispatched agents and for every headless `codex exec` the app runs when Codex is the selected [provider](models.md#models-what-the-apps-own-model-work-runs-on) |
| `MISSION_CODEX_TIMEOUT_MS` | `120000` | hard cap on a single headless `codex exec`, the mirror of `MISSION_CLAUDE_TIMEOUT_MS`. A caller that sets its own budget (the Inspector, the Goal refiner, the dispatch titler) passes it instead |
| `MISSION_PI_BIN` | `pi` | Pi (`@earendil-works/pi-coding-agent`) CLI path override for dispatched agents. Pi is a discovered/dispatched harness, not one of the app's own headless model providers |
| `MISSION_CODEX_HOOK` | app's `dist/satellites/codex-hook.mjs` | path to the bundled [Codex hook bridge](sessions.md#precise-status-for-codex-hooks-that-ride-on-the-dispatch) the dispatcher points a Codex launch at. If the path doesn't exist the hook overrides are dropped entirely and the session runs uninstrumented rather than failing to launch |
| `WEZTERM_BIN` | auto | wezterm CLI path override |
| `GHOSTTY_BIN` | `/Applications/Ghostty.app/Contents/MacOS/ghostty` | [Ghostty](sessions.md#which-terminal-you-use-is-declared-not-assumed) path override, for a non-standard install location. It answers *is Ghostty installed* and is never executed - the app drives the GUI through AppleScript, not this binary. There is deliberately no bare `ghostty` on `PATH` fallback: on Linux that binary is normally present and this integration cannot work there at all, so it would report "installed" on the one platform where every call must fail |
| `CMUX_BIN` | auto | cmux CLI path override. The default looks inside the app bundle (`/Applications/cmux.app/Contents/Resources/bin/cmux`) before PATH, because the cask does not symlink it |
| `FOREMAN_CLAUDE_BIN` | `claude` | legacy alias for `MISSION_CLAUDE_BIN`, still honored so existing setups keep working - and honored for the same things, dispatched agents included, since both now resolve through one chain; `MISSION_CLAUDE_BIN` wins when both are set |
| `FOREMAN_REVIEW_TIMEOUT_MS` | `120000` | Foreman: hard cap on one session review before it's abandoned - and the legacy alias for `MISSION_CLAUDE_TIMEOUT_MS`, which wins when both are set |
| `FOREMAN_EVAL_DEBOUNCE_MS` | `60000` | Foreman: minimum wall-clock gap between evaluations of the same session |
| `FOREMAN_REVIEW_MODEL` | `claude-opus-5` | Foreman [models](foreman.md#which-model-foreman-runs-as): the full reviewer (the `reviewModel` config wins over this) |
| `FOREMAN_VERIFY_MODEL` | `claude-opus-5` | Foreman [models](foreman.md#which-model-foreman-runs-as): the work-queue verifier (the `verifyModel` config wins over this) |
| `FOREMAN_TRIAGE_MODEL` | `claude-haiku-4-5` | Foreman [cheap tier](foreman.md#the-cheap-tier): Tier 1 router model (the `triageModel` config wins over this) |
| `FOREMAN_TRIAGE_TIMEOUT_MS` | `30000` | Foreman cheap tier: hard cap on the Tier 1 router; a timeout just routes up to the full review |
| `FOREMAN_BACKLOG_MODEL` | `claude-sonnet-5` | [Backlog autopilot](work-queues.md#backlog-autopilot-foreman-schedules-the-fleet): the model that reads the backlog's dependencies (the `backlogModel` config wins over this) |
| `FOREMAN_BACKLOG_TIMEOUT_MS` | scales with the backlog | Backlog autopilot: hard cap on one dependency read. Unset, the budget is `60s + 20s` per backlog item, capped at 10 min - the reply carries one written entry per task, so a fixed cap silently stops working once the backlog outgrows it. Set it to pin a flat ceiling instead. Three failures in a row and Foreman schedules serially |
| `FOREMAN_BACKLOG_RETRY_MS` | `600000` | Backlog autopilot: how long serial mode lasts before the dependency read is retried, so a transient outage doesn't degrade scheduling until a restart |
| `FOREMAN_BACKLOG_STORE_BACKOFF_MS` | `15000` | Backlog autopilot: first wait after the daemon refuses to store a plan, doubling per consecutive failure up to 10 min - a broken route can't cost a model call per tick, and after three it schedules one task at a time rather than stopping |
| `FOREMAN_QUEUE_SETTLE_MS` | `10000` | how long a session must sit idle before its work counts as settled - shared by the work queue's verify step, the PR follow-up, and the backlog autopilot's "is this agent free?" test |
| `MISSION_GOAL_MODEL` | `claude-haiku-4-5` | [Goal](sessions.md#goal): the model that reconciles each instruction with the durable objective. **Settings → Models → Goal** wins where it is set, then this, then the shipped default |
| `MISSION_AWAY_POLL_MS` | `5000` | [Away mode](attention-and-alerts.md#away-mode): how often the daemon re-checks for stuck sessions |
| `MISSION_AWAY_DIGEST_MODEL` | `claude-haiku-4-5` | [Away mode](attention-and-alerts.md#away-mode): the model that writes the return digest's narrative. **Settings → Models → Away digest** wins where it is set, then this, then the shipped default |
| `MISSION_AWAY_DIGEST_TIMEOUT_MS` | `20000` | Away mode: hard cap on the digest call; on a timeout the deterministic rollup stands alone |
| `CLAUDE_SETTINGS_PATH` | `~/.claude/settings.json` | which settings file the hook / statusLine / [cost telemetry](sessions.md#cost-telemetry) installers edit. Overridable so tests never touch your real one |

**Your dashboard settings are stored per machine, not per browser.** Layout, keyboard
shortcuts, alert delivery, and message formatting all live in the
daemon's database (`app_config`), alongside the Foreman, Skills, Harnesses, Task sources, Models, and
Cost settings - so they are the same in every tab, on `localhost` and `127.0.0.1` alike, in the
desktop app and in a browser, and they survive an upgrade. The browser keeps a copy in
`localStorage`, but only as a cache so the dashboard paints your layout in the first
frame; deleting it costs one request, not a preference.

[Cost telemetry](sessions.md#cost-telemetry) is not configured by the environment - it is a switch in
**Settings → Cost** (or `npm run install-telemetry`), which writes these keys into your
`~/.claude/settings.json` `env` block so that every Claude Code session on the machine
inherits them, including ones this app never launched:

| Key | Written as | Meaning |
|-----|-----|---------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | turns Claude Code's own metrics on |
| `OTEL_METRICS_EXPORTER` | `otlp` | export over OTLP |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` | JSON, so the daemon takes no protobuf dependency |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:<MISSION_PORT>` | the daemon; the SDK appends `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `x-harness-token=…` | the same per-machine token the hooks present |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | how often each session reports, in ms (5s-60s, set in Settings) |

`OTEL_METRICS_INCLUDE_SESSION_ID` is deliberately **not** written: it defaults to true and
must stay true, because with it false every datapoint arrives with no session id and none
of it can be attributed. If you have set it to `false` yourself, the daemon says so at
startup and the Cost panel says so on screen.

> **Upgrading from Fleet Control (`FLEET_*`) or ai-harness (`HARNESS_*`)?** Nothing to do.
> Both older env prefixes are still honored as fallbacks - `MISSION_*` wins where more than
> one is set - so a hook or MCP server installed under an older name keeps reporting without
> being reinstalled. On its first start the daemon renames an existing `~/.fleet-control`
> (or `~/.ai-harness`) state dir to `~/.mission-control`, keeping your db, token, and
> uploads; if that move can't happen the old dir keeps working exactly as before. Treehouse
> leases stamped with the old holder names are still recognised as ours, so a renamed
> install doesn't strand its worktree pool. Prefer the `MISSION_*` names going forward.
>
> Dashboard settings (layout, shortcuts, alerts, formatting) are read out of the browser
> once, under whichever product name last wrote them, and saved into the daemon - after
> which the rename can't reach them again. This only runs when the daemon has no settings
> of its own, so it can never overwrite ones you are already using. Settings left behind by
> an older **desktop app** are the exception: renaming the app gave it a new Electron
> profile, and the new one cannot read the old one's storage.
>
> Two things do need a re-run, because they registered a name with something outside this
> repo: `npm run install-service` (the launchd label becomes `com.mission-control.daemon`;
> the installer unloads the old one for you) and, if you use the review channel,
> re-adding the MCP server under its new name (`claude mcp add -s user mission-control …`).

## Commands

```sh
make init              # one-time bootstrap (deps, build, hooks, treehouse)
make session           # start an agent in a fresh worktree
npm run dev            # daemon + web (dev)
npm start              # daemon serving built UI
npm run foreman        # Foreman worker (needs-you queue, work queues, PR follow-up, backlog autopilot)
npm run build          # build web + MCP bundle
npm test               # full test suite, including real Electron GUI geometry checks
npm run test:electron  # focused Electron GUI checks (see AGENTS.md for macOS Seatbelt guidance)
npm run test:e2e       # Playwright: drive the real dashboard against a real daemon (after build)
npx playwright install chromium # one-time setup for test:e2e (npm install does not fetch it)
npm run smoke          # boot the built bundles, and check the MCP one publishes every declared tool (after build)
npm run demo           # token-free demo daemon + dashboard on ~/.mission-control-demo (after build)
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint over src, hooks, test, scripts, e2e (also: make lint)
npm run install-hooks  # wire Claude hooks
npm run install-statusline # + wrap the status line (terminal model / thinking / context %, plan meters)
npm run install-telemetry  # + cost telemetry env block (see Cost telemetry)
npm run install-service# LaunchAgent (macOS)
npm run personas       # recompile the built-in Personas from personas/*.md (commit the result)
npm run session-actions # recompile the built-in session actions from actions/*.md (commit the result)
node scripts/codex-app-server-bindings.mjs  # regenerate app-server types from the installed Codex
npx tsx scripts/measure-inspector-prompt.ts # size the Inspector review prompt on this checkout
```

The `make` wrappers for the build and verification commands - `make build`, `make test`,
`make lint`, `make check`, `make smoke` - install dependencies first, through a stamp file
(`node_modules/.install-stamp`) that carries `package.json` and `package-lock.json` as its
prerequisites. So they install in a tree that has never been installed, re-install after a
pull or a branch switch moves either manifest, and do nothing at all the rest of the time.

The stamp is what makes the second of those work: make is satisfied by any target that
exists, and `node_modules/` exists forever once anything has been installed into it - so
depending on the directory would install once and then silently run the gates against stale
dependencies. The stamp lives inside `node_modules/` so `rm -rf node_modules` invalidates it
too, and is touched only after a successful install, so a failed one is retried rather than
recorded as done.

A never-installed tree is routine rather than exotic: a [workflow Command](workflows.md#command-nodes) runs
its command in a freshly leased [pool worktree](worktrees-and-checks.md#check-leases), and `node_modules/` is
gitignored, so every check starts from a tree with no dependencies at all. Without this it
fails with `TS2688: Cannot find type definition file for 'node'`, which reads like a type
error in the diff under review and is really just a missing `@types/node`. The `npm run …`
forms are unchanged and assume an installed tree.

`npm run test:e2e` is the browser layer: it boots the built daemon against a throwaway state
dir, loads the built dashboard in Chromium, and drives real flows - dispatching an agent,
typing into a conversation - end to end. It spends no model tokens, because every agent
binary is redirected at a local fake through the `MISSION_*_BIN` chain that the daemon
already resolves for operators. See [e2e/README.md](../e2e/README.md) for the isolation
contract and for what to do (and not do) when adding a spec.

It needs two things a fresh checkout does not have: a build, and the browser. `npm install`
deliberately does not fetch Chromium - that would tax every contributor for a suite most
runs never touch - so run `npx playwright install chromium` once per machine. Without it the
run fails with `browserType.launch: Executable doesn't exist`.

Running a single test file has its own command, because the suite's state isolation rides on
a `--import` preload that `npm test` supplies and a hand-typed `node --test` does not. The
command and the contract behind it live in [AGENTS.md](../AGENTS.md#commands), which owns
contributor execution mechanics; they are deliberately not restated here.

`measure-inspector-prompt` prints the review prompt's byte size for the current source and
for a pre-fix revision beside it, so a change to what the Inspector carries can be shown in
bytes rather than asserted. It reads the older source out of git and never touches the
working tree, so it is safe to run on dirty state.
