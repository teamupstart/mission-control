import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CDPSession, Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const TASK = "review a large commented file";
const SOURCE = "review-notes.md";
const COMMENT_COUNT = 80;
const PROFILE_COMMENT_COUNT = 160;
const PROFILE_ACTIVITY_EVENTS = 80;
const SOURCE_LINES = Array.from(
  { length: 1_200 },
  (_, index) => `Review line ${index + 1} has a unique performance note.`,
);
const TYPED = "Typing in Dispatch stays responsive while the comment index remains open. ".repeat(4);
const PROFILE_TYPED = "Dispatch input remains responsive during live session updates. ".repeat(8);
const LONG_COMMENT = [
  "Comment 1 deliberately uses a long multi-sentence preview.",
  "It must remain inside its virtual row even when this sentence wraps repeatedly.",
  "The neighboring comment must stay visually separate and fully usable.",
].join(" ").concat(" ").repeat(4).trim();
const EVIDENCE = artifactsDir("file-comment-dispatch-performance");
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.use({
  daemonEnv: process.env.MC_E2E_PROFILE_WEB_DIR
    ? { MISSION_WEB_DIR: process.env.MC_E2E_PROFILE_WEB_DIR }
    : {},
});

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  await repo.fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

interface ActiveSession {
  id: string;
  cwd: string;
  agent: string;
  agentSessionId: string;
}

async function activeSession(daemon: DaemonHandle): Promise<ActiveSession> {
  const read = async (): Promise<ActiveSession | null> => {
    const rows = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
      id: string;
      cwd: string | null;
      agent: string;
      agentSessionId: string | null;
      state: string;
    }>;
    const row = rows[0];
    return row?.cwd && row.agentSessionId && row.state === "idle"
      ? {
          id: row.id,
          cwd: row.cwd,
          agent: row.agent,
          agentSessionId: row.agentSessionId,
        }
      : null;
  };
  await expect.poll(read).not.toBeNull();
  return (await read())!;
}

async function createComments(
  daemon: DaemonHandle,
  sessionId: string,
  count = COMMENT_COUNT,
): Promise<void> {
  const document = await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/file?path=${SOURCE}`,
  );
  expect(document.ok).toBe(true);
  const revision = ((await document.json()) as { revision: string | null }).revision;
  for (let index = 0; index < count; index += 1) {
    const line = Math.floor(index * (SOURCE_LINES.length - 1) / count) + 1;
    const response = await fetch(
      `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/file-comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: SOURCE,
          startLine: line,
          endLine: line,
          quote: SOURCE_LINES[line - 1],
          revision,
          surface: "editor",
          body: index === 0
            ? LONG_COMMENT
            : `Comment ${index + 1} checks the responsiveness of this line.`,
        }),
      },
    );
    expect(response.ok, await response.text()).toBe(true);
  }
}

async function useConsoleLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
}

async function dropImage(target: Locator, name: string): Promise<void> {
  const dataTransfer = await target.page().evaluateHandle(
    ([encoded, fileName]) => {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
      return transfer;
    },
    [PNG, name] as const,
  );
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
}

async function shoot(page: Page, name = "dispatch-over-comments.png"): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-dispatch-performance/${name}`);
}

async function openCommentedFile(page: Page, count: number): Promise<Locator> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Review A Large Commented File/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: SOURCE })
    .click();
  await page.getByRole("button", { name: "Editor" }).click();
  const comments = page.getByRole("button", { name: "Comments", exact: true });
  await expect(comments).toHaveAttribute("aria-expanded", "false");
  await expect(comments).toContainText(`(${count})`);
  return comments;
}

async function emitActivityBurst(daemon: DaemonHandle, active: ActiveSession): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  for (let index = 0; index < PROFILE_ACTIVITY_EVENTS; index += 1) {
    // Repeated Stop hooks update lastActivity and emit the same session_upsert stream as a
    // settling agent without moving the session to another Console group. That isolates the
    // redraw cost under test from the separate cost of regrouping the rail.
    const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: active.agent,
        sessionId: active.agentSessionId,
        cwd: active.cwd,
        env: {},
        profileSequence: index,
      }),
    });
    expect(response.status, await response.text()).toBe(204);
  }
}

async function taskDurationMs(cdp: CDPSession): Promise<number> {
  const result = await cdp.send("Performance.getMetrics");
  const metric = result.metrics.find((candidate) => candidate.name === "TaskDuration");
  if (!metric) throw new Error("Chromium did not report TaskDuration");
  return metric.value * 1_000;
}

interface ProfileSample {
  taskDurationMs: number;
  typingMs: number;
  attachmentMs: number;
}

async function profileDispatch(
  page: Page,
  daemon: DaemonHandle,
  active: ActiveSession,
  cdp: CDPSession,
  sample: string,
): Promise<ProfileSample> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const intent = dialog.getByPlaceholder("What should this agent do?");
  await expect(intent).toBeFocused();
  await intent.fill("");
  await expect(intent).toHaveValue("");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const taskBefore = await taskDurationMs(cdp);
  const activity = emitActivityBurst(daemon, active);
  const typingStarted = performance.now();
  await intent.pressSequentially(PROFILE_TYPED);
  const typingMs = performance.now() - typingStarted;
  await expect(intent).toHaveValue(PROFILE_TYPED);

  const attachment = `${sample}.png`;
  const uploaded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/uploads"),
  );
  const attachmentStarted = performance.now();
  await dropImage(dialog.locator(".drop-zone"), attachment);
  expect((await uploaded).status()).toBe(200);
  const attachmentMs = performance.now() - attachmentStarted;
  await expect(dialog.getByRole("button", { name: `Remove ${attachment}` })).toBeVisible();

  await activity;
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  const taskDuration = await taskDurationMs(cdp) - taskBefore;
  await dialog.getByRole("button", { name: `Remove ${attachment}` }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return { taskDurationMs: taskDuration, typingMs, attachmentMs };
}

test("comment index stays usable while Dispatch types and attaches under session activity", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const active = await activeSession(daemon);
  writeFileSync(join(active.cwd, SOURCE), SOURCE_LINES.join("\n"));
  await createComments(daemon, active.id);
  await useConsoleLayout(page, daemon);

  const comments = await openCommentedFile(page, COMMENT_COUNT);
  await comments.click();
  const rail = page.getByRole("complementary", { name: `Comments on ${SOURCE}` });
  const list = rail.getByRole("list");
  const rows = list.getByRole("button");
  await expect(rail.getByText(`${COMMENT_COUNT} total`)).toBeVisible();
  expect(await rows.count()).toBeLessThan(30);

  // The production row preview is variable-length user content inside a fixed virtual slot.
  // Exercise an actually overflowing body and prove both the paint containment and geometry.
  const items = rail.locator(".file-comment-rail-item");
  const firstItem = items.nth(0);
  const secondItem = items.nth(1);
  const longPreview = firstItem.locator(".file-comment-rail-text");
  await expect(longPreview).toContainText("long multi-sentence preview");
  const [firstBox, secondBox, previewBox] = await Promise.all([
    firstItem.boundingBox(),
    secondItem.boundingBox(),
    longPreview.boundingBox(),
  ]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(firstBox!.y + firstBox!.height).toBeLessThanOrEqual(secondBox!.y);
  expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(firstBox!.y + firstBox!.height);
  await expect(firstItem).toHaveCSS("overflow", "hidden");
  await expect(longPreview).toHaveCSS("-webkit-line-clamp", "2");
  await expect(longPreview).toHaveCSS("overflow", "hidden");
  await shoot(page, "long-comment-contained.png");

  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  const intent = dialog.getByPlaceholder("What should this agent do?");
  await expect(intent).toBeFocused();

  // A real agent turn produces the session upserts that previously redrew CodeMirror and
  // every comment-index row underneath this controlled form. Run one while entering the
  // task and attaching a file, which is the operator-visible combination from the report.
  const backgroundActivity = fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(active.id)}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "background activity during dispatch", submit: true }),
    },
  );
  await intent.pressSequentially(TYPED);
  await expect(intent).toHaveValue(TYPED);

  const attachment = "dispatch-performance.png";
  const uploaded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/uploads"),
  );
  await dropImage(dialog.locator(".drop-zone"), attachment);
  expect((await uploaded).status()).toBe(200);
  await expect(dialog.getByRole("button", { name: `Remove ${attachment}` })).toBeVisible();
  await shoot(page);

  const activityResponse = await backgroundActivity;
  expect(activityResponse.ok, await activityResponse.text()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The DOM window stays bounded, but scrolling must materialize and navigate the last
  // durable thread normally rather than making performance depend on losing reachability.
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const last = list.getByRole("button", { name: /Comment 80 checks the responsiveness/ });
  await expect(last).toBeVisible();
  await last.click();
  await expect(last).toHaveAttribute("aria-current", "true");
});

test("comment index keeps renderer CPU and Dispatch responsiveness near the closed-rail baseline", async ({
  dashboard: page,
  daemon,
}) => {
  test.skip(
    process.env.MC_E2E_PROFILE !== "1",
    "run explicitly because browser performance assertions require an otherwise idle host",
  );
  await dispatch(page, daemon);
  const active = await activeSession(daemon);
  writeFileSync(join(active.cwd, SOURCE), SOURCE_LINES.join("\n"));
  await createComments(daemon, active.id, PROFILE_COMMENT_COUNT);
  await useConsoleLayout(page, daemon);
  await openCommentedFile(page, PROFILE_COMMENT_COUNT);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "timeTicks" });

  const closed = await profileDispatch(page, daemon, active, cdp, "comments-closed");
  // Reopen the same durable Files state before the comments-on sample so both measurements
  // begin with the identical tab, file, and editor surface.
  const comments = await openCommentedFile(page, PROFILE_COMMENT_COUNT);
  await comments.click();
  await expect(comments).toHaveAttribute("aria-expanded", "true");
  const rail = page.getByRole("complementary", { name: `Comments on ${SOURCE}` });
  await expect(rail.getByText(`${PROFILE_COMMENT_COUNT} total`)).toBeVisible();
  const renderedRows = await rail.getByRole("list").getByRole("button").count();
  if (process.env.MC_E2E_PROFILE_BASELINE === "1") {
    expect(renderedRows).toBe(PROFILE_COMMENT_COUNT);
  } else {
    expect(renderedRows).toBeLessThan(30);
  }
  const open = await profileDispatch(page, daemon, active, cdp, "comments-open");
  await cdp.detach();

  const result = {
    comments: PROFILE_COMMENT_COUNT,
    activityEvents: PROFILE_ACTIVITY_EVENTS,
    closed,
    open,
    ratios: {
      taskDuration: open.taskDurationMs / closed.taskDurationMs,
      typing: open.typingMs / closed.typingMs,
      attachment: open.attachmentMs / closed.attachmentMs,
    },
  };
  // This line is the retained measurement artifact. It reports renderer main-thread CPU,
  // not wall time, so host scheduling noise cannot manufacture or hide the redraw spike.
  // eslint-disable-next-line no-console
  console.log(`FILE_COMMENT_DISPATCH_PROFILE ${JSON.stringify(result)}`);

  expect(
    result.ratios.taskDuration,
    `opening comments used ${result.ratios.taskDuration.toFixed(2)}x renderer task CPU`,
  ).toBeLessThan(1.5);
  expect(
    result.ratios.typing,
    `opening comments made typing ${result.ratios.typing.toFixed(2)}x slower`,
  ).toBeLessThan(1.5);
  expect(
    result.ratios.attachment,
    `opening comments made attachment ${result.ratios.attachment.toFixed(2)}x slower`,
  ).toBeLessThan(1.5);
});
