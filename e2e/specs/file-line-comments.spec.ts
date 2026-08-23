import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Comment mode in the Files tab: turn it on, click a line number, write a comment, and find
 * it still there - as a marker on that line, expandable into a thread you can add to and
 * close - after a full reload.
 *
 * Only a browser can say any of that. The three older UI layers each assert something real
 * and none of them can see whether this works: `renderToStaticMarkup` runs render and not
 * effects, so CodeMirror never mounts and there is no line number to click; the in-process HTTP
 * tests reach the routes without a DOM; and the Electron tests measure geometry. The whole
 * feature is a click on a line number becoming a row in SQLite becoming a server event
 * becoming a marker back on the line, and this is the only layer that closes that loop.
 *
 * No model tokens: every agent binary is redirected at a fake by `fake-agents.ts`, and this
 * spec never asks an agent for anything - phase 2 deliberately sends nothing. What it does
 * assert about the daemon's state is read straight out of `harness.db`, because "persists"
 * has to mean the row and not just the pixels.
 */

const EVIDENCE = artifactsDir("file-line-comments");

/** Photograph a state this spec has already asserted on. See copy-confirms-and-reports.spec.ts. */
async function shoot(target: Locator, page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-line-comments/${name}.png`);
}

const TASK = "review a spec line by line";
const SOURCE = "docs/plans/spec.md";
const CONTENTS = [
  "# The spec",
  "",
  "The retry budget is thirty seconds.",
  "",
  "The table below has no units column.",
  "",
].join("\n");

/** A second file, purely to select away to while a draft is still unwritten. */
const OTHER = "docs/plans/other.md";
const OTHER_CONTENTS = "# Something else entirely\n\nNot the file the comment is about.\n";

const COMMENT = "This contradicts the table three screens down.";
/** One sentence, deliberately written into two different drafts. See the last test. */
const ECHO = "Both of these say thirty seconds.";
const FIRST_DRAFT = "Something to change my mind about later.";
const REPLY = "And the diagram disagrees with both of them.";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every keystroke;
  // without this the next fill lands on a covered control. See file-default-view.spec.ts.
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

/**
 * Reach the open file, from a freshly loaded page as well as from the first one.
 *
 * It lands in PREVIEW, because a Markdown document does - which is the case worth driving
 * here rather than around: a spec is the document this feature exists for, and asking to
 * comment on one has to bring its source up on its own.
 */
async function openTheFile(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Review A Spec Line By Line/i })
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
}

/**
 * The line-number gutter element for a 1-based source line.
 *
 * CodeMirror renders a hidden spacer as the gutter's first child, so the numbers are matched
 * by their exact text rather than by index.
 */
function lineNumber(page: Page, line: number): Locator {
  return page
    .locator(".cm-lineNumbers .cm-gutterElement")
    .filter({ hasText: new RegExp(`^${line}$`) });
}

/** Every thread this session holds, read from the daemon's own state. */
function storedThreads(daemon: DaemonHandle): {
  path: string;
  start_line: number;
  quote: string;
  status: string;
  queue_seq: number | null;
  messages: number;
}[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.path, t.start_line, t.quote, t.status, t.queue_seq,
                (SELECT COUNT(*) FROM file_comment_messages m WHERE m.thread_id = t.id) AS messages
           FROM file_comment_threads t
          ORDER BY t.created_at`,
      )
      .all() as never);
}

/** Every opening comment, with the file it was written on. */
function storedOpeningBodies(daemon: DaemonHandle): { path: string; body: string }[] {
  return withDaemonDb(daemon, (db) =>
    db
      .prepare(
        `SELECT t.path, m.body
           FROM file_comment_threads t
           JOIN file_comment_messages m ON m.thread_id = t.id
          ORDER BY t.created_at, m.created_at`,
      )
      .all() as never);
}

test.describe("line comments in the Files editor", () => {
  test("a comment written on a line survives a reload as a thread on that line", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    // Untracked and not ignored, which is what keeps it in the Files list.
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);

    // ---- the control ----
    const commentMode = page.getByRole("button", { name: "Comment mode" });
    await expect(commentMode).toHaveAttribute("aria-pressed", "false");
    await expect(commentMode).toHaveAttribute("aria-keyshortcuts", "m");
    await commentMode.click();
    await expect(commentMode).toHaveAttribute("aria-pressed", "true");
    // A comment names a line, so something with line numbers has to come up - but the
    // rendered spec the reader was reading STAYS. See the Preview test below, which is where
    // that rule is stated; here it is simply the surface the rest of this runs on.
    await expect(page.getByLabel(`Preview of ${SOURCE}`)).toBeVisible();
    await expect(page.getByLabel(`Editor for ${SOURCE}`))
      .toContainText("The retry budget is thirty seconds.");

    // ---- cancelling one ----
    // Escape discards the ROW as well as the box: an abandoned draft would otherwise leave a
    // marker on a line for a comment the reader just decided against. That the same press
    // does not also reach App's global Escape is pinned in
    // `test/file-comment-editor-markup.test.ts`, where the handler is readable.
    await lineNumber(page, 5).click();
    const scratch = page.getByRole("textbox", { name: "Comment on line 5" });
    await scratch.fill("never mind");
    await expect
      .poll(() => storedThreads(daemon).length, { message: "the scratch draft was never saved" })
      .toBe(1);
    await scratch.press("Escape");
    await expect(scratch).toBeHidden();
    await expect
      .poll(() => storedThreads(daemon).length, { message: "cancelling left the draft behind" })
      .toBe(0);

    // ---- writing one ----
    await lineNumber(page, 3).click();
    const box = page.getByRole("textbox", { name: "Comment on line 3" });
    await expect(box).toBeVisible();
    await box.fill(COMMENT);
    await shoot(page.locator(".file-main"), page, "composer-on-line");

    // The draft is durable from the first keystroke, before anything is submitted: that is
    // what makes it editable, and what keeps a half-written review from living in a tab.
    await expect
      .poll(() => storedThreads(daemon).map((row) => row.status), {
        message: "the comment was never written as a draft row",
      })
      .toEqual(["draft"]);

    await page.getByRole("button", { name: "Comment", exact: true }).click();

    // ---- the marker ----
    const marker = page.getByRole("button", { name: /^Comment MC-\w+ on line 3, queued$/ });
    await expect(marker).toBeVisible();
    await expect(box).toBeHidden();
    await shoot(page.locator(".file-main"), page, "marker-on-line");

    // Submitting takes the next position in the session's review queue, in ONE call - phase 3
    // drains this, and a phase 3 opening onto an empty queue would have nothing to send.
    const queued = storedThreads(daemon);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.path).toBe(SOURCE);
    expect(queued[0]!.start_line).toBe(3);
    expect(queued[0]!.quote).toBe("The retry budget is thirty seconds.");
    expect(queued[0]!.status).toBe("queued");
    expect(queued[0]!.queue_seq).not.toBeNull();

    // ---- expanding it, and adding to it ----
    await marker.click();
    const thread = page.getByRole("region", { name: /^Comment MC-\w+ on line 3$/ });
    await expect(thread).toContainText(COMMENT);
    await thread.getByPlaceholder("Reply…").fill(REPLY);
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread).toContainText(REPLY);
    await shoot(page.locator(".file-main"), page, "thread-expanded");

    await expect
      .poll(() => storedThreads(daemon)[0]?.messages, {
        message: "the reply never reached the thread",
      })
      .toBe(2);

    // ---- and it is still there after a reload ----
    await page.reload();
    await openTheFile(page);
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    // Comment mode is off again - it is a mode, not a setting - and the marker is there
    // anyway. Markers are the file's record of what was said about it; the mode only decides
    // whether a click on a line number starts something new.
    await expect(page.getByRole("button", { name: "Comment mode" }))
      .toHaveAttribute("aria-pressed", "false");
    // The reply is part of what the marker announces now, which is the point of the name
    // carrying the thread's state rather than just its existence.
    const afterReload = page.getByRole("button", {
      name: /^Comment MC-\w+ on line 3, queued, 1 reply$/,
    });
    await expect(afterReload).toBeVisible();
    await afterReload.click();
    const reopened = page.getByRole("region", { name: /^Comment MC-\w+ on line 3$/ });
    await expect(reopened).toContainText(COMMENT);
    await expect(reopened).toContainText(REPLY);

    // ---- closing it ----
    await reopened.getByRole("button", { name: "Resolve" }).click();
    await expect(afterReload).toBeHidden();
    await expect
      .poll(() => storedThreads(daemon)[0]?.status, {
        message: "Resolve did not close the thread",
      })
      .toBe("resolved");

    // Only a person closes a thread, and the toggle is how they see one they closed. It is a
    // comment-mode control and not a permanent fixture of the toolbar, which is the condition
    // `docs/ui.md` states: a file with closed threads shows nothing extra until you ask.
    const showResolved = page.getByRole("button", { name: "Show resolved comments" });
    await expect(showResolved).toBeHidden();
    await page.getByRole("button", { name: "Comment mode" }).click();
    await expect(showResolved).toHaveAttribute("aria-pressed", "false");
    await showResolved.click();
    await expect(page.getByRole("button", { name: /^Comment MC-\w+ on line 3, resolved, 1 reply$/ }))
      .toBeVisible();
  });

  test("comment mode answers to m, and the extracted window claims no key of its own", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);

    const commentMode = page.getByRole("button", { name: "Comment mode" });
    // The chord is claimed on the capture phase from outside the editor - a bare key never
    // reaches a window handler from `contentEditable`, which is why creating a comment is a
    // click on a line number and not a key.
    await page.getByRole("listbox", { name: "Session files" }).click();
    await page.keyboard.press("m");
    await expect(commentMode).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await page.keyboard.press("m");
    await expect(commentMode).toHaveAttribute("aria-pressed", "false");
    // Turning it off puts the pane back the way it was: the preview alone, full width.
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeHidden();
    await expect(page.getByLabel(`Preview of ${SOURCE}`)).toBeVisible();

    // And it stands down while you are typing, like p and e.
    await page.getByPlaceholder("Filter files…").fill("m");
    await expect(commentMode).toHaveAttribute("aria-pressed", "false");
    await page.getByPlaceholder("Filter files…").fill("");

    // The extracted window's keys belong to the window it was extracted from, so it prints
    // none. `file-default-view.spec.ts` pins the same rule for Preview and Editor.
    await page.getByRole("button", { name: "Extract files window" }).click();
    const extracted = page.getByRole("dialog", { name: /Files for / });
    await expect(extracted).toBeVisible();
    await expect(extracted.getByRole("button", { name: "Comment mode" })).toBeVisible();
    await expect(extracted.locator("[aria-keyshortcuts]")).toHaveCount(0);
  });


  test("commenting in Preview keeps the rendered document on screen", async ({
    dashboard: page,
    daemon,
  }) => {
    /*
     * The reader who has something to say about line 84 is the reader looking at the RENDERED
     * plan. Comment mode used to answer that by switching them to source - it took the
     * document away to let them point at it.
     *
     * It does not now. The preview keeps its half of the pane, the source takes the other,
     * and Preview stays the pressed view throughout: the whole comment is written, submitted
     * and read back without ever leaving it.
     */
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);

    const preview = page.getByLabel(`Preview of ${SOURCE}`);
    const previewButton = page.getByRole("button", { name: "Preview", exact: true });
    await expect(previewButton).toHaveAttribute("aria-pressed", "true");
    // The rendered document, not its source: the heading is an <h1>, which only Preview draws.
    await expect(preview.getByRole("heading", { name: "The spec" })).toBeVisible();

    await page.getByRole("button", { name: "Comment mode" }).click();

    // Both halves, at once. This assertion is the requested behaviour in one line.
    await expect(preview.getByRole("heading", { name: "The spec" })).toBeVisible();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await expect(previewButton, "commenting must not switch the view out from under the reader")
      .toHaveAttribute("aria-pressed", "true");
    await shoot(page.locator(".file-main"), page, "preview-comment-split");

    // The source column is for pointing at lines, not for editing: Preview is the view they
    // chose, and `e` is one key away if they meant otherwise.
    await expect(page.locator(".file-content.is-comment-split .cm-content"))
      .toHaveAttribute("contenteditable", "false");

    await lineNumber(page, 3).click();
    const box = page.getByRole("textbox", { name: "Comment on line 3" });
    await box.fill(COMMENT);
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    const marker = page.getByRole("button", { name: /^Comment MC-\w+ on line 3, queued$/ });
    await expect(marker).toBeVisible();
    await expect(previewButton).toHaveAttribute("aria-pressed", "true");
    await expect(preview.getByRole("heading", { name: "The spec" })).toBeVisible();

    const queued = storedThreads(daemon);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.path).toBe(SOURCE);
    expect(queued[0]!.start_line).toBe(3);
    expect(queued[0]!.status).toBe("queued");

    // Reading it back is a Preview action too.
    await marker.click();
    await expect(page.getByRole("region", { name: /^Comment MC-\w+ on line 3$/ }))
      .toContainText(COMMENT);
    await shoot(page.locator(".file-main"), page, "preview-thread-open");
  });

  /**
   * The two async races the draft lifecycle had, driven end to end.
   *
   * Both were reachable by an ordinary reader at ordinary speed, and neither is visible in
   * the markup: one is about which values a request is built from, the other about when a
   * cancel decides what to delete. `test/file-comment-editor-markup.test.ts` states each rule
   * as a pure function; these two prove the wiring actually honours them against a real
   * daemon, which is the half a unit test cannot reach.
   */
  test("a draft still being typed is written against the file it was opened on", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);
    writeFileSync(join(cwd, OTHER), OTHER_CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Comment mode" }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();

    await lineNumber(page, 3).click();
    await page.getByRole("textbox", { name: "Comment on line 3" }).fill(COMMENT);
    // Straight to another file, inside the debounce window - so the row has not been written
    // yet and the selection has already moved by the time it is. This is the ordinary speed
    // of changing your mind about which file you were reading, not a contrived race.
    await page
      .getByRole("listbox", { name: "Session files" })
      .getByRole("option", { name: OTHER })
      .click();

    await expect
      .poll(() => storedThreads(daemon).length, { message: "the pending draft was never written" })
      .toBe(1);
    const [saved] = storedThreads(daemon);
    expect(saved!.path, "the draft followed the selection onto the wrong file").toBe(SOURCE);
    expect(saved!.start_line).toBe(3);
    expect(saved!.quote).toBe("The retry budget is thirty seconds.");
    expect(saved!.status).toBe("draft");
  });

  test("cancelling while the create request is in flight leaves no comment behind", async ({
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

    // Hold the create open long enough to press Escape underneath it. Only the create is
    // delayed; the DELETE that cancelling issues goes to `/api/file-comments/:id` and is
    // untouched, so what this measures is the ordering, not the latency.
    await page.route("**/api/sessions/*/file-comments", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/file-comments"),
    );

    await lineNumber(page, 3).click();
    const box = page.getByRole("textbox", { name: "Comment on line 3" });
    await box.fill(COMMENT);
    // Past the debounce, so the request is out, and well inside the delay, so it has not
    // come back. The composer has no thread id to cancel with at this moment - which is
    // exactly the state that used to leak a row.
    // A literal wait, which is the right tool exactly once: the thing being waited for is a
    // 400ms debounce this spec is deliberately racing, and there is no observable state
    // between "typed" and "request sent" to poll on. The 2s route delay is the margin.
    await page.waitForTimeout(700);
    await box.press("Escape");
    await expect(box).toBeHidden();

    // Wait for the create to actually come back BEFORE asserting anything about the store.
    // Without this the assertion below reads an empty table while the request is still in
    // the air and passes for the wrong reason - which it did, until this line existed.
    await created;

    // The row now exists, and the cancel's delete is queued behind the create that made it.
    // What is being measured is that the delete finds it: a leak here is a marker on a line
    // for a comment the reader discarded.
    await expect
      .poll(() => storedThreads(daemon).length, {
        message: "cancelling during the create left a durable comment behind",
        timeout: 15_000,
      })
      .toBe(0);
    await expect(page.getByRole("button", { name: /^Comment MC-/ })).toHaveCount(0);
  });

  test("switching files while the create is in flight leaves exactly one draft", async ({
    dashboard: page,
    daemon,
  }) => {
    /*
     * The same switch-away as the test above, but with the create still unresolved when it
     * happens - which is a different bug, not a slower version of the same one.
     *
     * Closing the composer settles what was typed, deliberately: a draft is durable, so
     * leaving the file writes the comment where it was written rather than discarding it.
     * That settling write inherited a snapshot whose `threadId` was still null, because the
     * create it was waiting on had not answered yet, and read the null as "no row exists" -
     * so it made a SECOND one. Two durable drafts, two markers, on a line commented on once.
     */
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);
    writeFileSync(join(cwd, OTHER), OTHER_CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Comment mode" }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();

    // Only the create is held open; the edit and delete routes are untouched, so what this
    // measures is the ordering rather than the latency.
    await page.route("**/api/sessions/*/file-comments", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });
    const isCreate = (method: string, url: string): boolean =>
      method === "POST" && url.endsWith("/file-comments");
    const created = page.waitForResponse((response) =>
      isCreate(response.request().method(), response.url()));
    /*
     * A SECOND create, if one is ever issued.
     *
     * Counting requests rather than rows, because the duplicate queues behind the first and
     * therefore inherits the same 2s delay - a row count read on any fixed schedule races it,
     * and the version of this test that did read on a schedule passed against the bug.
     */
    let creates = 0;
    page.on("request", (request) => {
      if (isCreate(request.method(), request.url())) creates += 1;
    });
    // Registered after the counter, so by the time this predicate is asked about a request
    // the counter has already seen it - and `creates > 1` is therefore true of the SECOND
    // create and no earlier. Matching the first is the mistake this comment exists to stop:
    // it makes the assertion below fail identically whether the bug is present or not.
    const secondCreate = page
      .waitForRequest(
        (request) => isCreate(request.method(), request.url()) && creates > 1,
        { timeout: 8_000 },
      )
      .then(() => true)
      .catch(() => false);

    await lineNumber(page, 3).click();
    await page.getByRole("textbox", { name: "Comment on line 3" }).fill(COMMENT);
    // Past the 400ms debounce, so the create is out, and well inside the 2s delay, so it has
    // not come back. See the cancel test below for why the literal wait is right here.
    await page.waitForTimeout(700);
    await page
      .getByRole("listbox", { name: "Session files" })
      .getByRole("option", { name: OTHER })
      .click();

    await created;
    expect(await secondCreate, "settling the draft behind an in-flight create wrote it twice")
      .toBe(false);
    expect(creates, "exactly one create for one comment").toBe(1);

    const rows = storedThreads(daemon);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe(SOURCE);
    expect(rows[0]!.start_line).toBe(3);
    expect(rows[0]!.status).toBe("draft");
    expect(rows[0]!.messages, "the settling write must edit the opening message, not add one")
      .toBe(1);
  });

  test("an edit to one draft is not silenced by what another draft just saved", async ({
    dashboard: page,
    daemon,
  }) => {
    /*
     * Two drafts, one sentence, and a cache that used to belong to whoever spoke last.
     *
     * An unchanged body costs no request - that is worth having, because every keystroke
     * asks. But the record of what the daemon holds was a bare string shared by every
     * composer, so a create finishing for the draft on one file could leave its body sitting
     * there while the reader was already editing a draft on another. Typing the same sentence
     * into the second one then looked like "nothing changed" and nothing was sent: the words
     * stayed on screen and never reached the row, with no error to notice.
     *
     * The request chain makes the order deterministic rather than lucky - the second draft's
     * write is queued behind the first draft's create and therefore always runs after it.
     */
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    mkdirSync(join(cwd, dirname(SOURCE)), { recursive: true });
    writeFileSync(join(cwd, SOURCE), CONTENTS);
    writeFileSync(join(cwd, OTHER), OTHER_CONTENTS);

    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Comment mode" }).click();

    const files = page.getByRole("listbox", { name: "Session files" });

    // ---- the draft that gets edited later ----
    await files.getByRole("option", { name: OTHER }).click();
    await expect(page.getByLabel(`Editor for ${OTHER}`)).toBeVisible();
    await lineNumber(page, 3).click();
    await page.getByRole("textbox", { name: "Comment on line 3" }).fill(FIRST_DRAFT);
    await expect
      .poll(() => storedOpeningBodies(daemon).map((row) => row.body), {
        message: "the first draft was never written",
      })
      .toEqual([FIRST_DRAFT]);

    /*
     * ---- a second draft, on the other file, whose create is HELD OPEN ----
     *
     * Held open because that is the whole race: the cache is written when the create answers,
     * and the reader has to already be editing the other draft by then. Reopening a draft
     * refreshes the cache from the thread, so a create that has already answered is harmless -
     * an earlier version of this test let it answer first and passed against the bug.
     */
    await page.route("**/api/sessions/*/file-comments", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });
    const secondCreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/file-comments"),
    );

    await files.getByRole("option", { name: SOURCE }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await lineNumber(page, 3).click();
    await page.getByRole("textbox", { name: "Comment on line 3" }).fill(ECHO);
    // Past the 400ms debounce, so the create is out and unanswered.
    await page.waitForTimeout(700);

    // ---- and, while it is still in the air, say the same thing in the first one ----
    await files.getByRole("option", { name: OTHER }).click();
    await page.getByRole("button", { name: /^Comment MC-\w+ on line 3, draft$/ }).click();
    const reopened = page.getByRole("textbox", { name: "Comment on line 3" });
    await expect(reopened).toHaveValue(FIRST_DRAFT);
    await reopened.fill(ECHO);

    // This edit is queued behind that create, so it necessarily runs after the create has
    // filled the cache in. Which draft the cache belongs to is the only thing keeping the
    // edit alive.
    await secondCreated;
    await expect
      .poll(() => storedOpeningBodies(daemon).length, { message: "the second draft never landed" })
      .toBe(2);

    await expect
      .poll(() => storedOpeningBodies(daemon).find((row) => row.path === OTHER)?.body, {
        message: "the edit was suppressed by another draft's cached body",
        timeout: 10_000,
      })
      .toBe(ECHO);
  });
});
