# Speech 4: the voice picker

Part of `docs/plans/voice-spoken-responses/phased-plan.md`. Source plan: `plan.md` beside this
file. "Phase n" is a phase of the voice plan. Owns the picker, audition, the download row and
the missing-voice states.

## 1. Outcome

Voice settings has a "Spoken replies" group where the operator chooses the voice, hears a
sample, and downloads the Mission Control voices. The group always says what will speak, or why
nothing will.

## 2. Entry criteria

Speech 2 and Speech 3 are merged.

## 3. Scope and non-goals

In scope: the group in Voice settings, settings search, docs and specs. Not in scope: per-agent
voices, a second model family, any new route or stored field.

## 4. Repository findings and inherited contracts

- Voice settings is `src/web/components/VoiceSettingsPanel.tsx`, built from `kb-row` rows, with
  `useVoiceConfig` for reads and patches and entries in `src/web/lib/settings-registry.ts` and
  `settings-search.ts` (merged as #1671).
- Phase 8 draws a model download as a Setup row with a progress bar, Cancel and Retry. Reuse
  its progress component rather than drawing a second one.
- The group is inline in the settings page and opens no modal.
- Inherited: `config.speech.voice`, `VoiceState.speech`, `resolveSpeechVoice`, the audition and
  stop routes (contract L); `VOICE_SPEECH_NEURAL_VOICES`, the model state and the download
  routes (contract M); the system voices in the hello (Speech 3).

## 5. Implementation steps

1. **Group.** A "Spoken replies" group directly under "When routing is unsure", drawn while the
   `voice` flag is on.
2. **Voice select.** One select labelled Voice. First option: "Automatic", followed by what it
   resolves to now. Then "Mission Control voices": F1 to F5 and M1 to M5. Then "This Mac's
   voices", only when the hello lists system voices, each with its tier (Premium, Enhanced or
   none). Choosing writes `speech.voice` through the config route. Choosing Automatic writes
   null. Choosing a Mission Control voice while the speech model is `missing` or `failed` also
   starts the download through the download route.
3. **Status line.** One sentence under the select from `VoiceState.speech`: the voice that will
   speak, or the reason nothing will, in the capability's words.
4. **Play sample.** A button that calls the audition route. While the job is live it reads Stop
   and calls the stop route. It is disabled, with the reason as its description, when
   `speech-output` is unavailable.
5. **Download row.** While the speech model is not `ready`: "Mission Control voices are not
   downloaded", the size from the manifest, the licence name with a link to what it restricts,
   and Download; then progress with Cancel; then the error with Retry. The download starts in
   two ways and no other: choosing a Mission Control voice (step 2), or pressing Download, which
   is how someone who stays on Automatic gets the Mission Control voice. Cancel, or a failure,
   leaves the choice in place, shown as not downloaded.
6. **Unavailable choice.** A stored voice that is not in the catalog (a Mission Control voice
   with no model, or a system voice this Mac does not have) is shown in the select as "<name>,
   not available" and the status line names the fix: Download, or System Settings, Accessibility,
   Read & Speak. Nothing is substituted for it.
7. **Apple voices note.** On a Mac, one line saying better Apple voices are installed in System
   Settings and that Mission Control cannot download them.
8. **Search.** Register the group's rows in the settings registry and search.
9. **Docs.** `docs/voice.md` (choosing a voice, Automatic, the download, the licence),
   `docs/ui.md`, and the manual checklist in `docs/voice.md`.

## 6. Data and compatibility

No storage beyond `config.speech.voice`, which Speech 1 added. A config restored on another
machine may name a voice that machine lacks; step 6 covers it.

## 7. Tests and verification

- `renderToStaticMarkup` tests: the select's groups for each catalog; the status line for each
  reason; the unavailable choice.
- `e2e/specs/voice-picker.spec.ts`, with `beSpeaker` and the model fixture server. With no
  model and a fake Mac hello, Automatic names the system voice. Choosing F4 saves it and starts
  the download with no further click: the row shows progress, then F4 is ready and the status
  line names it. Cancelling a download leaves F4 chosen and shown as not downloaded, with
  Download offered. On Automatic with no model, pressing Download starts the same download and
  Automatic then names F4. With the fake hello's system voice chosen, which needs no synthesis,
  Play sample reads Stop while the fake speaker is speaking and returns after `ended`; with no
  speaker it is disabled and says why. With a Linux hello the system
  group is absent. A stored system voice the hello does not list reads "not available" with the
  fix.
- Manual check on a signed build, recorded in the pull request: the final checklist in
  `phased-plan.md`.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## 8. Merge and exit criteria

A person can choose any ready voice and hear it through the same path a real ask uses. Choosing
a Mission Control voice, or pressing Download, fetches the Mission Control voices. Every state in which nothing will be spoken says so
and names the fix.

## 9. Downstream handoff

None inside this plan. A later per-agent voice reuses the select with a different stored value.

## 10. Cross-phase audit record

- The `speech` field is Speech 1's. This phase adds no stored field and no route.
- The default named by Automatic is `VOICE_SPEECH_DEFAULT_NEURAL`, F4, from contract L.
- Completion review: choosing a Mission Control voice starts the download, as the root plan
  says. The first version of this file saved the choice and waited for the Download button.
