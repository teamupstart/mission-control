# Persona repository access - phased implementation

Source plan: `docs/plans/persona-repository-access/plan.md` (rendered at `plan.html`).
This index turns it into three merge units. The phase files (`phase-<n>-<slug>.md`, beside this
file) are the authoritative per-phase instructions; a scheduled task carries their paths, not their
content.

A rendered, self-contained version of this document sits beside it at `phased-plan.html`.

## Incorporated decisions

Every product and architecture decision below arrived approved with the request. This plan
implements them; none is re-opened, and none was presented back to the operator for confirmation.

| Decision | Selection | Owning phase |
|---|---|---|
| Where access is configured | Separately on each Persona | 1 |
| Provider coverage | Claude and Codex receive equivalent capabilities | 3 |
| Mechanism | Provider-neutral interactive query broker; ai-harness executes and audits | 2 (ops) + 3 (loop) |
| Capability set | read, search, glob, plus server-owned status, diff, show, log, blame | 2 |
| Excluded | shell, writes, network, direct unrestricted provider tools | 2 and 3 (as non-goals) |
| Sensitive paths | preserved or strengthened | 2 |
| Repository view | exact submitted state, including staged, unstaged and untracked | 2 |
| Unavailable | block and retry; never fall back to prompt-only | 3 (Phase 2 records the state) |
| Publication | frozen into the Persona snapshot at publish | 1 |
| Built-ins | immutable guidance/runner/model, local access override allowed | 1 |
| Auditability | operations, denials, truncation and failures recorded | 2 (record) + 3 (surface) |
| Limits | per-operation, per-round, per-attempt; no single global character cap | 2 (values) + 3 (round budget) |

### Execution assignment

All three phase tasks are scheduled on **Codex, `gpt-5.6-sol`, `high` reasoning effort**, at the
operator's direction, rather than on the backlog default. `create_task` deliberately files a task
with the default agent, model and effort, so this was applied afterwards through
`POST /api/tasks/:id/update`, which is the documented route that accepts all three; dependency edges
and task intents were verified unchanged by the patch.

Two consequences the phase files now carry, because all three implementers are Codex:

- `gpt-5.6-sol` is in the `codex` catalog (`src/shared/model.ts`) and its
  `effort.levelsFor` admits the full `THINKING_LEVELS`, so `high` is a valid pairing rather than one
  silently downgraded.
- On macOS under `CODEX_SANDBOX=seatbelt`, `npm test` includes real Electron geometry tests and
  needs the repository-prescribed scoped outside-sandbox approval. Each phase's verification section
  says so rather than leaving three agents to rediscover it, following the precedent in
  `docs/plans/test-db-isolation/` and `docs/plans/keep-awake-native-provider/`.

## Repository findings that shaped the phases

Verified against the worktree at planning time; implementers re-verify. Three findings decided the
shape, and each is the reason a phase exists where it does.

- **A pooled worktree can be reset underneath a running review.**
  `nativeWorktreeOwnerReferenced` (`src/server/worktrees/owners.ts:18`) has no `workflow_runs`
  clause, and task teardown releases with `ownerAuthorized: true`
  (`src/server/dispatcher.ts:2027`), which skips the domain check and leaves only process
  occupancy - which a server-side review does not have.
  `src/server/workflows/manager.ts:1163` already records the consequence in prose. So the review's
  repository view cannot be a directory. It is a snapshot commit in the repository's shared object
  database, and that is Phase 2's core.
- **No provider offers a second turn, and one of them offers no tool grant at all.**
  `runInThread` is `null` on both runners; the default Claude transport pins `maxTurns: 1` for the
  Persona shape; `codex exec` is one turn by construction; `codexRunner.sandbox` is `null` so every
  grant is refused; `LlmRunOptions` has no field for a tool definition or an MCP server, and no
  headless path passes an MCP flag. Parity is therefore impossible through native tools and
  trivial through a server-owned loop over `run(prompt)`. That is Phase 3's core, and it is why the
  approved broker decision is also the only workable one.
- **`PersonaSnapshotSchema` is a strip-mode `z.object` whose every key is required.** A new field
  must carry `.default("off")`, which is simultaneously the backward-compatibility mechanism and
  the enforcement of "later Persona edits affect only newly published versions". That single choice
  is the highest-risk edit in the feature and is why Phase 1 exists as its own merge unit.

Supporting findings, each cited in the phase that consumes it:

- A built-in Persona is not a row; immutability is enforced in three store methods, and
  `workflow_commands`/`workflow_command_overrides` is the repository's own precedent for a sidecar
  override table keyed by an immutable identity.
- `publishBuiltinGraph` runs at module load and cannot read the database, so built-in workflow
  versions freeze `off`. Duplicate-the-workflow is the documented route, matching the product's
  existing Duplicate-to-customize rule.
- `handleInfrastructureFailure` already provides the retry ladder and the blocked-run terminus, and
  `CHECK_CLEANUP_UNRESOLVED_PHASE` is the precedent for a distinct phase with a distinct remedy.
- The attempt's `StructuredAttemptObserver` already writes a per-call `workflow_llm_calls` row and
  already refuses to start a call after cancellation - the accounting and cancellation seams a round
  loop needs.
- Measured: seeding a temp index from the live one makes exact-state materialization **34 ms**
  (2,633 paths) against 729 ms cold, leaves the worktree and live index untouched, and the pinning
  ref lands in the **common** `.git` so it survives release, removal and `gc`.
- Measured: `git ls-tree` does **not** support `:(glob)` pathspec magic (`git grep` does), and
  there is no glob dependency in `package.json` - so the glob matcher is a small audited function,
  not a library and not two different semantics.
- Measured: `git add -A` respects `.gitignore`, but an untracked non-ignored `.env` is in the
  snapshot tree. Moving to git objects removes the filesystem from the trust boundary; it does not
  remove the need for a sensitive-path denylist.

Two discrepancies between the request's starting surfaces and the code, recorded rather than
carried forward:

- `ServerEvent` is in `src/shared/types.ts:2860`, not `src/shared/protocol.ts`. It needs no change:
  `persona_upsert` already carries a `PersonaView`.
- `src/server/inspector/` is a *reference*, not a target. The Inspector is the precedent for a
  review holding repository tools, and its `DENY_PATHS` seeds the denylist - but its grant cannot be
  reused, and this feature changes no Inspector behaviour.

## Sizing and phase count

**Estimated gross non-test implementation lines: 2,100 - 2,700**, counting production code added or
materially changed across shared contracts, persistence, server modules and browser code, and
excluding tests and documentation prose.

Assumptions behind the estimate: this repository's comment density is high and load-bearing (the
schema, migration and runner contracts all carry their rationale inline), so line counts run
roughly 1.5x what the same logic would be elsewhere; the eight typed operations are the largest
single block; and no new dependency is added.

| Area | Estimate |
|---|---|
| Shared contracts (`workflow.ts`, `protocol.ts`, `repository-query.ts`, `review.ts`) | 300 - 380 |
| Persistence (`db.ts` columns, tables, migrations) | 60 - 90 |
| Store (row schemas, resolver, override CRUD, snapshot columns, audit) | 320 - 400 |
| Routes and manager | 80 - 110 |
| Review-state materialization and retention | 200 - 260 |
| The eight typed operations, validation, denial, bounds | 420 - 520 |
| Broker loop, engine wiring, blocked phase, prompt | 380 - 470 |
| Browser (Persona Editor chip and control, api, run detail) | 340 - 470 |

Well above the 200-line one-phase threshold, so more than one phase is permitted. The default is
still one phase, and each additional boundary has to earn itself:

- **Phase 1 exists separately** because it is the only phase that touches persisted Persona state,
  published-version compatibility and built-in immutability - three surfaces where a mistake is
  silent and durable. `PersonaSnapshotSchema`'s `.default("off")` decides whether every existing
  published version keeps parsing, and the built-in override has to thread past three refusals that
  currently reject before looking at any field. Combining it with the broker would bury that
  compatibility argument inside a 1,600-line diff whose interesting parts are elsewhere. It also
  leaves the repository in a genuinely useful state on its own: an operator can configure and
  publish the setting, and no review behaviour changes.
- **Phase 2 exists separately** because it is the feature's entire security surface, and it can be
  proven without a model. Its adversarial tests - traversal in every position, a denied path reached
  only through a search *result*, a symlink out of the tree, a non-ancestor revision - are the
  reason the boundary is here: they get reviewed against the code that enforces them, before
  anything can point a reviewer at it. Folded into Phase 3, the same review would arrive alongside
  a round loop, a prompt change, a provider-parity argument and a UI surface, and the eight
  validation orderings would be the least-read part of it.
- **Phase 3 exists separately** because it is the behaviour change, and because it is the only
  phase that can be wrong in a way tests catch loudly rather than quietly. Its risks - does the
  loop terminate, does cancellation land, does a failure become a verdict - are dynamic, not
  structural.
- **No fourth phase.** Documentation, migration compatibility and observability live with the
  behaviour that introduces them, per the skill's rule against preparation and catch-all phases.
  There is no test-only or docs-only phase.

Why not fewer: Phases 2 and 3 combined would be ~1,300 - 1,600 lines spanning twelve files and two
distinct risk classes ("can a crafted path escape the tree" and "does this loop terminate"). Why not
more: no smaller unit leaves the repository operable. A phase that shipped only the query contract,
or only the snapshot, would be a dead surface with nothing to exercise it.

## Phases

| # | File | Merge unit | Direct dependencies |
|---|---|---|---|
| 1 | `phase-1-persona-access-setting.md` | The setting, its storage, its publication contract, and the Persona Editor | none |
| 2 | `phase-2-review-state-and-read-service.md` | Exact review-state materialization, the eight typed operations, and the audit record | none |
| 3 | `phase-3-interactive-broker.md` | The broker loop, provider parity, retry and blocking, prompt, and run detail | 1 and 2 |

```mermaid
flowchart LR
  P[planning PR merges] --> A[Phase 1: setting + snapshot + editor]
  P --> B[Phase 2: exact state + read service + audit]
  A --> C[Phase 3: broker + parity + prompt + run detail]
  B --> C
```

**Concurrency.** Phases 1 and 2 may execute and merge at the same time, in either order. Phase 3
starts when both have merged.

**Merge order.** Any of `1, 2, 3` / `2, 1, 3`. Phase 3 is always last.

## Cross-phase contracts

Established by Phase 1, consumed by Phase 3:

- `PERSONA_REPOSITORY_ACCESS_MODES` / `DEFAULT_PERSONA_REPOSITORY_ACCESS`, appended-only, with
  `off` meaning "absent" everywhere.
- `Persona.repositoryAccess` is the **resolved** value, so no consumer merges overrides again.
- `PersonaSnapshot.repositoryAccess` is non-optional after parse, via
  `.default(DEFAULT_PERSONA_REPOSITORY_ACCESS)` on the schema.
- `personaSnapshotOf` stays the single projection; `publishWorkflow` stays one transaction reading
  both catalogs inside it.
- The setting lives **outside** the editor draft: `PERSONA_DRAFT_FIELDS`, `personaUpdatePatch` and
  `reconcilePersonaSave` are unchanged.

Established by Phase 2, consumed by Phase 3:

- `RepositoryQuery`, `RepositoryQueryResult`, `REPOSITORY_DENIAL_CODES`,
  `REPOSITORY_QUERY_LIMITS`, `matchesRepositoryGlob`, `REPOSITORY_DENY_GLOBS`.
- `createRepositoryReader({ ..., audit, recordQuery, ... }).execute(query, { round })` as the
  **only** way to reach the repository. The reader owns validation, denial, mode classification,
  bounds, scrubbing, the audit write **and the `ordinal`**, so Phase 3 never re-implements a check,
  never writes an audit row, and never numbers a sequence. It is built **once per Persona attempt**
  and carries that attempt's `{ runId, submissionId, nodeAttemptId }`, which is what makes the
  unique `(node_attempt_id, round, ordinal)` identity satisfiable at all.
- `unavailable` as the only denial code meaning infrastructure.
- `WorkflowSubmission.reviewSnapshotOid` / `.reviewSnapshotRepoRoot`, nullable, with null meaning
  "no exact state is available".
- `refs/mission-control/review-snapshots/<submissionId>` and its retention owner.

Established by Phase 3:

- `PersonaReviewReply` and its bare-verdict tolerance, which is what keeps an access-off review on
  the historical prompt and parse path.
- `REPOSITORY_ACCESS_UNAVAILABLE_PHASE` and its `BLOCKED_PHASE_CLAUSES` label.
- `workflow_llm_calls.round`, distinct from `attempt` (the parse-retry attempt within a round).

Owned by exactly one phase, stated because each is a plausible place for two phases to collide:

| Concern | Owner | Not touched by |
|---|---|---|
| `src/shared/workflow.ts` Persona types | 1 | 2, 3 |
| `src/shared/repository-query.ts` | 2 | 1 |
| `PersonaSnapshotSchema` | 1 | 2, 3 |
| `personas`, `persona_access_overrides` | 1 | 2, 3 |
| `workflow_submissions` snapshot columns, `workflow_repository_queries` | 2 | 1, 3 (writes rows only) |
| `workflow_llm_calls.round` | 3 | 1, 2 |
| `reviewContract`, `buildPersonaPrompt` | 3 | 1, 2 |
| `personas/*.md` and the generated module | 3 | 1, 2 |
| Persona Editor | 1 | 2, 3 |
| Run detail | 3 | 1, 2 |
| Retry ladder and blocked phases | 3 | 1, 2 |

## Final cross-phase audit

Performed over the complete set after the last phase file was written.

**Every approved decision is owned by exactly one phase.** Checked against the twelve-row decision
table above; there is no decision without an owner and none with two. The three decisions split
across phases (broker mechanism, auditability, limits) are split along a stated seam - Phase 2 owns
the operations, the values and the record; Phase 3 owns the loop, the round budget and the surface -
and each phase file names its half and its non-goals.

**Every consumer follows its prerequisite.** Phase 3 consumes only contracts Phase 1 and Phase 2
establish, and both are direct dependencies. Neither Phase 1 nor Phase 2 reads anything the other
writes: Phase 1's reader takes a Persona, Phase 2's reader takes a snapshot oid.

**Concurrent phases can merge in either order.** Phases 1 and 2 both append to
`src/server/db.ts` (boot block and `migrate()`) and add methods to
`src/server/workflows/store.ts`. Every schema statement is `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS` or `addColumn`, all idempotent and order-independent, so the composed
schema is identical under either order and under a single upgrade that spans both. The expected
conflict is textual adjacency in two append-only regions, resolved by keeping both hunks; there is
no semantic conflict, and neither phase's tests read the other's tables.

**The final state matches the source plan without undocumented cleanup.** Walked the plan's ten
design sections against the phase files: the setting (1), snapshot and publication (1), exact
review state (2), broker protocol (2 for ops, 3 for envelope), the round loop (3), security model
(2 for enforcement, 3 for prompt-side framing), retry and blocking (3), Persona Editor (1), limits
(2 for values, 3 for round budget), audit and observability (2 for record, 3 for surface). Nothing
in the plan is unassigned, and no phase depends on a later phase to repair a knowingly broken state.

**Reconciliations made while writing the later phases**, each already appended to the affected
file's audit record:

1. `REPOSITORY_QUERY_LIMITS` carries `maxRounds` and `maxQueriesPerRound` in Phase 2 even though
   only Phase 3 consumes them. One budget belongs in one file; splitting it would let the halves
   drift. Phase 2's tests exercise them, so they are not dead.
2. Snapshot-creation failure is **non-fatal** in Phase 2 and **fatal** in Phase 3 for an
   access-enabled Persona. Inverting it would let a feature nobody enabled fail existing runs the
   moment Phase 2 merged. The asymmetry is stated in both files.
3. The publish-time published-graph byte guard was placed in Phase 1, not Phase 3, because Phase 1
   is the phase that widens the published snapshot; a guard added later would leave a window in
   which the field shipped without it.
4. The built-in Persona Markdown correction and the `reviewContract` access-on variant were moved
   out of Phase 1 into Phase 3. Both change what a reviewer is told, and Phase 1 changes no review
   behaviour; landing them early would also fire the outdated-snapshot signal on built-ins a phase
   before anything justified it.
5. The attempt-wide wall-clock budget is Phase 3's, not Phase 2's: it is a property of the loop,
   not of a read. `PERSONA_TIMEOUT_MS` keeps its existing meaning as a per-call budget so no
   single-call review changes.

**Reconciliations from automated review of the planning pull request.** Every finding was a real
defect in the artifacts, and every one was fixed without moving an approved decision.

Two patterns repeated often enough to be worth naming for the implementers, because both are easy to
reintroduce and neither is caught by the guards that look like they should catch it:

- **Live `HEAD` standing in for the captured `headSha`.** Four separate places (reconciliations 10,
  14 and 18). The snapshot exists precisely because the checkout is mutable, so any code path that asks
  git for `HEAD` after capture has reintroduced the problem the design exists to solve. The captured
  sha is always in hand; use it. Note that the parent assertion on the snapshot commit does **not**
  detect this, because the parent is passed explicitly.
- **Fixing a leak in one op and leaving its sibling.** `git_diff` then `git_show`
  (reconciliations 12 and 13), then `git_log` filed under a class whose safety argument did not apply
  to it (15). This is why output class is a total `Record` over the op list, why input validation is
  stated as universal rather than per-class, and why the adversarial suites are table-driven over the
  op list: the class rules and the test shape are the fix, not the three individual patches. When
  reviewing a new op, check **both** axes - what it is handed, and what its output can carry.
- **Updating one list and not its sibling list.** The dominant failure of this review, by some
  distance: the boot block versus `migrate()` (23), the class table versus the op set (22), the op argv
  versus its siblings (18), the reader's inputs versus what was persisted (27, 28), and the row schema
  versus the domain type (30). Six findings, one habit. Where a fact has to appear in two places, the durable answer has
  been a test that derives one from the other rather than a note asking the next author to remember -
  the `table_info` set comparison, the argv assertion, the total `Record`.
- **Fixing the instance the review pointed at, and not its siblings elsewhere.** The same failure in
  a different register, and the reason it is called out separately: a reader-directed instruction was
  removed from `plan.md` in reconciliation 9 and left standing in the pull request description, which
  is where a reviewer actually meets it (17). A finding anchored on one line is evidence about a
  class, not a work item scoped to that line - so when one lands, sweep the whole surface it belongs
  to, **including the pull request text**, which is as much untrusted input to automated review as
  any committed file.

6. **Every caller-supplied revision is ancestry-constrained, not just `git_show`'s** (Phase 2).
   `git_diff`'s `base` was left free, which would let an access-enabled Persona name another branch
   and receive a diff containing files that were never in the submitted state. One shared
   `resolveSnapshotAncestor(rev)` now serves both ops, so a future rev-taking op cannot repeat the
   omission.
7. **`maxPathsPerList` rose from 2,000 to 4,000** (Phase 2). The value sat *below* this
   repository's measured 2,633-path tree while its own rationale claimed it sat above - so a
   whole-repository listing would have been silently clipped, which is the failure decision 12 rules
   out.
8. **The built-in access override got its own `revision`** (Phase 1). The first draft accepted and
   ignored `expectedRevision` for a built-in, whose synthetic revision is always `1`; two concurrent
   writers would both succeed and the later would silently win. One token,
   `expectedAccessRevision`, now means "the revision of the record that stores this setting", with
   `0` for a built-in that has no override row yet so the concurrent first write is refused too.
9. **The plan's own pointer to its rendered page is a description rather than an instruction.**
   Pull-request content is untrusted input to automated review, so an imperative aimed at a reader
   was replaced with a neutral statement of where the file is.
10. **`git_diff`'s default base is the captured `headSha`, never live `HEAD`** (Phase 2). The
    original wording reintroduced, in one word, the exact hazard this plan exists to answer: the
    worktree's `HEAD` is mutable and may have moved by review time. The reader resolves the default
    from state it already holds and never asks git for `HEAD`; a regression test moves `HEAD` after
    capture and asserts the diff does not follow it.
11. **Snapshot commits carry a daemon-owned Git identity** (Phase 2). `commit-tree` was specified
    without one, and it exits "Author identity unknown" when none is configured - verified - so a
    clone that never set `user.email` would have failed every snapshot and blocked every
    access-enabled Persona. It also fixes provenance the other way: the operator would otherwise be
    recorded as author of an object the daemon wrote.
12. **`git_diff` is allowlisted before it runs, not filtered after** (Phase 2). The post-filter step
    listed `git_diff` alongside five path-emitting ops, which is wrong for a response that is one
    blob of file content: measured, an unrestricted diff over a snapshot holding an untracked
    non-ignored `.env` emitted `+SECRET=hunter2-should-never-be-seen` and
    `+-----BEGIN PRIVATE KEY-----` into the response. The path set is now resolved first with
    `--name-only`, denied within, and content generated only for an explicit `:(literal)` allowlist,
    with both sides of every `diff --git` header verified before anything is returned.
    `--no-renames` became explicit at the same time, because `diff.renames=true` on the reviewing
    machine made a header name a denied path and made the response shape depend on operator config.
    The path-shaped denylist's genuine limit - content the change itself moved to an allowed path -
    is now stated rather than implied covered.
13. **Output class is declared per op, and both content-bearing ops share one allowlisted pipeline**
    (Phase 2). `git_show` with an allowed ancestor `rev` and no `path` emitted its commit's whole
    patch, leaking a denied path's content - the identical hole reconciliation 12 fixed in
    `git_diff`, left behind because that fix was written as a one-op fix. Verified: the offending
    revision **passes** the ancestry check, which is the real lesson - ancestry answers "is this
    revision part of what was submitted" and the denylist answers "may this path be read", and one
    had been treated as covering the other. Now a total `Record<RepositoryQueryOp, ...>` states each
    op's class, both `content` ops call one `generateAllowlistedPatch`, and the adversarial suite is
    table-driven over that record so a future content op inherits it rather than needing to be
    remembered. `git_show` also fetches its commit message separately from its patch, because a
    message is attacker-controlled text that can contain a forged `diff --git` line (verified).
14. **The cold index fallback seeds from the captured `headSha`, and the tree is verified** (Phase 2).
    The fallback said `read-tree HEAD` while the snapshot must represent the captured commit - the
    third appearance of live `HEAD` standing in for it. Silent rather than merely wrong: verified, a
    path force-added at capture under a `.gitignore` pattern vanishes from the snapshot when the seed
    comes from an advanced `HEAD`, because `add -A` will not re-add an ignored path the seeded index
    does not track. The fast path carries the same hazard, since a copied live index reflects current
    tracking, so a tree verification now compares paths tracked at capture against the written tree
    and requires any absentee to be absent from disk too. The pre-existing parent assertion is blind
    to all of it - `commit-tree -p <headSha>` sets the parent correctly however the index was seeded.
15. **Input validation and output class are separate axes** (Phase 2). `git_log` was filed in the
    `path` output class, whose safety is post-filtering paths out of a result - but its output has no
    paths to filter, and its own prose called it metadata. The concrete consequence was that nothing
    validated the `path` argument it accepts, so `git log --format=… -- .env` was permitted,
    confirming a denied path's existence, change times and commit subjects. Input validation is now
    stated as **universal** for any op given a path or glob, independent of output class, and the
    output axis gains a `metadata` class with a real policy: a fixed no-path no-content `--format`
    and `-p`/`--name-only`/`--name-status`/`--stat` forbidden rather than merely omitted. Not
    claimed: a commit *subject* is authored prose and can name a denied path, which no path-shaped
    rule filters - the same boundary already recorded for renames.
16. **The reader carries per-attempt audit identity** (Phases 2 and 3). The factory took only
    `{ repoRoot, snapshotOid, headSha, budget }` while the same phase required it to write a row per
    operation under a unique `(node_attempt_id, round, ordinal)`, and Phase 3 was forbidden from
    writing rows - so as written, nothing could persist a brokered query. The reader is now built
    per attempt with that attempt's `{ runId, submissionId, nodeAttemptId }` and a narrow
    `recordQuery` writer, takes `round` per `execute`, and assigns `ordinal` itself. Ownership did
    not move; the reader had always been the writer, and it now has what the contract required.
17. **Reader-directed instructions removed from the pull request text too, not just the plan**
    (no phase - review hygiene). Reconciliation 9 neutralised an imperative in `plan.md` but left two
    in the pull request description, which is where a reviewer and an automated reviewer actually
    encounter it. Both are now statements of where the rendered files are rather than directions to
    open or read them. Recorded here because the miss was the class failure above, not a second
    independent defect: the finding was anchored on a file, so the sweep stopped at that file.
18. **Every git invocation names an explicit snapshot-derived revision** (Phase 2). `git_log`
    carried no revision, so it walked live `HEAD`; verified, two post-capture commits including one
    from an unrelated task appeared in its output. Auditing every op rather than just that one turned
    up why this keeps happening: omitting a revision does not fail, it silently reads live state, and
    it does so differently per command - `git log` walks live `HEAD`, `git grep` and
    `git blame` read the live *working tree* rather than any commit, while `git cat-file` and
    `git ls-tree` refuse to run. Three silent, two safe, indistinguishable from the response. The
    pin is now an invariant with a per-op argv table and a mechanical test over the built argv, which
    is what catches this class - an unpinned log returns a well-formed answer about the wrong commits,
    so no output assertion notices.

19. **Every content-producing git invocation disables conversion drivers** (Phase 2). `git` runs a
    configured `diff.<name>.textconv` or `.command` while producing a patch, selected by a
    `.gitattributes` in the change under review - so decision 5's no-shell boundary was not held by
    passing an argv array at the outer call. Measured driver invocations: `git diff` 3, `git show` 2,
    `git blame` **3**. All three now pass `--no-ext-diff --no-textconv`; `git blame` is included
    although the finding named only diff and show. `--textconv` joins the forbidden-flag list and the
    argv test asserts the flags, since their absence produces a well-formed answer.
20. **`git_status` answers from a persisted `--porcelain=v2`, not from the tree** (Phase 2). A
    snapshot commit records one blob per path, so the staged-versus-worktree distinction is absent
    from it - verified, a staged-then-modified file is `AM` with a distinct index oid in porcelain and
    only the worktree version in the tree. Leaning on the existing captured status made it worse,
    since that is bounded at 500 lines for the prompt. Capture now persists the complete porcelain on
    the submission with an explicit truncation flag. Stated rather than papered over: the staged
    blob's *content* is not separately retrievable, because nothing pins it - decision 7 asks for the
    content of all four categories, which the merged tree provides.

21. **Staged blobs are pinned, so decision 7 is literally true** (Phase 2). The porcelain recorded
    the index oid but nothing kept that object alive, so a staged-then-modified path's staged bytes
    were unretrievable after release or `gc`. I had called that out of scope, reading decision 7 as
    asking only for merged content; the plain reading is the other one - it lists "staged ...
    content", and for a mixed-index path that is different bytes. Capture now also writes the index
    tree and pins it under a sibling ref, and `read_file` takes `stage: "worktree" | "index"`. A
    sibling ref rather than a second parent, because a second parent would enter the snapshot's
    ancestry and `merge-base --is-ancestor` is what `git_show` and `git_diff` gate on.
22. **The safety declaration is a set of required handlings, not one class** (Phase 2).
    `read_file` and `git_blame` had no output class at all while the `Record` was specified as total,
    so it could not have compiled - a gap left by reconciliation 15, which removed the `single-path`
    class and never re-homed those two. Fixing it turned up why a single label keeps failing:
    `git blame --porcelain` emits `filename` and `previous` headers naming *other* paths (verified,
    even with `--no-renames`), so blame carries both file content and paths and needs two handlings.
    The declaration is now `ReadonlySet<RepositorySafetyStep>` per op, with an empty set as a real
    answer for `read_file` - stated so "nothing declared" cannot be confused with "not yet
    classified", which is the confusion that produced this.

23. **Every persisted column has a migration, and a test that cannot go stale** (Phases 1 and 2).
    The boot block grew to four `workflow_submissions` columns in reconciliation 20 while the
    `migrate(d)` instruction still said "the two `addColumn` calls". This is the failure mode the
    repository's own migration comment describes: `CREATE TABLE` supplies the column to a fresh
    database, so every test and every developer machine looks fine, and only an existing
    installation is broken. All four are now named. Closed as a class by a test that compares the
    `PRAGMA table_info` column set of a migrated pre-feature database against a fresh one - it names
    no column, so it does not go stale as columns are added, and it is the assertion that would have
    caught this. Each phase adds it for the tables it owns, so the two stay independent.

24. **Paths are bytes end to end; the durable columns are BLOBs** (Phase 2). `-z` was chosen
    because git paths are bytes, and the payload was then specified into a `TEXT` column - the same
    contradiction as writing "match as bytes, never normalize" at step 2 and then decoding every path
    into a JavaScript string. Measured: a UTF-8 round trip turns 11 bytes into 15 and is not
    recoverable, and `a<ff>b` and `a<fe>b` - two distinct paths - decode to one string, which is the
    security-relevant half because a denylist decision on a decoded string is a decision about a
    different value. Fixed as a class: validation, denylist and glob matcher compare bytes; the
    porcelain and the audit `path` are BLOBs; `-c core.quotePath=false` is required on every
    invocation (git otherwise C-quotes into a *third* representation, verified) with `-z` wherever
    the output form allows. A non-UTF-8 path is reported to the reviewer with a marker and is
    unaddressable, so `read_file` on the mangled spelling fails closed.

25. **Capture neutralises content filters** (Phase 2). `git add -A` runs a configured
    `filter.<name>.clean` for paths a submitted `.gitattributes` selects, and a clean filter rewrites
    what gets stored. Measured: two invocations and `value=REDACTED-original` in the snapshot as
    specified, versus zero and `value=SECRET-original` with the filters overridden - so this broke
    decision 7, not only decision 5. `filter.*.process` is neutralised too: it is what git-lfs uses,
    enumerating only `.clean` would have missed it, and a mismatched `process` driver **hangs**
    `git add` rather than failing, so the capture calls carry a timeout as well. The fix is
    configuration rather than plumbing, which keeps the 34 ms fast path and preserves file modes.
26. **An `unavailable` mid-loop aborts the attempt** (Phase 3). The loop treated only a missing
    snapshot or a failed reader construction as infrastructure. A git timeout on round 3 would have
    been folded into the transcript like a denial, the model would have proceeded on what it had, and
    the attempt could have produced a verdict reached without the repository - decision 8 broken by a
    path that looks like normal operation. `unavailable` now aborts at once; every other code stays
    data.
27. **The reader receives the persisted status and index tree** (Phases 2 and 3). Reconciliations 20
    and 21 persisted the porcelain and the index tree, and neither was added to
    `createRepositoryReader`'s inputs - so `git_status` had no contract path to the data it answers
    from and would have had to reach into persistence outside its interface, or silently report
    tree-derived state as complete. The same one-list-not-its-sibling habit as 23; the durable
    answer here is that the reader reads no row at all, so anything it needs has to arrive in the
    factory object where its absence is a type error.

28. **The index tree is derived from its ref, not persisted** (Phases 2 and 3). Reconciliation 21
    pinned the index tree and 27 added `indexTreeOid` to the reader's inputs, and nothing ever
    returned or stored it - so Phase 3 had no durable source for a required factory input. The
    review offered persisting it or making ref resolution an explicit contract; I took the second,
    because the ref name is a pure function of the submission id, so there is no fifth column to keep
    in step with the reader's inputs - and that pair is precisely what produced the finding. The
    reader resolves it once at construction. A missing ref yields the new `stage_unavailable` denial,
    deliberately **not** `unavailable`, which since 26 aborts the attempt: a submission captured
    before this phase has no index ref, and that is not a reason to fail its review.
29. **The round envelope schema stays browser-safe** (Phase 3). The envelope was specified to reuse
    `PersonaVerdictInputSchema` from `src/server/workflows/verdict.ts` - impossible twice over, since
    `src/shared` imports nothing from `src/server` (verified, the boundary is clean today, so this
    would have been the first violation and the web bundle would have broken) and the schema is not
    exported at all. The tolerant schema moves to `src/shared/protocol.ts` beside the strict
    `PersonaVerdictSchema` it is the sibling of, and the server parser imports it, keeping
    `normalizePersonaVerdict` and the id cross-checks server-side.

30. **Every persisted value travels all five hops, with a round-trip test** (Phases 2 and 3). The
    porcelain was declared on the row schema and never carried onto `WorkflowSubmission`, so it was
    parsed and dropped - the fifth instance of one-list-not-its-sibling, and this time both halves sat
    three lines apart in the same bullet. Fixed, and then swept properly rather than narrowly: the
    same sweep found two more the review had not reached - the audit rows had no domain type at all
    (Phase 3 renders them, so there was nothing to render), and `workflow_llm_calls.round` was never
    added to `WorkflowLlmCall`. The rule is now stated once with the five hops named -
    column, row schema, row parser, domain type, writer - and each value carries a **round-trip test**
    through the public store API, which is the only test that sees a value parsed and then dropped: a
    parser test passes and an insert test passes.

## Final verification strategy

Each phase runs `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and
`npm run smoke`; Phases 1 and 3 additionally run `npm run test:e2e` because they change UI
surfaces. Focused single-file runs use the suite's loader preamble
(`--import ./test/setup-state.mjs --import tsx`), which is not optional.

After Phase 3 merges, three properties are the ones worth re-checking end to end, because each
spans phases and no single phase's tests can assert it alone:

1. **An access-off Persona is byte-identical to before the feature.** Prompt string, parse path,
   provider options, and both capture fingerprints. This is what makes the feature safe to ship to
   installations that never enable it.
2. **An access-on Persona never returns a verdict without the repository.** Exercised through the
   browser with the snapshot removed, ending in `repository_access_unavailable` after the retry
   ladder.
3. **Claude and Codex produce the same review capability.** The same fixture change, the same
   Persona, both runners, the same operation set reaching the reader - the regression test for the
   parity decision, and the one that would catch a future change reintroducing a provider grant.
