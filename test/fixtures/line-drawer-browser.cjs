const { app } = require("electron");
const { measurePages, pagesFromArgv, viewportFromArgv } = require("./measuring-window.cjs");

/**
 * Measures an open Line drawer's laid-out geometry in a real browser.
 *
 * The sibling of `line-strip-browser.cjs`, and it exists for the same reason: the three
 * claims this surface makes are all about USED HEIGHT, which no assertion on markup can
 * produce. The drawer is hard-capped and scrolls inside itself; the board below it moves down
 * by exactly the drawer's height and no more; and a session card is the same size with the
 * drawer open as with it shut.
 *
 * One page per case, because the shell cases are `height: 100dvh` and a viewport holds one
 * of those at a time. The last of those claims is a comparison BETWEEN two of those pages,
 * which is only a claim about the drawer while both were measured in the same window - so
 * the window is established and reported per page by `measuring-window`, whose note explains
 * what it costs when it is not.
 */
const MEASURE = `() => {
  const drawer = document.querySelector('.line-drawer');
  const body = document.querySelector('.line-drawer-body');
  const foot = document.querySelector('.line-drawer-foot');
  const shellBody = document.querySelector('.console');
  const card = document.querySelector('.card.expanded');
  const rows = [...document.querySelectorAll('.line-drawer-rows > li')];
  const first = rows[0]?.getBoundingClientRect() ?? null;
  return {
    rows: rows.length,
    // The optional footer, which sits OUTSIDE the capped body. Measured because that
    // placement is the whole claim: inside, it would scroll away with the rows and
    // would also eat into the three-row budget.
    footHeight: foot ? Math.round(foot.getBoundingClientRect().height) : null,
    footInsideBody: foot ? Boolean(body && body.contains(foot)) : null,
    // The drawer's whole footprint, which is what the board below it gives up.
    drawerHeight: drawer
      ? Math.round(
          drawer.getBoundingClientRect().height
          + parseFloat(getComputedStyle(drawer).marginTop)
          + parseFloat(getComputedStyle(drawer).marginBottom),
        )
      : null,
    // The capped, scrolling part. \`scrollHeight > clientHeight\` is the whole claim
    // about internal scroll - a body that grew to fit would report them equal.
    bodyClientHeight: body ? body.clientHeight : null,
    bodyScrollHeight: body ? body.scrollHeight : null,
    // Every row at ONE height, so three rows is a number and not an average.
    rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
    // The widest thing the row clipped rather than wrapped, across every field that
    // is allowed to clip. Which ONE overflows depends on the window - at a realistic
    // width four chips fit and the session name does not - so measuring a single
    // column would make the case pass or fail on the viewport rather than on the rule.
    rowOverflows: rows.map((row) => Math.max(0, ...[
      ...row.querySelectorAll(
        '.line-run-who strong, .line-run-wf, .line-run-chips, .line-run-state,'
        + ' .line-group-who strong, .line-group-mid,'
        + ' .line-bl-title, .line-bl-meta, .line-bl-marks',
      ),
    ].map((el) => el.scrollWidth - el.clientWidth))),
    firstRowTop: first ? Math.round(first.top) : null,
    // The two boxes the drawer must not resize.
    shellBodyHeight: shellBody
      ? Math.round(shellBody.getBoundingClientRect().height)
      : null,
    shellBodyTop: shellBody ? Math.round(shellBody.getBoundingClientRect().top) : null,
    shellBodyBottomOverflow: shellBody
      ? Math.round(shellBody.getBoundingClientRect().bottom - window.innerHeight)
      : null,
    cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
    cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null,
  };
}`;

app.whenReady().then(async () => {
  try {
    const measured = await measurePages({
      paths: pagesFromArgv(process.argv),
      viewport: viewportFromArgv(process.argv),
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
