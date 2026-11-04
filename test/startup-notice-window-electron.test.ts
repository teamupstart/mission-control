// The startup notice's fallback window in real Electron: what a person sees when the update
// helper owns the transaction and a notification cannot carry the notice. It must render the
// notice and then close itself, so the launch leaves within its bound and never holds the
// bundle the helper is waiting on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

const require = createRequire(import.meta.url);
const HOLD_MS = 3_000;

test("with notifications unavailable, the update-in-progress notice shows in a window that closes itself", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async (t) => {
  assertElectronGuiLaunchAllowed();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-notice-window-")));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const app = join(root, "app"); mkdirSync(app);
  const out = join(root, "out"); mkdirSync(out);
  buildSync({
    stdin: {contents: `
      export { announceStartupNotice } from "./src/main/startup-notice.ts";
      export { showStartupNoticeWindow } from "./src/main/startup-notice-window.ts";
      export { MIGRATION_IN_PROGRESS_NOTICE } from "./scripts/migration-runtime.mjs";
    `, resolveDir: resolve("."), loader: "ts"},
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
    alias: {"@shared": "./src/shared"}, outfile: join(app, "notice.cjs"), logLevel: "silent",
  });
  writeFileSync(join(app, "package.json"), JSON.stringify({name: "startup-notice-fixture", main: "main.cjs"}));
  writeFileSync(join(app, "main.cjs"), `
    const {app, BrowserWindow} = require("electron");
    const {writeFileSync} = require("node:fs");
    const n = require("./notice.cjs");
    const out = process.env.FIXTURE_OUT;
    app.on("window-all-closed", () => {});
    app.whenReady().then(async () => {
      const started = Date.now();
      setTimeout(async () => {
        const [win] = BrowserWindow.getAllWindows();
        if (!win) return;
        const image = await win.webContents.capturePage();
        writeFileSync(out + "/notice.png", image.toPNG());
        writeFileSync(out + "/window.json", JSON.stringify({visible: win.isVisible(), title: win.getTitle(), bounds: win.getBounds()}));
      }, 1200);
      await n.announceStartupNotice(n.MIGRATION_IN_PROGRESS_NOTICE, {
        supported: () => false, show: () => { throw new Error("must not post"); },
        fallback: n.showStartupNoticeWindow, log: (line) => console.log(line),
      }, {fallbackMs: ${HOLD_MS}});
      writeFileSync(out + "/done.json", JSON.stringify({elapsed: Date.now() - started, open: BrowserWindow.getAllWindows().length}));
      app.exit(0);
    });
  `);
  const env: NodeJS.ProcessEnv = {...process.env, FIXTURE_OUT: out};
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawn(require("electron") as string, [app], {env, stdio: ["ignore", "pipe", "pipe"]});
  let output = "";
  electron.stdout.on("data", (chunk) => { output += chunk; });
  electron.stderr.on("data", (chunk) => { output += chunk; });
  assert.equal(await new Promise<number | null>((done) => electron.once("exit", done)), 0, output);

  const shown = JSON.parse(readFileSync(join(out, "window.json"), "utf8"));
  assert.equal(shown.visible, true, "the fallback window was never shown");
  assert.equal(shown.title, "Mission Control");
  assert.ok(existsSync(join(out, "notice.png")));
  const done = JSON.parse(readFileSync(join(out, "done.json"), "utf8"));
  assert.equal(done.open, 0, "the fallback window was still open when the launch left");
  assert.ok(done.elapsed >= HOLD_MS - 100 && done.elapsed < HOLD_MS + 2_000, `the window held the launch for ${done.elapsed}ms`);
  assert.match(output, /showing it in a window/);
  if (process.env.MC_EVIDENCE_DIR) {
    mkdirSync(process.env.MC_EVIDENCE_DIR, {recursive: true});
    copyFileSync(join(out, "notice.png"), join(process.env.MC_EVIDENCE_DIR, "startup-notice-window.png"));
  }
});
