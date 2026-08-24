import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeInventory } from "../../src/shared/worktrees.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("settings-worktrees");

/**
 * How long an Execute is allowed to take to close its preview.
 *
 * A return is real git - a fetch, then a reset of a checkout on disk to the fetched remote
 * default - so this window is about the disk, not about the dialog. Measured at six to eight
 * seconds on a developer's machine, which is why the implicit five second one was a coin toss
 * on a busy box and failed the same way on a clean tree.
 */
const EXECUTES_MS = 30_000;

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktrees/${name}.png`);
}

test("Settings Worktrees configures, inventories, previews, blocks, launches, and stays bounded", async ({
  dashboard,
  daemon,
  context,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "settings evidence" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // Search is one route into the same registered category. The result lands on the native
  // inventory anchor, while the direct hash below proves the bookmark grammar too.
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("native worktree pools");
  await dashboard.getByRole("option", { name: /Native worktree pools/ }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/worktrees$/);
  await expect(dashboard.getByRole("tab", { name: /Worktrees/ })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText(/Mission Control owns these checkouts/)).toBeVisible();

  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  await expect(repo).toBeVisible();
  await repo.getByRole("button", { name: /demo-repo/ }).click();
  await expect(repo.getByText(lease.path)).toBeVisible();
  await expect(repo.getByText("leased", { exact: true })).toBeVisible();

  // Capacity edits are future-only. The saved one-slot maximum leaves this live lease in
  // place, and a second open dashboard converges through the content-free SSE invalidation.
  const second = await context.newPage();
  await second.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const secondMax = second.getByLabel("Default maximum native slots");

  // This page can only converge through an invalidation it is SUBSCRIBED to, and `goto`
  // resolves long before the stream is up. Editing in the gap sends the one event this
  // page needed while nothing is listening, after which it sits on the value it first
  // fetched and the assertion below waits out its timeout - a race in the fixture, not a
  // regression, and the one that made this spec fail under a loaded machine.
  //
  // Two readiness facts, because they are different claims and only both together close
  // the gap: the value proves this page's own fetch has LANDED (so a pass cannot be it
  // simply never having shown the old number), and the connection segment proves the
  // stream is UP - it is the app's own published state, and it names "reconnecting" for
  // exactly the window in which an invalidation would be dropped.
  const before = (await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json()) as {
    config: { maxSlots: number };
  };
  await expect(secondMax).toHaveValue(String(before.config.maxSlots));
  await expect(
    second.getByRole("button", { name: /^Keep awake - (?!Mission Control is reconnecting)/ }),
  ).toBeVisible();

  const defaultMax = dashboard.getByLabel("Default maximum native slots");
  await defaultMax.fill("4");
  await expect.poll(async () => (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json())
    .toMatchObject({ config: { maxSlots: 4 } });
  await expect(secondMax).toHaveValue("4");
  await second.close();

  // The capacity bar is the pane's answer to "do I have room". Its track width is the
  // configured maximum, so raising it to four leaves this one live lease holding a quarter
  // of the track - and every count on it is restated as text beside it, never by fill alone.
  const bar = repo.getByRole("img");
  await expect(bar).toHaveAttribute("aria-label", "1 leased, 0 available, 0 quarantined, 3 more may be created, maximum 4");
  // All four lifecycle counts are readable as text, zeroes included: the track has no
  // width to draw "0 quarantined" with, and that is exactly why the legend has to say it.
  for (const words of ["1 leased", "0 available", "0 quarantined", "3 more may be created"]) {
    await expect(repo.getByText(words, { exact: true })).toBeVisible();
  }
  await expect(repo.getByText("1 of 4 slots", { exact: true })).toBeVisible();
  await dashboard.getByText(/Mission Control owns these checkouts/).scrollIntoViewIfNeeded();
  await shoot(dashboard, "00-pools-populated");

  // Clipboard feedback and terminal opening both use their established abstractions. The
  // daemon's fake cmux records the latter, so no real external window opens in this suite.
  await repo.getByRole("button", { name: "Copy path" }).click();
  await expect(repo.getByRole("button", { name: "Copied" })).toBeVisible();
  await repo.getByLabel("Terminal backend for slot 1").selectOption("cmux");
  await repo.getByRole("button", { name: "Open terminal" }).click();
  await expect.poll(() => readdirSync(daemon.recordDir).filter((name) => name.startsWith("cmux-")).length).toBe(1);

  // A clean manual lease has an actionable preview, with focus inside the dialog and the
  // fixed server-resolved path visible before execution.
  await repo.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(lease.path)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expect(preview.locator(":focus")).toBeVisible();
  await shoot(dashboard, "02-actionable-return-preview");
  const staleFile = join(lease.path, "appeared-after-preview.txt");
  writeFileSync(staleFile, "state changed\n");
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview.getByText("State changed after this preview.")).toBeVisible();
  await preview.getByRole("button", { name: "Refresh preview" }).click();
  await expect(preview.getByText(/Dirty or untracked work will be discarded/)).toBeVisible();
  await preview.getByRole("button", { name: "Cancel" }).click();
  unlinkSync(staleFile);

  // A process whose cwd is the leased path is an unacknowledgeable blocker. The preview
  // may name the count, never its command line, and Execute remains unavailable.
  const occupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path,
    stdio: "ignore",
  });
  try {
    await dashboard.waitForTimeout(200);
    await repo.getByRole("button", { name: "Return", exact: true }).click();
    const blocked = dashboard.getByRole("dialog", { name: "return worktree preview" });
    await expect(blocked.getByText("Cannot execute")).toBeVisible();
    await expect(blocked.getByText(/Known processes must exit/)).toBeVisible();
    await expect(blocked.getByRole("button", { name: "Execute" })).toBeDisabled();
    await shoot(dashboard, "03-process-blocker");
    await blocked.getByRole("button", { name: "Cancel" }).click();
  } finally {
    occupant.kill("SIGKILL");
  }

  // Legacy capability is isolated from native inventory, which stays fully usable whether
  // this machine has the compatibility binary or not.
  await expect(dashboard.getByRole("heading", { name: "Treehouse", exact: true })).toBeVisible();
  await shoot(dashboard, "01-desktop-inventory-and-legacy", true);

  // A missing binary has a direct remediation and does not erase the native ledger.
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const missingPage = await context.newPage();
  await missingPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      legacy: {
        capability: { kind: "missing", version: null, diagnostic: "Treehouse is not installed; install v2.1.1 or newer to drain historical leases." },
        totals: { ownedExact: 0, identityUnverifiable: 0, foreign: 0, unreadable: 0 },
        items: [],
      },
    } satisfies WorktreeInventory),
  }));
  await missingPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(missingPage.getByText(/Treehouse is not installed/)).toBeVisible();
  await expect(missingPage.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
  await missingPage.close();

  // The built panel renders the complete legacy classification vocabulary. Only an exact
  // persisted owner gets an action; unverifiable, foreign, and unreadable rows stay diagnostic.
  const legacyPage = await context.newPage();
  await legacyPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      legacy: {
        capability: { kind: "conditional-json", version: "v2.1.1", diagnostic: null },
        totals: { ownedExact: 1, identityUnverifiable: 1, foreign: 1, unreadable: 1 },
        items: [
          { id: "legacy-exact", classification: "ownedExact", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/exact`, owner: { kind: "task", id: "task-exact", position: 0 }, leaseId: "lease-exact", holder: "mission-control", acquiredAt: "2026-08-16T12:00:00Z", processes: { state: "known", count: 0, reason: null }, dirty: false, canReturn: true, diagnostic: null },
          { id: "legacy-unverifiable", classification: "identityUnverifiable", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/unverifiable`, owner: { kind: "task", id: "task-old", position: 0 }, leaseId: null, holder: "mission-control", acquiredAt: null, processes: { state: "unknown", count: null, reason: "identity unavailable" }, dirty: null, canReturn: false, diagnostic: "Treehouse cannot prove the historical lease identity." },
          { id: "legacy-foreign", classification: "foreign", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/foreign`, owner: null, leaseId: "lease-foreign", holder: "someone-else", acquiredAt: "2026-08-16T12:00:00Z", processes: { state: "known", count: 0, reason: null }, dirty: false, canReturn: false, diagnostic: "This lease belongs to another holder." },
          { id: "legacy-unreadable", classification: "unreadable", repoRoot: daemon.repo, path: daemon.repo, owner: null, leaseId: null, holder: null, acquiredAt: null, processes: { state: "unknown", count: null, reason: "status unavailable" }, dirty: null, canReturn: false, diagnostic: "Treehouse status could not be read." },
        ],
      },
    } satisfies WorktreeInventory),
  }));
  await legacyPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(legacyPage.getByRole("button", { name: "Return legacy lease" })).toHaveCount(1);
  for (const classification of ["identityUnverifiable", "foreign", "unreadable"]) {
    await expect(legacyPage.getByText(classification, { exact: true })).toBeVisible();
  }
  await expect(legacyPage.getByText("Force", { exact: true })).toHaveCount(0);
  await shoot(legacyPage, "05-legacy-classification-gates", true);
  await legacyPage.close();

  // The page itself never overflows sideways. Slot detail owns the bounded horizontal
  // scroll at a narrow viewport, and every policy/legacy card stacks within the pane.
  await dashboard.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dashboard.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 390, scroll: 390 });
  await expect(repo).toBeVisible();
  await shoot(dashboard, "04-narrow-inventory", true);
});

test("refreshing a preview drops acknowledgements that the new token does not require", async ({
  dashboard,
  daemon,
}) => {
  // Two previews and a real return, and a return is `git fetch` plus a reset to the fetched
  // remote default on a checkout on disk. That is seconds of git per Execute, so the default
  // thirty is a budget for the browser and not for the work underneath it.
  test.setTimeout(120_000);
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "acknowledgement refresh" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string };
  const dirtyFile = join(lease.path, "dirty-before-preview.txt");
  writeFileSync(dirtyFile, "preview this risk\n");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  await repo.getByRole("button", { name: /demo-repo/ }).click();
  await repo.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  const dirtyAcknowledgement = preview.getByRole("checkbox", {
    name: /Dirty or untracked work will be discarded/,
  });
  await dirtyAcknowledgement.check();

  unlinkSync(dirtyFile);
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview.getByText("State changed after this preview.")).toBeVisible();
  await preview.getByRole("button", { name: "Refresh preview" }).click();
  await expect(dirtyAcknowledgement).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await preview.getByRole("button", { name: "Execute" }).click();
  // The dialog closes when the return has actually happened, and measuring it says the return
  // takes six to eight seconds here - so the implicit five-second window was asserting that
  // git is fast rather than that the preview closes. `EXECUTES_MS` is the honest one.
  await expect(preview).toHaveCount(0, { timeout: EXECUTES_MS });
});

/**
 * The three states the pane used to render as a heading over nothing, plus the one state
 * a number input cannot express.
 *
 * Loading, empty, and unavailable are three distinguishable conditions on the wire and
 * must look like three different things: an outage and an empty machine especially must
 * never read alike. Over capacity is driven from a routed inventory rather than the live
 * one because the only way to reach it for real is a maximum below the live slot count,
 * and the input's floor is one - which is the point, since lowering the maximum is allowed
 * to make the state visible and is never allowed to prune to fix it.
 *
 * The right-size preview at the end goes to the real daemon with the real pool id, so the
 * unchanged preview-first protocol is proved under the new presentation.
 */
test("Settings Worktrees gives loading, empty, unavailable, and over capacity real copy", async ({
  dashboard,
  daemon,
  context,
}) => {
  // A pool exists only once something has needed a checkout, which is the empty state's
  // whole point - so acquire one lease first and read the real inventory back.
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "capacity states" },
  });
  expect(acquired.status()).toBe(201);
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const pool = current.repositories[0];
  expect(pool).toBeDefined();

  // Loading: the group has shape - skeleton rows and a sentence - before the fetch lands.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowPage = await context.newPage();
  await slowPage.route("**/api/worktrees", async (route) => {
    await gate;
    await route.continue();
  });
  await slowPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(slowPage.getByRole("heading", { name: "Pools", exact: true })).toBeVisible();
  await expect(slowPage.getByText("Observing Git, process, and provider state…")).toBeVisible();
  await expect(slowPage.locator(".wt-skeleton")).toHaveCount(2);
  await shoot(slowPage, "06-pools-loading");
  release();
  await expect(slowPage.getByText("Observing Git, process, and provider state…")).toHaveCount(0);
  await slowPage.close();

  // Empty: an invitation to act, not a report of absence.
  const emptyPage = await context.newPage();
  await emptyPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ...current, repositories: [] } satisfies WorktreeInventory),
  }));
  await emptyPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(emptyPage.getByText("No pools yet.")).toBeVisible();
  await expect(emptyPage.getByText(/the first time something needs a checkout in a repository/)).toBeVisible();
  await shoot(emptyPage, "07-pools-empty");
  await emptyPage.close();

  // Unavailable: says the state could not be observed and offers Refresh. It must not
  // claim zero pools, which is what an operator would act on by creating one.
  const downPage = await context.newPage();
  await downPage.route("**/api/worktrees", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await downPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(downPage.getByText("Pool capacity could not be observed.")).toBeVisible();
  await expect(downPage.getByText(/This is an outage, not an empty machine/)).toBeVisible();
  await expect(downPage.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(downPage.getByText("No pools yet.")).toHaveCount(0);
  await shoot(downPage, "09-pools-unavailable");
  await downPage.close();

  // Over capacity: labelled in words on the bar, in the legend, and in the row's sentence.
  const overPage = await context.newPage();
  await overPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      repositories: [{
        ...pool!,
        status: "attention",
        policy: { ...pool!.policy, maxSlots: 16 },
        counts: { total: 18, leased: 17, available: 0, quarantined: 1, overCapacity: 2 },
      }],
    } satisfies WorktreeInventory),
  }));
  await overPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const overRow = overPage.locator(".wt-pool", { hasText: "demo-repo" });
  await expect(overRow.getByRole("img", { name: "17 leased, 0 available, 1 quarantined, 0 more may be created, 2 over the maximum, maximum 16" })).toBeVisible();
  for (const words of ["17 leased", "0 available", "1 quarantined", "0 more may be created", "2 over the maximum"]) {
    await expect(overRow.getByText(words, { exact: true })).toBeVisible();
  }
  await expect(overRow.getByText(/2 slots are over the maximum of 16\. Nothing was pruned to say so\./)).toBeVisible();
  await shoot(overPage, "08-pool-over-capacity");

  // The track is the configured maximum, so 17 leased against a ceiling of 16 saturates it
  // rather than rescaling it to the 18 slots that exist. The spill is the fixed-width cap
  // at the track's end plus the counts in words above - never a wider bar.
  await expect.poll(() => overRow.locator(".wt-bar-seg").evaluateAll(
    (nodes) => nodes.map((node) => (node as HTMLElement).style.width),
  )).toEqual(["100%"]);
  await expect(overRow.locator(".wt-bar-over")).toHaveCSS("width", "13px");

  // The row's own remedy is preview-first against the real pool, and cancelling changes
  // nothing - the same protocol the rest of this pane has always used.
  await overRow.getByRole("button", { name: "Preview right-size" }).click();
  const rightSize = overPage.getByRole("dialog", { name: "prune worktree preview" });
  await expect(rightSize).toBeVisible();
  await expect(rightSize.getByRole("heading", { name: /Prune worktree/ })).toBeVisible();
  await rightSize.getByRole("button", { name: "Cancel" }).click();
  await expect(rightSize).toHaveCount(0);
  await expect(overRow.getByRole("button", { name: "Preview right-size" })).toBeFocused();
  await overPage.close();
});

/**
 * A refresh that fails is not an outage, and must not be drawn as one.
 *
 * The panel greys every control on `!config` and falls the maximum-slots box back to a
 * hardcoded 16. So discarding a good inventory because ONE refresh failed does not merely
 * lose detail - it tells an operator whose maximum is 4 that their maximum is 16, in an
 * enabled-looking number field, with no marker saying the value is a placeholder. That is
 * the failure worth a spec: not "the panel went blank", but "the panel lied about a
 * setting". The real outage state - never having observed anything - still has to read as
 * an outage, which is the second half of this test.
 */
test("a failed refresh keeps the observed inventory instead of blanking it to a placeholder", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const maxSlots = dashboard.getByLabel("Default maximum native slots");
  await expect(maxSlots).toBeEnabled();
  await maxSlots.fill("4");
  await expect
    .poll(async () => (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json())
    .toMatchObject({ config: { maxSlots: 4 } });
  await expect(maxSlots).toHaveValue("4");

  // Exactly one refresh fails, the way a busy daemon drops one.
  let failures = 0;
  await dashboard.route("**/api/worktrees", async (route) => {
    if (route.request().method() === "GET" && failures === 0) {
      failures += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  // "Refresh" is the button's own text; the long sentence beside it is a Tooltip, which
  // renders as `aria-describedby` and is deliberately NOT the accessible name.
  await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();

  // The number the operator set is still the number on screen, and still editable. The
  // banner says the refresh failed - above data the panel still trusts, not instead of it.
  await expect(maxSlots).toHaveValue("4");
  await expect(maxSlots).toBeEnabled();
  await expect(dashboard.getByText("Worktree inventory is unavailable.")).toBeVisible();
  await expect(dashboard.getByText("Pool capacity could not be observed.")).toHaveCount(0);
});
