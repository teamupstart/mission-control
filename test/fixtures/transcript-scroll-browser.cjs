const { app, BrowserWindow } = require("electron");

/**
 * Measures the conversation log's laid-out geometry in a real browser.
 *
 * The page it loads carries the REAL panel markup and the REAL stylesheet; this file
 * only supplies the height-bounded ancestors' viewport, opens find where the case asks
 * for it, and reads back what the layout actually did. Whether a log scrolls is a fact
 * about used height, and no amount of static markup assertion can produce one.
 */
app.whenReady().then(async () => {
  try {
    const htmlPath = process.argv.at(-1);
    const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
    await window.loadFile(htmlPath);

    const measured = await window.webContents.executeJavaScript(`(() => {
      // Find opens by state, not by markup, so a static render is always closed. The bar
      // and the rail below are the real components' markup, moved into the two mount
      // points the panel documents (bar inside the wrapper, rail beside it).
      const find = JSON.parse(document.getElementById('find-markup').textContent);
      for (const host of document.querySelectorAll('[data-case$="-open"]')) {
        const split = host.querySelector('.find-split');
        split.dataset.find = 'open';
        host.querySelector('.find-logwrap').insertAdjacentHTML('afterbegin', find.bar);
        split.insertAdjacentHTML('beforeend', find.rail);
      }

      const out = {};
      for (const host of document.querySelectorAll('[data-case]')) {
        const box = host.firstElementChild;
        const log = host.querySelector('.transcript-log');
        const compose = host.querySelector('.transcript-compose');
        const rail = host.querySelector('.find-rail');
        const boxRect = box.getBoundingClientRect();
        const composeRect = compose.getBoundingClientRect();
        // Ask for the bottom and report where it landed: a log that cannot scroll
        // answers 0, which is the difference between "clipped" and "scrollable".
        log.scrollTop = 1e6;
        out[host.dataset.case] = {
          boxHeight: Math.round(boxRect.height),
          logHeight: log.clientHeight,
          contentHeight: log.scrollHeight,
          scrolledTo: Math.round(log.scrollTop),
          composeBottomOverflow: Math.round(composeRect.bottom - boxRect.bottom),
          composeHeight: Math.round(composeRect.height),
          railBottomOverflow: rail ? Math.round(rail.getBoundingClientRect().bottom - boxRect.bottom) : null,
          railHeight: rail ? Math.round(rail.getBoundingClientRect().height) : null,
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
