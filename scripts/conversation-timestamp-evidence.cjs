/* eslint-disable no-console */
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const outDir = join(repo, "docs", "evidence", "conversation-timestamps");
const outPath = join(outDir, "conversation-timestamps.png");
const buildDir = mkdtempSync(join(tmpdir(), "conversation-timestamp-evidence-"));

app.commandLine.appendSwitch("lang", "en-US");

function buildHarness() {
  buildSync({
    entryPoints: [join(__dirname, "conversation-timestamp-evidence.tsx")],
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
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
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

buildHarness();
mkdirSync(outDir, { recursive: true });

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 920,
    height: 700,
    backgroundColor: "#0a0c0f",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadFile(join(buildDir, "index.html"));
    await waitFor(
      window,
      `(() => {
        const turns = [...document.querySelectorAll('.turn')];
        const say = (row) => row.textContent.replace(/\\s+/g, ' ').trim().toLowerCase();
        const spoke = (who, time) =>
          turns.some((row) => say(row).includes(who) && say(row).includes(time));
        // Placement is the claim this capture is making, so it is checked before the
        // shutter rather than left to the reviewer's eye: every clock has to end within a
        // pixel of its own turn's right edge, whatever the speaker beside it is called.
        const pinned = turns.every((row) => {
          const time = row.querySelector('.turn-time');
          if (!time) return true;
          const gap = row.getBoundingClientRect().right - time.getBoundingClientRect().right;
          return Math.abs(gap) <= 1;
        });
        return pinned && spoke('you', '9:42 am') && spoke('claude', '9:43 am');
      })()`,
    );
    await waitForPaint(window);
    const image = await window.webContents.capturePage();
    writeFileSync(outPath, image.toPNG());
    console.log(outPath);
  } catch (error) {
    console.error(error);
    const rendered = await window.webContents.executeJavaScript(`({
      text: document.body.innerText,
      rows: [...document.querySelectorAll('.turn-role')].map((row) => row.textContent),
    })`);
    console.error("Rendered evidence state:", rendered);
    process.exitCode = 1;
  } finally {
    window.destroy();
    rmSync(buildDir, { recursive: true, force: true });
    app.quit();
  }
});
