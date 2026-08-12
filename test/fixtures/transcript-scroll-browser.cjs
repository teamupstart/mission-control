const { app, BrowserWindow } = require("electron");

/**
 * Measures the conversation log's laid-out geometry in a real browser.
 *
 * The page it loads carries the REAL panel markup and the REAL stylesheet; this file
 * only supplies the height-bounded ancestors' viewport, arranges the case's state
 * (find open, activity disclosure expanded), and reads back what the layout actually
 * did. Whether a log scrolls is a fact about used height, and no amount of static
 * markup assertion can produce one.
 */
app.whenReady().then(async () => {
  try {
    const htmlPath = process.argv.at(-1);
    const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
    await window.loadFile(htmlPath);

    const measured = await window.webContents.executeJavaScript(`(() => {
      // Find opens by state, not by markup, so a static render is always closed. The bar
      // and the rail below are the real components' markup, moved into the two mount
      // points the panel documents (bar inside the wrapper, rail beside it). The panel
      // mounts find and Observed activity into ONE slot exclusively - a ternary the
      // render test pins - so opening find here also removes the activity rail, exactly
      // as React unmounting it would.
      const find = JSON.parse(document.getElementById('find-markup').textContent);
      for (const host of document.querySelectorAll('[data-case$="-open"]')) {
        const split = host.querySelector('.find-split');
        split.dataset.find = 'open';
        host.querySelector('.activity-rail')?.remove();
        host.querySelector('.find-logwrap').insertAdjacentHTML('afterbegin', find.bar);
        split.insertAdjacentHTML('beforeend', find.rail);
      }
      // The narrow disclosure opens by state too; flip the attribute the stylesheet keys on.
      for (const host of document.querySelectorAll('[data-case$="-expanded"]')) {
        host.querySelector('.activity-rail').dataset.open = 'true';
      }

      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const out = {};
      for (const host of document.querySelectorAll('[data-case]')) {
        const box = host.firstElementChild;
        const log = host.querySelector('.transcript-log');
        const compose = host.querySelector('.transcript-compose');
        const rail = host.querySelector('.find-rail');
        const split = host.querySelector('.find-split');
        const activity = host.querySelector('.activity-rail');
        const toggle = host.querySelector('.activity-toggle');
        const body = host.querySelector('.activity-body');
        // The in-progress row at the tail of the log. Its height is a correctness fact,
        // not a style one: the log follows its tail only while the reader is within 48px
        // of the bottom, so a row that wrapped would push a pinned reader out of that
        // window and stop the pane following the conversation.
        const progress = host.querySelector('.turn-progress');
        const progressText = host.querySelector('.turn-progress-text');
        const boxRect = box.getBoundingClientRect();
        const composeRect = compose.getBoundingClientRect();
        // Ask for the bottom and report where it landed: a region that cannot scroll
        // answers 0, which is the difference between "clipped" and "scrollable".
        log.scrollTop = 1e6;
        let activityScrolledTo = null;
        let activityContentHeight = null;
        let activityViewHeight = null;
        if (body && visible(body)) {
          body.scrollTop = 1e6;
          activityScrolledTo = Math.round(body.scrollTop);
          activityContentHeight = body.scrollHeight;
          activityViewHeight = body.clientHeight;
        }
        // Where the secondary region sits relative to the log: beside it at rail
        // widths, below it once the container query stacks the split. A column that
        // "relocated" in the stylesheet but not in layout shows up here.
        const logRect = log.getBoundingClientRect();
        const below = (el) => el ? el.getBoundingClientRect().top >= logRect.bottom - 1 : null;
        out[host.dataset.case] = {
          boxHeight: Math.round(boxRect.height),
          logHeight: log.clientHeight,
          contentHeight: log.scrollHeight,
          scrolledTo: Math.round(log.scrollTop),
          composeBottomOverflow: Math.round(composeRect.bottom - boxRect.bottom),
          composeHeight: Math.round(composeRect.height),
          railBottomOverflow: rail ? Math.round(rail.getBoundingClientRect().bottom - boxRect.bottom) : null,
          railHeight: rail ? Math.round(rail.getBoundingClientRect().height) : null,
          railBelowLog: below(rail),
          activityBelowLog: below(activity),
          // The two-region frame must not leak out of its host sideways: a column that
          // does not fit shows up as a right edge past the pane's.
          splitRightOverflow: Math.round(split.getBoundingClientRect().right - boxRect.right),
          activityPresent: Boolean(activity),
          activityHeight: activity ? Math.round(activity.getBoundingClientRect().height) : null,
          activityBottomOverflow: activity
            ? Math.round(activity.getBoundingClientRect().bottom - boxRect.bottom)
            : null,
          activityToggleVisible: activity ? visible(toggle) : null,
          activityBodyVisible: activity ? visible(body) : null,
          activityContentHeight,
          activityViewHeight,
          activityScrolledTo,
          progressHeight: progress ? Math.round(progress.getBoundingClientRect().height) : null,
          progressRightOverflow: progress
            ? Math.round(progress.getBoundingClientRect().right - log.getBoundingClientRect().right)
            : null,
          progressClipped: progressText
            ? progressText.scrollWidth > progressText.clientWidth
            : null,
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
