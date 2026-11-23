# Phase 12: floating surfaces and ask aloud

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V14 and the pill, popover halves of V40 and V43. Mock-ups:
`mockup-confirmation-card.html` (variants B and C), `mockup-recently-heard.html` (variant B).

## 1. Outcome

The confirmation card can float over any app as a pill or hang off the tray icon, Recently heard
opens from the tray, and Mission Control can ask aloud when routing is unsure.

## 2. Entry criteria

Phases 6, 7 and 10 are merged.

## 3. Scope and non-goals

In scope: two shell windows, the Recently heard popover, speech output, docs and tests. Not in
scope: new card states or router rules.

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- Window precedents: `src/main/startup-notice-window.ts:12-27` (kept on top) and
  `src/main/window.ts:101-130` (the main window and its preload). No frameless or tray-anchored
  window exists.
- Inherited: the reserved routes and `VoiceCardView` (contract G), the shell's card state (Phase
  10), the Recently heard routes and row formatter (contract D, Phase 7), `whenUnsure` and
  `ui.voice.confirmation` (contract A), the pick-by-name rule (Phase 3), the directive (contract
  I), the spike's S9.

## 5. Implementation steps

1. **Pill window.** `src/main/voice-pill-window.ts`: a frameless, transparent window kept on top
   that does not take focus, shown under the menu bar at the centre of the display with the
   pointer, loading `#/voice/pill`. It is shown while a card is live and hidden otherwise. Clicks
   outside the pill pass through.
2. **Popover window.** `src/main/voice-popover-window.ts`: a frameless window anchored under the
   tray icon's bounds, loading `#/voice/popover`. It shows the live card when the placement is
   `popover`, and Recently heard when opened from the tray menu's Recently Heard row.
3. **Placement.** The shell reports the `floating-windows` capability. The dashboard's host then
   draws no toast while the pill or popover is selected (contract G). Long text is truncated in
   the pill with the full text in its accessible name.
4. **Recently heard popover.** The popover page lists recent entries in compact rows with the
   reason, the mode line, Clear and the privacy line.
5. **Ask aloud.** When `whenUnsure` is `ask` and a card becomes `unsure`, the shell speaks "<name>
   or <name>?" with the macOS system voice and reports `speech-output`. The directive's `capture`
   is false while it speaks. The card stays on screen in the selected placement, marked as asking,
   and the answer is the candidate's name (Phase 3's pick rule) or a click.
6. **Setting.** The "When routing is unsure" row gains Ask aloud as an enabled choice when the
   `speech-output` capability is available; the placement previews drop "Needs the desktop app".
7. **Docs.** `docs/voice.md`, `docs/ui.md`, `docs/desktop-and-packaging.md`.

## 6. Data and compatibility

No storage. In a browser, or with the shell absent, the capability is unavailable and the toast
and on-screen rows are used.

## 7. Tests and verification

- `test/voice-windows-electron.test.ts`: the pill is frameless, kept on top, non-focusable and
  positioned under the menu bar; the popover is anchored to given tray bounds; both hide when no
  card is live.
- `test/voice-ask-aloud.test.ts`: the sentence built for two and three candidates; capture paused
  and resumed around speech, with a fake speaker.
- `e2e/specs/voice-pill-route.spec.ts`: open `#/voice/pill` and `#/voice/popover` in a browser;
  say a sentence; each shows the card and its countdown; Cancel works; the popover's Recently
  heard view lists it.
- `e2e/specs/voice-placement.spec.ts`: with a fake shell report offering `floating-windows` and
  the pill selected, the dashboard shows no toast.
- Manual check, recorded in the pull request: the pill appears over another app while the window
  is minimized; ask aloud speaks and a spoken name picks.

## 8. Merge and exit criteria

A card is drawn in one placement. The pill works with the window minimized. Ask aloud speaks once
per unsure card and does not hear itself.

## 9. Downstream handoff

None inside this plan. The Linux follow-on leaves `floating-windows` unavailable.

## 10. Cross-phase audit record

- If S9 finds that pausing capture does not stop the listener hearing the system voice, ask aloud
  ships off by default and the finding is recorded in `docs/voice.md`.
