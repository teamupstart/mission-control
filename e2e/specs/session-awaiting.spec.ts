import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import type { Session } from "../../src/shared/types.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { api, connect, dispatch } from "../fixtures/session-control.ts";

const FLAG = "session-awaiting";
const EVIDENCE = artifactsDir("session-awaiting");
const WAIT = {
  what: "CI checks on PR #1612",
  wakeSource: "command",
  referenceUrl: "https://github.com/teamupstart/mission-control/pull/1612/checks",
  details: "Started `gh pr checks 1612 --watch` in the background. [Run log](https://github.com/teamupstart/mission-control/actions)",
};

async function setFlag(daemon: DaemonHandle, enabled: boolean): Promise<void> {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: FLAG, enabled }, "PUT");
}

async function session(daemon: DaemonHandle, id: string): Promise<Session | undefined> {
  return (await api(daemon, "/api/sessions") as Session[]).find((s) => s.id === id);
}

/** The declaration as the agent sends it: a required `expectedBy`, twenty minutes out. */
function declaration(): typeof WAIT & { expectedBy: string } {
  return { ...WAIT, expectedBy: new Date(Date.now() + 20 * 60_000).toISOString() };
}

function toolText(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? "").join("\n");
}

async function useBoard(page: Page, daemon: DaemonHandle): Promise<void> {
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  // A reload, not a hash navigation: the layout is read when the dashboard loads.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await ("mouse" in target ? target : target.page()).mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/session-awaiting/${name}.png`);
}

/**
 * A session idle on purpose while a background process finishes, end to end: the session's own
 * agent declares the wait through the real `report_awaiting` tool, and the dashboard draws it as
 * a deadline track under Idle's Awaiting rule, never in Needs you. The Conversation tab shows the
 * calm band with Clear. The wait survives a daemon restart, turns Overdue once its deadline
 * passes (the page's clock is moved, not the test's patience), leaves the Awaiting section, and
 * Clear ends it.
 */
test("a declared wait draws a deadline track under Idle's Awaiting rule, survives a restart, turns Overdue, and clears", async ({
  dashboard: page,
  daemon,
}) => {
  test.setTimeout(180_000);
  await setFlag(daemon, true);
  const agent = await dispatch(daemon, "Awaiting CI");
  await useBoard(page, daemon);
  const client = await connect(daemon, agent);
  try {
    const declared = await client.callTool({ name: "report_awaiting", arguments: declaration() });
    expect(declared.isError, toolText(declared)).toBeFalsy();
    expect(toolText(declared)).toContain("Wait recorded");
  } finally {
    await client.close();
  }

  // The Idle column groups it under its own rule, counts it, and nothing enters Needs you.
  const idle = page.locator("main.board section.board-col.tone-idle");
  const card = idle.locator(".tile").filter({ hasText: "Awaiting CI" });
  await expect(idle.getByText("awaiting background work", { exact: true })).toBeVisible();
  await expect(idle.getByText("Each resumes on its own when its process reports back.", { exact: false })).toBeVisible();
  await expect(idle.locator(".board-col-head").getByText("1 awaiting", { exact: true })).toBeVisible();
  await expect(card).toContainText(`Awaiting ${WAIT.what}`);
  await expect(card).toContainText(/due \d{1,2}:\d{2}/);
  const track = card.getByRole("progressbar", { name: "Time until its deadline" });
  await expect(track).toHaveAttribute("aria-valuetext", /^(20|19)m left$/);
  await expect(page.locator("main.board section.board-col.tone-attention")).toHaveCount(0);
  await expect(page.locator(".tile.is-blocked")).toHaveCount(0);
  await shoot(page, "01-board-awaiting");

  // The Conversation band: what, how it wakes, the link, and Clear. Never the blocker's band.
  await card.locator(".tile-name").click();
  const band = page.getByRole("region", { name: "Session awaiting" });
  await expect(band).toBeVisible();
  await expect(band).toContainText("Awaiting");
  await expect(band).toContainText(WAIT.what);
  await expect(band).toContainText("wakes when its background command finishes");
  // How long it has been waiting, as the blocker band shows its age.
  await expect(band.getByText(/^waiting \d+m$/)).toBeVisible();
  await expect(band.getByRole("link", { name: "Open ↗" })).toHaveAttribute("href", WAIT.referenceUrl);
  await expect(band.getByRole("progressbar")).toHaveAttribute("aria-valuetext", /^(20|19)m left$/);
  await expect(band.getByRole("button", { name: "Clear" })).toBeEnabled();
  await expect(page.getByRole("region", { name: "Session blocker" })).toHaveCount(0);
  await band.getByText("Details", { exact: true }).click();
  await expect(band.locator("code", { hasText: "gh pr checks 1612 --watch" })).toBeVisible();
  await settled(band);
  await shoot(page, "02-conversation-band");
  // The band's controls are on the reader's keyboard path: from the conversation body Tab
  // reaches Open, then Clear, and Shift+Tab walks back to the body.
  await page.locator(".cdetail .detail-body").focus();
  await page.keyboard.press("Tab");
  await expect(band.getByRole("link", { name: "Open ↗" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(band.getByRole("button", { name: "Clear" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(band.getByRole("link", { name: "Open ↗" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".cdetail .detail-body")).toBeFocused();
  // With Details closed, the link inside it is hidden and off the path: Tab goes Open, Clear,
  // Details, then on to the tab strip, never stuck on the summary.
  const summary = band.getByText("Details", { exact: true });
  await summary.click();
  await expect(band.getByRole("link", { name: "Run log" })).toBeHidden();
  await page.locator(".cdetail .detail-body").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  // The next Tab steps the reader on to the tab strip's next tab, leaving the Conversation and its
  // band behind. Stuck on the hidden link, focus would stay on the summary and the band would stay.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("region", { name: "Session awaiting" })).toHaveCount(0);
  await page.getByRole("tab", { name: /^Conversation/ }).click();
  await expect(page.getByRole("region", { name: "Session awaiting" })).toBeVisible();
  await page.locator(".cdetail .detail-body").focus();
  await page.keyboard.press("Escape");

  // A daemon restart reloads the wait for the rediscovered session.
  await daemon.crash();
  await daemon.restart();
  await expect.poll(async () => (await session(daemon, agent.id))?.awaiting?.what ?? "", {
    timeout: 60_000,
    message: "the wait came back after the restart",
  }).toBe(WAIT.what);

  // Move only the page's clock past the deadline, with the band open: it turns Overdue in place,
  // in amber, and says the normal handling applies again. The rail row says so too.
  // Reduced motion, so the Board-to-reader morph does not run on the clock the test now owns.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.reload();
  await expect(card).toContainText(`Awaiting ${WAIT.what}`);
  await card.locator(".tile-name").click();
  const late = page.getByRole("region", { name: "Session awaiting" });
  await expect(late).toContainText("Awaiting");
  await settled(late);
  await page.clock.fastForward("00:22:00");
  await expect(late).toContainText("Overdue");
  await expect(late).toContainText("the stuck-session alerts apply to this session again");
  await expect(late.getByRole("progressbar", { name: "Past its deadline" })).toHaveAttribute("aria-valuetext", /^\d+m late$/);
  const viewport = page.viewportSize()!;
  const box = (await late.boundingBox())!;
  expect(box.x + box.width, "the overdue band runs off the window").toBeLessThanOrEqual(viewport.width + 0.5);
  await expect(late.getByRole("button", { name: "Clear" })).toBeInViewport();
  await expect(page.locator(".rail-awaiting.is-late")).toHaveText("overdue");
  await shoot(page, "04-conversation-overdue");

  // Back on the Board the card reads Overdue and has left the Awaiting section for plain Idle.
  await page.keyboard.press("Escape");
  await expect(card).toContainText(`Overdue ${WAIT.what}`);
  await expect(card).toContainText(/\dm late/);
  await expect(card.locator(".tile-awaiting.is-late")).toBeVisible();
  await expect(idle.getByText("awaiting background work", { exact: true })).toHaveCount(0);
  await expect(idle.locator(".board-col-head").getByText("1 awaiting", { exact: true })).toHaveCount(0);
  await expect(page.locator("main.board section.board-col.tone-attention")).toHaveCount(0);
  await shoot(page, "03-board-overdue");

  await card.locator(".tile-name").click();
  await expect(late).toContainText("Overdue");

  // Clear ends it: the band goes, the card is an ordinary idle card, and the daemon agrees.
  await late.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByRole("region", { name: "Session awaiting" })).toHaveCount(0);
  await expect.poll(async () => (await session(daemon, agent.id))?.awaiting ?? null).toBeNull();
  await page.keyboard.press("Escape");
  await expect(card.locator(".tile-awaiting")).toHaveCount(0);
  await shoot(page, "05-cleared");
});

/**
 * The Awaiting section is a queue of things coming back, so it keeps its soonest-due order with
 * repository grouping on (the default): repository A waits on deadlines 20 and 5 minutes out and
 * repository B on one 10 minutes out, and framing A's two together would put its 20-minute wait
 * ahead of B's 10-minute one. None of the three cards sits inside a repository frame.
 *
 * A fourth agent declares nothing, and nothing is held by a workflow: both the Board column head
 * and the Console rail head say how many can take work ("1 free") beside "3 awaiting", never the
 * column total, which would leave the number free for work unclear.
 */
test("with repositories grouped, the Awaiting section keeps soonest-due order across repositories", async ({
  dashboard: page,
  daemon,
}) => {
  test.setTimeout(180_000);
  await setFlag(daemon, true);
  const waits = [
    { name: "Alpha later", repo: daemon.repo, minutes: 20 },
    { name: "Bravo middle", repo: daemon.secondRepo, minutes: 10 },
    { name: "Alpha soonest", repo: daemon.repo, minutes: 5 },
  ];
  const leaf = (path: string | null | undefined) => (path ?? "").split("/").filter(Boolean).at(-1);
  for (const wait of waits) {
    const agent = await dispatch(daemon, wait.name, wait.repo);
    // Each agent really is in the repository it was dispatched into, so the ordering below is
    // proved across two repositories and not within one.
    expect(leaf((await session(daemon, agent.id))?.repoRoot), `${wait.name}'s repository`).toBe(leaf(wait.repo));
    const client = await connect(daemon, agent);
    try {
      const expectedBy = new Date(Date.now() + wait.minutes * 60_000).toISOString();
      const declared = await client.callTool({ name: "report_awaiting", arguments: { ...WAIT, expectedBy } });
      expect(declared.isError, toolText(declared)).toBeFalsy();
    } finally {
      await client.close();
    }
  }
  await dispatch(daemon, "Delta free", daemon.repo);
  await useBoard(page, daemon);

  const idle = page.locator("main.board section.board-col.tone-idle");
  const head = idle.locator(".board-col-head");
  await expect(head.getByText("3 awaiting", { exact: true })).toBeVisible();
  await expect(head.getByText("1 free", { exact: true })).toBeVisible();
  await expect(head.getByText("4", { exact: true })).toHaveCount(0);
  await expect(head.getByText(/held$/)).toHaveCount(0);
  const waiting = idle.locator(".tile").filter({ has: page.getByRole("progressbar", { name: "Time until its deadline" }) });
  await expect(waiting.locator(".tile-name")).toHaveText([/Alpha soonest/, /Bravo middle/, /Alpha later/]);
  await expect(idle.locator(".board-repo .tile").filter({
    has: page.getByRole("progressbar", { name: "Time until its deadline" }),
  })).toHaveCount(0);
  // Grouping is on: the free agent below the section sits inside its repository's frame.
  await expect(idle.locator(".board-repo .tile").filter({ hasText: "Delta free" })).toHaveCount(1);
  await settled(idle);
  await shoot(page, "06-board-awaiting-across-repos");

  // The Console rail's Idle head draws the same split.
  await api(daemon, "/api/ui/config", { layout: "console" }, "PUT");
  await page.reload();
  const railIdle = page.getByRole("navigation", { name: "Sessions" }).locator(".rail-group.tone-idle");
  await expect(railIdle.getByText("3 awaiting", { exact: true })).toBeVisible();
  await expect(railIdle.getByText("1 free", { exact: true })).toBeVisible();
  await expect(railIdle.getByText("4", { exact: true })).toHaveCount(0);
  await settled(railIdle);
  await shoot(page, "07-rail-awaiting-free");
});

/**
 * With the preview off the tool refuses and says why, and nothing is drawn. Switching the preview
 * off while a wait stands ends it, so no card is left holding automation nobody can see.
 */
test("with the preview off the tool says it is off, and switching the preview off ends a standing wait", async ({
  dashboard: page,
  daemon,
}) => {
  await setFlag(daemon, false);
  const agent = await dispatch(daemon, "Awaiting off");
  await useBoard(page, daemon);
  const client = await connect(daemon, agent);
  try {
    const refused = await client.callTool({ name: "report_awaiting", arguments: declaration() });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("turned off in Mission Control");
    expect((await session(daemon, agent.id))?.awaiting ?? null).toBeNull();

    await setFlag(daemon, true);
    const declared = await client.callTool({ name: "report_awaiting", arguments: declaration() });
    expect(declared.isError, toolText(declared)).toBeFalsy();
  } finally {
    await client.close();
  }
  const card = page.locator("main.board .tile").filter({ hasText: "Awaiting off" });
  await expect(card.locator(".tile-awaiting")).toBeVisible();

  await setFlag(daemon, false);
  await expect(card.locator(".tile-awaiting")).toHaveCount(0);
  await expect(page.getByText("awaiting background work", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await session(daemon, agent.id))?.awaiting ?? null).toBeNull();
});
