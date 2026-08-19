#!/usr/bin/env node

// launchd entry for the source-owned daemon. Build the one native runtime artifact
// before any source import can advertise Keep Awake support, then replace this process
// with Node's tsx import hook so launchd still owns and signals the daemon's exact PID.

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeBuild = join(repo, "scripts", "build-keep-awake-native.mjs");
const server = join(repo, "src", "server", "index.ts");

execFileSync(process.execPath, [nativeBuild], { cwd: repo, stdio: "inherit" });
process.execve(process.execPath, [process.execPath, "--import", "tsx", server], process.env);
