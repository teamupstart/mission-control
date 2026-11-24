#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

for (const script of ["build-state-lock-native.mjs", "build-keep-awake-native.mjs"]) {
  execFileSync(process.execPath, [resolve("scripts", script)], { stdio: "inherit" });
}
