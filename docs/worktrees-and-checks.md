# Isolated worktrees

Running several agents in **one** working tree is a recipe for clobbering - one
agent's branch switch or edit lands under another's feet. Mission Control therefore gives every
new task, Workflow check, and approved manual development session an isolated checkout through
one daemon-owned native allocator.

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

An explicit pinned base bypasses all of this: it is verified to be a real full commit ID in that
repository and used unchanged, with no fetch. A pin names one commit in one repository, so a
task's attached repositories still resolve their own remote defaults.

### Native pools

Native pooling is enabled by default. The daemon lazily creates exact-commit, detached Git
worktrees beneath `MISSION_HOME/worktree-pools`, keyed by Git's physical common directory rather
than by the checkout path used to reach it. Released slot directories remain in place so ignored
dependencies and build caches stay warm for the next lease. A repository-specific disable uses a
cold disposable Git worktree beneath `MISSION_HOME/worktrees` instead.

New slots reserve capacity independently, then serialize `git worktree add` within the same
physical repository. Git registrations share `.git/worktrees` metadata even when their checkout
paths differ; overlapping creation can read another slot's incomplete `commondir` file. This
serialization ends when registration finishes, so setup, inspection, warm-slot resets, and
creation in other repositories can still proceed concurrently.

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

`make session` is a loopback client for that daemon-owned inventory:

```sh
make session                                  # acquire, warm, and open your shell
make session ARGS="--label review -- claude" # label it and launch a command
make session ARGS="--return <lease-id>"       # return one exact durable lease
make session ARGS="--return-lease <lease-id>" # explicit spelling of the same action
```

Under the hood (`scripts/new-session.mjs`):

1. **Acquire** a manual lease from the running daemon's loopback API.
2. **Warm** it (`scripts/worktree-setup.mjs`): install dependencies so the session starts fast.
3. **Hand it over** with `MISSION_WORKTREE` and `MISSION_WORKTREE_LEASE_ID` set, opening your
   `$SHELL` or the command after `--` in the tree.

The lease stays durable after the shell exits. Return it explicitly with either command above,
using the lease ID printed by `make session` or exported as `MISSION_WORKTREE_LEASE_ID`. A slot path
is reusable and never authorizes a return. If the daemon is unavailable, `make session` tells you
to start it and exits without allocating a standalone worktree. **Settings > Worktrees** reads
and acts on the same durable lease. The command is useful from a shell; the panel adds the safety
preview and the surrounding pool, Git, process, and owner state.

Native capacity and enablement are configuration policy. The shipped policy is enabled with 16
slots per physical repository. A repository override affects its next acquisition, never an
active lease.

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
  again. Each slot carries its exact manager path, observed HEAD, relationship to the remote
  default, cleanliness, process count, disk estimate, and owner. **Copy path** stays in the browser.
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
risks, blockers, and consequences. Dirty or unlanded exact targets require an explicit
acknowledgement. Execution consumes the short-lived token once and observes the lease, task or
check owner, processes, Git state, and slot version again. A changed fact refuses with a stale
preview message. Unknown process occupancy is never acknowledgeable.

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
  only states whose result is positively proven and keeps uncertainty quarantined.
- **Destroy** removes one exact manager-owned slot or the fixed slot set enumerated for one pool.
  It may discard dirty or unlanded work only after those risks are acknowledged. It has no target
  meaning every pool and cannot override unknown identity, ownership, registration, or process
  state.
- **Return legacy lease** delegates to the task or check owner and then the conditional Treehouse
  adapter. There is no force action for unverifiable or foreign resources.

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

A task's worktrees are not freed when the task ends. A `done`, `failed`, or `cancelled` task
keeps every checkout it holds so a person can still read the work, commit it, push it, or
reclaim it deliberately with **Clean up**. That reprieve is bounded: **Mission Control removes a
terminal task's worktrees automatically after 30 days without a Git-visible change.**

The policy is fixed and destructive at the boundary. Staged changes, unstaged changes,
untracked files, local commits, and commits that were never pushed are all deleted when the
window expires. None of them exempts a tree, and push, upstream, pull request, and merge status
are deliberately not consulted at all. What they do is **reset the clock**: any change to the
observable Git state grants another full 30 days from the moment it is observed.

What counts as a change:

- `HEAD`, including a new local commit;
- the complete index - anything staged, unstaged, or removed from staging;
- tracked worktree content, including deletions, mode changes, and symlink targets; and
- every non-ignored untracked file and its current content.

What does not: anything `.gitignore` covers. Warm dependency directories, build caches, and log
files churn without anybody working, and a tree pinned by them would never be reclaimed.

**One task has one deadline.** A multi-repository task's primary and attached checkouts are
combined into a single fingerprint in repository order, so the most recently touched tree
protects the whole set, and the task is reclaimed as one operation.

**How the clock is kept.** The daemon observes each eligible task's checkouts on a fixed
internal cadence, well inside the window, and persists the result - the fingerprint, when it
last changed, and the resulting deadline - so a restart resumes the boundary that was actually
granted rather than starting over. A restart no longer frees a checkout: when reconciliation
proves a task's agent died with the daemon, the task settles honestly and keeps every worktree,
provider, and lease fact for the same 30-day rule.

**The clock starts when the tree is first observed, not when the task ended.** No timestamp in
the database can prove when a checkout was last touched, so every tree that existed before this
shipped - and every tree whose resources are replaced - is seeded at its first successful
observation and gets one full window from there.

**Uncertainty retries; it never deletes.** A checkout Git cannot be read, a provider that
refuses, a process still occupying a tree, a scout report that cannot be published, or a
partial multi-repository release all keep every durable resource fact, record a bounded reason,
and try again with exponential backoff capped at a day. The tree stays past due - a failed
cleanup never buys it another 30 days - and the ordinary **Clean up** action still reaches it.
While a due cleanup is retrying, the task's card says so, separately from its outcome or
failure reason.

Cleanup runs through the same provider-aware teardown as **Clean up**, so a native slot, a
disposable Git worktree, and a historical Treehouse lease are each released under the provider
and lease identity recorded on the task. At most one automatic cleanup touches a given physical
repository at a time, and it releases at background priority, so a large stale fleet cannot
stand in front of a dispatch that needs a slot now.

This policy applies only to worktrees Mission Control provisioned for a task. Manual
development worktrees, [check leases](#check-leases), and Git worktrees Mission Control does not
own are never touched by it.

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
- **The captured commit, in a pooled worktree**, not your own working copy - so a check never
  sees, and can never disturb, whatever you have open. The tree is `reset --hard` to that exact
  commit and cleaned with `clean -fd`, never `-fdx`, which is what preserves the pool's warm
  ignored dependencies: your `node_modules` survives, so a check is a build rather than an
  install. A subdirectory command runs in that subdirectory *of the leased tree*.
- **A trimmed environment.** The daemon's auth token is removed, along with any variable that
  overrides where its state directory lives and anything whose name reads like a credential
  (`…_TOKEN`, `…_SECRET`, `…_PASSWORD`, `…_KEY`, `…_CREDENTIALS`). `PATH`, `HOME`, `SHELL`, the
  locale and proxy variables and everything else a build needs are passed through. This stops a
  credential being *handed* to a check; it does not hide the daemon's default state directory,
  which sits in your home folder and which anything running as you can find whatever the
  environment says.
- **A closed stdin**, so a command that stops to ask a question fails immediately instead of
  hanging until its timeout.
- **Bounded output.** The last 4,000 bytes are kept, because a failing build's useful lines are
  its last ones, and the run detail reports exactly how many bytes were dropped.

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
