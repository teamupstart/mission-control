import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Hibernating a task (issue #1547), end to end: the Pause menu's Hibernate reaches the route,
 * the daemon really ends the agent's process, and the task leaves the board for the Backlog's
 * Hibernated section - where it survives a daemon restart, says why a Resume failed, and
 * Retry reopens the SAME conversation under the same session in the same worktree.
 *
 * A real Agent SDK session whose driver child is the fake Claude, so the process ending and
 * coming back is observable in the process table without spending a token.
 */

const EVIDENCE = artifactsDir("task-hibernation");

interface LiveSession {
  id: string;
  name: string;
  state: string;
  cwd: string | null;
  agentSessionId: string | null;
}

interface WireTask {
  id: string;
  title: string;
  status: string;
  sessionId: string | null;
  worktreePath: string | null;
  hibernation?: { sessionId: string; agentSessionId: string; failure: { reason: string } | null } | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  return (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as LiveSession[];
}

async function taskById(daemon: DaemonHandle, id: string): Promise<WireTask | undefined> {
  const tasks = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as WireTask[];
  return tasks.find((task) => task.id === id);
}

async function setHibernationFlag(daemon: DaemonHandle, enabled: boolean): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "flag", id: "task-hibernation", enabled }),
  });
  expect(response.ok, "the daemon accepted the flag choice").toBe(true);
}

async function putUi(daemon: DaemonHandle, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, "the daemon accepted the UI preference").toBe(true);
}

async function dispatchIdle(page: Page, daemon: DaemonHandle, title: string): Promise<LiveSession> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`${title}: say hello`);
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd && fresh.agentSessionId ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${title}" settled idle` }).toBe("idle");
  return fresh!;
}

/** Every process under the daemon running the fake Claude: the SDK driver's child and below. */
async function fakeAgents(daemon: DaemonHandle): Promise<number> {
  const health = (await (await fetch(`${daemon.baseURL}/api/health`)).json()) as { pid: number };
  const table = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
  const under = new Set([health.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table) {
      if (!under.has(p.pid) && under.has(p.ppid)) {
        under.add(p.pid);
        grew = true;
      }
    }
  }
  return table.filter((p) => under.has(p.pid) && /fake-claude/.test(p.command)).length;
}

async function shoot(page: Page, target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-hibernation/${name}.png`);
}

function boardCard(page: Page, name: string): Locator {
  return page.locator(".tile").filter({ has: page.locator(".tile-name", { hasText: name }) });
}

test("Hibernate parks a task in the Backlog across a restart, and Retry reopens the same conversation after a failed Resume", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  await setHibernationFlag(daemon, true);
  const session = await dispatchIdle(page, daemon, "Hibernate ledger");
  await putUi(daemon, { layout: "board" });
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();

  const card = boardCard(page, session.name);
  await expect(card).toBeVisible();
  await expect.poll(() => fakeAgents(daemon), { message: "the agent is running" }).toBeGreaterThan(0);

  // Uncommitted work in the task's worktree, which every step below must leave exactly as it is.
  const localChange = join(session.cwd!, "hibernation-local-change.txt");
  const localContent = `work in progress ${Date.now()}\n`;
  writeFileSync(localChange, localContent);
  const keptLocally = (where: string): void => {
    expect(existsSync(localChange), `the local change exists ${where}`).toBe(true);
    expect(readFileSync(localChange, "utf8"), `the local change is unchanged ${where}`).toBe(localContent);
    expect(execFileSync("git", ["-C", session.cwd!, "status", "--porcelain", "--", "hibernation-local-change.txt"], { encoding: "utf8" }),
      `git still sees the local change ${where}`).toContain("hibernation-local-change.txt");
  };

  // Hibernate from the card's run chip: the pause menu every placement opens.
  await card.getByRole("button", { name: "Pause controls: Running" }).click();
  const menu = page.getByRole("menu", { name: "Pause" });
  const hibernate = menu.getByRole("menuitem", { name: /^Hibernate/ });
  await expect(hibernate).toBeEnabled();
  await expect(hibernate).toContainText("frees its memory");
  await shoot(page, page, "pause-menu-hibernate");
  await hibernate.click();

  // The task leaves the board for the Backlog's Hibernated section.
  const shelf = page.getByRole("region", { name: "Hibernated tasks" });
  const row = shelf.getByRole("listitem", { name: `Hibernated task: ${session.name}` });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Resume" })).toBeVisible();
  // A clean hibernation, and only a clean one, says its agent's memory is free.
  await expect(row.locator(".bl-hib-meta")).toHaveAccessibleDescription(/Its agent is stopped and uses no memory\./);
  await expect(card, "the stopped card leaves the board").toHaveCount(0, { timeout: 30_000 });
  // With no session left on the board, the Backlog still draws the hibernated task rather than
  // the fleet's "No agent sessions detected" screen hiding it, and the Line names it.
  await expect(row).toBeVisible();
  await expect(page.getByText("1 hibernated", { exact: true })).toBeVisible();
  await expect.poll(() => fakeAgents(daemon), { message: "the agent's process ended" }).toBe(0);
  const task = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as WireTask[])
    .find((t) => t.hibernation?.sessionId === session.id)!;
  expect(task.status).toBe("hibernated");
  expect(task.hibernation?.agentSessionId).toBe(session.agentSessionId);
  expect(task.worktreePath).toBe(session.cwd);
  keptLocally("after Hibernate");
  await shoot(page, page.locator("section.board-backlog"), "backlog-hibernated");

  // Across a restart it stays hibernated, and nothing relaunches it.
  await daemon.shutdown();
  await daemon.restart();
  await page.reload();
  await expect(page.getByRole("region", { name: "Hibernated tasks" })
    .getByRole("listitem", { name: `Hibernated task: ${session.name}` })).toBeVisible();
  expect((await taskById(daemon, task.id))?.status).toBe("hibernated");
  expect((await sessions(daemon)).some((s) => s.id === session.id)).toBe(false);
  expect(await fakeAgents(daemon)).toBe(0);
  keptLocally("after a restart");
  await expect(page.locator("section.board-backlog .board-col-n"), "the Backlog head counts it").toHaveText("1");

  // The Line's Backlog drawer - the Backlog of the Console layout - carries the same section.
  const lineBacklog = page.getByRole("navigation", { name: "The Line" }).getByRole("button", { name: /^Backlog,/ });
  await lineBacklog.click();
  const drawer = page.getByRole("region", { name: "Backlog drawer" });
  await expect(drawer.getByRole("listitem", { name: `Hibernated task: ${session.name}` })
    .getByRole("button", { name: "Resume" })).toBeVisible();
  await shoot(page, drawer, "line-backlog-drawer");
  await lineBacklog.click();
  await expect(drawer).toBeHidden();

  // The Console has no Backlog column, and with no session left it draws no fleet at all. The
  // Line and the Backlog drawer it opens sit outside that gate, so Resume stays one click away
  // - from the strip, and with the Line switched off from its stages loose on the page.
  for (const lineHidden of [false, true]) {
    await putUi(daemon, { layout: "console", lineHidden });
    await page.reload();
    await expect(page.getByText("No agent sessions detected"), "the Console has no session to draw").toBeVisible();
    const stages = lineHidden
      ? page.getByRole("group", { name: "Line drawers" })
      : page.getByRole("navigation", { name: "The Line" });
    const backlogStage = stages.getByRole("button", { name: /^Backlog,/ });
    await backlogStage.click();
    const consoleDrawer = page.getByRole("region", { name: "Backlog drawer" });
    await expect(consoleDrawer.getByRole("listitem", { name: `Hibernated task: ${session.name}` })
      .getByRole("button", { name: "Resume" })).toBeVisible();
    await shoot(page, page, lineHidden ? "console-line-off-backlog-drawer" : "console-backlog-drawer");
    await backlogStage.click();
    await expect(consoleDrawer).toBeHidden();
  }
  await putUi(daemon, { layout: "board", lineHidden: false });
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();

  // A Resume that cannot reopen the conversation says why and keeps the work.
  const worktree = task.worktreePath!;
  const aside = `${worktree}-aside`;
  renameSync(worktree, aside);
  const parkedRow = page.getByRole("region", { name: "Hibernated tasks" })
    .getByRole("listitem", { name: `Hibernated task: ${session.name}` });
  try {
    await parkedRow.getByRole("button", { name: "Resume" }).click();
    await expect(parkedRow.getByRole("alert").first()).toContainText("Could not resume");
    await expect(parkedRow.getByRole("alert").first()).toContainText("no longer exists");
    await expect(parkedRow.getByRole("button", { name: "Retry" })).toBeVisible();
    // With a failure on record the card claims nothing about the agent, and points at the note.
    await expect(parkedRow.locator(".bl-hib-meta")).toHaveAccessibleDescription(/See the note below: its agent may not have stopped cleanly\./);
    expect((await taskById(daemon, task.id))?.status).toBe("hibernated");
    await shoot(page, page.locator("section.board-backlog"), "backlog-resume-failed");
  } finally {
    renameSync(aside, worktree);
  }
  keptLocally("after a failed Resume");

  // Retry reopens the same conversation, under the same session, back on the board.
  await parkedRow.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("region", { name: "Hibernated tasks" })).toHaveCount(0, { timeout: 30_000 });
  await expect(boardCard(page, session.name)).toBeVisible();
  await expect.poll(async () => {
    const back = (await sessions(daemon)).find((s) => s.id === session.id);
    return back ? { state: back.state, agentSessionId: back.agentSessionId } : null;
  }, { timeout: 30_000, message: "the same session came back idle on the same conversation" })
    .toEqual({ state: "idle", agentSessionId: session.agentSessionId });
  const resumed = await taskById(daemon, task.id);
  expect(resumed?.status).toBe("running");
  expect(resumed?.sessionId).toBe(session.id);
  expect(resumed?.worktreePath).toBe(worktree);
  keptLocally("after Retry reopened the conversation");
  await expect.poll(() => fakeAgents(daemon), { message: "the agent runs again" }).toBeGreaterThan(0);
  await shoot(page, page.locator("main.board"), "board-resumed");
});

test("a hibernated task's age keeps counting past its first hour", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await setHibernationFlag(daemon, true);
  const session = await dispatchIdle(page, daemon, "Hibernate clock");
  await putUi(daemon, { layout: "board" });
  // The page's clock, so hours can pass in a moment. It keeps running at normal speed until
  // fast-forwarded, so everything else on the page behaves as it always does.
  await page.clock.install();
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
  const card = boardCard(page, session.name);
  await card.getByRole("button", { name: "Pause controls: Running" }).click();
  await page.getByRole("menu", { name: "Pause" }).getByRole("menuitem", { name: /^Hibernate/ }).click();
  const row = page.getByRole("region", { name: "Hibernated tasks" })
    .getByRole("listitem", { name: `Hibernated task: ${session.name}` });
  await expect(row).toContainText(/Hibernated (just now|\d+s ago)/);

  // Past the first hour it still moves on: a clock that stopped there would read "2h ago" for days.
  await page.clock.fastForward("02:00:00");
  await expect(row).toContainText("Hibernated 2h ago");
  await page.clock.fastForward("03:00:00");
  await expect(row).toContainText("Hibernated 5h ago");
});

test("the Hibernate tasks flag appears in Settings, and switching it on reaches another window without a reload", async ({ dashboard: page, context, daemon }) => {
  const session = await dispatchIdle(page, daemon, "Hibernate flag ledger");
  await putUi(daemon, { layout: "board" });
  const peer = await context.newPage();
  await peer.goto(`${daemon.baseURL}/#/fleet`);
  await expect(peer.locator("main.board")).toBeVisible();
  const card = boardCard(peer, session.name);
  await card.getByRole("button", { name: "Pause controls: Running" }).click();
  const menu = peer.getByRole("menu", { name: "Pause" });
  await expect(menu.getByRole("menuitem", { name: /^Pause now/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Hibernate/ }), "off by default").toHaveCount(0);
  await peer.keyboard.press("Escape");

  await page.goto(`${daemon.baseURL}/#/settings/feature-flags`);
  const flag = page.getByRole("button", { name: "Hibernate tasks: off" });
  await expect(flag).toBeVisible();
  await flag.click();
  await expect(page.getByRole("button", { name: "Hibernate tasks: on" })).toBeVisible();
  await shoot(page, page.locator('[data-anchor="feature-flags/task-hibernation"]'), "settings-flag");

  // The other window learns it over the event stream, with no reload.
  await card.getByRole("button", { name: "Pause controls: Running" }).click();
  await expect(peer.getByRole("menu", { name: "Pause" }).getByRole("menuitem", { name: /^Hibernate/ })).toBeVisible();
});
