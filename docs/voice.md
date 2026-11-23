# Voice addressing

Voice addressing is being built in phases behind the **Voice addressing** preview flag (`voice`).
When it is finished, the operator will talk to an agent by name, with speech recognized on this
machine; the plan is in [`docs/plans/voice-addressing-for-agents/`](plans/voice-addressing-for-agents/plan.md).

None of that works yet: there are no spoken names, no routing, no cards and no audio. What exists
today, and what this page describes, is the foundation: the flag, the voice settings, the voice
state that the dashboard and later the desktop shell follow, the Voice settings category with its
input device choice, and the Voice family in Setup, whose rows turn on the previews voice needs,
report the microphone permission, and download and verify the speech model.

With the flag off nothing on this page exists: every voice route answers 404, the reconnect
snapshot has no `voice` field, and neither the Settings category nor the Setup family is drawn.

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

- **Download** fetches each file to a temporary name beside its destination, hashes it while it
  writes, and refuses it if the server offers a different size, sends more or fewer bytes than the
  manifest pins, or the digest differs. A refused file is deleted and the row reads the reason
  with **Retry**. Only a file that matches is renamed into place.
- While it runs, the row shows a progress bar with the bytes done, the rate and the time left, and
  **Cancel**. Progress reaches every window through `voice_state` at most four times a second.
- **Cancel** stops the download and removes the revision's directory, so nothing unverified is
  left behind.
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
  pinned path, so a mirror or a test server can serve the files. It must be an `http` or `https`
  URL. The end-to-end suite points every daemon at a closed loopback port, so a Download pressed
  without a fixture fails instead of reaching Hugging Face.
- `MISSION_VOICE_MODEL_MANIFEST` names a JSON file in the same shape as `VOICE_MODELS`, keyed by
  backend, whose entries replace the pinned ones. It exists so tests can serve small fixture
  files whose digests the real manifest cannot name. It is held to the same schema, so its URLs
  are pinned to commits too, and a file that does not parse is ignored with a warning.

## Voice settings

**Settings > Voice** opens with the mode line: a dot, the mode in words and, when voice cannot
listen, every reason it cannot, with **Open Setup**.

Under **Input**, **Input device** chooses the microphone (`inputDevice`): **Built-in microphone**
(`built-in`, the default), **macOS default input** (`system-default`), or one of the devices the
live listener lists in its hello. With no listener the menu offers the first two, and the row
says so. The one exception is a saved device that is not listed now (unplugged, or no listener):
it stays in the menu as **Saved device (not connected)**, so the menu never shows a choice that
was not made. `GET /api/voice/devices` returns `{ devices, listener }` for this menu; a listener
interprets the id.

Below it are the behavior rows:

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
`roster` is empty until the names phase fills it.

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
  listener every 10 seconds. `version` is the listener protocol version; a hello whose major
  version is not this daemon's (`1`) is refused with 409 `unsupported_protocol`, and the state's
  `listener` capability says why.
- `POST /voice/shell-report { capabilities, microphone, callActive, pushToTalk, hotkeyError }`,
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
