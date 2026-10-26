import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "playwright";
import type { Session } from "../../src/shared/types.ts";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

async function api(daemon: DaemonHandle, path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return response.json();
}

const controlOf = async (daemon: DaemonHandle, id: string) =>
  (await api(daemon, "/api/sessions") as Session[]).find((s) => s.id === id)?.sessionControlEnabled;

// `session-control.spec.ts` drives a purpose-built shell. This one launches the production
// main process itself, whose click IPC once refused every grant while the fixture's accepted it.
test("the production desktop shell grants and revokes session control from operator clicks", async ({ daemon }) => {
  test.skip(process.platform !== "darwin", "the real desktop shell requires the macOS GUI");
  await daemon.crash();
  // Hand the shell this fixture's isolated home, port and fake agents; it starts its own daemon.
  const { MISSION_DEV_SERVER_URL: _dev, ...env } = daemon.desktopLaunchConfig().env;
  const application = await electron.launch({ args: [".", `--user-data-dir=${join(daemon.home, "electron-profile")}`], env });
  try {
    const dashboard = await application.firstWindow();
    await expect(dashboard.getByRole("button", { name: "Dispatch" }).first()).toBeVisible({ timeout: 60_000 });
    await api(daemon, "/api/tasks", { repoRoot: daemon.repo, intent: "write a haiku about control", title: "Controller", kind: "ship", agent: "claude", workflowId: null });
    let controller: Session | undefined;
    await expect.poll(async () => {
      controller = (await api(daemon, "/api/sessions") as Session[]).find((s) => s.agentSessionId && s.state === "idle");
      return !!controller;
    }).toBe(true);
    await api(daemon, `/api/sessions/${encodeURIComponent(controller!.id)}/rename`, { name: "Controller" });
    await api(daemon, "/api/ui/config", { layout: "console", conversationView: "chat", lineDensity: "expanded" }, "PUT");
    await dashboard.reload();
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: "Controller" }).click();
    await dashboard.getByRole("button", { name: "Session control" }).click();
    const menu = dashboard.getByRole("menu", { name: "Control other sessions" });
    const on = menu.getByRole("menuitemradio", { name: "On", exact: true });
    await expect(on).toBeEnabled();
    await on.click();
    await expect(on).toBeChecked();
    await expect(menu.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => controlOf(daemon, controller!.id)).toBe(true);
    if (process.env.MC_E2E_EVIDENCE === "1") {
      mkdirSync(artifactsDir("session-control"), { recursive: true });
      await dashboard.mouse.move(0, 0);
      await dashboard.screenshot({ path: join(artifactsDir("session-control"), "production-shell-granted.png") });
    }
    await menu.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    await expect(on).not.toBeChecked();
    await expect(menu.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => controlOf(daemon, controller!.id)).toBe(false);
  } finally {
    await application.close();
  }
});
