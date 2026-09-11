import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Run the pinned Pi TUI with a deterministic loopback provider. Discovery only acts on our
// uniquely named tmux pane. The provider never reaches an account or an external model.
test.use({ daemonEnv: { MISSION_POLL_MS: "300", MISSION_USAGE_POLL_MS: "300" } });
const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

test("Pi terminal interrupts reach the conversation from the dashboard and directly from the pane", async ({ dashboard, daemon }) => {
  test.skip(tmuxMissing, "tmux is required for the real Pi terminal boundary");
  const dir = join(daemon.home, "pi-interrupt");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  let requests = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the local request */ }
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (content: string, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: "interrupt-proof", object: "chat.completion.chunk", model: "pi-probe",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }],
    })}\n\n`);
    frame(requests === 1 ? "Pi terminal partial response" : requests === 2 ? "" : "Pi terminal continued");
    if (requests > 2) { frame("", "stop"); res.end("data: [DONE]\n\n"); }
    // The first two requests stay open until Pi aborts them.
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("provider has no address");
  const providerFile = join(dir, "provider.js");
  writeFileSync(providerFile, `export default function(pi) { pi.registerProvider("mission-test", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local-proof", api: "openai-completions",
    models: [{ id: "pi-probe", name: "Pi Interrupt Proof", reasoning: false, input: ["text"],
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
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const command = [bin, cli, "--offline", "--no-extensions", "--no-skills", "--no-context-files",
    "--no-prompt-templates", "--no-themes", "--no-approve", "-e", resolve("dist/pi-extension/index.js"),
    "-e", providerFile, "--provider", "mission-test", "--model", "pi-probe"];
  writeFileSync(launch, `#!/bin/sh\nunset MISSION_SESSION_ID MISSION_AGENT_SESSION_ID CLAUDE_SESSION_ID MISSION_API_TOKEN_FILE FLEET_HOME HARNESS_HOME\n${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexec ${command.map(quote).join(" ")}\n`);
  const session = `mc-pi-interrupt-${process.pid}-${Date.now()}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "130", "-y", "45", "-c", daemon.repo, `/bin/sh ${quote(launch)}`]);
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: session });
    await expect(row).toHaveCount(1);
    await row.click();
    const detail = dashboard.locator(".console-detail");
    await expect(detail).toContainText(/tmux · %\d+/);
    // Discovery sees the process before Pi finishes startup. The extension's session-start
    // identity arrives after the TUI installs its normal submit handler.
    await expect.poll(async () => {
      const response = await dashboard.request.get(`${daemon.baseURL}/api/sessions`);
      const sessions = await response.json() as Array<{ name: string; agentSessionId: string | null }>;
      return sessions.find((item) => item.name === session)?.agentSessionId;
    }).toBeTruthy();
    const marker = detail.getByText("[Request interrupted by user]", { exact: true });
    for (let turn = 1; turn <= 2; turn++) {
      execFileSync("tmux", ["send-keys", "-t", session, `Hold turn ${turn}`, "Enter"]);
      await expect.poll(() => requests).toBe(turn);
      if (turn === 1) {
        // Provider bytes must reach Pi before the interrupt, otherwise it is an empty abort.
        await expect.poll(() => execFileSync("tmux", ["capture-pane", "-p", "-t", session], { encoding: "utf8" })).toContain("Pi terminal partial response");
        await detail.getByRole("button", { name: /^interrupt\b/ }).click();
      } else {
        execFileSync("tmux", ["send-keys", "-t", session, "Escape"]);
      }
      await expect(marker).toHaveCount(turn);
    }
    await expect(detail.getByText("Pi terminal partial response", { exact: true })).toBeVisible();
    execFileSync("tmux", ["send-keys", "-t", session, "Continue now", "Enter"]);
    await expect(detail.getByText("Pi terminal continued", { exact: true })).toBeVisible();
    await dashboard.reload();
    await row.click();
    await expect(marker).toHaveCount(2);
    await expect(detail.getByText("Pi terminal continued", { exact: true })).toBeVisible();
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("pi-interrupt-conversation");
      mkdirSync(evidence, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: join(evidence, "real-pi-tmux.png") });
    }
  } catch (error) {
    console.log(spawnSync("tmux", ["capture-pane", "-p", "-t", session], { encoding: "utf8" }).stdout);
    throw error;
  } finally {
    spawnSync("tmux", ["kill-session", "-t", session]);
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
});
