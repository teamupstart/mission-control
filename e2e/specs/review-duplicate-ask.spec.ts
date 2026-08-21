import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * One question asked, one card to answer it on.
 *
 * `request_input` BLOCKS on a human for as long as the human takes, and the MCP client in
 * front of it does not: it abandons the tool call on its own timeout - five minutes, in the
 * duplicates the operator's database recorded - and hands the model an error for a question
 * that is still on screen and still answerable. The model asks again, byte for byte, and
 * until this change nothing could tell that retry from a fresh ask: a new uuid per POST, no
 * dedup key on the table. The abandoned row stayed pending BESIDE its own retry and the
 * review queue showed the same prompt twice, with no way to tell which of the two still had
 * an agent listening behind it.
 *
 * This drives the seam the operator actually met: two identical posts on the real
 * `POST /mcp/reviews` channel against a real dispatched session, then the real review queue
 * they open from the real card. The assertion is what a person reads - one prompt, counted
 * once - not the row count behind it, which is what `test/review-duplicate-ask.test.ts`
 * covers.
 */

const TASK = "tune the transcript cache";

const QUESTION = "Which caching strategy should the transcript reader use?";

/** The payload `request_input` builds: title and body are the question, ids are positional. */
const ASK = {
  kind: "input",
  title: QUESTION,
  body: QUESTION,
  decisions: [
    {
      id: "q",
      question: QUESTION,
      options: [
        { id: "o0", label: "Bounded LRU per session", recommended: true },
        { id: "o1", label: "Single shared ring buffer" },
      ],
      allowOther: true,
    },
  ],
};

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

/** Ask this session's human a question, over the same HTTP route the MCP child posts to. */
async function ask(
  daemon: DaemonHandle,
  body: Record<string, unknown>,
): Promise<{ id: string; sessionId: string }> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();

  let cwd: string | null = null;
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
        }>;
        cwd = sessions[0]?.cwd ?? null;
        return cwd;
      },
      { message: "the dispatched session is on the fleet, with a checkout to bind a review to" },
    )
    .toBeTruthy();

  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`).toBe(
    200,
  );
  return (await res.json()) as { id: string; sessionId: string };
}

test("a retried ask does not put the same prompt in the queue twice", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  // The tool call, then the retry the client's timeout provoked. Identical, as a retry is.
  const first = await ask(daemon, ASK);
  const retry = await ask(daemon, ASK);
  expect(retry.id, "the retry was given its own review to wait on").toBe(first.id);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  // The chip counts what is waiting on the operator, and only prints a number once there is
  // more than one to distinguish (`format.ts`). So the plain wording IS the assertion: with
  // the duplicate row this read "2 to review", which was the first place a person met it.
  const chip = card.getByRole("button", { name: /to review/ });
  await expect(chip).toHaveText(/^to review/);

  await chip.click();
  const modal = dashboard.locator(".review-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByText(QUESTION)).toHaveCount(1);
  await expect(dashboard.getByRole("dialog", { name: "Review request" })).toContainText(
    "1 pending",
  );

  // And it is a real question, not a husk: answering the single card clears the queue.
  await modal.getByRole("radio", { name: /Single shared ring buffer/ }).check();
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();
  await expect(card.getByRole("button", { name: /to review/ })).toHaveCount(0);
});

test("a different question from the same session still gets its own card", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  await ask(daemon, ASK);
  await ask(daemon, { kind: "input", title: "What retry budget?", body: "What retry budget?" });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const chip = card.getByRole("button", { name: /to review/ });
  await expect(chip).toHaveText(/^2 to review/);

  await chip.click();
  const modal = dashboard.locator(".review-modal");
  await expect(modal.getByText(QUESTION)).toHaveCount(1);
  await expect(modal.getByText("What retry budget?")).toHaveCount(1);
});
