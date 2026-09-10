const { readFile } = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the scrollbar thumb's two rules resolve to, and where possible what they paint.
 *
 * Two readings, because they are available in different places:
 *
 *  - `resolved` asks the engine what each rule's declared `background` actually computes to,
 *    by applying the declared string to a real element. That works anywhere a browser runs.
 *  - `painted` samples the rendered scrollbar band, at rest and with the pointer parked on the
 *    thumb. That needs a frame, and a frame is not always available: under the virtual display
 *    CI uses, `capturePage` fails outright with `UnknownVizError`, and offscreen rendering is
 *    the compositor path that still produces one. When neither does, this reports
 *    `painted: null` rather than failing, and the caller asserts the resolved contract only.
 *
 * A scrollbar pseudo-element has no computed style of its own and is not in the DOM, so these
 * two are the whole of what can be observed about it.
 */
app.whenReady().then(async () => {
  try {
    const appCss = await readFile(process.argv[process.argv.length - 1], "utf8");
    const window = new BrowserWindow({
      show: false,
      width: 700,
      height: 260,
      // Offscreen rendering, so a frame arrives without a mapped window. `capturePage` on a
      // hidden window returns nothing on a virtual display.
      webPreferences: { offscreen: true },
    });
    let frame = null;
    window.webContents.on("paint", (_event, _dirty, image) => { frame = image; });

    const card = '<section class="wf-pipeline-stage" style="flex:none;width:200px">'
      + '<header class="wf-pipeline-stage-head"><span class="wf-pipeline-stage-name">S</span>'
      + "</header></section>";
    const html = `<!doctype html><style>${appCss}
      html, body { margin: 0; }
      .probe { width: 600px; }
      .swatch { width: 120px; height: 20px; }
      #paint-marker { position: absolute; top: 0; left: 0; width: 1px; height: 1px; background: black; }
      </style>
      <div class="wf-pipeline-strip probe" id="strip">${card.repeat(6)}</div>
      <div class="swatch" id="swatch-rest"></div>
      <div class="swatch" id="swatch-hover"></div><div id="paint-marker"></div>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Resolve each rule's own declared value through the engine, and paint the two swatches
    // with it so a captured frame can be compared against them.
    const resolved = await window.webContents.executeJavaScript(`(() => {
      const declared = (selector, property) => {
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of rules) {
            if (rule.selectorText === selector) {
              return rule.style.getPropertyValue(property) || "";
            }
          }
        }
        return null;
      };
      const thumb = '.wf-pipeline-strip::-webkit-scrollbar-thumb';
      const paint = (id, value) => {
        const node = document.getElementById(id);
        if (value) node.style.background = value;
        return getComputedStyle(node).backgroundColor;
      };
      // This opaque marker changes in the same script as the swatches. Its pixel is a
      // receipt for their paint, unlike a paint-event counter that can include queued frames.
      document.getElementById('paint-marker').style.background = 'rgb(255, 0, 255)';
      const restDeclared = declared(thumb, 'background');
      const hoverDeclared = declared(thumb + ':hover', 'background');
      return {
        restDeclared,
        hoverDeclared,
        radiusDeclared: declared(thumb, 'border-radius'),
        trackHeight: declared('.wf-pipeline-strip::-webkit-scrollbar', 'height'),
        restComputed: paint('swatch-rest', restDeclared),
        hoverComputed: paint('swatch-hover', hoverDeclared),
      };
    })()`);

    const geometry = await window.webContents.executeJavaScript(`(() => {
      const strip = document.getElementById('strip');
      const box = strip.getBoundingClientRect();
      const centre = (id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      };
      return {
        left: Math.round(box.left),
        width: strip.clientWidth,
        band: Math.round(box.top + strip.offsetHeight - 5),
        track: strip.offsetHeight - strip.clientHeight,
        overflow: strip.scrollWidth - strip.clientWidth,
        rest: centre('swatch-rest'),
        hover: centre('swatch-hover'),
      };
    })()`);

    // The swatches are styled by the script above, which runs after the first frame. Sampling
    // without waiting for a later one reads them unpainted - that is what made CI report a
    // thumb of rgb(70, 72, 84) against a "declared" colour of rgb(20, 20, 32), which was just
    // the page showing through.
    const usable = () => {
      if (!frame) return null;
      const size = frame.getSize();
      const bitmap = frame.toBitmap();
      if (!size.width || !size.height || bitmap.length < size.width * size.height * 4) return null;
      if (bitmap[0] !== 255 || bitmap[1] !== 0 || bitmap[2] !== 255) return null;
      return { size, bitmap };
    };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (usable()) break;
      await wait(100);
    }

    const read = () => {
      const current = usable();
      if (!current) return null;
      const { size, bitmap } = current;
      // Electron hands back BGRA; the caller thinks in RGB.
      const at = (x, y) => {
        const i = (y * size.width + x) * 4;
        return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
      };
      const band = [];
      for (let x = geometry.left; x < geometry.left + geometry.width; x += 1) {
        band.push(at(x, geometry.band));
      }
      // The track is whatever the band's right-hand end is: the thumb cannot reach it while
      // the strip is scrolled to its start.
      const track = band[band.length - 2];
      const differs = (p) => Math.abs(p[0] - track[0]) + Math.abs(p[1] - track[1])
        + Math.abs(p[2] - track[2]) > 12;
      let start = -1;
      let best = { from: -1, to: -1 };
      band.forEach((pixel, index) => {
        if (differs(pixel)) {
          if (start < 0) start = index;
          if (index - start > best.to - best.from) best = { from: start, to: index };
        } else {
          start = -1;
        }
      });
      if (best.from < 0) return null;
      const swatchRest = at(geometry.rest.x, geometry.rest.y);
      return {
        track,
        thumbWidth: best.to - best.from + 1,
        thumb: at(geometry.left + Math.round((best.from + best.to) / 2), geometry.band),
        // A corner of a rounded thumb is not the thumb's own colour.
        thumbCorner: at(geometry.left + best.from, geometry.band - Math.round(geometry.track / 2) + 1),
        swatchRest,
        swatchHover: at(geometry.hover.x, geometry.hover.y),
      };
    };

    const rest = read();
    let hovered = null;
    if (rest) {
      window.webContents.sendInputEvent({
        type: "mouseMove",
        x: geometry.left + Math.round(rest.thumbWidth / 2),
        y: geometry.band,
      });
      // Polled rather than slept once: a repaint under a virtual display is slower.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(120);
        const next = read();
        if (next && next.thumb.join() !== rest.thumb.join()) { hovered = next; break; }
        hovered = next;
      }
    }

    process.stdout.write(`${JSON.stringify({
      resolved,
      geometry,
      painted: rest && hovered ? { rest, hovered } : null,
    })}\n`);
    window.destroy();
  } catch (error) {
    // On stdout, not stderr: `app.quit()` exits 0 regardless of `process.exitCode`, so stderr
    // reaches the caller as empty output and a JSON parse error rather than as the reason.
    process.stdout.write(`${JSON.stringify({ error: String((error && error.stack) || error) })}\n`);
  } finally {
    app.quit();
  }
});
