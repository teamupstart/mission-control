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
  3. `add -A`, `write-tree`, `commit-tree -p <headSha>`, `update-ref`;
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

`createRepositoryReader({ repoRoot, snapshotOid, headSha, budget })` returning
`execute(query): Promise<RepositoryQueryResult>`, and a `close()` that abandons in-flight work.

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
   of `search_text`, `list_paths`, `git_status`, `git_diff`, `git_log` and `git_blame`. This is the
   step that makes the denylist real; `claude-grant.ts` already documents why a rule that guards
   only arguments protects nothing it names.
8. **Bound and mark** - clip to the per-query, per-round and per-attempt budgets, set
   `truncated` and `omittedBytes`. Never clip silently.
9. **Scrub** - `scrubSecrets` over the response text.
10. **Audit** - one row per operation, whatever the outcome.

**Every caller-supplied revision is constrained to the snapshot's ancestry.** `git_show`'s `rev`
and `git_diff`'s `base` each pass only when `merge-base --is-ancestor <rev> <snapshotOid>` succeeds,
and are otherwise refused as `unsupported_rev`. Without that check a revision is an arbitrary
reference into the whole object database - another branch, another task's work, any object the
repository happens to hold - and a diff taken against one returns files that were never in the
submitted state, which defeats the exact-submitted-state boundary this phase exists to draw.

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
  - `deleteReviewSnapshot` is idempotent and the sweep removes an orphan and spares a live one.
- `test/repository-read.test.ts` (new): every op returns its shape against the fixture; a dirty
  file reads with its dirty content; `read_file` paging by `startLine`/`lineCount`; truncation sets
  `truncated` and `omittedBytes`; `list_paths` and `search_text` agree on which paths exist.
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
- Also assert the positive half, so the check is not simply "refuse everything": a `base` that *is*
  an ancestor - the snapshot's parent, and the merge base against the default branch - succeeds and
  returns the expected paths.
- `test/workflow-context.test.ts`: capture persists the oid and root; **both fingerprints are
  byte-identical** to a run whose snapshot oid differs; a snapshot failure leaves the columns null
  and capture still succeeds.
- `test/workflow-db.test.ts`: the new columns and table exist with their indexes; the audit table
  has a validating typed row parser like every other workflow table; the unique index refuses a
  duplicate `(attempt, round, ordinal)`.
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
- `createRepositoryReader(...).execute(query)` as the only way to reach the repository, and
  `unavailable` as the only code meaning infrastructure.
- The reader owning validation, denial, bounds, scrubbing and audit, so Phase 3 never re-implements
  a check and never writes an audit row itself.
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
  `workflow_llm_calls.round`, which this phase does not touch. The audit table's `round` and
  `ordinal` are written by Phase 3's loop; this phase's tests exercise them with a synthetic round
  number, so the columns are not dead.
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
