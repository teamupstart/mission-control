/* eslint-disable no-console */
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const outDir = join(repo, "docs", "plans", "workflow-card-progress", "evidence");
const buildDir = mkdtempSync(join(tmpdir(), "workflow-board-tile-evidence-"));

function buildHarness() {
  buildSync({
    entryPoints: [join(__dirname, "workflow-board-tile-evidence.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome130"],
    outfile: join(buildDir, "evidence.js"),
    alias: { "@shared": join(repo, "src", "shared") },
    loader: { ".css": "css" },
    logLevel: "silent",
  });
  writeFileSync(
    join(buildDir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta name="color-scheme" content="dark">'
      + '<link rel="stylesheet" href="./evidence.css"></head>'
      + '<body><div id="root"></div><script src="./evidence.js"></script></body></html>',
  );
}

async function waitFor(window, expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function waitForPaint(window) {
  await window.webContents.executeJavaScript(`new Promise((resolvePaint) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolvePaint, 240)));
  })`);
}

async function capture(window, name) {
  await waitForPaint(window);
  const rect = await window.webContents.executeJavaScript(`(() => {
    const label = document.querySelector('.evidence-label').getBoundingClientRect();
    const shell = document.querySelector('.evidence-shell').getBoundingClientRect();
    return {
      x: Math.max(0, Math.floor(shell.left - 24)),
      y: Math.max(0, Math.floor(label.top - 18)),
      width: Math.ceil(shell.width + 48),
      height: Math.ceil(shell.bottom - label.top + 36),
    };
  })()`);
  const image = await window.webContents.capturePage(rect);
  writeFileSync(join(outDir, name), image.toPNG());
}

buildHarness();
mkdirSync(outDir, { recursive: true });

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 620,
    height: 1000,
    backgroundColor: "#0a0c0f",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadFile(join(buildDir, "index.html"));
    await waitFor(window, "document.querySelector('.wf-tile-peek:not(.is-placeholder)')");
    await capture(window, "board-tile-dprime-implemented-collapsed.png");
    await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.tile-workflow-disclosure-btn');
      button.click();
    })()`);
    await waitFor(
      window,
      "document.querySelector('.tile-workflow-disclosure.is-expanded .wf-ladder-panel')",
    );
    await capture(window, "board-tile-dprime-implemented-expanded.png");
    console.log(outDir);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    rmSync(buildDir, { recursive: true, force: true });
    app.quit();
  }
});
