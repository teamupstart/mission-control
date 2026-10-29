import { connect, createServer, type Socket } from "node:net";
import { test, expect } from "../fixtures/test.ts";
import { startDevDashboard } from "../fixtures/dev-dashboard.ts";

// A byte-for-byte tunnel, like SSM or ssh -L: no HTTP header rewriting and only one port.
async function forward(baseURL: string) {
  const target = new URL(baseURL);
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing tunnel address");
  return {
    port: address.port,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("the development dashboard boots through its diagnostic entry", async ({ page, daemon }) => {
  const dev = await startDevDashboard(daemon);
  try {
    await page.goto(`${dev.origin}/#/fleet`);
    await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  } finally {
    await page.goto("about:blank");
    dev.stop();
  }
});

// The reveal is a delayed CSS animation, so `animationstart` fires exactly when the hint paints.
function recordStartupHint() {
  addEventListener("animationstart", (event) => {
    if (event.animationName === "startup-pending-reveal") (window as { startupHintShown?: boolean }).startupHintShown = true;
  }, true);
}
const startupHintShown = () => (window as { startupHintShown?: boolean }).startupHintShown === true;

test("a blocked entry script leaves actionable HTML instead of an empty root", async ({ page, daemon }) => {
  await page.addInitScript(recordStartupHint);
  await page.route("**/assets/app-*.js", (route) => route.abort());
  await page.goto(daemon.baseURL);
  const heading = page.getByRole("heading", { name: "Loading Mission Control" });
  // Held back for two seconds so a start that is merely in progress shows nothing.
  expect(await heading.isVisible()).toBe(false);
  await expect(heading).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Console and Network");
  expect(await page.evaluate(startupHintShown)).toBe(true);
});

test("a healthy load never paints the troubleshooting hint", async ({ page, daemon }) => {
  await page.addInitScript(recordStartupHint);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  // Past the reveal delay: had the placeholder survived this long, the animation would have started.
  await page.waitForFunction(() => performance.now() > 2_500);
  expect(await page.evaluate(startupHintShown)).toBe(false);
  await expect(page.getByRole("heading", { name: "Loading Mission Control" })).toHaveCount(0);
});

test("a failed application chunk displays a startup diagnostic", async ({ page, daemon }) => {
  await page.route("**/assets/main-*.js", (route) => route.abort());
  await page.goto(daemon.baseURL);
  await expect(page.getByRole("alert")).toContainText("dashboard JavaScript could not load or initialize");
});

test("an exception during module initialization displays a startup diagnostic", async ({ page, daemon }) => {
  await page.addInitScript(() => Object.defineProperty(window, "missionDesktop", {
    get() { throw new Error("fixture private initialization detail"); },
  }));
  await page.goto(daemon.baseURL);
  await expect(page.getByRole("alert")).toContainText("dashboard JavaScript could not load or initialize");
  await expect(page.getByRole("alert")).not.toContainText("fixture private");
});

test("an uncaught React effect error leaves recovery instructions", async ({ page, daemon }) => {
  await page.addInitScript(() => {
    const original = window.addEventListener;
    window.addEventListener = function (...args: Parameters<typeof original>) {
      if (args[0] === "keydown") throw new Error("fixture private effect detail");
      return original.apply(this, args);
    };
  });
  const reported = page.waitForRequest((request) => request.url().endsWith("/api/telemetry/ingress")
    && (request.postData() ?? "").includes("mission.renderer.error"));
  await page.goto(daemon.baseURL);
  await expect(page.getByRole("alert")).toContainText("unexpected rendering error");
  await expect(page.getByRole("alert")).not.toContainText("fixture private");
  expect((await reported).postData()).not.toContain("fixture private");
});

for (const host of ["localhost", "127.0.0.1"]) {
  test(`built dashboard and SSE use one forwarded port on ${host}`, async ({ page, daemon }) => {
    const tunnel = await forward(daemon.baseURL);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://${host}:${tunnel.port}`;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      const snapshot = new Promise<void>((resolve) => cdp.on("Network.eventSourceMessageReceived", (event) => {
        if (JSON.parse(event.data).type === "snapshot") resolve();
      }));
      const events = page.waitForResponse((response) => response.url() === `${origin}/events`);
      await page.goto(`${origin}/#/fleet`);
      await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
      expect((await events).status()).toBe(200);
      await snapshot;
      await cdp.detach();
      expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
      // A browser POST has the forwarded Origin, not the daemon's listening port.
      const status = await page.evaluate(async () => (await fetch("/api/ui/config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ showToursOnStartup: false }),
      })).status);
      expect(status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      await page.goto("about:blank");
      await tunnel.stop();
    }
  });
}
