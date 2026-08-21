import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The review queue has a chord, and the badge that opens it says so.
 *
 * A pending review is the most urgent thing a session can be - it is the one state where an
 * agent has stopped dead waiting on a person - and until now the only way to open its queue
 * was to find the amber badge with a mouse. `e` is that badge's keyboard equivalent, and it
 * travels: on a fleet where the selected card has nothing waiting, it goes to the first
 * session that is asking rather than doing nothing.
 *
 * Driven end to end, because that is the only layer that can see it work: the chord is
 * dispatched by App's window keydown listener, which nothing in `test/` can reach (see
 * `lib/conversationReveal.ts` on why those decisions live in `lib/`), and the queue it opens
 * is fed by the real SSE stream. Reviews are created over the real `POST /mcp/reviews`
 * channel the agent's MCP child uses, so no model tokens are spent.
 */

const TASK = "tune the transcript cache";
/** A second, differently-named agent, so the travel test can name the queue that opened. */
const OTHER_TASK = "rebuild the pane capture index";

const QUESTION = {
  kind: "input",
  title: "Which caching strategy should the transcript reader use?",
  body: "Which caching strategy should the transcript reader use?",
  decisions: [
    {
      id: "q",
      question: "Which caching strategy should the transcript reader use?",
      options: [
        { id: "o0", label: "Bounded LRU per session", recommended: true },
        { id: "o1", label: "Single shared ring buffer" },
      ],
      allowOther: false,
    },
  ],
};

/** Launch one agent and wait for the fleet to have adopted `expected` cards. */
async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  expected: number,
  task = TASK,
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control. Its own handler stops
  // propagation, so this closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(expected);
}

/**
 * Ask a question the way the agent's MCP child does, bound to the session in `cwd`.
 *
 * Posted over HTTP rather than scripted into the fake agent, because the review channel IS
 * an HTTP route (`src/mcp/server.ts` performs exactly this POST), and going through it keeps
 * the spec honest about the contract while every agent binary stays a cost-free fake.
 */
async function ask(daemon: DaemonHandle, cwd: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, ...QUESTION }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`).toBe(
    200,
  );
}

/**
 * The checkouts the daemon actually cut, in the order it reports them, once every dispatched
 * session has one.
 *
 * Polled rather than read once: a card is on screen before the registry has necessarily
 * finished adopting the worktree it was cut into, so a single read is intermittently empty.
 */
async function checkouts(
  daemon: DaemonHandle,
  count: number,
): Promise<{ cwd: string; name: string }[]> {
  let found: { cwd: string; name: string }[] = [];
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
          name: string;
        }>;
        found = sessions
          .filter((s): s is { cwd: string; name: string } => Boolean(s.cwd))
          .map((s) => ({ cwd: s.cwd, name: s.name }));
        return found.length;
      },
      { message: `${count} dispatched sessions have checkouts to bind a review to` },
    )
    .toBe(count);
  return found;
}

test("e opens the review queue of the session that is asking", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  const [session] = await checkouts(daemon, 1);
  await ask(daemon, session.cwd);

  // The badge is the thing the chord stands in for, so wait for it rather than for a count:
  // it appearing is the fleet having heard about the review.
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card.getByRole("button", { name: "to review" })).toBeVisible();

  // Nothing is selected, and the chord still finds the session asking.
  await dashboard.keyboard.press("e");

  const modal = dashboard.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("1 pending");
  await expect(modal).toContainText("Which caching strategy should the transcript reader use?");
});

test("the badge prints the chord that opens it", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  const [session] = await checkouts(daemon, 1);
  await ask(daemon, session.cwd);

  // A bare letter keycap stays lowercase (`formatChord` only uppercases a MODIFIED letter),
  // so this asserts the exact glyph a person reads on the badge.
  const badge = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().getByRole("button", { name: "to review" });
  await expect(badge.locator("kbd.kb-hint")).toHaveText("e");
});

test("e travels to the first session asking when the selected one has nothing waiting", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, 1);
  // A different task, so the two cards carry different names and the modal that opens can
  // be identified by the session it belongs to rather than merely by being open.
  await dispatch(dashboard, daemon, 2, OTHER_TASK);
  const sessions = await checkouts(daemon, 2);

  // Bound by NAME, not by index: `/api/sessions` promises no particular order, so picking
  // `[1]` would silently ask the wrong agent on any run that returned them the other way
  // round - and the test would still pass, because a modal would still open.
  const askTarget = sessions.find((s) => s.name.toLowerCase().includes("pane capture"));
  expect(askTarget, `the ${OTHER_TASK} session is on the fleet`).toBeTruthy();
  await ask(daemon, askTarget!.cwd);

  // Exactly one of the two is asking. Which CARD that is gets read off the DOM rather than
  // assumed: a pending review tones a session `attention`, which re-sorts it to the front of
  // the grid, so the asking card is not the one that was dispatched second.
  const rows = dashboard.getByRole("navigation", { name: "Sessions" });
  const asking = rows
    .locator("button.rail-row")
    .filter({ has: dashboard.getByRole("button", { name: "to review" }) });
  await expect(asking).toHaveCount(1);

  // Select the OTHER card - the one with no queue of its own. Without the travel rule the
  // chord would be dead here, which is the whole point of the test.
  const quiet = rows
    .locator("button.rail-row")
    .filter({ hasNot: dashboard.getByRole("button", { name: "to review" }) });
  await expect(quiet).toHaveCount(1);
  await quiet.click();
  await expect(quiet).toHaveClass(/selected/);

  await dashboard.keyboard.press("e");

  // The queue that opened is the asking session's, and the selection followed it there, so
  // the modal and the highlighted card do not disagree about which session is being answered.
  const modal = dashboard.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  // The queue is the SECOND session's - the one dispatched with OTHER_TASK - and not
  // merely some queue. Names are title-cased from the task.
  await expect(modal).toContainText(askTarget!.name);
  await expect(asking).toHaveClass(/selected/);
});

test("e is left to the browser on a fleet with nothing waiting", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  await checkouts(daemon, 1);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.click();
  await expect(card.getByRole("button", { name: "to review" })).toHaveCount(0);

  await dashboard.keyboard.press("e");

  // No queue exists, so no queue opens - and the chord is left unclaimed rather than
  // swallowed, which is what keeps a bare letter usable by the page underneath it.
  await expect(dashboard.getByRole("dialog", { name: "Review request" })).toHaveCount(0);
});
