import { build } from "esbuild";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { publishNativeAddon } from "./native-addon-publish.mjs";

if (["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch)) {
  const require = createRequire(import.meta.url);
  const dist = process.argv[2] ?? "dist";
  const pkg = `sherpa-onnx-${process.platform}-${process.arch}/package.json`;
  const source = dirname(require.resolve(pkg));
  const runtime = `${process.platform}-${process.arch}-${require(pkg).version}`;
  const native = join(dist, "native", "sherpa-onnx");
  const entry = join(dist, "voice-listener", "sherpa.mjs");
  await mkdir(native, { recursive: true });
  await mkdir(dirname(entry), { recursive: true });
  const stage = await mkdtemp(join(dist, ".sherpa-"));
  try {
    const libs = join(stage, runtime);
    await mkdir(libs);
    for (const name of await readdir(source)) {
      if (/\.node$|\.dylib$|\.so(?:\.|$)/.test(name)) await publishNativeAddon(join(source, name), join(libs, name));
    }
    require(resolve(libs, "sherpa-onnx.node"));
    const bundle = join(stage, "sherpa.mjs");
    await build({
      entryPoints: ["src/voice-listener/sherpa.ts"], outfile: bundle,
      bundle: true, platform: "node", format: "esm", target: "node24",
      banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
      plugins: [{ name: "published-addon", setup(build) {
        build.onResolve({ filter: /^\.\/addon(?:\.js)?$/ }, args =>
          args.importer.includes("/sherpa-onnx-node/") ? { path: `../native/sherpa-onnx/${runtime}/sherpa-onnx.node`, external: true } : undefined);
      } }],
    });
    // A build of this exact package version may already have published the complete directory.
    try { await rename(libs, join(native, runtime)); }
    catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error; }
    await rename(bundle, entry);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
