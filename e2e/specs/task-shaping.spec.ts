import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { handOver, hasTmux, PANE_AGENT_DAEMON, paneSession, sessionIdle, startPaneAgent } from "../fixtures/pane-agent.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Task shaping at dispatch, from the Dispatch button to what the session shows.
 *
 * Only this layer connects the pieces: a click files the task, the daemon provisions it and
 * calls a real `command` shaper process, the pending tile names the step while it runs, the
 * worker's turn one carries the section, the record lands on the task over SSE, and the chip,
 * its viewer and the board marker draw it - or, for a launch whose record names another
 * session, draw nothing.
 *
 * A backlog task handed over to an agent that is already running (`TaskManager.assign`) is
 * shaped too, and its record has to land on the session that took the turn: the last block
 * hands two tasks in turn to one live pane agent and reads what each showed.
 *
 * No model tokens: the agents are the suite's fakes, and the shaper is
 * `e2e/fixtures/fake-shaper.mjs`, which answers from a fixed script.
 */

const SHAPER = fileURLToPath(new URL("../fixtures/fake-shaper.mjs", import.meta.url));
const EVIDENCE = artifactsDir("task-shaping");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  console.log(`CAPTURED e2e/.artifacts/task-shaping/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

/** The flag on, and one enabled `command` shaper at the select stage. */
async function registerShaper(
  daemon: DaemonHandle,
  id: string,
  label: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<void> {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  // A long step, so a held shaper is released by the spec rather than by the deadline.
  await api(daemon, "/api/shaping", { kind: "settings", limits: { deadlineMs: 60_000 } }, "PUT");
  await api(daemon, "/api/shaping", {
    kind: "upsert",
    shaper: { id, label, stage: "select", timeoutMs, transport: { type: "command", command: process.execPath, args: [SHAPER, ...args] } },
  }, "PUT");
  await api(daemon, "/api/shaping", { kind: "enable", id, enabled: true }, "PUT");
}

async function useLayout(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  await api(daemon, "/api/ui/config", { layout }, "PUT");
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

/** Dispatch from the modal, as an operator does, and return the task it filed. */
async function dispatch(page: Page, daemon: DaemonHandle, intent: string, title: string): Promise<{ id: string }> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const response = await created;
  expect(response.ok(), `dispatching answered ${response.status()}`).toBe(true);
  await expect(dialog).toBeHidden();
  return await response.json() as { id: string };
}

/** Every user turn the fake Claude recorded under this daemon's home. */
function recordedUserTurns(daemon: DaemonHandle): string[] {
  const root = join(daemon.home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const turns: string[] = [];
  for (const project of readdirSync(root)) {
    for (const file of readdirSync(join(root, project)).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(root, project, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (record.type !== "user") continue;
          const content = record.message?.content;
          turns.push(typeof content === "string" ? content : JSON.stringify(content));
        } catch {
          // A line still being written; the next poll reads it whole.
        }
      }
    }
  }
  return turns;
}

function sessionRail(page: Page, title: string): Locator {
  return page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: title });
}

test("a shaped dispatch shows Shaping context, then the context its session received", async ({ dashboard, daemon }) => {
  const gate = join(daemon.home, "release-shaper");
  await registerShaper(daemon, "acme-guidance", "Acme guidance", ["ok", "--wait", gate]);
  await useLayout(dashboard, daemon, "console");
  const title = "Add idempotent charges";
  const task = await dispatch(dashboard, daemon, "Make charging idempotent.", title);

  // While the shaper is held, the pending row names the step.
  const starting = dashboard.getByRole("list", { name: "Starting" });
  const row = starting.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Shaping context", { timeout: 30_000 });
  await shoot(dashboard, "shaping-context-pending", starting);
  writeFileSync(gate, "");

  // The worker's first prompt ends with the Task context section, after the operator's words.
  const turnOne = () => recordedUserTurns(daemon).find((turn) => turn.includes("Make charging idempotent.")) ?? "";
  await expect.poll(turnOne, { timeout: 60_000 })
    .toMatch(/Make charging idempotent\.[\s\S]*## Task context[\s\S]*### Acme guidance: Idempotent charges[\s\S]*### Acme guidance: Retry budget/);
  const sentSection = turnOne().slice(turnOne().indexOf("## Task context"));

  await sessionRail(dashboard, title).click();
  const chip = dashboard.locator(".console-detail").getByRole("button", { name: "Context: 2 entries", exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, "context-chip", dashboard.locator(".console-detail"));
  await chip.click();
  const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("listitem", { name: "Acme guidance: Answered" })).toContainText("version e2e-1");
  // The section exactly as turn one carried it, shown whole rather than split back into entries.
  const delivered = viewer.getByRole("region", { name: "Delivered in turn one" });
  await expect(delivered).toContainText("## Task context");
  const deliveredText = await delivered.locator("pre").innerText();
  expect(deliveredText.trim()).toBe(sentSection.trim());
  // The text scrolls on its own, so it is a named region a keyboard can tab into.
  const deliveredScroll = delivered.getByRole("region", { name: "Delivered text" });
  await deliveredScroll.focus();
  await expect(deliveredScroll).toBeFocused();
  await expectContentClearsBorder(viewer);
  await shoot(dashboard, "context-viewer", viewer);
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toBeHidden();

  // Task reads carry the same record, for the session it describes.
  const read = (await api<Array<{ id: string; sessionId: string | null; shaping?: { state: string; sessionId: string } }>>(daemon, "/api/tasks"))
    .find((entry) => entry.id === task.id);
  expect(read?.shaping).toMatchObject({ state: "ok", sessionId: read?.sessionId });
});

test("a slow shaper still launches and shows Context degraded, and a redispatch without it shows nothing", async ({ dashboard, daemon }) => {
  await registerShaper(daemon, "slow-guidance", "Slow guidance", ["slow", "20000"], 1500);
  await useLayout(dashboard, daemon, "board");
  const title = "Tune the retry worker";
  const task = await dispatch(dashboard, daemon, "Tune the retry worker's backoff.", title);

  // The launch is not held by the shaper: the session lands, and its card says what happened.
  const tile = dashboard.locator("section.board-col .tile:not(.pend-tile)", { hasText: title });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  const marker = tile.getByText("context degraded");
  await expect(marker).toBeVisible({ timeout: 30_000 });
  // The flag is only a tooltip trigger, and the tooltip gives it the tab stop a keyboard needs.
  await expect(marker).toHaveAttribute("tabindex", "0");
  // The whole board: a live tile re-renders as its session reports, so a frame of the element
  // alone can be taken from a node that was just replaced.
  await shoot(dashboard, "degraded-board-marker");

  await useLayout(dashboard, daemon, "console");
  await sessionRail(dashboard, title).click();
  await expect(sessionRail(dashboard, title).getByRole("img", { name: "Context degraded" })).toBeVisible();
  const chip = dashboard.locator(".console-detail").getByRole("button", { name: "Context degraded", exact: true });
  await expect(chip).toBeVisible();
  await chip.click();
  const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
  await expect(viewer.getByRole("listitem", { name: "Slow guidance: Timed out" })).toContainText("Timed out after 1.5 s.");
  await expect(viewer.getByText("No context was added to turn one.")).toBeVisible();
  await expectContentClearsBorder(viewer);
  await shoot(dashboard, "degraded-viewer", viewer);
  await viewer.getByRole("button", { name: "Close" }).click();

  // Back to the backlog, the shaper switched off, and the same task dispatched again.
  const firstSession = (await api<Array<{ id: string; sessionId: string | null }>>(daemon, "/api/tasks"))
    .find((entry) => entry.id === task.id)?.sessionId;
  await api(daemon, `/api/tasks/${task.id}/requeue`, {});
  await api(daemon, "/api/shaping", { kind: "enable", id: "slow-guidance", enabled: false }, "PUT");
  // The operator launching it by hand: a requeued task is held from autopilot until then.
  await api(daemon, `/api/tasks/${task.id}/dispatch`, { overrideDisabled: true });
  await expect.poll(async () => {
    const current = (await api<Array<{ id: string; status: string; sessionId: string | null }>>(daemon, "/api/tasks"))
      .find((entry) => entry.id === task.id);
    return current?.status === "running" && current.sessionId !== firstSession ? current.sessionId : null;
  }, { timeout: 60_000 }).not.toBeNull();
  await sessionRail(dashboard, title).first().click();
  await expect(dashboard.locator(".console-detail")).toBeVisible();
  await expect(dashboard.locator(".console-detail").getByRole("button", { name: /^Context/ })).toHaveCount(0);
  await expect(sessionRail(dashboard, title).getByRole("img", { name: "Context degraded" })).toHaveCount(0);
  const read = (await api<Array<{ id: string; shaping?: unknown }>>(daemon, "/api/tasks")).find((entry) => entry.id === task.id);
  expect(read && "shaping" in read).toBe(false);
  await shoot(dashboard, "redispatch-no-chip", dashboard.locator(".console-detail"));
});

test("a dashboard that connected with shaping off shows the saved context as soon as the flag is turned back on", async ({ dashboard, daemon }) => {
  await registerShaper(daemon, "acme-guidance", "Acme guidance", ["ok"]);
  await useLayout(dashboard, daemon, "console");
  const title = "Retry the ledger sync";
  const task = await dispatch(dashboard, daemon, "Make the ledger sync retry safely.", title);
  await sessionRail(dashboard, title).click();
  const detail = dashboard.locator(".console-detail");
  const chip = detail.getByRole("button", { name: "Context: 2 entries", exact: true });
  await expect(chip).toBeVisible({ timeout: 60_000 });

  // The flag goes off, and this window reconnects while it is off: the card arrives without
  // its record, so there is no chip.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: false }, "PUT");
  await dashboard.reload();
  await sessionRail(dashboard, title).click();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: /^Context/ })).toHaveCount(0);
  // Let the worker finish its turn and go quiet, so no later session update could carry the
  // record by accident: the flag change itself has to bring it back.
  const sessionId = (await api<Array<{ id: string; sessionId: string | null }>>(daemon, "/api/tasks"))
    .find((entry) => entry.id === task.id)?.sessionId;
  let previous = "";
  await expect.poll(async () => {
    const current = JSON.stringify((await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
      .find((session) => session.id === sessionId) ?? null);
    const quiet = current === previous && current.includes('"state":"idle"');
    previous = current;
    return quiet;
  }, { timeout: 60_000, intervals: [2_000] }).toBe(true);

  // Back on, with no reload and no change to the session: the saved context is there again.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await chip.click();
  const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
  await expect(viewer.getByRole("region", { name: "Delivered in turn one" })).toContainText("## Task context");
  await shoot(dashboard, "flag-reenabled-chip", viewer);
});

test.describe("handed over to a running agent", () => {
  // Only a discovered terminal agent can take a handover; see `fixtures/pane-agent.ts`.
  test.use(PANE_AGENT_DAEMON);
  test.skip(!hasTmux(), "tmux is not installed on this machine");

  test("a handover shows exactly the context that agent received in its turn, not the previous task's", async ({ dashboard, daemon }) => {
    // One entry per task, named for it, so two tasks' sections can be told apart.
    await registerShaper(daemon, "task-briefs", "Task briefs", ["brief"]);
    await useLayout(dashboard, daemon, "console");
    const pane = startPaneAgent(daemon, { prefix: "mc-e2e-shaped-handover", turns: true });
    try {
      const sessionId = await paneSession(daemon, pane);
      const backlogTask = (title: string, intent: string) => api<{ id: string }>(daemon, "/api/tasks", {
        repoRoot: daemon.repo, title, intent, kind: "ship", agent: "claude", workflowId: null, backlog: true,
      });
      /** The section the pane agent was typed in the turn carrying this intent. */
      const sectionFor = (intent: string): string => {
        const turn = pane.turns().find((text) => text.includes(intent)) ?? "";
        const at = turn.indexOf("## Task context");
        return at === -1 ? "" : turn.slice(at).trim();
      };
      const detail = dashboard.locator(".console-detail");
      const chip = detail.getByRole("button", { name: "Context: 1 entry", exact: true });
      const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
      const delivered = viewer.getByRole("region", { name: "Delivered in turn one" });

      // The previous task: handed to this agent, shaped, and shown on its header, so the record
      // a later handover must not show is really there on this session first.
      const previousTitle = "Reconcile the ledger";
      const previousIntent = "Reconcile the ledger every night.";
      const previous = await backlogTask(previousTitle, previousIntent);
      await handOver(daemon, previous.id, sessionId);
      await expect.poll(() => sectionFor(previousIntent), { timeout: 60_000 }).toContain(`### Task briefs: Brief for ${previousTitle}`);
      await sessionRail(dashboard, previousTitle).click();
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await chip.click();
      await expect(delivered).toContainText(`Brief for ${previousTitle}`);
      await viewer.getByRole("button", { name: "Close" }).click();
      await expect(viewer).toBeHidden();
      await sessionIdle(daemon, sessionId);
      await api(daemon, `/api/tasks/${previous.id}/complete`, { outcome: "Reconciled." });
      await sessionIdle(daemon, sessionId);

      // This task, handed to the same agent. Its turn carries its own section and nothing of the last one.
      const title = "Cap the retry budget";
      const intent = "Cap the retry worker at five attempts.";
      const task = await backlogTask(title, intent);
      await handOver(daemon, task.id, sessionId);
      await expect.poll(() => sectionFor(intent), { timeout: 60_000 }).toContain(`### Task briefs: Brief for ${title}`);
      const received = sectionFor(intent);
      expect(received).not.toContain(previousTitle);

      // The header chip on that session, and its viewer showing that section exactly.
      await sessionRail(dashboard, title).click();
      await expect(detail).toContainText(title);
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await shoot(dashboard, "handover-chip", detail);
      await chip.click();
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole("listitem", { name: "Task briefs: Answered" })).toContainText("version e2e-brief-1");
      await expect(delivered).toContainText(`Brief for ${title}`);
      expect((await delivered.locator("pre").innerText()).trim()).toBe(received);
      await expect(viewer).not.toContainText(previousTitle);
      await expectContentClearsBorder(viewer);
      await shoot(dashboard, "handover-viewer", viewer);
      await viewer.getByRole("button", { name: "Close" }).click();
      await expect(viewer).toBeHidden();

      // Every task read agrees: this task's record names the session that took the turn, and the
      // previous task's, which named the same session, is no longer shown by any reader.
      const shaping = await api<{ summary: { sessionId: string }; text: string | null }>(daemon, `/api/tasks/${task.id}/shaping`);
      expect(shaping.summary.sessionId).toBe(sessionId);
      expect(shaping.text?.trim()).toBe(received);
      const reads = await api<Array<{ id: string; sessionId: string | null; shaping?: { state: string; sessionId: string } }>>(daemon, "/api/tasks");
      expect(reads.find((entry) => entry.id === task.id)?.shaping).toMatchObject({ state: "ok", sessionId });
      expect(reads.find((entry) => entry.id === previous.id)?.shaping).toBeUndefined();
    } finally {
      pane.cleanup();
    }
  });
});
