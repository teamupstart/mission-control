# Phase 1 - Evidence-grounded verification and the auto-submit fallback

## Outcome

Foreman's prompted completion verifier stops holding finished ship-task work for proof it
structurally cannot see. A completion whose registered evidence covers the required
verification is claimed into its bound workflow on the first verify; and when the verifier
still holds solely for missing verification proof, the worker claims the bound workflow
anyway (adopted decision, 2026-08-24), because the No-Mistakes workflow runs the real test
suite itself.

Engineering value: this removes the false-hold class that produced the incident in
`docs/plans/foreman-completion-judgment/plan.md` (4 completions, 4 holds, 0 workflow runs)
and, fleet-wide, 15 of 31 decided sessions sitting on `held`.

## Entry criteria and dependencies

- No phase prerequisites; this is the first phase.
- The planning artifacts must be on the default branch (the scheduling gate handles this).

## Scope and non-goals

In scope: the Foreman client evidence read, the verify prompt's evidence sections and
policy text, the additive gap kind, the structural evidence-registration statement, and the
worker's fallback claim branch. All on the prompted path.

Non-goals: no change to the queue-item (drain) verify semantics beyond the shared schema
gaining one additive kind value; no change to when gap feedback is delivered (Phase 2); no
change to recovery accounting or persisted decision shapes (Phase 3); no UI change.

## Repository findings this phase builds on

- `GET /api/sessions/:id/workflow-evidence` (`src/server/routes.ts:1973`) returns
  `WorkflowStagedEvidenceList` (`src/shared/workflow.ts:291`) for any live session's note
  key via `stagedEvidenceForSession` (`src/server/workflows/manager.ts:1355`). It requires
  a live, non-exited session - not a binding - so it works for Straight-to-PR tasks too.
  A 404 means the session is gone or exited.
- The Foreman worker reads everything over the daemon HTTP client
  (`src/server/foreman/client.ts`); it must never touch SQLite.
- The prompted verify call site is `src/server/foreman/worker.ts:1991-2022`
  (`verifyItem` with `completionContract`), fed by the evidence gather at
  `worker.ts:1897-1915` (diff + transcript anchor) and `worker.ts:1980` (48-turn
  transcript window). Evidence-gather failures return without consuming the generation
  (`worker.ts:1891-1895` documents the discipline) - the new evidence read must follow it.
- The verify prompt builder is `buildVerifyPrompt` (`src/server/foreman/queue-prompt.ts:144`),
  with trusted policy above the `EVIDENCE_START` fence and untrusted material inside it.
  The transcript renderer emits tool inputs only (`src/server/foreman/prompt.ts:604-628`),
  which is why test output can never appear in the transcript evidence.
- `GapSchema.kind` (`src/server/foreman/queue-verify.ts:113-122`) is
  `incomplete | untested | standards | regression`. The dashboard renders a gap's kind as
  free text (`src/web/components/WorkQueue.tsx:805`), so an additive value is display-safe.
- The claim seam is `promptedCompletionClaim` (`src/server/foreman/workflow-claim.ts:45`)
  through `tryWorkflowCompletionClaim` to the daemon's `claimCompletion`
  (`src/server/workflows/manager.ts:3023`), which answers `claimed`, `manual_trigger`
  (binding exists but is not `foreman_complete`), or `no_binding`. The worker's outcome
  handling is `worker.ts:2058-2116`.
- The ship completion contract is `src/shared/task-completion.ts` (`SHIP_CONTRACT`); its
  clauses "the focused tests and verification the change requires have been run" and
  "evidence registration the task asked for is done" are the two this phase grounds.

## Implementation steps

1. **Client read** (`src/server/foreman/client.ts`): add
   `workflowEvidence(id: string): Promise<WorkflowStagedEvidenceList | null>` against the
   existing route. Map 404 to `null` (session gone or exited); throw on other failures so
   the worker can treat them as an evidence-gather failure.

2. **Verify input** (`src/server/foreman/queue-prompt.ts`): extend `VerifyInput` with
   `registeredEvidence?: { items: RegisteredEvidenceItem[]; truncated: boolean } | null`
   where each item carries display name, evidence kind, source locator (the command line
   for command evidence), work generation, created-at, byte size, and the child-authored
   caption. Add `evidenceRegistrationSatisfied?: boolean | null` - the structural fact,
   `null` when the session has no ship contract.

3. **Prompt rendering** (`buildVerifyPrompt`):
   - Above the fence, beside the completion-contract block: a trusted statement of the
     structural fact - either "N evidence items are registered for this work (server
     metadata below); the contract clause 'evidence registration is done' is satisfied
     structurally - do not raise a gap about evidence registration" or the explicit
     opposite. Render the server-derived metadata table (names, kinds, generations,
     timestamps, sizes) here; none of it is child-authored.
   - Inside the untrusted fence, after the transcript: a "Registered evidence contents"
     section carrying each item's source locator and caption, per-item capped (600 chars)
     and section capped (12 kB), with a truncation header like the diff's.
   - POLICY additions: define the new gap kind `unverified` as "the requested change
     itself appears done; the only deficiency is missing or unconfirmable proof that
     verification ran". Instruct: when registered command evidence covers the verification
     the change requires, the absence of test output in the transcript is NOT a gap;
     prior-generation registered evidence remains valid for a re-submission (the operator
     may explicitly tell agents not to rerun the full suite on re-submission); when the
     only thing standing between this verdict and complete is verification proof, answer
     `complete: true` with a blocking gap of kind `unverified` rather than
     `complete: false`.

4. **Schema** (`src/server/foreman/queue-verify.ts`): add `"unverified"` to
   `GapSchema.kind`. Additive only; nothing renames or reorders existing values.

5. **Worker** (`src/server/foreman/worker.ts`, prompted path):
   - Fetch evidence in the same `Promise.all` as the diff and transcript anchor; on read
     failure, log and return `false` without consuming (same as a failed diff read).
   - Compute `evidenceRegistrationSatisfied` from the item list when the session's task
     kind is `ship`; pass both new fields into `verifyItem`.
   - After the verdict and the existing `refreshPromptedCandidate` re-check
     (`worker.ts:2055`): if the verdict is claimable as today (`complete` and no blocking
     gaps), behavior is unchanged. New branch: if `complete === true` and every blocking
     gap has kind `unverified`, build the claim with a summary prefixed
     `verification-evidence fallback:` plus the verifier's summary, and submit it through
     `tryWorkflowCompletionClaim`. Outcome handling mirrors the existing branch:
     `claimed` starts the run; `manual_trigger` consumes as `asked` (Ship it? card);
     `no_binding` falls through to today's hold; `failed` holds without consuming.
     `complete === false` always holds, whatever the gap kinds - "implementation not
     done" verdicts keep today's behavior.

6. **Documentation**: update the Foreman section of the docs that describe completion
   verification (locate via the docs index; `docs/agent-guides/architecture.md` links the
   subsystem pages) to describe the evidence input and the fallback, in the same change.

## Data, API, and compatibility

- No persisted-shape changes. The fallback decision is made at verdict time on the live
  `QueueVerdict`; the persisted `PromptedCompletionGap` (id, path, detail) is unchanged in
  this phase (Phase 3 extends it).
- The wire schema for the verdict gains one additive enum value; old recorded decisions
  parse unchanged.
- The evidence read adds one daemon round-trip per prompted verify (a handful per hour,
  fleet-wide) - no caching needed.

## Tests and verification

Extend the existing suites rather than creating parallel ones:

- `test/queue-verify.test.ts`: `unverified` parses; existing kinds unchanged.
- Prompt-builder coverage (beside the existing verify-prompt tests): metadata renders
  above the fence, captions inside it, caps and truncation headers, structural statement
  in both directions, POLICY lines present.
- `test/prompted-wrapup-worker-e2e.test.ts`: with staged evidence, the structural clause
  is stated and a clean verdict claims; a verdict with only `unverified` blocking gaps
  claims with the fallback-prefixed summary; a verdict with any other blocking gap holds;
  `complete: false` holds; `no_binding` falls through to hold; an evidence read failure
  neither consumes nor claims.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/queue-verify.test.ts test/prompted-wrapup.test.ts test/prompted-wrapup-worker-e2e.test.ts
npm run typecheck
npm run lint
npm test
```

## Merge and exit criteria

- All verification above passes; the pull request is reviewable and merged.
- The repository is fully operable with only this phase: evidence-grounded verdicts and
  the fallback work end to end; recovery timing and accounting behave exactly as before.

## Downstream handoff

Later phases may rely on: `client.workflowEvidence`, the `VerifyInput.registeredEvidence`
and `evidenceRegistrationSatisfied` fields and their fence placement (contract C1), and
the `unverified` gap kind's meaning (contract C2). They must not move evidence content
across the trust fence or redefine the kind.

## Cross-phase audit record

- 2026-08-24: written first; owns C1 and C2. The gap-kind definition was placed here
  rather than in Phase 3 (which persists it) so the prompt and the fallback share one
  definition from the start.
