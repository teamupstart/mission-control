#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

if (process.platform !== "darwin") {
  throw new Error(`native Keep Awake verification requires macOS, not ${process.platform}`);
}

const binding = createRequire(import.meta.url)(resolve("dist/native/keep-awake.node"));
const reason = `Mission Control native Keep Awake verification ${process.pid}`;
let handle;
try {
  handle = binding.create(reason);
  const active = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
  if (!active.includes(reason) || !active.includes("PreventUserIdleSystemSleep")) {
    throw new Error("pmset did not report the native idle-system-sleep assertion");
  }
  console.log(`[keep-awake-native] assertion observed for pid ${process.pid}`);
} finally {
  if (handle !== undefined) binding.release(handle);
}

const released = execFileSync("/usr/bin/pmset", ["-g", "assertions"], { encoding: "utf8" });
if (released.includes(reason)) {
  throw new Error("native Keep Awake assertion remained after release");
}
console.log("[keep-awake-native] assertion released");
