# Phase 2 - Exact review-state materialization and the repository read service

Source plan: `docs/plans/persona-repository-access/plan.md` (rendered at `plan.html`).
Index: `docs/plans/persona-repository-access/phased-plan.md`.

## Outcome

Every workflow submission carries an immutable, durable record of the **exact** state that was
submitted for review - committed, staged, unstaged and untracked - which survives the session's
worktree being released, reset or deleted. The daemon can answer every typed repository operation
the approved capability list names against that record, with path validation, sensitive-path
denial, mode classification, output bounds and a durable audit row per operation.

No model is pointed at it yet. That is the point of the boundary: the security surface of this
feature is reviewed on its own, against its own adversarial tests, before anything can reach it.

## Entry criteria and dependencies

- **Direct phase dependencies: none.** This is a root phase.
- Runs concurrently with Phase 1. The two share `src/server/db.ts` and
  `src/server/workflows/store.ts` but touch disjoint tables, disjoint methods and disjoint
  append-only regions. Either may merge first; see the compatibility audit.

## Scope

In scope:

- `workflow_submissions.review_snapshot_oid` and `.review_snapshot_repo_root`.
- The `workflow_repository_queries` audit table and its store reads/writes.
- Snapshot creation inside the existing capture window, and snapshot deletion in retention.
- A startup sweep for orphaned snapshot refs.
- The provider-neutral query/result contract in `src/shared/`.
- The read service: eight typed operations against a snapshot commit, with validation, denial,
  bounds and audit.
- The shared glob matcher.
- Documentation of the trust boundary.
- Unit, security, persistence and integration tests.

Explicit non-goals:

- No Persona setting, no snapshot field, no publish change, no Persona Editor work. Phase 1.
- No broker loop, no prompt change, no engine wiring, no run-detail UI. Phase 3.
- No worktree lease. This phase borrows no checkout; see the findings.
- No write, shell, or network operation of any kind.

## Repository findings this phase must respect

Re-verify at implementation; these were true at planning time, and the measurements are the
reason for the design.

- **A pooled worktree can be reset underneath a running review.**
  `nativeWorktreeOwnerReferenced` (`src/server/worktrees/owners.ts:18`) consults `tasks`,
  `task_repos`, `workflow_check_leases` and `worktree_slots` - there is no `workflow_runs`
  clause. Task teardown calls `release(lease, { ownerAuthorized: true })`
  (`src/server/dispatcher.ts:2027`), which skips the domain check, leaving only process
  occupancy - and a server-side review holds no process in the tree.
  `src/server/workflows/manager.ts:1163` already records the consequence in prose. **Do not read
  the live checkout at review time.**
- **`check-lease.ts` is deliberately not reused.** It exists because a check runs a *build* in a
  tree. A repository read needs no tree, so a lease would add a durable row, a holder token, a
  reclamation ladder and a second pool consumer for a problem the object database does not have.
  Its `pinnedPaths()` hook stays unused by this phase.
- **The capture window already exists.** `readWorkflowContextRaw`
  (`src/server/workflows/context.ts:559`) resolves the checkout through
  `workflowCheckoutPath(binding, session)` (`:548`), reads repository evidence, and returns a
  `boundary` the manager re-reads and retries once against before persisting. `WORKFLOW_CONTEXT_TIMEOUT_MS`
  is 45,000.
- **Fingerprints must not move.** `evidenceFingerprint` is identity (trigger keys, idempotency)
  and `repositoryFingerprint` is change detection (the unchanged-resubmission guard). Adding the
  snapshot oid to either invalidates every existing run.
- **Measured git behaviour** (this repository, git 2.50.1):
  - `cp .git/index $TMP` then `GIT_INDEX_FILE=$TMP git add -A`: **34 ms**, 2,633 paths. Cold
    (`read-tree <commit>` then `add -A`): 729 ms. Live worktree and live index unchanged either way.
    The cost is the same whichever commit seeds the cold path - it is dominated by re-hashing, not by
    the seed - so seeding from the captured `headSha` rather than `HEAD` is free. The timing was
    originally taken with `HEAD`, which is where that mistake entered the plan.
  - `git rev-parse --git-path refs/mission-control/...` resolves into the **common** `.git/refs`;
    `HEAD` resolves per-worktree. So the ref survives linked-worktree removal.
  - `git gc --prune=now` keeps the snapshot commit while the ref exists.
  - `git add -A` respects `.gitignore` (verified: `node_modules/` absent) but an untracked,
    **non-ignored** `.env` **is** in the tree. The denylist is still required.
  - A symlink is mode `120000` whose blob content is the target string. Submodules are `160000`.
  - `cat-file -p <snap>:../etc/passwd`, `:/etc/passwd` and `:.git/config` all fail at the git
    layer.
  - `git cat-file --batch-check` returns `<oid> <type> <size>` or `<rev> missing` **without
    reading bytes**, and distinguishes `blob` from `tree`.
  - `git ls-tree -r -z` emits `<mode> <type> <oid>\t<path>` NUL-terminated.
  - **`git ls-tree` does not support `:(glob)` pathspec magic**; `git grep` does.
  - `git grep -I` skips binary content; `git log --max-count=N --format=<NUL-separated>`,
    `git blame --porcelain <commit> -- <path>` and `git diff --name-status <a> <b>` all work
    against the snapshot commit.
- No glob dependency exists (`package.json` has no `minimatch`/`picomatch`), and there is no
  in-repo glob helper.
- `run` (`src/server/util/exec.ts`) is the argv-array subprocess helper every git call in this
  repository uses, with a `timeoutMs`. `src/server/diff.ts` is the model for reporting a git
  failure honestly rather than returning an empty success.
- `scrubSecrets` is `src/server/inspector/scrub.ts`; `untrustedBlock` is
  `src/server/review/prompt.ts`; the Inspector's `DENY_PATHS` is
  `src/server/inspector/worker.ts:295`.
- `migrate(d)` runs on every open and must be idempotent; `addColumn` reports whether it added.

## Implementation steps

### 1. Shared contract - `src/shared/repository-query.ts` (new)

Browser-safe, no `node:` imports, because the audit surface renders these shapes.

- `REPOSITORY_QUERY_OPS = ["read_file", "search_text", "list_paths", "git_status", "git_diff", "git_show", "git_log", "git_blame"] as const`
  and `RepositoryQuery`, a discriminated union on `op` with the arguments the plan's table names.
- `REPOSITORY_OP_SAFETY: Record<RepositoryQueryOp, ReadonlySet<RepositorySafetyStep>>` - which
  handlings each op's output requires, as a total `Record` so a new op **cannot compile** without
  stating them. A **set**, because an op whose output carries more than one kind of thing needs more
  than one handling, and `git_blame` is one. This
  is the same enforcement idiom `LLM_RUNNERS` uses on `LlmRunnerId` and
  `SESSION_FIELD_COMPARATORS` uses on a new `Session` field, and it is here for a demonstrated
  reason rather than a stylistic one: the per-op version of this rule failed three times in review -
  `git_diff`, then `git_show` with the identical content hole, then `git_log` filed under a class
  whose safety argument did not apply to it. A `Record` makes the omission a type error.
  It describes **output only**. Validation of a supplied path is universal and independent of it -
  see *Two axes* below, and note that conflating the two is what produced the `git_log` hole.
- `REPOSITORY_DENIAL_CODES = ["not_found", "not_a_file", "sensitive_path", "path_invalid", "symlink", "submodule", "binary", "too_large", "unsupported_rev", "invalid_argument", "budget_exhausted", "unavailable", "cancelled"] as const`.
  Appended-only; the strings reach durable audit rows.
- `RepositoryQueryResult`: `{ ok: true; op; ...payload; bytes; truncated; omittedBytes }` or
  `{ ok: false; op; code; detail }`.
- `REPOSITORY_QUERY_LIMITS.statusPorcelainBytes` (2,000,000) - the capture-time bound on the
  persisted `--porcelain=v2` status. It sits with the query limits rather than beside the snapshot
  service because `git_status` is what reports its truncation, and one budget belongs in one file.
- `REPOSITORY_QUERY_LIMITS` exactly as the plan's limits table states, with each value's reason in
  a comment. `maxRounds` and `maxQueriesPerRound` live here too even though Phase 3 is their only
  consumer - they are part of one budget and splitting them across phases would let the two halves
  drift.
- `matchesRepositoryGlob(path, glob)`: a deliberately minimal matcher supporting `*` (no
  separator), `**` (any, including separators) and `?`. Document the minimality as a choice: git's
  own pathspec magic is unavailable on `ls-tree`, and no glob dependency exists, so a small
  audited matcher is preferable to either a new dependency or two different glob semantics.
- `REPOSITORY_DENY_GLOBS`: the repository-relative denylist. Seed from the Inspector's
  `DENY_PATHS` and **strengthen** it: `.git/**` outright rather than only `.git/config`. Do not
  import the Inspector's array - its entries include absolute host globs (`//Users/*/...`) that
  are meaningless against a tree, and coupling the two would let a change for one reviewer move
  the other silently. State the relationship in a comment and pin the repository-relative overlap
  in a test.

### 2. Persistence - `src/server/db.ts`

Boot block:

```sql
-- The exact submitted state this submission was reviewed against, as a commit in the
-- repository's own object database, pinned by refs/mission-control/review-snapshots/<id>.
-- NULL on every row written before the column and on any submission whose repository could
-- not be snapshotted; a reader must treat NULL as "no exact state is available".
ALTER-equivalent on workflow_submissions: review_snapshot_oid TEXT
ALTER-equivalent on workflow_submissions: review_snapshot_repo_root TEXT
-- The complete `git status --porcelain=v2 -z --untracked-files=all` taken in the same capture
-- window as the snapshot. The snapshot tree records one blob per path and so cannot express the
-- staged-versus-worktree distinction at all; this is the only durable record of it. NULL on a row
-- written before the column, and on any submission whose status could not be captured.
ALTER-equivalent on workflow_submissions: review_status_porcelain BLOB
-- Set when the porcelain exceeded statusPorcelainBytes and was stored as a prefix, so git_status
-- reports truncation instead of implying completeness.
ALTER-equivalent on workflow_submissions: review_status_truncated INTEGER NOT NULL DEFAULT 0

CREATE TABLE IF NOT EXISTS workflow_repository_queries (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  submission_id    TEXT NOT NULL,
  node_attempt_id  TEXT NOT NULL,
  round            INTEGER NOT NULL,
  ordinal          INTEGER NOT NULL,
  op               TEXT NOT NULL,
  -- Byte-exact, because git paths are bytes and a TEXT column collapses two distinct paths
  -- that decode to the same string. The browser renders a labelled lossy display form.
  path             BLOB,
  detail           TEXT,
  outcome          TEXT NOT NULL,
  denial_code      TEXT,
  bytes            INTEGER NOT NULL DEFAULT 0,
  truncated        INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_repository_queries_identity
  ON workflow_repository_queries(node_attempt_id, round, ordinal);
CREATE INDEX IF NOT EXISTS idx_workflow_repository_queries_run
  ON workflow_repository_queries(run_id, created_at);
```

In `migrate(d)`, **one `addColumn` per column this phase adds to `workflow_submissions` - all
four**, not just the snapshot pair:

```ts
addColumn(d, "workflow_submissions", "review_snapshot_oid", "TEXT");
addColumn(d, "workflow_submissions", "review_snapshot_repo_root", "TEXT");
addColumn(d, "workflow_submissions", "review_status_porcelain", "BLOB");
addColumn(d, "workflow_submissions", "review_status_truncated", "INTEGER NOT NULL DEFAULT 0");
```

An earlier draft said "the two `addColumn` calls" and was never updated when the status columns were
added to the boot block in round 12. The consequence is invisible on a fresh install and total on an
upgrade: `CREATE TABLE` supplies the column to a new database, so every test and every developer
machine looks fine, while an existing installation never gets it and the capture write fails or the
`git_status` read finds nothing. Create the run index in `migrate()` only if it names a
just-added column - the constraint `db.ts:1245-1249` documents. The unique index is the durability
guarantee that a retried round cannot double-write its audit.

### 3. Snapshot service - `src/server/workflows/review-snapshot.ts` (new)

- `reviewSnapshotRef(submissionId)` - the one place the ref name is spelled.
- `createReviewSnapshot({ repoRoot, checkout, headSha, submissionId })`:
  1. resolve `--git-common-dir` and `--git-dir` (argv arrays, never a shell);
  2. copy the checkout's live index to a temp path, falling back to
     **`read-tree <headSha>`** - the captured commit, never `HEAD` - into an empty temp index when
     the copy fails. The fast path is 34 ms and the fallback is 729 ms, and the fallback must exist
     because a fresh or repaired worktree may have no readable index.
     **Never `HEAD` here.** It is the third place in this plan where live `HEAD` stood in for the
     captured commit, and this one is silent: if the worktree advanced or was reassigned between
     capture and the fallback, seeding from `HEAD` omits paths that were **tracked at the captured
     commit but match a `.gitignore` pattern**, because `add -A` will not re-add an ignored path
     that the seeded index does not already track. Verified - a `build/config.json` force-added at
     the captured commit and untracked by a later one vanishes from the snapshot entirely:

     ```
     seeded from live HEAD:        .gitignore  app.ts
     seeded from captured headSha: .gitignore  app.ts  build/config.json
     ```

     **And the existing parent assertion cannot catch it**, which is why this is called out rather
     than left to that guard: `commit-tree -p <headSha>` sets the parent correctly however the index
     was seeded, so the parent check passes on a tree that is missing submitted content.
  3. `add -A`, then `write-tree` - **both with every configured `filter.*.clean` and
     `filter.*.process` overridden**, per *Capture neutralises content filters* below. Without it the
     stored bytes are the filter's output, not the submitted content.
  4. **Verify the tree before committing it, rather than trusting the seed.** Copying the live index
     is what buys the 34 ms, but that index reflects whatever the checkout currently tracks, so the
     fast path carries the same hazard as the fallback. Compare
     `git ls-tree -r --name-only <headSha>` against the written tree, and for every path tracked at
     capture but absent from the tree, require that it is also absent from the worktree on disk. A
     genuine deletion satisfies that; a path still on disk that disappeared from the tree is the
     fault above, and it discards the attempt and retries through the cold path, which is seeded
     from `headSha` and correct by construction. The difference set is normally empty or tiny, so
     this costs one `ls-tree` and a sorted comparison.
  2c. `write-tree` on the copied index **before** `add -A`, giving the **index tree** - the
     staged version of every path. Verified essentially free: one extra `write-tree` on an index
     already in hand, and for a staged-then-modified file the two trees genuinely differ
     (`STAGED-VERSION` versus `WORKTREE-VERSION`). Committed and pinned under
     `refs/mission-control/review-index/<submissionId>`, a **sibling** ref rather than a second
     parent of the snapshot commit: a second parent would put the index commit into the snapshot's
     ancestry, and `merge-base --is-ancestor` is what `git_show` and `git_diff` gate on, so it
     would silently widen what those ops accept.
  4b. capture `git status --porcelain=v2 -z --untracked-files=all`, bounded by
     `statusPorcelainBytes`, and return it with a truncation flag for the manager to persist beside
     the oid. Taken in the same window as the tree, so the two describe one instant.
  5. `commit-tree -p <headSha>`, then `update-ref`. **`commit-tree` runs with an
     explicit daemon-owned identity** in its environment - `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
     `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` - and never relies on repository or global config.
     Verified: with no identity configured, `commit-tree` exits non-zero with "Author identity
     unknown", so a freshly cloned repository that never set `user.email` would fail every snapshot,
     and Phase 3 would then retry and block every access-enabled Persona before any provider call.
     The explicit identity also fixes provenance in the opposite case: on a machine that *does* have
     config, the operator would otherwise be recorded as the author of an object the daemon wrote.
     Constants live beside `reviewSnapshotRef` so one module owns the namespace and the identity;
  6. assert the resulting commit's parent equals `headSha`, and return
     `{ oid, repoRoot }` or a typed failure naming which step failed. This assertion is cheap and
     kept, but note what it does **not** cover: the parent is correct by construction because it is
     passed explicitly, so step 4 is the check that the *tree* is right;
  7. clean up the temp index on every path.
  Never touch `GIT_INDEX_FILE` for the live index, never write into the worktree, and never run
  anything that could check out a tree.
- `deleteReviewSnapshot(repoRoot, submissionId)` - `update-ref -d` for **both** refs, the
  snapshot and the index tree, idempotent. One function deletes both so retention cannot free one and
  leak the other.
- `sweepOrphanReviewSnapshots(repoRoots, liveSubmissionIds)` - `for-each-ref` under **both**
  namespaces,
  delete any ref whose submission id is not live. Called once at daemon start, bounded.

### 4. Capture integration - `src/server/workflows/context.ts`

Create the snapshot immediately after `readRepositoryEvidence` inside `readWorkflowContextRaw`,
and return `{ oid, repoRoot }` on the existing `WorkflowRawCaptureRead` so the manager can persist
it in the same write that persists the raw evidence.

Two hard constraints:

- **Do not touch `sourceFingerprintFields`, `workflowContextFingerprint` or
  `workflowRepositoryFingerprint`.** Pinned by a test asserting both fingerprints are byte-identical
  for a fixture whose snapshot oid differs.
- A snapshot failure is **not** a capture failure in this phase. Record it, leave the columns null,
  and let capture succeed - no Persona reads it yet, and failing capture would break every existing
  run for a feature nobody enabled. Phase 3 is where a null snapshot becomes fatal, and only for a
  Persona that asked for access.

### 5. Store - `src/server/workflows/store.ts`

- `WorkflowSubmissionRowSchema` gains the two snapshot columns as `nullableText.optional()`, the
  porcelain as an optional nullable **`Uint8Array`** (it is a BLOB), and the truncation flag as an
  optional integer;
  `WorkflowSubmission` gains `reviewSnapshotOid?: string | null` and
  `reviewSnapshotRepoRoot?: string | null`, optional for the same reason `repositoryFingerprint`
  is - a row written before the column exists.
- The submission insert writes them.
- `insertRepositoryQueryAudit(...)` and `listRepositoryQueryAudit(attemptId)`.
- Retention deletes the snapshot ref wherever a submission's evidence is pruned, and the sweep is
  wired at daemon start beside the other reconciliations.

### 6. Read service - `src/server/workflows/repository-read.ts` (new)

**A reader is created per Persona attempt and carries that attempt's audit identity**, because
step 10 requires it to write one row per operation and `workflow_repository_queries` requires
`(node_attempt_id, round, ordinal)` to be unique. A reader built only from
`{ repoRoot, snapshotOid, headSha, budget }` could not satisfy either, and Phase 3 is forbidden
from writing audit rows itself - so the identity has to arrive here:

```ts
createRepositoryReader({
  repoRoot,
  snapshotOid,
  headSha,
  // The index tree, so read_file can serve stage: "index".
  indexTreeOid,
  // The persisted porcelain and its truncation flag. git_status answers from these once the
  // worktree is gone, so they have to arrive through the interface rather than being fetched
  // from persistence by the reader - which would make the reader depend on the store.
  statusPorcelain,        // Uint8Array | null
  statusTruncated,        // boolean
  // Identity for every row this reader writes. One reader, one attempt.
  audit: { runId, submissionId, nodeAttemptId },
  // Narrow writer, defaulted in production to the store's insertRepositoryQueryAudit.
  // A callback rather than the store itself so the reader's own tests need no database.
  recordQuery,
  budget,
})
// => { execute(query, { round }): Promise<RepositoryQueryResult>, close(): void }
```

Everything durable the reader needs arrives in that object. It reads no row itself: `git_status`
answers from `statusPorcelain`, and `read_file` with `stage: "index"` from `indexTreeOid`. An
earlier draft persisted both and then omitted them here, which left `git_status` with no contract
path to the data it was specified to answer from - it would have had to reach into persistence
outside its own interface, or silently fall back to tree-derived state and report it as complete.

`round` is the **only** positional value `execute` takes, because it is the only one Phase 3 knows
and the reader cannot: the loop owns rounds. **`ordinal` is the reader's own**, a monotonic counter
per round, so Phase 3 cannot mis-number a sequence into a unique-index collision and the constraint
holds by construction rather than by two subsystems agreeing to count the same way.

Two facts that keep that identity unique, worth stating because they are exactly what a unique
index punishes:

- A **retried** Persona attempt is a new row with a new `randomUUID()` id - the engine's retry path
  inserts `attempt + 1` under a fresh id - so a retry gets a fresh reader and cannot collide with
  the attempt it replaced.
- A **parse retry inside a round** re-calls the provider, not the reader, so it consumes no ordinal.

Order of checks per query, and the order is the contract:

1. **Argument validation** - schema-parse the query; refuse an out-of-range bound as
   `invalid_argument` rather than clamping silently, so a reviewer is told what it asked for was
   not honoured.
2. **Path validation** - reject empty, absolute, NUL-bearing, any `.` or `..` segment, a leading
   `.git` segment, and anything over a path-length bound. Match as **bytes**; never normalize,
   because git paths are bytes and normalizing would let two spellings resolve to one object.
3. **Denylist** - `REPOSITORY_DENY_GLOBS` against the path. Refuse as `sensitive_path`.
   **Steps 2 and 3 run for every op that was given a path or glob, with no exceptions and
   regardless of output class.** That is `read_file`, `git_blame`, `git_log`, `git_diff`'s `path`,
   and the globs on `search_text` and `list_paths`. Stating it as universal rather than per-class is
   the fix for a real hole: `git_log` was filed under an output class that post-filters results, its
   `path` argument was consequently never checked, and `git log --format=… -- .env` was permitted.
4. **Mode classification** - from the cached tree listing: `120000` is `symlink`, `160000` is
   `submodule`, a tree is `not_a_file`, absent is `not_found`.
5. **Size pre-flight** - `cat-file --batch-check` for the byte count; refuse `too_large` before
   reading.
6. **Execute** - the argv from the plan's table, through `run` with a per-operation timeout.
7. **Post-filter** - re-apply the path validator and the denylist to every path in the **result**
   of every op declaring `filter-emitted-paths`, and only those. This is what makes the denylist real for that class;
   `claude-grant.ts` already documents why a rule that guards only arguments protects nothing it
   names. It is sufficient for `path` and **only** `path`, because each of those ops emits a path
   beside its own content or no content at all, so dropping the line drops the content with it.
   A `content`-class op never comes through here - it goes through the allowlisted pipeline below.
   A `metadata`-class op never comes through here either, and it is not exempt: its safety is a
   fixed no-path no-content format plus the forbidden-flag list, described with the classes.
8. **Bound and mark** - clip to the per-query, per-round and per-attempt budgets, set
   `truncated` and `omittedBytes`. Never clip silently.
9. **Scrub** - `scrubSecrets` over the response text.
10. **Audit** - one row per operation, whatever the outcome, through `recordQuery` with this
    reader's `audit` identity, the `round` this `execute` was given, and the `ordinal` the reader
    assigned. The write happens on **every** exit path including a refusal at step 2 or 3, so a
    denial is as auditable as a success - which is what decision 11 asks for.

**The staged version is retrievable, because decision 7 names it.** `read_file` takes
`stage: "worktree" | "index"`, defaulting to `worktree`. `worktree` reads the snapshot tree;
`index` reads the index tree pinned at
`refs/mission-control/review-index/<submissionId>`. Both go through the identical validation,
denylist, mode classification and size pre-flight - the index tree is not a privileged view, it is a
second tree with the same rules.

An earlier draft persisted only the porcelain's index *oid* and said the staged content was out of
scope. That was wrong on the plain reading: decision 7 lists "committed, staged, unstaged, and
untracked content", and for a staged-then-modified path the staged and unstaged bytes are different
content, both named. Pinning the index tree makes the sentence literally true instead of nearly
true, and it costs one `write-tree` and one ref.

`git_status` remains the op that reports the *classification* (`MM`, `AM`) from the persisted
porcelain; `read_file` with `stage` is how the two versions' *bytes* are reached. Neither replaces
the other.

### `git_status` needs a persisted status; the tree cannot reconstruct one

A snapshot commit records **one blob per path** - the final state. It therefore cannot express the
staged-versus-worktree distinction at all. Verified: stage a file and then modify it again, and

```
git status --porcelain=v1   ->  AM s.txt
git status --porcelain=v2   ->  1 AM N... 100644 100644 <indexOid> ... s.txt
the snapshot tree           ->  the worktree version only
```

The `AM` classification and the index blob oid exist nowhere in the tree. So specifying `git_status`
as "the tree diff plus the captured porcelain status" was wrong twice over: the existing capture is
bounded at `MAX_STATUS = 500` lines and `MAX_STATUS_BYTES = 80_000`
(`src/server/workflows/context.ts`), so a large submission's status is **incomplete**; and nothing
durable holds the classification at all once the worktree is released, so it is also
**unreconstructable**. An op that answers "what is the state of this change" would have quietly
returned a wrong answer for any mixed staged/unstaged submission.

**Capture therefore persists a complete machine-readable status beside the snapshot.**

- At capture, inside the same bounded window, run `git status --porcelain=v2 -z --untracked-files=all`
  and store it on `workflow_submissions` as `review_status_porcelain` (**BLOB**, nullable - see
  *Paths are bytes end to end*), with
  `review_status_truncated` (INTEGER, default 0).
- **v2 rather than v1**, because v1 gives two status letters while v2 additionally carries the index
  and worktree modes and the index blob oid - which is the only durable record of the staged
  version's identity. `-z` because paths are bytes and may contain newlines - and because without it git C-quotes an
  odd path into a third encoding. See *Paths are bytes end to end* below for why the column that
  receives this is a BLOB.
- Bounded by `REPOSITORY_QUERY_LIMITS.statusPorcelainBytes` (2,000,000 - one line per changed path,
  so this is roughly 20,000 paths and well past any real submission). On overflow, store the prefix
  and set `review_status_truncated`; **`git_status` then reports `truncated: true` with the omitted
  count**, which is the contract intentionally permitting truncation rather than hiding it.
- This is separate from the existing 500-line `workingTreeStatus` in the context snapshot, which
  stays exactly as it is - that field feeds the prompt and its bound is part of an existing
  fingerprint. Do not widen it; do not make `git_status` read it.

`git_status` therefore answers from two exact sources: the tree-level change set
(`git diff --name-status <headSha> <snapshotOid>`, complete by construction) and the persisted
porcelain (complete unless flagged). Both are post-filtered through the denylist as a `path`-class
result.

**Both versions are durable.** The persisted porcelain carries the classification and the index
oid; the index tree pinned beside the snapshot carries the staged **bytes**, so neither depends on
the worktree surviving and `git gc` cannot prune either. This paragraph previously said the staged
content was out of scope; that was a misreading of decision 7, corrected in round 13.

### Capture neutralises content filters, or the snapshot is not the submitted bytes

`git add -A` runs a configured `filter.<name>.clean` for paths a `.gitattributes` in the change
under review selects. This is the round-12 driver problem on the **capture** side, and it is worse
there, because a clean filter does not merely execute - it **rewrites the content that gets
stored**. Measured, with a filter mapping `SECRET` to `REDACTED`:

| | filter invocations | bytes in the snapshot |
|---|---|---|
| `git add -A` as originally specified | **2** | `value=REDACTED-original` |
| with every clean filter overridden to `cat` | **0** | `value=SECRET-original` |

The second row is the submitted content; the first is not. So the original specification broke
decision 7 outright, not only decision 5.

**The fix keeps the fast path.** Clean filters are *enumerable*, so they can be neutralised by
configuration rather than by abandoning `add -A` for plumbing:

```
git config --get-regexp '^filter\.'      # discover every configured driver
# then, for the capture invocations only:
git -c filter.<name>.clean=cat -c filter.<name>.process= ... read-tree / add -A
```

Verified this preserves everything that matters: the original bytes, and the file modes -
`100644`, `100755` for an executable, `120000` for a symlink - which a hand-rolled
`hash-object`/`update-index` path would have had to reconstruct itself.

**`filter.<name>.process` must be neutralised too, and it is the dangerous one.** git-lfs uses
`process`, not `clean`. Enumerating only `.clean` would have missed it entirely - and a `process`
driver speaks a long-running protocol, so a mismatched one does not fail, it **hangs**: the
verification fixture for this had to be killed after two minutes with `git add` still waiting on a
handshake. Capture therefore neutralises `clean` and `process`, and the capture invocations carry
`run`'s timeout so a hang is reported as a capture failure rather than stalling the daemon.
`smudge` is checkout-side and unreachable here - nothing ever checks a tree out - and is overridden
anyway so the question does not have to be re-asked.

**What "exact submitted state" does and does not mean, said precisely.** With filters neutralised
the snapshot holds the worktree's bytes. It does **not** override the `text`/`eol` attributes, so a
repository with `* text=auto` records the line endings git itself would commit rather than the
worktree's CRLF. That is deliberate: those bytes are what the change contains in git's own model,
`git diff` reports no difference for them, and a reviewer reading the tree sees what a commit would.
The claim is "the bytes git would record for this change", not "a byte-for-byte image of the
directory" - and the difference is worth stating because I had been writing the latter.
### Paths are bytes end to end, and the durable columns are BLOBs

Step 2 already says "match as **bytes**; never normalize, because git paths are bytes and
normalizing would let two spellings resolve to one object". Several parts of this phase then
specified decoding those bytes into JavaScript strings - a `TEXT` column for the porcelain, a
`TEXT` column for the audit path - which is exactly the normalization that rule forbids. Measured,
the decode is both lossy and collapsing:

```
raw bytes        6261642d fffe 2e656e7600      (bad-<ff><fe>.env)
utf8 round trip  6261642d efbfbd efbfbd 2e...  11 bytes become 15, not recoverable

a<ff>b and a<fe>b   distinct paths
  both decode to    "a\uFFFDb"                 two paths collapse to one
```

The collapse is the security-relevant half: a denylist decision taken on a decoded string is a
decision about a different value than the one in the tree, and two distinct paths comparing equal
is precisely what step 2 exists to prevent.

There are also **three** representations of a path in git's output, not two. Verified on a tree
holding `q<ff>.txt`:

| Invocation | Emits |
|---|---|
| `ls-tree --name-only` | `"q\377.txt"` - C-quoted, with escapes |
| `ls-tree --name-only -z` | `71 ff 2e 74 78 74 00` - raw bytes |
| a UTF-8 decode of either | a lossy string |

So the rules, and they are not per-op:

- **`-c core.quotePath=false` on every invocation**, as a required option checked in the argv
  builder beside the driver flags. This is the general lever and it is not per-op: it stops git
  C-quoting a path in *any* output, including the `diff --git` headers of a patch, where `-z` does
  not apply. Verified - `ls-tree --name-only` emits `"q\377.txt"` by default and the raw bytes
  `71 ff ...` with the option set.
- **`-z` additionally wherever the output form supports it**, so records are NUL-delimited rather
  than newline-delimited and a path containing a newline cannot split a record. Verified available
  on `ls-tree -z`, `git grep -z` (which NUL-separates the path from the match), `diff -z
  --name-status`, and `status --porcelain=v2 -z`. It does **not** apply to patch output, which is
  why the quotePath option above is the load-bearing one for `git_diff` and `git_show`, and why the
  step-5 header verifier compares header paths as **bytes**.
- **Validation, the denylist and the glob matcher take bytes** (`Uint8Array`/`Buffer`), not strings,
  and compare bytes. `matchesRepositoryGlob` and `REPOSITORY_DENY_GLOBS` operate on byte sequences;
  the glob syntax stays ASCII, so the matcher is unchanged in behaviour for every path that is valid
  UTF-8 and correct for the ones that are not.
- **Durable columns hold bytes.** `review_status_porcelain` is a **BLOB**, and
  `workflow_repository_queries.path` is a **BLOB**. A `TEXT` column cannot round-trip what `-z` was
  chosen to preserve, so storing it as text would have made `-z` pointless.
- **The browser renders a lossy display form and says so.** The audit surface shows the path
  UTF-8-decoded, with a marker when the bytes are not valid UTF-8, so an operator sees that the
  display is not the value. The durable record stays exact.

**And the limit this leaves, stated plainly.** A model reads text, so a path that is not valid
UTF-8 cannot be handed to the reviewer faithfully. Such an entry is reported by `list_paths` and
`search_text` with an explicit marker and is **unaddressable**: `read_file` on the mangled spelling
returns `not_found`, because the argument bytes will not equal any tree entry's bytes. That fails
closed - the reviewer is told the file exists and cannot be opened, rather than being served a
different file whose name happened to decode the same way.
### One list of flags the argv builder refuses

Three separate rules about flags accumulated across review - the metadata class's, the driver
flags, and rename detection - and scattered rules are what this review kept punishing. They are one
named list, `REFUSED_GIT_FLAGS`, checked in the argv builder for every op:

| Refused | Why |
|---|---|
| `-p`, `--patch` | emits file content from an op whose class promises none (verified on `git log`) |
| `--name-only`, `--name-status`, `--stat` | emits paths from a `metadata` op, bypassing the class contract |
| `--textconv`, `--ext-diff` | re-enables the conversion drivers the next section disables |
| `-c`, `--cc` | combined-diff headers the step-5 verifier cannot parse into two paths |
| `--no-index` | reads paths outside the object database entirely |

And these are **required**, checked in the same place: `-c core.quotePath=false` on **every**
invocation; `--no-ext-diff --no-textconv` on every content-producing one; `--no-renames` on
`git_diff` and `git_show`; and `-z` wherever the output form supports it. Required rather than merely present in a specimen argv, because
omitting any of them yields a well-formed answer - see the next two sections for what each one
prevents.

### Every git invocation disables configured conversion drivers

`git` will **execute a program from the repository's configuration** while producing a diff, and it
does so by default. `.gitattributes` - a file in the change under review - selects a driver by name,
and `diff.<name>.textconv` or `diff.<name>.command` maps that name to a command. The command comes
from config rather than from the reviewed content, so this is not a self-contained repository
exploit; but an operator legitimately has such drivers configured (`*.pdf diff=pdf` with
`textconv = pdftotext` is the textbook case), and the reviewed change chooses which paths route
through one. Decision 5 says no arbitrary shell execution, and an argv array at the outer call does
not deliver that if git forks a configured program underneath it.

Measured with a driver configured and `.gitattributes` selecting it - invocations of the driver per
command:

| Command | default | with the flags |
|---|---|---|
| `git diff --no-renames <a> <b>` | **3** | 0 |
| `git show --no-renames --format= <rev>` | **2** | 0 |
| `git blame --porcelain <rev> -- <path>` | **3** | 0 |
| `git grep -I -n <rev>` | 0 | 0 |

So **every content-producing invocation passes `--no-ext-diff --no-textconv`**: `git_diff`,
`git_show` and `git_blame`. `git blame` is on that list although the review finding named only diff
and show - it executes the driver by default too, verified above, and `--no-ext-diff` is accepted
there as well. `git grep` does not (textconv is opt-in for it) and `--textconv` is added to the
forbidden-flag list so it stays that way.

These flags are **required**, not merely present in the specimen argv, and the revision-pin test
below is extended to assert them, for the same reason it asserts the revision: their absence
produces a well-formed answer, so nothing about the output reveals that a program ran.

### Every git invocation names an explicit snapshot-derived revision

This is an invariant of the reader, not a property of individual ops, and it is stated separately
because the per-op version of it has now failed four times - `git_diff`'s default base, the cold
index seed, and `git_log`, all defaulting to live state, plus the `git_show` case where a revision
was checked but the wrong thing was concluded from it.

The reason it has to be an invariant is that **omitting a revision does not fail; it silently reads
live state**, and it does so differently per command. Measured:

| Command with no revision | What it actually reads |
|---|---|
| `git log` | live `HEAD` - commits made after capture, including another task's work |
| `git grep` | the live **working tree**, not any commit - the worst case, since that directory may have been reset and handed to a different task |
| `git blame` | the live worktree file |
| `git cat-file --batch-check` | treats the input as an object name and answers `missing`. Fails closed. |
| `git ls-tree` | usage error, refuses to run. Fails closed. |

So three of the five silently substitute live state and two refuse. A reviewer cannot tell the
difference from the response, and neither could I from my own specification - which is why the
argv for **every** op now spells its revision, and why a test asserts it rather than a reader
trusting the prose:

| Op | Revision in its argv |
|---|---|
| `read_file` | `<snapshotOid>:<path>` |
| `search_text` | `<snapshotOid>` |
| `list_paths` | `<snapshotOid>` |
| `git_status` | `<headSha> <snapshotOid>` |
| `git_diff` | `<base or headSha> <snapshotOid>` |
| `git_show` | `<rev>`, proven an ancestor of `<snapshotOid>` |
| `git_log` | `<snapshotOid>` |
| `git_blame` | `<snapshotOid>` |

**Every caller-supplied revision is constrained to the snapshot's ancestry.** `git_show`'s `rev`
and `git_diff`'s `base` each pass only when `merge-base --is-ancestor <rev> <snapshotOid>` succeeds,
and are otherwise refused as `unsupported_rev`. Without that check a revision is an arbitrary
reference into the whole object database - another branch, another task's work, any object the
repository happens to hold - and a diff taken against one returns files that were never in the
submitted state, which defeats the exact-submitted-state boundary this phase exists to draw.

### Two axes: what an op is *given*, and what its output *is*

The first version of this section had one axis and got an op wrong because of it. It listed a
`single-path` class - meaning "the path is an argument, so it is validated up front" - beside output
classes, which quietly implied that an op was either argument-validated *or* output-filtered.
`git_log` then landed in the `path` class, whose safety comes from filtering paths out of the
result, while its prose justified it as metadata; and because it was not in `single-path`, nothing
validated the `path` argument it accepts. `git log --format=… -- .env` was therefore permitted.

The two properties are **orthogonal** and are now stated separately.

**Input axis - universal.** Every op that accepts a `path` or `pathGlob` has it validated and
denied at steps 2 and 3, before anything runs, whatever its output class. That is `read_file`,
`git_blame`, `git_log`, `git_diff`'s `path`, and the globs on `search_text` and `list_paths`. There
is no op for which a supplied path is exempt, and no output class that excuses one.

**Output axis - `REPOSITORY_OP_SAFETY`, and it is a SET, not a single class.** Two rounds of review
found ops that a single-valued class could not describe, and the second time it was because the
question "which one class is this?" has no answer for an op whose output carries more than one kind
of thing. So each op declares **which handlings it requires**, and an op needing two gets two:

```ts
REPOSITORY_OP_SAFETY: Record<RepositoryQueryOp, ReadonlySet<RepositorySafetyStep>>
// RepositorySafetyStep = "allowlist-before-generate" | "filter-emitted-paths" | "fixed-metadata-format"
```

| Op | Required handlings | Why exactly those |
|---|---|---|
| `read_file` | *(none beyond the universal input check)* | One validated path in, that file's bytes out. No other path can enter the response. |
| `search_text` | `filter-emitted-paths` | Line-per-match: every path appears beside its own content, so dropping the line drops the content. |
| `list_paths` | `filter-emitted-paths` | Paths only, no content. |
| `git_status` | `filter-emitted-paths` | Name-status and porcelain: paths only. |
| `git_log` | `fixed-metadata-format` | No path field and no diff line by construction; see the metadata policy below. |
| `git_diff` | `allowlist-before-generate` | A patch is one blob of content with no path line to drop. |
| `git_show` | `allowlist-before-generate` | Same. |
| `git_blame` | `filter-emitted-paths` | **Both** kinds: the line text is the requested file's, but the porcelain headers name *other* paths. See below. |

An empty set is a real answer and `read_file` is the only op that has one - stated explicitly so
"no handling declared" cannot be confused with "not yet classified", which is exactly the gap that
left `read_file` and `git_blame` unclassified when this was a single-valued class.

A total `Record` over the op list still forces every op to declare, and that enforcement is why
this is a class rule rather than a per-op one: the per-op version failed in review for `git_diff`,
then `git_show` with the identical content hole, then `git_log` misfiled, then `read_file` and
`git_blame` with no class at all.

**`git_blame` emits paths, so it is not a "one path in, one file's bytes out" op.** Verified -
`git blame --porcelain` writes `filename` and `previous` headers, and after a rename they name the
*earlier* path, with `--no-renames` making no difference:

```
$ git blame --no-renames --porcelain HEAD -- renamed.txt | grep -E '^(filename|previous)'
filename f.txt
previous c73d2119... f.txt
```

So a blame on an allowed path can name a denied one in a header. It therefore takes
`filter-emitted-paths` like any other path-emitting op: every path in a `filename` or `previous`
header is re-validated and re-denied, and a header naming a denied path is dropped rather than the
whole op refused, since the line attribution itself is legitimate. This was not in the review
finding - it turned up while checking what class `git_blame` actually belongs in, which is the
argument for making the declaration a set rather than guessing a single label.

**The `metadata` policy, since "post-filter handles it" was never true for it.** `git_log` emits
`%H`, author, commit time and subject, NUL-separated - verified to contain no path field and no diff
lines. The flags that would change that are **forbidden explicitly rather than merely omitted**,
for the same reason `--no-renames` is explicit: verified, `-p` emits file content and `--name-only`
emits paths, so `-p`, `--patch`, `--name-only`, `--name-status` and `--stat` are refused if they
ever reach the argv builder. Scrubbing applies to the subject like every other response.

**One exposure a path rule cannot close, stated rather than implied away.** A commit *subject* is
prose the author wrote, and it can name a denied path - the fixture's real subject is
`add .env with the prod credentials`. No path-shaped denylist can filter an author's sentence, and
this is the same documented boundary as the rename case below. What the fix does close is the sharp
part: a log **scoped to** a denied path, which confirmed that path's existence, its change times and
its commit subjects, and which is now refused at step 3 like any other denied path argument.

A unified diff is **one blob that carries file content**, not a list of paths beside content, so
filtering paths out of a finished patch is not the same operation as filtering a path list. Measured
against a fixture snapshot containing an untracked, non-ignored `.env` and a `k/id_rsa`, both
unrestricted forms leak:

```
$ git diff <headSha> <snapshot> | grep -n 'hunter2\|BEGIN PRIVATE KEY'
7:+SECRET=hunter2-should-never-be-seen
21:+-----BEGIN PRIVATE KEY-----

$ git show <ancestorRev> | grep -n 'hunter2\|BEGIN PRIVATE KEY'
13:+SECRET=hunter2-via-git-show
27:+-----BEGIN PRIVATE KEY-----
```

The `git_show` case is worth dwelling on, because it shows two checks being mistaken for one: that
`rev` **passed** the ancestry check - it is a genuine ancestor of the snapshot, so it is squarely
inside the submitted history. Ancestry answers "is this revision part of what was submitted"; the
denylist answers "may this path be read". Neither substitutes for the other, and conflating them is
what left the hole.

**The pipeline, one implementation both `content` ops call.** `generateAllowlistedPatch` takes the
op's name-only form and its content form, and never lets content exist for a denied path:

1. **Paths first, no content.** `git diff --no-renames -z --name-only <base> <snapshot>`, or
   `git show --no-renames -z --name-only --format= <rev>`. Path sets, nothing else.
2. **Validate and deny** that set through steps 2 and 3 above. Record how many were dropped.
3. **Nothing surviving** returns an ok, empty patch with `filtered: true` and the dropped count -
   not an error, because "every changed file is denied" is an answer.
4. **Content second, allowlisted.** The same command with `-- ':(literal)<path>'…` over the
   survivors only, batched so argv stays bounded, concatenated in path order. Verified: both fixture
   cases yield zero occurrences of either secret.
5. **Verify before returning.** Re-extract the paths from every `diff --git a/<x> b/<y>` header,
   anchored at line start, and re-check **both** sides. A header that fails, or that cannot be
   parsed into two paths, refuses the whole operation as `sensitive_path` rather than returning a
   partially filtered patch. Generating nothing denied is the guarantee; this is the assertion that
   it held.

**`git_show` fetches its metadata separately, and its patch with `--format=`.** Not cosmetic: a
commit message is attacker-controlled text in a review, and `git show`'s default format prints it
inside the same stream the step-5 verifier parses. Verified - a commit whose message contains
`diff --git a/.env b/.env` puts that line into `git show` output (indented four spaces, which is why
step 5 anchors at line start). Splitting metadata into `git show -s --format=<NUL-separated>` and
the patch into `--format=` means the verifier only ever parses git's own diff output, with no
attacker-controlled prose in it at all.

`--no-renames` is **explicit, not inherited**. With the operator's `diff.renames=true` the fixture
emits `diff --git a/.env b/notsecret.txt` - a header naming a denied path, whose shape depends on the
reviewing machine's git config. Passing `--no-renames` makes every path its own section and the
response shape independent of configuration. The broker also never passes `-c` or `--cc`, so
combined-diff headers cannot arise; step 5 refuses any header form it cannot parse, so they could not
slip through unnoticed if they did.

**The honest limit, stated because overclaiming here would be worse than the gap.** This guarantees
that a *denied path* contributes no section. It does not stop content the submitted work itself
moved to an *allowed* path: rename `.env` to `notsecret.txt` in the change under review and its
bytes are reachable - but reachable exactly as `read_file("notsecret.txt")` already makes them,
because the denylist is path-shaped by construction. That is the documented boundary of a
path-shaped rule, with `scrubSecrets` as the imperfect content-shaped layer behind it, and it is not
made better or worse by either `content` op. Do not describe the allowlist as preventing it.

**`git_diff`'s default base is the captured `headSha` - the snapshot commit's own parent - and
never live `HEAD`.** This is the same hazard the whole phase exists to answer, so it must not be
reintroduced by an omitted argument: the worktree's `HEAD` is mutable and may have moved, been
reset, or been handed to another task by the time a review runs, so a diff against it can return
state that was never submitted. The reader already holds `headSha`; it resolves the default itself
and never asks git for `HEAD`. An explicitly requested `base` goes through the ancestry check
above; an omitted one is not a request and is not resolved through anything.

The rule is written once and applied to both ops rather than per-op, because the two were specified
separately at first and only `git_show` got the check; a shared `resolveSnapshotAncestor(rev)` that
every rev-taking op must call is what stops the next op added to this list from repeating that.
`git_status`, `git_log` and `git_blame` take no caller revision - they walk from the snapshot - and a
future op that does must go through the same helper.

`list_paths` lists the tree once (`ls-tree -r -z`), caches it for the reader's lifetime - the tree
is immutable, so a per-reader cache is correct by construction - and filters in Node.
`search_text` may pass `:(glob)` to `git grep` as an optimisation, but the Node matcher and the
denylist are the **authority** and only ever narrow.

Any git failure, a missing snapshot oid, a repository root that no longer exists, or a timeout is
`unavailable` - the one code that means infrastructure rather than policy.

### 7. Documentation

`docs/security.md` gains the trust boundary: what the snapshot is, why the filesystem is not in
it, the eight operations, the denial list, the layered defences and the audit record.
`docs/database-and-migrations.md` gains the columns, the table and the ref namespace.
`docs/worktrees-and-checks.md` gains a note that a review's repository view is a snapshot commit
and therefore unaffected by worktree reclamation - the fact whose absence made the live-read design
look viable.

## Tests

- `test/repository-query-contract.test.ts` (new): the op and denial lists are append-only; the
  glob matcher's full truth table including `**` across separators; the denylist covers the
  Inspector's repository-relative entries and adds `.git/**`; every limit is finite and the
  hierarchy is consistent (per-query <= per-round <= per-attempt).
- `test/review-snapshot.test.ts` (new), on a fixture repository built in a temp dir with all four
  content classes plus a gitignored directory, a non-ignored `.env`, a symlink and a binary file:
  - the snapshot tree contains committed, staged, unstaged and untracked content and excludes the
    gitignored directory;
  - the live worktree and live index are byte-identical afterwards;
  - the commit's parent is the captured `headSha`;
  - the ref resolves under the common git dir;
  - the snapshot still reads after the worktree directory is deleted;
  - the snapshot still reads after `git gc --prune=now`;
  - the cold-index fallback produces the same tree as the seeded path;
  - **a path tracked at the captured commit but matching a `.gitignore` pattern survives into the
    snapshot even after the checkout advances past it.** Force-add `build/config.json` under a
    `build/` ignore rule, capture that commit as `headSha`, then `git rm --cached` it in a later
    commit while leaving the file on disk. The snapshot must still contain it. This is the
    regression for seeding from live `HEAD`, and it fails loudly against the original wording;
  - the same fixture exercises the **step-4 tree verification** directly: seed a temp index from the
    advanced commit on purpose, and assert the verification rejects the resulting tree rather than
    committing it, since the parent assertion would have passed;
  - **snapshot creation succeeds in a repository with no `user.name` or `user.email`** - build the
    fixture with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` so the ambient
    operator config cannot mask the failure, and assert the commit's recorded author and committer
    are the daemon identity rather than anyone else's;
  - `deleteReviewSnapshot` is idempotent and the sweep removes an orphan and spares a live one.
- `test/repository-read.test.ts` (new): every op returns its shape against the fixture; a dirty
  file reads with its dirty content; `read_file` paging by `startLine`/`lineCount`; truncation sets
  `truncated` and `omittedBytes`; `list_paths` and `search_text` agree on which paths exist.
- **`git_diff` with no `base` does not follow live `HEAD`.** The regression test for the hazard the
  whole phase exists to answer: take a snapshot, then move the worktree's `HEAD` (commit again, or
  reset it) and assert the default-base diff is unchanged and still describes the submitted state.
  A test that only checked the happy path would pass against an implementation that asked git for
  `HEAD`, because at capture time the two agree - the bug only appears once the checkout moves,
  which is exactly when it matters.
- `test/workflow-security.test.ts`: the adversarial half, and the tests that justify this phase's
  boundary - absolute path, `..` in every position, NUL, a leading `.git`, an over-long path, a
  denied path as an argument, a denied path appearing **only** in a `search_text` result, a denied
  path appearing only in a `list_paths` result, a symlink pointing outside the repository, a
  submodule, a binary, an oversize blob, and - for **both** rev-taking ops - a `git_show` `rev` and
  a `git_diff` `base` naming a commit that is not an ancestor of the snapshot. Each asserts the
  denial code and that no content crosses the boundary.
- The ancestry case is worth building deliberately rather than with a random sha: create a second
  branch in the fixture with a file the snapshot never contained, then assert that naming its tip as
  `git_diff`'s `base` is refused as `unsupported_rev` **and** that the refusal body contains none of
  that file's content or path. A test that only checks the code would still pass if the
  implementation refused after running the diff.
- **The conversion-driver test.** Configure `diff.mydriver.textconv` in the fixture repository and
  add `.gitattributes` selecting it, then assert the driver **never executes** for `git_diff`,
  `git_show` or `git_blame` - have the driver append to a file and assert that file is never
  created. Verified that without the flags those three invoke it 3, 2 and 3 times respectively, so
  this fails loudly against the original argv. Assert `--textconv` is refused if it reaches the
  argv builder.
- **The staged-version tests.** A staged-then-modified file: `read_file` with
  `stage: "index"` returns the staged bytes and with `stage: "worktree"` returns the worktree bytes,
  both **after the worktree directory is deleted** and after `git gc --prune=now`, which is the whole
  point of pinning the index tree. The denylist applies identically to both stages - a denied path is
  refused with `stage: "index"` too, since a second tree must not become a second way in. A
  submission with a clean index returns identical bytes for both stages rather than erroring.
- **The blame header test.** After a rename, `git_blame` on the new path must not emit a
  `filename` or `previous` header naming a **denied** old path; the header is dropped while the
  line attribution survives. Verified that `--no-renames` does not suppress those headers, so this
  cannot be delegated to a flag.
- **The clean-filter fixture.** Configure `filter.myfilter.clean` mapping a marker to a
  replacement, select it from `.gitattributes`, and assert the snapshot contains the **original**
  bytes and the filter binary never ran. Then the same with `filter.myfilter.process` configured, to
  pin that `process` is neutralised as well - the case git-lfs uses, and the one that hangs rather
  than failing if it is missed. Assert file modes survive: `100644`, `100755`, `120000`.
- **The non-UTF-8 path tests**, which are cheap to build and were the gap this class hid in. Use
  `git mktree` to put a path with bytes `ff fe` into the tree, so the fixture needs no filesystem
  support for it. Then: the persisted porcelain round-trips byte-for-byte out of the BLOB column; the
  audit row's `path` round-trips byte-for-byte; the denylist refuses `bad-<ff><fe>.env` on its
  **bytes**; two paths differing only in an invalid byte (`a<ff>b` versus `a<fe>b`) are treated as
  distinct rather than collapsing; and `read_file` on the U+FFFD-mangled spelling returns
  `not_found` rather than resolving to either.
- **The status tests.** A submission with a staged-then-modified file records `AM` and the index oid
  in `review_status_porcelain`, and `git_status` reports that classification **after the worktree
  is deleted** - the case the tree alone cannot answer. A status over `statusPorcelainBytes` sets
  `review_status_truncated` and `git_status` reports `truncated: true` with an omitted count
  rather than a short complete-looking list. A denied path present in the porcelain is filtered out
  like any other `path`-class result.
- **The revision-pin test, table-driven over every op.** Build each op's argv and assert it contains
  a snapshot-derived revision, that **every** op carries `-c core.quotePath=false`, and that every
  content-producing op carries `--no-ext-diff` and `--no-textconv`. This is a mechanical check on the argv rather than a behavioural one,
  deliberately: it is what would have caught `git_log` shipping with no revision at all, which no
  amount of output assertion does, because an unpinned log returns a perfectly well-formed answer
  about the wrong commits.
- **The live-state regression, per op that can silently fall back.** After capture, advance the
  checkout - commit twice more and edit the worktree - then assert `git_log`, `search_text` and
  `git_blame` still answer about the snapshot: the log does not list the post-capture commits, the
  search does not match the uncommitted worktree edit, and blame does not attribute it. Each of the
  three defaults to a different flavour of live state, so all three need the assertion rather than
  one standing in for the others.
- **The universal input-validation test, table-driven over every op that accepts a path or glob.**
  Feed each one a denied path (`.env`, `k/id_rsa`, `.git/config`) and assert `sensitive_path`, and
  feed each one a traversal (`../etc/passwd`) and assert `path_invalid`. Driven off the op list
  rather than written per op, so an op added without argument validation fails here. This is the
  regression for `git_log --  .env`, which the per-class version of the rule permitted.
- **The `metadata` class tests.** `git_log`'s output carries no path field and no diff line, on a
  fixture whose history includes a commit touching a denied path; and `-p`, `--patch`,
  `--name-only`, `--name-status` and `--stat` are refused if they reach the argv builder - verified
  that the first emits file content and the third emits paths, so omitting them is not the same as
  forbidding them.
- **The adversarial content-class tests, which are their own group because path-shaped assertions do
  not cover a content-bearing response.** Run **the whole group against every `content` op** -
  table-driven over `REPOSITORY_OP_SAFETY`, so an op declaring `allowlist-before-generate` inherits
  the suite instead
  of needing someone to remember it. That table-driven shape is the test-side half of the same
  lesson: `git_show` had this hole because `git_diff`'s fix was written as a one-op fix.
  Against a snapshot holding an untracked non-ignored `.env`, a `k/id_rsa`, a binary file and an
  ordinary changed source file, plus an ancestor commit that touches both a denied and an allowed
  path:
  - each `content` op returns the source file's hunks and **zero bytes** of the `.env`
    or `id_rsa` content - assert on the secret *values*, not on the paths, since a path-only
    assertion passes against an implementation that filtered headers and kept hunks;
  - `git_show` on an ancestor `rev` **that passes the ancestry check** and carries a denied path
    returns no content for it - the regression for conflating ancestry with the denylist;
  - a commit whose **message** contains a forged `diff --git a/.env b/.env` line does not corrupt
    the verifier or appear in the patch stream, because metadata and patch are fetched separately;
  - no `diff --git` header in the response names a denied path on **either** side;
  - `filtered` is set and the dropped count matches the number of denied changed paths;
  - a diff in which *every* changed path is denied returns ok-and-empty with `filtered: true`,
    not an error;
  - the same assertions hold with `diff.renames=true` set on the fixture repository, pinning that
    the response does not depend on the operator's git config;
  - a fabricated patch containing a denied header, fed through the step-5 verifier directly, is
    refused as `sensitive_path` - the guarantee is "never generated", and this is the test that the
    assertion behind it actually fires rather than being dead code.
- Also assert the positive half, so the check is not simply "refuse everything": a `base` that *is*
  an ancestor - the snapshot's parent, and the merge base against the default branch - succeeds and
  returns the expected paths.
- `test/workflow-context.test.ts`: capture persists the oid and root; **both fingerprints are
  byte-identical** to a run whose snapshot oid differs; a snapshot failure leaves the columns null
  and capture still succeeds.
- `test/workflow-db.test.ts`: the new columns and table exist with their indexes; the audit table
  has a validating typed row parser like every other workflow table; the unique index refuses a
  duplicate `(attempt, round, ordinal)`.
- **The audit-identity tests**, which are what make the row writable at all: a reader built with
  fixture `{ runId, submissionId, nodeAttemptId }` and driven across rounds 1, 2 and 3 writes rows
  carrying that identity, with `ordinal` restarting at the first value in each round and increasing
  monotonically within it; a **denied** query at step 2 or 3 writes a row too, with its
  `denial_code` and zero `bytes`, so a refusal is as auditable as a success; two readers built for
  two different attempt ids write rows that do not collide; and every row inserts through the unique
  index without a conflict across the whole sequence.
- A migration test: a hand-written pre-feature `workflow_submissions` opens, migrates, and reads
  with null snapshot **and status** columns and every other field unchanged; two opens are idempotent.
- **The boot-block/migration pair check**, following `test/persona-migration.test.ts:153` and its
  reasoning verbatim - the omission is invisible at runtime on a fresh database, because
  `CREATE TABLE` supplies the column, so the only place it shows is the source. For each of the four
  columns, assert it appears in the `workflow_submissions` `CREATE TABLE` block **and** in a
  matching `addColumn` call.
- **And the general guard, which is what actually closes this class.** Open a hand-seeded pre-feature
  database, run `migrate()`, and assert its `PRAGMA table_info` column set for
  `workflow_submissions` is **equal** to a fresh database's - failing with the difference. Same for
  `workflow_repository_queries`. This names no column, so it keeps working for every column added
  later without anyone maintaining a list, and it is the assertion that would have caught this
  finding. The named pair check above stays as well: it localises the failure to the missing
  `addColumn` line, where the set-equality test only says the sets differ.
- Retention: pruning a submission's evidence deletes its ref.

Verification: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`.
No UI surface changes in this phase, so `npm run test:e2e` is a regression check rather than a new
spec. Focused runs use the loader preamble `--import ./test/setup-state.mjs --import tsx`.

On macOS under `CODEX_SANDBOX=seatbelt`, `npm test` includes real Electron geometry tests: use the
repository-prescribed scoped outside-sandbox approval rather than bypassing the preflight or adding
Chromium flags.

One extra note for this phase specifically: its tests build real git repositories in a temp
directory and shell out to `git`. Under a sandbox that restricts writes, those fixtures need a
writable temp root, and the suite's own `MISSION_TEST_STATE` temp home is the model to follow.
Never point a fixture at the operator's own checkout.

## Merge and exit criteria

- A submission captured after this merge carries a snapshot oid and root, and the snapshot
  reproduces the exact submitted state.
- The snapshot is readable after the session's worktree is released, reset or deleted, and after
  garbage collection.
- Every one of the eight operations answers correctly against the snapshot, and every adversarial
  case above is denied with the right code and no content leak.
- Every operation, denial and truncation writes exactly one audit row.
- `evidenceFingerprint` and `repositoryFingerprint` are unchanged, proven by test.
- A pre-existing database opens and every existing submission reads with null snapshot columns.
- Capture latency for this repository is within a few tens of milliseconds of its previous value.
- All verification commands green.

## Downstream handoff

Phase 3 may rely on, and must not change:

- `RepositoryQuery`, `RepositoryQueryResult`, `REPOSITORY_DENIAL_CODES` and
  `REPOSITORY_QUERY_LIMITS` as the provider-neutral vocabulary. Phase 3 adds the **envelope**
  around them, not the operations.
- `createRepositoryReader({ ..., indexTreeOid, statusPorcelain, statusTruncated, audit, recordQuery, ... }).execute(query, { round })`
  as the only way to reach the repository. Everything durable it needs arrives in that object; it
  reads no row itself, so Phase 3 supplies the submission's persisted values rather than the reader
  reaching into the store, and `unavailable` as the only code meaning infrastructure. Phase 3
  builds **one reader per Persona attempt**, supplying that attempt's
  `{ runId, submissionId, nodeAttemptId }`, and passes only the `round` per call.
- The reader owning validation, denial, bounds, scrubbing and audit, so Phase 3 never re-implements
  a check and never writes an audit row itself. It also owns `ordinal`, so Phase 3 never numbers
  one - the unique `(node_attempt_id, round, ordinal)` identity is the reader's to keep, not a
  convention two subsystems have to share.
- `WorkflowSubmission.reviewSnapshotOid` being nullable, with null meaning "no exact state" -
  which is what Phase 3 turns into a blocking failure for an access-enabled Persona.
- The ref namespace and its retention owner.

## Cross-phase compatibility audit

- **Against Phase 1**: disjoint tables and disjoint store methods; both append to `db.ts`'s boot
  block and `migrate()`. `addColumn` and `CREATE TABLE IF NOT EXISTS` are idempotent and
  order-independent, so either merge order produces the same schema and the only expected conflict
  is textual adjacency, resolved by keeping both. This phase reads nothing Phase 1 writes: the
  reader takes a snapshot oid, never a Persona.
- **Against Phase 3**: `REPOSITORY_QUERY_LIMITS` carries `maxRounds`/`maxQueriesPerRound` even
  though only Phase 3 consumes them, deliberately - one budget in one file. Phase 3 adds
  `workflow_llm_calls.round`, which this phase does not touch. The audit table's `round` arrives
  from Phase 3's loop per `execute` call and its `ordinal` is assigned by the reader; this phase's
  tests build a reader with fixture identity and drive it across several rounds directly, so both
  columns and the unique index are exercised here rather than only once Phase 3 lands.
- **Reconciliation record**: snapshot-creation failure is non-fatal in this phase and fatal in
  Phase 3 for an access-enabled Persona. That asymmetry is intentional and stated in both files,
  because inverting it here would make a feature nobody enabled able to fail an existing run.
- **Reconciliation record, review round 2.** The first draft constrained only `git_show`'s `rev`
  to the snapshot's ancestry and left `git_diff`'s `base` free, which lets an access-enabled
  Persona name another branch or object id and receive a diff containing files that were never in
  the submitted state - defeating the exact-submitted-state boundary this phase draws. Fixed by
  routing **every** caller-supplied revision through one shared `resolveSnapshotAncestor(rev)`, so
  the next rev-taking op added to the list cannot repeat the omission. The op set and decision 4 are
  unchanged: `git_diff` keeps its selectable base, it just cannot leave the snapshot's history.
  `maxPathsPerList` also rose from 2,000 to 4,000, because 2,000 sat below this repository's
  measured 2,633-path tree while claiming to sit above it - a whole-repository listing would have
  been silently clipped, which is the exact failure decision 12 rules out.
- **Reconciliation record, review round 4.** Two more findings, both this phase's, both accepted:
  1. `git_diff`'s default base read "`base` or `HEAD`", which reintroduces in one word the exact
     hazard this phase exists to answer - live `HEAD` is mutable and may have moved, been reset, or
     been handed to another task by review time. The default is now the captured `headSha`, resolved
     by the reader from state it already holds, and git is never asked for `HEAD`. A regression test
     moves the worktree's `HEAD` after capture and asserts the default-base diff does not follow it.
  2. `commit-tree` was specified without an identity, and it exits "Author identity unknown" when
     none is configured (verified). A clone that never set `user.email` would have failed every
     snapshot, and Phase 3 would then block every access-enabled Persona. It now runs with an
     explicit daemon-owned author and committer, which also stops the operator being recorded as the
     author of an object the daemon wrote. Fixture tests null out global and system config so
     ambient operator settings cannot mask the failure.
- **Reconciliation record, review round 5.** The step-7 post-filter was specified as applying to
  "every path in the result" of six ops including `git_diff`, which is wrong for that one op and only
  that one: a unified diff is a single blob carrying file content, so there is no path line to drop
  that takes the content with it. Measured, an unrestricted `git diff` over a snapshot holding an
  untracked non-ignored `.env` emitted `+SECRET=hunter2-should-never-be-seen` and
  `+-----BEGIN PRIVATE KEY-----` straight into the response. `git_diff` now resolves its path set
  first with `--name-only` (no content), denies within that set, and generates content only for an
  explicit `:(literal)` allowlist - so nothing denied is ever produced - then verifies both sides of
  every `diff --git` header before returning and refuses the whole op rather than shipping a
  partially filtered patch. `--no-renames` became explicit in the same change, because
  `diff.renames=true` on the reviewing machine made a header name a denied path and made the
  response shape depend on operator configuration. The op set and decision 4 are unchanged.
  The path-shaped denylist's real limit - content the change itself moved to an allowed path - is
  now stated rather than papered over, because claiming the allowlist covers it would be a false
  guarantee in the security section.
- **Reconciliation record, review round 6.** The reader factory was specified as
  `createRepositoryReader({ repoRoot, snapshotOid, headSha, budget })` while step 10 required it to
  write one audit row per operation and `workflow_repository_queries` required a unique
  `(node_attempt_id, round, ordinal)` - identity the factory never received. Phase 3 was
  simultaneously forbidden from writing audit rows, so as written **nothing** could persist a
  brokered query. Fixed by making the reader per-attempt and giving it that attempt's
  `{ runId, submissionId, nodeAttemptId }` plus a narrow `recordQuery` writer, with `round` passed
  per `execute` call and `ordinal` owned by the reader. Ownership did not move - the reader still
  writes every row - so Phase 3's non-goal stands unchanged; what changed is that it now has the
  data the contract always required. The reader also owning `ordinal` removes a class of bug the
  first shape invited, where two subsystems counting independently collide on the unique index.
- **Reconciliation record, review round 13.** Two findings, both accepted, and one further leak found
  while checking the second.
  0. *(Round 14, recorded here because it is the same class as several of these.)* The boot block
     grew to four `workflow_submissions` columns in round 12 while the `migrate(d)` instruction still
     said "the two `addColumn` calls". Invisible on a fresh install - `CREATE TABLE` supplies the
     column, so every test passes - and total on an upgrade. Fixed by naming all four, and closed as a
     class by a test that compares the `PRAGMA table_info` column set of a migrated pre-feature
     database against a fresh one, which names no column and so cannot go stale.
  1. **Staged blobs were not reachable.** The porcelain recorded the index oid but nothing kept that
     object alive, so for a staged-then-modified path the staged bytes were unretrievable after
     release or `gc`. I had called that out of scope on the reading that decision 7 asks only for
     merged content; the plain reading is the other one - it lists "staged ... content" and for a
     mixed-index path that is different bytes from the unstaged version. Capture now also writes the
     **index tree** (`write-tree` on the copied index before `add -A`, verified essentially free)
     and pins it under `refs/mission-control/review-index/<submissionId>`. `read_file` takes
     `stage: "worktree" | "index"`. The sibling ref is deliberate: a second *parent* would put the
     index commit in the snapshot's ancestry, and `merge-base --is-ancestor` is what `git_show` and
     `git_diff` gate on, so it would silently widen what those ops accept.
  2. **`read_file` and `git_blame` had no output class**, while the `Record` was specified as total -
     so the declaration could not have compiled. That gap was mine from round 9, where splitting the
     axes removed the `single-path` class and never re-homed those two on the output axis.
  3. **Found while fixing (2): `git_blame` emits other paths.** `--porcelain` writes `filename` and
     `previous` headers, and after a rename they name the *earlier* path - verified, with
     `--no-renames` making no difference. So blame on an allowed path can name a denied one, and it
     needs path filtering rather than being a "one path in, one file's bytes out" op. That is why the
     safety declaration is now a **set** of required handlings rather than one class: the question
     "which single class is this?" has no answer for an op emitting two kinds of thing, and guessing
     one is what produced both this and the round-9 `git_log` misfiling.
- **Reconciliation record, review round 7.** `git_show` with an allowed ancestor `rev` and no
  `path` emits that commit's whole patch, so a commit touching a denied path leaked its content -
  the identical hole round 5 fixed in `git_diff`, left behind in the sibling op because round 5's
  fix was written as a one-op fix. Verified: the offending `rev` **passes** the ancestry check,
  which is the actual lesson - ancestry answers "is this revision part of what was submitted" and
  the denylist answers "may this path be read", and one had been treated as covering the other.
  Fixed as a **class** rather than as a third instance: every op declares an output class in a total
  `Record<RepositoryQueryOp, ...>`, both `content` ops share one `generateAllowlistedPatch`, and the
  adversarial suite is table-driven over that record so a future content op inherits it. Found on
  the way: `git show`'s default format prints the commit message into the same stream the header
  verifier parses, and a message can contain a forged `diff --git` line (verified), so metadata and
  patch are now separate invocations and step 5 anchors at line start.
- **Reconciliation record, review round 8.** The cold-index fallback said `read-tree HEAD` while the
  snapshot is required to represent the captured `headSha` - the **third** appearance of live `HEAD`
  standing in for the captured commit, after `git_diff`'s default base in round 4. This one is
  silent rather than merely wrong: verified, a path force-added at the captured commit under a
  `.gitignore` pattern vanishes from the snapshot entirely when the seed comes from an advanced
  `HEAD`, because `add -A` will not re-add an ignored path the seeded index does not already track.
  The fallback now seeds from `headSha`. Two things came out of looking at it properly: the fast
  path carries the same hazard, since a copied live index reflects current tracking - so a step-4
  tree verification was added, comparing paths tracked at capture against the written tree and
  requiring any absentee to be absent from disk too; and the pre-existing parent assertion is blind
  to all of it, because `commit-tree -p <headSha>` sets the parent correctly however the index was
  seeded. Recording that explicitly, because "we already assert the parent" is exactly the reasoning
  that would let this back in.
- **Reconciliation record, review round 9.** `git_log` was filed in the `path` output class, whose
  safety is post-filtering paths out of the result - but its output has no paths to filter, and its
  own prose called it metadata. Two different safety arguments, and the wrong one was assigned. The
  consequence was concrete: nothing validated the `path` argument `git_log` accepts, so
  `git log --format=… -- .env` was permitted, confirming a denied path's existence, change times and
  commit subjects. Fixed by separating the two axes the single class list had conflated - **input**
  validation is now stated as universal for any op given a path or glob, regardless of class, and the
  **output** axis gains a `metadata` class for `git_log` with a real policy: a fixed no-path
  no-content `--format`, and `-p`/`--patch`/`--name-only`/`--name-status`/`--stat` forbidden rather
  than merely omitted (verified: the first emits content, the third emits paths).
  What is **not** claimed: the pathless log is verified to carry no path field and no diff line, but
  a commit *subject* is prose the author wrote and can name a denied path - the fixture's real
  subject is `add .env with the prod credentials`. No path-shaped rule filters an author's sentence,
  and that is the same boundary already recorded for the rename case, so the finding's broader
  framing is answered by stating the limit rather than by claiming to have closed it.
- **Reconciliation record, review round 11.** `git_log`'s argv carried no revision, so it walked live
  `HEAD`. Verified: after capture, two further commits - including one belonging to an unrelated task
  - appeared in its output, which is a straight breach of the exact-state boundary. Fixed, but the
  useful part was auditing **every** op's argv instead of only this one, which turned up that
  omitting a revision silently reads live state for `git log`, `git grep` and `git blame` (the last
  two read the live *working tree*, not any commit) while `git cat-file` and `git ls-tree` fail
  closed. Three silent, two safe, and no way to tell from the response - so the revision pin is now
  an invariant with a table of every op's argv and a mechanical test over it, plus a live-state
  regression for each of the three that can fall back. That test is what would have caught this,
  because an unpinned log returns a well-formed answer about the wrong commits and no output
  assertion notices.
- **Reconciliation record, review round 12.** Two findings, both accepted.
  1. **Conversion drivers execute during diff generation.** `git` runs a configured
     `diff.<name>.textconv` or `.command` while producing a patch, selected by a `.gitattributes` in
     the change under review - so the "no shell" boundary of decision 5 was not actually held by
     passing an argv array at the outer call. Measured invocations of a configured driver:
     `git diff` 3, `git show` 2, `git blame` **3**. Every content-producing invocation now passes
     `--no-ext-diff --no-textconv`, and `git blame` is included although the finding named only diff
     and show - it executes the driver by default too. `git grep` does not, and `--textconv` joins
     the forbidden-flag list so it cannot start. The argv test asserts the flags for the same reason
     it asserts the revision: their absence produces a well-formed answer.
  2. **`git_status` could not answer correctly and would not have said so.** A snapshot tree holds
     one blob per path, so the staged-versus-worktree distinction is absent from it entirely -
     verified, a staged-then-modified file is `AM` with a distinct index oid in `porcelain=v2` and
     just the worktree version in the tree. Leaning on the existing captured status made it worse,
     since that is bounded at 500 lines for the prompt. Capture now persists the complete
     `--porcelain=v2 -z` output on the submission with an explicit truncation flag, and `git_status`
     answers from that plus the tree-level name-status. Stated rather than papered over: the staged
     blob's *content* is not separately retrievable, because nothing pins it - decision 7 asks for
     the content of all four categories, which the merged tree provides.
