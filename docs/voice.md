# Voice addressing

Voice addressing is being built in phases behind the **Voice addressing** preview flag (`voice`).
When it is finished, the operator will talk to an agent by name, with speech recognized on this
machine; the plan is in [`docs/plans/voice-addressing-for-agents/`](plans/voice-addressing-for-agents/plan.md).

Nothing is heard or routed yet: there is no routing, no cards and no audio. What exists today, and
what this page describes, is the foundation: the flag, the voice settings, the voice state that the
dashboard and later the desktop shell follow, the Voice settings category, the Voice family in
Setup, whose row turns on the previews voice needs, and [spoken names](#spoken-names): the call
signs and reference names an agent will be addressed by, and the roster of who can be addressed.

With the flag off nothing on this page is drawn: every voice route answers 404, the reconnect
snapshot has no `voice` field, and neither the Settings category, the Setup family, nor the Call
sign and Reference name fields is drawn. A call sign or reference name already saved is kept, and
names no agent until the flag is on again.

## Turning voice on

Switch **Voice addressing** on in **Settings > Feature flags**. Voice also needs three other
previews: **Ask without stopping** (`async-input`), **Reports and inbox upgrades** (`inbox`) and
**File plan decisions** (`filed-plan-decisions`). A flag cannot require another, so voice can be
on while any of them is off; it then reads as unavailable, and **Settings > Setup > Voice** has a
**Voice previews** row that names which are on and which are off. Its button turns on exactly the
ones that are off, through the same `PUT /api/feature-flags` the Feature flags panel uses. The row
is optional, so it never raises the Setup banner.

The Setup panel re-reads the machine when any flag it depends on changes in any window, so the
Voice family appears as soon as the flag is switched and the row reports the switch just made.

## Voice settings

**Settings > Voice** opens with the mode line: a dot, the mode in words and, when voice cannot
listen, every reason it cannot, with **Open Setup**. Below it is **Who you can address**, the
[roster](#who-can-be-addressed), then the behavior rows:

| Row | Field | Default |
| --- | --- | --- |
| Auto-mute during calls | `autoMuteDuringCalls` | on |
| Cancel window (switch and length) | `cancelWindow { enabled, seconds }` | on, 4 seconds |
| When routing is unsure (Show on screen or Ask aloud) | `whenUnsure` | `show` |
| Plan forms by voice | `planFormsByVoice` | on |

The settings are one `app_config` entry, `voice`, read with defaults so a field an older build
never wrote needs no migration. It holds every field the later phases read, so none of them
changes the schema:

| Field | Default | Meaning |
| --- | --- | --- |
| `muted` | `false` | Mute, by the tray, the hotkey or the dashboard. Operational: a settings restore leaves it alone |
| `hotkey` | `ctrl+alt+m` | The mute chord in the format the Keyboard panel records, or null for none. Nothing registers it yet |
| `autoMuteDuringCalls` | `true` | Stop listening while another app uses the microphone |
| `cancelWindow` | `{ enabled: true, seconds: 4 }` | How long a routed message waits for "cancel" (1 to 30 seconds) |
| `whenUnsure` | `show` | `show` the candidates, or `ask` aloud |
| `planFormsByVoice` | `true` | Whether speech may fill a plan-decision form |
| `inputDevice` | `built-in` | `built-in`, `system-default`, or a device id from a listener |
| `decisionProvider` | `null` | Null for automatic, or `off`, `openai`, `jev` |
| `backend` | `auto` | `auto`, `fluidaudio` or `sherpa-onnx` |

The settings snapshot backs them up under the `voice` domain, except `muted`.

The dashboard's half is `ui.voice` in the UI config: `confirmation` (`pill`, `toast` or
`popover`, default `pill`) and `indicators` (a list of indicator ids, default `["status-line"]`).
Nothing draws either yet. Like every voice surface it is behind the flag: with
`voice` off, `GET /api/ui/config` omits `voice` (the stored value is kept and returns with the
flag), and a `PUT /api/ui/config` that names `voice` is refused with 404 and saves nothing.

## Spoken names

An agent is addressed by a name you can say. A [resident](residents.md) answers to its profile
name, or to its **reference name** when one is set. A session answers only when its task has a
**call sign**; a task title is never a spoken name. Any other session is answered through its open
card by starting with "reply" (a later phase).

### Call signs

**Dispatch > Advanced** has a **Call sign** field for every kind, below **Persona**. It is
optional: 1 to 40 characters, trimmed, with inner spaces collapsed. Closed, the fold's summary
names it (`Persona: none · Call sign: Alice`). Reopening a backlog task reads it back, and
clearing it saves `callSign: null`. See [Dispatch and the backlog](dispatch-and-backlog.md#a-call-sign-for-the-task).

A call sign is `Task.callSign`, stored in `tasks.call_sign` (schema 50, nullable, no backfill),
and carried to the session card as `TaskSummary.callSign` while the task has one. It is
annotation, like priority: nothing is provisioned from it, so an update may set or clear it while
the agent runs. `POST /api/tasks` and `POST /api/tasks/:id/update` accept it, and so do the MCP
`create_task` and `update_task` tools; `get_task` and `list_tasks` report it.

### Reference names

A resident profile's **Identity** card has a **Reference name** field under **Description**:
what to say instead of the profile name, for a name such as "Release Captain" that is not
something to say. It is `identity.referenceName` in the profile's revision JSON, optional with no
default, so a revision saved before it existed reads exactly as before. Clearing it saves it
blank, which means none: a save that left the key out would carry the previous revision's forward.

A reference name is a spoken name, not a launch setting, so it applies as soon as it is saved,
also to a resident that is running: the roster reads the profile as it stands, and so does the
display name a card prints. Every other profile edit still applies at the next launch.

### Checking a name

Each field shows the sentence you would say, "**Alice,** check the build", with a four-step
meter under it and one line per warning. The meter lights four steps, less one per warning.
Warnings never block: Dispatch and Save stay enabled whatever they say. They come from one pure
function, `validateSpokenName(name, roster)` in `src/shared/voice-names.ts`, checked against the
other names on the roster, never against the agent's own entry:

| Warning | When |
| --- | --- |
| `control-word` | The name, or its first word, is or sounds like a word voice listens for on its own: cancel, stop, reply, answer, submit, option, no (`VOICE_CONTROL_WORDS`) |
| `sounds-like` | It sounds like another roster name, which the warning names |
| `common-word` | A one-word name on the bundled list of everyday words (`src/shared/voice-common-words.ts`), such as Will or Sage |
| `short` | A one-word name of one syllable and four letters or fewer, such as Bo |

"Sounds like" compares `phoneticKey(name)`, a Metaphone-style key with Double Metaphone's choices
for initial vowels and B: Steve and Stevie are both `STF`, and Steven is `STFN`. Two keys sound
alike when they are equal, or one edit apart and starting with the same sound: an added or dropped
sound from three codes, a swapped one from four. Two names also sound alike when their first words
do, because speech is routed by its first word. The later router compares the same keys with the
same `keysSoundAlike`, so validation and routing agree.

### Who can be addressed

The daemon's `VoiceNameRegistry` (`src/server/voice/names.ts`) holds the roster, `VoiceState.roster`.
It reads the Registry's own catalogs (resident profiles, open runs, tasks and live sessions) and
recomputes when one of their frames can move it. Each entry is a `SpokenName { key, name, kind,
taskId, sessionId, role, colorId, agent, state }`:

- one per live resident profile, keyed `resident:<profileId>`: its reference name, else its profile
  name; its description as its role; its board colour; `running` while it has an open run, else
  `not-running`. It stays while the profile is live.
- one per task with a call sign that has launched, keyed `task:<taskId>`: its call sign; its title
  as its role; `running` while a live session runs it, `hibernated` while the task is hibernated,
  else `not-running`. A task in the backlog is not listed until it launches.

A task that is not running leaves the roster 24 hours after it stopped (a finished task counts from
completion), or at once when another agent answers to the same name: a resident, a task that is
running or hibernated, or a task that stopped later. A task the Registry drops from memory while its
row remains keeps its name for the rest of its day; a deleted task leaves at once. Agents that are
not running stay listed so a later phase can say "<name> isn't running".

**Settings > Voice** draws the roster as a table: the agent (a resident's profile name in its board
colour, a session's task title), its kind, what to say, its state, and its check, "Distinct" or
each warning. Under it, a line counts the live sessions no spoken name reaches and says they are
answered through their open card with "reply". The table is read-only: names are set on the
profile and in Dispatch.

The roster reaches windows in the reconnect snapshot's `voice` field, on every `voice_state` frame,
and on its own `voice_roster` frame when it alone changes. See
[the event stream](event-stream.md#voice).

### Display names

Both names are the first rank of the display name the inbox plan defines (`agentDisplayName` in
`src/shared/display-name.ts`): with the `inbox` and `voice` flags on, a session with a call sign is
called by it on the inbox, the review modal, question cards, alert titles, the Away digest and a
report's author, and a resident by its reference name in its board colour. They are voice's names,
so with `voice` off a saved one is kept but names nothing: `sessionDisplayNameInput` takes the flag
as `spokenNames`, off unless a caller passes it, and the ranks below answer as they did before.

## The voice state

The daemon publishes one voice state. Its `mode` is one of:

| Mode | When |
| --- | --- |
| `off` | The `voice` flag is off |
| `unavailable` | At least one reason below holds |
| `muted` | `muted` is on |
| `auto-muted` | A live shell report says another app has the microphone, and auto-mute is on |
| `push-to-talk` | As `auto-muted`, while the shell reports the hotkey held |
| `listening` | Otherwise |

`voiceMode(inputs)` in `src/shared/voice.ts` is the one rule, applied in that order. The reasons,
in the order they are listed:

- `flags`: one of the three previews voice needs is off;
- `listener`: no listener hello in the last 30 seconds;
- `model`: the listener's hello says no model is loaded;
- `microphone`: a hello or a live shell report says access is denied.

The state also carries `capabilities`, `hotkeyError`, `model` and `roster`. The capabilities and
`hotkeyError` are copied from the latest shell report and lapse with it; with no report they are
absent and `hotkeyError` is null. `listener` is the daemon's own reading, never the shell's: available while a
hello is live, unavailable with the reason while a hello was refused for its protocol version, and
absent otherwise; a shell report's `listener` entry is dropped.
`model` reads `missing` until a later phase drives it, and `roster` is
[who can be addressed](#who-can-be-addressed).

### Routes

Dashboard routes live under `/api/voice/` behind the loopback gate:

- `GET /api/voice/config` returns `{ config }`; `PUT` applies a patch and returns `{ config }`.
  Fields replace, `cancelWindow` merges per key, and an unknown field or out-of-range value is a 400.
- `POST /api/voice/mute { muted }` sets `muted` and returns `{ state }`.

Token routes live under `/voice/` and check `x-harness-token`, as the hook ingest does:

- `POST /voice/listener/hello { backend, version, devices, modelLoaded, microphone }`, sent by a
  listener every 10 seconds. `version` is the listener protocol version; a hello whose major
  version is not this daemon's (`1`) is refused with 409 `unsupported_protocol`, and the state's
  `listener` capability says why.
- `POST /voice/shell-report { capabilities, microphone, callActive, pushToTalk, hotkeyError }`,
  sent by the desktop shell. A report lapses 15 seconds after it arrives. Capability ids this build
  does not know are dropped rather than refused.

### Following it

The reconnect snapshot carries `voice` while the flag is on, computed at that moment. The
`voice_state` event carries the whole state whenever it changes: a flag or the config changed, or
a hello or report arrived or lapsed. A lapse is published by a timer, with no request. Identical
frames are suppressed. Switching `voice` off sends one frame with the mode `off`; the desktop shell
reads no feature flag, so that frame is how it learns voice is off. See
[the event stream](event-stream.md#voice).

## Tests

- `test/voice-state.test.ts`: `voiceMode` for each mode, the reasons, a hello and a shell report
  lapsing, and a refused protocol version.
- `test/voice-config-http.test.ts`: defaults, patches, mute, the token routes, the frames, and
  every route answering 404 with the flag off.
- `test/setup-probes.test.ts`: the **Voice previews** row and the family following the flag.
- `test/voice-names.test.ts`: each warning, Steve against Stevie and Steven, control words, the
  meter, the stored name's bounds, and a cleared reference name staying cleared.
- `test/voice-registry.test.ts`: a resident launched and stopped, a call sign set by update, a
  session exiting, a hibernated task, the 24-hour and name-reuse removals, an evicted task, and the
  `voice_roster` frames from the real Registry.
- `test/voice-call-sign.test.ts`: the schemas, and a call sign set and cleared on a running task.
- `test/voice-call-sign-migration.test.ts`: a version 49 database gains `tasks.call_sign`.
- `test/display-name.test.ts`: a call sign and a reference name as the first rank.
- `e2e/specs/voice-call-sign.spec.ts`: "Will" draws the everyday-word warning with Dispatch still
  enabled; dispatched as "Alice", the roster lists Alice running and the question card names the
  session Alice; a shelved task's call sign survives a restart and clears.
- `e2e/specs/voice-reference-name.spec.ts`: a resident's reference name is checked as it is typed,
  survives a restart, is listed in the roster, and clears.
- `e2e/specs/voice-flag-and-settings.spec.ts`: the flag row toggles, the Voice category appears,
  a cancel window change persists across a reload, the Setup row's button turns the three flags on
  and the row passes, and the mode line reads unavailable, then listening once a listener says
  hello. `beListener(daemon)` in `e2e/fixtures/voice.ts` is that listener: it sends a hello with a
  loaded model and a granted microphone every few seconds under the token, so a spec reaches
  `listening` on any platform with no microphone.
