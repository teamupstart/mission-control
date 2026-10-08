import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test as base } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * Settings > Telemetry on a Mac an organization manages, driven end to end.
 *
 * The organization is forced with `MISSION_ORGANIZATION=upstart` onto a collector this spec
 * runs on loopback - the only way the daemon will honour a force - so nothing here can reach
 * Upstart's real gateway. What this proves that the unit layer cannot: the panel a person
 * sees is view-only, the daemon refuses the write that view-only implies, and the default-on
 * lane reaches the collector in the Datadog-ready shape the preset names.
 */

const EVIDENCE = artifactsDir("telemetry-organization");

interface Collector {
  endpoint: string;
  /** Every metrics request body received, in order. */
  metrics: Uint8Array[];
  /** Answer with a Cloudflare-shaped 403 instead of accepting. */
  refuse: (refusing: boolean) => void;
  /** Answer with a plain 401, which the daemon treats as a rejected credential and pauses on. */
  unauthorized: () => void;
  close: () => Promise<void>;
}

async function startCollector(): Promise<Collector> {
  let refusing = false;
  let rejecting = false;
  const metrics: Uint8Array[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (rejecting) {
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("unauthorized");
        return;
      }
      if (refusing) {
        response.writeHead(403, {
          "cf-ray": "e2e-IAD",
          server: "cloudflare",
          "content-type": "text/html",
        });
        response.end("network refused");
        return;
      }
      if (request.url === "/v1/metrics") metrics.push(new Uint8Array(Buffer.concat(chunks)));
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    metrics,
    refuse: (value) => {
      refusing = value;
    },
    unauthorized: () => {
      rejecting = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// The collector has to exist before the daemon starts, because its address is the forced
// organization endpoint the daemon reads at launch.
const test = base.extend<{ collector: Collector }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
  collector: async ({}, use) => {
    const collector = await startCollector();
    try {
      await use(collector);
    } finally {
      await collector.close();
    }
  },
  daemonEnv: async ({ collector }, use) => {
    await use({
      MISSION_ORGANIZATION: "upstart",
      MISSION_ORGANIZATION_ENDPOINT: collector.endpoint,
    });
  },
});

base("an unmanaged installation does not show the notice or enable product telemetry", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/`);
  await expect(dashboard.getByRole("status", { name: "Upstart telemetry notice" })).toHaveCount(0);
  const response = await dashboard.request.get(`${daemon.baseURL}/api/telemetry/config`);
  expect(response.ok()).toBe(true);
  const settings = await response.json() as { config: { enabled: boolean; product: { enabled: boolean } }; organization: unknown };
  expect(settings.organization ?? null).toBeNull();
  expect(settings.config.enabled).toBe(false);
  expect(settings.config.product.enabled).toBe(false);
});

// ---- a minimal OTLP metrics reader: resource attributes, metric names, sum temporality ----

type Field = { field: number; value: number | Uint8Array };

function varint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
  throw new Error("truncated protobuf varint");
}

function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [tag, afterTag] = varint(bytes, offset);
    offset = afterTag;
    const wire = tag & 0x7;
    const field = tag >>> 3;
    if (wire === 0) {
      const [value, next] = varint(bytes, offset);
      out.push({ field, value });
      offset = next;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      out.push({ field, value: bytes.subarray(offset, offset + size) });
      offset += size;
    } else if (wire === 2) {
      const [length, next] = varint(bytes, offset);
      out.push({ field, value: bytes.subarray(next, next + length) });
      offset = next + length;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

const bytesOf = (list: Field[], field: number): Uint8Array[] =>
  list.filter((f) => f.field === field && f.value instanceof Uint8Array).map((f) => f.value as Uint8Array);
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

interface DecodedRequest {
  resource: Record<string, string>;
  metrics: Array<{ name: string; sumTemporality: number | null }>;
}

function decodeMetricsRequest(request: Uint8Array): DecodedRequest {
  const resource: Record<string, string> = {};
  const metrics: DecodedRequest["metrics"] = [];
  for (const resourceMetrics of bytesOf(fields(request), 1)) {
    const rm = fields(resourceMetrics);
    for (const res of bytesOf(rm, 1)) {
      for (const kv of bytesOf(fields(res), 1)) {
        const pair = fields(kv);
        resource[text(bytesOf(pair, 1)[0])] = text(bytesOf(fields(bytesOf(pair, 2)[0]!), 1)[0]);
      }
    }
    for (const scope of bytesOf(rm, 2)) {
      for (const metric of bytesOf(fields(scope), 2)) {
        const m = fields(metric);
        const sum = bytesOf(m, 7)[0];
        const temporality = sum ? fields(sum).find((f) => f.field === 2)?.value : undefined;
        metrics.push({
          name: text(bytesOf(m, 1)[0]),
          sumTemporality: typeof temporality === "number" ? temporality : null,
        });
      }
    }
  }
  return { resource, metrics };
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/telemetry-organization/${name}.png`);
}

test("the default-on notice appears once and its dismissal survives a daemon restart", async ({ dashboard, daemon }) => {
  await dashboard.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as Window & { testEventSource?: EventSource }).testEventSource = this;
      }
    };
  });
  await dashboard.reload();
  const notice = dashboard.getByRole("status", { name: "Upstart telemetry notice" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Mission Control usage telemetry is on for this Upstart-managed Mac.");
  await expect(notice).toContainText("Upstart manages this setting.");
  await expect(notice.getByRole("link", { name: "View telemetry" })).toHaveAttribute("href", "#/settings/telemetry");
  await shoot(dashboard, "00-default-on-notice");
  await dashboard.route("**/api/telemetry/organization/notice", (route) => route.abort());
  await notice.getByRole("button", { name: "Dismiss managed telemetry notice" }).click();
  await expect(notice.getByRole("alert")).toBeVisible();
  await expect(notice.getByRole("button", { name: "Dismiss managed telemetry notice" })).toBeEnabled();
  await dashboard.unroute("**/api/telemetry/organization/notice");
  await dashboard.evaluate(() => {
    const stream = (window as Window & { testEventSource?: EventSource }).testEventSource;
    if (!stream) throw new Error("the dashboard event stream was not created");
    stream.close();
  });
  await notice.getByRole("button", { name: "Dismiss managed telemetry notice" }).click();
  await expect(notice).toHaveCount(0);
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await expect(notice).toHaveCount(0);
});

test("a managed Mac shows Upstart's telemetry view-only, refuses edits, and sends by default", async ({
  dashboard,
  daemon,
  collector,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const panel = dashboard.locator("section.settings-section").filter({ hasText: "Managed by Upstart" });

  // The block, its evidence and the default-on state.
  await expect(panel.getByText("Managed by Upstart", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(
      `MISSION_ORGANIZATION forces Upstart on this daemon, sending to a collector on this machine (${collector.endpoint}).`,
    ),
  ).toBeVisible();
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toBeVisible();

  // The effective configuration, read-only.
  const configuration = panel.getByLabel("Managed telemetry configuration");
  await expect(configuration).toContainText("Product analytics");
  await expect(configuration).toContainText(collector.endpoint);
  await expect(configuration).toContainText("Delta");
  await expect(configuration).toContainText("Datadog lean");
  await expect(configuration).toContainText("Leaves out the mission.analytics.v1 cohort gauges");
  await expect(configuration).toContainText("corp");
  await expect(configuration).toContainText("Cloudflare edge");

  // Nothing on the page edits a setting: no switch, field, select, Save, purge or reset.
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /save/i })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /discard|clear|reset|remove/i })).toHaveCount(0);
  // What stays: Re-check and Test connection.
  await expect(
    panel.getByRole("button", { name: "Check again whether Upstart manages this Mac" }),
  ).toBeEnabled();
  await expect(
    panel.getByRole("button", { name: "Test the connection to Upstart's Datadog" }),
  ).toBeEnabled();
  await shoot(dashboard, "01-managed-default-on");

  // The daemon refuses the write the view-only panel implies.
  const refused = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { product: { enabled: true } },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({
    error: "Telemetry settings on this Mac are managed by Upstart",
    managedBy: "upstart",
  });

  // The retired pilot route cannot switch the managed lane off.
  const retired = await dashboard.request.post(
    `${daemon.baseURL}/api/telemetry/organization/pilot`,
    { data: { enrolled: false } },
  );
  expect(retired.status()).toBe(409);
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Test the connection to Upstart's Datadog" }),
  ).toBeEnabled();

  // Default-on survives a restart: the record re-asserts the rollout at start. The
  // restart is also the daemon's own first counted fact under the managed lane -
  // `mission.daemon.starts` - so the export below carries a real delta counter, not only
  // health gauges.
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toBeVisible();

  // A real export reaches the collector, in the preset's Datadog-ready shape.
  const decodedNow = () => collector.metrics.map(decodeMetricsRequest);
  const sumsIn = (decoded: DecodedRequest[]) =>
    decoded.flatMap((request) => request.metrics.filter((metric) => metric.sumTemporality !== null));
  await expect
    .poll(
      async () => {
        await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);
        return sumsIn(decodedNow()).length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const decoded = decodedNow();
  for (const request of decoded) {
    expect(request.resource["datadog.host.name"]).toBe("mission-control");
    expect(request.resource["deployment.environment.name"]).toBe("corp");
  }
  const names = decoded.flatMap((request) => request.metrics.map((metric) => metric.name));
  expect(names).toContain("mission.daemon.starts");
  expect(names.filter((name) => name.startsWith("mission.analytics.v1."))).toEqual([]);
  const sums = sumsIn(decoded);
  // OTLP's AggregationTemporality: 1 is DELTA.
  expect(sums.every((metric) => metric.sumTemporality === 1)).toBe(true);
  await shoot(dashboard, "02-default-on-sending");

  // A Cloudflare-shaped refusal reads as waiting for the Upstart network, not as a failure.
  // The restart queues a fresh `mission.daemon.starts` fact, so the next drain is certain to
  // have something to send into the refusal rather than depending on a health change.
  collector.refuse(true);
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await expect
    .poll(
      async () => {
        await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);
        return panel.getByText("Waiting for the Upstart network", { exact: true }).isVisible();
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
  await expect(
    panel.getByText(
      "Waiting for network access to Upstart's Datadog. Queued data is kept and sent when it can get through.",
    ),
  ).toBeVisible();
  await expect(panel.getByText(/^Stopped:/)).toBeHidden();
  await shoot(dashboard, "03-waiting-for-network");

  // Re-check runs detection again; the force still holds, so the Mac stays managed.
  await panel.getByRole("button", { name: "Check again whether Upstart manages this Mac" }).click();
  await expect(
    panel.getByText("Checked again: Upstart still manages telemetry on this Mac."),
  ).toBeVisible();
  await expect(panel.getByText("Managed by Upstart", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
});

test("a managed lane does not claim to be sending before its live status arrives", async ({
  dashboard,
  daemon,
}) => {
  // The stored configuration loads over HTTP; the live queue summary rides the event stream.
  // Holding the stream back leaves exactly the window where the panel knows the Mac is
  // on by default but not whether anything is being sent.
  await dashboard.route("**/events", (route) => route.abort());
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await dashboard.reload();
  const panel = dashboard
    .locator("section.settings-section")
    .filter({ hasText: "Managed by Upstart" });
  await expect(
    panel.getByText("Checking whether this Mac is sending to Upstart's Datadog", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toHaveCount(0);

  // Once the stream is back the summary arrives, and the line reports what it shows.
  await dashboard.unroute("**/events");
  await dashboard.reload();
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toBeVisible();
});

test("a managed lane the daemon paused says it stopped sending, and offers Try again", async ({
  dashboard,
  daemon,
  collector,
}) => {
  collector.unauthorized();
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const panel = dashboard.locator("section.settings-section").filter({ hasText: "Managed by Upstart" });

  // The collector rejects the credential, so the daemon pauses the destination. The state line
  // must not keep claiming the lane is sending.
  await expect
    .poll(
      async () => {
        await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);
        return panel.getByText("Stopped sending to Upstart's Datadog", { exact: true }).isVisible();
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toHaveCount(0);
  await expect(
    panel.getByText("Stopped: the destination rejected the credential. Fix it and use Try again."),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Try sending to Upstart's Datadog again" })).toBeEnabled();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await shoot(dashboard, "04-paused");
});

test("a Mac that left Upstart stays locked until its withdrawal is written, then becomes editable", async ({
  dashboard,
  daemon,
}) => {

  // The Mac leaves Upstart's management while its database refuses the telemetry write a
  // withdrawal needs - a full or locked disk.
  await daemon.crash();
  withDaemonDb(daemon, (db) =>
    db.exec(`CREATE TRIGGER fail_telemetry_write BEFORE UPDATE ON app_config
      WHEN NEW.key = 'telemetry' BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated)'); END`),
  );
  await daemon.restart({ MISSION_ORGANIZATION: "none", MISSION_ORGANIZATION_ENDPOINT: undefined });
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const panel = dashboard
    .locator("section.settings-section")
    .filter({ hasText: "Managed by Upstart" });

  // Still locked: the gateway is still stored, so the panel stays view-only and nothing sends.
  await expect(
    panel.getByText("Removing Upstart's telemetry settings", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(/removing Upstart's telemetry settings has not finished/),
  ).toBeVisible();
  await expect(panel.getByText("Sending to Upstart's Datadog", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  const refused = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: false },
  });
  expect(refused.status()).toBe(403);
  await expect(
    panel.getByText("These settings stay view-only until removing them finishes.", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/sets telemetry on this Mac/)).toHaveCount(0);
  await expect(
    panel.getByText("Nothing is sent to Upstart's Datadog until removing these settings finishes."),
  ).toBeVisible();
  await expect(panel.getByText(/no endpoint is configured/)).toHaveCount(0);
  // The successor daemon's event stream is up, so the capture shows a live dashboard.
  await expect(dashboard.getByText("live", { exact: true })).toBeVisible();
  await shoot(dashboard, "05-withdrawal-pending");

  // Once the store accepts the write again, Re-check completes the withdrawal and unlocks.
  withDaemonDb(daemon, (db) => db.exec("DROP TRIGGER IF EXISTS fail_telemetry_write"));
  await panel
    .getByRole("button", { name: "Check again whether Upstart manages this Mac" })
    .click();
  await expect(dashboard.getByText("Managed by Upstart", { exact: true })).toHaveCount(0);
  await expect(
    dashboard.getByLabel("Collect Mission Control telemetry on this machine"),
  ).toBeEnabled();
  await expect(dashboard.getByLabel("Product analytics endpoint")).toHaveValue("");
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: true },
  });
  expect(saved.status()).toBe(200);
});
