const { readFile } = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");

/**
 * Reports the height each strip gives up to a scrollbar. `.probe-plain` is the same scroller
 * without the product's rule, so the caller can tell the rule's effect from the platform's,
 * and `#fits` holds one card so the non-overflowing case can be measured too.
 */
app.whenReady().then(async () => {
  try {
    const appCssPath = process.argv[process.argv.length - 1];
    const appCss = await readFile(appCssPath, "utf8");
    const window = new BrowserWindow({ show: false, width: 640, height: 480 });
    // Cards wide enough that a 600px strip cannot hold them, so both scrollers overflow and
    // a scrollbar is due in each. `flex: none` is what the real stage cards carry.
    const cards = Array.from({ length: 6 }, (_, index) =>
      `<section class="wf-pipeline-stage" style="flex:none;width:200px">
         <header class="wf-pipeline-stage-head">
           <span class="wf-pipeline-stage-name">Stage ${index + 1}</span>
         </header>
       </section>`).join("");
    // One card cannot overflow a 600px strip, so no scrollbar is due and its height is the
    // padding alone.
    const oneCard = cards.slice(0, cards.indexOf("</section>") + "</section>".length);
    const html = `<!doctype html><style>${appCss}
      .probe { width: 600px; }
      /* The strip's own box, minus the one rule under test. */
      .probe-plain {
        display: flex;
        align-items: stretch;
        gap: 0;
        padding: 4px 2px 12px;
        overflow-x: auto;
        overflow-y: hidden;
      }
      </style>
      <div class="wf-pipeline-strip probe" id="strip">${cards}</div>
      <div class="probe-plain probe" id="plain">${cards}</div>
      <div class="wf-pipeline-strip probe" id="fits">${oneCard}</div>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const measured = await window.webContents.executeJavaScript(`(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        return {
          reserved: el.offsetHeight - el.clientHeight,
          overflow: el.scrollWidth - el.clientWidth,
        };
      };
      return { strip: read('strip'), plain: read('plain'), fits: read('fits') };
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
