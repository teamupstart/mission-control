import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceIndicatorButton } from "../src/web/components/VoiceIndicators.tsx";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

test("the status line leaves the last row visible at the minimum desktop size", () => {
  assertElectronGuiLaunchAllowed();
  const dir = mkdtempSync(join(tmpdir(), "mission-voice-geometry-"));
  try {
    const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
    const status = renderToStaticMarkup(createElement(VoiceIndicatorButton, { id: "status-line", mode: "listening", onClick() {} }));
    const path = join(dir, "shell.html");
    writeFileSync(path, `<style>${css}</style><div class="app app-console"><header class="topbar">Mission Control</header><main class="console"></main>${status}</div>`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = execFileSync(createRequire(import.meta.url)("electron"), [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--user-data-dir=${join(dir, "profile")}`,
      fileURLToPath(new URL("fixtures/voice-status-line-browser.cjs", import.meta.url)),
      "--pages", path,
    ], { encoding: "utf8", env, timeout: 90000 });
    const bounds = JSON.parse(output).shell;
    assert.deepEqual(bounds.viewport, { width: 720, height: 480 });
    assert.equal(bounds.line.height, 26);
    assert.equal(bounds.line.bottom, bounds.viewport.height);
    assert.ok(bounds.content <= bounds.line.top);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
