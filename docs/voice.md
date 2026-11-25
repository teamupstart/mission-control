# Voice addressing

Voice addressing is being built in phases behind the **Voice addressing** preview flag (`voice`).
When it is finished, the operator will talk to an agent by name, with speech recognized on this
machine; the plan is in [`docs/plans/voice-addressing-for-agents/`](plans/voice-addressing-for-agents/plan.md).

The daemon accepts text captures from a token-authenticated listener. It resolves spoken names,
settles ambiguous sentences with a model, holds each message for the configured cancel window,
and queues it to the addressed agent. On supported Apple silicon Macs, FluidAudio captures and
recognizes speech locally. The standalone sherpa-onnx listener recognizes recordings on macOS
and Linux. The corner confirmation card names the recipient and shows the spoken words.
Long transcripts scroll inside the card so you can still see the recipient and reach Cancel or Send now.
Tab to an overflowing transcript and use the arrow keys or End to read it. The countdown bar and
seconds count down together. On a slow connection, `≤` marks the longest time that could
remain. You can still try Cancel, and the daemon confirms whether it arrived in time.
When several cards share the corner, open cancel windows stay nearest the corner, ahead of delivery results.
Click Cancel, say “cancel”, or click Send now. If the daemon is slow to answer, the card offers a retry while the original request can still reach it. A split offers
“Send both now” when both messages are waiting. With a mention or an already-issued stop,
the send button names the agent who will receive the remaining message. With the cancel
window off, delivery begins immediately. Sent and queued cards show the open question count. A queued receipt names the recipient. It mentions a current turn when the session is working and unpaused.
Countdowns use the time remaining on the daemon, including when a LAN dashboard’s clock differs.
With Sound enabled, the pending chime plays only while the card still offers Cancel.
A successful addressed stop displays “Stop sent to” and the recipient’s name. During the cancel window, an unfocused
dashboard repeats the spoken words in a desktop notification if notifications are enabled
in Mission Control, notification permission is granted, and the platform supports desktop
notifications. If you switch away while the card is counting down, the notification shows
the time left in the window. If you return before the desktop shows it, switching away
again can still show it before the deadline. A split card shows an immediate stop’s result as soon as it arrives. The
desktop notification identifies that stop separately and counts down only the waiting
delivery. Its Cancel remaining and Send remaining now buttons control that delivery.
If a desktop action fails, the dashboard card names the unconfirmed action and shows
the reason. Its controls remain available for a retry while the cancel window is open.
The desktop measures the remaining interval on its own monotonic clock. Reloading or
closing the dashboard dismisses the native notice for that page.
The browser closes its notification at the cancel deadline even if its connection to the daemon drops.
If the clock estimate is uncertain, the card and notification allow at most one configured
cancel window from the first time the dashboard receives that pending delivery.
At the deadline the card removes its delivery controls. If the outcome has yet to arrive,
it shows “Awaiting delivery confirmation”.

A settled card stays visible while one of its controls has focus or its action is in
progress, including when the dashboard reconnects to the daemon. Once both end, the card
gives you another eight seconds to read the result or retry.
When a queued message changes to Sent, its reading interval starts again before the card fades.
If a blocking question opens while the message is still queued, the dashboard shows a Held
card with **Open question** and **Cancel message**, even if the Queued card has already faded.
If you remove the task’s call sign, its held turn remains recallable after a daemon restart or after you switch Voice off and back on.
The restored card uses the session’s display name. **Open question** opens the question named on the card, even when the session has several pending requests.
Each Held card shows the spoken words its **Cancel message** button recalls and names
a question that still blocks delivery. A plan already filed for a later answer
can remain open while the agent receives the message.
If the daemon takes more than two seconds to confirm a held message’s recall, the card
shows that recall is unconfirmed and lets you retry or open the blocking question.
Each follow-up opens a fresh draft on the finished task’s repository. The regular Dispatch
draft stays available when the follow-up closes. If you leave the follow-up through a setup
or launch repair link, reopening Dispatch restores its instructions and attachments.

Settings > Voice > Confirmation card previews the corner toast, floating pill and tray popover.
The floating pill is the default. On macOS it appears under the menu bar on the display with
the pointer, including while the dashboard is minimized. A floating card appears without taking
keyboard focus. From another app, use **⌘Tab** to switch to Mission Control. Press **⌘⌥V** or
choose **View > Focus Voice Confirmation** to focus Cancel on a pending message. Use Tab or
Shift-Tab to reach Send now. The tray popover hangs beneath the
Mission Control icon. Click Cancel or say “cancel” before time runs out. The countdown itself
also accepts a click to send immediately. Browsers and shells without floating windows show
the corner toast. Right-click the tray icon and choose **Recently Heard** for compact history.
History takes the place of the tray card while its countdown continues. Press Escape to return
to the card if it is still active. On a desktop with tray history and no floating-card support,
Recently Heard opens from the tray while the confirmation stays in the dashboard toast.
Closing a floating window leaves its card in the toast. The next confirmation or tray history
request can open the window again. Switching placement keeps the selected message and any action in progress.
An unsure card opens the same history from **Recently heard**, or the Voice settings table in a browser. If a save times out, select the placement you want to keep. You can select the checked placement again. A delayed request
cannot replace the newer saved choice, even when that save reaffirms the current placement.
Opening either reserved route (`#/voice/pill` or `#/voice/popover`) shows
cards regardless of the saved preference. Each
route gives an open cancel window priority over a newer outcome. When the displayed
countdown expires, it switches to another open window even if the event stream is disconnected.
With no countdown open or message selected, an address awaiting a recipient choice appears
ahead of delivery results, including messages held behind a question.
When several messages remain, the Voice message selector lets you revisit their cards,
including individual turns held for the same agent. A new countdown takes priority even
when you selected another pending delivery. A stop receipt updates its own card and keeps
the current countdown selected. When the new window closes, the surface returns to your
selection if its card is still available and eligible.
If a countdown interrupts a relaunch, the standalone card keeps the result for up to one minute
while hidden. Returning to the card starts a fresh eight-second reading interval. Switching
between the dashboard and either standalone route preserves the relaunch progress and feedback.
Retrying uses the same launch request.
Setup also reports microphone permission and downloads and verifies the speech model.

With the flag off, gated voice endpoints on the server return HTTP 404 and the reconnect
snapshot omits the `voice` field. The dashboard redirects both `#/voice/pill` and
`#/voice/popover` to Fleet (`#/fleet`), including when the flag is turned off while either
view is open. It also hides the Voice settings category, the Voice setup family, and the
Call sign and Reference name fields. Saved names become available again when the flag is on.

## Listening from the desktop app

Enable Voice addressing and its required previews in Settings. In Setup, download the speech
model and choose **Ask macOS** to grant the microphone. The app also asks automatically when
the verified model and listener are available. If the request fails while permission is still
undetermined, the app retries with backoff. After a denial, **Open System Settings** opens
the microphone privacy pane. Allow Mission Control, then choose **Check again**. The desktop
app reads the current macOS permission and reports it to the daemon before Setup refreshes.

On macOS, the daemon publishes its voice port and public TLS certificate in its state directory
when Voice is enabled. The shell and its listener verify that certificate on their voice
connections. Losing the connection pauses capture. The shell reconnects if the initial snapshot
takes over 30 seconds, or if an established stream delivers neither events nor pings for 45 seconds.
After losing an enabled connection, the tray shows the struck microphone and **Voice: reconnecting**.
The shell reads the current daemon identity again before resuming from a fresh snapshot.
Turning Voice off restores the usual tray.

You can minimize the window while speaking. The menu-bar microphone means listening, and a
struck microphone means muted or unavailable. Right-click for the status and existing app
commands. Left-click to mute or unmute. While a change awaits confirmation, further clicks
are ignored. If confirmation fails, the menu opens with the last reported status and the action
to retry. The handset and microphone with waves represent the
call and push-to-talk modes when the daemon reports them. The need-you count stays beside the
icon in every mode. In `daemon.log`, the desktop app records the model revision at launch,
the child PID and exit status or signal at close, and the attempt number and delay for each
retry. A failed launch includes the OS error code. The first failed shell report in an
outage records its HTTP status when available.

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
| `MISSION_VOICE_DAEMON_URL` | The daemon's loopback HTTP origin for standalone development |
| `MISSION_VOICE_TOKEN_FILE` | Path to its token, sent as `x-harness-token` |
| `MISSION_VOICE_MODEL_DIR` | The model revision directory containing the two model repositories |

The desktop shell supplies an HTTPS origin and its pinned DER certificate in
`MISSION_VOICE_DAEMON_CERT` (base64). The managed listener requires both for its requests.

The development launcher reads the effective backend, model manifest and verified directory from
the running daemon. With the daemon set to `auto`, `--backend` can use either installed model.
If the daemon selects a specific backend, the launcher reports a conflicting override before
starting a helper. Change the daemon selection through `PUT /api/voice/config` or its
`MISSION_VOICE_BACKEND` environment, then verify the model in Voice Setup.
When macOS reports `not-determined` at startup, the helper
prints a terminal diagnostic, includes the reading in its hello and keeps the microphone
closed. Run the development command from a terminal app that already has microphone access.
An explicit denial is sent in the hello and exits with status 2. The first-time consent
prompt belongs to the desktop launcher in [phase 10](plans/voice-addressing-for-agents/phase-10-shell-and-tray.md).

On startup and every ten seconds, the helper posts protocol 4.0 to `/voice/listener/hello`.
Version 4 requires both monotonic capture bounds for released holds. Earlier protocols receive HTTP 409 at hello.
Standalone listeners generate a UUID per process. The desktop supervisor generates its own
UUID and passes it to each managed helper after the previous child exits. This lets its
replacement resume capture immediately after the daemon event stream reconnects.
Send the UUID in `x-voice-listener-id` on each hello, directive poll and utterance POST,
alongside the daemon token. The first compatible hello claims the listener lease.
While its microphone permission is granted, a listener with a different UUID
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
During push-to-talk the helper retains the interrupted prefix for up to two seconds.
If delayed key-up falls on or before the last contiguous sample boundary, the helper
can finish the phrase using only samples through release. A key-up in the gap discards it.
If the gap falls between utterances, the helper clears the lead-in and accepts the next phrase immediately.

The shell timestamps every snapshot, including idle heartbeats, at observation time with
`reportedAtHostUs`. This strictly increasing integer counts microseconds on the shared
monotonic host clock. Serialize snapshot creation and use distinct timestamps, including
across shell restarts. Retried snapshots keep their original timestamp. The daemon ignores
older, duplicate, future-dated and expired snapshots before applying state. A dated
snapshot's 15-second lifetime starts when observed, including time spent in transit.
Once it has accepted an ordered snapshot, it also ignores reports with a missing or invalid observation time.
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
on the host clock shared by the listener and daemon. The helper dates the first sample
when it detects speech and carries that timestamp through clipping and transcription.
A UUID works. IDs can contain 1 to 128 ASCII letters, digits, periods, hyphens,
underscores or tildes. The card action routes reserve the complete segments `.` and `..`.
Each timing is `{ text, startMs, endMs }`. Missing timings are treated as an empty array.
The response is `{ accepted }`. A terminal refusal produces a diagnostic without the
transcript, and the listener continues with later speech. While listening, the daemon can route a capture immediately.
A POST made while push-to-talk is held waits for the shell's key-up timestamp before
anything reaches Recently heard, a card or the queue. If the same key is still held after
25 seconds, the daemon returns `accepted: false` and its revision in `x-voice-held-revision`.
The listener retries the same POST and utterance ID after at least 250 ms. It drops that
segment after three attempts or 55 seconds, including time spent waiting for a response,
and continues with later speech. During auto-mute following key-up,
the daemon accepts the same owner's held revision for segments contained within the key interval.
The listener rounds the first sample down to host microseconds in `x-voice-capture-start-host-us`.
It also sends the first voiced sample in `x-voice-speech-start-host-us`. This optional
timestamp lies inside the posted audio interval. It orders speech against dashboard actions
even when the recorded lead-in began before a click. Clients that omit it use capture start.
It clips on 16 kHz sample boundaries and rounds the exclusive end up to host milliseconds
for `x-voice-capture-end-host-ms`. At key-up the detector tests a partial 20 ms frame
with silence padding. The recognizer receives only recorded samples through release.
A clipped prefix containing only quiet lead-in is discarded.

For sherpa WAV playback, the host times describe when the listener fed the first and last
sample windows of a detected phrase to the detector. A phrase read entirely during a hold
can finish decoding after key-up. The file listener uses the same retry budget and
utterance ID across held responses. A phrase that crosses key-up is discarded.
The daemon timestamps dashboard picks on the listener's host clock. On macOS it reads
`CLOCK_UPTIME_RAW`, the Core Audio clock in nanoseconds, and converts it to microseconds.
On Linux the host clock is `CLOCK_MONOTONIC`. The router uses these timestamps to order
commands, picks and cancels. Comparisons involving Unix-only captures use wall time.
Recently heard displays the original Unix `capturedAt`. If a POST races key-up
and extends past it, the daemon returns `accepted: false` and the release headers. The
helper transcribes the clipped PCM again before retrying. Successive key presses during the
same call preserve the release exception. Manual mute, a change of recipient, listener or input,
or leaving the call revokes it. When the shell lease lapses, a new call cannot
restore an earlier call's released revisions.
With the window off the daemon acknowledges the capture as soon as it claims delivery.
The card reports the final outcome when the queue or interrupt handler finishes.
The capture must name the backend in the live listener’s hello and agree with any explicit
backend selection. During ordinary listening the daemon drops captures dated more than
one second ahead of its host clock, or its wall clock for Unix-only clients.
For released holds it checks the monotonic key interval,
so a backward wall-clock adjustment still lets pre-release speech reach the queue.
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
When a later name could start a second message, or the first name is in doubt, the
[model step](#the-model-step) resolves that question. A later name with nothing on one
side of it (“Steve and Will, check the build”, “Steve, ping Will”) leaves the whole
message with the first agent.

During the cancel window, the message stays in memory. At the deadline, or immediately with
the window off, the daemon submits the remaining text as a spoken turn. The card and Recently heard show the delivery outcome.
For example, `Will,"ship it"` queues `"ship it"` with both quotes, and
`Will, ???` queues `???`. Only one comma separates the address from the message,
so `Will,,,` queues `,,` and `Will,,,stop` queues `,,stop`.
Quotes and brackets around an address must close in matching pairs. For example,
`“Will”ship it` queues `ship it` even without a space after the closing quote.
`[Will, ) stop` queues `) stop` as message text. An unclosed wrapper also makes the body
ordinary message text. `[Will, stop` queues the word `stop`.
The pending card keeps the session ID selected when it opened. If that session ends or another
session takes over its roster entry, the card and Recently heard show `not-running`.
“Steve, stop” bypasses the cancel window and interrupts immediately. A bare command may end with sentence punctuation
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
timestamp and can select only choices the daemon had offered by then. A matching name on another
card that was resolving at capture time keeps the pick ambiguous, even if that card has since
settled or closed. The daemon retains the last 50 choice transitions and ignores spoken picks
older than the history it can verify. For a pick through the card API, the daemon records the host time when it applies
the pick. A cancel spoken before that instant leaves the picked card pending even if its POST
arrives after the pick.
The loopback card routes are `POST /api/voice/cards/:id/cancel`,
`/send-now` and `/pick` (body `{ id: candidateId }`). A stale action returns 409.
A finished card reads its stored task’s repository from `GET /api/voice/tasks/:id/follow-up`,
including tasks that have aged out of the dashboard’s recent list.

`GET /api/voice/heard` returns `{ entries }` for the 50 most recent captures, sorted by capture
time with the latest arrival first for ties. Entries include
ignored speech, cancellations, the routing rule and any observed pause. A failed delivery includes the reason in the entry’s detail. Muted and unavailable
captures leave no record. `DELETE /api/voice/heard` clears the list. Captures, timings and
card history exist only in memory and disappear on daemon restart or disabling voice. Across a preview
toggle, the daemon remembers the last 50 accepted capture IDs so a retried “cancel” cannot dismiss
a newly opened card. A daemon restart clears those IDs. A message
actually submitted to the operator queue follows the queue’s normal durable delivery lifecycle.
After a restart, each spoken turn still queued behind a blocking question gets a held card
with its own recall control when the daemon restores its session.

## The model step

A sentence the names alone could not settle goes to one model step, with a five-second budget
for the whole of it, process start included. It asks only what is left in doubt:

- **Split or mention.** “Steve, check the build, and Alice, review the PR” is one card with two
  parts: “check the build” to Steve and “review the PR” to Alice, each verbatim from the sentence
  with the joining “and” dropped. When a comma alone marks the boundary, a lone ambiguous “and”
  or “then” stays in the first message. In “Steve, echo done then, Alice, review the PR”, Steve
  receives “echo done then” and Alice receives “review the PR” after either a model split or a
  manual split pick. “Steve, ask Alice about the build” is a mention:
  the whole text goes to Steve and nothing to Alice. A name inside a quoted sentence stays in the
  dictated text. A quote around just the addressee can still start a separate command. Each possible split is considered in spoken
  order, including repeated uses of the same name. The first split determines the two messages.
  A “not sure” before that split leaves the card unsure. A sentence with more than eight possible
  split positions goes straight to manual selection, with every position available. A name shared
  by two agents counts once at each place it occurs in the sentence.
  On an unsure card, picking the first agent keeps the whole message with that agent. Picking a
  later occurrence confirms the split there, even when both messages go to the same agent.
  If several rows share a name, their details distinguish keeping the message whole from splitting
  at the words shown. Saying the shared name alone leaves the card unsure.
- **Who.** A first word that sounds like two names (“Steven” with Steve and Stevie on the roster) asks
  which was meant, judged by sound. If the rest of the sentence contains another possible command,
  the router settles its split points after choosing the first agent, within the original deadline. If the selected spoken name belongs to several agents, the card stays unsure. The operator can pick the intended session from the roster rows.
- **Option** questions, a loosely worded answer to a card, are part of the same contract for the
  phase that answers cards by voice.

An exact first-word name is never asked about: the model decides only split or mention, a name in
doubt and an option. The step is a ladder, and every rung's answer is checked against the
question's own choices before its confidence is read, since in the spike a model gave an option
that was not on the card a confidence of 1.0.

1. **A decision model**, when one is in use (see [Faster routing](#faster-routing)): one HTTPS
   request per batch to OpenAI Decisions (`POST /v1/decisions`, model `gpt-6-luna`) or Jev
   (`POST /v1/systemone`, model pinned to `jev-1.14.0`), carrying each question as a typed choice.
   Its two-second allowance covers the whole capture, including a follow-up split question.
   A valid “not sure”, a refusal, or
   confidence below 0.98 leaves routing unsure. An error, timeout, malformed reply, or choice
   outside the offered values falls to the next rung with the time remaining.
2. **The `voice-routing` job**, with thinking off and its own short system prompt, on the time
   left. It runs on Codex (Luna, `gpt-6-luna`, floor 0.98) when every agent involved is a Codex
   session, on Claude (Haiku) when every one is a Claude session, and otherwise on the provider
   chosen for background jobs in **Settings > Models**. The Haiku rung is **off**: its retest
   passed on accuracy and missed the five-second deadline once in 60 calls (see
   [the spike findings](voice-spike-findings.md#s7-addendum-haiku-retest)), so a sentence to
   Claude sessions skips this rung. Luna is never used in its place.
3. **None**: the daemon marks the card `unsure` and includes the candidates for an operator
   pick. A missing key or a disabled rung follows this same path.

The daemon opens the card at once and puts it in the cancel order, so “cancel” stops it while the
step runs. It is published as `resolving` only once the step has taken a second. When the step
answers, the card keeps its place in the cancel order and becomes `pending` (one target, or
two parts for a split, with the ordinary cancel window) or `unsure`. Picking a split requires
both captured sessions to still match the roster. An answer that comes after the budget, or after the card was
cancelled, is dropped: nothing is ever sent late. Once a split is confirmed, the daemon checks
each captured session immediately before delivering its part. Addressed stops interrupt as soon
as the split is confirmed. Ordinary message parts keep their cancel window and delivery order.
Cancelling the remaining message marks that part as cancelled. The card shows the other
recipient's stop as in progress until its result arrives. If a session
has left or been replaced, the other recipient can still receive their part. Recently heard
lists each recipient and delivery result. The card carries the worse of the two outcomes.
The `detail` also says which rung answered and what it decided, for example `job on codex answered: split`.

Phase 4 publishes these outcomes through `voice_card` and the `voiceCards` snapshot. The confirmation card draws the on-screen candidate picker, the stopped resident and finished
session with their respective actions, the message held behind a blocking question, and the
two-message split or one-message mention. A finished session opens a separate follow-up
draft on its repository. Reopening regular Dispatch restores the operator's original draft.
The unsure card offers clickable candidates and a Recently heard link. Spoken responses follow
the [Voice Response Options plan](plans/voice-spoken-responses/phased-plan.md). The roster
in Voice settings lists addressable agents independently of these outcomes.
[Selected routing-exceptions mock-up](plans/voice-addressing-for-agents/mockup-routing-exceptions.html#b)
· [Phase 6 outcome cards](plans/voice-addressing-for-agents/phase-6-confirmation-and-outcome-cards.md)
· [Phase 12 floating surfaces](plans/voice-addressing-for-agents/phase-12-floating-surfaces-and-ask-aloud.md)

For what each model receives, see [Voice routing in the Security guide](security.md#voice-routing).

`MISSION_VOICE_OPENAI_DECISIONS_URL` and `MISSION_VOICE_JEV_URL` replace each provider's base URL
(`https://api.openai.com`, `https://api.typesafe.ai`) for a test server or a gateway. The end-to-end
suite points both at a closed loopback port, and its daemons never inherit `OPENAI_API_KEY` or
`TYPESAFE_API_KEY`, so no spec reaches a real provider; a spec that drives the rung serves both
endpoints with `startDecisionServer()`.

## Spoken delivery

An idle agent starts a turn. A busy agent receives the message after its current turn ends.
Only non-spoken outbox rows offer **Steer now** and **Interrupt and deliver**.
When the agent is waiting inside a question or plan form, spoken delivery files the ask and releases
the tool call with its receipt. The message lists the agent’s open questions. A filed plan still gates
work on the plan. If any waiting child lacks conversion support, its call stays open and the message
waits behind it. Typed messages leave the call open. A hibernated task resumes its
conversation before the daemon queues the message. Messages that arrive while that task is waking
share the resume. Each message still has its own outbox row and receipt. Recently heard and the card show `queued` (or
`held` for a blocking question, including after resume) until the outbox confirms the handoff.
Replaying a capture while its outbox row exists reuses that row for the same conversation and spoken words.
Confirmation changes the outcome to `sent`. Recalling an unsent message changes it to `cancelled`.
An outstanding card still receives that outcome after its entry leaves Recently heard.
If writing the delivery receipt fails, the card keeps its queue status while the daemon retries
the database write. A successful retry publishes the receipt without sending the message again.
A confirmed transport refusal requeues its outbox claim and withdraws its transcript reservation
in one transaction. If that write fails, the daemon retries the transaction without resending.
If transcript preparation fails before delivery, the daemon counts the attempt when it can
commit the queue update. After three failed preparations it reports the failure, releases
Foreman, and lets the following message proceed.
A stopped agent receives nothing. The
dashboard identifies the stopped agent and suggests relaunching a resident or starting a
follow-up task. A follow-up opens a separate Dispatch draft for the finished task’s repository.
If you exit the See the work tour during the repository lookup, the draft opens when the lookup
finishes. An already open follow-up stays available after tour exit.

At the first claim, the daemon appends the agent’s open asks, a reminder of any unseen reports,
and “When you have finished this, post a report.” A retry uses that exact text. The conversation
labels the operator’s words **Spoken**. Open **What the agent received** to read the payload.
After an SDK send is acknowledged, or an uncertain send is abandoned after a crash, the daemon
allows 24 hours for the client message ID and matching words to appear. Hourly cleanup checks live and persisted
conversations and the custom transcript paths saved at handoff. If the harness cannot discover a
default path, cleanup can still check the saved files. A missing saved file keeps the scan incomplete.
Cleanup scans from the beginning because a rewritten transcript can move a receipt.
It removes an unmatched payload only after reading the whole file. If the transcript is missing,
unreadable, or changes during the scan, cleanup tries again on a later sweep. If a runtime exits
mid-record, cleanup checks every complete record and reads through the unfinished line to EOF.
It waits until that file revision is at least 24 hours old before expiring unmatched receipts.
If a complete record exceeds the parser budget, cleanup can observe later receipts but keeps
unmatched payloads because it could not check that record.

A terminal delivery records the native file identity and a digest of the bytes through its delivery
offset. A worker hashes the history before the paste. The daemon checks the file revision and
the outbox claim at handoff. A matching native turn must have a timestamp at or after handoff,
within the 24-hour window, and the saved prefix must still belong to the file. A record outside
that window can precede a buffered turn inside it, so the reader checks each candidate.
Opening or updating a conversation searches
for an unbound receipt only when the displayed records could contain it. A later copy still
checks the history from handoff so the first eligible turn keeps its disclosure. If the reader
skips an oversized record, a later text match stays unlabelled. The daemon checks again when the
transcript changes. An exact SDK receipt can still identify its own record. If the proof worker
is unavailable or the record changes during verification, the dashboard shows the native transcript
and continues streaming new turns. It retries the disclosure in the background, including for pages
the operator scrolled back to. SDKs that accept client message IDs use that receipt.

Sending a typed, delegated, or review message leaves spoken transcript scans to the prepared
handoff, conversation reader, or cleanup. When a parser generates a different ID on a later
read, the daemon can identify the spoken turn by matching text and time only if the match is
unique in the file and occurs at or after the saved handoff offset.

A confirmed terminal delivery has a 24-hour window to match its transcript turn. Cleanup makes
one final binding pass and deletes the payload if it still has no match. If the transcript stays
unavailable, cleanup keeps the unbound payload for the daemon's orphan retention period (seven
days by default). A bound disclosure stays available in the conversation.

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

On Apple silicon running macOS 14 or newer, `auto` selects FluidAudio.
Elsewhere it selects sherpa-onnx. Select either backend with `PUT /api/voice/config`
or set `MISSION_VOICE_BACKEND` when starting the daemon. Switching keeps the other
backend's verified files. The sherpa download includes the int8 Parakeet TDT 0.6B v2
recognizer (about 661 MB) and a Silero speech detector (2.2 MB).

The 2026-11-23 spike sampled the sherpa process's resident memory after each file on
an M4 Pro Mac. The highest reading with the production model was about 2.0 GB.
Memory use during a file could have been higher. [Sherpa spike findings](voice-spike-findings.md#s2-sherpa-onnx)

**Sherpa currently accepts recordings only. Live microphone capture is unverified.**
On macOS or Linux, build the helper, select sherpa in the daemon, download its model
in Setup, unmute, then run
`npm run voice:listener -- --backend sherpa-onnx --input-file sample.wav` from the
checkout. Use a 16 kHz mono WAV with 8-, 16- or 32-bit integer PCM or 32-bit float samples.
The 32 MiB file limit includes the header and metadata, allowing about 17 minutes at 16 bits.
The listener validates the recording before claiming
the daemon lease, so a rejected file can be corrected and retried immediately. With capture
permission from the daemon, it detects speech, applies roster hotwords and posts timed utterances. During
playback the development listener reports its file input as granted and enumerates
zero microphones. Use ordinary listening mode for playback. After the file ends,
allow the listener’s 30-second lease to expire before launching another process. The packaged app excludes file playback. The desktop
shell starts FluidAudio for live capture. Linux supports the standalone recognizer path;
desktop capture, daemon launch, hotkeys and call detection belong to the Linux follow-on.

The dedicated Linux CI job tests the shipped addon layout against a loopback daemon with
a 16 kHz mono recording of “Steve, check the build”. The fixture uses the macOS Samantha
voice at 180 words per minute, with 400 ms of silence inserted between the name and
the message. The test checks the decoded words and their timings. Routing uses the
first word regardless of the measured gap. The pinned fp32 Parakeet 110M model
and detector cache occupy about 480 MB. Unit shards use a complete existing cache and
skip recognition on a cold cache. To run the required check locally, set
`MISSION_VOICE_RECOGNIZER_JOB=1` and run
`node --test --import ./test/setup-state.mjs --import tsx test/voice-sherpa-recognizer.test.ts`.
`MISSION_VOICE_TEST_MODEL_DIR` overrides the temporary cache location.

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

### Faster routing

The **Faster routing** group chooses the decision model (`decisionProvider`) and holds a key for
each provider, since a key belongs to a provider.

- The line at the top names the provider in use. When no provider is in use, it reads
  “Not set: routing uses Luna for Codex sessions, and shows the candidates for others”.
- **Decision model**: **Automatic** (null, the default), **Off** (`off`), **OpenAI Decisions**
  (`openai`) or **Jev** (`jev`). Automatic takes the first of four keys that exists, in a fixed
  order: a saved OpenAI Decisions key, a saved Jev key, `OPENAI_API_KEY` in the daemon's
  environment, `TYPESAFE_API_KEY` in it. So a key in the environment alone switches the decision
  model on, a saved key beats any environment key, and within each OpenAI Decisions comes first.
  A provider chosen by name is used only with its own key; another provider's key is never sent
  to it. Off sends nothing to either, whatever keys exist.
- The **OpenAI Decisions key** and **Jev key** rows show **From the environment**, **Saved on
  this Mac** or **Not set**. Enter a key and choose **Save** to add or replace that provider's
  key. Choose **Remove** to delete its saved key. If that provider also has an environment key,
  its row then shows **From the environment**. Each action affects only the selected provider.
  If the daemon cannot read the key store, the rows flag the saved key status as unavailable.
  The banner still names the provider receiving speech through an environment key, or
  describes the job and roster fallback when neither provider is in use.
  For storage and disclosure details, see [Saved voice decision keys](security.md#saved-voice-decision-keys).

`GET /api/voice/decision-key` returns `{ provider, keys: { openai: { source }, jev: { source } } }`
with `source` one of `settings`, `environment` or null. An unreadable store adds
`savedKeysUnavailable: true` and the report identifies the usable environment keys.
Dashboard reads of both config and key status carry the provider selection revision and the
order in which the daemon read the snapshot. A delayed poll can still show a new cancel-window
length, and an older result cannot make an already removed key appear saved again.
Config, device and key-status reads expire after 15 seconds. Saving or removing a key cancels
earlier key-status polls and refreshes the rows. Leaving Voice settings cancels outstanding reads.
If a save or removal goes unconfirmed for 15 seconds, the dashboard releases both rows and
reads the current key sources from the daemon.
The dashboard sends that deadline and the revision it read for the provider with each save or removal.
The daemon checks both before changing the key file. A late request cannot enable or disable routing
after the dashboard has reported the timeout.
`PUT /api/voice/decision-key` accepts
`{ provider, key }`. `DELETE /api/voice/decision-key?provider=openai` removes the saved OpenAI
Decisions key. Both operations return the updated report.

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
The indicators are configured under **Settings > Voice > In the window**. Select any combination of the status line, top-bar segment, floating button, edge light and composer microphone, or clear all five. Each checkbox sends its own `{ id, enabled }` to `PUT /api/voice/indicators`, so edits to different indicators in different windows are kept. The save response, config read, reconnect snapshot and live indicator event carry the same daemon-scoped `voiceIndicatorVersion` for a given selection. Windows ignore older revisions. Click any indicator to mute or unmute. When voice is unavailable, the control opens Setup. A shortcut appears only while the shell reports a working hotkey.

If an indicator save takes over five seconds, Settings reports that the change is unconfirmed. You can use the checkboxes again while the dashboard refreshes the saved selection. If the write commits after that refresh, the daemon sends the final selection to every connected window. Reconnecting windows receive it in their snapshot.

While a mute or unmute request is pending, the dashboard shows its progress and disables the other mute controls in that window. If the daemon takes more than five seconds to confirm the change, the controls become available again. The indicators continue to show the daemon's latest mode, including a change that arrives after the timeout.

**Recently heard** shows the latest 50 utterances, newest first, including the match, deciding rule and outcome. An exact opening name routes with or without a pause. A name mentioned later alone does not address an agent. A read that takes over five seconds shows an error and keeps the last known rows until polling succeeds. Clear empties the daemon’s in-memory history, even when the table is empty or cannot refresh. If Clear times out, the table reports that deletion is unconfirmed, resumes polling and lets you retry. Audio is never stored.

With
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
A deleted task leaves at once, even one the Registry had already evicted from memory. Agents that are not running stay listed so the
dashboard can say "<name> isn't running".

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

The state also carries `capabilities`, `configuredHotkey`, `registeredHotkey`, `hotkeyError`, `model` and `roster`.
Every window receives the saved chord and current shell registration together when either changes.
The dashboard shows a shortcut only when the shell confirms the exact configured chord,
reports the hotkey capability and has no registration error. Until then the indicator shows its
click action. A missing or expired confirmation yields `registeredHotkey: null`. The capabilities and
`hotkeyError` are copied from the latest shell report and lapse with it; with no report they are
absent and `hotkeyError` is null. `listener` is the daemon's own reading, never the shell's: available while a
hello is live, unavailable with the reason while a hello was refused for its protocol version, and
absent otherwise; a shell report's `listener` entry is dropped.
`model` is the speech model manager's reading (see [The speech model](#the-speech-model)), and
`roster` is [who can be addressed](#who-can-be-addressed).

### Routes

Dashboard routes live under `/api/voice/` behind the loopback gate:

- `GET /api/voice/config` returns `{ config }`; `PUT` applies a patch and returns `{ config }`.
  Each ordinary dashboard edit gets 15 seconds from the time it leaves the local queue.
  The dashboard uses the request and response times of daemon snapshots to estimate expiry.
  A slow response preserves an earlier, more precise estimate. If the initial estimate is too
  imprecise, the dashboard requests another sample within the edit's original time budget.
  The daemon rejects an expired patch before changing any setting.
- The dashboard reserves a provider selection with `POST /api/voice/config/provider-intent`
  and sends the returned ticket in the config write's `x-voice-provider-ticket` header. A newer
  selection can commit immediately. An older write arriving afterwards receives 409.
  A window with a stale view can retry Off when the daemon's last provider intent
  predates the click. An intervening reservation also invalidates that retry.
  An uncommitted reservation also counts when ordering clicks from different windows.
  Dashboard windows share the daemon's latest reservation receipt before submitting a write.
  A click carrying that receipt follows the reservation even if its response arrives much later.
  This protects a pending Off from a delayed opt-in and a pending provider from a delayed Off.
  A later opt-in can still switch providers if its window observed the current selection.
  The dashboard gives a provider change 75 seconds, including its reservation, write and any
  retry. If the change times out, it reads the current configuration and provider from the daemon.
  The daemon binds that deadline to the signed ticket and rejects a write that arrives after expiry.
  Fields replace, `cancelWindow` merges per key, and an unknown field or out-of-range value is a 400.
- `POST /api/voice/mute { muted }` sets `muted` and returns `{ state }`. While voice is enabled,
  the reply and the event stream carry the same daemon-scoped `modeVersion`. The dashboard
  displays the newest confirmed mode whichever arrives first.
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
  major version from this daemon's (`4`) is refused with 409 `unsupported_protocol`.
  If there is no other active owner, the state's `listener` capability says why.
- `POST /voice/shell-report { capabilities, microphone, callActive, pushToTalk, reportedAtHostUs?, pushToTalkPressedAtHostUs?, pushToTalkReleasedAtHostUs?, registeredHotkey, hotkeyError }`,
  sent by the desktop shell. A dated report lapses 15 seconds after observation. An
  accepted undated report lapses 15 seconds after arrival. Capability ids this build
  does not know are dropped rather than refused.

[Phase 10](plans/voice-addressing-for-agents/phase-10-shell-and-tray.md) introduces the shell report producer.
[Phase 11](plans/voice-addressing-for-agents/phase-11-hotkey-and-calls.md) connects it to the native hotkey registrar.
On successful registration, Electron must include the registrar's confirmed chord in `registeredHotkey` on each report.
If replacing a chord fails, it reports the chord still in force and the registration error. With no registration,
it reports `null`. The producer regression test belongs alongside the registrar and checks the outgoing report
after a successful registration, a failed replacement, and unregistration.

### Following it

The dashboard and the desktop shell follow the state through the `voice` snapshot field and the
`voice_state` event. When each is sent, and the one frame that says voice is off, are in
[the event stream](event-stream.md#voice).

## Tests

- `test/voice-state.test.ts`: `voiceMode` for each mode, the reasons, a hello and a shell report
  lapsing, and a refused protocol version.
- `test/voice-routing.test.ts`: each routing rule, an exact first word with a later name asking
  split or mention with the target fixed, and where a split cuts the sentence.
- `test/voice-decide.test.ts`, with both real provider adapters over a fake `fetch` answering in
  each provider's documented reply shape and a scripted job: the key order (each source alone,
  both saved, a saved Jev key against `OPENAI_API_KEY`, a chosen provider, Off, a chosen provider
  with only the other's key), a provider error or timeout falling to the job on what is left of the
  budget, a job past the deadline, a low confidence, a choice that is not on the list at 1.0, a
  refusal, the job's provider following the agents, and the router's split, mention, unsure,
  `resolving` and cancel-while-resolving.
- `test/voice-decision-key-http.test.ts` covers saving and removing keys independently, each
  provider's reported source, and the credential protections in the security guide.
- `test/voice-utterances-http.test.ts`: the routes, the cancel order and delivery, with a scripted
  model step, including a split queued to each agent.
- `test/voice-config-http.test.ts`: defaults, patches, mute, the token routes, the frames, and
  HTTP 404 responses from gated server endpoints with the flag off.
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
- `e2e/specs/voice-decision-key.spec.ts`: a saved OpenAI Decisions key reads **Saved on this Mac**
  and the group names OpenAI Decisions, the page never holds the key, and Remove clears it; with
  keys on both rows Automatic names OpenAI Decisions and choosing Jev names Jev, and a split
  sentence reaches Jev with its own key; with `OPENAI_API_KEY` in the daemon's environment the
  group names OpenAI Decisions and the row reads **From the environment**, and Off reads **Not
  set** while the suite's fake Codex answers the routing job for split and mention.
  `startDecisionServer()` in `e2e/fixtures/voice.ts` answers both providers' endpoints, and the
  suite's daemon never inherits either variable, so no spec reaches a provider.
