import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The comment loop the Files tab exists for: comment on a sentence, the agent rewrites that
 * sentence and answers, and the person keeps iterating in the same thread.
 *
 * Two things used to break it, and only a browser against a real daemon sees both. The open
 * document never re-read the file, so the agent's edit stayed invisible until the reader left
 * the file and came back. And a follow-up in the thread was held rather than sent: the quote
 * had stopped resolving - because the agent's own edit replaced it - so the review paused on
 * "quotes text that is no longer in" the file, and the only way past was to drop the thread.
 *
 * The agent's edit is a write straight to disk, and its answer is the MCP reply route the
 * agent's tool posts to. No model tokens.
 */

const EVIDENCE = artifactsDir("file-comment-follow-up-after-edit");

async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-follow-up-after-edit/${name}.png`);
}

const TASK = "iterate on a spec";
const SOURCE = "docs/plans/spec.md";
const ORIGINAL = "The retry budget is thirty seconds.";
const FIRST_EDIT = "Retries stop at the deadline.";
const SECOND_EDIT = "Retries stop at the request deadline of ninety seconds.";
const file = (sentence: string): string =>
  ["# The spec", "", sentence, "", "The table below has no units column.", ""].join("\n");

const COMMENT = "Thirty seconds is not what the code does.";
const FOLLOW_UP = "Closer, but name the deadline.";
const SECOND_FOLLOW_UP = "Good. Say where the ninety comes from.";

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

async function openTheFile(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Iterate On A Spec/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: SOURCE })
    .click();
  // The gutter is where a comment is made by click, so the Editor is the surface here.
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
}

function storedThread(daemon: DaemonHandle): {
  short_id: string;
  status: string;
  outdated: number;
  delivered: number;
} | null {
  return withDaemonDb(daemon, (db) =>
    (db
      .prepare(
        `SELECT t.short_id, t.status, t.outdated,
                (SELECT COUNT(*) FROM file_comment_messages m
                  WHERE m.thread_id = t.id AND m.delivered_at IS NOT NULL) AS delivered
           FROM file_comment_threads t`,
      )
      .get() ?? null) as never);
}

function storedReview(daemon: DaemonHandle): { state: string; pause_reason: string | null } | null {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT state, pause_reason FROM file_comment_reviews`).get() ?? null) as never);
}

/** Answer a delivered turn the way the agent's MCP child does. See file-comment-walkthrough. */
async function answer(daemon: DaemonHandle, cwd: string, commentId: string, body: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/file-comments/replies`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, commentId, body }),
  });
  expect(res.status, `the reply channel accepted the answer: ${await res.clone().text()}`).toBe(200);
}

/** Every turn the fake agent received, off the transcript the daemon serves. */
async function receivedTurns(daemon: DaemonHandle): Promise<string[]> {
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { id: string }[];
  const id = sessions[0]!.id;
  const body = (await (await fetch(`${daemon.baseURL}/api/sessions/${id}/transcript`)).json()) as {
    messages?: { role: string; text: string }[];
  };
  return (body.messages ?? []).filter((m) => m.role === "user").map((m) => m.text);
}

async function reply(page: Page, body: string): Promise<void> {
  const thread = page.getByRole("region", { name: /^Comment MC-\w+ on line 3$/ });
  await expect(thread).toBeVisible();
  await thread.getByPlaceholder("Reply…").fill(body);
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(thread.locator(".file-comment-message.is-human").last()).toContainText(body);
}

test.describe("a comment thread on text the agent rewrote", () => {
  test("re-renders the edit in place and keeps taking follow-ups", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    const onDisk = join(cwd, SOURCE);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(onDisk, file(ORIGINAL));

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    const editor = page.getByLabel(`Editor for ${SOURCE}`);
    await expect(editor).toContainText(ORIGINAL);
    await page.getByRole("button", { name: "Comment mode" }).click();

    // ---- the comment goes to the agent ----
    await page
      .locator(".cm-lineNumbers .cm-gutterElement")
      .filter({ hasText: /^3$/ })
      .click();
    const box = page.getByRole("textbox", { name: "Comment on line 3" });
    await box.fill(COMMENT);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(box).toBeHidden();
    await expect
      .poll(() => storedThread(daemon)?.delivered, {
        message: "the comment never reached the agent",
        timeout: 20_000,
      })
      .toBe(1);
    const shortId = storedThread(daemon)!.short_id;

    // ---- the agent answers by rewriting the sentence the comment quotes ----
    writeFileSync(onDisk, file(FIRST_EDIT));
    await answer(daemon, cwd, `${shortId}.1`, "Rewrote it to describe the deadline.");

    // The open document follows the file: no leaving and coming back.
    await expect(editor, "the agent's edit re-rendered where the reader is looking")
      .toContainText(FIRST_EDIT, { timeout: 10_000 });
    await expect(editor).not.toContainText(ORIGINAL);

    // The thread is still on the line it was about, and says its quote has moved.
    const marker = page.getByRole("button", { name: /^Comment MC-\w+ on line 3, moved, 1 reply$/ });
    await expect(marker).toBeVisible();
    await marker.click();
    const thread = page.getByRole("region", { name: /^Comment MC-\w+ on line 3$/ });
    await expect(thread).toContainText("Rewrote it to describe the deadline.");
    await expect(thread).toContainText("the quoted text has moved");

    // ---- the follow-up goes, rather than being held ----
    await reply(page, FOLLOW_UP);
    await expect
      .poll(() => storedThread(daemon)?.delivered, {
        message: "the follow-up was held instead of delivered",
        timeout: 20_000,
      })
      .toBe(2);
    expect(storedThread(daemon)!.outdated, "the quote really does not resolve").toBe(1);
    expect(storedReview(daemon)?.state).not.toBe("paused");
    expect(storedReview(daemon)?.pause_reason ?? null).toBeNull();
    await expect(page.getByRole("alert").filter({ hasText: "no longer in" })).toHaveCount(0);
    await expect(thread.getByRole("alert")).toHaveCount(0);
    // The agent got the follow-up, told that the quote is the thread's original text.
    await expect
      .poll(async () => (await receivedTurns(daemon)).find((turn) => turn.includes(FOLLOW_UP)) ?? "")
      .toContain("The quoted text is no longer in the file");
    await shoot(page.locator(".file-main"), page, "follow-up-delivered");

    // ---- and the loop keeps going ----
    writeFileSync(onDisk, file(SECOND_EDIT));
    await answer(daemon, cwd, `${shortId}.2`, "Named the request deadline.");
    await expect(editor).toContainText(SECOND_EDIT, { timeout: 10_000 });
    await expect(thread).toContainText("Named the request deadline.");
    await reply(page, SECOND_FOLLOW_UP);
    await expect
      .poll(() => storedThread(daemon)?.delivered, {
        message: "the second follow-up was held instead of delivered",
        timeout: 20_000,
      })
      .toBe(3);
    expect(storedReview(daemon)?.state).not.toBe("paused");
    await shoot(page.locator(".file-main"), page, "second-follow-up-delivered");
  });

  test("keeps the open document through a failed re-check, then follows the next edit", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    const onDisk = join(cwd, SOURCE);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(onDisk, file(ORIGINAL));

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    const editor = page.getByLabel(`Editor for ${SOURCE}`);
    await expect(editor).toContainText(ORIGINAL);

    // The file is gone for a moment, as it is while an agent deletes and rewrites it. Wait for
    // a real re-check to come back refused, so what follows is measured after a failure rather
    // than before the first check ran.
    const refused = page.waitForResponse((response) =>
      /\/api\/sessions\/[^/]+\/file\?.*known=/.test(response.url()) && response.status() === 404);
    rmSync(onDisk);
    await refused;

    // The reader keeps what it was showing, with no error put over it.
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(ORIGINAL);
    await expect(page.locator(".file-notice")).toHaveCount(0);
    await shoot(page.locator(".file-main"), page, "failed-recheck-keeps-document");

    // The file comes back with the agent's edit, and the next check puts it on screen.
    writeFileSync(onDisk, file(FIRST_EDIT));
    await expect(editor, "a later successful check updated the reader")
      .toContainText(FIRST_EDIT, { timeout: 10_000 });
    await expect(editor).not.toContainText(ORIGINAL);
  });
});
