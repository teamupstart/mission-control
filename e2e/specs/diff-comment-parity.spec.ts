import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Diff tab reads comments the way the Files tab does.
 *
 * `diff-line-comments.spec.ts` proves a diff row WRITES the Files tab's thread. This spec is the
 * reading half, and the four things a reader of a long diff could not do before:
 *
 *   - reach Comment, Comments and Open in Files from anywhere in the file, because the header
 *     no longer scrolls away with the rows;
 *   - see which changed files carry comments, from the list, and whether an answer is unread;
 *   - open a file's Comments index and read the agent's answer, including on a line the diff
 *     does not show, without leaving for the Files tab;
 *   - steer the session's review from the diff, through the same queue the Files tab has.
 *
 * And the Files tab's own list marks commented files the same way. The session is a real
 * dispatch into a real git worktree and the agent's answers go through the real reply route,
 * so no model tokens are spent: every agent binary is faked.
 */

const EVIDENCE = artifactsDir("diff-comment-parity");

async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/diff-comment-parity/${name}.png`);
}

const TASK = "read comments from the diff";
const README = ["# Demo repo", "", "The retry budget is thirty seconds.", ""].join("\n");
const README_COMMENT = "Make the budget a named constant.";
const README_ANSWER = "Done - RETRY_BUDGET_SECONDS now names it.";

/**
 * Committed to the base branch BEFORE dispatch, so the worktree starts with it and the diff
 * shows only the line the session changes. Line 80 is therefore a real line of the file that
 * no hunk includes - the case a thread written in the Files tab lands in.
 */
const NOTES_LINES = Array.from({ length: 120 }, (_, i) => `Note ${i + 1}: keep this line.`);
const NOTES_LINE = 80;
const NOTES_QUOTE = NOTES_LINES[NOTES_LINE - 1]!;
const NOTES_COMMENT = "Is this note still true after the retry change?";
const NOTES_ANSWER = "Yes - the retry change never touched it.";
const NOTES_REPLY = "Thanks, resolving after the next run.";

/** A long, wholly new file: enough rows to scroll the header away if it were in the scroll. */
const LONG = Array.from({ length: 220 }, (_, i) => `export const step${String(i + 1).padStart(3, "0")} = ${i + 1};`);

function commitToBase(daemon: DaemonHandle): void {
  writeFileSync(join(daemon.repo, "notes.md"), `${NOTES_LINES.join("\n")}\n`);
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", daemon.repo, ...args], { stdio: "pipe" });
  };
  git("add", "notes.md");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "notes");
  git("push", "-q", "origin", "main");
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field; see diff-open-in-files.spec.ts.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The Diff and Files TABS live in the Console layout. See diff-open-in-files.spec.ts. */
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

async function theSession(daemon: DaemonHandle): Promise<{ id: string; cwd: string }> {
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        cwd: string | null;
      }[];
      return sessions[0]?.cwd ?? null;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    id: string;
    cwd: string;
  }[];
  return sessions[0]!;
}

async function openDiff(page: Page): Promise<Locator> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Read Comments From The Diff/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Diff$/ })
    .click();
  const diff = page.getByRole("region", { name: "Session diff" });
  await expect(diff).toBeVisible();
  return diff;
}

function changedFile(diff: Locator, path: string): Locator {
  return diff
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: new RegExp(path.replace(".", "\\.")) });
}

async function select(diff: Locator, path: string): Promise<void> {
  const row = changedFile(diff, path);
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
}

function storedThreads(daemon: DaemonHandle): {
  id: string;
  short_id: string;
  path: string;
  start_line: number;
  status: string;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(`SELECT id, short_id, path, start_line, status FROM file_comment_threads ORDER BY created_at`)
      .all() as never);
}

function threadOn(daemon: DaemonHandle, path: string): { id: string; short_id: string; status: string } {
  const row = storedThreads(daemon).find((thread) => thread.path === path);
  expect(row, `no thread was stored on ${path}`).toBeTruthy();
  return row!;
}

function messagesOn(daemon: DaemonHandle, threadId: string): { author: string; body: string }[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(`SELECT author, body FROM file_comment_messages WHERE thread_id = ? ORDER BY created_at`)
      .all(threadId) as never);
}

/**
 * A comment written in the Files tab on a line the diff does not show, through the routes the
 * Files tab's composer uses: create the thread at the line's current revision, then queue it.
 */
async function commentInFilesOnNotes(daemon: DaemonHandle, sessionId: string): Promise<void> {
  const session = encodeURIComponent(sessionId);
  const file = (await (await fetch(
    `${daemon.baseURL}/api/sessions/${session}/file?path=${encodeURIComponent("notes.md")}`,
  )).json()) as { revision?: string };
  expect(file.revision, "the daemon reported no revision for notes.md").toBeTruthy();
  const created = await fetch(`${daemon.baseURL}/api/sessions/${session}/file-comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "notes.md",
      startLine: NOTES_LINE,
      endLine: NOTES_LINE,
      quote: NOTES_QUOTE,
      revision: file.revision,
      surface: "editor",
      body: NOTES_COMMENT,
    }),
  });
  expect(created.status, `the thread was created: ${await created.clone().text()}`).toBe(200);
  const { thread } = (await created.json()) as { thread: { id: string } };
  const queued = await fetch(`${daemon.baseURL}/api/file-comments/${encodeURIComponent(thread.id)}/queue`, {
    method: "POST",
  });
  expect(queued.status, `the thread was queued: ${await queued.clone().text()}`).toBe(200);
}

/**
 * Answer the comment out with the agent, the way its MCP child does. See the walkthrough spec:
 * the reply channel IS this HTTP route, so going through it spends no model tokens.
 */
async function answer(daemon: DaemonHandle, cwd: string, commentId: string, body: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/file-comments/replies`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, commentId, body }),
  });
  expect(res.status, `the reply channel accepted the answer: ${await res.clone().text()}`).toBe(200);
}

const OUT = ["sending", "awaiting"];

test("the diff reads, lists and answers comments the way the Files tab does", async ({
  dashboard: page,
  daemon,
}) => {
  commitToBase(daemon);
  await dispatch(page, daemon);
  const session = await theSession(daemon);
  writeFileSync(join(session.cwd, "README.md"), README);
  const notes = [...NOTES_LINES];
  notes[1] = "Note 2: the retry budget moved to RETRY_BUDGET_SECONDS.";
  writeFileSync(join(session.cwd, "notes.md"), `${notes.join("\n")}\n`);
  writeFileSync(join(session.cwd, "long.ts"), `${LONG.join("\n")}\n`);
  await useConsoleLayout(page, daemon);

  const diff = await openDiff(page);
  await select(diff, "README.md");
  for (const path of ["README.md", "notes.md", "long.ts"]) {
    await expect(changedFile(diff, path).getByRole("img"), `${path} carries no comment yet`).toHaveCount(0);
  }

  // ---- a comment written in the diff marks its file in the list ----
  await page.keyboard.press("m");
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 3" }).fill(README_COMMENT);
  await diff.getByRole("button", { name: "Send", exact: true }).click();
  await expect(diff.getByRole("textbox", { name: "Comment on line 3" })).toBeHidden();
  await expect(changedFile(diff, "README.md").getByRole("img", { name: "1 comment" })).toBeVisible();
  await expect(changedFile(diff, "long.ts").getByRole("img")).toHaveCount(0);
  await expect
    .poll(() => threadOn(daemon, "README.md").status, { message: "the comment never went out" })
    .toMatch(/^(sending|awaiting)$/);
  const readme = threadOn(daemon, "README.md");

  // A comment written in the Files tab on a line no hunk includes. It waits behind the first.
  await commentInFilesOnNotes(daemon, session.id);
  await expect
    .poll(() => threadOn(daemon, "notes.md").status, { message: "the notes comment never queued" })
    .toBe("queued");
  const noted = threadOn(daemon, "notes.md");
  await expect(changedFile(diff, "notes.md").getByRole("img", { name: "1 comment" })).toBeVisible();
  await shoot(diff, page, "01-list-marks-commented-files");

  // ---- the review queue is reachable from the diff, and opens a comment in its file ----
  const reviewToggle = diff.getByRole("button", { name: "Review queue" });
  await expect(reviewToggle).toHaveText(/Review \(2\)/);
  await reviewToggle.click();
  const queue = diff.getByRole("region", { name: "Review queue" });
  await expect(queue).toBeVisible();
  await queue
    .getByRole("button", { name: `Open comment ${noted.short_id} on notes.md line ${NOTES_LINE}` })
    .click();
  // The queue moves the diff to the comment's file, and the thread opens there - docked above
  // the rows, because line 80 is not one of them.
  await expect(changedFile(diff, "notes.md")).toHaveAttribute("aria-current", "true");
  await expect(diff.getByText(`Line ${NOTES_LINE} is not part of this diff.`)).toBeVisible();
  const notesThread = diff.getByRole("region", {
    name: new RegExp(`^Comment ${noted.short_id} on line ${NOTES_LINE}$`),
  });
  await expect(notesThread).toContainText(NOTES_COMMENT);
  await expect(page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Diff$/ }))
    .toHaveAttribute("aria-selected", "true");
  await reviewToggle.click();
  await expect(queue).toBeHidden();

  // ---- the agent answers both; the open thread shows its answer where it is ----
  await answer(daemon, session.cwd, `${readme.short_id}.1`, README_ANSWER);
  await expect
    .poll(() => threadOn(daemon, "notes.md").status, { message: "the answer never released the notes comment" })
    .toMatch(new RegExp(`^(${OUT.join("|")})$`));
  await answer(daemon, session.cwd, `${noted.short_id}.1`, NOTES_ANSWER);
  await expect(notesThread).toContainText(NOTES_ANSWER);
  // And it can be answered back from here, without the Files tab.
  await notesThread.getByPlaceholder("Reply…").fill(NOTES_REPLY);
  await notesThread.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(notesThread).toContainText(NOTES_REPLY);
  await expect
    .poll(() => messagesOn(daemon, noted.id).map((m) => m.author), { message: "the reply never landed" })
    .toEqual(["human", "agent", "human"]);
  await shoot(diff, page, "02-docked-thread-outside-the-diff");

  // README's answer has not been read, and its row says so in words as well as amber.
  await expect(
    changedFile(diff, "README.md").getByRole("img", { name: "1 comment, 1 unread reply" }),
  ).toBeVisible();

  // ---- the Comments index lists the file's threads and opens one where it is drawn ----
  await select(diff, "README.md");
  const commentsToggle = diff.getByRole("button", { name: "Comments", exact: true });
  await expect(commentsToggle).toHaveText("Comments (1)");
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "false");
  await commentsToggle.click();
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "true");
  const index = diff.getByRole("complementary", { name: "Comments on README.md" });
  await expect(index).toBeVisible();
  const indexRow = index.getByRole("button", { name: new RegExp(readme.short_id) });
  await expect(indexRow).toContainText("2 messages");
  await expect(indexRow).toContainText(README_ANSWER);
  await indexRow.click();
  const readmeThread = diff.getByRole("region", { name: new RegExp(`^Comment ${readme.short_id} on line 3$`) });
  await expect(readmeThread).toContainText(README_COMMENT);
  await expect(readmeThread).toContainText(README_ANSWER);
  await expect(readmeThread).toBeInViewport();
  // Under its own row this time, so nothing is docked.
  await expect(diff.getByText(/is not part of this diff\./)).toHaveCount(0);
  await expect(indexRow).toHaveAttribute("aria-current", "true");
  // Reading it is what clears the amber, here exactly as in the Files tab.
  await expect(changedFile(diff, "README.md").getByRole("img", { name: "1 comment" })).toBeVisible();
  await shoot(diff, page, "03-comments-index-in-the-diff");

  // The index follows the reader to another file, as comment mode does.
  await select(diff, "notes.md");
  await expect(diff.getByRole("complementary", { name: "Comments on notes.md" })).toBeVisible();

  // ---- the header stays where it is, however far down the file the reader goes ----
  await select(diff, "long.ts");
  await expect(diff.getByRole("complementary", { name: "Comments on long.ts" }))
    .toContainText("No threads on this file");
  const openInFiles = diff.getByRole("button", { name: "Open in Files" });
  const commentMode = diff.getByRole("button", { name: "Comment mode" });
  const first = diff.getByText(LONG[0]!, { exact: true });
  const last = diff.getByText(LONG.at(-1)!, { exact: true });
  await expect(first).toBeInViewport();
  await expect(last).not.toBeInViewport();
  const before = await openInFiles.boundingBox();
  await first.hover();
  await page.mouse.wheel(0, 20_000);
  await expect(last).toBeInViewport();
  await expect(first).not.toBeInViewport();
  await expect(openInFiles).toBeInViewport();
  await expect(commentMode).toBeInViewport();
  await expect(commentsToggle).toBeInViewport();
  const after = await openInFiles.boundingBox();
  expect(after?.y, "Open in Files did not move while the rows scrolled").toBe(before?.y);
  await shoot(diff, page, "04-header-pinned-at-the-bottom-of-a-long-file");
  // And still answers from down here.
  await commentMode.click();
  await expect(commentMode).toHaveAttribute("aria-pressed", "false");
  await commentMode.click();
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");

  // ---- the Files tab's list marks the same files the same way ----
  await openInFiles.click();
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  const list = page.getByRole("listbox", { name: "Session files" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: /^README\.md/ }).getByRole("img", { name: "1 comment" }))
    .toBeVisible();
  await expect(list.getByRole("option", { name: /^notes\.md/ }).getByRole("img", { name: "1 comment" }))
    .toBeVisible();
  await expect(list.getByRole("option", { name: /^long\.ts/ }).getByRole("img")).toHaveCount(0);
  await shoot(page.locator(".file-workspace"), page, "05-files-list-marks-commented-files");
});

test("a thread closed from the diff's index stays in it, and the list counts it as closed", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const session = await theSession(daemon);
  writeFileSync(join(session.cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiff(page);
  await select(diff, "README.md");
  await diff.getByRole("button", { name: "Comment mode" }).click();
  await diff.getByRole("button", { name: "Comment on line 1" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 1" }).fill("Title case?");
  await diff.getByRole("button", { name: "Send", exact: true }).click();
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 3" }).fill(README_COMMENT);
  await diff.getByRole("button", { name: "Send", exact: true }).click();
  await expect(changedFile(diff, "README.md").getByRole("img", { name: "2 comments" })).toBeVisible();

  // The second waits behind the first, so a person may close it at once.
  await expect
    .poll(() => storedThreads(daemon).find((t) => t.start_line === 3)?.status, {
      message: "the second comment never queued",
    })
    .toBe("queued");
  const queued = storedThreads(daemon).find((t) => t.start_line === 3)!;
  await diff.getByRole("button", { name: "Comments", exact: true }).click();
  const index = diff.getByRole("complementary", { name: "Comments on README.md" });
  await index.getByRole("button", { name: new RegExp(queued.short_id) }).click();
  await diff
    .getByRole("region", { name: new RegExp(`^Comment ${queued.short_id} on line 3$`) })
    .getByRole("button", { name: "Resolve" })
    .click();
  await expect(changedFile(diff, "README.md").getByRole("img", { name: "2 comments, 1 open" })).toBeVisible();
  // A resolved thread is still in the index - closing it never erases the way back to it.
  await expect(index.getByRole("button", { name: new RegExp(queued.short_id) })).toContainText("resolved");
});

function storedReviewState(daemon: DaemonHandle): string | null {
  return withDaemonDb(daemon, (db) =>
    ((db.prepare(`SELECT state FROM file_comment_reviews`).get() as { state: string } | undefined)?.state
      ?? null));
}

test("a queued comment on a file this diff does not hold opens that file in the Files tab", async ({
  dashboard: page,
  daemon,
}) => {
  // notes.md is in the base and the session never touches it, so the diff does not list it.
  commitToBase(daemon);
  await dispatch(page, daemon);
  const session = await theSession(daemon);
  writeFileSync(join(session.cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiff(page);
  await select(diff, "README.md");
  await expect(changedFile(diff, "notes.md")).toHaveCount(0);

  await diff.getByRole("button", { name: "Comment mode" }).click();
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 3" }).fill(README_COMMENT);
  await diff.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => threadOn(daemon, "README.md").status, { message: "the comment never went out" })
    .toMatch(/^(sending|awaiting)$/);

  // Paused from the diff's own queue, so the comment written next stays queued: nothing can go
  // out and take the Files tab to its file on its own. Whatever opens notes.md below is the
  // queue's request and nothing else.
  await diff.getByRole("button", { name: "Review queue" }).click();
  const queue = diff.getByRole("region", { name: "Review queue" });
  await queue.getByRole("button", { name: "Pause review" }).click();
  await expect.poll(() => storedReviewState(daemon), { message: "Pause never reached the daemon" })
    .toBe("paused");
  await commentInFilesOnNotes(daemon, session.id);
  // README's comment finishes - answered, or given up on after the settle window - so that no
  // comment at all is out with the agent when the queue is used.
  await expect
    .poll(() => threadOn(daemon, "README.md").status, {
      message: "the first comment was never released",
      timeout: 30_000,
    })
    .toMatch(/^(answered|unanswered)$/);
  expect(threadOn(daemon, "notes.md").status, "the pause held the notes comment back").toBe("queued");
  const noted = threadOn(daemon, "notes.md");

  await queue
    .getByRole("button", { name: `Open comment ${noted.short_id} on notes.md line ${NOTES_LINE}` })
    .click();

  // The diff has no row for it, so the Files tab - which holds every file - opens on it.
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  const files = page.getByRole("listbox", { name: "Session files" });
  await expect(files.getByRole("option", { name: /^notes\.md/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Preview of notes.md")).toBeVisible();
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveText("Comments (1)");
  // Still the requested file once its document has loaded, and still nothing out with the agent.
  await expect(files.getByRole("option", { selected: true })).toHaveCount(1);
  await expect(files.getByRole("option", { name: /^notes\.md/ })).toHaveAttribute("aria-selected", "true");
  expect(threadOn(daemon, "README.md").status).toMatch(/^(answered|unanswered)$/);
  expect(threadOn(daemon, "notes.md").status, "nothing went out to explain the move").toBe("queued");
  await shoot(page.locator(".file-workspace"), page, "06-queue-opens-absent-file-in-files");
});

test("the queue's file wins over the comment already out with the agent", async ({
  dashboard: page,
  daemon,
}) => {
  // README's comment is still out with the agent when the notes comment is opened from the
  // queue. The Files tab follows each comment as it goes OUT; one already out when the tab
  // opens must not take the reader off the file they asked for.
  commitToBase(daemon);
  await dispatch(page, daemon);
  const session = await theSession(daemon);
  writeFileSync(join(session.cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiff(page);
  await select(diff, "README.md");
  await diff.getByRole("button", { name: "Comment mode" }).click();
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 3" }).fill(README_COMMENT);
  await diff.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(() => threadOn(daemon, "README.md").status, { message: "the comment never went out" })
    .toMatch(/^(sending|awaiting)$/);

  // Paused, so the notes comment cannot go out itself - if it did, the Files tab would follow it
  // to notes.md and the right file would be selected for the wrong reason.
  await diff.getByRole("button", { name: "Review queue" }).click();
  const queue = diff.getByRole("region", { name: "Review queue" });
  await queue.getByRole("button", { name: "Pause review" }).click();
  await expect.poll(() => storedReviewState(daemon), { message: "Pause never reached the daemon" })
    .toBe("paused");
  await commentInFilesOnNotes(daemon, session.id);
  await expect
    .poll(() => threadOn(daemon, "notes.md").status, { message: "the notes comment never queued" })
    .toBe("queued");
  const noted = threadOn(daemon, "notes.md");

  const open = queue.getByRole("button", {
    name: `Open comment ${noted.short_id} on notes.md line ${NOTES_LINE}`,
  });
  await expect(open).toBeVisible();
  await open.click();
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  // Read at once, after the tab mounted: a comment only ever moves on from being out, so one
  // still out now was out - in the daemon and in the page - when the Files tab opened.
  expect(threadOn(daemon, "README.md").status, "README's comment was out as the Files tab opened")
    .toMatch(/^(sending|awaiting)$/);

  const files = page.getByRole("listbox", { name: "Session files" });
  await expect(page.getByLabel("Preview of notes.md")).toBeVisible();
  await expect(files.getByRole("option", { name: /^notes\.md/ })).toHaveAttribute("aria-selected", "true");
  await expect(files.getByRole("option", { name: /^README\.md/ })).toHaveAttribute("aria-selected", "false");
  expect(threadOn(daemon, "notes.md").status, "nothing else went out to explain the move").toBe("queued");
  await shoot(page.locator(".file-workspace"), page, "07-queue-file-wins-over-outstanding");
});

/** A queued comment on one line of notes.md, through the routes the Files composer uses. */
async function queueOnNotes(daemon: DaemonHandle, sessionId: string, line: number, revision: string): Promise<void> {
  const session = encodeURIComponent(sessionId);
  const created = await fetch(`${daemon.baseURL}/api/sessions/${session}/file-comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "notes.md",
      startLine: line,
      endLine: line,
      quote: NOTES_LINES[line - 1],
      revision,
      surface: "editor",
      body: `Check note ${line}.`,
    }),
  });
  expect(created.status, `the thread on line ${line} was created`).toBe(200);
  const { thread } = (await created.json()) as { thread: { id: string } };
  const queued = await fetch(`${daemon.baseURL}/api/file-comments/${encodeURIComponent(thread.id)}/queue`, {
    method: "POST",
  });
  expect(queued.status, `the thread on line ${line} was queued`).toBe(200);
}

test("a long review queue in the diff scrolls on its own and reaches its last comment", async ({
  dashboard: page,
  daemon,
}) => {
  commitToBase(daemon);
  await dispatch(page, daemon);
  const session = await theSession(daemon);
  const notes = [...NOTES_LINES];
  notes[1] = "Note 2: the retry budget moved to RETRY_BUDGET_SECONDS.";
  writeFileSync(join(session.cwd, "notes.md"), `${notes.join("\n")}\n`);
  const file = (await (await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(session.id)}/file?path=${encodeURIComponent("notes.md")}`,
  )).json()) as { revision: string };
  // Far more comments than the pane has room for.
  const LINES = Array.from({ length: 16 }, (_, i) => 60 + i);
  for (const line of LINES) await queueOnNotes(daemon, session.id, line, file.revision);
  await useConsoleLayout(page, daemon);

  const diff = await openDiff(page);
  await select(diff, "notes.md");
  await diff.getByRole("button", { name: "Review queue" }).click();
  const queue = diff.getByRole("region", { name: "Review queue" });
  await expect(queue).toBeVisible();
  // Held still, so the rows measured below are the rows still there: the first comment out
  // finishes, and every other one waits.
  await queue.getByRole("button", { name: "Pause review" }).click();
  await expect.poll(() => storedReviewState(daemon), { message: "Pause never reached the daemon" })
    .toBe("paused");
  await expect
    .poll(() => storedThreads(daemon).filter((t) => OUT.includes(t.status)).length, {
      message: "the comment out with the agent never finished",
      timeout: 30_000,
    })
    .toBe(0);
  const rows = queue.getByRole("list").getByRole("button", { name: /^Open comment / });
  await expect(rows.nth(LINES.length - 2)).toBeAttached();
  const openInFiles = diff.getByRole("button", { name: "Open in Files" });
  const header = [
    openInFiles,
    diff.getByRole("button", { name: "Comment mode" }),
    diff.getByRole("button", { name: "Comments", exact: true }),
  ];

  // The diff scrolled with the queue open: its rows move, and the header they scroll under stays.
  const firstLine = diff.getByText("Note 1: keep this line.", { exact: true });
  await firstLine.hover();
  await page.mouse.wheel(0, 2_000);
  await expect(firstLine).not.toBeInViewport();

  // The default window, and a short one - where 45% of the pane once left the list no room, and
  // a wrapped header once lost its second row, Open in Files, to the queue.
  for (const viewport of [null, { width: 1280, height: 560 }]) {
    if (viewport) await page.setViewportSize(viewport);
    const where = viewport ? `at ${viewport.height}px tall` : "at the default size";
    await expect(queue).toBeVisible();
    for (const control of header) {
      await expect(control, `the diff header keeps its controls on screen ${where}`).toBeInViewport({ ratio: 1 });
    }
    const pane = (await diff.boundingBox())!;
    const panel = (await queue.boundingBox())!;
    expect(panel.y + panel.height, `the queue ends inside the diff pane ${where}`)
      .toBeLessThanOrEqual(pane.y + pane.height + 1);
    const first = rows.first();
    const last = rows.last();
    await expect(first, `the first queued comment shows ${where}`).toBeInViewport();
    await expect(last).not.toBeInViewport();
    // By wheel, the way a reader gets there: a list with no scroll area of its own cannot move.
    await first.hover();
    await page.mouse.wheel(0, 5_000);
    await expect(last, `the last queued comment is reachable ${where}`).toBeInViewport();
    const row = (await last.boundingBox())!;
    expect(row.y + row.height, `the last comment is inside the pane ${where}`)
      .toBeLessThanOrEqual(pane.y + pane.height + 1);
    for (const control of header) await expect(control).toBeInViewport({ ratio: 1 });
    // Back to the top over the list itself, so the next size starts where a reader would.
    await last.hover();
    await page.mouse.wheel(0, -5_000);
    await expect(first).toBeInViewport();
    await shoot(diff, page, viewport ? "09-long-queue-short-window" : "08-long-queue-scrolls");
  }

  // Still at 560px with the queue open: Open in Files does what it says, on the selected file.
  await openInFiles.click();
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: /^notes\.md/ }),
  ).toHaveAttribute("aria-selected", "true");
});
