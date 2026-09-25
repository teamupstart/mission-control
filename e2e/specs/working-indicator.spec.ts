import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The conversation's working indicator (issue #1116): a clock on every working row, and two
 * marks an operator adds from Display > Working indicator.
 *
 * Each claim here is one only a laid-out browser can check:
 *
 * - The clock is on the row with nothing checked, and it TICKS. A static render can print a
 *   duration; only a running page can show the second hand moving.
 * - With nothing checked, the row is not pinned and the reply box draws no bar: the
 *   conversation is what it was before these options existed, plus the clock.
 * - The Display panel offers both, unchecked, and its preview moves with each box - measured,
 *   because "the row holds the bottom edge" is a fact about geometry inside a clipped log.
 * - Checked, the live row stays inside the log's viewport while the reader is scrolled back
 *   to the top, and it is painted in the surface it sits on, so the turns scrolling under it
 *   do not print through. The reply box carries the bar while the session works and drops it
 *   when the session settles.
 * - The bar MOVES, and under reduced motion it stops moving without disappearing. Its painted
 *   gradient is identical either way, so this reads the element's running animations and
 *   samples where the layer is, rather than trusting `backgroundImage`.
 *
 * Every session is a fake agent (`MISSION_CLAUDE_BIN`); no model is spent. Live state goes
 * through the real `/hooks/:event` ingest, the way `conversation-in-progress-row.spec.ts`
 * drives it: `PreToolUse` with a tool name is what produces `running Bash`.
 */

const TASK = { title: "Watch the working indicator", intent: "exercise the working indicator" };

const EVIDENCE = artifactsDir("working-indicator");

const PIN = "Pin the working row";
const BAR = "Reply box progress bar";

async function shot(page: Page, locator: Locator, name: string, observed: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  // Animations left running on purpose: "disabled" parks an infinite animation at its first
  // frame, which puts the reply box's sweeping bar one full width off its left edge.
  await locator.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${observed}`);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/working-indicator/${name}.png`);
}

interface FleetSession {
  id: string;
  agent: string;
  agentSessionId: string | null;
  cwd: string;
  runtime: string;
}

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

async function put(daemon: DaemonHandle, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, `PUT ${path} answered ${res.status}`).toBe(true);
}

/** The dispatched session, once it has bound a conversation for the hooks to land on. */
async function session(daemon: DaemonHandle): Promise<FleetSession> {
  let found: FleetSession | null = null;
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as FleetSession[];
        found = all.find((s) => s.runtime === "sdk" && s.agentSessionId !== null) ?? null;
        return found !== null;
      },
      { message: "the dispatched session should bind a conversation", timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

async function hook(
  daemon: DaemonHandle,
  target: FleetSession,
  event: "PreToolUse" | "Stop",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      agent: target.agent,
      sessionId: target.agentSessionId,
      cwd: target.cwd,
      env: {},
      ...extra,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(204);
}

/** Dispatch one agent from the real modal, named so the rail button is unambiguous. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // `RepoCombobox` portals its listbox over the fields below and reopens on every keystroke.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK.intent);
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(TASK.title);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Switch to the console and select the dispatched session, returning the detail pane. */
async function openDetail(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await put(daemon, "/api/ui/config", { layout: "console" });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  const rail = page.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  await rail.getByRole("button", { name: TASK.title }).first().click();
  const detail = page.locator(".cdetail");
  await expect(detail.getByRole("heading", { name: TASK.title })).toBeVisible();
  await expect(detail.locator(".transcript-log .turn").first()).toBeVisible({ timeout: 30_000 });
  return detail;
}

/** The reply box's painted background layers - "none" unless something is drawn on it. */
function backgroundImage(box: Locator): Promise<string> {
  return box.evaluate((el) => getComputedStyle(el).backgroundImage);
}

/**
 * What the reply box's bar is doing right now: the layer it paints, whether an animation is
 * running on it, and whether that layer actually moves.
 *
 * `backgroundImage` cannot tell a sweeping bar from a parked one - it is the same gradient in
 * both - so this asks the element for its running CSS animations and samples the layer's
 * position twice, a quarter second apart. Any two instants that far apart in a 1.8s sweep sit
 * at different positions; a steady bar sits at the same one.
 */
function replyBar(box: Locator): Promise<{
  image: string;
  size: string;
  animations: string[];
  moved: boolean;
}> {
  return box.evaluate(async (el) => {
    const style = getComputedStyle(el);
    const before = style.backgroundPosition;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      image: style.backgroundImage,
      size: style.backgroundSize,
      animations: el
        .getAnimations()
        .filter((a) => a instanceof CSSAnimation && a.playState === "running")
        .map((a) => (a as CSSAnimation).animationName),
      moved: style.backgroundPosition !== before,
    };
  });
}

/**
 * Take an evidence frame with the reply box's sweep held at the middle of its edge.
 *
 * Evidence only, and a no-op otherwise. A screenshot of a 2px segment in flight lands wherever
 * the clock happens to put it - including one full width off either end, where the frame shows
 * no bar at all. Seeking the real `reply-progress` animation to half its 1.8s duration puts
 * the segment across the middle 30% of the edge, which is a genuine frame of that animation;
 * it runs again as soon as the frame is taken. The motion itself is asserted by the reply-bar
 * test, which this cannot affect.
 */
async function withSweepMidEdge(box: Locator, capture: () => Promise<void>): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const held = await box.evaluate((el) => {
    const sweeps = el
      .getAnimations()
      .filter((a) => a instanceof CSSAnimation && a.animationName === "reply-progress");
    for (const sweep of sweeps) {
      sweep.pause();
      sweep.currentTime = 900;
    }
    return sweeps.length;
  });
  expect(held, "the reply box should be running its sweep when the frame is taken").toBe(1);
  try {
    await capture();
  } finally {
    await box.evaluate((el) => {
      for (const a of el.getAnimations()) {
        if (a instanceof CSSAnimation && a.animationName === "reply-progress") a.play();
      }
    });
  }
}

/** Whether `inner` lies inside `outer`'s box, to the pixel. */
async function inside(inner: Locator, outer: Locator): Promise<boolean> {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  return a.y >= b.y - 1 && a.y + a.height <= b.y + b.height + 1;
}

test("a working row carries a ticking clock, and with nothing checked it is the only mark", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const target = await session(daemon);
  const detail = await openDetail(dashboard, daemon);

  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });
  const row = detail.locator(".transcript-log .turn-progress");
  await expect(row).toContainText("running Bash", { timeout: 15_000 });

  // The clock: the turn's elapsed time in the shape `duration()` prints.
  const clock = row.locator(".turn-progress-clock");
  await expect(clock).toHaveText(/^(\d+s|\d+m \d{2}s|\d+h \d{2}m)$/);
  // And it is a clock, not a stamp: the second hand moves while nothing else does.
  const first = await clock.textContent();
  await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(first);

  // Nothing checked: the row is the log's plain last line and the reply box is unmarked.
  await expect(row).not.toHaveClass(/is-pinned/);
  const reply = detail.getByPlaceholder(/^Reply to this session|^Send the next instruction/);
  expect(await backgroundImage(reply), "the reply box draws no bar by default").toBe("none");

  await shot(dashboard, detail.locator(".detail-conv"), "base-clock", "the working row carries a ticking clock with neither option checked");
});

test("Display offers both marks unchecked, and the preview moves with each box", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  await expect(panel.getByRole("heading", { name: "Working indicator" })).toBeVisible();

  const pin = panel.getByRole("checkbox", { name: PIN, exact: true });
  const bar = panel.getByRole("checkbox", { name: BAR, exact: true });
  await expect(pin).not.toBeChecked();
  await expect(bar).not.toBeChecked();

  const preview = panel.locator(".working-preview");
  // `has` is queried INSIDE each customizer, so it names the preview from the page rather
  // than re-rooting it at the panel, which no customizer contains.
  const customizer = panel
    .locator(".board-card-customizer")
    .filter({ has: dashboard.locator(".working-preview") });
  // The base experience is visible before anything is checked: the row and its clock.
  await expect(preview.locator(".turn-progress-clock").first()).toHaveText("2m 14s");

  // The scrolled-back frame: its tail, row included, is below the fold until pinned.
  const back = preview.locator(".working-preview-log.is-scrolled-back");
  const backRow = back.locator(".turn-progress");
  expect(await inside(backRow, back), "unpinned, the row has scrolled away with the tail").toBe(false);
  const box = preview.getByRole("textbox", { includeHidden: true });
  expect(await backgroundImage(box)).toBe("none");
  await shot(dashboard, customizer, "display-unchecked", "Display > Working indicator ships with both marks unchecked");

  await pin.check();
  await expect(backRow).toHaveClass(/is-pinned/);
  await expect.poll(() => inside(backRow, back), { message: "pinned, the row holds the bottom edge" }).toBe(true);
  expect(await backgroundImage(box), "the pin does not bring the bar with it").toBe("none");

  await bar.check();
  await expect.poll(() => backgroundImage(box)).toContain("gradient");
  await shot(dashboard, customizer, "display-both-checked", "both marks checked, the preview pins the row and draws the bar");

  // The choice is the operator's and survives a reload.
  await dashboard.reload();
  await expect(panel.getByRole("checkbox", { name: PIN, exact: true })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: BAR, exact: true })).toBeChecked();
});

test("checked, the live row holds the bottom edge while scrolled back, and the reply box carries the bar", async ({
  dashboard,
  daemon,
}) => {
  // Opted in through the real panel, so the same click an operator makes is what the
  // console below is reading.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  await panel.getByRole("checkbox", { name: PIN, exact: true }).check();
  await panel.getByRole("checkbox", { name: BAR, exact: true }).check();
  await expect(panel.getByRole("checkbox", { name: BAR, exact: true })).toBeChecked();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dispatch(dashboard, daemon);
  const target = await session(daemon);

  // A pane the conversation genuinely overflows, and tall enough that the scrolled-back
  // frame below shows several turns above the pinned row rather than a sliver of one.
  await dashboard.setViewportSize({ width: 1280, height: 760 });
  const detail = await openDetail(dashboard, daemon);
  const log = detail.locator(".transcript-log");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  for (const n of [1, 2, 3, 4]) {
    const line = `Turn ${n} - a reply long enough to wrap inside a narrow console pane and give the log something to scroll.`;
    await reply.fill(line);
    await reply.press("Enter");
    await expect(log.getByText(`Mock reply to: ${line}`)).toBeVisible({ timeout: 30_000 });
  }
  const overflow = await log.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the fixture must give the log something to scroll").toBeGreaterThan(80);

  // Idle: no row, no bar.
  await expect(detail.locator(".turn-progress")).toHaveCount(0);
  expect(await backgroundImage(reply)).toBe("none");

  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });
  const row = log.locator(".turn-progress");
  await expect(row).toContainText("running Bash", { timeout: 15_000 });
  await expect(row).toHaveClass(/is-pinned/);
  await expect.poll(() => backgroundImage(reply)).toContain("gradient");

  // Scrolled back to the very top: the tail is far below the fold, and the row is not.
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await inside(row, log), "the pinned row stays inside the log's viewport").toBe(true);
  const rowBox = (await row.boundingBox())!;
  const logBox = (await log.boundingBox())!;
  expect(
    logBox.y + logBox.height - (rowBox.y + rowBox.height),
    "and it sits on the log's bottom edge rather than anywhere above it",
  ).toBeLessThan(8);

  // Opaque, in the colour of the surface under the log, so the turns scrolling beneath it do
  // not print through and it does not read as a band of some other panel.
  const painted = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const surface = await log.evaluate((el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
  expect(painted, "the pinned row is painted in the surface it sits on").toBe(surface);

  await withSweepMidEdge(reply, () =>
    shot(dashboard, detail.locator(".detail-conv"), "pinned-scrolled-back-live-chat", "live chat scrolled to the top: the pinned row holds the log's bottom edge and the reply box carries the bar"),
  );

  // The terminal drawing keeps both, and its surface matches too.
  await detail.getByRole("button", { name: "Terminal view" }).click();
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
  const termRow = log.locator(".turn-progress");
  await expect(termRow).toHaveClass(/pty-entry/);
  await expect(termRow).toHaveClass(/is-pinned/);
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(await inside(termRow, log), "the terminal stream keeps the row pinned too").toBe(true);
  const termReply = detail.getByPlaceholder(/^Send the next instruction/);
  await expect.poll(() => backgroundImage(termReply)).toContain("gradient");
  await shot(dashboard, detail.locator(".detail-conv"), "pinned-terminal", "the terminal drawing pins the row and draws the bar along the prompt line");

  // Settled: the row goes, and the bar goes with it.
  await hook(daemon, target, "Stop");
  await expect(log.locator(".turn-progress")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => backgroundImage(termReply)).toBe("none");
});

test("the reply box bar sweeps while the session works, and holds still as a steady line under reduced motion", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  await panel.getByRole("checkbox", { name: BAR, exact: true }).check();
  await expect(panel.getByRole("checkbox", { name: BAR, exact: true })).toBeChecked();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dispatch(dashboard, daemon);
  const target = await session(daemon);
  const detail = await openDetail(dashboard, daemon);
  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });
  await expect(detail.locator(".transcript-log .turn-progress")).toContainText("running Bash", {
    timeout: 15_000,
  });

  // Both drawings, because the rule is declared for each: the terminal one has to restate it
  // after a rule of its own resets `background`, and so does its reduced-motion override.
  for (const view of ["chat", "terminal"] as const) {
    if (view === "terminal") {
      await detail.getByRole("button", { name: "Terminal view" }).click();
      await expect(detail.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
    }
    const reply = detail.getByPlaceholder(
      view === "chat" ? /^Reply to this session/ : /^Send the next instruction/,
    );
    const compose = detail.locator(".transcript-compose");

    // No motion preference: the sweep is attached and running, it paints a short segment
    // rather than the whole edge, and that segment is somewhere else a moment later.
    await dashboard.emulateMedia({ reducedMotion: "no-preference" });
    await expect
      .poll(async () => (await replyBar(reply)).animations, {
        message: `the ${view} reply box runs the reply-progress sweep`,
      })
      .toEqual(["reply-progress"]);
    const sweeping = await replyBar(reply);
    expect(sweeping.image, "the sweep paints the working tone").toContain("gradient");
    expect(sweeping.size, "a moving segment, not the whole top edge").toBe("30% 2px");
    expect(sweeping.moved, `the ${view} bar moves along the top edge`).toBe(true);
    await shot(dashboard, compose, `reply-bar-sweeping-${view}`, `the ${view} reply box runs the reply-progress sweep`);

    // Reduced motion: nothing runs and nothing moves, and the bar is still there - drawn
    // across the whole top edge, which is what keeps it readable without the motion.
    await dashboard.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () => (await replyBar(reply)).animations, {
        message: `reduced motion stops the ${view} sweep`,
      })
      .toEqual([]);
    const steady = await replyBar(reply);
    expect(steady.image, "reduced motion still draws the bar").toContain("gradient");
    expect(steady.size, "as a steady line across the whole top edge").toBe("100% 2px");
    expect(steady.moved, `the ${view} bar holds still`).toBe(false);
    await shot(dashboard, compose, `reply-bar-reduced-motion-${view}`, `under reduced motion the ${view} reply box keeps a steady full-width bar`);
  }
  await dashboard.emulateMedia({ reducedMotion: null });

  // And the steady bar is still the session's state, not decoration: it goes when the session
  // settles, exactly as the sweep does.
  await hook(daemon, target, "Stop");
  await expect(detail.locator(".transcript-log .turn-progress")).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(() => backgroundImage(detail.getByPlaceholder(/^Send the next instruction/)))
    .toBe("none");
});
