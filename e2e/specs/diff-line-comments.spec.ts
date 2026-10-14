import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Line comments from the Diff tab: turn on comment mode while reading a diff, click a line
 * number, write a comment, and find it - as the same thread on the same line - in the Files
 * tab as well as in the diff.
 *
 * The Files tab's own experience is `file-line-comments.spec.ts`. What only this spec can say
 * is that the diff is a second door into the SAME model: the row it writes is the row the
 * Files editor draws, at the working-tree line the diff showed, and a thread written in either
 * tab is a marker in both. The session is a real dispatch into a real git worktree, so the
 * diff under test is one git produced. No model tokens: every agent binary is faked.
 */

const EVIDENCE = artifactsDir("diff-line-comments");

async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/diff-line-comments/${name}.png`);
}

const TASK = "comment on a diff line";
/**
 * `seedRepo` commits `# demo-repo` as the whole README. Rewriting the heading makes it a
 * DELETED row beside three added ones, so the spec can show that only working-tree lines take
 * a comment.
 */
const README = ["# Demo repo", "", "The retry budget is thirty seconds.", ""].join("\n");
const QUOTE = "The retry budget is thirty seconds.";
/** Typed key by key, and it carries `j`, `k` and `m` - the diff reader's own keys. */
const COMMENT = "Make the budget a named constant, just like the jitter knob. Hmm.";
const REPLY = "And mention it in the docs.";

/** A sent comment's marker, in whichever state delivery has reached. */
function sentMarker(line: number, id = "MC-\\w+"): RegExp {
  return new RegExp(`^Comment ${id} on line ${line}, (?:queued|sent|no answer)(?:, \\d+ repl(?:y|ies))?$`);
}

const SENT_STATUSES = ["queued", "sending", "awaiting", "unanswered"];

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

async function openDiffOn(page: Page, path: string): Promise<Locator> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Comment On A Diff Line/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Diff$/ })
    .click();
  const diff = page.getByRole("region", { name: "Session diff" });
  await expect(diff).toBeVisible();
  await diff
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: new RegExp(path.replace(".", "\\.")) })
    .click();
  return diff;
}

function storedThreads(daemon: DaemonHandle): {
  path: string;
  start_line: number;
  end_line: number;
  quote: string;
  surface: string;
  status: string;
  messages: number;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.path, t.start_line, t.end_line, t.quote, t.surface, t.status,
                (SELECT COUNT(*) FROM file_comment_messages m WHERE m.thread_id = t.id) AS messages
           FROM file_comment_threads t
          ORDER BY t.created_at`,
      )
      .all() as never);
}

test("a comment written on a diff line is the Files tab's thread on that line", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  writeFileSync(join(cwd, "README.md"), README);
  // A binary next to it: a changed file with no lines to point at.
  writeFileSync(join(cwd, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
  await useConsoleLayout(page, daemon);

  const diff = await openDiffOn(page, "README.md");
  const changed = diff.getByRole("navigation", { name: "Changed files" });
  await expect(changed.locator('[aria-current="true"]')).toContainText("README.md");

  const commentMode = diff.getByRole("button", { name: "Comment mode" });
  await expect(commentMode).toHaveAttribute("aria-pressed", "false");
  await expect(commentMode).toHaveAttribute("aria-keyshortcuts", "m");
  const lineButtons = diff.getByRole("button", { name: /^Comment on line \d+$/ });
  await expect(lineButtons).toHaveCount(0);
  await page.keyboard.press("m");
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");

  // Three working-tree lines and no button for the deleted heading: text that is gone has
  // no line in the file for a thread to anchor to.
  await expect(lineButtons).toHaveCount(3);
  await expect(diff.getByRole("button", { name: "Comment on line 1" })).toHaveText("1");

  await diff.getByRole("button", { name: "Comment on line 1" }).click();
  const scratch = diff.getByRole("textbox", { name: "Comment on line 1" });
  await scratch.fill("never mind");
  await expect
    .poll(() => storedThreads(daemon).length, { message: "the scratch draft was never saved" })
    .toBe(1);
  await scratch.press("Escape");
  await expect(scratch).toBeHidden();
  // The box that held focus is gone; the reader takes it back so its keys still answer.
  await expect(diff).toBeFocused();
  await expect
    .poll(() => storedThreads(daemon).length, { message: "cancelling left the draft behind" })
    .toBe(0);

  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  const box = diff.getByRole("textbox", { name: "Comment on line 3" });
  await expect(box).toBeFocused();
  // Key by key, because `fill()` presses nothing. The composer lives inside the diff reader,
  // whose `j`, `k` and `m` change the file and the mode: typed here they must only type.
  await box.pressSequentially(COMMENT);
  await expect(box).toHaveValue(COMMENT);
  await expect(changed.locator('[aria-current="true"]')).toContainText("README.md");
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => storedThreads(daemon).map((row) => row.status), {
      message: "the comment was never written as a draft row",
    })
    .toEqual(["draft"]);
  await shoot(diff, page, "diff-composer-on-line");

  await diff.getByRole("button", { name: "Send", exact: true }).click();
  const marker = diff.getByRole("button", { name: sentMarker(3) });
  await expect(marker).toBeVisible();
  await expect(box).toBeHidden();
  await expect(diff).toBeFocused();

  // The row is the Files tab's: the Files-relative path, the working-tree line the diff
  // showed, that line's text, and the editor surface.
  const [row] = storedThreads(daemon);
  expect(row?.path).toBe("README.md");
  expect(row?.start_line).toBe(3);
  expect(row?.end_line).toBe(3);
  expect(row?.quote).toBe(QUOTE);
  expect(row?.surface).toBe("editor");
  expect(SENT_STATUSES).toContain(row?.status);
  const shortId = /Comment (MC-\w+) on line 3/.exec((await marker.getAttribute("aria-label")) ?? "")?.[1];
  expect(shortId, "the marker names its thread").toBeTruthy();

  await marker.click();
  const thread = diff.getByRole("region", { name: new RegExp(`^Comment ${shortId} on line 3$`) });
  await expect(thread).toContainText(COMMENT);
  await thread.getByPlaceholder("Reply…").fill(REPLY);
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread).toContainText(REPLY);
  await expect
    .poll(() => storedThreads(daemon)[0]?.messages, { message: "the reply never reached the thread" })
    .toBe(2);
  await shoot(diff, page, "diff-thread-expanded");

  await changed.getByRole("button", { name: /logo\.bin/ }).click();
  await expect(commentMode).toHaveAttribute("aria-disabled", "true");
  await expect(commentMode).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("A binary file has no lines to comment on")).toBeAttached();
  await page.keyboard.press("m");
  await expect(commentMode).toHaveAttribute("aria-pressed", "false");
  await changed.getByRole("button", { name: /README\.md/ }).click();
  await expect(commentMode).toHaveAttribute("aria-pressed", "true");
  await expect(diff.getByRole("button", { name: sentMarker(3, shortId) })).toBeVisible();

  await page.reload();
  const reloaded = await openDiffOn(page, "README.md");
  await expect(reloaded.getByRole("button", { name: "Comment mode" }))
    .toHaveAttribute("aria-pressed", "false");
  await expect(reloaded.getByRole("button", { name: sentMarker(3, shortId) })).toBeVisible();

  await reloaded.getByRole("button", { name: "Open in Files" }).click();
  await expect(
    page.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByLabel("Editor for README.md")).toContainText(QUOTE);
  const inFiles = page.getByRole("button", { name: sentMarker(3, shortId) });
  await expect(inFiles).toBeVisible();
  await inFiles.click();
  const filesThread = page.getByRole("region", { name: new RegExp(`^Comment ${shortId} on line 3$`) });
  await expect(filesThread).toContainText(COMMENT);
  await expect(filesThread).toContainText(REPLY);
  expect(storedThreads(daemon)).toHaveLength(1);
  await shoot(page.locator(".file-main"), page, "files-same-thread");
});

async function sendFromDiff(diff: Locator, line: number, body: string): Promise<void> {
  await diff.getByRole("button", { name: `Comment on line ${line}` }).click();
  const box = diff.getByRole("textbox", { name: `Comment on line ${line}` });
  await box.fill(body);
  await diff.getByRole("button", { name: "Send", exact: true }).click();
  await expect(box).toBeHidden();
}

function storedOn(daemon: DaemonHandle, line: number): { status: string; messages: number } | undefined {
  return storedThreads(daemon).find((row) => row.start_line === line);
}

const REFUSED_REPLY = "the daemon refused this reply";
const REFUSED_STATUS = "this comment is already out with the agent; wait for a reply or the grace window";
const KEPT_REPLY = "Keep this sentence when the daemon says no.";

test("a diff thread resolves and reopens, and a refused action keeps the thread and its text", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  writeFileSync(join(cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiffOn(page, "README.md");
  await diff.getByRole("button", { name: "Comment mode" }).click();

  // Two comments. The first goes straight out to the agent and stays out for the settle
  // window, which holds the second in the queue behind it - and a queued comment, unlike one
  // out with the agent, is one a person may close. That is what lets this resolve at once
  // instead of waiting out the grace window.
  await sendFromDiff(diff, 1, "Is the new heading meant to be title case?");
  await sendFromDiff(diff, 3, COMMENT);
  await expect.poll(() => storedOn(daemon, 3)?.status, { message: "the second comment never queued" })
    .toBe("queued");
  const queuedMarker = diff.getByRole("button", { name: /^Comment MC-\w+ on line 3, queued$/ });
  const shortId = /Comment (MC-\w+) on line 3/.exec((await queuedMarker.getAttribute("aria-label")) ?? "")?.[1];
  expect(shortId, "the marker names its thread").toBeTruthy();
  const thread = diff.getByRole("region", { name: new RegExp(`^Comment ${shortId} on line 3$`) });

  await queuedMarker.click();
  await thread.getByRole("button", { name: "Resolve" }).click();
  // A closed thread stops being drawn, and its panel goes with its marker.
  await expect(thread).toBeHidden();
  await expect(diff.getByRole("button", { name: new RegExp(`^Comment ${shortId} on line 3,`) }))
    .toHaveCount(0);
  await expect.poll(() => storedOn(daemon, 3)?.status, { message: "Resolve did not close the thread" })
    .toBe("resolved");

  const showResolved = diff.getByRole("button", { name: "Show resolved comments" });
  await expect(showResolved).toHaveAttribute("aria-pressed", "false");
  await showResolved.click();
  await expect(showResolved).toHaveAttribute("aria-pressed", "true");
  const resolvedMarker = diff.getByRole("button", { name: `Comment ${shortId} on line 3, resolved` });
  await expect(resolvedMarker).toBeVisible();
  await resolvedMarker.click();
  await expect(thread.getByRole("button", { name: "Reopen" })).toBeVisible();

  // Hiding closed threads takes an open one's panel away with its marker, and showing them
  // again does not bring the panel back on its own.
  await showResolved.click();
  await expect(showResolved).toHaveAttribute("aria-pressed", "false");
  await expect(resolvedMarker).toHaveCount(0);
  await expect(thread).toBeHidden();
  await shoot(diff, page, "diff-resolved-hidden");
  await showResolved.click();
  await expect(resolvedMarker).toBeVisible();
  await expect(thread).toBeHidden();
  await resolvedMarker.click();
  await expect(thread.getByRole("button", { name: "Reopen" })).toBeVisible();

  await page.route("**/api/file-comments/*/messages", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: REFUSED_REPLY }),
    }));
  const replyBox = thread.getByPlaceholder("Reply…");
  await replyBox.fill(KEPT_REPLY);
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread.getByRole("alert")).toHaveText(REFUSED_REPLY);
  await expect(replyBox, "a refused reply must not take the reader's sentence with it")
    .toHaveValue(KEPT_REPLY);
  await expect(thread).toBeVisible();
  expect(storedOn(daemon, 3)?.messages, "nothing was appended").toBe(1);
  await page.unroute("**/api/file-comments/*/messages");

  await page.route("**/api/file-comments/*/status", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: REFUSED_STATUS }),
    }));
  await thread.getByRole("button", { name: "Reopen" }).click();
  await expect(thread.getByRole("alert")).toHaveText(REFUSED_STATUS);
  await expect(thread.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(replyBox).toHaveValue(KEPT_REPLY);
  expect(storedOn(daemon, 3)?.status).toBe("resolved");
  await shoot(diff, page, "diff-refused-action");
  await page.unroute("**/api/file-comments/*/status");

  await thread.getByRole("button", { name: "Reopen" }).click();
  await expect.poll(() => storedOn(daemon, 3)?.status, { message: "Reopen did not put it back in play" })
    .toBe("draft");
  await expect(thread.getByRole("alert")).toHaveCount(0);
  await expect(thread.getByRole("button", { name: "Resolve" })).toBeVisible();
  await expect(diff.getByRole("button", { name: `Comment ${shortId} on line 3, draft` })).toBeVisible();

  await page.route("**/api/file-comments/*/status", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: REFUSED_STATUS }),
    }));
  await thread.getByRole("button", { name: "Resolve" }).click();
  await expect(thread.getByRole("alert")).toHaveText(REFUSED_STATUS);
  await expect(thread).toBeVisible();
  await expect(thread.getByRole("button", { name: "Resolve" })).toBeVisible();
  await expect(replyBox).toHaveValue(KEPT_REPLY);
  expect(storedOn(daemon, 3)?.status).toBe("draft");
  await page.unroute("**/api/file-comments/*/status");
  await shoot(diff, page, "diff-reopened-thread");
});

async function currentRevision(daemon: DaemonHandle, path: string): Promise<string> {
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { id: string }[];
  const response = await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessions[0]!.id)}/file?path=${encodeURIComponent(path)}`,
  );
  const body = (await response.json()) as { revision?: string };
  expect(body.revision, `the daemon reported no revision for ${path}`).toBeTruthy();
  return body.revision!;
}

function storedAnchors(daemon: DaemonHandle): { start_line: number; quote: string; revision: string | null }[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(`SELECT start_line, quote, revision FROM file_comment_threads ORDER BY created_at`)
      .all() as never);
}

const CHANGED_LINE = "This line has changed since the diff loaded. Reload the diff to comment on what is there now.";

test("a click re-reads the file: an untouched line anchors to it, an edited one is refused", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  writeFileSync(join(cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiffOn(page, "README.md");
  await diff.getByRole("button", { name: "Comment mode" }).click();
  await expect(diff.getByRole("button", { name: "Comment on line 3" })).toBeVisible();
  const loaded = await currentRevision(daemon, "README.md");

  // The diff and its copy of the file still agree with each other, and line 3 still says what
  // it said. The comment must anchor to the file as it is now, not to the copy.
  writeFileSync(join(cwd, "README.md"), `${README}A trailing note the agent added.\n`);
  const moved = await currentRevision(daemon, "README.md");
  expect(moved).not.toBe(loaded);

  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  const box = diff.getByRole("textbox", { name: "Comment on line 3" });
  await box.fill("Still the line I meant.");
  await expect
    .poll(() => storedAnchors(daemon), { message: "the draft was not anchored to the re-read file" })
    .toEqual([{ start_line: 3, quote: QUOTE, revision: moved }]);
  await box.press("Escape");
  await expect.poll(() => storedThreads(daemon).length, { message: "cancelling left the draft behind" })
    .toBe(0);

  writeFileSync(join(cwd, "README.md"), README.replace("thirty", "sixty"));
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await expect(diff.getByText(CHANGED_LINE)).toBeVisible();
  await expect(diff.getByRole("textbox", { name: "Comment on line 3" })).toHaveCount(0);
  expect(storedThreads(daemon), "no comment was written against the old text").toHaveLength(0);
  // The re-read copy turns the changed line inert rather than inviting the same click again,
  // and lines the edit did not touch still take a comment.
  await expect(diff.getByRole("button", { name: "Comment on line 3" })).toHaveCount(0);
  await expect(diff.getByRole("button", { name: "Comment on line 1" })).toBeVisible();
  await shoot(diff, page, "diff-changed-line-refused");
});

test("a line re-read still in flight never opens a composer over a choice made since", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  writeFileSync(join(cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiffOn(page, "README.md");
  const commentMode = diff.getByRole("button", { name: "Comment mode" });
  await commentMode.click();
  await sendFromDiff(diff, 1, "Is the new heading meant to be title case?");
  const marker = diff.getByRole("button", { name: sentMarker(1) });
  await expect(marker).toBeVisible();

  // Hold the re-read a click starts, so the reader can change their mind while it is out.
  await page.route("**/api/sessions/*/file?*", async (route) => {
    if (route.request().url().includes("known=")) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await route.continue();
  });
  const box = diff.getByRole("textbox", { name: "Comment on line 3" });

  let reread = page.waitForResponse((response) => response.url().includes("known="));
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await marker.click();
  const thread = diff.getByRole("region", { name: /^Comment MC-\w+ on line 1$/ });
  await expect(thread).toBeVisible();
  await reread;
  // The answer has landed; give React the frame a stale composer would have opened in.
  await page.waitForTimeout(300);
  await expect(box).toHaveCount(0);
  await expect(thread).toBeVisible();

  await thread.getByRole("button", { name: "Collapse comment", exact: false }).click();
  await expect(thread).toBeHidden();
  reread = page.waitForResponse((response) => response.url().includes("known="));
  await diff.getByRole("button", { name: "Comment on line 3" }).click();
  await commentMode.click();
  await expect(commentMode).toHaveAttribute("aria-pressed", "false");
  await reread;
  await page.waitForTimeout(300);
  await expect(box).toHaveCount(0);
  expect(storedThreads(daemon), "only the comment on line 1 exists").toHaveLength(1);
  await page.unroute("**/api/sessions/*/file?*");
});

const REREAD_REFUSED = "the daemon could not read README.md";

test("a failed re-read starts no comment, says why, and the next click can succeed", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  writeFileSync(join(cwd, "README.md"), README);
  await useConsoleLayout(page, daemon);

  const diff = await openDiffOn(page, "README.md");
  await diff.getByRole("button", { name: "Comment mode" }).click();
  const lineButton = diff.getByRole("button", { name: "Comment on line 3" });
  await expect(lineButton).toBeVisible();

  // Only the re-read a click starts is refused - the one carrying the revision already held.
  // The first read, which drew the line buttons, has already succeeded.
  await page.route("**/api/sessions/*/file?*", (route) =>
    route.request().url().includes("known=")
      ? route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: REREAD_REFUSED }),
      })
      : route.continue());

  const box = diff.getByRole("textbox", { name: "Comment on line 3" });
  await lineButton.click();
  // A comment anchored to a read that did not happen would quote whatever the copy held, so
  // the click stops and says why rather than opening the box on the stale copy.
  await expect(diff.getByText(`This file could not be re-read, so no comment was started: ${REREAD_REFUSED}`))
    .toBeVisible();
  await expect(box).toHaveCount(0);
  expect(storedThreads(daemon), "nothing was written without a fresh read").toHaveLength(0);
  // The line stays clickable: nothing says it changed, only that it could not be checked.
  await expect(lineButton).toBeVisible();
  await shoot(diff, page, "diff-reread-failed");

  await page.unroute("**/api/sessions/*/file?*");
  await lineButton.click();
  await expect(box).toBeVisible();
  await expect(diff.getByText(/This file could not be re-read/)).toHaveCount(0);
});
