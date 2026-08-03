import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

const require = createRequire(import.meta.url);
const ELECTRON_TIMEOUT_MS = 240_000;

test("collapsed-card recall preserves multiline queued text exactly", () => {
  assertElectronGuiLaunchAllowed();
  const fixtureDir = mkdtempSync(join(tmpdir(), "mission-pending-turn-recall-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-pending-turn-recall-profile-"));
  const evidenceDir = process.env.MISSION_PENDING_TURN_EVIDENCE_DIR
    ? resolve(process.env.MISSION_PENDING_TURN_EVIDENCE_DIR)
    : fixtureDir;
  mkdirSync(evidenceDir, { recursive: true });
  try {
    const bundlePath = join(fixtureDir, "recall.js");
    const htmlPath = join(fixtureDir, "index.html");
    const queuedCapturePath = join(evidenceDir, "queued-message.png");
    const recalledCapturePath = join(evidenceDir, "recalled-into-composer.png");
    execFileSync(require.resolve("esbuild/bin/esbuild"), [
      fileURLToPath(new URL("fixtures/pending-turn-recall.tsx", import.meta.url)),
      "--bundle",
      "--platform=browser",
      "--format=iife",
      `--outfile=${bundlePath}`,
    ]);
    writeFileSync(
      htmlPath,
      `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="./recall.css">
    <style>
      .pending-turn-evidence { width: 760px; margin: 0 auto; padding: 42px 0; }
      .pending-turn-evidence-head { margin: 0 0 18px; }
      .pending-turn-evidence-kicker { color: var(--working); font: 600 11px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; }
      .pending-turn-evidence h1 { margin: 9px 0 7px; font: 650 26px/1.15 var(--sans); }
      .pending-turn-evidence p { margin: 0; color: var(--muted); font: 13px/1.5 var(--sans); }
      .pending-turn-evidence-card { overflow: visible; }
      .pending-turn-evidence-session { display: flex; align-items: baseline; gap: 9px; color: var(--muted); font: 12px/1.3 var(--sans); }
      .pending-turn-evidence-session strong { color: var(--fg); font-size: 15px; }
      .pending-turn-evidence-state { margin-left: auto; color: var(--idle); text-transform: uppercase; font-size: 10px; letter-spacing: .08em; }
      .pending-turn-evidence .compose-input { min-height: 64px; }
    </style>
  </head>
  <body><div id="root"></div><script src="./recall.js"></script></body>
</html>`,
    );

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
        queuedCapturePath,
        recalledCapturePath,
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
    assert.ok(statSync(queuedCapturePath).size > 5_000, "queued-state screenshot was captured");
    assert.ok(
      statSync(recalledCapturePath).size > 5_000,
      "recalled-state screenshot was captured",
    );
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});
