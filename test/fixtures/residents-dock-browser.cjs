const { app } = require("electron");
const {
  budgetFromArgv,
  measurePages,
  pagesFromArgv,
  viewportFromArgv,
} = require("./measuring-window.cjs");

/**
 * Measures the Residents dock against the real top bar in a real browser.
 *
 * Every page carries the REAL `Topbar` markup, rendered with the dock open, and the REAL
 * stylesheet. This file supplies only the viewport and reads back where the layout put the
 * bar, the dock's button and its panel.
 */
const MEASURE = `() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
  };
  const bar = document.querySelector('header.topbar');
  const style = getComputedStyle(bar);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const tallest = Math.max(0, ...[...bar.children].map((k) => k.offsetHeight));
  const panel = document.querySelector('.residents-pop');
  return {
    barRows: bar.clientHeight - padY > tallest + 2 ? 2 : 1,
    bar: rect(bar),
    foreman: rect(document.querySelector('.foremanbar')),
    button: rect(document.querySelector('.residents-btn')),
    panel: rect(panel),
    panelPosition: panel ? getComputedStyle(panel).position : null,
    rows: document.querySelectorAll('.residents-pop-row').length,
    // The page never scrolls sideways: the bar has to fit a phone-width window too.
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}`;

app.whenReady().then(async () => {
  try {
    const measured = await measurePages({
      paths: pagesFromArgv(process.argv),
      viewport: viewportFromArgv(process.argv),
      budgetMs: budgetFromArgv(process.argv),
      measure: MEASURE,
    });
    process.stdout.write(`${JSON.stringify(measured)}\n`, () => app.exit(0));
  } catch (error) {
    console.error(error);
    setImmediate(() => app.exit(1));
  }
});
