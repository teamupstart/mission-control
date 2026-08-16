# Mission Control

Mission Control is a local control plane for teams running Claude Code, Codex, and Pi.
It brings the sessions, tasks, conversations, reviews, workflows, and delivery signals
that normally live across terminal panes into one live dashboard.

This repository is internal. It is not licensed for public distribution.

## See the fleet

The fleet view turns a working directory full of agent sessions into an operational board:
what is active, what needs a decision, and what is ready for the next step.

![Mission Control fleet board](docs/images/fleet-board.png)

## Dispatch with context

Start a task in the right repository, choose its harness and runtime, and leave it attached
to the backlog and workflow that will carry it through review.

<kbd>+</kbd> starts the guided pass by default. It asks for the repository, kind, harness and
what runs after the work, then hands over the same dispatch form with those answers set and
the caret in the task box. The choices print their one-key answers. <kbd>⇥</kbd> or the first
<kbd>Esc</kbd> leaves the pass at any point and keeps what it has; a second <kbd>Esc</kbd>
closes Dispatch. Closing and reopening keep the current question and every answer, while
**Clear**, **Dispatch now**, and **Add to backlog** reset the pass for the next task.
While the questions are active, dropping an image anywhere on the window attaches it to the
same task without advancing the pass.
**Guided** in the modal header and **Settings → Dispatch** control the preference, which ⌘K
also finds by name. See
[the guided pass](docs/dispatch-and-backlog.md#the-guided-pass).

A task can attach more than one repository. Dispatch it and you get **one** agent session
holding all of them in shared context: its working directory is the primary repo's worktree,
each attached repo gets a worktree of its own, and the agent is granted write access to every
one of them. The intent it receives names where each repo lives, which branch each one is on,
and asks for one pull request per repository it actually changes. Claude and Codex
support this; the dispatch modal offers the control only for a harness that does. Multi-repo
tasks are dispatch-only - they cannot be dropped onto an agent that is already running,
because the extra worktrees and the write access to them are granted when a session starts.

Each of those pull requests is tracked on its own. The card and the console list one line per
repository with that repository's pull request and its state, so a task spanning three repos
never collapses to a single link. **A multi-repo task completes only when every repository it
changed has had its pull request merged** - a repo whose branch never moved off the commit it
was cut at is exempt, and a pull request closed without merging never satisfies the rule, so
the task stays visible for you to deal with. Merging itself is unchanged: each pull request
still merges on its own verdict, whenever it alone is ready.

**Every repository it changed gets its own full review, too.** One review run per changed
repo, running at the same time, each reading that repo's worktree, pinning that repo's pull
request and spending its own repair budget - so a finding in one repo restarts that repo's
review alone and never holds up a sibling's merge. A repo the task never touched gets no run
at all. The card shows one workflow chip per review, each naming its repository.

Everything typed at the agent is per repository too. Each review's packets name the repository
they are about, and Foreman's review follow-through - the nudge that puts a parked session back
on unresolved comments or a red CI - tracks each pull request separately, so one repository's
feedback is never mistaken for another's or lost behind it. They share the pane, so they take
turns in it: one instruction at a time, never two in a turn expecting neither.

The daemon also carries the durable state and conservative restart reconciliation needed for
Mission Control's native worktree pools. No dispatch or workflow-check acquisition path selects
that allocator yet: current sessions and checks continue to use their existing treehouse or
plain Git behavior until the later consumer cutover.

![Mission Control dispatch](docs/images/dispatch.png)

## Build the operating system around the work

The Library keeps reusable workflows, personas, session actions, ensemble strategies, mission
sources, and the commands behind each standard gate together rather than burying them in
individual terminals.

**Library → Personas → Foreman** is the fixed System profile for Foreman's exact standing
guidance. Its name, policy, safeguards, models, and authority remain owned by Mission Control
and their existing Settings controls. Only the Markdown guidance is editable here, and the
System profile is never offered to workflows or ensembles as a Persona.

![Mission Control Library](docs/images/library.png)

## Design reusable review workflows

Workflows and Personas turn the team's review practice into reusable, inspectable building
blocks. The Line keeps their live runs attached to the fleet.

![Mission Control workflow library](docs/images/workflows.png)

## Coordinate the fleet

Foreman provides configurable operational guidance for the fleet. GitHub Inspector keeps shipping
and remote review state visible beside the work that produced it.

![Mission Control Foreman settings](docs/images/foreman.png)

![Mission Control GitHub Inspector settings](docs/images/inspector.png)

## Watch a pipeline engine you already use

Some work is driven by an external SDLC engine rather than by a single agent.
[ai-conductor](docs/pipelines.md) is one: it walks a feature through a gated 22-step pipeline
in its own worktree and halts for a human when a gate refuses. **Settings → Conductor**
detects it and lets you consent, per repository, to Mission Control reading its state.

Detection is automatic and consent is not. Nothing is read until a repository is switched on,
and Mission Control never writes a file the engine owns. With no engine installed and nothing
configured, the dashboard is exactly what it was - no row, no panel, nothing in the command
palette. [Pipelines](docs/pipelines.md) owns the exact visibility rule.

Once a repository is switched on, the **Runs** page gains a second tab. **Workflows** is the
page it always was; **Pipelines** shows what the engine is driving - a rail grouped per
repository under its engine daemon's state, and each feature's whole gated sequence drawn in
the same diagram grammar a workflow run uses.

The engine's own agents show up on the fleet too, and are marked as its rather than yours: a
session working inside an observed feature's worktree wears the run's badge, groups under it,
and has a sentence where its composer was, because it is a `--print` process that reads nothing
typed at it. Its Workflows tab draws the feature's ladder. And when the engine **halts** a
feature for a human, that halt is a row in the [attention inbox](docs/attention-and-alerts.md)
with its class, what stopped it, and the runbook that clears it - the one thing waiting on you
that has no session behind it.

You can act on a pipeline from there, not only read it: start, stop, pause and resume the
engine's daemon, park and unpark a feature, authorize one DECIDE re-entry with your own
rationale, watch the daemon's console, and run the re-seal ceremony in a hosted terminal.

The same integration starts at Dispatch. An enabled repository offers the **pipeline** task
kind, which opens `conduct-ts engineer --idea` in a real terminal and lets conductor own the
worktree, agent, model, and effort. When that run opens a pull request, GitHub Inspector adopts
it under pipeline provenance and it joins **Shipped**. **Settings → Conductor → Foreman
triage** can also let Foreman unpark mechanical halts through the same action route the
dashboard uses. That switch ships off, and every needs-human or unknown halt stays with the
operator.
Every verb spawns the engine's own CLI and is judged by what it printed, never by an exit code
- and what a shipped feature cost lands in the [spend strip](docs/cost-and-usage.md) as
automation, under the engine's own figures.

## Quick start

Mission Control needs Node.js 24 or newer.

```sh
git clone <internal-repository-url>
cd ai-harness
make init
npm run dev
```

Open `http://127.0.0.1:5173`. For the desktop shell, demo mode, hooks, state locations, and
the full verification path, use the setup guide below.

## Go deeper

- [Documentation index](docs/README.md) - product behavior, configuration, and feature guides.
- [Architecture overview](docs/architecture.md) - how the daemon, dashboard, integrations, and local state fit together.
- [Contributing](CONTRIBUTING.md) - clone-to-green setup, test layers, and contribution expectations.
- [Security policy](SECURITY.md) - security posture and internal vulnerability reporting.

## Regenerate screenshots

The screenshots above come from the built dashboard in deterministic, token-free demo mode.
After a dashboard change, rebuild and run:

```sh
npm run build
npm run docs:screenshots
```
