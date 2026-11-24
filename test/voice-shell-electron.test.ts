import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { desktopVoiceEndpointPath } from "../src/shared/harness-runtime.mjs";
import { ensureToken } from "../src/server/auth.ts";
import { serveDesktopVoice } from "../src/server/voice/desktop-endpoint.ts";
import { buildSync } from "esbuild";
import { _electron } from "@playwright/test";
import { voiceStateOff, type VoiceMode, type VoiceShellReport } from "../src/shared/voice.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

test("Electron keeps one template tray in sync while minimized, handles both clicks and restores the off menu", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async t => {
  assertElectronGuiLaunchAllowed();
  const root = mkdtempSync(join(tmpdir(), "voice-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "token"), ensureToken());
  const binary = join(root, "voice-listener");
  writeFileSync(binary, `#!/usr/bin/env node
    const fs = require("node:fs");
    const {MISSION_VOICE_MODEL_DIR, MISSION_VOICE_TOKEN_FILE, MISSION_VOICE_DAEMON_URL, MISSION_VOICE_DAEMON_CERT} = process.env;
    fs.appendFileSync(${JSON.stringify(join(root, "pids"))}, process.pid + "\\n");
    fs.writeFileSync(${JSON.stringify(join(root, "started"))}, JSON.stringify([MISSION_VOICE_MODEL_DIR, MISSION_VOICE_TOKEN_FILE, MISSION_VOICE_DAEMON_URL, MISSION_VOICE_DAEMON_CERT]));
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(join(root, "stopped"))}, "stopped"); process.exit(0); });
    setInterval(() => {}, 1000);
  `, {mode: 0o755});
  let events: ServerResponse | undefined;
  let connects = 0;
  let unavailableHandshakes = 1;
  let refusals = 0;
  let reconnectSnapshot: string | undefined;
  const heartbeatMs = 750;
  let keepalive: "ping" | "registry" | "silent" = "ping";
  const requests: boolean[] = [];
  let muteResponse: "ok" | "refused" | "timeout" = "ok";
  const reports: VoiceShellReport[] = [];
  let holdReport = false;
  let refuseReport = false;
  let heldReport: ServerResponse | undefined;
  const publicRequests: { path?: string; credential: boolean }[] = [];
  const server = createServer((req, res) => {
    publicRequests.push({ path: req.url, credential: !!req.headers["x-harness-token"] });
    res.end(JSON.stringify({ counts: { needsYou: 2 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpointFile = desktopVoiceEndpointPath(root, address.port);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const secureServer = await serveDesktopVoice(async (req, res) => {
    if (req.url === "/events") {
      if (unavailableHandshakes > 0) {
        unavailableHandshakes--;
        refusals++;
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      events = res;
      connects++;
      res.flushHeaders();
      const ping = setInterval(() => {
        if (keepalive === "ping") res.write("event: ping\ndata: \n\n");
        if (keepalive === "registry") res.write('data: {"type":"session_remove","id":"fixture"}\n\n');
      }, heartbeatMs);
      res.once("close", () => clearInterval(ping));
      if (connects === 1) res.write('data: {"type":"snapshot"}\n\n');
      else if (reconnectSnapshot) res.write("data: " + reconnectSnapshot + "\n\n");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/api/voice/mute") {
      requests.push(JSON.parse(body).muted);
      if (muteResponse === "timeout") return;
      if (muteResponse === "refused") res.statusCode = 503;
    }
    if (req.url === "/voice/shell-report" && req.headers["x-harness-token"] === ensureToken()) {
      if (refuseReport) { res.writeHead(503).end(); return; }
      reports.push(JSON.parse(body));
      if (holdReport) {
        holdReport = false;
        heldReport = res;
        return;
      }
    }
    res.end(JSON.stringify({ counts: { needsYou: 2 } }));
  }, endpointFile, controller.signal);
  assert.ok(secureServer);
  const rejectedHandshake = once(secureServer, "tlsClientError");
  const endpoint = JSON.parse(readFileSync(endpointFile, "utf8"));
  const otherFile = join(root, "other-identity.json");
  const other = new AbortController();
  await serveDesktopVoice(() => assert.fail("unexpected application request"), otherFile, other.signal);
  const otherCertificate = JSON.parse(readFileSync(otherFile, "utf8")).certificate;
  other.abort();
  writeFileSync(endpointFile, JSON.stringify({ ...endpoint, certificate: otherCertificate }));
  const entry = join(root, "fixture.cjs");
  buildSync({
    stdin: { resolveDir: resolve("."), loader: "ts", contents: `
      import { app, BrowserWindow, shell, systemPreferences } from "electron";
      import { createTray, setTrayVoice, destroyTray } from "./src/main/tray.ts";
      import { startShellVoice } from "./src/main/voice-state.ts";
      app.whenReady().then(() => {
        let permission = "not-determined";
        systemPreferences.getMediaAccessStatus = () => permission;
        let answer = "granted";
        const calls = [];
        systemPreferences.askForMediaAccess = async media => {
          calls.push(media);
          if (answer === "reject") throw Error("fixture permission error");
          permission = answer;
          return permission === "granted";
        };
        shell.openExternal = async url => { calls.push(url); };
        const configurePermission = (status, next) => { permission = status; answer = next; };
        const win = new BrowserWindow({ width: 800, height: 300 });
        win.loadURL("about:blank");
        win.minimize();
        let opens = 0;
        const tray = createTray(${JSON.stringify(resolve("build/trayTemplate.png"))}, ${JSON.stringify(resolve("build"))}, {
          onOpen: () => opens++, setMuted: value => voice.mute(value)
        });
        const captures = [];
        const setImage = tray.setImage.bind(tray);
        tray.setImage = image => {
          if (image.isEmpty() || !image.isTemplateImage()) throw Error("invalid template");
          captures.push(image.toDataURL());
          setImage(image);
        };
        let labels = [];
        let lastMenu;
        tray.popUpContextMenu = menu => { lastMenu = menu; labels = menu.items.map(item => item.label); };
        const voice = startShellVoice(${JSON.stringify(binary)}, setTrayVoice, ${heartbeatMs});
        global.fixture = { tray, voice, captures, calls, configurePermission, clickMenu: label => lastMenu.items.find(item => item.label === label).click(), get labels() { return labels; }, get opens() { return opens; } };
        app.on("before-quit", () => { voice.stop(); destroyTray(); });
      });
    ` }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry,
  });
  const app = await _electron.launch({ args: [entry, "--user-data-dir=" + root], env: {
    ...process.env, MISSION_HOME: root, MISSION_PORT: String(address.port),
  } });
  t.after(() => app.close());
  const page = await app.firstWindow();
  type Fixture = { tray: Electron.Tray; voice: {state: {mode: string}; fixMicrophone(): Promise<string>; checkMicrophone(): Promise<string>}; calls: string[]; configurePermission(status: string, answer: string): void; clickMenu(label: string): void; labels: string[]; captures: string[]; opens: number };
  // evaluate executes in the fixture main process.
  const read = () => app.evaluate(() => {
    const f = (globalThis as unknown as {fixture: Fixture}).fixture;
    return {mode: f.voice.state.mode, title: f.tray.getTitle(), labels: f.labels, captures: f.captures, opens: f.opens};
  });
  const click = (event: string) => app.evaluate((_, name) => {
    (globalThis as unknown as {fixture: Fixture}).fixture.tray.emit(name);
  }, event);
  async function until(predicate: () => boolean | Promise<boolean>, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, "timed out waiting for shell state");
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  await t.test("a different daemon certificate keeps voice off and sends no HTTP request", async () => {
    await until(async () => (await read()).title === " 2");
    await rejectedHandshake;
    assert.equal((await read()).mode, "off");
    assert.equal(refusals, 0);
    assert.equal(connects, 0);
    assert.equal(reports.length, 0);
    assert.equal(existsSync(join(root, "started")), false);
    assert.ok(publicRequests.length && publicRequests.every(r => r.path === "/api/report" && !r.credential));
  });
  writeFileSync(endpointFile, JSON.stringify(endpoint));
  await until(async () => !!events && (await read()).title === " 2");
  assert.equal(refusals, 1, "the shell recovered from a 503 on its first handshake");
  assert.equal(reports.length, 0);
  await click("click");
  assert.equal((await read()).opens, 1);
  const images: string[] = [];
  for (const mode of ["listening", "muted", "auto-muted", "push-to-talk", "unavailable", "off"] satisfies VoiceMode[]) {
    events!.write("data: " + JSON.stringify({ type: "voice_state", state: { ...voiceStateOff(), mode } }) + "\n\n");
    await until(async () => (await read()).mode === mode);
    if (mode === "off") break;
    await click("right-click");
    const {labels, title, captures} = await read();
    assert.equal(title, " 2");
    assert.match(labels[3]!, /^Voice: /);
    assert.equal(labels[4], mode === "muted" ? "Unmute Voice" : "Mute Voice");
    images.push(captures.at(-1)!);
    if (mode === "listening" || mode === "muted") await click("click");
  }
  await until(() => requests.length === 2);
  assert.deepEqual(requests, [true, false]);
  assert.ok(reports.length);
  assert.equal(new Set(images).size, 4);
  await click("click");
  assert.equal((await read()).opens, 2);
  assert.equal(await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.voice.fixMicrophone()), "unavailable");
  await t.test("rapid tray clicks send one request until the published mute state changes", async () => {
    const publish = (mode: VoiceMode) => events!.write("data: " + JSON.stringify({type: "voice_state", state: {...voiceStateOff(), mode}}) + "\n\n");
    publish("listening");
    await until(async () => (await read()).mode === "listening");
    const since = requests.length;
    await click("click");
    await click("click");
    await until(() => requests.length > since);
    // The fixture has accepted the POST and deliberately withholds its state event.
    await click("click");
    await click("right-click");
    await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.clickMenu("Mute Voice"));
    publish("muted");
    await until(async () => (await read()).mode === "muted");
    await click("click");
    await until(() => requests.at(-1) === false);
    assert.deepEqual(requests.slice(since), [true, false]);
    publish("off");
    await until(async () => (await read()).mode === "off");
  });
  await t.test("the tray opens with feedback on a refused mute or timeout and supports a menu retry", async () => {
    for (const response of ["refused", "timeout"] as const) {
      muteResponse = response;
      const mode = response === "refused" ? "listening" : "muted";
      events!.write("data: " + JSON.stringify({type: "voice_state", state: {...voiceStateOff(), mode}}) + "\n\n");
      await until(async () => (await read()).mode === mode);
      await click("click");
      const action = mode === "listening" ? "Mute" : "Unmute";
      const error = action + " not confirmed. Try again.";
      await until(async () => (await read()).labels.includes(error));
      assert.equal((await read()).mode, mode);
      muteResponse = "ok";
      const since = requests.length;
      await app.evaluate((_, label) => (globalThis as unknown as {fixture: Fixture}).fixture.clickMenu(label), action + " Voice");
      await until(() => requests.length > since);
      assert.equal(requests.at(-1), mode === "listening");
      await until(async () => { await click("right-click"); return !(await read()).labels.includes(error); });
      if (mode === "listening") {
        // A successful POST without its confirmation event eventually offers retry, too.
        await until(async () => (await read()).labels.includes(error));
      }
    }
  });
  events!.write("data: " + JSON.stringify({ type: "voice_state", state: { ...voiceStateOff(), mode: "unavailable" } }) + "\n\n");
  await until(async () => (await read()).mode === "unavailable");
  await t.test("a shell report outage logs its HTTP status once until delivery recovers", async () => {
    const check = () => app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.voice.checkMicrophone());
    const failures = () => readFileSync(join(root, "daemon.log"), "utf8").match(/Voice shell report failed status=503/g)?.length ?? 0;
    try {
      refuseReport = true;
      await assert.rejects(check(), /report was not accepted/);
      await assert.rejects(check(), /report was not accepted/);
      assert.equal(failures(), 1);
      refuseReport = false;
      assert.equal(await check(), "checked");
      refuseReport = true;
      await assert.rejects(check(), /report was not accepted/);
      assert.equal(failures(), 2);
    } finally { refuseReport = false; }
  });
  await t.test("microphone repair retries a rejected prompt, reports denial, opens Privacy settings and reports a grant", async () => {
    const fix = () => app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.voice.fixMicrophone());
    const configure = (status: string, answer: string) => app.evaluate((_, args) => {
      (globalThis as unknown as {fixture: Fixture}).fixture.configurePermission(args.status, args.answer);
    }, {status, answer});
    const expectReport = async (since: number, status: string) => {
      await until(() => reports.slice(since).some(r => r.microphone === status &&
        r.capabilities.microphone?.available === (status === "granted") &&
        r.capabilities.microphone.reason === (status === "granted" ? null : status)));
    };
    await configure("not-determined", "reject");
    await assert.rejects(fix(), /fixture permission error/);
    // A failed OS request leaves the permission undetermined on the next heartbeat.
    await expectReport(reports.length, "not-determined");
    await configure("not-determined", "denied");
    let since = reports.length;
    await fix();
    await expectReport(since, "denied");
    since = reports.length;
    await fix();
    await expectReport(since, "denied");
    // Check again reports the OS change immediately and never opens Settings or asks for access.
    await configure("granted", "reject");
    since = reports.length;
    assert.equal(await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.voice.checkMicrophone()), "checked");
    assert.equal(reports.slice(since).at(-1)?.microphone, "granted");
    await configure("not-determined", "granted");
    since = reports.length;
    await fix();
    await expectReport(since, "granted");
    assert.deepEqual(await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.calls), [
      "microphone", "microphone", "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", "microphone",
    ]);
    await configure("not-determined", "reject");
  });
  events!.write("data: " + JSON.stringify({ type: "voice_state", state: voiceStateOff() }) + "\n\n");
  await until(async () => (await read()).mode === "off");
  await t.test("a delayed shell report coalesces queued updates and samples current permission before the next POST", async t => {
    const event = (mode: VoiceMode) => "data: " + JSON.stringify({type: "voice_state", state: {...voiceStateOff(), mode}}) + "\n\n";
    t.after(async () => {
      holdReport = false;
      if (heldReport && !heldReport.writableEnded) heldReport.end();
      events!.write(event("off"));
      await until(async () => (await read()).mode === "off");
      await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.configurePermission("not-determined", "reject"));
    });
    const since = reports.length;
    holdReport = true;
    events!.write(event("unavailable"));
    await until(() => !!heldReport);
    events!.write(event("listening") + event("muted"));
    await until(async () => (await read()).mode === "muted");
    // Permission changes after the queued state events and before the first POST completes.
    await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.configurePermission("granted", "granted"));
    assert.equal(reports.length, since + 1, "queued reports wait for the outstanding POST");
    heldReport!.end();
    await until(() => reports.length >= since + 2);
    assert.deepEqual(reports.slice(since, since + 2).map(report => report.microphone), ["not-determined", "granted"]);
  });
  const ready = { ...voiceStateOff(), mode: "unavailable", model: {
    ...voiceStateOff().model, status: "ready", backend: "fluidaudio", directory: "/verified-model",
  } };
  assert.equal(existsSync(join(root, "started")), false);
  await t.test("an automatic prompt rejection backs off and retries on a heartbeat while permission remains undetermined", async () => {
    const calls = () => app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.calls.length);
    const before = await calls();
    const update = "data: " + JSON.stringify({type: "voice_state", state: ready}) + "\n\n";
    events!.write(update);
    await until(async () => (await calls()) === before + 1);
    await app.evaluate(() => (globalThis as unknown as {fixture: Fixture}).fixture.configurePermission("not-determined", "granted"));
    const reportCount = reports.length;
    events!.write(update);
    await until(() => reports.length > reportCount);
    assert.equal(await calls(), before + 1);
    assert.equal(existsSync(join(root, "started")), false);
    await until(() => existsSync(join(root, "started")), 15_000);
    assert.equal(await calls(), before + 2);
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "started"), "utf8")),
    ["/verified-model", join(root, "token"), `https://127.0.0.1:${endpoint.port}`, endpoint.certificate]);
  const pids = () => readFileSync(join(root, "pids"), "utf8").trim().split("\n").map(Number);
  const exited = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  };
  await t.test("capture stops on stream loss, ignores an early incremental update and resumes from a fresh snapshot after two HTTP 503s", async () => {
    const [first] = pids();
    assert.equal(exited(first!), false);
    unavailableHandshakes = 2;
    events!.destroy();
    await until(() => exited(first!));
    await until(() => connects === 2);
    assert.equal(refusals, 3);
    assert.equal((await read()).mode, "off");
    await click("right-click");
    assert.equal((await read()).labels[3], "Voice: reconnecting");
    assert.equal((await read()).captures.at(-1), images[1], "reconnect uses the approved struck microphone");
    const opens = (await read()).opens;
    await click("click");
    await until(async () => (await read()).labels.includes("Mute not confirmed. Try again."));
    assert.equal((await read()).opens, opens, "a voice click during reconnect does not open the dashboard");
    const duringReconnect = await app.evaluate(async () => {
      const f = (globalThis as unknown as {fixture: Fixture}).fixture;
      const before = f.calls.length;
      f.configurePermission("not-determined", "granted");
      const ask = await f.voice.fixMicrophone();
      f.configurePermission("denied", "denied");
      const settings = await f.voice.fixMicrophone();
      f.configurePermission("granted", "granted");
      return { ask, settings, osCalls: f.calls.length - before };
    });
    assert.deepEqual(duringReconnect, { ask: "unavailable", settings: "unavailable", osCalls: 0 });
    assert.deepEqual(pids(), [first]);
    const imagesBeforeSnapshot = (await read()).captures.length;
    const early = { ...ready, mode: "listening", model: { ...ready.model, directory: "/pre-snapshot-model" } };
    events!.write("data: " + JSON.stringify({ type: "voice_state", state: early }) + "\n\n");
    events!.write("data: " + JSON.stringify({ type: "snapshot", voice: ready }) + "\n\n");
    await until(() => pids().length === 2);
    assert.equal((await read()).captures.length, imagesBeforeSnapshot, "the early update never showed a listening glyph");
    assert.doesNotMatch(readFileSync(join(root, "daemon.log"), "utf8"), /modelRevision="pre-snapshot-model"/);
    const second = pids()[1]!;
    assert.notEqual(second, first);
    assert.equal(exited(second), false);
    events!.write("data: " + JSON.stringify({type: "voice_state", state: voiceStateOff()}) + "\n\n");
    await until(() => exited(second));
  });
  await t.test("switching a ready desktop to sherpa stops FluidAudio capture", async () => {
    const before = pids().length;
    events!.write("data: " + JSON.stringify({ type: "voice_state", state: ready }) + "\n\n");
    await until(() => pids().length === before + 1);
    const pid = pids().at(-1)!;
    events!.write("data: " + JSON.stringify({ type: "voice_state", state: {
      ...ready, model: { ...ready.model, backend: "sherpa-onnx", directory: "/verified-sherpa" },
    } }) + "\n\n");
    await until(() => exited(pid));
    assert.equal(pids().length, before + 1);
  });
  await t.test("stalled streams stop capture and reconnect, even when pings arrive before the first snapshot", async () => {
    const snapshot = JSON.stringify({type: "snapshot", voice: ready});
    const before = pids().length;
    const firstStream = connects;
    events!.write("data: " + snapshot + "\n\n");
    await until(() => pids().length === before + 1);
    const active = pids().at(-1)!;
    try {
      keepalive = "registry";
      await new Promise(resolve => setTimeout(resolve, 4 * heartbeatMs));
      assert.equal(connects, firstStream, "ordinary registry messages keep a quiet voice stream alive");
      keepalive = "silent";
      await until(() => exited(active));
      assert.equal((await read()).mode, "off");
      keepalive = "ping";
      await until(() => connects === firstStream + 1);
      // This stream returns headers and pings, but withholds its snapshot. Only its successor gets one.
      events!.write("data: " + JSON.stringify({type: "voice_state", state: ready}) + "\n\n");
      reconnectSnapshot = snapshot;
      await until(() => connects === firstStream + 2 && pids().length === before + 2);
      assert.equal((await read()).mode, ready.mode);
      const recovered = pids().at(-1)!;
      events!.write("data: " + JSON.stringify({type: "voice_state", state: voiceStateOff()}) + "\n\n");
      await until(() => exited(recovered));
    } finally {
      reconnectSnapshot = undefined;
      keepalive = "ping";
    }
  });
  await t.test("malformed events stop the active child and reconnect for a fresh snapshot without another state change", async () => {
    const snapshot = JSON.stringify({type: "snapshot", voice: ready});
    const send = (data: string) => events!.write("data: " + data + "\n\n");
    const initialChildren = pids().length;
    reconnectSnapshot = snapshot;
    send(snapshot);
    await until(() => pids().length === initialChildren + 1);
    for (const invalid of [
      "{", "null", JSON.stringify({type: "voice_state"}),
      JSON.stringify({type: "voice_state", state: {...ready, mode: "unexpected"}}),
      JSON.stringify({type: "snapshot", voice: {...ready, model: null}}),
      JSON.stringify({type: "snapshot", voice: {...ready, model: {...ready.model, directory: "/bad\0path"}}}),
    ]) {
      const count = pids().length;
      const streamCount = connects;
      const pid = pids().at(-1)!;
      send(invalid);
      await until(async () => (await read()).mode === "off");
      await until(() => exited(pid));
      await until(() => pids().length === count + 1);
      assert.equal(connects, streamCount + 1);
    }
    // A snapshot without voice is valid. It should stay off on the same connection.
    const streamCount = connects;
    send(JSON.stringify({type: "snapshot"}));
    await until(async () => (await read()).mode === "off");
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(connects, streamCount);
  });
  if (process.env.MC_EVIDENCE_DIR) {
    mkdirSync(process.env.MC_EVIDENCE_DIR, {recursive: true});
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
    // Contact sheet of the actual template pixels passed to Electron, on both appearances.
    await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}
      main{display:flex;justify-content:space-around;padding:15px;background:#e9e9ee}
      main.dark{color:white;background:#35363b}.dark img{filter:invert(1)}section{text-align:center}
      span{display:flex;align-items:center;justify-content:center;gap:4px}img{width:16px;height:16px}</style><article>` +
      ["dark","light"].map(theme => '<main class="'+theme+'">' + images.slice(0,4).map((src,i) =>
        '<section><span><img src="'+src+'">2</span>'+["Listening","Muted","On a call","Push-to-talk"][i]+'</section>').join("")+'</main>').join("") + "</article>");
    await page.locator("article").screenshot({path: join(process.env.MC_EVIDENCE_DIR, "tray-templates.png")});
  }
});
