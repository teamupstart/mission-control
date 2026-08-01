/* eslint-disable no-console */
// Photographs the Workflows-tab relocation from the real ConsoleDetail.
//
//   npx electron scripts/workflows-tab-evidence.cjs
//
// Writes docs/evidence/workflows-tab/*.png. See that directory's README for what each
// capture proves. The harness it drives is scripts/workflows-tab-evidence.tsx.

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const outDir = join(repo, "docs", "evidence", "workflows-tab");
const buildDir = mkdtempSync(join(tmpdir(), "workflows-tab-evidence-"));

function buildHarness() {
  buildSync({
    entryPoints: [join(__dirname, "workflows-tab-evidence.tsx")],
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
      + '<link rel="stylesheet" href="./evidence.css">'
      + "<style>body{margin:0;padding:18px;background:#0d0d0d}"
      + ".evidence-shell{width:100%;height:760px;display:flex;flex-direction:column;"
      + "overflow:hidden;border:1px solid var(--border);border-radius:12px;"
      + "background:var(--panel);box-shadow:var(--shadow)}"
      + ".evidence-shell > .cdetail{flex:1;min-height:0}</style>"
      + '</head><body><div id="root"></div><script src="./evidence.js"></script></body></html>',
  );
}

async function waitFor(window, expression, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function waitForPaint(window) {
  await window.webContents.executeJavaScript(`new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)));
  })`);
}

async function load(window, scenario) {
  await window.loadFile(join(buildDir, "index.html"), { query: { scenario } });
  await waitFor(window, "document.querySelector('.detail-tabs')");
}

/** What the capture actually contains, asserted rather than eyeballed. */
async function probe(window) {
  return window.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.detail-tab')];
    const body = document.querySelector('.detail-body');
    // The label alone: a tab's text also carries its keycap and, when something is waiting,
    // its pip - so reading textContent would make "Workflows" and "Workflows1" different
    // tabs depending on whether the gate happened to be parked.
    const label = (t) => [...t.childNodes]
      .filter((n) => n.nodeType === 3 || !n.classList?.contains('kb-hint')
        && !n.classList?.contains('detail-pip'))
      .map((n) => n.textContent)
      .join('')
      .trim();
    return {
      tabs: tabs.map(label),
      active: tabs.filter((t) => t.classList.contains('on')).map(label)[0] ?? null,
      pane: body?.getAttribute('aria-label') ?? null,
      keycaps: tabs.map((t) => t.querySelector('.kb-hint')?.textContent ?? null),
      hasGateTab: tabs.some((t) => label(t) === 'Gate'),
      nmStrip: Boolean(document.querySelector('.nm-strip')),
      nmLog: Boolean(document.querySelector('.nm-log, .nm-rollup')),
      ladder: Boolean(document.querySelector('.wf-ladder-panel')),
      gateVerbs: ['Approve', 'Fix', 'Skip']
        .filter((v) => [...document.querySelectorAll('button')]
          .some((b) => b.textContent.trim() === v)),
      pip: document.querySelector('.detail-pip')?.textContent ?? null,
    };
  })()`);
}

async function capture(window, name) {
  await waitForPaint(window);
  const image = await window.webContents.capturePage();
  writeFileSync(join(outDir, name), image.toPNG());
}

async function run() {
  mkdirSync(outDir, { recursive: true });
  buildHarness();
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    show: false,
    backgroundColor: "#0d0d0d",
    webPreferences: { offscreen: false },
  });

  await load(window, "conversation");
  const conversation = await probe(window);
  await capture(window, "01-conversation-no-nomistakes.png");

  await load(window, "workflows");
  await waitFor(window, "document.querySelector('.nm-strip')");
  const workflows = await probe(window);
  await capture(window, "02-workflows-tab-via-y.png");

  console.log(JSON.stringify({ conversation, workflows }, null, 2));

  // The capture is only evidence if it shows what it claims to. Fail the run rather than
  // write a screenshot that quietly disagrees with the README beside it.
  const problems = [];
  const strip = ["Conversation", "Work queue", "Workflows", "Diff", "Files"];
  const caps = ["g", "q", "y", "d", "f"];
  if (JSON.stringify(conversation.tabs) !== JSON.stringify(strip)) {
    problems.push(`tab strip is ${JSON.stringify(conversation.tabs)}`);
  }
  if (JSON.stringify(conversation.keycaps) !== JSON.stringify(caps)) {
    problems.push(`keycaps are ${JSON.stringify(conversation.keycaps)}`);
  }
  if (conversation.hasGateTab || workflows.hasGateTab) problems.push("a Gate tab survives");
  if (conversation.active !== "Conversation") problems.push("did not open on Conversation");
  if (conversation.nmStrip || conversation.nmLog || conversation.ladder) {
    problems.push("conversation still renders progress UI");
  }
  if (workflows.active !== "Workflows") problems.push("the y request did not open Workflows");
  if (!workflows.nmStrip) problems.push("workflows tab has no no-mistakes strip");
  if (!workflows.nmLog) problems.push("workflows tab has no fix log");
  if (!workflows.ladder) problems.push("workflows tab has no workflow ladder");
  if (workflows.gateVerbs.length !== 3) {
    problems.push(`gate actions present: ${JSON.stringify(workflows.gateVerbs)}`);
  }
  if (problems.length > 0) throw new Error(`Evidence disagrees with its claim: ${problems.join("; ")}`);

  window.destroy();
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
