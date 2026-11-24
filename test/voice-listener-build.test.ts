import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("ordinary native builds run both app builders without the optional listener", t => {
  const cwd = mkdtempSync(join(tmpdir(), "voice-build-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scripts = join(cwd, "scripts");
  mkdirSync(scripts);
  for (const name of ["state-lock", "keep-awake"]) {
    writeFileSync(join(scripts, `build-${name}-native.mjs`), `console.log("${name}")`);
  }
  const build = spawnSync(process.execPath, [resolve("scripts/build-native.mjs")], { cwd, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  assert.deepEqual(build.stdout.trim().split("\n"), ["state-lock", "keep-awake"]);
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

for (const selection of ["automatic", "explicit"] as const) {
  test(`the development launcher forwards the WAV to the sherpa Node entry on ${selection} selection`, t => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), "voice-launch-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const directory = join(cwd, "dist", "voice-listener");
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, "sherpa.mjs");
    writeFileSync(binary, "console.log(JSON.stringify(process.argv));");
    const args: string[] = [];
    const env = { ...process.env };
    delete env.MISSION_VOICE_BACKEND;
    if (selection === "automatic") {
      // Exercise the Linux default on both Linux and Apple silicon development hosts.
      const platform = join(cwd, "linux.cjs");
      writeFileSync(platform, 'Object.defineProperty(process, "platform", { value: "linux" });');
      args.push("--import", platform);
    } else {
      env.MISSION_VOICE_BACKEND = "fluidaudio";
    }
    args.push(resolve("scripts/run-voice-listener.ts"));
    if (selection === "explicit") args.push("--backend", "sherpa-onnx");
    const recording = join(cwd, "speech fixture.wav");
    const launch = spawnSync(process.execPath, [...args, "--input-file", recording], { cwd, env, encoding: "utf8" });
    assert.equal(launch.status, 0, launch.stderr);
    assert.deepEqual(JSON.parse(launch.stdout), [process.execPath, binary, "--input-file", recording]);
  });
}

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
