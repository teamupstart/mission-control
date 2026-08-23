import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The walkthrough, driven: press Start review and watch exactly one comment reach a live
 * agent, with the queue still yours while it drains.
 *
 * Only a browser can say this. The state machine has its own unit file and proves every
 * branch against a fake port; the HTTP tests prove the routes answer. Neither can say that a
 * click on Start review turns into a row in `pending_turns` turns into a turn the agent
 * actually received turns into a queue on screen that still reorders - which is the whole
 * feature, and the only layer that closes that loop.
 *
 * No model tokens: `fake-agents.ts` redirects every agent binary, and what this asserts about
 * delivery is read out of `harness.db` and out of the fake's own conversation - so "the agent
 * got it" means the bytes, not the pixels.
 */

const EVIDENCE = artifactsDir("file-comment-walkthrough");

async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-walkthrough/${name}.png`);
}

const TASK = "walk a spec review";
const SOURCE = "docs/plans/spec.md";
const CONTENTS = [
  "# The spec",
  "",
  "The retry budget is thirty seconds.",
  "",
  "The table below has no units column.",
  "",
  "The diagram contradicts the paragraph above it.",
  "",
].join("\n");

const FIRST = "This number disagrees with the table.";
const SECOND = "Add a units column here.";
const THIRD = "Which of these two is right?";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field. See file-line-comments.spec.ts.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The Files TAB lives in the Console layout. See diff-open-in-files.spec.ts. */
async function useConsoleLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Console layout").toBe("console");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
}

async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        cwd: string | null;
      }[];
      return sessions[0]?.cwd ?? null;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string | null;
  }[];
  return sessions[0]!.cwd!;
}

async function openTheFile(page: Page, path: string = SOURCE): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Walk A Spec Review/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
  await openAnotherFile(page, path);
}

/** Select a file in the already-open Files tab. */
async function openAnotherFile(page: Page, path: string): Promise<void> {
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: path })
    .click();
  await expect(page.getByLabel(`Preview of ${path}`)).toBeVisible();
}

function lineNumber(page: Page, line: number): Locator {
  return page
    .locator(".cm-lineNumbers .cm-gutterElement")
    .filter({ hasText: new RegExp(`^${line}$`) });
}

/** Write one comment on one line and submit it into the review. */
async function comment(page: Page, line: number, body: string): Promise<void> {
  await lineNumber(page, line).click();
  const box = page.getByRole("textbox", { name: `Comment on line ${line}` });
  await expect(box).toBeVisible();
  await box.fill(body);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(box).toBeHidden();
}

/** Every thread, in the daemon's own queue order. */
function storedQueue(daemon: DaemonHandle): {
  short_id: string;
  start_line: number;
  status: string;
  queue_seq: number | null;
  outdated: number;
  delivered: number;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.short_id, t.start_line, t.status, t.queue_seq, t.outdated,
                (SELECT COUNT(*) FROM file_comment_messages m
                  WHERE m.thread_id = t.id AND m.delivered_at IS NOT NULL) AS delivered
           FROM file_comment_threads t
          ORDER BY COALESCE(t.queue_seq, 9999), t.created_at`,
      )
      .all() as never);
}

/** The review's own run state, which is a row and not a derived value. */
function storedReview(daemon: DaemonHandle): { state: string; pause_reason: string | null } | null {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT state, pause_reason FROM file_comment_reviews`).get() ?? null) as never);
}

/** How many turns are sitting in the daemon's human outbox for this session. */
function outboxDepth(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM pending_turns`).get() as { n: number }).n);
}

test.describe("the review walkthrough", () => {
  test("Start review sends exactly one comment, and the queue stays steerable", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Comment mode" }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();

    // ---- three comments, in the order they were written ----
    await comment(page, 3, FIRST);
    await comment(page, 5, SECOND);
    await comment(page, 7, THIRD);
    await expect
      .poll(() => storedQueue(daemon).map((row) => row.start_line), {
        message: "the three comments never reached the queue",
      })
      .toEqual([3, 5, 7]);

    // ---- the queue, and its depth ----
    const queueToggle = page.getByRole("button", { name: "Review queue" });
    await expect(queueToggle).toHaveText(/Review \(3\)/);
    await queueToggle.click();
    const queue = page.getByRole("region", { name: "Review queue" });
    await expect(queue).toBeVisible();
    await expect(queue).toContainText("3 of 3 waiting");
    // The live region says what a sighted reader reads off the list.
    await expect(queue.getByRole("status")).toContainText("Review not started. 3 comments waiting.");
    await shoot(page.locator(".file-main"), page, "queue-before-start");

    // ---- reorder BEFORE it starts: the third comment goes first ----
    await queue.getByRole("button", { name: /^Move comment MC-\w+ earlier$/ }).nth(2).click();
    await expect
      .poll(() => storedQueue(daemon).map((row) => row.start_line), {
        message: "the reorder never reached the daemon",
      })
      .toEqual([3, 7, 5]);

    // ---- and the head goes, exactly once ----
    await queue.getByRole("button", { name: "Start review" }).click();

    await expect
      .poll(() => storedQueue(daemon).filter((row) => row.status !== "queued").length, {
        message: "Start review delivered nothing",
        timeout: 20_000,
      })
      .toBe(1);
    // The whole guarantee, in one assertion: two comments are still queued while one is out.
    const started = storedQueue(daemon);
    expect(started[0]!.start_line, "the first comment is the one in flight").toBe(3);
    expect(started.slice(1).map((row) => row.status)).toEqual(["queued", "queued"]);
    // And the outbox is never asked to hold more than the one turn. Depth one is what keeps
    // tail-only recall, head-of-line blocking and the missing correlation id from mattering.
    expect(outboxDepth(daemon)).toBeLessThanOrEqual(1);

    // The agent really received it - the fake echoes what it was sent, so this is the bytes
    // and not the pixels.
    await expect
      .poll(() => storedQueue(daemon)[0]?.delivered, {
        message: "the comment never reached the agent",
        timeout: 20_000,
      })
      .toBe(1);
    await expect(page.getByRole("region", { name: "Review queue" }).getByRole("status"))
      .toContainText(/is out with the agent/);
    // The head row still shows the sentence it sent, not the line it was written about. It
    // stopped doing that once delivery was confirmed, which is precisely when a reader is
    // looking at it.
    await expect(queue.locator(".file-review-item").first()).toContainText(FIRST);
    await shoot(page.locator(".file-main"), page, "queue-running");

    // ---- the one in flight offers none of the three controls, and the queued ones do ----
    const head = queue.locator(".file-review-item").first();
    await expect(head.getByRole("button", { name: /^Drop comment MC-/ })).toBeDisabled();
    await expect(head.getByRole("button", { name: /^Edit comment MC-/ })).toBeDisabled();
    await expect(head.getByRole("button", { name: /^Move comment MC-\w+ later$/ })).toBeDisabled();
    const next = queue.locator(".file-review-item").nth(1);
    await expect(next.getByRole("button", { name: /^Drop comment MC-/ })).toBeEnabled();

    // ---- rewrite an unsent one, mid-review ----
    await next.getByRole("button", { name: /^Edit comment MC-/ }).click();
    const editor = next.getByRole("textbox");
    await expect(editor).toHaveValue(THIRD);
    await editor.fill("Actually: say which of the two is right.");
    await next.getByRole("button", { name: "Save" }).click();
    await expect
      .poll(
        () =>
          withDaemonDb(daemon, (db) =>
            (db
              .prepare(
                `SELECT m.body FROM file_comment_messages m
                   JOIN file_comment_threads t ON t.id = m.thread_id
                  WHERE t.start_line = 7`,
              )
              .get() as { body: string }).body),
        { message: "the mid-review edit never landed" },
      )
      .toBe("Actually: say which of the two is right.");

    // ---- and drop the last one ----
    await queue.locator(".file-review-item").nth(2).getByRole("button", { name: /^Drop comment MC-/ }).click();
    await expect
      .poll(() => storedQueue(daemon).length, { message: "the drop never landed" })
      .toBe(2);

    // ---- Pause holds the queue without recalling what already went ----
    await queue.getByRole("button", { name: "Pause review" }).click();
    await expect
      .poll(() => storedReview(daemon)?.state, { message: "the pause never reached the daemon" })
      .toBe("paused");
    const paused = storedQueue(daemon);
    expect(paused[0]!.delivered, "a pause does not take back what the agent has read").toBe(1);
    expect(paused[1]!.status, "and it releases nothing further").toBe("queued");
    await expect(queue.getByRole("button", { name: "Resume review" })).toBeVisible();
    await shoot(page.locator(".file-main"), page, "queue-paused");

    // ---- and the comment already out with the agent still finishes ----
    // Pause is a promise about that comment too, not only about the ones behind it. Frozen in
    // `awaiting`, a paused queue would go on presenting it as in flight long after the agent
    // had moved on - so this waits out the real advance window rather than mocking it.
    const outstandingId = paused[0]!.short_id;
    const headStatus = (): string | undefined =>
      storedQueue(daemon).find((row) => row.short_id === outstandingId)?.status;
    await expect
      .poll(headStatus, {
        message: "the outstanding comment never resolved after the pause",
        timeout: 30_000,
        intervals: [1_000],
      })
      .toBe("unanswered");
    // Resolving it is not resuming: the person's pause still stands and nothing else went.
    expect(storedReview(daemon)?.state).toBe("paused");
    expect(
      storedQueue(daemon).filter((row) => row.status === "queued").length,
      "a paused review still releases nothing",
    ).toBe(1);
    expect(outboxDepth(daemon)).toBe(0);
  });
  test("a review spanning two files takes the reader to the file each comment is in", async ({
    dashboard: page,
    daemon,
  }) => {
    // A review covers every file the session holds comments on, so the comment that just went
    // out is frequently not in the file being looked at. Producing a scroll request only when
    // the path already matched left the reader parked on the previous file with nothing to say
    // anything had happened.
    const OTHER = "docs/plans/other.md";
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);
    writeFileSync(join(cwd, OTHER), ["# The other file", "", "This one has its own problem.", ""].join("\n"));

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Comment mode" }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await comment(page, 3, FIRST);

    // A second comment, in a DIFFERENT file.
    await openAnotherFile(page, OTHER);
    await expect(page.getByLabel(`Editor for ${OTHER}`)).toBeVisible();
    await comment(page, 3, SECOND);

    // Back to the first file, which is where the reader is when the review starts.
    await openAnotherFile(page, SOURCE);
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();

    const queueToggle = page.getByRole("button", { name: "Review queue" });
    await expect(queueToggle).toHaveText(/Review \(2\)/);
    await queueToggle.click();
    const queue = page.getByRole("region", { name: "Review queue" });
    await queue.getByRole("button", { name: "Start review" }).click();

    // Comment one is in the file already open, so nothing moves.
    await expect
      .poll(() => storedQueue(daemon).filter((row) => row.status !== "queued").length, {
        message: "Start review delivered nothing",
        timeout: 20_000,
      })
      .toBe(1);
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();

    // Comment two is in the other file. When it goes out, the reader goes with it.
    // Counted rather than matched on the line, because both comments sit on line 3 - which is
    // the point: only the FILE distinguishes them, and the file is what is under test.
    await expect
      .poll(() => storedQueue(daemon).filter((row) => row.status !== "queued").length, {
        message: "the second comment never went out",
        timeout: 30_000,
      })
      .toBe(2);
    await expect(page.getByLabel(`Editor for ${OTHER}`)).toBeVisible({ timeout: 30_000 });
    // And the comment it moved us to is the one that is actually out with the agent.
    await expect(queue.getByRole("status")).toContainText(OTHER);
  });
});
