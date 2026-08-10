# Phase 3: Retro solicitation UI

## 1. Outcome

The user is offered a retro at the moment the source plan chose: when the PR exists and
the Inspector's findings are all addressed, and the session is actually worth
retrospecting. The offer appears as a run action on the workflow ladder (Board tile and
Runs page), as a Retro entry in the ActionBar, and as a backstop in the Complete flow.
Clicking any of them calls phase 2's route. Nothing is ever typed autonomously. The
behavior is covered by a Playwright spec in `e2e/`.

## 2. Entry criteria and dependencies

- Phase 2 merged: `POST /api/sessions/:id/retro`, `RETRO_SESSION_ACTION_ID`, and the
  `retro` skill exist.
- (Transitively phase 1, via phase 2.)

## 3. Scope and non-goals

In scope:

- Server: a retro-worthiness signal computed per session and shipped on the existing
  `Session` payload (additive optional field, no new event type).
- Web: run-action descriptor + ladder and Runs-page wiring, ActionBar entry,
  CompleteModal backstop.
- `e2e/` spec, unit tests, README.

Non-goals:

- No new tab in `detailTabs` (the review modal and existing surfaces suffice for v1).
- No autonomous delivery, no Foreman typing, no workflow graph changes.
- No dashboard memory-catalogue browser (out of scope per the source plan).

## 4. Repository findings and inherited contracts

- The gate predicate is already on the wire: `WorkflowRunSummary.gate === "clean"`
  (`compactGate`, `src/server/workflows/store.ts:191-202`) is exactly "adopted PR,
  reviewed head equals target head, zero unresolved findings". For sessions without a
  bound workflow, the universal predicate is PR-present plus inspector-clean
  (`inspectorChipView` tone `insp-clean`, `src/web/components/session-bits.tsx:954-983`).
  Two caveats verified in code: dry-run Inspector rounds reach "clean" without posting
  (exposed as `dry`), and a merged or closed PR reads `retired`, not `clean`; the offer
  treats `dry` as clean (the operator chose dry-run) and stays available on `retired`
  (the auto-merge backstop in the source plan).
- Run action descriptors carry no URL; call sites own the POST
  (`src/web/workflows/run-actions.ts:14-38` for the `GateAction` union,
  `WorkflowLadder.tsx:516-535` and `WorkflowRuns.tsx` for rendering and wiring). The
  "Prepare PR in session" descriptor (`run-actions.ts:65-83`) is the pattern to follow.
- Retro-worthiness needs the server: human-correction turns exist
  (`humanTranscriptDecisions`, `src/server/workflows/context.ts:147`, over
  scaffolding-stripped transcript text) or the Inspector raised findings that were then
  resolved (resolved `inspector_comments` rows, `src/server/db.ts:987-1006`). Transcript
  scanning is not free, so it is computed lazily and cached, not on every poll.
- `Session` already carries computed summaries (`Session.inspector`,
  `src/shared/types.ts:1997`) recomputed by the registry and pushed via
  `session_upsert`; an additive optional field rides the same path with no
  `useEventStream` event-type change (its exhaustiveness contract is over event types,
  not session fields).
- ActionBar button rows live at `src/web/components/ActionBar.tsx:413-533` (console
  foot and card variants); `CompleteModal` confirms via
  `api.completeTask(...)` then `api.kill(...)`
  (`src/web/components/CompleteModal.tsx:71-100`).
- e2e constraints (`e2e/README.md`, AGENTS.md): fake agents only, no `data-testid`,
  select by role/label; `npm run test:e2e` needs a prior `npm run build`.

## 5. Implementation steps

1. Server, worthiness signal:
   - Add `Session.retro?: { worthy: boolean; reason: "corrections" | "findings" }`
     (additive optional) to `src/shared/types.ts`.
   - Compute it in the registry beside the inspector summary refresh: findings-based
     worthiness from resolved `inspector_comments` counts (cheap query); corrections
     -based worthiness computed at most once per session (lazy, cached, recomputed only
     when the transcript grows past the last scan anchor), using the scaffolding
     -stripped human-turn extraction phase 2's skill also relies on.
   - Emit through the existing `session_upsert` path.
2. `src/web/workflows/run-actions.ts`: extend `GateAction` with
   `{ kind: "retro" }`; produce it when the run's gate is `clean` (or `dry`) and the
   bound session's `retro?.worthy` is true. Label "Run retro", tooltip explaining what
   it delivers.
3. `WorkflowLadder.tsx` and `WorkflowRuns.tsx`: render the new action through the
   existing `LadderAction` machinery and wire it to
   `POST /api/sessions/:id/retro` (client function added to `src/web/lib/api.ts`).
4. `src/web/components/ActionBar.tsx`: a Retro button in both variants, shown when the
   session's `retro?.worthy` holds and either the gate predicate or the chip predicate
   (PR-present + inspector-clean) is satisfied; hidden otherwise (an offer, not
   permanent chrome). Wire to the same client function.
5. `src/web/components/CompleteModal.tsx`: when `session.retro?.worthy`, render a
   secondary "Run a retro first" action that calls the same client function and closes
   the modal without completing the task.
6. Tests:
   - `test/`: predicate units (gate clean, dry, retired, unbound-session chip path;
     worthiness reasons), `renderToStaticMarkup` for the ActionBar row shape.
   - `e2e/retro-offer.spec.ts`: with fake agents, drive a session to a state where the
     offer must appear (worthy + clean), assert the control is reachable by its
     accessible name, click it, and assert the session's conversation shows the
     delivered retro action text; assert the offer is absent for an unworthy session.
7. README: the solicitation behavior, where the offer appears, and the conditioning
   rule.

## 6. Data, API, and migration details

- `Session.retro` is an additive optional wire field; no migration, no new
  `ServerEvent`.
- No new routes; phase 2's route is consumed.

## 7. Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`
- `npm run build && npm run smoke`
- `npm run test:e2e` including the new spec (requires the build; Playwright browser via
  `npx playwright install chromium` once per machine)

## 8. Merge and exit criteria

- Section 7 green locally and in CI (e2e job runs on Node 24).
- The e2e spec proves: offer appears exactly under the predicate, click delivers the
  action text into the session, no offer on unworthy sessions.
- README matches the shipped behavior.

## 9. Downstream handoff

- None; this is the last phase. It must not change phase 2's route contract, the
  `repo_commit` kind, the `retro` skill id, or phase 1's shared constants.

## 10. Cross-phase audit record

- 2026-08-04: Initial version. Worthiness signal placed on `Session` (additive
  optional) rather than a new event type after verifying `useEventStream`'s
  exhaustiveness contract is per event type. Gate caveats (`dry`, `retired`) resolved:
  dry counts as clean, retired keeps the offer (auto-merge backstop).
