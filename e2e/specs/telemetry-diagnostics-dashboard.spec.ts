import { mkdirSync } from "node:fs";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("telemetry-diagnostics-dashboard");

/**
 * The walking slice through a browser: a captured fact reaching a panel a person can read, and
 * the trace navigation from that panel to the span explaining it.
 *
 * PREREQUISITE, and an explicit one rather than a silent skip. It needs the local reference
 * stack, which needs Docker:
 *
 *     npm run build
 *     npm run observability:up
 *     MC_E2E_OBSERVABILITY=1 npm run test:e2e -- e2e/specs/telemetry-diagnostics-dashboard.spec.ts --workers=1
 *
 * Without `MC_E2E_OBSERVABILITY` it skips with that command in the message, so an ordinary CI
 * run - which has no Docker - does not fail, and nobody can mistake a skipped run for a passing
 * proof. The phase's exit criteria require this to have been RUN, and its output attached.
 *
 * No model tokens are spent: the only thing dispatched here is the daemon's own start
 * observation and a synthetic connection probe, neither of which touches an agent.
 */
const GRAFANA = "http://127.0.0.1:13000";
const DASHBOARD = `${GRAFANA}/d/mission-telemetry-diagnostics`;
const OTLP = "http://127.0.0.1:14318";

test.skip(
  !process.env.MC_E2E_OBSERVABILITY,
  "needs the local observability stack: npm run observability:up, then MC_E2E_OBSERVABILITY=1",
);

test.describe.configure({ mode: "serial" });

test("a captured fact reaches a provisioned Grafana panel and its trace", async ({
  daemon,
  dashboard,
}) => {
  test.setTimeout(180_000);

  // 1. Opt this isolated daemon in and point it at the local Collector. Through the real route,
  //    because the route's validation is part of what is being exercised: a loopback HTTP
  //    Collector is the supported plaintext case, and anything else with a credential is not.
  const configured = await fetch(`${daemon.baseURL}/api/telemetry/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, user: { enabled: true, endpoint: OTLP } }),
  });
  expect(configured.ok, await configured.text()).toBe(true);

  // 2. Produce a fact. The probe sends a real empty OTLP request AND captures its own result
  //    through the durable path, so one call exercises both halves.
  const probed = await fetch(`${daemon.baseURL}/api/telemetry/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "user" }),
  });
  expect(probed.ok).toBe(true);
  const probe = (await probed.json()) as { outcome: string; traceId: string | null };
  expect(probe.outcome, "the local Collector accepted an OTLP request").toBe("accepted");
  expect(probe.traceId).toBeTruthy();

  // 3. Drain now rather than waiting out the thirty-second cadence. Same code the timer runs.
  const drained = await fetch(`${daemon.baseURL}/api/telemetry/drain`, { method: "POST" });
  expect(drained.ok).toBe(true);
  const cycle = (await drained.json()) as { batches: number; accepted: number };
  expect(cycle.accepted, "at least one batch was accepted by the Collector").toBeGreaterThan(0);

  // 4. And the health view an operator would check, which must agree.
  const health = (await (await fetch(`${daemon.baseURL}/api/telemetry/health`)).json()) as {
    enabled: boolean;
    installationId: string;
    profiles: Array<{ profile: string; exporting: boolean; accepted: number; pausedReason: string | null }>;
  };
  expect(health.enabled).toBe(true);
  expect(health.installationId).toMatch(/^[0-9a-f]{24}$/);
  const user = health.profiles.find((p) => p.profile === "user");
  expect(user?.exporting).toBe(true);
  expect(user?.pausedReason).toBeNull();
  expect(user?.accepted).toBeGreaterThan(0);

  // 5. The panels, SCOPED to this daemon's installation.
  //
  //    Scoping matters twice over. Prometheus keeps data across runs, so an unscoped panel
  //    would be reading some earlier run's totals and this spec would pass whether or not the
  //    daemon it just started exported anything. And it is the shape a real multi-installation
  //    rollup has to use anyway, so the filter is worth exercising rather than bypassing.
  const scoped = `from=now-6h&to=now&var-environment=local&var-installation=${health.installationId}`;
  await dashboard.goto(`${DASHBOARD}?${scoped}`);
  await expect(dashboard.getByText("Mission Control: telemetry diagnostics")).toBeVisible({
    timeout: 60_000,
  });

  const probesPanel = dashboard.locator("section", { hasText: "Export connection probes" }).first();
  // The Collector batches for up to five seconds before forwarding, and Prometheus commits on
  // arrival, so this is a wait on a configured pipeline latency rather than on a guess.
  await expect(probesPanel).toContainText("accepted", { timeout: 90_000 });
  await expect(probesPanel).toContainText("user");

  // The honest empty state, and a real distinction rather than a weak assertion. This daemon
  // booted BEFORE anyone opted in, so it has no start to report - and the panel has to say
  // "no exports yet" rather than draw a zero, because zero would claim the daemon started zero
  // times. P5 requires genuine zero, no eligible observations and stale export to look
  // different from one another; this is the middle one.
  const startsPanel = dashboard.locator("section", { hasText: "Daemon starts observed" }).first();
  await expect(startsPanel).toContainText("no exports yet", { timeout: 60_000 });

  await shoot(dashboard, "01-diagnostics-dashboard");

  // And the filter is proved to FILTER using only telemetry this test created.
  //
  // The obvious check - widen to All and expect a number - quietly depended on some earlier run
  // having left data in Prometheus. On a freshly reset stack this daemon is the only
  // installation and it started before telemetry was enabled, so widening still shows "no
  // exports yet" and the documented standalone command fails. Pointing the filter at an
  // installation that does not exist proves the same thing and depends on nothing.
  await dashboard.goto(
    `${DASHBOARD}?from=now-6h&to=now&var-environment=local&var-installation=no-such-installation`,
  );
  const probesWhenFilteredOut = dashboard
    .locator("section", { hasText: "Export connection probes" })
    .first();
  await expect(probesWhenFilteredOut).toContainText("no probes run yet", { timeout: 60_000 });
  await shoot(dashboard, "01b-filtered-out");

  // Back to this installation, and the probe returns: the panel was filtered, not empty.
  await dashboard.goto(`${DASHBOARD}?${scoped}`);
  await expect(probesPanel).toContainText("accepted", { timeout: 90_000 });

  // 6. Trace navigation, bound to THE trace this test produced.
  //
  //    The binding is the whole point. Tempo accumulates traces across runs, so selecting "the
  //    first row" and accepting any Mission Control span name would pass on a leftover trace
  //    from an earlier run even if this probe's trace never reached Grafana at all - which is
  //    exactly the false green a review caught here. `probe.traceId` is the per-profile scoped
  //    id the probe route handed back, which is the id Tempo actually stores, so the row, the
  //    click and the opened view can all be pinned to it.
  //
  //    Opened with `viewPanel` rather than scrolled to. Grafana lazily renders panels below the
  //    fold, so a plain `expect` on the traces panel asserts against markup that does not exist
  //    yet and fails for a reason that has nothing to do with the trace backend.
  const traceId = probe.traceId as string;
  await dashboard.goto(`${DASHBOARD}?${scoped}&viewPanel=6`);
  const tracesPanel = dashboard.locator("section", { hasText: "Mission Control traces" }).first();

  // This installation exported exactly one trace, so the scoped panel lists exactly one row -
  // which also proves the Installation filter reaches the trace panel and not only the metric
  // panels. The wait is on the Collector's five-second batching, not on a guess.
  const traceRow = tracesPanel.getByRole("row").filter({ hasText: "mission.telemetry.probe" });
  await expect(traceRow).toHaveCount(1, { timeout: 90_000 });
  await expect(traceRow).toContainText(traceId);
  await shoot(dashboard, "02-trace-table");

  const traceLink = tracesPanel.getByRole("link", { name: traceId });
  await expect(traceLink).toBeVisible({ timeout: 30_000 });
  await traceLink.click();

  // And the opened view is THAT trace: its exact id, and the probe's own span name. Either one
  // alone would be weaker - the id without the name would not prove the span arrived, and the
  // name without the id is what let an unrelated trace satisfy this before.
  await expect(dashboard.getByText(traceId).first()).toBeVisible({ timeout: 60_000 });
  await expect(dashboard.getByText("mission.telemetry.probe").first()).toBeVisible({
    timeout: 60_000,
  });
  await shoot(dashboard, "03-trace-view");
});

/** Evidence capture, behind `MC_E2E_EVIDENCE` per this suite's standing rule. */
async function shoot(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled", fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/telemetry-diagnostics-dashboard/${name}.png`);
}
