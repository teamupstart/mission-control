const { writeFileSync } = require("node:fs");
const { app, BrowserWindow } = require("electron");

async function waitFor(window, expression, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not settle`);
}

async function waitForPaint(window) {
  await window.webContents.executeJavaScript(`new Promise((resolvePaint) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolvePaint, 80)));
  })`);
}

app.whenReady().then(async () => {
  try {
    const [htmlPath, queuedCapturePath, recalledCapturePath] = process.argv.slice(-3);
    const window = new BrowserWindow({
      show: false,
      width: 900,
      height: 650,
      backgroundColor: "#0a0c0f",
    });
    await window.loadFile(htmlPath);

    await waitFor(
      window,
      'window.__pendingTurnRecallStage === "queued"',
      "Pending-turn queued state",
    );
    await waitForPaint(window);
    writeFileSync(queuedCapturePath, (await window.webContents.capturePage()).toPNG());

    await window.webContents.executeJavaScript("void window.__triggerPendingTurnRecall?.()");
    await waitFor(
      window,
      'window.__pendingTurnRecallStage === "recalled"',
      "Pending-turn recalled state",
    );
    await waitForPaint(window);
    writeFileSync(recalledCapturePath, (await window.webContents.capturePage()).toPNG());
    const result = await window.webContents.executeJavaScript(
      "window.__pendingTurnRecallResult ?? null",
    );

    process.stdout.write(`${JSON.stringify(result)}\n`);
    window.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
