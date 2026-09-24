import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * A real Pi session's COMMANDS reaching the conversation and the Activity rail.
 *
 * `conversation-observed-activity.spec.ts` proves the rail itself against a fake Claude. This
 * one exists because the rail was working and Pi still showed nothing: the reader translated
 * Pi's transcript with the wrong discriminator (`tool_call`, which is Pi's EXTENSION EVENT
 * name; a content part is `toolCall`), so every tool-only assistant turn - a turn with no
 * prose to fall back on - was dropped before it could become a chip or a row. A Pi session
 * ran commands and the dashboard said it had done nothing.
 *
 * So the agent has to be the REAL pinned Pi, writing its own JSONL: a fake that emits records
 * we wrote cannot catch us misreading the ones Pi writes. What is faked is only the model - a
 * loopback `openai-completions` provider that answers with one `bash` tool call and then one
 * line of prose - so this spends nothing and never reaches an account.
 *
 * The terminal backend is deliberately not the variable here. The rail is fed by the file the
 * agent writes, never by the pane, so tmux stands for every backend; `pi-interrupt-herdr.spec.ts`
 * is where a second backend's own discovery is proven.
 */

test.use({ daemonEnv: { MISSION_POLL_MS: "300", MISSION_USAGE_POLL_MS: "300" } });
const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** What the faked model asks Pi to run. Echoed so the tool genuinely executes. */
const COMMAND = "echo mission-activity-proof";

test("a real Pi session's commands reach the conversation and the Activity rail", async ({
  dashboard,
  daemon,
}) => {
  test.skip(tmuxMissing, "tmux is required for the real Pi terminal boundary");
  const dir = join(daemon.home, "pi-activity");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });

  let requests = 0;
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the local request */ }
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
      id: "activity-proof", object: "chat.completion.chunk", model: "pi-probe",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (requests === 1) {
      // The shape pi's openai-completions adapter reads a tool call out of: an indexed
      // `tool_calls` delta whose `function.arguments` is a JSON string, closed by the
      // `tool_calls` finish reason that makes the turn a `toolUse` stop.
      frame({
        role: "assistant",
        tool_calls: [{
          index: 0, id: "call_activity_proof", type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) },
        }],
      });
      frame({}, "tool_calls");
    } else {
      frame({ role: "assistant", content: "Pi finished the command" });
      frame({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  let session: string | undefined;
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("provider has no address");

    const providerFile = join(dir, "provider.js");
    writeFileSync(providerFile, `export default function(pi) { pi.registerProvider("mission-test", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", apiKey: "local-proof", api: "openai-completions",
    models: [{ id: "pi-probe", name: "Pi Activity Proof", reasoning: false, input: ["text"],
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
      "--no-prompt-templates", "--no-themes", "--no-approve", "-e", resolve("dist/pi-integration/extension.js"),
      "-e", providerFile, "--provider", "mission-test", "--model", "pi-probe"];
    writeFileSync(launch, `#!/bin/sh\nunset MISSION_SESSION_ID MISSION_AGENT_SESSION_ID CLAUDE_SESSION_ID MISSION_API_TOKEN_FILE FLEET_HOME HARNESS_HOME\n${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexec ${command.map(quote).join(" ")}\n`);

    session = `mc-pi-activity-${process.pid}-${Date.now()}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "130", "-y", "45", "-c", daemon.repo, `/bin/sh ${quote(launch)}`]);
    const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: session });
    await expect(row).toHaveCount(1);
    await row.click();
    const detail = dashboard.locator(".console-detail");
    await expect(detail).toContainText(/tmux · %\d+/);
    // Discovery sees the process before Pi finishes startup; the extension's session-start
    // identity is what binds the transcript this whole assertion reads from.
    await expect.poll(async () => {
      const response = await dashboard.request.get(`${daemon.baseURL}/api/sessions`);
      const sessions = await response.json() as Array<{ name: string; agentSessionId: string | null }>;
      return sessions.find((item) => item.name === session)?.agentSessionId;
    }).toBeTruthy();

    // Before the turn there is nothing to show, and the rail says so rather than looking
    // like the broken state this spec is about.
    const activity = detail.getByRole("region", { name: "Conversation rail" });
    await expect(activity.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    await expect(activity.getByText("No observed tool activity yet")).toBeVisible();

    execFileSync("tmux", ["send-keys", "-t", session, "Run the proof command", "Enter"]);
    // Two requests: the one answered with the tool call, and the one Pi makes with the
    // tool's result. The second arriving means the first turn is written and complete.
    await expect.poll(() => requests).toBe(2);
    await expect(detail.getByText("Pi finished the command", { exact: true })).toBeVisible();

    // The rail names the tool and the command it ran - not the command LINE, which is the
    // row's tooltip. This is the assertion that was empty before the discriminator was fixed.
    await expect(activity.getByText("bash", { exact: true })).toBeVisible();
    await expect(activity.getByText("echo", { exact: true })).toBeVisible();
    await expect(activity.getByText("No observed tool activity yet")).toBeHidden();

    // And the same invocation is in the log itself: a tool-only turn folds into a run
    // whose chip a reader meets without opening the rail at all.
    await expect(detail.locator(".transcript-log .tool-chip").filter({ hasText: "bash" })).toBeVisible();

    // It survives a reload, because it is derived from Pi's own file rather than from a
    // live event the browser happened to be connected for.
    await dashboard.reload();
    await row.click();
    await expect(detail.getByRole("region", { name: "Conversation rail" }).getByText("echo", { exact: true })).toBeVisible();

    console.log(`PASS: real Pi ran ${COMMAND}; the call reached the conversation log and the Activity rail, and survived a reload.`);
    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("pi-observed-activity");
      mkdirSync(evidence, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: join(evidence, "real-pi-activity-rail.png") });
    }
  } catch (error) {
    if (session) {
      console.log(spawnSync("tmux", ["capture-pane", "-p", "-t", session], { encoding: "utf8" }).stdout);
    }
    console.log(daemon.readLog());
    throw error;
  } finally {
    if (session) {
      spawnSync("tmux", ["kill-session", "-t", session]);
    }
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
  }
});
