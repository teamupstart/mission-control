import { mkdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { argvValue, recordsIn } from "../fixtures/records.ts";
import { shellWords } from "../../src/server/terminal/shell.ts";

/**
 * A Claude task pins its advisor at dispatch: Inherit (the default), Opus, Sonnet or Off.
 *
 * Driven from the dispatch form to the command line each runtime was really handed, because
 * that is the only place the claim "the pin reached the launch, and Inherit changed nothing"
 * can be checked:
 *
 *   - Terminal: the fake cmux (`CMUX_BIN`) records the `--command` it was asked to run, which
 *     is the launch wrapper. The wrapper's `export` lines are the session environment and its
 *     last line is the agent argv, so both halves of the pin are read from the same file the
 *     pane would have executed.
 *   - Agent SDK: the fake Claude records its own argv and `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`,
 *     so the SDK's rendering of `Options.settings` is read off the real subprocess.
 *
 * No model tokens: every agent binary is the suite's fake.
 */

const EVIDENCE = artifactsDir("advisor-dispatch-override");
const ADVISOR = "Advisor for dispatched Claude Code session";
const OFF_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer or focus.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/advisor-dispatch-override/${name}.png`);
}

async function putHarnesses(daemon: DaemonHandle, body: unknown): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/harnesses/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `the harness config should be accepted (${response.status})`).toBe(true);
}

/** Open the form and fill everything but the advisor. */
async function openDispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  return dialog;
}

async function dispatchNow(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

interface TerminalLaunch {
  argv: string[];
  env: Record<string, string>;
}

/**
 * The launches the fake cmux was asked to run, read through each wrapper script.
 *
 * Only ordinary dispatches are expected here, so every wrapper ends in the agent argv; the
 * `export NAME='value'` lines above it are the environment `agentSubprocessEnv` rendered.
 */
function terminalLaunches(daemon: DaemonHandle): TerminalLaunch[] {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("cmux-"))
    .flatMap((record) => {
      const argv = Array.isArray(record.argv) ? (record.argv as string[]) : [];
      if (argv[0] !== "new-workspace") return [];
      const command = argv[argv.indexOf("--command") + 1] ?? "";
      const wrapper = shellWords(command).find((word) => word.endsWith("launch-and-cleanup.sh"));
      if (!wrapper) return [];
      const lines = readFileSync(wrapper, "utf8").trimEnd().split("\n");
      const env: Record<string, string> = {};
      // The header is one statement per line; the agent command after the pid line is not,
      // because a quoted word (an appended system prompt) can carry newlines of its own.
      const pidLine = lines.findIndex((line) => line.startsWith("printf "));
      for (const line of lines.slice(0, pidLine)) {
        if (!line.startsWith("export ")) continue;
        const [assignment] = shellWords(line.slice("export ".length));
        const at = assignment?.indexOf("=") ?? -1;
        if (assignment && at > 0) env[assignment.slice(0, at)] = assignment.slice(at + 1);
      }
      return [{ argv: shellWords(lines.slice(pidLine + 1).join("\n")), env }];
    });
}

async function terminalLaunch(daemon: DaemonHandle): Promise<TerminalLaunch> {
  // Polled: the spawn is recorded a moment after the dialog closes.
  await expect
    .poll(() => terminalLaunches(daemon).length, { message: "the dispatch should have opened a cmux workspace" })
    .toBeGreaterThan(0);
  return terminalLaunches(daemon).at(-1)!;
}

interface SdkInvocation {
  argv: string[];
  cwd: string;
  disableAdvisorTool: string | null;
}

async function sdkInvocation(daemon: DaemonHandle): Promise<SdkInvocation> {
  const dir = join(daemon.recordDir, "claude");
  const worktrees = join(daemon.home, "worktree-pools") + sep;
  const dispatched = () =>
    recordsIn<SdkInvocation>(dir).filter(
      (record) => record.cwd.startsWith(worktrees) && record.argv.includes("--input-format"),
    );
  await expect
    .poll(() => dispatched().length, { message: "the SDK session should have launched the fake" })
    .toBeGreaterThan(0);
  return dispatched().at(-1)!;
}

/** The flag-layer object a launch carried, or null when it carried no `--settings` at all. */
function flagSettings(argv: readonly string[]): Record<string, unknown> | null {
  const value = argvValue(argv, "--settings");
  return value === undefined ? null : (JSON.parse(value) as Record<string, unknown>);
}

test.describe("terminal runtime", () => {
  test.beforeEach(async ({ daemon }) => {
    await putHarnesses(daemon, {
      sessionRuntime: { claude: "terminal" },
      terminalBackend: { claude: "cmux" },
    });
  });

  test("Advisor = Opus rides --settings and sets no environment", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "pair this task with an Opus advisor");
    const advisor = dialog.getByRole("combobox", { name: ADVISOR });
    // Inherit is the default, and it names where the answer then comes from.
    await expect(advisor).toHaveValue("");
    await expect(advisor.locator("option:checked")).toHaveText("Inherit from Claude settings");
    await expect(advisor.locator("option")).toHaveText(["Inherit from Claude settings", "Opus", "Sonnet", "Off"]);
    await shoot(dashboard, dialog.locator(".dispatch-crew-field"), "00-crew-advisor-inherit");
    await advisor.selectOption("opus");
    await shoot(dashboard, dialog.locator(".dispatch-crew-field"), "01-crew-advisor-opus");
    await dispatchNow(dialog);

    const launch = await terminalLaunch(daemon);
    expect(flagSettings(launch.argv), launch.argv.join(" ")).toEqual({ advisorModel: "opus" });
    expect(launch.env[OFF_ENV]).toBeUndefined();
  });

  test("Advisor = Off exports the disable switch and renders no --settings", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "run this task with no advisor");
    await dialog.getByRole("combobox", { name: ADVISOR }).selectOption("off");
    await dispatchNow(dialog);

    const launch = await terminalLaunch(daemon);
    expect(launch.env[OFF_ENV]).toBe("1");
    expect(flagSettings(launch.argv), launch.argv.join(" ")).toBeNull();
  });

  test("Inherit leaves the argv and the environment as they were", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "inherit whatever the operator configured");
    await expect(dialog.getByRole("combobox", { name: ADVISOR })).toHaveValue("");
    await dispatchNow(dialog);

    const launch = await terminalLaunch(daemon);
    expect(flagSettings(launch.argv), launch.argv.join(" ")).toBeNull();
    expect(launch.env[OFF_ENV]).toBeUndefined();
  });
});

test.describe("Agent SDK runtime", () => {
  test("Advisor = Sonnet reaches the SDK's flag-layer settings", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "pair this SDK task with a Sonnet advisor");
    await dialog.getByRole("combobox", { name: ADVISOR }).selectOption("sonnet");
    await dispatchNow(dialog);

    const invocation = await sdkInvocation(daemon);
    expect(flagSettings(invocation.argv), invocation.argv.join(" ")).toMatchObject({ advisorModel: "sonnet" });
    expect(invocation.disableAdvisorTool).toBeNull();
  });

  test("Advisor = Off sets the disable switch on the SDK subprocess", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "run this SDK task with no advisor");
    await dialog.getByRole("combobox", { name: ADVISOR }).selectOption("off");
    await dispatchNow(dialog);

    const invocation = await sdkInvocation(daemon);
    expect(invocation.disableAdvisorTool).toBe("1");
    expect(flagSettings(invocation.argv)?.advisorModel).toBeUndefined();
  });

  test("Inherit sends no advisor setting and no disable switch", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "inherit the advisor on the SDK");
    await dispatchNow(dialog);

    const invocation = await sdkInvocation(daemon);
    expect(flagSettings(invocation.argv)?.advisorModel).toBeUndefined();
    expect(invocation.disableAdvisorTool).toBeNull();
  });
});

test("the Advisor select is offered only for a harness that declares one", async ({ dashboard, daemon }) => {
  const dialog = await openDispatch(dashboard, daemon, "check which harnesses offer an advisor");
  const advisor = dialog.getByRole("combobox", { name: ADVISOR });
  await advisor.selectOption("opus");

  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await expect(dialog.getByRole("combobox", { name: /^Advisor for dispatched/ })).toHaveCount(0);
  await shoot(dashboard, dialog.locator(".dispatch-crew-field"), "02-crew-codex-no-advisor");

  // Switching back resets the pin with model and effort, rather than resurrecting it.
  await dialog.locator("select").filter({ hasText: "Codex" }).selectOption("claude");
  await expect(advisor).toHaveValue("");
});

test("a saved advisor pin reads back on edit, and changes or clears from there", async ({ dashboard, daemon }) => {
  const title = "Advisor pin round trip";
  const dialog = await openDispatch(dashboard, daemon, "keep this task's advisor pin across edits");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  await dialog.getByRole("combobox", { name: ADVISOR }).selectOption("opus");
  const created = dashboard.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks",
  );
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await created;
  expect(response.ok(), `creating the backlog task answered ${response.status()}`).toBe(true);
  await expect(dialog).toBeHidden();
  const task = (await response.json()) as { id: string; advisorModel: unknown };
  expect(task.advisorModel).toBe("opus");

  const stored = async () =>
    ((await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{ id: string; advisorModel: unknown }>)
      .find((candidate) => candidate.id === task.id)?.advisorModel;

  const board = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(board.ok, "the daemon should accept the Board layout").toBe(true);
  await dashboard.reload();
  const card = dashboard.locator(".bl-card", { hasText: title });

  const reopen = async (): Promise<Locator> => {
    await card.getByRole("button", { name: title, exact: true }).click();
    const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
    await expect(editor).toBeVisible();
    return editor;
  };

  let editor = await reopen();
  const advisor = editor.getByRole("combobox", { name: ADVISOR });
  await expect(advisor).toHaveValue("opus");
  await shoot(dashboard, editor.locator(".dispatch-crew-field"), "03-edit-reads-opus");

  await advisor.selectOption("off");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(stored).toBe("off");

  // Inherit is the empty option, sent as null, which takes the stored pin back off.
  editor = await reopen();
  await expect(editor.getByRole("combobox", { name: ADVISOR })).toHaveValue("off");
  await editor.getByRole("combobox", { name: ADVISOR }).selectOption("");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(stored).toBeNull();
});
