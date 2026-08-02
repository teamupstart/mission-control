# Phase 3: automation parity on Claude

## Outcome

Everything autonomous that works on a terminal Claude session works on an SDK one, and
works better: Foreman reviews and answers structured asks (including multi-question
forms and free text), the work queue delivers over an acked send, reset/clear and the
wrap-up skill ride the driver, cost is verified single-counted, and PR provenance flows
from the driver. The machinery is runtime-generic so phase 4's Codex driver and phase
6's pi driver inherit it without edits.

## Entry criteria and dependencies

- Direct prerequisite: phase 2 merged (driver, supervisor, answer routing, toggle).
- Runs concurrently with phase 4 (disjoint files; either merge order).

## Scope

In: Foreman prompt/verdict/pending updates, `foremanAutomationAuthorized` runtime arm,
queue delivery + outcome mapping, reset, skills reload + wrap-up delivery, cost
double-count verification, `pr_created` → `adoptPr`, removal of phase 2's interim queue
refusal.

Non-goals: Codex or pi specifics (the changes here branch on `runtime` and capability,
never on agent id); any new UI surface.

## Repository findings and inherited contracts

Inherits C1-C8. Findings binding this phase:

## Implementation steps

1. **`foreman/prompt.ts` (C9)**: `PromptHarness` gains
   `runtime: SessionRuntime`; `promptHarness(agent, session)` projects it. `policyFor`
   branches the grammar: terminal keeps today's wording; sdk states the menu is
   structured data, `answer.option` is delivered exactly, prose IS deliverable (a
   deny-with-reason or free-text answer), and multi-question forms are answered with
   `answer.form: { answers: Record<question, string | string[]>, freeText? }`.
   `foreman-prompt-harness.test.ts` extends to pin both projections.
2. **`foreman/verdict.ts`**: accept `answer.form` in the verdict schema; `menuMismatch`
   keeps refusing pane multi-selects but validates driver forms (every non-free-text
   question answered with labels that exist; `optionRowMiss` per option). `applyVerdict`
   routes forms through `POST /submit-options` with the answers map.
3. **`foreman/pending.ts`**: `classifyPending`'s dialog branch already fires on the
   shared `paneDialog` field; name the situation `"structured-request"` when
   `dialog.source === "driver"` so the reviewer prompt selects the right framing;
   `canSend` already reads `canMessage` (phase 1).
4. **Queue delivery**: in the daemon's inject/send handlers (already runtime-branched,
   phase 2), surface the ack to `queue-apply`'s outcome mapping: SDK success →
   recorded-and-sent (no `mayHaveLanded` limbo), SDK failure → a definite failed attempt
   (spends a rationed attempt; no park-and-retry `paneBlocked` arm, no pane-recreated
   observation for `paneKey: null` sessions). Verification (`transcript.since` from the
   delivery anchor) is unchanged. Remove phase 2's interim SDK-queue refusal.
5. **`foremanAutomationAuthorized` (C9)**: add the runtime arm - an SDK-runtime session
   with `harness.workQueue` non-null is authorized (its driver IS the pickup/completion
   channel); terminal logic unchanged. `workQueueBlockedReason` composes the matching
   sentence.
6. **Reset**: `resetToOrigin` branches on runtime - sdk → `handle.clearContext()` via
   the supervisor (null handle capability degrades to `cleared: false`, the tested
   answer). Add a driver-sourced clear evidence kind that `canResolvePending` accepts,
   so the next `bound` can transfer the work episode instead of timing out after identity
   rotates. The rest of `resetSession` (episode reset, queue clear, rebind wait) remains
   the single owner and must pass its existing tests for SDK sessions.
7. **Skills**: reload delivery for SDK Claude sessions sends `reloadCommand` via
   `send()` with preconditions reduced to driver-idle (the pane-guard reads have no SDK
   arm); wrap-up composition is unchanged (`composeWrapup`), delivery rides the queue
   path from step 4.
8. **Cost**: E2E-verify OTEL usage events arrive from an SDK subprocess session and the
   daily ledger records them once; assert the driver's `turn_done` usage is not written
   to the ledger (display enrichment only, per the source plan).
9. **Provenance**: `applyDriverEvent`'s paired-command-and-URL `pr_created` feeds the same
   registry path the hook's `prCreated` does (session `pr_opened` emit → Inspector adoption).
   `inspector-adoption.test.ts` extends: driver event adopts; a bare `prUrl` sighting
   still does not.
10. **Tests**: `foreman-prompt-runtime.test.ts`, verdict form validation,
    `queue-apply-sdk.test.ts` (ack outcomes, no-limbo mapping, verification anchor),
    `reset-sdk.test.ts`, skills-reload SDK arm, provenance extension.

## Data and compatibility

No schema changes. The verdict schema addition (`answer.form`) is additive; older
Foreman workers against a newer daemon simply never emit it (Foreman ships from the same
repo - version skew is one deploy at most).

## Verification

Unit suites above, plus E2E on a real SDK dispatch: queue two items and watch
pickup/verify/wrap-up complete; let Claude raise an `AskUserQuestion` multi-select and
watch Foreman answer the full form; reset the session and confirm episode/queue
integrity; confirm the day's cost ledger shows the session once; open a PR from the
session and watch the Inspector adopt it.

## Merge / exit criteria

CI green; the E2E checklist above demonstrated; phase 2's interim refusal removed; no
agent-id branches introduced (grep the diff for `agent ===` - capability and runtime
reads only).

## Downstream handoff

Phase 4 and 6 may rely on: every mechanism in this phase being runtime-generic
(prompt projection, form answers, queue ack mapping, reset routing, the
`foremanAutomationAuthorized` runtime arm). They must not: add per-agent forks of any of
it - a Codex or pi gap is expressed through the harness's capability slots or its
adapter, never a special case in Foreman.

## Cross-phase audit record

- 2026-07-24: initial version. Step 5's runtime arm is deliberately here (not phase 6)
  so pi's driver lands against a stable authorization contract; phase 6 references it as
  C9. Phase 2's step 10 refusal removal is owned here - recorded in both files.
- 2026-07-25: implemented. Step 6 required two edits inside C4/C5 machinery, both
  additive and recorded here because they are phase 1/2 surfaces:
  - `SdkEvent`'s `bound` gains optional `cleared?: true` (C4). A rotation looks identical
    from outside whether the agent was cleared or merely reported a new id, and only the
    party that issued `clearContext()` knows which - so the driver latches it and spends
    it on the first rotation after. Absent means "an ordinary binding", so every existing
    emitter is unchanged.
  - `ensureWorkEpisode`'s identity evidence gains `driver_clear` beside `clear_start`,
    and its `pathReplaced` corroboration is weakened FOR THAT KIND ONLY: a driver reports
    the new identity the instant the harness mints it and Claude writes the session file
    lazily, so `claudeSdkTranscriptPath` legitimately answers null. Measured live against
    Claude 2.1.220 - three consecutive `/clear` resets, three null paths, three episodes
    stranded with `workIdentityReady: false` on a reset that had worked. The hook path's
    `clear_start` and the passive path are byte-identical. Test:
    `reset-sdk.test.ts`.
