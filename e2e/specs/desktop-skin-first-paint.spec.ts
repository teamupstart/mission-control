import { createServer, request } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";

/**
 * The desktop window opens in the chosen skin, with no dark frame first.
 *
 * Electron paints its window before the dashboard has loaded, so a light skin would open on a
 * dark frame unless the shell already knows the skin's background. The unit layer proves the
 * helpers and the handler in isolation; only this file runs the production `createWindow`, the
 * production preload and the production `mission:set-window-background` handler together, and
 * can therefore see the colour the window is constructed with, the dashboard keeping it current
 * through the real bridge, and the next launch opening in what the dashboard last wrote.
 *
 * No agent is dispatched, so no binary runs and no tokens are spent.
 */

test.skip(process.platform !== "darwin", "the desktop shell requires the macOS GUI");

const EVIDENCE = artifactsDir("desktop-skin-first-paint");
const DAYLIGHT_BG = "#f5f7fa";
const DEFAULT_BG = "#0a0c0f";

function bundle(home: string): { windowModule: string; backgroundModule: string } {
  const options = {
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
    alias: { "@shared": join(process.cwd(), "src/shared") },
  } as const;
  const windowModule = join(home, "window.cjs");
  const backgroundModule = join(home, "window-background.cjs");
  buildSync({ ...options, entryPoints: ["src/main/window.ts"], outfile: windowModule });
  buildSync({ ...options, entryPoints: ["src/server/window-background.ts"], outfile: backgroundModule });
  return { windowModule, backgroundModule };
}

/** A proxy in front of the daemon that answers 503 until released, holding the startup page. */
async function gate(target: string): Promise<{ origin: string; release(): void; close(): Promise<void> }> {
  let ready = false;
  const server = createServer((incoming, outgoing) => {
    if (!ready) {
      outgoing.writeHead(503).end("Starting");
      return;
    }
    const upstream = request(new URL(incoming.url ?? "/", target), {
      method: incoming.method, headers: { ...incoming.headers, host: new URL(target).host },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 500, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing gate port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    release: () => { ready = true; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function launch(baseURL: string, home: string, modules: ReturnType<typeof bundle>): Promise<ElectronApplication> {
  return electron.launch({ args: [
    fileURLToPath(new URL("../fixtures/desktop-skin.cjs", import.meta.url)),
    baseURL, modules.windowModule, modules.backgroundModule, join(home, "electron-profile"),
  ] });
}

/** The colour the window was constructed with, before any page loaded. */
async function firstPaint(application: ElectronApplication): Promise<string> {
  await expect.poll(() => application.evaluate(() => Reflect.get(globalThis, "firstPaintBackground") ?? null))
    .not.toBeNull();
  return String(await application.evaluate(() => Reflect.get(globalThis, "firstPaintBackground"))).toLowerCase();
}

async function liveBackground(application: ElectronApplication): Promise<string> {
  return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase());
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/desktop-skin-first-paint/${name}.png`);
}

test("the desktop window opens in the remembered skin background, and the dashboard keeps it current", async ({ daemon }) => {
  assertElectronGuiLaunchAllowed();
  const stored = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skin: "daylight" }),
  });
  expect(stored.ok).toBe(true);
  // What an earlier session under Daylight left behind.
  const file = join(daemon.home, "window-background.json");
  writeFileSync(file, `${JSON.stringify({ color: DAYLIGHT_BG })}\n`);
  const remembered = (): string => (JSON.parse(readFileSync(file, "utf8")) as { color: string }).color;
  const modules = bundle(daemon.home);

  let application: ElectronApplication | undefined = await launch(daemon.baseURL, daemon.home, modules);
  try {
    // ---- the first frame is Daylight's, not the dark pre-skin colour ----
    expect(await firstPaint(application), "the window was constructed dark under a light skin").toBe(DAYLIGHT_BG);
    // Read from the same file the handler writes, not one this spec guessed at.
    expect(await application.evaluate(() => Reflect.get(globalThis, "windowBackgroundFile"))).toBe(file);

    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Dispatch", exact: true }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-skin", "daylight");
    expect(await liveBackground(application)).toBe(DAYLIGHT_BG);
    await shoot(page, "desktop-daylight");

    // ---- picking Default in the desktop dashboard repaints the window and remembers it ----
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Display" }).click();
    const picker = page.getByRole("radiogroup", { name: "Skin" });
    await picker.getByRole("radio", { name: "Default", exact: true }).check();
    await expect.poll(() => liveBackground(application!)).toBe(DEFAULT_BG);
    await expect.poll(remembered).toBe(DEFAULT_BG);

    // ---- the bridge refuses a value that is not a colour, and nothing changes ----
    const refused = await page.evaluate(() =>
      window.missionDesktop!.setWindowBackground!("url(evil)").then(() => "accepted", () => "refused"),
    );
    expect(refused).toBe("refused");
    expect(remembered()).toBe(DEFAULT_BG);
    expect(await liveBackground(application)).toBe(DEFAULT_BG);

    // ---- back to Daylight, then quit: the dashboard, not the seed, decides the next launch ----
    await picker.getByRole("radio", { name: "Daylight", exact: true }).check();
    await expect.poll(() => liveBackground(application!)).toBe(DAYLIGHT_BG);
    await expect.poll(remembered).toBe(DAYLIGHT_BG);
    await application.close();
    application = undefined;

    application = await launch(daemon.baseURL, daemon.home, modules);
    expect(await firstPaint(application), "the relaunch opened on a dark frame").toBe(DAYLIGHT_BG);
    const relaunched = await application.firstWindow();
    await expect(relaunched.getByRole("button", { name: "Dispatch", exact: true }).first()).toBeVisible();
    await expect(relaunched.locator("html")).toHaveAttribute("data-skin", "daylight");
    await shoot(relaunched, "desktop-daylight-relaunch");
  } finally {
    await application?.close();
  }
});

test("Daylight chosen in a browser opens the first desktop launch light, startup page included", async ({ daemon, page }) => {
  assertElectronGuiLaunchAllowed();
  // The desktop app has never run: no launch colour is remembered.
  const file = join(daemon.home, "window-background.json");
  rmSync(file, { force: true });

  // ---- the operator picks Daylight in a plain browser tab, which has no desktop bridge ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const picker = page.getByRole("radiogroup", { name: "Skin" });
  await picker.getByRole("radio", { name: "Daylight", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-skin", "daylight");
  expect(await page.evaluate(() => window.missionDesktop === undefined), "this tab is not the desktop app").toBe(true);
  // The daemon, not the bridge, left the launch colour for the shell.
  await expect.poll(() => existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { color: string }).color)
    .toBe(DAYLIGHT_BG);
  await page.close();

  // ---- first desktop launch, held on the startup page until the daemon is "ready" ----
  const held = await gate(daemon.baseURL);
  let application: ElectronApplication | undefined;
  try {
    application = await launch(held.origin, daemon.home, bundle(daemon.home));
    expect(await firstPaint(application), "the first launch was constructed on a dark frame").toBe(DAYLIGHT_BG);
    const window = await application.firstWindow();
    await expect(window.getByRole("heading", { name: "Starting Mission Control", exact: true })).toBeVisible();
    // The page the operator waits on is Daylight too, not a dark slab between two light ones.
    expect(await window.evaluate(() => ({
      background: getComputedStyle(document.documentElement).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }))).toEqual({ background: "rgb(245, 247, 250)", scheme: "light" });
    await shoot(window, "desktop-startup-daylight");

    // Sample every frame of the dashboard document from its first: the skin on <html>, its
    // color-scheme and the body background, in each animation frame - which runs before that
    // frame paints. This profile has no local preference cache, so anything that paints from the
    // cache would show Default. Before the stylesheet (loaded with the app's JS chunk) applies,
    // the body is transparent and what paints is the canvas of <html>'s color-scheme.
    await window.addInitScript(() => {
      if (!location.href.startsWith("http")) return;
      const frames: Array<{ skin: string | null; scheme: string | null; bg: string | null }> = [];
      Reflect.set(window, "__skinFrames", frames);
      const sample = (): void => {
        const html = document.documentElement;
        frames.push({
          skin: html?.getAttribute("data-skin") ?? null,
          scheme: html ? getComputedStyle(html).colorScheme : null,
          bg: document.body ? getComputedStyle(document.body).backgroundColor : null,
        });
        if (frames.length < 240) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    held.release();
    await expect(window.getByRole("button", { name: "Dispatch", exact: true }).first()).toBeVisible();
    await expect(window.locator("html")).toHaveAttribute("data-skin", "daylight");
    // ---- no frame of the dashboard was Default: the served document carried the skin ----
    await expect.poll(() => window.evaluate(() => (Reflect.get(window, "__skinFrames") as unknown[] | undefined)?.length ?? 0))
      .toBeGreaterThan(30);
    const frames = await window.evaluate(() =>
      Reflect.get(window, "__skinFrames") as Array<{ skin: string | null; scheme: string | null; bg: string | null }>);
    const painted = frames.filter((frame) => frame.bg !== null);
    expect(painted.length, "no frame was sampled with a body").toBeGreaterThan(0);
    // Light in every frame: Daylight's own background once styled, and before that a light
    // canvas, never Default's #0a0c0f or a dark canvas.
    const light = (frame: { skin: string | null; scheme: string | null; bg: string | null }): boolean =>
      frame.skin === "daylight" && frame.scheme === "light"
      && (frame.bg === "rgb(245, 247, 250)" || frame.bg === "rgba(0, 0, 0, 0)");
    expect(painted.filter((frame) => !light(frame)), "a dashboard frame did not paint the stored Daylight").toEqual([]);
    expect(painted.at(-1)?.bg, "the dashboard never reached Daylight's background").toBe("rgb(245, 247, 250)");
    expect(await liveBackground(application)).toBe(DAYLIGHT_BG);
    await shoot(window, "desktop-first-launch-daylight");
  } finally {
    try { await application?.close(); } finally { await held.close(); }
  }
});
