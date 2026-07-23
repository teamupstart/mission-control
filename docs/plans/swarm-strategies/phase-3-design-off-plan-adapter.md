# Phase 3 - `design_off` and the `plan` ArtifactAdapter

## Outcome and value

Design-offs: members produce **design documents, not implementations**, so comparison
happens where candidates are cheap and exactly one build follows. This phase adds the
second ArtifactAdapter (`plan`) and the `design_off` strategy on top of it: replicated
launch (default 4, max 8 - the roster cap is per-strategy policy, and cheap members earn
the larger N), isolated members, comparative evaluation over documents, human decision,
and a finalization whose `restore` materializes the winning plan as one normal build
Task. Value: the best value-to-cost strategy in the set, and the proof that the adapter
seam carries a non-Git artifact kind end to end.

## Entry criteria and direct dependencies

- Engine plan Phase 8 merged (task `915fea1a-0479-4d47-a4bd-d5ee3eebbfd5`).
- This planning session's PR merged.

## Scope

- **`plan` artifact kind** (append-only) and its ArtifactAdapter in
  `src/server/ensembles/artifacts/`:
  - `capture`: the member's prompt appendix names one conventional document path
    (`DESIGN.md` in the worktree root); capture reads it, enforces a byte cap with an
    honest truncation flag, fingerprints the content, and stores a bounded content
    locator (the engine plan's report-artifact shape) - no Git snapshot required for this
    kind.
  - `summarize` / `materializeForEvaluation`: title/first-heading summary; the bounded
    document as evaluation material.
  - `restore`: creates one normal build Task whose intent embeds the original ensemble
    intent plus the winning document verbatim, returning the Task for
    `materializedTaskId`. Idempotent under the finalization's persist-before-act rules.
  - Versioned locator union member with its own Zod validation; kind and format version
    are append-only.
- **`design_off` strategy**: append the id; descriptor (replicated launch template,
  count 2-8 with concurrency cap, approach hints, optional guidance Persona); compiled
  plan spawn -> collect-all -> evaluate (comparative, reusing the kernel evaluator over
  plan materials with a document-oriented rubric emphasis) -> decision -> finalize
  (select-one, `restore` the winner, keep all document artifacts - reap only worktrees).
- Member prompt appendix for plan members: write the design to the conventional path, do
  not implement, do not push or open a PR, submit when the document is ready.
- Detail renderer: document cards with summaries and on-demand full content (HTTP detail
  route that already materializes artifact evidence), the recommendation, and a
  "build this design" confirmation that is the finalization; Dispatch preset card;
  README.

## Non-goals

Panel or divergence evaluation over plans (compositions for later; keep this phase's
evaluator the kernel's comparative call); transcript/scout artifacts; rendering documents
as HTML (plain text/markdown source display only, injected content stays inert);
auto-starting the build Task's session beyond normal Task backlog semantics.

## Repository findings and inherited contracts

No kernel exists at planning time; the adapter interface, artifact tables, and
finalization transaction arrive with the engine tasks - re-verify names against merged
code. Inherited: artifact attempts immutable; submission attribution is session-derived;
evaluator input is fenced and capped; `materializedTaskId` and adapter `restore` are the
kernel's designed seams for exactly this phase; full documents never ride SSE.

## Implementation steps

1. `src/shared/ensemble.ts`: append artifact kind `plan` and strategy id `design_off`;
   shared locator/summary types; descriptor with launch estimate (documents are cheap -
   surface the 2-8 range honestly).
2. `src/server/ensembles/artifacts/plan.ts`: the adapter, with capture/restore tests
   (missing file, oversize file, byte-identical resubmission returns the prior artifact).
3. `src/server/ensembles/strategies/design-off.ts`: compiler + prompt appendix wiring.
4. Evaluator input assembly: document material path (no diffs), same anonymization.
5. Renderer, preset card, README.
6. Tests: adapter unit tests; compiler bounds (1 and 9 rejected, 2-8 accepted); scenario
   from fake members to a restored build Task; renderer markup test proving injected
   markup in a document renders as text.

## Data / API / migration

No new tables or routes: the artifact row's kind/locator carry the document within the
existing schema, and on-demand materialization uses the existing artifact evidence
endpoint. If the merged kernel's locator storage turns out to cap content below a useful
document size, store the body in the private refs namespace the kernel already owns and
record that decision here - do not add a table.

## Verification

Focused tests, then `npm run typecheck && npm test && npm run build`. In the app: run a
4-member design-off, read two documents in the detail, confirm the winner, and verify the
build Task exists with the document embedded and every document artifact still
restorable.

## Merge / exit criteria

A design-off run completes select-one with a materialized build Task; worktrees are
reaped, all document artifacts retained; the roster cap 8 is enforced; no engine branch
tests the id.

## Downstream handoff

Later phases and follow-ups may rely on: the `plan` kind and its locator contract, the
conventional document path, and `restore`-to-build-Task semantics. They must not narrow
the byte cap silently or make `restore` non-idempotent. A future composition may swap
this strategy's evaluator for Phase 1's panel or Phase 2's divergence mining without
touching the adapter.

## Cross-phase audit record

- 2026-07-23: created; independent of Phases 1, 2, 4. Deliberately uses the kernel's
  comparative evaluator rather than depending on Phase 1 or 2, so all four phases stay
  concurrent.
