import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../fixtures/test.ts";
import { buildFeatureFlagsDashboard } from "../fixtures/feature-flags-dashboard.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { tempDir } from "../../test/temp-root.mjs";

let webDir: string;
test.beforeAll(async () => {
  webDir = tempDir("mission-feature-flags-web-");
  const nodeEnv = process.env.NODE_ENV;
  await buildFeatureFlagsDashboard(webDir);
  expect(process.env.NODE_ENV, "private builds must not contaminate later dev-server specs").toBe(nodeEnv);
});
test.afterAll(() => { if (webDir) rmSync(webDir, { recursive: true, force: true }); });

// Evaluated after beforeAll: the ordinary isolated daemon serves our private dashboard.
// Playwright requires destructured fixture arguments even when this override needs none.
// eslint-disable-next-line no-empty-pattern
test.use({ daemonEnv: async ({}, use) => { await use({ MISSION_WEB_DIR: webDir }); } });

test("flag snapshots and live events update state and the resolved hook in two windows without reload", async ({ page, context, daemon }) => {
  const putMaster = async (enabled: boolean) => {
    const response = await fetch(`${daemon.baseURL}/api/feature-flags`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", enabled }),
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ config: { enableAll: enabled, overrides: {} } });
  };
  // An initial true cannot come from the hook's false default: it must consume the snapshot.
  await putMaster(true);
  const peer = await context.newPage();
  const windows = [page, peer];
  const eventConnections = [0, 0];
  const navigations = [0, 0];
  windows.forEach((window, index) => {
    window.on("request", (request) => {
      if (new URL(request.url()).pathname === "/events") eventConnections[index]!++;
    });
    window.on("framenavigated", (frame) => {
      if (frame === window.mainFrame()) navigations[index]!++;
    });
  });
  const expectState = async (enabled: boolean) => {
    for (const window of windows) {
      await expect(window.getByLabel("Feature flag stream state")).toHaveText(JSON.stringify({
        featureFlags: { enableAll: enabled, overrides: {} }, connected: true, hasSnapshot: true,
      }));
      // This is the production hook under App's provider, with a declared preview fixture.
      // Reading the raw config alone cannot prove that the hook consumes/resolves it.
      await expect(window.getByLabel("Resolved preview flag")).toHaveText(String(enabled));
    }
  };
  await Promise.all(windows.map((window) => window.goto(`${daemon.baseURL}/#/fleet`)));
  await expectState(true);
  const initialNavigations = [...navigations];
  expect(eventConnections).toEqual([1, 1]);

  // Both mounted React trees must consume the incremental event, not a new snapshot or GET.
  await putMaster(false);
  await expectState(false);
  await putMaster(true);
  await expectState(true);
  expect(eventConnections).toEqual([1, 1]);
  expect(navigations).toEqual(initialNavigations);

  // Miss a change while disconnected. Reconnection must replace stale true from a snapshot.
  await context.setOffline(true);
  // Chromium offline mode alone can leave an already-open SSE response alive. Close the
  // real transport, then restart while offline so the write is genuinely missed.
  await daemon.crash();
  for (const window of windows) {
    await expect(window.getByLabel("Feature flag stream state")).toContainText('"connected":false');
  }
  await daemon.restart();
  await putMaster(false);
  await context.setOffline(false);
  await expectState(false);
  expect(navigations).toEqual(initialNavigations);
  expect(eventConnections.every((count) => count > 1)).toBe(true);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const directory = artifactsDir("feature-flags-stream");
    mkdirSync(directory, { recursive: true });
    await peer.screenshot({ path: join(directory, "peer-after-reconnect.png") });
  }
});
