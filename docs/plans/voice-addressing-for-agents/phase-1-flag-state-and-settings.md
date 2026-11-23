# Phase 1: flag, voice state and settings

Part of `docs/plans/voice-addressing-for-agents/phased-plan.md`. Source plan: `plan.md` beside
this file. Owns V38 and V39. Mock-ups: `mockup-voice-settings.html`,
`mockup-enable-and-download.html`.

## 1. Outcome

A `voice` preview flag exists. With it on, Settings has a Voice category, the Setup panel has a
Voice family whose first row turns on the prerequisite flags, and the daemon publishes a voice
state that reads "unavailable" until a listener says hello.

## 2. Entry criteria

Inbox Phase 1 (`INBOX_FLAG`) and filed Phase 1 (`FILED_PLAN_DECISIONS_FLAG`) are merged.

## 3. Scope and non-goals

In scope: contracts A and B, the behaviour rows of Voice settings, the Setup family and its
`voice-previews` row, the listener fixture, docs and specs. Not in scope: names and the roster
(Phase 2), the rows for placement, indicators, the key, the hotkey and the input device (phases 6,
7, 4, 11 and 8), any audio.

## 4. Repository findings and inherited contracts

As of `2088bd522`:

- Flags are declared in `src/shared/feature-flag-registry.ts`; gates are `featureEnabled` and
  `requireFeature` (`src/server/feature-flags/index.ts:63`, `:80`) and `useFeatureFlag`. A flag
  cannot require another.
- A settings category is an entry in `SETTINGS_CATEGORIES` (`src/web/lib/settings-registry.ts:102`)
  with an optional `flag`, drawn by `renderCategory` in `src/web/components/SettingsPage.tsx:582`.
- Daemon settings are schema-checked blobs in `app_config`, as `src/server/llm/config.ts` shows; UI
  settings are `UiConfigSchema` (`src/shared/protocol.ts:4493`).
- Setup families and remedy kinds are fixed lists (`src/shared/setup-catalog.ts:46-55`, `:215-230`);
  probes are in `src/server/setup/index.ts:488`.
- A flag-gated snapshot field follows `shaping` (`src/server/registry.ts:1412`), and the event
  switch in `src/web/useEventStream.ts` is exhaustive.
- A token-checked route follows `POST /hooks/:event` (`src/server/routes.ts:5026-5031`).

## 5. Implementation steps

1. **Flag.** `src/shared/voice.ts` with contract A's constants; the registry entry, labelled
   "Voice addressing", stage `preview`.
2. **Config.** The `voice` app-config entry with contract A's fields and defaults (`muted` false,
   `autoMuteDuringCalls` true, `cancelWindow` on at 4 seconds, `whenUnsure` `show`,
   `planFormsByVoice` true, `inputDevice` `built-in`, `decisionProvider` null, `backend` `auto`;
   `decisionProvider` accepts null, `off`, `openai` or `jev`),
   its routes, and `ui.voice` (`confirmation` `pill`, `indicators` holding `status-line`).
3. **State.** `voiceMode(inputs)` in `src/shared/voice.ts`: off when the flag is off; unavailable
   when a reason holds; then muted; then, during a call with auto-mute on, push-to-talk while held
   and auto-muted otherwise; else listening. A server `VoiceStateStore` computes contract B's
   state from the flags, the config, the latest hello and the latest shell report, with the
   reasons as contract B defines them, and publishes the snapshot field and `voice_state`. `roster`
   is empty and `model` is `missing` until phases 2 and 8 drive them.
4. **Routes.** `POST /api/voice/mute`, `POST /voice/shell-report` and `POST
   /voice/listener/hello`. A hello carries a protocol version; one with an unknown major version
   is refused with 409 and the state says why.
5. **Settings.** A `voice` category gated on the flag. Rows: auto-mute during calls, cancel window
   (switch and seconds), when routing is unsure, plan forms by voice. A mode line at the top
   of the category prints the mode and, when unavailable, the reasons with a link to Setup.
6. **Setup.** A `voice` family; the dependency `voice-previews`, optional, whose probe passes when
   the required flags are on; a new remedy kind `feature-flags` whose Fix button turns them on
   through `PUT /api/feature-flags`.
7. **Fixture.** `e2e/fixtures/voice.ts` with `beListener(daemon)`, which sends a hello with a
   loaded model and granted microphone every few seconds under the token.
8. **Docs.** A new `docs/voice.md`, linked from `docs/README.md`; the flag in
   `docs/feature-flags.md`; the family in `docs/setup.md`.

## 6. Data and compatibility

No SQL migration. With the flag off the routes answer 404, the snapshot has no `voice` field and
no category or family is drawn.

## 7. Tests and verification

- `test/voice-state.test.ts`: `voiceMode` for each mode and reason; a hello and a shell report
  lapsing; a refused protocol version.
- `test/voice-config-http.test.ts`: defaults, a patch, the flag-off 404.
- `test/feature-flags.test.ts` and the setup catalog tests cover the new entries.
- `e2e/specs/voice-flag-and-settings.spec.ts`: the flag row toggles; the Voice category appears;
  changing the cancel window persists across a reload; the Setup row's Fix turns the three flags
  on and the row passes; the mode line reads unavailable, then listening once `beListener` runs.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

The flag toggles live. Contract A's fields round-trip. `voice_state` reaches a second window. With
the flag off nothing changed.

## 9. Downstream handoff

Later phases rely on contracts A and B as written and add no config field. A phase that needs a
new capability id adds it to the list in `src/shared/voice.ts`.

## 10. Cross-phase audit record

- Written after Phase 0. The config holds the fields phases 4, 6, 7, 8, 11, 12, 14 and 16 read, so
  none of them changes the schema.
- The hello route is here, not in Phase 9, so specs from Phase 3 on can reach `listening`.
