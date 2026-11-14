# Storage

**Settings > Storage** shows how much disk Mission Control uses on this machine, warns before
it uses too much or leaves the volume short of free space, and limits the two things that grow
without bound on a busy machine: full-database backups and the warm caches native worktree
pools keep between leases. It has five tabs.

Nothing on this page deletes anything because a limit was crossed. Limits warn. Backup limits
delete copies the limits no longer keep when they are saved and after every capture, and the
page shows exactly which copies before you save. The idle-cache budget only chooses what a
cleanup preview offers, and nothing is removed until that preview is executed.

## Overview

The **Problems** list comes first: a failed backup, low free space, and the storage limit, each
with a button to the tab where it is fixed.

Below it, two bars:

- **Volume**: the volume holding the state directory, split into Mission Control, everything
  else on the volume, and free space, with the free-space floor marked.
- **Mission Control**: the state directory by category, drawn against the storage limit when one
  is set, with the warning point marked.

The table lists each category, what it is, its size and share, the limit that applies to it, and
how much that limit would reclaim now. For Database backups that is the disk space of the copies
the saved limits delete at the next prune, from the same plan as the Backups tab. Copies outgrow
the limits between prunes as they age past an age limit, so the row reads "Within limits" only
when that plan deletes nothing. The categories are `STORAGE_CATEGORIES` in
`src/shared/storage-health.ts`:

| Category | Entries in the state directory | Limit |
|---|---|---|
| Native worktree pools | `worktree-pools/` | Idle-cache budget |
| Database backups | `backups/database/` | Count, age and size limits |
| App updates | `app-src/`, `update-runtimes/`, `update-downloads/`, `install-attempts/` | Managed by the updater |
| Live database | `harness.db` and its WAL | Never removed |
| Workflow evidence and output | `workflow-evidence/`, `workflow-command-output/` | Follows its run |
| Disposable and check worktrees | `worktrees/`, `check-worktrees/` | Removed with its owner |
| Archives | `archives/`, `scouts/` | Not cleaned here |
| Everything else | whatever no category names | Not cleaned here |

Measuring walks every file, which on a machine with large pools is millions of files and can
take minutes. A state directory reached through a symlink is resolved first, so the walk measures
what the link points at; symlinks inside it are never followed. When a walk finishes, the backup
folder is summed again on the spot, so a copy captured while the walk was elsewhere is counted
in the measurement it publishes. The daemon runs one `du -k -x -d 3` walk in a child process two minutes after it
starts and every six hours after that, and **Measure now** runs one on request. While a storage
limit is set, the free-space check also watches for growth: once the volume has lost as much free
space, since the last walk began, as was left between the measured total and the next threshold
(the warning, then the limit itself), and never more than a GiB, the walk runs again then, at most
once every 15 minutes. A quarter-GiB limit is therefore re-checked after the few MiB that can cross
it, and the limit warning does not wait for the six-hourly walk. Lost free space is net of every
program on the volume, so the state directory can grow while something else frees as much; for
that, while a limit is set the walk also runs on age alone, at least hourly and every 15 minutes
once the measured total is within a GiB of its next threshold. Growth on this volume always shows up as
lost free space first; space other programs take can trigger an early walk too, which the 15-minute
spacing bounds. The page shows
when the last measurement finished and how long it took, and keeps showing it while the next one
runs. A walk that cannot read some entries reports that its sizes may be low; one that fails
keeps the last good measurement. The backups category always reflects the copies the backup
service lists now, so saving a lower backup limit shows in the totals at once, and slots a
cleanup removed drop out of the totals as soon as they are gone. Free space is a `statfs` call,
checked every minute. A new reading replaces the shown one once it has moved 64 MiB, and at once,
however small the move, when it falls on the other side of the free-space floor, so the floor is
judged on every check. Between walks, the backups figure moves by exactly what the kept copies
gained or lost on disk, counted in the same allocated blocks the walk counts, so a sparse copy moves
it by the space it held rather than by its file size; anything else the walk measured in the backup
folder, such as a capture's temporary file, stays counted.

## Backups

The [full-database backups](sqlite-database.html#backup) and their limits: how many copies of
each kind are kept, how old each kind may grow, and a size budget for all copies together. Age
and size limits are off until set. The **Always kept** set (the newest scheduled copy, the two
newest pre-migration copies and the newest manual copy) is never deleted by an age or size
limit, so there is always a recent point to restore to. Each kind's own count still decides how
many copies it keeps, so a pre-migration count of 1 keeps and protects only the newest one; the
Always kept line follows the count you are editing.

While you edit, the tab says what saving would delete and how far back the scheduled and
pre-migration copies would still reach afterwards, and lists the exact copies it would delete,
each with its reason and the disk space it holds; the kept-copies table marks them too. The saving
is stated in disk space, which is what deleting frees; where copies are sparse and their file
sizes add up to more, that figure is named too, as the one the size budget counts. Fewer copies shorten the
recovery window. A strip of every kept copy, oldest to newest, marks the ones saving would delete
and the ones that are always kept.

Save sends that list with the limits. The daemon works out its own deletions against the copies
it holds at that moment and refuses the save, changing and deleting nothing, unless the two lists
match exactly, so a capture that lands between the preview and Save can never make Save delete a
copy you were not shown. After a refusal the tab reads the copies again and shows the new list.
The same rule holds for any other caller of `PUT /api/storage/backups/config`: a request without a
list is taken to expect no deletions, so one that deletes nothing (an interval, a raised count)
goes through, and one that would delete copies is refused with 409 and the exact list, which the
caller confirms by sending it back as `expectRemove`.

A save that passes has stored the limits; the prune runs after that, and if it fails the daemon
only warns and prunes again at the next backup or start. The tab therefore reads the copies back
after every save and reports what they show: the copies removed, or the ones still on disk.

## Pool caches

A released native slot stays on disk so the next lease in its repository starts warm, with its
ignored dependencies and build output in place (see [Native pools](worktrees-and-checks.md#native-pools)).
The **idle-cache budget** caps how much those idle slots may hold across every pool, and **Keep
warm in each pool** is how many of each pool's most recently used idle slots the budget never
chooses. The budget is off by default, and Keep warm defaults to 2.

The table shows each pool's slots (leased, idle, quarantined, and room to grow up to its
maximum), its measured size, its idle cache, and how many idle slots the budget would remove.
Pool maximums stay in **Settings > Worktrees**; lowering one still never deletes a slot.

Removing a warm slot makes a later session in that repository slower: it starts in a fresh slot
and installs its dependencies again.

## Cleanup

What the idle-cache budget would remove now, read on demand from `GET /api/storage/pool-caches`
because it observes every slot through Git. Within each pool the warm slots stay; the rest are
taken least recently used first, across pools, until the idle total fits the budget. Each one
must pass the same bar as Safe prune, judged against the same observation the preview is built from: available, unreferenced by any task or check lease
(task worktree retention included), clean, merged into the remote default, registered, and with
no process in it. A slot that fails is listed under **Blocked** with its reason and the next is
tried; so is a slot the last measurement did not size. An unsized slot is never counted as empty:
until every idle slot has been measured, the totals read "at least", the tab says whether the
caches fit the budget is unknown and offers **Measure now**, and Overview reads "Unknown until
measured" rather than reporting a fit. **Never touched here** names leased and
quarantined slots, the warm slots, backups and the categories Storage does not clean.

Only a plan read for the current limits, sizes and slots is offered. While a newer read is
pending, Preview removal waits; if the plan cannot be read again, it is dropped and nothing is
offered, so slots chosen under a budget that has since changed are never removed. The same holds
for a preview already open: when the plan it was built from changes (the budget, a size or a slot
moves), the dialog says so and Execute stays disabled until it is previewed again. The daemon checks
the same thing itself, whatever the browser has heard: a `trimIdle` preview names only slots the
saved budget removes from the preview's own observation, and Execute rebuilds that preview before
removing anything, so a budget saved after the dialog opened refuses the run on the daemon.

**Preview removal** builds a Worktrees preview of exactly the listed slots (the `trimIdle`
action) and opens the same dialog Settings > Worktrees uses. Execute queues it on the Worktrees
cleanup queue, which checks owner, processes and Git state again before each removal; a slot
that no longer qualifies blocks the preview rather than quietly leaving it. Each slot is removed
whole with `git worktree remove`. Storage never picks through a slot's ignored files one by one,
because `.env` files, local databases and editor state live there too. Progress and any failure
are listed in Settings > Worktrees.

## Warnings

- **Storage limit**: warn when Mission Control uses this much, starting at **Warn at** percent
  of it (90 by default). Off by default.
- **Free-space floor**: warn when the volume has less than this free. 10 GiB by default.
- **A banner on the fleet** (on by default) and **a desktop notification when a warning starts**
  (off by default, and only when the browser allows notifications).

The Storage rail dot always shows a standing warning: red for low free space or a failed backup,
amber near the storage limit. Each warning is one occurrence with an id built from when it began,
kept in the operational `storage.alerts` value, so a restart reports the same occurrence and a
warning that clears and returns is a new one. The daemon reads that value once at start and
then holds the occurrences in memory. A write that fails, as one can on a full disk, does not
start the warning again under a new id; the same occurrence is written again on the next
recompute. Dismissing the fleet banner hides the occurrences it showed; a new occurrence shows
again.

The limits and the idle-cache budget are the `storage.limits` setting, saved with
`PUT /api/storage/limits` and carried by settings snapshots in the `storage-limits` domain.
