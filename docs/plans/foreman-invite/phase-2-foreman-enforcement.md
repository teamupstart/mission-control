# Phase 2: Foreman enforcement

## 1. Outcome

The Foreman worker stops tracking, triaging, wrapping up, PR-following, and
backlog-assigning into any session whose `foremanInvite` is `null`, and the daemon
independently refuses Foreman-marked writes into such sessions. This is the phase that
ends the user-facing pain: Foreman no longer types "create a PR" into personal Claude
chats. An operator invite grants triage, wrapup, and PR follow-through; backlog
assignment stays reserved for `"sdk"` and `"dispatch"` sessions (approved decision 2).

## 2. Entry criteria and dependencies

- Direct prerequisite: **Phase 1** merged (`Session.foremanInvite` resolved by the
  registry, dispatcher auto-invite live, invite routes live - contracts C1-C5 in
  `phase-1-invite-foundation.md`).

## 3. Scope and non-goals

In scope: the worker-side selection gates, the daemon-side write backstops, the test
churn that follows (tests exercising gated paths now declare their invite), and the
README behavior update.

Non-goals:

- No UI: no `ForemanSendBlock` reason, no rail button, no drawer change - phase 3.
  Interim state after this merge: an uninvited session's work-queue tab does not yet
  explain the silence; the API-only invite (`POST .../foreman-invite`) exists. This is
  operable and short-lived; phase 3 closes it and should merge promptly after.
- No change to `foremanAutomationAuthorized` (`src/server/harness/index.ts:329`) or
  `workQueueBlockedReason` (`src/shared/harness-capabilities.ts:711`) - see finding
  below; `test/queue-apply-sdk.test.ts:193-220` pins them in agreement and the invite
  is deliberately not part of that capability mirror.
- No change to `foremanMayActLive` / `applyVerdict` (`verdict.ts:743`, `:543`) -
  neither receives a `Session`; the selection sites are the policy seam.
- No change to human paths: manual sends, drag-assign (`TaskManager.assign`,
  `tasks.ts:1376`), review resolution `by: "human"`.
- No change to `activeAgentCount` (`backlog-machine.ts:150`): uninvited sessions still
  count toward `maxSessions` - the cap is a claim about machine load
  (`protocol.ts:1146-1152`), not participation.

## 4. Repository findings and inherited contracts

- `foremanTriageAuthorized` (`src/server/foreman/authorization.ts:9-14`) is a thin
  wrapper over `foremanAutomationAuthorized` with an unused `_sessions` param. It has
  exactly four callers, and all four must agree: `tickTargets` needs-you half
  (`queue-machine.ts:211`), `decideQueueTick` (`queue-machine.ts:326`),
  `processSession` first line (`worker.ts:1690`), and `countNeedsYou`
  (`foreman/config.ts:218`) - the dashboard queue-depth badge whose doc explicitly
  demands lockstep with `tickTargets`. Putting the invite check inside
  `foremanTriageAuthorized` updates all four atomically.
- `tickTargets` (`queue-machine.ts:197-222`): the rest half (`:214-220`) gates only on
  `capabilitiesFor(s.agent).workQueue`, `state !== "exited"`, dedupe, and
  queue/prompted wants-a-tick. It deliberately does not call
  `foremanTriageAuthorized` (hookless sessions with open work must stay reachable -
  pinned by `test/queue-machine.test.ts:366-379`), so it needs its own invite
  conjunct.
- `decideReviewFollowup` (`review-followup.ts:134-213`) returns
  `{kind:"skip"; why: string} | {kind:"nudge"; ...}` via ordered early returns; gate 2
  (`:147-151`) is the "Only a harness Foreman can actually drive" block. Nothing pins
  the skip order or an exhaustive reason list, so a new refusal is additive. Both the
  initial decision (`worker.ts:815-829`) and the freshness re-decision
  (`worker.ts:856+`) flow through this one function.
- `agentIsFree` (`backlog-machine.ts:198-215`) sees the full `Session`; `freeAgentFor`
  (`:218-241`) is its only consumer, called from `decideBacklogTick` (`:363`). The
  drag-assign asymmetry is documented at `:162-165` and `:234-237` and enforced
  server-side in `TaskManager.assign` (`tasks.ts:1339-1376`) - leave `assign` alone.
- `queue-apply.ts:203` re-checks `foremanAutomationAuthorized(fresh)` just before a
  live send - the existing precedent for a just-before-send backstop that holds a
  fresh `Session`.
- Daemon routes that can identify Foreman today: `/inject` carries
  `origin: "foreman"` (`InjectPromptSchema`, `protocol.ts:2208`; route
  `routes.ts:2327-2357`); `/select-option` and `/submit-options` carry
  `by: "foreman"` (`AnswerActorSchema`, `protocol.ts:268`; routes `:2197-2223`,
  `:2231+`); review resolve carries `by` (`client.ts:1345`). The note
  (`PUT /api/sessions/:id/note`) and queue-state writes carry **no** actor marker and
  are shared with the human dashboard (`web/lib/api.ts:1038`) - they stay ungated
  (approved deviation; they are bookkeeping downstream of typing acts these gates
  refuse). The worker's `sendText(submit: true)` delegates to `inject`
  (`client.ts:1291`), so gating `/inject` covers submitted text.
- Tests that will need invite handling once the gates land (from the verification
  sweep): `test/queue-machine.test.ts` has its own hand-rolled `mkSession` (`:53`)
  backing roughly 25 call sites in the file. Set that local fixture's base to
  `foremanInvite: "dispatch"` - the same rationale as C5: these fixtures model
  dispatched, hooked sessions. With that base, every existing case in the file keeps
  its current behavior with no edits, including the `:408` operator-codex ordering
  case (its subject stays invited; its point is hook authorization, which is
  unchanged). Do not set the base to `null`: that silently drops most of the file's
  sessions out of `tickTargets` and rewrites two dozen assertions to say something
  they were never about. The uninvited coverage comes only from new cases declaring
  `foremanInvite: null` explicitly. Same treatment for `test/prompted-wrapup.test.ts`
  (local `mkSession` at `:62`),
  `test/harness-capabilities.test.ts` (uses shared `mkSession`, which defaults
  `"dispatch"` - likely no change), `test/foreman-review-followup.test.ts`,
  `test/backlog-machine.test.ts`, and the registry-minted-session suites
  `test/task-multi-session.test.ts` / `test/task-completion-reconciler.test.ts`, whose
  sessions come from the real registry and will resolve `foremanInvite: null` unless
  the test dispatches through the dispatcher (which now auto-invites) or calls
  `registry.setForemanInvite` in setup.

## 5. Implementation steps (execution order)

1. **`src/server/foreman/authorization.ts`** - `foremanTriageAuthorized` becomes
   `session.foremanInvite !== null && foremanAutomationAuthorized(session)`. Rewrite
   the doc comment: it currently claims launch-scoped hooks prove operator opt-in,
   which is untrue for Claude's machine-scoped hooks and is the bug this plan fixes;
   the invite is now the opt-in proof, hooks remain the capability proof.
2. **`src/server/foreman/queue-machine.ts`** - add `s.foremanInvite !== null` to the
   rest-half filter (`:216` area), with a comment naming why the two halves cannot
   share one call site.
3. **`src/server/foreman/review-followup.ts`** - in gate 2's block (`:147-151`), add
   `if (s.foremanInvite === null) return skip("Foreman is not invited into this session");`
   beside the capability and hook checks.
4. **`src/server/foreman/backlog-machine.ts`** - in `agentIsFree`, grouped with the
   `hooksSeen` clause: refuse unless `s.foremanInvite === "sdk" || s.foremanInvite ===
   "dispatch"`, with a comment recording decision 2 (an operator invite is help with
   current work, not consent to new task assignment) and pointing at the drag-assign
   asymmetry docs.
5. **`src/server/foreman/queue-apply.ts`** - extend the `:203` just-before-send
   re-check with `fresh.foremanInvite !== null` (defence in depth on the freshest
   snapshot).
6. **`src/server/routes.ts` backstops** - each returns 403 with a one-line reason:
   - `/inject`: after parse, `if (parsed.data.origin === "foreman" &&
     session.foremanInvite === null)` refuse before any delivery path.
   - `/select-option` and `/submit-options`: same on `parsed.data.by === "foreman"`.
   - Review resolve (`/api/reviews/:reviewId/resolve`): when `by === "foreman"` and
     the owning session resolves to `foremanInvite === null`, refuse. If the owning
     session cannot be resolved cheaply from the review record, document and skip this
     one route - the three above cover every direct typing path.
7. **Tests**:
   - `test/queue-machine.test.ts`: base the local `mkSession` on
     `foremanInvite: "dispatch"` so every existing case (including `:408`) keeps its
     behavior without edits; add "tickTargets skips an uninvited session on both
     halves" (needs-you shape and open-work shape, both declaring
     `foremanInvite: null`).
   - `test/foreman-review-followup.test.ts`: `decide({session: mkSession({
     foremanInvite: null })}).kind === "skip"` with a `/not invited/` match.
   - `test/backlog-machine.test.ts`: `agentIsFree` refuses `null` and `"operator"`;
     accepts `"sdk"` and `"dispatch"`.
   - `test/queue-apply-sdk.test.ts`: unchanged assertions must stay green (the
     capability invariant) - this is the regression canary for step 1's placement.
   - Route backstop tests (in-process HTTP): foreman-marked inject/select/submit into
     an uninvited session → 403; the same payloads into an invited session pass; the
     human-marked equivalents pass regardless.
   - Registry-minted suites (`task-multi-session`, `task-completion-reconciler`): give
     their setups invites via the dispatcher path or `registry.setForemanInvite`;
     where a case exists precisely to prove autopilot assignment works, that setup now
     also documents the invite prerequisite.
   - A `countNeedsYou`/`tickTargets` lockstep case: an uninvited needs-you session is
     absent from both the badge count and the targets.
8. **README** - the Foreman section states the new participation rule: Foreman acts
   only in sessions Mission Control created (SDK and dispatched) or sessions you
   invite; on upgrade, already-running terminal sessions start uninvited until
   re-dispatched or invited (the API exists now; the button lands with the next
   phase). Keep the wording so phase 3 only has to add the button/withdraw mentions.

## 6. Data / API / migration details

None. This phase writes no schema and no new routes; it changes route responses only
by adding 403s for Foreman-marked writes into uninvited sessions.

## 7. Tests and verification

- `node --test --test-concurrency=2 --import tsx test/queue-machine.test.ts`
- `node --test --test-concurrency=2 --import tsx test/foreman-review-followup.test.ts`
- `node --test --test-concurrency=2 --import tsx test/backlog-machine.test.ts`
- `node --test --test-concurrency=2 --import tsx test/queue-apply-sdk.test.ts`
- Full: `npm run typecheck && npm run lint && npm test`
- `npm run build && npm run smoke` (runtime surface changed).
- Manual runtime check (per the validation working rule): run the daemon + foreman
  worker locally against a personal terminal session and a dispatched one; confirm the
  worker's log skips the former and processes the latter; confirm a foreman-origin
  inject into the former 403s.

## 8. Merge and exit criteria

- All of section 7 green.
- With the worker running: an uninvited session receives no notes, no queue ticks, no
  wrapup prompts, no PR follow-through nudges, and no backlog assignments; invited
  sessions behave exactly as before this phase.
- The queue-depth badge and the worker agree on needs-you counts for uninvited
  sessions (both zero).
- README updated; no UI files touched.

## 9. Downstream handoff (what later phases may rely on and must not change)

- **C6**: gating semantics - the worker acts only when `foremanInvite !== null`;
  backlog autopilot assigns only into `"sdk" | "dispatch"`; human paths (manual send,
  drag-assign, human review resolution) are never invite-gated; the daemon 403s
  Foreman-marked inject/select/submit into uninvited sessions.
- **C7**: the refusal string for review follow-through contains "not invited" (phase 3
  copy may reference the concept but owns its own UI wording).
- Phase 3 may rely on the 403s existing but must not need them: the UI reads
  `session.foremanInvite` directly, never by probing writes.

## 10. Cross-phase audit record

- 2026-08-09 (authoring): consistent with phase 1's C1-C5; this phase adds no write
  door (C4 upheld - the worker still never touches SQLite). The source plan's earlier
  idea of a `foremanMayTrack` sibling predicate collapsed into widening
  `foremanTriageAuthorized`, because its four call sites are exactly the set that must
  move together; recorded here and in the source plan's gating section.
- 2026-08-09 (authoring): review-resolve backstop marked judgment-call (step 6) - the
  three marker-carrying typing routes are the hard requirement.
- 2026-08-09 (Inspector round 2): the queue-machine.test.ts guidance contradicted
  itself - it predicted the `:408` case would lose its rest-half entry while also
  prescribing a non-null invite that keeps it. Resolved by stating the local
  fixture's base value plainly (`"dispatch"`, per C5's rationale), under which no
  existing case in the file changes and uninvited coverage is new cases only; the
  same rule extended to `test/prompted-wrapup.test.ts`'s local fixture.
