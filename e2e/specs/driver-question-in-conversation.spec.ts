import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The other channel a session asks its human through, and what it leaves behind.
 *
 * A session dispatched to a TERMINAL has Claude's built-in `AskUserQuestion` taken away and
 * asks through the MCP review channel instead (`ask-channel.ts`), which
 * `review-answers-in-conversation.spec.ts` covers end to end. A session on the SDK runtime -
 * every session in this suite, and the default a dispatch takes - keeps the built-in
 * deliberately: the ask arrives over `canUseTool` as a driver request, which IS the
 * dashboard's own control, so the MCP stand-in would be approximating something already
 * native.
 *
 * The two used to end differently, and only one of them ended well. Answering a driver
 * request resolved the callback the agent was blocked on and recorded nothing, and the
 * transcript could not cover for it: the answer lands in the JSONL as a user turn that is
 * purely a `tool_result`, which every harness parser drops as machine noise. So the log read
 * as a grey `AskUserQuestion` chip, a silence, and then the agent acting on a decision that
 * appeared from nowhere - while the identical question asked over MCP left a permanent
 * record. This pins the missing half.
 *
 * Everything here is real except the model: a real dispatched SDK session, a real
 * `can_use_tool` control request raised by the fake CLI over the real vendored SDK, the real
 * form the dashboard draws for one, the real `POST /api/sessions/:id/submit-options` route,
 * and the conversation read back off the real SSE stream.
 */

const EVIDENCE = artifactsDir("driver-question-in-conversation");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE` for the same reason every other capture here is: an ordinary run
 * would rewrite the binaries for no added signal. Taken inside the regression test rather
 * than from a staged fixture, so the picture is of a run whose assertions passed.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // form this spec drives is a column of adjacent buttons.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/driver-question-in-conversation/${name}.png`);
}

const TASK = "pick the toolchain";
/** The prompt `fake-claude.mjs` answers by raising an `AskUserQuestion` and blocking. */
const ASK_TURN = "ask me which linter to use";
/** `--attention`, the gold a review answer wears. Asserted as a used colour, not a class. */
const ATTENTION_GOLD = "rgb(246, 167, 51)";

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
 * Send the prompt that makes the agent ask, and wait for the form it raises.
 *
 * The conversation is opened first because the composer lives in it - and it stays open, so
 * the answer's arrival in the log is observed on the same screen the question was answered
 * on, which is the reading the feature is about.
 */
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

test("answering the agent's own question puts the whole form in the conversation", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  // Both questions are on screen at once, which is what a driver form can do and a pane
  // could not - the TUI shows one tab at a time.
  await expect(form).toContainText("Which linter?");
  await expect(form).toContainText("Which checks should run?");

  await shoot(dashboard, "the-question-as-asked", form);

  // Deliberately NOT the first row of either question: a spec that picks the default
  // passes just as well against a form that ignores the click.
  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();

  // The form goes when the agent takes the answer - the card is no longer waiting on you.
  await expect(form).toBeHidden({ timeout: 15_000 });

  const answer = card.locator(".transcript-log .review-answer");
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await expect(answer).toContainText("you answered");

  // Both questions replay, each with what was passed over still listed beside what was
  // taken. That is the point of drawing the form rather than the response string.
  await expect(answer.getByLabel("Chosen: eslint")).toBeVisible();
  await expect(answer.getByLabel("Not chosen: biome")).toBeVisible();
  await expect(answer.getByLabel("Chosen: tests")).toBeVisible();
  await expect(answer.getByLabel("Not chosen: types")).toBeVisible();
  await expect(answer).toContainText("Which linter?");
  await expect(answer).toContainText("Which checks should run?");

  // A record, not a control. A resolved question cannot be re-answered, and something that
  // looks live but does nothing is worse than prose.
  await expect(answer.locator("input, button, textarea, select")).toHaveCount(0);

  // The one styling fact this is about: the entry wears the gold of the form it was
  // answered on, so it cannot be mistaken for your own blue turn or Foreman's purple.
  await expect(answer).toHaveCSS("border-left-color", ATTENTION_GOLD);

  // Placed where you SPOKE, above the turn your answer unblocked. The stamp for that is
  // taken before the answer is handed to the driver: read afterwards it is a reading of a
  // moment when the agent was already running again, and the entry files below the reply it
  // caused - which is the same conversation telling the reader the wrong story about who
  // moved first.
  const reply = card.getByText("Mock reply to: ask me which linter to use", { exact: true });
  await expect(reply).toBeVisible({ timeout: 15_000 });
  const [answerBox, replyBox] = [await answer.boundingBox(), await reply.boundingBox()];
  expect(answerBox!.y, "your answer reads above the turn it released").toBeLessThan(replyBox!.y);

  // The log is a scroller and the entry is taller than one screenful of it, so the capture
  // is taken against a viewport tall enough to hold the whole thing rather than against a
  // crop that would cut a question off.
  await dashboard.setViewportSize({ width: 1280, height: 1400 });
  await answer.scrollIntoViewIfNeeded();
  await shoot(dashboard, "the-answer-in-the-conversation", card.locator(".transcript-log"));
});

test("a typed answer is recorded as typed, not as nothing chosen", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  await form.getByLabel("Custom answer for Which linter?").fill("oxlint, actually");
  await form.getByRole("checkbox", { name: /types/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });

  const answer = card.locator(".transcript-log .review-answer");
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await expect(answer).toContainText("oxlint, actually");
  // The question it was typed against still shows every row it declined, so the reader can
  // see the choice was made against these options and not in a vacuum.
  await expect(answer.getByLabel("Not chosen: biome")).toBeVisible();
  await expect(answer.getByLabel("Not chosen: eslint")).toBeVisible();
});

test("a question re-presented after a first answer leaves both rounds in the log", async ({
  dashboard,
  daemon,
}) => {
  // The shape a real session took: the operator answered entirely in free text ("I can't see
  // the mockups - open them and re-prompt me"), the agent did that and asked the SAME
  // questions again, and they picked. Two decisions minutes apart, and the log owes the
  // reader both - the first is what explains why the second exists.
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  await form.getByLabel("Custom answer for Which linter?").fill("show me the mockups first");
  await form.getByLabel("Custom answer for Which checks should run?").fill("same - show me first");
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });

  const answers = card.locator(".transcript-log .review-answer");
  await expect(answers).toHaveCount(1, { timeout: 15_000 });

  // The agent asks the same thing again. Same questions, same options, new request.
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await composer.fill(ASK_TURN);
  await composer.press("Enter");
  await expect(form).toBeVisible({ timeout: 15_000 });

  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });

  // Two entries, not one overwritten twice - and each says what THAT round said, so a swap
  // or a duplicate cannot pass.
  await expect(answers).toHaveCount(2, { timeout: 15_000 });
  await expect(answers.first()).toContainText("show me the mockups first");
  await expect(answers.last().getByLabel("Chosen: eslint")).toBeVisible();
  await expect(answers.last().getByLabel("Chosen: tests")).toBeVisible();
  // The rounds read in the order they happened, oldest first.
  const [firstBox, lastBox] = [
    await answers.first().boundingBox(),
    await answers.last().boundingBox(),
  ];
  expect(firstBox!.y, "the round that asked for the mockups reads above the one that chose")
    .toBeLessThan(lastBox!.y);

  await dashboard.setViewportSize({ width: 1280, height: 1800 });
  await answers.first().scrollIntoViewIfNeeded();
  await shoot(dashboard, "both-rounds", card.locator(".transcript-log"));
});

test("an unanswered question is not in the log as though it had been answered", async ({
  dashboard,
  daemon,
}) => {
  // Absence asserted only after presence, and against a conversation that has SETTLED: the
  // asking turn is on screen and the form is up, so "no entry yet" is a real state rather
  // than an early read. The live review list the conversation folds in carries every status,
  // so this is the filter that keeps a question still on screen out of the log.
  await dispatch(dashboard, daemon);
  const { card, form } = await askAndWait(dashboard);

  const log = card.locator(".transcript-log");
  await expect(log.getByText(ASK_TURN, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(log.locator(".review-answer")).toHaveCount(0);

  // And the same conversation gains the entry the moment it IS answered - which is what
  // makes the count above evidence of the filter rather than of a card that never renders.
  await form.getByRole("radio", { name: /biome/ }).click();
  await form.getByRole("checkbox", { name: /types/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(log.locator(".review-answer")).toHaveCount(1, { timeout: 15_000 });
});
