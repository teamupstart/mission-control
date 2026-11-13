import { mkdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { argvValue, recordsIn } from "../fixtures/records.ts";

/**
 * A running task that needs a decision asks it through `request_input`, with the context and
 * tradeoffs the operator needs to make it - and the operator sees them on the card.
 *
 * Nothing here is injected. The task is dispatched from the dashboard on the default (Agent
 * SDK) runtime; what it was TOLD is read off what the fake `claude` recorded - its argv and
 * its `initialize` frame; and the question is asked by launching the exact Mission Control
 * MCP server that launch was handed (`--mcp-config`) from the task's own checkout and calling
 * `request_input` the way the agent does. The card is then answered in the browser and the
 * answer is read back from the blocked tool call.
 *
 * Against the code before this change it fails: an SDK task kept `AskUserQuestion`, was told
 * nothing about context or tradeoffs, and `request_input` had no `context`, so the background
 * an agent sent never reached the card.
 */

const EVIDENCE = artifactsDir("request-input-context");
const TASK = "choose a linter";
const QUESTION = "Which linter should this repo use?";
const CONTEXT =
  "The repo has no linter yet; CI runs Prettier only.\nThe team asked for type-aware rules on the server code.";
const BIOME_TRADEOFF = "Lint and format in one fast binary; no type-aware rules.";
const ESLINT_TRADEOFF = "Type-aware rules and the widest ecosystem; slower and more config.";

type LaunchRecord = { argv: string[]; cwd: string };

/** Opt-in reviewer pixels, gitignored under `e2e/.artifacts/`, never committed. */
async function evidence(target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

/** The dispatched task's own launch, as the fake `claude` recorded it. */
async function dispatchedLaunch(daemon: DaemonHandle): Promise<LaunchRecord> {
  const dir = join(daemon.recordDir, "claude");
  const taskWorktrees = join(daemon.home, "worktree-pools") + sep;
  const find = () =>
    recordsIn<LaunchRecord>(dir).find(
      (record) => record.cwd.startsWith(taskWorktrees) && argvValue(record.argv, "--mcp-config") !== undefined,
    );
  // Polled: the card registers before the child has run far enough to write its record.
  await expect.poll(() => find() !== undefined, { message: "the task launched the fake claude" }).toBe(true);
  return find()!;
}

/** The system-prompt append the task's process was initialized with. */
async function systemPromptAppendOf(daemon: DaemonHandle, cwd: string): Promise<string> {
  const dir = join(daemon.recordDir, "claude-initialize");
  const find = () =>
    recordsIn<{ cwd: string; appendSystemPrompt: string | null }>(dir).find((record) => record.cwd === cwd);
  await expect.poll(() => find() !== undefined, { message: "the task's process was initialized" }).toBe(true);
  return find()!.appendSystemPrompt ?? "";
}

/** The Mission Control MCP server the launch was handed, started the way Claude starts it. */
async function missionTools(daemon: DaemonHandle, launch: LaunchRecord): Promise<Client> {
  // A terminal launch names a file; an Agent SDK launch passes the JSON inline.
  const raw = argvValue(launch.argv, "--mcp-config")!;
  const config = JSON.parse(raw.trimStart().startsWith("{") ? raw : readFileSync(raw, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  };
  const descriptor = config.mcpServers["mission-control"];
  expect(descriptor, "the launch registered the Mission Control MCP server").toBeTruthy();
  const client = new Client({ name: "e2e-dispatched-agent", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: descriptor!.command,
      args: descriptor!.args,
      cwd: launch.cwd,
      env: {
        ...(process.env as Record<string, string>),
        ...descriptor!.env,
        MISSION_PORT: new URL(daemon.baseURL).port,
      },
      stderr: "pipe",
    }),
  );
  return client;
}

test("a task's decision reaches the operator with its context and tradeoffs, and the answer returns", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const launch = await dispatchedLaunch(daemon);

  // The built-in that has no room for context is taken away, and request_input pre-approved.
  expect(argvValue(launch.argv, "--disallowedTools")?.split(","), "AskUserQuestion is removed").toContain(
    "AskUserQuestion",
  );
  expect(argvValue(launch.argv, "--allowedTools")?.split(","), "request_input raises no permission card").toContain(
    "mcp__mission-control__request_input",
  );

  // What the running task was told about asking for a decision. On the Agent SDK runtime the
  // system-prompt append travels in the `initialize` control frame, which the fake records.
  const told = await systemPromptAppendOf(daemon, launch.cwd);
  expect(told, "the task is sent to request_input for a decision").toContain("request_input");
  expect(told, "and told to carry the background in `context`").toContain("put the background in `context`");
  expect(told, "and a tradeoff on every option").toContain("give each option a `detail` that states its tradeoff");

  const tools = await missionTools(daemon, launch);
  try {
    const listed = (await tools.listTools()).tools.find((tool) => tool.name === "request_input");
    expect(listed?.description, "the tool itself states the same rule").toContain("states its tradeoff");

    // Blocks until the operator answers on the card, exactly as the agent's call does.
    const answered = tools.callTool(
      {
        name: "request_input",
        arguments: {
          question: QUESTION,
          context: CONTEXT,
          options: [
            { label: "biome", detail: BIOME_TRADEOFF },
            { label: "eslint", detail: ESLINT_TRADEOFF, recommended: true },
          ],
        },
      },
      undefined,
      { timeout: 120_000 },
    );

    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    await dashboard.locator(".console-detail").getByRole("button", { name: "to review" }).click();
    const modal = dashboard.getByRole("dialog", { name: "Review request" });
    await expect(modal).toBeVisible();

    // The decision is the heading, printed once - not repeated as the body's lead.
    await expect(modal.getByRole("heading", { name: QUESTION })).toBeVisible();
    await expect(modal.getByText(QUESTION, { exact: true })).toHaveCount(1);

    // The context reads beneath it, whole, with its line break kept.
    const context = modal.locator(".review-content .question");
    await expect(context).toHaveText(CONTEXT);
    const lines = await context.evaluate((el) => {
      const { lineHeight } = getComputedStyle(el);
      return Math.round(el.getBoundingClientRect().height / parseFloat(lineHeight));
    });
    expect(lines, "the context's newline is rendered, not collapsed").toBeGreaterThanOrEqual(2);

    // Each option carries its tradeoff, and the recommended one is marked.
    const group = modal.getByRole("group", { name: QUESTION });
    await expect(group.getByText(BIOME_TRADEOFF)).toBeVisible();
    await expect(group.getByText(ESLINT_TRADEOFF)).toBeVisible();
    await expect(group.getByRole("radio", { name: /^eslint/ })).toHaveAccessibleName(/recommended/i);
    await evidence(modal, "decision-with-context");

    await group.getByRole("radio", { name: /^eslint/ }).check();
    await modal.getByRole("button", { name: /^Submit/ }).click();
    await expect(modal).toBeHidden();

    // The blocked call returns the operator's choice to the agent.
    const result = await answered;
    const text = (result.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
    expect(result.isError, text).toBeFalsy();
    expect(text).toContain("eslint");
  } finally {
    await tools.close();
  }
});
