#!/usr/bin/env node

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { arch as processArch, platform as processPlatform } from "node:process";
import { fileURLToPath } from "node:url";

import { publishNativeAddon } from "./native-addon-publish.mjs";

/** The Keychain is macOS's alone: every other platform keeps shaper sign-ins in memory. */
export function keychainBuildTarget(platform, arch) {
  if (platform !== "darwin") return { kind: "skip", platform };
  if (arch === "arm64" || arch === "x64") return { kind: "build", arch };
  throw new Error(`keychain native build does not support Darwin ${arch}`);
}

export async function buildKeychainNative() {
  const target = keychainBuildTarget(processPlatform, processArch);
  if (target.kind === "skip") {
    console.log(`[keychain-native] skipped on ${target.platform}`);
    return;
  }

  const sourceDir = resolve("native/keychain");
  const nodeGyp = resolve("node_modules/node-gyp/bin/node-gyp.js");
  const outputDir = resolve("dist/native");
  const output = resolve(outputDir, "keychain.node");

  await mkdir(outputDir, { recursive: true });
  const workspace = await mkdtemp(join(outputDir, ".keychain-build-"));
  const isolatedSourceDir = join(workspace, "source");
  const sourceBuildDir = resolve(sourceDir, "build");

  try {
    // A test file and `make start` can both ask for this artifact at once. Building in a
    // private directory keeps node-gyp from racing over one shared `build/` tree, and
    // `publishNativeAddon` puts the result in place by rename, never by a copy onto an addon
    // a running daemon may have mapped.
    await cp(sourceDir, isolatedSourceDir, {
      recursive: true,
      filter: (source) => resolve(source) !== sourceBuildDir,
    });
    execFileSync(
      process.execPath,
      [nodeGyp, "rebuild", "--directory", isolatedSourceDir, `--arch=${target.arch}`],
      { stdio: "inherit" },
    );
    await publishNativeAddon(join(isolatedSourceDir, "build/Release/keychain.node"), output);
    console.log(`[keychain-native] built ${target.arch} ${output}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildKeychainNative();
}
