# Voice addressing

Voice addressing is being built in phases behind the **Voice addressing** preview flag (`voice`).
When it is finished, the operator will talk to an agent by name, with speech recognized on this
machine; the plan is in [`docs/plans/voice-addressing-for-agents/`](plans/voice-addressing-for-agents/plan.md).

The daemon accepts text captures from a token-authenticated listener. It resolves spoken names,
holds a message for the configured cancel window and queues it to the addressed agent. On Apple silicon, the standalone listener captures and recognizes speech locally.
The on-screen confirmation card belongs to a later phase.
Setup also reports microphone permission and downloads and verifies the speech model.

With the flag off nothing on this page is drawn: every voice route answers 404, the reconnect
snapshot has no `voice` field, and neither the Settings category, the Setup family, nor the Call
sign and Reference name fields is drawn. A call sign or reference name already saved is kept, and
names no agent until the flag is on again.

## Running the listener on a development Mac

Build the helper with `npm run build:voice-listener`. Start the daemon, enable the four previews, download
the model in Setup and unmute Voice. From a terminal with microphone access, run
`npm run voice:listener`. Speak a running resident's reference name followed by “check the
build”. After the cancel window, look for “check the build” in the resident's conversation
and the routing outcome at `GET /api/voice/heard`. Muting stops the audio engine and
releases its microphone. If this was the only capture, the macOS orange dot goes out.

Any launcher can run `dist/native/voice-listener` directly with these three variables.

| Variable | Value |
| --- | --- |
| `MISSION_VOICE_DAEMON_URL` | The daemon's loopback HTTP origin |
| `MISSION_VOICE_TOKEN_FILE` | Path to its token, sent as `x-harness-token` |
| `MISSION_VOICE_MODEL_DIR` | The model revision directory containing the two model repositories |

The development launcher fills missing values from the local daemon configuration and the
FluidAudio model manifest. When macOS reports `not-determined` at startup, the helper
prints a terminal diagnostic, includes the reading in its hello and keeps the microphone
closed. Run the development command from a terminal app that already has microphone access.
An explicit denial is sent in the hello and exits with status 2. The first-time consent
prompt belongs to the desktop launcher in [phase 10](plans/voice-addressing-for-agents/phase-10-shell-and-tray.md).

On startup and every ten seconds, the helper posts protocol 3.0 to `/voice/listener/hello`.
Generate a UUID once per listener process. Send it in `x-voice-listener-id` on each hello,
directive poll and utterance POST, alongside the daemon token. The first compatible hello
claims the listener lease. While its microphone permission is granted, a second process
receives HTTP 409 `listener_in_use` and exits before
opening the microphone. A new process can claim capture 30 seconds after the owner's last
hello. It receives a fresh revision even when settings are identical. The daemon checks
ownership again when a held poll completes and before routing each utterance.
A helper with undetermined, restricted or unknown permission can report its status to Setup
and poll with capture off. A granted listener can replace it immediately. The replacement
receives a fresh revision and the previous listener's next poll or heartbeat receives HTTP 409.
A helper reporting an explicit microphone denial releases capture immediately and exits
with status 2. Setup retains the permission reading, and a newly authorized helper can
start immediately.
Selecting a different backend releases the previous owner's lease and wakes its held poll.
Only the selected backend can acquire or renew the lease. A hello from another backend
receives HTTP 409 `backend_not_selected`. In `auto`, either backend can acquire a free lease.

Every utterance POST also requires the capture directive's revision. Older protocol majors
receive HTTP 409 `unsupported_protocol` at hello. The helper sends one hello
at a time, so a loading heartbeat completes before it announces CoreML readiness.
The hello lists inputs by stable UID and reports built-in and Bluetooth transport. It
omits empty or oversized UIDs and limits display names to 256 UTF-16 code units.
The built-in selection falls back
to the system input when no built-in input exists. An unavailable explicit UID stops the
listener. The optional `primingAvailable` boolean reports whether the local CTC model loaded.
With only the TDT repository present, transcription continues with priming off.

Fetch `GET /voice/listener/directive` with both `x-harness-token` and `x-voice-listener-id`
on every poll. Use the same listener UUID that the daemon accepted at hello. The first poll returns
`{ capture, roster, inputDevice, pauseMs, revision }`. The roster is an array of spoken names.
After applying the directive, pass the opaque revision back as `?revision=...` to wait for a change or receive the current
directive after 25 seconds. A heartbeat with identical capture settings leaves the poll open.
`pauseMs` is optional and unused. This daemon sends null.

A push-to-talk capture directive identifies its revision in the `x-voice-held-revision`
response header. The native helper retains completed phrases in capture order and decodes
them after a confirmed release. It can retain up to 120 seconds of segmented PCM per hold.
The first excess sample's timestamp lets the helper apply key-up before deciding overflow.
If the held audio exceeds the limit, the helper discards the entire hold and reports it on stderr.
When releasing push-to-talk returns a call to auto-mute, the capture-off response includes
`x-voice-release-revision` (the held capture revision) and `x-voice-release-host-ms` (monotonic
host milliseconds). A helper applying that exact held revision uses key-up as the boundary for
the unfinished phrase. If its input tap still owes samples through that time, the helper
collects the pre-release portion of the last callback before closing. A stalled input
closes after 250 ms and delivers only phrases completed before the stall. Manual mute stops the input immediately. The helper can finish decoding and posting
the held audio with the original revision. If another press arrives before the tap closes,
the helper keeps polling for privacy changes and rechecks the directive after closure.
A second key press can record while the helper
finishes decoding previous holds in spoken order. The daemon lists up to eight authorized
released revisions in `x-voice-draining-revisions`. A poll that missed an intervening key-up
also receives the release time for its queried revision. An ordinary capture stop discards unfinished work.
The native helper dates the samples from the input tap's audio timestamp on the shared host
clock, so a delayed callback still includes speech recorded before key-up. A gap in
the input timeline discards the interrupted utterance through the next silence boundary.

The shell timestamps every snapshot, including idle heartbeats, at observation time with
`reportedAtHostUs`. This strictly increasing integer counts microseconds on the shared
monotonic host clock. Serialize snapshot creation and use distinct timestamps, including
across shell restarts. Retried snapshots keep their original timestamp. The daemon ignores
older and duplicate snapshots before applying state or renewing its 15-second lifetime.
A fresh snapshot still renews that lifetime and updates call state, permissions and capabilities
when it repeats a key event older than the daemon’s last key transition.

On macOS use the Core Audio host clock (`mach_absolute_time` converted with its timebase).
Key events use the same microsecond clock. The daemon orders them at that precision and
rounds down to whole milliseconds only for the release boundary sent to the listener. During a hold send
`pushToTalk: true` and the original `pushToTalkPressedAtHostUs` when available. Otherwise
the first ordered down snapshot dates the press. A later press starts a fresh revision.
On release send `pushToTalk: false` and `pushToTalkReleasedAtHostUs`, retaining the last
release stamp on subsequent idle snapshots so a reordered heartbeat can confirm it.
If key-up predates an inferred press and cannot be identified as a replay of an older
physical event, the daemon closes capture and discards the hold.
A missing, invalid or future release stamp closes capture and discards the tail. Reports
without ordering metadata still carry shell capabilities and call state but cannot authorize
a hold. Legacy Unix key timestamps are accepted as input and have no delivery authority.

The default-input audio engine runs with voice processing off. It converts input to mono
16 kHz samples. A local WebRTC voice activity detector classifies 20 ms frames so
steady background noise can continue between utterances. Parakeet transcribes each segment
after 800 ms of frames classified as non-speech. If the 30-second buffer fills
before that boundary, the listener discards the whole utterance, including any further
speech before the next silence boundary. During a key hold, the prefix remains recoverable
for two more seconds of capture in case a delayed key-up timestamp falls within the limit.
When CTC is available, the helper uses the directive's roster to rescore those same samples.
Only a correction aligned to the leading address can change the transcript and its timing
labels. The rest of the decoder transcript, including its punctuation, passes through verbatim.
Word timings come from the decoder. When a CTC correction changes the word count, the listener
divides the measured span evenly among the corrected words. Interior boundaries are estimates.
While listening, two completed phrases can wait in capture order behind a busy recognizer
or a pending POST. If that queue fills, the listener drops the incoming phrase and reports
the backlog on stderr. Only text, relative word timings and capture metadata reach the daemon. Samples and pending
utterances stay in memory. Except for a matching push-to-talk release, a changed directive
discards buffered audio and cancels unfinished work. A later capture starts with a fresh audio engine.
If a hardware change stops the engine, the helper refreshes its directive and opens a new
input if capture is still enabled. Losing an explicitly selected UID produces an input error.
A failed directive poll closes the microphone and exits. The helper writes no recordings or
transcripts and logs no recognized words.

## Routing a text utterance

A listener posts `{ id, text, words, capturedAt, backend }` to `POST /voice/utterances?revision=...`
with both `x-harness-token` and `x-voice-listener-id`. Set the latter to the UUID from that
listener's accepted hello. Send the directive revision under which the segment was captured. The daemon
returns `{ accepted: false }` for a missing or superseded revision before the utterance reaches
Recently heard, a card or the queue. This also covers a mute and unmute while a POST is in flight.
Reassigning a spoken name or changing its target task or session issues a fresh revision,
even when the list of names sent to the recognizer stays the same.
Use a fresh ID per capture. Set `capturedAt` to the time of capture in Unix milliseconds
on the host clock shared by the listener and daemon. A recognizer using its own clock
converts its timestamps to host time at capture.
A UUID works. IDs can contain 1 to 128 ASCII letters, digits, periods, hyphens,
underscores or tildes. The card action routes reserve the complete segments `.` and `..`.
Each timing is `{ text, startMs, endMs }`. Missing timings are treated as an empty array.
The response is `{ accepted }`. While listening, the daemon can route a capture immediately.
A POST made while push-to-talk is held waits for the shell's key-up timestamp before
anything reaches Recently heard, a card or the queue. If the same key is still held after
25 seconds, the daemon returns `accepted: false` and its revision in `x-voice-held-revision`.
The listener retries the same POST and utterance ID after at least 250 ms. It drops that
segment after three attempts or 55 seconds, including time spent waiting for a response,
and continues with later speech. During auto-mute following key-up,
the daemon accepts the same owner's held revision for segments ending by the release
timestamp. The listener clips on 16 kHz sample boundaries and rounds the exclusive end up
to host milliseconds for `x-voice-capture-end-host-ms`. Only the utterance’s `capturedAt`
history field uses Unix milliseconds. If a POST races key-up
and extends past it, the daemon returns `accepted: false` and the release headers. The
helper transcribes the clipped PCM again before retrying. Successive key presses during the
same call preserve the release exception. Manual mute, a change of recipient, listener or input,
or leaving the call revokes it.
With the window off the daemon acknowledges the capture as soon as it claims delivery.
The card reports the final outcome when the queue or interrupt handler finishes.
The capture must name the backend in the live listener’s hello and agree with any explicit
backend selection. The daemon drops captures dated more than one second ahead of its clock.
Accepted captures keep their listener timestamps for history, spoken picks and cancellations.
The listener posts captures in spoken order, waiting for each response before posting the next
capture (including a cancel or pick). This lets the daemon apply a control to an action that
has already opened. A cancel received with no pending action records `nothing-pending`.
The daemon starts each delivery deadline when it opens the pending card.
The cancel window closes at that deadline even if the delivery timer runs late.

“Will, grab the door” and “Will you grab the door” both address Will. Voice compares the whole
first word after normalizing case and boundary punctuation. The exact first word takes priority
over a longer call sign. A later mention alone (“Please ask Will”) is ignored. Timing is
descriptive only. Recently heard measures from the last address word to the first message word,
skipping punctuation-only timing entries. Missing or mismatched words leave the pause empty.
Only whitespace can separate the two tokens of a call sign, both in an address and in a later mention.
For example, `Release. Captain, stop` does not address Release Captain. Punctuation spelled
inside a roster name such as `Dr. Ada` participates in exact matching.
“Release Captain, run tests”
can address Release Captain, while “Release, Captain needs help” can address Release. A phonetic match such as “Steven” or
“Steve’s” can address Steve. If both Steve and Steve Captain sound like the start of the capture,
“Steven Captain, run tests” selects the longer phonetic match. “Will, ask Steve about the build” sends “ask Steve about the build” to Will.
A unique exact first word settles the address even when the message names another agent.
A spelling near-miss is ignored even when several names are one edit away. A bare name selects
a candidate when exactly one option matches across open unsure cards captured by the time
the name was spoken. A final sentence mark is optional. `Will.` selects Will, while
`,Will`, `Will,` and `“Will”` leave the card open. An apostrophe within a name such as
`O’Neil` is part of the name. Multiple matches
leave the cards open and record `ambiguous-pick` in Recently heard. If the selected candidate has
left the roster, the card stays open and Recently heard records `candidate-unavailable`. A bare roster name with
no matching option records `no-message`. This includes “Release Captain” when both Release
and Release Captain are on the roster.
Ambiguous exact or phonetic matches with message text open an unsure card, as does a later agent mention after a phonetic or
two-word match. No model is called.

During the cancel window, the message stays in memory. At the deadline, or immediately with
the window off, the daemon submits the remaining text verbatim to the running target’s operator
queue. The card and Recently heard show `queued` when the queue accepts the message.
For example, `Will,"ship it"` queues `"ship it"` with both quotes, and
`Will, ???` queues `???`. Only one comma separates the address from the message,
so `Will,,,` queues `,,` and `Will,,,stop` queues `,,stop`.
Quotes and brackets around an address must close in matching pairs. For example,
`“Will”ship it` queues `ship it` even without a space after the closing quote.
`[Will, ) stop` queues `) stop` as message text. An unclosed wrapper also makes the body
ordinary message text. `[Will, stop` queues the word `stop`.
The pending card keeps the session ID selected when it opened. If that session ends or another
session takes over its roster entry, the card and Recently heard show `not-running`.
“Steve, stop” uses the session interrupt path. A bare command may end with sentence punctuation
such as `!` or `?`. Quoting the word in `Steve, "stop"` queues
the message `"stop"`. A bare “cancel” stops the newest action that
is still pending and was opened by the time the cancel was spoken. Quoting the word
in a standalone `“cancel”` leaves pending actions open. The daemon uses capture
timestamps when listener requests arrive out of order. For equal timestamps, the last action
opened wins. An unsure card has no deadline. The five most recent unsure captures stay open.
An older capture arriving after all five is cancelled. For tied capture times, the later arrival stays.
The router allows up to 50 open or delivering cards in total. At capacity a capture that
would open a new card returns `{ accepted: false }` and can be retried when a slot opens.
Existing cards keep their deadlines, and the operator can still pick or cancel them.
Picking a candidate opens the ordinary cancel window. A spoken pick has its own capture
timestamp. For a pick through the card API, the daemon records the host time when it applies
the pick. A cancel spoken before that instant leaves the picked card pending even if its POST
arrives after the pick.
The loopback card routes are `POST /api/voice/cards/:id/cancel`,
`/send-now` and `/pick` (body `{ id: candidateId }`). A stale action returns 409.

`GET /api/voice/heard` returns `{ entries }` for the 50 most recent captures, sorted by capture
time with the latest arrival first for ties. Entries include
ignored speech, cancellations, the routing rule and any observed pause. A failed delivery includes the reason in the entry’s detail. Muted and unavailable
captures leave no record. `DELETE /api/voice/heard` clears the list. Captures, timings and
card history exist only in memory and disappear on daemon restart or disabling voice. Across a preview
toggle, the daemon remembers the last 50 accepted capture IDs so a retried “cancel” cannot dismiss
a newly opened card. A daemon restart clears those IDs. A message
actually submitted to the operator queue follows the queue’s normal durable delivery lifecycle.

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

The family has two more rows, both optional:

- **Microphone access** reads the microphone permission from the latest listener hello or desktop
  shell report. A denial from either wins while its report is live, as it does for the mode
  line's `microphone` reason; otherwise the newest reading counts. A denial that has lapsed
  therefore gives way to a newer grant from the other source, so allowing Mission Control in System
  Settings and pressing **Check again** clears it, while a lapsed denial with nothing newer still
  stands. Until either has reported, the row reads **Not checked yet**.
  Its fix says where macOS keeps the switch (System Settings > Privacy & Security > Microphone) and
  **Check again** re-reads it. Asking macOS from the app belongs to the desktop shell's phase.
- **Voice speech model** downloads and verifies the speech model. See [The speech model](#the-speech-model).

## The speech model

Voice recognizes speech on this machine with NVIDIA Parakeet TDT 0.6B v2. Nothing is bundled with
the app: the **Voice speech model** row in **Settings > Setup > Voice** downloads it when the
operator presses **Download**.

What is downloaded is fixed by a manifest in this repository, `VOICE_MODELS` in
`src/shared/voice-models.ts`, keyed by listener backend. Every file names a Hugging Face URL pinned
to a commit, its exact size and its SHA-256 digest, measured by the voice spike
([`docs/voice-spike-findings.md`](voice-spike-findings.md)). A URL that names a branch rather than
a 40-character commit does not parse. The `fluidaudio` entry holds two models, 568,273,745 bytes
(about 542 MiB) together:

| Model | Repository and commit | Why |
| --- | --- | --- |
| Parakeet TDT 0.6B v2, Core ML | `FluidInference/parakeet-tdt-0.6b-v2-coreml` at `ee09c569f73759e6d44c9bd16766f477b2b36d39`: the Encoder, Decoder, JointDecision and Preprocessor models and `parakeet_vocab.json` | The recognizer |
| Parakeet TDT-CTC 110M, Core ML | `FluidInference/parakeet-ctc-110m-coreml` at `accdafd8cf8a2ff1cabe3c11e54416b405d409aa` | FluidAudio primes the roster's names with a vocabulary-boosting pass over this model |

The `sherpa-onnx` entry is empty until its backend is built. The configured `backend` decides which
entry is used: `auto` is `fluidaudio` on Apple silicon and `sherpa-onnx` everywhere else. A machine
whose backend has no model reads so on the row, with nothing to download.

### Download and verification

`VoiceModelManager` in `src/server/voice/models.ts` owns the files and `VoiceState.model`. It
works only while the `voice` flag is on.

- **Download** fetches each file uncompressed (`accept-encoding: identity`) to a temporary name
  beside its destination, hashes it while it writes, and refuses it if the server offers a
  different size, sends more or fewer bytes than the manifest pins, or the digest differs. A server
  that compresses anyway reports a compressed length, so that response is checked by its decoded
  bytes and digest alone. A refused file is deleted and the row reads the reason with **Retry**.
  Only a file that matches is renamed into place.
- While it runs, the row shows a progress bar with the bytes done, the rate and the time left, and
  **Cancel**. Progress reaches every window through `voice_state` at most four times a second.
- **Cancel** stops the download and removes the revision's directory, so nothing unverified is
  left behind. A Download pressed while that removal runs starts at once but writes nothing until
  the removal has finished, and a second Cancel stops it. If the directory cannot be removed, the
  row reads the reason with **Retry**.
- **Retry** downloads again. A file already on disk at its pinned size is hashed and kept when it
  matches, so a retry fetches only what is missing or wrong.
- A download that receives nothing for 60 seconds fails rather than hanging.
- **At start**, and whenever the flag is switched on or the backend changes, the manager reads the
  model on disk. A missing file reads `missing`, a file of the wrong size reads `failed`, and a
  model whose every file is the right size reads `verifying` while each is hashed again. It reads
  `ready` only when every digest matches. No stored record stands in for the hash, so a file
  edited without changing its size is refused at the next start.

`ready` covers the whole entry, both models: a revision directory holding the recognizer without
the CTC model reads `missing`, never a partial `ready`, so a listener is never handed a directory
it cannot prime names from. There is no "ready without priming" state.

`VoiceState.model` carries `status` (`missing`, `downloading`, `verifying`, `ready` or `failed`),
`backend`, `revision`, `totalBytes`, `doneBytes`, `bytesPerSecond`, `directory` (the verified
directory, set only while `ready`) and `error`. It says whether the model is on disk and verified.
Whether a listener has *loaded* it is the hello's `modelLoaded`, which is what the mode line's
`model` reason reads.

### Where it is kept

The files live under the state home, outside SQLite and outside settings backups:

```
<state home>/voice/models/<backend>/<revision>/<repository>/<file>
```

For example `~/.mission-control/voice/models/fluidaudio/parakeet-v2-ee09c569-ctc110m-accdafd8/parakeet-tdt-0.6b-v2-coreml/Encoder.mlmodelc/weights/weight.bin`.
A listener is given the revision directory. A new revision in the manifest downloads into its own
directory beside the old one, and the old one is removed only after the new one verifies.

### Attribution

Both models are licensed under CC-BY-4.0. They were created by NVIDIA
([parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
[parakeet-tdt_ctc-110m](https://huggingface.co/nvidia/parakeet-tdt_ctc-110m)) and converted to
Core ML by FluidInference
([parakeet-tdt-0.6b-v2-coreml](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml),
[parakeet-ctc-110m-coreml](https://huggingface.co/FluidInference/parakeet-ctc-110m-coreml)).
Mission Control uses the files unmodified. The same notice is in `NOTICE`.

### Test and mirror overrides

Two environment variables, read when the daemon starts:

- `MISSION_VOICE_MODEL_BASE_URL` replaces `https://huggingface.co` in every file's URL and keeps the
  pinned path, appended to the base URL's own path; a query string on the base URL (a mirror's
  token, say) is kept as a query. A mirror or a test server can serve the files this way. It must be an `http` or `https`
  URL. The end-to-end suite points every daemon at a closed loopback port, so a Download pressed
  without a fixture fails instead of reaching Hugging Face.
- `MISSION_VOICE_MODEL_MANIFEST` names a JSON file in the same shape as `VOICE_MODELS`, keyed by
  backend, whose entries replace the pinned ones. It exists so tests can serve small fixture
  files whose digests the real manifest cannot name. It is held to the same schema, so its URLs
  are pinned to commits too, and a file that does not parse is ignored with a warning.

## Voice settings

**Settings > Voice** opens with the mode line: a dot, the mode in words and, when voice cannot
listen, every reason it cannot, with **Open Setup**. Below it is **Who you can address**, the
[roster](#who-can-be-addressed).

Under **Input**, **Input device** chooses the microphone (`inputDevice`): **Built-in microphone**
(`built-in`, the default), **macOS default input** (`system-default`), or one of the devices the
live listener lists in its hello. With no listener the menu offers the first two, and the row
says so. The one exception is a saved device that is not listed now (unplugged, or no listener):
it stays in the menu as **Saved device (not connected)**, so the menu never shows a choice that
was not made. `GET /api/voice/devices` returns `{ devices, listener }` for this menu; a listener
interprets the id.

Below that are the behavior rows:

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

A call sign is `Task.callSign`, stored in `tasks.call_sign` (schema 51, nullable, no backfill),
and carried to the session card as `TaskSummary.callSign` while the task has one. It is
annotation, like priority: nothing is provisioned from it, so an update may set or clear it while
the agent runs. `POST /api/tasks` and `POST /api/tasks/:id/update` accept it, and so do the MCP
`create_task` and `update_task` tools; `get_task` and `list_tasks` report it.

A resident's task takes no call sign: the resident answers to its profile's names, and the roster
would leave a call sign out while its card printed it. Creating or updating one with a call sign
is refused (`taskKindTakesCallSign` in `src/shared/voice-names.ts`), and the display name never
calls a resident by one.

### Reference names

A resident profile's **Identity** card pairs **Name** with an optional **Reference name**.
For example, a resident named "Release Captain" can answer to "Sage". The reference name
is `identity.referenceName` in the profile's revision JSON, optional with no
default, so a revision saved before it existed reads exactly as before. Clearing it saves it
blank, which means none: a save that left the key out would carry the previous revision's forward.

If Voice is switched off during an edit, saving the profile preserves its stored reference name.

A reference name is a spoken name, not a launch setting, so it applies as soon as it is saved,
also to a resident that is running: the roster reads the profile as it stands, and so does the
display name a card prints. With no reference name, Voice follows the current profile name
as soon as the operator renames the resident. With Voice off, cards use the name pinned at launch.

### Checking a name

Dispatch previews "**Alice,** check the build" and the resident profile previews
"**Sage,** cut the release". Each field shows a four-step meter and one line per warning.
The meter lights four steps, less one per warning.
Warnings never block: Dispatch and Save stay enabled whatever they say. They come from one pure
function, `validateSpokenName(name, roster)` in `src/shared/voice-names.ts`, checked against the
other names on the roster, never against the agent's own entry:

| Warning | When |
| --- | --- |
| `control-word` | The name's first word is, or sounds like (`keysSoundAlike`, so Stopper is heard as stop), a word voice listens for on its own: cancel, stop, reply, answer, submit, option, no (`VOICE_CONTROL_WORDS`) |
| `sounds-like` | It sounds like another roster name, which the warning names |
| `symbols-only` | The name contains no letters or numbers in any script. |
| `common-word` | A one-word name on the bundled list of everyday words (`src/shared/voice-common-words.ts`), such as Will or Sage |
| `short` | A one-word name of one syllable and four letters or fewer, such as Bo |

"Sounds like" compares `phoneticKey(name)`, a Metaphone-style key with Double Metaphone's choices
for initial vowels and B: Steve and Stevie are both `STF`, and Steven is `STFN`. Two keys sound
alike when they are equal, or one edit apart and starting with the same sound: an added or dropped
sound from three codes, a swapped one from four. Two names also sound alike when their first words
do, because speech is routed by its first word. The router compares the same keys with the
same `keysSoundAlike`, so validation and routing agree. A name with no letters a to z, such as
サクラ, has no key: it draws only `sounds-like`, against a roster name it is identical to.

The field's verdict (Distinctive, or each warning's label) is also kept in a polite `role="status"`
region that stays mounted, so a screen reader hears the warnings change while the operator types.

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
  else `not-running`. A backlog task or an attempt still provisioning its first session cannot
  displace an agent that already answers to the name.

A task that is not running leaves the roster 24 hours after it stopped, or at once when another
agent answers to the same name: a resident, a task that is running or hibernated, or a task that
stopped later. Schema 52 adds the nullable `tasks.retired_call_sign` column to record displacement
without changing the configured call sign. The displaced name stays off the roster even if the other agent gives it up or the
daemon restarts. The task keeps its configured call sign and can answer again when it resumes.
A deleted task leaves at once, even one the Registry had already evicted from memory. Agents that are not running stay listed so a later
phase can say "<name> isn't running".

When a task stopped is not always known across a daemon restart, so the 24 hours are not an
absolute bound:

- A finished task (done, failed or cancelled) counts from its stored completion time, so a restart
  does not change its 24 hours. That holds for a finished task the Registry no longer keeps in
  memory (it keeps the 50 most recent): while the daemon runs, an evicted named task is kept, and
  a restarted daemon reads the day's named finished tasks from storage
  (`loadFinishedTasksWithCallSign`), not only the 50 it reloads.
- A task that stopped without finishing (its session exited, the task still open) counts from when
  the daemon first saw it stopped, even when the call sign was added later. That moment is held in memory only, so a restart starts the
  clock again and the name can stay listed for longer than a day.

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
Schema 53 adds nullable `author_spoken_name` columns to `reports` and `report_mutes`.
New reports capture both author labels when posted. Switching Voice changes which label is shown,
even after the session exits. Older reports with a single recorded label keep that attribution.
Away previews and return digests also select the label for buffered session events when read.

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
`model` is the speech model manager's reading (see [The speech model](#the-speech-model)), and
`roster` is [who can be addressed](#who-can-be-addressed).

### Routes

Dashboard routes live under `/api/voice/` behind the loopback gate:

- `GET /api/voice/config` returns `{ config }`; `PUT` applies a patch and returns `{ config }`.
  Fields replace, `cancelWindow` merges per key, and an unknown field or out-of-range value is a 400.
- `POST /api/voice/mute { muted }` sets `muted` and returns `{ state }`.
- `GET /api/voice/devices` returns `{ devices, listener }`: the live listener's input devices, empty
  with `listener: false` when no hello is live.
- `POST /api/voice/model/download` starts the download and answers 202 with `{ model }`. A download
  already running or a model already verified is not started again. With no model for the
  configured backend it answers 409 `model_unavailable` with the `reason`.
- `DELETE /api/voice/model/download` cancels a running download, removes what it wrote, and returns
  `{ model }` as the disk now reads.

Token routes live under `/voice/` and check `x-harness-token`, as the hook ingest does:

- `POST /voice/listener/hello { backend, version, devices, modelLoaded, microphone }`, sent by a
  listener every 10 seconds. `version` is the listener protocol version. A hello with a different
  major version from this daemon's (`3`) is refused with 409 `unsupported_protocol`.
  If there is no other active owner, the state's `listener` capability says why.
- `POST /voice/shell-report { capabilities, microphone, callActive, pushToTalk, reportedAtHostUs?, pushToTalkPressedAtHostUs?, pushToTalkReleasedAtHostUs?, hotkeyError }`,
  sent by the desktop shell. A report lapses 15 seconds after it arrives. Capability ids this build
  does not know are dropped rather than refused.

### Following it

The dashboard and the desktop shell follow the state through the `voice` snapshot field and the
`voice_state` event. When each is sent, and the one frame that says voice is off, are in
[the event stream](event-stream.md#voice).

## Tests

- `test/voice-state.test.ts`: `voiceMode` for each mode, the reasons, a hello and a shell report
  lapsing, and a refused protocol version.
- `test/voice-config-http.test.ts`: defaults, patches, mute, the token routes, the frames, and
  every route answering 404 with the flag off.
- `test/setup-probes.test.ts`: the **Voice previews**, **Microphone access** and **Voice speech
  model** rows, and the family following the flag.
- `test/voice-models.test.ts`: the manifest's shape, that every URL is pinned to a commit, and that
  its sizes and digests are the spike's.
- `test/voice-model-download.test.ts`, against a local fixture server: a download that verifies, a
  digest mismatch, a short file, a wrong offered size, a stall, Cancel, Retry fetching only what
  failed, the start-up hash, a same-size edit refused at the next start, a new revision replacing
  the old, the flag switched off mid-download, and the routes.
- `test/voice-names.test.ts`: each warning, Steve against Stevie and Steven, control words
  including Stopper and Summit, a name with no letters a to z, the meter, the stored name's bounds,
  and a cleared reference name staying cleared.
- `test/spoken-name-field.test.tsx`: the field's verdict and its polite status region.
- `test/task-edit-patch.test.ts`: a call-sign edit is sent only while voice is on.
- `test/voice-registry.test.ts`: a resident launched and stopped, a call sign set by update, a
  task still waiting for its first launch, a session exiting, a hibernated task, the 24-hour and
  name-reuse removals, an evicted task, a named finished task read back from storage after a
  restart past the 50 reloaded, and the `voice_roster` frames from the real Registry.
- `test/task-startup-cleanup.test.ts`: a call sign, priority or label edit landing while startup
  tears down a dead terminal home is kept.
- `test/voice-call-sign.test.ts`: the schemas, a call sign set and cleared on a running task, and
  one refused on a resident's task, created or updated.
- `test/voice-call-sign-migration.test.ts`: a version 50 database gains `tasks.call_sign`.
- `test/display-name.test.ts`: a call sign and a reference name as the first rank, and a
  resident never named by its task's call sign.
- `e2e/specs/voice-call-sign.spec.ts`: "Will" draws the everyday-word warning with Dispatch still
  enabled and its verdict in the status region; dispatched as "Alice", the roster lists Alice
  running and the question card names the session Alice; a shelved task's call sign survives a
  restart, stays off the roster while saved, is kept when voice goes off mid-edit, and clears.
- `e2e/specs/voice-reference-name.spec.ts`: a resident's reference name is checked as it is typed,
  survives a restart, is listed in the roster, and clears.
- `e2e/specs/voice-flag-and-settings.spec.ts`: the flag row toggles, the Voice category appears,
  a cancel window change persists across a reload, the Setup row's button turns the three flags on
  and the row passes, and the mode line reads unavailable, then listening once a listener says
  hello. `beListener(daemon)` in `e2e/fixtures/voice.ts` is that listener: it sends a hello with a
  loaded model and a granted microphone every few seconds under the token, so a spec reaches
  `listening` on any platform with no microphone.
- `e2e/specs/voice-model-setup.spec.ts`: the speech model row reads missing, Download shows the bar
  and its figures then reads verified with the files on disk, a corrupt file reads as the error
  with Retry, Cancel removes what was written, and a same-size edit is refused after a restart; the
  microphone row reads **Not checked yet** until a listener reports, and the input device menu
  offers the listener's devices. `startModelServer()` in `e2e/fixtures/voice.ts` stands in for
  Hugging Face with three small files and a manifest pinning them, so no spec downloads the real
  model.
