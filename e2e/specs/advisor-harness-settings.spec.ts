import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { argvValue, recordsIn } from "../fixtures/records.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { shellWords } from "../../src/server/terminal/shell.ts";

/**
 * The advisor a dispatched Claude session launches with is chosen on Settings -> Harnesses:
 * one default (Harness default, Opus, Sonnet or Off) plus per-model "Advisor Overrides". The
 * dispatch form no longer offers a select; it says which advisor the launch will get.
 *
 * Driven from the settings card and the dispatch form to the command line each runtime was
 * really handed, because that is the only place the claim "the setting reached the launch,
 * and Harness default changed nothing" can be checked:
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

const EVIDENCE = artifactsDir("advisor-harness-settings");
const DEFAULT_ADVISOR = "Default advisor for dispatched Claude Code sessions";
const OFF_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer or focus.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/advisor-harness-settings/${name}.png`);
}

async function putHarnesses(daemon: DaemonHandle, body: unknown): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/harnesses/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `the harness config should be accepted (${response.status})`).toBe(true);
}

/** Open the form and fill it in; the advisor is no longer one of its fields. */
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

async function openHarnesses(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/settings`);
  await page.getByRole("tab", { name: /Harnesses/ }).click();
  const card = page.locator('[data-anchor="harnesses/claude"]');
  await expect(card).toBeVisible();
  return card;
}

async function storedAdvisor(daemon: DaemonHandle): Promise<unknown> {
  const config = (await (await fetch(`${daemon.baseURL}/api/harnesses/config`)).json()) as {
    advisor: { claude: unknown };
  };
  return config.advisor.claude;
}

/** The operator's own Claude settings file, as the daemon under test reads it. */
function writeClaudeSettings(daemon: DaemonHandle, settings: Record<string, unknown>): void {
  const path = join(daemon.home, ".claude", "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings));
}

test.describe("Settings -> Harnesses", () => {
  test("the Claude card sets a default advisor and per-model overrides, and says whether it is on", async ({
    dashboard,
    daemon,
  }) => {
    const card = await openHarnesses(dashboard, daemon);
    const advisor = card.getByRole("combobox", { name: DEFAULT_ADVISOR });
    const status = card.getByRole("status", { name: "Claude Code advisor status" });
    await expect(advisor).toHaveValue("");
    await expect(advisor.locator("option")).toHaveText(["Harness default", "Opus", "Sonnet", "Off"]);
    // Nothing configured anywhere: the card says the advisor will not be used.
    await expect(status).toHaveText("Off: ~/.claude/settings.json names no advisor, so only a project's own settings could add one.");
    const overrides = card.getByRole("group", { name: "Claude Code advisor overrides" });
    await expect(overrides.getByText("Advisor Overrides", { exact: true })).toBeVisible();
    await expect(overrides.getByText("Every model uses the advisor above.")).toBeVisible();
    await shoot(dashboard, card, "00-card-harness-default");

    await advisor.selectOption("opus");
    await expect(status).toHaveText("On: sessions may consult Opus.");
    await expect.poll(() => storedAdvisor(daemon)).toEqual({ default: "opus", overrides: {} });

    // An override starts on the first model with none, on Opus unless Opus is weaker.
    await overrides.getByRole("button", { name: "+ Add model override" }).click();
    await expect(overrides.getByRole("combobox", { name: "Model for the Fable 5.1 advisor override" })).toHaveValue("claude-fable-5-1");
    await expect(overrides.getByRole("combobox", { name: "Advisor for Fable 5.1 sessions" })).toHaveValue("off");
    // Moved to another model, and pointed at a weaker advisor: the card warns.
    await overrides.getByRole("combobox", { name: "Model for the Fable 5.1 advisor override" }).selectOption("claude-opus-5-5");
    const opusRow = overrides.getByRole("combobox", { name: "Advisor for Opus 5.5 sessions" });
    await opusRow.selectOption("sonnet");
    await expect(overrides.getByText("Sonnet is less capable than Opus 5.5, so Claude Code will not consult it on the main conversation.")).toBeVisible();
    await expect.poll(() => storedAdvisor(daemon)).toEqual({ default: "opus", overrides: { "claude-opus-5-5": "sonnet" } });
    await opusRow.selectOption("off");
    await expect.poll(() => storedAdvisor(daemon)).toEqual({ default: "opus", overrides: { "claude-opus-5-5": "off" } });
    await shoot(dashboard, card, "01-card-opus-with-override");

    await overrides.getByRole("button", { name: "Remove the Opus 5.5 advisor override" }).click();
    await expect(overrides.getByText("Every model uses the advisor above.")).toBeVisible();
    await expect.poll(() => storedAdvisor(daemon)).toEqual({ default: "opus", overrides: {} });

    // Only Claude Code declares an advisor.
    for (const label of ["Codex", "Pi"]) {
      await expect(dashboard.getByRole("combobox", { name: `Default advisor for dispatched ${label} sessions` })).toHaveCount(0);
    }
  });

  test("on Harness default the status reads the operator's own Claude settings", async ({ dashboard, daemon }) => {
    writeClaudeSettings(daemon, { advisorModel: "opus" });
    const card = await openHarnesses(dashboard, daemon);
    const status = card.getByRole("status", { name: "Claude Code advisor status" });
    await expect(status).toHaveText("On: inherits Opus from ~/.claude/settings.json.");
    await shoot(dashboard, card, "02-card-inherits-opus");

    // A switch in the settings env turns it off for every session, whatever is chosen.
    writeClaudeSettings(daemon, { advisorModel: "opus", env: { [OFF_ENV]: "1" } });
    await dashboard.reload();
    await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
    await expect(status).toHaveText(`Off: ${OFF_ENV} is set in ~/.claude/settings.json.`);
    await card.getByRole("combobox", { name: DEFAULT_ADVISOR }).selectOption("sonnet");
    await expect(status).toHaveText(`Off: ${OFF_ENV} is set in ~/.claude/settings.json.`);
  });
});

test.describe("terminal runtime", () => {
  test.beforeEach(async ({ daemon }) => {
    await putHarnesses(daemon, {
      sessionRuntime: { claude: "terminal" },
      terminalBackend: { claude: "cmux" },
    });
  });

  test("the dispatch form has no Advisor select, and a default of Opus rides --settings", async ({ dashboard, daemon }) => {
    await putHarnesses(daemon, { advisor: { claude: { default: "opus" } } });
    const dialog = await openDispatch(dashboard, daemon, "pair this task with an Opus advisor");
    await expect(dialog.getByRole("combobox", { name: /^Advisor for dispatched/ })).toHaveCount(0);
    const line = dialog.getByRole("note", { name: "Advisor for this launch" });
    await expect(line).toHaveText("AdvisorOpusfrom Settings → Harnesses");
    await expect(line.getByRole("link", { name: "Settings → Harnesses" })).toHaveAttribute("href", "#/settings/harnesses");
    await shoot(dashboard, dialog.locator(".dispatch-crew-field"), "03-dispatch-advisor-line");
    await dispatchNow(dialog);

    const launch = await terminalLaunch(daemon);
    expect(flagSettings(launch.argv), launch.argv.join(" ")).toEqual({ advisorModel: "opus" });
    expect(launch.env[OFF_ENV]).toBeUndefined();
  });

  test("the override for the chosen model applies: Off exports the disable switch", async ({ dashboard, daemon }) => {
    await putHarnesses(daemon, { advisor: { claude: { default: "opus", overrides: { "claude-opus-5-5": "off" } } } });
    const dialog = await openDispatch(dashboard, daemon, "run this Opus task with no advisor");
    await dialog.locator("select").filter({ hasText: "Opus 5.5" }).first().selectOption("claude-opus-5-5");
    await expect(dialog.getByRole("note", { name: "Advisor for this launch" })).toHaveText(
      "AdvisorOfffor Opus 5.5, from Settings → Harnesses",
    );
    await dispatchNow(dialog);

    const launch = await terminalLaunch(daemon);
    expect(launch.env[OFF_ENV]).toBe("1");
    expect(flagSettings(launch.argv), launch.argv.join(" ")).toBeNull();
  });

  test("Harness default leaves the argv and the environment as they were", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "inherit whatever the operator configured");
    await expect(dialog.getByRole("note", { name: "Advisor for this launch" })).toHaveText(
      "AdvisorInheritinherits Claude Code's own settings. Change it on Settings → Harnesses.",
    );
    await dispatchNow(dialog);

    const launch = await terminalLaunch(daemon);
    expect(flagSettings(launch.argv), launch.argv.join(" ")).toBeNull();
    expect(launch.env[OFF_ENV]).toBeUndefined();
  });
});

test.describe("Agent SDK runtime", () => {
  test("a Sonnet default reaches the SDK's flag-layer settings", async ({ dashboard, daemon }) => {
    await putHarnesses(daemon, { advisor: { claude: { default: "sonnet" } } });
    const dialog = await openDispatch(dashboard, daemon, "pair this SDK task with a Sonnet advisor");
    await dispatchNow(dialog);

    const invocation = await sdkInvocation(daemon);
    expect(flagSettings(invocation.argv), invocation.argv.join(" ")).toMatchObject({ advisorModel: "sonnet" });
    expect(invocation.disableAdvisorTool).toBeNull();
  });

  test("an Off default sets the disable switch on the SDK subprocess", async ({ dashboard, daemon }) => {
    await putHarnesses(daemon, { advisor: { claude: { default: "off" } } });
    const dialog = await openDispatch(dashboard, daemon, "run this SDK task with no advisor");
    await dispatchNow(dialog);

    const invocation = await sdkInvocation(daemon);
    expect(invocation.disableAdvisorTool).toBe("1");
    expect(flagSettings(invocation.argv)?.advisorModel).toBeUndefined();
  });

  test("Harness default sends no advisor setting and no disable switch", async ({ dashboard, daemon }) => {
    const dialog = await openDispatch(dashboard, daemon, "inherit the advisor on the SDK");
    await dispatchNow(dialog);

    const invocation = await sdkInvocation(daemon);
    expect(flagSettings(invocation.argv)?.advisorModel).toBeUndefined();
    expect(invocation.disableAdvisorTool).toBeNull();
  });
});

test("the advisor line is shown only for a harness that declares one", async ({ dashboard, daemon }) => {
  const dialog = await openDispatch(dashboard, daemon, "check which harnesses have an advisor");
  await expect(dialog.getByRole("note", { name: "Advisor for this launch" })).toHaveCount(1);
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await expect(dialog.getByRole("note", { name: "Advisor for this launch" })).toHaveCount(0);
});

test("a task saved with an advisor pin before the move shows it, and Use Settings clears it", async ({ dashboard, daemon }) => {
  const title = "Legacy advisor pin";
  const created = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent: "keep the old pin visible", agent: "claude",
      workflowId: null, backlog: true }),
  });
  expect(created.ok, `creating the backlog task answered ${created.status}`).toBe(true);
  const task = (await created.json()) as { id: string };
  // An older build stored the pin on the row; nothing in this build can write one. Seeded
  // with the daemon down, the way `backlog-dependencies.spec.ts` seeds a row, so the
  // successor loads it at boot.
  await daemon.crash();
  withDaemonDb(daemon, (db) => db.prepare("UPDATE tasks SET advisor_model = 'opus' WHERE id = ?").run(task.id));
  await daemon.restart();

  const stored = async () =>
    ((await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{ id: string; advisorModel: unknown }>)
      .find((candidate) => candidate.id === task.id)?.advisorModel;
  expect(await stored()).toBe("opus");

  const board = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(board.ok, "the daemon should accept the Board layout").toBe(true);
  await dashboard.reload();
  const card = dashboard.locator(".bl-card", { hasText: title });
  await card.getByRole("button", { name: title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor).toBeVisible();

  const line = editor.getByRole("note", { name: "Advisor for this launch" });
  await expect(line).toContainText("Opus");
  await expect(line).toContainText("saved on this task before the advisor moved to Settings → Harnesses.");
  await shoot(dashboard, editor.locator(".dispatch-crew-field"), "04-edit-legacy-pin");
  await line.getByRole("button", { name: "Use Settings" }).click();
  await expect(line).toHaveText("AdvisorInheritinherits Claude Code's own settings. Change it on Settings → Harnesses.");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(stored).toBeNull();
});
