#!/usr/bin/env node

// launchd entry for the source-owned daemon. Build the one native runtime artifact
// before any source import can advertise Keep Awake support, then load the daemon into
// this process so launchd owns and signals its exact PID.

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeBuild = join(repo, "scripts", "build-keep-awake-native.mjs");
const server = join(repo, "src", "server", "index.ts");

execFileSync(process.execPath, [nativeBuild], { cwd: repo, stdio: "inherit" });
register();
process.argv[1] = server;
await import(pathToFileURL(server).href);
