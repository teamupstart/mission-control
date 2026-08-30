#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { arch as processArch, platform as processPlatform } from "node:process";
import { fileURLToPath } from "node:url";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);

export function stateLockBuildTarget(platform, arch) {
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`state ownership lock does not support ${platform} ${arch}`);
  }
  return { platform, arch };
}

export async function buildStateLockNative() {
  const target = stateLockBuildTarget(processPlatform, processArch);
  const sourceDir = resolve("native/state-lock");
  const nodeGyp = resolve("node_modules/node-gyp/bin/node-gyp.js");
  const built = resolve(sourceDir, "build/Release/state_lock.node");
  const outputDir = resolve("dist/native");
  const output = resolve(outputDir, "state-lock.node");

  execFileSync(
    process.execPath,
    [nodeGyp, "rebuild", "--directory", sourceDir, `--arch=${target.arch}`],
    { stdio: "inherit" },
  );
  await mkdir(outputDir, { recursive: true });
  await copyFile(built, output);
  console.log(`[state-lock-native] built ${target.platform} ${target.arch} ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStateLockNative();
}
