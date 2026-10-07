import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("telemetry-network-wait");

async function startCollector(): Promise<{
  endpoint: string;
  accept: () => void;
  close: () => Promise<void>;
}> {
  let accepting = false;
  const server: Server = createServer((request, response) => {
    request.resume();
    if (accepting) {
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
      return;
    }
    response.writeHead(403, {
      "cf-ray": "e2e-IAD",
      server: "cloudflare",
      "content-type": "text/html",
    });
    response.end("network refused");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    accept: () => {
      accepting = true;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}

test("a gated Cloudflare refusal waits with its queue and recovers", async ({
  dashboard,
  daemon,
}) => {
  const collector = await startCollector();
  try {
    const configured = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
      data: {
        enabled: true,
        product: {
          enabled: true,
          endpoint: collector.endpoint,
          networkGate: "cloudflare-edge",
        },
      },
    });
    expect(configured.ok()).toBe(true);
    await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);

    const drained = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);
    expect(drained.ok()).toBe(true);
    await expect(
      dashboard.getByText(
        "Waiting for network access to this destination. Queued data is kept and sent when it can get through.",
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(dashboard.getByLabel("Share anonymous product analytics")).toBeChecked();
    await expect(
      dashboard.getByRole("img", {
        name: "A telemetry destination is waiting for network access",
      }),
    ).toBeVisible();
    await expect(dashboard.getByText(/^Stopped:/)).toBeHidden();
    await dashboard.locator('[data-anchor="telemetry/product"]').scrollIntoViewIfNeeded();
    await shoot(dashboard, "01-waiting");

    collector.accept();
    await dashboard.waitForTimeout(1_500);
    const retried = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);
    expect(retried.ok()).toBe(true);
    await expect(
      dashboard.getByText(
        "Waiting for network access to this destination. Queued data is kept and sent when it can get through.",
      ),
    ).toBeHidden({ timeout: 15_000 });
    await expect(
      dashboard.getByRole("img", {
        name: "A telemetry destination is waiting for network access",
      }),
    ).toBeHidden();
    await expect(dashboard.getByLabel("Share anonymous product analytics")).toBeChecked();
  } finally {
    await collector.close();
  }
});
