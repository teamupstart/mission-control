import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

// A shared tmux server can restart between concurrent fixtures and reuse its pane ids.
// Give discovery and this test the same private socket so another fixture's retired pane
// cannot receive this extension's hooks or review before its eviction timer expires.
test.use({ daemonEnv: async ({}, use) => {
  const dir = mkdtempSync(join(tmpdir(), "mc-pi-tmux-"));
  const bin = join(dir, "tmux-private");
  writeFileSync(bin, `#!/bin/sh\nexec tmux -S ${quote(join(dir, "socket"))} "$@"\n`, { mode: 0o755 });
  try {
    await use({ MISSION_TMUX_BIN: bin, MISSION_POLL_MS: "300", MISSION_USAGE_POLL_MS: "300" });
  } finally {
    spawnSync(bin, ["kill-server"]);
    rmSync(dir, { recursive: true, force: true });
  }
} });
const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

test("hand-run Pi loads the extension, blocks on a dashboard answer and reports live metadata and cost", async ({ daemon, daemonEnv, dashboard }) => {
  test.skip(tmuxMissing, "tmux is required for passive terminal discovery");
  const tmux = daemonEnv.MISSION_TMUX_BIN!;
  const dir = join(daemon.home, "pi-proof"); mkdirSync(dir);
  const agentDir = join(dir, "agent"); mkdirSync(agentDir);
  const session = `mc-pi-proof-${process.pid}-${Date.now()}`;
  const log = join(dir, "pi.log");
  const extensionPath = resolve("dist/pi-extension/index.js");
  const livePi = process.env.MC_E2E_LIVE_PI;
  let requests = 0;
  const payloads: unknown[] = [];
  // The installed Pi reaches only this local deterministic provider, with no account key.
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body)); requests++;
    const delta = requests === 1 ? { tool_calls: [{ index: 0, id: "proof-call", type: "function", function: { name: "request_input", arguments: JSON.stringify({ question: "Pi extension proof: continue?", options: [{ label: "Continue" }] }) } }] } : { content: "Proof complete" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (choices: unknown[], extra = {}) => res.write(`data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", model: "pi-probe", choices, ...extra })}\n\n`);
    frame([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]);
    frame([{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }]);
    frame([], { usage: { prompt_tokens: 25000, completion_tokens: 10, total_tokens: 25010 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("provider address");
  const providerFile = join(dir, "provider.js");
  writeFileSync(providerFile, `export default function(pi) { pi.registerProvider("mission-test", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local-proof", api: "openai-completions",
    models: [{ id: "pi-probe", name: "Pi Probe", reasoning: true, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }]
  }); }`);
  const env: Record<string, string> = {
    HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", MISSION_HOME: daemon.home,
    MISSION_PORT: new URL(daemon.baseURL).port, MISSION_API_TOKEN: readFileSync(join(daemon.home, "token"), "utf8").trim(),
    MISSION_MCP_SERVER: resolve("dist/mcp/server.mjs"), MC_E2E_PI_EXTENSION: extensionPath,
    MC_E2E_PI_SESSION_FIXTURE: resolve("e2e/fixtures/fake-pi-session.mjs"),
  };
  // No dispatch, no --session-id: discovery learns the identity from the extension itself.
  let command: string;
  if (livePi) {
    command = `${quote(livePi)} --offline --no-skills --no-context-files --no-prompt-templates --no-themes -e ${quote(extensionPath)} -e ${quote(providerFile)} --provider mission-test --model pi-probe --thinking high`;
  } else {
    const bin = join(dir, "pi"); symlinkSync(process.execPath, bin);
    command = `${quote(bin)} ${quote(resolve("e2e/fixtures/fake-pi.mjs"))} --mission-extension-test`;
  }
  const launch = join(dir, "launch.sh");
  writeFileSync(log, "");
  // Pi selects print mode if stdout is redirected. Keep its TUI on the real pty and
  // capture the test-owned pane with tmux instead. The fake has no TUI to preserve.
  const redirect = livePi ? "" : ` >${quote(log)} 2>&1`;
  writeFileSync(launch, `#!/bin/sh\nunset MISSION_SESSION_ID MISSION_AGENT_SESSION_ID CLAUDE_SESSION_ID MISSION_API_TOKEN_FILE FLEET_HOME HARNESS_HOME\n${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexec ${command}${redirect}\n`);
  try {
    execFileSync(tmux, ["new-session", "-d", "-s", session, "-x", "130", "-y", "45", "-c", daemon.repo, `/bin/sh ${quote(launch)}`]);
    if (livePi) execFileSync(tmux, ["pipe-pane", "-o", "-t", session, `/bin/cat >${quote(log)}`]);
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: session });
    await expect(row).toHaveCount(1);
    await row.click();
    const detail = dashboard.locator(".console-detail");
    const sessions = async () => await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{ id: string; name: string; agentSessionId: string | null; state: string; meta: { contextPct: number } | null; estimatedCost?: { costUsd: number } }>;
    await expect.poll(async () => (await sessions()).find((s) => s.name === session)?.agentSessionId).toBeTruthy();

    execFileSync(tmux, ["send-keys", "-t", session, "probe", "Enter"]);
    const review = detail.getByRole("button", { name: /to review/ });
    await expect(review).toBeVisible();
    await expect(detail).toContainText("Pi Probe");
    await expect(detail).toContainText("high");
    // Still blocked: there cannot yet be a final result or second provider request.
    if (livePi) expect(requests).toBe(1);
    else expect(readFileSync(log, "utf8")).not.toContain("PI_EXTENSION_RESUMED");
    await review.click();
    const modal = dashboard.getByRole("dialog", { name: "Review request" });
    await expect(modal).toContainText("Pi extension proof: continue?");
    await expectContentClearsBorder(modal);
    const evidence = artifactsDir("pi-extension"); mkdirSync(evidence, { recursive: true });
    await modal.screenshot({ path: join(evidence, livePi ? "live-blocked.png" : "fake-blocked.png") });
    await modal.getByRole("radio", { name: "Continue" }).check();
    await modal.getByRole("button", { name: "Submit" }).click();
    await expect(modal).toBeHidden();
    await expect.poll(async () => (await sessions()).find((s) => s.name === session)?.state).toBe("idle");
    await expect(detail).toContainText("25%");
    await expect(detail).toContainText(/\$0\.0[235]/);
    if (livePi) {
      expect(requests).toBe(2);
      const payload = payloads[0] as { tools: { function: { name: string; parameters: unknown } }[] };
      expect(payload.tools.some((tool) => tool.function.name === "request_input")).toBe(true);
      console.log("Installed Pi: provider observed Mission tools, dashboard answer resumed the call, settled card reports high effort, 25% context and priced usage; zero external model requests.");
    } else {
      expect(readFileSync(log, "utf8")).toContain("PI_EXTENSION_RESUMED");
      for (const effort of ["minimal", "off"]) {
        execFileSync(tmux, ["send-keys", "-t", session, effort, "Enter"]);
        await expect(detail.getByLabel(`Reasoning effort: ${effort}`, { exact: true })).toBeVisible();
      }
    }
    await detail.screenshot({ path: join(evidence, livePi ? "live-settled.png" : "fake-settled.png") });
  } catch (error) { console.log(readFileSync(log, "utf8")); throw error; }
  finally { spawnSync(tmux, ["kill-session", "-t", session]); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); }
});
