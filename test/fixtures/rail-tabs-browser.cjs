const { app, BrowserWindow } = require("electron");

/**
 * Measures the conversation rail's head in a real browser: whether its tabs, the count and
 * the fold all fit the 244px column on one line.
 *
 * The page carries the REAL rail markup and the REAL stylesheet; this file only reads back
 * what the layout did, in one synchronous evaluation (see `measuring-window.cjs` for why one).
 * Whether a tab strip fits is a fact about used width that no markup assertion can produce.
 */
app.whenReady().then(async () => {
  try {
    const htmlPath = process.argv.at(-1);
    const window = new BrowserWindow({ show: false, width: 1400, height: 900, useContentSize: true });
    await window.loadFile(htmlPath);

    const measured = await window.webContents.executeJavaScript(`(() => {
      const out = {};
      for (const host of document.querySelectorAll('[data-case]')) {
        const rail = host.querySelector('.activity-rail');
        const head = rail.querySelector('.activity-head');
        const tabs = rail.querySelector('.activity-tabs');
        const end = rail.querySelector('.activity-head-end');
        const fold = rail.querySelector('.activity-collapse');
        const railRect = rail.getBoundingClientRect();
        const headRect = head.getBoundingClientRect();
        const headStyle = getComputedStyle(head);
        const innerRight = headRect.right - parseFloat(headStyle.paddingRight) - parseFloat(headStyle.borderRightWidth);
        const tabRects = [...tabs.querySelectorAll('[role="tab"]')].map((tab) => {
          const r = tab.getBoundingClientRect();
          return {
            name: tab.textContent,
            top: Math.round(r.top),
            height: Math.round(r.height),
            right: r.right,
            clipped: tab.scrollWidth > tab.clientWidth,
          };
        });
        out[host.dataset.case] = {
          railWidth: Math.round(railRect.width),
          headHeight: Math.round(headRect.height),
          headOverflow: head.scrollWidth > head.clientWidth,
          tabs: tabRects,
          tabsRight: tabs.getBoundingClientRect().right,
          endLeft: end.getBoundingClientRect().left,
          foldRight: fold.getBoundingClientRect().right,
          foldVisible: fold.getBoundingClientRect().width > 0,
          innerRight,
          railRight: railRect.right,
        };
      }
      return out;
    })()`);

    process.stdout.write(`${JSON.stringify(measured)}\n`);
    window.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
