import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import { resolveVoiceBackend } from "../src/shared/voice-models.ts";
import { publishNativeAddon } from "./native-addon-publish.mjs";

if (resolveVoiceBackend("auto", process.platform, process.arch, release()) !== "fluidaudio") {
  console.log("Skipping voice-listener (requires macOS 14 or newer on Apple silicon).");
} else {
  const args = ["build", "--package-path", "native/voice-listener", "-c", "release"];
  execFileSync("swift", args, { stdio: "inherit" });
  const dir = execFileSync("swift", [...args, "--show-bin-path"], { encoding: "utf8" }).trim();
  await mkdir("dist/native", { recursive: true });
  await publishNativeAddon(join(dir, "voice-listener"), "dist/native/voice-listener");
}
