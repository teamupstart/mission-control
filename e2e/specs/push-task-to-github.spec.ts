import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { seedRepo, type DaemonHandle } from "../fixtures/daemon.ts";
import { FAKE_GH_ISSUE_ID, FAKE_GH_ISSUE_URL } from "../fixtures/fake-agents.ts";

/**
 * Filing a backlog task as a GitHub issue, from the editor that wrote it.
 *
 * Task sources have been strictly inbound since they shipped: a sweep files issues as backlog
 * rows, and there was no way to send a task the other direction - so work that started in
 * Mission Control stayed invisible to everyone sweeping the same repository. This is the one
 * outward verb, and it is what these specs drive end to end.
 *
 * Only this layer can see the claim. `test/github-issues-map.test.ts` pins the argv and the
 * three readings of an exit code, `test/task-source-push.test.ts` pins what commits with what,
 * and `test/backlog-edit-render.test.ts` pins each state the block renders - and none of them
 * can say that pressing the button in a browser reaches the route, reaches `gh`, and comes
 * back as a link a person can click. The chain runs: click -> POST /api/tasks/:id/push ->
 * pushTask -> the faked `gh` -> one transaction -> the reply's own `Task` -> the DOM.
 *
 * Nothing here spends model tokens (no task is ever dispatched) and nothing here reaches
 * GitHub: `MISSION_GH_BIN` points every `gh` call in the daemon at `FAKE_GH`, which records
 * its argv and prints the URL a real `gh issue create` would. That redirection is the reason
 * this spec is safe to run at all - unfaked, on any machine where `gh` is signed in, it would
 * file a real issue into a real repository on every pass.
 */

const EVIDENCE = artifactsDir("push-task-to-github");

/** The labels the seeded source sweeps on, and therefore the labels the issue must carry. */
const LABELS = ["mission", "triage"];

/**
 * A frame of a state the assertion beside it has just proved, behind `MC_E2E_EVIDENCE` so an
 * ordinary run does not rewrite a binary for no added signal.
 *
 * What a picture adds here is the half the DOM cannot carry: that the linked banner reads as
 * provenance rather than as an error, and that the action sits with the task's other facts
 * instead of competing with the footer's verbs.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The dialog is taller than the 720px default viewport and its BODY is what scrolls, so an
  // element screenshot at that size trails off into empty space below the fold. Grown for the
  // capture and put straight back, so the assertions around it keep running at the size every
  // other spec uses - the same trade `backlog-task-delete.spec.ts` makes for its footer.
  const restore = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1100 });
  // Off every control, pointer AND focus: `Tooltip` opens on either, and a bubble over the
  // banner would be the one thing in the frame that is not what the spec is about.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  if (restore) await page.setViewportSize(restore);
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/push-task-to-github/${name}.png`);
}

/** Configure the whole task-source list, through the route the settings panel writes with. */
async function putSources(
  page: Page,
  daemon: DaemonHandle,
  sources: Array<Record<string, unknown>>,
): Promise<void> {
  const res = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: { sources },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/**
 * A github-issues source over `repoRoot`, sweeping on this spec's two labels.
 *
 * `config` is overridable so a test can seed two sources that are eligible for the SAME task and
 * yet would file visibly different issues - which is the only way to prove which one was used.
 */
const githubSource = (
  id: string,
  repoRoot: string,
  label = "mission-control bugs",
  config: Record<string, unknown> = { labelsAny: LABELS },
) => ({
  id,
  kind: "github-issues",
  label,
  repoRoot,
  config,
});

/** Seed a backlog task and hand back its id. */
async function seedTask(daemon: DaemonHandle, title: string, intent: string): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `workflowId: null` opts the task out of the machine's default after-work Workflow, which
    // this repo is not allowlisted for - see the same note in `line-drawers.spec.ts`. The title
    // is given rather than derived, so the card this spec looks for is the card it named.
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent, backlog: true, workflowId: null }),
  });
  expect(res.ok, `seeding "${title}" answered ${res.status}`).toBe(true);
  const task = (await res.json()) as { id?: string };
  expect(task.id, "the daemon returned the seeded task").toBeTruthy();
  return task.id!;
}

/** The Board, the one layout that draws the backlog as a column of cards. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const res = await page.request.put(`${daemon.baseURL}/api/ui/config`, {
    data: { layout: "board" },
  });
  const body = (await res.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

/** Open a backlog card's editor through the control a keyboard can reach: its title. */
async function openEditor(page: Page, title: string): Promise<Locator> {
  const card = page.locator(".bl-card", { hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Every `gh` invocation the fake has recorded so far, newest last. */
function ghCalls(daemon: DaemonHandle): Array<{ argv: string[]; cwd: string }> {
  return readdirSync(daemon.recordDir)
    .filter((f) => f.startsWith("gh-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(daemon.recordDir, f), "utf8")) as { argv: string[]; cwd: string });
}

test("pushing a backlog task creates the issue, links the task, and records it as seen", async ({
  dashboard,
  daemon,
}) => {
  const title = "Retire the legacy poller";
  const intent = "Rip out the poller and its dead config, then delete the feature flag.";
  await putSources(dashboard, daemon, [githubSource("gh-e2e", daemon.repo)]);
  await seedTask(daemon, title, intent);
  await useBoardLayout(dashboard, daemon);

  const dialog = await openEditor(dashboard, title);
  const push = dialog.getByRole("button", { name: "Create GitHub issue" });
  await expect(push).toBeEnabled();
  await shoot(dashboard, "01-task-not-yet-filed", dialog);

  const pushed = dashboard.waitForResponse(
    (r) => r.request().method() === "POST" && /\/api\/tasks\/[^/]+\/push$/.test(r.url()),
  );
  await push.click();

  // (a) The link, in the spot the button was, naming the issue the daemon says it created.
  // This is the first time `Task.source` has been rendered anywhere in the dashboard.
  expect((await pushed).status(), "the daemon accepted the push").toBe(200);
  const link = dialog.getByRole("link", { name: FAKE_GH_ISSUE_ID });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", FAKE_GH_ISSUE_URL);
  // It opens away from the dashboard: a target-less anchor would navigate this tab, taking the
  // modal and any unsaved edit in it along.
  await expect(link).toHaveAttribute("target", "_blank");
  // And the action is gone, because a second push would be refused - the daemon will not link
  // a task twice, and a button that cannot work should not be standing there.
  await expect(dialog.getByRole("button", { name: "Create GitHub issue" })).toHaveCount(0);
  await shoot(dashboard, "02-task-linked-to-issue", dialog);

  // (b) Durable, not merely drawn. The link came off the route's own reply, so a row that
  // never took it would still show this - which is exactly the failure a read-back catches.
  await expect
    .poll(async () => {
      const res = await dashboard.request.get(`${daemon.baseURL}/api/tasks`);
      const tasks = (await res.json()) as Array<{ title?: string; source?: { externalId?: string; url?: string } }>;
      return tasks.find((t) => t.title === title)?.source ?? null;
    }, { message: "the pushed task should carry the issue it was filed as" })
    .toMatchObject({ externalId: FAKE_GH_ISSUE_ID, url: FAKE_GH_ISSUE_URL, sourceId: "gh-e2e" });

  // (c) What `gh` was actually asked to do. `expect.poll` rather than a bare read: the record
  // is written by a subprocess, and the DOM can settle before the file lands (trap 4).
  await expect
    .poll(() => ghCalls(daemon).filter((c) => c.argv[0] === "issue" && c.argv[1] === "create").length)
    .toBe(1);
  const create = ghCalls(daemon).find((c) => c.argv[0] === "issue" && c.argv[1] === "create")!;
  expect(create.argv).toEqual([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    intent,
    // One `--label` per label the SOURCE sweeps on, so the issue this files matches the filter
    // that would find it - otherwise the push creates work the source cannot see.
    "--label",
    "mission",
    "--label",
    "triage",
  ]);
  // Run inside the repo, which is the whole of this feature's authentication: `gh` resolves
  // the repository and the credential from the checkout it is run in.
  expect(create.cwd).toBe(daemon.repo);

  // (d) The seen row. This is what stops the source's next sweep from filing the issue this
  // push just created as a NEW backlog task - the duplicate that would make the whole feature
  // unusable - and it outlives the task, so push-then-delete stays deleted.
  await expect
    .poll(async () => {
      const res = await dashboard.request.get(`${daemon.baseURL}/api/task-sources/config`);
      const body = (await res.json()) as { status?: Array<{ sourceId: string; seenCount: number }> };
      return body.status?.find((s) => s.sourceId === "gh-e2e")?.seenCount ?? 0;
    }, { message: "the created issue must be remembered as already filed" })
    .toBe(1);
});

test("the picker decides which source files the issue, not just which name is shown", async ({
  dashboard,
  daemon,
}) => {
  // The picker is the one control here whose whole job is to change what gets PUBLISHED, and
  // reading its options proves nothing about that. `pushToSource` resolves the chosen source as
  // `eligible.find((s) => s.id === push?.sourceId) ?? eligible[0]`, so a broken selection
  // handler - or a selection that never reaches the state the push reads - falls back to the
  // first source silently, and the issue lands with another source's labels in another repo.
  // Nothing about the DOM would look wrong afterwards.
  //
  // So the two sources here are deliberately distinguishable in the argv rather than only in the
  // picker: different labels AND a different `--repo`. The docs promise that a pushed issue
  // "matches the filter that would find it"; this is the case that holds the promise to the
  // source the operator actually chose.
  const title = "Filed through the second source";
  const intent = "It must carry the labels of the source that was picked.";
  await putSources(dashboard, daemon, [
    githubSource("gh-first", daemon.repo),
    githubSource("gh-second", daemon.repo, "triage inbox", {
      labelsAny: ["chore", "backlog"],
      repo: "acme/other-repo",
    }),
  ]);
  await seedTask(daemon, title, intent);
  await useBoardLayout(dashboard, daemon);

  const dialog = await openEditor(dashboard, title);
  const picker = dialog.getByRole("combobox", { name: "GitHub issue source" });
  // It opens on the first, which is what makes choosing the second a real choice - a test that
  // selected the default would pass against a picker wired to nothing at all.
  await expect(picker).toHaveValue("gh-first");
  await picker.selectOption({ label: "triage inbox" });
  await expect(picker).toHaveValue("gh-second");

  const pushed = dashboard.waitForResponse(
    (r) => r.request().method() === "POST" && /\/api\/tasks\/[^/]+\/push$/.test(r.url()),
  );
  await dialog.getByRole("button", { name: "Create GitHub issue" }).click();
  expect((await pushed).status(), "the daemon accepted the push").toBe(200);
  await expect(dialog.getByRole("link", { name: FAKE_GH_ISSUE_ID })).toBeVisible();

  // What `gh` was handed, in full: the SECOND source's repo and labels, and one issue only.
  await expect
    .poll(() => ghCalls(daemon).filter((c) => c.argv[1] === "create").length)
    .toBe(1);
  const create = ghCalls(daemon).find((c) => c.argv[1] === "create")!;
  expect(create.argv).toEqual([
    "issue",
    "create",
    "--title",
    title,
    "--body",
    intent,
    "--repo",
    "acme/other-repo",
    "--label",
    "chore",
    "--label",
    "backlog",
  ]);
  // Stated from the other side too, because `toEqual` on a wrongly-ordered argv could in
  // principle still contain these: the default source's filter is nowhere in this request.
  expect(create.argv).not.toContain("mission");
  expect(create.argv).not.toContain("triage");

  // And the ledger followed the same choice. A seen row on the wrong source would let the next
  // sweep of the RIGHT one file this very issue back as a new task.
  await expect
    .poll(async () => {
      const res = await dashboard.request.get(`${daemon.baseURL}/api/task-sources/config`);
      const body = (await res.json()) as { status?: Array<{ sourceId: string; seenCount: number }> };
      return Object.fromEntries((body.status ?? []).map((s) => [s.sourceId, s.seenCount]));
    }, { message: "only the chosen source should have remembered filing this" })
    .toMatchObject({ "gh-first": 0, "gh-second": 1 });
});

test("an unknown outcome is withdrawn for that opening and that task, and no further", async ({
  dashboard,
  daemon,
}) => {
  // Withdrawing the button is the strongest thing this feature does to an operator, so where
  // the withdrawal ENDS is as load-bearing as where it starts. Two boundaries, both reachable
  // by clicking, both silent if they break:
  //
  //  1. Reopening the same task brings the action back. That is the documented recovery: go
  //     and look at GitHub, come back, decide. A withdrawal that outlived the opening would
  //     leave a task that can never be filed again and never say why - and the push surface
  //     sits inside a form whose DRAFT is deliberately kept across closes, so "this state
  //     survives a close" is a plausible thing for a later change to make true of all of it.
  //  2. A different task never inherits it, nor the issue link from a push that worked. A ref
  //     from another task would tell an operator that work they have not filed anywhere is
  //     already upstream.
  //
  // Today the second boundary holds twice over - `DispatchLayer` unmounts the dialog on close
  // and keys it on the task id - and the push state is additionally tagged with the task it
  // belongs to, so no arrangement of those can render one task's answer against another. This
  // asserts the operator-visible consequence, which is the thing that must stay true however
  // that is arranged.
  await putSources(dashboard, daemon, [githubSource("gh-scope", daemon.repo)]);
  await seedTask(daemon, "Filed first", "The one that really gets pushed.");
  await seedTask(daemon, "Fails once", "The one whose push does not report back.");
  await seedTask(daemon, "Never asked", "The one that must inherit nothing at all.");
  await useBoardLayout(dashboard, daemon);

  // A real push, which really links its own task.
  const first = await openEditor(dashboard, "Filed first");
  await first.getByRole("button", { name: "Create GitHub issue" }).click();
  await expect(first.getByRole("link", { name: FAKE_GH_ISSUE_ID })).toBeVisible();
  await first.getByRole("button", { name: "Cancel" }).click();
  await expect(first).toBeHidden();

  // The next task is untouched by it: its own action, and no link to somebody else's issue.
  const second = await openEditor(dashboard, "Fails once");
  await expect(second.getByRole("button", { name: "Create GitHub issue" })).toBeEnabled();
  await expect(second.getByText(/Filed upstream as/)).toHaveCount(0);

  // Now the failure that takes the button away.
  await dashboard.route("**/api/tasks/*/push", (route) =>
    route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({
        error: "gh issue create did not report back - the issue may exist; check GitHub before retrying",
        outcomeUnknown: true,
      }),
    }),
  );
  await second.getByRole("button", { name: "Create GitHub issue" }).click();
  await expect(second.locator(".source-provenance-warn")).toBeVisible();
  await expect(second.getByRole("button", { name: "Create GitHub issue" })).toHaveCount(0);
  await second.getByRole("button", { name: "Cancel" }).click();
  await expect(second).toBeHidden();

  // Boundary 1: the same task, reopened, can be filed again - the operator has been to look.
  const reopened = await openEditor(dashboard, "Fails once");
  await expect(reopened.getByRole("button", { name: "Create GitHub issue" })).toBeEnabled();
  await expect(reopened.locator(".source-provenance-warn")).toHaveCount(0);
  await reopened.getByRole("button", { name: "Cancel" }).click();
  await expect(reopened).toBeHidden();

  // Boundary 2: a task that was never pushed carries neither the warning nor the link.
  const third = await openEditor(dashboard, "Never asked");
  await expect(third.getByRole("button", { name: "Create GitHub issue" })).toBeEnabled();
  await expect(third.locator(".source-provenance-warn")).toHaveCount(0);
  await expect(third.getByText(/Filed upstream as/)).toHaveCount(0);

  // And exactly one issue was ever created, by the one task whose push reached the daemon.
  await expect
    .poll(() => ghCalls(daemon).filter((c) => c.argv[1] === "create").length)
    .toBe(1);
});

test("a refused push keeps the button, and an unknown outcome takes it away", async ({
  dashboard,
  daemon,
}) => {
  // The two failures are one test because the whole point is that they are DIFFERENT. A 502
  // means `gh` ran and said no, so nothing was published and retrying is safe; a 504 means it
  // never reported back, so the issue may exist and pressing again files a duplicate into a
  // tracker other people read. Reaching either through the real `gh` would mean breaking the
  // fake in two different ways mid-run; what is under test here is what the FORM does with an
  // answer, so the answers are fulfilled and the form is real.
  const title = "Answer badly on purpose";
  await putSources(dashboard, daemon, [githubSource("gh-refuse", daemon.repo)]);
  await seedTask(daemon, title, "This one is never actually filed.");
  await useBoardLayout(dashboard, daemon);

  let answer = {
    status: 502,
    body: { error: "could not add label: 'mission' not found" },
  };
  await dashboard.route("**/api/tasks/*/push", (route) =>
    route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    }),
  );

  const dialog = await openEditor(dashboard, title);
  const push = dialog.getByRole("button", { name: "Create GitHub issue" });
  await push.click();

  // Verbatim, beside a button that still works: the fix for a missing label is a minute away,
  // and a retry cannot duplicate anything that was never created.
  await expect(dialog.locator(".source-provenance-error")).toContainText(
    "could not add label: 'mission' not found",
  );
  await expect(push).toBeEnabled();
  await shoot(dashboard, "03-refusal-keeps-the-button", dialog);

  answer = {
    status: 504,
    body: {
      error: "gh issue create did not report back - the issue may exist; check GitHub before retrying",
      outcomeUnknown: true,
    },
  };
  await push.click();

  // Withdrawn rather than disabled. A disabled button promises that something will re-enable
  // it; here the correct next move is to go and look at GitHub, and the one thing that must not
  // happen is another press.
  await expect(dialog.locator(".source-provenance-warn")).toContainText(
    "check GitHub before retrying",
  );
  await expect(dialog.getByRole("button", { name: "Create GitHub issue" })).toHaveCount(0);
  // Nothing was linked by either answer, so the task is still an ordinary backlog row.
  const res = await dashboard.request.get(`${daemon.baseURL}/api/tasks`);
  const tasks = (await res.json()) as Array<{ title?: string; source?: unknown }>;
  expect(tasks.find((t) => t.title === title)?.source).toBe(null);
  await shoot(dashboard, "04-unknown-outcome-withdraws-it", dialog);
});

test("without an eligible source the action is absent, and says what to add", async ({
  dashboard,
  daemon,
}) => {
  // An absence is only worth asserting where the thing could have been present, so this test
  // earns its negative before claiming it: the same task, the same build, the same browser,
  // with the source list changed underneath. Without the second half, an action that never
  // rendered at all - or one deleted tomorrow - would pass this unchanged.
  const other = seedRepo(daemon.workspace, "other-repo");
  const title = "Nothing here can file this";
  // Neither of these can take this task, and for the two different reasons the daemon itself
  // refuses: Jira implements no outward verb at all, and a GitHub source bound to another repo
  // files against a repository this task is not based on.
  await putSources(dashboard, daemon, [
    { id: "jira-here", kind: "jira", label: "platform queue", repoRoot: daemon.repo },
    githubSource("gh-elsewhere", other, "someone else's repo"),
  ]);
  await seedTask(daemon, title, "It has no source that could receive it.");
  await useBoardLayout(dashboard, daemon);

  const dialog = await openEditor(dashboard, title);
  // The hint is what makes the absence legible: an action that appears on some tasks and not
  // others, with no explanation, reads as a bug rather than as a missing five-second setup.
  await expect(dialog.getByText(/add a GitHub Issues task source for this repo in Settings/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create GitHub issue" })).toHaveCount(0);
  await shoot(dashboard, "05-no-eligible-source", dialog);

  // Now make it possible. One source for THIS repo, and the same card, reopened.
  await putSources(dashboard, daemon, [
    { id: "jira-here", kind: "jira", label: "platform queue", repoRoot: daemon.repo },
    githubSource("gh-elsewhere", other, "someone else's repo"),
    githubSource("gh-here", daemon.repo),
  ]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  const reopened = await openEditor(dashboard, title);
  await expect(reopened.getByRole("button", { name: "Create GitHub issue" })).toBeVisible();
  // And still only one of the three is offered, so the picker that would name a choice between
  // them is correctly absent.
  await expect(reopened.getByRole("combobox", { name: "GitHub issue source" })).toHaveCount(0);
  await expect(reopened.getByText(/add a GitHub Issues task source/)).toHaveCount(0);
  await shoot(dashboard, "06-one-eligible-source", reopened);

  // A second source for the same repo, which is when the choice becomes real: two sources can
  // sweep different labels, so which one files the issue decides what the issue carries.
  await putSources(dashboard, daemon, [
    { id: "jira-here", kind: "jira", label: "platform queue", repoRoot: daemon.repo },
    githubSource("gh-elsewhere", other, "someone else's repo"),
    githubSource("gh-here", daemon.repo),
    githubSource("gh-second", daemon.repo, "triage inbox"),
  ]);
  await reopened.getByRole("button", { name: "Cancel" }).click();
  await expect(reopened).toBeHidden();

  const withPicker = await openEditor(dashboard, title);
  const picker = withPicker.getByRole("combobox", { name: "GitHub issue source" });
  await expect(picker).toBeVisible();
  // The two that can take it, and neither of the two that cannot.
  await expect(picker.locator("option")).toHaveText(["mission-control bugs", "triage inbox"]);
  await shoot(dashboard, "07-two-eligible-sources", withPicker);

  // Nothing was filed by any of it - the whole test is about a button, and it was never pressed.
  expect(ghCalls(daemon).filter((c) => c.argv[1] === "create")).toEqual([]);
});
