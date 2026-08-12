const { BrowserWindow } = require("electron");

/**
 * One offscreen window, one page at a time, each measured in a viewport it has to report.
 *
 * `line-strip-browser.cjs` and `line-drawer-browser.cjs` both load a series of full-height
 * app shells into a window and hand the numbers to a test that compares them ACROSS pages.
 * That comparison rests on something neither fixture used to check: that every page was laid
 * out in the window the fixture asked for.
 *
 * It is not a theoretical worry, and the error is not small. `.card.expanded` is
 * `calc(100dvh - var(--topbar-h) - var(--cmdbar-clearance) - 28px)`, and the grid cases pin
 * both tokens inline - so the card's measured height IS the viewport minus 180px, a reading
 * of the window with no layout in it at all. CI produced `720 !== 693` from exactly that:
 * four pages measured in a 900px window and the fifth in an 873px one. Both cards were
 * correct. The test called it a regression in the Line strip, which is the opposite of what
 * had happened, and the strip is where somebody would then have gone looking.
 *
 * Where the 27px comes from is worth writing down, because it is neither random nor a wobble.
 * `new BrowserWindow({ height: 900 })` asks for a WINDOW 900px tall, frame included. Measured
 * on Linux, the page inside one reports a 900px viewport for the first few milliseconds and
 * an 873px one from the moment the frame is realised - 84ms and 95ms after `loadFile`, in a
 * 2-core container. Which side of that a page lands on is a race with however long its own
 * load took, and a busy machine can put four pages on one side of it and the fifth on the
 * other. So the fix is to stop asking for the wrong box:
 *
 *  1. **Ask for the page box, not the window.** `useContentSize` makes the requested size
 *     mean the box `dvh` resolves against, which is the box every assertion in those tests
 *     is really about, and it is settled before the document exists rather than 11ms after
 *     it. It also makes one number true on both platforms: the same fixture was measuring
 *     1400x868 on macOS and 1400x900 under Xvfb, and the comment above the drawer's height
 *     budget - "in a 900px window" - was only ever true on CI.
 *  2. **Insist on it, from the main process.** A new window is clamped to the display, which
 *     under `xvfb-run`'s default 1280x1024 screen silently narrows it to 1280. A later
 *     `setContentSize` is not clamped, and neither call has to ask the renderer anything.
 *  3. **Report the viewport the page was measured in, and measure again if it was wrong.**
 *     The size is read in the same evaluation as the geometry, where layout cannot move
 *     between two statements, so it describes those rects and no others. A case that still
 *     comes back from the wrong window keeps its numbers and is labelled with them, so the
 *     test fails with a window size in the message instead of blaming a stylesheet nobody
 *     touched.
 *
 * ## Why the waiting is not a poll
 *
 * The obvious shape for (3) is to poll `innerHeight` from here until it settles. Measured in
 * that same container, it is also broken: `webContents.executeJavaScript` is the one call in
 * this file that can lose a race with Chromium's frame swapping, and it loses it reliably
 * once a document is asked more than one thing. Polling the viewport and then measuring
 * hangs on the fourth page, every run, with "Render frame was disposed before WebFrameMain
 * could be accessed" and a promise that never settles - which a test can only experience as
 * the 240s launch timeout. A promise-returning script does the same, because Electron
 * answers it in a second message. One synchronous evaluation per document, which is what
 * these fixtures have always done, ran 6 pages for 6 results.
 *
 * So the only waiting here is a fresh document in a window that has already been made the
 * right size - which is a stronger guarantee than a settled poll anyway, because the page's
 * first layout happens at the size the test asked for rather than being corrected into it.
 */

/**
 * How many documents a case gets.
 *
 * The retries are for the three things that go wrong before a measurement exists: a window
 * that was the wrong size, which cannot be re-measured in place because that would be a
 * second evaluation of one document; a `file://` navigation Chromium simply refused; and a
 * call that stopped answering. None of the three is hypothetical. Running this fixture and
 * its sibling at once in a 2-core container failed 9 runs in 10 on stock `main`, mostly with
 * `ERR_FAILED` and no other detail - which reached the test as "Unexpected end of JSON
 * input", naming neither the page nor the cause.
 */
const ATTEMPTS = 3;

/** Between attempts, so a retry is a later moment and not the same one. */
const RETRY_MS = 50;

/**
 * How long one call into the browser gets before the attempt counts as failed.
 *
 * Generous - a page here is one file and one stylesheet, and a slow one loads in well under
 * a second - because the number's job is to bound a call that is never coming back, not to
 * police a slow one. It is a ceiling on ONE call; what bounds the run is the budget below.
 */
const CALL_TIMEOUT_MS = 10_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A call into the browser, bounded.
 *
 * `loadFile` and `executeJavaScript` can both stop answering when Chromium swaps a render
 * frame out from under them - the second one loudly ("Render frame was disposed before
 * WebFrameMain could be accessed") and then never settling at all. Unbounded, that is a
 * fixture that produces nothing for 240 seconds and a test that reports a launch timeout,
 * which says nothing about which page or which call. Bounded, it is one more attempt on a
 * fresh document, and a fresh document is exactly what clears it.
 */
function bounded(promise, what, ms) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms);
  });
  // A call that answers after its deadline has nobody waiting for it; catch it here so a
  // late rejection cannot take the process down as an unhandled one.
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Makes the window's page box the requested one, without asking the renderer anything.
 *
 * `getContentSize` is the browser process's own view of the box, so this catches the display
 * server's clamp on a new window before any document is loaded into it.
 */
function demandContentSize(browser, viewport) {
  const [width, height] = browser.getContentSize();
  if (width === viewport.width && height === viewport.height) return;
  browser.setContentSize(viewport.width, viewport.height);
}

/**
 * The one script a document is asked to run: measure, then say what it was measured in.
 *
 * `measure` is the SOURCE of a zero-argument function. The viewport is read after it and in
 * the same synchronous tail, so the size that comes back is the size those rects were laid
 * out in - a viewport read in a second call would be a different fact about a later moment.
 */
function measureSource(measure) {
  return `(() => {
    const geometry = (${measure})();
    return {
      ...geometry,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`;
}

const isViewport = (got, viewport) => got.width === viewport.width && got.height === viewport.height;

/**
 * `--viewport 1400x900`, as the test that owns the number wrote it on the command line.
 *
 * The size lives in the test rather than here because the test is where everything that
 * depends on it lives: it asks for a window and then refuses any case that came back
 * measured in a different one. One number, in the file that reads it.
 */
function viewportFromArgv(argv) {
  const flag = argv.indexOf("--viewport");
  const match = flag === -1 ? null : /^(\d+)x(\d+)$/.exec(argv[flag + 1] ?? "");
  if (!match) throw new Error("expected --viewport <width>x<height>");
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * `--budget-ms 210000`: how long the whole run gets to produce measurements.
 *
 * The test owns this for the same reason it owns the viewport, and for one more: the test is
 * what puts a timeout on this process, and being killed by that timeout is the one outcome
 * this fixture cannot explain. A budget derived from it there means the two cannot drift.
 *
 * A budget rather than an arithmetic argument about the per-call ceiling, because retries are
 * per PAGE: `ATTEMPTS` attempts of two `CALL_TIMEOUT_MS` calls is ~60s of worst case per
 * page, so any statement of the form "the ceiling leaves enough headroom" is really a
 * statement about how many cases a file happens to have today. This holds at 5 cases and at
 * 50 - the run stops on time and says which page it was on.
 */
function budgetFromArgv(argv) {
  const flag = argv.indexOf("--budget-ms");
  const match = flag === -1 ? null : /^\d+$/.exec(argv[flag + 1] ?? "");
  if (!match) throw new Error("expected --budget-ms <milliseconds>");
  return Number(match[0]);
}

/** `--pages a.html b.html …`, which is always last because it takes the rest of the line. */
function pagesFromArgv(argv) {
  const flag = argv.indexOf("--pages");
  if (flag === -1) throw new Error("expected --pages <path>…");
  return argv.slice(flag + 1);
}

/** Loads each page in turn and returns `{ [case name]: { …measurement, viewport } }`. */
async function measurePages({ paths, viewport, measure, budgetMs }) {
  const browser = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: viewport.width,
    height: viewport.height,
  });
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  // What one call gets: its own ceiling, or the rest of the run's budget if that is shorter.
  // Never below 1ms, because a call whose budget is already gone still has to fail with a
  // number somebody can read - and it fails into the budget check above, which explains it.
  const callTimeout = () => Math.max(1, Math.min(CALL_TIMEOUT_MS, left()));
  try {
    const measured = {};
    for (const htmlPath of paths) {
      const name = htmlPath.replace(/^.*\/(.+)\.html$/, "$1");
      let result = null;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (attempt > 1) await delay(RETRY_MS);
        // After the wait rather than before it, so the budget is checked against the moment
        // the calls below actually start and no call is ever given a deadline in the past.
        if (left() <= 0) {
          // The run's own answer, given while there is still time to print it. Whatever is
          // wrong, the page it was on and the pages it never reached are the two facts worth
          // having, and neither survives being killed by the caller's timeout.
          throw new Error(
            `${name}: out of time - the ${budgetMs}ms budget ran out with `
              + `${paths.length - Object.keys(measured).length} of ${paths.length} pages `
              + `unmeasured`,
          );
        }
        // Before the document, so its first layout is at the right size rather than being
        // resized into it afterwards.
        demandContentSize(browser, viewport);
        try {
          await bounded(browser.loadFile(htmlPath), `${name}: load`, callTimeout());
          result = await bounded(
            browser.webContents.executeJavaScript(measureSource(measure)),
            `${name}: measurement`,
            callTimeout(),
          );
        } catch (error) {
          // Thrown with the page and the call in it, on the last attempt, because the
          // alternative is what this used to do: exit quietly, and leave the test to report
          // a JSON parse error about a payload nobody wrote.
          if (attempt === ATTEMPTS) throw error;
          continue;
        }
        if (isViewport(result.viewport, viewport)) break;
      }
      if (!isViewport(result.viewport, viewport)) {
        // Reported, not thrown. The case's numbers are still worth having - the test needs
        // them to say what the window did to them - and a subprocess whose stdout is a JSON
        // payload is a poor place to explain anything.
        console.error(
          `[measuring-window] ${name} measured at `
            + `${result.viewport.width}x${result.viewport.height} after ${ATTEMPTS} attempts, `
            + `not the ${viewport.width}x${viewport.height} it asked for `
            + `(the window itself reports ${browser.getContentSize().join("x")})`,
        );
      }
      measured[name] = result;
    }
    return measured;
  } finally {
    browser.destroy();
  }
}

module.exports = { budgetFromArgv, measurePages, pagesFromArgv, viewportFromArgv };
