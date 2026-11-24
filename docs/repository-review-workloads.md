# Repository review workload foundation

Mission Control provides an internal executor, repository MCP and portable checkout artifact
service. Workflow submissions continue to use the existing prompt evidence by default.
Commands and the Inspector gate still pin their existing review commit and publication tree.

## Ownership and data flow

```mermaid
flowchart LR
  Harness[Internal harness] --> Executor[LocalPersonaWorkloadExecutor]
  Executor --> Materializer[Injected artifact materializer]
  Materializer --> Lease[Verified sparse view lease]
  Executor --> Provider[One Claude or Codex SDK session]
  Provider <-->|stdio tools and repository bodies| MCP[Standalone repository MCP]
  MCP --> Reader[Shared policy and bounded reader]
  Reader --> Git[Private bare Git wrapper]
  Git --> Lease
  MCP -->|body-free audit and shutdown seal| Executor
  Executor -->|ordered events and terminal result| Harness
```

`src/shared/repository-access.ts` owns the strict version 1 contracts. The terminal result
kind is append-only: `persona_verdict` is the sole current member. Later work can append
`inspector_verdict` without replacing the transport. Resolved provider, model and effort live
in `request.execution`; the frozen Persona remains separate. Prompt, daemon-owned images,
call-ledger identity and returned usage survive this boundary. This phase writes no ledger.

`WorkflowRepositoryArtifactService.forRoot` gives the manager and supervisor the same
daemon-owned materializer for a canonical artifact directory. The supervisor can install
or revoke its current workload lookup using `setActiveRequestLookup`. The service checks submission, workload, attempt,
locator and digest, and requires the active SQLite claim and ready artifact before opening
the artifact directory. The executor checks the returned identities again.

## Sealing and retention

`prepare` takes the selected checkout, the Workflow diff's source base and an abort signal.
Each stable-capture attempt samples the exact checkout before reading prompt evidence.
The prepared candidate must match that initial fingerprint and a final live sample.
An index-only edit between the prompt read and preparation therefore discards the
candidate and retries the entire read, even when HEAD, worktree bytes and porcelain
status all stay the same. A cleanup failure on a rejected candidate is logged.
Reconciliation retries removal, and the boundary check keeps its original outcome.
The default caller leaves the callback absent.

The version 1 directory contains a canonical JSON manifest and flat files named by Git
object id. Each object file holds its Git type and size header followed by its original
bytes. The SHA-256 of the manifest identifies the artifact. Its sorted object table
authenticates every object's type, size, Git id and SHA-256. Original tree bytes preserve
path spelling, mode and gitlink identity. The path table uses hex for raw filename bytes.
Phase 1 can address only canonical UTF-8 paths. A sensitive or unaddressable path keeps
its tree reference and classification while its blob body is omitted. If an allowed and
a denied path share a nonempty blob, capture fails closed. They can share Git's empty
blob, which has zero payload bytes. The sensitive path still denies reads.

Capture reads index entries and Git's nonignored untracked enumeration with optional locks
disabled. It constructs the layer trees from file bytes, literal link targets and gitlinks.
A checked-out nested repository supplies only its HEAD object ID. Capture fails if that ID
uses a different hash width from the parent repository's tree format.
Each regular worktree file and each Git object read for capture may be at most 64 MiB.
The daemon checks the open file's size before allocating its read buffer and retries
capture if the file grows or shrinks during the read. For Git objects, it requests the
type and size before requesting any payload, including objects needed only by the index,
HEAD or source base. An oversized required payload fails the whole capture.
Loose Git objects are opened under a held descriptor for the source object directory
and inflated from that file. The private Git process reads packs and indexes through
inherited file descriptors. It has no source object directory or alternates to follow.
Capture can pin up to 256 pack/index pairs. This bounds the file descriptors held for
a single capture, including when the checkout and artifact are on different volumes.
An abbreviated base must identify one distinct object across loose files and pinned packs.
All unique Git objects required by the base, HEAD, index and worktree share a 512 MiB
storage allowance, including their Git headers. Capture checks the combined blob sizes
before copying any blob. Pending candidates and private reader leases share a 2 GiB
allowance for object files, manifests and lease data. Each write reserves its bytes
before it starts. A candidate or lease holds its share until its directory is removed.
A repair also reserves the actual size of the old digest before moving it into the
pending directory. Failed cleanup retains this charge for the next maintenance pass.
Writes also leave 64 MiB free on the state volume and account for in-flight filesystem
allocations.
An absent skip-worktree path takes its indexed mode and object ID in the worktree layer.
Files present on disk supply their actual contents, including edits outside a sparse cone.
With `core.fileMode=false`, tracked regular files retain their indexed executable bit,
including intent-to-add entries. Untracked regular files retain their on-disk mode.
With `core.symlinks=false`, a regular file representing an indexed symlink supplies
its literal target bytes and retains symlink mode. Changing either setting invalidates
a pending stable capture.
If a file or symlink disappears or is replaced between inspection and opening it, stable
capture reads the submission again.
Status compares HEAD, the index and the worktree. A deletion already committed between
the selected base and HEAD appears in the base-to-HEAD diff. Staging a deletion and
recreating the path reports both the deletion and the new working file. The reader can
read the recreated bytes. When a directory replaces a file
or a file replaces a directory, the reader gets the missing deletion records from the
verified path manifest. They appear in `git_status` alongside the replacement files and
grant no content access. An intent-to-add path removed before capture appears as an
unstaged deletion even though neither tree contains a file. The same status-only records carry deletions when the live
worktree array is full. Their allowance covers the union of deleted HEAD and index
paths, up to twice the per-layer entry limit. Directory replacements are also recovered for previously sealed
v1 artifacts.
Comparing the layers avoids running repository
filters or textconv to produce status. An unmerged index has no single tree and fails capture.

Before reading the index or history, capture verifies where Git stores the checkout's
metadata. A linked worktree needs its own registration under the common directory and
a backlink to its `.git` file. Other separate Git directories need a local
`core.worktree` setting naming the submitted checkout. Capture holds the validated
directories open while reading and opens the object store relative to the common
directory handle. Replacing a directory invalidates capture even when all Git
contents match. Directory identities travel only in the local stability fingerprint.

History starts at HEAD and visits all parents breadth-first in recorded order. The service
stops before the first revision that would exceed 2,048 commits or 512 MiB of additional
unique allowed blob bytes. It counts objects already required by base, HEAD, index or
worktree once, outside the history budget. Capture also caps additional unique commit
and tree payloads at 64 MiB. A history-only blob over the single-object limit ends the
prefix before that revision. Before copying a revision, capture checks the sizes of the
commit and its new trees. If they would exceed this budget, the preceding revision
remains the end of the retained prefix. A shallow checkout contributes its declared
boundary commits to the same breadth-first prefix. Traversal stops before the first
omitted parent, including at a merge, and records the original parent IDs in the frontier.
Missing objects inside the selected prefix fail sealing. Changing the source's shallow
boundary also changes the stable capture fingerprint.

The queue holds only distinct revisions that can enter the prefix. The v1 descriptor
records up to 100 parents per revision. An older merge above that limit ends the prefix,
and its original commit can still serve as a diff-only base. A HEAD above the limit
fails capture because its complete parent list is required in the descriptor.

Each tree walk can expand up to 200,000 entries and 64 MiB of raw path names. A
streamed index and untracked listing enforces the same limits before opening working
files. The listing counts implicit directories, sensitive names and unaddressable names.
A subtree mounted at two paths contributes both sets of names. When another revision
reuses a subtree at the same path, its cached descendant count and path bytes still
count toward that revision's limits. Across history the same
limits apply to newly retained leaf paths and tree locations. Editing a known file
can reuse its path. An oversized HEAD or selected base fails capture. An oversized
historical revision ends the retained prefix before any of its new paths are published.

During traversal the daemon retains revision metadata and tree IDs. It writes accepted
commit payloads to the candidate and rereads newly selected trees by ID, verifying their
bytes before storage. Earlier commit messages and tree payloads can be freed while
later revisions are still being considered.

`promote` publishes a verified candidate under its digest and attaches a provisional claim
after capture guards pass. Verification syncs the manifest and every object file before
opening the claim transaction. The service flushes the recovery intent and syncs the
directories that name the candidate and published digest before SQLite commits the claim.
A sync failure leaves the submission able to retry. `WorkflowStore.commitRepositoryCaptureActivation` makes the
claim active and the submission running in one transaction. Multiple submissions can
independently own the same bytes. Verification marks a missing or corrupt digest as failed
for all its claims, including when materialization discovers the damage. A transient source
read error or a failure writing a private lease leaves the digest ready so any holder can retry.
If the shared digest directory is missing or invalid, every ready digest in the store
becomes unavailable. Affected submissions can still resume or retry.
Promoting a fresh, verified copy of the same digest can repair its existing claims. The
service replaces only a digest directory it owns and whose contents match the flat file
layout. It checks that layout before recording an intent. A rejected candidate can
be discarded while foreign entries stay in place. If publication is interrupted, reconciliation replays the recorded intent for
existing holders. It verifies the published copy or, if the directory is still missing,
verifies and installs the pending copy. The interrupted submission acquires a claim only
through a successful promotion transaction.
Each lease reconstructs a private loose Git object store
from verified files, along with the layer descriptor used by the MCP. This works after both
the checkout and its Git common directory have disappeared.

Failed capture, submission deletion and evidence retention release claims. The digest row
itself holds cleanup intent and any retryable deletion error. Cleanup syncs the
digest parent before deleting the ownership row, including on retry when the digest
directory is already gone. Publication and release commit
their final row states atomically, so neither operation needs a separately committed
intermediate state. Startup releases provisional
claims and reclaims marked pending and lease directories. A submission still capturing
after restart can replace its released claim in a new promotion transaction, even when
another active submission holds the original digest. A publication intent beside the
candidate identifies a rename interrupted before database commit. If installing an owner
marker fails, the allocator removes the temporary directory it just created. Before
sealing or writing a lease, it flushes the marker and syncs the allocation directory
and its parents through the directory containing the artifact root. Failed seal and
materialization attempts relinquish their temporary directories even if removal fails.
Once the payload is gone, a durable link to the owner marker survives outside the
directory until removal completes. Recovery checks the directory device and inode
before retrying a removal interrupted by daemon exit.
Maintenance can then retry cleanup using their ownership markers. Periodic maintenance
skips live candidates and leases. Reconciliation inspects existing directories and leaves
unused artifact storage absent. Its failures log `repository_reconcile_failed` independently
of Workflow retention results. Artifact operation logs record the underlying error code
or class, including failures to clean up a digest or an abandoned candidate or lease.
Callers receive `artifact_unavailable`. Unknown filesystem entries are counted for investigation.
The cleanup transaction rechecks ownership before removing digest files.

For truncated history, the materializer supplies a `shallow` file containing exactly the
frontier commit ids, one per line. Blame checks this boundary before walking. A merge at the
frontier can still have a retained first parent: `git_show` compares that explicit parent,
while blame conservatively stops at the shallow commit. A source base outside retained
history is usable only by the approved layer diffs.

## Repository capabilities and security

The separate `dist/repository-mcp/server.mjs` bundle publishes exactly `read`, `search`,
`glob`, `git_status`, `git_diff`, `git_show`, `git_log`, and `git_blame`. It has no Mission MCP,
HTTP client, bearer token, Registry, or database import. Its launch runs through `env -i`,
receiving only the descriptor path and executable PATH. Provider credentials never enter it.

All operations share canonical POSIX path validation, case-insensitive sensitive segment
policy and Inspector's secret scrubber. Inspector's historical deny grant remains identical.
Symlinks expose only their target blob bytes; submodules are metadata, never traversed.
Binary content is metadata-only in diffs and unavailable as text. Byte reads are refused if
scrubbing would change the immutable bytes. Multiline scrubbing preserves line coordinates.

Git receives closed argv arrays and only descriptor-derived object ids. A disposable bare
wrapper points at the verified object directory without reading its Git configuration.
Global/system config, hooks, external diff/textconv, credential helpers, lazy fetching,
pagers, optional locks and network protocols are disabled. Alternates and grafts are refused.
Blame disables rename following and ignored-revision files, then validates returned paths
and commit membership. Its evidence ranges describe the actual returned lines, including
Git's end-of-file clamping.

Diffs resolve names before reading any body. They return bounded full-file replacement hunks
constructed from explicitly allowed blobs, with separate old/new half-open line intervals.
This intentionally differs from Git's minimal context patches: it avoids executing content
drivers and permits pagination without making a larger unrestricted patch. Each hunk carries
its literal path and modes; binaries and gitlinks carry metadata only. Log path filtering
compares retained parent entries and includes deletions; a boundary remains explicit.

Per-attempt defaults are 128 calls, 32 MiB of serialized successful results and 15 minutes;
per-call defaults are 1 MiB, 100 items and 10 seconds. Blob/command buffering is also bounded
at 1 MiB. A direct read of a larger blob returns `budget_exhausted`, even for a small
requested window. Search skips oversized, binary and invalid UTF-8 blobs. Diffs report
those paths as metadata. A missing allowed blob still fails the query. A result that
cannot fit one item fails explicitly. Partial pages carry a
limit and HMAC cursor bound to the snapshot, operation, normalized request and policy. Cursors
cannot cross attempts. When a call times out after making progress, search resumes at the
interrupted file and line, and log resumes at the interrupted revision. A time-limited
page can have zero matches and a continuation cursor. Failed, denied, cancelled and omitted items never mint handles.
Each admitted call uses one audit slot, including a call cancelled before it reads anything.
Once the call budget is full, queued requests return `budget_exhausted` before admission.

The reader assigns an unpredictable `evidenceHandleId` to each returned item that has both
an approved repository path and a line, raw-byte, or diff range. For example, a verdict can
cite a text hunk from `git_show` using its operation ID and handle ID. The commit message
from the same query is readable metadata. It has no range or handle and cannot serve
as a repository evidence reference. The same rule applies to metadata-only
items such as `glob` and `git_status` entries, even when they include a path.

Only safe identity, path, range, hashes and counts cross the audit channel. Repository bodies
stay between MCP and provider. At shutdown the MCP publishes its complete audit seal by atomic rename.
The supervisor checks its count and hash before accepting success. Audit write failure fails closed.
Verdict repository references must match that attempt's audited operation and handle. The first
dispatch owns the local run. A replay observer can stop or abort its own stream while the owner
continues. Reconciliation returns cloned, ordered in-memory events. Cancellation generations
prevent older commands from reviving work, and late verdicts cannot become successful results.

## Provider isolation and the executable gate

The provider reply is an object envelope, `{result: {kind: "persona_verdict", verdict: ...}}`,
with the append-only kind inside it. This satisfies the [structured-output object-root
contract](https://developers.openai.com/api/docs/guides/structured-outputs) while allowing
later result kinds. Null optional fields normalize to absence without changing stored Workflow
schemas. The repository's provider-schema registry tests both rendering and parsing.

The dedicated adapters use the installed Claude Agent SDK and Codex SDK. They start one session
in an empty temporary home and working directory, use native image inputs and structured output,
and close the provider/MCP before releasing the view. They do not widen `LlmRunner`.

Claude has no built-in tools or settings sources, uses strict launch-only MCP configuration,
and permits only the eight repository names. Its initialization inventory is checked.
Codex disables native action features and agents, uses read-only/never-approval settings, and
excludes `functions`, `clock`, and `collaboration` from the Code Mode callable registry.
Code Mode's transport wrappers remain, but their callable registry contains only the eight
repository tools. MCP annotations declare closed, non-destructive reads. A preflight rejects
any extra enabled MCP server.

Native inventories are not a stable SDK API. These adapters therefore fail closed unless the
executable is a verified build: `codex-cli 0.166.0` or `2.1.319 (Claude Code)`. This exact allowlist,
rather than an assumed minimum version, is a deliberate Phase 1 deviation. An upgrade requires
rerunning the executable probe and updating the allowlist after its isolation assertions pass.
An unsupported build, tool inventory or effort returns `capability_mismatch` with a closed
reason code. Script-based CLI launchers resolve `env node` through a private link to the
configured Node runtime.
There is no prompt-only, direct-file, or repeated-session fallback. Unsupported Claude `xhigh`
effort fails rather than silently changing the resolved execution.

After building the bundle, run `node --import tsx scripts/probe-repository-providers.mjs`.
It uses the real installed SDK/CLI paths against localhost model fixtures, spends no model
tokens, and verifies native images, multiple calls, exact callable inventories, matching line,
raw-byte and diff ranges, terminal results, cancellation and lease release. The source MCP and
reader tests run without provider binaries. `npm run smoke` verifies both built MCP entrypoints.
