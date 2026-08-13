# Phase 4: Plan capture

Source plan: [`plan.md`](./plan.md), rendered at [`plan.html`](./plan.html).
Index: [`phased-plan.md`](./phased-plan.md).

## 1. Outcome and value

A plan outlives the checkout it was written in. When a plan task's worktree is about to be
reclaimed, Mission Control captures the plan artifacts that task produced into the archive
library as a `kind: "plan"` bundle, alongside the scout bundles the same library already holds.

This closes the approved durability decision. A human who reads a plan, decides to stop rather
than phase it, and later reclaims the worktree still has the plan - as ordinary files on their
machine, readable in a file manager, indexed for search, and outliving the task card.

## 2. Entry criteria and direct phase dependencies

**Direct dependencies: Phase 1 and Phase 3.** This is the only point where the two lines of work
meet. It needs the kind-discriminated bundle format and kind-agnostic mechanics (C-A1 to C-A4)
and it needs the guarantee that a plan task was dispatched with the planning skills invocable, so
its artifacts follow the skill's layout (C-P3).

## 3. Scope and explicit non-goals

In scope:

- A plan kind adapter deciding which checkout paths become a plan bundle.
- Capture wired into the existing settle-before-cleanup and reserve-on-exit paths.
- Search segments derived from the plan itself.
- Documentation and tests.

Explicit non-goals:

- **No completion gate.** The approved decision is Foreman's ordinary boundary. Nothing here
  makes a plan task's `done` wait on an archive, which is the deliberate difference from scout.
- **No agent-facing submission tool.** A plan is captured from its checkout by the daemon. There
  is no plan equivalent of `submit_scout_artifacts`, no submission credential, and no MCP surface.
- **No Archives reading UI.** Still deferred.
- **No capture of a plan produced by a ship task.** Capture is keyed on the durable kind. A ship
  task that happens to write a plan is not a plan task and is not archived.

## 4. Repository findings and inherited contracts

Verified against the planning checkout. Re-check before editing.

**Where capture must sit.** `settleScoutArchive` (`src/server/tasks.ts:2202-2228`) is called
immediately before `teardownWorktree` on **five** paths - `:2261` (cancel), `:2630`, `:2699`,
`:2749`, `:2856` (reclaim, remove, close-after-merge, startup reconciliation). Its comment states
the rule: "the last moment at which the evidence can be saved is right here, before the teardown,
on every one of those paths rather than on the visible Reclaim button alone." A plan must reach
all five, which means generalizing that one private method rather than adding a call.

**Reserve-on-exit is synchronous up to the durable row and asynchronous after it.**
`reserveOnExit` (`src/server/scouts/manager.ts:366-404`, wired at `src/server/index.ts:123`) runs
inline inside `beginEviction` because it "needs the session, the task binding and the worktree
paths… while they can still be derived", and defers the capture itself. A plan reservation must
keep that split, and must not throw into eviction.

**A refusal aborts teardown, and that is right only when there was something to save.** Scout's
settle returns a refusal that stops the caller, keeping resources tracked so an operator can
retry. For a plan this is correct when artifacts exist and capture fails, and **wrong when no
artifacts exist at all** - a plan task whose agent stopped before writing anything would wedge its
worktree permanently. The scout path never faces this because a scout cannot complete without an
archive; a plan can complete with nothing, by design.

**Finding the right plan directory is the hard part.** A scout's primary artifact is at one known
convention, `docs/reports/<slug>/report.html`. A plan's is at `docs/plans/<name>/plan.html` where
`<name>` is chosen by the agent, and a repository routinely holds many plan directories that have
nothing to do with this task - this repository holds 76. Capturing "every plan directory in the
checkout" would archive other people's work on every plan task.

The task's own diff is the answer, and it is already available: `changedPaths(diff.patch)`
(`src/server/inspector/diff-lines.ts:79-81`) returns repo-relative new-side paths and is what
Foreman already uses at `worker.ts:1077` and `:1273`. It is server-derived, cannot be spoofed by
the agent, and names exactly the plan directories this task touched. Its one caveat is already
handled in the existing callers: a truncated patch yields `null`, never a partial list.

**Plan artifacts are committed; scout reports are not.** The plan skills write into
`docs/plans/<name>/` and `phased-plan` commits and pushes before scheduling. This is why the diff
is a sound source, and it is the opposite of the scout case, where the report is an ordinary
untracked file.

**The HTML the validator will see.** `html-plans` mandates a self-contained `plan.html` with
inline CSS and `data:` URIs, which is the same contract the archive validator enforces, with one
exception that Phase 1 resolved: real plan pages carry external documentation links, and C-A5
permits them in navigational slots.

## 5. Implementation steps, in execution order

1. **Write the plan kind adapter.** Given a task and its changed paths, select the distinct
   `docs/plans/<name>/` directories the task touched. For each, the primary artifact is
   `plan.html`; every other file in that directory is a companion, which maps onto the bundle's
   existing primary-plus-companions shape. `phased-plan.html`, `phased-plan.md` and the
   `phase-*.md` files are companions of the plan they sit beside, not separate bundles.
2. **Decide the multiple-plan-directories case explicitly.** A plan task normally touches one.
   Capture each touched directory as its own bundle rather than merging them, because a bundle
   has exactly one primary artifact and merging would make one plan's page the primary for
   another's files.
3. **Derive the search segments from the plan.** A plan has no submission and therefore no
   agent-supplied summary or tags. Take the title from the plan's own heading and the body text
   through the existing `extractVisibleText`, which already bounds what an untrusted document may
   contribute to the index.
4. **Generalize the settle path.** Rename `settleScoutArchive` to a kind-neutral method and have
   it dispatch on the durable kind, so all five teardown call sites keep working unchanged.
5. **Get the refusal semantics right.** For a plan: no artifacts found means success and teardown
   proceeds. Artifacts found but capture failed means refusal, exactly as for a scout. Write this
   as the explicit rule it is, with the reason recorded, because the naive generalization - reuse
   scout's refusal unchanged - wedges the worktree of every plan task that produced nothing.
6. **Generalize reserve-on-exit** to reserve for a plan task on the same terms, preserving the
   synchronous-reservation and asynchronous-capture split and the existing swallow-and-log
   behaviour that keeps eviction safe.
7. **Handle the truncated-diff case.** If changed paths are unavailable, fall back to scanning the
   checkout for plan directories **only** if that can be done without archiving unrelated plans -
   otherwise record the capture as unavailable and let teardown proceed. Do not guess. An archive
   holding somebody else's plan is worse than a missing archive.
8. **Document it.** The archives page from Phase 1 gains the plan bundle's shape.
   `docs/dispatch-and-backlog.md` gains what happens to a plan's artifacts at reclaim.

## 6. Data, API, and compatibility

- **No schema change.** Phase 1's `kind` column and the append-only kind vocabulary already carry
  `plan`. This phase is the first writer of that value.
- **No new persisted vocabulary.** Plan bundles reuse the existing artifact roles and segment
  kinds. If a new role or segment kind is genuinely required, it is appended to the append-only
  vocabulary and never inserted or reordered.
- **No migration.**
- **Forward compatibility.** A plan bundle read by a build that predates Phase 1 is not
  discovered, which is the downgrade property Phase 1 documented.

## 7. Tests and verification

- A capture test proving a plan task's bundle contains exactly the plan directory it touched, and
  that an unrelated `docs/plans/*` directory present in the same checkout is **not** archived.
  This is the central correctness claim of the phase.
- A test proving each of the five teardown paths captures, mirroring how the scout paths are
  covered.
- A test proving a plan task with no artifacts tears down cleanly and does not wedge, and a test
  proving a plan task whose capture fails **does** refuse teardown.
- A test proving a truncated diff never produces a bundle containing an unrelated plan.
- A test proving a plan task's completion does **not** wait on the archive, which is the approved
  difference from scout and the thing a reviewer familiar with the scout path will assume was
  copied.
- A validator test proving a realistic `plan.html` carrying external documentation links is
  accepted, exercising C-A5 end to end.
- A test proving a ship task that writes a plan directory is not archived.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`.
- No Playwright spec: this phase adds no UI surface, and the reading UI remains deferred. Stated
  explicitly so the omission is not read as skipping the project's e2e requirement.

## 8. Merge and exit criteria

- A plan task's artifacts are archived before its worktree is reclaimed, on every teardown path.
- An unrelated plan directory in the same checkout is never archived.
- A plan task that produced nothing tears down cleanly.
- A plan task's completion is not gated on the archive.
- Scout capture behaviour is unchanged.

## 9. Downstream handoff

The deferred Archives reading UI may rely on:

- **C-C1**: Bundles of both kinds are discoverable through one list query with a `kind` filter,
  and a plan bundle's primary artifact is its `plan.html`.
- **C-C2**: A plan bundle's companions preserve their relative paths, so the plan page's own links
  to a phase document still resolve inside the archive.
- **C-C3**: Plan segments are derived from the document, so search works with no agent-supplied
  metadata.

## 10. Cross-phase audit record

- **Against Phase 1:** consumes C-A1 to C-A5. Confirmed that Phase 1 introduces `plan` into the
  append-only kind vocabulary while leaving it unreachable from the write path, so this phase adds
  a writer and not a format decision. No Phase 1 contract needed amending.
- **Against Phase 3:** consumes C-P3. Confirmed that Phase 3 leaves capture entirely alone, so
  there is no half-built capture path for this phase to finish.
- **Against Phase 2:** reached only through the kind value itself (C-K1).
- **Reconciliation applied while writing this file:** the initial route derived the plan directory
  from a path the agent names in its final message, mirroring the scout appendix's "finish by
  naming the report path". That was rejected on two grounds discovered here - it is spoofable
  where the diff is not, and it would have required Phase 3's appendix to carry a reporting rule
  that the approved "point at the skills" decision says the appendix should not carry. Phase 3's
  appendix therefore does **not** need amending, which was checked rather than assumed.
- **Reconciliation applied to Phase 1:** none required. C-A4 already states that what a kind
  contributes is "which checkout paths become the primary artifact, and what the search segments
  are cut from", which is exactly the seam this phase fills. Recorded as a confirmation because
  the audit is only meaningful if the negative result is written down too.
- **Deferred decision surfaced here:** the truncated-diff fallback in step 7 is deliberately
  conservative and may in practice mean a large plan task is not archived. That is the correct
  trade against archiving an unrelated plan, but it is a real gap and belongs in the pull request
  description rather than being discovered later.
