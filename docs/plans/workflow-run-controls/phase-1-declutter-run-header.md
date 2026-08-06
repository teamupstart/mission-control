# Phase 1 - Declutter the run header

## Outcome

The four controls that serve nobody reading a run leave the header. `Copy run id`, `Export run` and
`Export version` move into a collapsed audit disclosure beside the Timeline, and `Open version`
becomes the version badge itself. The header drops from up to eleven controls to seven, and the run
id gains a copy path that actually works in the Electron renderer.

Value: the immediate decluttering win, delivered without touching any action's behaviour. Nothing in
this phase changes what a run can do, only where the non-actions live, which makes it the smallest
independently shippable slice and the safest one to review.

## Entry criteria and dependencies

- **Direct phase dependencies: none.** Runs concurrently with Phase 4.
- Requires the approved plan's decision that the audit trio lands in a bottom disclosure rather than
  being deleted or kept in the header.

## Scope

In scope:

1. Remove `Copy run id`, `Export run`, `Export version` and `Open version` from `.wf-run-actions`.
2. Add a `<details class="wf-run-audit">` after the Timeline section carrying the run id (with a
   working copy control), the run JSON download, and the workflow version JSON download.
3. Make the `v8` badge the link to the composer, absorbing `Open version`.
4. Fix the silent-clipboard bug: the run id copy goes through `copyText()` from
   `src/web/lib/clipboard.ts`.

Non-goals, owned elsewhere:

- Deriving a single next move, the why-sentence, and the `open-pr` PR-URL gate: **Phase 2**.
- `Run this review again` on terminal runs: **Phase 3**.
- The `＋ workflow` bind chip: **Phase 4**.
- Any change to `Submit fresh evidence`, `Submit unchanged`, `Prepare PR in session`,
  `Retry provider call`, `Recheck Inspector`, `Copy feedback`, `Restart full workflow` or
  `Cancel run`. They stay exactly as they are, in place, this phase.

## Repository findings

Verified against the tree at `18528997`.

- The header's control row is `WorkflowRuns.tsx:629-780`; the danger row is `784-823`. The four
  controls to move are at `729-747` (`Open version`), `748-756` (`Export run`), `757-771`
  (`Export version`) and `772-779` (`Copy run id`).
- **The Timeline is the last section in `WorkflowRunView`.** It opens at `WorkflowRuns.tsx:1344`
  (`<section className="wf-run-section wf-run-timeline">`, named by its `<h4>Timeline</h4>` at 1345,
  no `aria-label`) and closes at `1377`. Line `1378` closes the root
  `<section className="wf-run-detail">` opened at `600`. The disclosure therefore goes **between
  1377 and 1378**.
- `Open version` currently calls `requestWorkflowVersionOpen(version.workflowId, version.version)`
  then sets `window.location.hash` (`WorkflowRuns.tsx:735-743`). That handler moves onto the badge
  unchanged; only its host element changes.
- `.wf-run-version` (`styles.css:435-441`) is styled for a `<span>`: it sets `border`, `border-radius`,
  `padding`, `color` and `font` but **no `background`**. Promoting it to a `<button>` picks up the UA
  button background and renders as a filled pill. The rule needs `background: transparent` plus a
  `cursor`/hover treatment for the button case. This was found by rendering the mockup and is why
  `mockups.html` carries a `button.wf-run-version` rule.
- `Copy run id` is the one clipboard control that bypasses the shared helper:
  `onClick={() => void navigator.clipboard.writeText(detail.run.id)}` (`WorkflowRuns.tsx:775`).
  `copyText()` (`src/web/lib/clipboard.ts:12-61`) returns `"clipboard" | "fallback"` and throws
  `"The browser refused the clipboard copy"` when both paths fail. `Copy feedback`
  (`WorkflowRuns.tsx:696-712`) is the pattern to copy, including the 1600 ms `Copied` label flip.
- Both export controls are plain `<a download>` anchors against
  `/api/workflow-runs/{id}/export` and `/api/workflows/{workflowId}/versions/{version}/export`. Both
  routes are GET-only and unchanged by this phase. `test/workflow-security.test.ts:38` asserts no
  write route matches `/export`; nothing here adds one.
- `detail.version` is `WorkflowVersion | null` (`src/shared/workflow.ts:2240`). The existing
  disabled-button fallbacks for a missing version (`WorkflowRuns.tsx:769`) must survive the move as
  disabled rows in the disclosure, not disappear.
- Precedent for the disclosure: `<details className="rm-config">` in
  `ScheduleDetail.tsx:186-236`, CSS at `styles.css:20505-20526`, whose comment states the charter -
  "The exact stored configuration: an audit view, so it sits behind a disclosure."
- **No drag-region registration needed.** `styles.css:1050-1075` lists fixed and absolutely
  positioned popovers for `-webkit-app-region: no-drag`. A `<details>` in the document flow is
  neither, so `desktop-drag-region.test.ts` is unaffected.

## Implementation steps

1. **`src/web/styles.css`**
   - Add `background: transparent` to `.wf-run-version` so the rule is element-agnostic, then add
     `button.wf-run-version { cursor: pointer; }` and a hover that moves `color` and `border-color`
     to `var(--working)`.
   - Add `.wf-run-audit`, `.wf-run-audit > summary`, `.wf-run-audit-body` and `.wf-run-audit-row`.
     Take the shape from `.rm-config`: `1px solid var(--border-soft)`, radius 9, `var(--panel)`, a
     `list-style: none` summary with a `▸`/`▾` marker at 11.5px `var(--muted)`. Row layout is a flex
     `<dl>`: mono uppercase `dt` at 10.5px `var(--dim)` with a fixed min-width, a `dd` for the value,
     and a `dd` holding the control. Prose `dd` stays sans; only the id itself is mono.

2. **`src/web/workflows/WorkflowRuns.tsx` - the badge**
   - Turn the `<span className="wf-run-version">` at `609` into a `<button>` wrapped in `Tooltip`,
     label `Open workflow version {version.version} in the composer`, `disabled={!version}` with the
     disabled tooltip reusing today's "The immutable published version is missing or corrupt".
     Move the `onClick` body from `735-743` verbatim.

3. **`src/web/workflows/WorkflowRuns.tsx` - remove four controls**
   - Delete the JSX at `729-779`. Leave `Copy feedback` (`696-712`) and `Open PR` (`713-728`) where
     they are; `Open PR` is Phase 2's problem.

4. **`src/web/workflows/WorkflowRuns.tsx` - the disclosure**
   - Add a `runIdCopied` state beside `feedbackCopied` (`562`) and a copy handler that calls
     `copyText(detail.run.id)`, flips the label to `Copied` for 1600 ms, and on failure sets the
     page error exactly as `copyFeedback` does (`1619-1627`).
   - Insert `<details className="wf-run-audit">` between `1377` and `1378` with
     `<summary>Audit and bug reports</summary>` and three rows: **Run id** (mono value plus the copy
     button), **Run history** ("Every retained event, verdict, delivery and model call" plus a
     `Download JSON` anchor to the run export), **Workflow v{n}** ("The immutable published
     definition this run was pinned to" plus a `Download JSON` anchor to the version export, rendered
     as a disabled button when `version` is null).
   - Keep the anchors' `download` filenames byte-identical to today's -
     `workflow-run-${detail.run.id}.json` and `workflow-version-${version.version}.json` - because
     `test/workflows-http.test.ts:261-307` pins the server's `Content-Disposition` to those names and
     a mismatch between the two would be confusing on disk.
   - Every control keeps its `<Tooltip>`. No native `title`.

## Data, API and migration

None. No route, schema, migration or wire-contract change. Both export endpoints and the version
route are consumed exactly as before, from a different element.

## Tests and verification

- **`test/workflow-runs-render.test.ts:503-517`** currently asserts all six of `Copy feedback`,
  `Copy run id`, `Export run`, `Export version`, `Open version`, `Cancel run` in the header. Rewrite:
  the header must still contain `Copy feedback` and `Cancel run` and must **no longer** contain
  `Copy run id`, `Export run`, `Export version` or `Open version`; the rendered markup must contain
  the `wf-run-audit` disclosure with the three rows. Cases at `1039` and `1081` also assert
  `Export run` and need the same retarget.
- **`test/workflow-builder-render.test.ts:331`** ("Open version carries one bounded request across
  the Runs-to-builder route") must retarget from the button to the badge. The `requestWorkflowVersionOpen`
  contract is unchanged, so only the element the test reaches for moves.
- Add a case asserting the missing-version path renders the version row **disabled** rather than
  omitting it.
- **New `e2e/specs/workflow-run-audit.spec.ts`**: seed a completed run (copy `api` + `dispatch` +
  `seedRun` from `e2e/specs/workflow-skipped-status.spec.ts:44-95`, the suite's simplest
  completed-run recipe - there is no shared helper module and each workflow spec carries its own
  copies, which is the established pattern). Assert: the header exposes no control named
  `Copy run id`, `Export run`, `Export version` or `Open version`; the `Audit and bug reports`
  disclosure is present and collapsed; opening it reveals the run id and two download controls;
  the version badge is a control whose accessible name names the version. Select by role and
  accessible name only - no `data-testid`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` followed by
  `npm run test:e2e` (the suite drives `dist/`, and needs `npx playwright install chromium` once per
  machine).

## Merge and exit criteria

- The header contains no run id, no export, and no `Open version` button.
- The version badge navigates to the composer and carries an accessible name naming the version.
- The audit disclosure exists after the Timeline, is collapsed by default, and its copy control
  survives a blocked clipboard by falling back through `copyText()`.
- All four verification commands pass, including the new e2e spec.
- README needs no edit: it documents neither the export controls nor the run id.

## Downstream handoff

Later phases may rely on:

- **`.wf-run-actions` (`WorkflowRuns.tsx:629`) containing only run-affecting controls.** Phase 2
  restructures this row into zones; it inherits a row already free of audit clutter, so its diff is
  purely about the primary move.
- **`.wf-run-audit` existing and owning the run id and both exports.** No later phase moves them
  again or adds a second copy of the run id.
- **The version badge owning composer navigation.** Phase 2 must not reintroduce an `Open version`
  button.
- **`copyText()` being the only clipboard path in this component.** Any later clipboard control uses
  it.

Must not change: the `download` filenames, the two export routes, or
`requestWorkflowVersionOpen`'s signature.

## Cross-phase audit record

- **Initial authoring.** No earlier phases exist. Boundaries chosen so this phase is pure relocation:
  it deliberately does **not** touch `Open PR`, whose fix requires the PR-URL gate and the
  non-null-assertion repair that Phase 2 owns, because splitting that across two phases would leave
  a window where `openPrAction!` is dereferenced against a conditional array.
- **Reconciled after Phase 2 authoring.** Phase 2 restructures the same JSX region
  (`.wf-run-actions`). Sequenced rather than concurrent for that reason, and Phase 2's entry criteria
  name this phase as its direct prerequisite. Confirmed no overlap with Phase 4's files
  (`SessionCard.tsx`, `ConsoleDetail.tsx`), so Phase 1 and Phase 4 may merge in either order.
- **Reconciled after Phase 3 authoring.** Phase 3 adds a control to the same row but depends on
  Phase 2, so it never races this phase. Phase 3 inherits the audit disclosure untouched.
