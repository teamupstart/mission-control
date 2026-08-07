# Isolated worktrees per session (treehouse)

Running several agents in **one** working tree is a recipe for clobbering - one
agent's branch switch or edit lands under another's feet. [`kunchenguid/treehouse`](https://github.com/kunchenguid/treehouse)
solves this with a pool of pre-warmed git worktrees ("manage worktrees without
managing worktrees"): each session gets its own isolated tree, and dependencies
/ build cache aren't re-paid every time.

`make session` makes treehouse a one-command "start a clean session":

```sh
make session                      # lease a worktree, warm it, drop you in a subshell
make session ARGS="-- claude"     # …or launch an agent in it directly
make session ARGS="--holder mine" # …under your own lease label (see below)
node scripts/new-session.mjs -- claude   # equivalent, without make
```

Under the hood (`scripts/new-session.mjs`):

1. **Lease** a worktree from this repo's pool (`treehouse get --lease`), creating
   one if the pool is empty (up to `max_trees` in `treehouse.toml`).
2. **Warm** it (`scripts/worktree-setup.mjs`): install dependencies so the session starts fast.
3. **Hand it over** - open your `$SHELL` (or the command after `--`) in the tree.

The lease is durable, so a backgrounded agent keeps its tree after you exit.
Release it when done:

```sh
treehouse status                 # see the pool
treehouse return <path>          # give the worktree back to the pool
```

Because treehouse ignores lifecycle hooks in the repo-level `treehouse.toml` for
safety, the warm step is run by `make session` itself. To make **every**
`treehouse get` (not just `make session`) warm automatically, add a
`post_create` hook to your user config - see the comments in `treehouse.toml`.

### Leaked leases are reclaimed for you

A durable lease is what lets a backgrounded agent survive a restart, but it also
means nothing frees a tree when its agent simply goes away. Left alone those
leases pile up until the pool hits `max_trees` with **zero available**, and every
later `treehouse get` fails - at which point a dispatch falls back to a throwaway
`git worktree` and the pool stops being reused at all. (`treehouse prune` can't
help: it skips any tree with an owner reservation, and a leaked lease is one.)

So the daemon sweeps every treehouse repo it can name - the ones behind your live
sessions and tracked tasks, plus every checkout under `MISSION_WORKSPACE_DIRS` -
each `MISSION_POOL_REAP_MS`, and again whenever a dispatch finds the pool dry. The
workspace scan is what reaches a *fully* leaked repo: once its agents are gone
there is no live session left to advertise it, and you can't start one to fix
that, because `treehouse get` is precisely what fails when the pool is dry.

It hands back only the leases it can prove are dead, and only its **own**. A tree
is returned **only** when it is leased to `mission-control` (the holder both `make
session` and dispatch record), treehouse reports no processes under it, no live
session's cwd is inside it, no task the harness tracks still records it, it has no
uncommitted changes, and origin's default branch already contains its HEAD.
Anything else - including any uncertainty - leaves the lease alone: a leaked lease
costs a slot, a wrong reap costs your work.

The holder check is the harness's own rule, not something treehouse enforces
(`treehouse return` takes a path and checks no holder). It matters because a lease
survives *"even with no process running inside it, until you release it"* - so a
tree you reserved with `treehouse get --lease --lease-holder my-label` is idle **on
purpose**, and the sweep leaves it exactly where you put it, in this repo or any
other one it walks. Reclaiming a `mission-control` lease is only fair game because
this harness took it and can tell its holder is gone.

That is also the escape hatch from this side: `make session ARGS="--holder my-label"`
(or `node scripts/new-session.mjs --holder my-label`) still warms and gates the tree
the usual way, but records the lease under **your** label instead, so the sweep will
never collect it - park a tree that way and it is yours until you
`treehouse return` it yourself.

The flip side is that the sweep only knows the label it records *today*. A lease
`make session` took under this project's old `ai-harness` name is skipped like any
other holder's, since nothing tells it apart from a reservation someone made under
that label on purpose. If `treehouse status` shows an old idle lease the sweep
never collects, hand it back yourself: `treehouse return <path>`.

Note that a *live* agent's tree is often clean and merged (right after a push), so
it's the liveness checks, not the git ones, that keep it yours - and a task's tree
stays its own even after the agent exits, which is what lets **Mark done** keep
your work. Because those liveness checks are the load-bearing ones, they're
re-taken immediately before a tree is handed back, so a tree leased while the
sweep was fetching is never returned on the strength of a reading from before it
existed.

That re-read alone isn't quite enough, because `treehouse status` prints no lease
id or timestamp: a tree that was returned and then *re-leased* in that window looks
identical to the stale lease the sweep planned to collect, since both hold as
`mission-control`. It matters most for a dispatch, which has no process, no session
and no task record between taking its tree and finishing provisioning - and a second
dispatch that finds the pool dry runs a sweep itself, right into that window.

So the daemon also tracks its own acquisitions, and spares a tree on two counts: one
it leased after the sweep looked, and one it is still provisioning. The second lasts
only until the tree is recorded on its task, after which the ordinary rungs decide
again, and it lapses on its own if that never happens - so a dispatch that dies mid-setup
delays a reap rather than stranding the slot. A `treehouse get` from another terminal is
outside all of this, which is why the holder check above stays the thing protecting
*your* reservations.

Set `MISSION_POOL_REAP_MS=0` to switch the background sweep off entirely; the
dispatch-time reap stays on, since its only alternative is abandoning the pool
for a throwaway worktree.

That last-resort fallback is no longer silent, which is how a pool could sit full
without anyone noticing: a dispatch that still can't get a tree warns in the daemon
log and points you at `treehouse status`. It reports what it actually observed and
quotes treehouse's own words rather than blaming a full pool - `get` fails the same
way for an unresolvable pool or a bad config, and sending you to a `treehouse status`
that looks perfectly healthy would help nobody.

### Check leases

A [Workflow check](workflows.md#workflows-and-personas) runs a build in an isolated worktree of its
own, pinned to the exact commit the run captured. When the `treehouse` binary is installed,
the check uses a pooled tree even if the repository has no `treehouse.toml`; unlike dispatch,
checks gate on binary availability alone. When the binary is absent, the check uses a
throwaway detached `git worktree`, still runs the configured command, and removes the tree
afterwards. The gate never passes merely because treehouse is unavailable.

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

The consequence is that the sweep can never collect a *leaked* check lease either, so
the daemon collects its own. It keeps a durable record of every check lease and, at
startup and on the same timer as the sweep, hands back the ones nobody is coming back
for - but only after proving both that the tree is still ours (same path, same exact
holder token) and that nothing is still running in it. A tree it cannot prove is empty
is kept rather than reclaimed, because the cost of keeping one is a pool slot and the
cost of guessing wrong is somebody's work. A path that has been re-leased to a
different holder in the meantime is never returned at all; the daemon records it and
walks away, which is what stops a crash-recovery from handing back a tree that is now
yours.

One residual, stated plainly because it cannot be closed from this side: the daemon
serialises its own `treehouse get` / `status` / `return` calls so they cannot interleave,
but that lock binds **one process**. A `make session` or a hand-run `treehouse get` in
another terminal is outside it. What makes that safe is the holder comparison rather
than the lock - anything leasing a tree from outside gets `mission-control` or its own
label, never a check token, so the daemon sees the mismatch and refuses to touch it.
(`treehouse return` accepts a path and no holder, and `--lease-holder` is a label
treehouse records and never checks, so this is a rule the harness imposes on itself.)

**A check lease costs a pool slot for as long as the command runs.** Two checks run at once, so
in the worst case two of a repository's `max_trees` are held by builds rather than by sessions,
and a dispatch that finds the pool dry waits. If that starts happening, raise `max_trees` in
that repository's `treehouse.toml` - the number is per repository, and the one in this
repository is 32.

If you ever see an idle `mission-control-check-…` lease that outlives its daemon, it is
safe to hand back by hand: `treehouse return <path>`.

### Running a check command

This is what a [Check node](workflows.md#check-nodes) does once you switch checks on and allowlist the
repository, and what it does with your machine is worth stating plainly before you do.

**Check commands run on Linux and macOS.** On any other platform a check reports Not run and
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

What a check command gets:

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
its lease rather than handing back a tree something may still be writing into.

**A daemon shutdown skips the grace and goes straight to `SIGKILL`**, deliberately. Stopping
Mission Control mid-build would otherwise wait out the rest of the command's timeout - up to
ten minutes for one test suite - and the output a grace period buys is output nobody is left to
read, because the attempt ends as an infrastructure failure rather than a verdict either way.
The daemon still waits for the group to be proven empty afterwards, so the worktree goes back
to the pool on the way out; stopping a daemon with a check running takes well under a second.

**A check whose worktree cannot be accounted for does not report a verdict**, whatever its
command exited with. A group that will not go away, or a return that failed, means the gate has
not been shown to have run against the commit it claims - so it is recorded as an infrastructure
failure instead, the run blocks and says so, and it clears once the lease is reclaimed. The
command's own exit code is kept in the reason, so you can still tell "the build failed and then
cleanup broke" from "the build passed and then cleanup broke".
