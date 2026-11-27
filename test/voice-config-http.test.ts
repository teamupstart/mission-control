// Voice's routes over HTTP (contracts A and B): the config's defaults and patches, mute, the
// listener's hello and the shell report under the token, the snapshot field and `voice_state`
// frames, and every route answering 404 with the flag off.
import assert from "node:assert/strict";
import { mkTask } from "./helpers/session-fixture.ts";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-voice-http-"));
process.env.MISSION_HOME = home;
const { closeDb, setAppConfig, getAppConfig, deleteAppConfig, openDb, upgradeDatabaseToCurrentSchema, upsertTask } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { voiceStateStore, wireVoiceStateEvents } = await import("../src/server/voice/state.ts");
const { reloadVoiceConfig } = await import("../src/server/voice/config.ts");
const { onVoiceIndicatorsChanged } = await import("../src/server/ui-config.ts");
const { VOICE_CONFIG_DEFAULTS, VOICE_INDICATORS_MAX, VOICE_LISTENER_PROTOCOL_VERSION, VoiceConfigSchema } = await import("../src/shared/voice.ts");
type VoiceState = import("../src/shared/voice.ts").VoiceState;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
const token = ensureToken();
const listenerId = crypto.randomUUID();
const registry = new Registry();
const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
const frames: VoiceState[] = [];
registry.on("event", (event: ServerEvent) => { if (event.type === "voice_state") frames.push(event.state); });
const stopVoice = wireVoiceStateEvents((state) => registry.emitVoiceState(state));
after(() => { stopVoice(); closeDb(); rmSync(home, { recursive: true, force: true }); });

const json = (path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) =>
  app.request(path, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const hello = (body: Record<string, unknown> = {}, auth: string | null = token) => json("/voice/listener/hello", "POST", {
  backend: "sherpa-onnx", version: VOICE_LISTENER_PROTOCOL_VERSION, devices: [], modelLoaded: true, microphone: "granted", ...body,
}, auth === null ? {} : { "x-harness-token": auth, "x-voice-listener-id": listenerId });
const report = (body: Record<string, unknown>, auth: string | null = token) =>
  json("/voice/shell-report", "POST", body, auth === null ? {} : { "x-harness-token": auth });
const setFlag = (id: "voice" | "async-input" | "inbox" | "filed-plan-decisions", enabled: boolean) =>
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id, enabled }).ok, true);

beforeEach(() => {
  deleteAppConfig(APP_CONFIG_ENTRIES.voice);
  reloadVoiceConfig();
  voiceStateStore.reset();
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"] as const) setFlag(id, true);
  frames.length = 0;
});

test("config snapshots advance across a cancel-window edit at the same provider revision", async () => {
  const snapshot = async () => {
    const result = await json("/api/voice/config", "GET", undefined, { "x-voice-provider-revision": "read" });
    return await result.json() as { config: { cancelWindow: { seconds: number } }; providerRevision: string; snapshotOrder: number };
  };
  const before = await snapshot();
  assert.equal((await json("/api/voice/config", "PUT", { cancelWindow: { seconds: 8 } })).status, 200);
  const after = await snapshot();
  assert.equal(after.config.cancelWindow.seconds, 8);
  assert.equal(before.providerRevision, after.providerRevision);
  assert.ok(before.snapshotOrder < after.snapshotOrder);
});

test("with the flag off every route answers 404, writes nothing, and the snapshot has no voice", async () => {
  setFlag("voice", false);
  const disabled = { error: "This feature is disabled.", feature: "voice" };
  for (const response of [
    await json("/api/voice/tasks/stored/follow-up"),
    await json("/api/voice/config"),
    await json("/api/voice/config", "PUT", { muted: true }),
    await json("/api/voice/config/provider-intent", "POST"),
    await json("/api/voice/hotkey-recording", "POST"),
    await json("/api/voice/mute", "POST", { muted: true }),
    await json("/api/voice/mute"),
    await json("/api/voice/indicators", "PUT", { id: "edge", enabled: true }),
    await hello(),
    await report({}),
  ]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), disabled);
  }
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.voice), undefined);
  assert.equal("voice" in registry.snapshot(), false);
  assert.equal("voiceIndicators" in registry.snapshot(), false);
  assert.equal("voiceIndicatorVersion" in registry.snapshot(), false);
});

test("follow-up uses the stored task repository even when the finished task is outside the registry", async () => {
  const id = "old-finished-task";
  upsertTask(mkTask({ id, status: "done", repoRoot: "/repo/finished" }));
  assert.equal(registry.getTask(id), undefined);
  const response = await json("/api/voice/tasks/" + id + "/follow-up");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { repoRoot: "/repo/finished" });
  const missing = await json("/api/voice/tasks/missing/follow-up");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "The finished task could not be found.");
});

test("GET returns every contract A field with its default", async () => {
  const response = await json("/api/voice/config");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { config: VOICE_CONFIG_DEFAULTS });
});

test("new and existing voice profiles default to two seconds and preserve independent Cancel settings", async () => {
  const config = async () => (await (await json("/api/voice/config")).json()).config;
  assert.equal((await config()).endOfSpeechMs, 2000);
  setAppConfig(APP_CONFIG_ENTRIES.voice, { cancelWindow: { enabled: false, seconds: 7 } });
  assert.equal((await config()).endOfSpeechMs, 2000);
  for (const endOfSpeechMs of [500, 5000]) {
    assert.equal((await json("/api/voice/config", "PUT", { endOfSpeechMs })).status, 200);
    assert.equal((await config()).endOfSpeechMs, endOfSpeechMs);
    assert.deepEqual((await config()).cancelWindow, { enabled: false, seconds: 7 });
  }
  assert.equal((await json("/api/voice/config", "PUT", { endOfSpeechMs: 0 })).status, 400);
  assert.equal((await config()).endOfSpeechMs, 5000);
});

test("dedicated push-to-talk ignores mute commands and preserves the prior Always-on mute", async () => {
  await json("/api/voice/mute", "POST", { muted: true });
  await json("/api/voice/config", "PUT", { listeningMode: "push-to-talk" });
  for (const command of [{ toggle: true }, { muted: false }]) {
    const response = await json("/api/voice/mute", "POST", command);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state.muted, true);
  }
  const restored = await json("/api/voice/config", "PUT", { listeningMode: "always-on" });
  assert.equal((await restored.json()).config.muted, true);
});

test("reading mute after a toggle returns the authoritative state without another write", async () => {
  await json("/api/voice/mute", "POST", { toggle: true });
  const applied = voiceStateStore.state();
  assert.equal(applied.muted, true);
  const readback = await json("/api/voice/mute");
  assert.equal(readback.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await readback.json(), { state: applied });
  assert.deepEqual(voiceStateStore.state(), applied);
});

test("a recorder owns the shortcut only until disconnect and cannot be opened by a foreign origin", async () => {
  const path = "/api/voice/hotkey-recording";
  assert.equal((await json(path, "POST", undefined, { origin: "https://example.org" })).status, 403);
  const res = await json(path, "POST");
  assert.equal(res.status, 200);
  assert.equal(voiceStateStore.state().recordingHotkey, true);
  assert.equal((await json(path, "POST")).status, 409);
  await json("/api/voice/mute", "POST", { toggle: true });
  assert.equal(voiceStateStore.state().muted, false, "a key queued before unregistration does not mute");
  const end = new Promise<void>(resolve => {
    const stop = voiceStateStore.onChange(state => { if (!state.recordingHotkey) { stop(); resolve(); } });
  });
  await res.body!.cancel();
  await end;
  await json("/api/voice/mute", "POST", { toggle: true });
  assert.equal(voiceStateStore.state().muted, true);
});

test("only a confirmed replacement becomes the saved hotkey, including across a restart after refusal", async t => {
  let nowUs = 1_000_000;
  t.mock.method(voiceStateStore, "hostNowUs", () => nowUs);
  const propose = (hotkey: string | null) => json("/api/voice/config", "PUT", { hotkey });
  const snapshot = (registeredHotkey: string, reason?: string, reportedAtHostUs = ++nowUs, trialId?: string) =>
    report({ capabilities: { hotkey: { available: true } }, registeredHotkey, reportedAtHostUs,
      hotkeyError: reason ? { reason, chordInForce: registeredHotkey, trialId } : null });
  const saved = async () => (await (await json("/api/voice/config")).json()).config.hotkey;
  await propose("ctrl+k");
  assert.equal(await saved(), VOICE_CONFIG_DEFAULTS.hotkey);
  assert.equal(voiceStateStore.state().pendingHotkey, "ctrl+k");
  await snapshot("ctrl+k");
  assert.equal(await saved(), "ctrl+k");
  assert.equal(voiceStateStore.state().pendingHotkey, undefined);

  const beforeEdit = ++nowUs;
  nowUs++;
  await propose("alt+Space");
  const previousTrial = voiceStateStore.state().pendingHotkeyId;
  assert.ok(previousTrial);
  await snapshot("alt+Space", undefined, beforeEdit);
  assert.equal(await saved(), "ctrl+k", "a snapshot taken before the edit cannot approve it");
  await propose("alt+Space");
  const currentTrial = voiceStateStore.state().pendingHotkeyId;
  assert.ok(currentTrial && currentTrial !== previousTrial);
  await snapshot("ctrl+k", "Reserved.", ++nowUs, previousTrial);
  assert.equal(voiceStateStore.state().pendingHotkeyId, currentTrial, "a heartbeat may repeat an earlier refusal for the same chord");
  await snapshot("ctrl+k", "Reserved.");
  assert.equal(voiceStateStore.state().pendingHotkeyId, currentTrial, "a legacy refusal cannot identify this trial");
  await snapshot("ctrl+k", "Reserved.", ++nowUs, currentTrial);
  assert.equal(voiceStateStore.state().pendingHotkey, undefined);
  assert.equal(voiceStateStore.state().hotkeyError?.chordInForce, "ctrl+k");
  const reopened = new DatabaseSync(join(home, "harness.db"), { readOnly: true });
  try {
    const row = reopened.prepare("SELECT value FROM app_config WHERE key = ?").get(APP_CONFIG_ENTRIES.voice.key);
    assert.equal(JSON.parse(String(row?.value)).hotkey, "ctrl+k");
  } finally { reopened.close(); }
  voiceStateStore.reset();
  assert.equal(voiceStateStore.state().configuredHotkey, "ctrl+k");
  assert.equal(await saved(), "ctrl+k");

  await propose("ctrl+p");
  await propose("ctrl+j");
  await snapshot("ctrl+p");
  assert.equal(await saved(), "ctrl+k", "a superseded proposal cannot commit");
  await snapshot("ctrl+j");
  assert.equal(await saved(), "ctrl+j");
  await propose("alt+Space");
  await propose(null);
  await snapshot("alt+Space");
  assert.equal(await saved(), null);
});

test("Speak replies aloud off survives a daemon restart and a later voice choice", async t => {
  // Leave the shared config as the next test expects it, whatever order the file runs in.
  t.after(async () => {
    assert.equal((await json("/api/voice/config", "PUT", { speech: { voice: null, playback: true } })).status, 200);
  });
  const saved = async () => (await (await json("/api/voice/config")).json()).config.speech;
  assert.equal((await saved()).playback, true, "spoken replies are on by default");
  assert.equal((await json("/api/voice/config", "PUT", { speech: { playback: false } })).status, 200);
  // A new process opens the state database on its own connection and parses the row with the schema.
  const reopened = new DatabaseSync(join(home, "harness.db"), { readOnly: true });
  try {
    const row = reopened.prepare("SELECT value FROM app_config WHERE key = ?").get(APP_CONFIG_ENTRIES.voice.key);
    assert.equal(VoiceConfigSchema.parse(JSON.parse(String(row?.value))).speech.playback, false,
      "a fresh read of the state database restores the switch as off");
  } finally { reopened.close(); }

  // The daemon's own startup path: the config is reloaded from storage and the state store starts over.
  reloadVoiceConfig();
  voiceStateStore.reset();
  assert.deepEqual(await saved(), { voice: null, playback: false });
  assert.equal(voiceStateStore.state().capabilities["speech-output"]?.code, "speech_playback_off");

  const voice = { engine: "system", id: "fixture" };
  assert.equal((await json("/api/voice/config", "PUT", { speech: { voice } })).status, 200);
  assert.deepEqual(await saved(), { voice, playback: false }, "choosing a voice keeps spoken replies off");
});

test("the schema upgrade replaces only the stored legacy default and preserves later explicit selections", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  upgradeDatabaseToCurrentSchema(db);
  const save = db.prepare("INSERT OR REPLACE INTO app_config(key, value) VALUES ('voice', ?)");
  const read = () => db.prepare("SELECT value FROM app_config WHERE key = 'voice'").get()!.value;
  for (const config of [{ hotkey: "ctrl+alt+m", muted: true, future: 4 }, { hotkey: "ctrl+k" }, { hotkey: null }, {}]) {
    save.run(JSON.stringify(config));
    db.exec("PRAGMA user_version = 62");
    upgradeDatabaseToCurrentSchema(db);
    assert.deepEqual(JSON.parse(String(read())), config.hotkey === "ctrl+alt+m"
      ? { ...config, hotkey: VOICE_CONFIG_DEFAULTS.hotkey } : config);
  }
  save.run('{"hotkey":"ctrl+alt+m"}');
  upgradeDatabaseToCurrentSchema(db);
  assert.equal(read(), '{"hotkey":"ctrl+alt+m"}', "selecting the old chord after upgrading survives restart");
});

const readProviderRevision = async () => {
  const read = await json("/api/voice/config", "GET", undefined, { "x-voice-provider-revision": "read" });
  return (await read.json() as { providerRevision: string }).providerRevision;
};
const providerIntent = (writer: string, observedRevision: string) =>
  json("/api/voice/config/provider-intent", "POST", { writer, observedRevision });
const choose = (provider: string, ticket: string) =>
  json("/api/voice/config", "PUT", { decisionProvider: provider }, { "x-voice-provider-ticket": ticket });
const reserveFor = async (writer: string, revision: string) => {
  const res = await providerIntent(writer, revision);
  assert.equal(res.status, 200);
  return (await res.json() as { ticket: string }).ticket;
};

test("a provider ticket cannot enable routing after the edit expired", async t => {
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  await json("/api/voice/config", "PUT", { decisionProvider: "off" });
  const revision = await readProviderRevision();
  const ticket = await reserveFor(randomUUID(), revision);
  elapsed = 75_000;
  assert.equal((await choose("openai", ticket)).status, 409);
  assert.equal(await readProviderRevision(), revision);
  assert.equal((await (await json("/api/voice/config")).json()).config.decisionProvider, "off");
});

test("the config route rejects an expired dashboard patch without changing either field", async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const expiry = { "x-voice-config-expires-at": String(start + 15_000) };
  const change = (seconds: number, muted: boolean) => json("/api/voice/config", "PUT", { cancelWindow: { seconds }, muted }, expiry);
  assert.equal((await change(6, true)).status, 200);
  t.mock.timers.tick(15_000);
  const late = await change(8, false);
  assert.equal(late.status, 409);
  const { config } = await (await json("/api/voice/config")).json();
  assert.equal(config.cancelWindow.seconds, 6);
  assert.equal(config.muted, true);
});

test("a delayed provider reservation uses only the time remaining on the original edit", async t => {
  const clicked = Date.now();
  let elapsed = 74_900;
  t.mock.method(Date, "now", () => clicked + elapsed);
  t.mock.method(performance, "now", () => elapsed);
  await json("/api/voice/config", "PUT", { decisionProvider: "off" });
  const observedRevision = await readProviderRevision();
  const reserve = (expiresAt: number) => json("/api/voice/config/provider-intent", "POST",
    { writer: randomUUID(), observedRevision, expiresAt, edit: 1 });
  const first = await reserve(clicked + 75_000);
  assert.equal(first.status, 200);
  elapsed += 100;
  assert.equal((await choose("openai", (await first.json()).ticket)).status, 409);
  assert.equal((await reserve(clicked + 75_000)).status, 409);
  const next = await reserve(Date.now() + 10_000);
  assert.equal(next.status, 200);
  assert.equal((await choose("jev", (await next.json()).ticket)).status, 200);
});

test("an earlier reserved provider write cannot undo Off, a restore, or a legacy write", async () => {
  const writer = randomUUID();
  const reserve = async () => reserveFor(writer, await readProviderRevision());
  const earlier = await reserve();
  const off = await reserve();
  assert.equal((await choose("off", off)).status, 200);
  assert.equal((await choose("openai", earlier)).status, 409);
  assert.equal((await choose("jev", off)).status, 409);
  const beforeRestore = await reserve();
  reloadVoiceConfig();
  assert.equal((await choose("jev", beforeRestore)).status, 409);
  const beforeLegacy = await reserve();
  assert.equal((await json("/api/voice/config", "PUT", { decisionProvider: "off" })).status, 200);
  assert.equal((await choose("jev", beforeLegacy)).status, 409);
  assert.equal((await choose("jev", await reserve())).status, 200);
});

test("provider choices from another window invalidate both stale reservations and stalled commits", async () => {
  const first = randomUUID(), second = randomUUID();
  const observed = await readProviderRevision();
  const off = await reserveFor(second, observed);
  const pending = await reserveFor(first, observed);
  assert.equal((await choose("off", off)).status, 200);
  assert.equal((await choose("jev", pending)).status, 409);
  const stale = await providerIntent(first, observed);
  assert.equal(stale.status, 409);
  const { config, providerRevision } = await stale.json() as { config: typeof VOICE_CONFIG_DEFAULTS; providerRevision: string };
  assert.equal(config.decisionProvider, "off");
  assert.equal(providerRevision, await readProviderRevision());
  assert.equal((await choose("jev", await reserveFor(first, providerRevision))).status, 200);
  assert.equal((await providerIntent(first, observed)).status, 409);
});

test("a ticketed Off supersedes an older commit and yields to a newer commit from another window", async () => {
  const writer = randomUUID(), other = randomUUID();
  for (const offIsNewer of [true, false]) {
    const revision = await readProviderRevision();
    const first = await reserveFor(writer, revision);
    const second = await reserveFor(other, revision);
    assert.equal((await choose("jev", offIsNewer ? first : second)).status, 200);
    const off = await choose("off", offIsNewer ? second : first);
    assert.equal(off.status, offIsNewer ? 200 : 409);
    const { config } = await (await json("/api/voice/config")).json() as { config: typeof VOICE_CONFIG_DEFAULTS };
    assert.equal(config.decisionProvider, offIsNewer ? "off" : "jev");
  }
});

test("a stale Off retry cannot reserve past an intervening uncommitted selection", async () => {
  const first = randomUUID(), second = randomUUID();
  const old = await readProviderRevision();
  assert.equal((await choose("jev", await reserveFor(second, old))).status, 200);
  const conflict = await providerIntent(first, old);
  assert.equal(conflict.status, 409);
  const { providerRevision, intentWindow } = await conflict.json() as {
    providerRevision: string; intentWindow: { token: string; quietForMs: number };
  };
  assert.ok(intentWindow.quietForMs >= 0);
  const next = await reserveFor(second, providerRevision);
  const retry = await json("/api/voice/config/provider-intent", "POST", {
    writer: first, observedRevision: providerRevision, unchangedSince: intentWindow.token,
  });
  assert.equal(retry.status, 409);
  assert.equal((await choose("openai", next)).status, 200);
});

test("reserving Off protects the still-current revision before its PUT arrives", async () => {
  const a = randomUUID(), b = randomUUID();
  const revision = await readProviderRevision();
  const intent = await json("/api/voice/config/provider-intent", "POST", { writer: a, observedRevision: revision, optOut: true });
  assert.equal(intent.status, 200);
  const { ticket } = await intent.json() as { ticket: string };
  const conflict = await providerIntent(b, revision);
  assert.equal(conflict.status, 409);
  const { intentWindow } = await conflict.json() as { intentWindow: { token: string; pendingSelection: boolean } };
  assert.equal(intentWindow.pendingSelection, true);
  assert.equal((await choose("jev", ticket)).status, 409);
  assert.equal((await choose("off", ticket)).status, 200);
  const retry = await json("/api/voice/config/provider-intent", "POST", { writer: b, observedRevision: revision, unchangedSince: intentWindow.token });
  assert.equal(retry.status, 409);
});

test("an uncommitted provider ticket blocks a cross-window Off reservation against the same applied revision", async () => {
  const observedRevision = await readProviderRevision();
  const reserve = (writer: string, optOut: boolean) => json("/api/voice/config/provider-intent", "POST", {
    writer, observedRevision, edit: 1, optOut,
  });
  const jev = await reserve(randomUUID(), false);
  assert.equal(jev.status, 200);
  const off = await reserve(randomUUID(), true);
  assert.equal(off.status, 409);
  assert.equal((await off.json()).intentWindow.pendingSelection, true);
  assert.equal((await choose("jev", (await jev.json()).ticket)).status, 200);
});

test("a receipt proves the preceding pending intent and expires at the next selection", async () => {
  const observedRevision = await readProviderRevision();
  const reserve = (writer: string, optOut: boolean, observedIntent?: string) => json("/api/voice/config/provider-intent", "POST", {
    writer, observedRevision, edit: 1, optOut, observedIntent,
  });
  const { intentReceipt, ticket: jev } = await (await reserve(randomUUID(), false)).json();
  assert.ok(intentReceipt);
  const b = randomUUID();
  assert.equal((await reserve(b, true, "unknown-receipt")).status, 409);
  const later = await reserve(b, true, intentReceipt);
  assert.equal(later.status, 200);
  const off = await later.json();
  assert.notEqual(off.intentReceipt, intentReceipt);
  assert.equal((await reserve(randomUUID(), false, intentReceipt)).status, 409);
  assert.equal((await choose("off", off.ticket)).status, 200);
  assert.equal((await choose("jev", jev)).status, 409);
  assert.equal((await reserve(randomUUID(), false, intentReceipt)).status, 409);
  const newer = await reserve(randomUUID(), false, off.intentReceipt);
  assert.equal(newer.status, 200);
  assert.equal((await choose("jev", (await newer.json()).ticket)).status, 200);
});

test("a provider ticket that observed a pending Off survives its commit", async () => {
  const observedRevision = await readProviderRevision();
  const reserve = (writer: string, optOut: boolean, observedIntent?: string) =>
    json("/api/voice/config/provider-intent", "POST", { writer, optOut, observedIntent, observedRevision, edit: 1 });
  const off = await (await reserve(randomUUID(), true)).json();
  const jev = await reserve(randomUUID(), false, off.intentReceipt);
  assert.equal(jev.status, 200);
  assert.equal((await choose("off", off.ticket)).status, 200);
  const { ticket } = await jev.json();
  assert.equal((await choose("jev", ticket + "x")).status, 409);
  assert.equal((await choose("jev", ticket)).status, 200);
});

test("shared browser click order survives delayed reservations in either arrival order", async () => {
  for (const laterArrivesFirst of [false, true]) {
    const observedRevision = await readProviderRevision();
    const group = randomUUID();
    const reserve = (order: number) => json("/api/voice/config/provider-intent", "POST", {
      writer: randomUUID(), observedRevision, gesture: { group, order }, edit: 1, optOut: order === 2,
    });
    if (laterArrivesFirst) {
      const later = await reserve(2);
      assert.equal(later.status, 200);
      assert.equal((await reserve(1)).status, 409);
      assert.equal((await choose("off", (await later.json()).ticket)).status, 200);
    } else {
      const earlier = await reserve(1);
      assert.equal(earlier.status, 200);
      const later = await reserve(2);
      assert.equal(later.status, 200);
      assert.equal((await choose("off", (await later.json()).ticket)).status, 200);
      assert.equal((await choose("jev", (await earlier.json()).ticket)).status, 409);
    }
  }
});

test("a later browser provider switch can cross its earlier commit but cannot cross a foreign commit", async () => {
  for (const sameBrowser of [true, false]) {
    const observedRevision = await readProviderRevision();
    const group = randomUUID();
    const reserve = (group: string, order: number) => json("/api/voice/config/provider-intent", "POST", {
      writer: randomUUID(), observedRevision, gesture: { group, order }, edit: 1,
    });
    const first = await reserve(group, 1);
    assert.equal((await choose("openai", (await first.json()).ticket)).status, 200);
    const second = await reserve(sameBrowser ? group : randomUUID(), 2);
    assert.equal(second.status, sameBrowser ? 200 : 409);
    if (sameBrowser) assert.equal((await choose("jev", (await second.json()).ticket)).status, 200);
  }
});

test("a browser counter cannot order an intervening reservation from another storage group", async () => {
  const observedRevision = await readProviderRevision();
  const group = randomUUID();
  const reserve = (group: string, order: number, observedIntent?: string) => json("/api/voice/config/provider-intent", "POST", {
    writer: randomUUID(), observedRevision, edit: 1, gesture: { group, order }, observedIntent,
  });
  const first = await (await reserve(group, 1)).json();
  const foreign = await (await reserve(randomUUID(), 1, first.intentReceipt)).json();
  const following = await reserve(group, 2, foreign.intentReceipt);
  assert.equal(following.status, 200);
  assert.equal((await reserve(group, 3)).status, 409);
  assert.equal((await choose("jev", (await following.json()).ticket)).status, 200);
});

test("a window can supersede only its own earlier pending Off", async () => {
  const a = randomUUID(), b = randomUUID(), revision = await readProviderRevision();
  const reserve = (writer: string, edit: number, optOut: boolean, unchangedSince?: string) => json("/api/voice/config/provider-intent", "POST", {
    writer, observedRevision: revision, edit, optOut, unchangedSince,
  });
  assert.equal((await reserve(a, 2, true)).status, 200);
  assert.equal((await reserve(a, 1, false)).status, 409);
  assert.equal((await reserve(a, 3, false)).status, 200);
  const laterOff = await reserve(b, 1, true);
  assert.equal(laterOff.status, 409);
  assert.equal((await reserve(b, 1, true, (await laterOff.json()).intentWindow.token)).status, 200);
  const foreign = await reserve(a, 4, true);
  assert.equal(foreign.status, 409);
  const own = await reserve(a, 4, true, (await foreign.json()).intentWindow.token);
  assert.equal(own.status, 200);
  assert.equal((await reserve(a, 5, false)).status, 409);
  assert.equal((await choose("off", (await own.json()).ticket)).status, 200);
});

test("newer explicit provider tickets win across windows unless an intervening Off invalidated their view", async () => {
  const a = randomUUID(), b = randomUUID();
  for (const newerFirst of [false, true]) {
    const base = await readProviderRevision();
    const older = await reserveFor(a, base);
    const newer = await reserveFor(b, base);
    if (!newerFirst) assert.equal((await choose("openai", older)).status, 200);
    assert.equal((await choose("jev", newer)).status, 200);
    if (newerFirst) assert.equal((await choose("openai", older)).status, 409);
    assert.equal((await (await json("/api/voice/config")).json()).config.decisionProvider, "jev");
  }
  const base = await readProviderRevision();
  const off = await reserveFor(a, base);
  const ownOptIn = await reserveFor(a, base);
  const stale = await reserveFor(b, base);
  assert.equal((await choose("off", off)).status, 200);
  assert.equal((await choose("openai", ownOptIn)).status, 200);
  assert.equal((await choose("jev", stale)).status, 409);
});

test("a card clock probe returns only daemon time while Voice is enabled", async () => {
  const before = Date.now();
  const monotonicBefore = performance.now();
  const response = await json("/api/voice/config", "HEAD");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  const stamp = Number(response.headers.get("X-Voice-Server-Time-Ms"));
  assert.ok(stamp >= before && stamp <= Date.now());
  const monotonic = Number(response.headers.get("X-Voice-Monotonic-Time-Ms"));
  assert.ok(monotonic >= monotonicBefore && monotonic <= performance.now());
  setFlag("voice", false);
  const disabled = await json("/api/voice/config", "HEAD");
  assert.equal(disabled.status, 404);
  assert.equal(disabled.headers.get("X-Voice-Server-Time-Ms"), null);
  assert.equal(disabled.headers.get("X-Voice-Monotonic-Time-Ms"), null);
});

test("a confirmed placement advances the selection revision without changing indicators", async () => {
  const write = async (confirmation: string) => (await json("/api/voice/confirmation", "PUT", { confirmation })).json();
  const start = await write("toast");
  const saved = await write("pill");
  assert.equal(saved.confirmation, "pill");
  assert.deepEqual(saved.indicators, start.indicators);
  assert.equal(saved.voiceIndicatorVersion.source, start.voiceIndicatorVersion.source);
  assert.ok(saved.voiceIndicatorVersion.revision > start.voiceIndicatorVersion.revision);
  assert.deepEqual(registry.snapshot().voiceIndicatorVersion, saved.voiceIndicatorVersion);
});

test("a placement body that arrives late cannot undo a newer save, including for an unversioned caller", async t => {
  const path = "/api/voice/confirmation";
  const initial = await (await json(path, "PUT", { confirmation: "toast" })).json();
  const published: string[][] = [];
  t.after(onVoiceIndicatorsChanged(indicators => published.push(indicators)));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const newer = await json(path, "PUT", { confirmation: "popover", expectedVersion: initial.voiceIndicatorVersion });
      assert.equal(newer.status, 200);
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ confirmation: "pill" })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const stale = await app.request(path, { method: "PUT", headers, body, duplex: "half" } as RequestInit & { duplex: "half" });
  assert.equal(stale.status, 409);
  const current = await stale.json();
  assert.equal(current.confirmation, "popover");
  assert.deepEqual(current.voiceIndicatorVersion, registry.snapshot().voiceIndicatorVersion);
  assert.deepEqual(current.indicators, initial.indicators);
  assert.equal(published.length, 1);
  const previousDaemon = { ...current.voiceIndicatorVersion, source: "previous-daemon" };
  assert.equal((await json(path, "PUT", { confirmation: "pill", expectedVersion: previousDaemon })).status, 409);
  assert.equal((await (await json("/api/ui/config")).json()).config.voice.confirmation, "popover");
});

test("reaffirming the current placement publishes a new revision and supersedes an older choice", async t => {
  const path = "/api/voice/confirmation";
  const toast = await (await json(path, "PUT", { confirmation: "toast" })).json();
  let announced: ServerEvent | undefined;
  t.after(onVoiceIndicatorsChanged(indicators => registry.emitVoiceIndicators(indicators)));
  t.after(registry.subscribe(event => { if (event.type === "voice_indicators") announced = event; }));
  const reaffirm = await json(path, "PUT", { confirmation: "toast", expectedVersion: toast.voiceIndicatorVersion });
  assert.equal(reaffirm.status, 200);
  const saved = await reaffirm.json();
  assert.ok(saved.voiceIndicatorVersion.revision > toast.voiceIndicatorVersion.revision);
  assert.deepEqual(announced, { type: "voice_indicators", confirmation: "toast", indicators: toast.indicators, voiceIndicatorVersion: saved.voiceIndicatorVersion });
  const stale = await json(path, "PUT", { confirmation: "pill", expectedVersion: toast.voiceIndicatorVersion });
  assert.equal(stale.status, 409);
  assert.equal((await (await json("/api/ui/config")).json()).config.voice.confirmation, "toast");
});

test("indicator edits publish the persisted selection in order and preserve unknown ids on reconnect", async (t) => {
  const selections: string[][] = [];
  const revisions: number[] = [];
  t.after(registry.subscribe(event => {
    if (event.type === "voice_indicators") {
      selections.push(event.indicators);
      revisions.push(event.voiceIndicatorVersion!.revision);
    }
  }));
  t.after(onVoiceIndicatorsChanged(indicators => registry.emitVoiceIndicators(indicators)));
  const write = (id: string, enabled: boolean) => json("/api/voice/indicators", "PUT", { id, enabled });
  const initial = { confirmation: "toast", indicators: ["future-style", "status-line"] };
  assert.equal((await json("/api/ui/config", "PUT", { voice: initial })).status, 200);
  const updates = await Promise.all([write("edge", true), write("floating", true)]);
  assert.ok(updates.every(response => response.ok));
  const unchanged = await (await write("edge", true)).json();
  assert.deepEqual(unchanged.voiceIndicatorVersion, registry.snapshot().voiceIndicatorVersion);
  const removal = await (await write("status-line", false)).json();
  assert.equal((await write("unrecognized", true)).status, 400);
  const { config, voiceIndicatorVersion } = await (await json("/api/ui/config")).json();
  assert.deepEqual(removal.voiceIndicatorVersion, voiceIndicatorVersion);
  assert.deepEqual(registry.snapshot().voiceIndicatorVersion, voiceIndicatorVersion);
  assert.deepEqual(revisions, [3, 2, 1, 0].map(offset => voiceIndicatorVersion.revision - offset));
  assert.equal(voiceIndicatorVersion.revision, revisions.at(-1));
  assert.equal(config.voice.confirmation, "toast");
  assert.deepEqual(selections[0], initial.indicators);
  assert.deepEqual(selections.at(-1), config.voice.indicators);
  assert.equal(selections.length, 4, "only the initial save and three changes publish");
  assert.deepEqual(config.voice.indicators.sort(), ["edge", "floating", "future-style"]);
  assert.deepEqual(registry.snapshot().voiceIndicators?.sort(), config.voice.indicators);
});

test("a full indicator list refuses an addition and still permits removing an indicator", async () => {
  const indicators = Array.from({ length: VOICE_INDICATORS_MAX - 1 }, (_, index) => `future-${index}`);
  assert.equal((await json("/api/ui/config", "PUT", { voice: { confirmation: "pill", indicators: [...indicators, "edge"] } })).status, 200);
  assert.equal((await json("/api/voice/indicators", "PUT", { id: "topbar", enabled: true })).status, 409);
  const removed = await json("/api/voice/indicators", "PUT", { id: "edge", enabled: false });
  assert.deepEqual(await removed.json(), { indicators, confirmation: "pill", voiceIndicatorVersion: registry.snapshot().voiceIndicatorVersion });
});

test("PUT applies a patch, merges the cancel window per key, and persists it", async () => {
  let response = await json("/api/voice/config", "PUT", { cancelWindow: { seconds: 8 }, whenUnsure: "ask", planFormsByVoice: false });
  assert.equal(response.status, 200);
  let { config } = await response.json() as { config: typeof VOICE_CONFIG_DEFAULTS };
  assert.deepEqual(config.cancelWindow, { enabled: true, seconds: 8 });
  assert.equal(config.whenUnsure, "ask");
  assert.equal(config.planFormsByVoice, false);

  response = await json("/api/voice/config", "PUT", { cancelWindow: { enabled: false }, hotkey: null, decisionProvider: "off", backend: "sherpa-onnx" });
  ({ config } = await response.json() as { config: typeof VOICE_CONFIG_DEFAULTS });
  assert.deepEqual(config.cancelWindow, { enabled: false, seconds: 8 }, "the length another write set survives");
  assert.equal(config.hotkey, null);
  assert.equal(config.decisionProvider, "off");
  assert.equal(config.backend, "sherpa-onnx");
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.voice), config);
  assert.deepEqual((await (await json("/api/voice/config")).json() as { config: unknown }).config, config);
});

test("PUT accepts the cancel window's limits, 1 and 30 seconds, and persists each", async () => {
  for (const seconds of [1, 30]) {
    const response = await json("/api/voice/config", "PUT", { cancelWindow: { seconds } });
    assert.equal(response.status, 200, `${seconds} seconds`);
    const { config } = await response.json() as { config: typeof VOICE_CONFIG_DEFAULTS };
    assert.deepEqual(config.cancelWindow, { enabled: true, seconds });
    assert.deepEqual((getAppConfig(APP_CONFIG_ENTRIES.voice) as typeof VOICE_CONFIG_DEFAULTS).cancelWindow, { enabled: true, seconds });
    assert.deepEqual((await (await json("/api/voice/config")).json() as { config: typeof VOICE_CONFIG_DEFAULTS }).config.cancelWindow, { enabled: true, seconds });
  }
});

test("a stored voice config this build cannot read reads as the defaults and is left as stored", async () => {
  // Out of range for this build's schema: a newer build with a wider bound could have written it.
  const unreadable = JSON.stringify({ muted: true, cancelWindow: { enabled: true, seconds: 999 }, whenUnsure: "guess" });
  openDb().prepare("INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(APP_CONFIG_ENTRIES.voice.key, unreadable);
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    const response = await json("/api/voice/config");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { config: VOICE_CONFIG_DEFAULTS }, "every field reads as its default");
    assert.equal(voiceStateStore.state().mode, "unavailable", "the state still computes, from the defaults");
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((args) => String(args[0]).includes("[voice] stored config does not parse")), "the fallback is logged");
  const stored = openDb().prepare("SELECT value FROM app_config WHERE key = ?").get(APP_CONFIG_ENTRIES.voice.key) as { value: string };
  assert.equal(stored.value, unreadable, "a read never rewrites the stored value");
});

test("PUT /api/ui/config saves ui.voice and reads it back; an unknown placement is refused and changes nothing", async () => {
  const saved = await json("/api/ui/config", "PUT", { voice: { confirmation: "toast", indicators: ["status-line", "topbar"] } });
  assert.equal(saved.status, 200);
  const expected = { confirmation: "toast", indicators: ["status-line", "topbar"] };
  assert.deepEqual((await saved.json() as { config: { voice: unknown } }).config.voice, expected);
  assert.deepEqual((await (await json("/api/ui/config")).json() as { config: { voice: unknown } }).config.voice, expected);

  for (const body of [{ voice: { confirmation: "banner", indicators: ["status-line"] } }, { voice: { confirmation: "pill" } }]) {
    const refused = await json("/api/ui/config", "PUT", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await (await json("/api/ui/config")).json() as { config: { voice: unknown } }).config.voice, expected, "the saved value is unchanged");
  assert.deepEqual((getAppConfig(APP_CONFIG_ENTRIES.ui) as { voice: unknown }).voice, expected);
});

test("with the flag off GET /api/ui/config has no voice field and a ui.voice write is refused; the stored value returns with the flag", async () => {
  const kept = { confirmation: "popover", indicators: ["edge"] };
  assert.equal((await json("/api/ui/config", "PUT", { voice: kept })).status, 200);
  setFlag("voice", false);

  const read = await (await json("/api/ui/config")).json() as { config: Record<string, unknown> };
  assert.equal("voice" in read.config, false, "the response is the one an install without voice gave");
  const refused = await json("/api/ui/config", "PUT", { voice: { confirmation: "toast", indicators: [] } });
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: "This feature is disabled.", feature: "voice" });
  const mixed = await json("/api/ui/config", "PUT", { richText: false, voice: { confirmation: "toast", indicators: [] } });
  assert.equal(mixed.status, 404, "a patch naming voice is refused whole");
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.ui) as { richText: boolean }).richText, true, "nothing in it was saved");
  // Other UI settings still save, and their answer carries no voice field either.
  const other = await json("/api/ui/config", "PUT", { richText: false });
  assert.equal(other.status, 200);
  assert.equal("voice" in (await other.json() as { config: Record<string, unknown> }).config, false);
  assert.deepEqual((getAppConfig(APP_CONFIG_ENTRIES.ui) as { voice: unknown }).voice, kept, "the stored value is kept");

  setFlag("voice", true);
  assert.deepEqual((await (await json("/api/ui/config")).json() as { config: { voice: unknown } }).config.voice, kept);
  await json("/api/ui/config", "PUT", { richText: true });
});

test("PUT refuses an empty patch, an unknown field and an out-of-range value, writing nothing", async () => {
  for (const body of [{}, { loudness: 11 }, { cancelWindow: { seconds: 0 } }, { cancelWindow: { seconds: 31 } }, { whenUnsure: "guess" }, { decisionProvider: "acme" }]) {
    const response = await json("/api/voice/config", "PUT", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const garbled = await app.request("/api/voice/config", { method: "PUT", headers, body: "{not json" });
  assert.equal(garbled.status, 400);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.voice), undefined);
});

test("the token routes refuse a request without the token", async () => {
  assert.equal((await hello({}, null)).status, 401);
  assert.equal((await hello({}, "0".repeat(token.length))).status, 401);
  assert.equal((await report({}, null)).status, 401);
  assert.equal(voiceStateStore.state().reasons.includes("listener"), true, "nothing was heard");
});

test("a hello makes voice listen, mute mutes it, and every change reaches the event stream", async () => {
  assert.deepEqual(registry.snapshot().voice?.reasons, ["listener"]);
  const response = await hello();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, protocol: VOICE_LISTENER_PROTOCOL_VERSION });
  assert.equal(registry.snapshot().voice?.mode, "listening");
  assert.equal(frames.at(-1)?.mode, "listening");

  const framesBefore = frames.length;
  await hello();
  assert.equal(frames.length, framesBefore, "a steady hello restates the state and sends no frame");

  const muted = await json("/api/voice/mute", "POST", { muted: true });
  assert.equal(muted.status, 200);
  assert.equal((await muted.json() as { state: VoiceState }).state.mode, "muted");
  assert.equal(frames.at(-1)?.mode, "muted");
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.voice) as { muted: boolean }).muted, true);
  await json("/api/voice/mute", "POST", { muted: false });
  assert.equal(frames.at(-1)?.mode, "listening");
  for (const mode of ["muted", "listening"]) {
    const toggled = await json("/api/voice/mute", "POST", { toggle: true });
    assert.equal((await toggled.json() as { state: VoiceState }).state.mode, mode);
  }
  assert.equal((await json("/api/voice/mute", "POST", { muted: "yes" })).status, 400);
});

test("a window that connects after a lapse but before its timer fires still sees the listener come back", async (t) => {
  // Mocked time: the hello's lapse passes while its timer has not fired, which is the window a
  // late timer leaves on a busy daemon.
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  t.mock.method(performance, "now", () => Date.now() - 1_000_000);
  try {
    voiceStateStore.reset();
    await hello();
    // The store's own reading: a frame may not be sent, if the last test already left `listening`.
    assert.equal(voiceStateStore.state().mode, "listening");
    mock.timers.setTime(1_000_000 + 30_001);
    const snapshot = registry.snapshot().voice;
    assert.equal(snapshot?.mode, "unavailable", "the snapshot is computed now, so the lapse already shows");
    assert.equal(frames.at(-1)?.mode, "unavailable", "and it is published, so lastVoice matches what was handed out");
    await hello();
    assert.equal(frames.at(-1)?.mode, "listening", "the returning listener reaches the window that connected in between");
  } finally {
    voiceStateStore.reset();
    mock.timers.reset();
  }
});

test("protocol 1.0 is refused at hello before unversioned captures can start", async () => {
  await hello();
  const response = await hello({ version: "1.0" });
  assert.equal(response.status, 409);
  const body = await response.json() as { error: string; reason: string; protocol: string };
  assert.equal(body.error, "unsupported_protocol");
  assert.equal(body.protocol, VOICE_LISTENER_PROTOCOL_VERSION);
  const state = registry.snapshot().voice!;
  assert.equal(state.mode, "unavailable");
  assert.equal(state.capabilities.listener?.available, false);
  assert.equal(state.capabilities.listener?.reason, body.reason);
  assert.equal((await hello({ version: "two" })).status, 400, "a version that is not one is a 400");
});

test("a process UUID is required and a legacy hello cannot displace a live owner", async () => {
  const body = { backend: "fluidaudio", version: VOICE_LISTENER_PROTOCOL_VERSION, devices: [], modelLoaded: true, microphone: "granted" };
  const send = (version: string, id?: string) => json("/voice/listener/hello", "POST", { ...body, version },
    { "x-harness-token": token, ...(id && { "x-voice-listener-id": id }) });
  for (const id of [undefined, "invalid"]) {
    const refused = await send(body.version, id);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "invalid_listener_id");
  }
  assert.equal((await hello()).status, 200);
  const legacy = await send("2.0");
  assert.equal(legacy.status, 409);
  assert.equal((await legacy.json()).error, "unsupported_protocol");
  assert.equal(voiceStateStore.state().mode, "listening");
});

test("a shell report's capabilities, call and hotkey error reach the state", async () => {
  await hello();
  const response = await report({
    capabilities: { tray: { available: true }, hotkey: { available: false, reason: "No desktop shell." } },
    callActive: true,
    hotkeyError: { reason: "Another app owns the chord.", chordInForce: "ctrl+alt+m" },
  });
  assert.equal(response.status, 200);
  const { state } = await response.json() as { state: VoiceState };
  assert.equal(state.mode, "auto-muted");
  assert.deepEqual(state.capabilities.tray, { available: true, reason: null });
  assert.deepEqual(state.capabilities.hotkey, { available: false, reason: "No desktop shell." });
  assert.deepEqual(state.hotkeyError, { reason: "Another app owns the chord.", chordInForce: "ctrl+alt+m" });
  assert.equal(frames.at(-1)?.mode, "auto-muted");

  // Turning auto-mute off through the config changes the mode at once.
  await json("/api/voice/config", "PUT", { autoMuteDuringCalls: false });
  assert.equal(frames.at(-1)?.mode, "listening");
});

test("a required flag switched off reads as the flags reason; voice off sends one off frame", async () => {
  await hello();
  setFlag("filed-plan-decisions", false);
  assert.equal(frames.at(-1)?.mode, "unavailable");
  assert.deepEqual(frames.at(-1)?.reasons, ["flags"]);

  setFlag("voice", false);
  assert.equal(frames.at(-1)?.mode, "off", "the frame that tells the shell voice is off");
  const count = frames.length;
  setFlag("inbox", false);
  assert.equal(frames.length, count, "while voice is off another flag sends nothing");
  assert.equal("voice" in registry.snapshot(), false);
});

async function transcriptEndpoint() {
  assert.equal((await hello()).status, 200);
  const auth = { "x-harness-token": token, "x-voice-listener-id": listenerId };
  const directive = await json("/voice/listener/directive", "GET", undefined, auth);
  assert.equal(directive.status, 200);
  const { revision } = await directive.json();
  return { path: "/voice/listener/transcript?revision=" + encodeURIComponent(revision), auth };
}

test("transcript word limits 1 and 100 apply live, and out-of-range or fractional edits cannot be saved", async () => {
  const { path, auth } = await transcriptEndpoint();
  const words = Array.from({ length: 101 }, (_, i) => `word${i + 1}`);
  const sample = await json(path, "POST", { phase: "words", onset: 1, text: words.join(" ") }, auth);
  assert.deepEqual(await sample.json(), { accepted: true });
  const save = (transcriptWords: number) => json("/api/voice/config", "PUT", { transcriptWords });
  const saved = async () => (await (await json("/api/voice/config")).json()).config.transcriptWords;
  for (const limit of [1, 100]) {
    assert.equal((await save(limit)).status, 200);
    assert.equal(await saved(), limit);
    assert.equal(voiceStateStore.state().transcript?.text, words.slice(-limit).join(" "));
  }
  for (const invalid of [0, 101, 2.5]) {
    assert.equal((await save(invalid)).status, 400);
    assert.equal(await saved(), 100);
    assert.equal(voiceStateStore.state().transcript?.text, words.slice(-100).join(" "));
  }
});

test("unauthorized and malformed transcript samples leave the current words intact", async () => {
  const { path, auth } = await transcriptEndpoint();
  const sample = { phase: "words", onset: 1, text: "current words" };
  assert.deepEqual(await (await json(path, "POST", sample, auth)).json(), { accepted: true });
  const before = voiceStateStore.state().transcript;
  assert.equal(before?.text, sample.text);
  const unauthorized = await json(path, "POST", { ...sample, text: "replacement" }, { "x-voice-listener-id": listenerId });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
  assert.deepEqual(voiceStateStore.state().transcript, before);
  const malformed = await json(path, "POST", { ...sample, text: 7 }, auth);
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /text/);
  assert.deepEqual(voiceStateStore.state().transcript, before);
});
