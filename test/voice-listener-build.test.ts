import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { VOICE_TEST_MODEL } from "../src/shared/voice-models.ts";

test("ordinary native builds run the app addon builders without the optional listener", t => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-build-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "voice-launch-"));
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

test("the staged sherpa addon loads in the macOS app layout and refuses file playback", {
  skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch),
}, t => {
  const cwd = mkdtempSync(join(tmpdir(), "sherpa-package-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "sherpa-upgrade-"));
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
  const dist = mkdtempSync(join(tmpdir(), "sherpa-repair-"));
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

for (const selection of ["automatic", "explicit auto", "explicit"] as const) {
  test(`the development launcher forwards the verified model and WAV to sherpa on ${selection} selection`, async t => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), "voice-launch-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "voice-empty-path-"));
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

for (const [description, args, error] of [
  ["file input with FluidAudio", ["--backend", "fluidaudio", "--input-file", resolve("test/fixtures/voice/steve-check-the-build.wav")],
    /^Error: --input-file requires sherpa-onnx$/m],
  ["an unknown backend", ["--backend", "unknown"], /^Error: Unknown voice backend: unknown$/m],
] as const) {
  test(`the development launcher rejects ${description}`, t => {
    const cwd = mkdtempSync(join(tmpdir(), "voice-launch-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const native = join(cwd, "dist", "native");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "voice-listener"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const launch = spawnSync(process.execPath, [resolve("scripts/run-voice-listener.ts"), ...args], { cwd, encoding: "utf8" });
    assert.equal(launch.status, 1, launch.stderr);
    assert.match(launch.stderr, error);
  });
}
