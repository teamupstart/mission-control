import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The console detail's `PATH`/`BRANCH` band is the operator's to switch off, and switching
 * both cells off gives the conversation the band's height.
 *
 * Three things are at stake and only a browser can settle any of them:
 *
 *  1. Both cells ship VISIBLE, so a profile that has never opened Settings sees the band the
 *     previous release drew. That is what keeps `console-tabs-toolbar.spec.ts` and
 *     `native-worktree-dispatch.spec.ts` - which both read facts out of `.detail-sub` -
 *     unmodified by this change.
 *  2. Unchecking both removes the band ENTIRELY rather than emptying it. An empty `<dl>`
 *     keeps its padding and its border, so it would be a bar of chrome saying nothing, and
 *     no markup assertion distinguishes "absent" from "present and empty" the way a measured
 *     height does.
 *  3. The height really moves to the conversation. Stated as a SHARE of the pane rather than
 *     as a pixel count, following `console-tabs-toolbar.spec.ts`: the absolute figure is a
 *     function of the window and the font stack, while the split between the conversation
 *     and the fixed chrome above it is what this change moved.
 *
 * What is deliberately NOT here: the cases where the band survives both cells being hidden -
 * a speaking task chip and a multi-repo task's pull requests. Those need a scout task, a
 * re-assigned session or a second repository to exist, and each is a render-level fact about
 * one component that `test/console-detail-header.test.ts` pins in milliseconds. What a
 * browser is needed for is the height, and the height is the same measurement either way.
 *
 * No model tokens: every agent binary is redirected by `e2e/fixtures/fake-agents.ts`.
 */

const EVIDENCE = artifactsDir("conversation-band-optional");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // would land on top of the pane being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-band-optional/${name}.png`);
}

interface LiveSession {
  id: string;
  state: string;
  cwd: string;
  agent: string;
  agentSessionId: string | null;
  gitBranch: string | null;
}

/**
 * Dispatch one agent, settle it, and put it on a named branch the daemon has OBSERVED.
 *
 * The branch is not decoration here - it is the band's second cell, and a spec that hid two
 * preferences while only one cell was ever drawn would prove half of what it claims. A fresh
 * dispatch reports `gitBranch: null` because native branch acquisition is detached, so this
 * models what a working agent does (`git switch -c`) and then sends the same `Stop` hook the
 * agent's own harness sends, which is how the daemon observes a branch without host process
 * scans in the isolated browser fixture. `workflow-pull-request-mismatch.spec.ts` does the
 * same thing for the same reason.
 */
async function dispatchOnBranch(
  page: Page,
  daemon: DaemonHandle,
  goal: string,
  branch: string,
): Promise<LiveSession> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The combobox portals its listbox over the fields below and reopens on every keystroke.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session: LiveSession | undefined;
  await expect
    .poll(async () => {
      const sessions = await api<LiveSession[]>(daemon, "/api/sessions");
      session = sessions.find((item) => item.state !== "exited");
      // The cwd comes back with the state: a card is on screen before the registry has
      // necessarily finished adopting the worktree the dispatch was cut into.
      return session?.cwd ? session.state : "";
    }, { message: `the dispatch for "${goal}" settled with a checkout` })
    .toBe("idle");

  execFileSync("git", ["-C", session!.cwd, "switch", "-q", "-c", branch]);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const observed = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session!.agent,
      sessionId: session!.agentSessionId ?? session!.id,
      cwd: session!.cwd,
    }),
  });
  expect(observed.ok, "the branch observation hook was accepted").toBe(true);
  await expect
    .poll(async () =>
      (await api<LiveSession[]>(daemon, "/api/sessions")).find((item) => item.id === session!.id)
        ?.gitBranch ?? null,
    )
    .toBe(branch);
  return session!;
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Switch to the Console layout and open one session's detail, by name off the rail.
 *
 * Written to the daemon rather than to `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache.
 */
async function openConsoleDetail(page: Page, daemon: DaemonHandle, name: RegExp): Promise<Locator> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(((await response.json()) as { config?: { layout?: string } }).config?.layout).toBe(
    "console",
  );
  // Back to the fleet route FIRST, then a full document load. This helper is called from the
  // settings page as well as from the board, and `reload()` alone would reload whichever
  // route the page is on; the load itself is what makes a preference written out of band
  // take, because the web store hydrates from `GET /api/ui/config` at boot.
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();

  const rail = page.getByRole("navigation", { name: "Sessions" });
  await rail.getByRole("button", { name }).click();
  const detail = page.locator(".cdetail");
  await expect(detail).toBeVisible();
  return detail;
}

/**
 * The conversation's share of the whole detail pane.
 *
 * `.detail-conv` rather than the transcript log inside it: `.detail-sub` is a SIBLING of
 * `.detail-body`, so removing it grows the conversation against the pane, not the log
 * against the conversation. Measured against `.cdetail`, which is the pane the fixed chrome
 * and the conversation are dividing between them.
 */
async function conversationShare(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const pane = document.querySelector(".cdetail") as HTMLElement;
    const conv = document.querySelector(".detail-conv") as HTMLElement;
    return conv.getBoundingClientRect().height / pane.getBoundingClientRect().height;
  });
}

/** The two conversation-header checkboxes, on the Display settings page. */
function bandBoxes(page: Page): { path: Locator; branch: Locator } {
  return {
    path: page.getByRole("checkbox", { name: "Working directory", exact: true }),
    branch: page.getByRole("checkbox", { name: "Git branch", exact: true }),
  };
}

test("both band cells ship visible, switch off together, and give the conversation their height", async ({
  dashboard,
  daemon,
}) => {
  // A dispatch, a settle, a branch observation and four full page loads.
  test.setTimeout(180_000);
  await dispatchOnBranch(
    dashboard,
    daemon,
    "give the conversation the band back",
    "e2e/band-height",
  );
  const detail = await openConsoleDetail(
    dashboard,
    daemon,
    /Give the Conversation the Band Back/i,
  );

  // (1) The shipped state. Not "the defaults array is empty" - what a reader sees, which is
  // the form of the claim the two untouched specs depend on.
  const band = detail.locator(".detail-sub");
  await expect(band).toBeVisible();
  await expect(band.locator(".kv")).toHaveCount(2);
  await expect(band.getByText("path", { exact: true })).toBeVisible();
  await expect(band.getByText("branch", { exact: true })).toBeVisible();
  const before = await conversationShare(dashboard);
  await shoot(dashboard, detail, "01-band-shipped-visible");

  // The checkboxes are in the same panel Phase 1 built, under their own heading - which is
  // what tells them apart from the card's Branch and Worktree items sitting above them.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  await expect(panel.getByRole("heading", { name: "Conversation header" })).toBeVisible();
  const { path, branch } = bandBoxes(dashboard);
  await expect(path).toBeChecked();
  await expect(branch).toBeChecked();
  // Independent switches, not a re-labelling of the card's pair: the card's own Branch stays
  // checked while the console's goes off, which is the whole reason these are two more ids.
  const cardBranch = dashboard.getByRole("checkbox", { name: "Branch", exact: true });
  await expect(cardBranch).toBeChecked();
  // No picture of the panel here. It is taller than this spec's viewport, and an element
  // screenshot taken across a scroll is stitched rather than photographed - the seam reads
  // as a missing row. `board-card-preview.spec.ts` sets a viewport tall enough for the whole
  // checklist and owns that frame; this spec's subject is the pane, not the panel.

  await path.uncheck();
  await branch.uncheck();
  await expect(cardBranch).toBeChecked();

  // (2) Back to the console. The band is ABSENT, not emptied - a count, which an empty `<dl>`
  // with its padding and border would fail.
  const reopened = await openConsoleDetail(
    dashboard,
    daemon,
    /Give the Conversation the Band Back/i,
  );
  await expect(reopened.locator(".detail-sub")).toHaveCount(0);
  await expect(reopened.locator(".detail-head")).toBeVisible();
  await expect(reopened.locator(".detail-tabs")).toBeVisible();

  // (3) And the height went to the conversation. Measured on this machine at the fixture
  // viewport: 0.628 of the pane with the band, 0.739 without it - a band of ~11 points of
  // the pane. A 0.68 floor sits between the two with room on both sides, so it fails the
  // shipped behaviour and passes this one without being a rounding-direction assert on a
  // different font stack. The relative check is what actually says "it grew"; the floor is
  // what stops a pane that grew for some unrelated reason from satisfying it.
  const after = await conversationShare(dashboard);
  // eslint-disable-next-line no-console
  console.log(`conversation share: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
  expect(after, "the conversation did not take the retired band's height").toBeGreaterThan(0.68);
  expect(after, "the conversation is no larger than it was with the band").toBeGreaterThan(before);
  await shoot(dashboard, reopened, "02-band-hidden-conversation-grown");

  // A preference, not a one-way trim: checking them back on restores both cells.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const restored = bandBoxes(dashboard);
  await expect(restored.path).not.toBeChecked();
  await expect(restored.branch).not.toBeChecked();
  await restored.path.check();
  await restored.branch.check();

  const back = await openConsoleDetail(
    dashboard,
    daemon,
    /Give the Conversation the Band Back/i,
  );
  await expect(back.locator(".detail-sub")).toBeVisible();
  await expect(back.locator(".detail-sub .kv")).toHaveCount(2);
});

test("hiding one cell leaves the band standing for the other", async ({ dashboard, daemon }) => {
  // The guard asks the CONTAINER whether it has an occupant, not whether the preferences are
  // off. Half the pair hidden is the cheapest case that tells those two rules apart, and it
  // is the case a "hide the band when the cells are hidden" shortcut would get wrong.
  test.setTimeout(180_000);
  await dispatchOnBranch(
    dashboard,
    daemon,
    "keep the branch when the path goes",
    "e2e/band-half",
  );
  const before = await openConsoleDetail(dashboard, daemon, /Keep the Branch When the Path Goes/i);
  await expect(before.locator(".detail-sub .kv")).toHaveCount(2);

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await bandBoxes(dashboard).path.uncheck();

  const detail = await openConsoleDetail(dashboard, daemon, /Keep the Branch When the Path Goes/i);
  const band = detail.locator(".detail-sub");
  await expect(band).toBeVisible();
  await expect(band.locator(".kv")).toHaveCount(1);
  await expect(band.getByText("branch", { exact: true })).toBeVisible();
  await expect(band.getByText("path", { exact: true })).toHaveCount(0);
});
