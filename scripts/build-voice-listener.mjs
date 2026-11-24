import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { publishNativeAddon } from "./native-addon-publish.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("Skipping voice-listener (requires macOS arm64).");
} else {
  const args = ["build", "--package-path", "native/voice-listener", "-c", "release"];
  execFileSync("swift", args, { stdio: "inherit" });
  const dir = execFileSync("swift", [...args, "--show-bin-path"], { encoding: "utf8" }).trim();
  await mkdir("dist/native", { recursive: true });
  await publishNativeAddon(join(dir, "voice-listener"), "dist/native/voice-listener");
}
