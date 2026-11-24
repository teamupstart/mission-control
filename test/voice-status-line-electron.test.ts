import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { constants, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceIndicatorButton } from "../src/web/components/VoiceIndicators.tsx";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

function installedSandbox(path: string | undefined): boolean {
  if (!path) return false;
  const helper = statSync(path, { throwIfNoEntry: false });
  return !!helper?.isFile() && helper.uid === 0 && (helper.mode & 0o7777) === 0o4755;
}

function fixtureElectron(dir: string): string {
  const electron = createRequire(import.meta.url)("electron") as string;
  const dist = dirname(electron);
  if (process.platform !== "linux" || installedSandbox(join(dist, "chrome-sandbox"))) return electron;
  const sandbox = [process.env.CHROME_DEVEL_SANDBOX, "/opt/google/chrome/chrome-sandbox", "/usr/lib/chromium/chrome-sandbox"].find(installedSandbox);
  if (!sandbox) return electron;

  // Chromium prefers the helper beside its executable, even when npm installed it without
  // setuid. Pair a private copy of this Electron binary with the host's configured helper.
  const runtime = join(dir, "electron");
  mkdirSync(runtime);
  const executable = join(runtime, basename(electron));
  copyFileSync(electron, executable, constants.COPYFILE_FICLONE);
  for (const name of readdirSync(dist)) {
    if (name !== basename(electron) && name !== "chrome-sandbox") symlinkSync(join(dist, name), join(runtime, name));
  }
  symlinkSync(sandbox, join(runtime, "chrome-sandbox"));
  return executable;
}

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
    const output = execFileSync(fixtureElectron(dir), [
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
