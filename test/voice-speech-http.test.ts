import { fixtureSupervisorEnv, fixtureVoiceSupervisor, newFixtureSupervisor } from "./helpers/voice-supervisor.ts";
import { createVoiceSupervisor, VOICE_SUPERVISOR_PROOF_HEADER } from "../src/server/voice/supervisor-auth.ts";
import { announcementName } from "../src/server/voice/speech-holds.ts";
import { playerScratchDirectory, retirementDirectory } from "../src/server/voice/recovery-files.ts";
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { Socket } from "node:net";
import { voiceProcessBirth } from "../src/server/voice/process-birth.ts";
import { text } from "node:stream/consumers";
import test, { afterEach } from "node:test";
import fs, { mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { sandboxLifetime } from "../src/server/voice/supervised-listener.ts";
import { FIXED_OS_EXECUTABLES } from "../src/server/executables/catalog.ts";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { act, app, applyFeatureFlagIntent, capture, home, listenerId, post, readHeard, registry, token, utterancePath, voiceStateStore as store } from "./helpers/voice-http.ts";
import { VoiceStateStore } from "../src/server/voice/state.ts";
import { registerVoiceRoutes } from "../src/server/voice/routes.ts";
import { VOICE_CONFIG_DEFAULTS, VOICE_HELLO_LAPSE_MS, VOICE_LISTENER_PROTOCOL_VERSION, VOICE_MODEL_STATE_NONE } from "../src/shared/voice.ts";
import { VOICE_INSTANCE_HEADER, VOICE_SPEECH_DEFAULT_NEURAL } from "../src/shared/voice-speech.ts";

Object.assign(process.env, fixtureSupervisorEnv);

const ledger = join(home, "voice/speech-holds.json");
const supervised = join(home, "voice/supervised");
const inventory = join(home, "voice/supervised-instances.json");
const used = join(home, "voice-speech-used");
// The HTTP harness shares a disposable home. Each scenario starts with its own launches.
afterEach(() => {
  rmSync(retirementDirectory(home), { recursive: true, force: true });
  rmSync(ledger, { recursive: true, force: true });
  rmSync(join(home, "voice/supervised-exits"), { recursive: true, force: true });
  rmSync(supervised, { recursive: true, force: true });
  rmSync(inventory, { force: true });
  rmSync(used, { force: true });
});
const entries = () => JSON.parse(readFileSync(ledger, "utf8"));
const audition = async () => (await (await post("/api/voice/speech/audition")).json()).id as string;
const toggle = (enabled: boolean) => applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled });

/** A fake process owns capture and speech through separate headers. Its successor may own neither. */
function player(owner: string = listenerId, server = app) {
  const supervisor = fixtureVoiceSupervisor(owner === listenerId ? "shell" : "dev");
  const { instance } = supervisor;
  const base = { host: "localhost", "content-type": "application/json", "x-harness-token": token, "x-voice-listener-id": owner };
  const urls: string[] = [];
  const request = async (path: string, body?: unknown, header: string | null = instance) => {
    urls.push(path);
    const res = await server.request(path, { method: body === undefined ? "GET" : "POST",
      headers: { ...base, ...(header && { [VOICE_INSTANCE_HEADER]: header }) }, body: JSON.stringify(body) });
    if (res.headers.get("content-type")?.includes("json")) assert.ok(!(await res.clone().text()).includes(instance));
    return res;
  };
  const hello = (header: string | null = instance, bodyInstance?: string) => request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION, backend: "fluidaudio", devices: [],
    modelLoaded: true, microphone: "granted", speech: { ...(bodyInstance && { instance: bodyInstance }), audio: true, systemVoices: [
      { id: "sample", name: "Sample", language: "en", quality: "default" },
    ] } }, header);
  const report = (state: "started" | "exited", subject = instance, proof = supervisor.proof(state, subject)) =>
    server.request("/voice/listener/supervised", { method: "POST", headers: {
      "content-type": "application/json", "x-harness-token": token, [VOICE_SUPERVISOR_PROOF_HEADER]: proof,
    }, body: JSON.stringify({ instance: subject, state }) });
  return {
    instance, urls, request, hello, report, supervisor,
    async announce() { assert.equal((await report("started")).status, 200); },
    async poll(header: string | null = instance) { return (await request("/voice/listener/directive", undefined, header)).json(); },
    async pickup() {
      const first = await (await request("/voice/listener/directive")).json();
      if (first.speak || first.capture) return first;
      return (await request("/voice/listener/directive?revision=" + first.revision)).json();
    },
    event(id: string, type: "ended" | "started") {
      return request("/voice/speech/jobs/" + id + "/events", { type, ...(type === "ended" && { outcome: "finished" }) });
    },
  };
}

test("timers request a stop, only the capture owner logs playback-time utterances, and only the holder can end playback", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const holder = player(), other = player(crypto.randomUUID());
  const frames: unknown[] = [];
  const unsubscribe = registry.subscribe(frame => frames.push(frame));
  t.after(unsubscribe);
  const logs: unknown[][] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  await holder.hello();
  const unavailable = await post("/api/voice/speech/audition");
  assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json()).reason, /not started by a supervisor/);
  await holder.announce();
  const id = await audition();
  const job = store.speech.live!;
  assert.equal(statSync(ledger).mode & 0o777, 0o600);
  assert.deepEqual(entries(), [{ jobId: id, instance: holder.instance, purpose: "audition" }]);
  const ready = await holder.poll();
  assert.equal(ready.capture, false);
  assert.deepEqual(ready.speak, { id, kind: "system", voiceId: "sample", text: "Steve or Will?" });
  const peerPoll = await other.poll();
  assert.equal(peerPoll.speak, null);
  assert.notEqual(peerPoll.revision, ready.revision);
  assert.equal((await holder.poll(null)).speak, null);
  const queryOnly = "/voice/listener/directive?instance=" + holder.instance;
  assert.equal((await (await app.request(queryOnly, { headers: { "x-harness-token": token } })).json()).speak, null);
  assert.equal((await other.event(id, "started")).status, 409);
  assert.equal(job.state, "ready");
  await holder.event(id, "started");
  assert.equal(job.state, "speaking");
  t.mock.timers.tick(9999);
  assert.equal(job.state, "speaking");
  const playing = await holder.poll();
  const waiting = holder.request("/voice/listener/directive?revision=" + playing.revision);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1);
  assert.deepEqual((await (await waiting).json()).speak, { id, stop: true });
  assert.equal(job.state, "stopping");
  assert.equal((await post("/api/voice/speech/audition")).status, 409);
  await other.announce();
  await other.hello(); // Phase 9 may refuse the capture lease. Speech ownership is independent.
  const stopped = await holder.poll();
  assert.deepEqual(stopped.speak, { id, stop: true });
  assert.equal(stopped.capture, false);
  assert.equal((await other.poll()).capture, false);
  assert.equal((await other.poll()).speak, null);
  assert.equal((await other.request("/voice/speech/jobs/" + id + "/audio")).status, 404);
  assert.equal((await other.event(id, "ended")).status, 409);
  const at = Date.now();
  const before = await readHeard();
  assert.deepEqual(await (await other.request("/voice/utterances", capture("Steve leaked"))).json(), { accepted: false });
  assert.deepEqual(await readHeard(), before);
  assert.deepEqual(await (await holder.request("/voice/utterances", capture("Steve playing"))).json(), { accepted: false });
  assert.equal((await readHeard())[0]?.rule, "while-speaking");
  assert.equal((await readHeard())[0]?.text, "Steve playing");
  t.mock.timers.tick(5000);
  assert.equal(store.state().mode, "unavailable");
  assert.equal(store.state().capabilities.listener?.reason, "the listener did not confirm that speech had stopped");
  await other.hello();
  assert.equal((await post("/voice/listener/supervised", { instance: holder.instance, state: "exited" })).status, 401);
  await other.report("exited"); await other.report("exited", player(crypto.randomUUID()).instance);
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await holder.event(id, "ended")).status, 200);
  assert.equal(job.state, "timed-out");
  assert.equal((await holder.poll()).capture, true);
  const second = await audition();
  assert.equal((await holder.pickup()).speak.id, second);
  await holder.event(second, "ended");
  assert.equal((await holder.poll()).capture, true);
  assert.deepEqual(await (await holder.request("/voice/utterances", { ...capture("Steve delayed"), capturedAt: at })).json(), { accepted: false });
  for (const secret of [holder.instance, other.instance]) {
    for (const output of [logs, frames, store.state(), holder.urls, other.urls]) assert.ok(!JSON.stringify(output).includes(secret));
  }
});

test("speech hello selects its holder from the header alone", async () => {
  const sender = player(), other = player(crypto.randomUUID());
  await sender.announce();
  await other.announce();
  for (const header of [null, "unknown"]) {
    assert.equal((await sender.hello(header, sender.instance)).status, 200);
    assert.equal((await post("/api/voice/speech/audition")).status, 409);
    assert.equal(store.speech.live, null);
  }
  assert.equal((await sender.hello(sender.instance, other.instance)).status, 200);
  const id = await audition();
  assert.equal((await sender.poll()).speak.id, id);
  assert.equal((await other.poll()).speak, null);
  assert.equal((await other.event(id, "ended")).status, 409);
  assert.equal((await sender.event(id, "ended")).status, 200);
});

test("a playback hold grants directive access only to the lease owner or job holder, including after a long poll", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  const deny = async (response: Response) => {
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "not_listener_owner", capture: false, speak: null });
    assert.equal([...response.headers.keys()].some(header => header.startsWith("x-voice-")), false);
  };
  await deny(await peer.request("/voice/listener/directive"));
  await deny(await app.request("/voice/listener/directive", { headers: { "x-harness-token": token } }));
  const leaseOnly = await holder.poll(null);
  assert.ok(Array.isArray(leaseOnly.roster));
  assert.equal(leaseOnly.speak, null);
  const pending = holder.request("/voice/listener/directive?revision=" + leaseOnly.revision, undefined, null);
  await new Promise(resolve => setImmediate(resolve));
  await holder.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION,
    backend: "fluidaudio", devices: [], modelLoaded: true, microphone: "denied" });
  await peer.hello();
  await deny(await pending);
  assert.equal((await holder.poll()).speak.id, id);
  assert.equal((await peer.poll()).capture, false);
  assert.equal((await peer.poll()).speak, null);
  await holder.event(id, "ended");
  assert.equal((await peer.poll()).capture, true);
});

test("only the capture owner's acknowledgement of the paused directive enables playback", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const grant = await holder.poll();
  assert.equal(grant.capture, true);
  const id = await audition();
  const pause = await (await holder.request("/voice/listener/directive?revision=" + grant.revision)).json();
  assert.equal(pause.capture, false);
  assert.equal(pause.speak, null);
  assert.deepEqual(entries(), [{ jobId: id, instance: holder.instance, purpose: "audition" }]);
  assert.equal((await holder.event(id, "started")).status, 409);
  assert.equal((await peer.request("/voice/listener/directive?revision=" + pause.revision)).status, 409);
  assert.equal((await holder.poll()).speak, null);
  const allowed = await (await holder.request("/voice/listener/directive?revision=" + pause.revision)).json();
  assert.equal(allowed.capture, false);
  assert.equal(allowed.speak.id, id);
  assert.equal((await holder.event(id, "started")).status, 200);
  assert.equal((await holder.event(id, "ended")).status, 200);
  assert.equal((await holder.poll()).capture, true);
  const second = await audition();
  assert.equal((await holder.poll()).speak, null);
  await holder.request("/api/voice/speech/stop", { id: second });
  assert.deepEqual((await holder.poll()).speak, { id: second, stop: true });
  assert.equal((await holder.event(second, "ended")).status, 200);
});

test("the speech holder can acknowledge its own microphone pause after its heartbeat expires", async t => {
  let steady = Math.ceil(performance.now());
  t.mock.method(performance, "now", () => steady);
  const holder = player();
  await holder.announce(); await holder.hello();
  assert.equal((await holder.poll()).capture, true);
  steady += VOICE_HELLO_LAPSE_MS - 1;
  const id = await audition();
  steady++;
  const pause = await holder.poll();
  assert.equal(pause.capture, false);
  assert.equal(pause.speak, null);
  assert.equal((await holder.event(id, "started")).status, 409);
  const ready = await (await holder.request("/voice/listener/directive?revision=" + pause.revision)).json();
  assert.equal(ready.speak.id, id);
  assert.equal((await holder.event(id, "ended")).status, 200);
});

for (const proof of ["pause", "exit"] as const) {
  test(`a capture-only listener's expired microphone grant needs its own ${proof} proof before its replacement can play`, async t => {
    let steady = Math.ceil(performance.now());
    t.mock.method(performance, "now", () => steady);
    const original = player(), replacement = player(crypto.randomUUID());
    if (proof === "exit") await original.announce();
    const captureOnly = await original.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION,
      backend: "fluidaudio", devices: [], modelLoaded: true, microphone: "granted" },
    proof === "exit" ? original.instance : null);
    assert.equal(captureOnly.status, 200);
    assert.equal((await post("/api/voice/speech/audition")).status, 409);
    assert.equal((await original.poll()).capture, true);
    steady += VOICE_HELLO_LAPSE_MS;
    await replacement.announce();
    assert.equal((await replacement.hello()).status, 200);
    assert.equal((await replacement.poll()).capture, true);
    const id = await audition();
    const ownPause = await replacement.poll();
    assert.equal(ownPause.speak, null);
    // A long poll from the replacement acknowledges its microphone alone.
    const waiting = replacement.request("/voice/listener/directive?revision=" + ownPause.revision);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await replacement.event(id, "started")).status, 409);
    const past = await original.poll();
    assert.equal(past.capture, false);
    assert.equal(past.speak, null);
    assert.deepEqual(past.roster, []);
    if (proof === "pause") {
      assert.equal((await original.request("/voice/listener/directive?revision=" + past.revision)).status, 409);
    } else {
      assert.equal((await replacement.report("exited", original.instance)).status, 403);
      assert.equal((await replacement.poll()).speak, null);
      assert.equal((await original.report("exited")).status, 200);
    }
    const ready = await (await waiting).json();
    assert.equal(ready.speak.id, id);
    assert.equal(ready.capture, false);
    assert.equal((await replacement.event(id, "ended")).status, 200);
    assert.equal((await replacement.poll()).capture, true);
  });
}

for (const restarted of [false, true]) test("a capture-only client killed without a final report releases only its kernel-verified microphone grant " +
  (restarted ? "after daemon restart" : "on the live daemon"), async t => {
  let steady = Math.ceil(performance.now());
  t.mock.method(performance, "now", () => steady);
  store.reset();
  const server = createServer(getRequestListener(app.fetch));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { ListenerClient } from "./src/voice-listener/client.ts";
    import { resolve } from "node:path";
    let headers, unverified;
    const client = new ListenerClient(process.argv[2], process.argv[1], async (url, request) => {
      headers = request.headers;
      const response = await fetch(url, request);
      if (url.endsWith("/hello")) {
        unverified = (await fetch(process.argv[2] + "/voice/listener/directive", { headers })).status;
      }
      return response;
    });
    client.trackProcess(resolve("dist/native/state-lock.node"));
    if (!(await client.hello()).ok) throw new Error("Capture hello was refused.");
    const denied = await fetch(process.argv[2] + "/voice/listener/directive", {
      headers: { ...headers, "x-voice-capture-pid": String(process.ppid) }
    });
    const directive = await client.poll();
    process.stdout.write(JSON.stringify([unverified, denied.status, directive.capture]));
    process.stdin.resume();
  `, join(home, "token"), "http://127.0.0.1:" + address.port], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [data] = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => {
    throw new Error("The capture-only fixture exited before receiving capture.");
  })]);
  assert.deepEqual(JSON.parse(data.toString()), [409, 409, true]);
  rmSync(join(home, "voice-capture.lock")); // Losing the path cannot release the pinned process.
  if (restarted) store.reset();
  steady += VOICE_HELLO_LAPSE_MS;
  const holder = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  const pause = await holder.poll();
  assert.equal(pause.capture, false);
  assert.equal(pause.speak, null);
  assert.equal((await holder.event(id, "started")).status, 409);
  const waiting = holder.request("/voice/listener/directive?revision=" + pause.revision);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const playable = (await (await waiting).json()).speak;
  assert.equal(playable.kind, "system");
  assert.equal(playable.id, id);
  assert.equal((await holder.event(id, "started")).status, 200);
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await holder.event(id, "ended")).status, 200);
  assert.equal((await holder.poll()).capture, true);
});

test("capture is served only after its private grant is saved and a failed pause acknowledgement can retry", async () => {
  const dir = join(home, "voice/capture-grants");
  mkdirSync(join(home, "voice"), { recursive: true });
  writeFileSync(dir, "busy");
  const owner = player();
  const denied = await owner.request("/voice/listener/directive", undefined, null);
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).capture, false);
  rmSync(dir);
  assert.equal((await owner.poll(null)).capture, true);
  assert.equal(statSync(join(dir, listenerId + ".json")).mode & 0o777, 0o600);
  store.reset();
  const holder = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  const pause = await owner.poll(null);
  renameSync(dir, dir + "-saved"); writeFileSync(dir, "busy");
  const ack = () => owner.request("/voice/listener/directive?revision=" + pause.revision, undefined, null);
  assert.equal((await ack()).status, 503);
  assert.equal((await holder.poll()).speak, null);
  rmSync(dir); renameSync(dir + "-saved", dir);
  await ack();
  assert.equal((await holder.poll()).speak.id, id);
});

test("HEAD never grants capture or acknowledges a pause across a daemon restart", async () => {
  const original = player();
  const head = (revision = "") => app.request("/voice/listener/directive" + revision,
    { method: "HEAD", headers: { "x-harness-token": token, "x-voice-listener-id": listenerId } });
  assert.equal((await head()).status, 405);
  assert.equal(store.capturePausePending, false);
  assert.equal((await original.poll(null)).capture, true);
  store.reset();
  const holder = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  assert.equal((await holder.poll()).speak, null);
  const pause = await original.poll(null);
  assert.equal(pause.capture, false);
  assert.equal((await head("?revision=" + pause.revision)).status, 405);
  assert.equal((await holder.poll()).speak, null);
  await original.request("/voice/listener/directive?revision=" + pause.revision, undefined, null);
  assert.equal((await holder.poll()).speak.id, id);
});

test("auditions have two waiting places and receive terminal failures if the holder never confirms Stop", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const holder = player();
  await holder.announce(); await holder.hello();
  const playing = await audition();
  await holder.event(playing, "started");
  const waiting = [await audition(), await audition()];
  assert.ok(waiting.every(id => typeof id === "string"));
  const expectBusy = async () => {
    const response = await post("/api/voice/speech/audition");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "speech_busy");
  };
  await expectBusy();
  await post("/api/voice/speech/stop", { id: waiting[1] });
  assert.deepEqual(store.state().speech.lastAudition, { id: waiting[1], state: "stopped" });
  await post("/api/voice/speech/stop", { id: playing });
  await expectBusy(); // There is room, but the holder already has a Stop directive.
  t.mock.timers.tick(4999);
  assert.deepEqual(store.state().speech.lastAudition, { id: waiting[1], state: "stopped" });
  t.mock.timers.tick(1);
  assert.deepEqual(store.state().speech.lastAudition, { id: waiting[0], state: "failed" });
  const held = await holder.poll();
  assert.equal(held.capture, false);
  assert.deepEqual(held.speak, { id: playing, stop: true });
  await holder.event(playing, "ended");
  assert.equal((await holder.poll()).capture, true);
  assert.equal(store.speech.live, null);
});

test("delayed utterances are logged within the playback history window and discarded after it", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  t.mock.method(performance, "now", Date.now);
  const holder = player();
  await holder.announce(); await holder.hello();
  const early = Date.now();
  await holder.event(await audition(), "ended");
  t.mock.timers.tick(180_000);
  await holder.hello();
  const send = (time: number, text: string) => holder.request(utterancePath(), { ...capture(text), capturedAt: time });
  assert.deepEqual(await (await send(early, "Steve delayed")).json(), { accepted: false });
  assert.equal((await readHeard())[0]?.text, "Steve delayed");
  const recentJob = await audition();
  const recent = Date.now();
  t.mock.timers.tick(1); // Capture strictly within playback, before the new grant.
  await holder.event(recentJob, "ended");
  t.mock.timers.tick(1);
  const before = await readHeard();
  assert.deepEqual(await (await send(early, "Steve too late")).json(), { accepted: false });
  assert.deepEqual(await readHeard(), before);
  assert.deepEqual(await (await send(recent, "Steve recent playback")).json(), { accepted: false });
  assert.equal((await readHeard())[0]?.rule, "while-speaking");
  assert.equal((await readHeard())[0]?.text, "Steve recent playback");
  assert.equal((await (await send(Date.now(), "Steve fresh capture")).json()).accepted, true);
});

test("a fresh capture grant accepts the release millisecond while a delayed playback revision is ignored", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  t.mock.method(performance, "now", Date.now);
  const holder = player();
  await holder.announce(); await holder.hello();
  const before = await holder.poll();
  const id = await audition();
  await holder.event(id, "started");
  const playing = await holder.poll();
  t.mock.timers.tick(10);
  await holder.event(id, "ended");
  const fresh = await holder.poll();
  assert.equal(fresh.capture, true);
  const send = (revision: string, text: string) => holder.request(utterancePath(revision), capture(text));
  for (const revision of [playing.revision, before.revision]) {
    assert.deepEqual(await (await send(revision, "Steve delayed")).json(), { accepted: false });
    assert.equal((await readHeard())[0]?.rule, "while-speaking");
  }
  assert.deepEqual(await (await send(fresh.revision, "Steve fresh")).json(), { accepted: true });
});

test("confirmation before its deadline advances the queue and late confirmation fails waiting work even with the timer pending", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  t.mock.method(performance, "now", Date.now);
  const holder = player();
  await holder.announce();
  for (const elapsed of [4999, 5000, 5001]) {
    await holder.hello();
    const id = await audition();
    await holder.event(id, "started");
    const queued = store.speech.open("audition", "Queued sample", null)!;
    await post("/api/voice/speech/stop", { id });
    assert.deepEqual((await holder.poll()).speak, { id, stop: true });
    t.mock.timers.setTime(Date.now() + elapsed);
    assert.equal(queued.state, "preparing");
    assert.equal(store.speech.held, true);
    assert.equal((await holder.event(id, "ended")).status, 200);
    if (elapsed < 5000) {
      assert.equal(queued.state, "ready");
      assert.equal((await holder.poll()).speak.id, queued.id);
      await holder.event(queued.id, "ended");
    } else {
      assert.equal(queued.state, "failed");
      assert.equal((await holder.poll()).speak, null);
    }
    assert.equal((await holder.poll()).capture, true);
  }
});

test("after restart a surviving player regains eligibility by replaying its signed start without releasing recovered playback", async () => {
  const holder = player();
  const proof = holder.supervisor.proof("started");
  const replay = () => holder.report("started", holder.instance, proof);
  assert.equal((await replay()).status, 200);
  await holder.hello();
  const id = await audition();
  await holder.event(id, "started");
  store.reset(); await holder.hello();
  assert.equal(store.state().capabilities["speech-output"]?.available, false);
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await replay()).status, 200);
  assert.equal(store.state().capabilities["speech-output"]?.available, true);
  const pending = await holder.poll();
  assert.equal(pending.capture, false);
  assert.deepEqual(pending.speak, { id, stop: true });
  await holder.event(id, "ended");
  const next = await audition();
  assert.equal((await holder.poll()).speak.id, next);
  assert.equal((await holder.report("exited")).status, 200);
  assert.equal((await replay()).status, 409);
});

test("restart rejects buffered playback frames under a missing, old, or freshly supplied revision", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const holder = player();
  await holder.announce(); await holder.hello();
  const id = await audition();
  await holder.event(id, "started");
  const playing = await holder.poll();
  const frame = capture("Steve buffered playback");
  t.mock.timers.tick(1);
  await holder.event(id, "ended");
  store.reset();
  t.mock.timers.tick(1);
  await holder.hello();
  const fresh = await holder.poll();
  assert.equal(fresh.capture, true);
  const before = await readHeard();
  for (const path of ["/voice/utterances", utterancePath(playing.revision), utterancePath(fresh.revision)]) {
    assert.deepEqual(await (await holder.request(path, frame)).json(), { accepted: false });
  }
  assert.deepEqual(await readHeard(), before);
  assert.deepEqual(await (await holder.request(utterancePath(fresh.revision), capture("Steve fresh speech"))).json(), { accepted: true });
});

test("after recovered silence the first authorized capture response sets the restart cutoff at its delayed poll", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const holder = player(), other = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  await holder.event(id, "started");
  store.reset(); await holder.hello();
  assert.deepEqual((await holder.poll()).speak, { id, stop: true });
  assert.equal((await holder.event(id, "ended")).status, 200);
  const computed = store.directive();
  assert.equal(computed.capture, true);
  t.mock.timers.tick(50);
  const buffered = capture("Steve buffered before the poll");
  const path = utterancePath(computed.revision);
  assert.deepEqual(await (await holder.request(path, buffered)).json(), { accepted: false });
  assert.equal((await other.request("/voice/listener/directive")).status, 409);
  assert.equal(store.captureGrantTime(computed.revision), undefined);
  t.mock.timers.tick(50);
  const fresh = await holder.poll();
  assert.equal(fresh.revision, computed.revision);
  assert.equal(store.captureGrantTime(fresh.revision), Date.now());
  assert.deepEqual(await (await holder.request(path, buffered)).json(), { accepted: false });
  const firstFrame = capture("Steve fresh after the poll");
  t.mock.timers.tick(50);
  assert.equal((await holder.poll()).revision, fresh.revision);
  assert.deepEqual(await (await holder.request(path, firstFrame)).json(), { accepted: true });
});

test("a start that cannot be recorded grants no speech authority", async () => {
  writeFileSync(supervised, "not a directory");
  const p = player();
  assert.equal((await p.report("started")).status, 503);
  await p.hello();
  assert.equal((await post("/api/voice/speech/audition")).status, 409);
  rmSync(supervised);
  await p.announce();
  const id = await audition();
  assert.equal((await p.poll()).speak.id, id);
  assert.equal((await p.report("exited")).status, 200);
  assert.deepEqual(readdirSync(supervised), []);
});

test("handoff waits for staged files and their directories to sync, including on retry", async t => {
  const p = player();
  await p.announce(); await p.hello();
  const homeInode = statSync(home).ino, voiceInode = statSync(join(home, "voice")).ino;
  const stages: string[] = [];
  let stagedInode: number | undefined;
  let failure: "staged file" | "voice directory" | undefined;
  const sync = fs.fsyncSync;
  const syncHook = t.mock.method(fs, "fsyncSync", (fd: number) => {
    const info = fs.fstatSync(fd);
    const stage = info.isFile() ? "staged file" : info.ino === voiceInode ? "voice directory" :
      info.ino === homeInode ? "state home" : "other directory";
    if (stagedInode !== undefined && info.isDirectory()) {
      const target = stage === "state home" ? used : ledger;
      assert.equal(statSync(target).ino, stagedInode, "published the synced staged file before syncing its parent");
      stages.push(target === used ? "publish marker" : "publish hold");
      stagedInode = undefined;
    }
    stages.push(stage);
    if (failure === stage) throw new Error("Injected sync failure");
    sync(fd);
    if (info.isFile()) stagedInode = info.ino;
  });
  syncBuiltinESMExports();
  try {
    for (failure of ["staged file", "voice directory"] as const) {
      stages.length = 0;
      assert.equal((await post("/api/voice/speech/audition")).status, 503);
      assert.equal(stages.at(-1), failure);
      assert.equal((await p.poll()).speak, null);
    }
    failure = undefined;
    stages.length = 0;
    const id = await audition();
    assert.deepEqual(stages, ["staged file", "publish marker", "state home", "staged file", "publish hold", "voice directory", "state home"]);
    assert.equal((await p.pickup()).speak.id, id);
    assert.equal((await p.event(id, "ended")).status, 200);
  } finally {
    syncHook.mock.restore(); syncBuiltinESMExports();
  }
});

test("a signed exit returns 503 and holds capture until a retry removes the launch record", async () => {
  const holder = player();
  await holder.announce();
  await holder.hello();
  const id = await audition();
  assert.equal((await holder.event(id, "started")).status, 200);

  // Keep the real receipt for the retry and make unlink fail even under a privileged test runner.
  const saved = supervised + ".saved";
  renameSync(supervised, saved);
  writeFileSync(supervised, "not a directory");
  const refused = await holder.report("exited");
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: "supervisor_record_unavailable" });
  assert.deepEqual(entries(), [{ jobId: id, instance: holder.instance, purpose: "audition" }]);
  assert.equal((await holder.poll()).capture, false);

  rmSync(supervised);
  renameSync(saved, supervised);
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await holder.report("exited")).status, 200);
  assert.deepEqual(readdirSync(supervised), []);
  assert.deepEqual(entries(), []);
  assert.equal((await holder.poll()).capture, true);
});

test("a linked state home permits fresh capture and recovers playback in its configured target", async t => {
  const backing = mkdtempSync(join(home, "linked-home-target-"));
  const alias = join(home, "configured-home");
  symlinkSync(backing, alias, "dir");
  t.after(() => rmSync(alias));
  const state = new VoiceStateStore({ now: () => performance.now(), enabled: () => true, config: () => VOICE_CONFIG_DEFAULTS,
    speechDirectory: join(alias, "voice") });
  t.after(() => state.reset());
  const server = new Hono();
  registerVoiceRoutes(server, state);
  const holder = player(listenerId, server);
  await holder.request("/voice/listener/hello", { version: VOICE_LISTENER_PROTOCOL_VERSION,
    backend: "fluidaudio", devices: [], modelLoaded: true, microphone: "granted" });
  assert.equal((await holder.poll()).capture, true);
  await holder.announce(); await holder.hello();
  const id = (await (await holder.request("/api/voice/speech/audition", {})).json()).id;
  assert.equal((await holder.pickup()).speak.id, id);
  assert.equal((await holder.event(id, "started")).status, 200);
  assert.equal(JSON.parse(readFileSync(join(backing, "voice", "speech-holds.json"), "utf8"))[0].jobId, id);
  state.reset(); await holder.hello();
  const recovery = await holder.poll();
  assert.equal(recovery.capture, false);
  assert.deepEqual(recovery.speak, { id, stop: true });
  assert.equal((await holder.event(id, "ended")).status, 200);
  assert.equal((await holder.poll()).capture, true);
});

test("a FIFO ledger with no writer returns an unknown recovery hold", () => {
  mkdirSync(join(home, "voice"), { recursive: true });
  const pipe = spawnSync("mkfifo", [ledger]);
  assert.equal(pipe.status, 0, pipe.stderr?.toString());
  // Bound the read in a separate process so a blocking open fails this regression promptly.
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { SpeechHolds } from "./src/server/voice/speech-holds.ts";
    const state = new SpeechHolds(process.argv[1]).load();
    console.log(JSON.stringify(state.holds.map(hold => hold.supervisor)));
  `, join(home, "voice")], { encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["."]);
});

test("linked recovery parents refuse signed retirement and keep capture held until a durable retry", async () => {
  const holder = player();
  await holder.announce(); await holder.hello();
  const id = await audition();
  await holder.event(id, "started");
  const alternate = mkdtempSync(join(home, "alternate-records-"));
  const receiptName = announcementName(holder.instance) + ".json";
  const placeholder = join(alternate, receiptName);
  writeFileSync(placeholder, "untouched");
  for (const directory of [join(home, "voice/supervised-exits"), supervised]) {
    mkdirSync(directory, { recursive: true });
    renameSync(directory, directory + ".real");
    symlinkSync(alternate, directory, "dir");
    try {
      assert.equal((await holder.report("exited")).status, 503);
      assert.deepEqual(readdirSync(alternate), [receiptName]);
      assert.equal(readFileSync(placeholder, "utf8"), "untouched");
      assert.equal((await holder.poll()).capture, false);
    } finally {
      rmSync(directory);
      renameSync(directory + ".real", directory);
    }
  }
  assert.equal((await holder.report("exited")).status, 200);
  assert.equal((await holder.poll()).capture, true);
});

for (const inventoryState of ["missing", "unreadable"] as const) {
  for (const ledgerState of ["intact", "unreadable"] as const) {
    test(`signed exit with ${inventoryState} inventory clears only the exact holder after restart with ${ledgerState} ledger`, async () => {
      const holder = player(), peer = player(crypto.randomUUID());
      await holder.announce(); await holder.hello();
      const id = await audition();
      assert.equal((await holder.event(id, "started")).status, 200);
      const saved = readFileSync(inventory, "utf8");
      if (inventoryState === "missing") rmSync(inventory);
      else writeFileSync(inventory, "?");
      if (ledgerState === "unreadable") writeFileSync(ledger, "?");
      store.reset(); await peer.hello();
      assert.equal((await holder.poll()).speak.stop, true);
      assert.equal((await peer.report("exited", holder.instance)).status, 403);
      assert.equal((await peer.poll()).capture, false);

      assert.equal((await holder.report("exited")).status, 200);
      assert.equal((await holder.report("started")).status, 409);
      const remaining = entries();
      if (ledgerState === "intact") assert.deepEqual(remaining, []);
      else {
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].supervisor, ".");
      }
      if (inventoryState === "missing") assert.throws(() => readFileSync(inventory), { code: "ENOENT" });
      else assert.equal(readFileSync(inventory, "utf8"), "?");
      store.reset(); await peer.hello();
      assert.equal((await peer.poll()).capture, ledgerState === "intact");
      // A restored inventory can contain the exited nonce. Its signed exit still counts.
      writeFileSync(inventory, saved);
      assert.equal((await holder.report("exited")).status, 200);
      assert.deepEqual(entries(), []);
      assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
      assert.equal((await peer.poll()).capture, true);
    });
  }
}

test("a partially restored directory stops each newly identified player once while unknown launches stay held", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  assert.equal((await holder.event(await audition(), "started")).status, 200);
  const receipt = join(supervised, announcementName(holder.instance) + ".json");
  const original = readFileSync(receipt);
  const launches = readFileSync(inventory);
  rmSync(receipt); rmSync(inventory); writeFileSync(ledger, "{");
  store.reset(); await holder.hello();
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await holder.poll()).speak, null);
  writeFileSync(receipt, original, { mode: 0o600 });
  assert.equal((await peer.report("exited")).status, 200);
  const stop = (await holder.poll()).speak;
  assert.ok(stop?.stop);
  assert.equal((await peer.poll()).speak, null);
  store.reset(); await holder.hello();
  assert.deepEqual((await holder.poll()).speak, stop);
  assert.equal((await holder.event(stop.id, "ended")).status, 200);
  store.reset(); await holder.hello();
  assert.equal((await peer.report("exited")).status, 200);
  const waiting = await holder.poll();
  assert.equal(waiting.speak, null);
  assert.equal(waiting.capture, false);
  writeFileSync(inventory, launches, { mode: 0o600 });
  assert.equal((await peer.report("exited")).status, 200);
  assert.equal((await holder.poll()).capture, true);
  assert.deepEqual(entries(), []);
});

test("a surviving peer receipt cannot account for a missing player when the inventory is lost", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  assert.equal((await holder.event(await audition(), "started")).status, 200);
  await peer.announce();
  renameSync(inventory, inventory + ".saved");
  rmSync(ledger);
  rmSync(join(supervised, announcementName(holder.instance) + ".json"));
  store.reset(); await peer.hello();
  const partial = await peer.poll();
  assert.equal(partial.capture, false);
  assert.equal(partial.speak.stop, true);
  assert.equal((await peer.event(partial.speak.id, "ended")).status, 200);
  assert.equal((await peer.poll()).capture, false);
  store.reset(); await peer.hello();
  assert.equal((await peer.poll()).capture, false);
  assert.equal((await peer.report("started")).status, 503);
  renameSync(inventory + ".saved", inventory);
  assert.equal((await peer.report("exited")).status, 200);
  const stop = await holder.poll();
  assert.equal(stop.capture, false);
  assert.equal(stop.speak.stop, true);
  assert.equal((await holder.event(stop.speak.id, "ended")).status, 200);
  assert.equal((await peer.poll()).capture, true);
});

test("a delayed signed start cannot revive a launch after exit, including across restart", async () => {
  const holder = player();
  await holder.announce(); await holder.hello();
  assert.equal((await holder.event(await audition(), "started")).status, 200);
  assert.equal((await holder.report("exited")).status, 200);
  // The supervisor may still have its old process record when a retry arrives.
  writeFileSync(join(supervised, "shell.json"), JSON.stringify({ instance: holder.instance }));
  for (const restart of [false, true]) {
    if (restart) { rmSync(ledger); store.reset(); await holder.hello(); }
    assert.equal((await holder.report("started")).status, 409);
    assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
    assert.deepEqual(readdirSync(supervised), ["shell.json"]);
    assert.equal((await holder.poll()).capture, true);
    assert.equal((await post("/api/voice/speech/audition")).status, 409);
    assert.equal((await holder.report("exited")).status, 200);
  }
  const next = player();
  await next.announce(); await next.hello();
  const nextJob = await audition();
  assert.equal((await next.pickup()).speak.id, nextJob);
  assert.equal((await next.event(nextJob, "ended")).status, 200);
});

for (const proof of ["ended", "exited"] as const) {
  test(`silence proof (${proof}) returns 503 until the hold can be durably cleared`, async () => {
    const holder = player();
    await holder.announce(); await holder.hello();
    const id = await audition();
    assert.equal((await holder.event(id, "started")).status, 200);
    const confirm = () => proof === "ended" ? holder.event(id, "ended") : holder.report("exited");
    renameSync(ledger, ledger + ".saved");
    mkdirSync(ledger);
    try {
      const refused = await confirm();
      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: "speech_hold_unavailable" });
      const pending = await holder.poll();
      assert.equal(pending.capture, false);
      assert.deepEqual(pending.speak, { id, stop: true });
      assert.equal((await confirm()).status, 503);
    } finally {
      rmSync(ledger, { recursive: true });
      renameSync(ledger + ".saved", ledger);
    }
    assert.deepEqual(entries(), [{ jobId: id, instance: holder.instance, purpose: "audition" }]);
    store.reset(); await holder.hello();
    assert.equal((await holder.poll()).capture, proof === "exited");
    if (proof === "exited") assert.deepEqual(entries(), []);
    assert.equal((await confirm()).status, 200);
    assert.deepEqual(entries(), []);
    store.reset(); await holder.hello();
    assert.equal((await holder.poll()).capture, true);
  });
}

test("restart applies only recorded exits and keeps every hold while the reconciled ledger cannot be saved", async () => {
  const gone = player(), live = player(crypto.randomUUID());
  await gone.announce(); await gone.hello();
  assert.equal((await gone.event(await audition(), "started")).status, 200);
  await live.announce();
  writeFileSync(ledger, "?");
  store.reset(); await live.hello();
  const both = readFileSync(ledger, "utf8");
  assert.equal(entries().length, 2);
  const liveStop = (await live.poll()).speak;
  assert.equal((await gone.report("exited")).status, 200);
  // Crash image: the exit is durable, but the old, intact two-player ledger survived.
  writeFileSync(ledger, both);
  renameSync(used, used + ".saved");
  mkdirSync(used); // Prevent saving the remaining, still-held player.
  try {
    store.reset(); await live.hello();
    assert.equal(readFileSync(ledger, "utf8"), both);
    assert.equal((await gone.poll()).speak.stop, true);
    assert.equal((await live.poll()).capture, false);
  } finally {
    rmSync(used, { recursive: true });
    renameSync(used + ".saved", used);
  }
  store.reset(); await live.hello();
  assert.equal((await gone.poll()).speak, null);
  assert.deepEqual(entries(), [{ jobId: liveStop.id, instance: live.instance, purpose: "ask" }]);
  const pending = await live.poll();
  assert.equal(pending.capture, false);
  assert.deepEqual(pending.speak, liveStop);
  assert.equal((await live.event(liveStop.id, "ended")).status, 200);
  assert.equal((await live.poll()).capture, true);
});

test("recovery requires the original issuer's signed exit for the exact persisted launch", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  assert.equal((await holder.event(id, "started")).status, 200);
  await peer.announce();
  assert.equal((await peer.report("exited")).status, 200);
  const file = (instance: string) => join(home, "voice/supervised-exits", announcementName(instance) + ".json");
  const peerExit = JSON.parse(readFileSync(file(peer.instance), "utf8"));
  for (const record of [true, peerExit, { ...peerExit, instance: holder.instance },
    { instance: holder.instance, proof: holder.supervisor.proof("started") }]) {
    writeFileSync(file(holder.instance), JSON.stringify(record));
    store.reset(); await holder.hello();
    const pending = await holder.poll();
    assert.equal(pending.capture, false);
    assert.deepEqual(pending.speak, { id, stop: true });
    assert.equal((await peer.poll()).capture, false);
  }
  const stale = readFileSync(ledger, "utf8");
  assert.equal((await holder.report("exited")).status, 200);
  writeFileSync(ledger, stale);
  store.reset(); await peer.hello();
  assert.deepEqual(entries(), []);
  assert.equal((await peer.poll()).capture, true);
});

test("repairing an unreadable launch receipt requests silence from the recovered instance", async () => {
  const p = player();
  await p.announce(); await p.hello();
  const id = await audition();
  await p.event(id, "started");
  const [receipt] = readdirSync(supervised);
  writeFileSync(join(supervised, receipt!), "?");
  // Inventory can preserve a receipt name while its holder identity is unreadable.
  writeFileSync(inventory, JSON.stringify([{ supervisor: receipt!.slice(0, -5) }]));
  writeFileSync(ledger, "?");
  store.reset(); await p.hello();
  assert.equal((await p.poll()).capture, false);
  assert.equal((await p.poll()).speak, null);
  await p.announce(); // Rewrites its own receipt. Reconciliation must transfer the hold.
  const recovered = await p.poll();
  assert.equal(recovered.capture, false);
  assert.equal(recovered.speak.stop, true);
  assert.equal((await p.event(recovered.speak.id, "ended")).status, 200);
  assert.equal((await p.poll()).capture, true);
});

test("a disappeared launch receipt can be cleared by the exact signed exit", async () => {
  const holder = player(), peer = player(listenerId);
  await holder.announce();
  await holder.hello();
  assert.equal((await holder.event(await audition(), "started")).status, 200);
  const [name] = readdirSync(supervised);
  const receipt = join(supervised, name!);
  writeFileSync(receipt, "{");
  writeFileSync(inventory, JSON.stringify([{ supervisor: name!.slice(0, -5) }]));
  writeFileSync(ledger, "{");
  store.reset();
  await holder.hello();
  rmSync(receipt);
  // The peer was launched by the same supervisor but has a different signed instance.
  await peer.announce();
  assert.equal((await peer.report("exited")).status, 200);
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await holder.report("exited")).status, 200);
  assert.deepEqual(entries(), []);
  assert.equal((await holder.poll()).capture, true);
});

for (const proof of ["ended", "exited"] as const) {
  test(`a replacement in an unreadable shell slot cannot retire the original hold with ${proof} proof`, async () => {
    const holder = player(), replacement = player(), peer = player(crypto.randomUUID());
    await holder.announce();
    await holder.hello();
    const id = await audition();
    assert.equal((await holder.event(id, "started")).status, 200);

    const originalLedger = readFileSync(ledger, "utf8");
    // The surviving inventory names a mutable slot. It cannot identify the original occupant.
    const [receipt] = readdirSync(supervised);
    rmSync(join(supervised, receipt!));
    writeFileSync(inventory, JSON.stringify([{ supervisor: "shell" }]));
    const processRecord = join(supervised, "shell.json");
    writeFileSync(processRecord, "{");
    writeFileSync(ledger, "{");
    store.reset();
    await holder.hello();
    const unknown = await holder.poll();
    assert.equal(unknown.capture, false);
    assert.equal(unknown.speak, null);

    writeFileSync(processRecord, JSON.stringify({ instance: replacement.instance, pid: 123, startedAt: Date.now() }));
    await replacement.announce();
    const recovered = await replacement.poll();
    assert.equal(recovered.capture, false);
    assert.equal(recovered.speak.stop, true);
    const stopId = recovered.speak.id;
    assert.equal(entries().length, 2);
    assert.equal(entries().some((h: { supervisor?: string }) => h.supervisor === "shell"), true);
    const other = await peer.poll();
    assert.equal(other.capture, false);
    assert.equal(other.speak, null);
    assert.equal((await peer.event(stopId, "ended")).status, 409);
    assert.equal((await peer.report("exited")).status, 200);
    assert.equal((await holder.poll()).capture, false);

    const confirmed = proof === "ended" ? await replacement.event(stopId, "ended") : await replacement.report("exited");
    assert.equal(confirmed.status, 200);
    assert.equal((await holder.poll()).capture, false);
    store.reset(); await holder.hello();
    assert.equal((await holder.poll()).capture, false);
    await peer.report("exited");
    assert.equal((await replacement.poll()).speak, null);
    assert.equal(entries()[0].supervisor, "shell");
    writeFileSync(ledger, originalLedger); // Recover the original job's independent identity.
    store.reset(); await holder.hello();
    assert.deepEqual((await holder.poll()).speak, { id, stop: true });
    assert.equal((await holder.report("exited")).status, 200);
    assert.deepEqual(entries(), []);
    assert.equal((await holder.poll()).capture, true);
  });
}

test("only the launching supervisor can attest exit, including after daemon restart", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.hello();
  assert.equal((await holder.request("/voice/listener/supervised", { instance: holder.instance, state: "started" })).status, 403);
  assert.equal(store.state().capabilities["speech-output"]?.available, false);
  await holder.announce();
  const id = await audition();
  await holder.event(id, "started");
  for (const restart of [false, true]) {
    if (restart) { store.reset(); await holder.hello(); }
    const expected = restart ? "stopping" : "speaking";
    const before = entries();
    assert.equal(store.speech.live?.state, expected);
    const unsigned = await holder.request("/voice/listener/supervised", { instance: holder.instance, state: "exited" });
    assert.equal(unsigned.status, 403);
    assert.equal((await peer.report("exited", holder.instance)).status, 403);
    assert.equal((await holder.report("exited", holder.instance, holder.supervisor.proof("started"))).status, 403);
    assert.equal((await holder.report("exited", holder.instance, holder.supervisor.proof("exited", peer.instance))).status, 403);
    assert.deepEqual(entries(), before);
    assert.equal(store.speech.live?.state, expected);
    assert.equal((await holder.poll()).capture, false);
    assert.equal((await peer.poll()).capture, false);
  }
  assert.equal((await holder.report("exited")).status, 200);
  assert.deepEqual(entries(), []);
  assert.equal((await holder.poll()).capture, true);
});

test("the daemon verifies supervisor reports with public material and binds launches to the original signing key", async () => {
  const holder = player();
  await holder.announce(); await holder.hello();
  const id = await audition();
  assert.equal((await holder.event(id, "started")).status, 200);
  assert.ok(!readdirSync(join(home, "voice")).includes("supervisor-keys"));
  const other = newFixtureSupervisor("shell");
  const unannounced = other.newInstance();
  assert.equal((await holder.report("started", unannounced, other.proof(unannounced, "started"))).status, 403);
  assert.equal((await holder.report("exited", unannounced, other.proof(unannounced, "exited"))).status, 403);
  const otherProof = other.proof(holder.instance, "exited");
  assert.equal((await holder.report("exited", holder.instance, otherProof)).status, 403);
  try {
    Object.assign(process.env, other.daemonEnv);
    store.reset(); await holder.hello();
    assert.equal((await holder.report("started", unannounced, other.proof(unannounced, "started", true))).status, 403);
    assert.equal((await holder.report("exited", holder.instance, otherProof)).status, 403);
    assert.equal((await holder.poll()).capture, false);
    assert.equal((await holder.report("started")).status, 403);
    assert.equal((await holder.report("exited")).status, 200);
    assert.equal((await holder.poll()).capture, true);
  } finally { Object.assign(process.env, fixtureSupervisorEnv); }
});

test("a restarted launcher can confirm the original player's exit using its provisioned signing authority", { timeout: 15_000 }, async t => {
  const p = player();
  // The test worker stands in for the protected credential host. Both launcher processes
  // receive the same key on their private descriptor, which the signer closes at startup.
  const credential = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" });
  t.after(() => { credential.fill(0); Object.assign(process.env, fixtureSupervisorEnv); });
  const boot = () => {
    const child = fork(new URL("./helpers/voice-restart-supervisor.mjs", import.meta.url), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc", "pipe"],
    });
    (child.stdio[4] as Writable).end(credential);
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return child;
  };
  const first = boot();
  const announced = once(first, "message");
  first.send({ state: "started", home });
  const [start] = await announced;
  Object.assign(process.env, start.env);
  assert.equal((await p.report("started", start.instance, start.proof)).status, 200);
  await p.hello(start.instance);
  const listener = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { if (listener.exitCode === null && listener.signalCode === null) listener.kill(); });
  await once(listener, "spawn");
  const id = await audition();
  assert.equal((await p.request("/voice/speech/jobs/" + id + "/events", { type: "started" }, start.instance)).status, 200);
  const crashed = once(first, "exit");
  first.kill("SIGKILL"); await crashed;
  store.reset(); await p.hello(start.instance);
  const replacement = boot();
  const confirmExit = async () => {
    const result = once(replacement, "message");
    replacement.send({ state: "exited", instance: start.instance, pid: listener.pid });
    return (await result)[0].proof;
  };
  assert.equal(await confirmExit(), null);
  assert.equal((await p.poll(start.instance)).capture, false);
  const gone = once(listener, "exit");
  listener.kill(); await gone; // The player disappears without sending ended.
  assert.equal((await p.poll(start.instance)).capture, false);
  const proof = await confirmExit();
  assert.equal(typeof proof, "string");
  assert.equal((await p.report("exited", start.instance, proof)).status, 200);
  assert.deepEqual(entries(), []);
  assert.equal((await p.poll(start.instance)).capture, true);
});

test("a sandbox lifetime follows the reported namespace PID across monitor termination", { timeout: 10_000 }, async t => {
  // Exercise the info-fd protocol with actual distinct processes even on hosts without namespaces.
  const monitor = spawn(process.execPath, ["-e", `
    const player = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const fs = require("node:fs");
    fs.writeFileSync(3, JSON.stringify({ "child-pid": player.pid }));
    fs.closeSync(3);
  `], { stdio: ["ignore", "ignore", "inherit", "pipe"] });
  t.after(() => { if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill("SIGKILL"); });
  await once(monitor, "spawn");
  const lifetime = await sandboxLifetime(monitor, monitor.stdio[3] as Readable);
  t.after(() => { if (lifetime.running()) process.kill(lifetime.pid, "SIGKILL"); });
  assert.notEqual(lifetime.pid, monitor.pid);
  let retired = false;
  void lifetime.exited.then(() => { retired = true; });
  const stopped = once(monitor, "exit");
  monitor.kill("SIGKILL");
  await stopped;
  assert.equal(lifetime.running(), true);
  assert.equal(retired, false);
  process.kill(lifetime.pid, "SIGKILL");
  await t.waitFor(() => assert.equal(retired, true));
});

test("Linux monitor termination keeps playing capture held in the live supervisor and after restart", {
  timeout: 15_000, skip: process.platform !== "linux",
}, async t => {
  const probe = spawnSync(FIXED_OS_EXECUTABLES.bubblewrap, ["--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"], { encoding: "utf8" });
  if ((probe.error as NodeJS.ErrnoException)?.code === "ENOENT" || (probe.status !== 0 && /namespace|permitted|userns/iu.test(probe.stderr))) {
    t.skip("Host cannot create a Bubblewrap namespace.");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
  const launchHome = mkdtempSync(join(home, "linux-monitor-"));
  const state = new VoiceStateStore({ now: () => performance.now(), enabled: () => true,
    config: () => VOICE_CONFIG_DEFAULTS, speechDirectory: join(launchHome, "voice") });
  const server = new Hono();
  registerVoiceRoutes(server, state);
  t.after(() => state.reset());
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createVoiceSupervisor("shell", privateKey);
  const replacement = createVoiceSupervisor("shell", privateKey);
  Object.assign(process.env, signer.daemonEnv);
  t.after(() => { signer.pauseExitRetries(); replacement.pauseExitRetries(); Object.assign(process.env, fixtureSupervisorEnv); });
  const peer = player(listenerId, server);
  const exits: string[] = [];
  const starts: string[] = [];
  const report = async (instance: string, state: "started" | "exited", proof: string) => {
    assert.equal((await peer.report(state, instance, proof)).status, 200);
    (state === "exited" ? exits : starts).push(instance);
  };
  const { instance, child, reannounce } = await signer.launch(launchHome, process.execPath,
    ["-e", "process.stdout.write('playing'); setInterval(() => {}, 1000)"], {}, report);
  const file = join(retirementDirectory(launchHome), "shell-" + announcementName(instance) + ".json");
  const { pid } = JSON.parse(readFileSync(file, "utf8"));
  assert.notEqual(pid, child.pid);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } });
  assert.equal(String((await once(child.stdout, "data"))[0]), "playing");
  await peer.hello(instance);
  const id = (await (await peer.request("/api/voice/speech/audition", {})).json()).id;
  assert.equal((await peer.request("/voice/speech/jobs/" + id + "/events", { type: "started" }, instance)).status, 200);
  const stopped = once(child, "exit");
  child.kill("SIGKILL");
  await stopped;
  assert.equal(await reannounce(), undefined);
  assert.deepEqual(starts, [instance, instance]);
  assert.deepEqual(exits, []);
  assert.equal((await peer.poll(instance)).capture, false);
  signer.pauseExitRetries();
  state.reset(); await peer.hello(instance);
  replacement.retryPendingExits(launchHome, report);
  assert.deepEqual(exits, []);
  assert.deepEqual((await peer.poll(instance)).speak, { id, stop: true });
  process.kill(pid, "SIGKILL");
  await t.waitFor(() => assert.deepEqual(exits, [instance]));
  assert.equal((await peer.poll(instance)).capture, true);
});

test("a same-account signing file is rejected even when owner-only", () => {
  const file = join(home, "same-account.key");
  writeFileSync(file, Buffer.alloc(48), { mode: 0o600 });
  const fd = openSync(file, "r");
  assert.throws(() => createVoiceSupervisor("shell", fd), /Unprotected supervisor credential/);
  rmSync(file);
});

for (const playing of [false, true]) test("a launcher crash after an accepted start can retire only when safe: " +
  (playing ? "the released player survives" : "before spawning"), { timeout: 10_000, skip: playing && process.platform !== "darwin" }, async t => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const credential = privateKey.export({ type: "pkcs8", format: "der" });
  const launcher = fork(new URL("./helpers/voice-restart-supervisor.mjs", import.meta.url), [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc", "pipe"],
  });
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    credential.fill(0); Object.assign(process.env, fixtureSupervisorEnv);
  });
  (launcher.stdio[4] as Writable).end(credential);
  const announced = once(launcher, "message");
  launcher.send({ state: playing ? "play" : "started", home });
  const [start] = await announced;
  Object.assign(process.env, start.env);
  const peer = player();
  const file = join(retirementDirectory(home), "shell-" + announcementName(start.instance) + ".json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, launcher.pid);
  assert.equal((await peer.report("started", start.instance, start.proof)).status, 200);
  let playerPid: number | undefined;
  const scratch = playerScratchDirectory(home, start.instance);
  const sibling = playerScratchDirectory(home, peer.instance);
  mkdirSync(sibling, { mode: 0o700 });
  writeFileSync(join(sibling, "other"), "another launch");
  if (playing) {
    const ready = once(launcher, "message");
    launcher.send({ state: "ack" });
    const [child] = await ready;
    assert.equal(typeof child.pid, "number");
    playerPid = child.pid;
    t.after(() => { if (playerPid) try { process.kill(playerPid, "SIGKILL"); } catch { /* Already reaped. */ } });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, playerPid);
    assert.equal(statSync(scratch).mode & 0o777, 0o700);
  }
  store.reset(); await peer.hello();
  assert.equal((await peer.poll()).capture, false);
  const replacement = createVoiceSupervisor("shell", privateKey);
  t.after(() => replacement.pauseExitRetries());
  const reports: string[] = [];
  const report = async (instance: string, state: "started" | "exited", proof: string) => {
    reports.push(instance);
    assert.equal(state, "exited");
    assert.equal((await peer.report(state, instance, proof)).status, 200);
  };
  replacement.retryPendingExits(home, report);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports, []);
  const crashed = once(launcher, "exit");
  launcher.kill("SIGKILL"); await crashed;
  if (playerPid) {
    replacement.retryPendingExits(home, report);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reports, []);
    assert.equal((await peer.poll()).capture, false);
    assert.equal(readFileSync(join(scratch, "playing"), "utf8"), "sample");
    process.kill(playerPid, "SIGTERM");
    await t.waitFor(() => assert.throws(() => process.kill(playerPid!, 0), { code: "ESRCH" }));
    playerPid = undefined;
    replacement.retryPendingExits(home, async () => { throw new Error("Daemon offline"); });
    await t.waitFor(() => assert.throws(() => statSync(scratch), { code: "ENOENT" }));
    assert.ok(statSync(file).isFile());
    assert.equal((await peer.poll()).capture, false);
  }
  replacement.retryPendingExits(home, report);
  await t.waitFor(() => assert.throws(() => statSync(file), { code: "ENOENT" }));
  assert.throws(() => statSync(scratch), { code: "ENOENT" });
  assert.equal(readFileSync(join(sibling, "other"), "utf8"), "another launch");
  assert.deepEqual(reports, [start.instance]);
  assert.equal((await peer.poll()).capture, true);
});

test("a stalled start times out before spawning and retires the accepted launch even if its acknowledgement arrives late", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => { signer.pauseExitRetries(); Object.assign(process.env, fixtureSupervisorEnv); });
  Object.assign(process.env, signer.daemonEnv);
  const peer = player();
  const reports: string[] = [];
  let signal: AbortSignal | undefined;
  let ack!: () => void;
  const stalled = new Promise<void>(resolve => { ack = resolve; });
  const failed = assert.rejects(signer.launch(home, process.execPath, ["--version"], {}, async (instance, state, proof, abort) => {
    assert.equal((await peer.report(state, instance, proof)).status, 200);
    reports.push(state);
    if (state === "started") { signal = abort; return stalled; }
  }), /started report timed out/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4999);
  assert.equal(signal?.aborted, false);
  assert.deepEqual(reports, ["started"]);
  t.mock.timers.tick(1);
  await failed;
  assert.equal(signal?.aborted, true);
  ack();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports, ["started", "exited"]);
  await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(home)), []));
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
});

test("start acknowledgements respect monotonic elapsed time even before the timer callback runs", async t => {
  let now = performance.now();
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => { signer.pauseExitRetries(); Object.assign(process.env, fixtureSupervisorEnv); });
  Object.assign(process.env, signer.daemonEnv);
  const peer = player();
  for (const elapsed of [4999, 5000, 5100]) {
    const reports: string[] = [];
    const launch = signer.launch(home, process.execPath, ["\0"], {}, async (instance, state, proof) => {
      assert.equal((await peer.report(state, instance, proof)).status, 200);
      reports.push(state);
      if (state === "started") now += elapsed;
    });
    // The invalid argv reaches spawn only when the start acknowledgement is on time.
    if (elapsed < 5000) await assert.rejects(launch, { code: "ERR_INVALID_ARG_VALUE" });
    else await assert.rejects(launch, /started report timed out/);
    await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(home)), []));
    assert.deepEqual(reports, ["started", "exited"]);
    assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  }
});

test("a signed process birth retires a reused PID and a changed birth cannot retire the live process", async t => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const issuer = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("hex");
  const supervisor = createVoiceSupervisor("shell", privateKey);
  t.after(() => supervisor.pauseExitRetries());
  const dir = retirementDirectory(home);
  mkdirSync(dir, { recursive: true });
  const protocol = process.platform === "linux" ? "mission-voice-launch-pid/linux-v2" : "mission-voice-launch-pid/v1";
  const birth = voiceProcessBirth(process.pid);
  function receipt(recorded: string, attested = recorded) {
    const instance = "shell_" + issuer + "_" + randomBytes(32).toString("hex");
    const proof = sign(null, Buffer.from([protocol, instance, process.pid, attested].join("\n")), privateKey).toString("hex");
    writeFileSync(join(dir, "shell-" + announcementName(instance) + ".json"), JSON.stringify({ instance, pid: process.pid, birth: recorded, proof }));
    return instance;
  }
  receipt(birth);
  receipt("different-boot", birth);
  const gone = receipt("previous-boot");
  const exited: string[] = [];
  supervisor.retryPendingExits(home, async instance => { exited.push(instance); });
  await t.waitFor(() => assert.deepEqual(exited, [gone]));
  await t.waitFor(() => assert.equal(readdirSync(dir).filter(file => file.endsWith(".json")).length, 2));
});

test("a failed gate write rejects launch and the OS exit retires it in the original state home", {
  skip: process.platform !== "darwin",
}, async t => {
  const supervisor = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => supervisor.pauseExitRetries());
  const root = mkdtempSync(join(home, "gate-"));
  const alias = join(root, "current");
  const first = join(root, "first"), replacement = join(root, "second");
  mkdirSync(first); mkdirSync(replacement); symlinkSync(first, alias);
  const write = Socket.prototype.write;
  t.mock.method(Socket.prototype, "write", function(this: Socket, ...args: Parameters<typeof write>) {
    if (args[0] === "go\n") {
      this.destroy();
      const callback = args[1] as unknown as (error: Error) => void;
      queueMicrotask(() => callback(new Error("fixture gate closed")));
      return false;
    }
    return Reflect.apply(write, this, args);
  });
  const reports: string[] = [];
  await assert.rejects(supervisor.launch(alias, process.execPath, ["--version"], {}, async (_instance, state) => {
    reports.push(state);
    if (state === "started") { rmSync(alias); symlinkSync(replacement, alias); }
  }), /fixture gate closed/);
  await t.waitFor(() => assert.deepEqual(reports, ["started", "exited"]));
  await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(first)), []));
  assert.deepEqual(readdirSync(replacement), []);
});

for (const disconnected of [false, true]) test("the first supervised same-account child protects recovery files and retires on OS exit " +
  (disconnected ? "after reconnect" : "while connected"), async t => {
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  Object.assign(process.env, signer.daemonEnv);
  t.after(() => Object.assign(process.env, fixtureSupervisorEnv));
  const peer = player();
  const retirement = join(retirementDirectory(home), "private.json");
  mkdirSync(retirementDirectory(home), { recursive: true });
  writeFileSync(retirement, "private");
  const check = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => process.stderr.write("handled\\n"));
    process.stderr.write("ready\\n");
    process.stdin.once("data", () => {
      const [ledger, exit, model, retirement] = process.argv.slice(1);
      fs.writeFileSync(require("node:path").join(process.env.TMPDIR, "buffer"), "scratch");
      const descendant = process.platform === "darwin" ? require("node:child_process").spawnSync("/usr/bin/true") : undefined;
      const denied = fn => {
        try { fn(); return false; }
        catch (err) { return ["EPERM", "EACCES", "EROFS", "ENOENT"].includes(err.code); }
      };
      console.log(JSON.stringify({
        read: denied(() => fs.readFileSync(ledger)), write: denied(() => fs.writeFileSync(ledger, "[]")),
        retirement: denied(() => fs.readFileSync(retirement)),
        exit: denied(() => fs.writeFileSync(exit, "true")), model: fs.readFileSync(model, "utf8"),
        descendantError: descendant?.error?.code,
      }));
    });`;
  const model = join(home, "voice/models/fixture-readonly");
  mkdirSync(join(home, "voice/models"), { recursive: true });
  writeFileSync(model, "sample");
  t.after(() => rmSync(model, { force: true }));
  const exit = join(home, "voice/supervised-exits", "fixture.json");
  mkdirSync(join(home, "voice/supervised-exits"), { recursive: true });
  t.after(() => signer.pauseExitRetries());
  let deliverExit!: () => void;
  const transport = new Promise<void>(resolve => { deliverExit = resolve; });
  let exitAttempts = 0;
  const launched = await signer.launch(home, process.execPath, ["-e", check, ledger, exit, model, retirement], {},
    async (subject, state, proof) => {
      if (state === "exited") { exitAttempts++; await transport; }
      assert.equal((await peer.report(state, subject, proof)).status, 200);
    })
    .catch(error => {
      if (process.platform === "linux" && (error.code === "ENOENT" || error.message === "Bubblewrap did not provide the sandbox PID.")) return null;
      throw error;
    });
  if (!launched) {
    deliverExit();
    await t.waitFor(() => assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []));
    t.diagnostic("Bubblewrap could not establish a sandbox PID. The launcher retired the failed start without releasing the listener.");
    return;
  }
  const { instance, child } = launched;
  const guarded = JSON.parse(readFileSync(join(retirementDirectory(home), "shell-" + announcementName(instance) + ".json"), "utf8"));
  if (child.exitCode === null && child.signalCode === null) {
    assert.equal(guarded.birth, voiceProcessBirth(guarded.pid));
    if (process.platform === "linux") assert.notEqual(guarded.pid, child.pid);
    else assert.equal(guarded.pid, child.pid);
  }
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const completed = once(child, "close");
  const ready = process.platform === "darwin" ? once(child.stderr, "data") : null;
  const output = text(child.stdout), errors = text(child.stderr);
  await peer.hello(instance);
  if (process.platform === "darwin") {
    assert.match(String((await ready)![0]), /ready/);
    const handled = once(child.stderr, "data");
    assert.equal(child.kill("SIGTERM"), true);
    assert.match(String((await handled)[0]), /handled/);
    assert.equal(child.killed, true);
    assert.equal(child.exitCode, null);
    const finished = await audition();
    assert.equal((await peer.request("/voice/speech/jobs/" + finished + "/events", { type: "ended", outcome: "finished" }, instance)).status, 200);
    store.reset(); await peer.hello(instance);
    assert.equal(store.state().capabilities["speech-output"]?.available, false);
    await launched.reannounce();
    assert.equal(store.state().capabilities["speech-output"]?.available, true);
  }
  const id = await audition();
  assert.equal((await peer.request("/voice/speech/jobs/" + id + "/events", { type: "started" }, instance)).status, 200);
  if (disconnected) signer.pauseExitRetries();
  child.stdin.on("error", () => {}); // A host that disallows namespaces can refuse the child before stdin opens.
  child.stdin.end("check");
  const [code] = await completed;
  // The monitor can close its pipes while the namespace init is still alive.
  if (disconnected) {
    const file = join(retirementDirectory(home), "shell-" + announcementName(instance) + ".json");
    await t.waitFor(() => assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { instance, proof: signer.exitProof(instance) }));
  } else await t.waitFor(() => assert.equal(exitAttempts, 1));
  assert.equal(await launched.reannounce(), false);
  const stderr = await errors;
  if (process.platform === "linux" && code !== 0 && /bwrap:.*(?:namespace|permitted|userns)/iu.test(stderr)) {
    assert.equal(await output, ""); // The host refused confinement and the listener never ran.
    deliverExit();
    if (disconnected) signer.retryPendingExits(home, async (subject, state, proof) => {
      assert.equal((await peer.report(state, subject, proof)).status, 200);
    });
    await t.waitFor(() => assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []));
    t.diagnostic("Host refused a confined process. Verified the launcher never falls back to an unrestricted child.");
    return;
  }
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(await output), { read: true, write: true, exit: true, retirement: true, model: "sample",
    ...(process.platform === "darwin" && { descendantError: "EPERM" }) });
  assert.equal(exitAttempts, disconnected ? 0 : 1);
  assert.deepEqual(entries(), [{ jobId: id, instance, purpose: "audition" }]);
  assert.throws(() => readFileSync(exit), { code: "ENOENT" });
  store.reset(); await peer.hello(instance);
  assert.equal((await peer.poll(instance)).capture, false);
  let replayed = 0;
  if (disconnected) {
    signer.retryPendingExits(home, async (subject, state, proof) => {
      assert.equal(state, "exited");
      assert.equal((await peer.report(state, subject, proof)).status, 200);
      replayed++;
    });
  }
  deliverExit();
  await t.waitFor(() => assert.deepEqual(entries(), []));
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  assert.equal(exitAttempts, disconnected ? 0 : 1);
  assert.equal(replayed, disconnected ? 1 : 0);
  assert.equal((await peer.poll(instance)).capture, true);
});

test("a symlinked voice directory cannot receive a signed start or replace the sandbox target during announcement", async t => {
  const root = mkdtempSync(join(home, "symlink-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const voice = join(root, "voice"), backing = join(root, "backing");
  mkdirSync(backing);
  symlinkSync(backing, voice, "dir");
  let announcements = 0;
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  const launch = (announce: () => Promise<void>) => signer.launch(root, process.execPath, ["--version"], {},
    async (_, state) => { if (state === "started") await announce(); });
  await assert.rejects(launch(async () => { announcements++; }), /real directories/);
  assert.equal(announcements, 0);
  rmSync(voice);
  mkdirSync(voice);
  for (const target of [backing, join(root, "missing-models")]) {
    const models = join(voice, "models");
    symlinkSync(target, models, "dir");
    await assert.rejects(launch(async () => { announcements++; }), /real directories/);
    assert.equal(announcements, 0);
    rmSync(models);
  }
  await assert.rejects(launch(async () => {
    announcements++;
    renameSync(voice, join(root, "original"));
    symlinkSync(backing, voice, "dir");
  }), /real directories/);
  assert.equal(announcements, 1);
});

test("a confirmed spawn failure retries its signed exit until recovery retires the announced launch", { timeout: 10_000 }, async t => {
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => signer.pauseExitRetries());
  Object.assign(process.env, signer.daemonEnv);
  t.after(() => Object.assign(process.env, fixtureSupervisorEnv));
  const peer = player();
  let original = "", exitAttempts = 0;
  const statuses: number[] = [];
  // Node rejects this argv before any OS child exists, after the start has been accepted.
  await assert.rejects(signer.launch(home, process.execPath, ["\0"], {}, async (instance, state, proof) => {
    if (state === "started") {
      original = instance;
      statuses.push((await peer.report(state, instance, proof)).status);
      return;
    }
    assert.equal(instance, original);
    if (++exitAttempts === 1) {
      store.reset(); await peer.hello(); // Missing playback ledger discovers the unretired launch.
      assert.equal((await peer.poll()).capture, false);
      renameSync(supervised, supervised + ".retry");
      writeFileSync(supervised, "unavailable");
      try { statuses.push((await peer.report(state, instance, proof)).status); }
      finally { rmSync(supervised); renameSync(supervised + ".retry", supervised); }
      throw new Error("Retry the unacknowledged exit");
    }
    statuses.push((await peer.report(state, instance, proof)).status);
  }), { code: "ERR_INVALID_ARG_VALUE" });
  await t.waitFor(() => assert.deepEqual(statuses, [200, 503, 200]));
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  rmSync(ledger);
  store.reset(); await peer.hello();
  assert.equal((await peer.poll()).capture, true);
});

test("a lost start acknowledgement retires the same launch while a definitive refusal spawns nothing", async t => {
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => signer.pauseExitRetries());
  Object.assign(process.env, signer.daemonEnv);
  t.after(() => Object.assign(process.env, fixtureSupervisorEnv));
  const peer = player();
  const reports: string[] = [];
  await assert.rejects(signer.launch(home, process.execPath, ["--version"], {}, async (subject, state, proof) => {
    reports.push(state);
    assert.equal((await peer.report(state, subject, proof)).status, 200);
    if (state === "started") throw new Error("Start acknowledgement lost");
  }), /acknowledgement lost/);
  await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(home)), []));
  assert.deepEqual(reports, ["started", "exited"]);
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  reports.length = 0;
  await assert.rejects(signer.launch(home, process.execPath, ["--version"], {}, async (_, state) => {
    reports.push(state);
    return false;
  }), /start was refused/);
  assert.deepEqual(reports, ["started"]);
});

test("a definitive exit refusal after an unknown start outcome returns the original error", { timeout: 3000 }, async t => {
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => signer.pauseExitRetries());
  Object.assign(process.env, signer.daemonEnv);
  t.after(() => Object.assign(process.env, fixtureSupervisorEnv));
  const peer = player();
  const reports: string[] = [];
  const original = new Error("Connection failed before the start reached the daemon");
  await assert.rejects(signer.launch(home, process.execPath, ["--version"], {}, async (subject, state, proof) => {
    reports.push(state);
    if (state === "started") {
      toggle(false);
      Object.assign(process.env, newFixtureSupervisor("shell").daemonEnv);
      throw original;
    }
    assert.equal((await peer.report(state, subject, proof)).status, 404);
    return false;
  }), error => error === original);
  await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(home)), []));
  assert.deepEqual(reports, ["started", "exited"]);
});

test("failed launches return their errors during an outage and a restarted supervisor replays their signed exits", { timeout: 5000 }, async t => {
  const key = generateKeyPairSync("ed25519").privateKey;
  const signer = createVoiceSupervisor("shell", key);
  t.after(() => { signer.pauseExitRetries(); Object.assign(process.env, fixtureSupervisorEnv); });
  Object.assign(process.env, signer.daemonEnv);
  const peer = player();
  const instances: string[] = [];
  const outstanding: AbortSignal[] = [];
  for (let i = 0; i < 2; i++) {
    await assert.rejects(signer.launch(home, process.execPath, ["\0"], {}, async (instance, state, proof, signal) => {
      if (state === "started") {
        assert.equal((await peer.report(state, instance, proof)).status, 200);
        instances.push(instance);
        return;
      }
      assert.ok(signal);
      outstanding.push(signal);
      await once(signal, "abort");
      throw new Error("Disconnected");
    }), { code: "ERR_INVALID_ARG_VALUE" });
  }
  await t.waitFor(() => assert.equal(outstanding.length, 1));
  const inFlight = outstanding[0]!;
  assert.equal(inFlight.aborted, false);
  const directory = retirementDirectory(home);
  for (const instance of instances) {
    const file = join(directory, "shell-" + announcementName(instance) + ".json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { instance, proof: signer.exitProof(instance) });
  }
  signer.pauseExitRetries();
  assert.equal(inFlight.aborted, true);
  store.reset(); await peer.hello();
  assert.equal((await peer.poll()).capture, false);
  const replacement = createVoiceSupervisor("shell", key);
  t.after(() => replacement.pauseExitRetries());
  const captures: boolean[] = [];
  replacement.retryPendingExits(home, async (instance, state, proof) => {
    assert.equal(state, "exited");
    assert.equal((await peer.report(state, instance, proof)).status, 200);
    captures.push((await peer.poll()).capture);
  });
  await t.waitFor(() => assert.deepEqual(readdirSync(directory), []));
  assert.deepEqual(captures, [false, true]);
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
});

test("a stalled exit times out, lets the next retirement finish, and ignores late completion until its own retry succeeds", async t => {
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  t.after(() => { signer.pauseExitRetries(); Object.assign(process.env, fixtureSupervisorEnv); });
  Object.assign(process.env, signer.daemonEnv);
  const peer = player();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(signer.launch(home, process.execPath, ["\0"], {}, async (instance, state, proof) => {
      if (state === "exited") throw new Error("offline");
      assert.equal((await peer.report(state, instance, proof)).status, 200);
    }), { code: "ERR_INVALID_ARG_VALUE" });
  }
  signer.pauseExitRetries();
  store.reset(); await peer.hello();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const attempts: string[] = [];
  let finishLate!: () => void;
  const stalled = new Promise<void>(resolve => { finishLate = resolve; });
  let transportSignal: AbortSignal | undefined;
  signer.retryPendingExits(home, async (instance, state, proof, signal) => {
    attempts.push(instance);
    if (attempts.length === 1) {
      transportSignal = signal;
      return stalled; // This transport ignores cancellation.
    }
    assert.equal((await peer.report(state, instance, proof)).status, 200);
  });
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(transportSignal?.aborted, false);
  assert.equal(attempts.length, 1);
  const receipts = () => readdirSync(retirementDirectory(home)).filter(name => name.endsWith(".json"));
  assert.equal(receipts().length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(transportSignal?.aborted, true);
  await t.waitFor(() => assert.equal(attempts.length, 2));
  assert.notEqual(attempts[1], attempts[0]);
  const remaining = ["shell-" + announcementName(attempts[0]!) + ".json"];
  await t.waitFor(() => assert.deepEqual(receipts(), remaining));
  finishLate();
  await flush();
  assert.deepEqual(receipts(), remaining);
  assert.equal((await peer.poll()).capture, false);
  t.mock.timers.tick(250);
  await flush();
  assert.deepEqual(attempts, [attempts[0], attempts[1], attempts[0]]);
  await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(home)), []));
  assert.equal((await peer.poll()).capture, true);
});

test("a stalled scratch removal and its retry cannot block another launch's signed exit", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  Object.assign(process.env, signer.daemonEnv);
  const peer = player();
  const started: string[] = [], exited: string[] = [];
  let cleanupAttempts = 0, unblock!: () => void;
  const stalled = new Promise<void>(resolve => { unblock = resolve; });
  const rm = fsPromises.rm;
  const hook = t.mock.method(fsPromises, "rm", async (...args: Parameters<typeof rm>) => {
    if (started[0] && args[0] === playerScratchDirectory(fs.realpathSync(home), started[0]) && ++cleanupAttempts === 1) {
      await stalled;
      throw new Error("Scratch temporarily busy");
    }
    return rm(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    unblock(); signer.pauseExitRetries(); hook.mock.restore(); syncBuiltinESMExports();
    Object.assign(process.env, fixtureSupervisorEnv);
  });
  const launch = () => signer.launch(home, process.execPath, [], {}, async (instance, state, proof) => {
    assert.equal((await peer.report(state, instance, proof)).status, 200);
    if (state === "exited") { exited.push(instance); return; }
    started.push(instance);
    mkdirSync(playerScratchDirectory(home, instance), { mode: 0o700 });
    throw new Error("Lost start acknowledgement");
  });
  await assert.rejects(launch(), /Lost start acknowledgement/);
  await t.waitFor(() => assert.equal(exited.length, 1));
  assert.equal(cleanupAttempts, 1);
  await assert.rejects(launch(), /Lost start acknowledgement/);
  const firstFile = join(retirementDirectory(home), "shell-" + announcementName(started[0]!) + ".json");
  const secondFile = join(retirementDirectory(home), "shell-" + announcementName(started[1]!) + ".json");
  await t.waitFor(() => assert.throws(() => statSync(secondFile), { code: "ENOENT" }));
  assert.deepEqual(exited, started);
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  assert.ok(statSync(firstFile).isFile());
  assert.equal(cleanupAttempts, 1);
  unblock();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000); // Even the longest retry interval has elapsed.
  await t.waitFor(() => assert.deepEqual(readdirSync(retirementDirectory(home)), []));
  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(exited, started);
});

test("start timeout at 2000 ms and stop-confirmation failure at 5000 ms keep capture off until the holder ends", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const holder = player();
  await holder.announce();
  await holder.hello();
  const id = await audition();
  const job = store.speech.live!;
  const pollWhileHeld = async () => {
    const directive = await holder.poll();
    assert.equal(directive.capture, false);
    return directive.speak;
  };

  t.mock.timers.tick(1999);
  assert.equal(job.state, "ready");
  const speak = await pollWhileHeld();
  assert.equal(speak.id, id);
  assert.equal(speak.kind, "system");

  t.mock.timers.tick(1);
  assert.equal(job.state, "stopping");
  const stop = { id, stop: true };
  assert.deepEqual(await pollWhileHeld(), stop);

  t.mock.timers.tick(4999);
  const late = await holder.event(id, "started");
  assert.equal(late.status, 409);
  assert.deepEqual(await late.json(), { ok: false, speak: stop });
  assert.equal(job.state, "stopping");
  assert.deepEqual(store.state().capabilities.listener, { available: true, reason: null });
  assert.deepEqual(await pollWhileHeld(), stop);

  t.mock.timers.tick(1);
  assert.equal(job.state, "stopping");
  assert.equal(store.state().mode, "unavailable");
  assert.deepEqual(store.state().capabilities.listener,
    { available: false, reason: "the listener did not confirm that speech had stopped" });
  assert.deepEqual(await pollWhileHeld(), stop);

  assert.equal((await holder.event(id, "ended")).status, 200);
  assert.equal(job.state, "timed-out");
  const released = await holder.poll();
  assert.equal(released.capture, true);
  assert.equal(released.speak, null);
});

test("a start report checks the elapsed deadline even before the timer callback has run", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  t.mock.method(performance, "now", Date.now);
  const holder = player();
  await holder.announce(); await holder.hello();
  for (const elapsed of [1999, 2000, 2001]) {
    const id = await audition();
    t.mock.timers.setTime(Date.now() + elapsed);
    assert.equal(store.speech.live?.state, "ready"); // setTime leaves the timer callback pending.
    const start = await holder.event(id, "started");
    assert.equal(start.status, elapsed < 2000 ? 200 : 409);
    assert.deepEqual(await start.json(), elapsed < 2000 ? { ok: true } : { ok: false, speak: { id, stop: true } });
    const directive = await holder.poll();
    assert.equal(directive.capture, false);
    if (elapsed < 2000) assert.equal(store.speech.live?.state, "speaking");
    else {
      assert.equal(store.speech.live?.state, "stopping");
      assert.deepEqual(directive.speak, { id, stop: true });
    }
    await holder.event(id, "ended");
    assert.equal((await holder.poll()).capture, true);
  }
});

test("a holder poll serves Stop at the elapsed deadline before the timer runs", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let steady = performance.now();
  t.mock.method(performance, "now", () => steady);
  const holder = player();
  await holder.announce(); await holder.hello();
  const id = await audition();
  steady += 1999;
  assert.equal((await holder.poll()).speak.kind, "system");
  steady++;
  const expired = await holder.poll();
  assert.deepEqual(expired.speak, { id, stop: true });
  assert.equal(expired.capture, false);
  assert.equal((await holder.event(id, "started")).status, 409);
  assert.deepEqual((await holder.poll()).speak, { id, stop: true });
  await holder.event(id, "ended");
  assert.equal((await holder.poll()).capture, true);
});

test("holder confirmation records the same deadline outcome before or after the timer callback", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  t.mock.method(performance, "now", Date.now);
  const holder = player();
  await holder.announce();
  for (const started of [false, true]) {
    const limit = started ? 10_000 : 2_000;
    for (const [elapsed, runTimer] of [[limit - 1, false], [limit, false], [limit + 1, false], [limit, true]] as const) {
      await holder.hello();
      const id = await audition();
      if (started) {
        assert.equal((await holder.pickup()).speak.id, id);
        assert.equal((await holder.event(id, "started")).status, 200);
      }
      assert.equal((await holder.poll()).capture, false);
      if (runTimer) t.mock.timers.tick(elapsed);
      else t.mock.timers.setTime(Date.now() + elapsed);
      assert.equal(store.speech.held, true);
      assert.equal((await holder.event(id, "ended")).status, 200);
      assert.deepEqual(store.state().speech.lastAudition, { id, state: elapsed < limit ? "finished" : "timed-out" });
      assert.equal((await holder.poll()).capture, true);
    }
  }
});

test("a backward wall-clock step during playback excludes buffered frames under a fresh capture grant", async t => {
  const epoch = Date.now();
  let wall = epoch, steady = performance.now();
  t.mock.method(Date, "now", () => wall);
  t.mock.method(performance, "now", () => steady);
  const holder = player();
  await holder.announce(); await holder.hello();
  const id = await audition();
  await holder.event(id, "started");
  steady += 30; wall += 30;
  const beforeStep = capture("Steve before the clock step");
  steady += 20; wall -= 1000;
  const afterStep = capture("Steve after the clock step");
  assert.deepEqual(await (await holder.request("/voice/utterances", afterStep)).json(), { accepted: false });
  assert.equal((await readHeard())[0]?.rule, "while-speaking");
  steady += 10; wall += 10;
  await holder.event(id, "ended");
  const grant = await holder.poll();
  assert.equal(grant.capture, true);
  for (const frame of [beforeStep, afterStep, capture("Steve ambiguous boundary")]) {
    assert.deepEqual(await (await holder.request(utterancePath(grant.revision), frame)).json(), { accepted: false });
    assert.equal((await readHeard())[0]?.rule, "while-speaking");
  }
  steady += 180_001; wall += 180_001;
  await holder.hello();
  const fresh = await holder.poll();
  const recent = await readHeard();
  for (const frame of [beforeStep, afterStep, { ...beforeStep, capturedAt: epoch + 60 }]) {
    assert.deepEqual(await (await holder.request(utterancePath(fresh.revision), frame)).json(), { accepted: false });
  }
  assert.deepEqual(await readHeard(), recent);
  assert.deepEqual(await (await holder.request(utterancePath(fresh.revision), capture("Steve fresh"))).json(), { accepted: true });
});

test("a late start or a stop before pickup waits for the holder; muting permits only an audition", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  t.mock.method(performance, "now", Date.now);
  const p = player();
  await p.announce(); await p.hello();
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ whenUnsure: "ask" }) });
  for (const action of ["cancel", "pick", "mute"]) {
    t.mock.timers.tick(1);
    const { revision } = await p.poll();
    const words = capture("Steve tell Will about CI");
    await p.request("/voice/utterances?revision=" + revision, words);
    await registry.voiceRouter!.resolution(words.id);
    const ask = store.speech.live!;
    assert.equal(ask.purpose, "ask");
    assert.equal(ask.cardId, words.id);
    if (action === "mute") await post("/api/voice/mute", { muted: true });
    else assert.equal((await act(words.id, action, action === "pick" ? { id: "task:Steve" } : {})).status, 200);
    assert.equal(ask.state, "stopping");
    const refused = await p.event(ask.id, "started");
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, speak: { id: ask.id, stop: true } });
    assert.deepEqual((await p.poll()).speak, { id: ask.id, stop: true });
    await p.event(ask.id, "ended");
    assert.equal(ask.state, "stopped");
  }
  assert.equal(store.speech.open("ask", "Muted?", "muted")?.state, "failed");
  const id = await audition();
  const job = store.speech.live!;
  assert.equal(job.state, "ready");
  await post("/api/voice/mute", { muted: false });
  t.mock.timers.tick(2000);
  await p.event(id, "started");
  assert.equal(job.state, "stopping");
  assert.equal((await p.poll()).capture, false);
  await p.event(id, "ended");
  assert.equal(job.state, "timed-out");
  assert.equal((await p.poll()).capture, true);
});

test("a missing ledger with no outstanding launches keeps capture available", async () => {
  rmSync(ledger, { force: true });
  const listener = player();
  store.reset();
  await listener.hello();
  assert.equal((await listener.poll()).capture, true);
  assert.equal(store.speech.live, null);
  await listener.announce();
  assert.equal((await listener.report("exited")).status, 200);
  store.reset();
  await listener.hello();
  assert.equal((await listener.poll()).capture, true);
});

test("a missing ledger with an unreadable launch history keeps capture off", async () => {
  const holder = player();
  await holder.announce();
  await holder.hello();
  assert.equal((await holder.event(await audition(), "started")).status, 200);
  rmSync(ledger);
  renameSync(inventory, inventory + ".saved");
  renameSync(supervised, supervised + ".saved");
  writeFileSync(supervised, "not a directory");
  store.reset();
  await holder.hello();
  const unknown = await holder.poll();
  assert.equal(unknown.capture, false);
  assert.equal(unknown.speak, null);

  rmSync(supervised);
  renameSync(supervised + ".saved", supervised);
  renameSync(inventory + ".saved", inventory);
  await holder.announce();
  const stop = await holder.poll();
  assert.equal(stop.capture, false);
  assert.equal(stop.speak.stop, true);
  assert.equal((await holder.event(stop.speak.id, "ended")).status, 200);
  assert.equal((await holder.poll()).capture, true);
});

test("loss of all three recovery records during playback cannot make a used state home fresh", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  assert.equal((await holder.event(await audition(), "started")).status, 200);
  assert.equal(statSync(used).mode & 0o777, 0o600);
  const saved = join(home, "lost-voice");
  renameSync(join(home, "voice"), saved);
  store.reset();
  await peer.hello();
  assert.equal((await peer.poll()).capture, false);
  assert.equal((await peer.report("started")).status, 503);
  assert.equal((await holder.poll()).capture, false);
  store.reset();
  await peer.hello();
  assert.equal((await peer.poll()).capture, false);
  renameSync(join(saved, "supervised-instances.json"), inventory);
  await holder.announce();
  const stop = await holder.poll();
  assert.equal(stop.speak.stop, true);
  assert.equal(stop.capture, false);
  assert.equal((await peer.event(stop.speak.id, "ended")).status, 409);
  assert.equal((await holder.event(stop.speak.id, "ended")).status, 200);
  assert.equal((await peer.poll()).capture, true);
});

test("a job cannot reach a listener if its prior-use marker cannot be written", async () => {
  const holder = player();
  await holder.announce(); await holder.hello();
  mkdirSync(used);
  try {
    assert.equal((await post("/api/voice/speech/audition")).status, 503);
    assert.equal((await holder.poll()).speak, null);
    assert.equal((await holder.poll()).capture, true);
  } finally {
    rmSync(used, { recursive: true });
  }
});

test("audition reports an immediate storage failure and publishes the terminal result of a queued failure", async t => {
  const holder = player();
  const results: string[] = [];
  t.after(registry.subscribe(frame => {
    if (frame.type === "voice_state" && frame.state.speech.lastAudition) {
      const result = frame.state.speech.lastAudition;
      results.push(result.id + "/" + result.state);
    }
  }));
  await holder.announce(); await holder.hello();
  const first = await audition();
  assert.equal((await holder.event(first, "started")).status, 200);
  const queued = await audition();
  // Clearing the first job can succeed, while persisting a new handoff fails.
  renameSync(used, used + ".saved");
  mkdirSync(used);
  try {
    assert.equal((await holder.event(first, "ended")).status, 200);
    assert.equal(store.state().speech.job, null);
    assert.deepEqual(registry.snapshot().voice?.speech.lastAudition, { id: queued, state: "failed" });
    assert.deepEqual(results, [first + "/finished", queued + "/failed"]);
    const response = await post("/api/voice/speech/audition");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "audition_failed", reason: "The voice sample could not be prepared for playback." });
    assert.equal((await holder.poll()).speak, null);
    assert.equal((await holder.poll()).capture, true);
  } finally {
    rmSync(used, { recursive: true });
    renameSync(used + ".saved", used);
  }
});

for (const proof of ["ended", "exited"] as const) {
  test(`disabling Voice during playback delivers the stop and accepts only silence proof (${proof})`, async () => {
    const holder = player(), peer = player(crypto.randomUUID());
    await holder.announce(); await holder.hello();
    const id = await audition();
    assert.equal((await holder.event(id, "started")).status, 200);
    const { revision } = await holder.poll();
    const waiting = holder.request("/voice/listener/directive?revision=" + revision);
    await new Promise(resolve => setImmediate(resolve));
    toggle(false);
    const stopped = await (await waiting).json();
    assert.deepEqual(stopped.speak, { id, stop: true });
    assert.equal(stopped.capture, false);
    store.reset(); // Restart with Voice still off.
    assert.deepEqual((await holder.poll()).speak, { id, stop: true });
    assert.equal((await peer.request("/voice/listener/directive")).status, 404);
    assert.equal((await post("/api/voice/speech/audition")).status, 404);
    assert.equal((await holder.report("started")).status, 404);
    assert.equal((await peer.report("exited")).status, 200);
    assert.equal((await holder.event(id, "started")).status, 404);
    assert.equal((await peer.event(id, "ended")).status, 409);
    assert.equal((await holder.report("exited", holder.instance, "bad")).status, 403);
    assert.equal((await holder.poll()).capture, false);
    const end = proof === "ended" ? await holder.event(id, "ended") : await holder.report("exited");
    assert.equal(end.status, 200);
    assert.deepEqual(entries(), []);
    assert.equal((await holder.request("/voice/listener/directive")).status, 404);
    toggle(true); await peer.hello();
    assert.equal((await peer.poll()).capture, true);
  });
}

test("re-enabling Voice preserves an idle listener's capture while a daemon restart recovers its outstanding launch", async () => {
  const listener = player();
  await listener.announce(); await listener.hello();
  assert.throws(() => statSync(ledger), { code: "ENOENT" });
  assert.equal((await listener.poll()).capture, true);
  toggle(false);
  assert.equal((await listener.request("/voice/listener/directive")).status, 404);
  toggle(true); await listener.hello();
  const idle = await listener.poll();
  assert.equal(idle.capture, true);
  assert.equal(idle.speak, null);
  assert.equal(store.state().speech.job, null);
  assert.throws(() => statSync(ledger), { code: "ENOENT" });
  store.reset(); await listener.hello();
  const recovered = await listener.poll();
  assert.equal(recovered.capture, false);
  assert.equal(recovered.speak.stop, true);
  assert.equal((await listener.event(recovered.speak.id, "ended")).status, 200);
  assert.equal((await listener.poll()).capture, true);
});

test("with Voice off a signed exit retires a recorded launch after its last playback hold ended", async () => {
  const holder = player(), peer = player(crypto.randomUUID());
  await holder.announce(); await holder.hello();
  const id = await audition();
  await holder.event(id, "started");
  toggle(false);
  assert.equal((await holder.event(id, "ended")).status, 200);
  assert.deepEqual(entries(), []);
  store.reset(); // Only durable records identify the launch now.
  assert.equal((await peer.report("exited")).status, 200);
  assert.equal((await holder.report("started")).status, 404);
  assert.equal((await peer.report("exited", holder.instance)).status, 403);
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), [holder.instance]);
  assert.equal((await holder.report("exited")).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(inventory, "utf8")), []);
  assert.equal((await holder.report("exited")).status, 200);
  rmSync(ledger);
  store.reset(); toggle(true); await peer.hello();
  assert.equal((await peer.poll()).capture, true);
});

test("a trusted exit received first with Voice off survives restart and rejects the delayed start", async () => {
  const listener = player();
  toggle(false); store.reset();
  const marker = join(home, "voice/supervised-exits", announcementName(listener.instance) + ".json");
  assert.equal((await listener.report("exited", listener.instance, "invalid")).status, 404);
  assert.throws(() => statSync(marker), { code: "ENOENT" });
  assert.equal((await listener.report("started")).status, 404);
  assert.equal((await listener.report("exited")).status, 200);
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.equal((await listener.report("exited")).status, 200);
  assert.throws(() => statSync(inventory), { code: "ENOENT" });
  store.reset(); toggle(true); await listener.hello();
  const late = await listener.report("started");
  assert.equal(late.status, 409);
  assert.deepEqual(await late.json(), { error: "launch_exited" });
  assert.equal((await post("/api/voice/speech/audition")).status, 409);
  store.reset(); await listener.hello();
  assert.equal((await listener.poll()).capture, true);
});

for (const ledgerState of ["intact", "unreadable", "missing"]) for (const proof of ["ended", "exited"] as const) {
  test(`restart with a playing holder and a second listener, ${ledgerState} ledger, ${proof} proof`, async () => {
    const holder = player(), second = player(crypto.randomUUID());
    await holder.announce(); await holder.hello();
    const original = await audition();
    await holder.event(original, "started");
    await second.announce(); await second.hello();
    if (ledgerState !== "intact") {
      // A third accepted launch has already exited. Only the two live launches must stop.
      const gone = player(crypto.randomUUID());
      await gone.announce();
      assert.equal((await gone.report("exited")).status, 200);
      const receipts = readdirSync(supervised);
      assert.equal(receipts.length, 2);
      for (const receipt of receipts) assert.equal(statSync(join(supervised, receipt)).mode & 0o777, 0o600);
      if (ledgerState === "missing") rmSync(ledger);
      else writeFileSync(ledger, "{");
    }
    store.reset();
    await second.hello(); // No announcement after restart.
    const other = await second.poll();
    assert.equal(other.capture, false);
    const recovered = entries();
    assert.equal(statSync(ledger).mode & 0o777, 0o600);
    assert.equal(recovered.length, ledgerState === "intact" ? 1 : 2);
    const job = store.speech.live!;
    assert.equal(job.state, "stopping");
    const stop = (await holder.poll()).speak;
    assert.equal(stop.stop, true);
    assert.equal(stop.id === original, ledgerState === "intact");
    if (ledgerState !== "intact") {
      assert.deepEqual(other.speak, { id: recovered.find((h: { instance: string }) => h.instance === second.instance).jobId, stop: true });
      assert.equal(store.state().capabilities.listener?.reason, "the record of unfinished speech could not be read");
      await second.event(other.speak.id, "ended");
    } else assert.equal(other.speak, null);
    assert.equal((await second.event(stop.id, "ended")).status, 409);
    assert.equal((await second.report("exited")).status, 200);
    assert.equal((await second.request("/voice/utterances", { ...capture("Steve old"), capturedAt: 0 })).status, 200);
    assert.equal((await readHeard())[0]?.rule, "while-speaking");
    await post("/api/voice/mute", { muted: true }); toggle(false);
    assert.equal((await holder.event(stop.id, "started")).status, 404);
    toggle(true); await post("/api/voice/mute", { muted: false });
    assert.equal((await second.poll()).capture, false);
    assert.equal((await second.poll()).speak, null);
    assert.deepEqual((await holder.poll()).speak, stop);
    if (proof === "exited") assert.equal((await holder.report("exited")).status, 200);
    else await holder.event(stop.id, "ended");
    assert.equal(job.state, "failed");
    assert.deepEqual(entries(), []);
    assert.equal((await second.poll()).capture, true);
  });
}

test("deleting an unreadable supervisor record leaves its hold intact through peer reports and restart", async () => {
  const p = player(), peer = player(crypto.randomUUID()), unknown = player(crypto.randomUUID());
  mkdirSync(supervised, { recursive: true });
  writeFileSync(join(supervised, "dev.json"), JSON.stringify({ instance: peer.instance }));
  writeFileSync(join(supervised, "unreadable.json"), "?");
  writeFileSync(join(supervised, "shell.json"), JSON.stringify({ instance: p.instance }));
  writeFileSync(ledger, "?");
  store.reset(); await p.hello();
  const stop = (await p.poll()).speak;
  await p.event(stop.id, "ended");
  await peer.event((await peer.poll()).speak.id, "ended");
  toggle(false); toggle(true);
  await p.announce();
  assert.equal((await p.poll()).capture, false);
  assert.equal(entries()[0].supervisor, "unreadable");
  rmSync(join(supervised, "unreadable.json"));
  assert.equal((await p.poll()).capture, false);
  await p.announce();
  assert.equal((await peer.report("exited")).status, 200);
  assert.equal((await p.poll()).capture, false);
  store.reset(); await p.hello();
  assert.equal(entries()[0].supervisor, "unreadable");
  assert.equal((await p.poll()).capture, false);

  writeFileSync(join(supervised, "unreadable.json"), JSON.stringify({ instance: unknown.instance }));
  await p.announce();
  const recovered = await unknown.poll();
  assert.equal(recovered.capture, false);
  assert.equal(recovered.speak.stop, true);
  assert.equal((await peer.event(recovered.speak.id, "ended")).status, 409);
  assert.equal((await unknown.event(recovered.speak.id, "ended")).status, 200);
  assert.equal(entries()[0].supervisor, "unreadable");
  assert.equal((await p.poll()).capture, false);
});

test("a missing supervisor directory keeps every outstanding launch held until its own silence proof", async () => {
  const holder = player(), second = player(crypto.randomUUID()), peer = player(crypto.randomUUID());
  await holder.announce();
  await holder.hello();
  const id = await audition();
  assert.equal((await holder.event(id, "started")).status, 200);
  rmSync(inventory); // The next start must also retain launches recorded before the inventory existed.
  await second.announce();
  assert.equal(statSync(inventory).mode & 0o777, 0o600);
  rmSync(supervised, { recursive: true });
  writeFileSync(ledger, "{");
  store.reset();
  await holder.hello();
  assert.equal((await holder.poll()).capture, false);

  await peer.announce(); // Recreates the directory with only the new launch's receipt.
  assert.equal((await peer.poll()).speak, null);
  assert.equal((await peer.report("exited")).status, 200);
  store.reset();
  await holder.hello();
  const stop = await holder.poll();
  assert.equal(stop.capture, false);
  assert.equal(stop.speak.stop, true);
  assert.equal((await second.poll()).speak.stop, true);
  assert.equal((await second.report("exited")).status, 200);
  assert.equal((await holder.poll()).capture, false);
  assert.equal((await holder.event(stop.speak.id, "ended")).status, 200);
  assert.equal((await holder.poll()).capture, true);
});

test("only the holder can fetch prepared audio, until stopping, completion or the elapsed deadline", async () => {
  const directory = join(home, "audio-test", "voice");
  let steady = 0;
  const s = new VoiceStateStore({ now: () => steady, enabled: () => true, config: () => VOICE_CONFIG_DEFAULTS,
    speechDirectory: directory, speechBackend: {
      model: () => ({ ...VOICE_MODEL_STATE_NONE, status: "ready" }),
      neural: () => [{ id: VOICE_SPEECH_DEFAULT_NEURAL, name: "F4", detail: "" }],
      synthesizer: { warm() {}, stop() {}, synthesize: async () => ({ durationMs: 42, wav: new Uint8Array([82, 73, 70, 70]) }) },
    } });
  const server = new Hono();
  registerVoiceRoutes(server, s);
  const holder = player(listenerId, server), other = player(crypto.randomUUID(), server);
  await holder.announce(); await holder.hello();
  assert.equal((await holder.poll()).capture, true);
  const id = (await (await holder.request("/api/voice/speech/audition", {})).json()).id;
  const path = "/voice/speech/jobs/" + id + "/audio";
  assert.equal((await holder.request(path)).status, 404);
  assert.equal((await holder.pickup()).speak.id, id);
  assert.equal(await (await holder.request(path)).text(), "RIFF");
  assert.equal((await other.request(path)).status, 404);
  assert.equal((await server.request(path + "?instance=" + holder.instance, { headers: { "x-harness-token": token } })).status, 404);
  await holder.event(id, "started"); assert.equal((await holder.request(path)).status, 200);
  await holder.request("/api/voice/speech/stop", {});
  assert.equal((await holder.request(path)).status, 404);
  await holder.event(id, "ended"); assert.equal((await holder.request(path)).status, 404);
  const next = (await (await holder.request("/api/voice/speech/audition", {})).json()).id;
  const audio = "/voice/speech/jobs/" + next + "/audio";
  steady += 1999;
  assert.equal((await holder.request(audio)).status, 200);
  steady++;
  assert.equal((await holder.request(audio)).status, 404);
  const expired = await holder.poll();
  assert.deepEqual(expired.speak, { id: next, stop: true });
  assert.equal(expired.capture, false);
  await holder.event(next, "ended");
  assert.equal((await holder.poll()).capture, true);
  s.reset();
});

test("recovery remains closed when neither ledger repair nor supervisor enumeration can complete", async () => {
  const p = player(), peer = player(crypto.randomUUID());
  await p.announce();
  await p.hello();
  const id = await audition();
  assert.equal((await p.event(id, "started")).status, 200);
  renameSync(inventory, inventory + ".saved");
  // A directory in place of the ledger makes the read and the replacement rename both fail.
  rmSync(ledger, { force: true });
  mkdirSync(ledger);
  rmSync(supervised, { recursive: true });
  writeFileSync(supervised, "unlistable");
  store.reset();
  await p.hello();
  assert.equal((await p.poll()).capture, false);
  toggle(false); toggle(true);
  assert.equal((await p.poll()).speak, null);
  rmSync(supervised);
  mkdirSync(supervised);
  assert.equal((await peer.report("started")).status, 503);
  assert.equal((await p.poll()).capture, false);
  renameSync(inventory + ".saved", inventory);
  assert.equal((await peer.report("started")).status, 503); // The ledger still cannot persist the transfer.
  rmSync(ledger, { recursive: true });
  await peer.announce();
  const directive = await p.poll();
  assert.equal(directive.capture, false);
  assert.equal(directive.speak.stop, true);
  await p.event(directive.speak.id, "ended");
  assert.equal((await p.poll()).capture, false);
  assert.equal((await peer.report("exited")).status, 200);
  assert.equal((await p.poll()).capture, true);
  rmSync(supervised, { recursive: true }); rmSync(ledger, { recursive: true });
});
