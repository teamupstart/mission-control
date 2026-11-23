# Resident drawer - Phase 2: Quick answers in the drawer

Source plan: `docs/plans/resident-display-surfaces/plan.md`. Index:
`docs/plans/resident-display-surfaces/phased-plan.md`. Prerequisite phase:
`docs/plans/resident-display-surfaces/phase-1-resident-drawer.md`. This file is the proposed
route. Where the repository disagrees, follow the repository and record the deviation in the pull
request.

## 1. Outcome

The drawer's selected card lets you answer a resident without leaving the fleet. It shows:

- the latest message, or the open question;
- the question's options as buttons;
- a reply box that sends with `⌘⏎`.

This completes source-plan acceptance criterion 3.

**Value:** most asks from a resident get answered in one or two keystrokes from the drawer.

## 2. Entry criteria and dependencies

- Phase 1 has merged, and its contracts are on the default branch.
- Direct prerequisite: Phase 1.

## 3. Scope

**In scope:** content inside Phase 1's `ResidentDrawerCardBody` for the selected card:

- the latest-message or open-question preview;
- question options rendered through the existing review UI;
- a reply box;
- their keyboard behavior, styles, tests and docs.

**Non-goals:**
- Any change to fleet membership, the placement predicate, drawer open or pin state, `⌥N`, the
  visitor card, or UI config fields. Phase 1 owns all of these.
- New server endpoints.
- Changing how the Conversation tab or the attention inbox answer reviews.

## 4. Repository findings and inherited contracts

Verified at `c90f6287d`, to be re-verified at implementation time.

- **Reviews are answered inline elsewhere already.** `src/web/components/AttentionInbox.tsx`
  renders `ReviewCard` from `src/web/components/ReviewModal.tsx` for each pending review, and
  calls `api.resolveReview(id, action, response, selections)` (`src/web/lib/api.ts` around 1831).
  The helpers in `src/web/lib/reviews.ts` (`reviewDecisions`, `showsBody`, `reviewAnswerVerb`)
  shape it. Reuse `ReviewCard` in the drawer the same way, rather than drawing a second answer
  UI.
- **Messages are sent through the Conversation tab's reply box.** Use the same API call and
  queueing behavior it uses. Find the send path in `TranscriptPanel.tsx` / the composer, and
  reuse it rather than calling an endpoint directly.
- **For the latest message,** use the text the session's Board card or rail row already shows
  for latest activity, if one exists. Otherwise use the tail of the transcript, which the
  Conversation tab already loads. Do not add a new transcript fetch per card. Only the selected
  card shows it.
- **Phase 1's `ResidentDrawerCardBody` is where this phase works.** Add content inside it, and
  keep the Open, Run now and Pause / Resume actions Phase 1 put there.
- **Inherited from Phase 1, do not change:**
  - `ResidentsDrawer.tsx`: its structure, card list and selection behavior
  - the drawer's selected-resident state
  - `openResidentDetail`
  - `src/web/lib/resident-placement.ts`
  - the UI config fields `residentPlacement` and `residentDrawerPinned`

## 5. Implementation steps, in order

1. **Pending ask.** In `ResidentDrawerCardBody`, when the selected resident has a pending review,
   render that review through `ReviewCard`, with the same props `AttentionInbox` passes. Its
   options become buttons, and resolving them calls the existing `api.resolveReview` path. A
   `request_input` ask that the Conversation tab renders as options gets the same treatment
   through the component the Conversation tab uses.
2. **Latest message.** With no pending ask, render the latest message preview: one to three
   lines, clamped, with no new fetch beyond what is already loaded for the session.
3. **Reply box.** A one-line reply box labeled **Reply to <name>**:
   - `⌘⏎` sends through the Conversation reply path, and Escape blurs the box.
   - It respects the same `canMessage(session)` predicate the composer uses. When messaging is
     not possible, the box is not drawn.
   - After a send, the box clears and the card keeps its selection.
4. **Keyboard.** Focus inside the reply box must not trigger the drawer's arrow-key selection or
   `⌥N`. Phase 1's `⌥N` arm already ignores typing targets; verify it.
5. **CSS.** Styles for the preview and the reply box inside `.residents-drawer`. The modal inset
   comes from the shell, so do not re-declare horizontal padding on children.
6. **Docs.** Add quick reply and answering to `docs/residents.md`, "The Residents drawer".

## 6. Data and compatibility

None. Phase 2 adds no persisted state, schema or endpoint.

## 7. Tests and verification

- **e2e:** a new `e2e/specs/residents-drawer-reply.spec.ts`, using fake agents and the same
  resident setup as `residents-drawer.spec.ts`:
  - A resident made to need you through `askResident()` (`POST /mcp/reviews`) shows the question
    and its options in the drawer.
  - Choosing an option resolves the review, and the visitor card and amber state clear.
  - The reply box sends a message that then appears in the resident's Conversation tab.
- **Unit tests:** a `renderToStaticMarkup` test for `ResidentDrawerCardBody`, covering the three
  states: pending ask, latest message only, and messaging not possible.
- **Commands:** `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## 8. Merge and exit criteria

- Source-plan acceptance criterion 3 holds in full.
- Phase 1's specs still pass unchanged.
- Every command above passes, and the docs match.

## 9. Downstream handoff

This is the last phase. Later work may extend `ResidentDrawerCardBody`, but must keep `ReviewCard`
and the Conversation send path as the only answer and send mechanisms.

## 10. Cross-phase audit record

- Checked against Phase 1's contracts. Phase 2 adds content inside `ResidentDrawerCardBody`, the
  region Phase 1 provides for it, plus CSS inside `.residents-drawer`, docs and its own tests.
- No conflict found, and Phase 1 needed no change.
- Concurrency: none. Phase 2 merges strictly after Phase 1.
- Repair round 2: the inherited-contract list no longer forbids `ResidentDrawerCardBody`; it
  names it as the region this phase fills.
