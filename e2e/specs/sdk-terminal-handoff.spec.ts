import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Session } from "../../src/shared/types.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { resumeLeaseRoot } from "../../src/server/terminal/resume-lease.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { test, expect } from "../fixtures/test.ts";

test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_RESUME_TOOLS: "1", MISSION_POLL_MS: "100" } });
const evidence = artifactsDir("sdk-terminal-handoff");

async function dispatch(page: Page, daemon: DaemonHandle) {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByLabel("Kind").selectOption("chat");
  await dialog.getByRole("textbox", { name: "What would you like to talk about?" }).fill("Keep Mission tools when continuing this conversation");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const sessions = async () => await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
  await expect.poll(async () => (await sessions()).find((s) => s.runtime === "sdk")?.state, { timeout: 30_000 }).toBe("idle");
  const source = (await sessions()).find((s) => s.runtime === "sdk")!;
  await page.goto(`${daemon.baseURL}/#/session/${encodeURIComponent(source.id)}`);
  // The rail selects through the same production detail used by a person.
  const row = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: source.name });
  if (await row.count()) await row.first().click();
  return source;
}

async function resume(page: Page, daemon: DaemonHandle, source: Session) {
  const response = page.waitForResponse((r) => r.url().includes(`/api/sessions/${encodeURIComponent(source.id)}/launch`) && r.request().method() === "POST");
  await page.getByRole("button", { name: /Claude Code/ }).filter({ has: page.locator(".launch-word") }).click();
  await page.getByRole("menuitem", { name: /Ghostty/ }).click();
  return await response;
}

test("managed resume actually invokes the built Mission MCP transport", async ({ dashboard, daemon }) => {
  const source = await dispatch(dashboard, daemon);
  let preparedHome: string | undefined;
  let guardPid: number | undefined;
  try {
    const response = await resume(dashboard, daemon, source);
    expect(response.ok(), await response.text()).toBe(true);
    const proof = join(daemon.recordDir, "resume-mcp.json");
    await expect.poll(() => existsSync(proof), { timeout: 30_000 }).toBe(true);
    const observed = JSON.parse(readFileSync(proof, "utf8"));
    preparedHome = observed.missionHome;
    guardPid = JSON.parse(readFileSync(join(observed.missionHome, "terminal-launch.json"), "utf8")).pid;
    expect(observed.nativeId).toBe(source.agentSessionId);
    expect(observed.sdkIdentity).toBeNull();
    expect(observed.missionHome).not.toBe(daemon.home);
    expect(observed.tools).toContain("submit_workflow_evidence");
    expect(observed.result.isError ?? false).toBe(false);
    expect(observed.result.content).toContainEqual({ type: "text", text: "ok" });
    expect(existsSync(join(observed.missionHome, "launch.json"))).toBe(true);
    // Neither the daemon's shutdown cleanup nor startup reconciliation owns a live wrapper.
    await daemon.crash(); await daemon.restart();
    expect(existsSync(join(observed.missionHome, "launch.json"))).toBe(true);
    await dashboard.reload();
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "managed-terminal.png") });
    }
    writeFileSync(join(daemon.recordDir, "resume-stop"), "stop");
    await expect.poll(() => {
      try { process.kill(guardPid!, 0); return false; } catch { return true; }
    }, { timeout: 10_000 }).toBe(true);
    // The replacement daemon is a new process under a shared ancestor. The guard cannot
    // distinguish it from an adopted descendant, so normal agent exit must retain the home.
    const status = await (await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(source.id)}/launch`)).json();
    expect(status.attempts).toContainEqual(expect.objectContaining({ state: "claimed" }));
    expect(existsSync(join(observed.missionHome, "loopback-token"))).toBe(true);
  } finally {
    // A failed daemon restart removes its fixture home. Still release the held fake and
    // preserve that original failure instead of replacing it with an ENOENT in teardown.
    mkdirSync(daemon.recordDir, { recursive: true });
    writeFileSync(join(daemon.recordDir, "resume-stop"), "stop");
    if (guardPid) await expect.poll(() => {
      try { process.kill(guardPid!, 0); return false; } catch { return true; }
    }, { timeout: 10_000 }).toBe(true);
    // This fixture's only agent and MCP client have exited. Remove its private retained
    // namespace explicitly; production reconciliation must not infer this from PID absence.
    if (preparedHome) rmSync(resumeLeaseRoot(daemon.home), { recursive: true, force: true });
  }
});

test.describe("preflight refusal", () => {
  test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_RESUME_TOOLS: "1", MISSION_POLL_MS: "100", MC_E2E_RESUME_PRIVATE_MCP: "1" } });
  test("a missing bundle leaves the SDK usable and renders the remedy", async ({ dashboard, daemon }) => {
    const source = await dispatch(dashboard, daemon);
    // A private copy avoids touching dist/ shared by another test or daemon.
    writeFileSync(join(daemon.home, "resume-mcp.mjs"), "throw new Error('fixture stale bundle');\n");
    const response = await resume(dashboard, daemon, source);
    expect(response.status()).toBe(409);
    await expect(dashboard.getByText(/MCP server.*could not be interrogated/)).toBeVisible();
    const refusal = dashboard.getByText(/MCP server.*could not be interrogated/);
    await expect(refusal).toContainText("npm run build");
    const bounds = await refusal.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dashboard.viewportSize()!.width);
    expect(existsSync(join(daemon.home, "terminal-boundary.json"))).toBe(false);
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    expect(sessions.find((s) => s.id === source.id)?.state).toBe("idle");
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, "preflight-refusal.png") });
    }
    const sent = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(source.id)}/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "The original SDK still accepts turns", origin: "human", submit: true }),
    });
    expect(sent.ok, await sent.text()).toBe(true);
    copyFileSync("dist/mcp/server.mjs", join(daemon.home, "resume-mcp.mjs"));
  });
});
