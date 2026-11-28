#!/usr/bin/env node
// `node electron-gui-launch.mjs <electron> [args...]`: run Electron with its startup serialized
// through the host's startup slot (see electron-startup-slot.mjs), for the tests that launch
// Electron with `execFileSync` and so cannot take the slot around an asynchronous startup
// themselves. Output, exit status and signals pass through unchanged, and a termination
// signal sent to this launcher (an `execFileSync` timeout) is forwarded to Electron.

import { spawn } from "node:child_process";
import { acquireElectronStartupSlot, electronStarted } from "./electron-startup-slot.mjs";

const [electron, ...args] = process.argv.slice(2);
if (!electron) {
  console.error("usage: electron-gui-launch.mjs <electron> [args...]");
  process.exit(2);
}

const release = await acquireElectronStartupSlot();
const child = spawn(electron, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.once("error", (error) => {
  release();
  console.error(error);
  process.exit(1);
});
electronStarted(child).finally(release);
child.once("exit", (code, signal) => {
  release();
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
