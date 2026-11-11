import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page, Route } from "@playwright/test";
import type { WorktreeInventory } from "../../src/shared/worktrees.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Settings > Worktrees: the pool's dependency claim editor, each variable name's presence, and
// every slot dependency state. The claim really runs: a dispatched task leases a slot, and the
// claim's one step is a small Node program that waits on a gate file this spec writes, so the
// slot is observed installing, then current, then stale once origin's default moves, and a
// second dispatch is observed failing with its tail. Every agent binary stays faked.

const EVIDENCE = artifactsDir("settings-worktree-claims");

/** A real native dispatch is git worktree work on disk; see native-worktree-dispatch.spec.ts. */
const DISPATCH_SETTLES_MS = 45_000;

/** Values the daemon can resolve. Neither may ever reach the browser. */
const DAEMON_VALUE = `daemon-value-${process.pid}-${Date.now()}`;
const SHELL_VALUE = `login-shell-value-${process.pid}-${Date.now()}`;

/**
 * The daemon's login shell, replaced so the snapshot is hermetic: it prints the PATH it was
 * handed and one variable the daemon's own environment does not have. Written at module scope
 * because the daemon boots, with this as its SHELL, before a test body runs.
 */
const shellDir = mkdtempSync(join(tmpdir(), "mc-e2e-claim-shell-"));
const LOGIN_SHELL = join(shellDir, "login-shell");
writeFileSync(
  LOGIN_SHELL,
  [
    "#!/bin/sh",
    `printf '__MISSION_PATH__%s__MISSION_PATH__' "$PATH"`,
    `printf '__MISSION_VAR:MC_E2E_CLAIM_SHELL_TOKEN:__%s__MISSION_VAR:MC_E2E_CLAIM_SHELL_TOKEN:__' '${SHELL_VALUE}'`,
    "",
  ].join("\n"),
);
chmodSync(LOGIN_SHELL, 0o755);

test.use({ daemonEnv: { MC_E2E_CLAIM_DAEMON_TOKEN: DAEMON_VALUE, SHELL: LOGIN_SHELL } });

/**
 * The claim's step: wait for the gate file, print a line, and exit with the code it holds.
 * A non-zero code also writes a registry-shaped refusal, which is the tail the failed card shows.
 */
const STEP_SCRIPT = [
  `const fs = require("fs");`,
  `const gate = process.argv[1];`,
  `const wait = () => {`,
  `  if (!fs.existsSync(gate)) return setTimeout(wait, 50);`,
  `  const code = Number(fs.readFileSync(gate, "utf8"));`,
  `  console.log("resolving fixture packages");`,
  `  if (code) console.error("using token " + process.env.MC_E2E_CLAIM_DAEMON_TOKEN);`,
  `  if (code) console.error("E401 fixture registry refused the token");`,
  `  process.exit(code);`,
  `};`,
  `wait();`,
].join("\n");

/** Settings scrolls inside its own pane, so evidence is the element itself, scrolled into view. */
async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktree-claims/${name}.png`);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function dispatch(page: Page, daemon: DaemonHandle, intent: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function openPool(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = page.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  return pool;
}

/** The ordinal of the one slot whose dependencies are installing right now. */
async function installingOrdinal(pool: Locator): Promise<number> {
  const region = pool.getByRole("region", { name: /^Slot \d+ dependencies$/ }).filter({ hasText: "installing" });
  await expect(region).toHaveCount(1, { timeout: DISPATCH_SETTLES_MS });
  const label = await region.getAttribute("aria-label");
  return Number(/Slot (\d+) dependencies/.exec(label ?? "")?.[1]);
}

test("the claim editor saves through the settings route and every slot shows its dependency state", async ({
  dashboard,
  daemon,
}) => {
  // Two real dispatches into a pool, each waiting on a real claim. The default thirty seconds
  // covers the browser, not the disk underneath it.
  test.setTimeout(240_000);
  const gate = join(mkdtempSync(join(tmpdir(), "mc-e2e-claim-gate-")), "gate");
  try {
    // Manual leases create the pool before any claim is configured, so each is answered at once
    // with 201 and no slot has ever been installed; the second is later recorded as interrupted.
    const acquire = async (label: string) => {
      const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
        data: { repositoryPath: daemon.repo, label },
      });
      expect(response.status()).toBe(201);
      return await response.json() as { path: string; leaseId: string };
    };
    await acquire("never claimed");
    const cutOff = await acquire("claim cut off by a restart");
    const beforeRedaction = await acquire("failed under an earlier build");

    const pool = await openPool(dashboard, daemon);
    const editor = pool.getByRole("group", { name: "Dependency claim, run on every task lease" });
    await expect(editor.getByText("No claim is configured. Add a step to set one up.")).toBeVisible();

    // A draft the route refuses: the refusal lands beside each field it names.
    await editor.getByRole("button", { name: "Add step" }).click();
    await editor.getByLabel("Step 1 command, one argument per line").fill(
      [process.execPath, "-e", STEP_SCRIPT.replaceAll("\n", " "), gate].join("\n"),
    );
    await editor.getByLabel("Step 1 variable names").fill("MC_E2E_CLAIM_DAEMON_TOKEN bad-name");
    await editor.getByLabel("Claim timeout in minutes, for every step together").fill("0");
    await editor.getByLabel("Fingerprint paths, one repository-relative glob per line").fill("../README.md");
    const refused = dashboard.waitForResponse((response) =>
      response.url().endsWith("/api/worktrees/config") && response.request().method() === "PUT");
    await editor.getByRole("button", { name: "Save claim" }).click();
    expect((await refused).status()).toBe(400);
    const variables = editor.getByLabel("Step 1 variable names");
    await expect(variables).toHaveAttribute("aria-invalid", "true");
    await expect(variables).toHaveAccessibleDescription("bad-name: a variable name is letters, digits and underscores");
    await expect(editor.getByLabel("Claim timeout in minutes, for every step together")).toHaveAccessibleDescription(
      /expected number to be >=1/,
    );
    await expect(editor.getByLabel("Fingerprint paths, one repository-relative glob per line")).toHaveAccessibleDescription(
      /^\.\.\/README\.md: a fingerprint path is a repository-relative glob/,
    );
    await expect(editor.getByRole("alert")).toHaveText("The claim was not saved. Fix the fields marked above.");
    const unsaved = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees/config`)).json() as {
      config: { repositories: Record<string, { claim?: unknown }> };
    };
    expect(Object.values(unsaved.config.repositories).some((repo) => repo.claim)).toBe(false);
    await shoot(dashboard, editor, "01-claim-schema-errors-inline");

    // The corrected claim saves, and each name says where its value is, never what it is.
    await variables.fill("MC_E2E_CLAIM_DAEMON_TOKEN MC_E2E_CLAIM_SHELL_TOKEN MC_E2E_CLAIM_ABSENT_TOKEN");
    await editor.getByLabel("Claim timeout in minutes, for every step together").fill("5");
    await editor.getByLabel("Fingerprint paths, one repository-relative glob per line").fill("README.md");

    // A save whose request never reaches the daemon reports that inline and leaves the editor
    // usable: it does not stay "Saving…" with every action disabled.
    const dropPut = async (route: Route) => {
      if (route.request().method() === "PUT") await route.abort("failed");
      else await route.continue();
    };
    await dashboard.route("**/api/worktrees/config", dropPut);
    await editor.getByRole("button", { name: "Save claim" }).click();
    // No field is at fault, so the alert does not send the operator looking for one.
    await expect(editor.getByRole("alert")).toHaveText("The claim was not saved.");
    await expect(editor.locator(".wt-claim-errors .settings-error")).toHaveCount(1);
    await expect(variables).not.toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByRole("button", { name: "Save claim" })).toBeEnabled();
    await expect(editor.getByRole("button", { name: "Saving…" })).toHaveCount(0);
    await expect(editor.getByLabel("Step 1 variable names"))
      .toHaveValue("MC_E2E_CLAIM_DAEMON_TOKEN MC_E2E_CLAIM_SHELL_TOKEN MC_E2E_CLAIM_ABSENT_TOKEN");
    await dashboard.unroute("**/api/worktrees/config", dropPut);

    await editor.getByRole("button", { name: "Save claim" }).click();
    await expect(editor.getByRole("status")).toHaveText("Claim saved.");
    await expect(editor.getByRole("alert")).toHaveCount(0);
    const presence = editor.getByRole("list", { name: "Step 1 variable presence" });
    await expect(presence.getByRole("listitem").filter({ hasText: "MC_E2E_CLAIM_DAEMON_TOKEN" }))
      .toHaveText(/MC_E2E_CLAIM_DAEMON_TOKEN\s*present\s*in the daemon environment/);
    await expect(presence.getByRole("listitem").filter({ hasText: "MC_E2E_CLAIM_SHELL_TOKEN" }))
      .toHaveText(/MC_E2E_CLAIM_SHELL_TOKEN\s*present\s*in the login shell/);
    await expect(presence.getByRole("listitem").filter({ hasText: "MC_E2E_CLAIM_ABSENT_TOKEN" }))
      .toHaveText(/MC_E2E_CLAIM_ABSENT_TOKEN\s*missing\s*in neither the daemon environment nor the login shell/);
    const served = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).text();
    for (const value of [DAEMON_VALUE, SHELL_VALUE]) {
      expect(served).not.toContain(value);
      expect(await dashboard.content()).not.toContain(value);
    }
    await shoot(dashboard, editor, "02-claim-saved-presence");

    // Never installed, and interrupted: the second is a restart's record, seeded behind the
    // daemon's back because a restart mid-claim is not something a browser can do.
    withDaemonDb(daemon, (db) => {
      db.prepare("UPDATE worktree_slots SET deps_state = 'interrupted' WHERE path = ?").run(cutOff.path);
      // An earlier build stored failures as text, output included, before values were redacted
      // from it. This one holds the daemon's value, as a step that printed it would have.
      db.prepare("UPDATE worktree_slots SET deps_state = 'failed', deps_last_error = ? WHERE path = ?").run(
        `step 1 of 1 (pnpm install) exited with code 1\nusing token ${DAEMON_VALUE}\nE401 Unauthorized\n`,
        beforeRedaction.path,
      );
    });
    await dashboard.getByRole("button", { name: "Refresh" }).click();
    await expect(pool.getByRole("region", { name: "Slot 1 dependencies" })).toContainText("never installed");
    await expect(pool.getByRole("region", { name: "Slot 1 dependencies" }))
      .toContainText("No claim has run in this slot. Its next task lease runs every step.");
    await expect(pool.getByRole("region", { name: "Slot 2 dependencies" })).toContainText("interrupted");
    await expect(pool.getByRole("region", { name: "Slot 2 dependencies" }))
      .toContainText("A restart, or a stop during a seed, cut off this slot’s last claim. Its next claim removes the seed paths and starts cold.");
    // That earlier build's output is withheld, whatever it holds: only its summary line shows.
    const legacy = pool.getByRole("region", { name: "Slot 3 dependencies" });
    await expect(legacy).toContainText("failed");
    await expect(legacy).toContainText("step 1 of 1 (pnpm install) exited with code 1");
    await expect(legacy).toContainText(
      "This failure was recorded by an earlier version, before claim variable values were redacted from step output, so its output is not shown.",
    );
    await expect(legacy.getByLabel("Slot 3 dependency output tail")).toHaveCount(0);
    await expect(legacy).not.toContainText("E401 Unauthorized");
    const servedLegacy = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).text();
    expect(servedLegacy).not.toContain(DAEMON_VALUE);
    expect(await dashboard.content()).not.toContain(DAEMON_VALUE);

    // A dispatched task leases a slot and runs the claim: installing, with the step and a
    // counting elapsed time, arriving through the worktrees revision bump without a refresh.
    const leasedAt = git(daemon.repo, "rev-parse", "HEAD");
    await dispatch(dashboard, daemon, "Install fixture dependencies through the pool claim");
    await openPool(dashboard, daemon);
    const first = await installingOrdinal(pool);
    const firstDeps = pool.getByRole("region", { name: `Slot ${first} dependencies` });
    await expect(firstDeps).toContainText("Step 1 of 1 · ");
    await expect(firstDeps.getByLabel(/^Running command: /)).toContainText(`${process.execPath} -e`);
    const elapsed = firstDeps.getByText(/^\d+:\d\d elapsed$/);
    const before = await elapsed.textContent();
    await expect(elapsed).not.toHaveText(before ?? "", { timeout: 5_000 });
    await shoot(dashboard, pool.getByRole("article", { name: `Slot ${first}` }), "03-slot-installing");

    writeFileSync(gate, "0");
    await expect(firstDeps).toContainText("current", { timeout: DISPATCH_SETTLES_MS });
    await expect(firstDeps).toContainText(`at ${leasedAt.slice(0, 9)}`);
    await expect(firstDeps).toContainText(`Matches the fetched default branch at ${leasedAt.slice(0, 9)}.`);
    await shoot(dashboard, pool.getByRole("article", { name: `Slot ${first}` }), "04-slot-current");

    // origin's default moves a fingerprint path. Pushing updates the checkout's origin/main,
    // which is the last fetched default ref the inventory judges against; it never fetches.
    writeFileSync(join(daemon.repo, "README.md"), "# demo-repo\n\nDependencies changed.\n");
    git(daemon.repo, "commit", "-qam", "change a fingerprint path");
    git(daemon.repo, "push", "-q", "origin", "main");
    const moved = git(daemon.repo, "rev-parse", "origin/main");
    await dashboard.getByRole("button", { name: "Refresh" }).click();
    await expect(firstDeps).toContainText("stale");
    await expect(firstDeps).toContainText(
      `The fetched default branch at ${moved.slice(0, 9)} needs different dependencies. The next lease runs the claim again.`,
    );
    await expect(firstDeps).toContainText(`at ${leasedAt.slice(0, 9)}`);
    await shoot(dashboard, pool.getByRole("article", { name: `Slot ${first}` }), "05-slot-stale");

    // A second dispatch, at the moved commit, runs the claim again, and this time it fails.
    // The slot is handed over anyway, and its card keeps the failing step and the output tail.
    rmSync(gate);
    await dispatch(dashboard, daemon, "Run the pool claim against a refusing registry");
    await openPool(dashboard, daemon);
    const second = await installingOrdinal(pool);
    writeFileSync(gate, "3");
    const secondDeps = pool.getByRole("region", { name: `Slot ${second} dependencies` });
    await expect(secondDeps).toContainText("failed", { timeout: DISPATCH_SETTLES_MS });
    await expect(secondDeps).toContainText(
      "Step 1 of 1 exited with code 3 (no value for MC_E2E_CLAIM_ABSENT_TOKEN).",
    );
    await expect(secondDeps.getByLabel(/^Failed command: /)).toContainText(`${process.execPath} -e`);
    const tail = secondDeps.getByLabel(`Slot ${second} dependency output tail`);
    await expect(tail).toContainText("E401 fixture registry refused the token");
    // The step printed the value it was given. What reaches the card is the redaction.
    await expect(tail).toContainText("using token [MC_E2E_CLAIM_DAEMON_TOKEN redacted]");
    const servedAfterFailure = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).text();
    expect(servedAfterFailure).toContain("[MC_E2E_CLAIM_DAEMON_TOKEN redacted]");
    for (const value of [DAEMON_VALUE, SHELL_VALUE]) {
      expect(servedAfterFailure).not.toContain(value);
      expect(await dashboard.content()).not.toContain(value);
    }
    await expect(secondDeps).toContainText("The next lease runs the claim again.");
    await shoot(dashboard, pool.getByRole("article", { name: `Slot ${second}` }), "06-slot-failed");
    await shoot(dashboard, pool.getByRole("article", { name: "Slot 1" }), "07-slot-never-installed");
    await shoot(dashboard, pool.getByRole("article", { name: "Slot 2" }), "08-slot-interrupted");
    await shoot(dashboard, pool.getByRole("article", { name: "Slot 3" }), "09-slot-failed-before-redaction");

    const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
    const states = inventory.repositories.flatMap((repo) => repo.slots).map((slot) => slot.dependencies?.state);
    expect(states).toEqual(expect.arrayContaining(["never", "interrupted", "failed"]));
  } finally {
    rmSync(join(gate, ".."), { recursive: true, force: true });
  }
});

test("a refused field's error follows its step when an earlier step is removed", async ({ dashboard, daemon }) => {
  const created = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "claim editor step removal" },
  });
  expect(created.status()).toBe(201);
  const pool = await openPool(dashboard, daemon);
  const editor = pool.getByRole("group", { name: "Dependency claim, run on every task lease" });

  // Two steps, the second naming a variable the schema refuses.
  await editor.getByRole("button", { name: "Add step" }).click();
  await editor.getByRole("button", { name: "Add step" }).click();
  await editor.getByLabel("Step 1 command, one argument per line").fill("true");
  await editor.getByLabel("Step 2 command, one argument per line").fill("true");
  await editor.getByLabel("Step 2 variable names").fill("bad-name");
  await editor.getByRole("button", { name: "Save claim" }).click();
  await expect(editor.getByLabel("Step 2 variable names")).toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByLabel("Step 1 variable names")).not.toHaveAttribute("aria-invalid", "true");

  // Removing step 1 makes the refused step the first one, and its error moves with it.
  await editor.getByRole("button", { name: "Remove step 1" }).click();
  await expect(editor.getByLabel("Step 2 variable names")).toHaveCount(0);
  const moved = editor.getByLabel("Step 1 variable names");
  await expect(moved).toHaveValue("bad-name");
  await expect(moved).toHaveAttribute("aria-invalid", "true");
  await expect(moved).toHaveAccessibleDescription("bad-name: a variable name is letters, digits and underscores");
  await expect(editor.getByRole("alert")).toHaveText("The claim was not saved. Fix the fields marked above.");

  // Removing the refused step itself leaves no error behind on a field that is fine.
  await editor.getByRole("button", { name: "Add step" }).click();
  await editor.getByLabel("Step 2 command, one argument per line").fill("true");
  await editor.getByRole("button", { name: "Remove step 1" }).click();
  await expect(editor.getByLabel("Step 1 variable names")).toHaveValue("");
  await expect(editor.getByLabel("Step 1 variable names")).not.toHaveAttribute("aria-invalid", "true");
  await expect(editor.getByRole("alert")).toHaveCount(0);
});

test.afterAll(() => {
  rmSync(shellDir, { recursive: true, force: true });
});
