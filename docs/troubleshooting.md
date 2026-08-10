# Troubleshooting

Start with the symptom you can see. The linked feature pages are the authoritative
reference when you need the underlying behavior or configuration.

## The daemon will not start because port 7317 is already in use

Mission Control's daemon uses port 7317 by default. First run `make status` to see
whether the expected daemon already owns that port. If this checkout started a
background daemon that you want to replace, run `make down`, then start the service
again. Use `make logs` when the daemon did not bind so you can see its startup error.

Do not casually start a second daemon on another port. The default port bind is also
the mutual-exclusion boundary for autonomous features such as skill reloads; a daemon
on a different port can still discover and write to the same local sessions. See
[Configuration](configuration.md) and [Skills and settings](skills-and-settings.md#the-daemon-is-no-longer-strictly-reactive).

## A Claude session stays grey, or its status looks stale

`instrumented: true` means the daemon has fresh hook evidence for that session. Install
the Claude integrations from a durable checkout with `npm run install-hooks`, then start
a new Claude Code session. Claude reads its hook configuration when a session starts, so
an already-running session will not begin reporting until it is restarted. In the new
session, run an action and confirm the card changes to **working**; the session endpoint
also exposes the `instrumented` field.

Codex differs: its hooks are launch-scoped, so only a Mission Control-dispatched Codex
session receives them. See [precise session status](sessions.md#precise-status-claude-hooks) and
[the Codex hook behavior](sessions.md#precise-status-for-codex-hooks-that-ride-on-the-dispatch).

## Playwright cannot find Chromium

If the end-to-end run reports `browserType.launch: Executable doesn't exist`, install
the browser once on this machine:

```sh
npx playwright install chromium
```

Then rebuild before rerunning the suite. The end-to-end tests drive `dist/`, not source:

```sh
npm run build
npm run test:e2e
```

See the [browser end-to-end test guide](../e2e/README.md).

## The end-to-end suite has no build to serve

Run `npm run build` before `npm run test:e2e`. The daemon used by the suite serves the
built dashboard from `dist/`; without that build it cannot serve the application the
browser tests exercise. The required command order is in the [browser end-to-end test guide](../e2e/README.md).

## A treehouse pool has no available worktree, or a check lease looks stale

Run `treehouse status` first. Mission Control automatically reclaims only leases it can
prove are its own and safe to return. A lease held under your own label is intentionally
left alone, as are old holder names the daemon cannot identify safely; return those
yourself with `treehouse return <path>` when you are finished.

An idle `mission-control-check-…` lease left behind after its daemon has exited is safe
to return with the same command. If dispatch still cannot acquire a tree after a reap,
check the daemon log and the reported `treehouse` error rather than assuming the pool is
full. See [worktrees and checks](worktrees-and-checks.md#leaked-leases-are-reclaimed-for-you).

## A session says exited but its task or workflow has not settled yet

**Exited** is the temporary presentation state at the start of session eviction, not the
durable cleanup boundary. The Registry waits through its linger window and then publishes
`session_remove`; tasks, workflows, reviews, and drafts reconcile from that removal event.
For a dispatched task, the session's disappearance normally settles the task after that
eviction path, while preserving its worktree for an explicit cleanup or re-dispatch.

Wait for removal before treating the session as fully gone, then inspect the task row for
its recorded outcome and cleanup choice. See [session lifecycle](session-lifecycle.md#from-observation-to-removal)
and [when a task's agent goes away](dispatch-and-backlog.md#when-a-tasks-agent-goes-away).
