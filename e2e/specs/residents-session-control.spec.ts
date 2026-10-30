import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { buildSync } from "esbuild";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// A resident profile with Control other sessions on gets the existing session-control grant only
// from the operator's Launch click in the desktop app: the shell arms that one launch, the daemon
// consumes it over its private channel, and the grant survives a daemon restart for the same
// conversation. Launched from the standalone browser it starts without control and says so, in
// Dispatch, in the dock and in the Console band. No model tokens are spent: every agent binary is
// the fake from `fixtures/fake-agents.ts`.

const PERSONA = "Code Risk Reviewer";
const PERSONA_ID = "builtin:code-risk-reviewer";
const PROFILE = "Fleet Steward";
const EVIDENCE = artifactsDir("residents-session-control");

async function capture(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if ("mouse" in target) await target.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/residents-session-control/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

interface LiveSession {
  id: string;
  state: string;
  sessionControlEnabled?: boolean;
  task: { id: string; kind: string } | null;
}

async function residentSessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  return (await api<LiveSession[]>(daemon, "/api/sessions")).filter((s) => s.task?.kind === "resident");
}

/** Wait for the one resident session to settle idle, and return it. */
async function idleResident(daemon: DaemonHandle, count = 1): Promise<LiveSession> {
  let found: LiveSession[] = [];
  await expect.poll(async () => {
    found = await residentSessions(daemon);
    return found.length === count && found.every((s) => s.state === "idle");
  }, { timeout: 60_000 }).toBe(true);
  return found.at(-1)!;
}

/** Open the resident in the Console and return its band. */
async function band(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: PROFILE }).first().click();
  const found = page.getByRole("group", { name: `Resident ${PROFILE}` });
  await expect(found).toBeVisible();
  return found;
}

test("a resident launched from the standalone browser starts without session control, and every launch surface says so", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/ui/config", { layout: "console", conversationView: "chat" }, "PUT");

  // The editor's Authority section: off by default, and explicit about the one way it is granted.
  await dashboard.goto(`${daemon.baseURL}/#/residents`);
  await dashboard.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = dashboard.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill(PROFILE);
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: `${PERSONA} · built-in` });
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  const control = editor.getByRole("checkbox", { name: "Control other sessions" });
  await expect(control).not.toBeChecked();
  await expect(editor).toContainText("Only your Launch click in the Mission Control desktop app grants it");
  await control.check();
  await control.scrollIntoViewIfNeeded();
  await capture(dashboard, "01-authority-section");
  await editor.getByRole("button", { name: "Save" }).click();
  const saved = dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` });
  await expect(saved).toContainText("Revision 1");

  // Dispatch says, before anything is sent, that this launch will not carry control.
  await saved.getByRole("button", { name: "Launch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toContainText("control: on");
  const note = dialog.getByRole("note");
  await expect(note).toContainText("only a Launch click in the Mission Control desktop app grants it");
  await expect(note).toContainText("this resident starts without session control");
  await capture(dialog, "02-dispatch-browser-note");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  const first = await idleResident(daemon);
  expect(first.sessionControlEnabled).toBe(false);

  // The Console band: "control not granted", beside the existing menu, which the browser cannot use.
  const residentBand = await band(dashboard, daemon);
  await expect(residentBand.getByRole("status").filter({ hasText: "control not granted" })).toBeVisible();
  await residentBand.getByRole("button", { name: "Session control: Off" }).click();
  const menu = dashboard.getByRole("menu", { name: "Control other sessions" });
  await expect(menu).toContainText("Open the desktop app to change session control.");
  await expect(menu.getByRole("menuitemradio", { name: "On", exact: true })).toBeDisabled();
  await capture(dashboard, "03-band-control-not-granted");
  await dashboard.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The dock's Launch says so too, once its resident is running, and its live rows carry the status.
  await dashboard.getByRole("button", { name: /^Residents - \d+ live$/ }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents" });
  await dock.getByRole("button", { name: `Launch ${PROFILE}` }).click();
  await expect(dock.getByRole("status").filter({ hasText: "Started without session control" })).toBeVisible({ timeout: 60_000 });
  await idleResident(daemon, 2);
  await expect(dock.getByRole("status").filter({ hasText: "control not granted" })).toHaveCount(2);
  await capture(dashboard, "04-dock-control-not-granted");
  for (const session of await residentSessions(daemon)) expect(session.sessionControlEnabled).toBe(false);
});

test("a desktop Launch click grants the resident session control, and a daemon restart keeps it for the same conversation", async ({ daemon }) => {
  test.skip(process.platform !== "darwin", "the real sandboxed desktop fixture requires the macOS GUI");
  // Hand this fixture's isolated state to a real Electron-owned utility process, so the daemon
  // has the private shell channel a Launch click is consumed over. No HTTP or environment
  // bypass exists for it.
  await daemon.crash();
  const authorizationModule = join(daemon.home, "session-control-authorization.cjs");
  buildSync({
    stdin: {
      contents: 'export * from "./src/main/session-control-authorization.ts"; export * from "./src/main/dashboard-click-ipc.ts";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: authorizationModule,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const application = await electron.launch({
    args: [fileURLToPath(new URL("../fixtures/desktop-session-control.cjs", import.meta.url)), authorizationModule],
  });
  const startDaemon = async (): Promise<void> => {
    const pid = await application.evaluate(async (_electron, config) =>
      (globalThis as unknown as { startControlDaemon(config: unknown): Promise<number> }).startControlDaemon(config),
    daemon.desktopLaunchConfig());
    await expect.poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/health`).catch(() => null);
      return response?.ok ? (await response.json() as { pid: number }).pid : null;
    }, { timeout: 60_000 }).toBe(pid);
  };
  try {
    const dashboard = await application.firstWindow();
    await startDaemon();
    await api(daemon, "/api/ui/config", { layout: "console", conversationView: "chat" }, "PUT");
    const profile = await api<{ id: string; revision: number }>(daemon, "/api/residents/profiles", {
      settings: {
        identity: { name: PROFILE },
        persona: { personaId: PERSONA_ID },
        workspace: { defaultRepoRoot: daemon.repo },
        authority: { controlOtherSessions: true },
      },
    });

    // A page script cannot arm a launch: the capability is already claimed, and a forged one is
    // refused. Asked once the dock has rendered, because the module that claims it is the one
    // every Launch affordance imports.
    await dashboard.goto(`${daemon.baseURL}/#/residents/${encodeURIComponent(profile.id)}`);
    await expect(dashboard.getByRole("button", { name: /^Residents - \d+ live$/ })).toBeVisible();
    await expect(dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` })).toBeVisible();
    expect(await dashboard.evaluate((profileId) => {
      const bridge = window.missionDesktop!;
      return [
        bridge.claimSessionControlAuthorization?.(),
        bridge.authorizeResidentLaunch?.("forged", { requestId: crypto.randomUUID(), profileId, revision: 1 }),
      ];
    }, profile.id)).toEqual([null, false]);

    await dashboard.getByRole("region", { name: `Resident profile ${PROFILE}` }).getByRole("button", { name: "Launch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await expect(dialog.getByRole("note")).toContainText("this Launch click gives this run session control");
    await capture(dialog, "05-dispatch-desktop-note");
    await dialog.getByRole("button", { name: "Launch resident" }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    const resident = await idleResident(daemon);
    await expect.poll(async () => (await residentSessions(daemon))[0]?.sessionControlEnabled, { timeout: 30_000 }).toBe(true);
    let residentBand = await band(dashboard, daemon);
    await expect(residentBand.getByRole("status").filter({ hasText: "control granted" })).toBeVisible();
    await expect(residentBand.getByRole("button", { name: "Session control: Off" })).toHaveCount(0);
    // The session's own menu reads the same grant, because it is the same grant.
    const toolbarControl = dashboard.locator(".console-detail").getByRole("button", { name: "Session control: On" });
    await expect(toolbarControl).toBeVisible();
    await capture(dashboard, "06-band-control-granted");

    // Restart the daemon. The same conversation comes back through SDK restore, and its grant with it.
    await application.evaluate(() => (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
    await startDaemon();
    await expect.poll(async () => {
      const sessions = await residentSessions(daemon);
      return sessions.length === 1 && sessions[0]!.id === resident.id ? sessions[0]!.sessionControlEnabled : null;
    }, { timeout: 60_000 }).toBe(true);
    await dashboard.reload();
    residentBand = await band(dashboard, daemon);
    await expect(residentBand.getByRole("status").filter({ hasText: "control granted" })).toBeVisible();
    await capture(dashboard, "07-band-control-granted-after-restart");
  } finally {
    await application.evaluate(() => (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
    await application.close();
  }
});
