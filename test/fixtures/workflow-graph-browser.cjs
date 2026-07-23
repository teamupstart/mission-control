const { readFile } = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  try {
    const [appCssPath, reactFlowCssPath] = process.argv.slice(-2);
    const [appCss, reactFlowCss] = await Promise.all([
      readFile(appCssPath, "utf8"),
      readFile(reactFlowCssPath, "utf8"),
    ]);
    const window = new BrowserWindow({ show: false, width: 500, height: 500 });
    const html = `<!doctype html><style>${reactFlowCss}\n${appCss}</style>
      <div class="workflow-version-detail">
        <div class="workflow-canvas is-readonly">
          <div class="react-flow" style="width: 100%; height: 100%; overflow: hidden; position: relative; z-index: 0;">
            <div class="react-flow__node" style="transform: translate(20px, 20px); width: 150px; height: 60px; visibility: visible"></div>
            <div class="react-flow__node" style="transform: translate(80px, 160px); width: 150px; height: 60px; visibility: visible"></div>
          </div>
        </div>
      </div>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const rect = (element) => {
        const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
        return { top, right, bottom, left, width, height };
      };
      return {
        graph: rect(document.querySelector('.workflow-canvas.is-readonly')),
        root: rect(document.querySelector('.react-flow')),
        nodes: [...document.querySelectorAll('.react-flow__node')].map(rect),
      };
    })()`);
    process.stdout.write(`${JSON.stringify(geometry)}\n`);
    window.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
