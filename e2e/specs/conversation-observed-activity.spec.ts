import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Conversation's Observed activity sideband, driven end to end: a dispatched fake
 * agent leaves `tool_use` records in a real transcript file, the real SSE stream carries
 * them to the browser, and the rail beside the log renders them - with the observed-only
 * language the feature is named for, Find's temporary ownership of the same column, and
 * the narrow layout's disclosure all asserted as a person would meet them.
 *
 * The fake's `E2E_OBSERVED_TOOLS` turn writes the two shapes that matter: a tool call
 * BESIDE prose (the shape the main log's tool-run folding does not fold, so a rail
 * deriving from folded rows would miss it) and a tool-only turn. No model is spent -
 * `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const TOOL_TURN = "E2E_OBSERVED_TOOLS";

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/conversation-observed-activity/", import.meta.url));

/**
 * Photograph the surface this spec is already asserting on. Behind `MC_E2E_EVIDENCE`
 * and committed, because a card carries a fresh worktree uuid and a relative clock, so
 * an unconditional capture would rewrite a binary on every run for no added signal.
 * Inside the regression rather than a staged walk: the point of the picture is that
 * the assertions around it passed on the same run.
 */
async function shoot(page: Page, card: ReturnType<Page["locator"]>, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and
  // it lands on top of the row being photographed.
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED docs/evidence/conversation-observed-activity/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  // Deliberately does not contain "observed activity": the task becomes the card's own
  // h2 title, and a colliding accessible name would make every heading and text matcher
  // below ambiguous.
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the conversation sideband");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Dispatch, expand the conversation, and leave deterministic tool activity in it. */
async function openConversationWithActivity(
  page: Page,
  daemon: DaemonHandle,
): Promise<ReturnType<Page["locator"]>> {
  await dispatch(page, daemon);

  const card = page.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();

  // Before any tool call exists, the rail says so instead of showing nothing: the
  // dispatch's opening exchange is prose only.
  const activity = card.getByRole("region", { name: "Observed activity" });
  await expect(activity).toBeVisible();
  await expect(activity.getByText("No observed tool activity yet")).toBeVisible();

  await reply.fill(TOOL_TURN);
  await reply.press("Enter");
  // The echoed reply is written AFTER the tool turns, so its arrival means the
  // transcript update carrying them has already reached the browser.
  await expect(card.getByText(`Mock reply to: ${TOOL_TURN}`)).toBeVisible();
  return card;
}

test("observed tool activity appears beside the conversation, honestly labelled", async ({
  dashboard,
  daemon,
}) => {
  const card = await openConversationWithActivity(dashboard, daemon);
  const activity = card.getByRole("region", { name: "Observed activity" });

  // The surface names itself with a real heading, and states its window.
  await expect(card.getByRole("heading", { name: "Observed activity", exact: true })).toBeVisible();
  await expect(activity.getByText("Tool calls observed in the loaded transcript.")).toBeVisible();

  // Both invocations arrived, through the shared chip projection: the read that rode a
  // prose turn (label + target), and the tool-only bash (label + command name, not the
  // whole command line).
  await expect(activity.getByText("src/web/styles.css")).toBeVisible();
  await expect(activity.getByText("read", { exact: true })).toBeVisible();
  await expect(activity.getByText("bash", { exact: true })).toBeVisible();
  await expect(activity.getByText("ls", { exact: true })).toBeVisible();
  await expect(activity.getByText("No observed tool activity yet")).toBeHidden();

  // The mixed prose/tool turn is represented on BOTH surfaces: its prose in the log,
  // its tool call in the rail - and the inline chip the transcript already drew for it
  // is still there, because the rail supplements the chips rather than replacing them.
  await expect(card.getByText("Mock reply with observed tools")).toBeVisible();
  await expect(card.locator(".transcript-log .tool-chip").filter({ hasText: "read" })).toBeVisible();

  await shoot(dashboard, card, "01-wide-rail");

  // Observed-only language: the rows carry no lifecycle verdicts. These words failing
  // to appear is meaningful because the rows above are proven present.
  await expect(activity).not.toContainText(/running|complete|succeeded|failed|duration/i);
});

test("Find borrows the secondary rail and closing it restores Observed activity", async ({
  dashboard,
  daemon,
}) => {
  const card = await openConversationWithActivity(dashboard, daemon);
  const activity = card.getByRole("region", { name: "Observed activity" });
  await expect(activity.getByText("bash", { exact: true })).toBeVisible();

  // Select the card (the expand button deliberately does not), then open find with
  // its chord. `Meta+f`, not `ControlOrMeta`: the app's chord grammar reads `cmd` off
  // `metaKey`, which is what Playwright synthesizes for Meta on every platform.
  await card.locator(".card-meta").click();
  await dashboard.keyboard.press("Meta+f");

  // Find owns the column now - whole, not shared: its rail is visible, activity is gone.
  await expect(card.getByRole("searchbox", { name: "Find in conversation" })).toBeVisible();
  await expect(card.getByRole("complementary", { name: "Search results" })).toBeVisible();
  await expect(card.getByRole("region", { name: "Observed activity" })).toHaveCount(0);

  await shoot(dashboard, card, "02-find-owns-rail");

  // Closing find hands the column back, with the same rows still derived from the
  // same transcript state - nothing was lost to the takeover.
  await dashboard.keyboard.press("Escape");
  await expect(card.getByRole("searchbox", { name: "Find in conversation" })).toHaveCount(0);
  await expect(activity).toBeVisible();
  await expect(activity.getByText("bash", { exact: true })).toBeVisible();
});

test("a narrow conversation collapses activity to a disclosure the reader can open", async ({
  dashboard,
  daemon,
}) => {
  const card = await openConversationWithActivity(dashboard, daemon);

  // Narrow the PANEL, live: the layout is a container query on the conversation's own
  // width, so shrinking the window is exactly how a person reaches this state.
  await dashboard.setViewportSize({ width: 600, height: 900 });

  const activity = card.getByRole("region", { name: "Observed activity" });
  const toggle = activity.getByRole("button", { name: /Observed activity/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Collapsed, the rows and the note are out of the way - the transcript keeps its
  // height until asked.
  await expect(activity.getByText("bash", { exact: true })).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(activity.getByText("bash", { exact: true })).toBeVisible();
  await expect(activity.getByText("src/web/styles.css")).toBeVisible();

  await shoot(dashboard, card, "03-narrow-disclosure-open");

  // The composer survives the stacked section: still on screen, still writable.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeVisible();
  await expect(reply).toBeEnabled();

  // And the disclosure closes as it opened.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(activity.getByText("bash", { exact: true })).toBeHidden();
});
