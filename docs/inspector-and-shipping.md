<a id="inspector-automated-pr-review"></a>

# GitHub Inspector (automated PR review)

GitHub Inspector is the optional remote reviewer. It is separate from the built-in
[Code Quality Judge](workflows.md#built-in-personas), which No-Mistakes Review runs locally before
its verified Pull Request action. Version 9 introduced the judge as a singleton stage; version 10
runs it alongside Code Risk Reviewer in stage 3, version 11 adds
[Code Design Reviewer](workflows.md#built-in-personas) to that same stage, version 12
adds Slop Filter beside Test Evidence Auditor and Documentation Steward in stage 4, and current
version 13 adds criterion-mapped evidence preflight before any local attempt. Versions 9 onward complete after
verified publication and do not wait for GitHub Inspector. Enabling this service adds review of
pushed heads on GitHub; it does not enable or skip the local Personas.

The GitHub Inspector reviews the pull requests **Mission Control opened** - and only those -
against the reviewed repo's [`INSPECTOR.md`](#inspectormd), leaves inline review comments for what it finds,
answers replies in its own threads, re-reviews on every push, and resolves its own
threads once a push fixes what they were about. When a live review finds nothing further
and every earlier GitHub Inspector finding is resolved, it leaves one top-level comment for that
head saying the pull request is safe to merge.

It ships **off**, in **dry run**, trusting **no repositories**. Turning it on is three
separate acts in Settings → GitHub Inspector, and the first two are reversible without anyone
else seeing anything. Enabling and mode live on the GitHub Inspector panel; which repos it may post
in is a column of **Settings → [Trust](skills-and-settings.md#trust-who-may-act-in-which-repository)** now (the
panel shows the count and links there), the same list `mode` is checked against below.

### Only our pull requests

This is the whole consent model, so it is worth being precise about. Mission Control
learns about PRs two loose ways - a URL sniffed out of any `Bash` result, and
`gh pr list --head <branch>` - and neither can tell a PR you opened from one a colleague
opened on the same branch. Neither adopts anything.

A PR is adopted for review when the hook saw the agent run **`gh pr create`**. It is matched
on the command, not the output, because `gh pr view` prints the same URL. A projected external
pipeline supplies the other proof: the engine writes `pr_url` into that run's own state, and
Mission Control adopts it with source `pipeline` on first sight only when its owner and
repository match a GitHub remote configured in the projected checkout. Missing, unreadable,
non-GitHub, and mismatched remotes all abstain. A repeated projection is an idempotent
adoption of the same ledger row.

Adopted PRs are recorded durably and stay adopted while they are open, even after the
session that opened them exits. A PR with no adoption record is never touched. Adoption is
not consent to post - that is `mode` plus the allowlist - so a PR is recorded whenever the
proof arrives, including while the GitHub Inspector is switched off. That single local insert is
the only thing it does while off; it runs no `gh` and no model.

Both sources enter the same ledger. Pipeline pull requests therefore appear in **Shipped** and
follow the ordinary Inspector and Shipping settings; pipeline provenance grants no review,
posting, or merge permission of its own.

### Knowing its own comments

A comment counts as the GitHub Inspector's own only if **both** are true: it was written by the
login `gh` is authenticated as, **and** it carries a hidden marker
(`<!-- mission-inspector:v1 … -->`) at the very start of its body. That is what decides
which threads get resolved and which questions get answered.

Neither half is enough alone, for different reasons. The account is shared - you comment
under it, other agents run as you, a second Mission Control on another machine posts as
you - so the author cannot tell our comments from those; the marker can. And the marker's
prefix is a fixed public string whose fingerprints are visible in any PR's page source, so
anyone who can comment on the pull request can paste one; the author check is what stops a
forged comment being read as ours. If `gh` cannot say who we are, nothing counts as ours
and nothing is resolved or answered.

The marker must be at the *start* of a body to count. GitHub's quote-reply prefixes every
line with `> `, so a human quoting one of our comments would otherwise be mistaken for us
and never answered.

### What it can read, and why that is a trade

On Claude, the reviewer runs one fresh Agent SDK query by default with **`Read`, `Grep`,
`Glob`** in the reviewed worktree. The operator can pin the supported `claude -p` escape hatch
with [`MISSION_CLAUDE_TRANSPORT=print`](configuration.md). Reviewing a diff without being able to open a file misses most of what matters -
whether a change breaks a caller three files away, whether there is a test - so the grant is
deliberate. It also means a pull request diff (which anyone can author) reaches a model
that can read the filesystem, whose output is published publicly.

Five things stand in the way of that:

1. **Tool allowlist** - reading only. No `Bash`, no `Write`/`Edit`, no `WebFetch`, no MCP.
2. **Path deny rules** handed to Claude Code itself, covering `.env*`, keys, `.ssh`,
   `.aws`, `.git/config`, and Mission Control's own state - denied for all three of
   `Read`, `Grep` and `Glob`, since `Grep` prints the lines of any path it is given.
3. **Working directory** is the reviewed worktree; under `-p` a read outside it has nobody
   to approve it, so it fails.
4. **Every finding must name a file the PR changed.** One that doesn't is discarded - so
   "read a secret and repeat it" produces a comment with nowhere to land.
5. **A secret scrubber** on every outbound string, including the review summary, which is
   the one output rule 4 does not constrain.

**On Codex there is no grant at all, and the GitHub Inspector says so rather than pretending.**
The five constraints above are enforced by the provider, not asked for in the prompt, and
`codex exec` cannot express this exact per-tool deny list. Rather than accept a weaker
grant under the same name, the runner declares it can sandbox none, and the GitHub Inspector hands
it no tools: a Codex review reads the diff in the prompt and nothing else. That is a
narrower review - it cannot go and check the caller three files away - and it is the
honest version of the trade, which is why the panel prints it beside the provider picker.

It never approves or requests changes; it comments. It does not chase comments to
resolution - it surfaces issues and resolves what later pushes fix.

### How a finding gets closed

A finding is resolved in three ways, and it is worth knowing all three, because an open one
blocks [YOLO mode](#what-has-to-be-true) outright:

1. **A later review round lists it as fixed.** The usual path. A model that merely stops
   mentioning a finding does *not* close it - silence is not evidence that anything was
   fixed - so it has to name the fingerprint.
2. **The GitHub Inspector drops it in conversation.** If you reply in one of its threads and it
   agrees its comment was wrong, it says so, resolves the thread, and closes the finding.
   Its answer and its ledger are the same act; it cannot say "dropping this" and go on
   blocking the merge over it.
3. **You resolve it yourself** - **Resolve**, on the row in **Settings → GitHub Inspector →
   Inspections**. This is the way out of the case the first two cannot reach: a finding
   whose fix was pushed and reviewed once, and which the review then never mentions again.
   Rounds stop at a head that has already been reviewed, so no later round exists to close
   it, and without this it blocked the pull request for good.

**Resolve** closes Mission Control's own ledger and nothing else. It does not merge
anything and it relaxes no gate - in particular, GitHub's own unresolved review threads are
counted separately, so a pull request whose threads are still open moves from *findings* to
*threads* rather than to merged. It is offered only on open pull requests that are actually
carrying findings.

A pull request that has **closed** is refused outright, by the daemon and not merely by the
panel hiding the button. A retired row is out of the sweep for good, so resolving it could
unblock nothing - all it could do is overwrite the record of what the GitHub Inspector said about
work that has already landed, which this ledger deliberately keeps.

### INSPECTOR.md

Put one in the repository being reviewed, at `personas/INSPECTOR.md` or at the root. It tells
the GitHub Inspector what the project cares about and, as importantly, what not to comment on - an
automated reviewer that pattern-matches style nits is worse than none. This repo's own is
[`personas/INSPECTOR.md`](../personas/INSPECTOR.md).

Both locations are supported and `personas/` wins when a repo has both: it keeps the brief
beside the [rest of the persona documents](../personas/), while the root name is what repos
configured before that convention already carry, and demoting those to the default brief would
weaken their reviews without anything failing. A blank file at the preferred path falls through
to the root rather than shadowing it.

A repo with neither is reviewed against a built-in default brief instead - general engineering
judgement, with the same insistence on a low noise floor - so the GitHub Inspector still works on a
repo nobody has configured. It's read fresh each round, so editing it changes the next review.

The repo's `CLAUDE.md` / `AGENTS.md` are loaded alongside it, so the GitHub Inspector judges a PR
against the contract the repo actually asserts. Both names are consulted, at the repo root
and in any directory the PR touched, but a document is loaded **once**: repos commonly ship
one of those names as a symlink to the other (this one does), and two names for a single
file are one contract, not two copies of it in the prompt.

A repo that carries [repository memory](repository-memory.md) has its
`.agents/memory/MEMORY.md` index loaded too - so the GitHub Inspector reviews against what this repo
has already learned about itself, not just what it wrote down as policy. It is read **last**,
after the root docs and after any nested doc governing a directory the PR touched, because
reading order is budget order: at the bundle's byte cap the memory index is the first thing
dropped, never the contract for the code under review, and the prompt says documents were
omitted.

### On the session detail

A session whose pull request has been adopted grows a `⌕` chip beside its PR chip, and the
mark next to the glyph is where the review stands: no mark at all means adopted but not
looked at yet, `✓` means reviewed with nothing outstanding, a number is the count of open
findings, and `!` means the last round didn't complete. It's a mark rather than a word
because a word costs the session detail title the width it needs; the sentence is in the tooltip. In
`dry-run` the chip is set apart - a dashed border, a dotted underline in the rail - and the
tooltip says nothing was posted.

Board tiles and the console detail both carry it, and there it opens the pull
request. The console rail carries the same mark without the link, and only when there is
something to say - open findings or a failed round - because a rail line is scanned rather
than read.

### The review model

**[Settings → Models](models.md#the-github-inspectors-review)** names what the review and the
follow-up replies spawn as, and the provider they spawn through - beside every other call this app
makes on your account. The GitHub Inspector's own panel keeps a pointer to them; everything else
about its posture stays there. It ships as `claude-sonnet-5`, and the row tells you where the value
in force came from - your config, `MISSION_INSPECTOR_MODEL` in the daemon's environment, or the
shipped default. Leave it empty to accept whichever of the other two applies.

**An unset provider now inherits.** It used to resolve to a literal `claude`, which made this the
one subsystem in the app that ignored the app-wide provider default and
[`MISSION_LLM_RUNNER`](configuration.md): an operator who had pinned everything to one provider got
a Claude review anyway, with nothing on screen saying so. If you were relying on that, name
`claude` here explicitly - the choice matters, because
[what it can read](#what-it-can-read-and-why-that-is-a-trade) changes with the provider.

Naming a default at all is the point. An unset `--model` inherits whatever the local
`claude` CLI happens to default to - on one machine that resolved to the 1M-context Opus
tier at roughly $2 a round - and nothing in the app recorded it or could show it to you.

A model is a **cost** choice here, not a latency one. The same 10KB PR measured 225s on
Opus and 272s on Sonnet: the cheaper model read more files to reach the same verdict. See
`MISSION_INSPECTOR_TIMEOUT_MS` for the ceiling those numbers set.

### Dry run

`dry-run` does everything except post: it adopts, reviews, computes findings and dedupes
them, then records them instead of publishing. **Settings → GitHub Inspector → Inspections** is
where you read what it would have said. Run it there on a few of your own PRs before you
let it speak.

Each row says where that PR stands: `queued` (adopted, not yet looked at), `failed` (the
last round errored - hover the link for why), a finding count, or `clean`, beside a count
of the findings that are no longer open and - on an open PR still carrying findings -
a **Resolve** control that closes them ([why that exists](#how-a-finding-gets-closed)).

That second number says `closed`, not `fixed`, because it cannot tell you which: a finding
closes in [three ways](#how-a-finding-gets-closed) and only one of them is a push that fixed
it. The ledger records the outcome, not which route produced it. A PR that has since closed reads `merged` or
`closed` and is dimmed: it left the sweep for good, so it is history rather than a queue. A
closed PR that *was* reviewed keeps its findings, because what the GitHub Inspector said about
something that landed is the more useful fact.

The count strip above the table tallies those same states and filters to one when you click
it - on a ledger that is mostly landed work, *with findings* is how you get to the two rows
that need you. The **Health** card beside it reports the last completed review and the last
failure, which is the difference between a GitHub Inspector that is quiet and one that has been
erroring for three hours; in the list those look identical, because every row simply keeps
its last verdict.

The table shows 25 rows at a time, with **Newer** and **Older** under it and a `1-25 of 50`
readout between them, and it scrolls inside its own frame rather than growing the page. This
is the same table the Shipping and Foreman panels use, on purpose: the strip is the only
control for shortening the list, so it has to stay in view while you read the list it
filters. Picking a tile starts that filtered list at its first page, and the pager is absent
when everything already fits. The GitHub Inspector's list is the 50 most recently reviewed pull
requests, so the total counts what this panel was served, not everything the database holds.

## Shipping (YOLO mode)

**Settings → Shipping** is where you decide what lands without you. **YOLO mode** merges
the pull requests Mission Control opened - the same adopted set the GitHub Inspector reviews, and
only those.

It ships **off**, trusting **no repositories**, with a **10 minute** soak.

### What has to be true

Every one of these, on the same read of the pull request:

| Gate | Why |
|---|---|
| The GitHub Inspector reviewed **this** push | a review of the previous head is not a review of what would land |
| The GitHub Inspector **published** that review | on, **live**, and the repo on *its* allowlist - see below |
| No active GitHub Inspector-gated workflow owns the PR | YOLO mode cannot merge around incomplete Personas or final-gate handling |
| No open GitHub Inspector findings | posted or previewed in dry run - a finding is a finding. [Three ways one closes](#how-a-finding-gets-closed) |
| No unresolved review threads | stricter than the above on purpose: not merging over a colleague's unanswered question, whoever asked it |
| Nobody requested changes, no required review outstanding | a human veto outranks a clean automated review |
| **CI passing** on the head commit | a commit with **no** checks does not pass this: it has never been asked |
| GitHub says it merges cleanly | `CONFLICTING` blocks, and so does mergeability it has not computed yet |
| Open for the **soak** | the window in which somebody can look and say no |
| The repo holds the **merge grant** | its own column in [Trust](skills-and-settings.md#trust-who-may-act-in-which-repository), not the GitHub Inspector's |

The soak is measured from when the pull request was opened, and defaults to 10 minutes.
Zero means "merge as soon as everything else passes". A push resets the review gate rather
than the soak - the new head has to be reviewed clean before anything merges.

The merge itself is a compare-and-swap against the head that was evaluated, so a push
landing in the seconds between the decision and the call makes GitHub refuse rather than
merge code nothing has looked at. Squash by default; merge commit and rebase are the other
two options.

The workflow veto is narrow and can only block. GitHub Inspector remains the sole PR poller, and Shipping
remains the sole merge executor; Shipping rides the GitHub Inspector tick instead of polling independently.
An active published GitHub Inspector gate vetoes its adopted or candidate PR; completed, cancelled,
archived, and no-final-gate workflows do not.

### It needs the GitHub Inspector, fully on

YOLO mode rides the GitHub Inspector's poll and merges what the GitHub Inspector reviewed clean, so with
the GitHub Inspector switched **off** nothing is ever reviewed, nothing qualifies, and nothing
merges. It is not a way to merge unreviewed pull requests.

All **three** of the GitHub Inspector's switches count, not just the first, because a review it
never published is not a review anything may act on:

| GitHub Inspector state | YOLO mode |
|---|---|
| **off** | nothing is reviewed, so nothing merges |
| on, but **dry run** | it reviews and publishes nothing - no merge |
| on and live, repo **not on the GitHub Inspector's allowlist** | same: it reviews, publishes nothing - no merge |
| on, live, repo on **both** allowlists | the gates above decide |

The middle two are worth stating plainly because they are not obvious: dry run still
*reviews*, and it advances the reviewed head exactly as a live round does. Only the
publishing stops. So "the GitHub Inspector reviewed this push" is true in dry run, and it is not
sufficient - **dry run means dry for the merge too**. While YOLO mode is armed, Shipping's
**Prerequisites** card names whichever of the three is in the way and links to the control
that fixes it; each reason also appears per pull request in the *Merge queue*. The session detail
says so only while something is genuinely unmet - a checklist of green ticks is one nobody
reads on the day a tick turns red.

Switching from dry run to live does not promote the review that already ran. The reviewed
head records the GitHub Inspector posture that produced it; once live, the GitHub Inspector reviews that
same head again, and only the new live result can authorize a later merge. Rows created by
an older build have no recorded posture and fail closed through the same re-review path.

The two allowlists stay separate: letting the GitHub Inspector comment on a repo is a smaller
grant than letting it merge there, so a repo has to be on both. Shipping's list does not
stand in for the GitHub Inspector's. Both are columns of
**Settings → [Trust](skills-and-settings.md#trust-who-may-act-in-which-repository)** now (the Shipping panel shows
the merge count and links there); the separation is exactly why Trust draws them as two
columns and flags the one dangerous combination - merge granted, review not - in amber.

### Why it did not merge

An auto-merger's failure mode is merging nothing and never saying why, so **Settings →
Shipping → Merge queue** carries the current reason per PR: soaking, CI still running,
three open findings, not on the allowlist. *Soaking* is its own tile in the strip rather
than part of *held at a gate*, because it is the one block that clears itself - counting it
as an obstruction is how the safety valve ends up turned down to zero. When GitHub refuses the merge
outright - a branch protection rule this app cannot see - its own message is shown there
verbatim, because that is the only account you get of a rule nothing here can read. The
queue is drawn as the [same paged table](#dry-run) the GitHub Inspector's is, over the same 50 rows.

### When a task's pull request merges

A task whose pull request merged ends as **done**, with that pull request as its outcome,
instead of as `failed`. This is **not tied to YOLO mode** - a pull request you merged
yourself on GitHub lands its task exactly the same way.

Everything in this section is written about the task's pull request, singular, which is what
a task attached to one repository has. A
[multi-repo task](dispatch-and-backlog.md#attaching-more-than-one-repository) reads the same
way with one substitution: **every** rule below that turns on "its pull request merged" turns
instead on *every repository it changed* having merged. One sibling landing settles nothing
on its own, in any of the situations below - not the finished-episode conclusion, not the
departed-agent one, and not the polled-by-url upgrade. A repository whose branch never moved
off the commit it was cut at is not one it changed and holds nothing up. The outcome then
names every pull request that landed, and the outcome link stays the primary repository's.

It matters because `failed` means "ended with no outcome recorded", and a failed task
reports as a *stopped* blocker - so every task declared to wait on it deadlocks behind
work that actually shipped. A task left unsettled costs more than a stale row, too: a live
session counts against the `maxSessions` ceiling, *and* the backlog autopilot refuses to
hand work to an agent that still has a non-terminal task bound to it, so a finished agent
both occupies a slot and is ineligible to use it.

**The merge alone does not end the task.** An agent routinely lands an intermediate pull
request and carries on, and you might merge, read the diff for a minute, and only then
tell it to continue - so no delay after the merge is long enough to rule more work out.
The merge is recorded when it happens, and the task is first concluded once its agent
**appears to have finished the episode**: idle, nothing queued, and not rolled onto new
work. An agent that is mid-turn is left alone whatever its pull request did.

Once the agent is **gone for good**, though, any pull request it merged is its outcome -
including one on an episode it had already rolled past. The two cases differ because a
present agent may still be mid-turn: while it is here, a rollover means it was handed more
work, so the merge is not concluded yet (above). But a departed agent has no work in flight
to strand, and reporting a pull request that actually shipped as `failed` would deadlock
every task waiting on it behind a *stopped* blocker. The merge survives the rollover in the
task's durable record, so a later prompt cannot outrun it; if several of the agent's
episodes merged, the **most recent** merge is the one recorded.

An idle agent cannot tell you whether it is finished or merely waiting to be typed at, so
that conclusion is **reversible**: once a follow-up prompt is delivered, the task goes back
to running and drops the outcome. Only conclusions Mission Control drew from idleness are
undone this way - an outcome you recorded yourself is never overwritten. This correction is
deliberately limited to the current daemon run; after a restart, a completed task stays
done.

#### A merge that lands when nobody is watching

Neither of those two moments is guaranteed to arrive. An agent killed while the daemon was
down is never seen being evicted, and a pull request you merge days later belongs to a
session that no longer exists - so the merge had no observer at all, and the task sat
`running` or `failed` for as long as you left it there.

So while its row is still present in Mission Control, a task's own pull requests are
**polled by URL** for as long as its completion is still in question, alongside the ones a
declared dependency is waiting on and at the same rate. No session needs to exist. When one
of them merges, the task is completed from the durable record - and that includes rows that
had already been written off:

| Status when the merge is observed | What happens |
|---|---|
| `running`, `dispatching`, agent gone | **done**, with the pull request as its outcome - or, for a multi-repo task, nothing until the last changed repository's has merged too |
| `running`, `dispatching`, agent still here | nothing yet - the narrower rule above owns it, because the agent may be mid-turn |
| `failed`, `cancelled` | **upgraded to done**: the error is cleared and the pull request becomes the outcome |
| `done` | untouched - your outcome is never overwritten |
| `backlog` | untouched: a rescheduled task is being re-run, so its previous attempt's merge is not this run's result |

Only a **merged** pull request does this. One that was closed without merging changes
nothing, and neither does one still open. An upgrade records an outcome and nothing else:
the worktree, branch and any terminal home stay exactly where they were, still behind the
**Clean up** button, because freeing a checkout runs `git worktree remove --force` and
stays a human's click. Tasks that declared a dependency on the upgraded one are released
at the same moment, which is the point - a `stopped` blocker over work that shipped is
what stalls a backlog.

Unlike the idle conclusion, this one is **not reversible**: it was drawn from a pull
request in main, not from an agent that had gone quiet, so an agent typing again does not
reopen it.

What happens to the agent is yours to choose, in **Settings → Shipping**:

| Close the session after merge | What happens |
|---|---|
| **off** (default) | The agent stays, with its checkout and its context. Once idle, its merged task lands; a later follow-up reopens it |
| **on** | Once the agent is idle with an empty queue, Mission Control first marks the merged task done and then closes its session, freeing a fleet slot for a fresh dispatch. If the merge is observed mid-turn, closure waits for that later idle transition. Its worktree is reclaimed **only** when nothing would be lost - uncommitted or untracked files keep the checkout, and the task row keeps its **Clean up** button |

An agent that is still **working**, awaiting input, awaiting review, or carrying queued
work is neither closed nor failed as a substitute for completion, even with the switch
on. The merge is recorded either way. Once the same episode does finish idle with an empty
queue, its task lands and the enabled switch closes the session.

The reclaim is conditional on purpose: a merge proves the *committed* work landed and says
nothing about files still sitting unsaved in that checkout, and reclaiming runs
`git worktree remove --force`. Anything that could be lost stays behind a human click.

Behind that click, not behind it forever. A checkout kept this way is removed automatically
once **30 days pass with no Git-visible change** in it, uncommitted, untracked and unpushed
work included - see [task worktree retention](worktrees-and-checks.md#task-worktree-retention).
Editing anything in the tree resets that window. Push and merge state are deliberately not
consulted: they decide whether a *merge* reclaims the checkout, and they have no bearing at
all on whether an untouched one is eventually reclaimed by age.
