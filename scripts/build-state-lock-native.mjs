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

/**
 * Remove download provenance inherited by a freshly copied local addon on macOS.
 *
 * The linker gives the bundle a valid ad-hoc signature, but a worktree can itself carry
 * `com.apple.provenance`. `copyFile` preserves that attribute on this host, and macOS then kills
 * Node while it loads the state-lock addon. A missing attribute is xattr status 1 and is already
 * the desired state. Other failures stay fatal because shipping an addon the daemon cannot load
 * would make both ordinary startup and database recovery fail without a JavaScript diagnostic.
 */
export function clearDarwinProvenance(
  path,
  platform = processPlatform,
  execute = execFileSync,
) {
  if (platform !== "darwin") return false;
  try {
    execute("/usr/bin/xattr", ["-d", "com.apple.provenance", path], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (error?.status === 1 && stderr.includes("No such xattr: com.apple.provenance")) {
      return false;
    }
    throw error;
  }
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
  clearDarwinProvenance(output);
  console.log(`[state-lock-native] built ${target.platform} ${target.arch} ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStateLockNative();
}
