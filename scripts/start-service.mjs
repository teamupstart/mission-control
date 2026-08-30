#!/usr/bin/env node

// launchd entry for the source-owned daemon. Build the native runtime artifacts before
// any source import can acquire state ownership or advertise Keep Awake support, then load
// the daemon into this process so launchd owns and signals its exact PID.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeBuild = join(repo, "scripts", "build-native.mjs");
const server = join(repo, "src", "server", "index.ts");
const terminationSignals = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

let buildProcess;
let requestedSignal;

function forwardBuildSignal(signal) {
  requestedSignal ??= signal;
  if (!buildProcess?.pid) return;
  try {
    process.kill(-buildProcess.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

const stopHandlers = new Map(
  terminationSignals.map((signal) => [signal, () => forwardBuildSignal(signal)]),
);
for (const [signal, handler] of stopHandlers) process.once(signal, handler);

let buildResult;
try {
  buildProcess = spawn(process.execPath, [nativeBuild], {
    cwd: repo,
    detached: true,
    stdio: "inherit",
  });
  if (requestedSignal) forwardBuildSignal(requestedSignal);
  buildResult = await new Promise((resolveBuild, rejectBuild) => {
    buildProcess.once("error", rejectBuild);
    buildProcess.once("exit", (code, signal) => resolveBuild({ code, signal }));
  });
} finally {
  for (const [signal, handler] of stopHandlers) process.off(signal, handler);
}

if (requestedSignal) process.exit(0);
if (buildResult.signal || buildResult.code !== 0) {
  throw new Error(
    `Native runtime build failed (${buildResult.signal ?? `exit ${buildResult.code}`})`,
  );
}

register();
process.argv[1] = server;
await import(pathToFileURL(server).href);
