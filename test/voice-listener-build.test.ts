import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
