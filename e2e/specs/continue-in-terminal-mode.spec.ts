import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * Continuing an Agent SDK session in a terminal carries the mode it was running in.
 *
 * The reported bug, verbatim from the operator: a session dispatched in auto mode, handed
 * to a terminal through the conversation pane's "resume this conversation in" chooser,
 * reopened in the CLI's default manual mode - and the operator had to notice and walk it
 * back to auto by hand, every time. The mode lived only in the embedded driver's options;
 * nothing on disk records it, so a bare `claude --resume <id>` / `codex resume <id>` was
 * a silent downgrade.
 *
 * Only this layer can watch that whole shape: the mode chip a person reads on the card,
 * the chooser they click, the daemon's handoff route, and the command line the chosen
 * terminal backend was actually told to run. The backend is the suite's fake cmux
 * (`CMUX_BIN`, see fake-agents.ts), whose record of `new-workspace --command <shell words>`
 * is exactly where the carried mode shows up or provably does not - before the fix, both
 * commands below ended at the conversation id.
 *
 * Both embedded harnesses, because the carry is spelled differently per harness and each
 * spelling can regress alone: Claude re-asserts its mode as `--permission-mode`, Codex as
 * its posture triple - sandbox, approval policy, and the `-c approvals_reviewer` override
 * that is the only thing separating Approve for me from Ask for approval.
 */

const EVIDENCE = artifactsDir("resume-mode-carry");

test.use({ daemonEnv: { MC_E2E_CODEX_ON_DAEMON_PATH_ONLY: "1" } });

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the row being photographed.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

async function dispatch(page: Page, daemon: DaemonHandle, agent: "claude" | "codex"): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`continue this ${agent} conversation in a terminal`);
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption(agent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Every `--command` the fake cmux has been asked to run a workspace with, oldest first.
 *
 * Read off the record files rather than the daemon's response, deliberately: the handoff
 * route holds its reply open while it waits for discovery to adopt the successor, and
 * discovery is off in this suite (`MISSION_POLL_MS=0`) - but the spawn this spec exists to
 * inspect has already happened by then, which is the half a user's terminal actually runs.
 */
function recordedWorkspaceCommands(daemon: DaemonHandle): string[] {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("cmux-"))
    .map((record) => {
      if (!Array.isArray(record.argv) || record.argv[0] !== "new-workspace") return "";
      const argv = record.argv as string[];
      const at = argv.indexOf("--command");
      return at >= 0 ? (argv[at + 1] ?? "") : "";
    })
    .filter(Boolean);
}

/**
 * Each harness's own spelling of "the mode rides along", as the exact shell words the
 * workspace command must contain - `shellCommand` single-quotes every argv word, so these
 * literals also pin that the flags arrived as separate words rather than as one pasted
 * string. Measured against claude 2.1.222 (`--permission-mode`, spelled `auto`) and
 * codex-cli 0.145.0 (`codex resume --help` documents `--sandbox` and `--ask-for-approval`
 * on the subcommand; the reviewer has no flag and rides as a `-c` config override).
 */
const CASES = [
  {
    agent: "claude" as const,
    chip: "auto",
    launcher: /Claude Code/,
    resumeWord: "'--resume'",
    carried: ["'--permission-mode' 'auto'"],
  },
  {
    agent: "codex" as const,
    chip: "approve",
    launcher: /Codex/,
    resumeWord: "'resume'",
    carried: [
      "'--sandbox' 'workspace-write'",
      "'--ask-for-approval' 'on-request'",
      "'-c' 'approvals_reviewer=\"auto_review\"'",
    ],
  },
];

for (const { agent, chip, launcher, resumeWord, carried } of CASES) {
  test(`continuing a ${agent} SDK session in a terminal carries its ${chip} mode`, async ({
    dashboard,
    daemon,
  }) => {
    await dispatch(dashboard, daemon, agent);

    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const card = dashboard.locator(".console-detail");

    // The mode a person reads on the card before continuing - the dispatch default armed
    // it, and it is the exact thing the reopened CLI must still be in. This is the chip
    // the operator kept having to reconcile with their terminal by hand.
    await expect(card.locator(".mode").first()).toContainText(chip);

    // The agent launcher becomes a chooser only once the session has reported its
    // conversation id - the same `agentLaunchAction` predicate the daemon enforces - so
    // enabled here means there is a conversation to reopen.
    const chooser = card.locator(".conv-launch").getByRole("button", { name: launcher });
    await expect(chooser).toBeEnabled();
    const [{ agentSessionId }] = await (async () => {
      const response = await fetch(`${daemon.baseURL}/api/sessions`);
      return (await response.json()) as Array<{ agentSessionId: string | null }>;
    })();
    expect(agentSessionId).toBeTruthy();

    // Both launchers share the same backend rows, but their help text must describe the
    // action this particular menu takes. The Terminal control opens a shell; it does not
    // resume the agent conversation merely because the neighbouring control does.
    const terminalChooser = card.locator(".conv-launch").getByRole("button", {
      name: "Terminal",
      exact: true,
    });
    await terminalChooser.click();
    const terminalMenu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    const terminalRow = terminalMenu.getByRole("menuitem").filter({ hasText: "cmux" });
    await expect(terminalRow.locator(".launch-note")).toHaveText(
      "Open a shell in cmux. New workspace in the worktree.",
    );
    await dashboard.keyboard.press("Escape");
    await expect(terminalMenu).toBeHidden();

    await chooser.click();
    const menu = card.getByRole("menu", { name: /resume this conversation in/ });
    await expect(menu).toBeVisible();
    const row = menu.getByRole("menuitem").filter({ hasText: "cmux" });
    await expect(row).toBeEnabled();
    await expect(row.locator(".launch-note")).toHaveText(
      "Resume this conversation in cmux. New workspace in the worktree.",
    );
    if (process.env.MC_E2E_EVIDENCE) {
      console.log(
        `OBSERVED the ${agent} card reads mode "${chip}" and offers "resume this conversation in" with cmux available`,
      );
    }
    await shoot(dashboard, `${agent}-menu-open`);
    await row.click();
    await expect(menu).toBeHidden();

    // The click's whole product: the command the chosen terminal was told to run. The
    // response itself is still held open waiting on discovery, so the record is the only
    // honest place to look - and the only place a user's terminal looks.
    await expect
      .poll(() => recordedWorkspaceCommands(daemon), { timeout: 15_000 })
      .toHaveLength(1);
    const [command] = recordedWorkspaceCommands(daemon);

    // The same conversation, on the faked CLI - not a fresh agent wearing the card.
    const executable = agent === "codex"
      ? join(daemon.home, "daemon-path-bin", "codex")
      : join(daemon.home, "fake-bin", `fake-${agent}`);
    expect(command).toContain(executable);
    expect(command).toContain(resumeWord);
    expect(command).toContain(`'${agentSessionId}'`);
    // And the mode it was running in, re-asserted in this harness's own spelling. Before
    // the fix the command ended at the conversation id and every one of these was absent.
    for (const words of carried) expect(command).toContain(words);
    if (process.env.MC_E2E_EVIDENCE) {
      console.log(`OBSERVED the ${agent} terminal command carries the mode: ${command}`);
    }
  });
}
