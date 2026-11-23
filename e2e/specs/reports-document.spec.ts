import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ReportItem } from "../../src/shared/reports.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: Open report shows the document an agent attached from the copy Mission
 * Control stored when the report was posted, so it still opens after the checkout file is gone.
 * Publish as scout saves that document to the scout archive, and only when the operator presses
 * it: before the press the Scouts page does not list it, after it the card says Published and
 * Open archive reaches it. A page the archive's checker refuses says why on the card and publishes
 * nothing. Neither action clears the report from to read.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Reports are posted on the exact
 * channel the MCP `post_report` tool uses, and the agent is the suite's fake: no model tokens are
 * spent.
 */

// A bundle removed from disk reaches its report only when a reconciliation pass prunes it. A
// recursive filesystem watcher reports that removal at once on macOS but not on Linux, where the
// pass falls to the recurring cadence (60 seconds by default). Keep that cadence quick, as the
// scout archive spec does, so the step does not depend on the platform's watcher.
test.use({ daemonEnv: { MISSION_SCOUT_RECONCILE_MS: "200" } });

const EVIDENCE = artifactsDir("reports-document");

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/reports-document/${name}.png`);
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

/** Post a report the way the MCP `post_report` tool does. */
async function report(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<ReportItem> {
  const res = await fetch(`${daemon.baseURL}/mcp/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { report: ReportItem }).report;
}

const toRead = (page: Page) => page.locator("button.pulse-seg", { hasText: "to read" });

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toRead(page).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  return inbox;
}

async function startSession(daemon: DaemonHandle, title: string): Promise<{ task: Task; session: Session }> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: title.toLowerCase(), kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  return { task, session };
}

const DOCUMENT_TITLE = "Flaky build diagnosis";
const DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><title>${DOCUMENT_TITLE}</title>
<style>body{font-family:sans-serif}</style></head><body>
<h1>${DOCUMENT_TITLE}</h1>
<p>The cache key ignored the lockfile, so CI restored stale modules.</p>
</body></html>`;

test("Open report reads the stored copy after the checkout file is gone, and Publish as scout archives it only on the press", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  const { session } = await startSession(daemon, "Diagnose the flaky build");
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "inbox", enabled: true }, "PUT");

  // A report with an HTML document attached, and the checkout file then deleted: from here on
  // the only copy is the one Mission Control stored when the report was posted.
  const file = join(session.cwd!, "diagnosis.html");
  writeFileSync(file, DOCUMENT);
  const posted = await report(daemon, session.cwd!, {
    title: "Build failure diagnosed",
    body: "Full write-up attached.",
    file: "diagnosis.html",
  });
  unlinkSync(file);
  expect(posted.document).toEqual({ name: "diagnosis.html", kind: "html" });

  await page.getByRole("button", { name: /^Scouts/ }).click();
  const scouts = page.getByRole("complementary", { name: "Scout archives" });
  await expect(scouts).toBeVisible();
  await expect(scouts.getByRole("button", { name: /Build failure diagnosed/ })).toHaveCount(0);
  await capture(page, "00-scouts-before-publish", page);
  await page.getByRole("button", { name: /^Fleet/ }).click();

  let inbox = await openInbox(page);
  let card = inbox.getByRole("article", { name: "Report: Build failure diagnosed" });
  await card.getByRole("button", { name: "Build failure diagnosed" }).click();
  await expect(card).toContainText("Attached: diagnosis.html");
  await capture(card, "01-card-with-document", page);
  await card.getByRole("button", { name: "Open report" }).click();
  const reader = page.getByRole("dialog", { name: "Report document: Build failure diagnosed" });
  await expect(reader).toBeVisible();
  const frame = reader.frameLocator('iframe[title="Report document: diagnosis.html"]');
  await expect(frame.getByRole("heading", { name: DOCUMENT_TITLE })).toBeVisible({ timeout: 20_000 });
  await expect(frame.getByText("The cache key ignored the lockfile")).toBeVisible();
  await expectContentClearsBorder(reader);
  // A modal dialog: keyboard focus moves into the reader rather than staying on the inbox behind it.
  await expect(reader).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => reader.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await capture(reader, "02-reader-stored-copy", page);
  await reader.getByRole("button", { name: "Close" }).click();
  await expect(reader).toBeHidden();
  // And focus returns to the control that opened it.
  await expect(card.getByRole("button", { name: "Open report" })).toBeFocused();

  await expect.poll(async () => (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`))
    .reports.find((r) => r.id === posted.id)?.openedAt ?? null, { timeout: 20_000 }).not.toBeNull();
  await expect(toRead(page)).toHaveCount(1);

  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Build failure diagnosed" });
  await card.getByRole("button", { name: "Publish as scout" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Published" })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Publish as scout" })).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(1);
  await capture(card, "03-card-published", page);
  const stored = (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`))
    .reports.find((r) => r.id === posted.id)!;
  expect(stored.publishedArchiveKey).not.toBeNull();
  expect(stored.readAt).toBeNull();

  await card.getByRole("button", { name: "Open archive" }).click();
  await expect(inbox).toBeHidden();
  // An archive key is two UUIDs joined by `~`: nothing in it needs escaping in a pattern.
  await expect(page).toHaveURL(new RegExp(`#/scouts/${stored.publishedArchiveKey!}`));
  const archive = page.getByRole("region", { name: "Scout report" });
  await expect(archive.getByRole("heading", { level: 1 })).toContainText("Build failure diagnosed", { timeout: 30_000 });
  await expect(page.getByRole("complementary", { name: "Scout archives" })
    .getByRole("button", { name: /Build failure diagnosed/ }).first()).toBeVisible();
  await capture(page, "04-scouts-after-publish", page);
  await page.getByRole("button", { name: /^Fleet/ }).click();

  await api(daemon, `/api/archives/${stored.publishedArchiveKey!}`, { confirmArchiveKey: stored.publishedArchiveKey! }, "DELETE");
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Build failure diagnosed" });
  if (!(await card.getByRole("button", { name: "Open report" }).isVisible())) {
    await card.getByRole("button", { name: "Build failure diagnosed" }).click();
  }
  await expect(card.getByRole("button", { name: "Publish as scout" })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("button", { name: "Open archive" })).toHaveCount(0);
  await expect(card.getByRole("status").filter({ hasText: "Published" })).toHaveCount(0);
  await expect(toRead(page)).toHaveCount(1);
  await capture(card, "04b-card-after-archive-deleted", page);

  // Published again, then its bundle removed from disk without the delete route - the state an
  // interrupted delete leaves. The library reconciler prunes it and hands that key to the report,
  // so the card offers Publish as scout again without a restart.
  await card.getByRole("button", { name: "Publish as scout" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Published" })).toBeVisible({ timeout: 30_000 });
  const [producerId, archiveId] = stored.publishedArchiveKey!.split("~");
  const bundle = join(daemon.home, "archives", producerId!, archiveId!);
  expect(existsSync(bundle), `the republished bundle is at ${bundle}`).toBe(true);
  rmSync(bundle, { recursive: true, force: true });
  await expect(card.getByRole("button", { name: "Publish as scout" })).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole("button", { name: "Open archive" })).toHaveCount(0);
  await capture(card, "04c-card-after-bundle-removed", page);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  writeFileSync(join(session.cwd!, "notes.md"), "# Release notes\n\n| step | result |\n| --- | --- |\n| build | fixed |\n");
  const notes = await report(daemon, session.cwd!, { title: "Release notes drafted", body: "Markdown attached.", file: "notes.md" });
  unlinkSync(join(session.cwd!, "notes.md"));
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Release notes drafted" });
  await card.getByRole("button", { name: "Release notes drafted" }).click();
  await card.getByRole("button", { name: "Open report" }).click();
  const notesReader = page.getByRole("dialog", { name: "Report document: Release notes drafted" });
  await expect(notesReader.getByRole("heading", { name: "Release notes" })).toBeVisible({ timeout: 20_000 });
  await expect(notesReader.getByRole("cell", { name: "fixed" })).toBeVisible();
  await expectContentClearsBorder(notesReader);
  await capture(notesReader, "05-reader-markdown", page);
  await page.keyboard.press("Escape");
  await expect(notesReader).toBeHidden();
  await card.getByRole("button", { name: "Publish as scout" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Published" })).toBeVisible({ timeout: 30_000 });
  const notesKey = (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`))
    .reports.find((r) => r.id === notes.id)!.publishedArchiveKey!;
  // The bundle is durable when Publish answers; the index catches up on its own, as it does for
  // a scout's submission, and the Scouts page redraws on `archive_changed`.
  let notesArchive!: { title: string; artifacts: Array<{ id: string; archivePath: string }> };
  await expect.poll(async () => {
    const res = await fetch(`${daemon.baseURL}/api/archives/${notesKey}`);
    if (!res.ok) return null;
    notesArchive = await res.json() as typeof notesArchive;
    return notesArchive.title;
  }, { timeout: 30_000 }).toBe("Release notes drafted");
  const notesPage = await fetch(`${daemon.baseURL}/api/archives/${notesKey}/artifacts/${notesArchive.artifacts[0]!.id}`);
  expect(await notesPage.text()).toContain("<table>");

  // The library cannot be written (the producer namespace made read-only, so the final rename
  // fails): the card says Mission Control failed, never that the document was refused, and the
  // same press works once the library is writable again.
  writeFileSync(join(session.cwd!, "unwritable.html"), DOCUMENT);
  await report(daemon, session.cwd!, { title: "Library unwritable", body: "Publishes after a retry.", file: "unwritable.html" });
  const namespace = join(daemon.home, "archives", producerId!);
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Library unwritable" });
  await card.getByRole("button", { name: "Library unwritable" }).click();
  chmodSync(namespace, 0o555);
  try {
    await card.getByRole("button", { name: "Publish as scout" }).click();
    const failure = card.getByRole("alert");
    await expect(failure).toContainText("Not published, and nothing is wrong with the document: ", { timeout: 30_000 });
    // The server's own reason leads the line: here, the rename the read-only namespace refused.
    await expect(failure).toContainText(/EACCES|permission denied/i);
    await expect(failure).not.toContainText("refused this document");
    await capture(card, "05b-card-publish-failed", page);
  } finally {
    chmodSync(namespace, 0o700);
  }
  await card.getByRole("button", { name: "Publish as scout" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Published" })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  writeFileSync(join(session.cwd!, "gone.html"), "<html><body><p>Soon gone</p></body></html>");
  const gone = await report(daemon, session.cwd!, { title: "Copy removed", body: "Its stored copy goes missing.", file: "gone.html" });
  const storedCopy = join(daemon.home, "reports", gone.id, "gone.html");
  expect(existsSync(storedCopy), `the stored copy is at ${storedCopy}`).toBe(true);
  unlinkSync(storedCopy);
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Copy removed" });
  await card.getByRole("button", { name: "Copy removed" }).click();
  await card.getByRole("button", { name: "Open report" }).click();
  const goneReader = page.getByRole("dialog", { name: "Report document: Copy removed" });
  await expect(goneReader.getByRole("alert"))
    .toContainText("The stored copy of gone.html is missing from Mission Control's state folder.", { timeout: 20_000 });
  await expect(goneReader.locator("iframe")).toHaveCount(0);
  await expectContentClearsBorder(goneReader);
  await capture(goneReader, "06-reader-missing-copy", page);
  await page.keyboard.press("Escape");
  await expect(goneReader).toBeHidden();

  writeFileSync(join(session.cwd!, "live.html"), "<html><body><p>Live page</p><script>fetch('/api/sessions')</script></body></html>");
  const refused = await report(daemon, session.cwd!, { title: "Live dashboard", body: "Has a script.", file: "live.html" });
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Live dashboard" });
  await card.getByRole("button", { name: "Live dashboard" }).click();
  await card.getByRole("button", { name: "Publish as scout" }).click();
  const alert = card.getByRole("alert");
  await expect(alert).toContainText("Not published.", { timeout: 30_000 });
  await expect(alert).toContainText("<script> is not allowed in an archived report");
  await expect(card.getByRole("button", { name: "Publish as scout" })).toBeVisible();
  await capture(card, "07-card-refused", page);
  const after = (await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`))
    .reports.find((r) => r.id === refused.id)!;
  expect(after.publishedArchiveKey).toBeNull();

  writeFileSync(join(session.cwd!, "tracking.html"),
    "<html><body><p>Tracking</p><script>fetch('/api/sessions')</script><img src=\"https://tracker.example/p.png\"></body></html>");
  const twoProblems = await report(daemon, session.cwd!, { title: "Tracking dashboard", body: "Script and a remote image.", file: "tracking.html" });
  card = inbox.getByRole("article", { name: "Report: Tracking dashboard" });
  await card.getByRole("button", { name: "Tracking dashboard" }).click();
  await card.getByRole("button", { name: "Publish as scout" }).click();
  const problems = card.getByRole("alert");
  await expect(problems).toContainText("Not published. The archive refused this document:", { timeout: 30_000 });
  await expect(problems.getByRole("listitem")).toHaveText([
    "<script> is not allowed in an archived report",
    "the https: scheme is not allowed in an archived report",
  ]);
  await capture(card, "08-card-refused-two-problems", page);
  // The refusal is the dashboard's, not the card's: it survives collapsing the card and closing
  // the inbox, until the next attempt.
  const bothProblems = [
    "<script> is not allowed in an archived report",
    "the https: scheme is not allowed in an archived report",
  ];
  await card.getByRole("button", { name: "Tracking dashboard" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await card.getByRole("button", { name: "Tracking dashboard" }).click();
  await expect(card.getByRole("alert").getByRole("listitem")).toHaveText(bothProblems);
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  inbox = await openInbox(page);
  card = inbox.getByRole("article", { name: "Report: Tracking dashboard" });
  if (!(await card.getByRole("button", { name: "Open report" }).isVisible())) {
    await card.getByRole("button", { name: "Tracking dashboard" }).click();
  }
  await expect(card.getByRole("alert").getByRole("listitem")).toHaveText(bothProblems);
  expect((await api<{ reports: ReportItem[] }>(daemon, `/api/sessions/${session.id}/reports`))
    .reports.find((r) => r.id === twoProblems.id)!.publishedArchiveKey).toBeNull();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  const entry = detail.getByRole("note", { name: "Report: Build failure diagnosed" });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  if (!(await entry.getByRole("button", { name: "Open report" }).isVisible())) {
    await entry.getByRole("button", { name: "Build failure diagnosed" }).click();
  }
  await entry.getByRole("button", { name: "Open report" }).click();
  const entryReader = page.getByRole("dialog", { name: "Report document: Build failure diagnosed" });
  await expect(entryReader.frameLocator('iframe[title="Report document: diagnosis.html"]')
    .getByRole("heading", { name: DOCUMENT_TITLE })).toBeVisible({ timeout: 20_000 });
  await expectContentClearsBorder(entryReader);
  await capture(entryReader, "09-reader-from-conversation-entry", page);
  await page.keyboard.press("Escape");
  await expect(entryReader).toBeHidden();
});
