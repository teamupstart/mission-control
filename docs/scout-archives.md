# Scout archives

A scout answers a question. The answer outlives the agent that found it, the task card that
asked for it, the worktree it was found in, and the database that once indexed it - because
the answer is kept as ordinary files on your machine, not as rows.

This page describes the local scout library: where it lives, what a bundle contains, how
Mission Control discovers one, and what deleting one does. It is the storage and API
reference. Automatic capture at the end of a scout task, and the Scouts page that reads the
library, arrive in later changes; today the library is reachable through the daemon's HTTP
API and through your own file manager.

## Where it lives

```text
~/.mission-control/scouts/
  .staging/                     # bundles being written, never discovered
  .trash/                       # bundles being deleted, never discovered
  <producer-id>/                # which machine made these
    <archive-id>/               # one scout
      manifest.json
      report/
        report.html             # the answer
        <files produced beside it>
      artifacts/
        <repo-slot>/path/from/the/checkout
```

`MISSION_HOME` moves the whole thing, exactly as it moves the database. An isolated or demo
daemon therefore keeps its scouts beside its own state instead of writing into your real
library.

Both directory levels are generated UUIDs. Nothing an operator or an agent typed becomes a
directory name: original paths live inside the manifest and are recreated only below a
generated repository slot, after containment checks.

### These files are yours

The library is an ordinary directory of ordinary files. You can copy it, back it up, put it
in a synchronised folder, open a report by double-clicking it, or `grep` it. Mission Control
provides no network transport, account, or remote store for scouts, and never sends archive
data anywhere.

The flip side is worth stating plainly: **Mission Control does not encrypt this directory.**
A scout archive can hold whatever the investigation touched. If you put the library in a
synchronised folder, its contents go wherever that folder goes.

## What one bundle contains

- `report/report.html` - one self-contained, static page: the question, the finding, and the
  evidence. It works from `file://`, uses inline CSS and inline SVG, and makes no network
  request. A non-executing parser checks that before the archive is indexed: scripts, event
  handlers, forms, frames, embeds, anything that re-roots relative URLs (`<base>`,
  `xml:base`), meta refresh, SVG animation, external and protocol-relative URLs anywhere -
  including inside a stylesheet's `url()`, `@import`, or `image-set()` - and relative links
  that leave the report directory are all refused.
- `report/` - every bounded file produced beside the report, keeping its relative path so the
  report's own links to a CSV, an image, or a log still resolve.
- `artifacts/<repo-slot>/…` - supporting files the scout explicitly named, under a generated
  slot per repository.
- `manifest.json` - a versioned, self-describing snapshot: the archive key, the producer, the
  display and search metadata, timing, completeness, artifact provenance, byte sizes, and
  SHA-256 digests.

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

Format versions, capture statuses, artifact roles, and missing-evidence kinds are append-only
identifiers. A bundle from a **newer** Mission Control is listed as unreadable rather than
parsed as the current format.

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

## Discovery is automatic

There is no import step, no reindex button, and no startup migration. SQLite holds a
**disposable** index of the library, and a background reconciler keeps it honest:

1. It runs at startup - after the daemon is already serving, so a large restored library
   cannot delay the port answering - then on a filesystem hint, then on a jittered
   60-second cadence (`MISSION_SCOUT_RECONCILE_MS`).
2. It walks exactly `scouts/<producer-id>/<archive-id>/manifest.json`, skipping `.staging`,
   `.trash`, symlinks, and anything whose name is not a generated UUID.
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

Drop a valid bundle into `scouts/<producer-id>/<archive-id>/` with any tool. It appears
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
GET    /api/scouts?q=&producer=&repo=&agent=&status=&from=&to=&cursor=&limit=
GET    /api/scouts/:archiveKey
GET    /api/scouts/:archiveKey/artifacts/:artifactId
POST   /api/scouts/:archiveKey/artifacts/:artifactId/open
DELETE /api/scouts/:archiveKey
```

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
content-free `scout_archive_changed` frame per reconciled batch tells whatever is on screen
to re-run its own bounded query.

## Deleting a scout

`DELETE /api/scouts/:archiveKey` requires `{"confirmArchiveKey": "<the same key>"}` in the
body and refuses a mismatch before it resolves any path. Then it:

1. atomically renames the bundle into `.trash`,
2. removes its index rows,
3. removes the trash entry.

The durable step is the rename, so a crash in the middle leaves an archive that is gone from
the library and rows the next complete pass prunes; a crash before it leaves the archive
intact. An interrupted deletion is finished on the next start.

This removes **a local file and its rows**. It touches no task, no session, and no
repository, and it makes no claim about copies elsewhere: a two-way sync tool may propagate
the deletion, or may restore the same immutable bundle later. Mission Control publishes no
portable tombstone and cannot promise either behaviour.

Deleting a task, or reclaiming its worktree, never deletes a scout archive. There is no
automatic retention sweep - a ready archive stays until you delete it.

## Related

- [Configuration](configuration.md) for `MISSION_HOME` and `MISSION_SCOUT_RECONCILE_MS`.
- [Database and migrations](database-and-migrations.md) for why the index is disposable.
- [Event stream](event-stream.md) for the invalidation frame.
- [Security](security.md) for the daemon's boundary.
