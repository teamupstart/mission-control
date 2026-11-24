import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
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
  writeFileSync(join(root, "token"), "fixture");
  const binary = join(root, "voice-listener");
  writeFileSync(binary, `#!/usr/bin/env node
    const fs = require("node:fs");
    const {MISSION_VOICE_MODEL_DIR, MISSION_VOICE_TOKEN_FILE, MISSION_VOICE_DAEMON_URL} = process.env;
    fs.appendFileSync(${JSON.stringify(join(root, "pids"))}, process.pid + "\\n");
    fs.writeFileSync(${JSON.stringify(join(root, "started"))}, JSON.stringify([MISSION_VOICE_MODEL_DIR, MISSION_VOICE_TOKEN_FILE, MISSION_VOICE_DAEMON_URL]));
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(join(root, "stopped"))}, "stopped"); process.exit(0); });
    setInterval(() => {}, 1000);
  `, {mode: 0o755});
  let events: ServerResponse | undefined;
  let connects = 0;
  const requests: boolean[] = [];
  let muteResponse: "ok" | "refused" | "timeout" = "ok";
  const reports: VoiceShellReport[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      events = res;
      connects++;
      res.flushHeaders();
      if (connects === 1) res.write('data: {"type":"snapshot"}\n\n');
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/api/voice/mute") {
      requests.push(JSON.parse(body).muted);
      if (muteResponse === "timeout") return;
      if (muteResponse === "refused") res.statusCode = 503;
    }
    if (req.url === "/voice/shell-report" && req.headers["x-harness-token"] === "fixture") reports.push(JSON.parse(body));
    res.end(JSON.stringify({ counts: { needsYou: 2 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
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
        const voice = startShellVoice(${JSON.stringify(binary)}, setTrayVoice);
        global.fixture = { tray, voice, captures, calls, configurePermission, clickMenu: label => lastMenu.items.find(item => item.label === label).click(), get labels() { return labels; }, get opens() { return opens; } };
        app.on("before-quit", () => { voice.stop(); destroyTray(); });
      });
    ` }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const app = await _electron.launch({ args: [entry, "--user-data-dir=" + root], env: {
    ...process.env, MISSION_HOME: root, MISSION_PORT: String(address.port),
  } });
  t.after(() => app.close());
  const page = await app.firstWindow();
  type Fixture = { tray: Electron.Tray; voice: {state: {mode: string}; fixMicrophone(): Promise<string>}; calls: string[]; configurePermission(status: string, answer: string): void; clickMenu(label: string): void; labels: string[]; captures: string[]; opens: number };
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
  await until(async () => !!events && (await read()).title === " 2");
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
    }
  });
  events!.write("data: " + JSON.stringify({ type: "voice_state", state: { ...voiceStateOff(), mode: "unavailable" } }) + "\n\n");
  await until(async () => (await read()).mode === "unavailable");
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
    ["/verified-model", join(root, "token"), `http://127.0.0.1:${address.port}`]);
  await t.test("a broken stream terminates the active listener before a reconnect snapshot starts its replacement", async () => {
    const pids = () => readFileSync(join(root, "pids"), "utf8").trim().split("\n").map(Number);
    const [first] = pids();
    const exited = (pid: number) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    };
    assert.equal(exited(first!), false);
    events!.destroy();
    await until(() => exited(first!));
    await until(() => connects === 2);
    assert.equal((await read()).mode, "off");
    assert.deepEqual(pids(), [first]);
    events!.write("data: " + JSON.stringify({ type: "snapshot", voice: ready }) + "\n\n");
    await until(() => pids().length === 2);
    const second = pids()[1]!;
    assert.notEqual(second, first);
    assert.equal(exited(second), false);
    events!.write("data: " + JSON.stringify({type: "voice_state", state: voiceStateOff()}) + "\n\n");
    await until(() => exited(second));
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
