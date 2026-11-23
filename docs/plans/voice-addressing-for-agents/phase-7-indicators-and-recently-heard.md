# Phase 7: in-window indicators and Recently heard

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V41 and the table half of V43. Mock-ups: `mockup-dashboard-indicator.html`,
`mockup-recently-heard.html` (variant E).

## 1. Outcome

The dashboard shows the voice mode in the styles the operator ticks, each of which can mute, and
Voice settings has a diagnostic table of what was heard.

## 2. Entry criteria

Phase 3 is merged. May run beside phases 4, 5 and 6.

## 3. Scope and non-goals

In scope: five indicators, their setting with previews, the Recently heard table, docs and specs.
Not in scope: the tray (Phase 10), the Recently heard popover (Phase 12).

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- The top bar's figures are `FleetPulse` (`src/web/components/Topbar.tsx:428`, segments at
  `:483-549`), fitted to one row by `src/web/topbarLadder.ts`; `e2e/specs/topbar-one-row.spec.ts`
  pins the segment count, and the inbox plan adds a to-read figure. See
  `.agents/memory/topbar-page-segment-guards.md`.
- No window-wide status line exists. A keycap is drawn by `Keycap`
  (`src/web/components/Keycap.tsx`).
- Inherited: voice state, `POST /api/voice/mute` and `beListener` (contract B),
  `ui.voice.indicators` (contract A), `GET` and `DELETE /api/voice/heard` and `say` (contract D).

## 5. Implementation steps

1. **Shared part.** `VoiceIndicatorButton`: a button whose accessible name is the mode ("Voice:
   listening. Mute"), which toggles mute, shows the hotkey's keycap when the hotkey works, and
   for `unavailable` opens Setup. One shared rule, `hotkeyShown(state, config)`, decides
   "works": the voice state's capabilities include `hotkey`, its `hotkeyError` is null, and
   the configured `hotkey` is not null. A configured chord is not enough: Phase 1 stores
   the default `ctrl+alt+m` and nothing registers it until Phase 11 reports the capability, and
   a dashboard with no desktop shell never has it. When the rule is false no indicator prints
   a keycap or names the hotkey, in text or in an accessible name. New tokens
   `--voice-listening`, `--voice-muted`, `--voice-call` and `--voice-talk` in
   `src/web/styles.css`, each set in each skin. Each mode also prints its glyph
   and word, so colour is not the one cue.
2. **Five indicators**, each mounted when its id is in `ui.voice.indicators`:
   - `status-line`: a thin line on the window's bottom edge with the mode, a hint and, when
     `hotkeyShown` is true, what the hotkey does next. Otherwise the line says what a click
     does;
   - `topbar`: a segment at the end of the pulse figures; its label drops at narrow rungs;
   - `floating`: a round button in the bottom-left corner that opens to a pill on hover or focus;
   - `edge`: a hairline on the window's top edge with a small named tab;
   - `composer`: a microphone button at the head of the message box.
3. **Setting.** An "In the window" group in Voice settings: five checkboxes, each with a static
   preview of that indicator in its four modes. None ticked is allowed.
4. **Recently heard table.** A section of Voice settings with columns for how long ago, what was
   heard (the matched name marked), the pause after the name, the match, what decided it and the
   outcome; a Clear button; the line "Kept in memory, cleared when Mission Control quits. Audio is
   not stored."; and an empty state.
5. **Guards.** Update the top-bar ladder rungs and the pinned count in
   `e2e/specs/topbar-one-row.spec.ts` for the case where the `topbar` indicator is on.
6. **Docs.** `docs/voice.md`, `docs/ui.md`.

## 6. Data and compatibility

No storage beyond `ui.voice.indicators`. With the flag off no indicator mounts and the top bar is
as it was.

## 7. Tests and verification

- `renderToStaticMarkup` tests for each indicator in each mode, with and without the hotkey
  shown.
- `test/voice-hotkey-shown.test.ts`: false with no `hotkey` capability though the default chord
  is configured; false with a `hotkeyError`; false with a null `hotkey`; true otherwise.
- A geometry test in `test/*-electron.test.ts` style for the status line: it does not cover the
  page's last row at the smallest supported window.
- `e2e/specs/voice-indicators.spec.ts`, with `beListener` running: the status line shows by
  default and reads listening; clicking it mutes and the mode reads muted in a second window;
  ticking the top-bar indicator adds a segment and the bar stays on one row; unticking the five
  removes them. With no shell report, so no `hotkey` capability, no indicator shows a keycap
  and the status line names no chord; after a shell report through `POST /voice/shell-report`
  that offers `hotkey`, the keycap reads ⌃⌥M; after one that carries a `hotkeyError`, it is
  gone again.
- `e2e/specs/voice-recently-heard.spec.ts`: say a routed sentence, a sentence with no pause and a
  cancelled one; the table lists the three with their reasons; Clear empties it.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, the specs and
  `e2e/specs/topbar-one-row.spec.ts`.

## 8. Merge and exit criteria

Each ticked indicator shows the live mode and mutes on click. No indicator names a hotkey that
is not registered. The table explains each utterance.

## 9. Downstream handoff

Phase 11 registers the hotkey and reports the `hotkey` capability, which is when the keycap
first appears. Phase 12 reuses the table's row formatter in the popover.

## 10. Cross-phase audit record

- After Phase 10: with no shell, the indicators are where the mode is shown, which is the Linux
  path the source plan describes.
- Pull request review, eighth round: Phase 1 stores a default chord that nothing registers
  before Phase 11, and this phase can merge long before that, so a keycap drawn "when one is
  set" would have told the operator to press a chord that does nothing. The keycap and each
  mention of the hotkey now wait for the shell's `hotkey` capability and no `hotkeyError`.
