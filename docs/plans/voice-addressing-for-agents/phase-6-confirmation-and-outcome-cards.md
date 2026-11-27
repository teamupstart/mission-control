# Phase 6: confirmation and outcome cards

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V16 and the toast and setting halves of V40. Mock-ups:
`mockup-confirmation-card.html` (variant A), `mockup-routing-exceptions.html`.

## 1. Outcome

The dashboard shows what voice is doing: a toast that counts down and can be cancelled, then says
what happened, and roster rows when routing is unsure or the agent cannot take the message.

## 2. Entry criteria

Phases 4 and 5 are merged.

## 3. Scope and non-goals

In scope: contract G, the chime, the placement setting with previews, docs and specs. Not in
scope: the pill and popover windows and ask aloud (Phase 12), voice answers on question cards
(Phase 13).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- The app has no toast component; `src/web/lib/chime.ts:51` plays tones and
  `src/web/useNotifier.ts:17` raises desktop notifications.
- Resident colour comes from `residentAccentStyle` (`src/web/residents/marker.ts:168`).
- A resident profile is launched with `POST /api/residents/profiles/:id/launch`
  (`src/server/routes.ts:9607`). A queued turn is recalled with `POST
  /api/sessions/:id/pending-turns/:turnId/recall` (`:6736`).
- Inherited: `VoiceCard` and its routes (contract D), the outcomes (contract F), `ui.voice`
  (contract A), capabilities (contract B).

## 5. Implementation steps

1. **Card.** `VoiceCardView` draws each state of a `VoiceCard`:
   - `pending`: "To <name>" in the board colour, the text, a draining bar, the seconds, Cancel and
     Send now, and the hint: Say "cancel" to stop;
   - `resolving`: "Working out who this is for";
   - `unsure`: "Who is this for?", the words as heard, one roster row per candidate (name, role,
     live state); a row is a button; Cancel, which closes the card and sends nothing; the hint
     says to say the name again or click a row, or say "cancel";
   - `sent` and `queued`: "Sent to <name>", or "Queued behind his current turn"; when the agent
     has open questions, the count and the hint: Say "<name>, answer" to reply to one;
   - `held`: "Held for <name>", the row, the question it waits behind, Open question, Cancel
     message (which recalls the queued turn), the hint: Say "<name>, answer: ..." to answer it,
     and the sentence "<name>'s session started before this was possible, so the question cannot
     be set aside. Your message is delivered once it is answered.";
   - `not-running`: "<name> isn't running" and "Nothing was sent". For a resident, a Relaunch
     <name> button that launches the profile through the launch route, with the line "Relaunch
     him, then say it again." For a finished session, the line "Completed sessions are not
     resumed." and a Start a follow-up task button that opens the dispatch form on that task's
     repository;
   - a two-part card lists both messages; Cancel stops both. A mention says the second agent is
     mentioned and nothing is sent to it;
   - `cancelled` and `failed` say so.
   The two answer hints, on the sent or queued card and on the held card, are drawn through the
   inbox plan's `SpokenHint`. Its voice-hints context is off until Phase 13 turns it on, so
   they render nothing in this phase and appear when the phrases they name work. The other
   hints name phrases that work already and are drawn directly.
   Settled states fade after a few seconds. The card is a live region, so a screen reader
   announces it.
2. **Host.** `VoiceCardHost` at the app root shows the newest cards as a toast stack in the
   bottom-right corner when contract G's rule selects the toast. When the window is not focused
   and the toast is selected, a desktop notification repeats the pending card's words.
3. **Chime.** A soft tone when a card becomes `pending`, through the existing chime module and its
   Sound setting.
4. **Setting.** A "Confirmation card" group in Voice settings: three choices, each with a small
   static preview. The pill and the popover read "Needs the desktop app" until the
   `floating-windows` capability is available.
5. **Routes.** Reserve the dashboard hashes `#/voice/pill` and `#/voice/popover`; each renders
   `VoiceCardView` alone on a transparent page.
6. **Docs.** `docs/voice.md`, `docs/ui.md`.

## 6. Data and compatibility

No storage beyond `ui.voice.confirmation`. With the flag off no host is mounted.

## 7. Tests and verification

- `renderToStaticMarkup` tests for each card state.
- `e2e/specs/voice-confirmation-card.spec.ts`, with `confirmation` set to `toast`:
  - say "Steve, check the build"; the toast names Steve and counts down; after the window it
    reads Sent to Steve and the fake agent's conversation has the message;
  - say it again and click Cancel; nothing is delivered;
  - say "cancel" by voice during the window; nothing is delivered;
  - with the window off, the message is delivered at once.
- `e2e/specs/voice-outcome-cards.spec.ts`: an unsure card with two rows, picked by a click and by
  saying the name; a resident with no run shows "isn't running" and Relaunch starts it; a session
  blocked inside a question shows the held card and Cancel message removes the queued message; a
  two-part card.
- `e2e/specs/voice-confirmation-setting.spec.ts`: the three previews render and the choice
  persists.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the specs.

## 8. Merge and exit criteria

Each `VoiceCard` state has a drawn form and a spec. Cancel by click and by voice both stop
delivery.

## 9. Downstream handoff

Phase 12 loads the two reserved routes in shell windows. Phase 13 reuses the draining bar and the
Cancel and Submit now pair for the countdown footer.

## 10. Cross-phase audit record

- After Phase 12: the host shows no toast while the pill or popover is selected and the
  `floating-windows` capability is available, so a card is drawn in one placement.
- After Phase 15: the `held` card is drawn as written here; that phase changes how often it
  occurs and no copy.
- After the final approval round: a resident that is not running gets a Relaunch button, as the
  selected mock-up shows, where the inbox plan's report card uses a sentence.
- Plan validation round 1: the unsure card's Recently heard link moved to Phase 12, the first
  phase that follows both this card and the Recently heard surfaces.
- Pull request review, fifth round: the answer hints named phrases that Phase 13 adds. They go
  through `SpokenHint`, so they are hidden until Phase 13, which also defines the bare
  "<name>, answer" and adds a question row to `VoiceCardView` for its question pick.
