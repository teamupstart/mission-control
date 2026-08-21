const { app } = require("electron");
const {
  budgetFromArgv,
  measurePages,
  pagesFromArgv,
  viewportFromArgv,
} = require("./measuring-window.cjs");

/**
 * Measures the Feedback dialog's laid-out geometry in a real browser.
 *
 * The three claims it exists for are all facts about USED HEIGHT and USED WIDTH, which no
 * markup assertion can produce and which a Playwright spec would only notice by failing to
 * click something:
 *
 *  1. **The publish button is reachable.** The dialog carries a form AND a Markdown preview
 *     of everything that will go public, so it is the tallest confirm in the app. On a short
 *     window it has to scroll inside the backdrop rather than run off the bottom - if the
 *     footer's bottom sits below the viewport with nothing scrollable above it, the one
 *     control the whole dialog exists for cannot be pressed.
 *  2. **Nothing overflows sideways.** A long repository name, a refusal naming a CLI command
 *     and a Markdown body are all unbounded strings arriving from the daemon. Any one of them
 *     scrolling the page horizontally would push the dialog itself off-centre.
 *  3. **The disabled screenshot region is still drawn.** It is the affordance a later release
 *     enables, and a zero-height inert box would read as a rendering fault rather than as a
 *     deliberate "not yet".
 *
 * One page per case, because the backdrop is a `position: fixed` full-viewport layer and two
 * of them on one page would measure the second against a screen the first already filled.
 * That makes the window size a shared premise - see `measuring-window.cjs`.
 *
 * Every page carries the REAL dialog markup and the REAL stylesheet. This file supplies only
 * the viewport and reads back what the layout actually did.
 */
const MEASURE = `() => {
  const backdrop = document.querySelector('.modal-backdrop');
  const modal = document.querySelector('.feedback-modal');
  const foot = document.querySelector('.modal-foot');
  const shots = document.querySelector('.feedback-shots');
  const modalRect = modal.getBoundingClientRect();
  return {
    viewportHeight: window.innerHeight,
    modalHeight: Math.round(modalRect.height),
    modalWidth: Math.round(modalRect.width),
    // How far the footer's bottom edge sits past the window. Positive is fine ONLY when the
    // backdrop can scroll to it, which the next number answers.
    footBottomOverflow: Math.round(foot.getBoundingClientRect().bottom - window.innerHeight),
    backdropScrollable: backdrop.scrollHeight - backdrop.clientHeight,
    // Sideways overflow of the page and of the dialog. The unbounded strings the daemon
    // supplies land inside the second one.
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    modalOverflow: modal.scrollWidth - modal.clientWidth,
    shotsHeight: shots ? Math.round(shots.getBoundingClientRect().height) : null,
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
    // for a pipe - then a non-zero status, which `process.exitCode` would not survive.
    setImmediate(() => app.exit(1));
  }
});
