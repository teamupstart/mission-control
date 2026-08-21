# Phase 1: Durable detached-review delivery

## Outcome and value

Deliver a human review answer to its owning Mission Control session even when the MCP host has already canceled the original blocking tool call. Preserve the blocking result as the fast path, then use the durable pending-turn outbox exactly once when that result path is gone.

## Entry criteria and dependencies

- Direct dependency: the planning session that publishes `plan.md`, `phased-plan.md`, and this phase document.
- The three plan paths resolve on the default branch before implementation begins.
- The phase agent reads the source plan and phased-plan index before inspecting or changing code.
- There are no phase-task prerequisites and no other repositories.

The planning checkout already contains a candidate implementation. Begin from the default branch delivered to the phase task. If some or all candidate work arrived through the prerequisite merge, treat it as inherited implementation: verify it against this outcome, preserve conforming contracts, and change only real gaps. Do not manufacture a duplicate API, migration, or delivery path.

## Scope

- Persist that an MCP wait detached and that its continuation was queued.
- Authenticate and session-bind the MCP-to-daemon detach handoff.
- Notify the daemon when the MCP blocking wait ends without a result.
- Share semantic review-result formatting between the MCP fast path and fallback continuation.
- Atomically enqueue a detached, human-resolved review through the pending-turn outbox.
- Recover unfinished handoffs after daemon restart and retry when the owning session becomes deliverable.
- Cover race ordering, idempotence, migration compatibility, session isolation, duplicate-ask behavior, and the browser-visible result.
- Keep operator documentation accurate about long-poll and host timeout behavior.

## Non-goals

- Do not remove or shorten blocking MCP reviews.
- Do not add a Mission Control-wide 30-minute timeout.
- Do not make host timeout configuration the primary correctness mechanism.
- Do not infer that an identical future question is always a retry.
- Do not add another terminal or SDK delivery writer.
- Do not redesign review controls or unrelated dashboard layout.

## Repository findings and inherited contracts

- `src/server/routes.ts` owns the 30-second daemon long-poll slice and authenticated MCP HTTP routes.
- `src/server/db.ts` owns fresh schema and in-place migrations. New review columns must be added in both paths and remain nullable for older rows.
- `src/server/reviews.ts` owns review lifecycle and is the correct place to reconcile resolved detached reviews.
- `src/server/pending-turns.ts` already owns durable, safe later-turn delivery to terminal and SDK sessions.
- `src/mcp/server.ts` owns the blocking request and has the request-cancellation signal needed to mark the durable handoff.
- `src/shared/review-item.ts` is browser-safe and can own a shared semantic result formatter.
- Existing review deduplication reattaches only pending identical asks and must not be broadened into answered-review replay.
- Database tests must use `--import ./test/setup-state.mjs`; browser coverage belongs in `e2e/` and must use accessible selectors without `data-testid`.

## Implementation steps

1. Inspect the default branch for an existing conforming candidate. Map each approved behavior to the owning modules above and identify only missing or incompatible pieces.
2. Extend the shared detach request contract with environment, optional session id, and optional working directory fields used by the daemon's existing session resolver.
3. Add nullable review detachment and continuation-queued timestamps to the fresh schema and migration path. Add database helpers that select eligible continuations and atomically insert a deterministic pending-turn record while stamping the review in one transaction.
4. Centralize review-result formatting so text input, plan decisions, diff approval or requested changes, dismissal, and orphan errors produce the same MCP and fallback semantics.
5. Add an authenticated MCP detach route. Resolve the caller to a session through existing environment/session/cwd rules and refuse a review owned by another session.
6. On any MCP wait-ending error, make a short best-effort detach request with a fresh cancellation budget rather than the already-canceled request signal. Preserve the original cancellation or transport error returned to the MCP host.
7. Extend the review manager to persist detachment, close the answer-before-detach race, reconcile restored pending reviews, and retry resolved continuations when their owning session becomes deliverable.
8. Extend the pending-turn manager through its existing delivery policy. Enqueue the review continuation atomically and idempotently; never type directly into a terminal or SDK session from review code.
9. Wire continuation recovery after pending-turn startup. Update operator documentation and source comments so 30-second long polls are not described as a permanent lease.
10. Add focused unit, migration, HTTP, MCP source/bundle, and Playwright coverage. Preserve duplicate-ask behavior and prove the continuation lands on the owning session while it is busy.

## Data, API, migration, and compatibility

- Review columns are nullable timestamps. Existing databases gain them with idempotent `addColumn` migrations; fresh databases create them directly.
- A review becomes continuation-eligible only when it is human-resolved, marked detached, and not stamped as queued.
- The pending-turn insert and queued stamp happen under one SQLite transaction. A deterministic review-based turn identity prevents duplicate delivery after retries or restart.
- The detach endpoint uses existing token authentication. Session ownership is checked after canonical session resolution, so a different session cannot detach or receive the review.
- Restored pending reviews are treated as detached because their former MCP stdio request cannot survive daemon restart.
- A failed or temporarily impossible delivery stays eligible for retry. Successful delivery clears retry bookkeeping only when no eligible continuation remains for that session.
- Existing pending reviews, blocking returns, dismissals, diff responses, and duplicate pending asks retain their wire behavior.

## Tests and verification

Run the focused contract suite:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/review-continuation.test.ts test/review-mcp-orphan.test.ts test/review-duplicate-ask.test.ts test/plan-decisions-http.test.ts
```

Run static and bundle gates:

```sh
npm run typecheck
npm run lint
npm run build
npm run smoke
```

Run the focused browser spec after the build:

```sh
npm run test:e2e -- e2e/specs/review-duplicate-ask.spec.ts --workers=1
```

The focused tests must prove pre-feature schema migration, answer-before-detach and detach-before-answer ordering, idempotent enqueue, restart recovery, authentication, cross-session refusal, result parity, and unchanged duplicate pending asks. The browser spec must show the original session working, the review answered after detachment, and the formatted continuation queued or delivered to that same session.

## Merge and exit criteria

- The approved outcome works for both terminal and SDK sessions through the existing pending-turn manager.
- No second delivery writer, schema source of truth, or review-result translator is introduced.
- Fresh and pre-feature databases open safely.
- Detach and enqueue are session-bound, atomic where required, idempotent, and restart-safe.
- Focused tests, typecheck, lint, build, smoke, and focused Playwright pass.
- Operator documentation matches the implemented timeout and recovery behavior.
- The phase is delivered as one reviewable pull request. If inherited work already satisfies part of the phase, the pull request contains only necessary completion or correction work and records why no duplicate implementation was added.

## Downstream handoff

There are no later implementation phases. Once this phase merges, future work may rely on durable detach timestamps, the shared review-result formatter, the authenticated detach route, and pending-turn continuation delivery as the single supported fallback. Later changes must not bypass session ownership, split the atomic enqueue/stamp transaction, or create another direct session writer.

## Cross-phase audit record

- Phase-count audit: one phase is intentional because every contract participates in one race-sensitive vertical slice.
- Source-plan audit: this phase owns every approved behavior and leaves both rejected primary alternatives out of scope.
- Compatibility audit: fresh schema, migration, fast-path response, fallback response, restart behavior, and duplicate-ask semantics are covered in the same merge unit.
- Existing-work audit: candidate code in the planning checkout is treated as inherited only if it reaches the task's default branch and passes the phase's conformance checks.
- Final dependency audit: this phase depends only on the planning-session publication gate and leaves the repository operable without a later cleanup phase.
