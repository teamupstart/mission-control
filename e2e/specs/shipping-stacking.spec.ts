import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { recordsIn } from "../fixtures/records.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Session, Task } from "../../src/shared/types.ts";
import type { ShippingConfig } from "../../src/shared/protocol.ts";

// Stacked pull requests, Phase 1, through the real dashboard and the real daemon:
//
//  - the Settings → Shipping card sets the default and it survives a reload;
//  - a dependency chip toggles Stack / After merge in the dispatch form and the backlog editor;
//  - a prerequisite whose fake agent finished with an open fake pull request releases its
//    dependent, whose card reads "Stacked on #N", and whose dispatch is pinned to the parent
//    branch's head and told which base to open against;
//  - the merge queue names both stacking holds.
//
// Every agent is a fake and every `gh` call goes to the fake, so no model tokens are spent and
// nothing reaches GitHub.

// The Inspector polls every second here (90s by default) so its merge gate runs inside the
// test; it is switched off by default, so the other cases never reach it.
test.use({ daemonEnv: { MISSION_PR_POLL_MS: "500", MISSION_INSPECTOR_POLL_MS: "1000" } });
const EVIDENCE = artifactsDir("shipping-stacking");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/shipping-stacking/${name}.png`);
}

function backlogTask(daemon: DaemonHandle, title: string, extra: object = {}): Promise<Task> {
  return api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent: title, kind: "ship", agent: "claude", backlog: true,
    workflowId: null, enabled: false, ...extra,
  });
}

async function boardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await page.goto(`${daemon.baseURL}/`);
}

test("the Stacked pull requests card sets the default and it survives a reload", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  const card = dashboard.locator("[data-anchor='shipping/stacking']");
  await expect(card).toBeVisible();
  const waitForMerge = card.getByRole("radio", { name: "Wait for merge (default)" });
  const stack = card.getByRole("radio", { name: "Stack on its branch" });
  // Shipped off, and nothing stored: the effective value is the shipped default.
  await expect(waitForMerge).toBeChecked();
  await expect(card).toContainText("Wait for merge - a dependent starts once its prerequisite merges");
  expect((await api<ShippingConfig>(daemon, "/api/shipping/config")).stacking).toBeUndefined();
  await expect(card).toContainText("never merges into a branch other than the default branch, never force-pushes");
  await expect(card).toContainText("Switching to Wait for merge stops new stacks only");

  // Saving another Shipping control does not pin the install to the default.
  const soak = dashboard.getByRole("spinbutton", { name: "minutes open before it may merge" });
  await soak.fill("7");
  await soak.blur();
  await expect.poll(async () => (await api<ShippingConfig>(daemon, "/api/shipping/config")).soakMinutes).toBe(7);
  expect((await api<ShippingConfig>(daemon, "/api/shipping/config")).stacking).toBeUndefined();

  await stack.locator("..").click();
  await expect.poll(async () => (await api<ShippingConfig>(daemon, "/api/shipping/config")).stacking).toBe("stack");
  await expect(card).toContainText("Stack - a dependent starts on its prerequisite's open pull request");
  const depth = card.getByRole("spinbutton", { name: "stacked pull requests above one on the default branch" });
  await expect(depth).toHaveValue("3");
  await depth.fill("2");
  await depth.blur();
  await expect.poll(async () => (await api<ShippingConfig>(daemon, "/api/shipping/config")).maxStackDepth).toBe(2);
  await shoot(card, "shipping-card");

  await dashboard.reload();
  await expect(dashboard.locator("[data-anchor='shipping/stacking']").getByRole("radio", { name: "Stack on its branch" })).toBeChecked();
  await expect(dashboard.locator("[data-anchor='shipping/stacking']").getByRole("spinbutton", { name: "stacked pull requests above one on the default branch" })).toHaveValue("2");
});

test("with Stack as the default, only a dependency that can stack earns the 'sooner' wait note", async ({ dashboard, daemon }) => {
  // A prerequisite in ANOTHER repository can never stack: a pull request has one base. With
  // the Shipping default set to Stack, the form must not promise it an early start.
  await api(daemon, "/api/shipping/config", { stacking: "stack" }, "PUT");
  const elsewhere = await backlogTask(daemon, "Groundwork in the other repo", { repoRoot: daemon.secondRepo });
  const same = await backlogTask(daemon, "Groundwork in this repo");
  await boardLayout(dashboard, daemon);

  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Work after both prerequisites");
  await dialog.getByRole("button", { name: "Backlog details" }).click();
  const add = dialog.getByRole("combobox", { name: "Add dependency" });
  const optionFor = (title: string) => add.evaluate((element, wanted) =>
    [...(element as HTMLSelectElement).options].find((option) => option.textContent?.includes(wanted))?.value ?? "",
  title);

  await add.selectOption(await optionFor(elsewhere.title));
  await expect(dialog.getByRole("group", { name: /When to start after Groundwork in the other repo/ })).toHaveCount(0);
  await expect(dialog).toContainText("and dispatches when their PRs merge.");
  await expect(dialog).not.toContainText("or sooner on a Stack dependency", { timeout: 1_000 });

  // A same-repository task prerequisite inheriting the Stack default does earn it.
  await add.selectOption(await optionFor(same.title));
  const group = dialog.getByRole("group", { name: /When to start after Groundwork in this repo/ });
  await expect(group.getByRole("button", { name: "Stack" })).toHaveAttribute("aria-pressed", "true");
  await expect(group).toContainText("default");
  await expect(dialog).toContainText("or sooner on a Stack dependency once its PR is open and every other dependency has merged.");
  await dialog.getByText(/Waits for \d+ dependenc/).scrollIntoViewIfNeeded();
  await shoot(dialog, "dispatch-wait-note-stackable-only");
});

test("a prerequisite whose pull request already merged offers no Stack control", async ({ dashboard, daemon }) => {
  test.setTimeout(120_000);
  // Stack is the default, so only the merge state can be what hides the control.
  await api(daemon, "/api/shipping/config", { stacking: "stack" }, "PUT");
  const parent = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, intent: "Land the merged groundwork", title: "Merged groundwork",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === parent.id)!;
    return session?.state && session.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  // The prerequisite's work, on a branch of its own, as a real agent would leave it.
  const git = (...args: string[]) => execFileSync("git", ["-C", session.cwd!, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" },
  }).trim();
  git("switch", "-c", "feat/merged-groundwork");
  writeFileSync(join(session.cwd!, "merged.txt"), "merged\n");
  git("add", "merged.txt");
  git("commit", "-q", "-m", "merged groundwork");
  const prUrl = "https://github.com/acme/mission-e2e/pull/41";
  writeGhPullRequests(daemon.home, [{
    cwd: session.cwd!, number: 41, url: prUrl, state: "MERGED", createdAt: new Date().toISOString(),
    mergedAt: new Date().toISOString(), headRefOid: git("rev-parse", "HEAD"), headRefName: "feat/merged-groundwork",
  }]);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  // PostToolUse only: the agent is still working after its pull request merged, so the task
  // is still running and its session is still offered as a prerequisite. (A Stop would let the
  // daemon settle the task as merged, and a finished task is not offered at all.)
  const res = await fetch(`${daemon.baseURL}/hooks/PostToolUse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent, sessionId: session.agentSessionId, cwd: session.cwd,
      toolName: "Bash", prCreated: true, prUrl, prUrls: [prUrl],
    }),
  });
  expect(res.status).toBe(204);
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.prState, { timeout: 30_000 }).toBe("merged");

  await boardLayout(dashboard, daemon);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Build on the merged groundwork");
  await dialog.getByRole("button", { name: "Backlog details" }).click();
  const add = dialog.getByRole("combobox", { name: "Add dependency" });
  // The picker fills from the live session list, which arrives over the event stream after
  // the page loads.
  let value = "";
  await expect.poll(async () => {
    value = await add.evaluate((element, title) =>
      [...(element as HTMLSelectElement).options].find((option) => option.textContent?.includes(title))?.value ?? "",
    parent.title);
    return value;
  }, { timeout: 30_000 }).not.toBe("");
  await expect(add.locator("option", { hasText: "Merged groundwork" })).toContainText("(merged)");
  await add.selectOption(value);
  await expect(dialog.locator(".dep-chip", { hasText: "Merged groundwork" })).toBeVisible();
  await expect(dialog.getByRole("group", { name: /When to start after Merged groundwork/ })).toHaveCount(0);
  await expect(dialog).not.toContainText("or sooner on a Stack dependency", { timeout: 1_000 });
  await dialog.getByText(/Dependencies each waits/).scrollIntoViewIfNeeded();
  await shoot(dialog, "dispatch-merged-prerequisite-no-stack");
});

test("a dependency chip toggles Stack / After merge in the dispatch form and the backlog editor", async ({ dashboard, daemon }) => {
  const parent = await backlogTask(daemon, "Phase one groundwork");
  await boardLayout(dashboard, daemon);

  // The dispatch form: a new task in the same repository depending on the backlog task.
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Phase two on top of phase one");
  await dialog.getByRole("button", { name: "Backlog details" }).click();
  const add = dialog.getByRole("combobox", { name: "Add dependency" });
  const value = await add.evaluate((element, title) =>
    [...(element as HTMLSelectElement).options].find((option) => option.textContent?.includes(title))?.value ?? "",
  parent.title);
  expect(value).not.toBe("");
  await add.selectOption(value);
  const group = dialog.getByRole("group", { name: /When to start after Phase one groundwork/ });
  await expect(group).toBeVisible();
  // Inherits the shipped default until changed, and says so.
  await expect(group.getByRole("button", { name: "After merge" })).toHaveAttribute("aria-pressed", "true");
  await expect(group).toContainText("default");
  await group.getByRole("button", { name: "Stack" }).click();
  await expect(group.getByRole("button", { name: "Stack" })).toHaveAttribute("aria-pressed", "true");
  await expect(group).not.toContainText("default");
  await expect(dialog).toContainText("or sooner on a Stack dependency once its PR is open and every other dependency has merged.");
  await shoot(dialog, "dispatch-chip-stack");
  await dialog.getByRole("button", { name: /Schedule after dependencies|Add to backlog/ }).first().click();
  await expect(dialog).toBeHidden();
  let child!: Task;
  await expect.poll(async () => {
    child = (await api<Task[]>(daemon, "/api/tasks")).find((task) => task.id !== parent.id && task.dependencies.length > 0)!;
    return child?.dependencies[0]?.type === "task" ? child.dependencies[0].mode : null;
  }).toBe("stack");

  // The backlog editor: the stored choice reads back, and can be flipped to After merge.
  await dashboard.reload();
  await dashboard.locator(".bl-card", { hasText: child.title }).getByRole("button", { name: child.title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor).toBeVisible();
  const editGroup = editor.getByRole("group", { name: /When to start after Phase one groundwork/ });
  await expect(editGroup.getByRole("button", { name: "Stack" })).toHaveAttribute("aria-pressed", "true");
  await editGroup.getByRole("button", { name: "After merge" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(async () => {
    const saved = (await api<Task[]>(daemon, "/api/tasks")).find((task) => task.id === child.id)!;
    return saved.dependencies[0]?.type === "task" ? saved.dependencies[0].mode : null;
  }).toBe("merge");
});

test("an explicit After merge choice overrides a Stack Shipping default, and survives a reopen", async ({ dashboard, daemon }) => {
  // The default is Stack, so an eligible dependency inherits Stack until told otherwise.
  await api(daemon, "/api/shipping/config", { stacking: "stack" }, "PUT");
  const parent = await backlogTask(daemon, "Schema groundwork");
  await boardLayout(dashboard, daemon);

  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Schema phase two after the groundwork merges");
  await dialog.getByRole("button", { name: "Backlog details" }).click();
  const add = dialog.getByRole("combobox", { name: "Add dependency" });
  const value = await add.evaluate((element, title) =>
    [...(element as HTMLSelectElement).options].find((option) => option.textContent?.includes(title))?.value ?? "",
  parent.title);
  expect(value).not.toBe("");
  await add.selectOption(value);
  const group = dialog.getByRole("group", { name: /When to start after Schema groundwork/ });
  await expect(group.getByRole("button", { name: "Stack" })).toHaveAttribute("aria-pressed", "true");
  await expect(group).toContainText("default");
  await expect(dialog).toContainText("or sooner on a Stack dependency");

  // The operator opts this one dependency out of stacking.
  await group.getByRole("button", { name: "After merge" }).click();
  await expect(group.getByRole("button", { name: "After merge" })).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByRole("button", { name: "Stack" })).toHaveAttribute("aria-pressed", "false");
  await expect(group).not.toContainText("default", { timeout: 1_000 });
  await expect(dialog).toContainText("and dispatches when their PRs merge.");
  await expect(dialog).not.toContainText("or sooner on a Stack dependency", { timeout: 1_000 });
  await shoot(dialog, "dispatch-after-merge-over-stack-default");
  await dialog.getByRole("button", { name: /Schedule after dependencies|Add to backlog/ }).first().click();
  await expect(dialog).toBeHidden();

  // Stored as an explicit choice, not left to inherit the Stack default.
  let child!: Task;
  await expect.poll(async () => {
    child = (await api<Task[]>(daemon, "/api/tasks")).find((task) => task.id !== parent.id && task.dependencies.length > 0)!;
    return child?.dependencies[0]?.type === "task" ? child.dependencies[0].mode ?? "inherit" : null;
  }).toBe("merge");

  // Reopened from the board after a reload, the choice reads back and still overrides Stack.
  await dashboard.reload();
  await dashboard.locator(".bl-card", { hasText: child.title }).getByRole("button", { name: child.title, exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor).toBeVisible();
  const editGroup = editor.getByRole("group", { name: /When to start after Schema groundwork/ });
  await expect(editGroup.getByRole("button", { name: "After merge" })).toHaveAttribute("aria-pressed", "true");
  await expect(editGroup.getByRole("button", { name: "Stack" })).toHaveAttribute("aria-pressed", "false");
  await expect(editGroup).not.toContainText("default", { timeout: 1_000 });
  await expect(editor).not.toContainText("or sooner on a Stack dependency", { timeout: 1_000 });
  // The Shipping default is still Stack: the override is per dependency, not a setting change.
  expect((await api<ShippingConfig>(daemon, "/api/shipping/config")).stacking).toBe("stack");
});

test("a finished prerequisite with an open pull request releases a stacked dependent that starts on its head", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  await api(daemon, "/api/shipping/config", { stacking: "stack" }, "PUT");
  // The fixture's origin is a local bare repository. A GitHub remote beside it is what lets the
  // daemon place the prerequisite's pull request in its PRIMARY repository; it is config only.
  execFileSync("git", ["-C", daemon.repo, "remote", "add", "github", "https://github.com/acme/mission-e2e.git"]);

  const parent = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, intent: "Build the parser groundwork", title: "Parser groundwork",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === parent.id)!;
    return session?.state;
  }, { timeout: 60_000 }).toBe("idle");
  // What a real agent does before opening its pull request: a branch, a commit, a push.
  const git = (...args: string[]) => execFileSync("git", ["-C", session.cwd!, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" },
  }).trim();
  git("switch", "-c", "feat/parser-groundwork");
  writeFileSync(join(session.cwd!, "groundwork.txt"), "groundwork\n");
  git("add", "groundwork.txt");
  git("commit", "-q", "-m", "groundwork");
  git("push", "-q", "origin", "feat/parser-groundwork");
  const head = git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/mission-e2e/pull/31";
  writeGhPullRequests(daemon.home, [{
    cwd: session.cwd!, number: 31, url: prUrl, state: "OPEN", createdAt: new Date().toISOString(),
    mergedAt: null, headRefOid: head, headRefName: "feat/parser-groundwork",
  }]);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  for (const event of ["PostToolUse", "Stop"]) {
    const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: session.agent, sessionId: session.agentSessionId, cwd: session.cwd,
        ...(event === "PostToolUse" ? { toolName: "Bash", prCreated: true, prUrl, prUrls: [prUrl] } : {}),
      }),
    });
    expect(res.status).toBe(204);
  }
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.prState, { timeout: 30_000 }).toBe("open");

  // The dependent inherits the Stack default from Settings.
  const child = await backlogTask(daemon, "Parser phase two", { dependencies: [{ type: "task", taskId: parent.id }] });
  await boardLayout(dashboard, daemon);
  const card = dashboard.locator(".bl-card", { hasText: child.title });
  await expect(card.locator(".bl-stacked")).toHaveText("Stacked on #31", { timeout: 30_000 });
  await expect(card.locator(".bl-blocked")).toHaveCount(0);
  const edge = (await api<Task[]>(daemon, "/api/tasks")).find((task) => task.id === child.id)!.dependencies[0]!;
  expect(edge.type === "task" && { ready: typeof edge.stackReadyAt, branch: edge.stackBaseBranch, url: edge.stackPrUrl, satisfied: edge.satisfiedAt })
    .toEqual({ ready: "number", branch: "feat/parser-groundwork", url: prUrl, satisfied: null });
  await shoot(card, "backlog-stacked-on");

  // Dispatching it pins the worktree to the parent branch's current head.
  await api(daemon, `/api/tasks/${child.id}/dispatch`, { overrideDisabled: true });
  let started!: Task;
  await expect.poll(async () => {
    started = (await api<Task[]>(daemon, "/api/tasks")).find((task) => task.id === child.id)!;
    return started.baseSha;
  }, { timeout: 60_000 }).toBe(head);
  expect({ parent: started.stackParentTaskId, branch: started.stackBaseBranch, sha: started.stackBaseSha, url: started.stackPrUrl })
    .toEqual({ parent: parent.id, branch: "feat/parser-groundwork", sha: head, url: prUrl });
  let childSession!: Session;
  // Settled, as the parent was: idle, with the agent session id its hooks are addressed by.
  // Captured any earlier, the hook below would name no session and nothing would be adopted.
  await expect.poll(async () => {
    childSession = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === child.id)!;
    return Boolean(childSession?.cwd && childSession.agentSessionId && childSession.state === "idle");
  }, { timeout: 60_000 }).toBe(true);
  expect(execFileSync("git", ["-C", childSession.cwd!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
  // Its task contract names the base its pull request belongs on.
  await expect.poll(async () => {
    const transcript = await api<{ messages: Array<{ role: string; text: string }> }>(daemon, `/api/sessions/${childSession.id}/transcript`);
    return transcript.messages.some((m) => m.role === "user" && m.text.includes("gh pr create --base feat/parser-groundwork") && m.text.includes("Stacked on #31"));
  }, { timeout: 30_000 }).toBe(true);
  // Until the child opens a pull request, nothing is written to GitHub at all.
  const gh = () => recordsIn<{ argv: string[] }>(daemon.recordDir, (file) => file.startsWith("gh-") && !file.startsWith("gh-patch-"));
  expect(gh().filter((call) => call.argv.includes("--method"))).toEqual([]);

  // ---- the child opens its pull request, against the WRONG base ----
  //
  // The agent ignores the instruction and targets main. Its PR reaches the daemon the way a real
  // `gh pr create` does: the PostToolUse hook, and the pull request on GitHub (the fake).
  const childGit = (...args: string[]) => execFileSync("git", ["-C", childSession.cwd!, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" },
  }).trim();
  childGit("switch", "-c", "feat/parser-phase-two");
  writeFileSync(join(childSession.cwd!, "phase-two.txt"), "phase two\n");
  childGit("add", "phase-two.txt");
  childGit("commit", "-q", "-m", "phase two");
  const childHead = childGit("rev-parse", "HEAD");
  const childPrUrl = "https://github.com/acme/mission-e2e/pull/32";
  const childPr = {
    cwd: childSession.cwd!, number: 32, url: childPrUrl, state: "OPEN" as const, createdAt: new Date().toISOString(),
    mergedAt: null, headRefOid: childHead, headRefName: "feat/parser-phase-two", baseRefName: "main",
  };
  const parentPr = { cwd: session.cwd!, number: 31, url: prUrl, state: "OPEN" as const, createdAt: new Date().toISOString(),
    mergedAt: null, headRefOid: head, headRefName: "feat/parser-groundwork" };
  writeGhPullRequests(daemon.home, [parentPr, childPr]);
  for (const event of ["PostToolUse", "Stop"]) {
    const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: childSession.agent, sessionId: childSession.agentSessionId, cwd: childSession.cwd,
        ...(event === "PostToolUse" ? { toolName: "Bash", prCreated: true, prUrl: childPrUrl, prUrls: [childPrUrl] } : {}),
      }),
    });
    expect(res.status).toBe(204);
  }

  // The daemon adopts it WITH its stack lineage, and corrects the base to the parent's branch:
  // one PATCH, carrying exactly that base.
  type Row = { key: string; mergeBlock: string | null; stack: { parentPrUrl: string; baseSha: string | null; note: string | null } | null };
  const row = async () => (await api<Row[]>(daemon, "/api/inspector/prs")).find((candidate) => candidate.key === "acme/mission-e2e#32");
  await expect.poll(async () => (await row())?.stack?.parentPrUrl, { timeout: 30_000 }).toBe(prUrl);
  expect((await row())!.stack!.baseSha).toBe(head);
  const patches = () => recordsIn<{ argv: string[]; input: string }>(daemon.recordDir, (file) => file.startsWith("gh-patch-"));
  await expect.poll(() => patches().length, { timeout: 30_000 }).toBe(1);
  expect(patches()[0]!.argv).toEqual(["api", "--method", "PATCH", "repos/acme/mission-e2e/pulls/32", "--input", "-"]);
  expect(JSON.parse(patches()[0]!.input)).toEqual({ base: "feat/parser-groundwork" });
  await expect.poll(async () => (await row())?.stack?.note).toBe("base moved from main to feat/parser-groundwork");
  // GitHub applies the edit.
  writeGhPullRequests(daemon.home, [parentPr, { ...childPr, baseRefName: "feat/parser-groundwork" }]);

  // ---- YOLO mode armed, and the daemon's own merge gate evaluates the child ----
  await api(daemon, "/api/inspector/config", { enabled: true, mode: "live", repoAllowlist: [daemon.repo] }, "PUT");
  await api(daemon, "/api/shipping/config", { autoMerge: true, repoAllowlist: [daemon.repo], soakMinutes: 0 }, "PUT");
  await expect.poll(async () => (await row())?.mergeBlock, { timeout: 30_000, message: "the Inspector tick evaluates the child's merge" })
    .toBe("stacked-base");
  // Several more ticks: it stays held, and nothing ever asks GitHub to merge.
  await dashboard.waitForTimeout(4_000);
  expect((await row())!.mergeBlock).toBe("stacked-base");
  const calls = gh();
  const merges = calls.filter((call) => call.argv.some((arg) => arg.endsWith("/merge")));
  expect(merges, "YOLO never merges a pull request whose base is not the default branch").toEqual([]);
  // The only write the daemon made on its own is that one base edit.
  expect(calls.filter((call) => call.argv.includes("--method")).map((call) => call.argv.slice(0, 4).join(" ")))
    .toEqual(["api --method PATCH repos/acme/mission-e2e/pulls/32"]);
  const observed = calls.map((call) => call.argv.join(" ").replace(/query=[\s\S]*$/, "query=<graphql>").slice(0, 140));
  console.log(`gh calls observed (${observed.length}, deduplicated):\n${[...new Set(observed)].map((line) => `  ${line}`).join("\n")}`);

  // And the merge queue shows the daemon's own verdict.
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  const queued = dashboard.locator(".sc-row").filter({ hasText: "mission-e2e#32" });
  await expect(queued).toContainText("stacked on another pull request's branch");
  await shoot(dashboard, "daemon-stacked-base-hold");
});

test("the merge queue names both stacking holds and a non-default base", async ({ dashboard, daemon }) => {
  const now = Date.now();
  await daemon.crash();
  withDaemonDb(daemon, (db) => {
    const insert = db.prepare(`INSERT INTO inspector_prs
      (key, url, owner, repo, number, repo_root, cwd, session_id, source, state, head_sha, review_posture,
       round, merge_block, observed_head_sha, observed_state, observed_at, head_ref_name, title, base_ref_name,
       stack_task_id, stack_episode, stack_adopted_at, stack_parent_pr_url, stack_base_sha, adopted_at, updated_at)
      VALUES (?, ?, 'acme', 'mission-e2e', ?, ?, ?, NULL, 'hook', 'open', 'head', 'live', 1, ?, 'head', 'OPEN', ?, ?, ?, ?,
              'child-task', 'ep1', ?, 'https://github.com/acme/mission-e2e/pull/40', ?, ?, ?)`);
    insert.run("acme/mission-e2e#41", "https://github.com/acme/mission-e2e/pull/41", 41, daemon.repo, daemon.repo,
      "stacked-base", now, "feat/child-a", "Child on its parent's branch", "feat/parent", now, "c".repeat(40), now, now);
    insert.run("acme/mission-e2e#42", "https://github.com/acme/mission-e2e/pull/42", 42, daemon.repo, daemon.repo,
      "stack-hold", now, "feat/child-b", "Child retargeted to main", "main", now, "c".repeat(40), now, now);
    // No stack lineage, opened against a release branch by hand: never a self-merge either.
    db.prepare(`INSERT INTO inspector_prs
      (key, url, owner, repo, number, repo_root, cwd, session_id, source, state, head_sha, review_posture,
       round, merge_block, observed_head_sha, observed_state, observed_at, head_ref_name, title, base_ref_name,
       adopted_at, updated_at)
      VALUES ('acme/mission-e2e#43', 'https://github.com/acme/mission-e2e/pull/43', 'acme', 'mission-e2e', 43, ?, ?,
              NULL, 'hook', 'open', 'head', 'live', 1, 'base-not-default', 'head', 'OPEN', ?, 'fix/backport',
              'Backport to release', 'release/next', ?, ?)`).run(daemon.repo, daemon.repo, now, now, now);
  });
  await daemon.restart();
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  const onParent = dashboard.locator(".sc-row").filter({ hasText: "mission-e2e#41" });
  const onMain = dashboard.locator(".sc-row").filter({ hasText: "mission-e2e#42" });
  await expect(onParent).toContainText("stacked on another pull request's branch");
  await expect(onMain).toContainText("stacked pull request held until it is restacked onto the default branch");
  await expect(dashboard.locator(".sc-row").filter({ hasText: "mission-e2e#43" }))
    .toContainText("its base is not, or is not known to be, the default branch");
  await shoot(dashboard, "merge-queue-holds");
});
