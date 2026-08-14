import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * What the session is doing right now, after it stopped being chrome.
 *
 * The line used to be a fixed band at the top of the Console detail's Conversation tab. It
 * is now the last row of the log, which is where the turn it describes is arriving. Three
 * claims, and every one of them needs a laid-out browser:
 *
 * - It renders at the TAIL. Reading order is a fact about geometry, and the
 *   `renderToStaticMarkup` tests beside this one can only say which string precedes which
 *   in a markup dump - not which row a person sees last.
 * - It comes and goes with the session. A settled session's `activity` field still holds a
 *   word ("idle"); the row is gone. Only a live daemon moving a real session between states
 *   can show that, because it is the daemon's state machine being asserted, not a prop.
 * - **A reader pinned to the bottom of the log stays pinned when it appears.** This is the
 *   regression the whole design risked: the log follows its tail from a layout effect keyed
 *   on its dependencies, so a row that changes the log's height without being one of them
 *   silently drifts the reader off the bottom. Nothing below a real scroll container can
 *   see that.
 *
 * Every session here is a fake agent (`MISSION_CLAUDE_BIN`); no model is spent. The live
 * state is driven through the real `/hooks/:event` ingest, which is how a machine-installed
 * Claude bridge drives it - `PreToolUse` with a tool name is what produces the literal
 * `running Bash` this spec is named for.
 */

const TASK = { title: "Watch the tail of the log", intent: "exercise the in-progress row" };

const EVIDENCE = artifactsDir("conversation-in-progress-row");

/** One reviewer-facing frame, only when capture is asked for. */
async function shot(page: Page, locator: Locator, name: string, observed: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // in-progress row has one.
  await page.mouse.move(0, 0);
  await locator.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${observed}`);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-in-progress-row/${name}.png`);
}

interface FleetSession {
  id: string;
  agent: string;
  agentSessionId: string | null;
  cwd: string;
  runtime: string;
}

/** The daemon's loopback token, which the hook ingest route requires. */
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

/**
 * The dispatched session, once it has bound a conversation.
 *
 * Waiting for `agentSessionId` is what makes the hook below land on this session: the
 * ingest binds by pane key, then by agent session id, then by a unique cwd - and a hook
 * posted before the binding exists is answered by the third of those at best.
 */
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

/**
 * Drive the session's live state the way an instrumented Claude does.
 *
 * A real hook, over the real ingest route, on the agent's own conversation id - not a
 * fixture write behind the registry's back. `PreToolUse` reports `working` and
 * `running <tool>`; `Stop` reports `idle`, which is the state that must draw no row while
 * leaving `activity` set to the word "idle".
 */
async function hook(
  daemon: DaemonHandle,
  target: FleetSession,
  event: "PreToolUse" | "PostToolUse" | "Stop",
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

/**
 * Dispatch one agent from the real modal.
 *
 * `Escape` after the repo field is load-bearing rather than defensive: `RepoCombobox`
 * portals its listbox over the fields below it and opens on every keystroke, so without
 * dismissing it the next `fill` lands on a covered control.
 */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK.intent);
  // Named explicitly: with the Title field blank the daemon asks the model for one and the
  // fake answers `E2E Mock Session` for every prompt, so the rail button below would be
  // ambiguous the moment a second session existed.
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(TASK.title);
  // Pinned rather than left at the daemon's default, which this repo is not allowlisted
  // for: the modal would stay open with the refusal in it.
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
  await page.reload();

  const rail = page.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  await rail.getByRole("button", { name: TASK.title }).first().click();

  const detail = page.locator(".cdetail");
  await expect(detail.getByRole("heading", { name: TASK.title })).toBeVisible();
  // The opening exchange has landed, so the log has recorded turns for the row to sit
  // after. Without this the "at the tail" assertion could be about an empty log.
  await expect(detail.locator(".transcript-log .turn").first()).toBeVisible({ timeout: 30_000 });
  return detail;
}

/** How far the log is from the bottom of its own scroll, in pixels. */
function distanceFromBottom(log: Locator): Promise<number> {
  return log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

test("the session's current step reads at the tail of the log, not in a band above it", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const target = await session(daemon);
  const detail = await openDetail(dashboard, daemon);

  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });

  const row = detail.locator(".transcript-log .turn-progress");
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("running Bash");
  // Whose step it is, in the log's own byline vocabulary.
  await expect(row).toContainText("claude");

  // At the tail, and measured rather than read off the markup: "later in the DOM" is not
  // the claim - a person reads this as the last thing in the conversation.
  const rowBox = await row.boundingBox();
  const lastTurnBox = await detail.locator(".transcript-log .turn").last().boundingBox();
  expect(rowBox, "the in-progress row should be laid out").not.toBeNull();
  expect(lastTurnBox, "the log should have a recorded turn").not.toBeNull();
  expect(rowBox!.y, "the current step reads after the turns already recorded").toBeGreaterThan(
    lastTurnBox!.y,
  );
  // With nothing queued there is nothing after it either. (A queued message would be: the
  // agent has not received it yet, so the step running now precedes it - pinned in
  // `test/transcript-in-progress-row.test.ts`, where a pending turn can be handed in.)
  const last = await detail
    .locator(".transcript-log")
    .evaluate((el) => el.lastElementChild?.className ?? "");
  expect(last, "the row is the last thing in the log").toContain("turn-progress");

  // And nowhere else. The same string is on screen in the assertion above - this is the
  // band that used to carry it being gone, not a selector that never matched.
  await expect(detail.locator(".detail-conv > .activity")).toHaveCount(0);
  await expect(detail.locator(".detail-conv > p")).toHaveCount(0);

  // The whole leading band, measured rather than argued: with nothing to answer first, the
  // transcript is the FIRST thing under the tab row. It is also still a DIRECT child -
  // shipped CSS and `pane-dialog-scroll.test.ts` both select through that combinator, so no
  // wrapper may appear where the status band was.
  const leading = await detail
    .locator(".detail-conv")
    .evaluate((el) => el.firstElementChild?.className ?? "");
  expect(leading, "the transcript should lead the conversation pane").toContain("transcript");
  await expect(detail.locator(".detail-conv > .transcript")).toHaveCount(1);

  await shot(dashboard, detail, "tail-of-the-log", "the current step reads at the tail of the log");
});

test("the row is the session's live report, and the Observed activity rail is not", async ({
  dashboard,
  daemon,
}) => {
  // F5: this pane already had a feature called activity. The rail lists calls the
  // transcript RECORDED and its language contract forbids it from claiming any of them is
  // running; the row claims exactly that, about one step, from the session. Both are on
  // screen here, which is the only place that distinction can be checked as a fact.
  await dispatch(dashboard, daemon);
  const target = await session(daemon);
  const detail = await openDetail(dashboard, daemon);

  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });
  const row = detail.locator(".transcript-log .turn-progress");
  await expect(row).toContainText("running Bash", { timeout: 15_000 });

  const rail = detail.getByRole("region", { name: "Conversation rail" });
  await expect(rail).toBeVisible();
  await expect(rail.getByText("Tool calls observed in the loaded transcript.")).toBeVisible();
  // The rail keeps its contract with the row inches away from it: it is not where the
  // running claim went.
  await expect(rail).not.toContainText("running Bash");
  // Two different places, not one thing read twice: the row belongs to the log.
  await expect(rail.locator(".turn-progress")).toHaveCount(0);

  // And the row is honest about being live. A settled session still HOLDS an activity
  // string - `Stop` reports the word "idle" - and the row is gone rather than spinning on
  // it. Present first, then absent, on the same element.
  await hook(daemon, target, "Stop");
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  // The rail is untouched by that: it was never reading `session.activity` at all.
  await expect(rail).toBeVisible();
  await expect(detail.locator(".transcript-log")).not.toContainText("idle");

  await shot(
    dashboard,
    detail.locator(".detail-conv"),
    "settled-keeps-the-rail",
    "a settled session drops the in-progress row and keeps the Observed activity rail",
  );
});

test("the terminal drawing keeps the row inside its stream", async ({ dashboard, daemon }) => {
  // The same log, drawn as a terminal: no flex gap, a 24px inset, one spine down the left
  // with a node per entry. This is a geometry claim and it is why the rendering was checked
  // in a browser at all - the first cut put the row flush against the last entry and two
  // dozen pixels to the left of the stream, which no markup assertion would have noticed.
  await dispatch(dashboard, daemon);
  const target = await session(daemon);
  const detail = await openDetail(dashboard, daemon);

  await detail.getByRole("button", { name: "Terminal view" }).click();
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toBeVisible();

  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });
  const row = detail.locator(".transcript-log .turn-progress");
  await expect(row).toContainText("running Bash", { timeout: 15_000 });

  // Aligned with the stream's entries, not with the log's edge.
  const rowBox = await row.boundingBox();
  const entryBox = await detail.locator(".transcript-log .pty-entry").first().boundingBox();
  const logBox = await detail.locator(".transcript-log").boundingBox();
  expect(rowBox, "the in-progress row should be laid out").not.toBeNull();
  expect(entryBox, "the terminal stream should have an entry").not.toBeNull();
  expect(rowBox!.x, "the row starts where the stream's entries start").toBe(entryBox!.x);
  expect(rowBox!.x, "and not at the log's own left edge").toBeGreaterThan(logBox!.x);

  await shot(
    dashboard,
    detail.locator(".transcript-log"),
    "terminal-stream-tail",
    "the terminal stream carries the in-progress row as its last entry",
  );
});

test("a reader at the bottom of the log stays there when the current step appears", async ({
  dashboard,
  daemon,
}) => {
  // F4, defect one, end to end. The log re-pins to its bottom from a layout effect keyed on
  // its dependencies; a row that changes the log's height while the effect is blind to it
  // leaves a bottom-pinned reader a row off the bottom, silently, with nothing else having
  // moved.
  //
  // Verified against a broken build, and the mutation that reproduces it is worth naming.
  // Dropping `inProgress` alone does NOT fail this: an activity change arrives as a
  // whole-session upsert, whose freshly parsed `session.pendingTurns` re-runs the effect on
  // the same tick. Cutting the array to `[messages]` - which is what that masking is
  // standing in for - fails on the last assertion here, at 28px off the bottom, while the
  // other two tests in this file still pass. So this test measures the invariant a person
  // has (the log keeps following) rather than the wiring that currently delivers it, and
  // `test/transcript-in-progress-row.test.ts` pins the wiring.
  await dispatch(dashboard, daemon);
  const target = await session(daemon);

  // A pane short enough that the conversation genuinely overflows it. Without this the log
  // has nothing to scroll and "still at the bottom" is true of a log that cannot leave it.
  await dashboard.setViewportSize({ width: 1280, height: 560 });
  const detail = await openDetail(dashboard, daemon);
  const log = detail.locator(".transcript-log");

  // Enough conversation to overflow that pane. Each reply is echoed by the fake agent, so
  // waiting on the echo is waiting for the turns to have landed in the log.
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  for (const n of [1, 2, 3]) {
    const line = `Turn ${n} - a reply long enough to wrap inside a narrow console pane and give the log something to scroll.`;
    await reply.fill(line);
    await reply.press("Enter");
    await expect(log.getByText(`Mock reply to: ${line}`)).toBeVisible({ timeout: 30_000 });
  }
  const overflow = await log.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the fixture must give the log something to scroll").toBeGreaterThan(40);

  // The state this test is about: no row yet, and the reader at the bottom.
  await expect(detail.locator(".turn-progress")).toHaveCount(0);
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await distanceFromBottom(log), "the reader starts pinned to the bottom").toBeLessThan(4);

  await hook(daemon, target, "PreToolUse", { toolName: "Bash" });
  await expect(detail.locator(".transcript-log .turn-progress")).toContainText("running Bash", {
    timeout: 15_000,
  });

  // Read once, not polled. The claim is that the reader never LEFT the bottom, and a
  // retrying assertion would happily wait out a drift that some later render corrected.
  expect(
    await distanceFromBottom(log),
    "a reader at the bottom of the log must stay there when the current step arrives",
  ).toBeLessThan(4);

  await shot(
    dashboard,
    detail.locator(".detail-conv"),
    "stays-pinned-to-the-tail",
    "the log is still following its tail after the in-progress row arrived",
  );
});
