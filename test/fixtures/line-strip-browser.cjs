const { app } = require("electron");
const {
  budgetFromArgv,
  measurePages,
  pagesFromArgv,
  viewportFromArgv,
} = require("./measuring-window.cjs");

/**
 * Measures the Line strip's laid-out geometry in a real browser.
 *
 * One page per case, because two of the cases are full-height app shells (`height: 100dvh`)
 * and a shell is not a thing you can put two of on one page - the second would be measured
 * against a viewport the first had already filled.
 *
 * Which makes the window's size a shared premise of every number here rather than a detail:
 * the cases are compared with each other, and two pages measured in two different windows
 * disagree about `100dvh` boxes by exactly the amount the window moved. `measuring-window`
 * is what holds that premise up and what reports it when it cannot - see the long note at
 * the top of it.
 *
 * Every page carries the REAL strip markup and the REAL stylesheet. This file supplies only
 * the viewport and reads back what the layout actually did.
 */
const MEASURE = `() => {
  const line = document.querySelector('.line');
  const lineRect = line.getBoundingClientRect();
  const body = document.querySelector('.console');
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
    // One line each, and clipped rather than wrapped when the sentence is long. A
    // sub that wrapped would grow the whole strip and step the board down a line.
    subHeights: subs.map((s) => s.clientHeight),
    subOverflows: subs.map((s) => s.scrollWidth - s.clientWidth),
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
    process.stdout.write(`${JSON.stringify(measured)}\n`);
    app.quit();
  } catch (error) {
    console.error(error);
    // One turn of the loop so that message reaches the terminal - `app.exit` does not wait
    // for a pipe - and then a non-zero status. `process.exitCode` does not survive Electron's
    // quit path, so this used to fail with status 0, and a fixture that fails with status 0
    // reaches its test as an empty payload and a JSON parse error naming neither.
    setImmediate(() => app.exit(1));
  }
});
