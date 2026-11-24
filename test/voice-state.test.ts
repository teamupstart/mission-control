import { fixtureSupervisorEnv, fixtureVoiceSupervisor } from "./helpers/voice-supervisor.ts";
// Voice state (contract B): the pure mode rule, the reasons, and the daemon's store with a fake
// clock - a hello and a shell report lapsing, a refused protocol version, and capabilities.
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import {
  canonicalVoiceState,
  VOICE_CONFIG_DEFAULTS,
  VOICE_HELLO_LAPSE_MS,
  VOICE_LISTENER_PROTOCOL_VERSION,
  VOICE_MODEL_STATE_NONE,
  VOICE_SHELL_REPORT_LAPSE_MS,
  VoiceConfigSchema,
  VoiceShellReportSchema,
  voiceCapable,
  voiceMode,
  voiceStateOff,
  voiceUnavailableReasons,
  type VoiceConfig,
  type VoiceListenerHello,
  type VoiceModeInputs,
  type VoiceShellReport,
  type VoiceState,
} from "../src/shared/voice.ts";
import { VoiceStateStore } from "../src/server/voice/state.ts";
import { voiceMicrophoneSetupStatus } from "../src/shared/voice-models.ts";

Object.assign(process.env, fixtureSupervisorEnv);
before(() => ensureNativeStateLockAddon());

const base: VoiceModeInputs = {
  enabled: true, reasons: [], muted: false, callActive: false, autoMuteDuringCalls: true, pushToTalk: false,
};

test("voiceMode decides each mode in its order", () => {
  assert.equal(voiceMode({ ...base, enabled: false, reasons: ["flags"], muted: true }), "off", "off outranks everything");
  assert.equal(voiceMode({ ...base, reasons: ["listener"], muted: true }), "unavailable", "a reason outranks mute");
  assert.equal(voiceMode({ ...base, muted: true, callActive: true, pushToTalk: true }), "muted", "mute outranks a call");
  assert.equal(voiceMode({ ...base, callActive: true }), "auto-muted");
  assert.equal(voiceMode({ ...base, callActive: true, pushToTalk: true }), "push-to-talk");
  assert.equal(voiceMode({ ...base, callActive: true, autoMuteDuringCalls: false }), "listening", "auto-mute off ignores a call");
  assert.equal(voiceMode({ ...base, pushToTalk: true }), "listening", "push-to-talk means something only during auto-mute");
  assert.equal(voiceMode(base), "listening");
});

test("voiceUnavailableReasons names every reason that holds, in order", () => {
  const loaded = { modelLoaded: true, microphone: "granted" as const };
  assert.deepEqual(voiceUnavailableReasons({ requiredFlagsOn: true, hello: loaded, shellMicrophone: null }), []);
  assert.deepEqual(voiceUnavailableReasons({ requiredFlagsOn: false, hello: loaded, shellMicrophone: null }), ["flags"]);
  assert.deepEqual(voiceUnavailableReasons({ requiredFlagsOn: true, hello: null, shellMicrophone: null }), ["listener"]);
  assert.deepEqual(
    voiceUnavailableReasons({ requiredFlagsOn: true, hello: { modelLoaded: false, microphone: "granted" }, shellMicrophone: null }),
    ["model"],
  );
  assert.deepEqual(
    voiceUnavailableReasons({ requiredFlagsOn: true, hello: { modelLoaded: true, microphone: "denied" }, shellMicrophone: null }),
    ["microphone"],
    "a hello can say access is denied",
  );
  assert.deepEqual(
    voiceUnavailableReasons({ requiredFlagsOn: false, hello: null, shellMicrophone: "denied" }),
    ["flags", "listener", "microphone"],
    "a shell report can say so with no listener at all",
  );
  // Without a hello nothing says whether a model is loaded, so only `listener` holds.
  assert.ok(!voiceUnavailableReasons({ requiredFlagsOn: true, hello: null, shellMicrophone: null }).includes("model"));
});

test("the config schema holds every contract A field with its default", () => {
  assert.deepEqual(VoiceConfigSchema.parse({}), {
    muted: false,
    hotkey: "ctrl+alt+m",
    autoMuteDuringCalls: true,
    cancelWindow: { enabled: true, seconds: 4 },
    whenUnsure: "show", speech: { voice: null },
    planFormsByVoice: true,
    inputDevice: "built-in",
    decisionProvider: null,
    backend: "auto",
  });
  // A stored row from before a field existed gains it with its default.
  assert.equal(VoiceConfigSchema.parse({ muted: true }).cancelWindow.seconds, 4);
  assert.equal(VoiceConfigSchema.parse({ hotkey: null }).hotkey, null, "no hotkey is a real answer");
});

// ---- the store ----

const ALL_FLAGS = new Set(["voice", "async-input", "inbox", "filed-plan-decisions"]);
const listenerId = crypto.randomUUID();
const HELLO: VoiceListenerHello = {
  backend: "sherpa-onnx", version: VOICE_LISTENER_PROTOCOL_VERSION, devices: [], modelLoaded: true, microphone: "granted",
};
const REPORT: VoiceShellReport = {
  capabilities: {}, microphone: null, callActive: false, pushToTalk: false, hotkeyError: null,
};

function harness(options: { flags?: Set<string>; config?: Partial<VoiceConfig> } = {}) {
  let now = 1_000_000;
  const flags = options.flags ?? new Set(ALL_FLAGS);
  let config: VoiceConfig = { ...VOICE_CONFIG_DEFAULTS, ...options.config };
  const timers: Array<{ fn: () => void; at: number }> = [];
  const store = new VoiceStateStore({
    now: () => now,
    hostNowUs: () => now * 1000,
    enabled: (id) => flags.has(id),
    config: () => config,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as (typeof timers)[number]);
      if (at >= 0) timers.splice(at, 1);
    },
  });
  const published: VoiceState[] = [];
  store.onChange((state) => published.push(state));
  return {
    store,
    hostNowUs: () => now * 1000,
    flags,
    published,
    setConfig: (patch: Partial<VoiceConfig>) => { config = { ...config, ...patch }; },
    /** Move the clock and fire every timer that came due, as the real ones would. */
    advance(ms: number): void {
      now += ms;
      for (let due = timers.find((t) => t.at <= now); due; due = timers.find((t) => t.at <= now)) {
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
    timers,
  };
}

test("with the flag off the state is off, whatever was heard", () => {
  const h = harness({ flags: new Set(["async-input", "inbox", "filed-plan-decisions"]) });
  h.store.acceptHello(listenerId, HELLO);
  assert.deepEqual(h.store.state(), voiceStateOff());
  assert.equal(h.timers.length, 0, "nothing is scheduled while voice is off");
});

test("mute replies and published modes share a revision ordered within one daemon", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  const initial = h.store.state().modeVersion;
  assert.ok(initial);
  h.store.acceptHello(listenerId, HELLO);
  assert.deepEqual(h.store.state().modeVersion, initial);
  for (const [index, muted] of [true, false].entries()) {
    h.setConfig({ muted });
    h.store.publish();
    const state = h.store.state();
    assert.equal(state.mode, muted ? "muted" : "listening");
    assert.deepEqual(state.modeVersion, { source: initial.source, revision: initial.revision + index + 1 });
    assert.deepEqual(state.modeVersion, h.published.at(-1)?.modeVersion);
  }
  const restarted = harness();
  restarted.store.acceptHello(listenerId, HELLO);
  assert.notEqual(restarted.store.state().modeVersion?.source, initial.source);
});

test("unavailable until a listener says hello; then listening; then unavailable once it lapses", () => {
  const h = harness();
  assert.deepEqual(h.store.state().reasons, ["listener"]);
  assert.equal(h.store.state().mode, "unavailable");

  h.store.acceptHello(listenerId, HELLO);
  assert.equal(h.store.state().mode, "listening");
  assert.deepEqual(h.store.state().capabilities.listener, { available: true, reason: null });
  assert.equal(h.published.at(-1)?.mode, "listening", "a hello publishes at once");

  h.advance(VOICE_HELLO_LAPSE_MS - 1);
  assert.equal(h.store.state().mode, "listening", "still inside the lapse");
  h.advance(1);
  assert.equal(h.published.at(-1)?.mode, "unavailable", "the lapse is published by its timer, with no request");
  assert.deepEqual(h.published.at(-1)?.reasons, ["listener"]);
  assert.equal(h.store.state().capabilities.listener, undefined, "no reading, so the capability is absent");
});

test("a hello saying no model is loaded, or the microphone denied, gives that reason", () => {
  const h = harness();
  h.store.acceptHello(listenerId, { ...HELLO, modelLoaded: false });
  assert.deepEqual(h.store.state().reasons, ["model"]);
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "denied" });
  assert.deepEqual(h.store.state().reasons, ["microphone"]);
});

test("a required flag off reads as the flags reason", () => {
  const h = harness();
  h.flags.delete("inbox");
  h.store.acceptHello(listenerId, HELLO);
  assert.equal(h.store.state().mode, "unavailable");
  assert.deepEqual(h.store.state().reasons, ["flags"]);
});

test("a hello with an unknown major version is refused, and the state says why", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  const refused = h.store.acceptHello(listenerId, { ...HELLO, version: "1.0" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /protocol 1\.0.*4\.0/);
  const state = h.store.state();
  assert.equal(state.mode, "unavailable", "the refused listener replaces the one heard before");
  assert.deepEqual(state.reasons, ["listener"]);
  assert.equal(state.capabilities.listener?.available, false);
  assert.match(state.capabilities.listener?.reason ?? "", /protocol 1\.0/);
  // A minor version is not compared.
  assert.equal(h.store.acceptHello(listenerId, { ...HELLO, version: "4.7.2" }).ok, true);
  assert.deepEqual(h.store.state().capabilities.listener, { available: true, reason: null });
  // And the refusal lapses like a hello.
  h.store.acceptHello(listenerId, { ...HELLO, version: "3.0" });
  h.advance(VOICE_HELLO_LAPSE_MS);
  assert.equal(h.store.state().capabilities.listener, undefined);
});

test("mute, a call with auto-mute, and push-to-talk come from the config and the shell report", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  h.setConfig({ muted: true });
  assert.equal(h.store.state().mode, "muted");
  h.setConfig({ muted: false });
  h.store.acceptShellReport({ ...REPORT, callActive: true });
  assert.equal(h.store.state().mode, "auto-muted");
  h.store.acceptShellReport({ ...REPORT, callActive: true, pushToTalk: true, reportedAtHostUs: h.hostNowUs() });
  assert.equal(h.store.state().mode, "push-to-talk");
  h.setConfig({ autoMuteDuringCalls: false });
  assert.equal(h.store.state().mode, "listening");
});

test("a dated key-down can authorize capture only for the lease remaining since observation", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  h.store.acceptShellReport({ ...REPORT, callActive: true });
  const down = { ...REPORT, callActive: true, pushToTalk: true };
  const nowUs = h.hostNowUs();
  h.store.acceptShellReport({ ...down, reportedAtHostUs: nowUs - VOICE_SHELL_REPORT_LAPSE_MS * 1000 });
  assert.equal(h.store.state().mode, "auto-muted");
  assert.equal(h.store.directive().capture, false);
  h.store.acceptShellReport({ ...down, reportedAtHostUs: nowUs - (VOICE_SHELL_REPORT_LAPSE_MS - 2000) * 1000 });
  assert.equal(h.store.state().mode, "push-to-talk");
  h.advance(1999);
  assert.equal(h.store.state().mode, "push-to-talk");
  h.advance(1);
  assert.equal(h.published.at(-1)?.mode, "listening");
});

test("a shell report's capabilities and hotkey error are copied, and lapse with it", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  assert.deepEqual(h.store.state().capabilities, { listener: { available: true, reason: null }, "speech-output": { available: false, reason: "This listener cannot play speech." } });
  assert.equal(h.store.state().registeredHotkey, null);
  assert.equal(h.store.state().hotkeyError, null);
  h.store.acceptShellReport({
    ...REPORT,
    capabilities: {
      hotkey: { available: true, reason: null },
      "call-detection": { available: false, reason: "Needs macOS 14.2 or later." },
      // A capability this build does not know is dropped, not refused.
      "teleport": { available: true, reason: null },
    },
    registeredHotkey: "ctrl+alt+m",
    hotkeyError: { reason: "Another app owns ⌥Space.", chordInForce: "ctrl+alt+m" },
  });
  const state = h.store.state();
  assert.ok(voiceCapable(state, "hotkey"));
  assert.equal(state.registeredHotkey, "ctrl+alt+m");
  assert.equal(state.configuredHotkey, "ctrl+alt+m");
  h.setConfig({ hotkey: "ctrl+alt+k" });
  assert.equal(h.store.state().configuredHotkey, "ctrl+alt+k");
  assert.equal(h.store.state().registeredHotkey, "ctrl+alt+m");
  assert.notEqual(canonicalVoiceState(state), canonicalVoiceState(h.store.state()));
  assert.ok(!voiceCapable(state, "call-detection"));
  assert.equal(state.capabilities["call-detection"]?.reason, "Needs macOS 14.2 or later.");
  assert.equal(Object.hasOwn(state.capabilities, "teleport"), false);
  assert.deepEqual(state.hotkeyError, { reason: "Another app owns ⌥Space.", chordInForce: "ctrl+alt+m" });

  h.advance(VOICE_SHELL_REPORT_LAPSE_MS);
  assert.equal(h.published.at(-1)?.capabilities.hotkey, undefined, "the lapse is published");
  assert.equal(h.store.state().registeredHotkey, null);
  assert.equal(h.store.state().hotkeyError, null);
  assert.equal(h.store.state().mode, "listening", "the hello has not lapsed yet");
});

test("a shell report cannot claim the listener: that capability is the daemon's own reading", () => {
  const h = harness();
  h.store.acceptShellReport({ ...REPORT, capabilities: { listener: { available: true, reason: null }, tray: { available: true, reason: null } } });
  let state = h.store.state();
  assert.deepEqual(state.reasons, ["listener"], "no hello, so no listener");
  assert.equal(state.capabilities.listener, undefined, "the shell's claim is dropped, not copied");
  assert.equal(voiceCapable(state, "listener"), false);
  assert.deepEqual(state.capabilities.tray, { available: true, reason: null }, "its other capabilities still come through");
  // A shell saying it is unavailable does not override a live hello either.
  h.store.acceptHello(listenerId, HELLO);
  h.store.acceptShellReport({ ...REPORT, capabilities: { listener: { available: false, reason: "shell says no" } } });
  state = h.store.state();
  assert.deepEqual(state.capabilities.listener, { available: true, reason: null });
  assert.equal(state.mode, "listening");
});

test("a lapsing shell report ends a call's auto-mute at the 15 second boundary, and the timer publishes it", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  h.store.acceptShellReport({ ...REPORT, callActive: true });
  assert.equal(h.store.state().mode, "auto-muted");
  assert.equal(h.published.at(-1)?.mode, "auto-muted", "the report publishes at once");
  const before = h.published.length;
  h.advance(VOICE_SHELL_REPORT_LAPSE_MS - 1);
  assert.equal(h.store.state().mode, "auto-muted", "still muted one millisecond before the boundary");
  assert.equal(h.published.length, before, "nothing is published before it");
  h.advance(1);
  assert.equal(h.published.at(-1)?.mode, "listening", "the lapse timer publishes the change, with no request");
  assert.equal(h.published.length, before + 1);
  assert.equal(h.store.state().mode, "listening", "at the boundary the call is no longer known");
});

test("a shell report saying the microphone is denied makes voice unavailable", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  h.store.acceptShellReport({ ...REPORT, microphone: "denied" });
  assert.deepEqual(h.store.state().reasons, ["microphone"]);
});

test("with no model manager the model reads as nothing known, and the roster is empty until Phase 2", () => {
  const h = harness();
  h.store.acceptHello(listenerId, HELLO);
  assert.deepEqual(h.store.state().model, VOICE_MODEL_STATE_NONE);
  assert.deepEqual(h.store.state().roster, []);
});

test("the microphone reading is the newest report's, and a live denial from either source wins", () => {
  const h = harness();
  assert.equal(h.store.microphoneReading(), null, "nothing has reported yet");
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "granted" });
  assert.deepEqual(h.store.microphoneReading(), { permission: "granted", source: "listener" });
  h.advance(1000);
  h.store.acceptShellReport(VoiceShellReportSchema.parse({ microphone: "not-determined" }));
  assert.deepEqual(h.store.microphoneReading(), { permission: "not-determined", source: "shell" }, "the newer reading");
  h.advance(1000);
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "denied" });
  h.advance(1000);
  h.store.acceptShellReport(VoiceShellReportSchema.parse({ microphone: "granted" }));
  assert.deepEqual(h.store.microphoneReading(), { permission: "denied", source: "listener" }, "a live denial wins");
  h.store.acceptShellReport(VoiceShellReportSchema.parse({}));
  assert.deepEqual(h.store.microphoneReading(), { permission: "denied", source: "listener" }, "a report with no permission says nothing");
});

test("a lapsed denial with nothing newer still stands: a listener stopping does not change macOS's answer", () => {
  const h = harness();
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "denied" });
  h.advance(VOICE_HELLO_LAPSE_MS * 2);
  assert.deepEqual(h.store.microphoneReading(), { permission: "denied", source: "listener" });
});

test("a lapsed denial gives way to a newer grant from the other source, so Check again can clear it", () => {
  // The desktop app reports denied. The operator allows Mission Control in System Settings and
  // quits the app, and a listener then reports granted.
  const h = harness();
  h.store.acceptShellReport(VoiceShellReportSchema.parse({ microphone: "denied" }));
  h.advance(1000);
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "granted" });
  assert.deepEqual(h.store.microphoneReading(), { permission: "denied", source: "shell" }, "while the app's report is live it still wins");
  h.advance(VOICE_SHELL_REPORT_LAPSE_MS);
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "granted" });
  assert.deepEqual(h.store.microphoneReading(), { permission: "granted", source: "listener" }, "once it lapses the newer grant counts");
  assert.deepEqual(voiceMicrophoneSetupStatus(h.store.microphoneReading()), {
    state: "satisfied", evidence: "Allowed, as the voice listener reports",
  });
});

test("a shell's microphone denial wins over a later listener grant", () => {
  // The reverse of the order above: the desktop app says denied first, then a listener says
  // granted. The newer reading does not override a denial; the Setup row still reports the shell's.
  const h = harness();
  h.store.acceptShellReport(VoiceShellReportSchema.parse({ microphone: "denied" }));
  h.advance(1000);
  h.store.acceptHello(listenerId, { ...HELLO, microphone: "granted" });
  assert.deepEqual(h.store.microphoneReading(), { permission: "denied", source: "shell" });
  assert.deepEqual(voiceMicrophoneSetupStatus(h.store.microphoneReading()), {
    state: "needs-setup",
    why: "macOS denied the microphone to Mission Control.",
    evidence: "As the desktop app reports",
  });
});

test("the listener's devices are offered only while its hello is live", () => {
  const h = harness();
  assert.equal(h.store.listenerDevices(), null);
  const devices = [{ id: "usb-1", name: "Desk microphone", builtIn: false }];
  h.store.acceptHello(listenerId, { ...HELLO, devices });
  assert.deepEqual(h.store.listenerDevices(), devices);
  h.advance(VOICE_HELLO_LAPSE_MS);
  assert.equal(h.store.listenerDevices(), null);
});

test("canonicalVoiceState ignores key order and nothing else", () => {
  const a: VoiceState = {
    ...voiceStateOff(), mode: "listening",
    capabilities: { tray: { available: true, reason: null }, hotkey: { available: false, reason: "x" } },
  };
  const b: VoiceState = { ...a, capabilities: { hotkey: { available: false, reason: "x" }, tray: { available: true, reason: null } } };
  assert.equal(canonicalVoiceState(a), canonicalVoiceState(b));
  assert.notEqual(canonicalVoiceState(a), canonicalVoiceState({ ...a, mode: "muted" }));
});

test("speech output belongs to the daemon and needs a supervised, capable listener and a ready voice", () => {
  const h = harness();
  const { instance, proof } = fixtureVoiceSupervisor();
  const speech = { audio: true, systemVoices: [{ id: "speaker", name: "Speaker", language: "en-US", quality: "premium" as const }] };
  const capability = () => h.store.state().capabilities["speech-output"];
  h.store.acceptShellReport({ ...REPORT, capabilities: { "speech-output": { available: true, reason: null } } });
  assert.match(capability()?.reason ?? "", /No listener/);
  h.store.acceptHello(listenerId, HELLO);
  assert.match(capability()?.reason ?? "", /cannot play/);
  h.store.acceptHello(listenerId, { ...HELLO, speech }, instance);
  assert.match(capability()?.reason ?? "", /not started by a supervisor/);
  h.store.speech.supervised(instance, "started", proof("started"));
  assert.deepEqual(capability(), { available: true, reason: null });
  h.store.acceptHello(listenerId, { ...HELLO, speech: { ...speech, systemVoices: [] } }, instance);
  assert.match(capability()?.reason ?? "", /No voice is ready/);
  assert.equal(JSON.stringify(h.published).includes(instance), false);
});
