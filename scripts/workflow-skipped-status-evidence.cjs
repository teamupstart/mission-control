/* eslint-disable no-console */
// Captures the two skipped-stage treatments with their production tooltip open.
//
//   npx electron scripts/workflow-skipped-status-evidence.cjs

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const outDir = join(repo, "e2e", ".artifacts", "workflow-skipped-status");
const buildDir = mkdtempSync(join(tmpdir(), "workflow-skipped-status-evidence-"));

const scenarios = [
  {
    id: "inspector",
    file: "01-inspector-repair-skipped-tooltip.png",
    tone: "workflow-passed",
    tooltip: "Skipped because this stage passed in the prior full workflow round. This Inspector repair round only rechecks Inspector.",
  },
  {
    id: "unconfigured",
    file: "02-unconfigured-skipped-tooltip.png",
    tone: "workflow-waiting",
    tooltip: "Skipped because no command is configured for the checks in this stage.",
  },
];

function buildHarness() {
  buildSync({
    entryPoints: [join(__dirname, "workflow-skipped-status-evidence.tsx")],
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
      + '<link rel="stylesheet" href="./evidence.css">'
      + '<style>body{margin:0;background:var(--bg);color:var(--fg)}'
      + '.evidence-page{box-sizing:border-box;width:760px;min-height:760px;padding:34px 38px;'
      + 'background:radial-gradient(circle at 92% 4%,color-mix(in oklab,var(--working) 8%,transparent),transparent 34%),var(--bg)}'
      + '.evidence-head{margin:0 0 18px}.evidence-kicker{font:10px/1.3 var(--mono);letter-spacing:.11em;'
      + 'text-transform:uppercase;color:var(--dim)}.evidence-head h1{margin:8px 0 4px;font-size:22px;line-height:1.2}'
      + '.evidence-head p{margin:0;color:var(--muted);font-size:12px}.evidence-shell{width:100%;}'
      + '.evidence-shell>.wf-ladder-panel{max-height:none;box-shadow:var(--shadow)}</style>'
      + '</head><body><div id="root"></div><script src="./evidence.js"></script></body></html>',
  );
}

async function waitFor(window, expression, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function waitForPaint(window) {
  await window.webContents.executeJavaScript(`new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120)));
  })`);
}

async function hoverSkippedStage(window, tone) {
  const point = await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.wf-ladder-rung.${tone}')]
      .find((candidate) => candidate.querySelector('.wf-ladder-state')?.textContent.trim() === 'Skipped');
    const trigger = row?.querySelector('.wf-ladder-state');
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!point) throw new Error(`No ${tone} skipped stage found`);
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  await waitFor(window, "document.querySelector('.tooltip')");
  await waitFor(window, "getComputedStyle(document.querySelector('.tooltip')).visibility === 'visible'");
}

async function probe(window, expected) {
  return window.webContents.executeJavaScript(`(() => {
    const skipped = [...document.querySelectorAll('.wf-ladder-state')]
      .filter((state) => state.textContent.trim() === 'Skipped');
    const explained = skipped.filter((state) => state.classList.contains('wf-status-explained'));
    const toneMatches = skipped.filter((state) => state.closest('.wf-ladder-rung')
      ?.classList.contains(${JSON.stringify(expected.tone)}));
    return {
      skipped: skipped.length,
      explained: explained.length,
      toneMatches: toneMatches.length,
      tooltip: document.querySelector('.tooltip')?.textContent.trim() ?? null,
    };
  })()`);
}

async function capture(window, scenario) {
  await window.loadFile(join(buildDir, "index.html"), { query: { scenario: scenario.id } });
  await waitFor(window, "document.querySelector('.wf-ladder-panel')");
  await window.webContents.executeJavaScript("window.scrollTo(0, 0)");
  await hoverSkippedStage(window, scenario.tone);
  await waitForPaint(window);
  const state = await probe(window, scenario);
  if (state.skipped === 0 || state.explained === 0 || state.toneMatches === 0) {
    throw new Error(`${scenario.id} skipped state is not visible: ${JSON.stringify(state)}`);
  }
  if (state.tooltip !== scenario.tooltip) {
    throw new Error(`${scenario.id} tooltip differs: ${JSON.stringify(state.tooltip)}`);
  }
  const image = await window.webContents.capturePage();
  writeFileSync(join(outDir, scenario.file), image.toPNG());
  return state;
}

async function run() {
  mkdirSync(outDir, { recursive: true });
  buildHarness();
  const evidence = {};
  // A fresh viewport per scenario prevents Chromium from carrying the first document's
  // scroll offset into the next navigation and cropping the second evidence header. Keep
  // both windows alive until capture completes so destroying one renderer cannot race the
  // next window's initial navigation.
  const windows = scenarios.map(() => new BrowserWindow({
    width: 760,
    height: 760,
    show: false,
    backgroundColor: "#0a0c0f",
  }));
  for (const [index, scenario] of scenarios.entries()) {
    evidence[scenario.id] = await capture(windows[index], scenario);
  }
  for (const window of windows) window.destroy();
  console.log(JSON.stringify(evidence, null, 2));
}

app.disableHardwareAcceleration();
app.whenReady()
  .then(run)
  .then(() => {
    rmSync(buildDir, { recursive: true, force: true });
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    rmSync(buildDir, { recursive: true, force: true });
    app.exit(1);
  });
