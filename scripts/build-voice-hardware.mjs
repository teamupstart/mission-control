import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publishNativeAddon } from "./native-addon-publish.mjs";

if (process.platform === "darwin") {
  const stage = await mkdtemp(join(tmpdir(), "voice-hardware-"));
  try {
    await mkdir("dist/native", { recursive: true });
    for (const name of ["voice-hotkey", "mic-activity"]) {
      const dir = join(stage, name);
      await cp(resolve("native", name), dir, { recursive: true });
      execFileSync(process.execPath, [resolve("node_modules/node-gyp/bin/node-gyp.js"), "rebuild", "--directory", dir], { stdio: "inherit" });
      await publishNativeAddon(join(dir, "build/Release", name.replace("-", "_") + ".node"), resolve("dist/native", name + ".node"));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
