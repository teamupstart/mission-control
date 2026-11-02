import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { argvValue, recordsIn } from "../fixtures/records.ts";

// A custom MCP server with a write-only secret, defined on #/residents, selected on a profile,
// named in Dispatch's launch summary, and attached to the launch the fake Claude receives - as a
// launcher entry under strict MCP config, with the secret on no command line and in no payload.
// The global catalog reads the fixture home's `~/.claude.json`; no model tokens are spent.

const SECRET = "e2e-mcp-sentinel-secret-5209";
const GLOBAL_SECRET = "e2e-mcp-global-sentinel-8841";
const EVIDENCE = artifactsDir("residents-mcp");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

test("a custom MCP server's secret is write-only, its selection reaches the launch summary and the launch, and no payload carries a secret", async ({
  dashboard: page,
  daemon,
}) => {
  // The custom server: a fixture that records the environment it was started with.
  const fixture = join(daemon.home, "linear-fixture.mjs");
  const started = join(daemon.home, "linear-started.json");
  writeFileSync(fixture, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify(process.env));\n`);
  writeFileSync(join(daemon.home, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: {
      "github-global": { command: "/usr/local/bin/github-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: GLOBAL_SECRET } },
      leaky: { command: "srv", args: [`--token=${GLOBAL_SECRET}`] },
    },
  }));

  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("button", { name: "Custom MCP servers" }).click();
  await expect(page).toHaveURL(/#\/residents\/mcp-servers$/);
  const panel = page.getByRole("region", { name: "Custom MCP servers" });

  // The global catalog: metadata only, and the reason a server cannot be used.
  const claudeGlobals = panel.getByRole("region", { name: "Claude Code global MCP servers" });
  await expect(claudeGlobals).toContainText("github-global");
  await expect(claudeGlobals).toContainText("uses GITHUB_TOKEN");
  await expect(claudeGlobals).toContainText("Unavailable to residents: argument 1");

  // A credential in an argument is refused, naming the argument.
  await panel.getByRole("button", { name: "New server" }).click();
  let editor = panel.getByRole("form", { name: "New custom MCP server" });
  await editor.getByLabel("Server name").fill("refused");
  await editor.getByRole("textbox", { name: "Command", exact: true }).fill("srv");
  await editor.getByLabel(/^Arguments/).fill("--api-key=abc");
  await editor.getByRole("button", { name: "Save server" }).click();
  await expect(panel.getByRole("alert")).toContainText("argument 1 (--api-key) looks like a credential-named value");
  await editor.getByRole("button", { name: "Cancel" }).click();

  // A stdio server with one secret and one plain variable.
  await panel.getByRole("button", { name: "New server" }).click();
  editor = panel.getByRole("form", { name: "New custom MCP server" });
  await editor.getByLabel("Server name").fill("linear");
  await editor.getByRole("textbox", { name: "Command", exact: true }).fill(process.execPath);
  await editor.getByLabel(/^Arguments/).fill(`${fixture}\n${started}`);
  await editor.getByRole("button", { name: "Add environment variable" }).click();
  await editor.getByLabel("Environment variable 1 name").fill("LINEAR_TOKEN");
  await editor.getByLabel("Environment variable 1 secret").check();
  await editor.getByLabel("Environment variable 1 value").fill(SECRET);
  await expect(editor.getByLabel("Environment variable 1 value")).toHaveAttribute("type", "password");
  await editor.getByRole("button", { name: "Add environment variable" }).click();
  await editor.getByLabel("Environment variable 2 name").fill("LOG_LEVEL");
  await editor.getByLabel("Environment variable 2 value").fill("info");
  await capture(panel, "custom-server-editor");
  await editor.getByRole("button", { name: "Save server" }).click();
  await expect(editor).toBeHidden();
  const list = panel.getByRole("list", { name: "Custom MCP servers list" });
  await expect(list).toContainText("linear");
  await expect(list).toContainText("1 secret value");

  // Opened again, the secret is never shown: the field is empty and says it is set.
  await panel.getByRole("button", { name: "Edit linear" }).click();
  editor = panel.getByRole("form", { name: "Edit linear" });
  const secretField = editor.getByLabel("Environment variable 1 value");
  await expect(secretField).toHaveValue("");
  await expect(secretField).toHaveAttribute("placeholder", "Set - leave blank to keep");
  await expect(editor.getByLabel("Environment variable 2 value")).toHaveValue("info");
  expect(await page.content()).not.toContain(SECRET);
  await capture(panel, "custom-server-secret-set");
  // A new connection with the secret left blank is refused, naming what to enter again: a value
  // never follows the server to a different command.
  await editor.getByLabel(/^Arguments/).fill(`${fixture}\n${started}\n--elsewhere`);
  await editor.getByRole("button", { name: "Save server" }).click();
  const refusal = panel.getByRole("alert");
  await expect(refusal).toContainText("this server's connection changed, so enter LINEAR_TOKEN again");
  await expect(editor).toBeVisible();
  await capture(refusal, "custom-server-connection-changed");
  await editor.getByRole("button", { name: "Cancel" }).click();

  // No route returns a secret: the catalog carries names and "set", never values.
  const catalog = await (await fetch(`${daemon.baseURL}/api/residents/mcp-catalog`)).text();
  expect(catalog).toContain("LINEAR_TOKEN");
  expect(catalog).not.toContain(SECRET);
  expect(catalog).not.toContain(GLOBAL_SECRET);
  expect(catalog).not.toContain("--stdio");

  // A profile selects it, beside the inherited defaults.
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const profile = page.getByRole("region", { name: "New resident profile" });
  await profile.getByLabel("Name").fill("MCP Resident");
  await profile.getByRole("combobox", { name: "Persona" }).selectOption({ label: "Code Risk Reviewer · built-in" });
  await profile.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await expect(profile.getByRole("checkbox", { name: "Inherit harness defaults" })).toBeChecked();
  const add = profile.getByRole("combobox", { name: "Add an MCP server" });
  await expect(add.locator("option", { hasText: "leaky (unavailable)" })).toHaveAttribute("disabled", "");
  await add.selectOption({ label: "linear" });
  await profile.getByRole("button", { name: "Add", exact: true }).click();
  const selected = profile.getByRole("list", { name: "Selected MCP servers" });
  await expect(selected).toContainText("linear");
  await expect(selected).toContainText("custom");
  await capture(profile, "profile-mcp-section");
  await profile.getByRole("button", { name: "Save" }).click();
  const saved = page.getByRole("region", { name: "Resident profile MCP Resident" });
  await expect(saved).toContainText("Revision 1");

  // Dispatch names it in the launch summary.
  await saved.getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toContainText("MCP: defaults + linear");
  await capture(dialog, "dispatch-launch-summary");
  // With inherit on, a global server residents cannot represent refuses the launch, naming why.
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Claude Code's global MCP server leaky is inherited but residents cannot use it: argument 1 (--token) looks like a credential-named value",
    { timeout: 60_000 },
  );
  expect(await page.content()).not.toContain(GLOBAL_SECRET);
  await capture(dialog, "dispatch-refused-unrepresentable-global");
  // The operator fixes the native configuration; the next launch reads it afresh.
  writeFileSync(join(daemon.home, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { "github-global": { command: "/usr/local/bin/github-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: GLOBAL_SECRET } } },
  }));
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // The launch the agent received: strict MCP config, Mission's server, the inherited global
  // and the custom server - both through the scoped launcher - and no secret in any argument.
  let argv: string[] = [];
  await expect.poll(() => {
    const record = recordsIn<{ argv: string[] }>(join(daemon.recordDir, "claude"))
      .find((entry) => entry.argv.includes("--strict-mcp-config"));
    argv = record?.argv ?? [];
    return argv.length > 0;
  }, { timeout: 60_000 }).toBe(true);
  const servers = JSON.parse(argvValue(argv, "--mcp-config") ?? "{}").mcpServers as Record<string, { args: string[] }>;
  expect(Object.keys(servers).sort()).toEqual(["github-global", "linear", "mission-control"]);
  for (const name of ["github-global", "linear"]) {
    expect(servers[name]!.args).toContain("--credential");
    expect(servers[name]!.args).not.toContain("--stdio");
  }
  expect(argv.join(" ")).not.toContain(SECRET);
  expect(argv.join(" ")).not.toContain(GLOBAL_SECRET);
  expect(argv.join(" ")).not.toContain("/usr/local/bin/github-mcp");

  // Start the custom server the way the agent would: the built launcher, with only what the
  // entry names. It redeems its ticket through the daemon's route, and the secret reaches that
  // server's environment.
  const linear = servers.linear as { command: string; args: string[]; env: Record<string, string> };
  const credential = linear.args[linear.args.indexOf("--credential") + 1]!;
  expect(existsSync(credential)).toBe(true);
  const first = spawnSync(linear.command, linear.args, { env: { PATH: process.env.PATH, ...linear.env }, encoding: "utf8", timeout: 30_000 });
  expect(first.status, first.stderr).toBe(0);
  expect(existsSync(credential)).toBe(false);
  const env = JSON.parse(readFileSync(started, "utf8")) as Record<string, string>;
  expect(env.LINEAR_TOKEN).toBe(SECRET);
  expect(env.LOG_LEVEL).toBe("info");
  expect(`${first.stdout}${first.stderr}`).not.toContain(SECRET);
  // The ticket was single-use: the same start again starts nothing.
  const second = spawnSync(linear.command, linear.args, { env: { PATH: process.env.PATH, ...linear.env }, encoding: "utf8", timeout: 30_000 });
  expect(second.status).toBe(1);
  expect(second.stderr).toContain("credential file is missing");
});

test("a profile that selects a global server with inheritance off launches with only that server and Mission Control's", async ({
  dashboard: page,
  daemon,
}) => {
  // Two usable globals and one residents cannot use: with inheritance off, only the selection
  // may reach the launch, and the unusable one no longer refuses it.
  writeFileSync(join(daemon.home, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: {
      "github-global": { command: "/usr/local/bin/github-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: GLOBAL_SECRET } },
      "docs-global": { command: "/usr/local/bin/docs-mcp" },
      leaky: { command: "srv", args: [`--token=${GLOBAL_SECRET}`] },
    },
  }));

  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const profile = page.getByRole("region", { name: "New resident profile" });
  await profile.getByLabel("Name").fill("Selection Resident");
  await profile.getByRole("combobox", { name: "Persona" }).selectOption({ label: "Code Risk Reviewer · built-in" });
  await profile.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");
  const inherit = profile.getByRole("checkbox", { name: "Inherit harness defaults" });
  await inherit.uncheck();
  await expect(profile.getByText("Only the selection.", { exact: false })).toBeVisible();
  const add = profile.getByRole("combobox", { name: "Add an MCP server" });
  await add.selectOption({ label: "github-global" });
  await profile.getByRole("button", { name: "Add", exact: true }).click();
  await expect(profile.getByRole("list", { name: "Selected MCP servers" })).toContainText("github-global");
  await profile.getByRole("button", { name: "Save" }).click();
  const saved = page.getByRole("region", { name: "Resident profile Selection Resident" });
  await expect(saved).toContainText("Revision 1");

  // The saved profile shows the final state: inheritance off, one global server selected.
  const section = saved.getByRole("region", { name: "MCP servers" });
  await expect(section.getByRole("checkbox", { name: "Inherit harness defaults" })).not.toBeChecked();
  const selected = section.getByRole("list", { name: "Selected MCP servers" });
  await expect(selected.getByRole("listitem")).toHaveCount(1);
  await expect(selected).toContainText("github-global");
  await section.scrollIntoViewIfNeeded();
  await capture(section, "profile-mcp-selection-only");

  await saved.getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toContainText("MCP: only github-global");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // The launch the agent received: strict MCP config, and exactly the selection plus Mission's
  // server. Neither the other usable global nor the unusable one is attached.
  let argv: string[] = [];
  await expect.poll(() => {
    const record = recordsIn<{ argv: string[] }>(join(daemon.recordDir, "claude"))
      .find((entry) => entry.argv.includes("--strict-mcp-config"));
    argv = record?.argv ?? [];
    return argv.length > 0;
  }, { timeout: 60_000 }).toBe(true);
  const servers = JSON.parse(argvValue(argv, "--mcp-config") ?? "{}").mcpServers as Record<string, { args: string[] }>;
  expect(Object.keys(servers).sort()).toEqual(["github-global", "mission-control"]);
  expect(servers["github-global"]!.args).toContain("--credential");
  expect(argv.join(" ")).not.toContain(GLOBAL_SECRET);
});
