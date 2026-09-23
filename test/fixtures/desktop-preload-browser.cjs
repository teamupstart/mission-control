const { app, BrowserWindow, ipcMain } = require("electron");

const preload = process.argv.at(-2);
const page = process.argv.at(-1);

app.whenReady().then(async () => {
  let preloadError = null;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload,
      sandbox: true,
    },
  });
  win.webContents.on("preload-error", (_event, _path, error) => {
    preloadError = error instanceof Error ? error.message : String(error);
  });
  ipcMain.on("mission:product-issue-report-click", (event) => {
    event.returnValue = event.sender === win.webContents;
  });

  try {
    await win.loadFile(page);
    const result = await win.webContents.executeJavaScript(`({
      isDesktop: window.missionDesktop?.isDesktop === true,
      hasDesktopClass: document.documentElement.classList.contains("is-desktop"),
      capability: window.missionDesktop?.claimProductIssueAuthorization?.() ?? null,
    })`);
    win.webContents.on("console-message", (details) => {
      if (details.message !== "preload-test:ready") return;
      win.webContents.sendInputEvent({ type: "mouseDown", x: 30, y: 15, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: 30, y: 15, button: "left", clickCount: 1 });
    });
    const authorization = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const capability = ${JSON.stringify(result.capability)};
      const input = {
        requestId: "11111111-2222-4333-8444-555555555555",
        draftIdentity: "a".repeat(64),
      };
      const authorize = (candidate = capability) =>
        window.missionDesktop.authorizeProductIssue(candidate, input);
      const checks = {
        withoutClick: authorize(),
        reclaimedCapability: window.missionDesktop.claimProductIssueAuthorization(),
      };
      const button = document.createElement("button");
      button.textContent = "Report";
      document.body.append(button);
      button.onclick = () => { checks.syntheticClick = authorize(); };
      button.click();
      button.onclick = () => {
        checks.wrongCapability = authorize("wrong-capability");
        checks.duringClick = authorize();
        setTimeout(() => { checks.afterClick = authorize(); resolve(checks); }, 0);
      };
      // Ask the fixture main process to deliver a native input event, without exposing
      // the capability to that event's sender or synthesizing a DOM click.
      console.info("preload-test:ready");
    })`, true);
    process.stdout.write(`${JSON.stringify({ ...result, preloadError, authorization })}\n`);
    app.quit();
  } catch (error) {
    console.error(error);
    setImmediate(() => app.exit(1));
  }
});
