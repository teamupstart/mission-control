/* eslint-disable no-console */
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const outDir = join(repo, "e2e", ".artifacts", "review-answers-in-conversation");
const outPath = join(outDir, "review-answers-in-conversation.png");
const buildDir = mkdtempSync(join(tmpdir(), "review-answer-evidence-"));

app.commandLine.appendSwitch("lang", "en-US");

function buildHarness() {
  buildSync({
    entryPoints: [join(__dirname, "review-answer-evidence.tsx")],
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
  // The capture is taller than a laptop screen, and macOS silently CLAMPS a window to the
  // display - which crops the bottom of the page out of `capturePage` rather than failing.
  // `enableLargerThanScreen` lifts that clamp, and `useContentSize` makes the height below
  // mean the web viewport rather than the viewport plus whatever chrome the OS adds.
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1008,
    useContentSize: true,
    enableLargerThanScreen: true,
    backgroundColor: "#0a0c0f",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadFile(join(buildDir, "index.html"));
    // Gate on every claim the capture is meant to support, so a regression that empties one
    // of them fails here rather than shipping a screenshot that no longer shows it: both
    // review shapes present, the chosen option marked, a blue turn and a purple one for
    // contrast, and the whole conversation actually in view rather than scrolled past.
    await waitFor(
      window,
      `(() => {
        const cards = [...document.querySelectorAll('.review-answer')];
        if (cards.length !== 2) return false;
        const replayed = cards.some((c) =>
          c.querySelector('.review-answer-option.is-picked') && c.querySelector('.review-answer-other'));
        const prose = cards.some((c) =>
          !c.querySelector('.review-answer-options') && c.querySelector('.review-answer-text'));
        const human = document.querySelector('.turn-user:not(.turn-foreman)');
        const foreman = document.querySelector('.turn-foreman');
        const log = document.querySelector('.transcript-log');
        const wholeLogVisible = log && log.scrollHeight <= log.clientHeight + 1;
        return replayed && prose && Boolean(human) && Boolean(foreman) && wholeLogVisible;
      })()`,
    );
    await waitForPaint(window);
    const image = await window.webContents.capturePage();
    writeFileSync(outPath, image.toPNG());
    console.log(outPath);
  } catch (error) {
    console.error(error);
    const rendered = await window.webContents.executeJavaScript(`({
      cards: [...document.querySelectorAll('.review-answer')].map((c) => c.innerText),
      voices: [...document.querySelectorAll('.turn')].map((t) => t.className),
      log: (() => {
        const l = document.querySelector('.transcript-log');
        return l ? { scrollHeight: l.scrollHeight, clientHeight: l.clientHeight } : null;
      })(),
    })`);
    console.error("Rendered evidence state:", rendered);
    process.exitCode = 1;
  } finally {
    window.destroy();
    rmSync(buildDir, { recursive: true, force: true });
    app.quit();
  }
});
