# Troubleshooting

Start with the symptom you can see. The linked feature pages are the authoritative
reference when you need the underlying behavior or configuration.

## The daemon will not start because port 7317 is already in use

Mission Control's daemon uses port 7317 by default. First run `make status` to see
whether the expected daemon already owns that port. If this checkout started a
background daemon that you want to replace, run `make down`, then start the service
again. Use `make logs` when the daemon did not bind so you can see its startup error.

Do not casually start a second daemon on another port. The default port bind is also
not the state ownership boundary; a daemon with an isolated home and a different port can
still discover and write to the same local sessions. See
[Configuration](configuration.md) and [Skills and settings](skills-and-settings.md#the-daemon-is-no-longer-strictly-reactive).

## The daemon says the state home is already owned

Mission Control locks `$MISSION_HOME/daemon.lock` before it opens SQLite. The startup error
names the owning daemon's PID and API port. Stop that daemon if this start is meant to replace
it, or set `MISSION_HOME` to a genuinely independent state directory if both daemons are
intentional. Do not delete `daemon.lock`: the file is durable metadata, while the kernel-held
lock is the ownership authority and is released automatically after a crash.

## Chrome is blank when forwarding a Linux daemon to a Mac

Use the **built daemon** for a one-port forward. It serves the dashboard, `/api/*`, and
`/events` on the same loopback port. Do not change its bind address to `0.0.0.0`, expose it
through an EC2 security group, or disable the loopback Host guard. Anyone who can access the
forward can control the daemon as you, so keep the Mac listener private too.

### Isolated verification

On Linux, in the checkout you want to verify, use Node.js 24 or newer:

```sh
node --version
npm ci
npm run build
# A fresh home and disabled discovery avoid adopting the host's live sessions.
STATE_DIR=$(mktemp -d /tmp/mission-forward-check.XXXXXX)
mkdir -p "$STATE_DIR/workspace"
MISSION_HOME="$STATE_DIR" MISSION_PORT=17317 MISSION_POLL_MS=0 \
  MISSION_WORKSPACE_DIRS="$STATE_DIR/workspace" node dist/server/index.mjs
```

Leave that process running. From another Linux terminal:

```sh
curl -i http://127.0.0.1:17317/
curl -i -H 'Host: localhost:27317' -H 'Origin: http://localhost:27317' \
  http://127.0.0.1:17317/api/health
```

Both should return `200`. The first must be HTML containing an `/assets/` module script,
not a Vite source entry or a 404. `MISSION_WEB_DIR`, if set in your environment, overrides
which build is served; unset it before launching this check unless intentional.

On the Mac, with AWS CLI credentials, the Session Manager plugin, and permission to start
an SSM session on the instance:

```sh
aws ssm start-session --target <id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["17317"],"localPortNumber":["27317"]}'
```

Keep the session open. In another Mac terminal:

```sh
curl -i http://localhost:27317/api/health
open http://localhost:27317/
```

Repeat with `http://127.0.0.1:27317/`. Expect the dashboard and its Dispatch button, a
successful `/events` request with snapshot frames, and no uncaught Console errors. Open
Settings and confirm it loads. Unequal local and remote ports are intentional. For equal
ports, change `localPortNumber` to `17317` and open `http://localhost:17317/`. An SSH
alternative is `ssh -N -L 127.0.0.1:27317:127.0.0.1:17317 <user>@<host>`.
Stop the daemon and tunnel with Ctrl-C when finished. The temporary state home is not your
normal Mission Control state. Do not dispatch real agents just to verify page rendering.

### If it still fails

Open Chrome DevTools before reloading and retain the first Console error plus the failed
Network request's URL, status and Content-Type. Do not share session payloads, tokens or
unredacted logs. The HTML now reveals loading instructions if the dashboard has not replaced
them within two seconds, including when the entry script never runs;
a failed application import or uncaught React error replaces an empty root with recovery
instructions. Details stay in Console, not on the page.

These are ranked hypotheses, **not confirmed causes of the reported Mac failure**:

1. **A stale, missing, blocked or mismatched JavaScript asset.** Reload with DevTools cache
   disabled after a completed build. A requested `.js` receiving HTML can mean a missing
   asset fell through to the SPA index route. Ensure the daemon serves the same checkout's
   `dist/web`, including any `MISSION_WEB_DIR` override. Avoid rebuilding while testing.
2. **Forwarding the wrong surface or port.** The default daemon is `7317`; this isolated
   check explicitly uses `17317`. Vite development uses `5173` and proxies API/SSE to the
   daemon. Forwarding only the daemon does not serve Vite's source dashboard. If deliberately
   testing development, forward Vite's port, point its `MISSION_PORT` at the correct daemon,
   and check HMR's WebSocket URL separately. A failed HMR connection alone does not prove
   why initial rendering failed. The built dashboard needs no HMR or second forwarded port.
3. **An initialization/render exception or browser-specific interference.** Try an Incognito
   window without extensions, and preserve the first error. No Electron preload is required
   to paint the browser dashboard, although desktop-only actions remain unavailable.
4. **Using an EC2/custom hostname instead of local loopback.** API/SSE intentionally reject
   non-loopback Host headers. Plain HTTP custom names can also lack secure-context APIs.
   `localhost` and `127.0.0.1` are secure contexts in Chrome; a correctly addressed forward
   does not lose `crypto.randomUUID` merely because its remote endpoint is Linux.

The Linux Chromium regression covers a byte-preserving, different-port TCP tunnel on both
loopback names, snapshot delivery, and a browser POST carrying the forwarded Origin. It does
not reproduce a failure on that path. Actual AWS SSM transport, Mac Chrome and the failing
operator profile still require the human check above. Keep security restrictions intact until
an observed refusal identifies a specific problem.

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

## Every Claude turn prints a hook error with `MODULE_NOT_FOUND`

```
UserPromptSubmit hook error
Error: Cannot find module '/Users/you/workspace/ai-harness/hooks/harness-hook.mjs'
code: 'MODULE_NOT_FOUND'
```

`npm run install-hooks` and the desktop app's **Install Claude integrations** both bake an
absolute path into `~/.claude/settings.json`. The path does not follow a checkout that is
later renamed, moved, or deleted, so Claude Code goes on running it for every event, in
every session on the machine, and every one of them fails. Nothing in the stack names
Mission Control or the settings file, and the sessions report no state while it lasts.

Mission Control reports this itself rather than leaving you to read the stack. The
**Claude Code hooks** row in Settings -> Setup names the dead path and how many events run
it, the setup banner raises it as a required gap, and the Dispatch form repeats the note
before an agent goes out on the machine.

The fix is to re-run the installer from a checkout that still exists:

```sh
cd <your durable clone> && npm run install-hooks
```

Run it from a durable clone rather than a pooled worktree. An install from a pool slot
bakes a path the pool will reclaim, which is this same outage with a shorter fuse, and the
installer refuses one outright for that reason. Packaged-app users press **Install Claude
integrations** instead; either installer now replaces the other's entries rather than
stacking a second bridge beside them.

## An MCP server I added is missing from a dispatched Claude session

A user-added MCP server with HTTP transport, usually one that needs a browser login, can be
absent from a Claude session that Mission Control dispatched. It does not show up at all,
not even as "needs authentication", and it can be missing from your own new sessions too.

Mission Control is not what removes it. A dispatch passes Mission Control's own MCP server and
filters none of yours, in both the terminal and the Agent SDK runtimes, and an SDK dispatch
loads your user, project and local settings. See [It already composes](upstart.md#it-already-composes).

The cause is in the `claude` binary, and this part comes from an earlier investigation
rather than from this repository's code. A server recorded in
`~/.claude/mcp-needs-auth-cache.json` can be skipped without a connection attempt; the
binary logs `Skipping connection (cached needs-auth)`. That file is shared by every Claude
session on the machine, so an entry written by one session can hide the server from all of
them. What writes an entry, and how long it lasts, is not known.

To check, open `~/.claude/mcp-needs-auth-cache.json` and look only at the server names and
their timestamps, to see whether your server is listed. Do not paste the file's contents into
a chat, ticket or pull request.

To fix it, run `/mcp` in a terminal and log in to the server again. A successful login should
clear its entry. If the server is still missing after a successful login, the entry may not
have cleared, so check the file again (names and timestamps only). Then dispatch again.

One related limit: a local-scoped server (the default for `claude mcp add`, stored under the
repository's path in `~/.claude.json`) is keyed by that path, so a dispatched session in a
worktree at a different path may not see it. A project-scoped server in the repository's
`.mcp.json` reaches a worktree only when that file is committed or otherwise present in the
checkout. A user-scope server has no such limit, so add it there if every worktree needs it.

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

## iTerm2 is installed but sessions are missing or actions are denied

First confirm iTerm2 is open. Mission Control intentionally does not address a closed iTerm2
during Setup or discovery because AppleScript application addressing would launch it. If the
app is open, inspect **System Settings → Privacy & Security → Automation**, expand Mission
Control or the terminal host that started a source daemon, and enable its **iTerm2** toggle.
Then retry the action or use **Settings → Setup → Re-check**.

If access was denied, the Automation entry is missing, or you need to revoke or reset access,
follow [iTerm2 Automation and permission recovery](sessions.md#iterm2-automation-and-permission-recovery).

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

**Settings > Worktrees > Treehouse** shows the same provider reading with its exact
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


## A desktop binary update is unavailable or fails verification

Use **Check again** to refresh the stable release or exact-main-SHA alpha offer. A release without
a complete manifest, ZIP and DMG is not ready. An alpha may still be publishing or may have expired;
the updater never substitutes an older alpha or compiles source. An intact local prepared binary
can still be installed in the current session. Native GitHub CLI authentication is required, but
host Node, npm and a source clone are not.

The download bar measures bytes. Archive and signature checks show their stage without a guessed
percentage. Cancellation waits for the worker and owned subprocesses to stop before retry appears.
Wrong signer, digest, architecture, OS requirement or helper protocol leaves the installed app and
receipt unchanged. Free enough space for the archive, expanded app and measured runtime/recovery
copies, then retry. See the bounded, redacted `update.log` for diagnostics.

If the app cannot update itself, use the [signed binary installer](desktop-and-packaging.md#binary-installation-and-manual-recovery)
to replace the existing destination without host Node. Preserve the state home, receipt and
recovery directories. A failure after receipt commitment needs forward recovery; do not manually
launch an older app against potentially migrated state. Signed publication and real packaged
qualification remain required before this route can be declared release-ready.

## Mission Control is not open anymore, or an update relaunch fails

A Dock error saying **The application "Mission Control" is not open anymore**, especially with
an unresponsive update notice still visible, can mean that the window belongs to a process
macOS did not launch or register normally. The update notice is not the launch failure.

Start with `daemon.log` and `update.log` in your configured `MISSION_HOME` (normally
`~/.mission-control`). Main-process entries identify renderer hangs/exits and each update dialog's
send, delivery and answer by ID. `update-outcome.json` distinguishes an installed bundle from a
verified relaunch; a new successful outcome carries `launchVerified: true`. A failed outcome is
kept until acknowledged. A verified success also remains on disk until answered, so a renderer
that hangs after receiving the notice cannot hide that outcome on the next launch.

Inspect the current macOS registration and launch jobs:

```sh
lsappinfo list
launchctl list
launchctl print "gui/$(id -u)/com.mission-control.recovery-20260918"
ps -axww -o pid,ppid,stat,comm
```

Use the actual job label reported by the update error. In `lsappinfo list`, look for
`bundleID="com.mission-control.app"`, your exact bundle path, the matching PID and
`type="Foreground"`. A process with state `T` is stopped. A running process whose executable
is the app's `Contents/MacOS/Mission Control` but has no matching Foreground registration is an
unmanaged start. Electron helper processes normally have no separate Foreground entry.

A launchd job whose program or shell arguments execute that binary can respawn it every time it
exits and race the updater. Inspect the job before removing it. For the historical recovery label:

```sh
launchctl bootout "gui/$(id -u)/com.mission-control.recovery-20260918"
```

The failure message supplies the exact command for the job actually found, including shell quoting.
Mission Control does not run it for you. Review and remove or disable any persistent LaunchAgent
configuration through its owner if it would reinstall the job at login. A normal runningboard-owned
application job is not itself evidence of a stray respawner. Do not reuse old `kill` commands from
recovery logs: both PIDs and process-group numbers can belong to unrelated processes later.

After resolving the respawner, quit the unmanaged instance and launch the installed `.app` from
Finder or the Dock. Do not directly execute `Contents/MacOS/Mission Control`. Retry the update only
when the ordinary launch is responsive and registered. An update refuses to replace a bundle while
any executable beneath it remains alive. If a separately managed daemon uses that bundle's helpers,
stop it through its normal owner as well.

If `open` still leaves a stopped app, or other applications also cannot open, LaunchServices may be
wedged system-wide. Restart macOS, then verify a normal launch before retrying. Do not keep starting
more copies or delete state, receipts or the database to clear the update modal. A relaunch failure
retains the prior bundle and receipt under `failed-update/` when possible; if automatic rollback was
blocked by an unrelated live process, the failure explains that recovery is still pending.

See [update relaunch safeguards](desktop-and-packaging.md#update-relaunch-safeguards) for the
verification, retry and rollback boundaries.
