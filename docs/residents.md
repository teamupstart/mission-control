# Residents

A **resident** is a long-running agent with a standing role. You author a **resident profile**
once - a Persona, instructions, a harness, model and effort, and a default repository - and
launch it from **Dispatch > Resident**. It runs as an ordinary session in the Agent SDK, keeps its
role through compaction and restarts, and ends only when you choose **Complete & close**.

This page describes profiles, launch, lifecycle, and how you find a resident on the board and
from the top bar. The wake loop, skill and MCP selection, session control and repository-free
residents are later phases of [the residents plan](plans/persistent-agent-profiles/plan.md).

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

- It runs in a task worktree of the chosen repository, always in the **Agent SDK**, whatever the
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
  the new revision. **Profile** opens the profile on the Residents page.
- **Hiding the marker.** **Settings → Display → Session display → Resident marker** takes the
  glow and chip off cards and rail rows. The pin still applies, and the Console band and the
  dock still name the resident.

### The Residents dock

**Residents** sits beside **Foreman** in the top bar. While any resident is running it shows how
many; with none running it shows no number. Click it, press **Shift+H**, or choose **Open the
Residents dock** in the ⌘K palette.

- **Live** lists each running resident with its chip, its session's state and **Open**, which
  opens that session.
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

## Lifecycle

After its first turn a resident idles like a chat: Foreman never completes it automatically,
because it has no explicit Workflow. It ends when you choose **Complete & close** on its session,
or when its session goes away, which settles its task through the ordinary task lifecycle. A
failed launch, or one interrupted by a restart before its session started, is recorded with its
reason and is never relaunched; launch the profile again.

## Backups

Resident profiles are part of [automatic settings snapshots](configuration.md#automatic-settings-snapshots).
Restoring a snapshot writes each changed profile as a new revision, reactivates profiles the
snapshot holds and archives live profiles it does not. Revisions that running residents pinned are
kept. A snapshot taken before residents existed restores without touching profiles.

A snapshot carries **every live profile** with its current revision, and only the **200 most
recently archived** ones. Archive never deletes a profile, so the full history grows without
limit and would eventually push snapshots past their size limit and stop automatic backups; at
the largest profile sizes, 200 live and 200 archived profiles fit in about 7 MB.

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
