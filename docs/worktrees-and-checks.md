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

### Native pools

Native pooling is enabled by default. The daemon lazily creates exact-commit, detached Git
worktrees beneath `MISSION_HOME/worktree-pools`, keyed by Git's physical common directory rather
than by the checkout path used to reach it. Released slot directories remain in place so ignored
dependencies and build caches stay warm for the next lease. A repository-specific disable uses a
cold disposable Git worktree beneath `MISSION_HOME/worktrees` instead.

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
to start it and exits without allocating a standalone worktree. The future Settings > Worktrees
surface will operate on the same inventory.

Native capacity and enablement are configuration policy. The shipped policy is enabled with 16
slots per physical repository. A repository override affects its next acquisition, never an
active lease. The Settings editor for this policy belongs to a later phase.

### Legacy Treehouse compatibility

[`kunchenguid/treehouse`](https://github.com/kunchenguid/treehouse) remains temporarily supported
for cleanup of task and check rows that already record provider `treehouse`, and its installation
and `treehouse.toml` setup remain documented during that bridge. No new Mission Control task,
check, or `make session` acquisition selects Treehouse.

Because treehouse ignores lifecycle hooks in the repo-level `treehouse.toml` for
safety, direct `treehouse get` calls need a user-level hook to warm automatically. Add a
`post_create` hook to your user config - see the comments in `treehouse.toml`.

### Historical Treehouse leases are reclaimed conservatively

A durable lease is what lets a backgrounded agent survive a restart, but it also
means nothing frees a tree when its agent simply goes away. Left alone those
leases pile up until the external pool hits `max_trees` with **zero available**.
`treehouse prune` cannot help because it skips owner reservations.

So the daemon sweeps every treehouse repo it can name - the ones behind your live
sessions and tracked historical tasks, plus every checkout under `MISSION_WORKSPACE_DIRS` -
each `MISSION_POOL_REAP_MS`. The
workspace scan is what reaches a *fully* leaked repo: once its agents are gone
there is no live session left to advertise it, and you can't start one to fix
that, because `treehouse get` is precisely what fails when the pool is dry.

It hands back only the leases it can prove are dead, and only its **own**. A tree
is returned **only** when it carries one of Mission Control's historical holder labels,
treehouse reports no processes under it, no live
session's cwd is inside it, no task the harness tracks still records it - including as one of
a multi-repo task's attached repositories, whose trees no session's cwd is inside - it has no
uncommitted changes, and origin's default branch already contains its HEAD.
It also leaves a lease alone when a Workflow check has pinned its path. Check leases use a
separate holder identity as the primary guard, and the path pin is deliberate defence in
depth for the interval before a check process appears.
Anything else - including any uncertainty - leaves the lease alone: a leaked lease
costs a slot, a wrong reap costs your work.

The holder check is the harness's own rule, not something treehouse enforces
(`treehouse return` takes a path and checks no holder). It matters because a lease
survives *"even with no process running inside it, until you release it"* - so a
tree you reserved with `treehouse get --lease --lease-holder my-label` is idle **on
purpose**, and the sweep leaves it exactly where you put it, in this repo or any
other one it walks. Reclaiming a `mission-control` lease is only fair game because
this harness took it and can tell its holder is gone.

For a direct Treehouse reservation that must be left alone, use Treehouse's own
`--lease-holder my-label`. A label outside Mission Control's historical list is yours until
you run `treehouse return` yourself.

If `treehouse status` shows an old idle lease the compatibility sweep never collects, hand
it back yourself: `treehouse return <path>`.

Note that a *live* agent's tree is often clean and merged (right after a push), so
it's the liveness checks, not the git ones, that keep it yours - and a task's tree
stays its own even after the agent exits, which is what lets **Mark done** keep
your work. Because those liveness checks are the load-bearing ones, they're
re-taken immediately before a tree is handed back, so a tree leased while the
sweep was fetching is never returned on the strength of a reading from before it
existed.

Treehouse status has no lease ID or timestamp, so the compatibility path re-reads holder,
process, task, session, Git, and pin state immediately before a return. A change or any
uncertainty cancels the return. Set `MISSION_POOL_REAP_MS=0` to switch this legacy background
sweep off entirely. Native maintenance has its own `MISSION_WORKTREE_SWEEP_MS` cadence.

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

The following compatibility behavior applies only to rows that already record provider
`treehouse`. No new check attempt creates one.

A pooled check tree is leased like any other, with one difference you will see in
`treehouse status`: it is held by **`mission-control-check-<attemptId>`**, not by plain
`mission-control`.

The distinct holder is the point, not decoration. A check has no session standing in
it and no task recording it, and between the lease and the build starting it has no
processes either - so every signal the sweep above trusts reads "idle" on a tree that
is about to be written into, and a reclaim would kill the build and hard-reset the
work. Because the sweep only ever returns leases stamped with a name this app has used
(`mission-control`, `fleet-control`, `ai-harness`), a check lease is refused by the
same rung that protects your own `--holder` reservations. The daemon also pins the path
outright while a check holds it, which is deliberate redundancy: the holder is a string
a future rename could break, and the pin is a path the daemon knows it is holding.

The consequence is that the Treehouse sweep can never collect a *leaked* historical check
lease either, so the daemon collects its own. It keeps a durable record of every check lease
and, at startup and on the native maintenance cadence, hands back the ones nobody is coming back
for - but only after proving both that the tree is still ours (same path, same exact
holder token) and that nothing is still running in it. A tree it cannot prove is empty
is kept rather than reclaimed, because the cost of keeping one is a pool slot and the
cost of guessing wrong is somebody's work. A path that has been re-leased to a
different holder in the meantime is never returned at all; the daemon records it and
walks away, which is what stops a crash-recovery from handing back a tree that is now
yours.

One residual for those historical rows, stated plainly because it cannot be closed from this side: the daemon
serialises its own `treehouse get` / `status` / `return` calls so they cannot interleave,
but that lock binds **one process**. A hand-run `treehouse get` in
another terminal is outside it. What makes that safe is the holder comparison rather
than the lock - anything leasing a tree from outside gets `mission-control` or its own
label, never a check token, so the daemon sees the mismatch and refuses to touch it.
(`treehouse return` accepts a path and no holder, and `--lease-holder` is a label
treehouse records and never checks, so this is a rule the harness imposes on itself.)

**A historical Treehouse check lease costs one external pool slot for as long as its command
runs.** No new check consumes `max_trees`; native capacity comes from the daemon's per-repository
policy instead.

If you ever see an idle `mission-control-check-…` lease that outlives its daemon, it is
safe to hand back by hand: `treehouse return <path>`.

### Running a check command

This is what a [Command node](workflows.md#command-nodes) does once you allow workflow Commands
and grant the repository, and what it does with your machine is worth stating plainly before
you do.

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
