import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";
import type { Session, Task } from "../../src/shared/types.ts";

// Only the session that OPENED a pull request may wear its chip.
//
// The regression: Claude's hook bridge sniffs a PR URL out of ANY Bash output, so an Agent
// Shepherd resident that ran `gh pr view 1304` to read review comments was shown as owning
// #1304 - permanently, because a resident's task has no repository and the PR poller never
// visits it to retract the chip.
//
// Every event here goes through the REAL `hooks/harness-hook.mjs`, fed the exact JSON
// Claude Code hands a `PostToolUse` hook, so the sniff, the `prCreated` provenance bit and the
// daemon's ingest are all production code. No model tokens: the agents are the e2e fakes.

const EVIDENCE = artifactsDir("pr-chip-provenance");
const PR_NUMBER = 1304;
const PR_URL = `https://github.com/acme/mission-e2e/pull/${PR_NUMBER}`;
const HOOK = join(process.cwd(), "hooks", "harness-hook.mjs");

async function sessions(daemon: DaemonHandle): Promise<Session[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<Session[]>;
}

async function sessionById(daemon: DaemonHandle, id: string): Promise<Session | undefined> {
  return (await sessions(daemon)).find((session) => session.id === id);
}

/** Run the real Claude hook bridge for one Bash `PostToolUse`, aimed at this fixture daemon. */
function runBashHook(daemon: DaemonHandle, session: Session, command: string): void {
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: session.agentSessionId ?? session.id,
    cwd: session.cwd,
    transcript_path: null,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: `${PR_URL}\n`, stderr: "", interrupted: false },
  };
  // A scrubbed environment: no inherited terminal identity (TMUX, WEZTERM, ...) that could
  // route the event to some other card, and no MISSION_HEADLESS, which makes the bridge
  // stay silent.
  const result = spawnSync(process.execPath, [HOOK, "PostToolUse"], {
    input: JSON.stringify(payload),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: daemon.home,
      MISSION_HOME: daemon.home,
      MISSION_PORT: new URL(daemon.baseURL).port,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

async function useConsole(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(response.ok).toBe(true);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/pr-chip-provenance/${name}`);
}

test("a repository task wears the pull request it opened, never one it only viewed", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("review a teammate's PR");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let live: Session | undefined;
  await expect.poll(async () => {
    live = (await sessions(daemon)).find((session) => session.state !== "exited");
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  const session = live!;

  await useConsole(dashboard, daemon);
  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  const railPr = rail.getByText(`#${PR_NUMBER}`, { exact: true });

  // Reading someone else's pull request prints its URL exactly as `gh pr create` would.
  runBashHook(daemon, session, `gh pr view ${PR_NUMBER} --json url --jq .url`);
  await expect.poll(async () => (await sessionById(daemon, session.id))?.hooksSeen).toBe(true);
  expect((await sessionById(daemon, session.id))?.prUrl ?? null).toBeNull();
  await expect(railPr).toHaveCount(0);
  await capture(dashboard, "repo-task-after-gh-pr-view.png");

  // Opening one is the proof-grade signal, and it decorates the card at once. Seeing it
  // arrive also proves the `gh pr view` event above reached the same card and was refused.
  runBashHook(daemon, session, `gh pr create --title "Ship it" --body "Done"`);
  await expect.poll(async () => (await sessionById(daemon, session.id))?.prNumber ?? null)
    .toBe(PR_NUMBER);
  await expect(railPr).toBeVisible();
  await capture(dashboard, "repo-task-after-gh-pr-create.png");
});

test("a repository-free Claude resident never wears a pull request chip", async ({
  dashboard: page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" })
    .getByRole("button", { name: "New" }).click();
  const name = "PR Shepherd";
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill(name);
  await editor.getByRole("combobox", { name: "Persona" })
    .selectOption({ label: "Code Risk Reviewer · built-in" });
  await editor.getByRole("combobox", { name: "Harness" }).selectOption("claude");
  await editor.getByRole("button", { name: "Save" }).click();
  await page.getByRole("region", { name: `Resident profile ${name}` })
    .getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByRole("button", { name: "No repository" }).click();
  await expect(dialog.getByLabel("Repository")).toHaveValue("");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  let task: Task | undefined;
  await expect.poll(async () => {
    const response = await fetch(`${daemon.baseURL}/api/tasks`);
    task = ((await response.json()) as Task[]).find((candidate) => candidate.kind === "resident");
    return task?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");
  expect(task).toMatchObject({ workspaceKind: "resident-workspace", worktreePath: null });
  await expect.poll(async () => (await sessionById(daemon, task!.sessionId!))?.agentSessionId ?? null)
    .toBeTruthy();
  const session = (await sessionById(daemon, task!.sessionId!))!;

  // What the Shepherd actually ran, then the stricter case: even a real `gh pr create` from a
  // session the poller can never confirm or retract must not decorate it.
  runBashHook(daemon, session, `gh pr view ${PR_NUMBER} --json url --jq .url`);
  runBashHook(daemon, session, `gh pr create --title "Not mine" --body "x"`);
  await expect.poll(async () => (await sessionById(daemon, session.id))?.hooksSeen).toBe(true);
  const after = (await sessionById(daemon, session.id))!;
  expect(after).toMatchObject({ prUrl: null, prNumber: null, prState: null });

  await useConsole(page, daemon);
  const rail = page.getByRole("navigation", { name: "Sessions" });
  await rail.locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  await expect(card.locator(".detail-sub")).toContainText("no repository");
  await expect(card.getByRole("link", { name: new RegExp(`#${PR_NUMBER}`) })).toHaveCount(0);
  await expect(card.getByText(`#${PR_NUMBER}`, { exact: true })).toHaveCount(0);
  await expect(rail.getByText(`#${PR_NUMBER}`, { exact: true })).toHaveCount(0);
  await capture(page, "resident-after-gh-pr-view-and-create.png");
});
