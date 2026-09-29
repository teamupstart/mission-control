import { createServer, request } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { _electron as electron, type Page } from "playwright";
import { expect, test } from "../fixtures/test.ts";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";

test.skip(process.platform !== "darwin", "the desktop shell requires the macOS GUI");

async function gatedDaemon(target: string) {
  let ready = false;
  let failDashboard = false;
  let dashboardStatus = 200;
  let dashboardRequests = 0;
  const server = createServer((incoming, outgoing) => {
    if (incoming.url === "/") dashboardRequests++;
    if (ready && failDashboard && incoming.url === "/") {
      outgoing.destroy();
      return;
    }
    if (ready && dashboardStatus >= 400 && incoming.url === "/") {
      outgoing.writeHead(dashboardStatus, { "content-type": "text/html" }).end("<h1>Dashboard temporarily unavailable</h1>");
      return;
    }
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
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    release: () => { ready = true; failDashboard = false; dashboardStatus = 200; },
    loseNavigation: () => { ready = true; failDashboard = true; },
    httpError: (status: number) => { ready = true; dashboardStatus = status; },
    dashboardRequests: () => dashboardRequests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function evidence(page: Page, name: string) {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = "e2e/.artifacts/desktop-startup";
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

for (const scenario of ["late readiness", "timeout and retry", "readiness after timeout", "navigation loss", "HTTP 404", "HTTP 503", "local page failure", "local page cancellation"] as const) {
  test(`desktop startup recovers from ${scenario}`, async ({ daemon }) => {
    assertElectronGuiLaunchAllowed();
    const gate = await gatedDaemon(daemon.baseURL);
    const windowModule = join(daemon.home, "window.cjs");
    buildSync({
      entryPoints: ["src/main/window.ts"], outfile: windowModule,
      bundle: true, platform: "node", format: "cjs", external: ["electron"],
      alias: { "@shared": join(process.cwd(), "src/shared") },
    });
    const application = await electron.launch({ args: [
      fileURLToPath(new URL("../fixtures/desktop-startup.cjs", import.meta.url)),
      gate.origin, windowModule, join(daemon.home, "electron-profile"), scenario,
    ] });
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole("heading", { name: "Starting Mission Control", exact: true })).toBeVisible();
      await evidence(page, "starting");
      if (scenario === "local page cancellation") {
        await application.evaluate(({ app }) => { app.emit("fixture:stop-startup"); });
        expect(await application.evaluate(() => Reflect.get(globalThis, "startupPageStopped"))).toBe(true);
        gate.release();
        await page.waitForTimeout(2200);
        expect(gate.dashboardRequests()).toBe(0);
        return;
      } else if (scenario === "local page failure") {
        expect(await application.evaluate(() => Reflect.get(globalThis, "startupPageFailures"))).toBe(1);
      } else if (scenario === "late readiness") {
        // Cross the old 15-second retry budget before making health reachable.
        await page.waitForTimeout(17_000);
        await expect(page.getByRole("heading", { name: "Starting Mission Control", exact: true })).toBeVisible();
      } else if (scenario === "navigation loss" || scenario === "HTTP 404" || scenario === "HTTP 503") {
        if (scenario === "navigation loss") gate.loseNavigation();
        else gate.httpError(scenario === "HTTP 404" ? 404 : 503);
        await expect(page.getByRole("heading", { name: "Reconnecting to Mission Control" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Retry now" })).toBeVisible();
        await evidence(page, "reconnecting");
      } else {
        // Advance the native clock, leaving the production timeout and polling unchanged.
        await application.evaluate(() => {
          const now = Date.now();
          Date.now = () => now + 61_000;
        });
        await expect(page.getByRole("heading", { name: "Still starting Mission Control" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Retry now" })).toBeVisible();
        await evidence(page, "delayed");
        if (scenario === "timeout and retry") {
          await page.getByRole("link", { name: "Retry now" }).click();
          await expect(page.getByRole("heading", { name: "Starting Mission Control", exact: true })).toBeVisible();
        }
      }
      if (scenario !== "navigation loss" && scenario !== "HTTP 404" && scenario !== "HTTP 503") expect(gate.dashboardRequests()).toBe(0);
      gate.release();
      await expect(page.getByRole("button", { name: "Dispatch" }).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "Starting Mission Control", exact: true })).toHaveCount(0);
      await evidence(page, "ready");
      const requests = gate.dashboardRequests();
      // A completed startup must not keep navigating over an active dashboard.
      await page.waitForTimeout(2200);
      expect(gate.dashboardRequests()).toBe(requests);
    } finally {
      await application.close();
      await gate.close();
    }
  });
}
