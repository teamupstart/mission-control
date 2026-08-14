# Archives

An archive is work that outlives the agent that did it, the task card that asked for it, the
worktree it happened in, and the database that once indexed it - because it is kept as
ordinary files on your machine, not as rows.

Every archive declares its **kind**: what the bundle preserves. Today one kind is produced,
`scout`, and most of this page is about how a scout's answer becomes one. The container
itself knows nothing about scouting, which is the point: the next kind of durable artifact
reuses this library rather than growing a second one beside it.

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
  finding, and the evidence. It works from `file://`, uses inline CSS and inline SVG, and
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
  sizes, and SHA-256 digests.

The conversation is **not** archived. Neither are hidden reasoning, system prompts, raw tool
protocol, or vendor bookkeeping. The useful output of a scout is the finding and its
evidence, not the turns spent reaching it.

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

Crossing one is refused by name. Mission Control does not publish a green archive that
silently omitted evidence.

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
has nowhere to hand it over, with no error, no warning, and a task that never reaches **done**.

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

`repoSlot` is a generated name (`repo-01`) that the task's own prompt hands out, one per
attached checkout. An absolute path, a path that leaves the checkout, a path that resolves
through a symbolic link, a path git ignores, and a file that changes while it is being read are
each refused **by name** - a submission fails with every offending path listed, and the task
stays exactly where it was so the agent can correct all of them at once.

Files beside the report are captured automatically and must not be listed as supporting files.
Hidden entries (`.DS_Store`, an editor swap file) cannot be represented inside a bundle at all,
so they are skipped; if the report actually links to one, the whole capture is refused rather
than published with a dead link.

### Completion waits for the archive

A scout cannot be marked **done** until its bundle exists, has been verified, and is
`complete`. A missing submission, an invalid report, a changed file, or a limit crossed leaves
the task exactly as it was - still running, still holding its session and its checkout - and
returns the exact problem. Indexing is not part of that: the bundle is durable before the
database knows about it, and a failed index is retried in the background.

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

### Cleanup asks first

Reclaim, Remove, Cancel, Reschedule, and the startup pass that reclaims a worktree whose agent
did not survive a restart all publish the scout's archive **before** they destroy its checkout.
When a launched agent is still alive, cleanup stops it before capture so the archive sees the
final bytes at the stop boundary; an agent the operator started and later assigned is never
stopped on the task's behalf.
If that fails, the cleanup is refused: the worktree stays, the task stays reclaimable, and you
can retry. Losing an answer to a transient disk error is not a trade Mission Control makes on
your behalf.

Reclaiming a scout that finished normally is cheap - its bundle already exists, and the guard
re-verifies it and returns.

### Capture jobs are local bookkeeping

`archive_capture_jobs` in the database coordinates all of this: one row per task work episode,
carrying the reserved archive identity and the checkout locators recovery needs. It is **not**
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
6. After a **complete** pass, archives the pass did not see are dropped from the index.

The watcher is a hint and the scan is the authority, because watchers drop events on network
and synchronised directories - which is exactly where foreign bundles come from.

### Deleting the database

Delete `harness.db` and restart. The index has no fingerprints, so every bundle looks new and
the whole catalog - summaries, artifact metadata, and full report-text search - is rebuilt in
the background. Nothing prompts, nothing blocks, and no archive is lost.

### Copying an archive in

Drop a valid bundle into `archives/<producer-id>/<archive-id>/` with any tool. It appears
within one reconciliation cadence.

Because producer ids are random per machine, two people who have never met never collide.
Copying the same bundle twice is idempotent. A completed archive is **immutable**: if a key
that was already indexed comes back holding a different manifest, Mission Control lists it as
unreadable rather than choosing which version of history to believe. Mutation means a new
archive, not a rewritten one.

Every externally copied bundle is untrusted input. Its manifest is validated for schema,
version, generated identities, path containment, limits, and digests before a single row is
written, and its producer label is treated as an unverified claim rather than an identity.

## The API

Everything is loopback-only, behind the daemon's existing boundary.

```text
GET    /api/archives?q=&producer=&repo=&agent=&kind=&status=&from=&to=&cursor=&limit=
GET    /api/archives/:archiveKey
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
from the title, question, summary, tags, provenance labels, artifact paths, and the visible
text of `report.html`, extracted by a non-executing HTML parser that never loads the page or
follows a link. Results are newest first and cursor-paginated; an out-of-range limit or a
malformed cursor is refused rather than quietly reinterpreted.

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
2. removes its index rows,
3. removes the trash entry.

The durable step is the rename, so a crash in the middle leaves an archive that is gone from
the library and rows the next complete pass prunes; a crash before it leaves the archive
intact. An interrupted deletion is finished on the next start. A bundle under the legacy root
is trashed inside that root, so the durable step stays a rename within one directory tree.

This removes **a local file and its rows**. It touches no task, no session, and no
repository, and it makes no claim about copies elsewhere: a two-way sync tool may propagate
the deletion, or may restore the same immutable bundle later. Mission Control publishes no
portable tombstone and cannot promise either behaviour.

Deleting a task, or reclaiming its worktree, never deletes an archive. There is no automatic
retention sweep - a ready archive stays until you delete it.

## Related

- [Configuration](configuration.md) for `MISSION_HOME` and `MISSION_SCOUT_RECONCILE_MS`.
- [Database and migrations](database-and-migrations.md) for why the index is disposable.
- [Event stream](event-stream.md) for the invalidation frame.
- [Security](security.md) for the daemon's boundary.
