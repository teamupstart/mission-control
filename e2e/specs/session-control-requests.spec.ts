import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { buildSync } from "esbuild";
import type { Page } from "@playwright/test";
import type { Session } from "../../src/shared/types.ts";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { api, connect, dispatch } from "../fixtures/session-control.ts";

const FLAG = "session-control-requests";
const REASON = "Read the Target session and answer its open linter question for you.";
/** Long enough to overflow the reason's own capped box on the default viewport. */
const LONG_REASON = [REASON, ...Array.from({ length: 25 }, (_, i) => `Step ${i + 1}: inspect the next blocked session and answer it.`)].join("\n");

async function setFlag(daemon: DaemonHandle, enabled: boolean): Promise<void> {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: FLAG, enabled }, "PUT");
}

async function session(daemon: DaemonHandle, id: string): Promise<Session> {
  return (await api(daemon, "/api/sessions") as Session[]).find((s) => s.id === id)!;
}

function toolText(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? "").join("\n");
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(artifactsDir("session-control-requests"), { recursive: true });
  await page.screenshot({ path: join(artifactsDir("session-control-requests"), `${name}.png`) });
}

test("a session's ask shows as a card; the browser cannot accept it, Decline answers the agent, and the flag hides it", async ({ dashboard, daemon }) => {
  await setFlag(daemon, true);
  const asker = await dispatch(daemon, "Asker");
  const client = await connect(daemon, asker);
  try {
    await dashboard.reload();
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: "Asker" }).click();
    const asked = client.callTool({ name: "request_session_control", arguments: { reason: LONG_REASON } }, undefined, { timeout: 120_000 });

    const card = dashboard.getByRole("region", { name: "Session control request" });
    await expect(card.getByRole("heading", { name: "Asker asks to control your other sessions" })).toBeVisible();
    await expect(card).toContainText(REASON);
    const accept = card.getByRole("button", { name: "Accept", exact: true });
    await expect(accept).toBeDisabled();
    await expect(card).toContainText("Open the Mission Control desktop app to accept. You can decline here.");
    // The decision stays on screen without scrolling, even with a reason long enough to scroll.
    const decline = card.getByRole("button", { name: "Decline", exact: true });
    await expect(decline).toBeInViewport();
    await expect(accept).toBeInViewport();
    await shoot(dashboard, "browser-card");

    // The card's ask is not a review, and naming it on the grant does not stand in for the click.
    const pending = (await session(daemon, asker.id)).sessionControlRequest!;
    expect(pending.reason).toBe(LONG_REASON);
    const reasonBox = card.locator(".review-content");
    expect(await reasonBox.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true);
    expect((await api(daemon, "/api/reviews") as Array<{ sessionId: string; status: string }>)
      .filter((review) => review.sessionId === asker.id && review.status === "pending")).toHaveLength(0);
    const resolved = await fetch(`${daemon.baseURL}/api/reviews/${pending.id}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve", by: "human" }),
    });
    expect(resolved.status).toBe(404);
    const forged = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(asker.id)}/session-control`, {
      method: "PUT", headers: { "content-type": "application/json", origin: daemon.baseURL },
      body: JSON.stringify({ enabled: true, requestId: crypto.randomUUID(), controlRequestId: pending.id }),
    });
    expect(forged.status).toBe(403);
    expect((await session(daemon, asker.id)).sessionControlEnabled).toBe(false);

    await decline.click();
    await expect(card).toHaveCount(0);
    const answer = await asked;
    expect(answer.isError).toBe(false);
    expect(toolText(answer)).toContain("Declined: the operator chose not to let this session control other sessions.");
    expect((await session(daemon, asker.id)).sessionControlEnabled).toBe(false);

    // One ask's error never shows on the next. A failed Decline leaves its error on this card;
    // the ask is then declined from another window, and the session asks again.
    const second = client.callTool({ name: "request_session_control", arguments: { reason: REASON } }, undefined, { timeout: 120_000 });
    await expect(card).toContainText(REASON);
    await dashboard.route("**/session-control/requests/*/decline", (route) => route.fulfill({
      status: 500, contentType: "application/json", body: JSON.stringify({ error: "Decline temporarily unavailable" }),
    }), { times: 1 });
    await decline.click();
    await expect(card.getByRole("alert")).toHaveText("Decline temporarily unavailable");
    const secondAsk = (await session(daemon, asker.id)).sessionControlRequest!;
    const elsewhere = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(asker.id)}/session-control/requests/${secondAsk.id}/decline`, { method: "POST" });
    expect(elsewhere.status).toBe(200);
    await expect(card).toHaveCount(0);
    expect(toolText(await second)).toContain("Declined");
    const third = client.callTool({ name: "request_session_control", arguments: { reason: REASON } }, undefined, { timeout: 120_000 });
    await expect(card).toContainText(REASON);
    expect((await session(daemon, asker.id)).sessionControlRequest!.id).not.toBe(secondAsk.id);
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(decline).toBeEnabled();

    // With the preview off, nothing is shown and the agent is told why: switching it off also
    // withdraws the pending ask and tells its waiting agent.
    await setFlag(daemon, false);
    const withdrawn = await third;
    expect(withdrawn.isError).toBe(true);
    expect(toolText(withdrawn)).toContain("session control requests were turned off");
    const refused = await client.callTool({ name: "request_session_control", arguments: { reason: REASON } }, undefined, { timeout: 60_000 });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("session control requests are turned off");
    await expect(card).toHaveCount(0);
    expect((await session(daemon, asker.id)).sessionControlRequest ?? null).toBeNull();
  } finally {
    await client.close();
  }
});

test("only the operator's own click on Accept in the desktop app grants a session's ask", async ({ daemon }) => {
  test.skip(process.platform !== "darwin", "the real sandboxed desktop fixture requires the macOS GUI");
  // The same isolated Electron shell as the session control menu's spec: the real preload, the
  // shell's own click registrar and the private utility-process channel, with no bypass.
  await daemon.crash();
  const authorizationModule = join(daemon.home, "session-control-authorization.cjs");
  buildSync({ stdin: { contents: 'export * from "./src/main/session-control-authorization.ts"; export * from "./src/main/dashboard-click-ipc.ts";', resolveDir: process.cwd(), loader: "ts" },
    outfile: authorizationModule, bundle: true, platform: "node", format: "cjs" });
  const application = await electron.launch({ args: [fileURLToPath(new URL("../fixtures/desktop-session-control.cjs", import.meta.url)), authorizationModule] });
  try {
    const dashboard = await application.firstWindow();
    const daemonPid = await application.evaluate(async (_electron, config) =>
      (globalThis as unknown as { startControlDaemon(config: unknown): Promise<number> }).startControlDaemon(config), daemon.desktopLaunchConfig());
    await expect.poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/health`).catch(() => null);
      return response?.ok ? (await response.json()).pid : null;
    }).toBe(daemonPid);
    await setFlag(daemon, true);
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    const asker = await dispatch(daemon, "Asker");
    const target = await dispatch(daemon, "Target");
    const client = await connect(daemon, asker);
    try {
      await api(daemon, "/api/ui/config", { layout: "console", conversationView: "chat", lineDensity: "expanded" }, "PUT");
      await dashboard.reload();
      await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: "Asker" }).click();
      expect((await client.callTool({ name: "read_sessions", arguments: {} })).isError).toBe(true);
      const asked = client.callTool({ name: "request_session_control", arguments: { reason: REASON } }, undefined, { timeout: 120_000 });

      const card = dashboard.getByRole("region", { name: "Session control request" });
      await expect(card).toContainText(REASON);
      const accept = card.getByRole("button", { name: "Accept", exact: true });
      await expect(accept).toBeEnabled();
      await expect(card).not.toContainText("Open the Mission Control desktop app to accept.");
      await shoot(dashboard, "desktop-card");

      // A script's click is untrusted, so it arms nothing, and the page cannot claim the bridge.
      await accept.evaluate((button: HTMLButtonElement) => button.click());
      await expect(card.getByRole("alert")).toHaveText("Click Accept yourself in the Mission Control desktop app to grant this.");
      expect(await dashboard.evaluate(() => window.missionDesktop?.claimSessionControlAuthorization?.() ?? null)).toBeNull();
      expect((await session(daemon, asker.id)).sessionControlEnabled).toBe(false);
      await expect(card).toBeVisible();

      // The operator's click.
      await accept.click();
      await expect(card).toHaveCount(0);
      const answer = await asked;
      expect(answer.isError).toBe(false);
      expect(toolText(answer)).toContain("Granted: the operator allowed this session to control other sessions.");
      await expect.poll(async () => (await session(daemon, asker.id)).sessionControlEnabled).toBe(true);
      const list = await client.callTool({ name: "read_sessions", arguments: {} });
      expect(list.isError).toBe(false);
      expect(JSON.stringify(list)).toContain(target.id);
      await expect(dashboard.getByRole("button", { name: "Session control: On" })).toBeVisible();
      await shoot(dashboard, "desktop-granted");

      // Already granted: a second ask is answered at once and draws nothing.
      const again = await client.callTool({ name: "request_session_control", arguments: { reason: REASON } }, undefined, { timeout: 60_000 });
      expect(toolText(again)).toContain("Granted");
      await expect(card).toHaveCount(0);
    } finally {
      await client.close();
    }
  } finally {
    await application.evaluate(() => (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
    await application.close();
  }
});
