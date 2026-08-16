import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";
import { recordsIn } from "../fixtures/records.ts";

// One dispatch, several repositories.
//
// This is the only layer that can prove the feature: the chips are a browser control, the
// worktrees are a filesystem effect of a daemon route, and the write grant is argv on a
// process the daemon spawned. Nothing below a browser connects those three, and each of
// them can be individually correct while the thing an operator asked for did not happen.
//
// No model tokens: every agent binary is redirected at a fake by `fake-agents.ts`, and the
// fake claude records the argv it was launched with - which is what makes the write grant
// assertable rather than merely intended.

interface ProvisionedTask {
  intent: string;
  worktreePath: string | null;
  provider: string | null;
  worktreeLeaseId: string | null;
  extraRepos: Array<{
    repoRoot: string;
    worktreePath: string | null;
    provider: string | null;
    worktreeLeaseId: string | null;
  }>;
}

async function provisionedTask(daemon: DaemonHandle, intent: string): Promise<ProvisionedTask | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  if (!response.ok) return undefined;
  return ((await response.json()) as ProvisionedTask[]).find((task) => task.intent === intent);
}

/**
 * The argv of every fake-claude launch recorded so far.
 *
 * Through the shared `recordsIn`, which skips a file that is created but not yet filled -
 * the daemon registers a card before the child it spawned has finished writing, so an
 * unguarded read races the fixture rather than the behaviour under test.
 */
function launchArgvs(daemon: DaemonHandle): string[][] {
  return recordsIn<{ argv?: string[] }>(join(daemon.recordDir, "claude")).map((r) => r.argv ?? []);
}

/**
 * Fill the dispatch form and attach `extraRepos`, then launch.
 *
 * The `Escape` after each repo field is the same load-bearing step the single-repo helper
 * documents: `RepoCombobox` portals its listbox over the fields below it and opens on focus
 * AND on every keystroke, so the next `fill` would land on a covered control.
 */
async function dispatchAcross(
  page: Page,
  daemon: DaemonHandle,
  extraRepos: string[],
  task: string,
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");

  for (const repo of extraRepos) {
    await dialog.getByRole("button", { name: "Add another repo" }).click();
    await dialog.getByPlaceholder("repo to attach…").fill(repo);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Attach repo" }).click();
  }

  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog.getByLabel("Kind").selectOption("ship");
  // Pinned to none for the reason the single-repo helper gives: left at the dispatch
  // default, an unallowlisted repo is refused and the modal simply stays open.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");

  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(dialog).toBeHidden();
}

test("attaching a second repo dispatches one session with a native lease in each", async ({
  dashboard,
  daemon,
}) => {
  await dispatchAcross(dashboard, daemon, [daemon.secondRepo], "Rename the shared field");

  // ONE session. The whole design decision this phase implements is one agent in shared
  // context, not one agent per repository.
  const card = dashboard.locator("article.card").first();
  await expect(card).toBeVisible();
  await expect(dashboard.locator("article.card")).toHaveCount(1);

  await expect.poll(() => provisionedTask(daemon, "Rename the shared field"), {
    message: "the task should durably record both native leases",
  }).toMatchObject({
    provider: "mission",
    worktreeLeaseId: expect.any(String),
    extraRepos: [{
      repoRoot: daemon.secondRepo,
      provider: "mission",
      worktreeLeaseId: expect.any(String),
    }],
  });
  const task = (await provisionedTask(daemon, "Rename the shared field"))!;
  expect(task.worktreePath).toContain(join(daemon.home, "worktree-pools"));
  expect(task.extraRepos[0]?.worktreePath).toContain(join(daemon.home, "worktree-pools"));
  expect(task.extraRepos[0]?.worktreePath).not.toBe(task.worktreePath);

  // Each tree really belongs to its own repository. The failure a shared destination path
  // would have produced looks identical from the outside until the filesystem is asked.
  expect(existsSync(join(task.worktreePath!, "README.md"))).toBe(true);
  expect(existsSync(join(task.extraRepos[0]!.worktreePath!, "README.md"))).toBe(true);
});

for (const nextAction of ["Dispatch now", "Add to backlog"] as const) {
  test(`an attached repo is scoped to one task before ${nextAction}`, async ({
    dashboard,
    daemon,
  }) => {
    await dispatchAcross(dashboard, daemon, [daemon.secondRepo], "Change the shared contract");

    // The primary repo remains the useful per-run seed. The secondary was an exceptional
    // write grant for the task just sent, so the next draft must not silently inherit it.
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("search repos or type a path…")).toHaveValue(daemon.repo);
    await expect(
      dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` }),
    ).toHaveCount(0);

    const intent = `Follow-up through ${nextAction}`;
    await dialog.getByPlaceholder("What should this agent do?").fill(intent);
    await dialog.getByLabel("Kind").selectOption("ship");
    await dialog
      .locator("select")
      .filter({ hasText: "finish without a Workflow" })
      .selectOption("__none");
    await dialog.getByRole("button", { name: nextAction }).click();
    await expect(dialog).toBeHidden();

    // Assert the stored task, not only the absence of a pill: this is the server-visible
    // scope that decides how many worktrees are provisioned and which write grants launch.
    await expect
      .poll(async () => {
        const response = await fetch(`${daemon.baseURL}/api/tasks`);
        expect(response.ok, "/api/tasks should answer").toBe(true);
        const tasks = (await response.json()) as Array<{
          intent: string;
          extraRepos: Array<{ repoRoot: string }>;
        }>;
        return tasks
          .find((task) => task.intent === intent)
          ?.extraRepos.map((entry) => entry.repoRoot);
      })
      .toEqual([]);
  });
}

test("the launched agent is granted write access to the secondary worktree", async ({
  dashboard,
  daemon,
}) => {
  await dispatchAcross(dashboard, daemon, [daemon.secondRepo], "Rename the shared field");
  await expect(dashboard.locator("article.card").first()).toBeVisible();

  // The grant as it reaches the PROCESS, which is the only form of it that matters. A
  // capability record that says `--add-dir` and a launch that never renders it look the
  // same everywhere else.
  await expect
    .poll(() => launchArgvs(daemon).some((argv) => argv.includes("--add-dir")), {
      message: "the launched agent was handed the secondary worktree",
    })
    .toBe(true);

  const granted = launchArgvs(daemon).find((argv) => argv.includes("--add-dir"))!;
  const dir = granted[granted.indexOf("--add-dir") + 1];
  expect(dir, "the granted directory is the secondary WORKTREE, never the repo itself").toContain(
    join(daemon.home, "worktree-pools"),
  );
  expect(dir).not.toBe(daemon.secondRepo);
});

test("a single-repo dispatch is granted nothing extra", async ({ dashboard, daemon }) => {
  // The other half of the promise: a form nobody attached anything to sends no repos, and
  // the resulting command line is exactly what it was before this feature existed.
  await dispatchAcross(dashboard, daemon, [], "Write a haiku about flexbox");
  await expect(dashboard.locator("article.card").first()).toBeVisible();

  await expect.poll(async () => (await provisionedTask(daemon, "Write a haiku about flexbox"))?.provider)
    .toBe("mission");
  expect(launchArgvs(daemon).some((argv) => argv.includes("--add-dir"))).toBe(false);
});

test("an attached repo can be read and detached before dispatching", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");

  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();

  // The chip is short (a basename), and the full path is what the operator can act on -
  // two attached repos can share a basename, so the short form alone would be ambiguous.
  await expect(dialog.getByText("second-repo", { exact: true })).toBeVisible();
  const detach = dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` });
  await expect(detach).toBeVisible();

  await detach.click();
  await expect(dialog.getByText("second-repo", { exact: true })).toBeHidden();
  // Back to the plain single-repo form, with the adder still offered.
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeVisible();
});

test("a harness that cannot hold write access outside its cwd is not offered the control", async ({
  dashboard,
  daemon,
}) => {
  // pi declares no `multiRepoDispatch` - the capability is unmeasured, and null is the only
  // honest answer for it. The control disappearing is what stops an operator composing a
  // task that would launch an agent unable to write to half of it.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");

  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeVisible();
  await dialog.getByLabel("Agent").selectOption("pi");
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeHidden();

  // And switching back brings it straight back, so this is the capability talking rather
  // than a control that was torn down for good.
  await dialog.getByLabel("Agent").selectOption("claude");
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeVisible();
});

test("retyping the primary onto an attached repo blocks the dispatch instead of dropping it", async ({
  dashboard,
  daemon,
}) => {
  // The silent drop this closes: the chip stayed on screen, the submit stayed enabled, and
  // the dispatch went out single-repo with nothing said. An operator deciding the secondary
  // should really be the primary - and forgetting to detach the old chip - got a task that
  // quietly did half of what they asked.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();
  await dialog.getByPlaceholder("What should this agent do?").fill("Rename the shared field");

  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go, "a well-formed multi-repo dispatch is launchable").toBeEnabled();

  // Now point the primary at the repo that is already attached.
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");

  await expect(dialog.getByText(/is named twice/)).toBeVisible();
  await expect(go, "the doubled repo blocks the dispatch rather than being dropped").toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toBeDisabled();

  // Detaching the chip resolves it, so the block names something the operator can act on.
  await dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` }).click();
  await expect(dialog.getByText(/is named twice/)).toBeHidden();
  await expect(go).toBeEnabled();
});
