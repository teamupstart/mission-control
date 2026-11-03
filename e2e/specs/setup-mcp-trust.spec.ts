import { mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

for (const [agent, label, directory, filename, initial] of [
  ["claude", "Claude Code", ".claude", "settings.json", '{"permissions":{"allow":["Read"],"deny":["Bash(rm *)"]}}'],
  ["codex", "Codex", ".codex", "config.toml", '# preserve\napproval_policy = "on-request"\n[mcp_servers.mission-control]\ncommand = "node"\nargs = ["server.mjs"]\n'],
] as const) {
  test(`${label} MCP trust repairs user settings and survives recheck`, async ({ page, daemon }) => {
    const dir = join(daemon.home, directory);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, initial);
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "extensions");
    const anchor = `dependency-${agent}-mcp-trust`;
    const row = setupRow(page, anchor);
    await expectRowStatus(page, anchor, "Needs setup");
    expect(readFileSync(path, "utf8")).toBe(initial);
    await row.getByRole("button", { name: `Trust Mission Control in ${label}` }).click();
    await expectRowStatus(page, anchor, "Ready");
    const result = readFileSync(path, "utf8");
    if (agent === "claude") {
      expect(JSON.parse(result)).toEqual({ permissions: { allow: ["Read", "mcp__mission-control__*"], deny: ["Bash(rm *)"] } });
    } else {
      expect(parseToml(result)).toMatchObject({ approval_policy: "on-request", mcp_servers: { "mission-control": { command: "node", args: ["server.mjs"], default_tools_approval_mode: "approve" } } });
      expect(result).toContain("# preserve");
    }
    await page.reload();
    await openSetupFamily(page, "extensions");
    await expectRowStatus(page, anchor, "Ready");
    await expect(row.getByRole("button", { name: `Trust Mission Control in ${label}` })).toHaveCount(0);
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const out = artifactsDir("mcp-trust");
      mkdirSync(out, { recursive: true });
      await row.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      await page.screenshot({ path: join(out, `${agent}-ready.png`) });
    }
    writeFileSync(path, agent === "claude" ? '{"permissions":false}' : '[invalid');
    await page.reload();
    await openSetupFamily(page, "extensions");
    await expectRowStatus(page, anchor, "Unknown");
    const invalid = readFileSync(path, "utf8");
    await row.getByRole("button", { name: `Trust Mission Control in ${label}` }).click();
    await expect(row).toContainText("Fix the file and retry.");
    await expect(row).toContainText("Fix the file named above as described, then press Re-check.");
    await expect(row).not.toContainText("Start it yourself in a terminal");
    expect(readFileSync(path, "utf8")).toBe(invalid);

    const target = join(dir, "linked-settings");
    writeFileSync(target, initial);
    unlinkSync(path);
    symlinkSync("linked-settings", path);
    const beforeRepair = readdirSync(dir).sort();
    await page.reload();
    await openSetupFamily(page, "extensions");
    await expectRowStatus(page, anchor, "Needs setup");
    await row.getByRole("button", { name: `Trust Mission Control in ${label}` }).click();
    await expect(row).toContainText("cannot update a symlinked settings file");
    expect(readFileSync(target, "utf8")).toBe(initial);
    expect(readlinkSync(path)).toBe("linked-settings");
    expect(readdirSync(dir).sort()).toEqual(beforeRepair);
  });
}

// The reported dead end: Codex has never had Mission Control registered, so trust has no
// server table to edit. The refusal must offer the install that writes one, then finish
// the trust, instead of sending the operator to a terminal.
test("Codex MCP trust offers the integration install when the server is not registered", async ({ page, daemon }) => {
  const dir = join(daemon.home, ".codex");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.toml");
  const initial = '# preserve\napproval_policy = "on-request"\n[mcp_servers.other]\nurl = "https://example.invalid"\n';
  writeFileSync(path, initial);
  let installs = 0;
  await page.exposeFunction("installFixture", () => {
    installs += 1;
    writeFileSync(path, `${readFileSync(path, "utf8")}[mcp_servers.mission-control]\ncommand = "node"\nargs = ["server.mjs"]\n`);
    return { ok: true, message: "Claude integrations installed via this app's bundled Node." };
  });
  await page.addInitScript(() => Object.defineProperty(window, "missionDesktop", { value: {
    isDesktop: true,
    onOpenSettings: () => () => {},
    installIntegrations: () => (window as unknown as { installFixture(): Promise<unknown> }).installFixture(),
  } }));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "extensions");
  const anchor = "dependency-codex-mcp-trust";
  const row = setupRow(page, anchor);
  await expectRowStatus(page, anchor, "Needs setup");
  await expect(row).toContainText("Mission Control MCP is not registered in Codex yet.");

  await row.getByRole("button", { name: "Trust Mission Control in Codex" }).click();
  await expect(row.getByRole("status")).toContainText("not registered in Codex yet");
  await expect(row).not.toContainText("Start it yourself in a terminal");
  expect(readFileSync(path, "utf8")).toBe(initial);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const out = artifactsDir("mcp-trust");
    mkdirSync(out, { recursive: true });
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(out, "codex-needs-integration.png") });
  }

  await row.getByRole("button", { name: "Install Claude integrations" }).click();
  await expectRowStatus(page, anchor, "Ready");
  expect(installs).toBe(1);
  const result = readFileSync(path, "utf8");
  expect(result).toContain("# preserve");
  expect(parseToml(result)).toMatchObject({
    approval_policy: "on-request",
    mcp_servers: { other: { url: "https://example.invalid" }, "mission-control": { command: "node", default_tools_approval_mode: "approve" } },
  });
  if (process.env.MC_E2E_EVIDENCE === "1") {
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(artifactsDir("mcp-trust"), "codex-installed-and-trusted.png") });
  }
});

test("a failed inline integration install shows its error and never retries the trust", async ({ page, daemon }) => {
  const dir = join(daemon.home, ".codex");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.toml");
  const initial = 'approval_policy = "on-request"\n';
  writeFileSync(path, initial);
  // First press: the installer answers but reports failure. Second: the bridge itself throws.
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true,
      onOpenSettings: () => () => {},
      installIntegrations: async () => {
        if (++attempts === 1) return { ok: false, message: "Codex: MCP installation needs attention: codex was not found" };
        throw new Error("Synthetic desktop bridge rejection");
      },
    } });
  });
  let trustStarts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/setup/service")) trustStarts += 1;
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "extensions");
  const anchor = "dependency-codex-mcp-trust";
  const row = setupRow(page, anchor);
  await row.getByRole("button", { name: "Trust Mission Control in Codex" }).click();
  const install = row.getByRole("button", { name: "Install Claude integrations" });
  await expect(install).toBeVisible();
  expect(trustStarts).toBe(1);

  await install.click();
  await expect(row.getByText("Codex: MCP installation needs attention: codex was not found")).toBeVisible();
  await expect(install).toBeEnabled();
  expect(trustStarts).toBe(1);
  await expectRowStatus(page, anchor, "Needs setup");
  expect(readFileSync(path, "utf8")).toBe(initial);

  await install.click();
  await expect(row.getByText("Integration install could not finish. Check the app log and retry.")).toBeVisible();
  await expect(row.getByText("codex was not found")).toHaveCount(0);
  await expect(install).toBeEnabled();
  expect(trustStarts).toBe(1);
  await expectRowStatus(page, anchor, "Needs setup");
  expect(readFileSync(path, "utf8")).toBe(initial);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const out = artifactsDir("mcp-trust");
    mkdirSync(out, { recursive: true });
    await row.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(out, "codex-inline-install-failed-r3.png") });
  }

  // A fresh trust attempt replaces the whole outcome; the old install failure must not linger.
  await row.getByRole("button", { name: "Trust Mission Control in Codex" }).click();
  await expect.poll(() => trustStarts).toBe(2);
  await expect(row.getByRole("status")).toContainText("not registered in Codex yet");
  await expect(row.getByText("Integration install could not finish. Check the app log and retry.")).toHaveCount(0);

  // And a trust that now succeeds: fail the install once more, register the server out of
  // band, then trust. The row turns Ready with no leftover install failure beside it.
  await install.click();
  await expect(row.getByText("Integration install could not finish. Check the app log and retry.")).toBeVisible();
  writeFileSync(path, `${initial}[mcp_servers.mission-control]\ncommand = "node"\nargs = ["server.mjs"]\n`);
  await row.getByRole("button", { name: "Trust Mission Control in Codex" }).click();
  await expectRowStatus(page, anchor, "Ready");
  expect(trustStarts).toBe(3);
  await expect(row.getByText("Integration install could not finish. Check the app log and retry.")).toHaveCount(0);
  expect(parseToml(readFileSync(path, "utf8"))).toMatchObject({ mcp_servers: { "mission-control": { default_tools_approval_mode: "approve" } } });
});

test("Codex MCP trust without the desktop bridge names where the install lives", async ({ page, daemon }) => {
  const dir = join(daemon.home, ".codex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), 'approval_policy = "on-request"\n');
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "extensions");
  const row = setupRow(page, "dependency-codex-mcp-trust");
  await row.getByRole("button", { name: "Trust Mission Control in Codex" }).click();
  await expect(row).toContainText("Open Setup in the Mission Control desktop app and choose Install Claude integrations");
  await expect(row.getByRole("button", { name: "Install Claude integrations" })).toHaveCount(0);
});
