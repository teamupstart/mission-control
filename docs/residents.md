# Residents

A **resident** is a long-running agent with a standing role. You author a **resident profile**
once - a Persona, instructions, a harness, model and effort, and a default repository - and
launch it from **Dispatch > Resident**. It runs as an ordinary session in the Agent SDK, keeps its
role through compaction and restarts, and ends only when you choose **Complete & close**.

This page describes profiles, launch, the persistent wake loop, repository-free residents,
skill sources, session control, MCP servers and their dashboard controls. Skill selection remains a later phase of
[the residents plan](plans/persistent-agent-profiles/plan.md).

## Resident profiles

Open **Residents** from the ⌘K palette, with **Shift+A**, from **Manage residents** in the
[Residents dock](#the-residents-dock), or from **Edit profile** in Dispatch's Resident mode. The page lists your live profiles beside an editor.

| Section | What it decides | Default |
|---|---|---|
| Identity | The name (unique among live profiles) and an optional description | required |
| Persona | The Library Persona whose guidance becomes the resident's standing role | required |
| Instructions | Markdown added after the Persona's guidance | empty |
| Harness, model and effort | Claude Code or Codex; the model and effort the harness offers | Claude Code, harness defaults |
| Workspace | The repository Dispatch pre-fills | none |
| Board presence | The marker color, its label, and **Pin to top of column** | first color, label from the name, pinned |
| Loop and guardrails | Loop prompt, cadence, requested-delay bounds, rolling caps and compaction | 5 minutes; 1 to 60 minute requests; 200 iterations and $20 per 24 hours; compact at 70% |
| Authority | **Control other sessions**: whether a desktop Launch click gives the run [session control](#session-control) | off |
| MCP servers | Whether the harness's global servers ride along, and which global or [custom](#custom-mcp-servers) servers are added; see [MCP servers](#mcp-servers) | inherit on, none selected |

Every save writes a new, immutable **revision**, compare-and-set on the revision the editor
opened, so two windows cannot overwrite each other silently. **Archive** removes a profile from
the list and from Dispatch and frees its name; nothing is deleted.

**Edits apply at the next launch.** A launch pins the profile's current revision, and a running
resident reads its settings only from that pinned revision. Editing the profile, or the Persona
it names, never changes a resident that is already running.

Pi is not offered: the first release supports Claude Code and Codex, and a profile can only be
saved for a harness with an Agent SDK driver.

## Launching a resident

**Dispatch > Resident** shows a card per live profile, the repository (pre-filled from the
profile's default), optional **Instructions for this run**, and a read-only summary of what the
launch carries. **Launch resident** starts it; the profile's **Launch** button opens the same
form on that profile.

A launch is a task of kind `resident`:

- With a repository it runs in a task worktree. **No repository** creates a private working
  directory for this run under `$MISSION_HOME/residents/runs/<runId>/workspace/`. Both run
  in the **Agent SDK**, whatever the
  harness's configured runtime is. **Continue in terminal** is unavailable for it.
- It uses the profile's harness, model and effort. Per-kind defaults in **Settings > Models** do
  not apply, because the profile already answers them.
- Its opening turn is "Begin your standing task." The Persona's guidance, the profile
  instructions and the run instructions travel as **standing instructions**, appended after any
  [repository standing instructions](skills-and-settings.md), on the harness's own channel:
  `systemPrompt.append` for Claude Code and developer instructions for Codex. They are recorded
  once at launch, shown under the session's **See standing instructions** control, and replayed on
  resume, so compaction or a daemon restart never loses who the agent is.
- It has no backlog, dependencies, schedule, autopilot, after-work Workflow or task-kind contract.
  Single agent Dispatch, MCP `create_task`, recurring missions and task sources do not offer it.

A launch is idempotent. Repeating a request - a second click, or a response lost on the way back
- returns the same resident rather than starting a second one, including when two identical
requests race. Reusing a launch for a different profile, repository or set of run instructions
is refused. An exact repeat is recognized by the repository path as it was typed, even after that
path stops resolving or a symlink in it is pointed elsewhere; any other spelling is compared by
the repository it resolves to. If a profile is archived while one of its launches is still
unanswered, Dispatch keeps that one launch available to retry exactly.

## Finding a resident

A running resident is marked wherever its session appears, and every mark comes from the
revision the run launched with: editing the profile's color, label or pin changes the next launch,
never a resident that is already running.

- **Border glow.** Its Board card has a glowing outline in the profile's color, and a label
  chip beside its name - the label you set, up to four characters, or initials from the profile's
  name. `⤒` on the chip means it is pinned. The colored spine on the card's left edge is still
  the session's state, so a resident that needs you still reads amber there. In the Console rail
  the same chip sits before the name, with the color as an edge on the row's right side.
- **Pinned to the top of its column.** A pinned resident sorts first in whichever Board column
  its state puts it in, ahead of free and held sessions, and leads the Console rail the same
  way, whether or not the column is grouped by repository. The arrow keys and the
  <kbd>⌘</kbd>-number shortcuts follow that order. Turn the pin off under **Board presence** and
  a resident takes its place in the column's ordinary order like any other session: by name,
  within its repository's group when **Group by repository** is on.
- **Console band.** Opening a resident shows a band under the Console header: the label chip,
  the profile name, the Persona, the revision it launched from and whether it is pinned. When the
  profile has been edited since the launch, the band says **Profile changed since launch** and
  the new revision. When the resident's revision turns **Control other sessions** on, the band
  says **control granted** or **control not granted**, the latter beside the session control
  menu. **Profile** opens the profile on the Residents page.
- **Hiding the marker.** **Settings → Display → Session display → Resident marker** takes the
  glow and chip off cards and rail rows. The pin still applies, and the Console band and the
  dock still name the resident.

### The Residents dock

**Residents** sits beside **Foreman** in the top bar. While any resident is running it shows how
many; with none running it shows no number. Click it, press **Shift+H**, or choose **Open the
Residents dock** in the ⌘K palette.

- **Live** lists each running resident with its chip, its session's state and **Open**, which
  opens that session. A resident whose revision asks for session control also shows **control
  granted** or **control not granted**, the latter with the session control menu.
- **Profiles** lists every live profile with **Launch**. A profile with a default repository
  launches straight away, through the same launch call as Dispatch; while it starts the row reads
  *starting…*, and closing the dock does not lose it - launching again resumes that same launch,
  in the repository it was sent with even if the profile's default has changed since.
  If it is still starting after a minute, the dock stops waiting and the row reads *still
  starting*; **Launch** then checks on that same launch rather than starting a second resident.
  A profile without a default repository shows **Launch…**, which opens **Dispatch > Resident**
  on it so you can choose one.
- **Manage residents** opens the Residents page.

Escape or a click outside closes the dock. On a narrow window the button drops its word and keeps
the ⌂, plus the live count when there is one, and **Settings → Display → Top bar** can keep it
that way at every width.

## Session control

**Control other sessions**, under **Authority**, is off by default. Turned on, it lets a
resident's run receive the same grant as the
[session control menu](sessions.md#let-a-session-steer-other-sessions), so it can read and steer
your other live sessions. Your **Launch** click in the Mission Control desktop app, on
**Launch resident** in Dispatch or **Launch** in the Residents dock, is the only thing that gives
it a grant that lasts for the run and through a restart. The session control menu can still grant
control for one conversation, as it can for any session, and that grant ends at the next restart.

- **For that run only.** The click authorizes exactly that launch of that profile revision. It
  is consumed when the launch starts, cannot be replayed, and expires after 15 seconds. Editing
  the profile afterwards changes the next launch, not this run.
- **Through a restart, for the same conversation.** After Mission Control restarts, the grant
  comes back only if the resident resumes the same conversation in the same working directory,
  on the same work episode and task. A clear or a new conversation ends it, and a new launch of the profile
  needs its own Launch click.
- **Once the session is ready.** The grant is given when the resident's session has its
  conversation. If the launch answers before that, Dispatch and the dock say session control is
  not granted yet, and the Console band reads **control granted** once it is. If Mission Control
  restarts first, that launch is not granted and needs a new Launch click.
- **Until you turn it off.** Choose **Off** in the session control menu to revoke it. A restart
  does not bring it back.
- **Launched anywhere else, it starts without control.** Before you launch from the browser
  dashboard, Dispatch says the launch will not carry control. A desktop app attached to a daemon
  it did not start cannot pass the click on either: Dispatch stays open after that launch to say
  the resident launched without session control. A Launch from the dock reports *Started without
  session control*, and the Console band reads **control not granted**. The
  session control menu in the desktop app can still grant it for that conversation, the way it
  can for any session; that grant ends at the next restart.

The exact rule, and what cannot create a grant, is in [security](security.md#resident-launch-grants).

## Lifecycle

After each completed turn a resident waits for its next wake. Foreman never completes it
automatically. It ends when you choose **Complete & close** on its session,
or when its session goes away, which settles its task through the ordinary task lifecycle. A
failed launch, or one interrupted by a restart before its session started, is recorded with its
reason and is never relaunched; launch the profile again.

A run without a repository has no Git worktree, diff, pull request, repository reset or repository group.
The Files panel browses its working directory directly, without Git or managed repository plans.
Listing is capped at 10,000 files and refuses trees exceeding 10,000 directories or 64 nested
levels. Traversal checks a 15-second budget between filesystem operations.
Directory scans run asynchronously against open directory handles and refuse symlinked
boundaries, including directories replaced while a listing is in progress.

The workspace survives daemon restarts while the run is active. When the run ends, Mission removes
that workspace after its session is gone and its SDK runtime has stopped. Failed launches also
remove their directories. Cleanup failures remain recorded and retry, including after restart;
the repository retention clock never applies to these directories. Files saved there are temporary.

## The persistent loop

The daemon owns every loop turn. After a completed turn it waits the pinned profile's cadence,
then sends its loop prompt. The default asks the resident to check what changed, act, and end
with a one-line status. The card, Console band, dock and live-run rows on the Residents page show
its state, cumulative iteration, next wake and the agent's wake reason.

The resident can call `schedule_next_iteration` with `delaySeconds` and an optional `reason`.
The delay is clamped to the profile's minimum and maximum. During a turn, the last new request
wins and its delay starts when the turn completes. It applies once; the following completion
uses the normal cadence unless the agent requests another delay. A late request replaces an
already waiting wake with now plus its delay.

The tool returns a `callId`. Replaying that id returns the original receipt without rescheduling,
even after a newer request or daemon restart. A new id is a new intent. The HTTP call has a
10-second timeout; an unknown outcome says the request may still apply and includes its id for
safe replay. Only a typed refusal or a refused connection proves nothing was recorded.

**Human input has priority.** Queuing a human message cancels the scheduled wake and pending
agent delay. After the human turn, the normal cadence applies unless the agent requests another
delay. A request for human input (`needs-you`) pauses the loop until the request is resolved and
you resume it. Pausing does not interrupt an already running turn.

All four surfaces offer **Pause**, **Resume** and **Run now**. Resume starts a fresh cadence;
Run now asks for an immediate idle wake, subject to the same human, compaction and budget checks.
After a profile edit, **Restart on new profile** ends the old task through its normal lifecycle
and launches the latest revision in a new conversation. It preserves the repository choice and
run instructions; a repository-free resident receives a fresh private workspace. New conversation
creation ensures every changed launch option takes effect. Retrying an interrupted Restart
finishes the same replacement request, including an interruption after the old task completed.
The replacement conversation does not inherit a session-control grant from the old run;
only the desktop Launch flow or the existing session-control menu can grant that authority.

### Compaction and guardrails

Before a wake at or above the context threshold, the daemon asks the harness to compact and
waits for a measured result below that threshold. Compaction and human turns do not count as
iterations. Missing or invalid context readings pause before a wake until a fresh measurement
is available and you resume. An interrupted or unconfirmed compaction also pauses instead of
sending a loop prompt.

The editor and every live-run surface name the active compaction layers:

- **Claude Code:** compaction before wakes is active. The configured native backstop did not
  fire in the Claude Code 2.1.310 probe on 2026-10-30.[^claude-native-backstop-probe] The operator
  approved shipping with manual compaction only, so the native backstop remains unavailable.
  A long turn therefore has no profile-threshold native backstop.
- **Codex:** compaction before wakes and the native backstop are active. The latter is computed
  from the explicit model's context window in Codex's native model catalog. Launch refuses if
  that window is unavailable. The measured native token limit is saved with the SDK session
  and replayed on resume, so a later catalog refresh cannot remove the configured backstop.
  Older sessions without a saved limit must resolve it from the catalog once.
  Codex's compact operation does not accept a focus instruction;
  the focus field is used by Claude.

The default rolling 24-hour limits are **200 iterations** and **$20**. Clearing either cap in
the editor disables that cap for new runs. Launch is iteration one only after the session
actually starts. Claims, sent wakes and uncertain deliveries count toward the iteration window;
positively refused sends do not. Rows exactly 24 hours old no longer count. Spend uses Claude's
reported costs and Codex's estimated Standard API costs, including human and maintenance turns
in the same resident conversation. It is a between-turn limit, not an interruption of spend
inside a running turn. Unpriced models cannot retain a spend cap at save or launch, and unpriced
usage pauses a capped run instead of treating it as free.

Reaching a cap pauses and appears in the attention inbox. Resume is refused until the rolling
window has room; the refusal names the earliest release time. Editing the profile cannot lift
a live run's pinned cap. Restart on new profile is the explicit way to adopt different settings.

### Restart recovery

The next wake, consumed completion generation, pacing requests and cumulative counters are
durable. A missed wake is rearmed once after SDK restoration. Each delivery is claimed before
sending, with a unique sequence and transcript offset. Only its own marker after that offset
confirms delivery after a crash. Missing or unreadable evidence becomes **wake delivery
unconfirmed**, counts conservatively, and pauses for you; it is never silently resent.

Sent and released delivery rows are retained for seven days. Unresolved claims are reconciled
before pruning, and uncertain deliveries stay until the run ends. Pruning never decreases the
cumulative iteration or reuses a sequence. Pacing receipts remain for the run's lifetime.

## MCP servers

**MCP servers** in the profile editor decides which MCP servers a resident starts with, besides
Mission Control's own, which every resident always has.

- **Inherit harness defaults** (on by default) adds every global server the harness configures
  when the resident launches: the user-scope `mcpServers` in Claude Code's `~/.claude.json` (or
  `$CLAUDE_CONFIG_DIR/.claude.json`), or the `mcp_servers` in Codex's own `config.toml`.
- **Add an MCP server** adds one of those global servers, or a [custom server](#custom-mcp-servers)
  that applies to the profile's harness. With inheritance off, the resident starts with only the
  selection. A selected server that is also inherited starts once.

Dispatch's launch summary says what the launch carries, such as `MCP: defaults + linear`.

### What a run starts

A launch resolves the run's set once, from the revision it pins and each harness's configuration
as it is at that moment, and keeps a private copy of every definition and value. Every start and
every resume after that reads only the copy:

- A global server added later, a field added to a native entry, an edited or deleted custom
  server, a changed secret or an edited profile never reaches a running resident. The next launch
  picks it up.
- Only the snapshot's servers start, plus Mission Control's own. Native MCP configuration is not
  read for a resident at all: on Claude Code a repository's `.mcp.json`, local-scope servers,
  plugin servers and claude.ai connectors do not load. On Codex, a server that only a trusted
  project's `.codex/config.toml` (or a system or managed configuration) defines is switched off
  for the run.
- A launch is refused, with the reason, when the set cannot be pinned: an inherited or selected
  global server residents cannot use, a custom server named like a global server of that harness,
  a selected server that no longer exists, a custom secret that is not set, or, on Codex, another
  configuration layer that changes one of the run's servers or forces a server on itself. Nothing
  is renamed or dropped silently.

Each launcher credential is good for one start, so a server that exits during a session is not
restarted by the harness; it starts again with the session's next start, such as a resume.

A global server residents cannot use is shown as unavailable, with the reason, in the catalog and
the picker. That happens when it uses a field residents cannot carry (anything beyond the command,
arguments, environment, URL, headers, and the timeouts and tool filters each harness maps one to
one), reads a value from the agent's environment (`env_vars`, `bearer_token_env_var`,
`env_http_headers`), relies on an OAuth login the harness holds, has a credential in an argument,
or uses a Claude Code `${VAR}` reference. A reference to a variable that is set reads a value the
resident's agent inherits too, so it would not be private to the server; define that server as a
custom server with a secret instead. A reference to an unset variable is refused unless it has a
`:-default`, which is used as written.

How each harness is held to exactly this set, and what was measured, is in
[resident MCP isolation](harnesses-and-terminals.md#resident-mcp-isolation).

### Custom MCP servers

**Residents > Custom MCP servers** defines servers for residents and lists each harness's global
servers. A custom server has a name, the harnesses it applies to, and either a **stdio command**
(command, arguments, environment variables) or an **HTTP URL** (URL, query parameters, headers).

- **Secret** values are write-only. An environment variable or header marked secret, and every
  query parameter, is stored on this machine, shown afterwards only as *Set*, never returned by
  the dashboard, and never included in a settings snapshot. Leave a set value blank when editing to
  keep it; renaming the field clears it.
- An argument that looks like a credential (`--api-key=…`, `--token`, `TOKEN=…`, a URL with a user
  name or query, a bearer credential) is refused, naming the argument. Put the credential in a
  secret environment variable instead. Arguments are otherwise stored and backed up as written.
- A URL with a user name or password is refused; a URL's query becomes secret query parameters.
- Names are unique, are never `mission-control`, and may not equal a global server's name on a
  harness the server applies to. A dotted name such as `foo.bar` is one server on both harnesses.
- **Delete** removes the definition and its secrets. A running resident keeps the copy it launched
  with; a profile that still selects it cannot launch until the selection is removed.

A secret, and every value of a global server, reaches only its own server's process, through
Mission Control's launcher; never the agent's environment, a command line, a generated
configuration file, a log or the transcript. See [security](security.md#resident-mcp-secrets).

When a run ends, its copy of the servers and their values, its launch tickets and its Codex
configuration overlay are removed once its session has stopped.

## Backups

Resident profiles are part of [automatic settings snapshots](configuration.md#automatic-settings-snapshots).
Custom MCP server definitions are too, under their own domain, without any secret value: a
snapshot restored onto another machine brings the servers back with their secrets *Not set*. A
snapshot taken before custom MCP servers existed restores without touching them. Full-database
recovery points are scrubbed of every secret before they are written.
Restoring a snapshot writes each changed profile as a new revision, reactivates profiles the
snapshot holds and archives live profiles it does not. Revisions that running residents pinned are
kept. A snapshot taken before residents existed restores without touching profiles.

A snapshot carries **every live profile** with its current revision, and only the **200 most
recently archived** ones. Archive never deletes a profile, so the full history grows without
limit and would eventually push snapshots past their size limit and stop automatic backups. In the multibyte-text backup fixture, 200 live and 200 archived
profiles with maximum instruction and loop text fit in about 15 MB. The snapshot file limit remains 16 MiB.

- **Restoring on the same machine** changes no archived profile the snapshot left out: restore
  only archives *live* profiles a snapshot omits, and every revision a run pinned is kept.
- **Restoring onto a fresh installation** recreates every live profile but not the archived ones
  past the newest 200. Nothing in Mission Control can reopen an archived profile, so no profile an
  operator can see or launch is lost.
- Settings snapshots never carried full history: they hold each profile's current revision, not
  earlier revisions or runs. To move the complete record to another machine, use a
  [full-database recovery point](database-and-migrations.md#full-database-recovery-points).

## How it is built

The registries later phases extend, the single launch path, the pinned-revision rule and the
launch and recovery guarantees are maintained in
[change contracts](agent-guides/change-contracts.md#resident-profiles).

[^claude-native-backstop-probe]: Mission Control workflow run
    `bfb6fe70-1862-4a6c-bfbd-ac54cb644b26`, round 6, segment 2,
    `probe-claude-20.log`, artifact `txt_4606a312dc45c5b01382778be74b210d`.
    The retained probe did not auto-compact at the requested 20% setting; explicit manual
    compaction emitted a boundary with 54,678 tokens before and 494 after.
## Skill sources

Open **Residents > Skill sources** to browse Mission Control's `skills/`, `~/.claude/skills`,
`~/.agents/skills`, and `$CODEX_HOME/skills` (or `~/.codex/skills` when unset). Claude entries
that resolve to a skill already indexed by Mission Control are omitted; independent
`mission-*` folders and links remain indexed.
Register up to 16 additional absolute or home-relative folders. Removing a source only removes
its registration; it never deletes skill files.

The catalog is scanned at daemon startup and on **Rescan**. Adding or removing a source also
rescans. Search matches names, descriptions and folders; the Source filter narrows the list.
Malformed frontmatter, missing folders, unreadable files and bounded-scan limits appear beside
the source. Grouped folders and symlinked skill folders are supported, but links to the home
directory or an ancestor are refused. The 5,000-entry scan budget includes ordinary and hidden
files as well as directories. A skill's stable identity
is its source id plus relative folder, so editing its name does not change its identity.
Registered directories are included in settings snapshots. Restoring an older snapshot without
that domain leaves the current registrations intact.

**Profile skill selection is currently unavailable for both Claude Code and Codex.** Neither
proposed per-launch mechanism passed the exact frozen-set check. The catalog does not change a
resident's launch or native skill discovery. Built-in source rows show the limitation instead
of inventing a selectable inventory. The approved policy remains: inheritance captures defaults
plus selections, selected-only captures selections, and both must resume from the same immutable
set. See the [capability measurements](harnesses-and-terminals.md#resident-skill-isolation).
