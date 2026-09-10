# Phase 6: staleness reporting, and the Setup row

Part of [Pi parity](plan.md) - see [phased-plan.md](phased-plan.md) for the graph.

## Outcome

A stale, broken or out-of-date Pi extension is **reported** - which is the only way anyone will
ever learn about it, because Pi's two failure shapes are silence and a machine-wide refusal to
start. The operator can install the integration from Setup, and the row disappears when it is
healthy.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 5.** The check inspects what that phase installs, through the same
  resolver.

## Scope

1. `"pi-extension"` appended to `ENVIRONMENT_CHECK_IDS`, with its `ENVIRONMENT_CHECK_INFO` entry.
2. An `EnvironmentCheckImpl` reporting a dangling link, a bundle that fails to load, and a
   version drift.
3. `ENVIRONMENT_ROW_METADATA` so the row reaches the Setup panel with a remedy.
4. The Setup install action that satisfies the row.
5. Phase 3's `deps.piExtensionInstalled` seam repointed at this check, so one thing decides.

### Non-goals

- **Repair.** The approved decision is report-only, with no one-press remedy on the row either.
- Changing what Phase 5 installs.
- A check on any harness but Pi.

## Repository findings

### Pi's failure shapes, and why a check is the only signal

Measured (`plan.md` P10), three installs, each broken differently:

| What is wrong | Pi's behavior | Blast radius |
| --- | --- | --- |
| Dangling symlink | **exit 0, zero bytes of stderr, nothing at all** | Every Pi session silently loses Mission Control |
| Bundle exists, fails to load | `Error: Failed to load extension "…": …` + `Hint: Start without extensions using "pi -ne".`, **exit 1** | Every Pi session on the machine **refuses to start** |
| Handler throws at runtime | `Extension error (…): …` on stderr, session continues | That event lost; session fine |

Compare Claude's, which `claude-hooks.ts` records: a moved checkout makes every hook event fail
with `MODULE_NOT_FOUND` and print a stack into the transcript **every turn** - loud, and pointing
nowhere near Mission Control. Pi's first row is *quieter than that* and its second is *more
destructive*. Neither names Mission Control. So this check is not a convenience; for the first
row it is the only signal that will ever exist.

### `claude-hooks.ts` is the template, including what it refuses to do

That file is a report, never a repair, and its reason transfers with more force. The daemon
running the check "may itself be running from a pooled worktree that its allocator will
reclaim", so an auto-repair "would therefore be free to cause the outage it just reported, and
would do it silently, from a background read nobody asked for". Here the outage is *no Pi
session starts*.

Also copy its restraint on inputs: bounded reads, a ceiling on how much it inspects, a maximum
path length before printing back a path out of a file the daemon does not own, and **silence on
a machine that never installed** - "no settings file, no commands of ours in it, or paths that
all resolve, and this says nothing".

And copy its one-sided error rule: `claude-hooks.ts` counts **only absence**, because "a script
that is present but unreadable is a permission problem this check cannot distinguish from a
race".

### The environment-check plumbing, and the append-only id

`ENVIRONMENT_CHECK_IDS` (`src/shared/environment-checks.ts:35`) is **append-only**: "a renamed id
silently stops matching a stored one", and the file points at
`docs/agent-guides/change-contracts.md`. Append `"pi-extension"` at the end; the
`Record<EnvironmentCheckId, …>` types then refuse to compile until `ENVIRONMENT_CHECK_INFO`,
`ENVIRONMENT_ROW_METADATA` and `ENVIRONMENT_CHECKS` all answer.

Registration is `src/server/environment/index.ts:37`. The Setup row comes from
`ENVIRONMENT_ROW_METADATA` (`src/shared/setup-catalog.ts`), and an environment row **exists only
while its check is warning** - which is what lets `mission-hook-script` be `required` without
nagging a machine that opted out. The same reasoning applies here, and the label follows that
entry's rule: name the thing the operator is looking at ("Pi extension"), not Mission Control,
and let the remedy sentence name us.

### The remedy, given the decision

`SetupRemedy` (`src/shared/setup-catalog.ts:122`) is a union whose comment says it is safe to
widen because "the wire contract grows a case, not an execution surface". The approved decision
rules out a one-press repair **on the row**, so the row's remedy is the installer the operator
runs themselves - the shape `mission-hook-script` uses (`kind: "command"` naming
`npm run install-hooks`, with a note covering the packaged-app case too).

The Setup **install action** in scope here is the other thing: turning the integration on for a
machine that has never installed it. That is `/api/setup/install` (`src/server/routes.ts:6519`)
and `SetupPanel.tsx:387`, and it is not a repair of a broken install - it is the first install.
Keep the two distinct in the copy, or an operator with a dangling link will press a button that
reports success while the link stays dangling.

### The version marker must already be in the artifact

Phase 4 adds a build marker to `dist/pi-extension/index.js` precisely so this check has something
to compare. Without it, an extension installed before this phase can never be recognised as
out of date. Read the marker; do not infer freshness from mtime - `mission-mcp.ts` records why
mtime was tried and rejected for the equivalent question ("`src/shared/` changes on almost every
commit in this repo, so a bundle that is behind by one irrelevant shared-module edit would warn
identically to one missing a tool... and a warning that fires constantly is a warning nobody
reads by the time it is true").

## Implementation steps

### 1. `src/shared/environment-checks.ts`

Append `"pi-extension"`. Add `ENVIRONMENT_CHECK_INFO` with `label: "Pi extension"`.

### 2. `src/server/environment/pi-extension.ts`

Resolve the directory **through Phase 5's capability resolver**, not by rebuilding the path -
otherwise the check and the installer disagree on a machine with `PI_EXTENSIONS_DIR` set, which
is how a check reports a healthy install that is not the one being loaded.

Four arms, in increasing cost:

1. **No link:** silence. A machine that never installed has nothing wrong with it.
2. **Dangling link:** warn. The sentence must say that **Pi reports nothing** - an operator's
   reasonable prior is that a broken integration announces itself, and here it does not. Name the
   link path and the target that is missing, and the installer that repoints it from a durable
   checkout.
3. **Present but fails to load:** warn, and lead with the consequence, because this is the one
   that stops work. Detect it by actually loading the bundle in a **child** process -
   `node --input-type=module -e 'import(process.argv[1])'` or equivalent - with a timeout, so a
   bundle that hangs cannot hang the check. Never load it in the daemon: this is a module chosen
   to run inside Pi, and importing it here would run its module scope in the control plane.
4. **Loads, but is out of date:** warn. Compare Phase 4's build marker against this build's. Then
   ask the bridged bundle's own `tools/list` whether it still publishes what `MISSION_MCP_TOOLS`
   names - `reportMissionMcpDrift`'s question, asked on Pi's behalf, and the one that catches the
   real case where the extension is current and `dist/mcp/server.mjs` is stale.

Bound everything the way `claude-hooks.ts` does: a path-length cap before printing back, a
timeout on the child, and only-absence-counts for the link probe.

### 3. `src/shared/setup-catalog.ts`

`ENVIRONMENT_ROW_METADATA["pi-extension"]`:

- `family: "extensions"`. Note that family's description currently reads "Claude Code
  extensions" - it now covers a Pi row, so update `SETUP_FAMILY_INFO.extensions` too, or the
  panel groups a Pi row under a Claude heading.
- `requirement`: `"required"`, on `mission-hook-script`'s reasoning - the row appears only while
  the check warns, and every state it warns about is worse than never having installed.
- `enables`: say what is broken *now*, per arm - a dangling link means no Pi session reaches
  Mission Control; a failing bundle means no Pi session starts at all.
- `remedy`: `kind: "command"`, the installer, with a note covering the packaged app - and **no**
  repair button, per the decision.

### 4. The Setup install action

Wire turning the integration **on** through the existing `/api/setup/install` route and
`SetupPanel`. Keep its copy distinct from the repair path above.

### 5. Phase 3's seam

Repoint `deps.piExtensionInstalled` at this check's reading and delete the temporary probe, so
one thing decides whether a Pi launch may declare Mission tools. A Pi plan or scout task should
now **succeed** on a machine with a healthy install, which is the end-to-end proof that Phases
3 through 6 compose.

### 6. Tests

- Each of the four arms, with a fixture directory: absent, dangling, unloadable (both a parse
  error and a module-scope throw - measured to produce the same exit-1 shape), stale marker, and
  healthy.
- A machine with no link says nothing.
- The check resolves through the capability: with `PI_EXTENSIONS_DIR` set, it inspects **that**
  directory. This is the check-installer agreement, and it should not rest on reading the code.
- The child loader cannot hang the check.
- The append-only id: assert `"pi-extension"` is last and that no earlier index moved.

**UI:** a new Setup row and a new install control, so an `e2e/` spec is required. Assert by role
and label, and call `expectContentClearsBorder` from `e2e/fixtures/modal-inset.ts` if any of it
lands in a modal.

```sh
npm run typecheck && npm run lint && npm test
npm run build && npm run smoke
npm run test:e2e
```

## Data and compatibility

`ENVIRONMENT_CHECK_IDS` gains one value at the end, so a stored `SetupRowId` from an older or
newer build keeps naming the same row - which is the whole reason that tuple is append-only.
A `SetupBannerDismissal` recorded against another row is unaffected.

## Merge and exit criteria

- Each of the four states produces the right report, and a healthy machine produces silence.
- The check never repairs, and never loads the bundle inside the daemon.
- Setup can install the integration, and the row clears once it is healthy.
- A Pi plan or scout task dispatches successfully on a healthy machine - the end-to-end proof.
- Build, smoke, unit and e2e all pass.

## Downstream handoff

Nothing depends on this phase. The project's remaining out-of-scope items - `permissionModes`,
the `sdk` runtime, blocking-tool TUI polish - are unaffected by anything here.

Anyone extending this later: the check is the single reading of "is the Pi integration
installed and current". Do not add a second one, and do not make it repair.

## Cross-phase audit record

- After Phase 5: consistent, and one requirement was moved into that phase rather than assumed
  here - resolving the directory through the capability is stated as Phase 5's handoff because
  Phase 5 owns the resolver.
- **Build marker moved into Phase 4**, where it was originally going to be added here. A version
  check cannot recognise an artifact installed before the marker existed, so the producer has to
  add it; recorded in Phase 4's audit as well.
- **Phase 3's seam is retired here**, which is recorded in Phase 3's audit too, so the temporary
  probe cannot survive as a second decider.
- `SETUP_FAMILY_INFO.extensions`'s description was found to be Claude-specific while this phase
  adds a Pi row to that family. Caught in this audit rather than by the panel looking wrong;
  fixed in this phase because this phase is what puts a Pi row there.
- Final audit over the whole set: every `plan.md` requirement and every submitted selection is
  owned by exactly one phase (see `phased-plan.md`'s table), every consumer follows its
  prerequisite, Phases 1-3 can merge in any order, and the final state needs no undocumented
  cleanup.
