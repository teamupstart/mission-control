# Claude-session control (preview)

P14 delivers setup and diagnostics for the Claude-session loop in the
[minimal headless-mode plan](plans/headless-mode-implementation/phase-14-setup-doctor-and-mod-install.md).
This preview installs from a built checkout. App packaging, service installation, Codex,
subagents and the other `mctl` commands are deferred.

## Setup

Use Node.js 24 or newer, install dependencies, and run `npm run build`. Start the Mission
Control daemon or open the app, then run from the checkout:

```sh
node dist/cli/mctl.mjs setup
node dist/cli/mctl.mjs doctor
```

These are `mctl setup` and `mctl doctor` when `mctl` is on your PATH. The CLI uses the same
`MISSION_HOME`, `MISSION_PORT` and token resolution as other daemon clients. Setup finds Claude
through `MISSION_CLAUDE_BIN`, PATH, then `~/.claude/local/claude`, `~/.local/bin/claude`,
`/opt/homebrew/bin/claude` and `/usr/local/bin/claude`. An explicit binary override is
authoritative. A usable CLI must run `--version` and expose `marketplace` in `plugin --help`.

Setup checks the daemon, enables only `headless-mode`, stages the built folder marketplace at
`{stateDir}/mod`, and installs `mission-control@mission-control` at user scope. Claude's plugin
commands own the plugin settings. Hook entries, MCP registrations and status line settings are
not rewritten. Setup skips the agents and Codex steps with `step not available in this build`.
It finishes the report even after a step fails, returning exit 1 for a failed check and 2 for
unsupported arguments. Services (`--service`) and paid live checks (`doctor --live`) are unavailable.

Unchanged stages are left byte-identical. A changed stage is prepared in a sibling directory
and published with rename; files in the live stage are never overwritten in place. A stale
user plugin is uninstalled and reinstalled, then checked in a fresh Claude invocation. A disabled
current user plugin is re-enabled. Running setup therefore reverses a manual `/plugin` disable.
An existing Mission Control marketplace pointing elsewhere is reported with a removal command;
setup refuses to silently replace that registration. Only the state directory is registered,
so the checkout may move after setup.

## Check and recover

Doctor prints daemon reachability, the flag and `home-dispatch-v1` capability, Claude's path and
version, `mod-enabled`, `mod-current` and `mod-calls`. It checks user scope, the installed version
against the stage, the marketplace source against the state directory, the staged bundle's
daemon paths against P8's `allowed-calls.json`, and Claude's plugin validation. It reads only,
spends no model tokens, and returns 1 for a failed required check.

The documentation-only `mods-*` policy and version-floor probes are deferred by the minimal
plan. This release does not infer a blocking managed-policy check from documentation or change
Claude's policy switches.

If an upgrade's install fails, setup retries once. A second failure may leave the plugin
uninstalled. The daemon keeps working; setup prints the cause and recovery commands:

```sh
claude plugin marketplace add "{stateDir}/mod"
claude plugin install mission-control@mission-control --scope user
```

Use the actual state directory printed by setup. If that marketplace is already registered,
only the install command is needed. Re-running setup also retries installation. A missing stage
requires rebuilding and running setup. An interrupted staging process may leave
`{stateDir}/.mod-stage-lock`; after verifying no setup is running, remove that empty lock
directory and rerun setup.

```sh
node dist/cli/mctl.mjs setup --off
claude plugin uninstall mission-control@mission-control --scope user
```

The first command turns the flag off without changing the plugin. Within one five-second poll,
the mod closes its pane and clears the band and status. The second command removes the user plugin.

## Claude-session walkthrough

With the flag on, the daemon running and the dashboard closed, open Claude Code in a repository
that already has a home-dispatched task. The pane opens with Needs you first and Tasks second,
docked at 110 columns or more and inline in narrower terminals. Run `/mission-dispatch`,
describe a task and confirm it; Tasks shows the new row within one five-second poll. A question
or plan produces one toast, a band with its `1` button, a status entry and a Needs you row.
Open it with the button or `/mission-dispatch inbox`; answer the question or focus the plan's
revision button and press Enter to approve. A receipt appears and the row leaves Needs you.
A stale revision is refused. When work finishes, Tasks shows ready with its PR or summary;
`/mission-dispatch check <task>` opens that row. Back or Esc sends no answer.

The launcher remains off pending the separately owned S10/S11 decision. The loop is tested
without model tokens by `test/headless-claude-session-loop.test.ts` at 160 and 100 columns.
The real Claude plugin engine proof runs with `npm run test:mod`.
