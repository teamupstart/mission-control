#!/usr/bin/env node

import { copyFile, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
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

/**
 * Remove download provenance inherited by a freshly copied local addon on macOS.
 *
 * The linker gives the bundle a valid ad-hoc signature, but a worktree can itself carry
 * `com.apple.provenance`. `copyFile` preserves that attribute on this host, and macOS then kills
 * Node while it loads the state-lock addon. Listing first distinguishes an already-clean file
 * without interpreting platform-specific error text. Every listing or deletion failure stays
 * fatal because shipping an addon the daemon cannot load would make both ordinary startup and
 * database recovery fail without a JavaScript diagnostic.
 */
export function clearDarwinProvenance(
  path,
  platform = processPlatform,
  execute = execFileSync,
) {
  if (platform !== "darwin") return false;
  const attributes = String(
    execute("/usr/bin/xattr", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (!attributes.split(/\r?\n/).includes("com.apple.provenance")) return false;
  execute("/usr/bin/xattr", ["-d", "com.apple.provenance", path], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  return true;
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
  const stagedOutput = join(workspace, "state-lock.node");

  try {
    // Test files can request this artifact from separate Node workers at the same time.
    // Build in a private directory so node-gyp never races over one shared `build/` tree,
    // then rename a complete addon into place atomically for concurrent daemon readers.
    await cp(sourceDir, isolatedSourceDir, {
      recursive: true,
      filter: (source) => resolve(source) !== sourceBuildDir,
    });
    execFileSync(
      process.execPath,
      [nodeGyp, "rebuild", "--directory", isolatedSourceDir, `--arch=${target.arch}`],
      { stdio: "inherit" },
    );
    await copyFile(join(isolatedSourceDir, "build/Release/state_lock.node"), stagedOutput);
    clearDarwinProvenance(stagedOutput);
    await rename(stagedOutput, output);
    console.log(`[state-lock-native] built ${target.platform} ${target.arch} ${output}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStateLockNative();
}
