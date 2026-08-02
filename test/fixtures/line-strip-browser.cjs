const { app, BrowserWindow } = require("electron");

/**
 * Measures the Line strip's laid-out geometry in a real browser.
 *
 * One page per case, loaded in turn into the same window, because two of the cases are
 * full-height app shells (`height: 100dvh`) and a shell is not a thing you can put two of
 * on one page - the second would be measured against a viewport the first had already
 * filled.
 *
 * Every page carries the REAL strip markup and the REAL stylesheet. This file supplies only
 * the viewport and reads back what the layout actually did.
 */
app.whenReady().then(async () => {
  try {
    const paths = process.argv.slice(process.argv.indexOf("--pages") + 1);
    const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
    const out = {};

    for (const htmlPath of paths) {
      await window.loadFile(htmlPath);
      const measured = await window.webContents.executeJavaScript(`(() => {
        const line = document.querySelector('.line');
        const lineRect = line.getBoundingClientRect();
        const body = document.querySelector('.console');
        const card = document.querySelector('.card.expanded');
        const subs = [...document.querySelectorAll('.ls-sub')];
        return {
          // What the strip actually occupies, its own border box plus the space it
          // reserves under itself - which is what the board below it loses.
          lineHeight: Math.round(lineRect.height + parseFloat(getComputedStyle(line).marginBottom)),
          lineBoxHeight: Math.round(lineRect.height),
          stages: document.querySelectorAll('.line-stage').length,
          // A full-height shell must still END at the viewport: the strip has to take its
          // height out of the layout, not out of the screen.
          bodyBottomOverflow: body
            ? Math.round(body.getBoundingClientRect().bottom - window.innerHeight)
            : null,
          bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
          cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
          // One line each, and clipped rather than wrapped when the sentence is long. A
          // sub that wrapped would grow the whole strip and step the board down a line.
          subHeights: subs.map((s) => s.clientHeight),
          subOverflows: subs.map((s) => s.scrollWidth - s.clientWidth),
        };
      })()`);
      out[htmlPath.replace(/^.*\/(.+)\.html$/, "$1")] = measured;
    }

    process.stdout.write(`${JSON.stringify(out)}\n`);
    window.destroy();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
