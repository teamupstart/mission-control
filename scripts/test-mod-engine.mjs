// Runs the mod's engine-level test (`src/mod/engine-tests/`) with `claude plugin test`, the
// engine's own test runner. It builds the mod into a temporary folder, copies the test beside the
// bundle, and runs it there, so the shipped build never carries a test. Skips with a message when
// the `claude` CLI is not installed. Not part of `npm test`: CI has no `claude`.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.log("[test:mod] claude is not installed; skipping claude plugin test");
  process.exit(0);
}
const out = mkdtempSync(join(tmpdir(), "mission-mod-engine-"));
try {
  const build = spawnSync(process.execPath, ["--import", "tsx", "scripts/build-mod.ts"], {
    env: { ...process.env, MISSION_MOD_OUT_DIR: out },
    stdio: "inherit",
  });
  if (build.status !== 0) {
    // Not process.exit: that would skip the finally below and leak the temporary build.
    process.exitCode = build.status ?? 1;
  } else {
    const pluginDir = join(out, "mission-control");
    const testsDir = resolve("src/mod/engine-tests");
    for (const name of readdirSync(testsDir)) cpSync(join(testsDir, name), join(pluginDir, name));
    const run = spawnSync("claude", ["plugin", "test", pluginDir], { stdio: "inherit" });
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
