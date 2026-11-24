import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { publishNativeAddon } from "./native-addon-publish.mjs";
import { buildStateLockNative } from "./build-state-lock-native.mjs";
import { loadVoiceHostClock } from "../src/server/voice/native-clock.ts";

function probeRuntime(dir) {
  // A fresh loader cannot satisfy a missing library from another runtime already in memory.
  execFileSync(process.execPath, ["-e", "require(process.argv[1])", resolve(dir, "sherpa-onnx.node")], { stdio: "pipe" });
}

async function matchesStagedRuntime(staged, existing, files) {
  try {
    for (const name of files) {
      const actual = await readFile(join(existing, name));
      if (!actual.equals(await readFile(join(staged, name)))) return false;
    }
    probeRuntime(existing);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR" || error.status || error.signal) return false;
    throw error;
  }
}

async function publishRuntime(staged, native, version, files) {
  // Never rewrite the libraries a running listener may still have mapped. Concurrent
  // rebuilds try the same names and converge on the first complete, loadable runtime.
  for (let generation = 0; ; generation++) {
    const name = generation ? `${version}-${generation}` : version;
    const directory = join(native, name);
    try {
      await rename(staged, directory);
      return name;
    } catch (error) {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    }
    if (await matchesStagedRuntime(staged, directory, files)) return name;
  }
}

if (["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch)) {
  const require = createRequire(import.meta.url);
  const dist = process.argv[2] ?? "dist";
  const pkg = `sherpa-onnx-${process.platform}-${process.arch}/package.json`;
  const source = dirname(require.resolve(pkg));
  const version = `${process.platform}-${process.arch}-${require(pkg).version}`;
  const native = join(dist, "native", "sherpa-onnx");
  const entry = join(dist, "voice-listener", "sherpa.mjs");
  await mkdir(native, { recursive: true });
  await mkdir(dirname(entry), { recursive: true });
  const stage = await mkdtemp(join(dist, ".sherpa-"));
  try {
    const libs = join(stage, version);
    await mkdir(libs);
    const files = (await readdir(source)).filter(name => /\.node$|\.dylib$|\.so(?:\.|$)/.test(name));
    for (const name of files) await publishNativeAddon(join(source, name), join(libs, name));
    probeRuntime(libs);
    const runtime = await publishRuntime(libs, native, version, files);
    const speaker = join(dist, "voice-speaker", "synth.mjs");
    await mkdir(dirname(speaker), { recursive: true });
    await build({
      entryPoints: ["src/voice-listener/sherpa.ts", "src/voice-speaker/synth.ts"],
      outdir: stage, outbase: "src", outExtension: { ".js": ".mjs" },
      bundle: true, platform: "node", format: "esm", target: "node24",
      banner: { js: 'const require = process.getBuiltinModule("node:module").createRequire(import.meta.url);' },
      plugins: [{ name: "published-addon", setup(build) {
        build.onResolve({ filter: /^\.\/addon(?:\.js)?$/ }, args =>
          args.importer.includes("/sherpa-onnx-node/") ? { path: `../native/sherpa-onnx/${runtime}/sherpa-onnx.node`, external: true } : undefined);
      } }],
    });
    const clockAddon = resolve("dist/native/state-lock.node");
    try { loadVoiceHostClock(clockAddon)(); }
    catch { await buildStateLockNative(); }
    const publishedClock = resolve(dist, "native", "state-lock.node");
    if (publishedClock !== clockAddon) await publishNativeAddon(clockAddon, publishedClock);
    await rename(join(stage, "voice-listener", "sherpa.mjs"), entry);
    await rename(join(stage, "voice-speaker", "synth.mjs"), speaker);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
