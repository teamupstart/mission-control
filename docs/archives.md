# Archives

An archive is work that outlives the agent that did it, the task card that asked for it, the
worktree it happened in, and the database that once indexed it - because it is kept as
ordinary files on your machine, not as rows.

Every archive declares its **kind**: what the bundle preserves. Two kinds are produced -
`scout`, an answer to a question, and `plan`, a plan a task wrote - and the container itself
knows nothing about either, which is the point: a third kind of durable artifact reuses this
library rather than growing a second one beside it.

This page describes the local library: where it lives, what a bundle contains, how one is
produced, how Mission Control discovers one, and what deleting one does. It is the storage,
capture, and API reference. The Archives page that reads the library arrives in a later
change; today the library is reachable through the daemon's HTTP API and through your own file
manager.

## Where it lives

```text
~/.mission-control/archives/
  .staging/                     # bundles being written, never discovered
  .trash/                       # bundles being deleted, never discovered
  <producer-id>/                # which machine made these
    <archive-id>/               # one archive
      manifest.json
      report/
        report.html             # the page a reader opens
        <files produced beside it>
      artifacts/
        <repo-slot>/path/from/the/checkout
```

`MISSION_HOME` moves the whole thing, exactly as it moves the database. An isolated or demo
daemon therefore keeps its archives beside its own state instead of writing into your real
library.

Both directory levels are generated UUIDs. Nothing an operator or an agent typed becomes a
directory name: original paths live inside the manifest and are recreated only below a
generated repository slot, after containment checks.

### The compatibility window

Before archives declared a kind, this library was `~/.mission-control/scouts/` and every
manifest carried `"format": "mission-control/scout-archive"`. Both are still read, for ever:

- **Nothing on disk moves.** A bundle published by an earlier build keeps its directory, its
  path and its format string. Discovery walks the archives root and then the scouts root in
  one pass, so both appear in one catalog. A bundle that exists under both - because you
  copied one across - is indexed once, from the archives root.
- **One format is written.** New bundles are written under `archives/`, carrying
  `"format": "mission-control/archive"` and a `kind`. A manifest is never rewritten in place;
  reading a legacy bundle does not upgrade it.
- **A legacy manifest reads as a scout,** which is what it is - that is the only thing the old
  format string was ever used for, and its meaning is frozen rather than reinterpreted.

The cost, stated rather than mitigated: **an archive written by this build is not discovered
by a build that predates it.** It remains an ordinary directory you can open in a file
manager either way, and it is the same one-way property the schedule store already has.

### These files are yours

The library is an ordinary directory of ordinary files. You can copy it, back it up, put it
in a synchronised folder, open a report by double-clicking it, or `grep` it. Mission Control
provides no network transport, account, or remote store for archives, and never sends archive
data anywhere.

The flip side is worth stating plainly: **Mission Control does not encrypt this directory.**
An archive can hold whatever the work touched. If you put the library in a synchronised
folder, its contents go wherever that folder goes.

## What one bundle contains

- `report/report.html` - one self-contained, static page: for a scout, the question, the
  finding, and the evidence; for a plan, the plan. The name is the format's, not the
  checkout's - a plan's `plan.html` is stored here, with its original path recorded in the
  manifest - so a link written *to* `plan.html` from one of its companions points at a name
  the bundle does not use. Links *from* the page resolve normally, which is the direction a
  reader travels. It works from `file://`, uses inline CSS and inline SVG, and
  **fetches nothing when it opens**. A non-executing parser checks that before the archive is
  indexed: scripts, event handlers, forms, frames, embeds, anything that re-roots relative
  URLs (`<base>`, `xml:base`), meta refresh, SVG animation, protocol-relative URLs, relative
  links that leave the report directory, and any URL scheme in a slot the browser fetches on
  its own - `src`, `srcset`, `imagesrcset`, `poster`, `cite`, `ping`, `xlink:href`, and a
  stylesheet's `url()`, `@import` or `image-set()` - are all refused.

  An `http(s)` link a person can **click** is allowed: `<a href="https://…">`. The line is
  what this machine requests on somebody else's behalf when a human opens an archive they
  were sent. An image fetches on open, before anyone has decided anything; a link requests
  nothing until you click it, and then takes you somewhere your own browser shows you. A
  `data:` link target is still refused, and a `data:` image is still bounded and still limited
  to image and font payloads.
- `report/` - every bounded file produced beside the report, keeping its relative path so the
  report's own links to a CSV, an image, or a log still resolve.
- `artifacts/<repo-slot>/…` - supporting files the scout explicitly named, under a generated
  slot per repository.
- `manifest.json` - a versioned, self-describing snapshot: the archive key, its **kind**, the
  producer, the display and search metadata, timing, completeness, artifact provenance, byte
  sizes, and SHA-256 digests. A new scout also carries a bounded human prompt trail: the exact
  stored task intent plus later human follow-ups that Mission Control could attribute to that
  work episode.

The prompt trail is provenance and search context, not a transcript and not the scout's
answer. Assistant prose, hidden reasoning, system text, tool calls and results, vendor
bookkeeping, the generated scout appendix, and turns attributed to Foreman, Workflow or the
harness are not archived. The useful output of a scout remains the report and its evidence.

Task ids, session ids, absolute home paths, and worktree paths are deliberately absent from
the portable manifest. An archive is meant to be readable on a machine that has never heard
of the task that produced it.

### Version 1

`manifest.json` and `report/report.html` are UTF-8 with LF endings and no byte-order mark;
every other file keeps its original bytes. The manifest is pretty-printed so a human can read
it, but readers use fields - nothing depends on byte-for-byte JSON formatting.

`content_digest` is a SHA-256 over a canonical table of the archived files: sort the entries
by archive path ascending, drop `manifest.json`, and write one
`<sha256-hex> <bytes> <archive-path>\n` line per entry in UTF-8. Golden vectors for that
encoding are committed at `test/fixtures/scout-archive/golden-digests.json`, so another
implementation can produce a byte-compatible identity without running Mission Control's code.

Format versions, kinds, capture statuses, artifact roles, and missing-evidence kinds are
append-only identifiers - added at the end, never renamed and never reordered. A bundle from a
**newer** Mission Control is listed as unreadable rather than parsed as the current format,
and so is one declaring a kind this build has no name for.

The prompt extension is additive inside version 1. Its wire shape is:

```json
{
  "archive": {
    "title": "Resume permission loss",
    "question": "Why did a resumed agent lose repository permissions?",
    "prompts": {
      "entries": [
        { "kind": "initial", "text": "Why did a resumed agent lose repository permissions?", "at": null },
        { "kind": "follow_up", "text": "Also compare Pi.", "at": "2026-08-14T15:18:00.000Z" }
      ],
      "truncated": false
    }
  }
}
```

When `prompts` is present, exactly one `initial` entry comes first. `initial` and `follow_up`
are append-only identifiers. `question` remains the bounded list preview for compatibility;
new local captures derive it from the initial prompt, while the prompt entry retains the
longer source text within the explicit byte limits. Older bundles omit `prompts`, parse with no
trail, and are never rewritten.

### Honest completeness

`capture_status` is `complete` or `partial`. A partial archive lists what is missing and why,
and is never presented as complete. A third state, `unreadable`, is the local index's verdict
about a bundle this build refuses - a manifest cannot claim it about itself.

### Limits

Applied before a bundle is published locally and again before an imported one is indexed:

| Limit | Value |
|---|---|
| `report/report.html` | 32 MiB |
| everything under `report/` | 128 MiB across 256 files |
| one supporting file | 64 MiB |
| files declared by one manifest | 512 |
| one bundle's content | 512 MiB |
| `manifest.json` | 4 MiB |
| prompt entries | 256, including the initial request |
| one prompt entry | 256 KiB of UTF-8 text |
| prompt text in one manifest | 3 MiB |

Content-file limits are refused by name. Prompt limits instead keep the initial request and
the newest follow-ups that fit, and set `prompts.truncated` so the surviving trail is never
presented as complete. The 4 MiB manifest limit remains the final publication guard.

## How a scout produces one

Every task whose kind is **scout** is told, in its own prompt, that its deliverable is a page:

> Write the report to `docs/reports/<slug>/report.html` ... Answer first ... Self-contained and
> static ... call the `submit_scout_artifacts` tool with the report path, a short plain-text
> summary of the finding, optional tags, and only the additional files worth preserving.

That instruction is appended by the daemon, not by a skill, so it arrives whether Skills are
enabled or not, and on both delivery paths - a fresh dispatch and a backlog scout dropped onto
an agent that was already running. The shipped `html-report` skill still teaches an agent how
to write a *good* one; the requirement itself does not depend on it being installed.

A scout also **requires** the `submit_scout_artifacts` tool, and that requirement is checked
before the agent starts rather than discovered when it tries to submit - on both delivery
paths, because a backlog scout dropped onto a running agent has its checkout reset first, and
an agent taken apart for a task it cannot finish is the worst version of this.

Two things are established, and they are different questions:

- **Can the bundle be registered at all?** If `dist/mcp/server.mjs` is not on this machine,
  there is nothing to point the launch at.
- **Does that bundle actually publish `submit_scout_artifacts`?** A bundle can be present,
  start cleanly and serve every other tool while missing this one, because `dist/` is rebuilt
  only by `npm run build` and is gitignored - so pulling the scout feature gives you the tool
  in `src/` and not in the file the agent runs. Mission Control answers this by completing a
  real MCP handshake against that exact bundle and reading back its published tools.

Either one failing refuses the launch or the assignment, naming the tool and `npm run build`.
The alternative is the failure this replaces: a scout that writes a finished report and then
has nowhere to hand it over, with no error or warning.

Normal completion still verifies a complete archive first. If no complete report can be
published, the first **Complete & close** attempt changes nothing and shows the daemon's exact
archive problems as a warning. The operator may then cancel so the scout can correct its report,
or explicitly choose **Close without report**. That confirmed exit marks the task done without
inventing a transcript-derived report; no older client or automatic completion path can take it
because the confirmation flag defaults to false.

**An assignment asks a third question, because it targets an agent that is already running.**
That agent's MCP server is a child it spawned at launch, holding whatever the bundle contained
at that moment - so rebuilding the bundle afterwards does not change what the agent can call.
The file on disk therefore only speaks for that agent while the two are the same build, which
is settled by comparing the bundle's write time against the session's start. A session that
started **before** the current bundle was built is refused with the remedy that actually works:
restart it, so it picks the new bundle up. Rebuilding again would not help, and admitting it
would reset the agent's checkout for a task it still could not submit. When a session's start
time is unknown the two cannot be ordered, and the disk check stands on its own.

### What gets captured

| Submitted | Captured as |
|---|---|
| `reportPath` | `report/report.html`, byte for byte |
| every file beside it, recursively | `report/…`, keeping its relative layout so the page's own links still resolve |
| `supporting: [{ repoSlot, path }]` | `artifacts/<repo-slot>/…` |

The archive title is the short `session.name` shown on the live card. If the session has
already gone, capture uses the name frozen for that work episode, then the task title only as
a legacy fallback. Capture does not call a title model or derive another name. The initial
prompt entry is the stored task intent before the 1,000-character `question` preview is
clipped. Later entries are positively delivered human user turns in conversation order.

`repoSlot` is a generated name (`repo-01`) that the task's own prompt hands out, one per
attached checkout. An absolute path, a path that leaves the checkout, a path that resolves
through a symbolic link, a path git ignores, and a file that changes while it is being read are
each refused **by name** - a submission fails with every offending path listed, and the task
stays exactly where it was so the agent can correct all of them at once.

Files beside the report are captured automatically and must not be listed as supporting files.
Hidden entries (`.DS_Store`, an editor swap file) cannot be represented inside a bundle at all,
so they are skipped; if the report actually links to one, the whole capture is refused rather
than published with a dead link.

### Normal completion waits for the archive

A scout's first completion attempt requires its bundle to exist, be verified, and be
`complete`. A missing submission, an invalid report, a changed file, or a limit crossed leaves
the task exactly as it was - still running, still holding its session and its checkout - and
returns the exact problem. The dashboard then offers the explicit **Close without report**
confirmation described above. Indexing is not part of the normal gate: the bundle is durable
before the database knows about it, and a failed index is retried in the background.

Nothing else is a fallback. There is no completion from the conversation, the last assistant
message, or the set of changed files.

### An unexpected exit

If a scout's session goes away before it submitted, Mission Control reserves a capture at the
moment of eviction - while the task, its work episode and its checkouts can still be derived -
and then, in the background:

1. a report the scout actually submitted always wins. Once a submission has been attributed
   to the live scout episode, exit recovery waits for it to be recorded and captured before it
   can publish that episode's archive;
2. otherwise it looks for exactly **one** `docs/reports/*/report.html` in the checkouts the
   task still holds, and captures that one with its representable companions;
3. zero candidates, or more than one, publishes an honest `partial` archive naming what is
   missing. A recovered report with an unrepresentable companion is partial for the same reason.
   It never guesses, and it never writes a report from conversation text.

A partial archive is a real, portable record - it just does not claim to hold the answer, and
it does not satisfy a normal completion.

## How a plan produces one

A [plan task](dispatch-and-backlog.md) writes its plan into the checkout as
`docs/plans/<name>/plan.md` with a rendered `plan.html` beside it, and once it has been phased,
one document per phase in the same directory. When anything is about to destroy that checkout,
Mission Control captures what the task wrote:

| In the checkout | Captured as |
|---|---|
| `docs/plans/<name>/plan.html` | `report/report.html` - the page a reader opens |
| everything else in that directory, recursively | `report/…`, keeping its relative layout so the plan's links to its phase documents still resolve |

A plan bundle has no `artifacts/` half. There is no submission tool, no summary and no tags: a
plan names itself in its own first heading, which becomes the archive's title, and the rest of
the search index is the page's visible text. Nothing an agent typed chooses what is archived.

### Finding the right plan

This is the whole difficulty, and it is the opposite of a scout's. A scout's report is at one
known path. A plan's directory is named by whoever wrote it, in a repository that routinely
holds dozens of unrelated plan directories - this one holds 76 - so capturing "every plan in
the checkout" would archive other people's work on every plan task.

**The task's own diff decides.** Mission Control asks git what this checkout changed since its
source branch, keeps the paths under `docs/plans/<name>/`, and archives those directories and
no others. That answer is derived from the repository rather than from anything an agent said,
so a plan task cannot aim capture at a file it did not write.

It also means the checkout has to belong to this task alone. A diff is only a statement about
one task's work while nothing else is happening in that tree, so a plan is captured **only from
a worktree the task owns**. A plan task an operator assigned to their own running session has
no worktree of its own, and is not archived: reading that shared checkout's diff would attribute
whatever else was in progress there - including a colleague's half-written plan - to this task.
Nothing reclaims that checkout either, so the plan stays where its author left it.

Three consequences worth stating:

- **A task that touched two plan directories produces two archives**, one per plan, never one
  merged bundle. A bundle has exactly one page at its centre, and merging would make one plan's
  page the front of another plan's files.
- **A directory too big for a bundle is trimmed, not dropped.** The plan's page is kept and as
  many of its companions as the archive limits allow follow it; every file that did not fit is
  named in the manifest's missing list. Losing a readable plan because the diagrams beside it
  crossed a size limit would be the exact failure this capture exists to prevent.
- **A checkout that cannot answer the question contributes nothing.** If git cannot report what
  changed, no archive is written for that checkout and the cleanup proceeds. Guessing would mean
  archiving a stranger's plan, which is worse than a missing archive.

  What that costs depends on how far the task got. A plan that reached its ordinary finish is
  committed and on its way to a pull request, so the archive was the convenience and not the
  copy. A plan **cancelled before it committed anything** has neither, and in that one case an
  unreadable checkout does lose it. The trade is deliberate and it is not free.

### Nothing to archive is a normal ending

A plan task that wrote no plan - the human read where it was going, said no, and stopped -
tears its checkout down cleanly. This is the one place plan capture deliberately parts from
scout capture: an ordinary scout finish has a submitted report, so a scout arriving at cleanup
with nothing is an anomaly worth holding a worktree over. The separate, confirmed close without
a report leaves its checkout for the same explicit cleanup path. A plan is not an anomaly, and
treating it the same way would strand that worktree with nothing anyone could do about it.

For the same reason, a plan page that **is** there but cannot lead a bundle - it fetches
something on open, or it crossed a size limit - produces an honest `partial` that keeps the
page under its own name and says why it is not the front of the bundle. What still refuses a
cleanup is a capture that failed for a reason a retry can fix, exactly as for a scout.

### Completion does not wait

A plan task reaches **done** on Foreman's ordinary boundary, like a ship task and unlike a
scout. Durability happens at teardown instead, on every path that destroys a checkout. A plan
is also offered the ordinary wrap-up, so it lands as a pull request - which is what publishes
the paths that any scheduled phase tasks depend on.

Nor does a plan's session going away capture anything, which is the other half of the same
rule. A scout's does, because its report is an untracked file and the session that would have
submitted it is gone. A plan's session can exit while the task is still running, and an archive
can never be rewritten - so publishing then would freeze a draft as the permanent record of a
plan still being written. Teardown is the only moment a plan is captured.

## Cleanup asks first

Reclaim, Remove, Cancel, Reschedule, and the startup pass that reclaims a worktree whose agent
did not survive a restart all publish the task's archives **before** they destroy its checkout,
whichever kind it produces.
When a launched agent is still alive, cleanup stops it before capture so the archive sees the
final bytes at the stop boundary; an agent the operator started and later assigned is never
stopped on the task's behalf.
If that fails, the cleanup is refused: the worktree stays, the task stays reclaimable, and you
can retry. Losing an answer to a transient disk error is not a trade Mission Control makes on
your behalf.

**What cleanup costs depends on the kind, because the two reach it in different states.** A
scout that finished normally already has its bundle - it could not have been marked done
without one - so reclaim re-verifies it and returns, which is cheap and is the common path.
A plan arrives with no bundle at all: its completion is Foreman's ordinary boundary and waits
on nothing, so **cleanup is where a plan is captured for the first time**, and it does the real
work of reading the task's diff, copying the directory and verifying the bundle. Reclaiming a
task that produced nothing to archive is cheap for either kind.

That difference is the approved design rather than an inconsistency: gating a plan's completion
on its archive would have made a plan task hold its session open over a durable-storage step it
does not need, when the plan is already committed and on its way to a pull request.

## Capture jobs are local bookkeeping

`archive_capture_jobs` in the database coordinates all of this: one row per archive a task
work episode owes - one for a scout, one per plan directory for a plan - carrying the reserved
archive identity, the directory it covers, and the checkout locators recovery needs. A scout
row also freezes the selected title and bounded prompt trail. What a row covers is frozen when
it is reserved, so a capture resumed after a restart writes the archive that was reserved
rather than rereading a later session, task or transcript. It is **not**
evidence. A published bundle needs none of it to be read, and deleting the database loses the
ability to resume an unfinished capture, never the ability to open a finished archive.
On startup, a job with a recorded submission resumes even if its scout is still running. Only
an unsubmitted reservation waits while its agent is still expected, so recovery cannot publish
a partial archive ahead of the report that agent may still submit.

## Discovery is automatic

There is no import step, no reindex button, and no startup migration. SQLite holds a
**disposable** index of the library, and a background reconciler keeps it honest:

1. It runs at startup - after the daemon is already serving, so a large restored library
   cannot delay the port answering - then on a filesystem hint, then on a jittered
   60-second cadence (`MISSION_SCOUT_RECONCILE_MS`).
2. It walks exactly `<root>/<producer-id>/<archive-id>/manifest.json` under each library
   root, skipping `.staging`, `.trash`, symlinks, and anything whose name is not a generated
   UUID.
3. It compares each manifest's size and nanosecond modification time with what it indexed
   last time. **An unchanged archive costs one `stat`** - no report is reparsed, no file is
   hashed.
4. A new or changed bundle must look identical across two observations before it is
   verified. Sync tools expose a directory before its payload finishes arriving, and this is
   what stops a half-copied archive from flashing up as corrupt.
5. Once settled, it verifies the manifest, containment, sizes, digests, limits, and the
   report's static-HTML rules, then replaces that archive's derived rows in one transaction.
6. After a **complete** pass, archives the pass did not see are dropped from the index. A
   root the pass could not READ - an unmounted volume, a permission change - is skipped and
   its archives are held back from that pruning rather than forgotten, because "I did not see
   it" and "it is gone" are the same observation from a directory that cannot be opened. Every
   other root still reconciles and still prunes. A root that is simply ABSENT is not a
   failure: an absent library is an empty one, and its rows go.

The watcher is a hint and the scan is the authority, because watchers drop events on network
and synchronised directories - which is exactly where foreign bundles come from.

### Deleting the database

Delete `harness.db` and restart. The index has no fingerprints, so every bundle looks new and
the whole catalog - summaries, prompt detail, artifact metadata, prompt search and full
report-text search - is rebuilt in the background. Nothing prompts, nothing blocks, and no
archive is lost.

### Copying an archive in

Drop a valid bundle into `archives/<producer-id>/<archive-id>/` with any tool. It appears
within one reconciliation cadence.

Because producer ids are random per machine, two people who have never met never collide.
Copying the same bundle twice is idempotent. A completed archive is **immutable**: if a key
that was already indexed comes back holding a different manifest, Mission Control lists it as
unreadable rather than choosing which version of history to believe. Mutation means a new
archive, not a rewritten one.

Renaming in the Scouts page does not mutate that history. It writes a small local display-name
sidecar under `archives/.metadata/names/<archive-key>.json` and projects that name over the
manifest title in the catalog, reader and title search. The archive key, manifest, report,
evidence and digests do not change. Sidecars live outside bundles, survive a deleted and rebuilt
SQLite index, and travel only when the library metadata is copied too.

Every externally copied bundle is untrusted input. Its manifest is validated for schema,
version, generated identities, path containment, limits, and digests before a single row is
written, and its producer label is treated as an unverified claim rather than an identity.

## The API

Everything is loopback-only, behind the daemon's existing boundary.

```text
GET    /api/archives?q=&producer=&repo=&agent=&kind=&status=&from=&to=&cursor=&limit=
GET    /api/archives/:archiveKey
PATCH  /api/archives/:archiveKey  {"title":"Local display name"}
GET    /api/archives/:archiveKey/artifacts/:artifactId
POST   /api/archives/:archiveKey/artifacts/:artifactId/open
DELETE /api/archives/:archiveKey
POST   /mcp/scouts/submit
```

`kind` filters to one kind. An unreadable bundle has no readable kind, so a kind filter
excludes it - which is the honest answer rather than a side effect.

`/mcp/scouts/submit` is the agent-facing one. It requires both the shared harness token and a
daemon-signed credential scoped to the current task checkout. Mission Control provisions that
credential before a dispatched or assigned scout receives its prompt; the MCP bridge reads it
from local state at call time, so a long-lived assigned session receives the credential for its
current task. The request body carries no attribution fields:

```json
{ "reportPath": "docs/reports/resume/report.html",
  "summary": "Resume rebuilt the session without replaying the grant.",
  "tags": ["resume"],
  "supporting": [{ "repoSlot": "repo-01", "path": "evidence/resume-debug.log" }] }
```

There is no environment, task id, session id, cwd, work episode, producer id, archive id,
destination, absolute path, digest, or completion status a caller can send. The signed credential
selects one task and checkout, and the daemon confirms that task is still bound to a live session
in that checkout before deriving the work episode and archive destination. Holding the shared
harness token alone cannot submit for another scout. Calling the tool twice returns the same
archive rather than publishing a second one, and it never writes task status: a scout that has
submitted is a scout that *can* finish.

`archiveKey` is `<producer-id>~<archive-id>`. Both routes and the index address an archive by
that key and an artifact by a generated id - **never by a path.** A request cannot name a
file; the daemon generates the path from the decoded key and re-checks containment on every
read.

Search is server-side, bounded, and literal: it scans normalized segments built at index time
from the title, question, summary, tags, provenance labels, artifact paths, every retained
human prompt, and the visible text of `report.html`, extracted by a non-executing HTML parser
that never loads the page or follows a link. Prompt text uses the same bounded overlapping
segments as report text, and a matching snippet reports `prompt` as its source. Results are
newest first and cursor-paginated; an out-of-range limit or a malformed cursor is refused
rather than quietly reinterpreted. The detail response carries the ordered prompt trail when
the manifest has one; list rows do not carry the full trail.

Artifact bodies are served as attachments with a content type derived from the archive path
through a closed table - never from the manifest's claim - plus `nosniff` and a
`default-src 'none'; sandbox` policy. Archived HTML is never rendered inline on the daemon's
origin, for the same reason checkout files are not: it is content somebody else wrote, and
the daemon's origin is where every action route lives.

Historical archives are not in the SSE snapshot and the browser does not poll. One
content-free `archive_changed` frame per reconciled batch tells whatever is on screen to
re-run its own bounded query.

## Deleting an archive

`DELETE /api/archives/:archiveKey` requires `{"confirmArchiveKey": "<the same key>"}` in the
body and refuses a mismatch before it resolves any path. Then it:

1. atomically renames the bundle into `.trash`,
2. removes its local display-name sidecar,
3. removes its index rows,
4. removes the trash entry.

The durable step is the rename, so a crash in the middle leaves an archive that is gone from
the library and rows the next complete pass prunes; a crash before it leaves the archive
intact. A display-name cleanup failure is returned as an error and remains retryable: the
index row is kept as a marker, and the durable sidecar itself authorizes a cleanup-only retry
if reconciliation or a restart removes that row first. A retry also discovers and removes
the exact key's bundle from `.trash` before it reports success, including after a restart.
An interrupted deletion is finished on the next start. A bundle under the legacy root is
trashed inside that root, so the durable step stays a rename within one directory tree.

This removes **a local file and its rows**. It touches no task, no session, and no
repository, and it makes no claim about copies elsewhere: a two-way sync tool may propagate
the deletion, or may restore the same immutable bundle later. Mission Control publishes no
portable tombstone and cannot promise either behaviour.

Deleting a task, or reclaiming its worktree, never deletes an archive. There is no automatic
retention sweep - a ready archive stays until you delete it.

## Reading one: the Scouts page

**Scouts** is a permanent top-level page, the fourth segment in the title bar, reachable by
<kbd>⇧</kbd><kbd>S</kbd> from anywhere and by a command-palette row that answers to the words
an operator actually reaches for - investigation, findings, report, research, evidence,
history, audit.

It lists the archive library without filtering by `kind`. That is deliberate: an unreadable
bundle has no kind at all, so a `kind=scout` query would hide exactly the state that most
needs an operator, and no other surface lists archives - it would be invisible and
impossible to delete. The cost is that an archive of another kind can appear here, so each
row says which kind it is rather than letting it pass as a scout.

![The Scouts page: the archive rail, the sandboxed report, and the evidence spine](images/scouts.png)

Two stable routes, both copyable:

```text
#/scouts
#/scouts/<producer-id>~<archive-id>
#/scouts/<producer-id>~<archive-id>?q=&producer=&repo=&agent=&status=&from=&to=
```

The filter names are exactly the ones `GET /api/archives` validates, so a link and a request
never disagree. The pagination cursor is deliberately absent: it continues the window you are
looking at rather than naming a place, so a pasted link cannot open on page three with no
first page above it.

Two different things can be wrong with a key, and they are answered differently:

- **Malformed or undecodable** - not a `<producer-id>~<archive-id>` pair of lowercase UUIDs,
  or an escape no decoder can read. The router drops it before anything is fetched, so the
  link opens the filtered list rather than a blank reader. Nothing is asked of the daemon,
  because nothing about the key could name an archive.
- **Well formed but not here** - a real key for an archive this library does not hold, such
  as one deleted since the link was copied, or one that only ever existed on another machine.
  The key is kept and its detail IS requested, because a key absent from the current filtered
  window may still be a real archive. The daemon answers 404 and the reader says *"This scout
  could not be read"* with the reason, beside a control back to the list.

### Three panes

- **The rail** searches. Results are newest first under day headings, each row carrying its
  title, time, artifact count and size, plus the daemon's snippet saying *why* it matched. For
  a newly captured scout, that title is the same short name its live session detail showed.
  Search covers titles, prompts, findings, report text and file metadata; a prompt match is
  labelled `prompt` without replacing that title. Press <kbd>/</kbd> to focus the search box;
  when focus is outside a text field or selector, <kbd>↑</kbd> and <kbd>↓</kbd> open the previous
  or next report in the current results.
- **The reader** leads with the same short archive title and shows it as a rename control.
  Clicking it or pressing the configured session rename binding,
  <kbd>⇧</kbd><kbd>R</kbd> by default, opens the same inline editor sessions use. Enter saves,
  Escape cancels, and a refusal stays in the editor with its reason. The saved name is local
  metadata as described above; it does not rewrite portable evidence. The reader then shows the
  ordered **Prompt context** before the report: **Original request**, then each human
  **Follow-up** with its recorded delivery time. Prompt text is escaped plain text outside the
  report iframe. The whole ledger is bounded to roughly seven lines of the pane and scrolls
  as one past that, so neither a page-long dispatch brief nor a long trail of follow-ups can
  push the report down the pane; the **Prompt context**
  heading is a disclosure that folds the whole ledger away and back, open on arrival and per
  archive. When capture omitted older or oversized prompt text, the reader says the
  trail is incomplete. A bundle from before prompt trails keeps its stored question visible
  below the title and remains readable. The primary report still opens by default in the same
  sandbox the Files tab uses: no scripts beyond the two hashed bridges, no network, and never
  `allow-same-origin`. A relative link inside a report resolves only to a verified companion
  artifact in the same bundle; every unclaimed link stays inert.
- **The evidence spine** lists every artifact as a stop on one line, with its role, repository
  slot, original checkout path, media type, byte count and SHA-256, and offers preview,
  download and registered open. Below it sits the absolute bundle directory, copyable, so the
  files are reachable without the app.

### It is honest about what it has

State is never carried by colour alone - every one of these is a word on screen:

| Index state | What the page shows |
| --- | --- |
| `ready` | **Complete**. The report reads; the evidence is all present. |
| `partial` | **Partial**, amber, and every `missing` entry enumerated with its expected source and reason. It is never presented as an answer. |
| `unreadable` | **Unreadable**, red, showing only the daemon's safe diagnostic. There is nothing to read, and the page says so rather than rendering an empty document. An unreadable bundle has no title, so it is listed by its archive id. |

A **failed request is not an empty library.** "The scout archive is unavailable" and "No
scouts archived yet" are different sentences, because telling an operator their evidence is
gone when the daemon merely refused would be the worst thing this page could do.

A `producerLabel` copied in from another machine is shown and marked **unverified**: it is a
claim in a manifest, not an authenticated identity.

### It refreshes without polling

The page consumes the `scout_archive_changed` revision from the existing event stream. A
reconciled batch, or a reconnect, refetches the current window and the open archive. There is
no interval, no second SSE connection, and no archive history in the opening snapshot.

### Deleting from the page

**Delete scout** appears in the selected archive's header and on every row. Both open one
confirmation that names the archive, states the local consequence and the sync caveat, and
requires the literal word `DELETE`. The archive key is captured when the control is pressed
and echoed as `confirmArchiveKey`, so background reconciliation reordering the rail underneath
an open dialog cannot redirect a confirmed deletion onto a different archive. Rows disappear
only after the daemon confirms; a refusal keeps the dialog open with the reason.

## Related

- [Configuration](configuration.md) for `MISSION_HOME` and `MISSION_SCOUT_RECONCILE_MS`.
- [Database and migrations](database-and-migrations.md) for why the index is disposable.
- [Event stream](event-stream.md) for the invalidation frame.
- [Security](security.md) for the daemon's boundary.
