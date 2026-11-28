# Isolated worktrees

Running several agents in **one** working tree is a recipe for clobbering - one
agent's branch switch or edit lands under another's feet. Mission Control therefore gives every
new task, Workflow check, and approved manual development session an isolated checkout through
one daemon-owned native allocator.

The owner may be an ordinary checkout or a bare clone. A bare clone owns its native pool
through its physical Git directory, and tasks execute in linked working checkouts. The
disposable Git fallback supports the same owners. Bare metadata named `.git` is still the
owner itself, not its parent folder. For bare metadata named `.bare` or `.git`, pool and
checkout names use the containing repository folder's name so working checkouts are not
named like hidden metadata.

One tree per session, with one exception. A
[multi-repo task](dispatch-and-backlog.md#attaching-more-than-one-repository) is dispatched
with a worktree per attached repository. Each comes from that repository's native pool, or
from a disposable Git worktree when native allocation is disabled or positively cannot
reserve a slot, and all of them are handed to one session. Everything on this page then
applies per tree: each is leased, pinned and reclaimed on its own. Provisioning is
all-or-nothing, so a dispatch that cannot cut one of them hands back the ones it already took
rather than starting an agent with half its repositories.

### Where a dispatch starts

An ordinary task - one whose caller named no commit - freezes a base before anything is
provisioned. Mission Control proves whether the repository has a remote named exactly `origin`,
fetches it, then asks that remote for both halves of one answer: which branch it advertises as
HEAD, and the commit that branch is on. The frozen base is the commit the remote stated, and the
local remote-tracking ref has to agree with it - which is what proves the fetch brought that exact
object down. A remote that advanced between the fetch and the observation disagrees, and is
refused for retry rather than quietly frozen at the older commit. Every repository the task
attaches is frozen the same way
and before the first worktree is taken, so a failure in the third repository costs an error rather
than two leases to unwind.

The refusals are deliberate. A configured `origin` that cannot be fetched, a remote HEAD that
cannot be proved, and a default branch that was advertised but not fetched all fail the dispatch
before any tree or agent exists. So does a `git remote` listing that never answered - only a
listing that succeeded and did not name `origin` establishes a repository with no remote, and only
that repository freezes its current local `HEAD` instead. The remote is asked rather than the
checkout's cached `refs/remotes/origin/HEAD`, because a fetch does not refresh that cache after a
server-side default-branch rename. When another fetch wins Git's remote-tracking-ref update race,
Mission Control retries that known-safe local refusal up to two times. Authentication, network,
timeout, overflow, and every other fetch failure still fail closed without an automatic retry.
A fetch stopped by its 30-second limit says so, with the limit, rather than reporting an exit
status Git never returned.

A repository with `origin` configured but no refs at all is refused before anything is fetched.
That is what a `git clone` looks like while it is still downloading, since it writes config and
`origin` first and its refs only once the whole pack has arrived. It is also what a repository
that was initialized and given a remote but never fetched looks like. Fetching either would
download the entire history inside a limit sized for an incremental update, beside any clone
still writing the same object store, and a large repository cannot finish. The task returns to
Backlog saying the repository has no commits yet: let a running clone finish, or run
`git fetch origin` in it once, then launch again.

Bare clones are fetched into `refs/remotes/origin/*` explicitly, since `git clone --bare`
does not create that fetch mapping. The same rule keeps mirror fetch configuration from
rewriting local branches used by linked worktrees. Remote-default freshness checks remain
the same as for ordinary clones, and the verified branch is recorded as `origin/HEAD` for
local status and reset operations.

An explicit pinned base bypasses all of this: it is verified to be a real full commit ID in that
repository and used unchanged, with no fetch. A pin names one commit in one repository, so a
task's attached repositories still resolve their own remote defaults.

### Native pools

Native pooling is enabled by default. The daemon lazily creates exact-commit, detached Git
worktrees beneath `MISSION_HOME/worktree-pools`, keyed by Git's physical common directory rather
than by the checkout path used to reach it. Released slot directories remain in place so ignored
dependencies and build caches stay warm for the next lease. Slot counts bound a pool, not its
bytes; **Settings > Storage** measures them and offers an idle-cache budget whose removals run
through the same previews and queue as this page (the `trimIdle` action). See
[Storage](storage.md#pool-caches). A repository-specific disable uses a
cold disposable Git worktree beneath `MISSION_HOME/worktrees` instead.

The allocator serializes new Git worktree creation within each repository. Distinct slot
paths still share Git registration metadata, and a concurrent creation can see a registration
before its `commondir` file exists. Slot reservations remain short; resets and setup commands
do not hold this creation lock.

A slot never crosses a task boundary holding a branch. Reset detaches the checkout at the exact
requested commit before it hard-resets and cleans, and both state transitions that hand a slot on
- finalizing a lease and marking a returned slot available - independently prove path, repository,
exact HEAD, cleanliness and detached HEAD from Git before they complete. An attached slot, or one
whose detached state cannot be proved, is quarantined rather than leased. That makes acquisition
repair a warm slot left attached by an older build on its next use.

Detaching releases the checkout, never the name: the previous occupant's branch ref stays exactly
where it was, and the reset's clean step still spares ignored files, so warm caches survive.

Every slot carries a random lease ID and an exact task, check, or manual owner. Task and check
rows persist that ID before work starts. Cleanup reads the recorded provider and lease ID rather
than deciding again from current configuration, and refuses a stale lease or any slot whose
process occupancy cannot be proved empty. Startup reconciliation uses the same fail-closed rules.

An observation read gets one retry before it counts as unknown. The process and cwd listings
behind occupancy and an owner lookup that throws each try once more in the same pass, 2 seconds
later and with double the timeout. A listing too large to buffer is not retried, because asking
again cannot make it smaller. So do `git worktree list` and each Git read of a slot
inspection when they timed out or were killed; a Git that exited with its own error is answered
at once, because it would say the same again. A PID that an otherwise healthy cwd listing
omitted is first re-read on its own, one at a time and stopping at the first re-read that does
not answer, and only one that is still unresolved, and still alive with the same start time,
leaves occupancy unknown. A read that fails twice records both attempts, for example "git status
timed out after 15 s, and after 30 s on retry". A command killed at its timeout is named as a
timeout, and one killed by another signal names that signal, so neither reads as "exit 1".

Git registration and slot-inspection reads discard inherited repository selectors so each read
targets the named checkout. A successful HEAD read must contain a full 40-character commit ID; malformed
output is an unknown observation and receives the same bounded retry. If an available slot's
HEAD differs from the recorded commit, reconciliation inspects it again under the slot lock.
Only the same mismatching HEAD from the same checkout and repository on both reads establishes
a moved-HEAD state quarantine. Disagreeing or failed reads produce a recoverable observation
quarantine without changing the recorded commit. The quarantine diagnostic includes the recorded,
observed and, when available, confirmation SHAs.

**Quarantine** takes a slot out of rotation, and records why, as which kind of fact, and when.
The kind is a persisted, append-only category that decides whether the slot can come back on its
own; the reason text is only for people and is never read to decide anything:

- **observation**: an observer did not answer - the process listing, a Git read, the
  registration list, or a domain-ownership lookup. Nothing is known to be wrong with the slot,
  so Reconcile returns it to available once it proves the slot idle again - provided it holds
  no lease. Recovery never releases a lease, so an observation quarantine taken while the slot
  was leased (its owner lookup did not answer) stays until its owner returns it or an operator
  destroys it.
- **state**: a positively observed fact makes the slot unsafe to hand out - dirty or untracked
  work, an occupant, a wrong path or common directory, a moved HEAD, a missing or unsafe
  registration, a pool marker that is absent, malformed or names another pool, or lease
  identity that is stale or incomplete. A marker read that does not answer is none of these:
  it defers the pass and quarantines nothing.
- **transition**: an allocator or setup mutation failed or its outcome could not be proven - a
  reset, a creation, the setup command, a dependency-claim record, a lease commit, a return, a
  removal, or an intent startup found interrupted.

State and transition quarantines stay until an operator acts on them, however healthy the slot
later looks. `quarantined_at` is written only by the transition into quarantine and cleared by
every transition out; observations never rewrite it, and a slot already quarantined is never
quarantined again with a new reason, category or time.

Acquisition quarantines only for positively bad facts: dirty or untracked work, an occupant, a
wrong path or common directory, an unsafe registration, or lease identity an available slot must
not carry. It screens every available slot, and a probe that does not answer for one of them
makes only that slot ineligible for this acquire. When no observed idle slot remains, the acquire
defers rather than adding a slot beside the unobserved ones or falling back to a disposable
worktree. If the occupancy recheck taken just after a slot was reserved does not answer, the
reservation is undone and the slot is available again exactly as it was screened, with its
release history; a process that did enter it is still quarantined.

Quarantines recorded before categories existed were classified once, when the database was
upgraded: a quarantine whose recorded reason was one only an unanswered observer produced became
an observation, and every other one has no category and is never recovered automatically. Neither
kind has a recorded time. A legacy observation that still holds a lease - most often "slot
occupancy became unknown before reset", whose reservation an older build never undid - is shown
as **Needs operator action**: Destroy it, since recovery never releases a lease.

If acquisition fails while a slot is still reserved, quarantine drops that exact never-granted
lease in the same version-checked write and preserves the failure reason. For older quarantines,
**Destroy** previews a stale lease when the domain lookup positively proves it is no longer
referenced, including a deleted task. It removes only the selected slot and does not reclaim
that task's other worktrees. After the final process scan, Execute rechecks durable ownership
and clears the stale identity with its prune intent in one synchronous database transaction.
Referenced leases still use their owner's cleanup; unknown ownership or
process occupancy blocks removal. Dirty and unlanded work still require acknowledgement.

`make session` is a loopback client for that daemon-owned inventory:

```sh
make session                                  # acquire, warm, and open your shell
make session ARGS="--label review -- claude" # label it and launch a command
make session ARGS="--return <lease-id>"       # return one exact durable lease
make session ARGS="--return-lease <lease-id>" # explicit spelling of the same action
```

Under the hood (`scripts/new-session.mjs`):

1. **Acquire** a manual lease from the running daemon's loopback API. When the pool has a
   [dependency claim](#dependency-claims), this waits for the claim, as described below.
2. **Warm** it (`scripts/worktree-setup.mjs`): install dependencies so the session starts fast.
3. **Hand it over** with `MISSION_WORKTREE` and `MISSION_WORKTREE_LEASE_ID` set, opening your
   `$SHELL` or the command after `--` in the tree.

**Waiting on a claim: 202, then poll.** A claim can run far longer than one HTTP request: up to
its `timeoutMinutes`, which may be 240. Node's `fetch` gives up after 300 seconds without
response headers, and a lease granted after its caller gave up would belong to nobody. So
`POST /api/worktrees/manual/acquire` has two answers. `make claude` goes through the same script
and gets the same handling.

- **The pool has no claim.** The route answers `201` with `{path, leaseId, baseSha}` straight
  away, as it always has, so a `make session` from an older checkout keeps working against a
  newer daemon.
- **The pool has a claim.** The route pins `HEAD` as before, answers `202` with
  `{requestId, baseSha}`, and runs the acquire in the background, claim included, under the same
  `manual:<key>` owner. `make session` polls `GET /api/worktrees/manual/requests/<requestId>`
  every 2 seconds. Each poll gets one of three states:
  - `claiming`, with `elapsedMs` and the running `step` (its number, the step count, the
    command and its own `elapsedMs`). `step` is null while the slot is still being chosen,
    reset or set up. The script prints the step and the elapsed time as it goes.
  - `granted`, with the `lease` and, when the claim failed, a `claimWarning` with the failing
    step and its output tail. A failed claim still hands the slot over, so the script prints
    the warning and opens the session anyway.
  - `failed`, with the `reason` the acquire was refused or could not be proven. The script
    prints it and exits without launching anything.

Pending requests live in daemon memory, never in the database:

- **A restart.** A poll after a restart answers `404`, and the script reports that the daemon
  restarted during the claim. Startup reconcile recovers the slot the claim was preparing (see
  "Crash and restart recovery" under [Dependency claims](#dependency-claims)). A grant made before the restart and never picked
  up is an ordinary manual lease, which **Settings > Worktrees** shows and can Return.
- **The pickup window.** A poll that reads `granted` picks the lease up. A grant nobody picks up
  within 10 minutes is returned by the daemon through the ordinary owner-authorized return, with
  its clean and occupancy checks, so a lease nobody received does not leak. A slot that is dirty
  or has a process in it stays leased, and Settings can return it. A poll that arrives after the
  window answers `failed`, never the returned slot.
- **Brief outages.** Each poll gets 5 seconds to answer, headers and body together, so a daemon
  that accepts a poll and never answers cannot hold the script. The script rides out a daemon
  that stops answering for up to a minute, counted from the first unanswered poll, so a restart
  reaches the `404` above instead of a connection error.

The lease stays durable after the shell exits. Return it explicitly with either command above,
using the lease ID printed by `make session` or exported as `MISSION_WORKTREE_LEASE_ID`. A slot path
is reusable and never authorizes a return. If the daemon is unavailable, `make session` tells you
to start it and exits without allocating a standalone worktree. **Settings > Worktrees** reads
and acts on the same durable lease. The command is useful from a shell; the panel adds the safety
preview and the surrounding pool, Git, process, and owner state.

Native capacity and enablement are configuration policy. The shipped policy is enabled with 16
slots per physical repository. A repository override affects its next acquisition, never an
active lease.

#### Orphaned slots

A slot is **orphaned** when Git no longer recognizes it. That is a narrow, positive finding: the
pool's identity and marker hold, the slot path is the pool's exact path, a `git worktree list`
that answered does not name it, and what is on disk proves it is no worktree. Either nothing is
there at all, or the directory has no `.git` link, or its `.git` file names an administrative
directory that does not exist. The path must also resolve to exactly itself, with no symbolic
link at the slot or in any parent component. Re-cloning the main checkout in place, or moving it aside and
cloning again, leaves every slot like this: each link now resolves into a repository that never
registered it. A slot whose link still resolves somewhere, a `.git` directory, a symbolic link,
or any read that fails is never orphaned, and whatever blocked it still does.

No Git proof can pass for an orphaned slot, so none is waited for:

- Settings marks it **not a Git worktree**, explains why, offers **Destroy** (and **Return**
  while its owner still references its lease, including a slot a failed Git read quarantined
  mid-lease), and never offers **Recover**. Reconcile does not promise to bring it back.
- An owner-authorized release (a task's cleanup, a check's recovery, or a manual return) cannot
  reset it. It hands the exact lease back without touching the files and leaves the slot in a
  **state** quarantine for the operator, so the owner is never pinned to a slot that can never be
  returned.
- **Destroy** replaces the cleanliness and default-branch blockers with one acknowledgement:
  any uncommitted or unpushed work in the slot cannot be checked and will be deleted. Execute
  releases the owner through its usual cleanup, rechecks every fact under the slot lock, and
  deletes the exact slot directory itself, because `git worktree remove` cannot remove what Git
  does not know. A slot with nothing left on disk needs no acknowledgement; only its row goes.
  Process occupancy still blocks, and is checked again immediately before the delete. The
  acknowledgement covers only the slots that were unregistered when the preview was shown: a
  slot that loses its registration afterwards is refused and needs a fresh preview. A sibling
  slot reached through its task's cleanup is released, never deleted, and the preview says so.
  The pool-wide **Destroy fixed pool set** uses the same path for every orphaned slot in it.

Copy anything worth keeping out of an orphaned slot before destroying it: Git can no longer show
what in it was never committed or pushed.

#### How the daemon deletes a tree

Every recursive delete of an operator tree the daemon makes - an orphaned slot's Destroy, an
orphaned task checkout's reclaim, dependency seed staging and seed paths, and archive staging and
deletion graves - goes through one helper, `removeTree` in `src/server/util/remove-tree.ts`. It
runs the platform's `/bin/rm -rf` as a child process rather than Node's `fs.rm`. The daemon runs
inside Electron, whose `fs` reads `.asar` files as virtual archives, and a checkout with
dependencies installed holds Electron's own
`node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar`. `fs.rm` there
neither deletes that file nor fails: it hangs, or reports `ENOTEMPTY` for every directory above
it. Turning Electron's `process.noAsar` off for the delete is not an option, because the flag is
process-global and every other file read in the daemon would see it while the delete ran.

Each delete has a deadline of five minutes, after which its process group is killed. An `rm`
that exits with an error, or exits cleanly while the path is still there, is retried twice, as
the `fs.rm` it replaced was, with a pause of 100 ms and then 200 ms; every attempt and pause
counts against the same deadline, and a Stop or the deadline ends the delete without a retry.
A delete that cannot finish, by its deadline or for any other reason, is a bounded, reported failure and
never a hang. The path is then checked again: an orphaned slot whose delete failed stays in a
**transition** quarantine, with the delete's own reason (for example `rm -rf exited with code 1`
and what `rm` printed), and Destroy can be retried. A failed reclaim renames the checkout back
to its slot, as described in [Orphaned task checkouts](#orphaned-task-checkouts). A dependency
seed's Stop or claim deadline kills a seed-path delete part-way and ends the seed. Registered
slots and check trees are removed by `git worktree remove`, which runs as its own process and
was never affected. Lint enforces the helper in `src/server/worktrees/` and `src/server/archives/`
(`repository/tree-removal`).

### Dependency claims

A warm slot keeps whatever its last occupant installed, which is not necessarily what the next
commit needs. A pool's **claim** closes that gap. It is an ordered list of dependency steps that
runs inside every task lease, every check lease and every manual lease, after the reset or add
and after the setup command on a new slot, and before the final proof. A dispatched task's slot,
a check's, and a `make session` slot therefore have dependencies for the commit they were leased
at. A check that falls back to a throwaway Git worktree runs the same claim there (see
[Check leases](#check-leases)). A manual lease waits on its claim through the 202-and-poll
described under [Native pools](#native-pools).

The claim is per pool, with no global default. It is stored beside `setupArgv` in that
repository's `worktrees` entry, so settings backups capture it, and it is set through
`PUT /api/worktrees/config`:

```json
{
  "repositories": {
    "/Users/me/code/web/.git": {
      "claim": {
        "steps": [
          { "argv": ["yarn", "install", "--immutable", "--mode=skip-build"], "env": ["ARTIFACTORY_AUTH_TOKEN"] },
          { "argv": ["yarn", "rebuild"], "env": [] }
        ],
        "timeoutMinutes": 10,
        "fingerprintPaths": ["yarn.lock", ".yarnrc.yml", "package.json", "apps/*/package.json", ".yarn/releases/**"],
        "seed": {
          "paths": ["node_modules", "apps/*/node_modules", "packages/*/node_modules", ".yarn/install-state.gz"],
          "exclude": ["**/node_modules/.cache"]
        }
      }
    }
  }
}
```

- `steps` holds 1 to 16 argvs, never a shell, each bounded like `setupArgv`. `env` lists up to 32
  variable **names**; Mission Control never stores a value. `PATH` and names starting with
  `MISSION_`, `FLEET_` or `HARNESS_` are refused, because those are the daemon's own.
- `timeoutMinutes` covers the whole claim, every step together, including the time spent
  building each step's environment and resolving its executable (either may wait on a
  login-shell read). A step only starts with time left, and gets only that remainder. It
  defaults to 10 and may be at most 240.
- `fingerprintPaths` holds up to 64 repository-relative globs. They are matched with Node's
  `path.matchesGlob`, so a wildcard does not match a segment that starts with a dot, and a
  dotfile directory is named literally (`.yarn/releases/**`). A glob that cannot be a
  repository-relative path is refused: a leading `/`, a `.` or `..` segment, an empty segment,
  or a backslash.
- `seed` is optional. `seed.paths` holds 1 to 64 repository-relative globs naming the ignored
  dependency trees a cold slot clones from a sibling (see "Seeding" below). Each segment is a
  literal name or a one-level pattern such as `apps/*/node_modules`. `**` is refused, because
  matching it would mean walking every installed tree to find what to clone. `seed.exclude` holds
  up to 64 globs removed from the clone before it is placed, and these may use `**`
  (`**/node_modules/.cache`). The seed is not a fingerprint input: it changes how a cold slot
  gets its dependencies, never which dependencies a commit needs.
- A patch's `claim` replaces the whole claim, and `"claim": null` removes it.

**Fingerprints.** Before a claim runs, Mission Control hashes three inputs:

- the Git object ids of every path at the leased commit that matches `fingerprintPaths`, read
  with `git ls-tree` from objects rather than from the checkout;
- every step's argv;
- every step's variable names.

The hash is recorded on the slot only after every step succeeds. When the next claimed lease
computes the same hash, the steps are skipped, so a slot that already matches costs nothing. Any
change to a matching file, an argv or a name runs the steps again. An empty `fingerprintPaths`
means the claim runs on every lease.

**Seeding.** A full monorepo install is the slow part of a cold slot, and an idle sibling slot
usually holds the very trees it needs. A claim whose pool configures `seed.paths` therefore
seeds before its steps run when either of these holds:

- the slot is cold: it is new, was never claimed, its last claim failed, or its last claim or
  seed was interrupted. A slot whose last claim succeeded is not cold, even when its claim lists
  no fingerprint paths and so recorded no fingerprint, or every lease would copy a sibling's tree
  over its own fresh install;
- its fingerprint is stale, **and** an idle sibling's fingerprint matches the leased commit's
  exactly. A slot whose last claim succeeded with no fingerprint, before fingerprint paths were
  configured, is stale as soon as the claim can compute one.

Otherwise the claim runs in place, so a small lockfile change stays an incremental install.

- **The source** is an idle sibling: an available slot of the same pool, with no active lease,
  whose last owner is provably gone, with no process inside, and whose last claim succeeded. It
  is screened by the same code acquisition screens an available slot with, so a sibling
  acquisition would quarantine is quarantined here too, and is never a source. The first choice
  is one whose fingerprint matches the leased commit's, and the next is the one most recently
  claimed successfully, including one whose claim recorded no fingerprint. A stale slot takes
  only the first choice. The main checkout is never a source. With no idle sibling
  there is no seed, and the steps run alone.
- **The `warm` lease.** The source is leased to a `warm` owner for the length of the copy,
  through the same reservation, `finalizeLease` and release paths as any lease. Nothing can
  lease, reset or quarantine it meanwhile: a process in a leased slot does not quarantine it, and
  another acquisition never sees it as available. Settings shows the owner as **warm**, "Seeding
  another slot's dependencies", with no Return or Destroy, and never as a task. The owner is
  referenced exactly while its seed runs in this daemon. Nothing about it is stored anywhere
  else, so at startup every `warm` owner is definitely not referenced. The source goes back to
  the pool through the ordinary owner-authorized return as soon as its clone is staged, before
  anything is placed in the target. A source is only read, so its fingerprint stays valid.
- **Copy-on-write only.** Each path is cloned with `cp -c -R` on macOS (clonefile). Where the
  filesystem cannot clone, `cp` refuses and there is no seed, and on any other platform there is
  no seed at all. It is never replaced by a byte copy, which would be slower than the install. The clone
  runs from the pool's directory, never from inside a slot. `cp` is the pinned `/bin/cp`, never
  a PATH search, because those flags are the platform's own: a GNU `cp` found first on a Mac
  would not clone.
- **Only ignored paths.** Every matched path must be ignored by Git in the target and hold
  nothing tracked (`git ls-files`, then `git check-ignore`, asked with a trailing slash for a
  directory). A path whose parent directory the target's commit does not have is left out.
  `.git`, in any letter case and at any depth, is never a seed path: the schema refuses it, and
  expansion drops it whether it was named or matched by a pattern, because on a case-insensitive
  disk `.Git` is the checkout's own Git administrative pointer.
- **Staging, then rename.** Each matched path is cloned into
  `<pool directory>/.seed-staging/<id>/`, on the same volume and outside every checkout, and the
  exclusions are removed there. Only then is each path renamed into the target, with any existing
  tree renamed aside first. A path in the checkout is therefore the old tree, absent for one
  rename, or the whole new one. The staging directory is removed when the seed ends. A Stop
  and the claim's deadline are checked before every rename and once more after the last, so a
  seed either one ends while it is being placed is recorded `interrupted`, never `current`, even
  when its source matched the leased commit.
- **After a seed** the target inherits the source's fingerprint, and the ordinary skip rule
  decides. A source that matched the leased commit records `current`, and the steps are skipped.
  Any other seed is followed by every step.
- **An incomplete seed inherits nothing.** A seed inherits the source's fingerprint only when
  it replaced every seed path the target has with the source's own. It is incomplete when an
  exclusion removes a whole matched path (the target keeps its own copy), when a source path is
  left out because the target's commit lacks its parent directory, or when the target holds a
  seed path the source does not have (the target's own, possibly stale, copy stays). Then what
  was placed is not the source's tree, the target inherits no fingerprint, and every step runs.
  Exclusions that remove every path are no seed at all: the target is untouched and the steps
  run.
- **A failed clone** abandons the seed, removes its staging, and the steps run. It is not a
  failed claim, and the target was never touched. So does a placement whose first rename fails
  before anything in the target changed, as when the cold check fallback's tree sits on another
  volume than the pool's staging and the rename is refused with `EXDEV`. A rename that fails
  after something was placed or moved aside records `interrupted`.
- **One deadline.** The seed spends the claim's `timeoutMinutes` together with the steps. Every
  phase of a seed checks the Stop and that deadline: expanding the globs, proving the paths
  ignored (each Git call is bounded by what is left of the claim's time, and by a minute at
  most), each clone, the exclusion walk, and placement. Whichever lands first ends the seed as
  `interrupted`. The interrupted wipe works within the same budget: it checks both before each
  Git call and between the entries of every seed path it removes, so a large `node_modules`
  cannot hide a Stop, and a wipe that a Stop or the deadline ends leaves the slot `interrupted`.
- **An exclusion walk that cannot read** a directory in the clone, or cannot look up the staged
  clone itself, for any reason other than it having vanished, abandons the seed and the steps
  run. The excluded content may
  still be in that directory, so the clone is never placed.
- **A tree that cannot be inspected is never read as empty.** Expanding the seed paths treats
  only a path that is genuinely not there as no match. A permission or I/O error while listing a
  directory or looking up a path abandons the seed, so the steps run, and fails an interrupted
  wipe without removing anything, so the slot stays `interrupted` and its next claim tries
  again.

**The environment.** Each step gets the same scrubbed base a check command gets (see "A trimmed
environment" under [Running a check command](#running-a-check-command)), plus only the variables
its own `env` names:

- A named value comes from the daemon's environment, or else from the operator's login shell.
  The locator's login-shell read, the same one that reads `PATH`, captures the named variables
  alongside it. A value that is empty everywhere is missing, and so is one that carries the
  daemon's own token.
- A credential reaches only the step that names it and the setup command, which receives every
  name the claim lists, as described below. Another step and a check never receive it.
- Stdin is closed, so a step that stops to ask a question fails at once.

**The setup command's environment changed too.** Setup still runs once, when a slot is created,
for every lease kind, with its 120-second limit. It now runs on the same scrubbed base, plus the
union of every name the pool's claim lists. A setup command that relied on a credential-shaped
variable from the daemon's environment, such as `NPM_TOKEN`, no longer receives it. List the name
on a claim step to give it back. A failed setup's reason has every value it received replaced with
`[NAME redacted]` before it is stored as the slot's quarantine reason and reported by the
inventory, as a claim step's tail is.

**Output, timeout and failure.**

- Each step's stdout and stderr stream into one 4,000-byte tail, the same bound checks use.
  Output size never fails a claim.
- A step may print the variables it was given. Before a failure is stored, reported by the
  worktree inventory or written into the agent's note, every value the step received is replaced in its tail and
  reason with `[NAME redacted]`. The tail keeps only the end of the output, so a tail that
  starts partway through a value has that leading piece redacted too, when it is at least four
  characters long. Every match is found in the original output before anything is replaced, so
  values that overlap or contain one another are all removed, and overlapping matches become one
  marker naming each variable, such as `[A_TOKEN, B_TOKEN redacted]`. A value the step transformed before printing, for example by encoding it,
  is not recognized.
- The slot row records a failure as a versioned JSON record: the step, the step count, the
  command (cut to 512 bytes), the reason, the tail and how many bytes the tail dropped.
  The worktree inventory reports those fields directly. A failure an earlier build stored as
  plain text reports only its first line, the command and the reason. Its output is never sent
  to the browser, because it was stored before redaction existed and may hold a value that
  cannot be recognized now, for example one since rotated. The inventory marks the output as
  withheld, and the slot's next claim replaces the record.
- A timeout sends SIGTERM to the step's process group, then SIGKILL after five seconds, and
  counts as a failed claim.
- A failure is a non-zero exit, a timeout, or a step that cannot start. The remaining steps do
  not run. The slot is **handed over with a warning and never quarantined for the exit code**.
  The slot's fingerprint stays cleared, so the next lease runs the claim again.
- The agent's launch prompt then opens with a "Dependency install warning" note. It names the
  failing step, its command cut to 512 bytes, and its output tail, so the agent can install or
  repair dependencies itself, and can tell a dependency failure from one its own change caused.
- Claim steps must not rewrite tracked files. A claim that leaves a tracked file modified, an
  untracked file Git does not ignore, or a branch attached fails the final proof, and the slot
  is quarantined as any other unproven materialization is. `yarn install --immutable` is one way
  to honor that.

**Crash and restart recovery.** Before anything touches the tree, one durable write records the
slot's `deps_state` as `claiming` and clears its fingerprint. A seed writes `seeding` the same
way once its source is held, before any clone starts. Success then records `current` with the
new fingerprint, and failure records `failed` with the failing step and its tail. A daemon that
dies anywhere after that write leaves no fingerprint for a later lease to trust. Startup finds
the slot still `provisioning` and quarantines it as an interrupted provisioning intent, exactly
as it does after a restart during setup, and marks its `deps_state` as `interrupted`, whether it
found `claiming` or `seeding`. That marking happens on every reconciliation path, including one
that quarantines the whole pool because its identity or marker cannot be proven. If that slot
ever returns to the pool, its next claim first removes the pool's seed paths, then starts cold:
it seeds if a sibling qualifies, and runs every step either way. That recovering claim never
skips the steps on an inherited fingerprint, even from an exact match. The write-ahead does not
record which seed paths the cut-off seed touched, and the operator may have narrowed
`seed.paths` since, so the wipe can only remove the paths configured now. The steps repair
whatever an older configuration's seed left behind.

- **The interrupted wipe** removes a seed path only once Git confirms it is ignored and holds
  nothing tracked. A matched path that is tracked, or not ignored, is never removed, and then
  nothing else is either: the claim fails with a warning naming the path, and the lease is
  granted with it. A wipe that fails partway, after removing some paths, fails the same way.
  Either way the slot stays `interrupted` rather than `failed`, so the obligation to remove its
  seed paths stays with it and its next claim tries the wipe again before anything else. A pool
  with no `seed.paths` has nothing to remove, and the claim runs every step.
- **A seed source** that a crash left leased to its `warm` owner is returned at startup through
  the ordinary return path: the occupancy check, the reset to origin's default, and the clean,
  detached proof. It becomes available with its fingerprint intact. A source the return cannot
  prove, for example one a process is still inside, is quarantined.
- **Seed staging** under `<pool directory>/.seed-staging/` that no live seed owns is removed by
  every reconciliation, first, before any check that can fail the whole pool. A pool whose
  identity or marker cannot be proven still loses its leftover staging, because removing it
  touches no checkout. It is removed only when the pool's directory lies inside the daemon's
  pools directory and the staging root is a real directory there, never a symlink.

A claim step's process group that outlived the daemon still has its working directory inside
the slot. The occupancy check therefore sees it, and the slot is never handed out while it runs.

**Maintenance and shutdown.** The manager keeps an in-memory registry of the claims running
right now. Periodic maintenance skips a slot whose claim is running instead of waiting for it,
because a claim may run for hours. The pool's reconciliation record names the skipped slot, and
the next pass retries it. Shutdown kills every running claim's process group before anything
else stops, and grants no claimed lease from then on. The slot is left `provisioning` with
`deps_state = claiming`, and the next startup recovers it as above.

**Stop and task cancel.** A running claim can be stopped from the task card of the dispatch
waiting on it, which sends `POST /api/worktrees/:slotId/claim/stop` with the running claim's own
id, so a Stop can never land on a later claim in the same slot. The
manager finds the claim through its claim registry, sends SIGTERM to the step's process group
(SIGKILL after five seconds), and fails the claim with the reason "was stopped". The slot is
handed over as for any failed claim: the lease is granted with the warning, `deps_state`
becomes `failed`, and the next claim reruns the steps in place. The dispatch then continues and
launches its agent with the warning note. A route answer of 404 means that claim had already
finished. A manual lease's claim has no task card; the same route stops it, and `make session`
then receives the grant with the warning.

Cancelling a task whose dispatch is waiting on a claim stops that claim too, once the task is
recorded as cancelled. A cancel that finished while the dispatch was still on its way to the
acquisition stops the claim as it registers, before its first step. The stopped claim hands its slot over at once, the dispatch finds the
task settled, and it tears the tree down exactly as it does for any cancel it notices. A task
with attached repositories provisions them one at a time, and stops provisioning further
repositories once the task is no longer dispatching, so no later repository's claim starts in
place of the stopped one. A Stop, a cancel or the claim's timeout decides `deps_state` by when it
lands. During a step it records `failed`, like any failed claim, and the next claim reruns the
steps in place. During a seed, including while its paths are renamed into place, it records
`interrupted`, because the renames may be half done,
and the next claim removes the seed paths and starts cold. Either way the lease is granted with
the warning.

**What the task shows.** While a dispatch waits on a claim step, its placeholder in the Board's
and the Console rail's Working group says **Installing dependencies**, with the step, the
elapsed time and **Stop**, in place of "Provisioning its worktree". It is the task's
`provisioning` field, a projection of the claim registry that the daemon derives on every
`task_upsert` and re-sends as the claim starts a step or ends. It is never stored, so a restart
drops it with the claim. A dispatching task stays `dispatching` while it claims, so Foreman keeps
counting it against its session limit. After the lease, each failed claim is recorded on the task
as `claimWarnings` (the `tasks.claim_warnings` column, cleared by the next dispatch), and the
session's task band shows it as **Dependency install failed in `<repository>`**, with the step,
its reason, the command and the output tail.

**What the inventory reports.** `GET /api/worktrees` reports each pool's claim and, for each
claim variable name, only whether a step would receive a value and from where: the daemon's
environment, or the login shell. This is the same rule a step's environment uses, so the two
cannot disagree, and the value itself never leaves the daemon.

Each slot of a pool with a claim reports one dependency state:

| State | Meaning |
|---|---|
| never installed | No claim has run in this slot. Its next task or check lease runs every step. |
| current | The last claim succeeded, and its fingerprint matches the claim's fingerprint at the fetched default branch. Also shown when no default can be read, or when the claim lists no fingerprint paths, since neither is evidence of staleness. |
| stale | The last claim succeeded, but the fetched default branch's fingerprint differs from the slot's. The next lease runs the claim again. |
| installing | A claim is running in the slot right now, with its claim id, its step, its command and its start time. |
| failed | The last claim failed, timed out or was stopped, with the failing step, its reason, its command and the output tail, claim variable values redacted. |
| interrupted | A restart, or a stop or timeout during a seed, cut off the slot's last claim. Its next claim removes the seed paths and starts cold. |

It also names the commit the slot's fingerprint was taken at. **Stale is judged against the
last fetched `origin/<default>` ref**, the same cached ref the slot's "Default" relation uses.
Building the inventory never fetches. The default branch's fingerprint is read once per default
commit and claim with `git ls-tree` in the main checkout, and reused until either changes. A claim
publishes the ordinary `worktrees_changed` revision bump as it starts, as each step starts, and as
it settles, so a dashboard reading the inventory follows the claim as it runs.

### Settings > Worktrees

Open **Settings > Worktrees** to configure and inspect the allocator. The page answers one
question first - do I have room, and what is holding the rest? - and is split into three groups, in
this order:

- **Pools** leads. Each repository gets one full-width capacity bar whose *track width is that
  pool's configured maximum*, so free capacity, leased slots, quarantine, and overflow read in one
  glance. The bar's segments are leased, available, and quarantined, and the hatched remainder is
  room to grow. Because the track is the maximum and not the occupancy, one slot is the same
  fraction of every bar sharing a maximum, and a bar cannot grow past its own ceiling. Over
  capacity is therefore not a fourth segment and not a wider bar: a pool past its maximum fills
  the track and spills, marked by an amber hatched cap at the track's end and counted in words
  beside it. The tradeoff, taken deliberately: when the slots that fit already consume the
  ceiling, a small trailing state has no width left to draw, so the legend - not the fill - is
  where every count is guaranteed to appear.

  Nothing on the bar is carried by colour, or by the absence of it: the legend beneath
  it names all four lifecycle counts as text in every state - **zeroes included**, because a state
  the track has no width to draw is still one you came here to ask about - the bar itself is an
  image with a composed label naming those same four counts and the maximum, and over capacity is
  spelled **over the maximum** in words. An over-capacity pool offers its right-size preview on
  that row.

  Opening a pool's disclosure shows its effective override, an optional setup argv, the maintenance
  actions, and the bounded slot detail. The argv is operator-authored, stored as separate arguments,
  and runs only when Mission Control creates a new slot. It never runs when a warm slot is leased
  again. It runs on the scrubbed environment described under
  [Dependency claims](#dependency-claims). Each slot carries its exact manager path, observed HEAD,
  relationship to the remote default, cleanliness, process count, disk estimate, and owner.
  A quarantined slot also shows its quarantine reason, how long ago it entered quarantine (hover
  for the exact time, or "Quarantine time not recorded" for one quarantined before the time was
  kept), and either **Reconcile returns it once re-proven** for an observation quarantine that
  holds no lease or **Needs operator action** for any other, including an observation
  quarantine that still holds one. The time is the moment of the transition, so a slot
  observed many times since still shows when it was quarantined. An
  [orphaned slot](#orphaned-slots) is marked **not a Git worktree** and never offers **Recover**.
  It offers **Destroy**, and also **Return** while it holds a lease its owner still
  references, whether leased or quarantined. Return releases the lease and keeps the slot
  quarantined with its files.
  **Copy path** stays in the browser.
  **Open terminal** asks the daemon's registered terminal launcher to open a login shell in the
  manager-known path.

  The group states loading, empty, and unavailable separately, and never renders a heading over
  nothing. An inventory that could not be observed says so and offers Refresh; it is never drawn as
  zero pools.
- **Defaults** controls the default enablement and maximum, and affects future acquisitions only.
  Each bar above is drawn against its own pool's *effective* maximum, which is **Default maximum
  slots** for every repository that has not set an override - so changing the default visibly
  reflows those bars, and leaves an overridden pool's bar where its own maximum puts it. Lowering
  a maximum below the pool's current count marks the difference **over the maximum** and offers a
  right-size preview; saving policy never deletes a slot.
- **Treehouse** classifies historical Treehouse resources as exact, unverifiable, foreign, or
  unreadable, and shows the four classification counts only when at least one is non-zero. Only an
  exact durable owner with a clean, process-free checkout offers Return.

All mutations begin with a server preview. The dialog lists the fixed paths, owners, disk estimate,
risks, blockers, and consequences. The disk estimate has a short budget: a warm slot with its
dependency install can take seconds to measure, so a preview measures at most four paths at a
time within one budget for the whole set, and any path it could not measure in time reads
"size unknown" instead of holding the dialog. Dirty or unlanded exact targets require an explicit
acknowledgement.

**Execute runs in the background.** The daemon answers as soon as it has consumed the
short-lived token and checked that it is still allowed and that the acknowledgements are exactly
the ones the preview asked for. The dialog then closes, and the rest of the work goes into one
ordered queue: it observes the lease, task or check owner, processes, Git state, and slot version
again, then mutates. You can keep previewing and executing while earlier cleanups finish. Queued
and running cleanups are listed above the pools, and each affected slot shows the pending action
and offers no second one. A preview that names a slot which already has a cleanup queued is
blocked for that slot, and Safe prune leaves such a slot to its own cleanup, so no dialog offers
an Execute that could only be refused. At most 64 operations may be listed at once, counting queued and running
cleanups and failure reports you have not dismissed. Beyond that, Execute says so and leaves the
preview open, so it can be executed again once there is room. A failure report is never removed
to make room: it leaves only through **Dismiss** or an accepted retry.

A changed target fact or affected set refuses with a stale preview message. Because the recheck
runs after Execute has answered, that refusal appears in the same list above the pools, with
**Preview again** to build a new preview of the same request from current state, and **Dismiss**.
A report stays listed until you dismiss it or its **Preview again** is executed; cancelling that
retry keeps it. A stale refusal changes nothing on disk. A failure partway through a set of removals is reported
as **partly done**: it lists each worktree already removed, says how many were left in place, and
its **Preview again** asks only for the ones it left. A destroy is always retried as the fixed
set of slots it was accepted with, minus those already removed, so a pool destroy's retry never
picks up a slot that joined the pool after the failure. Process churn in unrelated slots and inventory reconciliation
timestamps do not invalidate an unchanged target. Unknown process occupancy is never
acknowledgeable.

The operations have deliberately narrow meanings:

- **Return** hands an active lease back through its owner. Task Return uses the ordinary task
  cleanup, including multi-repository accounting and required archive or snapshot capture. Its
  preview therefore lists every native, legacy, or disposable Git path that task cleanup will
  touch, even when Return began from one slot. Check Return uses the recorded check provider and
  process-group recovery. Manual Return uses the exact durable lease. A successful native Return
  resets to the freshly fetched remote default - the branch the remote advertises now, proved the
  same way dispatch proves it - leaves the slot detached and clean, and keeps the warm slot.
- **Prune** removes only the clean, merged, process-free, unreferenced available slots enumerated in
  its preview. Right-size is the same safety rule restricted to capacity above the configured
  maximum.
- **Reconcile** re-observes durable state, Git registration, ownership, and processes. It repairs
  only states whose result is positively proven. An unknown process scan, an unreadable Git
  registration list, or a pool marker whose read did not answer (an I/O error or a denied open)
  leaves slot states and lease versions intact and records a pool diagnostic; it authorizes no
  recovery or return, and acquisition, return and removal each refuse a pool whose marker they
  cannot verify. A marker that is positively absent, malformed, or names another pool is a
  **state** fact instead, and quarantines every slot in the pool. Acquisition also defers without fallback when idle-slot
  occupancy cannot be observed. Only an **observation** quarantine is automatically recoverable. Such a slot
  returns to available only when its pool identity, marker, exact path, safe Git registration,
  common directory, cleanliness, detached HEAD at exactly the commit the allocator last recorded
  for it, merge into the observed remote default, and empty process occupancy are proven again.
  It must carry no active lease identity, and any last-released lease must be complete and no
  longer referenced by its owner. The recovery is one compare-and-swap on the slot version that
  itself refuses any other category, an active lease, or a moved HEAD. Startup and maintenance
  use the same recovery. Recovery clears the old quarantine diagnostic and its time without
  resetting or deleting files, preserves release history, and leaves active, dirty, moved,
  attached, unmerged, missing, or unverifiable slots protected. A **state** or **transition**
  quarantine, and an uncategorized legacy one, is never automatically recovered: use Recover
  when unleased, or Return it through its owner. After **Reconcile**, use **Preview safe prune** to review recovered slots;
  removal still checks safety again at execution. A new blocker appears in the pool's
  reconciliation diagnostic while the slot retains its original quarantine reason, category and
  time until recovery succeeds.
- **Recover** is offered on a quarantined slot with no active lease identity. Its preview shows
  the original reason, category and time and every recovery check, naming any failed or
  unavailable check. No acknowledgement overrides a failure. Execute uses the background queue,
  rejects stale previews, and repeats the same safety proof as automatic recovery before a
  version compare-and-swap. The operator may recover any category, including legacy quarantines.
  Success clears the diagnostic, preserves release history and warm dependencies without changing
  files, and logs `quarantine_recovered` with the operator authorization. Automatic recovery
  remains limited to observation quarantines. Recover shares the 64-operation queue limit.
- **Destroy** removes one exact manager-owned slot, the fixed slot set enumerated for one pool, or
  a bulk selection. Each destroyable slot has a checkbox, and a pool's **Select all slots** adds
  every destroyable slot in it; the selection may span pools. **Destroy selected** previews exactly
  the ticked slots as one fixed set, so one Execute queues the whole cleanup. The selection is
  exactly what you ticked and is never narrowed for you: a selected slot that has since
  disappeared stays in it, the selection bar counts it as no longer available, and the preview
  names it and is blocked until you clear or change the selection - even when every selected
  slot is gone. One selection holds at most 128 slots, the most one bulk request may name:
  **Select all slots** fills the remaining room and says how many did not fit, and an unticked
  slot cannot be added while the selection is full.
  Destroy may discard dirty or unlanded work only after those risks are acknowledged. It has no target
  meaning every pool and cannot override unknown identity, ownership, registration, or process
  state.
- **Return legacy lease** delegates to the task or check owner and then the conditional Treehouse
  adapter. There is no force action for unverifiable or foreign resources.

Native slot cleanliness allows a narrow set of untracked ai-conductor scratch files at the
checkout root: `.pipeline/.memory-count-at-start`, `conduct-state.json`, `engineer-run.json`,
`HALT`, `HALT.class`, `DONE`, `events.jsonl`, and `.pipeline/gates/<step>.json` (all files are
under `.pipeline/`). Inspection leaves them in place. Safe removal cleans only those files,
then asks Git to remove the worktree without force. Tracked changes, symlinks, and unknown
untracked paths, including other files under `.pipeline/`, still block safe pruning. The
merge, process, lease, and owner checks apply as usual.

Inventory is an observation, not a second owner database. Open dashboards receive only a
content-free change signal and fetch the bounded view again. They do not receive raw process
commands, Git diffs, environment values, or unbounded errors.

### Legacy Treehouse compatibility

Treehouse is not an installation, configuration, or runtime prerequisite. New tasks, checks,
and manual sessions never probe or acquire from it, and the repository has no `treehouse.toml`.
The persisted provider value remains valid only so upgraded databases can account for resources
that an older Mission Control acquired.

The compatibility bridge reads only repositories named by durable Treehouse task or check rows.
It never scans workspace roots or reaps an external pool in the background. Treehouse v2.1.1 or
newer supplies JSON status and conditional return. A return requires the persisted lease ID,
exact path, expected holder, a matching live status row, a clean checkout, and proven-empty
occupancy. It then passes both `--if-lease-id` and `--if-lease-holder` and confirms the lease
disappeared or changed before the task or check owner clears its fields.

Most historical rows predate lease-ID persistence. Those resources are reported as
`identityUnverifiable`; a path and familiar holder cannot distinguish the original lease from a
later same-holder lease. Missing binaries, old versions, malformed status, foreign status rows,
dirty trees, and uncertain occupancy are also read-only. Mission Control keeps their rows and
prints an actionable diagnostic instead of guessing. A missing Treehouse binary blocks only
cleanup of those historical resources. Native allocation continues normally.

To investigate one, run `treehouse status --json` in the recorded repository. Resolve foreign or
unverifiable leases with Treehouse itself after verifying their current owner. Remove the external
Treehouse pool and installation only after **Settings > Worktrees** reports no durable legacy rows
and every foreign lease has been reviewed. `MISSION_POOL_REAP_MS` is retired and ignored; if it remains set, startup names
`MISSION_WORKTREE_SWEEP_MS` as the native maintenance replacement.

### Task worktree retention

Final completion records the outcome and closes the owned session. Kill requests a stop, and
the normal exit handling settles a task whose session disappears. All three paths leave the
checkout for background retention. The initial handoff to a shipping workflow keeps the
checkout while the workflow owns the work.

The clock starts at the first verified owner-free observation after the last tracked session
leaves. Idle sessions and exiting cards still in their linger period hold their checkouts.
Board filters and folding do not change that inventory. Hidden discoveries, subdirectory users,
attached repositories, hibernation, and launch, resume and transfer reservations also count.
SDK sessions keep their additional checkout grants through exit linger and restart, including
sessions launched without a task binding.
If a session returns, it invalidates the deadline and any pending cleanup claim. Its next
verified departure earns a fresh window. Restart preserves a verified deadline. An older ledger
without a verified departure earns a full window on its first eligible observation.

One task has one deadline across its primary and attached repositories. Changes to HEAD, the
index, tracked files, or non-ignored untracked files grant a fresh window from observation.
Ignored file churn leaves the clock alone. Ignored files still block deletion because their
contents may include local work. The observer runs every six hours, so the deadline is the
earliest possible release.

At release, the daemon rechecks task and provider ownership, Git registration and activity,
and process occupancy. After occupancy and publication verification, it fingerprints
Git activity and confirms the published HEAD in a clean status scan that includes ignored
files. A final index check protects files hidden by Git index flags. The daemon verifies
publication against refreshed origin tracking refs, without applying the repository's configured
fetch mappings to local branches. An unfinished Git operation also blocks return.
Disposable Git worktrees must match the task's recorded branch. Initialized submodules and
retained submodule metadata block automatic removal. Missing metadata, unknown occupancy,
unpublished commits, local files, or an unsettled required archive hold the checkout. Ordinary failures are retried
with backoff capped at a day. A partial return clears only the repos the provider returned,
and a surviving checkout with a changed resource generation gets a fresh window. Automatic
Git removal also preserves the local branch. Native leases return under the slot lock.
Explicit Cancel, Clean up and Delete keep their own rules. Workflow checks release their
own attempt leases after proving the process group empty.

**Settings > Feature flags > Seven-day worktree cleanup** selects seven-day automatic return
with fresh publication checks. The preview is off by default. Off uses the
[configured window](configuration.md#task-worktree-retention) with the same safety checks.
The worker adopts the setting on its next successful observation and checks the current
window again before returning a checkout. A provider operation already issued can finish.

The daemon environment setting `MISSION_WORKTREE_CLEANUP_PREVIEW=report-only` overrides the flag
and evaluates due checkouts against read-only evidence, including locally available origin refs.
An unrecognized nonempty value also selects report-only. The old `enforce` value defers to the
feature flag. The modes preserve the stored Worktrees retention setting.

The existing local `GET /api/worktrees` diagnostics include `retention` with eligibility times
and blockers, and `disposable` with a bounded, read-only census of the task and check roots.
Neither carries a checkout path or claim data: a census entry is named by its `root` (`task` or
`check`) and its directory `name`, and a retention entry by its task and each checkout's
repository `position`. The census reports checkout metadata and task or check provenance when
available. It provides
review evidence for unowned directories, check residue and broken Git links. Those entries
do not authorize cleanup. `retention.orphanReclaim` reports `off`, `report-only` or `enforce`
for the [orphaned-checkout class](#orphaned-task-checkouts), and each entry's `checkouts` list
gives every held checkout's `position`, `provider` and `class`: what is on disk there right now,
`registered`, `absent`, `dangling-link` or `no-link`. It is read from the filesystem for each
response and never cached, so it cannot describe an earlier task that used the same slot.
`dangling-link` is what an orphan looks like; the entry's blocker says whether its full proof
passed. A census entry's
`orphanEvidence` is `dangling-link` when its `.git` file names an administrative directory that
is gone, or `no-link` when it has no `.git` at all. Blockers are bounded sentences that never
carry a path or claim data.

#### Orphaned task checkouts

A disposable Git task checkout is **orphaned** when Git no longer recognizes it. Re-cloning the
main checkout leaves every one of them with a `.git` file that names
`<repo>/.git/worktrees/<taskId>`, an administrative directory the new clone never registered.
Every Git command in such a checkout fails, so the ordinary activity probe answers unknown and
the checkout is held with `git rev-parse exit 128`. That stays true while
**Settings > Feature flags > Reclaim orphaned task worktrees** (`orphaned-worktree-reclaim`) is
off. With it on, retention adds one narrow, positive finding modelled on
[orphaned slots](#orphaned-slots):

- The checkout's provider is `git` and its path is exactly the task's slot path.
- The path resolves to exactly itself, with no symbolic link at the slot or in any parent.
- Its `.git` is a regular file whose administrative directory does not exist, sits in the
  recorded repository's own `worktrees` directory, and has the name Git gives this slot's
  checkout. A link naming a sibling task's administrative directory is not this task's orphan.
- A `git worktree list` of the recorded repository answered and does not name it.

A link into another repository, a `.git` directory, a missing `.git`, a symbolic link, or any
read that fails is never orphaned, and the checkout is held with a bounded reason. Everything
else the retention clock already requires still applies: the task is terminal and no longer
owned, and no tracked session, lease, reservation or process is using the checkout.

No Git proof is possible inside an orphan, so the daemon proves from other read-only evidence
that nothing unrecoverable is there. It builds a throwaway bare repository under the system
temp directory that borrows the recorded repository's objects through `objects/info/alternates`,
reads a commit into a throwaway index, and compares the checkout with it. Only the work-tree
column and untracked files count; the index column describes the scratch repository, not the
checkout. The user's repository is never written.

1. If tracked and non-ignored untracked content equals the task's recorded `baseSha`, the
   checkout is provably disposable.
2. Otherwise, if the daemon recorded a **merged** pull request for exactly the task's branch in
   that repository (a record with no branch proves nothing), the content is compared with that pull request's recorded head commit. A head the
   repository lacks is fetched from its `origin` into the scratch repository, never into the
   user's. An unreachable host, a missing head, an unrecorded head or two different merged heads
   hold the checkout.
3. Anything that matches neither is local-only work: modified tracked files and untracked files
   such as a stray `report.html`, `evidence.csv` or script. These are never deleted silently.
   The same required-archive step task return uses publishes them as a
   [`checkout` archive](archives.md) and verifies the bundle again at the provider boundary. If
   the archive cannot settle, the checkout is held with that blocker and retried with backoff.
   Deleting that archive from the library before the checkout is removed holds it too: the
   daemon never recreates a bundle an operator deleted. At the delete itself the local-only set
   is computed again from the exact bytes about to be removed, and the delete runs under that
   set's archive lock after re-verifying the bundle and every file's digest, so a delete
   requested while the checkout is being removed waits until the removal has finished. Files
   under dot-prefixed directories such as `.github` are stored at an escaped bundle path and
   keep their original path in the manifest.

A tracked file missing from the checkout does not hold it: its content is in the proof commit.
A clean status is not trusted for a tracked path with the `ident`, `filter` or
`working-tree-encoding` attribute, because those conversions can make different bytes compare
equal (`ident` turns `$Id: anything $` into `$Id$`). Such a path's raw bytes are compared with the
commit's blob, and a difference is local-only work. A missing or unreadable base commit,
submodules in the proof commit, a nested repository, a symbolic link or special file among the
local-only paths, and a path that is not valid UTF-8 all hold.

Ignored files follow a deliberately different rule from registered checkouts. A registered
return holds on any ignored file, because it has no cache-disposal policy. An orphan cannot be
recovered any other way, so it tolerates ignored entries inside directories named
`node_modules`, `dist`, `test-results`, `.evidence` or `.pipeline`, or whose name starts with
`.tmp`, at any depth, after walking each such directory without following links: a nested
repository inside one, whether a `.git` entry or a bare repository's own `HEAD`, `objects` and
`refs`, is not regenerable output and holds the checkout. Every other ignored
entry, such as `.env`, still holds it. As for registered checkouts, ignored content never moves
the retention clock; it holds the delete.

Removal deletes the exact slot directory, because `git worktree remove` cannot remove what Git
does not know. Under the retention claim, the daemon proves the orphan again, remembers the slot
directory's identity (device and inode), requires the exact content digest the claim was taken
against with no ignored file outside the regenerable directories, and checks process occupancy.
It then renames the slot, atomically and within its parent, to a private name, so nothing can
reach it by the slot path any more, and requires that what moved is the very directory it
proved rather than a byte-identical copy swapped in. On that set-aside directory it checks
occupancy, re-reads the content against the claimed digest and the ignored-file rule, and
requires the same `.git` link naming the same administrative directory. It then computes the
local-only files from those bytes and holds their archive as described above. Under that hold
it checks occupancy, re-reads the content and the ignored-file rule once more, checks occupancy
a final time, and deletes the directory. The task then releases the checkout and
the ledger row finishes through the ordinary claim and complete flow. A checkout that is
already gone, for example removed by hand, completes the same way with nothing to delete.

Any refusal, and a delete that fails part-way, renames the directory back to its slot first, so
a file written or a directory swapped in during these checks is never deleted and the task keeps
tracking whatever remains. If even that rename fails, the directory stays beside the slot under
its private name, and the slot is not treated as already gone while it is there: the task and
its ledger row are held with that blocker until the operator resolves it. Manual **Clean up**,
**Cancel** and **Delete** keep their own rules.

One residual is accepted: a writer that process occupancy cannot see - one holding a descriptor
it opened before the rename, or one that writes and exits during the final occupancy sample -
inside a directory reachable only by its private name.

**Terminal homes proved absent.** Retention also holds a terminal task while its terminal home
is present or its absence cannot be verified. A home with no `terminal_resource_id`, or one
whose multiplexer cannot be read, can never pass `homeAlive`: a title cannot identify a
resource, and a title miss after a rename must not undo `killHome`'s refusal. With the flag on,
such a home is also treated as absent when the backend that recorded it positively answers that
its server is not running and no process of that backend runs for the current user. tmux must
report `no server running` for its default server, and Herdr's own status must report the
server stopped. Only then can no session or pane of any name carry the home. A backend that
cannot answer, a running server, any process of that backend, an emulator-axis home, and a
legacy home with no recorded backend all stay held, as before.

`MISSION_WORKTREE_CLEANUP_PREVIEW=report-only` evaluates both classes, with or without the flag,
from local objects only. It records what it would do, such as
`report only: orphaned checkout would be removed after archiving 2 local-only file(s)`, and
never archives, fetches or deletes.

### Check leases

A [Workflow check](workflows.md#workflows-and-personas) runs a build in an isolated worktree of its
own, pinned to the exact commit the run captured. New attempts acquire a native slot under
owner `check:<attemptId>` and persist the allocator's random lease ID before the supervisor
gate can release. A disabled repository or a positive native refusal uses a throwaway detached
Git worktree, still runs the configured command, and removes the tree afterwards. An ambiguous
native acquisition fails closed and never attempts a second provider. The gate never passes
merely because worktree allocation is unavailable.

A check has no session or task row standing in for its lifecycle. Its durable check row,
just-acquired pin, supervisor identity, process-group recovery, retries, and verdict rules remain
authoritative above the generic slot record. Cleanup first proves the process group empty, then
conditionally returns the exact native lease. A missing, stale, occupied, or uncertain lease is
kept for startup or maintenance reconciliation rather than guessed away. Native check leak
reclamation runs on the native maintenance cadence after slot startup reconciliation.

Check lease startup reconciliation does not hold the daemon back from listening. It pins every
live lease's tree synchronously, and a durable row keeps its tree while the pass runs: a native
slot stays leased to it until its return, and a Git fallback tree's path names its own attempt.
It then resolves each row in the background. Each release runs Git against the tree, and returning a
Git fallback tree removes the whole checkout, which takes a while for a large repository; a
failure is logged and retried by the next maintenance pass.

#### The dependency claim in a check lease

A check lease runs the pool's [dependency claim](#dependency-claims) under the same rules as a
task lease: the same steps, environment, deadline, fingerprint skip and final proof. The cold
fallback runs the same claim against its throwaway tree once that tree is recorded and pinned. It
runs whenever the repository's settings carry a claim, even with native pooling off, because the
claim describes the repository's dependencies, not the pool. The claim is looked up by the
repository's Git common directory, read from Git when the pool cannot identify the repository,
for example one whose metadata is relocated. A lookup that fails is infrastructure and the tree
is removed. Only settings that were read and carry no claim let the command run without one.
That tree has no slot row, so it has no recorded fingerprint and is always cold. When the
repository's pool is enabled and configures `seed.paths`, the tree seeds under the same rule as a
slot, from an idle slot of that pool, and skips its steps when the source's fingerprint matches
the check's commit. There is no write-ahead to take, because the tree is removed with the
attempt, so a seed stopped or timed out there is simply a failed claim. The final proof still applies to
a claim that succeeded: a step that rewrites a tracked file, leaves an untracked file Git does
not ignore, moves HEAD or attaches a branch leaves a tree the command is never run in. A claim
that failed is reported as a dependency failure with its tail even if it also dirtied the tree,
because the tree is removed either way.

**A failed claim does not run the check's Command.** The tree goes straight back to the pool, or
is removed, before the attempt reports anything, and the attempt records a dependency failure
with the claim's output tail. Who owns the failure is decided by the claim's fingerprint paths:

- If any blob matching them differs between the check's head and its merge base with origin's
  default branch, the change owns it. The check **fails**,
  with the claim's tail as its output and a note naming the failing step and the changed inputs.
- If none differs, it is **infrastructure**, for example a registry outage or an expired token.
  The engine retries it as the same execution, up to its usual three attempts, and then blocks
  the run with `infrastructure_error`. The reason carries the tail.
- A claim with no fingerprint paths cannot trace a failure to the change, and neither can a
  merge base that cannot be read, so both count as infrastructure.

A failed claim never spends the Command's run budget, whichever way it is decided, because the
Command did not run. The comparison reads both trees from objects in the main checkout, never
from the worktree, and measures from the merge base rather than the default branch's tip, so a
lockfile the default branch changed after the branch was cut is not blamed on the change.

**The check slot while claiming.** The daemon runs two check commands at once. An attempt whose
claim runs gives its check slot up for as long as the claim runs, and takes one again before
anything else runs in its tree. A claim that may run for hours therefore never keeps another
check queued, and a third check runs while two claim. A claim skipped on a matching fingerprint
keeps its slot throughout. The order of the checks and the run-budget reservation taken before
the lease are unchanged. A CodeRabbit review installs and runs nothing from the tree, so it takes
its tree without a claim at all.

**Timeouts.** The Command's own timeout starts when it spawns, after the claim, so claim time
never counts against it. A slow install ends under the claim's own `timeoutMinutes`, as a
dependency failure, never as a timed-out check.

**Cancel.** Cancelling a run, including through archiving or replacing its binding, stops the
claims of its running attempts, in a pool slot or a fallback tree alike. That includes an attempt that has not reached its claim yet, for example
one still resolving its commit or resetting its slot: its claim stops before its first step the
moment it registers, and an attempt cancelled before it reaches its lease takes no worktree at
all. A stopped claim settles as a failed one: the slot records `failed` and goes back to the
pool, and the attempt is recorded as cancelled with the run. An attempt cancelled while it waits
to take its check slot back after its claim returns its tree and spawns nothing. A check command
that already spawned is not signalled by a run cancel; its result is recorded as audit-only.

#### Historical Treehouse check rows

Rows that already record provider `treehouse` keep their exact provider authority and
`mission-control-check-<attemptId>` holder. Check recovery runs on the native maintenance cadence
even when there are no native pools. It keeps the row and pin on every unreadable, unverifiable,
foreign, dirty, occupied, or conditional-return failure. Only an exact persisted lease ID and
matching holder can reach the compatibility return described above. No check code can acquire a
new Treehouse lease.

### Running a check command

This is what a [Command node](workflows.md#command-nodes) does once workflow Commands are
allowed and you grant the repository, which is the gate that ships closed. New installations
ship Commands allowed; a machine whose workflow settings were stored before that switch
existed keeps them off until you turn them on, and **Settings -> Workflows** is where either
one says which it is. What a Command does with your machine is worth stating plainly before
you grant a repository.

**Workflow Commands run on Linux and macOS.** On any other platform one reports Not run and
passes. That is not an oversight: the daemon has to be able to prove afterwards that a
command and everything it spawned is gone, before it hands the leased worktree back to the
pool. It does that by recording *which exact process* the supervisor was and asking the
operating system about it later, and neither Node nor any portable API answers that question -
it is read from `/proc` on Linux and from `ps` on macOS. Somewhere it cannot be read, a check
could be started but never proven finished, so the daemon declines to start one at all.

The recorded identity is a **composite**: an operating-system start time *and* a short digest
of the supervisor's command line, which carries the attempt id. The start time alone is not
enough, because the finest value either platform will tell us is whole seconds on macOS, and
process ids get reused - two different processes born in the same second would compare equal,
and the daemon would signal a stranger's programs believing they were the check's. Pairing it
with a command line that only one supervisor ever bears makes that vanishingly unlikely
instead: a false match would need the same reused pid, in the same second, running the
daemon's own supervisor, for an attempt only one supervisor is ever created for.

The command line is stored as a truncated SHA-256 rather than in full, because the raw line
carries a few kilobytes of the supervisor's own source and this value is written to a durable
row kept for audit. Only equality is ever asked of it, and equal command lines digest equally,
so the digest answers the same question in a fraction of the space - at the cost that the
guarantee is now collision resistance rather than a literal comparison. That is a trade worth
naming rather than glossing: it is not a proof, it is a very good bet, and the durable lease
row and startup recovery are what make a wrong bet recoverable rather than silent.

What a Command gets:

- **An argv, never a shell.** `&&`, `|`, `;` and `$(…)` reach the command as ordinary
  arguments, so there is no string for a repository's configured command to break out of.
- **The submitted content, in a pooled worktree**, not your own working copy - so a check never
  sees, and can never disturb, whatever you have open. A clean submission is checked at its
  captured commit. An uncommitted one - a ship task hands its work over before it commits - is
  checked at its *review snapshot*: the capture writes the complete tracked and nonignored
  worktree as a commit parented on HEAD, through a temporary index, and names it
  `refs/mission-control/workflow-reviews/<commit>`. No branch, index or file in your checkout
  moves, and the ref is pruned 30 days after capture. The tree is `reset --hard` to that exact
  commit and cleaned with `clean -fd`, never `-fdx`, which preserves the pool's ignored
  dependencies. That keeps whatever the slot last installed, which is not necessarily what this
  commit needs. Making it current is the pool's [dependency claim](#dependency-claims), which
  runs inside the check's lease before the command (see
  [The dependency claim in a check lease](#the-dependency-claim-in-a-check-lease)). A
  subdirectory command runs in that subdirectory *of the leased tree*.
- **Ignored Go source contamination.** Before a reused native slot is reset or its dependency
  claim runs for a check, Mission Control lists ignored, untracked `*.go` files through Git.
  If any are present, it quarantines the slot without changing its files and stops that attempt
  as infrastructure trouble, not a source failure. The diagnostic names the checkout, file
  count and a bounded sample of paths. An incomplete scan also blocks the attempt. A later
  attempt can use another slot or the existing disposable fallback; it cannot reuse the
  quarantined slot. Inspect and preserve its artifacts before manually recovering or destroying
  it. This is conservative: ignored generated or vendored Go source also blocks reuse, because
  an ignore rule cannot prove it belongs to the next task. Tracked Go source and ignored
  non-Go caches are unaffected. This preflight covers pre-existing Go source, not all possible
  contamination in other languages or files generated by the current setup or claim.
- **A trimmed environment.** The daemon's auth token is removed, along with any variable that
  overrides where its state directory lives and anything whose name reads like a credential
  (`…_TOKEN`, `…_SECRET`, `…_PASSWORD`, `…_KEY`, `…_CREDENTIALS`). `PATH`, `HOME`, `SHELL`, the
  locale and proxy variables and everything else a build needs are passed through. This stops a
  credential being *handed* to a check; it does not hide the daemon's default state directory,
  which sits in your home folder and which anything running as you can find whatever the
  environment says. make's recursion state (`MAKELEVEL`, `MAKEFLAGS`, `MFLAGS`, `MAKEOVERRIDES`)
  is removed too, so a daemon started under `make start` still runs each Command as a top-level
  make rather than as a sub-make carrying the parent's flags and jobserver descriptors.
- **A closed stdin**, so a command that stops to ask a question fails immediately instead of
  hanging until its timeout.
- **Bounded output.** The combined last 4,000 bytes remain inline because a failing build's
  useful lines are usually last. Separately, each attempt retains up to 2 MiB across stdout
  and stderr, and a workflow run retains at most 64 MiB of Command bodies. The daemon keeps
  draining after either cap, so log volume never terminates an otherwise healthy command.
  Run detail reports retained, observed, and dropped byte counts and reads each stream through
  a 64 KiB paged route. That reader remains available when timeout, signal, or cleanup failure
  leaves the attempt with infrastructure state and no check verdict. Storage failure is explicit
  and does not change the process verdict.

**This is not a sandbox, and the trimmed environment should not be read as one.** A check
command runs as you, with your filesystem access. Removing the token narrows what a build can
reach *back into*; it does not confine what it can do generally. That is why a repository must
be allowlisted before any of this happens - the allowlist, not the environment, is the boundary.

When a check is cancelled or times out, the whole process group is signalled: `SIGTERM` first,
then a few seconds' grace so a test runner can flush its output and clean up its own temporary
files, then `SIGKILL`. The daemon then keeps asking until the group is actually empty before
returning the worktree, because a build that leaves a server running behind it is common and
the leader exiting proves nothing about its children. A group it cannot prove is empty keeps
its lease rather than handing back a tree something may still be writing into. Test commands
get sixty minutes before this teardown begins; other Command slots keep the ten-minute default.
Library can configure a slot from one minute through two hours. The chosen value is frozen for
the attempt, and a timeout remains retryable infrastructure rather than a failed-code verdict.

**A daemon shutdown skips the grace and goes straight to `SIGKILL`**, deliberately. Stopping
Mission Control mid-build would otherwise wait out the rest of the command's timeout - up to
sixty minutes for one test suite - and the output a grace period buys is output nobody is left to
read, because the attempt ends as an infrastructure failure rather than a verdict either way.
The daemon still waits for the group to be proven empty afterwards, so the worktree goes back
to the pool on the way out; stopping a daemon with a check running takes well under a second.

**A check whose worktree cannot be accounted for does not report a verdict**, whatever its
command exited with. A group that will not go away, or a return that failed, means the gate has
not been shown to have run against the commit it claims - so it is recorded as an infrastructure
failure instead, the run blocks and says so, and it clears once the lease is reclaimed. The
command's own exit code is kept in the reason, so you can still tell "the build failed and then
cleanup broke" from "the build passed and then cleanup broke".

## Residents without a repository

A resident launched with **No repository** uses a Mission-owned run directory instead of a
checkout. The [resident profiles change contract](agent-guides/change-contracts.md#resident-profiles)
defines the persisted workspace marker and shared repository predicate.

Worktree allocation, diffs, pull-request observation, repository grouping, and worktree retention
skip these runs. The run directory is removed after durable run completion and confirmed session
shutdown. The same cleanup scans ended runs at startup and retries failures. Daemon shutdown
alone does not end a run or remove its workspace.

### CodeRabbit comparisons

CodeRabbit uses the same supervised Check lease and retained-output reader. It reviews the
same commit the other Commands are pinned to - the captured head, or the review snapshot of an
uncommitted submission - against a frozen merge-base, resolving refs in the run's repository.
It never fetches refs. A dirty submission captured before review snapshots existed blocks with
a submit-again remedy. Missing/invalid YAML and exhausted allowance skip with
warnings before any availability probe. Complete normalized findings have their own 4 MiB /
1,000-finding bound within the shared 64 MiB run quota; raw stdout/stderr keep their independent
2 MiB cap. A semantic overflow or unavailable findings artifact blocks even on exit zero.
