/* eslint-disable no-console */
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const outDir = join(
  repo,
  "docs",
  "plans",
  "workflow-card-progress",
  "evidence",
);
const buildDir = mkdtempSync(join(tmpdir(), "workflow-ladder-evidence-"));

function buildHarness() {
  buildSync({
    entryPoints: [join(__dirname, "workflow-ladder-actions-evidence.tsx")],
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
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolvePaint, 50)));
  })`);
}

async function loadScenario(window, scenario) {
  await window.loadFile(join(buildDir, "index.html"), { query: { scenario } });
  await waitFor(window, "document.querySelector('.wf-ladder-panel')");
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
}

async function clickButton(window, label, scope = "document") {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const root = ${scope};
    const button = [...root.querySelectorAll('button')]
      .find((candidate) => candidate.innerText.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Button not found: ${label}`);
}

async function scrollLadderToBottom(window) {
  await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.wf-ladder-panel');
    panel.scrollTop = panel.scrollHeight;
  })()`);
}

async function fillConfirmation(window) {
  const phrase = "DISCARD AND SEND A NEW REPAIR ROUND";
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.workflow-confirm-phrase input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(phrase)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    window,
    "!document.querySelector('.workflow-confirm button[type=\"submit\"]').disabled",
  );
}

async function capture(window, name) {
  await waitForPaint(window);
  const rect = await window.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.evidence-shell').getBoundingClientRect();
    const modal = document.querySelector('.workflow-confirm')?.getBoundingClientRect();
    const tooltip = document.querySelector('.tooltip')?.getBoundingClientRect();
    const bottom = Math.max(shell.bottom + 26, modal?.bottom + 48 || 0, tooltip?.bottom + 20 || 0);
    return {
      x: 0,
      y: 0,
      width: Math.ceil(window.innerWidth),
      height: Math.min(Math.ceil(bottom), window.innerHeight),
    };
  })()`);
  const image = await window.webContents.capturePage(rect);
  writeFileSync(join(outDir, name), image.toPNG());
}

async function showDisabledReason(window) {
  const point = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.innerText.trim() === 'Discard and send new round');
    const anchor = button.closest('.tt-anchor');
    const rect = anchor.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  await waitFor(window, "document.querySelector('.tooltip')");
}

async function evidenceState(window) {
  return window.webContents.executeJavaScript(`({
    requests: window.__ladderEvidence.requests,
    clipboard: window.__ladderEvidence.clipboard,
    expectedFeedback: window.__ladderEvidence.expectedFeedback,
    snapshot: window.__ladderEvidence.snapshot(),
  })`);
}

async function screenshotEvidence(window) {
  await loadScenario(window, "d2");
  await clickButton(window, "Copy feedback");
  await waitFor(
    window,
    "[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Copied')",
  );
  await capture(window, "phase-2-d2-copied.png");

  await loadScenario(window, "d3");
  await capture(window, "phase-2-d3-inspector-actions.png");

  await loadScenario(window, "prepare-pr-e2e");
  await clickButton(window, "Prepare PR in session");
  await waitFor(
    window,
    "window.__ladderEvidence.requests.filter((request) => request.method === 'GET').length >= 2",
  );
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
  await waitFor(
    window,
    "![...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Prepare PR in session')",
  );
  await capture(window, "phase-2-d3-pr-prepared.png");

  await loadScenario(window, "d4-disabled");
  await scrollLadderToBottom(window);
  await showDisabledReason(window);
  await capture(window, "phase-2-d4-disabled-no-session.png");

  await loadScenario(window, "d4-confirm");
  await scrollLadderToBottom(window);
  await clickButton(window, "Discard and send new round");
  await waitFor(window, "document.querySelector('.workflow-confirm')");
  await fillConfirmation(window);
  await capture(window, "phase-2-d4-typed-confirmation.png");

  await loadScenario(window, "mark-delivered-e2e");
  await scrollLadderToBottom(window);
  await clickButton(window, "Mark delivered");
  await waitFor(window, "document.querySelector('.workflow-confirm')");
  await capture(window, "phase-2-d4-mark-delivered-confirmation.png");
}

async function actionTranscript(window) {
  await loadScenario(window, "d2");
  await clickButton(window, "Copy feedback");
  await waitFor(
    window,
    "[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Copied')",
  );
  const copySuccess = await evidenceState(window);

  await loadScenario(window, "prepare-pr-e2e");
  await clickButton(window, "Prepare PR in session");
  await waitFor(
    window,
    "window.__ladderEvidence.requests.filter((request) => request.method === 'GET').length >= 2",
  );
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
  await waitFor(
    window,
    "![...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Prepare PR in session')",
  );
  const preparePrSuccess = await evidenceState(window);

  await loadScenario(window, "gate-e2e");
  await clickButton(window, "Recheck Inspector");
  await waitFor(
    window,
    "document.querySelector('[role=\"alert\"]')?.innerText.includes('Inspector ledger unavailable')",
  );
  await waitFor(
    window,
    "window.__ladderEvidence.requests.filter((request) => request.method === 'GET').length >= 2",
  );
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
  await waitFor(
    window,
    "[...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'Recheck Inspector')",
  );
  const gateFailure = await evidenceState(window);

  await clickButton(window, "Recheck Inspector");
  await waitFor(
    window,
    "window.__ladderEvidence.requests.filter((request) => request.method === 'GET').length >= 3",
  );
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
  await waitFor(window, "!document.body.innerText.includes('Recheck Inspector')");
  const gateSuccess = await evidenceState(window);

  await loadScenario(window, "delivery-e2e");
  await scrollLadderToBottom(window);
  await clickButton(window, "Discard and send new round");
  await waitFor(window, "document.querySelector('.workflow-confirm')");
  await fillConfirmation(window);
  await clickButton(window, "Discard and send new round", "document.querySelector('.workflow-confirm')");
  await waitFor(
    window,
    "window.__ladderEvidence.requests.filter((request) => request.method === 'GET').length >= 2",
  );
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
  await waitFor(window, "!document.body.innerText.includes('Repair delivery')");
  const deliverySuccess = await evidenceState(window);

  await loadScenario(window, "mark-delivered-e2e");
  await scrollLadderToBottom(window);
  await clickButton(window, "Mark delivered");
  await waitFor(window, "document.querySelector('.workflow-confirm')");
  const markConfirmation = await evidenceState(window);
  await clickButton(window, "Mark delivered", "document.querySelector('.workflow-confirm')");
  await waitFor(
    window,
    "window.__ladderEvidence.requests.filter((request) => request.method === 'GET').length >= 2",
  );
  await waitFor(window, "!document.querySelector('[aria-busy=\"true\"]')");
  await waitFor(window, "!document.body.innerText.includes('Repair delivery')");
  const markDeliveredSuccess = await evidenceState(window);

  return {
    copySuccess,
    preparePrSuccess,
    gateFailure,
    gateSuccess,
    deliverySuccess,
    markConfirmation,
    markDeliveredSuccess,
  };
}

function actionRows(requests) {
  return requests
    .map((request) => {
      const body = request.body ? `\`${JSON.stringify(request.body)}\`` : "—";
      const response = `\`${JSON.stringify(request.response)}\``;
      return `| ${request.sequence} | ${request.method} | \`${request.path}\` | ${request.status} | ${body} | ${response} |`;
    })
    .join("\n");
}

function writeTranscript(transcript) {
  const copiedPacket = transcript.copySuccess.clipboard.at(-1);
  const copiedPacketMatches = copiedPacket === transcript.copySuccess.expectedFeedback;
  const copiedPacketSha = createHash("sha256").update(copiedPacket).digest("hex");
  const preparePrPost = transcript.preparePrSuccess.requests
    .find((request) => request.method === "POST");
  const failedGatePost = transcript.gateFailure.requests
    .find((request) => request.method === "POST");
  const successfulGatePosts = transcript.gateSuccess.requests
    .filter((request) => request.method === "POST");
  const retriedGatePost = successfulGatePosts.at(-1);
  const deliveryPost = transcript.deliverySuccess.requests
    .find((request) => request.method === "POST");
  const markDeliveredPost = transcript.markDeliveredSuccess.requests
    .find((request) => request.method === "POST");
  const sameRequestId =
    failedGatePost.body.requestId === retriedGatePost.body.requestId;
  const deliveryPhrase =
    deliveryPost.body.confirmation === "DISCARD AND SEND A NEW REPAIR ROUND";

  const markdown = `# Phase 2 ladder action evidence

Generated from the real \`WorkflowLadderPanel\`, \`WorkflowConfirmModal\`,
\`useRunActions\`, and \`workflowRequest\` implementations. The harness replaces only
\`fetch\` and the clipboard, so button activation, confirmation gating, request construction,
inline errors, pending state, and refetch are exercised in the browser.

Reproduce from the repository root:

\`\`\`sh
npx electron scripts/workflow-ladder-actions-evidence.cjs
\`\`\`

## Visual captures

### D2 · Feedback carried by hand

The Preview-mode failed rung after activating **Copy feedback**; the live button state reads
**Copied**.

![D2 feedback copied](./phase-2-d2-copied.png)

### D3 · Inspector gate actions

The gate is parked on \`missing_pr\`, so **Prepare PR in session**, **Recheck Inspector**, and
**Open PR** are all visible on the gate rung.

![D3 Inspector actions](./phase-2-d3-inspector-actions.png)

After activating **Prepare PR in session**, the panel refetches the run in
\`waiting_for_session\` / \`pr_handoff\`; the one-shot preparation action is gone.

![D3 PR handoff prepared](./phase-2-d3-pr-prepared.png)

### D4 · Bound session disappeared

The durable binding has \`sessionId: null\` while the summary still carries its stale session
id. **Discard and send new round** remains visible but disabled; its visible tooltip explains
that the bound session is gone.

![D4 disabled without a bound session](./phase-2-d4-disabled-no-session.png)

### D4 · Typed destructive confirmation

With a live binding, activating **Discard and send new round** opens the real shared
confirmation. The exact phrase is typed and the destructive confirm is enabled.

![D4 typed phrase confirmation](./phase-2-d4-typed-confirmation.png)

The other resolution uses the real shared confirmation too. **Mark delivered** displays its
inspection warning before the guarded POST can run.

![D4 Mark delivered confirmation](./phase-2-d4-mark-delivered-confirmation.png)

## End-to-end action transcript

### Copy feedback: prepared packet written to the clipboard

Observed:

- Clipboard writes after activating **Copy feedback**: **${transcript.copySuccess.clipboard.length}**.
- Copied bytes exactly equal \`workflowFeedbackText(detail)\`: **${copiedPacketMatches ? "yes" : "no"}**.
- Copied packet size: **${Buffer.byteLength(copiedPacket, "utf8")} bytes**.
- Copied packet SHA-256: \`${copiedPacketSha}\`.
- Final rendered button label: **${transcript.copySuccess.snapshot.buttons.some((button) => button.label === "Copied") ? "Copied" : "not copied"}**.

### Prepare PR in session: POST and committed refresh

| # | Method | Path | Status | Request JSON | Response JSON |
|---:|---|---|---:|---|---|
${actionRows(transcript.preparePrSuccess.requests)}

Observed:

- Request id: \`${preparePrPost.body.requestId}\`.
- Refetch after PR handoff preparation: **${transcript.preparePrSuccess.requests.filter((request) => request.method === "GET").length > 1 ? "yes" : "no"}**.
- Final run status from the refreshed detail: \`${transcript.preparePrSuccess.snapshot.runStatus}\`.
- Final rendered state: Prepare PR offered = **${transcript.preparePrSuccess.snapshot.hasPreparePr}**.

### Inspector recheck: error, stable retry key, success, refresh

The harness returns 503 once to expose the panel's inline error and then accepts the retry.

| # | Method | Path | Status | Request JSON | Response JSON |
|---:|---|---|---:|---|---|
${actionRows(transcript.gateSuccess.requests)}

Observed:

- Inline error after the first POST: \`${transcript.gateFailure.snapshot.alert}\`.
- Failed request id: \`${failedGatePost.body.requestId}\`.
- Retry request id: \`${retriedGatePost.body.requestId}\`.
- Retry reused the idempotency key: **${sameRequestId ? "yes" : "no"}**.
- GETs after each settled POST: **${transcript.gateSuccess.requests.filter((request) => request.method === "GET").length - 1}**.
- Final rendered state: Recheck Inspector offered = **${transcript.gateSuccess.snapshot.hasRecheckInspector}**.

### Uncertain delivery: typed confirmation, guarded POST, refresh

| # | Method | Path | Status | Request JSON | Response JSON |
|---:|---|---|---:|---|---|
${actionRows(transcript.deliverySuccess.requests)}

Observed:

- Request id: \`${deliveryPost.body.requestId}\`.
- Exact typed confirmation sent: **${deliveryPhrase ? "yes" : "no"}**.
- Expected binding guard: session \`${deliveryPost.body.expectedSessionId}\`, note
  \`${deliveryPost.body.expectedNoteKey}\`.
- Refetch after the resolution: **${transcript.deliverySuccess.requests.filter((request) => request.method === "GET").length > 1 ? "yes" : "no"}**.
- Final rendered state: Repair delivery present = **${transcript.deliverySuccess.snapshot.hasRepairDelivery}**.

### Mark delivered: confirmation, guarded POST, refresh

| # | Method | Path | Status | Request JSON | Response JSON |
|---:|---|---|---:|---|---|
${actionRows(transcript.markDeliveredSuccess.requests)}

Observed:

- Confirmation shown before the POST: \`${transcript.markConfirmation.snapshot.confirmTitle}\`.
- POSTs before confirmation: **${transcript.markConfirmation.requests.filter((request) => request.method === "POST").length}**.
- Request id: \`${markDeliveredPost.body.requestId}\`.
- Resolution: \`${markDeliveredPost.body.resolution}\`.
- Confirmation is the Mark-delivered guard; this resolution deliberately requires no bound
  session.
- Refetch after the resolution: **${transcript.markDeliveredSuccess.requests.filter((request) => request.method === "GET").length > 1 ? "yes" : "no"}**.
- Final rendered state: Repair delivery present = **${transcript.markDeliveredSuccess.snapshot.hasRepairDelivery}**.
`;
  writeFileSync(join(outDir, "phase-2-evidence.md"), markdown);
}

buildHarness();
mkdirSync(outDir, { recursive: true });

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 820,
    height: 1000,
    backgroundColor: "#0a0c0f",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await screenshotEvidence(window);
    const transcript = await actionTranscript(window);
    writeTranscript(transcript);
    console.log(join(outDir, "phase-2-evidence.md"));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    rmSync(buildDir, { recursive: true, force: true });
    app.quit();
  }
});
