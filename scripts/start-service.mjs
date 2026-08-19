#!/usr/bin/env node

// launchd entry for the source-owned daemon. Build the one native runtime artifact
// before any source import can advertise Keep Awake support, then supervise the daemon
// so launchd termination signals reach its orderly shutdown path.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeBuild = join(repo, "scripts", "build-keep-awake-native.mjs");
const server = join(repo, "src", "server", "index.ts");

const terminationSignals = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
let activeChild;
let requestedSignal;

for (const signal of terminationSignals) {
  process.on(signal, () => {
    requestedSignal ??= signal;
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill(signal);
    }
  });
}

function runNode(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: process.env,
      stdio: "inherit",
    });
    activeChild = child;

    const finish = (result) => {
      if (activeChild === child) activeChild = undefined;
      resolveRun(result);
    };

    child.once("error", rejectRun);
    child.once("exit", (code, signal) => finish({ code, signal }));

    // A signal can arrive in the narrow gap between sequential children.
    if (requestedSignal) child.kill(requestedSignal);
  });
}

function applyExit(result) {
  process.exitCode = result.code ?? 1;
}

const build = await runNode([nativeBuild]);
if (build.code !== 0 || build.signal !== null) {
  applyExit(build);
} else if (requestedSignal) {
  process.exitCode = 0;
} else {
  applyExit(await runNode(["--import", "tsx", server]));
}
