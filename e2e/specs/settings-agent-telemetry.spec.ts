import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Settings > Agent telemetry, in both of its states.
 *
 * Unmanaged: off by default; a person turns it on with an endpoint and a credential header,
 * and the daemon then relays an OTLP export to that endpoint while never handing the
 * credential back to the browser. Managed: a Claude Code managed policy that routes telemetry
 * makes the panel read-only and names only the hostname.
 *
 * The managed policy is `managed-settings.json` under a fixture root, never a plist, so this
 * runs on Linux CI where `plutil` does not exist. No agent is launched; no tokens are spent.
 */

const EVIDENCE = artifactsDir("settings-agent-telemetry");
const SECRET = "Bearer e2e-agent-otel-s3cret";

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page
    .locator("section.settings-section")
    .first()
    .screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-agent-telemetry/${name}.png`);
}

test.describe("unmanaged", () => {
  const received: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  let sink: Server;
  let sinkUrl = "";

  test.beforeAll(async () => {
    sink = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push({ url: req.url ?? "", headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  });
  test.afterAll(() => sink.close());

  test("agent telemetry turns on with an endpoint and relays without exposing its header", async ({
    dashboard,
    daemon,
  }) => {
    await dashboard.goto(`${daemon.baseURL}/#/settings/agent-telemetry`);
    await expect(dashboard.getByRole("tab", { name: /Agent telemetry/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const harnesses = dashboard.getByRole("list", { name: "Agent telemetry by harness" });
    await expect(harnesses).toContainText("Claude Code: Off.");
    await expect(harnesses).toContainText("Codex: Off.");
    await expect(harnesses).toContainText("Pi: Own extension.");

    const toggle = dashboard.getByLabel("Relay SDK agent telemetry", { exact: true });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();

    // Enabled with no endpoint is refused in the form, before the daemon is asked.
    await toggle.check();
    await expect(dashboard.getByText("Set an endpoint to turn this on.")).toBeVisible();
    const saveButton = dashboard.getByRole("button", { name: "Save agent telemetry" });
    await expect(saveButton).toBeDisabled();

    await dashboard.getByLabel("Agent telemetry endpoint").fill(sinkUrl);
    await dashboard.getByLabel("Agent telemetry header name").fill("Authorization");
    await dashboard.getByLabel("Agent telemetry header value").fill(SECRET);
    await dashboard.getByLabel("Capture user prompts").check();
    await saveButton.click();

    await expect(harnesses).toContainText("Claude Code: Relayed.");
    await expect(harnesses).toContainText("Codex: Relayed.");
    await expect(dashboard.getByText(/Stored: Authorization\./)).toBeVisible();
    // The value field is empty again, and the credential is nowhere in the page or the API.
    await expect(dashboard.getByLabel("Agent telemetry header value")).toHaveValue("");
    expect(await dashboard.content()).not.toContain("e2e-agent-otel-s3cret");
    const status = await (await dashboard.request.get(`${daemon.baseURL}/api/agent-telemetry`)).text();
    expect(status).not.toContain("e2e-agent-otel-s3cret");

    // An export the daemon receives is answered locally and a copy reaches the endpoint.
    const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
    const res = await dashboard.request.post(`${daemon.baseURL}/v1/logs`, {
      headers: { "content-type": "application/json", "x-harness-token": token },
      data: { resourceLogs: [] },
    });
    expect(res.status()).toBe(200);
    await expect.poll(() => received.find((r) => r.url === "/v1/logs")?.headers.authorization).toBe(SECRET);
    expect(received.find((r) => r.url === "/v1/logs")?.headers["x-harness-token"]).toBeUndefined();

    // Reopening the panel reads the daemon's counters again.
    await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
    await dashboard.goto(`${daemon.baseURL}/#/settings/agent-telemetry`);
    await expect(dashboard.getByLabel("Agent telemetry relay counters")).toContainText("Forwarded 1");
    await shoot(dashboard, "agent-telemetry-relaying");

    // And removing the header leaves the endpoint in place.
    await dashboard.getByRole("button", { name: "Remove stored header" }).click();
    await expect(dashboard.getByText(/Stored: Authorization/)).toHaveCount(0);
  });
});

test.describe("managed", () => {
  const policyRoot = mkdtempSync(join(tmpdir(), "mission-e2e-agent-otel-policy-"));
  const policyDir = join(policyRoot, "Library", "Application Support", "ClaudeCode");
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "managed-settings.json"),
    JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com:4318/v1/logs?tenant=t-1",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.com:4318/v1/metrics",
        OTEL_LOG_USER_PROMPTS: "1",
        // Never read out of the policy, and so never shown.
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer managed-s3cret",
      },
    }),
  );
  test.afterAll(() => rmSync(policyRoot, { recursive: true, force: true }));
  test.use({ daemonEnv: { MISSION_MANAGED_SETTINGS_ROOT: policyRoot } });

  test("a managed Claude Code policy makes agent telemetry read-only", async ({ dashboard, daemon }) => {
    await dashboard.goto(`${daemon.baseURL}/#/settings/agent-telemetry`);
    await expect(dashboard.getByRole("status").filter({ hasText: "Managed by your organization." })).toBeVisible();

    const toggle = dashboard.getByLabel("Relay SDK agent telemetry", { exact: true });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(dashboard.getByLabel("Agent telemetry endpoint")).toHaveCount(0);
    await expect(dashboard.getByRole("button", { name: "Save agent telemetry" })).toHaveCount(0);
    await expect(dashboard.getByLabel("Capture user prompts")).toBeChecked();
    await expect(dashboard.getByLabel("Capture user prompts")).toBeDisabled();

    const destinations = dashboard.getByRole("list", { name: "Managed agent telemetry destinations" });
    await expect(destinations).toContainText("Logs: otel.example.com");
    await expect(destinations).toContainText("Traces: not sent");

    const harnesses = dashboard.getByRole("list", { name: "Agent telemetry by harness" });
    await expect(harnesses).toContainText("Claude Code: Managed.");
    await expect(harnesses).toContainText("exports directly to otel.example.com");

    // Only a hostname crosses the wire, and a write is refused.
    const status = await (await dashboard.request.get(`${daemon.baseURL}/api/agent-telemetry`)).text();
    for (const secret of ["managed-s3cret", "4318", "tenant", "Authorization", policyRoot]) {
      expect(status).not.toContain(secret);
    }
    const write = await dashboard.request.put(`${daemon.baseURL}/api/agent-telemetry`, {
      data: { enabled: false },
    });
    expect(write.status()).toBe(409);
    await shoot(dashboard, "agent-telemetry-managed");
  });
});
