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
