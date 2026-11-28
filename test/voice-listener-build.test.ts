import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, hash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { playerScratchDirectory } from "../src/server/voice/recovery-files.ts";
import { supervisorIssuer, VOICE_SUPERVISOR_PROOF_HEADER } from "../src/server/voice/supervisor-auth.ts";
import { VOICE_MODELS, VOICE_TEST_MODEL } from "../src/shared/voice-models.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { tempDir } from "./temp-root.mjs";

test("ordinary native builds run the app addon builders without the optional listener", t => {
  const cwd = tempDir("voice-build-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scripts = join(cwd, "scripts");
  mkdirSync(scripts);
  const builders = ["build-state-lock-native.mjs", "build-keep-awake-native.mjs", "build-keychain-native.mjs", "build-voice-hardware.mjs"];
  for (const name of builders) {
    writeFileSync(join(scripts, name), `console.log("${name}")`);
  }
  const build = spawnSync(process.execPath, [resolve("scripts/build-native.mjs")], { cwd, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  assert.deepEqual(build.stdout.trim().split("\n"), builders);
});

test("the launcher names the explicit build command when the listener is missing", t => {
  const cwd = tempDir("voice-launch-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const launch = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("scripts/run-voice-listener.ts")],
    { cwd, encoding: "utf8" });
  assert.equal(launch.status, 1);
  assert.match(launch.stderr, /npm run build:voice-listener/);
});

test("a clean desktop build includes the voice helper before packaging dist", async () => {
  const { scripts } = (await import("../package.json", { with: { type: "json" } })).default;
  assert.ok(scripts.build.split(" && ").includes("npm run build:voice-listener"));
});

test("Swift artifact cache publishes verified downloads, reuses them, and rejects corrupt replacements", {
  skip: process.platform === "win32",
}, t => {
  const cwd = tempDir("voice-swift-cache-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const fixture = join(cwd, "archive.zip");
  const archive = "fixture binary archive";
  const url = "https://example.test/v0.1/fixture.zip";
  const cache = join(cwd, "cache");
  const key = "https___example_test_v0_1_fixture_zip";
  const artifacts = join(cache, "artifacts");
  const cached = join(artifacts, key);
  writeFileSync(fixture, archive);
  writeFileSync(join(cwd, "curl"), ["#!/bin/sh", 'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output" ]; then exec cp archive.zip "$2"; fi',
    "  shift", "done", "exit 1", ""].join("\n"), { mode: 0o700 });

  const seed = () => spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const { cacheSwiftBinaryArtifact } = await import(process.argv[1]);
    await cacheSwiftBinaryArtifact(...process.argv.slice(2));
  `, resolve("scripts/cache-swift-binary-artifact.mjs"), cache, url, hash("sha256", archive)], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${cwd}${delimiter}${process.env.PATH}` },
  });
  const first = seed();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(cached, "utf8"), archive);

  writeFileSync(fixture, "invalid download");
  const warm = seed();
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(readFileSync(cached, "utf8"), archive);

  writeFileSync(cached, "corrupt cache");
  const failed = seed();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /SHA-256 mismatch/);
  assert.equal(readFileSync(cached, "utf8"), "corrupt cache");
  assert.deepEqual(readdirSync(artifacts), [key]);

  writeFileSync(fixture, archive);
  const repaired = seed();
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(readFileSync(cached, "utf8"), archive);
});

test("the staged sherpa addon loads in the macOS app layout and refuses file playback", {
  skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch),
}, t => {
  const cwd = tempDir("sherpa-package-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dist = join(cwd, "Mission Control.app", "Contents", "Resources", "app", "dist");
  const build = spawnSync(process.execPath, ["scripts/build-voice-sherpa.mjs", dist], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const entry = join(dist, "voice-listener", "sherpa.mjs");
  const play = spawnSync(process.execPath, [entry, "--input-file", "fixture.wav"], { encoding: "utf8" });
  assert.equal(play.status, 1);
  assert.match(play.stderr, /File input is available only from a development checkout/);
});

test("a failed rebuild preserves the published sherpa entry and complete versioned runtime", {
  skip: !["linux", "darwin"].includes(process.platform) || !["arm64", "x64"].includes(process.arch),
}, t => {
  const cwd = tempDir("sherpa-upgrade-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dist = join(cwd, "dist");
  const args = [resolve("scripts/build-voice-sherpa.mjs"), dist];
  const built = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const platform = `${process.platform}-${process.arch}`;
  const { version } = createRequire(import.meta.url)(`sherpa-onnx-${platform}/package.json`);
  const runtime = join(dist, "native", "sherpa-onnx", `${platform}-${version}`);
  const entry = join(dist, "voice-listener", "sherpa.mjs");
  const files = [entry, join(dist, "voice-speaker", "synth.mjs"), ...readdirSync(runtime).map(name => join(runtime, name))];
  assert.ok(files.includes(join(runtime, "sherpa-onnx.node")));
  const inodes = files.map(file => statSync(file).ino);
  // This checkout has no JS entry source. Bundling fails after the native libraries are staged.
  const failed = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Could not resolve/);
  assert.deepEqual(files.map(file => statSync(file).ino), inodes);
  assert.deepEqual(readdirSync(dist).sort(), ["native", "voice-listener", "voice-speaker"]);
});

test("rebuilds publish and reuse a complete replacement when a sherpa shared library is missing", {
  skip: !["linux", "darwin"].includes(process.platform) || !["arm64", "x64"].includes(process.arch),
}, async t => {
  const dist = tempDir("sherpa-repair-");
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  const build = () => promisify(execFile)(process.execPath, [resolve("scripts/build-voice-sherpa.mjs"), dist]);
  await build();
  const native = join(dist, "native", "sherpa-onnx");
  const [original] = readdirSync(native);
  assert.ok(original);
  const libraries = readdirSync(join(native, original)).sort();
  const missing = libraries.find(name => name.startsWith("libsherpa-onnx-c-api."));
  assert.ok(missing);
  rmSync(join(native, original, missing));

  await Promise.all([build(), build()]);
  const replacements = readdirSync(native).filter(name => name !== original);
  assert.equal(replacements.length, 1);
  assert.deepEqual(readdirSync(join(native, replacements[0]!)).sort(), libraries);
  const entry = join(dist, "voice-listener", "sherpa.mjs");
  const play = spawnSync(process.execPath, [entry], { encoding: "utf8" });
  assert.equal(play.status, 1);
  assert.match(play.stderr, /Sherpa currently requires --input-file/); // The bundled entry loaded the addon.
});

for (const selection of ["automatic", "explicit auto", "explicit", "credential-configured"] as const) {
  test(`the development launcher forwards the verified model and WAV to sherpa on ${selection} selection`, async t => {
    const cwd = realpathSync(tempDir("voice-launch-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const directory = join(cwd, "dist", "voice-listener");
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, "sherpa.mjs");
    writeFileSync(binary, `console.log(JSON.stringify({
      args: process.argv, directory: process.env.MISSION_VOICE_MODEL_DIR, manifest: JSON.parse(process.env.MISSION_VOICE_LISTENER_MANIFEST)
    }));`);
    const verified = join(cwd, "setup", VOICE_TEST_MODEL.revision);
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.end(JSON.stringify({ backend: "sherpa-onnx", directory: verified, manifest: VOICE_TEST_MODEL }));
    });
    t.after(() => server.close());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const args = [resolve("scripts/run-voice-listener.ts")];
    const env: NodeJS.ProcessEnv = { ...process.env, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port };
    delete env.MISSION_VOICE_BACKEND;
    if (selection === "credential-configured") env.MISSION_VOICE_DEV_CREDENTIAL_FD = "3";
    if (selection === "explicit") {
      env.MISSION_VOICE_BACKEND = "fluidaudio";
      args.push("--backend", "sherpa-onnx");
    } else if (selection === "explicit auto") {
      env.MISSION_VOICE_BACKEND = "fluidaudio";
      args.push("--backend", "auto");
    }
    const recording = join(cwd, "speech fixture.wav");
    const { stdout } = await promisify(execFile)(process.execPath, [...args, "--input-file", recording], { cwd, env });
    assert.deepEqual(requests, [selection === "explicit" ? "/api/voice/model?backend=sherpa-onnx" : "/api/voice/model"]);
    assert.deepEqual(JSON.parse(stdout), { args: [process.execPath, binary, "--input-file", recording], directory: verified, manifest: VOICE_TEST_MODEL });
  });
}

test("an empty --input-file is refused before daemon lookup or FluidAudio capture", async t => {
  const cwd = tempDir("voice-empty-path-");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const native = join(cwd, "dist", "native");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "voice-listener"), "#!/bin/sh\ntouch started\n", { mode: 0o755 });
  let lookups = 0;
  const server = createServer((_request, response) => {
    lookups++;
    response.end(JSON.stringify({ backend: "fluidaudio", directory: cwd, manifest: VOICE_TEST_MODEL }));
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, MISSION_VOICE_BACKEND: "fluidaudio", MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port };
  await assert.rejects(promisify(execFile)(process.execPath, [resolve("scripts/run-voice-listener.ts"), "--input-file", ""], { cwd, env }),
    /--input-file requires a non-empty recording path/);
  assert.equal(lookups, 0);
  assert.equal(existsSync(join(cwd, "started")), false);
});

for (const credential of [false, true]) {
  test(`daemon-selected FluidAudio refuses a WAV before launching a microphone listener ${credential ? "with" : "without"} a dev credential`, async t => {
    const cwd = tempDir("voice-file-mode-");
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const native = join(cwd, "dist", "native");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "voice-listener"), "#!/bin/sh\ntouch microphone-started\n", { mode: 0o755 });
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.end(JSON.stringify({ backend: "fluidaudio", directory: cwd, manifest: VOICE_TEST_MODEL }));
    });
    t.after(() => server.close());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env: NodeJS.ProcessEnv = { ...process.env, MISSION_HOME: cwd, MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port };
    delete env.MISSION_VOICE_DEV_CREDENTIAL_FD;
    if (credential) env.MISSION_VOICE_DEV_CREDENTIAL_FD = "3";
    const child = spawn(process.execPath, [resolve("scripts/run-voice-listener.ts"), "--backend", "auto", "--input-file",
      resolve("test/fixtures/voice/steve-check-the-build.wav")], {
      cwd, env, stdio: ["ignore", "ignore", "pipe", "pipe"], timeout: 5000,
    });
    const closed = once(child, "close");
    const keyPipe = child.stdio[3];
    assert.ok(keyPipe instanceof Writable);
    // Refusing file input leaves the supplied key unread. Linux can reset the socket on child exit.
    keyPipe.on("error", (error: NodeJS.ErrnoException) => {
      assert.ok(credential && (error.code === "ECONNRESET" || error.code === "EPIPE"), error.message);
    });
    keyPipe.end(credential ? generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }) : undefined);
    let diagnostic = "";
    assert.ok(child.stderr);
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    assert.deepEqual(await closed, [1, null]);
    assert.match(diagnostic, /^Error: --input-file requires sherpa-onnx$/m);
    assert.deepEqual(requests, ["/api/voice/model"]);
    assert.equal(existsSync(join(cwd, "microphone-started")), false);
    assert.equal(existsSync(join(cwd, "voice", "supervised", "dev.json")), false);
  });
}

test("credentialed FluidAudio live input reports OS-confirmed exits on state read failure and launcher shutdown, and restarts on recovery", {
  skip: process.platform !== "darwin",
}, async t => {
  ensureNativeStateLockAddon();
  const home = realpathSync(tempDir("voice-live-launch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const native = join(home, "dist", "native");
  const manifest = VOICE_MODELS.fluidaudio;
  assert.ok(manifest);
  const directory = join(home, "voice", "models", manifest.revision);
  mkdirSync(native, { recursive: true });
  mkdirSync(directory, { recursive: true });
  // Stay alive after TERM so that reporting on the signal would fail the OS check.
  writeFileSync(join(native, "voice-listener"), [
    "#!/bin/sh", "trap '' TERM",
    'printf "%s\\n" "$$" "$#" "$MISSION_VOICE_MODEL_DIR" > "$TMPDIR/ready"',
    "IFS= read -r line",
  ].join("\n"), { mode: 0o755 });
  const token = join(home, "token");
  writeFileSync(token, "fixture", { mode: 0o600 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const verifier = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const pids = new Map<string, number>();
  const reports: { instance: string; state: string; authenticated: boolean; gone: boolean }[] = [];
  let online = true;
  let failedReads = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/api/voice/model") {
      res.end(JSON.stringify({ backend: "fluidaudio", directory, manifest }));
    } else if (req.url === "/api/voice/mute") {
      if (online) res.end(JSON.stringify({ state: { mode: "listening", model: { status: "ready", backend: "fluidaudio", directory } } }));
      else { failedReads++; res.writeHead(503).end(); }
    } else if (req.method === "POST" && req.url === "/voice/listener/supervised") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { instance, state } = JSON.parse(body);
      const proof = req.headers[VOICE_SUPERVISOR_PROOF_HEADER];
      const issuer = typeof proof === "string" && supervisorIssuer(instance, state, proof);
      const authenticated = !!issuer && issuer.name === "dev" && issuer.key === verifier && req.headers["x-harness-token"] === "fixture";
      const pid = pids.get(instance);
      let gone = false;
      if (state === "exited" && pid !== undefined) {
        try { process.kill(pid, 0); }
        catch (error) { gone = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      reports.push({ instance, state, authenticated, gone });
      res.writeHead(authenticated ? 200 : 403).end();
    } else res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const launcher = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("scripts/run-voice-listener.ts"), "--backend", "auto"], {
    cwd: home,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json"), MISSION_HOME: home, MISSION_VOICE_TOKEN_FILE: token,
      MISSION_VOICE_DAEMON_URL: "http://127.0.0.1:" + address.port, MISSION_VOICE_DEV_CREDENTIAL_FD: "3" },
    stdio: ["ignore", "ignore", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL",
  });
  const closed = once(launcher, "close");
  let diagnostic = "";
  launcher.stderr!.on("data", chunk => { diagnostic += chunk; });
  const starts = () => reports.filter(report => report.state === "started");
  const liveInstance = (index: number) => t.waitFor(() => {
    const start = starts()[index];
    assert.ok(start, diagnostic || "waiting for signed start");
    const ready = readFileSync(join(playerScratchDirectory(home, start.instance), "ready"), "utf8").trim().split("\n");
    const record = JSON.parse(readFileSync(join(home, "voice", "supervised", "dev.json"), "utf8"));
    assert.ok(record.instance === start.instance);
    assert.deepEqual(ready, [String(record.pid), "0", directory]);
    process.kill(record.pid, 0);
    pids.set(start.instance, record.pid);
    return start.instance;
  }, { timeout: 8000 });

  try {
    const keyPipe = launcher.stdio[3];
    assert.ok(keyPipe instanceof Writable);
    keyPipe.end(privateKey.export({ type: "pkcs8", format: "der" }));
    const first = await liveInstance(0);
    online = false;
    await t.waitFor(() => {
      assert.ok(failedReads >= 2);
      assert.ok(reports.some(report => report.instance === first && report.state === "exited" && report.gone));
    }, { timeout: 8000 });
    assert.equal(starts().length, 1);
    online = true;
    const second = await liveInstance(1);
    assert.ok(first !== second);
    launcher.kill("SIGTERM");
    assert.deepEqual(await closed, [0, null], diagnostic);
    assert.equal(starts().length, 2);
    assert.ok(reports.some(report => report.instance === second && report.state === "exited"));
    assert.ok(reports.every(report => report.authenticated && (report.state === "started" || report.gone)));
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
    await closed;
  }
});

for (const [description, args, error] of [
  ["file input with FluidAudio", ["--backend", "fluidaudio", "--input-file", resolve("test/fixtures/voice/steve-check-the-build.wav")],
    /^Error: --input-file requires sherpa-onnx$/m],
  ["an unknown backend", ["--backend", "unknown"], /^Error: Unknown voice backend: unknown$/m],
] as const) {
  test(`the development launcher rejects ${description}`, t => {
    const cwd = tempDir("voice-launch-");
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const native = join(cwd, "dist", "native");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "voice-listener"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const launch = spawnSync(process.execPath, [resolve("scripts/run-voice-listener.ts"), ...args], { cwd, encoding: "utf8" });
    assert.equal(launch.status, 1, launch.stderr);
    assert.match(launch.stderr, error);
  });
}
