import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 120_000;

interface DesktopPreloadResult {
  isDesktop: boolean;
  hasDesktopClass: boolean;
  capability: string | null;
  preloadError: string | null;
}

test("the sandboxed preload identifies the desktop shell before the dashboard paints", () => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "mission-desktop-preload-"));
  const profile = mkdtempSync(join(tmpdir(), "mission-desktop-preload-profile-"));
  const preload = join(dir, "preload.cjs");
  const page = join(dir, "page.html");
  try {
    execFileSync(
      join(root, "node_modules", ".bin", "esbuild"),
      [
        join(root, "src", "preload", "index.ts"),
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node22",
        "--external:electron",
        `--outfile=${preload}`,
      ],
      { encoding: "utf8", timeout: TIMEOUT_MS },
    );
    writeFileSync(
      page,
      "<!doctype html><script>" +
        "if(window.missionDesktop?.isDesktop)document.documentElement.classList.add('is-desktop')" +
        "</script>",
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const output = execFileSync(
      electron,
      [
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `--user-data-dir=${profile}`,
        fileURLToPath(new URL("fixtures/desktop-preload-browser.cjs", import.meta.url)),
        preload,
        page,
      ],
      { encoding: "utf8", env, timeout: TIMEOUT_MS },
    );
    const result = JSON.parse(output.trim()) as DesktopPreloadResult;

    assert.equal(
      result.preloadError,
      null,
      `the sandboxed preload failed before it could expose the desktop bridge: ${result.preloadError}`,
    );
    assert.equal(result.isDesktop, true, "the renderer cannot distinguish Electron from a browser");
    assert.equal(
      result.hasDesktopClass,
      true,
      "the desktop-only traffic-light inset will not be applied",
    );
    assert.match(
      result.capability ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "the preload lost the private product-report capability while entering its sandbox",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(profile, { force: true, recursive: true });
  }
});
