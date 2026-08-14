# Running Mission Control at Upstart

Upstart distributes its internal Claude Code tooling as **UpstartClaw**, a private plugin
marketplace: ~60 plugins carrying Jira/Confluence/Glean/Slack skills, MCP server configs for
the internal services, and `PreToolUse` guard hooks. It equips a *session*; Mission Control
commands a *fleet*. The two meet in exactly one place - the operator's `~/.claude` - and they
already compose there, with no code on either side. See
[docs/plans/upstartclaw-integration/plan.md](plans/upstartclaw-integration/plan.md) for
the full comparison and the boundaries this section summarizes.

**Nothing here is required to run Mission Control**, and a machine without UpstartClaw
installed behaves exactly as the rest of this README describes.

### It already composes

A dispatched session inherits your plugins either way it launches. A **terminal** dispatch
runs the agent's real CLI in a worktree, so it loads `~/.claude` like any session you start
yourself. An **[Agent SDK](sessions.md#session-runtimes-terminal-or-the-agent-sdk)** dispatch loads
`settingSources: ["user", "project", "local"]`, so user-level plugin config reaches the
embedded driver too. That is the whole integration: your agents get the org's skills, its MCP
servers, and - the part that matters for an unattended fleet - its fail-closed guard hooks.

### Set it up once, interactively

Install the `upstartclaw-core` plugin and run **`/upstartclaw-core:setup` in an interactive
Claude Code session, once, before dispatching anything**. Its sign-in flows are interactive by
nature and cannot complete inside a dispatched session, and until they do the plugin's own
`PreToolUse` hook refuses its MCP calls - so an unattended agent stalls on its first Glean or
Jira call instead of finishing the task. The dispatch form warns when this machine looks
unprepared; see below.

That setup also installs the Palo Alto VPN CA certificate and exports `NODE_EXTRA_CA_CERTS`
at it - by appending a line to your **shell profile**, which is the detail that matters here.
`NODE_EXTRA_CA_CERTS` has to be present in **the daemon's own environment**, because an
embedded session's subprocess environment is the daemon's. A daemon launched from Finder, from
the tray app, or by a launchd service never reads that profile line, so its SDK sessions cannot
complete a TLS handshake through the inspecting proxy while terminal-runtime sessions on the
same machine work fine - a confusing pair of symptoms with one cause. Start the daemon from a
shell that has the variable, or set it somewhere your GUI session can see. It is deliberately
absent from the [Configuration](configuration.md#configuration) table: it is Claw's variable, not Mission
Control's, and the daemon only passes it through.

### The dispatch-time warning

When the plugin is installed and its setup state file (`~/.claude/upstartclaw-core-setup`) does
not read `completed`, the [dispatch form](dispatch-and-backlog.md#dispatch-an-agent) shows an amber note naming what
to run and briefly explaining why setup must finish before dispatch. Ordinary first-run and
in-progress states do not expose the setup file's implementation details. Malformed or
unreadable state files still include diagnostic detail because they require a different repair.

**The note never blocks a dispatch** - not the button, not `⌘Enter`, not "Add to backlog". It
is a machine-configuration fact you may knowingly accept, unlike an
[after-work Workflow](workflows.md#workflows-and-personas) the daemon would have to refuse. It is read from
disk on every open, so it disappears as soon as you finish the setup, with no restart.

A machine with no UpstartClaw installed sees no note and no chrome at all - **including one
that uninstalled it**. The state file is not removed with the plugin, and a leftover file is
not a finding: with the plugin gone there is no gate left to stall on, so there is nothing to
tell you.

### One owner per concern

Where the two overlap, run one of them and not both:

- **Alerts.** Claw's `notify` plugin fires an OS notification on Claude's `Notification` hook.
  Mission Control's [alert engine](attention-and-alerts.md#alerts--away-mode) already covers that event, plus stuck
  detection, Away mode, and delivery with the window closed. Running both double-fires on every
  needs-you. Disable `notify` when Mission Control's alerts are on.
- **Cost.** Claw's `cost-dashboard` is a retrospective, per-machine view over local
  transcripts; Mission Control's [cost telemetry](sessions.md#cost-telemetry) is live and fleet-wide. Keep
  the former only as a personal historical view, and note that the bundled Sniffly UI's Share
  button uploads conversation content to an external site.
- **Orchestration.** Do not run Claw's `agent-team` inside a Mission-Control-dispatched
  session. Two orchestrators means nested worktrees and conflicting PR rules; choose one per
  task and never nest them. Reading that plugin's role *documents* is a different thing and is
  supported - see [Personas from Claw's catalog](#personas-from-claws-catalog). Adopting a role
  as a reviewer runs none of Claw's orchestration: it takes the Markdown that describes the role
  and nothing else.
- **Skills.** Claw is the org's channel for *domain* skills; Mission Control's
  [skills catalog](skills-and-settings.md#skills-every-session-mixed-reload-behavior) is app-owned skills that make
  sessions cooperate with Mission Control. Claw's catalog is deliberately never copied into
  this repository.
- **Statusline.** Mission Control's statusline install is a *wrapper*: it records whatever
  command it found in a sidecar and delegates to it, so an installed Claw statusline is meant
  to keep rendering while Mission Control reads model/context/cost off the same line. That is
  what the installer does by construction; confirm it on your own machine after installing
  both, since only your machine has both halves.

### Personas from Claw's catalog

Claw's `agent-team` plugin ships eleven role documents - Manager, Product Manager, Implementer,
Tester, Reviewer, PR Orchestrator, Deployment Manager, Cleanup Specialist, Data Extractor, Memory
Keeper, Communications Gatekeeper - as Markdown under `references/roles/`. They describe review
remits in prose, which is exactly what a Mission Control
[Persona](workflows.md) is, so the daemon adopts them into the Persona library
automatically.

**It only happens if you installed that plugin.** Run `/plugin install agent-team@upstartclaw`.
Having the marketplace added is not enough and deliberately so: the marketplace checkout contains
every plugin in the catalogue, and treating its presence as an install would give personas to
people who never asked for them.

What to expect:

- The sync runs at daemon start, after the port answers, and never blocks a boot. What it
  imported - or skipped, and why - is on the daemon's log.
- Imported roles wear an **UpstartClaw** tag in the Persona library and sort after the built-ins
  and before your own Personas.
- They are ordinary Personas from then on: editable, duplicable, pickable as workflow reviewers.
  Your edits are never overwritten.
- **Archive one and it stays archived.** That is the way to decline a role you do not want; the
  next boot will not bring it back.
- When the plugin upgrades and a role document changes, the Persona shows the ordinary
  `upstream changed` badge and waits for you to adopt it. A boot never rewrites a reviewer's
  authority on its own.
- A role whose name you already use is skipped rather than renamed, and the log says which. Your
  Persona wins. These roles carry plain titles like `Reviewer`, so this is a normal outcome
  rather than an error.

Nothing from Claw's catalogue is copied into this repository - the documents are read from the
installed plugin on the operator's own machine, which is what lets the upstream badge mean
anything.

Claw's guard hooks (no-send/no-delete, read-only Databricks, publish gates) are worth keeping
exactly as they are for unattended work - they are the reason a fleet running against internal
systems fails closed. Mission Control's own boundaries are in [Security](security.md#security), and
[Task sources](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog) is where work waiting in an
internal tracker becomes backlog rows.
