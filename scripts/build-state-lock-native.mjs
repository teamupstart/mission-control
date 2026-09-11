#!/usr/bin/env node

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { arch as processArch, platform as processPlatform } from "node:process";
import { fileURLToPath } from "node:url";

import { publishNativeAddon } from "./native-addon-publish.mjs";

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
  const outputDir = resolve("dist/native");
  const output = resolve(outputDir, "state-lock.node");

  await mkdir(outputDir, { recursive: true });
  const workspace = await mkdtemp(join(outputDir, ".state-lock-build-"));
  const isolatedSourceDir = join(workspace, "source");
  const sourceBuildDir = resolve(sourceDir, "build");

  try {
    // Test files can request this artifact from separate Node workers at the same time.
    // Build in a private directory so node-gyp never races over one shared `build/` tree.
    // `publishNativeAddon` then puts the finished addon in place, and owns the reason that
    // step is a rename rather than a copy.
    await cp(sourceDir, isolatedSourceDir, {
      recursive: true,
      filter: (source) => resolve(source) !== sourceBuildDir,
    });
    execFileSync(
      process.execPath,
      [nodeGyp, "rebuild", "--directory", isolatedSourceDir, `--arch=${target.arch}`],
      { stdio: "inherit" },
    );
    await publishNativeAddon(join(isolatedSourceDir, "build/Release/state_lock.node"), output);
    console.log(`[state-lock-native] built ${target.platform} ${target.arch} ${output}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStateLockNative();
}
