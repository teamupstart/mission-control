# Phase 3: Invite foreman UI

## 1. Outcome

The dashboard shows and controls Foreman participation per session. The detail rail's
Foreman slot becomes a three-state control - **＋ Invite foreman** (uninvited),
**Foreman intent** (invited, no history), **Foreman · N** (invited, with episodes) -
with **Withdraw invite** in the Foreman drawer header, and every Foreman surface
explains uninvited silence with a "not-invited" reason instead of showing nothing.
This closes the interim state phase 2 leaves (enforcement without explanation or
button) and matches the approved mockup in `plan.html`.

## 2. Entry criteria and dependencies

- Direct prerequisite: **Phase 2** merged. The UI copy asserts "Foreman is not in this
  session", which is only true once enforcement is live; and the e2e spec exercises
  invite/withdraw against routes (phase 1) whose consequences (quiet worker) phase 2
  delivers. Phases 1's contracts C1-C5 and phase 2's C6-C7 are inherited.

## 3. Scope and non-goals

In scope: the rail control, the drawer withdraw action, the send-block reason and its
three render surfaces, the web API client methods, CSS, render tests, source-scan
compliance, the e2e spec, and README's button/withdraw mentions.

Non-goals:

- No server changes. The routes, resolution, and gating are done; this phase reads
  `session.foremanInvite` and calls the two API methods.
- No invite affordance on the grid `SessionCard` (approved out-of-scope; the console
  and board drill-in share `ConsoleDetail`).
- No change to Approve/Dismiss note machinery (`useForemanDecision`), to
  `workQueueBlockedReason`, or to the fleet Foreman settings panel.

## 4. Repository findings and inherited contracts

Verified against the repo (base `a6146ee`):

- Rail block: `ConsoleDetail.tsx:390-401` - gate `(episodes.length > 0 ||
  session.goal)`, `Tooltip`-wrapped button `.foreman-rail`, label
  `episodes.length > 0 ? "Foreman · N" : "Foreman intent"`, dot `.fr-dot` when
  `openCount > 0`. `live` is computed at `:231`; `drawerOpen` state at `:153`.
- Drawer: `src/web/components/ForemanDrawer.tsx` - props `{episodes, intent, open,
  onClose}` (`:22-30`), **no session prop**; header `fd-head` (`:65-86`) with
  `.fd-close` pinned right by `margin-left: auto` (`styles.css:20438`); Escape
  handling (`:35-49`) must not gain a second path. A withdraw control slots after
  `fd-title` (`:79`), before `.fd-close`, styled with the `.fd-back, .fd-close` group
  (`styles.css:20425-20451`).
- Send-block rule: `src/web/lib/foreman.ts:34-63`. The type union's order and the
  branch order already disagree - precedence comes from the branches (`:42-46`):
  `foreman-off` → `drafts-only` → `no-cwd` → `not-allowlisted`. Insert `not-invited`
  after `foreman-off`. `foremanSendBlock` takes no session and is called directly by
  the work-queue panel, so it gains an `invited: boolean` input; `sessionSendBlock`
  derives it from `session.foremanInvite !== null`.
- Render surfaces: shared `DraftHint` (`foreman-bits.tsx:119-158`, switch at `:130`)
  covers the console strip (`ForemanStrip.tsx:144`) and grid card
  (`ForemanNote.tsx:116-118`) at once. The work-queue panel has its own
  `QueueHint` (`WorkQueue.tsx:615-662`, `foremanSendBlock` call at `:622-627`),
  rendered only when `open.length > 0` (`:597-599`); the `blocked` branch returns
  early at `:338`. The mockup promises the sentence on an empty queue, so the gate
  widens: render the hint region when `open.length > 0` **or** the session is
  uninvited (empty-queue copy per the mockup: "Nothing queued. Foreman is not in this
  session - invite it from the rail above to let it triage and wrap up here.").
- API client: `src/web/lib/api.ts` - `post`/`del` helpers (`:479-484`, `del` is
  body-less, matching the C3 contract), Foreman block at `:1040-1055`. Add
  `inviteForeman: (id) => post(...)` and `withdrawForemanInvite: (id) => del(...)`
  with `encodeURIComponent`, per the file's convention. `foreman-bits.tsx:12` imports
  `api` directly - the drawer and rail may do the same; no prop drilling required,
  but keep test injectability in mind (the `ForemanWriter` narrow-interface pattern at
  `lib/foreman.ts:174-195` is the precedent if a helper is extracted).
- Source-scan compliance: `test/tooltip-coverage.test.ts` scans **every** `.tsx` under
  `src/web` - both new buttons need exactly one `Tooltip` ancestor each, and no
  `title=` attribute. The overlay/popover/drag-region registries do not reach these
  components (drawer is `position: absolute`, no `role="dialog"`).
- Render-test hosts: `test/workflows-tab.test.ts` (`view()` `:20-26`,
  `detailHtml(session)` `:28-32`) is the cleanest place to pin the three rail states;
  `test/foreman-intent-drawer.test.ts` (`render` helper `:28-37`) breaks on the
  drawer's widened props - intended churn, every fixture states the new input;
  `test/foreman-note.test.ts` (`:78-120`) and `test/work-queue-panel.test.ts`
  (`hint()` `:113-114`, ordering table `:116+`) hold the per-reason copy assertions to
  extend.
- The shared `mkSession` defaults `foremanInvite: "dispatch"` (C5), so existing
  ConsoleDetail render tests keep drawing the invited rail; three-state tests declare
  their state explicitly.
- E2E: discovery is hard-off (`e2e/fixtures/daemon.ts:183-188`, `MISSION_POLL_MS=0` -
  safety-critical, do not touch) and every e2e session is dispatched SDK runtime
  (`daemon.ts:375-379`). The tombstone (C1/C3) is what makes the cycle testable:
  withdraw an implicitly invited SDK session, then re-invite. Dispatch-helper pattern:
  `e2e/specs/dispatch-and-converse.spec.ts:133-162`; read `e2e/README.md` first; fake
  agents only; select by role/label, never `data-testid`.

## 5. Implementation steps (execution order)

1. **`src/web/lib/api.ts`** - `inviteForeman` / `withdrawForemanInvite` as above.
2. **`src/web/lib/foreman.ts`** - `ForemanSendBlock` gains `"not-invited"`;
   `foremanSendBlock` gains `invited: boolean`, branching
   `enabled → invited → mode → cwd → allowlist` with a doc-comment sentence for why
   invite outranks mode (an uninvited session is skipped in every mode, so mode would
   be a lie); `sessionSendBlock` supplies it from the session.
3. **`src/web/components/foreman-bits.tsx`** - `DraftHint` gains the `not-invited`
   case: "Foreman is not in this session. Invite it from the rail above." (`fn-hint
   dim`, same shape as its siblings).
4. **`src/web/components/WorkQueue.tsx`** - `QueueHint` gains the same case reading
   `props.session.foremanInvite`; widen the `:597` gate so an uninvited session shows
   the sentence with an empty queue (mockup copy above).
5. **`src/web/components/ForemanDrawer.tsx`** - props widen with the session (or
   `sessionId` + `foremanInvite`) and the withdraw handler; render **Withdraw invite**
   in `fd-head` between title and close, `Tooltip`-wrapped ("Remove Foreman from this
   session - it stops triaging, wrapping up, and following PRs here"), calling
   `api.withdrawForemanInvite`; on success the `session_upsert` flips the rail and the
   parent closes the drawer (uninvited sessions do not render it - see step 6
   decision).
6. **`src/web/components/layouts/ConsoleDetail.tsx`** - the rail becomes three-state:
   - `session.foremanInvite === null && live`: **＋ Invite foreman**
     (`.foreman-rail.invite`, Foreman purple accent), `Tooltip`: "Foreman is not in
     this session. Invite it to triage, wrap up, and follow PRs here." Click calls
     `api.inviteForeman`; the `session_upsert` swaps the button in place; no confirm.
   - invited: render the rail **always** (drop the `episodes.length > 0 ||
     session.goal` gate for invited sessions) - "Foreman intent" when no episodes,
     "Foreman · N" + dot otherwise, opening the drawer as today.
   - uninvited: the drawer does not open; history (episodes) becomes reachable again
     on re-invite. Authored decision: an uninvited session shows only the invite
     affordance - one slot, one meaning; recorded in the audit below.
   - uninvited and not `live`: render nothing (an exited session cannot be usefully
     invited).
7. **`src/web/styles.css`** - `.foreman-rail.invite` (purple text/border/tint per the
   mockup: `color: var(--foreman)`, border `color-mix` of `--foreman`, subtle tinted
   background) and `.fd-withdraw` in the `.fd-back, .fd-close` group; hover and
   `:focus-visible` states matching neighbors.
8. **Render tests** - three rail states in `test/workflows-tab.test.ts` (or a
   dedicated `test/foreman-rail.test.ts` beside it); widened-props fixtures in
   `test/foreman-intent-drawer.test.ts` plus a withdraw-button-present assertion;
   `not-invited` copy cases in `test/foreman-note.test.ts` and
   `test/work-queue-panel.test.ts` (extend the ordering table: invite outranks mode
   and allowlist, loses to foreman-off).
9. **E2E spec `e2e/specs/foreman-invite.spec.ts`** - one journey:
   dispatch through the real modal → open the session detail → rail reads "Foreman
   intent" (invited SDK session, no history) → open the drawer → click "Withdraw
   invite" → rail flips to "＋ Invite foreman" → Work queue tab shows the
   not-invited sentence → click "＋ Invite foreman" → rail returns to "Foreman
   intent" and the sentence is gone. Assert by role/accessible name throughout.
10. **README** - add the invite button and withdraw action to the Foreman section
    phase 2 rewrote (one or two sentences; the participation rule is already there).

## 6. Data / API / migration details

None server-side. The web client adds the two calls against phase 1's routes (C3).

## 7. Tests and verification

- `node --test --test-concurrency=2 --import tsx test/workflows-tab.test.ts`
- `node --test --test-concurrency=2 --import tsx test/foreman-intent-drawer.test.ts`
- `node --test --test-concurrency=2 --import tsx test/foreman-note.test.ts`
- `node --test --test-concurrency=2 --import tsx test/work-queue-panel.test.ts`
- `node --test --test-concurrency=2 --import tsx test/tooltip-coverage.test.ts`
- Full: `npm run typecheck && npm run lint && npm test`
- `npm run build && npm run smoke && npm run test:e2e` (UI change: the e2e spec is
  mandatory, and visual verification of the rail states against the mockup in
  `docs/plans/foreman-invite/plan.html` - screenshots attach to the PR, never commit
  evidence).

## 8. Merge and exit criteria

- All of section 7 green, including the new e2e spec in CI.
- The rendered states match the mockup: purple invite chip, unchanged invited states,
  empty-queue sentence, drawer withdraw.
- Withdraw works on an SDK session (the tombstone path) and on a dispatched terminal
  session; re-invite restores participation and history.
- README mentions the button and withdraw.

## 9. Downstream handoff

Final phase - no downstream consumers. What the repo guarantees after this merges:
the full approved plan (`plan.md`) is implemented; the invite state is visible,
controllable, explained, and enforced end to end.

## 10. Cross-phase audit record

- 2026-08-09 (authoring): depends on phase 2 (not just 1) so the UI's "Foreman is not
  in this session" is never rendered while the worker still acts there.
- 2026-08-09 (authoring): authored decision - an uninvited session renders only the
  invite affordance; its episode history is unreachable until re-invited. Keeps the
  slot single-purpose; revisit only if operators ask to read history while uninvited.
- 2026-08-09 (authoring): consistent with C5 - the `"dispatch"` fixture default means
  existing ConsoleDetail render tests keep their invited rail output; only the new
  three-state tests declare other values.
