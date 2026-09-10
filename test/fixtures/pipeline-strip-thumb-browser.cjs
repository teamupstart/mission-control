const { readFile } = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Samples the colour the scrollbar thumb is actually painted, at rest and under the pointer.
 *
 * Reported against reference swatches carrying the same `color-mix()` declarations rather than
 * as raw channels, so the caller compares the thumb to what those declarations produce instead
 * of to numbers that would need rewriting whenever the theme moves.
 *
 * The thumb is found by scanning the scrollbar band for the run of pixels that differ from the
 * track, not by computing its width from the scroll ratio: thumb metrics and minimum lengths
 * are platform-specific, and this runs on macOS and on Linux CI.
 */
app.whenReady().then(async () => {
  try {
    const appCss = await readFile(process.argv[process.argv.length - 1], "utf8");
    const window = new BrowserWindow({ show: false, width: 700, height: 260 });
    const card = '<section class="wf-pipeline-stage" style="flex:none;width:200px">'
      + '<header class="wf-pipeline-stage-head"><span class="wf-pipeline-stage-name">S</span>'
      + "</header></section>";
    const html = `<!doctype html><style>${appCss}
      html, body { margin: 0; }
      .probe { width: 600px; }
      /* The two declarations under test, rendered as flat swatches on the same surface. A
         thumb painted from the same values composites to the same pixel. */
      .swatch { width: 120px; height: 20px; }
      #swatch-rest { background: color-mix(in oklab, var(--fg) 24%, transparent); }
      #swatch-hover { background: color-mix(in oklab, var(--fg) 38%, transparent); }
      </style>
      <div class="wf-pipeline-strip probe" id="strip">${card.repeat(6)}</div>
      <div class="swatch" id="swatch-rest"></div>
      <div class="swatch" id="swatch-hover"></div>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Mapped, not merely loaded. A window that was never shown produces no frames on a
    // virtual display, so `capturePage` came back empty on CI while working on a desktop.
    // `showInactive` keeps it from stealing focus from whoever is running the suite, and it
    // is also what lets a synthesised mouse move reach the scrollbar widget below.
    window.showInactive();
    await wait(150);

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

    const read = async () => {
      const image = await window.webContents.capturePage();
      const bitmap = image.toBitmap();
      const size = image.getSize();
      if (!size.width || !size.height || bitmap.length < size.width * size.height * 4) {
        throw new Error(`capturePage returned an unusable frame: ${size.width}x${size.height},`
          + ` ${bitmap.length} bytes`);
      }
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
      return {
        track,
        thumbWidth: best.to - best.from + 1,
        thumb: best.from < 0 ? null : at(geometry.left + Math.round((best.from + best.to) / 2), geometry.band),
        // A corner of a rounded thumb is not the thumb's own colour.
        thumbCorner: best.from < 0 ? null
          : at(geometry.left + best.from, geometry.band - Math.round(geometry.track / 2) + 1),
        swatchRest: at(geometry.rest.x, geometry.rest.y),
        swatchHover: at(geometry.hover.x, geometry.hover.y),
      };
    };

    const rest = await read();
    // Park the pointer on the thumb and let the scrollbar repaint. Polled rather than slept
    // once: a repaint under a virtual display is slower than on a desktop.
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: geometry.left + Math.round(rest.thumbWidth / 2),
      y: geometry.band,
    });
    let hovered = rest;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(120);
      hovered = await read();
      if (hovered.thumb && rest.thumb && hovered.thumb.join() !== rest.thumb.join()) break;
    }

    process.stdout.write(`${JSON.stringify({ geometry, rest, hovered })}\n`);
    window.destroy();
  } catch (error) {
    // On stdout, not stderr: `app.quit()` below exits 0 regardless of `process.exitCode`, so
    // anything written to stderr reaches the caller as an empty stdout and a JSON parse error
    // rather than as the reason.
    process.stdout.write(`${JSON.stringify({ error: String(error && error.stack || error) })}\n`);
  } finally {
    app.quit();
  }
});
