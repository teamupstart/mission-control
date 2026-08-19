#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import { arch as processArch, platform as processPlatform } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export function nativeBuildTarget(platform, arch) {
  if (platform !== "darwin") return { kind: "skip", platform };
  if (arch === "arm64" || arch === "x64") return { kind: "build", arch };
  throw new Error(`keep-awake native build does not support Darwin ${arch}`);
}

async function main() {
  const target = nativeBuildTarget(processPlatform, processArch);
  if (target.kind === "skip") {
    console.log(`[keep-awake-native] skipped on ${target.platform}`);
    return;
  }

  const sourceDir = resolve("native/keep-awake");
  const nodeGyp = resolve("node_modules/node-gyp/bin/node-gyp.js");
  const built = resolve(sourceDir, "build/Release/keep_awake.node");
  const outputDir = resolve("dist/native");
  const output = resolve(outputDir, "keep-awake.node");

  execFileSync(
    process.execPath,
    [nodeGyp, "rebuild", "--directory", sourceDir, `--arch=${target.arch}`],
    { stdio: "inherit" },
  );
  await mkdir(outputDir, { recursive: true });
  await copyFile(built, output);
  console.log(`[keep-awake-native] built ${target.arch} ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
