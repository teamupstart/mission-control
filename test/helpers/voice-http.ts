import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkSupervisor } from "../../src/server/sdk/supervisor.ts";
import type { HeardEntry, VoiceCard } from "../../src/shared/voice-routing.ts";
import type { SpokenName } from "../../src/shared/voice-names.ts";

import { ensureNativeStateLockAddon } from "./native-state-lock.ts";
import type { VoiceDecisionResult, VoiceQuestion } from "../../src/shared/voice-decide.ts";

before(() => ensureNativeStateLockAddon());

const home = mkdtempSync(join(tmpdir(), "mission-voice-routing-"));
process.env.MISSION_HOME = home;
const { buildApp } = await import("../../src/server/routes.ts");
const { Registry } = await import("../../src/server/registry.ts");
const { ReviewManager } = await import("../../src/server/reviews.ts");
const { TaskManager } = await import("./task-manager-fixture.ts");
const { QueueManager } = await import("../../src/server/queue.ts");
const { PendingTurnManager } = await import("../../src/server/pending-turns.ts");
const { voiceStateStore, wireVoiceStateEvents } = await import("../../src/server/voice/state.ts");
const { VOICE_REQUIRED_FLAGS, VOICE_LISTENER_PROTOCOL_VERSION } = await import("../../src/shared/voice.ts");
const { applyFeatureFlagIntent } = await import("../../src/server/feature-flags/index.ts");
const { ensureToken } = await import("../../src/server/auth.ts");
const { closeDb } = await import("../../src/server/db.ts");
const token = ensureToken();
const registry = new Registry();
const interrupts: string[] = [];
const sdk = {
  interrupt: async (id: string) => { interrupts.push(id); return "idle"; },
  sendWhenIdle: async () => null,
} as unknown as SdkSupervisor;
const pending = new PendingTurnManager(registry, sdk, { idleSettleMs: 60_000, now: () => Date.now() });
const reviews = new ReviewManager(registry);
export const model = { decide: (questions: readonly VoiceQuestion[]): VoiceDecisionResult =>
  ({ rung: "none", answers: questions.map(() => ({ choice: null, confidence: 0 })), detail: "scripted" }) };
const app = buildApp({ registry, pendingTurns: pending, sdkSessions: sdk, reviews,
  tasks: new TaskManager(registry), queues: new QueueManager(registry), voiceDecider: { ask: async questions => model.decide(questions) } });
const cards: VoiceCard[] = [];
registry.subscribe((event) => { if (event.type === "voice_card") cards.push(event.card); });
const stop = wireVoiceStateEvents((state) => registry.emitVoiceState(state));
export const listenerId = randomUUID();
const post = (path: string, body: unknown = {}, auth?: string) => app.request(path, { method: "POST",
  headers: { host: "localhost", "content-type": "application/json", ...(auth ? { "x-harness-token": auth, "x-voice-listener-id": listenerId } : {}) },
  body: JSON.stringify(body) });
const capture = (text: string, id = String(randomUUID())) => ({ id, text, backend: "fluidaudio", capturedAt: Date.now() });
export const utterancePath = (revision = voiceStateStore.directive().revision) => "/voice/utterances?revision=" + encodeURIComponent(revision);
const say = (text: string, id?: string) => post(utterancePath(), capture(text, id), token);
const readHeard = async () => (await (await app.request("/api/voice/heard", { headers: { host: "localhost" } })).json() as { entries: HeardEntry[] }).entries;
const act = (id: string, action: string, body?: unknown) => post(`/api/voice/cards/${id}/${action}`, body);
const name = (name: string): SpokenName => ({ key: "task:" + name, name, kind: "session", taskId: name,
  sessionId: "sdk:" + name, role: "", colorId: null, agent: "claude", state: "running" });
const roster = ["Steve", "Will", "Bill"].map(name);
for (const target of roster) registry.registerSdkSession({ id: target.sessionId!, agent: "claude", name: target.name, cwd: home, agentSessionId: target.key });
voiceStateStore.useRoster(() => roster);
pending.start();
const queued = (agent: string) => registry.getSession("sdk:" + agent)!.pendingTurns.map((row) => row.text);

beforeEach(async () => {
  voiceStateStore.reset();
  for (const id of [...VOICE_REQUIRED_FLAGS, "voice"] as const) applyFeatureFlagIntent({ kind: "flag", id, enabled: true });
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ muted: false, cancelWindow: { enabled: true, seconds: 1 } }) });
  const hello = await post("/voice/listener/hello", { backend: "fluidaudio", version: VOICE_LISTENER_PROTOCOL_VERSION,
    devices: [], microphone: "granted", modelLoaded: true }, token);
  assert.equal(hello.status, 200);
  cards.length = 0;
});
afterEach(() => {
  registry.voiceRouter!.reset();
  for (const session of registry.snapshot().sessions) {
    for (const turn of session.pendingTurns.toReversed()) pending.recall(session.id, turn.id, turn.revision);
  }
});
after(() => { stop(); pending.stop(); closeDb(); rmSync(home, { recursive: true, force: true }); });

export { act, app, applyFeatureFlagIntent, capture, cards, home, interrupts, name, pending, post, queued, readHeard, registry, reviews, roster, say, sdk, token, voiceStateStore };
