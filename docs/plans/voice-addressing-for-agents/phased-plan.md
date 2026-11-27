# Voice addressing for agents: phased implementation

Source: `docs/plans/voice-addressing-for-agents/plan.md` (managed plan
`deccc636-b913-4507-b2cc-17f89d5b6581`). Its adopted decisions are requirements here. This task
writes the plan and schedules the phases. It ships no product code.

## Findings that shaped the phases

- The daemon owns the decisions and needs no audio. Names, routing, delivery, cards and answering
  can be built and tested by posting text, so they do not wait for the listener.
- The audio path carries the unproven parts: the recognizer's timings, microphone permission on a
  hardened build, key release, call detection. A spike proves them before those phases start.
- A spoken message must be operable at each merge. Phase 3 delivers it as a plain queued message;
  Phase 5 replaces that with the spoken turn and its notes.
- The settings store has one owner. Phase 1 declares the settings later phases read, so no later
  phase adds a field.
- A test must be able to reach the mode `listening` with no microphone. Phase 1 owns the
  listener's hello route and a fixture that sends it.
- Shell work needs a listener to supervise, and floating windows need the card component, so the
  shell phases follow both.

## Plan validation round 1

Five findings were accepted and applied across the bundle:

- **One rule for a card that is not open.** V23 said speech does not fill a card that is not
  open, while V26 and Phase 13 let an explicit answer phrase do so. The rule is now stated once,
  in V23: speech reaches a card through the open-card signal or through an explicit answer
  phrase, and through nothing else. V26 names the two signals, and Phase 13's step 3, tests and
  exit criterion refer to them.
- **Phase 9 is verified through what its prerequisites built.** Its manual check asked for a
  toast, which is Phase 6's. It now checks the queued message in the agent's conversation and
  the Recently heard route, both from Phase 3. Phase 16's manual check was corrected the same way.
- **Phase 16 follows Phase 10.** It changes the shell's listener supervisor, which Phase 10
  creates, so Phase 10 is now a direct prerequisite in the table, the graph and the task.
- **A spoken turn's notes are composed once, at delivery.** Phase 5 said both that the turn is
  created with the full text and that its notes are computed at delivery. Now the words are
  stored at submit, the notes are composed when the outbox claims the turn, and `composed_at`
  stops a retry or restart composing twice. Contract F carries the two columns and the
  signature. Phase 5 gains a migration and three tests.
- **A model is hashed again before it reads ready.** Phase 8's start-up check compared sizes and
  a stored record, which a same-size change passes. It now hashes each file against the manifest
  before reporting `ready`, with a same-size tampering test.

The same pass checked each phase's verification against what its prerequisites built, and found
two more of the second kind: the unsure card's Recently heard link sat in Phase 6, which does not
follow Phase 7, so it moved to Phase 12; and Phase 11's spec read a "status line" that could be
taken for Phase 7's indicator, so Phase 1's line at the top of Voice settings is now called the
mode line in both phases.

## Plan validation round 2

One finding was accepted and applied:

- **Phase 16's Linux claim has a required test.** The phase said the listener runs on Linux, but
  its real-recognizer test could be skipped and its Linux manual check was conditional. Phase 16
  now pins a small recognizer test model (chosen by the spike's S2) and a fixture recording, adds
  a file-input mode to the listener, and requires on Linux CI a test that loads the addon and
  transcribes the recording through the listener. Its outcome and exit criterion claim what that
  test proves. Microphone capture on a Linux desktop is stated as unverified and belongs to the
  follow-on plan, which the source plan's "Linux path" now says too.

## Pull request review

GitHub Inspector's review of the pull request raised two findings. Both were accepted and
applied.

- **A lost conversion response.** Phase 15 answered the waiting poll with the receipt and
  assumed it arrived. If it was lost, the child's next poll would re-attach the ask as a call
  after the message had been reported delivered. The conversion is now recorded on the row
  (`filed_by_voice_at`), a later convertible poll receives the same receipt, and a test drops
  the first response. Contract K and the source plan say the same.
- **CI depending on Hugging Face.** Phase 16's required recognizer test ran in the unit shards
  and downloaded its model on each run. The operator authorized one CI change: a dedicated
  Linux job that restores the model from a cache and runs that test alone. A missing addon, a
  digest mismatch and a wrong transcription fail it; a network outage can fail that one job on a
  cold cache and no unit shard.

A second review raised two more, both accepted.

- **Which pending item a bare "cancel" stops.** Phase 3 said the newest pending card and Phase
  13 said "cancel" clears the pending answer, so an answer and a routed message inside one
  window had two readings. Contract D now fixes one order: the newest pending voice action of
  any kind. Phases 3, 13 and 14 name it, and Phase 13 tests the overlap in both orders.
- **A mock-up path naming Parakeet v3.** The setup mock-up printed a v3 directory while the
  plan pins v2. It now prints a placeholder path, since Phase 8 owns the real one.

A third review raised three more, all accepted.

- **A spoken submit with the form not open.** Phase 14 said what "submit" does while a
  dashboard has the plan form open and nothing else. It is now refused when no dashboard has
  the form open, the daemon never submits its own fill state, and the fill state has stated
  ends.
- **An exit criterion that needed another phase.** Phase 15's exit named the held card, which
  Phase 6 draws and Phase 15 does not wait for. It now names the `held` outcome.
- **The Foreman hold lapsing under a held message.** Phase 5's hold ended 10 minutes after the
  card opened, while a held message can wait longer. The hold now lasts until the message is
  delivered, survives a restart, and the 10 minutes count from delivery.

A fourth review raised two more. One was accepted and one was settled by the operator.

- **An environment key used without anyone choosing a provider.** Phase 4 uses
  `OPENAI_API_KEY` or `TYPESAFE_API_KEY` whenever one is present, which sends ambiguous
  sentences and roster names to a provider for anyone who has that key set for other tools.
  Revision 10 required a selected provider. The operator was asked and reversed it on
  2026-11-23: a key alone switches the decision model on, so one variable enables it for an
  organization. This finding is therefore declined as a change of behaviour. What it did
  change: Phase 4 states the rule outright, a person can choose Off, and Voice settings names
  the provider in use and what is sent to it.
- **A late submit after a refusal.** Phase 14 refused a spoken submit when the dashboard did
  not answer in 5 seconds, but a slow dashboard could still resolve the form afterwards. Each
  submit request now carries an id that is revoked at the timeout and refused by the resolve
  route.

A fifth review raised two more, both accepted.

- **The Foreman hold reading the claim as delivery.** The third round's fix timed the hold
  from `composed_at`, which is stamped when the outbox claims a turn and before anything is
  sent. The hold now lasts while the spoken turn's row exists, which is until delivery is
  confirmed, and the 10 minutes start at `turn_delivered`.
- **A bare "<name>, answer".** Phase 6's card advertises it and Phase 13 defined only the
  form with words, and not the case of several questions with no card open. Both now open a
  question pick. Phase 6's two answer hints stay hidden until Phase 13 makes them work.

A sixth review raised one more, accepted.

- **`hotkey` missing from Phase 1's field list.** Step 2 listed the config fields with their
  defaults and left out `hotkey`, which Phase 11 writes and Phase 7 prints. The list is now
  complete and says so, with `hotkey` defaulting to the chord the selected settings mock-up
  shows.

A seventh review raised one more, accepted.

- **Plan-form fill state in the cancel order.** Phase 14 reused Phase 13's `VoiceAnswer` for a
  form's fill state, which would have put a record with no deadline into the cancel order and
  under "no, A". The fill state is now its own record, outside both, and Phase 14 tests a
  routed message, a filled form and then "cancel". Contract D also says what the order does
  hold and does not: an open `unsure` card is an entry, and a spoken submit is not.

An eighth review raised one more, accepted.

- **A keycap for a hotkey that is not registered.** Phase 7's indicators printed the keycap
  whenever a chord was configured, and Phase 1 configures one by default while Phase 11 is
  the first to register it. The keycap and each mention of the hotkey now appear only when
  the shell reports the `hotkey` capability and no `hotkeyError`.

A ninth review raised two more, both accepted.

- **Automatic with keys saved for both providers.** Phase 4 said "the provider of a saved
  key" and could store one for each. Automatic now follows a fixed order: a saved OpenAI
  Decisions key, a saved Jev key, then the two environment variables in the same order.
- **"Both prerequisites" in a mock-up.** The setup mock-up's note said both where the plan
  requires three previews. It now says all three.

## Sizing and phase count

Estimated 8,800 to 11,400 non-test implementation lines across shared contracts, the daemon, the
MCP child, the dashboard, the Electron shell, two native addons and a Swift helper. One reviewable
pull request holds a few hundred. A spike and sixteen phases:

| Phase | File | Delivers | Depends on | Runs on | Est. lines |
| --- | --- | --- | --- | --- | --- |
| 0 | `phase-0-spike.md` | Measured answers for the audio, permission, hotkey, call and model-step unknowns | this plan merged | Astra | 300 to 500 |
| 1 | `phase-1-flag-state-and-settings.md` | Flag, voice config, voice state, Voice settings, Setup family | inbox 1, filed 1 | Opus | 500 to 650 |
| 2 | `phase-2-spoken-names.md` | Call sign, reference name, validation, registry, roster panel | 1 | Opus | 600 to 750 |
| 3 | `phase-3-utterance-router.md` | Utterance route, deterministic router, cancel window, Recently heard buffer | 2 | Astra | 650 to 800 |
| 4 | `phase-4-model-rungs.md` | Decision providers, key entry, Haiku or Luna rung, split or mention | 0, 3 | Opus | 550 to 700 |
| 5 | `phase-5-spoken-delivery.md` | Spoken turn with notes, delivery outcomes, stop, Foreman hold | 3, inbox 3, filed 1 | Opus | 600 to 750 |
| 6 | `phase-6-confirmation-and-outcome-cards.md` | Confirmation toast, outcome cards, placement setting | 4, 5 | Opus | 500 to 650 |
| 7 | `phase-7-indicators-and-recently-heard.md` | Five in-window indicators, Recently heard table | 3 | Opus | 500 to 600 |
| 8 | `phase-8-model-download-and-setup.md` | Model manifest, download and verify, Setup rows, input device | 0, 1 | Opus | 500 to 650 |
| 9 | `phase-9-listener-helper.md` | Listener directive and the FluidAudio backend | 0, 3, 8 | Astra | 600 to 800 |
| 10 | `phase-10-shell-and-tray.md` | Supervision, microphone permission, signing, tray glyphs | 9 | Opus | 550 to 700 |
| 11 | `phase-11-hotkey-and-calls.md` | Hotkey, call auto-mute, push-to-talk | 10 | Opus | 500 to 650 |
| 12 | `phase-12-floating-surfaces-and-ask-aloud.md` | Pill, tray popover, Recently heard popover, ask aloud | 6, 7, 10 | Opus | 450 to 600 |
| 13 | `phase-13-answer-cards-by-voice.md` | Open-card report, voice answers, countdown footer, hints | 6 | Opus | 650 to 800 |
| 14 | `phase-14-plan-forms-and-inbox-actions.md` | Plan forms by voice, spoken inbox actions | 13, filed 2, inbox 4, 5, 7 | Opus | 650 to 800 |
| 15 | `phase-15-question-conversion.md` | Converting a blocking question | 5 | Astra | 300 to 400 |
| 16 | `phase-16-sherpa-onnx-backend.md` | The portable listener backend | 9, 10 | Astra | 400 to 550 |

"Inbox n" and "filed n" are phase tasks of the two prerequisite plans. "Opus" is Claude Opus 5.5
at extra-high effort, for a phase with a UI part. "Astra" is GPT-6 Astra at extra-high effort.

Why not fewer:

- 0 stands alone because its output is numbers and choices, not product code.
- 1 and 2: a flag and settings store against a migration, two forms and a registry.
- 3, 4 and 5 are the router's three risks: the pause rule, outside model calls with a stored key,
  and the pending-turn outbox. Each needs its own review.
- 6 and 7 are both dashboard work with no shared code; together they pass 1,000 lines.
- 8 and 9: a download the Linux CI can test, against a Swift program that builds on macOS alone.
- 10, 11 and 12 are shell work split by risk: signing, native addons, new windows.
- 13 and 14: single cards auto-submit and forms do not; 14 also waits on five prerequisite tasks.
- 15 changes the MCP child and the review channel and would hold delivery behind that review.
- 16 is a second backend that the first release does not need.

Why not more: each phase is one slice with its own storage, routes, UI and specs.

```mermaid
graph LR
  P[plan merged] --> P0[0 spike]
  I1[inbox 1] --> P1[1 flag, state, settings]
  F1[filed 1] --> P1
  P1 --> P2[2 names]
  P2 --> P3[3 router]
  P0 --> P4[4 model rungs]
  P3 --> P4
  P3 --> P5[5 delivery]
  I3[inbox 3] --> P5
  F1 --> P5
  P4 --> P6[6 cards]
  P5 --> P6
  P3 --> P7[7 indicators]
  P0 --> P8[8 model download]
  P1 --> P8
  P8 --> P9[9 listener]
  P3 --> P9
  P0 --> P9
  P9 --> P10[10 shell and tray]
  P10 --> P11[11 hotkey and calls]
  P6 --> P12[12 floating surfaces]
  P7 --> P12
  P10 --> P12
  P6 --> P13[13 answer cards]
  P13 --> P14[14 forms and inbox actions]
  F2[filed 2] --> P14
  I4[inbox 4, 5, 7] --> P14
  P5 --> P15[15 conversion]
  P9 --> P16[16 sherpa-onnx]
  P10 --> P16
```

## Concurrency and merge order

- 0 runs beside 1 and 2. 8 runs beside 2 to 7 once 0 and 1 have merged.
- After 3: phases 4, 5 and 7 may run together.
- After 6: phase 13 runs beside the shell phases 10 to 12.
- 15 runs beside anything that is not its prerequisite. 16 runs beside 11 to 15 once 10 has
  merged.
- Phases that run together edit `src/server/routes.ts`, `src/shared/types.ts`,
  `src/web/useEventStream.ts`, `src/web/components/SettingsPage.tsx` and `docs/voice.md` in
  different places; the later one rebases. A phase that adds a migration (2, 5 and 15) takes
  the next schema number at merge time, as the sibling plans do.

## Cross-phase contracts

Names are fixed here. A phase file refers to a contract by its letter and does not restate it.
Where a phase file and a `mockup-*.html` page differ, the mock-up shows the adopted look and the
phase file decides behaviour.

**A. Flag and settings (Phase 1).** `VOICE_FLAG = "voice"` and `VOICE_REQUIRED_FLAGS` (the
`async-input`, `inbox` and `filed-plan-decisions` ids) in `src/shared/voice.ts`. `VoiceConfig`, the
`voice` app-config entry: `muted`, `hotkey` (a chord string, default `ctrl+alt+m`, or null),
`autoMuteDuringCalls`, `cancelWindow { enabled,
seconds }`, `whenUnsure` (`show` or `ask`), `planFormsByVoice`, `inputDevice`, `decisionProvider`
(null for automatic, `off`, `openai` or `jev`), `backend`. Routes `GET` and `PUT
/api/voice/config`. `ui.voice` in the UI config: `confirmation`
(`pill`, `toast` or `popover`) and `indicators` (a list of indicator ids). Later phases read and
write these fields and add none.

**B. Voice state (Phase 1).** `VoiceState { mode, reasons, capabilities, hotkeyError, model,
roster }`. Modes:
`off`, `unavailable`, `listening`, `muted`, `auto-muted`, `push-to-talk`. Reasons: `flags` (a
required flag is off), `listener` (no hello in the last 30 seconds), `model` (the listener's hello
says no model is loaded), `microphone` (a hello or a shell report says access is denied).
Capability ids: `listener`, `microphone`, `hotkey`, `call-detection`, `speech-output`, `tray`,
`floating-windows`. `model` is a `VoiceModelState` with statuses `missing`, `downloading`,
`verifying`, `ready`, `failed`. The pure rule `voiceMode(inputs)` decides the mode. The snapshot
field `voice` and the event `voice_state` exist while the flag is on. `POST /api/voice/mute {
muted }`. `POST /voice/listener/hello { backend, version, devices, modelLoaded, microphone }`
(token), sent every 10 seconds by a listener. `POST /voice/shell-report` (token) carries
capabilities, microphone permission, `callActive`, `pushToTalk` and `hotkeyError`; a report lapses
15 seconds after the last one. The capabilities a shell reports and its `hotkeyError` (null, or
`{ reason, chordInForce }`) are copied into the state from the latest report, which is how a
dashboard learns of them; with no report those capabilities are absent and `hotkeyError` is
null. `e2e/fixtures/voice.ts` exports `beListener`, which sends hellos so a spec sees the mode
`listening` on any platform.

**C. Names (Phase 2).** `Task.callSign` and `TaskSummary.callSign`; `identity.referenceName` on a
resident profile; `validateSpokenName(name, roster)`, `phoneticKey(name)` and
`VOICE_CONTROL_WORDS` in `src/shared/voice-names.ts`; `SpokenName { key, name, kind, taskId,
sessionId, role, colorId, agent, state }` with key `resident:<profileId>` or `task:<taskId>` and
state `running`, `hibernated` or `not-running`. Phase 2 fills `VoiceState.roster` and emits
`voice_roster`.

**D. Utterances, routing and cards (Phase 3).** `POST /voice/utterances` (token) takes
`VoiceUtterance { id, text, words: [{ text, startMs, endMs }], capturedAt, backend }` and accepts
it while the mode is `listening` or `push-to-talk`. `routeUtterance(utterance, context)` in
`src/shared/voice-routing.ts` returns `control`, `addressed`, `needs-model` or `ignored`.
`VoiceCard { id, state, parts, deadline, candidates, reason, openQuestions }` with states
`pending`, `resolving`, `unsure`, `sent`, `queued`, `held`, `not-running`, `cancelled`, `failed`;
a part is `{ target, text }` and a split has two. A candidate is `{ kind, id, title, detail }`:
`kind` is `agent` in Phases 3 and 4, with a roster key as its id, and Phase 13 adds `question`,
with a review id. Event `voice_card`. Routes `POST
/api/voice/cards/:id/cancel`, `/send-now` and `/pick`. The `VoiceDeliverer` interface. `GET` and
`DELETE /api/voice/heard` with `HeardEntry`. `say` in `e2e/fixtures/voice.ts`.

One cancel order. The router keeps every voice action that a "cancel" can still stop in one
list, `pendingVoiceActions`, in the order they opened; an entry is `{ id, kind, openedAt,
cancel }`. A bare "cancel" stops the newest entry and nothing else, whatever its kind, and each
further "cancel" stops the next newest. With the list empty it does nothing and is listed in
Recently heard. Phase 3 registers pending cards, and a split is one entry. Phase 13 registers a
pending voice answer, together with its companion card when it has one, as one entry. Phase
14's inbox actions are pending cards, so they are entries already. An open `unsure` card, a
question pick included, is an entry with no deadline: "cancel" closes it and nothing is sent.
A Cancel button stops its own entry, not the newest. Two things are never entries: a plan
form's fill state (`VoiceFormFill`, Phase 14), which has no window and is changed by saying
the decision again, and a spoken submit of a plan form, which is the confirmation itself.

**E. Model step (Phase 4).** `VoiceDecider.ask(questions)` with question kinds `who`, `split` and
`option`, each answered with a choice and a confidence. Rungs in order: the effective decision
provider, the `voice-routing` background job, none. `effectiveDecisionProvider(config, env)`
names the provider: none when the setting is `off`; the one chosen in Voice settings; and with
the setting null, the first key present in a fixed order (saved OpenAI Decisions, saved Jev,
`OPENAI_API_KEY`, `TYPESAFE_API_KEY`), so a key in the environment alone switches it on (the
operator's decision of 2026-11-23). Key routes `GET`, `PUT` and `DELETE
/api/voice/decision-key`, where `PUT` and `DELETE` name the provider whose key they change;
`GET` reports the effective provider and, for each provider, its key's source (`settings`,
`environment` or none), and does not return a key.

**F. Spoken turns (Phase 5).** `VOICE_TURN_PREFIX`, `spokenMessageText(words, notes)` and
`openQuestionsNote(asks)` in `src/shared/voice-delivery.ts`;
`PendingTurnManager.submitSpoken(sessionId, words, utteranceId)`, which stores the words and
composes the notes once, when the turn is claimed for delivery; the `pending_turns` columns
`spoken_words` and `composed_at`; the delivery outcomes `sent`, `queued`, `held`, `not-running`,
`failed`; `voiceHold(sessionId)`, which is true while a card is pending for the session, while a
spoken turn's row exists for it in any state (the row is deleted when delivery is confirmed),
and after confirmed delivery until the receiving turn finishes, including across daemon restarts.
The operator selected turn completion as the release condition, with no time limit. `composed_at`
marks the claim, not delivery, and the hold does not read it.

**G. Card component (Phase 6).** `VoiceCardView` draws one `VoiceCard`. `VoiceCardHost` shows it
as a toast when `ui.voice.confirmation` is `toast` or the `floating-windows` capability is
unavailable. The dashboard routes `#/voice/pill` and `#/voice/popover` are reserved for Phase 12.

**H. Models and setup (Phase 8).** `VOICE_MODELS` in `src/shared/voice-models.ts`, keyed by
backend (`fluidaudio`, `sherpa-onnx`); the manager that drives contract B's `VoiceModelState`;
files under `<state home>/voice/models/<backend>/<revision>/`; routes `POST` and `DELETE
/api/voice/model/download`; Setup ids `voice-previews` (Phase 1), `voice-model` and
`voice-microphone`.

**I. Listener protocol (Phase 9).** A listener is a standalone program given
`MISSION_VOICE_DAEMON_URL`, `MISSION_VOICE_TOKEN_FILE` and `MISSION_VOICE_MODEL_DIR`. It sends
contract B's hello, long-polls `GET /voice/listener/directive` for `{ capture, roster,
inputDevice, pauseMs, revision }`, and posts contract D's utterances.

**J. Open cards and voice answers (Phase 13).** `PUT /api/voice/open-cards { windowId, focused,
cards: [{ kind, id, focused }] }`; `VoiceAnswer` and the event `voice_answer`;
`optionLetter(index)`; `CardVoiceFoot`. Phase 14 adds `VoiceFormFill { reviewId, selections }`
and the event `voice_form_fill` for plan forms. It is not a `VoiceAnswer`: no deadline, no
entry in the cancel order, and not a target for "no, A".

**K. Conversion (Phase 15).** The wait poll's `convertible=1` query, the response field
`converted { receipt }`, `ReviewManager.convertToFiled(reviewId)`, and the `reviews` column
`filed_by_voice_at`, which makes a later convertible poll receive the same receipt.

Token routes live under `/voice/` and check `x-harness-token`. Dashboard routes live under
`/api/voice/` behind the loopback gate. Both answer 404 while the flag is off.

## Requirement ownership

| Phase | Requirements |
| --- | --- |
| 1 | V38, V39 |
| 2 | V1, V2, V3, V32 |
| 3 | V5, V9, V11, V12, V36 |
| 4 | V13, V15, V44 |
| 5 | V17, V18, V19, V20, V21, V22, V24, V30 |
| 6 | V16, V40 (toast and the setting) |
| 7 | V41, V43 (table) |
| 8 | V35, V46 |
| 9 | V10, V34 |
| 10 | V4, V8 |
| 11 | V6, V7, V37 |
| 12 | V14, V40 (pill and popover), V43 (popover) |
| 13 | V23, V26, V27, V28, V33 |
| 14 | V29, V42 |
| 15 | V25 |
| 16 | V45 |

V31 needs no work: nothing in this plan reads a report aloud or switches the dashboard. Phase 0
owns no requirement; it supplies the measured values phases 4, 8, 9, 10, 11, 12 and 16 read from
`docs/voice-spike-findings.md`.

## Not scheduled here

- **Voice on Linux.** A follow-on plan task, "Voice Addressing on Linux Phased Plan", is created
  in the backlog behind Phase 16. It covers a daemon-run listener, microphone capture on a Linux
  desktop, a hotkey and call detection.
- Moving `voice` to `default-on` and retiring it, which `docs/feature-flags.md` makes separate
  pull requests.

## Final verification

With the phases merged and the four flags on: `npm run typecheck`, `npm run lint`, `npm run
build`, `npm run smoke`, `MISSION_TEST_CONCURRENCY=4 npm test`, `npm run test:electron` and `npm
run test:e2e`. Then the manual checklist in `docs/voice.md` on a signed build: speak to a
resident, cancel, mute by hotkey and tray, join a call, push to talk, answer a card. With the
`voice` flag off, specs that predate this work pass unchanged.

## Final cross-phase audit

- Each requirement V1 to V46 has one owner above, except V40 and V43, which name two surfaces and
  give each surface one owner.
- Each contract A to K has one owning phase, and its consumers depend on that phase directly or
  through the graph.
- Phases that may run together (4, 5, 7; 13 beside 10 to 12; 15; 16 beside 11 to 15) consume no
  contract owned by one another.
- Phase 3 leaves spoken messages working as plain queued messages, so phases 4 to 7 each merge
  onto an operable repository in any order the graph allows.
- The settings fields in contract A cover what phases 4, 6, 7, 8, 11, 12, 14 and 16 read.
- A spec reaches the mode `listening` through `beListener` from Phase 1 on, so no spec depends on
  a microphone, a model or macOS.
- After the final approval round: the not-running card for a resident carries a Relaunch button,
  stated in the source plan's adopted decisions and in Phase 6.
- After plan validation round 1: each of the five rules above reads the same in the source plan,
  the contracts and the phase that owns it, and each phase's verification uses surfaces its own
  prerequisites built.
