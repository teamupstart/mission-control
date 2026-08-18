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

## A scout or ensemble dispatch is refused, or the daemon says the MCP bundle is behind

Run `npm run build` (or just `npm run build:mcp`).

Symptoms, all of which are the same cause:

- The daemon logs at startup:
  `[mission-control] Mission Control's MCP server at …/dist/mcp/server.mjs does not publish submit_scout_artifacts …`
- A scout or ensemble dispatch fails with `this claude session requires the Mission MCP tools
  …`, or assigning a scout is refused before its checkout is reset.
- `npm run smoke` fails with `MISSION_MCP_TOOLS declares … which the MCP bundle does not publish`.

Dispatched agents are handed the **built** `dist/mcp/server.mjs`, never `src/mcp/server.ts`.
That file is rebuilt only by `npm run build` and is gitignored, so a `git pull` that brings you
a new MCP tool never brings you a bundle that serves it - and `npm run dev` reloads the daemon
from source without touching the bundle. The refusal is deliberate: a scout that cannot call
`submit_scout_artifacts` can never mark its task **done**, so failing the launch is better than
an agent that finishes its work and has nowhere to put it. See [Adding or changing a tool means
rebuilding the bundle](sessions.md#review-channel-mcp).

## A legacy Treehouse task or check cannot clean up

New work never needs Treehouse. A cleanup error naming provider `treehouse` refers to a persisted
resource from an older Mission Control. Run `treehouse status --json` in the recorded repository
if the binary is available. Mission Control conditionally returns only a v2.1.1+ lease whose
persisted lease ID, path, and holder still match and whose checkout is clean and unoccupied.

A missing or older binary, null lease ID, changed identity, foreign lease, dirty checkout, or
uncertain occupancy keeps the row and worktree intact. Resolve unverifiable or foreign resources
with Treehouse itself after confirming their current owner. Do not convert them to Git worktrees or
delete their directories behind Treehouse's bookkeeping. See
[Legacy Treehouse compatibility](worktrees-and-checks.md#legacy-treehouse-compatibility).

**Settings > Worktrees > Legacy drain** shows the same provider reading with its exact
classification. An exact row offers a preview-first Return only when durable owner identity,
cleanliness, and empty occupancy all agree. Unverifiable, foreign, and unreadable rows show
remediation instead of a Force button. Treehouse can be removed after that section reports no
durable legacy rows and you have separately reviewed every foreign lease.

## A Worktrees action says the preview is stale

Nothing was changed. A short-lived preview is bound to the exact owner, slot version, Git and
process observations, and fixed target set it displayed. Refresh the preview and review the new
facts. This commonly happens when a task finishes, a process exits, Git state moves, another
dashboard changes policy, or reconciliation repairs a slot between preview and Execute.

An unknown-process blocker is different: it cannot be acknowledged. Restore the host's process
inspection, stop the owning task or check through its normal control, and use **Reconcile**. Do not
delete the directory or Git registration by hand; uncertainty is why Mission Control kept it.

## A session says exited but its task or workflow has not settled yet

**Exited** is the temporary presentation state at the start of session eviction, not the
durable cleanup boundary. The Registry waits through its linger window and then publishes
`session_remove`; tasks, workflows, reviews, and drafts reconcile from that removal event.
For a dispatched task, the session's disappearance normally settles the task after that
eviction path, while preserving its worktree for an explicit cleanup or re-dispatch.

Wait for removal before treating the session as fully gone, then inspect the task row for
its recorded outcome and cleanup choice. See [session lifecycle](session-lifecycle.md#from-observation-to-removal)
and [when a task's agent goes away](dispatch-and-backlog.md#when-a-tasks-agent-goes-away).
