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

![Mission Control dispatch](docs/images/dispatch.png)

## Build the operating system around the work

The Library keeps reusable workflows, personas, session actions, ensemble strategies, and
mission sources together rather than burying them in individual terminals.

![Mission Control Library](docs/images/library.png)

## Design reusable review workflows

Workflows and Personas turn the team's review practice into reusable, inspectable building
blocks. The Line keeps their live runs attached to the fleet.

![Mission Control workflow library](docs/images/workflows.png)

## Coordinate the fleet

Foreman provides configurable operational guidance for the fleet. Inspector keeps shipping
and review state visible beside the work that produced it.

![Mission Control Foreman settings](docs/images/foreman.png)

![Mission Control Inspector settings](docs/images/inspector.png)

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
