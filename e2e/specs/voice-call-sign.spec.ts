import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";
import { openVoiceTab } from "../fixtures/voice-settings.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { Session, Task } from "../../src/shared/types.ts";

// The suite dispatches fixture agents and files their questions through the MCP review route.

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

test("a call sign is chosen with a heard-as preview that warns without blocking, and is named beside the session's title only while voice is on", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 1200 });

  let dialog = await openDispatch(page, daemon, "Check the build");
  await advancedOf(dialog).click();
  await expect(dialog.getByRole("combobox", { name: "Persona", exact: true })).toBeVisible();
  await expect(callSignOf(dialog)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await turnVoiceOn(daemon);
  dialog = await openDispatch(page, daemon, "Check the build");
  const advanced = advancedOf(dialog);
  if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
  const field = callSignOf(dialog);
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Leave blank to get one automatically");
  await expect(dialog.getByText("Type a name to see how you would say it.")).toBeVisible();
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  for (const value of ["scout", "plan", "chat", "bugfix", "document", "ship"]) {
    await kind.selectOption(value);
    await expect(field, `${value} offers a call sign`).toBeVisible();
  }
  await expectContentClearsBorder(dialog);
  await shoot(dialog, "01-advanced-empty");

  await field.fill("Will");
  await expect(dialog.locator(".voice-heard")).toHaveText("Will, check the build");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "2");
  await expect(dialog.locator(".voice-meter-bad")).toHaveText("Everyday word");
  await expect(dialog.getByText("Sentences like “Will you grab the door?” start the same way. You can keep it; a rarer name is safer.")).toBeVisible();
  await expect(dialog.getByText("One short syllable is easy to miss or mishear. You can keep it; two syllables or more is safer.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await expect(dialog.getByText("Warning only", { exact: true })).toBeVisible();
  await shoot(dialog, "02-warning-everyday-word");

  await field.fill("!!!");
  await expect(dialog.locator(".voice-meter-bad")).toHaveText("Symbols only");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "3");
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await field.fill("サクラ Stop");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "4");

  await field.fill("Alice");
  await expect(dialog.locator(".voice-heard")).toHaveText("Alice, check the build");
  await expect(meterOf(dialog)).toHaveAttribute("aria-valuenow", "4");
  await expect(dialog.locator(".voice-meter-good")).toHaveText("Distinctive");
  await expect(dialog.locator(".voice-name-warning")).toHaveCount(0);
  await shoot(dialog, "03-distinctive");

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

  await openVoiceTab(page, "Names & routing", daemon.baseURL);
  const roster = page.getByRole("table", { name: "Agents that answer to a spoken name" });
  const row = roster.getByRole("row").filter({ has: page.getByRole("cell", { name: "Alice", exact: true }) });
  await expect(row).toHaveCount(1);
  // The Agent column is the task's title, which the daemon derives from the brief.
  await expect(row.getByRole("cell")).toHaveText([session.task!.title, "Session", "Alice", "Running", "Distinct"]);
  await expect(page.getByRole("tabpanel", { name: "Voice" })).toContainText("A resident's reference name is set on its profile");
  await shoot(page.getByRole("tabpanel", { name: "Voice" }), "05-roster");

  await ask(daemon, session.cwd!);
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  // The row header keeps the task's title and draws the quoted call sign beside it, in the board
  // card's badge; the card below leaves the name to that header.
  const head = inbox.locator("section.inbox-reviews .inbox-head");
  await expect(head.locator("strong")).toHaveText(session.task!.title);
  await expect(head.locator(".cs-mark.cs-badge")).toHaveText('Call sign "Alice"');
  await expect(inbox.locator("section.review .review-head .review-agent")).toHaveCount(0);
  await shoot(inbox, "06-question-card-names-alice");

  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(head.locator("strong")).toHaveText(session.task!.title);
  await expect(head.locator(".cs-mark")).toHaveCount(0);
  await expect(inbox.locator("section.review .review-head .review-agent")).toHaveCount(0);
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

  await openVoiceTab(page, "Names & routing", daemon.baseURL);
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

  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await daemon.shutdown();
  await daemon.restart();
  // A reload, not a hash change, so the page reconnects to the restarted daemon on the Board layout.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();

  // The built-in resident's row shows the roster has loaded, so the absence is not just early.
  await openVoiceTab(page, "Names & routing", daemon.baseURL);
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

  await callSignOf(editor).fill("");
  const updated = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/tasks/${task.id}/update`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const response = await updated;
  expect(response.ok(), await response.text()).toBe(true);
  expect(JSON.parse(response.request().postData() ?? "{}")).toEqual({ callSign: null });
  expect(((await response.json()) as { task: Task }).task.callSign ?? null).toBeNull();
});

test("a running resident's question card follows its renamed profile only with Voice on", async ({ dashboard: page, daemon }) => {
  await turnVoiceOn(daemon);
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Release Captain" },
    persona: { personaId: "builtin:code-risk-reviewer" },
    execution: { model: "claude-fable-5" },
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "spoken-rename" });
  const residentCwd = async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.kind === "resident")?.cwd;
  await expect.poll(residentCwd, { timeout: 60_000 }).toBeTruthy();
  await ask(daemon, (await residentCwd())!);
  await page.locator("button.pulse-seg", { hasText: "to answer" }).click();
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expectContentClearsBorder(inbox);
  const author = inbox.locator("section.inbox-reviews .inbox-head strong");
  await expect(author).toHaveText("Release Captain");
  await api(daemon, `/api/residents/profiles/${profile.id}`, {
    expectedRevision: profile.revision, settings: { ...profile.settings, identity: { ...profile.settings.identity, name: "Release Lead" } },
  }, "PATCH");
  await expect(author).toHaveText("Release Lead");
  await shoot(inbox, "09-running-resident-renamed");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(author).toHaveText("Release Captain");
});

test("a resident's question in the split inbox is named by its profile name in its board colour with its quoted reference name beside it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await turnVoiceOn(daemon);
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "inbox-split", enabled: true }, "PUT");
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Dependency Steward", referenceName: "Scout" },
    persona: { personaId: "builtin:code-risk-reviewer" },
    execution: { model: "claude-fable-5" },
    board: { colorId: "violet" },
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  expect(profile.settings.identity.referenceName).toBe("Scout");
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "scout-inbox" });
  const residentCwd = async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.kind === "resident")?.cwd;
  await expect.poll(residentCwd, { timeout: 60_000 }).toBeTruthy();
  await ask(daemon, (await residentCwd())!);

  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await page.locator("button.pulse-seg", { hasText: "to answer" }).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);

  // The list row: the profile name in the resident's colour, then the quoted reference name pill.
  const meta = inbox.getByRole("option").filter({ hasText: LINTER }).locator(".inbox-split-row-meta");
  await expect(meta.locator("strong.agent-name-resident")).toHaveText("Dependency Steward");
  await expect(meta.locator("strong.agent-name-resident")).toHaveAttribute("style", /--resident:\s*var\(--resident-violet\)/);
  await expect(meta.locator(".cs-mark.cs-rail")).toHaveText('Call sign "Scout"');

  // The pane header: the same, in the board card's badge, with no name repeated on the card.
  await inbox.getByRole("option").filter({ hasText: LINTER }).click();
  const head = inbox.getByRole("region", { name: "Selected item" }).locator("section.inbox-reviews .inbox-head");
  const name = head.locator("strong");
  await expect(name).toHaveText("Dependency Steward");
  await expect(name).toHaveClass(/agent-name-resident/);
  // Drawn in the violet the profile chose, not inherited from the header around it.
  expect(await name.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--resident-violet)";
    el.parentElement!.appendChild(probe);
    const violet = getComputedStyle(probe).color;
    probe.remove();
    return violet !== getComputedStyle(el.parentElement!).color && getComputedStyle(el).color === violet;
  })).toBe(true);
  const badge = head.locator(".cs-mark.cs-badge");
  await expect(badge).toHaveText('Call sign "Scout"');
  // Adjacent: the badge is the element right after the name.
  expect(await name.evaluate((el) => el.nextElementSibling?.classList.contains("cs-badge"))).toBe(true);
  await expect(inbox.locator("section.review .review-head .review-agent")).toHaveCount(0);
  await shoot(inbox, "13-split-inbox-resident-reference-name");

  // Voice off: the profile name alone, still in its colour, with no pill.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(inbox.locator(".cs-mark")).toHaveCount(0);
  await expect(name).toHaveText("Dependency Steward");
  await expect(name).toHaveClass(/agent-name-resident/);
});

test("the split inbox names a question's agent by its title with the quoted call sign beside it, in the list and the pane", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await turnVoiceOn(daemon);
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "inbox-split", enabled: true }, "PUT");
  // Long enough to be cut short in the list, which must never cut the call sign.
  const title = "Split the inbox question card header so the title and the call sign both show";
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: "split the header", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
    callSign: "Granite",
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  expect(session.task?.callSign).toBe("Granite");
  await ask(daemon, session.cwd!);

  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await page.locator("button.pulse-seg", { hasText: "to answer" }).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);

  const row = inbox.getByRole("option").filter({ hasText: LINTER });
  const meta = row.locator(".inbox-split-row-meta");
  await expect(meta.locator("strong")).toHaveText(title);
  const pill = meta.locator(".cs-mark.cs-rail");
  await expect(pill).toHaveText('Call sign "Granite"');
  // The title gives way, the pill does not: the pill sits wholly inside the row.
  const [rowBox, pillBox] = [await meta.boundingBox(), await pill.boundingBox()];
  expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 0.5);
  expect(await meta.locator("strong").evaluate((el) => el.scrollWidth > el.clientWidth), "the long title is cut short").toBe(true);

  await row.click();
  const head = inbox.getByRole("region", { name: "Selected item" }).locator("section.inbox-reviews .inbox-head");
  await expect(head.locator("strong")).toHaveText(title);
  await expect(head.locator(".cs-mark.cs-badge")).toHaveText('Call sign "Granite"');
  await expect(inbox.locator("section.review .review-head .review-agent")).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: `Dismiss ${title} from the inbox` })).toBeVisible();
  await shoot(inbox, "10-split-inbox-title-and-call-sign");

  // Narrow: below 800 px the list and the pane stack. At 480 px the pane header still draws the
  // badge inside the card, and back in the list the title gives way while the pill stays whole.
  await page.setViewportSize({ width: 480, height: 1000 });
  await expect(head.locator(".cs-mark.cs-badge")).toBeVisible();
  const [headBox, badgeBox] = [await head.boundingBox(), await head.locator(".cs-mark.cs-badge").boundingBox()];
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(headBox!.x + headBox!.width + 0.5);
  await shoot(inbox, "11-split-inbox-narrow-pane");
  await inbox.getByRole("button", { name: "‹ Inbox" }).click();
  await expect(pill).toBeVisible();
  const [narrowRow, narrowPill] = [await meta.boundingBox(), await pill.boundingBox()];
  expect(narrowPill!.x + narrowPill!.width).toBeLessThanOrEqual(narrowRow!.x + narrowRow!.width + 0.5);
  expect(await meta.locator("strong").evaluate((el) => el.scrollWidth > el.clientWidth), "the title is cut short, not the pill").toBe(true);
  await shoot(inbox, "12-split-inbox-narrow-list");
  await page.setViewportSize({ width: 1280, height: 1000 });

  // Voice off: the title alone, with no pill, in the list and the pane.
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "voice", enabled: false }, "PUT");
  await expect(inbox.locator(".cs-mark")).toHaveCount(0);
  await expect(meta.locator("strong")).toHaveText(title);
  await expect(head.locator("strong")).toHaveText(title);
});
