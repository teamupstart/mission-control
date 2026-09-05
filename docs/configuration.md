# Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `MISSION_PORT` | `7317` | daemon / dashboard port |
| `MISSION_HOME` | `~/.mission-control` | state dir (db, token, logs, logical settings snapshots, native worktree pools, and disposable Git worktrees) |
| `MISSION_WORKSPACE_DIRS` | unset | colon-separated launch-time override for **Settings → Repositories**. While set, it is the effective repository-index list and the saved list stays read-only. Without it, the removable saved defaults are `~/workspace`, `~/code`, `~/dev`, and `~/upstart` |
| `MISSION_POLL_MS` | `1500` | discovery interval |
| `MISSION_AGENTS_SHADOW_MS` | `0` (off) | how often to take a [shadow reading](sessions.md#shadow-reading-claudes-own-session-state) of `claude agents --json` and log where it disagrees with our own discovery. Diagnostic only - it never feeds the registry. `0` or any non-positive value disables it; anything under `5000` is clamped up, since one reading spawns the full `claude` binary |
| `MISSION_WORKTREE_SWEEP_MS` | `300000` | how often the daemon reconciles native worktree slots and reclaims eligible task and check leases. `0` (or any non-positive value) turns recurring reconciliation off; startup reconciliation still runs. An unparseable value falls back to the default, values under `30000` are clamped up, and values over `604800000` (7d) are clamped down. It does **not** govern [task worktree retention](worktrees-and-checks.md#task-worktree-retention): the 30-day rule runs on its own fixed internal cadence, so setting this to `0` quietens native pool maintenance and leaves retention exactly as it was |
| `MISSION_DISPATCH_READY_MS` | `30000` | dispatch: how long to wait for the agent's pane to be discovered before failing |
| `MISSION_DISPATCH_SETTLE_MS` | `2000` | terminal-runtime dispatch: how long a discovered pane with no usable hook readiness signal must remain live before dispatch continues. This starts immediately for Pi, whose positional launch message needs no pane injection, and after a hook wait times out for a still-live session. An observed exit fails instead. Agent SDK dispatch does not use a settle delay |
| `MISSION_DISPATCH_HOOK_READY_MS` | `20000` | terminal-runtime dispatch: how long to wait for the exact discovered session's first hook when that launch can produce one. Hook silence falls back to the settle above if the session is still live; an observed exit ends the wait immediately. The wait is skipped for hookless harnesses such as Pi and when a particular Codex launch could not install its [hook bridge](sessions.md#precise-status-for-codex-hooks-that-ride-on-the-dispatch) |
| `MISSION_TASK_TITLE_MODEL` | `claude-haiku-4-5` | [dispatch](dispatch-and-backlog.md#dispatch-an-agent): the model that names a task whose Title was left blank. **Settings → Models → Task title** wins where it is set, then this, then the shipped default |
| `MISSION_WORKFLOW_CONTEXT_MODEL` | provider's cheap model | [Workflows](workflows.md#workflows-and-personas): compacts one Preview submission's preserved raw evidence, with one fresh 45-second attempt after an unparsable reply and deterministic fallback on failure. **Settings → Models → Workflow context** wins where it is set, then this, then the selected provider's cheap default |
| `MISSION_WORKFLOW_PERSONA_MODEL` | provider's balanced model | [Personas](workflows.md#workflows-and-personas): runs a fresh, tool-less Persona review. A Persona's own model override wins, then this variable, then the selected provider's balanced default |
| `MISSION_WORKFLOW_PERSONA_TIMEOUT_MS` | `600000` | [Personas](workflows.md#workflows-and-personas): hard cap on one Persona call. Sized with `MISSION_INSPECTOR_TIMEOUT_MS` rather than with the 120s default below, because a Persona reads the same shape of evidence - a diff and a transcript window - and the cost of the budget being too small is paid three times: a timeout is an infrastructure failure, and the engine retries one twice more before failing the submission |
| `MISSION_ENSEMBLE_COMPARISON_MODEL` | provider's cheap model | [Ensembles](ensembles.md#multi-agent-ensembles): the model behind every ensemble evaluation - the Best-of-N comparison, the Consensus divergence pass, and each Panel-vote judge's ballot. An explicit evaluator or judge model wins, then a judging Persona's model override; otherwise **Settings → Models → Ensemble evaluation**, then this variable, then the provider's cheap default |
| `MISSION_TASK_TITLE_TIMEOUT_MS` | `15000` | dispatch: hard cap on one titling attempt - a timeout isn't retried, so a missing or slow `claude` costs this once and the first-line title stands. Sized above Haiku's measured 7-8s; a successful call returns as soon as the model does, so lowering it only buys a faster failure |
| `MISSION_LLM_RUNNER` | `claude` | [Models](models.md): which provider does the app's own offline work when nothing nearer has chosen - the background jobs, each of Foreman's four roles, and the GitHub Inspector's review. **Settings → Models → Provider** loses to this where it is set, and the panel says so. A job, a Foreman role, or the Inspector that names its own provider outranks it; Foreman's roles have one further rung between them, its **All roles** value. An id this build does not have falls back to the default rather than failing, and the panel names what it dropped |
| `MISSION_CLAUDE_TRANSPORT` | `sdk` | Claude's headless wire protocol: `sdk` uses one fresh Agent SDK `query()` with deterministic setting sources and AbortController cancellation; `print` uses `claude -p`. Tool-less calls keep every tool disabled; GitHub Inspector reviews and replies keep their existing `Read,Grep,Glob` grant and provider-enforced deny rules. The stored `llm.claudeTransport` choice wins where set, then this environment fallback, then `sdk`. The daemon resolves that ladder and shares the result with the separate Foreman worker over `/api/llm/status`, so Foreman's review, queue verify, backlog planner, and Tier 1 triage calls follow the same choice without opening the database. Pin `print` to diagnose an SDK compatibility problem or temporarily roll back the transport while preserving every caller above it |
| `MISSION_SKILLS_DIR` | app's `skills/` | [skills](skills-and-settings.md#skills-every-session-mixed-reload-behavior) catalog dir (the symlinks' target) |
| `MISSION_FOREMAN_INSTRUCTIONS` | app's `personas/FOREMAN.md` | the seed for [Foreman's standing instructions](foreman.md#its-standing-instructions-foremanmd). Only the DEFAULT - once saved through the API the stored value wins, and this is what a reset restores |
| `MISSION_MCP_SERVER` | app's `dist/mcp/server.mjs` | path to the bundled MCP server that dispatched sessions are pointed at through [the ask channel](sessions.md#the-ask-channel)'s `--mcp-config`. What a bad path costs depends on what the launch asked for. An ordinary dispatch degrades quietly: the channel is skipped entirely and the session keeps Claude's built-in menu. A launch that **requires** Mission MCP tools - every scout, every ensemble member - is refused before the agent spawns instead, because a session that cannot submit its result cannot finish its normal task contract. A human may later confirm closing a scout without its report, but dispatch does not start work expecting that exception. Both launch failures are refusals: a path that does not exist, and a bundle that exists but does not publish a required tool. The daemon also reports the second at startup - see [Adding or changing a tool means rebuilding the bundle](sessions.md#review-channel-mcp) |
| `MISSION_GH_BIN` | `gh` | the GitHub CLI used by every GitHub subprocess, including [public product issue reporting](sessions.md#review-channel-mcp), task sources, pull-request polling, and GitHub Inspector. Mission Control passes fixed arguments directly and stores no GitHub credential; authentication remains in the CLI selected here. Product-report screenshots require version 2.99.0 or newer; text-only product reports remain available on older versions |
| `MISSION_PRODUCT_ISSUES_REPO` | `mancej-cyc/mission-control-issues` | the one public GitHub repository [product reports](ui.md#report-product-feedback) may target, from the dashboard's Feedback form and from the agent tool alike. The value must be an exact `owner/name` and exists for downstream forks and isolated tests. A report request cannot override the repository, labels, source, assignee, project, or milestone. The target must already carry all eight labels - `bug`, `feature-request`, `documentation`, `usability`, `other`, `status:needs-triage`, `source:dashboard`, `source:agent` - or preflight refuses and names the missing ones |
| `MISSION_PRODUCT_ISSUE_CONSENT_CMD` | unset | test seam only. Names a program the daemon runs, with the target repository and report title as arguments, INSTEAD of asking the desktop shell to raise the publish dialog; exit 0 consents. The end-to-end suite uses it because a daemon it forks has no shell and therefore cannot publish at all. Setting this is not a privilege escalation for anyone: it lives on the daemon's own environment, and a process that can choose that has already replaced the daemon - the same reasoning as `MISSION_GH_BIN`. Leave it unset everywhere else |
| `MISSION_TASK_SOURCE_TICK_MS` | `30000` | [Task sources](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog): how often the sweeper wakes to ask which sources are due. Not the sweep interval - that is per source, and clamped to 1 minute - 24 hours. Floored at `5000` |
| `MISSION_TASK_SOURCE_TIMEOUT_MS` | `60000` | Task sources: hard cap on one sweep, so a hung source cannot wedge its own schedule. Floored at `5000` |
| `MISSION_CONDUCTOR_BIN` | `conduct-ts` | [Pipelines](pipelines.md): the external SDLC engine binary the detection probe resolves. Follows the usual `MISSION_` / `FLEET_` / `HARNESS_` chain, so pointing it at a wrapper - or at a fake, as the browser suite does - is honoured everywhere the engine is reached |
| `MISSION_PIPELINE_TICK_MS` | `5000` | [Pipelines](pipelines.md): how often the watcher re-reads the state files of every repository an operator consented to. Floored at `1000`. Inert while nothing is enabled - a tick then reads one config value and returns |
| `MISSION_PIPELINE_PROBE_TTL_MS` | `30000` | Pipelines: how long a cached engine probe answers the Settings route before it is re-run. Cached because a probe spawns a subprocess and the panel polls; the panel's **Check again** bypasses it. Floored at `1000` |
| `AI_CONDUCTOR_REGISTRY` | `~/.ai-conductor/registry.json` | [Pipelines](pipelines.md): where the engine's project registry is read from when its CLI cannot answer. Read **bare**, without the `MISSION_` prefix, because it is the variable ai-conductor itself reads - a machine already configured for it needs nothing new. Names the FILE, not its directory, and a whitespace-only value counts as unset |
| `JIRA_API_TOKEN` | unset | [Jira task sources](dispatch-and-backlog.md#jira): the API token the local REST fallback authenticates with when the selected method is **Jira CLI or API token** and the `jira` CLI is not on the daemon's `PATH` (or cannot answer). Read **bare**, without the `MISSION_` prefix, because it is the same variable `jira-cli` and Atlassian's own shell helpers already use - so a machine set up for either needs nothing new. Never stored in Mission Control's database; read from the daemon's environment when it sweeps, so a variable exported after the daemon started needs a restart to reach it |
| `JIRA_EMAIL` | unset | Jira task sources: the account the token belongs to. Jira basic auth is the **pair** - one without the other is reported by name in the source's preflight rather than failing as a bad password |
| `JIRA_ALLOWED_HOSTS` | unset (Jira Cloud only) | [Jira task sources](dispatch-and-backlog.md#jira): extra hosts the REST rung may send `JIRA_API_TOKEN` to, comma-separated; `*.example.internal` allows a whole domain. Without it the credential goes only to `*.atlassian.net`, so a lookalike host - or a config written by something other than you, since the config route is localhost-reachable and dispatched agents share the machine - cannot aim the token elsewhere. Read bare, like the credential itself: widening the target and holding the token are then the same act of trust. Does not affect the `jira` CLI, which uses its own credentials |
| `MISSION_SCOUT_RECONCILE_MS` | `60000` | [Archives](archives.md): how often the daemon rescans `$MISSION_HOME/archives`, and the legacy `$MISSION_HOME/scouts`, for new, changed, or removed bundles. The scan is the AUTHORITY - a filesystem watcher runs beside it as a latency hint, and watchers drop events on exactly the synchronised directories foreign bundles arrive through. Each pass is jittered by up to 20% so several daemons, or a daemon and a sync tool, do not settle into lockstep. An unchanged bundle costs one `stat`, so the steady-state cost is proportional to the number of archives rather than their size. `0` (or any non-positive value) turns recurring reconciliation off, leaving only the bootstrap pass and the watcher; an unparseable value falls back to the default |
| `MISSION_SKILLS_SETTLE_MS` | `10000` | skills: how long a session must sit idle before the daemon types `/reload-skills` into it |
| `MISSION_RETRO_SCAN_MS` | `10000` | [Repository memory](repository-memory.md#when-the-dashboard-offers-one): how often to look for a human turn beyond a live session's opening brief, which is half of whether the dashboard offers that session a retro. Far cheaper than the interval suggests: a session that has already flipped is never read again, and one whose transcript has not grown costs a single `stat`. `0` switches transcript scanning off entirely - the other half of the condition, resolved GitHub Inspector findings, comes out of a ledger query that runs anyway and keeps working |
| `CLAUDE_SKILLS_DIR` | `~/.claude/skills` | skills: where Claude's symlinks are written; set, it wins outright. Overridable so tests never touch your real one - though setting `MISSION_HOME` is the better isolation, because it covers every harness at once and so covers the ones added later. Left unset, a daemon on an explicit `MISSION_HOME` writes to `<MISSION_HOME>/claude-skills` instead - it doesn't own the machine's shared dir, and reconciling that dir against an isolated daemon's own (empty) skills config would unlink the real install's links. Under the `node --test` runner a reconcile pass over any of the three real directories below is **refused outright**, whatever the config says: pinning one variable and forgetting the others is how `npm run test` came to silently uninstall the machine's live Codex and Pi skills on every run |
| `CODEX_SKILLS_DIR` | `~/.agents/skills` | the same override for Codex's skills directory; on an explicit `MISSION_HOME` it falls back to `<MISSION_HOME>/codex-skills`, for the same reason. Point both at one path and the reconciler still walks it once |
| `PI_SKILLS_DIR` | `~/.pi/agent/skills` | the same override for Pi's skills directory; on an explicit `MISSION_HOME` it falls back to `<MISSION_HOME>/pi-skills`. Pi loads SKILL.md skills from the same standard as Claude and Codex, so the reconciler links the catalog into this dir too. Identity-bound Pi sessions dispatched by Mission Control receive `/reload` when idle; operator-started Pi sessions need a launch or restart |
| `MISSION_CLAUDE_BIN` | `claude` | Claude CLI path override - for dispatched agents and every headless Claude call, whether its wire transport is `claude -p` or Agent SDK `query()` (Foreman's review and Tier 1 router, the [Goal](sessions.md#goal) refiner, the untitled-[dispatch](dispatch-and-backlog.md#dispatch-an-agent) titler, the [GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review)'s review and reply) |
| `MISSION_CLAUDE_TIMEOUT_MS` | `120000` | default hard cap on a single headless Claude call through either transport; callers that set their own budget (the Tier 1 router, the Goal refiner, the dispatch titler, the GitHub Inspector - see `MISSION_INSPECTOR_TIMEOUT_MS`) pass it instead |
| `MISSION_INSPECTOR_POLL_MS` | `90000` | [GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review): how often to look at the adopted PRs. Slow by design - a review is expensive and a push isn't frequent. Also the base of the retry backoff: a PR that keeps failing is retried at twice the previous delay, up to six hours. A new push cuts that wait short for the first few failures, after which it waits like any other attempt - unless the failure is one only a push can fix (a diff too large to buffer), where the next push always cuts it short. The tick does nothing at all while the GitHub Inspector is off |
| `MISSION_INSPECTOR_MODEL` | `claude-sonnet-5` | GitHub Inspector: the model both the review and the follow-up replies run on. **Settings → Models** wins where it is set, then this, then the shipped default. Named rather than left to the `claude` CLI: an unset `--model` inherits whatever that CLI defaults to, which is the priciest tier available and is not recorded anywhere |
| `MISSION_INSPECTOR_TIMEOUT_MS` | `600000` | GitHub Inspector: hard cap on one review. Far larger than the Foreman reviewer's 120s because this one has tool round-trips inside it: a 10KB five-file diff measured 225s on Opus and 272s on Sonnet, so a wire near either is a guaranteed failure rather than a safety net - the run is killed, the head never advances, and the PR climbs the retry backoff having produced nothing |
| `MISSION_INSPECTOR_REPLY_TIMEOUT_MS` | `300000` | GitHub Inspector: hard cap on one follow-up reply - a smaller job than a review, but the same shape (the diff in the prompt, the same read-only tools), so it moves with the review's ceiling rather than sitting at a fraction of it |
| `INSPECTOR_MAX_DIFF_BYTES` | `400000` | GitHub Inspector: cap on the diff put in a prompt, in UTF-8 **bytes** - so a diff of CJK, emoji or box-drawing content counts the 3-4 bytes each of those costs, and the cut lands on a character boundary rather than halfway through one. Read bare, unlike every other row here; `MISSION_INSPECTOR_MAX_DIFF_BYTES` (and the `FLEET_` / `HARNESS_` forms) still work and win where both are set. A refactor past this isn't reviewable in one pass anyway; the prompt says it was truncated so the model never concludes anything from the absence. Separately, a diff too large to hold in memory at all (16MB) is declined rather than reviewed - the PR is parked, and a later push that shrinks it below the ceiling gets reviewed |
| `MISSION_CODEX_BIN` | `codex` | Codex CLI path override - both for dispatched agents and for every headless `codex exec` the app runs when Codex is the selected [provider](models.md) |
| `MISSION_CODEX_TRANSPORT` | `exec` | Codex's headless wire protocol, the mirror of `MISSION_CLAUDE_TRANSPORT`: `exec` spawns `codex exec` and decodes its `--json` stream by hand; `sdk` drives the same binary through `@openai/codex-sdk` and reads typed thread events instead. The stored `llm.codexTransport` choice wins where set, then this environment fallback, then `exec`. **This is a parsing choice, not a faster path.** The SDK spawns the same executable, so both transports pay the identical model round trip - measured on `gpt-5.6-luna`, a title call is 4.5-7.7s wall of which only ~0.3-0.6s is the process. Pinning `sdk` buys typed events and a supported cancellation path; it does not buy latency, and it must not be chosen to fix a slow dispatch. The SDK is always pinned to the same binary `MISSION_CODEX_BIN` names, because installing it drops a second, differently versioned `codex` into `node_modules` and an unpinned SDK would silently run that one instead. Tool grants and image attachments are refused on `sdk` rather than dropped |
| `MISSION_CODEX_TIMEOUT_MS` | `120000` | hard cap on a single headless `codex exec`, the mirror of `MISSION_CLAUDE_TIMEOUT_MS`. A caller that sets its own budget (the GitHub Inspector, the Goal refiner, the dispatch titler) passes it instead |
| `MISSION_PI_BIN` | `pi` | Pi (`@earendil-works/pi-coding-agent`) CLI path override for dispatched agents. Pi is a discovered/dispatched harness, not one of the app's own headless model providers |
| `MISSION_CODEX_HOOK` | app's `dist/satellites/codex-hook.mjs` | path to the bundled [Codex hook bridge](sessions.md#precise-status-for-codex-hooks-that-ride-on-the-dispatch) the dispatcher points a Codex launch at. If the path doesn't exist the hook overrides are dropped entirely and the session runs uninstrumented rather than failing to launch |
| `WEZTERM_BIN` | auto | wezterm CLI path override |
| `GHOSTTY_BIN` | `/Applications/Ghostty.app/Contents/MacOS/ghostty` | [Ghostty](sessions.md#which-terminal-you-use-is-declared-not-assumed) path override, for a non-standard install location. It answers *is Ghostty installed* and is never executed - the app drives the GUI through AppleScript, not this binary. There is deliberately no bare `ghostty` on `PATH` fallback: on Linux that binary is normally present and this integration cannot work there at all, so it would report "installed" on the one platform where every call must fail |
| `ITERM_BIN` | `/Applications/iTerm.app/Contents/MacOS/iTerm2` | [iTerm2](sessions.md#iterm2-automation-and-permission-recovery) app-bundle binary override for a non-standard installation. Availability reads only this path. Mission Control never runs it for discovery or actions; it controls an already-running iTerm2 through AppleScript, and passive checks do not launch the app |
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
daemon's database (`app_config`), alongside the Foreman, Skills, Harnesses, Task sources, Models, Conductor, and
Cost settings - so they are the same in every tab, on `localhost` and `127.0.0.1` alike, in the
desktop app and in a browser, and they survive an upgrade. The browser keeps a copy in
`localStorage`, but only as a cache so the dashboard paints your layout in the first
frame; deleting it costs one request, not a preference.

### Repository standing instructions

One box per repository, in your own words, that every session Mission Control opens into
that checkout is told before it starts work - *"never run the E2E suite locally, it only
runs in CI"*, *"always prove a bug with a failing test first"*.

Machine-local and per-repository, which is the gap nothing else fills: a repository's
committed `AGENTS.md` reaches every teammate on every machine, and Foreman's standing
guidance is machine-local but global and never reaches a session at all.

| | |
|---|---|
| Stored under | the `instructions.standing` key in `app_config` |
| Shape | one machine-wide `default`, plus a map of repository path to text |
| Per-box limit | 8,000 characters |
| Repository limit | 200 configured repositories |
| Reaches | only sessions Mission Control launches - dispatch, and a task assigned into one of them. Never a session it merely discovered |

A repository is matched by its **longest** configured path, so a rule on
`~/ws/mono/packages/api` beats one on `~/ws/mono`, and matching is on the path boundary -
`/repo-backup` never inherits `/repo`'s rule. A repository configured with an **empty** box
means "send nothing here" and beats the machine-wide default; a repository you have not
configured at all inherits it.

A dispatch that attaches several repositories sends **all** of their rules, since it hands the
agent write access to all of them. Checkouts that resolve to the same words - the machine-wide
default is the ordinary case - share one block rather than repeating it once per checkout; where
they differ, each block is labelled with the checkouts it governs.

How the text reaches the agent depends on the harness and the runtime, and it is delivered
exactly once either way:

| Harness · runtime | Carried as |
|---|---|
| `claude` · terminal | one `--append-system-prompt`, composed with the ask-channel redirect |
| `claude` · Agent SDK | `systemPrompt.append` on the Claude Code preset |
| `codex` · Agent SDK | `developerInstructions`, merged with whatever you configured in Codex. That channel replaces your configured value, so when Codex cannot report it the merge is skipped rather than overwriting it - and the instructions are sent as prose instead, so they are never dropped. On a fresh launch that is turn one, with the block in the same slot the rows below put it; on a resume after a daemon restart it is the block by itself, because that conversation's request is already in the transcript being reopened |
| `codex` · terminal | turn one, above the request |
| `pi` · terminal | turn one, above the request |

**A session keeps the standing instructions it launched with.** An edit takes effect on the
next session, not a running one - a live agent's system prompt cannot be rewritten, so the
alternative would be edits reaching two of those five pairs and not the other three. What
each session actually received is recorded at launch and read back unchanged - the only
thing that can move afterwards is which channel carried it, when a restart forces the Codex
fallback above, because a later assignment repeats a rule that rode prose and never repeats
one still installed on the process.

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

On every daemon start, Mission Control also reconciles this owned telemetry block from the
persisted Cost intent. The edit is idempotent and best-effort. This repairs a file that drifted or
was copied with the state database, while an unreadable settings file is left untouched and logged
for the operator to fix.

> **Upgrading from Fleet Control (`FLEET_*`) or ai-harness (`HARNESS_*`)?** Nothing to do.
> Both older env prefixes are still honored as fallbacks - `MISSION_*` wins where more than
> one is set - so a hook or MCP server installed under an older name keeps reporting without
> being reinstalled. On its first start the daemon renames an existing `~/.fleet-control`
> (or `~/.ai-harness`) state dir to `~/.mission-control`, keeping your db, token, and
> uploads; if that move can't happen the old dir keeps working exactly as before. Persisted
> legacy Treehouse resources keep their recorded provider and fail closed when exact lease
> identity is unavailable. Prefer the `MISSION_*` names going forward.
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

## Automatic settings snapshots

After the daemon successfully starts serving, it ensures one logical snapshot for the current
local calendar date. It rechecks through the day and writes no second generation for that date.
A date when the daemon never runs has no fabricated backup; the next launch captures the current
date and current settings.

Snapshots live at `$MISSION_HOME/backups/settings/`, which is
`~/.mission-control/backups/settings/` by default. An isolated `MISSION_HOME` therefore gets an
isolated snapshot library and never reads or writes the default one. The directory is mode `0700`
and each JSON file is mode `0600`. The files contain private machine configuration, including
absolute repository paths and imported Persona provenance, so treat copies with the same care as
the rest of `MISSION_HOME`.

Format v1 includes normalized values for every registered setting, including schema defaults,
plus every active or archived operator-owned Persona, session action, Workflow definition, its
immutable published versions, and all four Command slots. Built-in catalog items are supplied by
the application and are not copied. Snapshots also exclude tasks, queues, schedules, sessions,
workflow bindings and runs, reviews, telemetry and spend history, operational away or lease state,
derived reload generations, credentials, tokens, and environment secrets.

The daemon publishes a sibling temporary file atomically, verifies its schema and SHA-256 digest,
then applies retention. It keeps the newest 90 `daily` files and, independently, the newest 10
`pre_restore` safety files.

Open **Settings → Restore** to see the owner-only history. The browser receives bounded metadata,
compatibility, catalog counts, and a redacted preview. It never receives a resolved filesystem
path, a snapshot envelope, or raw setting and catalog values. Corrupt, unreadable, and newer-format
files stay visible with an explanation but cannot be selected.

A restore requires selecting a verified snapshot, previewing it, and typing
`RESTORE SETTINGS` in the final dialog. Immediately before the transactional commit, Mission
Control captures a `pre_restore` safety snapshot of the current settings. The restore then replaces
registered configuration and reconciles the reusable Library catalogs. Immutable Workflow versions
already present are retained. Operational state remains untouched, including tasks, queues,
schedules, sessions, bindings and runs, reviews, repository and worktree state, archives, telemetry
history, credentials, tokens, and environment secrets.

The window that confirmed the restore hydrates its browser cache from the daemon and reloads, so
daemon-backed settings and first-paint preferences restart from one source. Other open windows do
not reload automatically. They keep unsaved drafts and show a persistent **Reload now** notice so
the operator chooses when to adopt the restored state.

## Commands

```sh
make init              # one-time bootstrap (deps, build, hooks)
make session           # ask the running daemon for a durable manual worktree lease
make session ARGS="--return <lease-id>" # return a clean manual lease by durable ID
npm run dev            # daemon + web (dev)
npm start              # daemon serving built UI
npm run foreman        # Source-development Foreman worker; the packaged app starts its own
npm run build          # build web, daemon, Foreman, Electron, MCP, and satellite bundles
npm test               # full test suite, including real Electron GUI geometry checks
npm run test:workflow-evidence # focused evidence transport and Test Evidence audit checks
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
npx tsx scripts/measure-inspector-prompt.ts # size the GitHub Inspector review prompt on this checkout
```

On macOS, `npm test` and `npm run test:electron` validate Electron's framework link before
starting their suites. If a copied dependency tree contains the complete framework payload
but is missing either canonical framework link, the pretest restores that link. If the payload
itself is absent, the command-line pretest re-runs Electron's installer before asserting the
links; the runtime integrity probe that follows still verifies the installed binary before any
test starts. Direct callers of the framework inspection function remain fail-closed and name
Electron's installer as the repair instead of manufacturing a payload.

The same lease and pool policy are visible under **Settings > Worktrees**. The panel can set
default and per-repository native enablement, maximum capacity, and an operator-authored setup
argv for newly created slots. Capacity reductions are future-only until a separately previewed
safe Prune or right-size operation runs. See [Worktree settings and operations](worktrees-and-checks.md#settings--worktrees).

The `make` wrappers for the build and verification commands - `make build`, `make test`,
`make lint`, `make check`, `make smoke` - install dependencies first, through a stamp file
(`node_modules/.install-stamp`) that carries `package.json` and `package-lock.json` as its
prerequisites. So they install in a tree that has never been installed, re-install after a
pull or a branch switch moves either manifest, and do nothing at all the rest of the time.

After that link check, the pretest probes the installed Electron binary in Node mode. This
loads the platform framework rather than trusting only the installer marker files. If the
generated runtime is truncated or otherwise cannot load, the pretest replaces that package's
`dist` directory from Electron's checksum-verified download cache and probes it again. An
operator-supplied `ELECTRON_OVERRIDE_DIST_PATH` is never modified; a broken override fails with
a diagnostic instead.

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
for a pre-fix revision beside it, so a change to what the GitHub Inspector carries can be shown in
bytes rather than asserted. It reads the older source out of git and never touches the
working tree, so it is safe to run on dirty state.
