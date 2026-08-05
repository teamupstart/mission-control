import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { dialogMarker } from "../../src/server/foreman/pending.ts";

/**
 * A decision you have already made must stop being asked of you.
 *
 * Foreman escalates by pinning a note that reads "needs your decision", carrying a suggested
 * answer and a control to send it. Answering the question yourself spends that note - the
 * child is unblocked and the suggestion answers nothing - and nothing used to say so. The
 * note stayed until someone clicked Dismiss, which is the click this regression removes.
 *
 * Both channels a session asks through are driven here, because the note was stranded on each
 * for a different reason and only one of them looked stale:
 *
 *  - The DRIVER form, which is what an SDK session's own `AskUserQuestion` raises. Its marker
 *    is a `dialog:` digest, so `deliveryTarget` could not tell the ask had been answered and
 *    drew a live Approve & send. On this surface that button is not merely useless: it injects
 *    Foreman's prose into a session that already has its answer.
 *  - The MCP review. Its marker names the review, so the dashboard did degrade it to "already
 *    resolved, nothing to send it to" - but the banner stayed, and its only remaining control
 *    was the Dismiss nobody should have had to press.
 *
 * Both were real on a live database: two notes still `escalated` against a plan their operator
 * had approved and a plan-decisions they had answered hours earlier, and a third whose
 * `dialog:` marker was finally cleared by hand three minutes after the question it was about.
 *
 * Everything is real except the model: a real dispatched SDK session, a real `can_use_tool`
 * request over the vendored SDK, a real review over the real `POST /mcp/reviews` channel, a
 * real note written through `PUT /api/sessions/:id/note`, real clicks on the real forms, and
 * the note read back out of the SSE stream the card renders from.
 *
 * The note is SEEDED rather than produced by a real Foreman pass, which would cost a model
 * call per test. What that trades away is covered below it: `test/foreman-pending.test.ts`
 * pins that `dialogMarker` is the very string `classifyPending` stamps on the note, so the
 * marker these tests write is the marker the worker writes.
 */

const TASK = "pick the toolchain";
/** The prompt `fake-claude.mjs` answers by raising an `AskUserQuestion` and blocking. */
const ASK_TURN = "ask me which linter to use";

const SUGGESTION = "Choose biome - it is already in the toolchain.";
/** The sentence the dashboard shows for a note whose review has since been resolved. */
const STALE_HINT = /already been resolved/;

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("article.card")).toHaveCount(1);
}

/**
 * The dispatched session as the daemon holds it, polled - see trap 4 in e2e/README.md.
 *
 * Waits for `agentSessionId`, not merely for the row, and that wait is load-bearing rather
 * than defensive. A note is keyed by `noteKeyFor`, which is the agent's own session id once
 * the session has BOUND and the synthetic id until then - deliberately, so a note survives the
 * synthetic-id churn. A fixture that pins a note before the bind therefore writes it under a
 * key the daemon is about to stop reading, and `session.note` goes null the moment the driver
 * reports in: the panel unmounts, and every assertion here reads as a pass or an error
 * depending only on which side of the bind the poll landed on.
 */
async function session(daemon: DaemonHandle): Promise<{
  id: string;
  cwd: string | null;
  paneDialog: Parameters<typeof dialogMarker>[0] | null;
}> {
  let found: Awaited<ReturnType<typeof session>> | null = null;
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
          id: string;
          cwd: string | null;
          runtime: string;
          agentSessionId: string | null;
          paneDialog: Parameters<typeof dialogMarker>[0] | null;
        }[];
        // Picked by runtime rather than by being the only row: process discovery is
        // machine-wide, so on a developer box this daemon also finds the operator's own
        // running agents. Those arrive as discovered TERMINAL sessions; the dispatched one is
        // the only `sdk` one.
        const sdk = all.find((s) => s.runtime === "sdk") ?? null;
        found = sdk;
        return sdk?.cwd && sdk.agentSessionId ? sdk.cwd : null;
      },
      { message: "the dispatched session is on the fleet, with a checkout and a bound agent" },
    )
    .toBeTruthy();
  return found!;
}

/**
 * Pin a Foreman note on this session, the way the worker's `putNote` does.
 *
 * `handledMarker` is the whole point of the fixture: it is how a note says WHICH ask it was
 * raised about, and every assertion below turns on the daemon matching it against the ask
 * that was answered.
 */
async function pinNote(
  daemon: DaemonHandle,
  sessionId: string,
  o: { marker: string; disposition: "escalated" | "pending"; recommendation?: string },
): Promise<void> {
  const res = await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/note`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "Which linter this repo should adopt.",
        brief: "Both are defensible, and the cost lands on whoever maintains the config.",
        recommendation: o.recommendation ?? SUGGESTION,
        disposition: o.disposition,
        lastAction:
          o.disposition === "escalated"
            ? "escalated for your decision"
            : "drafted a reply (awaiting you)",
        handledMarker: o.marker,
      }),
    },
  );
  expect(res.status, `the note was pinned: ${await res.clone().text()}`).toBe(200);
}

/** Send the prompt that makes the agent ask, and wait for the form it raises. */
async function askAndWait(page: Page): Promise<{ card: Locator; form: Locator }> {
  const card = page.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(ASK_TURN);
  await composer.press("Enter");
  const form = card.locator(".pane-dialog");
  await expect(form).toBeVisible({ timeout: 15_000 });
  return { card, form };
}

/** The Foreman panel on the expanded card. */
const notePanel = (card: Locator): Locator => card.locator(".foreman-note");

/**
 * A string that must no longer be anywhere on this card.
 *
 * `toHaveCount(0)` on the text rather than `not.toContainText` on the panel, because the two
 * disagree about the BEST possible outcome. `not.toContainText` has to resolve its container
 * to read it, so it errors with "element(s) not found" when the panel unmounts altogether -
 * meaning a change that cleared the note more thoroughly than this does would fail the spec
 * for being too good. Counting the text is true whether the panel is emptied or gone.
 */
async function goneFromCard(card: Locator, text: string | RegExp): Promise<void> {
  await expect(card.getByText(text)).toHaveCount(0);
}

test("answering the agent's own question retires the note pinned on it", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  // The marker is built from the dialog the daemon actually published, not from a literal, so
  // this cannot pass against a projection that changed shape underneath it.
  const live = await session(daemon);
  expect(live.paneDialog, "the ask reached the card as a dialog").toBeTruthy();
  await pinNote(daemon, live.id, {
    marker: dialogMarker(live.paneDialog!),
    disposition: "escalated",
  });

  // Present before it is asserted absent, which is the standing rule in e2e/README.md: a
  // spec that only checked the note was gone would pass with the note never written.
  const note = notePanel(card);
  await expect(note).toContainText("needs your decision");
  await expect(note).toContainText("Suggested answer");
  await expect(note).toContainText(SUGGESTION);

  // Answer the agent, and touch nothing on the Foreman panel. Deliberately NOT what Foreman
  // recommended: the note is retired because the question is closed, not because the operator
  // happened to agree with the suggestion.
  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });

  // The decision is no longer being asked of you: no suggestion, no controls, and nothing
  // still claiming to need you.
  await goneFromCard(card, "Suggested answer");
  await goneFromCard(card, SUGGESTION);
  await goneFromCard(card, "needs your decision");
  await expect(card.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Approve & send" })).toHaveCount(0);

  // The purpose survives: this retires a spent DECISION, not the card's account of what the
  // session is for.
  await expect(note).toContainText("Which linter this repo should adopt.");
});

test("the drafted reply's Approve button goes with it", async ({ dashboard, daemon }) => {
  // The dangerous half, and the reason this is not merely tidiness. A `pending` draft draws a
  // live Approve & send, and on the driver surface approving delivers by INJECTING the text
  // into the session - so a stale draft offered to type an answer to a question that was
  // already answered, into an agent that was already running again.
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  const live = await session(daemon);
  await pinNote(daemon, live.id, {
    marker: dialogMarker(live.paneDialog!),
    disposition: "pending",
  });

  const note = notePanel(card);
  await expect(note).toContainText("drafted a reply");
  const approve = note.getByRole("button", { name: "Approve & send" });
  await expect(approve).toBeVisible();

  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });

  await expect(approve, "nothing is left to send, so nothing offers to send it").toHaveCount(0);
  await goneFromCard(card, "Proposed reply");
  await goneFromCard(card, SUGGESTION);
});

test("answering the review channel's question retires it too", async ({ dashboard, daemon }) => {
  // The other channel. A terminal-dispatched session has `AskUserQuestion` taken away and asks
  // over MCP instead, and the note for one of those carries a `review:<id>` marker.
  await dispatch(dashboard, daemon);
  const live = await session(daemon);

  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const created = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      cwd: live.cwd,
      kind: "input",
      title: "Which linter should this repo adopt?",
      body: "Which linter should this repo adopt?",
      decisions: [
        {
          id: "q",
          question: "Which linter should this repo adopt?",
          options: [
            { id: "o0", label: "biome", recommended: true },
            { id: "o1", label: "eslint" },
          ],
        },
      ],
    }),
  });
  expect(created.status, `the review channel accepted it: ${await created.clone().text()}`).toBe(200);
  const { id: reviewId } = (await created.json()) as { id: string };

  await pinNote(daemon, live.id, { marker: `review:${reviewId}`, disposition: "escalated" });

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const note = notePanel(card);
  await expect(note).toContainText("needs your decision");
  await expect(note).toContainText(SUGGESTION);
  // While the review is live the note is not stale, so the dashboard makes no such claim.
  await expect(note).not.toContainText(STALE_HINT);

  await card.getByRole("button", { name: "to review" }).click();
  const form = dashboard.locator(".review-modal");
  await form.getByRole("radio", { name: /eslint/ }).check();
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  // What used to be here: the banner still pinned, now explaining that the question it is
  // about has already been resolved, with a Dismiss button as its only remaining control.
  await goneFromCard(card, "needs your decision");
  await goneFromCard(card, SUGGESTION);
  // An explanation of a stale note is not a substitute for clearing it.
  await goneFromCard(card, STALE_HINT);
  await expect(card.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
});

test("a note about a DIFFERENT ask is still yours to decide", async ({ dashboard, daemon }) => {
  // The safety half. A note is the only surface an escalation has, so a retire that fired on
  // "this session was answered" rather than on "this ASK was answered" would silently throw
  // away a decision the human still owes - strictly worse than the stale note it clears.
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  const live = await session(daemon);
  const other = "Stop this session - it has been retrying the same command for an hour.";
  // A marker for an ask that is NOT the form on screen: an escalation raised off the session's
  // state, with no reply channel of its own.
  await pinNote(daemon, live.id, {
    marker: "state:awaiting_input:41",
    disposition: "escalated",
    recommendation: other,
  });

  const note = notePanel(card);
  await expect(note).toContainText(other);

  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });

  // Still on screen, and still asking. The form's answer said nothing about this.
  await expect(note).toContainText("needs your decision");
  await expect(note).toContainText(other);
});
