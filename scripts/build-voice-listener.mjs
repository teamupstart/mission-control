import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { release } from "node:os";
import { resolveVoiceBackend } from "../src/shared/voice-models.ts";
import { cacheSwiftBinaryArtifact } from "./cache-swift-binary-artifact.mjs";
import { publishNativeAddon } from "./native-addon-publish.mjs";

if (resolveVoiceBackend("auto", process.platform, process.arch, release()) !== "fluidaudio") {
  console.log("Skipping voice-listener (requires macOS 14 or newer on Apple silicon).");
} else {
  const packagePath = "native/voice-listener";
  const cachePath = resolve(packagePath, ".build", "swift-cache");
  // SwiftPM fetches binary targets even with the NeMo trait disabled. Its URLSession
  // download can stall on macOS. Seed the workspace cache with the pinned archive.
  await cacheSwiftBinaryArtifact(cachePath,
    "https://github.com/FluidInference/text-processing-rs/releases/download/v0.3.4/NemoTextProcessing.xcframework.zip",
    "fdfebc5ce0938624435aa217d5425394f0b946cc0dd47bd01b66917e671be851");
  const args = ["build", "--package-path", packagePath, "--cache-path", cachePath, "-c", "release"];
  execFileSync("swift", args, { stdio: "inherit" });
  const dir = execFileSync("swift", [...args, "--show-bin-path"], { encoding: "utf8" }).trim();
  await mkdir("dist/native", { recursive: true });
  await publishNativeAddon(join(dir, "voice-listener"), "dist/native/voice-listener");
}
