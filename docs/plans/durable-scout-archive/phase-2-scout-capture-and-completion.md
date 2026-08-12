# Phase 2: scout capture and completion

## Outcome and value

Every newly delivered scout is explicitly asked to produce one self-contained HTML report and can
submit that report plus bounded supporting artifacts through Mission Control. A scout cannot become
`done` or lose its Mission Control-owned checkout until a verified portable bundle exists. A scout
that exits unexpectedly leaves an honest complete or partial archive rather than losing all useful
output.

This phase makes the archive reliable without depending on the optional HTML-report skill or model
memory. The archive remains accessible through the Phase 1 HTTP API; the dedicated history UI lands
in Phase 3.

## Entry criteria and direct dependencies

- Direct dependency: Phase 1, `phase-1-portable-library-and-index.md`.
- Phase 1 must be merged and its C1-C5 contracts available on the default branch.
- Re-verify current call sites of `TaskManager.complete`, `TaskManager.reclaim`, `TaskManager.remove`,
  `TaskManager.cancel`, `Dispatcher.dispatch`, and `TaskManager.assignReserved` before editing. These
  are active ownership boundaries and may move between planning and implementation.

## Scope

In scope:

- mandatory scout report instructions for fresh dispatch and assignment;
- launch-scoped Mission MCP requirement and `submit_scout_artifacts` registration;
- server-derived submission attribution and idempotency;
- durable local capture-job rows and restart recovery;
- bounded copying of the report folder and explicit supporting files;
- static HTML verification, manifest assembly, atomic publication, and index notification;
- asynchronous scout completion gating across every existing completion caller;
- `onSessionExit` recovery and honest partial bundles;
- reclaim, remove, cancel, and startup-cleanup protection;
- focused unit, HTTP, lifecycle, fake-agent Playwright, documentation, and skill-contract coverage.

Explicit non-goals:

- adding the top-level Scouts page or any historical search UI;
- capturing conversations, last messages, prompts, hidden reasoning, or every changed file;
- editing a published archive in place;
- synthesizing an HTML report after the source checkout is gone;
- changing ship-task completion, dependency, teardown, or Mission MCP behavior;
- adding remote transport, trust, signing, or a retention policy.

## Repository findings and inherited contracts

This phase inherits C1-C5 and the server half of C12. It owns C6-C9.

- The Phase 1 directory and verified manifest remain the completion authority. A successful SQLite
  upsert is not part of capture readiness.
- `src/server/mission-mcp.ts` has the append-only tool registry and launch descriptor;
  `src/mcp/server.ts` repeats tool input schemas by design; `src/shared/protocol.ts` validates daemon
  HTTP bodies. `test/mission-mcp.test.ts` enforces registry and server drift.
- `src/server/ensembles/submission-tool.ts`, `src/server/ensembles/member-prompt.ts`, and the
  `/mcp/ensembles/submit` route are the closest pattern for a required, task-attributed, idempotent
  artifact submission. Scout capture stays in `src/server/scouts/`, not under Ensembles.
- `Dispatcher.dispatch` owns fresh terminal and SDK delivery and already fails if a caller-declared
  Mission MCP requirement cannot be registered. It knows the durable `Task.kind` before choosing a
  runtime.
- `TaskManager.assignReserved` injects `ready.intent` directly after resetting a live session. A
  dispatcher-only prompt helper would miss this path. Assignment cannot retroactively change a
  process's launch allowlist, so it must verify the already-registered Mission MCP channel is usable
  and deliver the same report appendix; refuse before destructive reset if the tool is unavailable.
- `TaskManager.complete` is synchronous at phase entry. Its call sites include the completion HTTP
  route, merge and session-loss reconciliation, internal task tests, and
  `EnsembleTaskManagerGateway.settleSuperseded`. The owner method, interface promises, engine awaits,
  and tests must change together.
- `Registry.onSessionExit` fires inside `beginEviction` before `session_remove`, while the session,
  task, work episode, checkout, and attached worktree metadata can still be derived. It is the one
  reservation signal. Continue to use the existing eviction and `session_remove` sequence.
- The normal complete modal awaits the HTTP request before offering its follow-on stop. A validation
  conflict can keep the existing modal and task open without a new client completion path.
- `skills/html-report/SKILL.md` already owns the optional report-authoring instructions. Its current
  short-answer exception is incompatible with durable scouts and must be narrowed.

## Implementation steps

### 1. Add the durable capture-job ledger

Add the all-new `scout_capture_jobs` table in `src/server/db.ts`. Keep its local coordination data
separate from the portable manifest. At minimum store:

- one stable operation key for a task work episode;
- local task ID, session ID when known, work-episode identity, and append-only job status;
- generated producer ID and archive ID once reserved;
- submitted report path, bounded summary, tags, and explicit supporting locators;
- server-derived repository slots and local source roots needed for recovery;
- safe error, attempt timestamps, created and updated times, and final bundle relative path.

Use an all-new table in the base schema with indexes after creation. Do not add foreign keys or
cascades to task and session tables. The row may retain local identifiers after publication for
idempotent replay, but no completed archive reader may require it.

Extend `src/server/scouts/store.ts`, or add a focused `capture-store.ts`, with transactional compare
and set operations. Persisted job statuses are append-only. Serialize one operation per task episode
and make retries return the already reserved key or final result. A lost HTTP response must not
publish a second archive.

### 2. Define and enforce the report-delivery contract

Add a focused `src/server/scouts/prompt.ts` that appends a compact, stable appendix only when
`Task.kind === "scout"`. It must tell the agent to:

- write `docs/reports/<slug>/report.html` even for a short answer;
- make it answer-first, self-contained, static, usable offline, and free of JavaScript or external
  requests;
- put deliberately linked companion files beside the report;
- keep ordinary source citations visible as `path:line` text unless the cited file is copied into
  the report folder;
- call `submit_scout_artifacts` with the report path, short summary, optional tags, and only the
  additional supporting files worth preserving;
- finish by naming the report path and never open a pull request merely for the scout report.

Use this helper in both fresh delivery and `TaskManager.assignReserved`. Compose it once with any
multi-repository manifest or repository-memory prefix so ordering is deterministic and the agent
still sees the original user request intact. Add a drift test against `skills/html-report/SKILL.md`
for the required path, self-contained static rule, answer-first structure, citations, final path,
and no short-scout exception.

Update the skill so its one-sentence no-HTML allowance applies only to non-scout work. The daemon
prompt remains authoritative when skills are globally disabled.

### 3. Register and attribute `submit_scout_artifacts`

Add a literal tool constant under `src/server/scouts/submission-tool.ts` and append it to
`MISSION_MCP_TOOLS`. Register the same name in `src/mcp/server.ts`. Keep the hand-written MCP schema
and `src/shared/protocol.ts` request schema aligned through the existing drift test.

The tool accepts only:

- required `reportPath` matching the checkout-relative
  `docs/reports/<slug>/report.html` convention;
- required bounded plain-text `summary`;
- optional bounded tags;
- optional bounded supporting items `{ repoSlot, path }`, where the slot was issued in the task's
  repository manifest and `path` is relative to that checkout.

It must not accept a task ID, session ID, work episode, producer ID, archive ID, destination,
absolute source, artifact digest, or completion status.

Add `POST /mcp/scouts/submit` behind the existing Mission MCP token guard. Resolve the calling
session from the environment token, then derive the current running scout, current work episode,
primary and attached worktrees, agent, model, repository labels, and commits. Refuse no task,
non-scout task, stale episode, unknown repository slot, absent source root, and already-terminal
incompatible states with safe actionable errors.

Fresh scout dispatch automatically merges `submit_scout_artifacts` into any existing
`MissionMcpRequirement` as a set and requires successful registration for terminal and SDK
runtimes. Ship tasks receive no scout requirement. For assignment to an existing session, perform a
capability check before reset and use the existing registered Mission MCP channel; do not silently
assign a scout that cannot submit its required output.

### 4. Capture the report and explicit artifacts

Add `src/server/scouts/capture.ts` or a focused set of mechanism modules invoked by
`ScoutArchiveManager`:

1. Reserve or load the idempotent job and generated final identity.
2. Resolve repository slots to server-derived realpaths. Verify the report and each explicit path
   is a nonignored regular file under the claimed source root, with no symlink at any component.
3. Require the primary path convention and capture the full containing report directory within the
   Phase 1 count and byte limits. Preserve relative companion layout under `report/`.
4. Copy explicit supporting files under generated `artifacts/<repo-slot>/...` roots, preserving
   their checkout-relative paths only after normalization and containment.
5. Open source files defensively, hash while copying, and re-stat before accepting. A file that
   changes, disappears, becomes a symlink, or crosses a limit fails the operation with every
   offending path named.
6. Validate the staged `report/report.html` through the Phase 1 nonexecuting HTML validator. Keep the
   exact original report bytes; do not rewrite links or inject metadata.
7. Assemble the version 1 manifest with generated IDs, submitted display metadata, server-derived
   provenance, artifact table, exact sizes and hashes, and canonical content digest. Exclude task,
   session, checkout, username, and absolute paths.
8. Write the pretty two-space LF manifest, re-read and verify the entire staging bundle with the
   same Phase 1 importer, then atomically rename to the final producer/archive directory.
9. Mark the capture job published, notify the reconciler, and optimistically replace derived index
   rows. Return ready as soon as the final bundle itself verifies, even if cache indexing must retry.

Mission Control never overwrites a final archive path. A replay returns the verified existing result
when the operation key and digest agree. A final-key conflict is an error and preserves both the
task sources and existing final evidence.

### 5. Make task completion an ordered async boundary

Inject `ScoutArchiveManager` into `TaskManager` from the daemon composition root. Preserve the null
or no-op construction used by focused tests that do not exercise scouts.

Refactor the owner-level completion operation to be awaitable. The order is:

1. validate current task state and reserve one in-flight completion per task;
2. for a scout, call `ensureReady(taskId)` and await a verified complete final bundle;
3. re-read the task after the await and refuse if a conflicting transition or episode change won;
4. perform the existing synchronous status, outcome, timestamps, broadcast, and optional dependency
   satisfaction exactly once;
5. for a ship, skip archive work and preserve existing observable order and results.

Update every direct caller and interface. The implementation-time inventory must include the HTTP
completion route, live merge settlement, periodic merge reconciliation, `agentWentAway`, task
assignment tests, dependency tests, reschedule conflict tests, and the Ensemble gateway and engine.
Event-emitter callbacks cannot leak rejected promises: enter async work with `void`, catch and log at
the owner boundary, and serialize repeated completion signals by task ID.

Do not add `/complete-scout`, write task status from the MCP route, or mark the task done before
capture verification. A missing submission, missing report, invalid HTML, changed file, or limit
error leaves the task nonterminal with its session and checkout intact and returns the exact
correction to the completion caller. The existing modal can display the refusal and retry.

Partial archives do not satisfy normal completion. A human can correct and resubmit while sources
exist; a new valid submission for the same active operation supersedes staging state before final
publication, never edits a published partial directory.

### 6. Reserve on exit and protect destructive cleanup

Register one `Registry.onSessionExit` listener in `ScoutArchiveManager`. While the Registry still has
the session and binding, synchronously reserve a capture job for an unarchived running scout and
persist only server-derived source locators. Queue background work and return immediately so
`beginEviction` keeps its current timing and emits the existing `session_remove` event.

Exit recovery follows a strict order:

- a previously submitted report path wins;
- otherwise scan only the current task's retained source roots for exactly one new conventional
  `docs/reports/*/report.html` candidate associated with the episode;
- capture one unambiguous valid report and its report-folder companions;
- if no report or more than one candidate can be attributed, publish an honest `partial` bundle with
  structured `missing` entries and no primary artifact;
- never use transcript text, assistant output, git diff enumeration, or an automatic model call.

`session_remove` continues to let `TaskManager.agentWentAway` settle an uncompleted task as failed
when there is no merged outcome. That task status is independent of the complete or partial archive.
Do not create a second eviction or agent-loss path.

Before `reclaim`, `remove`, `cancel`, startup cleanup, or an internal close-after-merge path destroys
a scout-owned source root, call a manager cleanup guard. It resumes a reserved job, publishes a
complete or partial final bundle, and verifies the final path. Transient I/O or validation failures
refuse cleanup and keep resources tracked. Reclaiming a normally completed scout always finds the
already-ready complete bundle and is cheap and idempotent.

Start capture-job recovery during daemon composition before any startup task cleanup can reclaim
sources. Stop accepting new jobs during shutdown but leave resumable rows and staging directories
intact.

### 7. Align product and operator documentation

Extend the Phase 1 scout archive reference and dispatch documentation with:

- the mandatory HTML report contract for `Task.kind === scout`;
- the exact default report path and explicit-supporting-file behavior;
- no conversation capture and no pull request requirement;
- completion, failure correction, unexpected-exit partial archives, and cleanup safety;
- local job rows as recovery coordination only, not portable evidence;
- the fact that archives remain available when tasks and sessions are removed.

Keep the HTML-report skill focused on authoring. Do not teach it archive destination paths or let it
claim that writing a report alone completes capture; the MCP submission and daemon verify that.

## Data, API, migration, and compatibility details

- **Database:** `scout_capture_jobs` is an additive all-new table. It may refer to local task and
  session identifiers as values but has no foreign key or cascade. Completed archive tables remain
  task-independent.
- **MCP:** one append-only tool name is added. Tool input is caller-minimal; environment attribution
  is server-owned. Schema drift tests cover the registry, bundled server, and daemon schema.
- **Task lifecycle:** completion becomes async at its existing owner. All callers await or safely
  schedule that one method. No route or worker writes `done` directly.
- **Ship compatibility:** ship intent bytes, MCP requirements, completion ordering, dependency
  satisfaction, merge settlement, and cleanup remain unchanged. Pin this with regression tests.
- **Assignment:** both delivery seams receive the appendix. Capability refusal happens before the
  existing destructive reset, so a backlog scout and idle agent remain unchanged on failure.
- **Filesystem:** staging and jobs can be local and mutable; final bundles follow Phase 1 immutability.
  Report and companion bytes are exact copies.
- **Recovery:** a partial archive is a portable terminal result with explicit missing evidence. It
  does not permit a normal `done` transition and never pretends that a conversation is a report.

## Tests and verification

Add focused `node:test` coverage for:

- prompt appendix delivery through fresh terminal dispatch, fresh SDK dispatch, and assignment;
- global HTML-report skill disabled, short scouts still requiring HTML, and prompt-skill drift;
- required Mission MCP registration for both runtimes, union with an existing requirement, ship
  omission, assignment capability refusal before reset, and bundled registry drift;
- MCP attribution, non-scout and stale-episode refusal, unknown repo slots, schema bounds,
  idempotent replay, and absence of caller-controlled destination or identity;
- primary report and full report-folder copying, explicit supporting files, multi-repository slots,
  ignore rules, symlink and traversal refusal, changing files, limits, exact bytes, digests, and
  atomic publish boundaries;
- capture-job restart recovery from each status and staging boundary, lost-response replay, and final
  path conflict handling;
- complete scouts waiting for ready bundles, capture refusal leaving status and resources unchanged,
  duplicate completion serialization, and ship completion remaining behavior-compatible;
- every converted completion caller, including merge reconciliation, dependencies, reschedule, and
  Ensemble superseded-task settlement;
- exit reservation before `session_remove`, submitted-path preference, exactly-one conventional
  recovery, ambiguous and missing report partials, and no transcript fallback;
- reclaim, remove, cancel, close-after-merge, and startup cleanup waiting for final capture, including
  transient failure preserving tracked resources.

Start `e2e/specs/scout-archive.spec.ts` against the built dashboard and fake agents. Extend the fake
agent fixture with a deterministic scout scenario that writes a static report and invokes the real
Mission MCP submission path without a model call. Prove:

1. a dispatched scout receives and follows the report requirement with the global skill disabled;
2. no pull request is needed;
3. the complete action remains pending until the fake submission publishes a verified final bundle;
4. invalid or absent report submission leaves the task and checkout available for correction;
5. after success, stopping and reclaiming the task do not remove the archive from the Phase 1 API.

Do not use `data-testid`, real agent binaries, real API credentials, or model tokens.

Relevant commands:

```sh
node --test --import tsx test/scout-capture.test.ts
node --test --import tsx test/scout-lifecycle.test.ts
node --test --import tsx test/mission-mcp.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/scout-archive.spec.ts
```

## Merge and exit criteria

- Every newly delivered scout gets the mandatory static HTML appendix through either delivery path.
- Fresh scout launches require the submission tool, and the daemon derives all durable identity and
  destination data from the authenticated session and task episode.
- Normal scout completion publishes and verifies one complete final bundle before setting `done`.
  Index failure never loses the bundle; capture failure never loses the task sources.
- Unexpected exit publishes a complete recovery when one report is unambiguous or an honest partial
  bundle otherwise, without copying conversation data.
- Every destructive task cleanup path settles the capture job first. A failure leaves resources
  tracked and retryable.
- Ship tasks and Ensemble behavior remain compatible, and all converted async callers are covered.
- Focused tests, required Playwright behavior, and repository gates are green.

## Downstream handoff

Phase 3 may rely on every delivered scout having a complete archive before normal completion, on
partial archives accurately naming missing evidence, and on `scout_archive_changed` firing after
local publication or foreign reconciliation. It consumes only Phase 1 HTTP routes and shared types;
it does not read capture-job rows or join tasks to archives.

Later work must not make the browser responsible for capture, accept caller-selected archive
identity, archive conversation text, rewrite report bytes, mark a scout done from an MCP route, or
weaken cleanup gating. The report contract and MCP tool name are durable agent-facing behavior.

## Cross-phase audit record

- 2026-08-12: initial draft uses the Phase 1 importer as the final staging verifier, avoiding separate
  rules for locally produced and externally copied bundles.
- 2026-08-12: the source plan and Phase 1 were re-read before drafting. Capture jobs remain here and
  completed evidence remains free of task and session foreign keys.
- 2026-08-12: repository tracing added `TaskManager.assignReserved` to C6. Assignment performs the
  MCP capability refusal before reset and receives the same prompt appendix as fresh dispatch.
- 2026-08-12: async completion is an owner-level refactor, including the Ensemble gateway and
  reentrant merge listeners. No scout-specific route writes task status.
- 2026-08-12: destructive cleanup includes cancel and startup recovery, not only the visible reclaim
  button. This closes the path where an unexpected exit could reserve a job and immediately lose its
  source tree.
