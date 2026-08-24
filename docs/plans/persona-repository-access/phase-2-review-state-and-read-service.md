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
    (`read-tree HEAD` then `add -A`): 729 ms. Live worktree and live index unchanged either way.
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
- `REPOSITORY_DENIAL_CODES = ["not_found", "not_a_file", "sensitive_path", "path_invalid", "symlink", "submodule", "binary", "too_large", "unsupported_rev", "invalid_argument", "budget_exhausted", "unavailable", "cancelled"] as const`.
  Appended-only; the strings reach durable audit rows.
- `RepositoryQueryResult`: `{ ok: true; op; ...payload; bytes; truncated; omittedBytes }` or
  `{ ok: false; op; code; detail }`.
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

CREATE TABLE IF NOT EXISTS workflow_repository_queries (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  submission_id    TEXT NOT NULL,
  node_attempt_id  TEXT NOT NULL,
  round            INTEGER NOT NULL,
  ordinal          INTEGER NOT NULL,
  op               TEXT NOT NULL,
  path             TEXT,
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

In `migrate(d)`, the two `addColumn` calls. Create the run index in `migrate()` only if it names a
just-added column - the constraint `db.ts:1245-1249` documents. The unique index is the durability
guarantee that a retried round cannot double-write its audit.

### 3. Snapshot service - `src/server/workflows/review-snapshot.ts` (new)

- `reviewSnapshotRef(submissionId)` - the one place the ref name is spelled.
- `createReviewSnapshot({ repoRoot, checkout, headSha, submissionId })`:
  1. resolve `--git-common-dir` and `--git-dir` (argv arrays, never a shell);
  2. copy the checkout's live index to a temp path, falling back to `read-tree HEAD` into an empty
     temp index when the copy fails - the fast path is 34 ms and the fallback is 729 ms, and the
     fallback must exist because a fresh or repaired worktree may have no readable index;
  3. `add -A`, `write-tree`, `commit-tree -p <headSha>`, `update-ref`. **`commit-tree` runs with an
     explicit daemon-owned identity** in its environment - `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
     `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` - and never relies on repository or global config.
     Verified: with no identity configured, `commit-tree` exits non-zero with "Author identity
     unknown", so a freshly cloned repository that never set `user.email` would fail every snapshot,
     and Phase 3 would then retry and block every access-enabled Persona before any provider call.
     The explicit identity also fixes provenance in the opposite case: on a machine that *does* have
     config, the operator would otherwise be recorded as the author of an object the daemon wrote.
     Constants live beside `reviewSnapshotRef` so one module owns the namespace and the identity;
  4. assert the resulting commit's parent equals `headSha`, and return
     `{ oid, repoRoot }` or a typed failure naming which step failed;
  5. clean up the temp index on every path.
  Never touch `GIT_INDEX_FILE` for the live index, never write into the worktree, and never run
  anything that could check out a tree.
- `deleteReviewSnapshot(repoRoot, submissionId)` - `update-ref -d`, idempotent.
- `sweepOrphanReviewSnapshots(repoRoots, liveSubmissionIds)` - `for-each-ref` under the namespace,
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

- `WorkflowSubmissionRowSchema` gains the two nullable columns as `nullableText.optional()`;
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
  // Identity for every row this reader writes. One reader, one attempt.
  audit: { runId, submissionId, nodeAttemptId },
  // Narrow writer, defaulted in production to the store's insertRepositoryQueryAudit.
  // A callback rather than the store itself so the reader's own tests need no database.
  recordQuery,
  budget,
})
// => { execute(query, { round }): Promise<RepositoryQueryResult>, close(): void }
```

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
4. **Mode classification** - from the cached tree listing: `120000` is `symlink`, `160000` is
   `submodule`, a tree is `not_a_file`, absent is `not_found`.
5. **Size pre-flight** - `cat-file --batch-check` for the byte count; refuse `too_large` before
   reading.
6. **Execute** - the argv from the plan's table, through `run` with a per-operation timeout.
7. **Post-filter** - re-apply the path validator and the denylist to every path in the **result**
   of `search_text`, `list_paths`, `git_status`, `git_log` and `git_blame`. This is the
   step that makes the denylist real; `claude-grant.ts` already documents why a rule that guards
   only arguments protects nothing it names.
   **This step is sufficient only because each of those five emits paths beside their own content,
   or no content at all** - `search_text` is line-per-match, `list_paths` and `git_status` are
   name-only, `git_log` is metadata, and `git_blame` takes its single path as an argument validated
   at step 2. Dropping the line drops the content with it. **`git_diff` is deliberately absent from
   that list and must not be added to it** - see *Content-bearing output* below.
8. **Bound and mark** - clip to the per-query, per-round and per-attempt budgets, set
   `truncated` and `omittedBytes`. Never clip silently.
9. **Scrub** - `scrubSecrets` over the response text.
10. **Audit** - one row per operation, whatever the outcome, through `recordQuery` with this
    reader's `audit` identity, the `round` this `execute` was given, and the `ordinal` the reader
    assigned. The write happens on **every** exit path including a refusal at step 2 or 3, so a
    denial is as auditable as a success - which is what decision 11 asks for.

**Every caller-supplied revision is constrained to the snapshot's ancestry.** `git_show`'s `rev`
and `git_diff`'s `base` each pass only when `merge-base --is-ancestor <rev> <snapshotOid>` succeeds,
and are otherwise refused as `unsupported_rev`. Without that check a revision is an arbitrary
reference into the whole object database - another branch, another task's work, any object the
repository happens to hold - and a diff taken against one returns files that were never in the
submitted state, which defeats the exact-submitted-state boundary this phase exists to draw.

### Content-bearing output: `git_diff` is allowlisted before it runs

A unified diff is **one blob that carries file content**, not a list of paths beside content. So
filtering paths out of a finished patch is not the same operation as filtering a path list, and a
denylist applied after the fact has already lost. Measured on a fixture snapshot containing an
untracked, non-ignored `.env` and a `k/id_rsa`:

```
$ git diff <headSha> <snapshot> | grep -n 'hunter2\|BEGIN PRIVATE KEY'
7:+SECRET=hunter2-should-never-be-seen
21:+-----BEGIN PRIVATE KEY-----
```

Both files are in the snapshot tree - which the plan already establishes as the reason the denylist
survives the move to git objects - so an unrestricted `git_diff` hands their contents to the broker.

`git_diff` therefore runs as two invocations, and **content is never generated for a denied path**:

1. **Paths first, no content.** `git diff --no-renames -z --name-only <base> <snapshot>` yields the
   changed path set and nothing else.
2. **Validate and deny** that set through steps 2 and 3 above. Record how many paths were dropped.
3. **Nothing surviving** returns an ok, empty patch with `filtered: true` and the dropped count -
   not an error, because "every changed file is denied" is an answer.
4. **Content second, allowlisted.** `git diff --no-renames <base> <snapshot> -- ':(literal)<path>'…`
   over the surviving paths only, batched so argv stays bounded, results concatenated in path order.
   Verified: the same fixture yields zero occurrences of either secret.
5. **Verify before returning.** Re-extract the paths from every `diff --git a/<x> b/<y>` header in
   the produced patch and re-check **both** sides against the validator and the denylist. A header
   that fails, or that cannot be parsed into two paths, refuses the whole operation as
   `sensitive_path` rather than returning a partially filtered patch. Generating nothing denied is
   the guarantee; this is the assertion that the guarantee held.

`--no-renames` is **explicit, not inherited**. With the operator's `diff.renames=true` the same
fixture emits `diff --git a/.env b/notsecret.txt` - a header naming a denied path, whose shape
depends on the reviewing machine's git config. Passing `--no-renames` makes every path its own
section and the response shape independent of configuration. The broker also never passes `-c` or
`--cc`, so combined-diff headers cannot arise; step 5 refuses any header form it cannot parse, so
they could not slip through unnoticed if they did.

**The honest limit, stated because overclaiming here would be worse than the gap.** This guarantees
that a *denied path* contributes no section. It does not stop content the submitted work itself
moved to an *allowed* path: rename `.env` to `notsecret.txt` in the change under review and its
bytes are reachable - but reachable exactly as `read_file("notsecret.txt")` already makes them,
because the denylist is path-shaped by construction. That is the documented boundary of a
path-shaped rule, with `scrubSecrets` as the imperfect content-shaped layer behind it, and it is not
made better or worse by `git_diff`. Do not describe the allowlist as preventing it.

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
- **The adversarial `git_diff` content tests, which are their own group because path-shaped
  assertions do not cover a content-bearing response.** Against a snapshot holding an untracked
  non-ignored `.env`, a `k/id_rsa`, a binary file and an ordinary changed source file:
  - a whole-repository `git_diff` returns the source file's hunks and **zero bytes** of the `.env`
    or `id_rsa` content - assert on the secret *values*, not on the paths, since a path-only
    assertion passes against an implementation that filtered headers and kept hunks;
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
  with null snapshot columns and every other field unchanged; two opens are idempotent.
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
- `createRepositoryReader({ ..., audit, recordQuery, ... }).execute(query, { round })` as the only
  way to reach the repository, and `unavailable` as the only code meaning infrastructure. Phase 3
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
