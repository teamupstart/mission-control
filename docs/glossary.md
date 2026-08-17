# Glossary

Mission Control uses a few product names consistently. Each term below links to the
feature page that defines its behavior in detail.

## [Agent](sessions.md#how-it-works)

An agent is a supported coding CLI, currently Claude, Codex, or Pi, which Mission Control
can discover or dispatch as a session.

## [Away mode](attention-and-alerts.md#away-mode)

Away mode is durable daemon state for time away from the dashboard: blockers still use
enabled alert channels, while other events are collected into a return digest.

## [Backlog](dispatch-and-backlog.md#dispatch-an-agent)

The backlog is the durable list of shelved and active tasks. It is where work waits to be
dispatched, held, edited, or scheduled.

## [Daemon](sessions.md#how-it-works)

The daemon is the long-lived local service that serves the dashboard, API, and event
stream while maintaining the session registry and durable product state.

## [Demo mode](demo-mode.md)

Demo mode runs an isolated Mission Control environment with scripted agents so the
dashboard can be explored without ordinary agent-session token spend.

## [Dispatch](dispatch-and-backlog.md#dispatch-an-agent)

Dispatch launches work from a task into an isolated worktree and starts the selected
harness through its declared terminal or Agent SDK runtime.

## [Ensemble](ensembles.md)

An ensemble is a coordinated group of ordinary dispatched tasks working under one
versioned strategy, with shared evaluation and a human decision boundary.

## [Foreman](foreman.md)

Foreman is the opt-in auto-responder that reviews invited sessions and can draft or,
when configured, deliver follow-up work through the daemon.

## [Harness](sessions.md#which-terminal-you-use-is-declared-not-assumed)

A harness is Mission Control's declared adapter for an agent, including its capabilities,
status evidence, runtime options, and terminal integration.

## [GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review)

GitHub Inspector is the opt-in automated reviewer for pull requests Mission Control adopted from
observed `gh pr create` activity. It only comments in repositories you explicitly trust.

## [The Library](library-and-line.md)

The Library is the place to browse and edit reusable product definitions such as
workflows, personas, and session actions.

## [The Line](ui.md#the-line-the-pipeline-strip-above-the-fleet)

The Line is the pipeline strip above the fleet that summarizes work moving from intake
through review and shipping, with drawers for its stages.

## [Mission / recurring mission](recurring-missions.md)

A mission is scheduled work. A recurring mission stores a schedule and policy that create
tasks over time, including catch-up behavior after the machine was away.

## [Persona](workflows.md#workflows-and-personas)

A persona is a reusable review role with authored guidance. Workflow stages use personas
to judge one immutable submission and return a verdict.

## [Session](sessions.md#session-runtimes-terminal-or-the-agent-sdk)

A session is one running agent conversation shown on the fleet. It can be a terminal
session that Mission Control discovers or a daemon-owned Agent SDK session without a terminal pane.

## [Session action](workflows.md#session-actions)

A session action is a reusable instruction a workflow sends to its bound conversation;
unlike a persona, it may change the repository and has a completion condition the daemon proves.

## [Ship log](library-and-line.md#the-ship-log)

The Ship log is the durable record of shipping outcomes, surfaced from the Library's
shipping view rather than only from a transient notification.

## [Shipping / YOLO mode](inspector-and-shipping.md#shipping-yolo-mode)

Shipping, also called YOLO mode, is the separately armed automation that can merge an
eligible adopted pull request after the GitHub Inspector's required gates are satisfied.

## [Task](dispatch-and-backlog.md#dispatch-an-agent)

A task is Mission Control's durable unit of requested work. It records the work request
and, when dispatched, its execution details and outcome.

## [Multi-repo task](dispatch-and-backlog.md#attaching-more-than-one-repository)

A multi-repo task is a task with secondary repositories attached to its primary one. It
dispatches as a single session holding a worktree of each, and produces one pull request,
one review run, and one merge per repository it actually changed - completing only once all
of them have merged.

## [Workflow](workflows.md#workflows-and-personas)

A workflow is a versioned, durable process composed from persona, check, and session-action
nodes, with recovery and a visible run history.

## [Worktree](worktrees-and-checks.md#isolated-worktrees)

A worktree is the isolated Git checkout assigned to a task, check, or manual session. Mission
Control owns native, durable pools and can fall back to disposable Git worktrees.
