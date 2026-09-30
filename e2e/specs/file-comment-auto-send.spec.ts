import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Sending a comment delivers it. There is no Start step: a comment goes to the agent as its
 * own turn when nothing is out, or waits in the queue behind the one that is, and the queue
 * returns to idle when it runs dry so the next comment goes on its own again.
 *
 * `file-comment-walkthrough.spec.ts` drives the queue's steering - reorder, rewrite, drop,
 * and the reader following a comment into its file. This file is about the one thing that
 * changed: what Send does, what the composer says it will do before it is pressed, and that
 * Pause is still the way to hold comments back.
 *
 * No model tokens: `fake-agents.ts` redirects every agent binary, and delivery is read out of
 * `harness.db` rather than off the screen.
 */

const EVIDENCE = artifactsDir("file-comment-auto-send");

async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-auto-send/${name}.png`);
}

const TASK = "review a spec as I go";
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
/** Held open by the fake for fifteen seconds. See `e2e/fixtures/fake-claude.mjs`. */
const HELD_TURN = "hold the current turn open for queued review setup";
const TYPED_MESSAGE = "An ordinary message, typed while the agent is busy.";
const SECOND = "Add a units column here.";

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
    .getByRole("button", { name: /Review A Spec As I Go/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  const row = page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: SOURCE });
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  // The gutter is the input device here, so take the surface that has one.
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
  await page.getByRole("button", { name: "Comment mode" }).click();
}

function lineNumber(page: Page, line: number): Locator {
  return page
    .locator(".cm-lineNumbers .cm-gutterElement")
    .filter({ hasText: new RegExp(`^${line}$`) });
}

/** Open the composer on a line, write in it, and return it - WITHOUT sending. */
async function write(page: Page, line: number, body: string): Promise<Locator> {
  await lineNumber(page, line).click();
  const composer = page.getByRole("region", { name: `New comment on line ${line}` });
  const box = composer.getByRole("textbox", { name: `Comment on line ${line}` });
  await expect(box).toBeVisible();
  await box.fill(body);
  return composer;
}

async function send(composer: Locator): Promise<void> {
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toBeHidden();
}

/** Every thread, in the daemon's own queue order. */
function storedQueue(daemon: DaemonHandle): {
  short_id: string;
  start_line: number;
  status: string;
  delivered: number;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.short_id, t.start_line, t.status,
                (SELECT COUNT(*) FROM file_comment_messages m
                  WHERE m.thread_id = t.id AND m.delivered_at IS NOT NULL) AS delivered
           FROM file_comment_threads t
          ORDER BY t.created_at`,
      )
      .all() as never);
}

function byLine(daemon: DaemonHandle, line: number): { short_id: string; status: string; delivered: number } | undefined {
  return storedQueue(daemon).find((row) => row.start_line === line);
}

function storedReview(daemon: DaemonHandle): { state: string; pause_reason: string | null } | null {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT state, pause_reason FROM file_comment_reviews`).get() ?? null) as never);
}

function outboxDepth(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM pending_turns`).get() as { n: number }).n);
}

/** Answer the comment out with the agent through the reply channel its MCP child uses. */
async function answer(daemon: DaemonHandle, cwd: string, commentId: string, body: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/file-comments/replies`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, commentId, body }),
  });
  expect(res.status, `the reply channel accepted the answer: ${await res.clone().text()}`).toBe(200);
}

/** Dispatch, write the files, and open SOURCE. Every file exists before the list loads. */
/**
 * Wait for the session to be settled: idle, with nothing in its outbox.
 *
 * "Goes to the agent now" is only true of a settled session - a busy one takes the comment
 * when it is next free - so a spec asserting that sentence has to know which it is looking at.
 */
async function settled(daemon: DaemonHandle): Promise<void> {
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        state: string;
        pendingTurns: unknown[];
      }[];
      const session = sessions[0];
      return session ? `${session.state}:${session.pendingTurns.length}` : null;
    }, { message: "the session never settled idle with an empty outbox", timeout: 30_000 })
    .toBe("idle:0");
}

async function prepare(
  page: Page,
  daemon: DaemonHandle,
  extra: Record<string, string> = {},
): Promise<string> {
  await dispatch(page, daemon);
  const cwd = await sessionCwd(daemon);
  mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
  writeFileSync(join(cwd, SOURCE), CONTENTS);
  for (const [path, text] of Object.entries(extra)) writeFileSync(join(cwd, path), text);
  await useConsoleLayout(page, daemon);
  await openTheFile(page);
  await settled(daemon);
  return cwd;
}

test.describe("comments go to the agent as they are sent", () => {
  test("Send delivers with no Start, and the next comment waits its turn", async ({
    dashboard: page,
    daemon,
  }) => {
    const cwd = await prepare(page, daemon);

    // ---- the composer says what Send will do, before it is pressed ----
    const first = await write(page, 3, FIRST);
    await expect(first).toContainText("Goes to the agent now");
    await shoot(page.locator(".file-main"), page, "composer-goes-now");
    await send(first);

    // ---- and it goes: no Start review, no queue panel to open first ----
    await expect
      .poll(() => byLine(daemon, 3)?.delivered, {
        message: "Send never delivered the comment to the agent",
        timeout: 20_000,
      })
      .toBe(1);
    expect(storedReview(daemon)?.state).toBe("running");
    // The panel did not pop open over the file; the toolbar says a comment is out instead.
    await expect(page.getByRole("region", { name: "Review queue" })).toBeHidden();
    const queueToggle = page.getByRole("button", { name: "Review queue" });
    await expect(queueToggle).toHaveText(/Review \(1\)/);
    await expect(queueToggle.locator(".file-review-live")).toBeVisible();

    // ---- a second comment, written while the first is out, waits behind it ----
    const second = await write(page, 5, SECOND);
    await expect(second).toContainText("Waits behind 1 comment");
    await shoot(page.locator(".file-main"), page, "composer-waits-behind");
    await send(second);
    await expect
      .poll(() => byLine(daemon, 5)?.status, { message: "the second comment never reached the queue" })
      .toBe("queued");
    expect(byLine(daemon, 3)!.status, "the first is still the one out with the agent").not.toBe("queued");
    expect(outboxDepth(daemon), "one turn outstanding, ever").toBeLessThanOrEqual(1);

    await queueToggle.click();
    const queue = page.getByRole("region", { name: "Review queue" });
    await expect(queue).toBeVisible();
    await expect(queue.getByRole("button", { name: "Start review" })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: "Pause review" })).toBeVisible();
    await expect(queue.getByRole("status")).toContainText(/is out with the agent\. 1 comment waiting\./);
    await shoot(page.locator(".file-main"), page, "queue-running");

    // ---- the agent answers the first, and the second goes with no click ----
    await answer(daemon, cwd, `${byLine(daemon, 3)!.short_id}.1`, "Fixed.");
    await expect
      .poll(() => byLine(daemon, 5)?.delivered, {
        message: "answering the first never released the second",
        timeout: 20_000,
      })
      .toBe(1);

    // ---- and when the queue runs dry it waits for the next comment, not for a Resume ----
    await answer(daemon, cwd, `${byLine(daemon, 5)!.short_id}.1`, "Added.");
    await expect
      .poll(() => storedReview(daemon), { message: "the drained review never went back to idle" })
      .toEqual({ state: "idle", pause_reason: null });
    await expect(queue.getByRole("status")).toHaveText(
      "Nothing waiting. Comments go to the agent as you send them.",
    );
    await expect(queue.getByRole("button", { name: "Resume review" })).toHaveCount(0);
    await expect(queue.getByRole("button", { name: "Pause review" })).toHaveCount(0);
    await shoot(page.locator(".file-main"), page, "queue-drained");

    // The next comment goes on its own again.
    await settled(daemon);
    const third = await write(page, 7, "Which of these two is right?");
    await expect(third).toContainText("Goes to the agent now");
    await send(third);
    await expect
      .poll(() => byLine(daemon, 7)?.delivered, {
        message: "a comment sent after the queue ran dry never went",
        timeout: 20_000,
      })
      .toBe(1);
  });

  test("Pause holds a newly sent comment until Resume", async ({ dashboard: page, daemon }) => {
    const cwd = await prepare(page, daemon);

    await send(await write(page, 3, FIRST));
    await expect
      .poll(() => byLine(daemon, 3)?.delivered, { message: "the first comment never went", timeout: 20_000 })
      .toBe(1);

    await page.getByRole("button", { name: "Review queue" }).click();
    const queue = page.getByRole("region", { name: "Review queue" });
    await queue.getByRole("button", { name: "Pause review" }).click();
    await expect
      .poll(() => storedReview(daemon)?.state, { message: "the pause never reached the daemon" })
      .toBe("paused");

    // ---- the composer says a sent comment will wait ----
    const second = await write(page, 5, SECOND);
    await expect(second).toContainText("Delivery is paused; this waits until you resume");
    await shoot(page.locator(".file-main"), page, "composer-held");
    await send(second);
    await expect
      .poll(() => byLine(daemon, 5)?.status, { message: "the held comment never reached the queue" })
      .toBe("queued");

    // The first resolves - the pause is about the ones behind it - and the held one stays.
    await answer(daemon, cwd, `${byLine(daemon, 3)!.short_id}.1`, "Fixed.");
    // Either way out of the outstanding set: the reply, or the grace window if it ran first.
    await expect
      .poll(() => byLine(daemon, 3)?.status, { message: "the first comment never resolved" })
      .toMatch(/^(answered|unanswered)$/);
    await expect(queue.getByRole("status")).toContainText(
      "Delivery paused. 1 comment waiting. New comments join the queue.",
    );
    await shoot(page.locator(".file-main"), page, "queue-paused");
    expect(byLine(daemon, 5)!.status, "a paused review sends nothing new").toBe("queued");
    expect(storedReview(daemon)?.state).toBe("paused");

    // ---- Resume releases it ----
    await queue.getByRole("button", { name: "Resume review" }).click();
    await expect
      .poll(() => byLine(daemon, 5)?.delivered, { message: "Resume never released the held comment", timeout: 20_000 })
      .toBe(1);
  });

  test("a comment going out never moves the reader away from one they are writing", async ({
    dashboard: page,
    daemon,
  }) => {
    // Comments go as they are sent, so the next one often leaves while the reader is writing
    // on another line of another file. Following it there would take the view out from under
    // the open composer.
    const OTHER = "docs/plans/other.md";
    const cwd = await prepare(page, daemon, {
      [OTHER]: ["# The other file", "", "This one has its own problem.", ""].join("\n"),
    });

    await send(await write(page, 3, FIRST));
    await expect
      .poll(() => byLine(daemon, 3)?.delivered, { message: "the first comment never went", timeout: 20_000 })
      .toBe(1);

    // Held, so the moment the next comment goes is the test's to choose rather than the
    // grace window's: that moment has to come while a composer is open.
    await page.getByRole("button", { name: "Review queue" }).click();
    await page.getByRole("region", { name: "Review queue" }).getByRole("button", { name: "Pause review" }).click();
    await expect
      .poll(() => storedReview(daemon)?.state, { message: "the pause never reached the daemon" })
      .toBe("paused");

    // A second comment in another file, which waits.
    const files = page.getByRole("listbox", { name: "Session files" });
    await files.getByRole("option", { name: OTHER }).click();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${OTHER}`)).toBeVisible();
    await send(await write(page, 3, SECOND));

    // Back to the first file, mid-sentence on a third comment.
    await files.getByRole("option", { name: SOURCE }).click();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    const writing = await write(page, 5, "Half a thought about the tab");

    // Released from outside the page, so nothing the reader does is what lets it go: the
    // daemon's own Resume, then the answer that frees the one turn.
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { id: string }[];
    const resumed = await fetch(`${daemon.baseURL}/api/sessions/${sessions[0]!.id}/file-comment-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    await answer(daemon, cwd, `${byLine(daemon, 3)!.short_id}.1`, "Fixed.");
    await expect
      .poll(
        () => storedQueue(daemon).filter((row) => row.start_line === 3).map((row) => row.delivered),
        { message: "the comment in the other file never went", timeout: 20_000 },
      )
      .toEqual([1, 1]);

    // The reader is where they were, with their sentence intact.
    await expect(files.getByRole("option", { name: SOURCE })).toHaveAttribute("aria-selected", "true");
    await expect(writing.getByRole("textbox", { name: "Comment on line 5" })).toHaveValue(
      "Half a thought about the tab",
    );
    await shoot(page.locator(".file-main"), page, "composer-not-moved");
  });

  test("the hint says a comment waits for a message already in the session's outbox", async ({
    dashboard: page,
    daemon,
  }) => {
    // One comment outstanding is one turn in the session's WHOLE outbox. An ordinary message
    // typed into the conversation while the agent is busy sits in that outbox, the comment
    // waits behind it, and the composer must not promise "now" in the meantime.
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);
    await useConsoleLayout(page, daemon);

    await page
      .getByRole("navigation", { name: "Sessions" })
      .getByRole("button", { name: /Review A Spec As I Go/i })
      .click();
    await page
      .getByRole("tablist", { name: "Session detail" })
      .getByRole("tab", { name: /Conversation$/ })
      .click();
    const detail = page.locator(".console-detail");
    const reply = detail.getByPlaceholder(/^Reply to this session/);
    await expect(reply).toBeEnabled();
    // The fake holds this exact prompt open for fifteen seconds, so the next message meets a
    // busy session and stays in Mission Control's outbox. See `queued-turn-held-by-review`.
    await reply.fill(HELD_TURN);
    await reply.press("Enter");
    await expect(
      detail.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
    ).toBeVisible();
    await reply.fill(TYPED_MESSAGE);
    await reply.press("Enter");
    await expect
      .poll(() => outboxDepth(daemon), { message: "the typed message never waited in the outbox" })
      .toBe(1);

    // The session is already selected, so straight to its Files tab.
    await page
      .getByRole("tablist", { name: "Session detail" })
      .getByRole("tab", { name: /Files$/ })
      .click();
    await page.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: SOURCE }).click();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await page.getByRole("button", { name: "Comment mode" }).click();
    const composer = await write(page, 3, FIRST);
    await expect(composer).toContainText("Waits for the message already in this session's outbox");
    await expect(composer).not.toContainText("Goes to the agent now");
    await shoot(page.locator(".file-main"), page, "composer-waits-for-outbox");
    await send(composer);

    // It waits behind that message rather than joining it in the outbox...
    await expect
      .poll(() => byLine(daemon, 3)?.status, { message: "the comment never reached the queue" })
      .toBe("queued");
    expect(byLine(daemon, 3)!.delivered).toBe(0);
    expect(outboxDepth(daemon), "one turn in the outbox, never two").toBeLessThanOrEqual(1);

    // ...and goes on its own once that message has been delivered.
    await expect
      .poll(() => byLine(daemon, 3)?.delivered, {
        message: "the comment never went after the outbox cleared",
        timeout: 45_000,
        intervals: [1_000],
      })
      .toBe(1);
  });

  test("the hint says a comment goes when the agent is next free while it is mid-turn", async ({
    dashboard: page,
    daemon,
  }) => {
    // Nothing queued and nothing in the outbox, but the agent is working: the comment's turn
    // waits in the outbox for it to be free, so "now" would be a promise the daemon cannot keep.
    await prepare(page, daemon);
    await page
      .getByRole("tablist", { name: "Session detail" })
      .getByRole("tab", { name: /Conversation$/ })
      .click();
    const detail = page.locator(".console-detail");
    const reply = detail.getByPlaceholder(/^Reply to this session/);
    await expect(reply).toBeEnabled();
    await reply.fill(HELD_TURN);
    await reply.press("Enter");
    await expect(
      detail.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
    ).toBeVisible();
    // Working, with nothing waiting behind it: the state this hint exists for.
    await expect
      .poll(async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
          state: string;
          pendingTurns: unknown[];
        }[];
        return `${sessions[0]?.state}:${sessions[0]?.pendingTurns.length}`;
      }, { message: "the held turn never left the agent working with an empty outbox" })
      .toBe("working:0");

    await page
      .getByRole("tablist", { name: "Session detail" })
      .getByRole("tab", { name: /Files$/ })
      .click();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    // Comment mode is a mode, not a setting, so leaving the tab may have turned it off.
    const mode = page.getByRole("button", { name: "Comment mode" });
    if ((await mode.getAttribute("aria-pressed")) !== "true") await mode.click();
    await expect(mode).toHaveAttribute("aria-pressed", "true");
    const composer = await write(page, 3, FIRST);
    await expect(composer).toContainText("Goes to the agent when it is next free");
    await expect(composer).not.toContainText("Goes to the agent now");
    await shoot(page.locator(".file-main"), page, "composer-agent-busy");
    await send(composer);

    // And it does go, on its own, once the held turn ends.
    await expect
      .poll(() => byLine(daemon, 3)?.delivered, {
        message: "the comment never went after the agent was free",
        timeout: 45_000,
        intervals: [1_000],
      })
      .toBe(1);
  });
});
