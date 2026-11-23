import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * A call sign, end to end (voice plan, Phase 2). With voice on, Dispatch > Advanced offers a
 * Call sign field whose heard-as preview shows the sentence the operator would say and a
 * four-step meter. "Will" is an everyday word, so it draws a warning, and Dispatch stays enabled
 * anyway. Dispatched as "Alice", the task carries its call sign, Settings > Voice lists Alice as a
 * running session, and with the inbox naming rule on the agent's question card names it Alice.
 *
 * Real daemon, routes, SSE and the built dashboard. Every agent is the suite's fake, the question
 * is filed on the channel the MCP `request_input` tool uses, and nothing listens to a microphone.
 */

const EVIDENCE = artifactsDir("voice-call-sign");

async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const page = target.page();
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/voice-call-sign/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

/** Voice and the three previews it needs, through the Feature flags route the panel uses. */
async function turnVoiceOn(daemon: DaemonHandle): Promise<void> {
  for (const id of ["async-input", "inbox", "filed-plan-decisions", "voice"]) {
    await api(daemon, "/api/feature-flags", { kind: "flag", id, enabled: true }, "PUT");
  }
}

async function openDispatch(page: Page, daemon: DaemonHandle, intent: string): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form; close it before reaching fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  return dialog;
}

const LINTER = "Which linter should this repo use?";

/** File a question the way the MCP `request_input` tool does. */
async function ask(daemon: DaemonHandle, cwd: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: LINTER,
      body: `${LINTER}\n\nThe repo has no linter.`,
      decisions: [{ id: "q", question: LINTER, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] }],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

const advancedOf = (dialog: Locator) => dialog.getByRole("button", { name: /^Advanced/ });
const callSignOf = (scope: Locator) => scope.getByRole("textbox", { name: "Call sign", exact: true });
const meterOf = (scope: Locator) => scope.getByRole("meter", { name: "Distinctiveness" });

test("a call sign is chosen with a heard-as preview that warns without blocking, and names the session only while voice is on", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 1200 });

  // Off: Advanced offers no call sign, and the voice routes are closed.
  let dialog = await openDispatch(page, daemon, "Check the build");
  await advancedOf(dialog).click();
  await expect(dialog.getByRole("combobox", { name: "Persona", exact: true })).toBeVisible();
  await expect(callSignOf(dialog)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // On, with the page left open: the field is drawn in Advanced for every kind.
  await turnVoiceOn(daemon);
  dialog = await openDispatch(page, daemon, "Check the build");
  const advanced = advancedOf(dialog);
  if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
  const field = callSignOf(dialog);
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "A short spoken name, like Atlas");
  await expect(dialog.getByText("Type a name to see how you would say it.")).toBeVisible();
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  for (const value of ["scout", "plan", "chat", "bugfix", "document", "ship"]) {
    await kind.selectOption(value);
    await expect(field, `${value} offers a call sign`).toBeVisible();
  }
  await expectContentClearsBorder(dialog);
  await shoot(dialog, "01-advanced-empty");

  // "Will": an everyday word and one short syllable. Two warnings, two of four steps, and a line
  // for each; Dispatch stays enabled.
  await field.fill("Will");
  await expect(dialog.locator(".voice-heard")).toHaveText("Will, check the build");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "2");
  await expect(dialog.locator(".voice-meter-bad")).toHaveText("Everyday word");
  await expect(dialog.getByText("Anything you say that starts with “Will” goes to this agent, and everyday sentences can start that way. You can keep it; a rarer name is safer.")).toBeVisible();
  await expect(dialog.getByText("One short syllable is easy to miss or mishear. You can keep it; two syllables or more is safer.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await shoot(dialog, "02-warning-everyday-word");

  // "Alice": distinctive, all four steps.
  await field.fill("Alice");
  await expect(dialog.locator(".voice-heard")).toHaveText("Alice, check the build");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "4");
  await expect(dialog.locator(".voice-meter-good")).toHaveText("Distinctive");
  await expect(dialog.locator(".voice-name-warning")).toHaveCount(0);
  await shoot(dialog, "03-distinctive");

  // Collapsed, the summary names the call sign.
  await advanced.click();
  await expect(field).toBeHidden();
  await expect(advanced).toContainText("Call sign: Alice");
  await shoot(dialog, "04-advanced-collapsed");

  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const created = await posted;
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()) as Task;
  expect(task.callSign).toBe("Alice");
  await expect(dialog).toBeHidden();

  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  expect(session.task?.callSign).toBe("Alice");

  // Settings > Voice lists Alice: a running session, saying Alice, with a distinctive name.
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  const row = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Alice", exact: true }) });
  await expect(row).toHaveCount(1);
  // The Agent column is the task's title, which the daemon derives from the brief.
  await expect(row.getByRole("cell")).toHaveText([session.task!.title, "Session", "Alice", "Running", "Distinct"]);
  await expect(page.getByRole("tabpanel", { name: "Voice" })).toContainText("A resident's reference name is set on its profile");
  await shoot(page.getByRole("tabpanel", { name: "Voice" }), "05-roster");

  // The agent asks a question: with the inbox naming rule on, its card names it Alice.
  await ask(daemon, session.cwd!);
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expect(inbox.locator("section.inbox-reviews .inbox-head strong")).toHaveText("Alice");
  await expect(inbox.locator("section.review .review-head .review-agent")).toHaveText("Alice");
  await shoot(inbox, "06-question-card-names-alice");

  // Voice off, with the inbox left open: the call sign is kept but names nothing, so the card
  // falls back to the task title the inbox naming rule printed before voice.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(inbox.locator("section.inbox-reviews .inbox-head strong")).toHaveText(session.task!.title);
  await expect(inbox.locator("section.review .review-head .review-agent")).toHaveText(session.task!.title);
  const kept = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)!;
  expect(kept.task?.callSign, "the call sign stays saved while voice is off").toBe("Alice");
  await shoot(inbox, "07-voice-off-names-task-title");
});

test("a warned call sign is dispatched as typed: the task keeps it and the roster lists it with its warnings", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await turnVoiceOn(daemon);
  const dialog = await openDispatch(page, daemon, "Check the build");
  const advanced = advancedOf(dialog);
  if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();

  // "Will" draws two warnings, and the dispatch goes ahead with it unchanged.
  await callSignOf(dialog).fill("Will");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "2");
  await expect(dialog.locator(".voice-meter-bad")).toHaveText("Everyday word");
  // The verdict is also in a polite status region, so a screen reader hears the warnings change.
  await expect(dialog.locator(".spoken-name-field").getByRole("status")).toHaveText("Everyday word, Very short");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const created = await posted;
  expect(created.ok(), await created.text()).toBe(true);
  expect(JSON.parse(created.request().postData() ?? "{}").callSign, "the warned name is sent as typed").toBe("Will");
  const task = (await created.json()) as Task;
  expect(task.callSign, "and saved as typed").toBe("Will");
  await expect(dialog).toBeHidden();

  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  expect(session.task?.callSign).toBe("Will");

  // The roster lists Will, running, with both warnings in its check.
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  const row = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Will", exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("cell")).toHaveText([session.task!.title, "Session", "Will", "Running", /Everyday word · Very short/]);
  await shoot(page.getByRole("tabpanel", { name: "Voice" }), "08-roster-warned-will");
});

test("a shelved task's call sign survives a restart, reads back in the editor, and the roster leaves it out until it launches", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await turnVoiceOn(daemon);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, intent: "Shelved with a name", title: "Named backlog task", kind: "ship",
    workflowId: null, backlog: true, callSign: "  Marlowe ",
  });
  expect(task.callSign).toBe("Marlowe");

  // It survives a daemon restart.
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await daemon.shutdown();
  await daemon.restart();
  // A reload, not a hash change, so the page reconnects to the restarted daemon on the Board layout.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();

  // A task in the backlog is not an agent yet: with Marlowe still saved, the roster leaves it out.
  // The built-in resident's row shows the roster has loaded, so the absence is not just early.
  await page.goto(`${daemon.baseURL}/#/settings/voice`);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  await expect(roster.getByRole("cell", { name: "Agent Shepherd", exact: true }).first()).toBeVisible();
  await expect(roster.getByRole("cell", { name: "Marlowe", exact: true })).toHaveCount(0);

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("main.board")).toBeVisible();
  await page.locator(".bl-card", { hasText: "Named backlog task" }).getByRole("button", { name: "Named backlog task", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(advancedOf(editor)).toContainText("Call sign: Marlowe");
  await advancedOf(editor).click();
  await expect(callSignOf(editor)).toHaveValue("Marlowe");
  await expect(meterOf(editor), "a task is never warned against its own name").toHaveAttribute("aria-valuenow", "4");

  // An edit typed while voice is on is not saved once voice goes off: the field is gone, so its
  // draft is not the operator's answer, and the stored call sign stays.
  await callSignOf(editor).fill("Atlas");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(callSignOf(editor)).toHaveCount(0);
  let sentUpdate = false;
  page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/tasks/${task.id}/update`) sentUpdate = true; });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(sentUpdate, "nothing else changed, so nothing is sent").toBe(false);
  expect((await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === task.id)?.callSign).toBe("Marlowe");

  await turnVoiceOn(daemon);
  await page.locator(".bl-card", { hasText: "Named backlog task" }).getByRole("button", { name: "Named backlog task", exact: true }).click();
  await expect(editor).toBeVisible();
  if ((await advancedOf(editor).getAttribute("aria-expanded")) !== "true") await advancedOf(editor).click();
  await expect(callSignOf(editor)).toHaveValue("Marlowe");

  // Cleared and saved: the update takes it off with null.
  await callSignOf(editor).fill("");
  const updated = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/tasks/${task.id}/update`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const response = await updated;
  expect(response.ok(), await response.text()).toBe(true);
  expect(JSON.parse(response.request().postData() ?? "{}")).toEqual({ callSign: null });
  expect(((await response.json()) as { task: Task }).task.callSign ?? null).toBeNull();
});
