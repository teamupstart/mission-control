const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  try {
    const htmlPath = process.argv.at(-1);
    const window = new BrowserWindow({ show: false, width: 900, height: 600 });
    await window.loadFile(htmlPath);

    const deadline = Date.now() + 5_000;
    let result = null;
    while (Date.now() < deadline && result === null) {
      result = await window.webContents.executeJavaScript("window.__pendingTurnRecallResult ?? null");
      if (result === null) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (result === null) throw new Error("Pending-turn recall did not settle");

    process.stdout.write(`${JSON.stringify(result)}\n`);
    window.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
