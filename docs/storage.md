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

The speech model voice addressing downloads lives in `voice/models/`, about 542 MiB for the
current model, and is counted under **Everything else**. It is removed only by the model manager,
which deletes an old revision once a new one verifies; see
[Voice addressing](voice.md#where-it-is-kept). Like everything outside SQLite, it is not in a
database or settings backup.

Supertonic 3 speech synthesis weights live under
`<state home>/voice/models/speech/<revision>/`. All ten voices share the seven
files (145.3 MB). The daemon verifies their SHA-256 digests and retires older
speech revisions after their replacement verifies. Settings backups exclude
these files. Synthesized speech stays in memory.

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

Before serving a capture-enabled directive, the daemon records the microphone owner in
an owner-only receipt under `voice/capture-grants/`. The receipt carries the launch
instance or verified process birth when available. A restart restores the pause
obligation before offering playback. Acknowledging a pause or verifying exit
removes the receipt.

The daemon atomically replaces `voice/speech-holds.json` in the state home with
an owner-only (0600) ledger before offering speech to a listener. Its entries
hold the job ID, purpose and private listener instance. Confirmation removes
the entry. Restart recovery may also record a supervisor name and job ID while
its process record under `voice/supervised/` is unreadable. This runtime file
contains no text or audio and stays outside settings exports.

Before handing off a job, the daemon also writes an owner-only `voice-speech-used`
marker containing only `true` at the root of the state home. It survives loss of
the entire `voice/` directory and remains after playback ends. If the ledger,
launch inventory and supervisor records all disappear, this marker distinguishes
the used state home from a first boot. Capture stays off while the daemon cannot
identify which listeners need to confirm silence.

#### Voice supervisor credentials

The packaged macOS shell can provision its own durable signing key for the daemon
it launches. When Voice is enabled or an earlier listener needs recovery, the shell
opens the key asynchronously using Electron safeStorage and the macOS Keychain.
The desktop window and daemon can start while a Keychain prompt is pending. If
the model and microphone are ready and there is no earlier listener to recover,
a capture-only helper can listen during the prompt. Once the key is available,
the shell waits for that helper to exit before transferring its capture lease
to a supervised helper. An owned daemon reads the public verifier over its
private Electron port when a supervisor report arrives. An adopted daemon keeps
its own trust settings. The encrypted value lives in the owner-only
`voice/shell-credential.json`. An external
launch service supplies `MISSION_VOICE_SHELL_CREDENTIAL_FD` or
`MISSION_VOICE_DEV_CREDENTIAL_FD` to the corresponding launcher and the matching
public verifier to the daemon. Pass the descriptor directly to the launcher process
(for development, `node --import tsx scripts/run-voice-listener.ts`). An unprovisioned
development listener supports capture only.

Each macOS supervisor atomically maintains `voice/supervised/shell.json` or
`voice/supervised/dev.json` (0600 in a 0700 directory). The record initially contains
the launch instance. Before the child can pass its startup gate it also contains
`pid` and `startedAt`, the OS process birth identity. The slot survives a daemon
outage until the daemon accepts that exact exit. It is machine-local runtime state.
Each supervisor holds its own advisory lock and can relay the other supervisor's
signed exit after checking the process has gone. A missing signature still requires
the originating launch service.

Provision a distinct Ed25519 private key once for each shell or dev supervisor.
Keep it in the launch service's protected credential store throughout launcher
and daemon restarts. Provisioning a new key for each launcher process strands
the old process's exit authority.

On each boot, the service passes the 48-byte DER PKCS#8 key to the launcher on
a dedicated inherited descriptor (3 or higher). It can send the key through a
private pipe and close the write end, or preopen a private file owned by a
different OS account before dropping privileges. Keep that file in a directory
inaccessible to the listener, with no group, other or ACL grants. The launcher
calls `createVoiceSupervisor(name, fd)` before spawning the listener. The import
closes the descriptor and clears its temporary buffer, including on failure.
A service with a protected key provider can supply a private Ed25519 KeyObject
directly. A missing credential must prevent a new speech announcement.

Only the public verifier is passed to the daemon. Every listener instance binds
that verifier to its launch nonce. Ordinary files owned by the listener's OS
account, including legacy keys in the Mission Control state home, cannot be
used as credential descriptors.

Use the supervisor's `launch(stateHome, executable, args, env, report)` for
speech-capable children. The report callback receives the instance, event and
signature, and resolves when the daemon acknowledges that report. It returns
`false` for a definitive refusal and throws when the outcome is unknown.
Before sending the start, the launcher resolves the state home and durably records its
own PID, boot identity and process start time. A signature binds these to the launch instance under `voice-retirements/`. It waits up to
five seconds for acknowledgement. On success it starts a confined shell that
waits on the launcher's pipe. The launcher records the sandbox child's PID and
signature before releasing the shell to exec the listener. Losing the launcher
before release closes the pipe and the listener never starts. Before releasing
the gate the launcher also subscribes to the child's OS exit event. That event
queues its signed retirement immediately. During a disconnect the exit stays
on disk for the next connection.

A replacement supervisor checks the recorded process with the OS. A missing process
or a different verified birth at the same PID establishes exit. It rereads the watch
and verifies the signature before reporting exit. A live process or an inconclusive
read keeps the launch pending. Older PID-only watches wait for that PID to disappear. The child can read the voice models and write to its own owner-only
`voice-retirements/scratch-announced-<digest>/` directory. The digest comes
from the recorded launch instance. On normal close the launcher removes its
scratch. After a launcher crash, retirement removes the same directory after
confirmed exit and retains the record until cleanup succeeds. Scratch cleanup
retries independently while the supervisor delivers other players' exits.
The child cannot read the other voice records or
write the daemon's ledger, launch inventory, receipts or exit evidence.
The macOS launcher uses `/usr/bin/sandbox-exec` and forbids spawning descendants.
Both macOS playback engines run inside the listener, so a child player cannot
outlive the process whose exit the supervisor reports. The Linux launcher requires
`/usr/bin/bwrap` and user namespaces. If confinement fails the player cannot
run. The launcher rejects a symlinked voice or model directory before announcing
the child and rechecks the directories before spawn. The supervisor uses the
instance it announced to report the child's exit. If the OS refuses to spawn
the child, pre-spawn validation fails after announcement, or the start
acknowledgement is lost, the launch helper returns the original error while
the supervisor delivers the signed exit independently. It replaces the PID record
with the instance and its exit signature in the same owner-only file hidden
from the listener. If storage is unavailable it
retains the exit in memory and retries the write. Each outstanding exit is
retried with backoff until the daemon acknowledges or definitively refuses it.
Each delivery attempt has five seconds to respond. A stalled transport leaves
the exit queued and allows delivery of the other launches' exits to proceed.
On service startup and daemon reconnect, call `retryPendingExits(stateHome, report)`
even when there is no child to launch. On disconnect or shutdown,
`pauseExitRetries()` cancels pending requests and timers. Forward the report
callback's optional fourth argument, an AbortSignal, to the HTTP request.
A capture-only listener can keep its existing launch path.

#### Voice launch receipts

Under `voice/supervised/`, the daemon writes one owner-only `announced-<digest>.json` per accepted start, by atomic rename. Its content is the private instance ID and its filename uses the SHA-256 digest of that ID. An authenticated exit removes only that instance’s file. These launch records survive the daemon and let it find possible players even before a launcher reconnects. The supervisor owns its separate process record in the same directory.

The daemon maintains an owner-only `voice/supervised-instances.json` by atomic replacement. It lists outstanding private instance IDs and can retain an unresolved record name during recovery. Keeping the inventory outside `voice/supervised/` lets the daemon ask every possible holder to stop if the directory disappears while the speech ledger is unreadable. A signed exit can clear its exact ledger hold even when the inventory is missing or unreadable. The exit marker also applies if the inventory is restored. Any separate hold for unknown launches still requires a complete inventory.

Before acknowledging a handoff or lifecycle write, the daemon syncs the staged
file, renames it and syncs the directory entries up to the state home. Receipt
removal also syncs its parent directories. A failed sync leaves the operation
unacknowledged.

Each accepted exit stores the instance and its supervisor's Ed25519 exit signature under `voice/supervised-exits/`, keyed by the launch receipt's digest. Recovery checks both the digest and the original issuer's signature before applying an exit. An older unsigned boolean marker requires a fresh signed exit. Records stay for the lifetime of the state home because signed start retries have no expiry and each launch instance is single-use.
