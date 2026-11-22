import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Task shaping's route stage, from the Dispatch button to the after-work prompt.
 *
 * A selector and a router are real `command` processes (`e2e/fixtures/fake-shaper.mjs`). The
 * router routes one skill for during the work and one for after it. The worker's first prompt
 * carries "Skills for this task" after the task context; once the work is submitted to a
 * workflow, Mission Control itself prompts the after-work skill, which reaches the session as a
 * later user turn led by its invocation; and the context viewer lists both skills and says the
 * after-work one was prompted.
 *
 * No model tokens: the agent is the suite's fake Claude, and both shapers answer from a script.
 */

const SHAPER = fileURLToPath(new URL("../fixtures/fake-shaper.mjs", import.meta.url));
const EVIDENCE = artifactsDir("task-shaping-route");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-shaping-route/${name}.png`);
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

/** The flag on, and one enabled `command` shaper per entry. Registration stores each off, so each is switched on. */
async function registerShapers(daemon: DaemonHandle, shapers: Array<{ id: string; label: string; stage: string; args: string[] }>): Promise<void> {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "task-shaping", enabled: true }, "PUT");
  await api(daemon, "/api/shaping", { kind: "settings", limits: { deadlineMs: 60_000 } }, "PUT");
  for (const shaper of shapers) {
    await api(daemon, "/api/shaping", {
      kind: "upsert",
      shaper: {
        id: shaper.id, label: shaper.label, stage: shaper.stage, timeoutMs: 30_000,
        transport: { type: "command", command: process.execPath, args: [SHAPER, ...shaper.args] },
      },
    }, "PUT");
    await api(daemon, "/api/shaping", { kind: "enable", id: shaper.id, enabled: true }, "PUT");
  }
}

/** Every user turn the fake Claude recorded under this daemon's home, in the order it wrote them. */
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

/** A published workflow that ends as soon as the session submits: the after-work step, and nothing more. */
async function publishedWorkflow(daemon: DaemonHandle): Promise<string> {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Finish",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 1 },
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 220, y: 0 } },
      ],
      edges: [{ id: "complete", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
    },
  });
  const published = await api<{ version: { id: string } }>(daemon, `/api/workflows/${created.workflow.id}/publish`, { expectedDraftRevision: 1 });
  return published.version.id;
}

test("a routed skill reaches turn one, the after-work skill is prompted once the work is submitted, and the viewer shows both", async ({ dashboard, daemon }) => {
  await registerShapers(daemon, [
    { id: "acme-guidance", label: "Acme guidance", stage: "select", args: ["ok"] },
    { id: "skill-router", label: "Skill router", stage: "route", args: ["route", "lint-fix:during,wrap-notes:after-work"] },
  ]);
  await api(daemon, "/api/ui/config", { layout: "console" }, "PUT");
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch" })).toBeVisible();

  const title = "Retry the ledger sync";
  const intent = "Make the ledger sync retry safely.";
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  const created = dashboard.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const task = await (await created).json() as { id: string };
  await expect(dialog).toBeHidden();

  // Turn one: the task context, then "Skills for this task" naming each routed skill and when.
  const turnOne = () => recordedUserTurns(daemon).find((turn) => turn.includes(intent)) ?? "";
  await expect.poll(turnOne, { timeout: 60_000 }).toMatch(
    /Make the ledger sync retry safely\.[\s\S]*## Task context[\s\S]*## Skills for this task[\s\S]*- `\/lint-fix` - during the work: use this skill when it applies\.[\s\S]*- `\/wrap-notes` - after the work: do not use it yet\./,
  );
  // Nothing has prompted the after-work skill yet.
  expect(recordedUserTurns(daemon).some((turn) => turn.startsWith("/wrap-notes"))).toBe(false);

  let sessionId = "";
  await expect.poll(async () => {
    const current = (await api<Array<{ id: string; status: string; sessionId: string | null }>>(daemon, "/api/tasks"))
      .find((entry) => entry.id === task.id);
    sessionId = current?.status === "running" ? current.sessionId ?? "" : "";
    return sessionId;
  }, { timeout: 60_000 }).not.toBe("");
  await expect.poll(async () => (await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
    .find((session) => session.id === sessionId)?.state, { timeout: 60_000 }).toBe("idle");

  // The person submits the work to a workflow: its after-work step starts.
  const versionId = await publishedWorkflow(daemon);
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId, sessionId, deliveryMode: "preview", maxRepairRounds: 1,
  });
  await api(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-task-shaping-route" });

  // Mission Control prompts it as a later user turn, led by the skill's invocation, once.
  const prompted = () => recordedUserTurns(daemon).filter((turn) => turn.startsWith("/wrap-notes"));
  await expect.poll(() => prompted().length, { timeout: 60_000 }).toBe(1);
  const turns = recordedUserTurns(daemon);
  expect(turns.findIndex((turn) => turn.startsWith("/wrap-notes"))).toBeGreaterThan(turns.findIndex((turn) => turn.includes(intent)));
  expect(prompted()[0]).toContain("The work is complete");
  expect(prompted()[0]).not.toContain("lint-fix");

  // Task reads carry the skills and the prompt.
  await expect.poll(async () => (await api<{ afterWork: { state: string } | null }>(daemon, `/api/tasks/${task.id}/shaping`)).afterWork?.state,
    { timeout: 30_000 }).toBe("delivered");
  const read = (await api<Array<{ id: string; shaping?: { skills?: Array<{ name: string; state: string }> } }>>(daemon, "/api/tasks"))
    .find((entry) => entry.id === task.id);
  expect(read?.shaping?.skills?.map((skill) => [skill.name, skill.state])).toEqual([["lint-fix", "announced"], ["wrap-notes", "announced"]]);

  // The viewer: both skills, each with when, its router and its state, and the after-work one prompted.
  const rail = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: title });
  await rail.click();
  const chip = dashboard.locator(".console-detail").getByRole("button", { name: "Context: 2 entries, 2 skills", exact: true });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, "route-chip", dashboard.locator(".console-detail"));
  await chip.click();
  const viewer = dashboard.getByRole("dialog", { name: "Context this session received" });
  await expect(viewer).toBeVisible();
  const skills = viewer.getByRole("region", { name: "Skills for this task" });
  await expect(skills.getByRole("listitem", { name: "lint-fix: Announced" })).toContainText("during the work · routed by Skill router · not verified");
  const wrap = skills.getByRole("listitem", { name: "wrap-notes: Announced" });
  await expect(wrap).toContainText("after the work");
  await expect(wrap).toContainText("e2e/wrap-notes");
  await expect(wrap.getByRole("note")).toContainText(/^Prompted/);
  await expect(viewer.getByRole("region", { name: "Delivered in turn one" })).toContainText("## Skills for this task");
  await expectContentClearsBorder(viewer);
  await shoot(dashboard, "route-viewer", viewer);
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toBeHidden();
});
