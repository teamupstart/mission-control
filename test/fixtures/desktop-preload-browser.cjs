const { app, BrowserWindow } = require("electron");

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

  try {
    await win.loadFile(page);
    const result = await win.webContents.executeJavaScript(`({
      isDesktop: window.missionDesktop?.isDesktop === true,
      hasDesktopClass: document.documentElement.classList.contains("is-desktop"),
      capability: window.missionDesktop?.claimProductIssueAuthorization?.() ?? null,
    })`);
    process.stdout.write(`${JSON.stringify({ ...result, preloadError })}\n`);
    app.quit();
  } catch (error) {
    console.error(error);
    setImmediate(() => app.exit(1));
  }
});
