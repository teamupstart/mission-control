import { mkdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { shellWords } from "../../src/server/terminal/shell.ts";
import { WORK_UNIT_REUSE_REFUSAL } from "../../src/shared/work-unit.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * The work unit id preview, from the launches it shapes to the row a person reads.
 *
 * With `work-unit-id` on, an agent Mission Control starts for a task gets that task's work unit
 * in its environment as `WORK_UNIT_ID`, which MCP config that references it turns into the
 * `x-work-unit-id` header. The fakes record their own environment, so each launch's value is
 * read where the agent read it: the embedded Claude driver, the embedded Codex app-server and
 * a terminal wrapper's exports. The session detail shows the id the session emits and copies
 * it. With the preview off there is no variable and no row. And an idle agent started for one
 * work unit refuses a task of another, saying why on the board.
 *
 * Real daemon, real routes, real SSE and the built dashboard; every agent binary is a fake, so
 * no model tokens are spent.
 */

const EVIDENCE = artifactsDir("work-unit-id");

async function shoot(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/work-unit-id/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function preview(daemon: DaemonHandle, enabled: boolean): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "work-unit-id", enabled }, "PUT");
  expect(config.overrides["work-unit-id"]).toBe(enabled);
}

async function dispatch(daemon: DaemonHandle, title: string, over: Record<string, unknown>): Promise<Task> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: `${title}.`, kind: "ship", workflowId: null, ...over,
  });
  expect(task.workUnitId, "every task has its work unit whatever the preview").toMatch(/^wu_[0-9A-HJKMNP-TV-Z]{26}$/);
  return task;
}

interface Invocation { argv: string[]; cwd: string; workUnitId: string | null }

/** The dispatched agent launches a fake recorded, in a task worktree. */
function launches(daemon: DaemonHandle, agent: "claude" | "codex"): Invocation[] {
  const worktrees = join(daemon.home, "worktree-pools") + sep;
  return recordsIn<Invocation>(join(daemon.recordDir, agent), (file) => file.startsWith("invocation-"))
    .filter((record) => record.cwd.startsWith(worktrees));
}

/** The work unit each terminal wrapper exports, and whether it unsets the pane's first. */
function terminalLaunches(daemon: DaemonHandle): Array<{ workUnitId: string | null; unsetsPane: boolean }> {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("cmux-")).flatMap((record) => {
    const argv = Array.isArray(record.argv) ? (record.argv as string[]) : [];
    if (argv[0] !== "new-workspace") return [];
    const wrapper = shellWords(argv[argv.indexOf("--command") + 1] ?? "").find((word) => word.endsWith("launch-and-cleanup.sh"));
    if (!wrapper) return [];
    const lines = readFileSync(wrapper, "utf8").split("\n");
    const exported = lines.find((line) => line.startsWith("export WORK_UNIT_ID="));
    const unset = lines.find((line) => line.startsWith("unset ")) ?? "";
    return [{
      workUnitId: exported ? shellWords(exported.slice("export ".length))[0]!.split("=")[1]! : null,
      unsetsPane: unset.split(" ").includes("WORK_UNIT_ID"),
    }];
  });
}

async function sessionFor(daemon: DaemonHandle, taskId: string): Promise<Session | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((session) => session.task?.id === taskId);
}

/** Open a session's detail from the rail, by the task title its card carries. */
async function openSession(page: Page, title: string): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: title }).first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toContainText(title);
  return detail;
}

test("with the preview on, each launch carries its own task's work unit, and the detail shows and copies it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await preview(daemon, true);

  // An embedded Claude task: the Agent SDK driver's environment.
  const claude = await dispatch(daemon, "Tag the Claude driver", { agent: "claude", runtime: "sdk" });
  await expect.poll(() => launches(daemon, "claude").filter((l) => l.argv.includes("--input-format")).map((l) => l.workUnitId),
    { timeout: 60_000, message: "the embedded Claude launch recorded its environment" }).toContain(claude.workUnitId);

  // An embedded Codex task: the `codex app-server` process Mission Control spawns. Real Codex
  // puts the variable on every MCP request whose config maps a header to it (checked against a
  // local fixture during planning); this is Mission Control's half.
  const codex = await dispatch(daemon, "Tag the Codex app-server", { agent: "codex", runtime: "sdk" });
  await expect.poll(() => launches(daemon, "codex").map((l) => l.workUnitId),
    { timeout: 60_000, message: "the app-server recorded its environment" }).toContain(codex.workUnitId);

  // A terminal task: the wrapper script the pane runs exports this launch's value, after
  // unsetting whatever the terminal server's environment held.
  const harness = await fetch(`${daemon.baseURL}/api/harnesses/config`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionRuntime: { claude: "terminal" }, terminalBackend: { claude: "cmux" } }),
  });
  expect(harness.ok).toBe(true);
  const terminal = await dispatch(daemon, "Tag the terminal agent", { agent: "claude" });
  await expect.poll(() => terminalLaunches(daemon).map((l) => l.workUnitId),
    { timeout: 60_000, message: "the dispatch opened a cmux workspace" }).toContain(terminal.workUnitId);
  expect(terminalLaunches(daemon).every((l) => l.unsetsPane), "the pane's own WORK_UNIT_ID is unset first").toBe(true);

  // Standalone tasks are separate work units.
  expect(new Set([claude.workUnitId, codex.workUnitId, terminal.workUnitId]).size).toBe(3);

  // The session reports what its agent was started with, and emits it for its task.
  await expect.poll(async () => (await sessionFor(daemon, claude.id))?.launchWorkUnitId, { timeout: 30_000 })
    .toBe(claude.workUnitId);
  expect((await sessionFor(daemon, claude.id))?.task?.workUnitId, "the id the session emits for its task").toBe(claude.workUnitId);

  // The row: the id this session emits, and a copy control that confirms.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const detail = await openSession(page, claude.title);
  const copy = detail.getByRole("button", { name: "Copy work unit id" });
  await expect(detail.getByRole("term").filter({ hasText: /^work unit$/ })).toBeVisible();
  await expect(detail.getByRole("definition").filter({ hasText: claude.workUnitId! })).toBeVisible();
  await expect(copy).toHaveText("Copy");
  await shoot(detail.locator("dl.detail-sub"), "01-work-unit-row", page);
  await copy.click();
  await expect(copy).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(claude.workUnitId);
  await shoot(detail.locator("dl.detail-sub"), "02-work-unit-copied", page);
});

test("with the preview off, a launch carries no variable and the detail shows no row", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await preview(daemon, false);
  const task = await dispatch(daemon, "Run without a work unit", { agent: "claude", runtime: "sdk" });
  await expect.poll(() => launches(daemon, "claude").filter((l) => l.argv.includes("--input-format")).length,
    { timeout: 60_000 }).toBeGreaterThan(0);
  expect(launches(daemon, "claude").map((l) => l.workUnitId)).toEqual(launches(daemon, "claude").map(() => null));
  await expect.poll(async () => (await sessionFor(daemon, task.id))?.state, { timeout: 60_000 }).toBe("idle");
  expect((await sessionFor(daemon, task.id))?.launchWorkUnitId ?? null).toBeNull();

  const detail = await openSession(page, task.title);
  await expect(detail.locator("dl.detail-sub")).toBeVisible();
  await expect(detail.getByRole("button", { name: "Copy work unit id" })).toHaveCount(0);
  await expect(detail.locator("dl.detail-sub")).not.toContainText("work unit");
  await shoot(detail.locator("dl.detail-sub"), "03-preview-off-no-row", page);
});

test("an idle agent started for another work unit refuses a dropped task, and the board says why", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await preview(daemon, true);
  // An idle agent between turns of its own task, started with that task's work unit.
  const first = await dispatch(daemon, "Started for its own unit", { agent: "claude", runtime: "sdk" });
  await expect.poll(async () => {
    const session = await sessionFor(daemon, first.id);
    return session?.state === "idle" && session.instrumented ? session.launchWorkUnitId : null;
  }, { timeout: 60_000 }).toBe(first.workUnitId);
  // Another work unit's task, waiting in the backlog in the same repository.
  const other = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Belongs to another unit", intent: "A card to drop on the agent.", backlog: true,
    // No Workflow, like the dispatched task, so the drop is judged on the agent alone.
    workflowId: null,
  });
  expect(other.workUnitId).not.toBe(first.workUnitId);

  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }),
  });
  expect(layout.ok).toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
  const card = page.locator(".bl-card", { hasText: "Belongs to another unit" });
  const tile = page.locator("section.board-col.tone-idle .tile").first();
  await expect(card).toBeVisible();
  await expect(tile).toBeVisible();

  // A real HTML5 drag, as `board-held-by-workflow.spec.ts` drives one.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent("dragstart", { dataTransfer });
  // The board offers the drop - the guard is the daemon's, so the refusal is a sentence, not a
  // tile that silently will not light up.
  await expect(tile).toHaveClass(/can-drop/);
  await tile.dispatchEvent("dragover", { dataTransfer });
  await tile.dispatchEvent("drop", { dataTransfer });
  await card.dispatchEvent("dragend", { dataTransfer });

  // The work unit is the reason given, ahead of the agent being busy: busy passes, this does not.
  const refusal = page.getByRole("status").filter({ hasText: WORK_UNIT_REUSE_REFUSAL });
  await expect(refusal).toBeVisible();
  await shoot(page, "04-reuse-refused", page);
  // Nothing was handed over: the task waits in the backlog for a new agent.
  expect((await api<Task[]>(daemon, "/api/tasks")).find((task) => task.id === other.id)?.status).toBe("backlog");
});
