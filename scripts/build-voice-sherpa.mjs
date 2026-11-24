import { build } from "esbuild";
import { mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { publishNativeAddon } from "./native-addon-publish.mjs";

if (["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch)) {
  const require = createRequire(import.meta.url);
  const dist = process.argv[2] ?? "dist";
  const native = join(dist, "native/sherpa-onnx");
  const source = dirname(require.resolve(`sherpa-onnx-${process.platform}-${process.arch}/package.json`));
  await mkdir(native, { recursive: true });
  for (const name of await readdir(source)) {
    if (/\.node$|\.dylib$|\.so(?:\.|$)/.test(name)) await publishNativeAddon(join(source, name), join(native, name));
  }
  // Inline the JS wrappers, replacing the npm platform probes with the published sibling addon.
  await build({
    entryPoints: ["src/voice-listener/sherpa.ts"], outfile: join(dist, "voice-listener/sherpa.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24",
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: "published-addon", setup(build) {
      build.onResolve({ filter: /^\.\/addon(?:\.js)?$/ }, args =>
        args.importer.includes("/sherpa-onnx-node/") ? { path: "../native/sherpa-onnx/sherpa-onnx.node", external: true } : undefined);
    } }],
  });
}
