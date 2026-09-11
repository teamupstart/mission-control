import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Session } from "../../src/shared/types.ts";
import { expect, test as base } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Opt in with an installed binary. The server and its panes are real; only the model
// provider is local and deterministic. A separate config root isolates every Herdr call.
const herdrBin = process.env.MC_E2E_REAL_HERDR_BIN;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
type HerdrFixture = { env: Record<string, string>; cli: (...args: string[]) => string };
const test = base.extend<{ realHerdr: HerdrFixture }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture dependencies.
  realHerdr: async ({}, use) => {
    if (!herdrBin || !isAbsolute(herdrBin)) throw new Error("Set MC_E2E_REAL_HERDR_BIN to an absolute Herdr binary path");
    const home = mkdtempSync(join(tmpdir(), "h-"));
    const env = {
      XDG_CONFIG_HOME: join(home, "c"), HERDR_CONFIG_PATH: join(home, "c", "config.toml"),
      XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"),
    };
    mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
    writeFileSync(env.HERDR_CONFIG_PATH, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n');
    const childEnv = { ...process.env, ...env, HOME: home };
    for (const key of ["HERDR_SESSION", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "TMUX", "TMUX_PANE"]) delete childEnv[key];
    const cli = (...args: string[]) => execFileSync(herdrBin, args, { env: childEnv, encoding: "utf8", timeout: 10_000 });
    const before = JSON.parse(cli("status", "server", "--json")) as { running: boolean; socket: string };
    expect(before.running).toBe(false);
    expect(before.socket.startsWith(`${home}/`)).toBe(true);
    const server = spawn(herdrBin, ["server"], { env: childEnv, stdio: "ignore" });
    const exited = new Promise<void>((done) => server.once("exit", () => done()));
    try {
      await expect.poll(() => JSON.parse(cli("status", "server", "--json")).running).toBe(true);
      console.log(`REAL HERDR: ${cli("--version").trim()}; isolated server socket ${before.socket}`);
      await use({ env, cli });
    } finally {
      spawnSync(herdrBin, ["server", "stop"], { env: childEnv, stdio: "ignore", timeout: 10_000 });
      if (server.exitCode === null) server.kill("SIGTERM");
      await exited;
      rmSync(home, { recursive: true, force: true });
    }
  },
  daemonEnv: async ({ realHerdr }, use) => {
    await use({ ...realHerdr.env, MISSION_HERDR_BIN: herdrBin!, MISSION_POLL_MS: "300", MISSION_USAGE_POLL_MS: "300", MISSION_TMUX_BIN: "/nonexistent/mc-herdr-test-tmux" });
  },
});
test.skip(!herdrBin, "Set MC_E2E_REAL_HERDR_BIN to exercise the installed Herdr server");

test("real Pi through Herdr retains its interrupt marker after conversation reload", async ({ dashboard, daemon, realHerdr }) => {
  const dir = join(daemon.home, "pi-herdr");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  let requests = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the local request */ }
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (content: string, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: "herdr-interrupt-proof", object: "chat.completion.chunk", model: "pi-probe",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }],
    })}\n\n`);
    frame(requests === 1 ? "Pi through Herdr partial response" : "Pi through Herdr continued");
    if (requests > 1) { frame("", "stop"); res.end("data: [DONE]\n\n"); }
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("provider has no address");
  const providerFile = join(dir, "provider.js");
  writeFileSync(providerFile, `export default function(pi) { pi.registerProvider("mission-test", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local-proof", api: "openai-completions",
    models: [{ id: "pi-probe", name: "Pi Herdr Proof", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }]
  }); }`);
  const bin = join(dir, "pi");
  symlinkSync(process.execPath, bin);
  const env = {
    HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", MISSION_HOME: daemon.home,
    MISSION_PORT: new URL(daemon.baseURL).port,
    MISSION_API_TOKEN: readFileSync(join(daemon.home, "token"), "utf8").trim(),
    MISSION_MCP_SERVER: resolve("dist/mcp/server.mjs"),
  };
  const launch = join(dir, "launch.sh");
  const command = [bin, resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
    "--no-themes", "--no-approve", "-e", resolve("dist/pi-extension/index.js"),
    "-e", providerFile, "--provider", "mission-test", "--model", "pi-probe"];
  writeFileSync(launch, `#!/bin/sh\nunset MISSION_SESSION_ID MISSION_AGENT_SESSION_ID CLAUDE_SESSION_ID MISSION_API_TOKEN_FILE FLEET_HOME HARNESS_HOME\n${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexec ${command.map(quote).join(" ")}\n`);
  const name = `Pi through Herdr interrupt proof ${process.pid}`;
  let paneId: string | undefined;
  let workspaceId: string | undefined;
  try {
    const { result: created } = JSON.parse(realHerdr.cli("workspace", "create", "--cwd", daemon.repo, "--label", name, "--no-focus"));
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    expect(paneId).toBeTruthy();
    realHerdr.cli("pane", "send-text", paneId!, `/bin/sh ${quote(launch)}`);
    await expect.poll(() => realHerdr.cli("pane", "read", paneId!, "--format", "text")).toContain("launch.sh");
    realHerdr.cli("pane", "send-keys", paneId!, "enter");
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.click();
    const detail = dashboard.locator(".console-detail");
    await expect(detail).toContainText("herdr");
    await expect.poll(async () => {
      const response = await dashboard.request.get(`${daemon.baseURL}/api/sessions`);
      const sessions = await response.json() as Session[];
      const session = sessions.find(item => item.name === name);
      return session?.agent === "pi" && session.terminals.some(handle => handle.kind === "multiplexer" && handle.backend === "herdr" && handle.paneId === paneId);
    }).toBeTruthy();
    // Discovery can see Pi before it is ready to accept the first prompt.
    await expect.poll(() => realHerdr.cli("pane", "read", paneId!, "--format", "text")).toContain("(mission-test) pi-probe");
    const send = async (text: string) => {
      realHerdr.cli("pane", "send-text", paneId!, text);
      await expect.poll(() => realHerdr.cli("pane", "read", paneId!, "--format", "text")).toContain(text);
      realHerdr.cli("pane", "send-keys", paneId!, "enter");
    };
    await send("Hold this turn through Herdr");
    await expect.poll(() => requests).toBe(1);
    await expect.poll(() => realHerdr.cli("pane", "read", paneId!, "--format", "text")).toContain("Pi through Herdr partial response");
    await detail.getByRole("button", { name: /^interrupt\b/ }).click();
    const marker = detail.getByText("[Request interrupted by user]", { exact: true });
    await expect(marker).toHaveCount(1);
    await expect(detail.getByText("Pi through Herdr partial response", { exact: true })).toBeVisible();
    await dashboard.reload();
    await row.click();
    await expect(marker).toBeVisible();
    await send("Continue after the Herdr interrupt");
    await expect(detail.getByText("Pi through Herdr continued", { exact: true })).toBeVisible();
    await expect(marker).toHaveCount(1);
    console.log("PASS: real Pi discovered through Herdr; active turn interrupted from dashboard; marker and partial output retained after reload; follow-up completed.");
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("pi-interrupt-conversation");
      mkdirSync(evidence, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: join(evidence, "real-pi-herdr.png") });
    }
  } catch (error) {
    if (paneId) console.log(realHerdr.cli("pane", "read", paneId, "--format", "text"));
    throw error;
  } finally {
    try {
      if (workspaceId) realHerdr.cli("workspace", "close", workspaceId);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
    }
  }
});
