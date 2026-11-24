// Voice's routes over HTTP (contracts A and B): the config's defaults and patches, mute, the
// listener's hello and the shell report under the token, the snapshot field and `voice_state`
// frames, and every route answering 404 with the flag off.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-voice-http-"));
process.env.MISSION_HOME = home;
const { closeDb, getAppConfig, deleteAppConfig, openDb } = await import("../src/server/db.ts");
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
const { VOICE_CONFIG_DEFAULTS, VOICE_LISTENER_PROTOCOL_VERSION } = await import("../src/shared/voice.ts");
type VoiceState = import("../src/shared/voice.ts").VoiceState;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
const token = ensureToken();
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
}, auth === null ? {} : { "x-harness-token": auth });
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

test("with the flag off every route answers 404, writes nothing, and the snapshot has no voice", async () => {
  setFlag("voice", false);
  const disabled = { error: "This feature is disabled.", feature: "voice" };
  for (const response of [
    await json("/api/voice/config"),
    await json("/api/voice/config", "PUT", { muted: true }),
    await json("/api/voice/config/provider-intent", "POST"),
    await json("/api/voice/mute", "POST", { muted: true }),
    await hello(),
    await report({}),
  ]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), disabled);
  }
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.voice), undefined);
  assert.equal("voice" in registry.snapshot(), false);
});

test("GET returns every contract A field with its default", async () => {
  const response = await json("/api/voice/config");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { config: VOICE_CONFIG_DEFAULTS });
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
  assert.equal((await json("/api/voice/mute", "POST", { muted: "yes" })).status, 400);
});

test("a window that connects after a lapse but before its timer fires still sees the listener come back", async () => {
  // Mocked time: the hello's lapse passes while its timer has not fired, which is the window a
  // late timer leaves on a busy daemon.
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
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

test("a hello with an unknown major version is refused with 409 and the state says why", async () => {
  await hello();
  const response = await hello({ version: "2.0" });
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
