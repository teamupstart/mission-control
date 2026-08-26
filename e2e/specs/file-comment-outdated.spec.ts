import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A comment whose quoted text is gone is HELD, not sent, and the pause says why.
 *
 * This is the promise the whole re-anchor pass exists to keep, and the one that cannot be
 * asserted anywhere else: the pure `reanchor()` tests prove the search, and the state machine
 * proves the decision, but only here does an edit to a real file on disk turn into the daemon
 * re-reading it, deciding, persisting the flag, and refusing to deliver.
 *
 * The edit here stands in for the agent's own. That is the case `plan.md` is actually about:
 * you queued twelve comments, the agent answered comment one by deleting the paragraph
 * comment two quotes, and delivering comment two would produce exactly the confused exchange
 * one-at-a-time exists to prevent.
 *
 * No model tokens; nothing here asks an agent for anything.
 */

const EVIDENCE = artifactsDir("file-comment-outdated");

async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-outdated/${name}.png`);
}

const TASK = "hold an outdated comment";
const SOURCE = "docs/plans/spec.md";
const CONTENTS = [
  "# The spec",
  "",
  "The retry budget is thirty seconds.",
  "",
  "The table below has no units column.",
  "",
].join("\n");
/** The agent's edit: the paragraph the FIRST comment quotes is gone; the second's survives. */
const REWRITTEN = [
  "# The spec",
  "",
  "Retries are bounded by the deadline, not by a fixed budget.",
  "",
  "The table below has no units column.",
  "",
].join("\n");

const FIRST = "Thirty seconds is not what the code does.";
const SECOND = "Add a units column here.";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

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
    .getByRole("button", { name: /Hold An Outdated Comment/i })
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
  await expect(page.getByLabel(`Preview of ${SOURCE}`)).toBeVisible();
  // A comment here is made by clicking a line number, which is the Editor's gutter. Comment
  // mode used to raise a read-only copy of it beside the preview; the panel docks over the
  // preview now, so the surface is chosen explicitly.
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
}

function lineNumber(page: Page, line: number): Locator {
  return page
    .locator(".cm-lineNumbers .cm-gutterElement")
    .filter({ hasText: new RegExp(`^${line}$`) });
}

async function comment(page: Page, line: number, body: string): Promise<void> {
  await lineNumber(page, line).click();
  const box = page.getByRole("textbox", { name: `Comment on line ${line}` });
  await expect(box).toBeVisible();
  await box.fill(body);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(box).toBeHidden();
}

function storedQueue(daemon: DaemonHandle): {
  short_id: string;
  start_line: number;
  status: string;
  outdated: number;
  delivered: number;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.short_id, t.start_line, t.status, t.outdated,
                (SELECT COUNT(*) FROM file_comment_messages m
                  WHERE m.thread_id = t.id AND m.delivered_at IS NOT NULL) AS delivered
           FROM file_comment_threads t
          ORDER BY COALESCE(t.queue_seq, 9999), t.created_at`,
      )
      .all() as never);
}

function storedReview(daemon: DaemonHandle): { state: string; pause_reason: string | null } | null {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT state, pause_reason FROM file_comment_reviews`).get() ?? null) as never);
}

test.describe("a comment whose text the agent deleted", () => {
  test("is held rather than sent, and the pause names it", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    const onDisk = join(cwd, SOURCE);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(onDisk, CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Comment mode" }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();

    await comment(page, 3, FIRST);
    await comment(page, 5, SECOND);
    await expect
      .poll(() => storedQueue(daemon).map((row) => row.start_line), {
        message: "the two comments never reached the queue",
      })
      .toEqual([3, 5]);

    // ---- the edit that removes what the head comment quotes ----
    //
    // Straight to disk, standing in for the agent's own write. The daemon re-reads the file
    // itself on the way to each send, which is exactly what is being measured: nothing in the
    // browser has to have noticed.
    writeFileSync(onDisk, REWRITTEN);

    await page.getByRole("button", { name: "Review queue" }).click();
    const queue = page.getByRole("region", { name: "Review queue" });
    await queue.getByRole("button", { name: "Start review" }).click();

    // ---- held, not sent ----
    await expect
      .poll(() => storedReview(daemon)?.state, {
        message: "the review never settled after Start",
        timeout: 20_000,
      })
      .toBe("paused");
    const held = storedQueue(daemon);
    expect(held[0]!.status, "a comment quoting deleted text is not delivered").toBe("queued");
    expect(held[0]!.delivered, "and nothing reached the agent").toBe(0);
    // The outcome was PERSISTED, not merely computed: `reanchor()` is pure, and a re-anchor
    // pass that did not write would recompute from the original anchor on every send.
    expect(held[0]!.outdated).toBe(1);
    // The second comment's quote survived the edit, so it is untouched and still waiting.
    expect(held[1]!.outdated).toBe(0);
    expect(held[1]!.status).toBe("queued");

    // ---- and the pause says which comment, and why ----
    const reason = storedReview(daemon)!.pause_reason ?? "";
    expect(reason).toContain(held[0]!.short_id);
    expect(reason).toContain(SOURCE);
    expect(reason).toMatch(/no longer in/);
    await expect(queue.getByRole("alert")).toContainText(held[0]!.short_id);
    await expect(queue.getByRole("alert")).toContainText("no longer in");
    // Dismiss removes only the warning. The review stays paused and the held comment stays
    // queued, so this is not a disguised Drop or Resume action.
    const warning = queue.getByRole("alert").filter({ hasText: held[0]!.short_id });
    await shoot(page.locator(".file-main"), page, "held-outdated");
    await warning.getByRole("button", { name: "Dismiss review warning" }).click();
    await expect(warning).toBeHidden();
    await expect
      .poll(() => storedReview(daemon), { message: "the warning was not durably dismissed" })
      .toEqual({ state: "paused", pause_reason: null });
    expect(storedQueue(daemon)[0]!.status).toBe("queued");
    expect(storedQueue(daemon)[0]!.delivered).toBe(0);
    // The list says the same thing beside the comment itself, so the reason is findable from
    // either end.
    await expect(queue.locator(".file-review-item").first())
      .toContainText("the quoted text has moved or is gone");

    // ---- Resume is a RE-CHECK, not a way past ----
    await queue.getByRole("button", { name: "Resume review" }).click();
    await expect
      .poll(() => storedReview(daemon)?.pause_reason, {
        message: "Resume did not re-check and raise the warning again",
      })
      .toContain(held[0]!.short_id);
    await expect(queue.getByRole("alert")).toContainText(held[0]!.short_id);
    // Still held: resuming re-runs the pass, the quote is still gone, and holding is still the
    // right answer. What resuming does NOT do is deliver a comment about text that is not
    // there. Nor would editing it: Edit rewrites the message body and the quote is fixed, so
    // the way past is to drop it and comment again on the text that is there - which is what
    // the block below does.
    await expect
      .poll(() => storedQueue(daemon)[0]?.delivered, { timeout: 15_000 })
      .toBe(0);

    // ---- dropping it lets the review carry on ----
    const head = queue.locator(".file-review-item").first();
    await head.getByRole("button", { name: /^Drop comment MC-/ }).click();
    await expect
      .poll(() => storedQueue(daemon).length, { message: "the held comment was not dropped" })
      .toBe(1);
    await queue.getByRole("button", { name: /^(Resume|Start) review$/ }).click();
    await expect
      .poll(() => storedQueue(daemon)[0]?.delivered, {
        message: "the surviving comment never went out once the held one was dropped",
        timeout: 25_000,
      })
      .toBe(1);
  });
});
