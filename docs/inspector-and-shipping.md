<a id="inspector-automated-pr-review"></a>

# GitHub Inspector (automated PR review)

GitHub Inspector is the optional remote reviewer. It is separate from the local Personas
in [No-Mistakes Review](workflows.md#built-in-personas). No-Mistakes versions 9 through 17
completed after verified PR publication; versions 18 and 19 include the final Inspector gate.
A published workflow keeps its own completion policy. Installing that gate does not enable
Inspector globally or grant posting permission.

The GitHub Inspector reviews the pull requests **Mission Control opened** - and only those -
against the reviewed repo's [`INSPECTOR.md`](#inspectormd), leaves inline review comments for what it finds,
answers replies in its own threads, re-reviews on every push, and resolves its own
threads once a push fixes what they were about. When a live review finds nothing further
and every earlier GitHub Inspector finding is resolved, it leaves one top-level comment for that
head saying the pull request is safe to merge.

### Completion and status

An Inspector completion gate waits for the exact commit the workflow reviewed and every
Inspector finding to be resolved. Captured short commit IDs are resolved in the bound repository
before comparison with GitHub's full ID. A genuinely different PR head requires a fresh workflow
submission; the gate shows both expected and observed commits instead of implying a review is
still running. Existing waiting gates use the same normalization after restart.
If an older binding lacks a repository root, normalization uses the pinned adopted PR's
repository provenance. Missing provenance still blocks the gate.

In Live mode, the gate also waits for the final clean review to be confirmed on GitHub. Review
completion and publication are separate durable facts. A failed clean-review post is retried without
another model review, and a lost response is reconciled against the review marker before posting
again. Findings resolved through replies use the same publication path. An Inspector-only repair
can complete on the same commit when Inspector withdraws the last finding and confirms the clean
review. Legacy reviews without complete provenance are reviewed once before claiming safety.
Reviews that dropped off-diff or over-cap findings are reviewed again on the same commit once
their retained findings resolve. The existing review-round limit still applies. An unreviewable
Live diff reports an error with backoff instead of silently waiting for clean publication.

The session chip says **no open findings** and names the reviewed commit. Its Live checkmark means
the final clean review was confirmed for the observed PR head; a pending or stale review shows an
ellipsis. Workflow completion remains a separate state. Dry run also requires a review of the
observed PR head for a checkmark; it is labeled explicitly and publishes nothing. The gate does
not itself certify CI or authorize a merge.

If Inspector's reply was posted but resolving its thread failed, that resolution is retried without
another reply. An operator resolving local ledger findings does not authorize closing GitHub threads.

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
   blocking the merge over it. If you reply and resolve the GitHub thread together, Inspector
   still evaluates the new reply on its next poll while its local finding remains open.
   Resolving a GitHub thread alone does not clear the finding: Inspector must agree with
   the reply. This works on an unchanged commit and needs no workflow restart or empty push.
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

### Whether a finding reached GitHub

Every finding records whether, and when, it was posted. The time is stamped when GitHub
accepts the review that carried it, or when the next round finds the comment of a review
whose response was lost. It is never cleared, so a finding that was posted and later
resolved still reads as posted, and one raised again in dry run reads as "not posted again,
posted earlier".

Findings recorded before Mission Control tracked posting report only what their row
proves. An open finding, or one with replies, was on GitHub. A dry-run draft never was. A
resolved finding with no replies could be either, and it reads as **unknown** rather than
guessing, until a tick finds its own thread or review on the pull request, which proves it
was posted.

A posted finding also records where it is. An inline finding links to the first comment of
its thread. A finding folded into the review body, because it had no line to anchor to,
links to the review that carried it. The link comes from the pull request read each tick
already makes, and from any later page of threads or reviews that the clean-review check
reads, so it costs no extra GitHub call. It lands on the tick after the review is posted.
Until then the finding reads as posted without a link. When a tick has read only some of a
pull request's pages, it fills a missing link but does not replace a stored one that an
unread page could still prove out of date. The same ownership rule
that decides which threads are the GitHub Inspector's own decides which comment or review a
finding links to, so a comment someone else wrote is never linked. The link is kept when a
finding is raised again, so a finding that is not posted again still points at the comment
where it was posted earlier.

`GET /api/inspector/findings?pr=owner/repo%23123` returns one pull request's ledger row and
every finding on it, in every status, unresolved first and then by severity, path and line.
It answers 400 for a missing or malformed key and 404 for a pull request the GitHub
Inspector never adopted. It is read-only, and it is how Foreman's worker, which never
touches the database, can read finding text.

### Dry run

`dry-run` does everything except post: it adopts, reviews, computes findings and dedupes
them, then records them instead of publishing. **Settings → GitHub Inspector → Inspections** is
where you read what it would have said: each row with findings has a **Findings** control
that opens every draft for that pull request
([Reading a pull request's findings](#reading-a-pull-requests-findings)). Run it there on a
few of your own PRs before you let it speak.

Each row says where that PR stands: `queued` (adopted, not yet looked at), `failed` (the
last round errored - hover the link for why), a finding count, or `clean`, beside a count
of the findings that are no longer open, a **Findings** control on any row with at least one
finding, and - on an open PR still carrying findings - a **Resolve** control that closes them
([why that exists](#how-a-finding-gets-closed)).

That second number says `closed`, not `fixed`, because it cannot tell you which: a finding
closes in [three ways](#how-a-finding-gets-closed) and only one of them is a push that fixed
it. The ledger records the outcome, not which route produced it. A PR that has since closed reads `merged` or
`closed` and is dimmed: it left the sweep for good, so it is history rather than a queue. A
closed PR that *was* reviewed keeps its findings, because what the GitHub Inspector said about
something that landed is the more useful fact. Its count reads as left behind, `3 unresolved at
merge` or `3 unresolved at close`, rather than `3 findings`, since nothing will review them
again. `merged` follows GitHub's own state as of the last poll, so a PR you merged by hand reads
`merged` too, not only one YOLO mode merged.

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

### Drafts after a switch to live

Switching a repository from dry run to live posts the findings dry run drafted. The switch
makes the GitHub Inspector review the same head again (see
[It needs the GitHub Inspector, fully on](#it-needs-the-github-inspector-fully-on)). The
review prompt lists each draft under "Found earlier but never posted", and asks the model only
whether the push fixed it. Whatever the model leaves alone, Mission Control posts itself, in
the same review as anything new. A draft is posted only when all of these hold:

- the model neither resolved it nor raised it again. A draft it raises again is posted as a
  new finding;
- its file is still in the diff, and its line snaps to one GitHub can anchor. A draft about a
  file the push removed stays a draft;
- GitHub has refused it fewer than 3 times.

Drafts share the round's comment cap with new findings. At the same severity a new finding
comes first.

A refusal counts against a draft only when GitHub's answer is about that draft. Mission
Control reads the HTTP status `gh` reports:

| GitHub's answer | What happens |
| --- | --- |
| A rate limit (429, or a 403 secondary limit), an auth or SSO refusal, a server error, any other status that is not 422 | The round fails as any failed review does: the findings stay drafts, the head is reviewed again after backoff, and nothing is counted. |
| A 422 on a head that moved during the review | The same, after one read of the pull request's head. |
| A 422 on an unmoved head | A validation refusal, attributed below. |

For a validation refusal, a review that also carried new findings is sent again at once
without the drafts. If GitHub refuses that one too, nothing is counted and the round fails as
above. Then the drafts are attributed. A single draft records the refusal. Several drafts are
each posted in a review of their own, so a valid draft is never charged for a bad sibling. Each
of those reviews is its own notification on the pull request. A response that never arrived is
not a refusal and is never counted.

Every retry reuses the round's review, so no second model run is made. Once the refusals are
pinned, the round finishes and the head counts as reviewed live. A refused draft stays a draft,
still counts as an open finding for [Shipping](#shipping-yolo-mode), and is offered again on the
next push. At 3 refusals it stops being offered. Its row keeps the count and GitHub's latest
reason. It stays open until a push fixes it and the model resolves it, or you use
[Resolve](#how-a-finding-gets-closed).

The count and the reason show from the first refusal, not only at the cap. Below 3, the
finding still reads **Not posted** in the [Findings modal](#reading-a-pull-requests-findings)
and the workflow Completion tab, with "GitHub refused it 1 time" under it. At 3 it reads
**Refused**. Either way it stays unresolved, so it still blocks [Shipping](#shipping-yolo-mode)
and Foreman still relays it. The relay and the workflow `inspector_feedback` packet mark it
"Not posted yet. GitHub refused it N time(s): <reason>. Mission Control offers it again on the
next push." below the cap, and "Not posted. GitHub refused it 3 times: <reason>" at it.

### Reading a pull request's findings

**Findings** on an Inspections row opens every finding the GitHub Inspector generated for that
pull request, open and closed, in a read-only modal. It is offered on any row with at least
one finding, including a pull request that has since merged or closed. A row with no findings
has no control.

The modal names the pull request with a link to it, says whether it is open, merged or closed,
and counts its review rounds. When the last review was not live and no finding on the pull
request ever reached GitHub, it says so: "Dry run: nothing on this pull request was posted". It
says nothing about posture for a row from a build that did not record it. On a pull request that
merged or closed with findings still unresolved, one line says so: "This pull request merged with
3 findings unresolved. They are kept as a record and will not be reviewed again." The findings
stay on the ledger as the record of what the GitHub Inspector said, and each keeps its own Posted
label.

The table is the one the [Completion tab](workflows.md) uses. Each finding shows its severity,
title, location, round and status, and a **Posted** column that reads
[whether it reached GitHub](#whether-a-finding-reached-github):

| Posted | Meaning |
| --- | --- |
| Posted, linked | On GitHub. The link opens its comment, or the review that carried it. |
| Posted, no link | On GitHub. The link is recorded on a later tick. |
| Not posted | A draft. It exists only in Mission Control. |
| Not posted, "GitHub refused it N time(s)" | A draft GitHub refused once or twice after a switch to live. It is offered again on the next push. Hover for GitHub's reason, which **Show finding** also lists. |
| Refused, "GitHub refused it 3 times" | A draft GitHub refused 3 times. It is no longer offered. The reason shows the same way. |
| Not posted (posted earlier) | Raised again and not posted again. The link opens the earlier comment. |
| Posting | Sent to GitHub, outcome not known yet. |
| Unknown | Recorded before Mission Control tracked posting. |

An unresolved finding's text is always shown. A resolved one's opens with **Show finding**,
which also shows its fingerprint and timestamps. The modal reads
`GET /api/inspector/findings` when it opens and again on the panel's 4-second poll while it
stays open. It has no Resolve: that stays on the row, and closes every finding on the pull
request at once.

## Shipping (YOLO mode)

**Settings → Shipping** is where you decide what lands without you. **YOLO mode** merges
the pull requests Mission Control opened - the same adopted set the GitHub Inspector reviews, and
only those.

It ships **off**, trusting **no repositories**, with a **10 minute** soak.

### CodeRabbit follow-up

**Follow up on CodeRabbit comments** is a separate Shipping setting, off by default and
included in settings snapshots. It works while Inspector reviews and YOLO are off. The existing
daemon poll observes only adopted PRs, including attached repositories, normally every 90 seconds.
It reads GitHub but neither calls a review model nor replies to or resolves threads itself.

A finding is either an unresolved review thread whose first comment belongs to the exact
CodeRabbit Bot account, or an error or warning in that bot's marked pre-merge checks section
in a PR summary issue comment. Both review threads and issue comments are paginated. Passed
and skipped checks, ordinary summary prose, other bots, and human threads with bot replies
are excluded. An outdated unresolved thread still counts. Shipping shows the combined
unresolved finding count, unknown/provider errors, and delivery status beside the merge status.

Foreman must be enabled and Live, invited into the owning session, and trusted for both the
session and the PR's repository. A busy session, human input, queued work, unknown ownership,
draft/closed PR or active or parked workflow holds delivery. No absent session is restarted.
The session is asked to assess findings, fix valid in-scope defects, explain invalid findings,
run focused checks and push to the same PR branch under its task and repository instructions.
This setting grants no merge permission and changes none of the merge gates below.

The repair prompt asks the session to read both inline threads and summary comments, including
each check's full explanation and resolution. Warnings are considered for repair even when
CodeRabbit labels them optional. The session verifies their validity and scope before acting.
This is separate from the [local CodeRabbit workflow Command](workflows.md#local-coderabbit-command):
enabling local review through YAML does not enable PR follow-up or import cloud pre-merge checks.

Each root finding has a durable generation. Each named pre-merge check has its own identity;
its status, explanation and full resolution determine changes, so an unrelated summary edit
does not re-arm it. New roots, root edits and observed reopening can
prompt again; replies, pushes, reordered results, fewer unresolved threads, toggles and restarts
cannot replay handled findings. The daemon claims before sending. Only confirmed non-delivery
releases a claim; a lost response or interrupted send remains **Delivery uncertain**. Manual
messaging remains available. This is conservative delivery, not an exactly-once transport promise.

Observations must complete within 20 pages, 8 MiB total and 60 seconds, with an 8 MiB cap per
provider response. Missing identities, malformed connections, cursor loops and exceeded limits
are unknown, never zero. A newer error immediately disables the prior success for delivery.
A new daemon requires a successful fresh observation. Freshness lasts three poll intervals
(with a one-second minimum for test/development cadences). At most 12 finding links appear in
the prompt, which always asks the session to load the complete list.

### What has to be true

Every one of these, on the same read of the pull request:

| Gate | Why |
|---|---|
| The GitHub Inspector reviewed **this** push, against **this** base | a review of the previous head is not a review of what would land, and the same head against another base is a different diff |
| The GitHub Inspector **published** that review | on, **live**, and the repo on *its* allowlist - see below |
| The pull request targets the repository's **default branch** (`base-not-default`) | YOLO mode lands work on the default branch and nowhere else, whoever chose the base. A base or default branch GitHub did not report fails closed. Stacked pull requests answer this through the next two gates instead |
| A [stacked pull request](#stacked-pull-requests) targets the **default branch** (`stacked-base`) | merging a child into its parent's branch would fold it into the parent's pull request and skip its own review. Only a pull request with stack lineage is evaluated |
| A stacked pull request has been **released** for its current head (`stack-hold`) | a base change alone proves nothing: GitHub retargets a child by itself when the parent's branch is deleted. Only a pull request with stack lineage is evaluated |
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

### Stacked pull requests

A dependent task can **stack** on its prerequisite's open pull request instead of waiting for
it to merge. It starts from the prerequisite's head, opens its own pull request against the
prerequisite's branch, and lands after it. Stacking follows declared
[dependencies](dispatch-and-backlog.md#stacked-dependencies), never a whole repository, so unrelated
work is never chained together.

**Settings → Shipping → Stacked pull requests** sets the default for same-repository
dependencies: *Wait for merge* or *Stack on its branch*. It ships as *Stack on its branch*,
because the [stack lifecycle](#the-stack-lifecycle) catches a stacked child up, retargets and
restacks it, and holds it with a named reason and a fix when its stack breaks. It lands a stack
automatically when the conditions in [when a stack lands by itself](#the-stack-lifecycle) hold;
that section also lists what needs an operator. An install that never chose a value follows the shipped default,
and only an explicit choice is stored, so an explicit *Wait for merge* is kept. **Maximum stack depth** (1 to 5, default 3) caps how many stacked pull requests may
sit above one that targets the default branch. Each dependency can override the default from
its chip in the dispatch form and the backlog editor: **Stack** or **After merge**.

A dependency stacks only when all of these hold. Otherwise it waits for merge as before.

- Its mode is Stack, set on the chip or inherited from the default.
- The prerequisite is a task in the same primary repository. Stacking covers the primary
  repository only; a dependent's secondary repositories are always cut from their default
  branch, and their pull requests carry no stack lineage.
- It is the only unmerged same-repository prerequisite, every prerequisite in another
  repository has merged, and every secondary repository the prerequisite changed has merged.
  A secondary repository counts as changed unless the daemon has observed it unchanged, so a
  change with no pull request yet, or one it could not read, keeps the dependent waiting.
- The stack under the prerequisite is shorter than the depth cap.

The dependent is released to **start** (not completed: the edge is still unsatisfied, and
*Mark done* and *Unblock dependents* are unchanged) once the prerequisite's current episode
has an open, non-draft pull request in its primary repository and its agent has finished
the episode: idle, nothing queued. The primary repository is the one `origin` names when
`origin` is a GitHub remote, otherwise the checkout's only GitHub remote. A pull request in any
other remote's repository is never stacked on, and a checkout where neither rule names one
stacks on nothing, because the child's own pull request would open somewhere else and get no
stack lineage. The daemon records that readiness on the dependency edge,
and the backlog card and the Line row read *Stacked on #N*. It clears the readiness when the
prerequisite starts a new turn, or when the edge stops qualifying, for example when the
default is switched back to *Wait for merge*. Dispatch reads the parent pull request again
before it starts: it must still be open, not a draft, on the same branch and episode, and its
agent still finished. The dispatch then fetches the parent branch at the repository root (from
`origin`, or from the primary GitHub remote when `origin` is another remote that lacks it) and
pins the worktree to its current head, but only when that commit is exactly the head GitHub
reports for the parent pull request. A branch name alone proves nothing: a pull request from a
fork can share its name with an unrelated branch here. If the parent pushes while that check
runs, the check is made again on the new head, up to three times, and the dispatch is refused
rather than started on a superseded commit if the parent is still moving. A refused readiness read is looked at
again about a minute later, so a draft marked ready on GitHub releases its dependent without
anything changing locally. A stamp that stands is read again on the same interval, so a parent
turned back into a draft, closed, or moved out of the primary repository on GitHub withdraws it
and the dependent reads as waiting again. A read that only failed keeps the stamp, because the
dispatch checks everything again before it starts anything. If the parent head lacks the merge commit of another
same-repository prerequisite that already merged, the dependent keeps waiting. That covers a
standalone-session prerequisite too, when its merged pull request is in a repository this
checkout's remotes name. Nothing falls
back to the default branch silently: a stacked task that cannot be pinned is refused with the
reason. A stacked task is always dispatched into a fresh worktree; it is never assigned to an
existing agent.

The task contract and the pull-request packets tell the session to open its pull request
with `--base` set to the expected base and to start the description with "Stacked on #N".
The expected base is the current parent's branch while that parent is open, and the default
branch once it has merged or closed. When the pull request is adopted, the daemon records
its **stack lineage** on the ledger row: the current parent pull request and the commit the
child was cut at. The lineage is written in the same step as the adoption, before anything can
inspect the row, so a stacked pull request is never seen without it. A later pull request of
the same task, repository and work episode (a replacement) inherits that lineage unchanged, while a rescheduled task's next episode starts
fresh from its new dispatch. The daemon then checks the pull request's base and corrects it
with GitHub's API if it is wrong. Nothing is ever retargeted to a merged or closed parent's
branch.

A pull request with lineage is held by the two stacking gates above until a **release
check** passes for its current head, evaluated on the GitHub Inspector tick from GitHub data
only:

| Current parent | Released when | Manual action that satisfies it |
|---|---|---|
| Merged | the base is the default branch and the parent's merge commit is in the child's history | merge the default branch, which now contains the parent's merge commit, into the child and push |
| Closed without merging | the base is the default branch and neither the commit the child was cut at nor the parent's last head is in the child's history | cherry-pick only the child's own commits onto a fresh branch cut from the default branch and open a replacement pull request against it. Merging the default branch into the old child does not help |
| Open | never | the parent has to merge or close first |

The release is recorded against the head it was verified for, and a new head is checked
again. Anything that cannot be read holds. The release also records the parent state it was
granted under. One granted under a merged parent is final, because a merge cannot be undone
and that release verified the merge commit is in the child. One granted under a closed parent
is checked again on every tick, because a closed pull request can be reopened. A reopened
parent, a parent that can no longer be read, or a base that is no longer the default branch
withdraws it. A parent that is reopened and then merges needs its merge commit in the child,
like any merged parent. The child is held until the check passes again. Lineage belongs to the pull request, so switching
the setting off or flipping a chip to *After merge* stops **new** stacks only: a pull request
that is already stacked keeps its hold until it is released. The
[stack lifecycle](#the-stack-lifecycle) below brings it to the state this check accepts.

**Review while stacked.** The GitHub Inspector reviews the pull request's diff against its
current base, and the reviewed head records that base. A base that changes under an
unchanged head (a retarget without a restack) is reviewed again rather than trusted, and a
review recorded before bases were recorded counts only while the base is the default branch.
The review also records the base's commit, because a parent rebased or force-pushed under an
unchanged child keeps both branch names while the diff GitHub shows changes. When the base
commit moves, GitHub's merge base for the old and new commit is compared: the same merge base
keeps the review (the parent only moved forward), and a different one, or an old commit GitHub
no longer knows, means review again. If GitHub cannot report the merge base for the current
commit, the pull request neither merges nor reuses the review on that sweep. This applies to a
pull request with stack lineage or a known base other than the default branch.
Workflow Personas and the CodeRabbit merge base use the same base for a stacked task: the
pull request's current base, read from GitHub for each review rather than taken from the last
poll (a pull request adopted moments ago has not been polled yet), or the parent branch before
a pull request exists. Because the parent keeps moving after dispatch, every review diff first
fetches that branch at the repository root and checks the fetched commit against what origin
advertises. The child's head is read from the repository root too (`git worktree list`), the
merge base the diff starts from is computed there from explicit commit ids, and the diff is
read from the repository root as well, naming the child's checkout explicitly (`--git-dir`,
`--work-tree`) and staging its working tree into a temporary index and object directory, so
the child's own index is never written. Either half can fail, and neither falls back to
another base or to an ordinary diff:

- **Resolving the base** (reading the pull request's current base, fetching and verifying the
  branch, reading the child's head, computing the merge base) fails with *stacked base could
  not be refreshed*, followed by the reason.
- **Capturing the child's work** fails the review capture with *Could not capture repository
  diff*, followed by the step that failed. For example, *could not stage the child's working
  tree* when staging fails, or *could not capture the child's working tree* when the tree
  cannot be written.

The review capture every workflow shares (status, content tree, review snapshot) still reads
the session's checkout, read-only, exactly as it does for any other task.

It never merges into a branch other than the default branch, never force-pushes, never
stacks across repositories, and never runs a git command that changes a worktree's checkout,
branches or commits. The only GitHub write it makes on its own is a pull request's base.

#### The stack lifecycle

A stack keeps itself landable. On every Inspector tick, each open pull request with stack
lineage is observed with its current parent: their states and heads, whether the parent's head
is in the child's history, and how many commits the child is behind (GitHub's compare API).
That observation is recorded on the ledger row, and the lifecycle **state** is derived from it
and from the release record. It runs whatever the Shipping setting says, with the GitHub
Inspector and CodeRabbit both off, and with the child's session gone: the lineage belongs to
the pull request. When more than one state applies, the first in this order wins, so a parent
that advanced and then merged or closed never gets a catch-up prompt:

| State | When | What happens |
|---|---|---|
| Released | the release check passed for the child's current head | nothing: an ordinary pull request against the default branch, merged by the ordinary gates |
| Broken | the parent closed without merging, the parent task was cancelled, failed or rescheduled back into the backlog while its pull request was open, or GitHub closed the child | held, with a named reason and the actions below |
| Parent merged, needs retarget | the parent merged and the child's base is not yet the default branch | the base is retargeted on this tick |
| Restack needed | the parent merged, the child is on the default branch, and the release check has not passed for its head (including a head moved by an unrelated push) | the **restack** prompt |
| Parent moved | the parent is open and its head is not in the child's history | the **catch-up** prompt |
| Current | none of the above | nothing |

**Base reconciliation.** Every tick compares the child's base with the branch it belongs on
(the parent's branch while it is open, the default branch once it merged or closed) and
retargets it through GitHub's API when they differ. It is skipped when they already match,
which covers GitHub's own retarget after an auto-deleted branch. A refused retarget is tried
again on the next tick, and until it succeeds the merge queue reads *Retarget failed:* with
GitHub's reason. The base-aware review record forces a re-review after a retarget, and
`stack-hold` keeps the child held until the restack is verified.

**Prompts.** Two prompts go to the child's session, both through Foreman's review follow-up,
the same path and rules as the CodeRabbit follow-up:

- *catch up*: merge the parent branch in, resolve conflicts, run focused checks, push;
- *restack*: merge `origin/<default branch>` in, resolve conflicts, run focused checks, push.

Both say never to force-push or rebase. Each is claimed before it is typed, keyed to the pull
request, the prompt kind and the tip that made it necessary (the parent's head for a catch-up,
the parent's merge commit for a restack), never to the child's head. An unrelated push to the
child therefore sends nothing new, while the parent pushing again, or a different parent
merging after a replacement, re-arms it. A restart, a push or a setting toggle never re-arms a
claim. Foreman types one only into the child's single live owning session, while it is idle with
no queued turns, no work queue and no active workflow, and only when Foreman is on, live,
allowed in the repository and invited into that session. Those session conditions and the idle
settle window are one shared rule (`followupSessionBlocker`, `foremanSettleMs`) that Foreman's
decision and the daemon's recheck both call, so the worker never selects a prompt the daemon
then refuses. The daemon builds the text from the
ledger row and checks every condition again inside the delivery. A confirmed non-delivery
releases the claim. A delivery that may have landed (a lost response, a restart between the
claim and the confirmation) stays *uncertain* and is never retried automatically, because a
retry could deliver it twice.

The merge queue row keeps the gate label (`stacked-base` or `stack-hold`) and shows the
lifecycle as its detail, which never becomes a gate value:

| Lifecycle label | Meaning | Action offered |
|---|---|---|
| *Stacked on #A (waiting for it to merge)* | current, or caught up | none |
| *Catching up with #A* | the catch-up prompt is pending or delivered | none |
| *Restacking onto main* | retarget or restack under way (counted with **waiting**, not **blocked**) | none |
| *Catch-up needed: no session* / *Restack needed: no session* | no live session owns the child. Nothing is sent and nothing restarts it | resume the task with its **Resume** control. That gives the prompt a live owner again: if Foreman may drive the resumed session (on and live, invited, hooks seen, a pane, allowed in the repository), it delivers the prompt once on the session's first settled-idle tick; otherwise the row reads *Foreman is off* or *Foreman can't send it* and offers the manual send |
| *Catch-up needed: Foreman is off* / *Restack needed: Foreman is off* | Foreman is switched off or not live | **Send catch-up prompt** / **Send restack prompt** |
| *Restack needed: Foreman can't send it - <reason>* (or *Catch-up needed: ...*) | Foreman is on, but its own session rule will never type into the owning session: not invited, no hooks seen, no pane, or not allowed in this repository. The same rule (`followupStableBlocker`) Foreman's decision and the delivery recheck use, so a prompt is never shown as on its way that Foreman would refuse | **Send catch-up prompt** / **Send restack prompt** |
| *Catch-up prompt delivery uncertain* / *Restack prompt delivery uncertain* | the claim was stored but the delivery never confirmed | **Send catch-up prompt** / **Send restack prompt**, which finishes the uncertain claim, claims again and sends once |
| *Catch-up needed: the session has no pane to type into - resume its task to restore one* (or *Restack needed: ...*) | the one live owner has no pane, so neither Foreman nor the operator can type into it | resume the task; no send is offered until a pane exists |
| *Catch-up prompt went to a session that has gone - send it to the resumed one* (or *Restack prompt ...*) | the prompt was delivered, but that session exited before acting on it and the resumed session owns the child now. (While no session owns it, the row reads *no session*.) | **Send catch-up prompt** / **Send restack prompt**, which re-arms the old claim for the resumed session once; Foreman never re-sends it |
| *Retarget failed: <reason>* | GitHub refused the base edit | none; retried every tick |
| *Checking #A on GitHub - prompts wait until it can be read* | the last tick could not read the current parent. Its last known facts are kept, but the parent may have merged or closed since, so no prompt or action is offered on them, Foreman cannot deliver one, and nothing is retargeted | none; the next successful read clears it |
| *Stack broken: #A closed* | the parent closed without merging | **Move onto main**, **Wait for a replacement** |
| *Stack broken: GitHub closed this pull request after #A merged* | the child was closed when its base branch was deleted | **Reopen against main** |
| *Stack broken: GitHub closed this pull request and #A closed* | as above, with a parent that closed unmerged | **Move onto main** |
| *Stack broken: this pull request was closed while #A is still open* | the child was closed (by hand, say) while its parent is open | **Reopen on #A's branch** |
| *Stack broken: #A's task was cancelled* (or *failed*) | the parent task stopped while its pull request is open | **Reschedule #A's task** |
| *Stack broken: #A's task was rescheduled* | the parent task is back in the backlog and has not started again | **Start #A's task** |

The child's board tile shows the same label and buttons. The manual sends use the same inject
route and guards as Foreman, minus Foreman's own switches: the session must still be idle with
no queued turns, no work queue and no active workflow.

**Broken stacks.** A broken child is already held by `stacked-base` or `stack-hold`.

- **Move onto main** asks the session to cherry-pick only its own commits onto a new branch cut
  from the default branch, open a replacement pull request against it and close the old one.
  The replacement inherits the old row's current parent, stack base and lineage history, stays
  on the default branch, and is released only when the closed-parent branch of the release
  check passes. The closed row then reads *Replaced by #N* and offers nothing.
- **Reopen against main** (the child was closed by GitHub and its parent merged) asks the
  session to open a new pull request from the same branch against the default branch, then
  merge the default branch in and push. The new pull request inherits the lineage, and the
  restack and the merged-parent release apply as usual.
A closed child that no later pull request of its task and work episode has replaced keeps being
observed every sweep (GitHub reads only), so the action it offers follows its parent: a child
closed while #A was open offers *Reopen on #A's branch*, and once #A merges it offers *Reopen
against main* instead. Every recovery prompt also reads the parent again just before it is
typed, and is refused if the parent's state - or, for *Reopen on #A's branch*, its branch - no
longer matches what the offer was based on, or GitHub cannot be read; inside the delivery's
write lock it is checked once more against the latest observation. Closed children are read a
bounded page per sweep, round-robin, so every one is reached however many there are, and one
whose parent is confirmed merged is no longer read, since its offer cannot change. A
recovery prompt is claimed like a catch-up or restack, keyed to the stack state it answers:
once delivered it reads *(sent)* and is not sent again - a second *Move onto main* would ask
for a second replacement pull request - until that state changes.

- **Reopen on #A's branch** (the child was closed while its parent is still open) asks the
  session to open a new pull request from the same branch against the open parent's branch.
  It inherits the closed row's lineage, base correction keeps it there, and it is an ordinary
  stacked child again; the closed row then reads *Replaced by #N*.
- **Wait for a replacement** (offered only while the child is open and its parent closed
  unmerged) records the choice. When the parent task opens a replacement pull request in the
  **same work episode** (a session of the parent task, adopted by the Inspector after the closed
  one), the **replacement-parent transition** runs on the next tick. It is the only writer that
  changes a row's current parent, and it writes only the open child's own row, in one step that
  re-checks, as it writes, that the child is still open, the operator still waits for a
  replacement, and the release check has not released its current head meanwhile:
  it appends `{from, to, at}` to the lineage history, makes the replacement the current parent
  and clears the release. The commit the child was cut at never changes. It is idempotent, and
  never runs for a released child or one from the parent task's next episode. The child is then
  retargeted onto the replacement's branch and caught up with it, and is released through the
  merged-parent branch once the replacement merges and the child restacks. A replacement that
  also closes unmerged makes the child broken again, with the same actions.

- **Reschedule #A's task** and **Start #A's task** (the parent task stopped while its pull
  request is still open) restart the parent's work through the task's own reschedule and
  dispatch controls. The child cannot release itself while that pull request is open, so the fix
  is the parent's: once it is running again, in this work episode or a later one, its open pull
  request can be pushed to and merge, and the child reads as stacked again and restacks as usual.
  Closing the parent pull request on GitHub instead turns this into the closed-parent case above,
  with *Move onto main*.

A stacked child is running while its parent's pull request is open, so it is never in the
backlog; the stopped parent is named on the child's own tile and merge-queue row. Flipping an edge to *After merge*, or the Shipping default to *Wait for merge*, after
the child started changes nothing for it.

**When a stack lands by itself.** With YOLO mode on, a two-pull-request stack lands bottom-up
with no human step except conflicts - the parent merges, the child is retargeted, restacked,
released, reviewed clean and merged - when all of these hold:

- the child's task has exactly one live session, and Foreman may drive it: Foreman is on and
  live, invited into that session, the session has reported hooks and has a pane, and the
  repository is on Foreman's allowlist;
- the Inspector reviews live in that repository and YOLO mode may merge there (the ordinary
  merge gates above);
- each prompt Foreman types is confirmed delivered. A delivery whose outcome is uncertain is
  never retried automatically, so it waits for the operator's send (below);
- GitHub can be read for the parent on each tick.

When a prompt is needed and Foreman may not drive the one live session that owns the child, the
child is held and its row says why (*Foreman is off*, or *Foreman can't send it - <reason>*) and
offers **Send catch-up prompt** or **Send restack prompt**: one click from the operator, after
which the stack carries on as above. The same send is offered when a delivery's outcome is
uncertain (*Catch-up prompt delivery uncertain*, *Restack prompt delivery uncertain*), because
Foreman never retries one itself. With no live session the row reads *no session* and waits
for **Resume**. While the parent cannot be read, the row reads *Checking #A on GitHub* and
nothing is offered until GitHub answers. A failing merge gate holds the child exactly as it
holds any pull request.

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

For an assigned agent without task-owned worktrees, the idle conclusion remains
**reversible**: once a follow-up prompt is delivered, the task goes back
to running and drops the outcome. Only conclusions Mission Control drew from idleness are
undone this way - an outcome you recorded yourself is never overwritten. This correction is
deliberately limited to the current daemon run; after a restart, a completed task stays
done. A task with owned worktrees instead enters final closure and return; further work
requires a new agent.

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
nothing, and neither does one still open. An upgrade records the merged outcome, releases
dependents, and starts final completion cleanup for task-owned worktrees. Required archives
are saved before those worktrees are reset and returned.

Final completion of a task with owned worktrees closes its agent and resets and returns those
worktrees, including residual local changes, regardless of the Shipping setting. An agent that
is still working, awaiting input or review, or carrying queued work is not completed from an
intermediate merge. Its episode must first finish idle with an empty queue.

**Settings > Shipping > Close assigned sessions after their pull requests merge** controls
agents without task-owned worktrees:

| Setting | Assigned-session behavior |
|---|---|
| **off** (default) | Keep the agent with its checkout and context; a later follow-up can reopen its inferred completion |
| **on** | Close the idle completed agent to free fleet capacity |

Provider or archive failures preserve the unreturned resource records. See
[task worktree retention](worktrees-and-checks.md#task-worktree-retention) for safe Kill returns,
manual reconciliation, quarantine, and the unchanged 30-day fallback.
