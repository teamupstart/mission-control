import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { VoiceListener } from "../src/main/voice-listener.ts";
import { ShellVoiceStateSchema } from "../src/main/voice-state-schema.ts";
import { voiceStateOff, type VoiceState } from "../src/shared/voice.ts";

test("the shell owns one granted listener per ready model, retries crashes and drains before shutdown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const models: string[] = [];
  const signals: string[] = [];
  const diagnostics: string[] = [];
  let child = new EventEmitter();
  const listener = new VoiceListener(directory => {
    models.push(directory);
    child = new EventEmitter();
    return Object.assign(child, {
      pid: models.length === 1 ? undefined : 100 + models.length,
      kill: (signal: string) => signals.push(signal),
    }) as unknown as ChildProcess;
  }, line => diagnostics.push(line));
  const state: VoiceState = voiceStateOff();
  listener.update(state, true);
  state.mode = "unavailable";
  listener.update(state, true);
  state.model = { ...state.model, status: "ready", backend: "fluidaudio", directory: "/model/a" };
  listener.update(state, false);
  assert.deepEqual(models, []);
  listener.update(state, true);
  state.mode = "muted";
  listener.update(state, true);
  assert.deepEqual(models, ["/model/a"]);
  child.emit("error", Object.assign(new Error("spawn path should stay private"), {code: "EACCES"}));
  child.emit("close", -13, null);
  t.mock.timers.tick(499);
  assert.equal(models.length, 1);
  t.mock.timers.tick(1);
  assert.equal(models.length, 2);
  child.emit("close", 1, null);
  t.mock.timers.tick(999);
  assert.equal(models.length, 2);
  t.mock.timers.tick(1);
  state.model.directory = "/model/b";
  listener.update(state, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(models.length, 3);
  child.emit("close", 0, null);
  assert.equal(models.at(-1), "/model/b");
  const stopped = listener.stop();
  let drained = false;
  void stopped.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  t.mock.timers.tick(2000);
  assert.equal(signals.at(-1), "SIGKILL");
  child.emit("close", null, "SIGKILL");
  await stopped;
  assert.deepEqual(diagnostics, [
    'Voice listener launch pid=none modelRevision="a"',
    "Voice listener close pid=none code=-13 signal=none requested=false error=EACCES",
    "Voice listener retry pid=none attempt=1 delayMs=500",
    'Voice listener launch pid=102 modelRevision="a"',
    "Voice listener close pid=102 code=1 signal=none requested=false",
    "Voice listener retry pid=102 attempt=2 delayMs=1000",
    'Voice listener launch pid=103 modelRevision="a"',
    "Voice listener close pid=103 code=0 signal=none requested=true",
    'Voice listener launch pid=104 modelRevision="b"',
    "Voice listener close pid=104 code=none signal=SIGKILL requested=true",
  ]);
  assert.ok(drained);
  listener.update(state, true);
  t.mock.timers.tick(5000);
  assert.equal(models.length, 4);
});

test("an already-exited asynchronous launch cannot signal its replacement or finish its shutdown", async () => {
  let deliver!: (child: ChildProcess) => void;
  const launching = new Promise<ChildProcess>(resolve => { deliver = resolve; });
  const signals: string[] = [];
  const replacement = Object.assign(new EventEmitter(), { kill: (signal: string) => signals.push(signal) });
  const listener = new VoiceListener(directory => directory === "/a" ? launching : replacement as unknown as ChildProcess, () => {});
  const state = voiceStateOff();
  state.mode = "listening";
  state.model = { ...state.model, status: "ready", backend: "fluidaudio", directory: "/a" };
  listener.update(state, true);
  state.model.directory = "/b";
  listener.update(state, true);
  deliver(Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null }) as ChildProcess);
  await launching;
  assert.equal(replacement.listenerCount("close"), 1);
  assert.deepEqual(signals, []);

  let drained = false;
  const stopped = listener.stop().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(drained, false);
  replacement.emit("close", 0, null);
  await stopped;
});

test("switching voice off disarms a pending retry", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let starts = 0;
  const child = new EventEmitter();
  const listener = new VoiceListener(() => { starts++; return child as ChildProcess; });
  const off = voiceStateOff();
  listener.update({ ...off, mode: "unavailable", model: { ...off.model, directory: "/a", status: "ready", backend: "fluidaudio" } }, true);
  child.emit("close", 1);
  listener.update(off, true);
  t.mock.timers.tick(5000);
  assert.equal(starts, 1);
});

test("an unconfirmed stop code replaces once regardless of display text and waits for actual close", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  const signals: string[] = [];
  const children: EventEmitter[] = [];
  const listener = new VoiceListener(() => {
    const child = new EventEmitter();
    children.push(child);
    return Object.assign(child, {kill: (signal: string) => signals.push(signal)}) as unknown as ChildProcess;
  }, () => {});
  const state = voiceStateOff();
  state.mode = "listening";
  state.model = {...state.model, status: "ready", backend: "fluidaudio", directory: "/model"};
  listener.update(state, true);
  state.capabilities.listener = {available: false, reason: "the listener did not confirm that speech had stopped"};
  listener.update(ShellVoiceStateSchema.parse(state), true);
  assert.deepEqual(signals, []);
  state.capabilities.listener = {available: false, code: "speech_stop_unconfirmed", reason: "The stop deadline passed."};
  const missedStop = ShellVoiceStateSchema.parse(state);
  listener.update(missedStop, true);
  listener.update(missedStop, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(2500);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(children.length, 1);
  children[0]!.emit("close", null, "SIGKILL");
  t.mock.timers.tick(500);
  listener.update(missedStop, true);
  assert.equal(children.length, 2);
  assert.equal(signals.length, 2);
  const stopped = listener.stop();
  children[1]!.emit("close", 0);
  await stopped;
});

test("confined launch records its OS identity and replays its exit before it can reuse the slot", {
  skip: process.platform !== "darwin", timeout: 20000,
}, async t => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { mkdtempSync, statSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { MacListenerSupervisor, hasPendingMacListenerRecovery } = await import("../src/server/voice/macos-supervisor.ts");
  const { createVoiceSupervisor, supervisorIssuer } = await import("../src/server/voice/supervisor-auth.ts");
  const { voiceProcessBirth } = await import("../src/server/voice/process-birth.ts");
  const { ensureNativeStateLockAddon } = await import("./helpers/native-state-lock.ts");
  ensureNativeStateLockAddon();
  const home = mkdtempSync(join(tmpdir(), "mc-speech-supervisor-"));
  const slot = join(home, "voice", "supervised", "dev.json");
  const read = () => JSON.parse(readFileSync(slot, "utf8"));
  const signer = createVoiceSupervisor("dev", generateKeyPairSync("ed25519").privateKey);
  let online = true;
  let exited = false;
  let starts = 0;
  let exitAttempts = 0;
  let instance: string | undefined;
  const supervisor = new MacListenerSupervisor(home, "dev", signer, "/bin/cat", async (id, state, proof) => {
    assert.equal(supervisorIssuer(id, state, proof)?.name, "dev");
    if (state === "started") {
      starts++;
      assert.equal(read().pid, undefined);
      assert.ok(read().instance === id && id !== instance);
      instance = id;
    } else {
      exitAttempts++;
      assert.ok(exited);
      assert.ok(id === instance);
      if (!online) throw new Error("Daemon offline");
    }
  });
  t.after(async () => {
    await supervisor.close();
    signer.pauseExitRetries();
    rmSync(home, {recursive: true, force: true});
  });
  assert.equal(hasPendingMacListenerRecovery(home), false);
  const first = await supervisor.start(process.env);
  t.after(() => first.kill());
  assert.equal(read().pid, first.pid);
  assert.equal(read().startedAt, voiceProcessBirth(first.pid!));
  assert.equal(statSync(slot).mode & 0o777, 0o600);
  assert.equal(statSync(join(slot, "..")).mode & 0o777, 0o700);
  online = false;
  first.once("exit", () => { exited = true; });
  const close = once(first, "close");
  first.kill();
  assert.equal(exitAttempts, 0);
  await close;
  await t.waitFor(() => assert.ok(exitAttempts > 0));
  assert.ok(existsSync(slot));
  assert.equal(hasPendingMacListenerRecovery(home), true, "a deferred signer is needed to recover the earlier run");
  await assert.rejects(supervisor.start(process.env));
  assert.equal(starts, 1);
  online = true;
  supervisor.reconnect();
  await t.waitFor(() => assert.equal(existsSync(slot), false));
  assert.equal(hasPendingMacListenerRecovery(home), false);
  const second = await supervisor.start(process.env);
  assert.equal(starts, 2);
  const done = once(second, "close");
  second.kill();
  await done;
  await t.waitFor(() => assert.equal(existsSync(slot), false));
});

test("recovery stops a verified prior process, preserves a live peer, and handles incomplete records conservatively", {
  skip: process.platform !== "darwin", timeout: 20000,
}, async t => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn, execFileSync } = await import("node:child_process");
  const { MacListenerSupervisor } = await import("../src/server/voice/macos-supervisor.ts");
  const { createVoiceSupervisor } = await import("../src/server/voice/supervisor-auth.ts");
  const { writeVoiceRecord } = await import("../src/server/voice/recovery-files.ts");
  const { ensureNativeStateLockAddon } = await import("./helpers/native-state-lock.ts");
  ensureNativeStateLockAddon();
  const home = mkdtempSync(join(tmpdir(), "mc-recovery-"));
  const helper = join(home, "recovery-player-" + process.pid);
  execFileSync("xcrun", ["clang", "-x", "c", "-", "-o", helper], {
    input: "#include <unistd.h>\nint main(void) { write(1, \"ready\", 5); for (;;) pause(); }",
  });
  const slot = join(home, "voice/supervised/shell.json");
  const peer = join(home, "voice/supervised/dev.json");
  const signer = createVoiceSupervisor("shell", generateKeyPairSync("ed25519").privateKey);
  const dev = createVoiceSupervisor("dev", generateKeyPairSync("ed25519").privateKey);
  const children: ChildProcess[] = [];
  const exits: string[] = [];
  const supervisor = new MacListenerSupervisor(home, "shell", signer, helper, async (id, event) => {
    if (event === "exited") exits.push(id);
  });
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill();
      await closed;
    }));
    await supervisor.close();
    signer.pauseExitRetries();
    dev.pauseExitRetries();
    rmSync(home, {recursive: true, force: true});
  });
  const prior = await signer.launch(home, helper, [], process.env, async () => {}, (instance, pid, startedAt) => {
    assert.ok(writeVoiceRecord(home, slot, {instance, pid, startedAt}));
  });
  children.push(prior.child);
  const peerChild = await dev.launch(home, helper, [], process.env, async () => {}, (instance, pid, startedAt) => {
    assert.ok(writeVoiceRecord(home, peer, {instance, pid, startedAt}));
  });
  children.push(peerChild.child);
  await Promise.all([once(prior.child.stdout, "data"), once(peerChild.child.stdout, "data")]);
  const peerOriginal = readFileSync(peer, "utf8");
  signer.pauseExitRetries();
  dev.pauseExitRetries();
  await t.waitFor(async () => {
    await supervisor.recoverPrevious();
    assert.equal(existsSync(slot), false);
  });
  assert.ok(prior.child.signalCode);
  assert.ok(exits.includes(prior.instance));
  assert.equal(readFileSync(peer, "utf8"), peerOriginal);
  assert.equal(peerChild.child.signalCode, null);

  writeFileSync(slot, "unreadable");
  await assert.rejects(supervisor.recoverPrevious(), /Waiting/);
  assert.ok(existsSync(slot));
  const peerClosed = once(peerChild.child, "close");
  peerChild.child.kill();
  await peerClosed;
  // The originating supervisor has signed its OS-observed exit, but is offline.
  await supervisor.recoverPrevious();
  assert.ok(exits.includes(peerChild.instance));
  assert.equal(existsSync(peer), false);
  assert.equal(existsSync(slot), false);

  const unrelated = spawn(helper, []);
  children.push(unrelated);
  await once(unrelated, "spawn");
  const stale = JSON.parse(peerOriginal);
  assert.ok(writeVoiceRecord(home, peer, {...stale, pid: unrelated.pid, startedAt: "earlier birth"}));
  await supervisor.recoverPrevious();
  assert.equal(existsSync(peer), false);
  assert.equal(unrelated.signalCode, null);

  assert.ok(writeVoiceRecord(home, peer, {instance: peerChild.instance}));
  await supervisor.recoverPrevious();
  assert.ok(existsSync(peer), "PID-less peer needs proof no executable remains");
  const gone = once(unrelated, "close");
  unrelated.kill();
  await gone;
  await supervisor.recoverPrevious();
  assert.equal(existsSync(peer), false);
});
