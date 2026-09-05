import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A Codex conversation whose prose arrives as `item_completed`, driven end to end.
 *
 * Codex CLI 0.153.4 moved the rollout records that carry a conversation. A top-level
 * thread stopped writing `event_msg/user_message` and `event_msg/agent_message` and started
 * writing `event_msg/item_completed`, whose `item.type` is `UserMessage` or `AgentMessage`.
 * Its TOOL calls did not move - they are still `response_item/custom_tool_call` - and that
 * asymmetry is the whole shape of the bug an operator met: every new Codex session opened on
 * a Conversation holding one folded run of commands and no words at all, on either side.
 * `parseCodexMessages` recognised only the old names, so it dropped the prose and kept the
 * commands, which reads exactly like an agent that ran fourteen things and said nothing.
 *
 * Why a browser: the reader's unit tests can assert a parse, and they do, but only this
 * layer can say that a rollout written by the agent binary reaches a person as readable
 * text - file to daemon to SSE to DOM. The defect sat in the middle of that chain with
 * every layer at either end healthy, which is why it shipped.
 *
 * Terminal is the rendering under test because it is the one the report came from, and its
 * frame is the surface that made the emptiness so stark: a status line, a live prompt, and
 * a single collapsed record above it. The reader feeds both renderings, and
 * `conversation-terminal-view.spec.ts` already pins that they share it.
 *
 * The run of commands is asserted BESIDE the prose deliberately. A reader that dropped the
 * prose still rendered the run, so a spec that only proved words appear could pass while the
 * two were mis-grouped into one unreadable turn - and one that only counted the run would
 * have passed all along, before the fix and after.
 *
 * No model tokens: `MISSION_CODEX_BIN` points at `fake-codex.mjs` throughout.
 */

/** The fake's prompt that leaves a preamble, a run of three commands, and a reply. */
const TOOL_RUN = "E2E_TERMINAL_RUN";

const EVIDENCE = artifactsDir("codex-item-completed-conversation");

/**
 * A picture of the rendering this spec already asserts on, behind `MC_E2E_EVIDENCE` and
 * produced outside the repository. Taken INSIDE the regression rather than in a staged
 * capture: what makes the picture worth anything is that the assertions around it passed on
 * the same run. Unconditional, it would rewrite a binary every run for no added signal - a
 * card carries a fresh worktree uuid and a relative clock.
 */
async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the surface being photographed.
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/codex-item-completed-conversation/${name}.png`);
}

test.use({
  daemonEnv: {
    // Turns this fake Codex into a 0.153.4 one: prose as `item_completed` items, tool calls
    // left exactly where they always were. Every other Codex spec runs without it and keeps
    // covering the older records, which 0.153.4 still writes for a subagent thread.
    MC_E2E_CODEX_ITEM_EVENTS: "1",
  },
});

async function dispatchCodex(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("a Codex rollout that records prose as item_completed still reads as a conversation", async ({
  dashboard,
  daemon,
}) => {
  // Terminal is the reported surface. Pinned before the dispatch so the card opens on it,
  // rather than being switched under a live conversation.
  const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationView: "terminal" }),
  });
  expect(pinned.ok, "the daemon should accept the terminal rendering").toBe(true);
  await dashboard.reload();

  // Deliberately not a phrase asserted on below: the task becomes the card's own heading,
  // so a goal echoing the transcript would make every text matcher here ambiguous.
  const goal = "exercise the renamed rollout records";
  await dispatchCodex(dashboard, daemon, goal);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = dashboard.locator(".console-detail");
  await settled(card);
  const terminal = card.getByRole("region", { name: "Conversation terminal" });
  await expect(terminal).toBeVisible();

  // Terminal's own composer prompt - the same shared reply box the Chat rendering
  // labels "Reply to this session…".
  const reply = card.getByPlaceholder(/^Send the next instruction/);
  await expect(reply).toBeEnabled();

  // The dispatch's own turn, before anything else is sent. BOTH halves: the operator's
  // prompt is a `UserMessage` item and the answer an `AgentMessage` item, and the reader
  // lost them together - so asserting only the reply would leave the more common half of
  // the complaint, "my own message isn't there either", uncovered.
  await expect(terminal.getByText(`Mock reply to: ${goal}`)).toBeVisible();
  await expect(terminal.getByText(goal, { exact: false }).first()).toBeVisible();

  // Now the shape that made the bug legible: prose and a run of commands in one stretch.
  await reply.fill(TOOL_RUN);
  await reply.press("Enter");

  // Written last by the fake, so its arrival means the records above it have already
  // reached the browser.
  await expect(terminal.getByText(`Mock reply to: ${TOOL_RUN}`)).toBeVisible();

  // The preamble is prose the old reader dropped, and it is its OWN turn rather than
  // something welded onto the run below it.
  await expect(terminal.getByText("Mock reply before the run")).toBeVisible();

  // And the run is still one folded record of three, unchanged by the rename. This is the
  // assertion that passed before the fix; it is here to prove the fix did not buy the prose
  // back by breaking the grouping.
  const record = terminal.locator(".pty-toolrun");
  await expect(record).toHaveCount(1);
  await expect(record).toContainText("codex executed 3 commands");

  await shoot(dashboard, card, "conversation-reads-again");
});
