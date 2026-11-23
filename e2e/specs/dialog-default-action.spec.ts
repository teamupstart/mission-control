import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

async function capture(dialog: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir("dialog-default-action");
  mkdirSync(dir, { recursive: true });
  await dialog.screenshot({ path: join(dir, `${name}.png`) });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise dialog default actions");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  // Dispatch must work even with focus in the footer rather than the task field.
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Meta+Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

async function ask(daemon: DaemonHandle, body: Record<string, unknown>): Promise<string> {
  const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{ cwd: string }>;
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim(),
    },
    body: JSON.stringify({ env: {}, cwd: sessions[0]!.cwd, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { id: string }).id;
}

async function result(daemon: DaemonHandle, id: string) {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
    headers: { "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() },
  });
  expect(res.status).toBe(200);
  return await res.json() as { status: string; response: string; selections: unknown[] };
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Review request" });
  await expectContentClearsBorder(dialog);
  return dialog;
}

for (const modifier of ["Meta", "Control"]) {
  test(`${modifier}+Enter sends an open-ended request_input answer`, async ({ dashboard, daemon }) => {
    await dispatch(dashboard, daemon);
    const id = await ask(daemon, { kind: "input", title: "What retry budget?", body: "What retry budget?" });
    const dialog = await openReview(dashboard);
    const answer = dialog.getByPlaceholder("Your answer…");
    await answer.fill("Three retries");
    await answer.press("Enter");
    await expect(answer).toHaveValue("Three retries\n");
    await answer.press("Shift+Enter");
    await expect(answer).toHaveValue("Three retries\n\n");
    await capture(dialog, `${modifier.toLowerCase()}-answer-ready`);
    await answer.press(`${modifier}+Enter`);
    await expect(dialog).toBeHidden();
    expect(await result(daemon, id)).toMatchObject({ status: "answered", response: "Three retries" });
    await capture(dashboard.locator(".console-detail"), `${modifier.toLowerCase()}-answer-delivered`);
  });
}

for (const kind of ["plan", "diff"] as const) {
  test(`Cmd+Enter approves a ${kind} review with its trimmed note`, async ({ dashboard, daemon }) => {
    await dispatch(dashboard, daemon);
    const title = `Approve the ${kind} retry change`;
    const id = await ask(daemon, {
      kind,
      title,
      body: kind === "plan"
        ? "## Retry plan\n\nLimit retries to three attempts."
        : "diff --git a/retry.ts b/retry.ts\n--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-const retries = 5;\n+const retries = 3;\n",
    });
    const dialog = await openReview(dashboard);
    const note = "Keep the retry budget at three attempts.";
    await dialog.getByPlaceholder("Optional note to the agent…").fill(`  ${note}  `);
    // Approve remains the default even when another action in the review holds focus.
    await dialog.getByRole("button", { name: "Request changes" }).focus();
    await expect(dialog.getByRole("button", { name: "Approve" })).toBeEnabled();
    await capture(dialog, `${kind}-approval-ready`);
    await dashboard.keyboard.press("Meta+Enter");
    await expect(dialog).toBeHidden();
    expect(await result(daemon, id)).toMatchObject({ status: "approved", response: note });
    const entry = dashboard.locator(".console-detail .transcript-log .review-answer");
    await expect(entry).toContainText(title);
    await expect(entry).toContainText(note);
    await capture(dashboard.locator(".console-detail"), `${kind}-approval-delivered`);
  });
}

test("request_input choices respect completeness and submit once while busy", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, {
    kind: "input", title: "Choose a cache", body: "Choose a cache",
    decisions: [{ id: "q", question: "Choose a cache", options: [{ id: "disk", label: "On disk" }] }],
  });
  const dialog = await openReview(dashboard);
  const calls: unknown[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route("**/api/reviews/*/resolve", async (route) => {
    calls.push(route.request().postDataJSON());
    await hold;
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Close" }).focus();
  await dashboard.keyboard.press("Meta+Enter");
  await expect(dialog.getByRole("button", { name: /^Submit/ })).toBeDisabled();
  expect(calls).toHaveLength(0);
  await dialog.getByRole("radio", { name: "On disk" }).check();
  // IME candidate commits and key auto-repeat must not activate a ready action.
  await dialog.getByRole("radio", { name: "On disk" }).evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, isComposing: true, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, repeat: true, bubbles: true }));
  });
  expect(calls).toHaveLength(0);
  await dashboard.keyboard.press("Meta+Enter");
  await expect.poll(() => calls.length).toBe(1);
  await expect(dialog.getByRole("button", { name: /^Submit/ })).toBeDisabled();
  await dashboard.keyboard.press("Meta+Enter");
  expect(calls).toHaveLength(1);
  release();
  await expect(dialog).toBeHidden();
  expect(await result(daemon, id)).toMatchObject({ status: "answered", selections: [{ decisionId: "q", selected: ["disk"], other: null }] });
});

test("plan decisions submit the focused review and then the first remaining review", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const first = await ask(daemon, { kind: "input", title: "First question", body: "First question" });
  const plan = await ask(daemon, {
    kind: "plan-decisions", title: "Cache rollout", body: "## Plan\n\nRoll out the cache in stages.",
    decisions: [
      { id: "store", question: "Where?", options: [{ id: "disk", label: "On disk" }] },
      { id: "when", question: "When?", options: [{ id: "now", label: "Now" }] },
    ],
  });
  const dialog = await openReview(dashboard);
  await dialog.getByPlaceholder("Your answer…").fill("First answer");
  await dialog.getByRole("radio", { name: "On disk" }).check();
  await dashboard.keyboard.press("Meta+Enter");
  // The focused plan is incomplete. Do not fall through to the other enabled Send answer.
  await expect(dialog.getByText("2 pending")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Submit/ })).toBeDisabled();
  await dialog.getByRole("radio", { name: "Now" }).check();
  const note = dialog.getByRole("textbox", { name: "Note to the agent: When?" });
  await note.fill("Use a small canary first");
  await capture(dialog, "plan-decisions-ready");
  await note.press("Meta+Enter");
  await expect(dialog.getByText("1 pending")).toBeVisible();
  expect(await result(daemon, plan)).toMatchObject({ status: "answered", selections: [
    { decisionId: "store", selected: ["disk"], other: null },
    { decisionId: "when", selected: ["now"], other: null, note: "Use a small canary first" },
  ] });
  await dialog.getByRole("button", { name: "Close" }).focus();
  await dashboard.keyboard.press("Control+Enter");
  await expect(dialog).toBeHidden();
  expect(await result(daemon, first)).toMatchObject({ status: "answered", response: "First answer" });
  await capture(dashboard.locator(".console-detail"), "plan-decisions-delivered");
});

test("a different modal above a ready review owns Cmd+Enter", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, { kind: "input", title: "Question under feedback", body: "Question under feedback" });
  const review = await openReview(dashboard);
  await review.getByPlaceholder("Your answer…").fill("Keep this draft");
  // Simulate another dialog arriving while a review is open, through the existing opener.
  // The backdrop covers the topbar, so call its handler rather than clicking through it.
  await dashboard.getByRole("button", { name: "Report product feedback" }).evaluate((button: HTMLButtonElement) => button.click());
  const feedback = dashboard.getByRole("dialog", { name: "Report product feedback" });
  await expectContentClearsBorder(feedback);
  await feedback.getByRole("button", { name: "Close feedback form" }).focus();
  await dashboard.keyboard.press("Meta+Enter");
  await expect(feedback).toBeVisible();
  await capture(feedback, "top-dialog-blocks-covered-answer");
  await expect(review.getByPlaceholder("Your answer…")).toHaveValue("Keep this draft");
  await dashboard.keyboard.press("Escape");
  await expect(feedback).toBeHidden();
  await review.getByRole("button", { name: "Close" }).focus();
  await dashboard.keyboard.press("Meta+Enter");
  await expect(review).toBeHidden();
  expect(await result(daemon, id)).toMatchObject({ status: "answered", response: "Keep this draft" });
});

test("Cmd+Enter activates a native confirmation form from its Cancel control", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 45_000 });
  await row.click();
  await dashboard.locator(".console-detail").getByRole("button", { name: "Complete" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await capture(dialog, "native-confirmation-ready");
  await dashboard.keyboard.press("Meta+Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{ status: string }>;
    return tasks[0]?.status;
  }).toBe("done");
});

test("Cmd+Enter opens the active FilePicker choice instead of the first or focused choice", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{ cwd: string }>;
  writeFileSync(join(sessions[0]!.cwd, "shortcut-choice-a.txt"), "First file\n");
  writeFileSync(join(sessions[0]!.cwd, "shortcut-choice-b.txt"), "Second file\n");
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.keyboard.press("Shift+O");
  const picker = dashboard.getByRole("dialog", { name: /^Find a file/ });
  await expectContentClearsBorder(picker);
  await picker.getByRole("textbox", { name: "Search checkout files" }).fill("shortcut-choice");
  const first = picker.getByRole("option", { name: "shortcut-choice-a.txt" });
  const second = picker.getByRole("option", { name: "shortcut-choice-b.txt" });
  await expect(first).toHaveAttribute("aria-selected", "true");
  await dashboard.keyboard.press("ArrowDown");
  await expect(second).toHaveAttribute("aria-selected", "true");
  // Move focus off the search form so the shared overlay handler owns the chord. Focus
  // the first row deliberately: both first-row and focused-row shortcuts would be wrong.
  await first.focus();
  await expect(first).toHaveAttribute("aria-selected", "false");
  await capture(picker, "file-picker-second-choice-ready");
  await dashboard.keyboard.press("Meta+Enter");
  await expect(picker).toBeHidden();
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  await expect(files.getByRole("option", { name: "shortcut-choice-b.txt" })).toHaveAttribute("aria-selected", "true");
  await expect(files.getByRole("option", { name: "shortcut-choice-a.txt" })).toHaveAttribute("aria-selected", "false");
  await expect(dashboard.getByLabel("Editor for shortcut-choice-b.txt")).toContainText("Second file");
  await capture(dashboard.locator(".console-detail"), "file-picker-second-choice-opened");
});

test("Cmd+Enter respects Reset preview gating and resets the checkout once enabled", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 45_000 });
  await row.click();
  const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Array<{ id: string; cwd: string }>;
  const session = sessions[0]!;
  const discarded = join(session.cwd, "discard-on-shortcut-reset.md");
  writeFileSync(discarded, "Reset must discard this only after its preview is ready.\n");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route("**/reset/preview", async (route) => {
    await hold;
    await route.continue();
  });
  const resets: unknown[] = [];
  dashboard.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/sessions/${encodeURIComponent(session.id)}/reset`) {
      resets.push(request.postDataJSON());
    }
  });
  await dashboard.locator(".console-detail").getByRole("button", { name: /reset/ }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Reset session to origin" });
  await expectContentClearsBorder(dialog);
  try {
    await expect(dialog.getByText("Checking working tree against origin…")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Reset & clear" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    await dashboard.keyboard.press("Meta+Enter");
    await expect(dialog).toBeVisible();
    expect(resets).toHaveLength(0);
    expect(existsSync(discarded)).toBe(true);
    await capture(dialog, "reset-preview-blocks-shortcut");
  } finally {
    release();
  }
  await expect(dialog.getByRole("button", { name: "Reset & clear" })).toBeEnabled();
  await dashboard.keyboard.press("Meta+Enter");
  await expect(dialog).toBeHidden();
  expect(resets).toEqual([{ clear: true }]);
  expect(existsSync(discarded)).toBe(false);
  await capture(dashboard.locator(".console-detail"), "reset-shortcut-completed");
});
