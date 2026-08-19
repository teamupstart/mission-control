#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import { arch, platform } from "node:process";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

if (platform !== "darwin") {
  console.log(`[keep-awake-native] skipped on ${platform}`);
  process.exit(0);
}

if (arch !== "arm64") {
  throw new Error(
    `keep-awake native build supports the packaged macOS arm64 target, not ${arch}`,
  );
}

const sourceDir = resolve("native/keep-awake");
const nodeGyp = resolve("node_modules/node-gyp/bin/node-gyp.js");
const built = resolve(sourceDir, "build/Release/keep_awake.node");
const outputDir = resolve("dist/native");
const output = resolve(outputDir, "keep-awake.node");

execFileSync(process.execPath, [nodeGyp, "rebuild", "--directory", sourceDir, "--arch=arm64"], {
  stdio: "inherit",
});
await mkdir(outputDir, { recursive: true });
await copyFile(built, output);
console.log(`[keep-awake-native] built ${output}`);
