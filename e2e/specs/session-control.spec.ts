import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { buildSync } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Session } from "../../src/shared/types.ts";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { argvValue, recordsIn } from "../fixtures/records.ts";
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

async function dispatch(daemon: DaemonHandle, name: string): Promise<Session> {
  const before: Session[] = await api(daemon, "/api/sessions");
  await api(daemon, "/api/tasks", { repoRoot: daemon.repo, intent: `write a haiku about ${name}`, title: name, kind: "ship", agent: "claude", workflowId: null });
  let session: Session | undefined;
  await expect.poll(async () => {
    const all: Session[] = await api(daemon, "/api/sessions");
    session = all.find((s) => !before.some((previous) => previous.id === s.id) && s.agentSessionId && s.state === "idle");
    return !!session;
  }).toBe(true);
  await api(daemon, `/api/sessions/${encodeURIComponent(session!.id)}/rename`, { name });
  return session!;
}

/** Use the actual MCP descriptor the fake agent received, including its private locator. */
async function connect(daemon: DaemonHandle, session: Session): Promise<Client> {
  let descriptor: { command: string; args: string[]; env: Record<string, string> } | undefined;
  await expect.poll(() => {
    const records = recordsIn<{ cwd: string; argv: string[] }>(join(daemon.recordDir, "claude"));
    for (const record of records.filter((r) => r.cwd === session.cwd)) {
      const raw = argvValue(record.argv, "--mcp-config");
      if (raw) descriptor = JSON.parse(raw).mcpServers?.["mission-control"];
      if (descriptor) break;
    }
    return !!descriptor;
  }).toBe(true);
  const client = new Client({ name: "session-control-e2e", version: "1" });
  await client.connect(new StdioClientTransport({
    command: descriptor!.command, args: descriptor!.args,
    cwd: session.cwd!, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...descriptor!.env },
    stderr: "pipe",
  }));
  return client;
}

test("standalone browser and headerless local HTTP cannot grant session control", async ({ dashboard, daemon }) => {
  const controller = await dispatch(daemon, "Browser controller");
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: "Browser controller" }).click();
  const toggle = dashboard.getByRole("checkbox", { name: "Control other sessions" });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(dashboard.locator(".session-control-setting p").filter({ hasText: "Open the desktop app to change session control." })).toBeVisible();
  await toggle.locator("..").hover();
  await expect(dashboard.locator(".tooltip")).toHaveText("Open the desktop app to change session control. Resets when this conversation changes or Mission Control restarts.");
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(artifactsDir("session-control"), { recursive: true });
    await dashboard.screenshot({ path: join(artifactsDir("session-control"), "browser-control-tooltip.png") });
  }
  await dashboard.mouse.move(0, 0);
  for (const extra of [{}, { requestId: crypto.randomUUID() }]) {
    const refused = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(controller.id)}/session-control`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, ...extra }),
    });
    expect(refused.status).toBe(403);
  }
  expect((await api(daemon, "/api/sessions") as Session[]).find((s) => s.id === controller.id)?.sessionControlEnabled).toBe(false);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(artifactsDir("session-control"), { recursive: true });
    await dashboard.screenshot({ path: join(artifactsDir("session-control"), "browser-refused.png") });
  }
});

test("operator desktop clicks grant and revoke a controller; real MCP messages and prompt answers reach another session", async ({ daemon }) => {
  test.skip(process.platform !== "darwin", "the real sandboxed desktop fixture requires the macOS GUI");
  // Transfer only this fixture's isolated state to a real Electron-owned utility process.
  // There is no production HTTP or environment bypass for the authorization under test.
  await daemon.crash();
  const authorizationModule = join(daemon.home, "session-control-authorization.cjs");
  buildSync({ entryPoints: ["src/main/session-control-authorization.ts"], outfile: authorizationModule, bundle: true, platform: "node", format: "cjs" });
  const application = await electron.launch({ args: [fileURLToPath(new URL("../fixtures/desktop-session-control.cjs", import.meta.url)), authorizationModule] });
  try {
    const dashboard = await application.firstWindow();
    const daemonPid = await application.evaluate(async (_electron, config) =>
      (globalThis as unknown as { startControlDaemon(config: unknown): Promise<number> }).startControlDaemon(config), daemon.desktopLaunchConfig());
    await expect.poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/health`).catch(() => null);
      return response?.ok ? (await response.json()).pid : null;
    }).toBe(daemonPid);
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    const controller = await dispatch(daemon, "Controller");
    const target = await dispatch(daemon, "Target");
    const client = await connect(daemon, controller);
    try {
      await api(daemon, "/api/ui/config", { layout: "console", conversationView: "chat", lineDensity: "expanded" }, "PUT");
      await dashboard.reload();
      const rail = dashboard.getByRole("navigation", { name: "Sessions" });
      await rail.locator("button.rail-row").filter({ hasText: "Controller" }).click();
      const toggle = dashboard.getByRole("checkbox", { name: "Control other sessions" });
      await expect(toggle).not.toBeChecked();
      await toggle.locator("..").hover();
      await expect(dashboard.locator(".tooltip")).toHaveText("Allow this session to message and steer other live sessions on your behalf. Resets when this conversation changes or Mission Control restarts.");
      expect((await client.callTool({ name: "read_sessions", arguments: {} })).isError).toBe(true);
      await toggle.evaluate((input: HTMLInputElement) => input.click());
      await expect(toggle).not.toBeChecked();
      await expect(dashboard.getByRole("alert").filter({ hasText: "Use the session control checkbox" })).toBeVisible();
      expect(await dashboard.evaluate((sessionId) => {
        const bridge = window.missionDesktop!;
        return [bridge.claimSessionControlAuthorization?.(), bridge.authorizeSessionControl?.("forged", { sessionId, enabled: true, requestId: crypto.randomUUID() })];
      }, controller.id)).toEqual([null, false]);
      const unarmed = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(controller.id)}/session-control`, {
        method: "PUT", headers: { "content-type": "application/json", origin: daemon.baseURL },
        body: JSON.stringify({ enabled: true, requestId: crypto.randomUUID() }),
      });
      expect(unarmed.status).toBe(403);
      await dashboard.route("**/api/sessions/*/session-control", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Grant temporarily unavailable" }) }), { times: 1 });
      await toggle.click();
      await expect(dashboard.getByRole("alert").filter({ hasText: "Grant temporarily unavailable" })).toBeVisible();
      await expect(toggle).not.toBeChecked();
      const grantRequest = dashboard.waitForRequest((request) => request.url().endsWith("/session-control") && request.method() === "PUT");
      await toggle.click();
      await expect(toggle).toBeChecked();
      const usedGrant = (await grantRequest).postDataJSON();
      const replay = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(controller.id)}/session-control`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(usedGrant),
      });
      expect(replay.status).toBe(403);
      await expect.poll(async () => (await api(daemon, "/api/sessions") as Session[]).find((s) => s.id === controller.id)?.sessionControlEnabled).toBe(true);
      await dashboard.reload();
      await rail.locator("button.rail-row").filter({ hasText: "Controller" }).click();
      await expect(toggle).toBeChecked();
      const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
      await tabs.getByRole("tab", { name: /Diff$/ }).click();
      await expect(toggle).toHaveCount(0);
      await tabs.getByRole("tab", { name: /Conversation$/ }).click();
      await expect(toggle).toBeChecked();

      const act = (command: unknown) => client.callTool({ name: "control_session", arguments: { sessionId: target.id, command } });
      const list = await client.callTool({ name: "read_sessions", arguments: {} });
      expect(list.isError).toBe(false);
      expect(JSON.stringify(list)).toContain(target.id);
      expect((await act({ action: "message", text: "A delegated follow-up about CSS" })).isError).toBe(false);
      await rail.locator("button.rail-row").filter({ hasText: "Target" }).click();
      await expect(toggle).not.toBeChecked();
      await expect(dashboard.getByText("A delegated follow-up about CSS", { exact: true }).first()).toBeVisible();
      await expect(dashboard.getByRole("article", { name: "Delegated session", exact: true }).first()).toBeVisible();

      // Exercise the native SDK question channel, through the same built MCP tool.
      expect((await act({ action: "message", text: "ask me which linter to use" })).isError).toBe(false);
      let requestId: string | undefined;
      await expect.poll(async () => {
        const all: Session[] = await api(daemon, "/api/sessions");
        requestId = all.find((s) => s.id === target.id)?.paneDialog?.requestId;
        return !!requestId;
      }).toBe(true);
      expect((await act({ action: "submit_options", form: { requestId, answers: [
        { question: "Which linter?", labels: ["biome"] },
        { question: "Which checks should run?", labels: ["types", "tests"] },
      ] } })).isError).toBe(false);
      await expect(dashboard.getByText(`session ${controller.id} answered`, { exact: true }).first()).toBeVisible();

      // The review channel carries both free-text and structured decisions separately from native asks.
      const tokenHeaders = { "content-type": "application/json", "x-harness-token": (await import("node:fs")).readFileSync(join(daemon.home, "token"), "utf8").trim() };
      const reviewResponse = await fetch(`${daemon.baseURL}/mcp/reviews`, { method: "POST", headers: tokenHeaders,
        body: JSON.stringify({ env: {}, sessionId: target.id, cwd: target.cwd, kind: "input", title: "Delegated review", body: "Which direction?" }) });
      expect(reviewResponse.ok).toBe(true);
      const review = await reviewResponse.json() as { id: string };
      expect((await act({ action: "resolve_review", reviewId: review.id, resolution: { action: "answer", response: "Continue with the focused change" } })).isError).toBe(false);
      await expect(dashboard.getByText("Continue with the focused change", { exact: true }).first()).toBeVisible();
      await dashboard.reload();
      await rail.locator("button.rail-row").filter({ hasText: "Target" }).click();
      await expect(dashboard.getByText("Continue with the focused change", { exact: true }).first()).toBeVisible();

      if (process.env.MC_E2E_EVIDENCE === "1") {
        mkdirSync(artifactsDir("session-control"), { recursive: true });
        await dashboard.screenshot({ path: join(artifactsDir("session-control"), "delegated-answers.png") });
      }
      await rail.locator("button.rail-row").filter({ hasText: "Controller" }).click();
      await expect(toggle).toBeChecked();
      if (process.env.MC_E2E_EVIDENCE === "1") await dashboard.screenshot({ path: join(artifactsDir("session-control"), "controller-enabled.png") });
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      expect((await act({ action: "message", text: "must be refused after revocation" })).isError).toBe(true);
      expect((await client.callTool({ name: "read_sessions", arguments: {} })).isError).toBe(true);
      await toggle.click();
      await expect(toggle).toBeChecked();
      await application.evaluate(() => (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
      const restartedPid = await application.evaluate(async (_electron, config) =>
        (globalThis as unknown as { startControlDaemon(config: unknown): Promise<number> }).startControlDaemon(config), daemon.desktopLaunchConfig());
      await expect.poll(async () => {
        const response = await fetch(`${daemon.baseURL}/api/health`).catch(() => null);
        return response?.ok ? (await response.json()).pid : null;
      }).toBe(restartedPid);
      await dashboard.reload();
      await rail.locator("button.rail-row").filter({ hasText: "Controller" }).click();
      await expect(toggle).not.toBeChecked();
      expect((await client.callTool({ name: "read_sessions", arguments: {} })).isError).toBe(true);
    } finally { await client.close(); }
  } finally {
    await application.evaluate(() => (globalThis as unknown as { stopControlDaemon(): Promise<void> }).stopControlDaemon());
    await application.close();
  }
});
