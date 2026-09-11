import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "../fixtures/test.ts";
import { openSetupFamily } from "../fixtures/setup-panel.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

test.use({ viewport: { width: 1440, height: 1100 }, daemonEnv: { MISSION_POLL_MS: "300", MISSION_PI_EXTENSION: resolve("dist/pi-extension/index.js") } });
test.describe.configure({ timeout: 120_000 });

// Opt-in source-mapped browser coverage for the focused review proof. Ordinary runs
// neither collect coverage nor write these artifacts. Build the web bundle with --sourcemap.
const coverageDir = process.env.MC_E2E_COVERAGE_DIR;
test.beforeEach(async ({ page }) => {
  if (coverageDir) await page.coverage.startJSCoverage({ resetOnNavigation: false });
});
test.afterEach(async ({ page }, info) => {
  if (!coverageDir) return;
  const coverage = await page.coverage.stopJSCoverage();
  mkdirSync(coverageDir, { recursive: true });
  writeFileSync(join(coverageDir, `${info.testId.replaceAll(/[^a-z0-9-]/gi, "_")}.json`), JSON.stringify(coverage));
});

test("Setup installs Pi only on first use, reports a dangling link without repair, and clears after manual correction", async ({ daemon, page }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "extensions");
  await expect(page.getByRole("heading", { name: "Agent extensions" })).toBeVisible();
  const install = page.getByRole("button", { name: "Install Pi integration" });
  await expect(install).toBeVisible();
  const evidence = artifactsDir("pi-extension-setup"); mkdirSync(evidence, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await page.locator(".setup-panel").screenshot({ path: join(evidence, "first-install.png") });
  await install.click();
  await expect(page.getByRole("status")).toContainText("Pi integration installed");
  await expect(install).toHaveCount(0);
  const link = join(daemon.home, "pi-extensions", "mission-control.js");
  const expected = resolve("dist/pi-extension/index.js");
  const config = JSON.parse(readFileSync(join(daemon.home, "pi-extension.json"), "utf8"));
  expect(config.enabled).toBe(true);
  rmSync(link); symlinkSync(join(daemon.home, "gone.js"), link);
  await page.getByRole("button", { name: "Re-check" }).click();
  const warning = page.getByRole("article").filter({ has: page.locator("strong", { hasText: /^Pi extension$/ }) });
  await expect(warning).toContainText("Pi reports nothing");
  await expect(warning).toContainText("npm run install-pi-extension");
  await expect(warning.getByRole("button")).toHaveText(["Copy"]);
  await expect(install).toHaveCount(0);
  const refused = await fetch(`${daemon.baseURL}/api/setup/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "pi-integration" }) });
  expect(refused.status).toBe(409);
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await page.locator(".setup-panel").screenshot({ path: join(evidence, "dangling-report.png") });
  // A manual correction is external to the check. Re-check must see it without a restart.
  rmSync(link); symlinkSync(expected, link);
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(warning).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await page.locator(".setup-panel").screenshot({ path: join(evidence, "healthy.png") });
  console.log("Setup first install published the isolated link; dangling warning offered only Copy; server refused repair; manual correction cleared the warning without restart.");
});

test("Setup reports a module-scope load failure and enabled missing link", async ({ daemon, page }) => {
  const dir = join(daemon.home, "pi-extensions"); mkdirSync(dir, { recursive: true });
  const broken = join(daemon.home, "throws.js"); writeFileSync(broken, 'throw Error("load failure");');
  const link = join(dir, "mission-control.js"); symlinkSync(broken, link);
  writeFileSync(join(daemon.home, "pi-extension.json"), '{"enabled":true}');
  await page.goto(`${daemon.baseURL}/#/settings/setup`); await openSetupFamily(page, "extensions");
  const warning = page.getByRole("article").filter({ has: page.locator("strong", { hasText: /^Pi extension$/ }) });
  await expect(warning).toContainText("Every Pi session on this machine may refuse to start");
  await expect(page.getByRole("button", { name: "Install Pi integration" })).toHaveCount(0);
  const evidence = artifactsDir("pi-extension-setup"); mkdirSync(evidence, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await page.locator(".setup-panel").screenshot({ path: join(evidence, "load-failure.png") });
  rmSync(link); await page.getByRole("button", { name: "Re-check" }).click();
  await expect(warning).toContainText("integration is enabled");
  await expect(warning).toContainText("Pi reports nothing");
});

test("Setup reports a cyclic Pi extension link with manual guidance and no repair control", async ({ daemon, page }) => {
  const dir = join(daemon.home, "pi-extensions"); mkdirSync(dir, { recursive: true });
  const link = join(dir, "mission-control.js"); symlinkSync(link, link);
  writeFileSync(join(daemon.home, "pi-extension.json"), '{"enabled":true}');
  await page.goto(`${daemon.baseURL}/#/settings/setup`); await openSetupFamily(page, "extensions");
  const warning = page.getByRole("article").filter({ has: page.locator("strong", { hasText: /^Pi extension$/ }) });
  await expect(warning).toContainText("cannot be resolved");
  await expect(warning).toContainText("npm run install-pi-extension");
  await expect(warning).toContainText("required");
  await expect(warning.getByRole("button")).toHaveText(["Copy"]);
  await expect(page.getByRole("button", { name: "Install Pi integration" })).toHaveCount(0);
  const evidence = artifactsDir("pi-extension-setup"); mkdirSync(evidence, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  await page.locator(".setup-panel").screenshot({ path: join(evidence, "cyclic-link.png") });
});

test("Setup reports inaccessible extension entries and baked MCP bundles without repair", async ({ daemon, page }) => {
  test.skip(process.getuid?.() === 0, "root bypasses filesystem permission denial");
  const dir = join(daemon.home, "pi-extensions"); mkdirSync(dir, { recursive: true });
  const link = join(dir, "mission-control.js"); symlinkSync(resolve("dist/pi-extension/index.js"), link);
  writeFileSync(join(daemon.home, "pi-extension.json"), '{"enabled":true}');
  const evidence = artifactsDir("pi-extension-setup"); mkdirSync(evidence, { recursive: true });
  const warning = page.getByRole("article").filter({ has: page.locator("strong", { hasText: /^Pi extension$/ }) });
  chmodSync(dir, 0);
  try {
    await page.goto(`${daemon.baseURL}/#/settings/setup`); await openSetupFamily(page, "extensions");
    await expect(warning).toContainText("extension entry");
    await expect(warning).toContainText("cannot be inspected");
    await expect(warning).toContainText("permissions");
    await expect(warning.getByRole("button")).toHaveText(["Copy"]);
    await expect(page.getByRole("button", { name: "Install Pi integration" })).toHaveCount(0);
    await page.mouse.move(0, 0); await expect(page.locator(".tooltip")).toHaveCount(0);
    await page.locator(".setup-panel").screenshot({ path: join(evidence, "inaccessible-entry.png") });
  } finally { chmodSync(dir, 0o700); }
  const restricted = join(daemon.home, "restricted-mcp"); mkdirSync(restricted);
  const baked = join(restricted, "server.mjs"); writeFileSync(baked, "export {};");
  const bundle = join(daemon.home, "inaccessible-bridge.js");
  writeFileSync(bundle, `export default () => {}; export const missionControlBuild = ${JSON.stringify({ version: "fixture", mcpServerPath: baked })};`);
  rmSync(link); symlinkSync(bundle, link); chmodSync(restricted, 0);
  try {
    await page.getByRole("button", { name: "Re-check" }).click();
    await expect(warning).toContainText("baked MCP bundle");
    await expect(warning).toContainText("cannot be inspected");
    await expect(warning).toContainText("Lifecycle reports may still work");
    await expect(warning.getByRole("button")).toHaveText(["Copy"]);
    await expect(page.getByRole("button", { name: "Install Pi integration" })).toHaveCount(0);
    await page.mouse.move(0, 0); await expect(page.locator(".tooltip")).toHaveCount(0);
    await page.locator(".setup-panel").screenshot({ path: join(evidence, "inaccessible-baked-mcp.png") });
  } finally { chmodSync(restricted, 0o700); }
  rmSync(link); symlinkSync(resolve("dist/pi-extension/index.js"), link);
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(warning).toHaveCount(0);
});

test("a healthy installed extension admits a Pi plan dispatch through the real daemon guard", async ({ daemon, dashboard }) => {
  const put = async (path: string, body: unknown) => {
    const response = await fetch(`${daemon.baseURL}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.ok, await response.text()).toBe(true);
  };
  await put("/api/skills/config", { enabled: true, skills: { "html-plans": true, "phased-plan": true } });
  test.skip(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0, "tmux is required for the real Pi terminal proof");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(daemon.home, "fake-bin", "fake-pi"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve("e2e/fixtures/fake-pi-plan.mjs"))} ${quote(daemon.home)} ${quote(resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"))} "$@"\n`);
  const agentDir = join(daemon.home, "pi-agent"); mkdirSync(agentDir, { recursive: true });
  symlinkSync(join(daemon.home, "pi-extensions"), join(agentDir, "extensions"));
  await put("/api/harnesses/config", { sessionRuntime: { pi: "terminal" }, terminalBackend: { pi: "tmux" } });
  const installed = await fetch(`${daemon.baseURL}/api/setup/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "pi-integration" }) });
  expect(installed.ok, await installed.text()).toBe(true);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Plan the Pi integration proof");
  await dialog.getByLabel("Agent").selectOption("pi");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await dialog.getByRole("combobox", { name: /^Model/ }).selectOption("openai/gpt-5.6-sol");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: /^Dispatch/ }).click();
  await expect(dialog).toBeHidden();
  const tasksNow = async () => await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{ agent: string; kind: string; status: string; sessionId: string | null; homeName: string | null; homeBackend: string | null; error: string | null }>;
  try { await expect.poll(async () => {
    const tasks = await tasksNow();
    return tasks.find(task => task.agent === "pi" && task.kind === "plan" && task.sessionId)?.status;
  }, { timeout: 60_000 }).toBe("running");
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(join(daemon.home, "pi-plan-payload.json"), "utf8")).tools.map((tool: { function: { name: string } }) => tool.function.name); }
    catch { return []; }
  }).toEqual(expect.arrayContaining(["request_plan_decisions", "create_task", "request_input"]));
  const task = (await tasksNow()).find(task => task.agent === "pi" && task.kind === "plan")!;
  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: task.homeName! });
  await row.click();
  const evidence = artifactsDir("pi-extension-setup"); mkdirSync(evidence, { recursive: true });
  await dashboard.mouse.move(0, 0);
  await dashboard.screenshot({ path: join(evidence, "pi-plan-dispatched.png") });
  console.log("Real Pi plan dispatch: running task bound to a terminal session; Pi auto-discovered the installed extension; loopback provider received request_plan_decisions, create_task and request_input. Zero external model calls.");
  } catch (error) {
    console.log(await tasksNow()); console.log(daemon.readLog());
    const task = (await tasksNow()).find(task => task.agent === "pi" && task.kind === "plan");
    if (task?.homeName && task.homeBackend === "tmux") console.log(spawnSync("tmux", ["capture-pane", "-p", "-t", task.homeName, "-S", "-100"]).stdout?.toString());
    throw error;
  } finally {
    const task = (await tasksNow()).find(task => task.agent === "pi" && task.kind === "plan");
    if (task?.homeName && task.homeBackend === "tmux") spawnSync("tmux", ["kill-session", "-t", task.homeName], { stdio: "ignore" });
  }
});


test.describe("first-install preflight failure", () => {
  const candidate = join(tmpdir(), `mission-pi-preflight-${process.pid}.js`);
  test.use({ daemonEnv: { MISSION_PI_EXTENSION: candidate } });
  test.beforeAll(() => {
    mkdirSync(artifactsDir("pi-extension-setup"), { recursive: true });
    writeFileSync(candidate, 'throw Error("candidate fixture cannot load");');
  });
  test.afterAll(() => rmSync(candidate, { force: true }));
  test("Setup explains that a rejected candidate was never installed", async ({ daemon, page }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "extensions");
    const install = page.getByRole("button", { name: "Install Pi integration" });
    await install.click();
    const status = page.getByRole("status");
    await expect(status).toContainText("Nothing was installed or enabled");
    await expect(status).toContainText("candidate Pi extension");
    await expect(status).not.toContainText("Every Pi session on this machine may refuse");
    await expect(install).toBeEnabled();
    await page.mouse.move(0, 0);
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await page.locator(".setup-panel").screenshot({ path: join(artifactsDir("pi-extension-setup"), "candidate-refused.png") });
  });
});
