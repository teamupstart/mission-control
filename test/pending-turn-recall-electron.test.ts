import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

const require = createRequire(import.meta.url);
const ELECTRON_TIMEOUT_MS = 120_000;

test("collapsed-card recall preserves multiline queued text exactly", () => {
  assertElectronGuiLaunchAllowed();
  const fixtureDir = mkdtempSync(join(tmpdir(), "mission-pending-turn-recall-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-pending-turn-recall-profile-"));
  try {
    const bundlePath = join(fixtureDir, "recall.js");
    const htmlPath = join(fixtureDir, "index.html");
    execFileSync(require.resolve("esbuild/bin/esbuild"), [
      fileURLToPath(new URL("fixtures/pending-turn-recall.tsx", import.meta.url)),
      "--bundle",
      "--platform=browser",
      "--format=iife",
      `--outfile=${bundlePath}`,
    ]);
    writeFileSync(htmlPath, '<!doctype html><div id="root"></div><script src="./recall.js"></script>');

    const electron = require("electron") as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = execFileSync(
      electron,
      [
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `--user-data-dir=${userData}`,
        fileURLToPath(new URL("fixtures/pending-turn-recall-browser.cjs", import.meta.url)),
        htmlPath,
      ],
      { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS },
    );
    const result = JSON.parse(output.trim()) as {
      error: string | null;
      tagName: string | null;
      value: string | null;
    };
    assert.equal(result.error, null);
    assert.equal(result.tagName, "TEXTAREA");
    assert.equal(result.value, "race.\nDo not steer");
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});
