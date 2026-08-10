import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Native PTY rendering of the Conversation, driven end to end: a dispatched fake agent
 * leaves a real transcript, the real SSE stream carries it to the browser, and the panel
 * draws it as a terminal stream - prompt line in, stdout out, a run of tool calls folded
 * into one record, inside a frame with a live status line.
 *
 * Three claims, and only a browser can make any of them: that the daemon-stored preference
 * reaches the rendering, that one session's own switch beats that preference while the rest
 * of the fleet is untouched, and that the rendering is really the same conversation - same
 * composer, same transcript - rather than a second surface that happens to look like one.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const TOOL_RUN = "E2E_TERMINAL_RUN";

const EVIDENCE = artifactsDir("conversation-terminal-view");

/**
 * A picture of the rendering this spec is already asserting on, behind `MC_E2E_EVIDENCE`
 * so an ordinary run does not rewrite a binary for no added signal - a card carries a fresh
 * worktree uuid and a relative clock. Taken inside the regression rather than in a staged
 * capture, because what makes the picture worth anything is that the assertions around it
 * passed on the same run.
 */
async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the row being photographed.
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/conversation-terminal-view/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Set the dashboard's default rendering.
 *
 * Written to the daemon rather than to `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache. The reload is what makes it
 * take - the same idiom `board-held-by-workflow.spec.ts` uses for the layout.
 */
async function useRendering(page: Page, daemon: DaemonHandle, view: "chat" | "terminal"): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationView: view }),
  });
  const body = (await response.json()) as { config?: { conversationView?: string } };
  expect(body.config?.conversationView, "the daemon accepted the rendering").toBe(view);
  await page.reload();
}

/**
 * Expand a card's conversation.
 *
 * Settled first: a live card re-lays-out for a second or so after anything happens to it -
 * a titler rename, the model arriving, the branch line - and collapsing its neighbour
 * reflows the whole grid. The assertion that the control exists runs inside the click, so
 * this is a barrier and not a mask.
 */
async function openConversation(card: Locator): Promise<void> {
  await settled(card);
  await card.getByRole("button", { name: "Expand conversation" }).click();
  await expect(card.locator(".transcript")).toBeVisible();
}

/** Leave a folded run of tool calls, plus one human turn, in the transcript. */
async function seedRun(card: Locator, reply: Locator): Promise<void> {
  await expect(reply).toBeEnabled();
  await reply.fill(TOOL_RUN);
  await reply.press("Enter");
  // The echoed reply is written AFTER the tool turns, so its arrival means the transcript
  // update carrying them has already reached the browser.
  await expect(card.getByText(`Mock reply to: ${TOOL_RUN}`)).toBeVisible();
}

test("the terminal rendering draws the conversation as one stream", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, "exercise the terminal rendering");
  const card = dashboard.locator("article.card").first();
  await openConversation(card);

  // The shipped default is the chat log, and nothing about this session says otherwise
  // yet. Asserting it first is what makes the switch below mean something.
  await expect(card.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);
  await seedRun(card, card.getByPlaceholder(/^Reply to this session/));

  await useRendering(dashboard, daemon, "terminal");
  const reopened = dashboard.locator("article.card").first();
  await openConversation(reopened);

  // The frame: a titlebar naming the window, the agent and the shell it is really on.
  const terminal = reopened.getByRole("region", { name: "Conversation terminal" });
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText("mission-control: conversation · claude");
  await expect(terminal.locator(".pty-attach")).toHaveText(/attached|attaching/);

  // The human turn is a prompt line, not a bubble - and it names who typed it.
  const prompt = terminal.locator(".pty-commandline").filter({ hasText: TOOL_RUN });
  await expect(prompt).toBeVisible();
  await expect(prompt.locator(".pty-host")).toHaveText("you@mission");

  // The agent's turn is stdout under a speaker header.
  await expect(terminal.locator(".pty-speaker").first()).toContainText("claude / stdout");
  await expect(terminal.getByText("Mock reply before the run")).toBeVisible();

  // The run of three tool-only turns is ONE record, closed, counting what it holds.
  const record = terminal.locator(".pty-toolrun").filter({ hasText: "executed 3 commands" });
  await expect(record).toBeVisible();
  await expect(record.locator(".pty-tools, .turn-tools-lines")).toBeHidden();
  await record.locator("summary").click();
  // Open, it lists the literal command - not the chip's 40-character summary.
  await expect(record.getByText("rg PersonaDirective src test")).toBeVisible();
  await expect(record.getByText("git status --short")).toBeVisible();

  // And each line reads as one command, tool name included, because copying a line out of
  // this record is the point of opening it. Asserted as the row's whole TEXT rather than by
  // its parts: the parts are separate spans, and a layout gap between them is not a space
  // in what lands on the clipboard. `toHaveText` normalises runs of whitespace, so this
  // passes on the gap being present and fails on it being absent.
  const lines = record.locator(".tool-line");
  await expect(lines).toHaveText([
    "bash rg PersonaDirective src test",
    "bash git status --short",
    "read src/server/registry.ts",
  ]);

  // Nothing in the record claims a result: the transcript records none, and the sideband's
  // honesty contract holds here too. These words failing to appear is meaningful because
  // the commands above are proven present.
  await expect(record).not.toContainText(/done|exit|succeeded|failed|passed/i);

  // Find counts what this rendering SHOWS. `--short` is only ever visible inside an opened
  // record - the chat log keeps it in a hover tooltip - so a search for it must both count
  // and mark it here. A hit find can see but not highlight, or text on screen find reports
  // zero of, are the two ways this feature lies about a number.
  await reopened.locator(".card-meta").click();
  await dashboard.keyboard.press("Meta+f");
  const findBox = reopened.getByRole("searchbox", { name: "Find in conversation" });
  await findBox.fill("--short");
  await expect(reopened.locator(".transcript-log mark.find-hit")).toHaveCount(1);
  await expect(reopened.locator(".transcript-log mark.find-hit")).toHaveText("--short");
  await dashboard.keyboard.press("Escape");
  await expect(findBox).toHaveCount(0);

  // The composer keeps the prompt metaphor, and keeps working.
  await expect(reopened.getByText("mission ❯")).toBeVisible();
  const reply = reopened.getByPlaceholder(/^Send the next instruction/);
  await expect(reply).toBeEnabled();

  // The status line carries this session's real state.
  const statusLine = reopened.getByRole("region", { name: "Session status" });
  await expect(statusLine).toBeVisible();
  await expect(statusLine).toContainText(/claude: (idle|working|running)/);
  await expect(statusLine).toContainText("harness/");
  // A dispatched SDK session reports no subprocess, so there is no pid to show - and the
  // line shows none rather than `pid 0`, which would name a process that does not exist.
  // The branch above is proven present on the same element, so this absence is a real
  // assertion about what the line draws and not about whether it rendered.
  await expect(statusLine).not.toContainText("pid");
  await expect(statusLine).toContainText("terminal");
  await expect(statusLine).toContainText("kill");

  await shoot(dashboard, reopened, "01-terminal-rendering");

  // Still the same conversation underneath: the reply goes out through the same box and
  // comes back into the same log.
  await reply.fill("second instruction");
  await reply.press("Enter");
  await expect(reopened.getByText("Mock reply to: second instruction")).toBeVisible();
});

test("one session reads as a terminal while the rest stay on the chat log", async ({
  dashboard,
  daemon,
}) => {
  // The per-session half of the switch, and the claim that makes it worth having: flipping
  // one session must say nothing about the next one. Two sessions, because a single card
  // cannot tell "this session changed" from "the dashboard changed".
  await dispatch(dashboard, daemon, "read this one as a terminal");
  await dispatch(dashboard, daemon, "stay on the chat log");
  const cards = dashboard.locator("article.card");
  await expect(cards).toHaveCount(2);

  // Addressed by their own goals rather than by position: the fleet reorders as sessions
  // settle, so `nth(1)` after a collapse is whichever card the sort left there - which is
  // how "the other one is untouched" would silently assert against the same card twice.
  const first = cards.filter({ hasText: "read this one as a terminal" });
  const second = cards.filter({ hasText: "stay on the chat log" });
  await openConversation(first);
  const toggle = first.getByRole("button", { name: "Terminal view" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(first.getByRole("region", { name: "Conversation terminal" })).toBeVisible();

  await shoot(dashboard, first, "02-per-session-override");

  // The other card, opened after: untouched by a choice that belongs to its neighbour.
  await first.getByRole("button", { name: "Collapse conversation" }).click();
  await openConversation(second);
  await expect(second.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Terminal view" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(second.getByPlaceholder(/^Reply to this session/)).toBeVisible();

  // And the first card kept its choice across being collapsed and reopened - the override
  // outlives the panel that made it, which is why it is not state inside that panel.
  await second.getByRole("button", { name: "Collapse conversation" }).click();
  await openConversation(first);
  await expect(first.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
});

test("the frame fits both places a conversation is mounted, at both widths", async ({
  dashboard,
  daemon,
}) => {
  // The expanded card is narrower than the console detail pane and crosses the container
  // breakpoint the conversation already had. Markup cannot say "still on screen", so this
  // one measures: the status line is the last row in the frame and the one carrying the
  // session's state, so a frame that overflows loses exactly the thing worth keeping.
  await dispatch(dashboard, daemon, "fit the frame at every width");
  await useRendering(dashboard, daemon, "terminal");

  const card = dashboard.locator("article.card").first();
  await openConversation(card);
  const frame = card.getByRole("region", { name: "Conversation terminal" });
  const statusLine = card.getByRole("region", { name: "Session status" });
  await expect(statusLine).toBeVisible();

  await dashboard.setViewportSize({ width: 620, height: 900 });
  await settled(frame);
  // Narrow, the titlebar drops its centred title and the send hint goes - both are things
  // a person can get elsewhere. What must not go is the run state.
  await expect(frame.locator(".pty-title")).toBeHidden();
  await expect(card.locator(".pty-sendkey")).toBeHidden();
  await expect(statusLine).toBeVisible();
  await expect(statusLine).toContainText("claude:");

  const frameBox = (await frame.boundingBox())!;
  const statusBox = (await statusLine.boundingBox())!;
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1);
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height + 1);
  // Wrapped rather than squashed to nothing: the row still has a line of height.
  expect(statusBox.height).toBeGreaterThan(12);
  // And the box is still reachable, which is the other thing a squeezed frame loses.
  await expect(card.getByPlaceholder(/^Send the next instruction/)).toBeVisible();

  await shoot(dashboard, card, "03-narrow-card");

  // The console detail is the other mount, and the wider one. Same frame, from the same
  // panel - reached by actually switching layouts, because the claim is about a surface a
  // person arrives at rather than about a selector.
  await dashboard.setViewportSize({ width: 1400, height: 900 });
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(((await response.json()) as { config?: { layout?: string } }).config?.layout).toBe("console");
  await dashboard.reload();

  // The console opens on nothing until a session is chosen, so choose one the way a person
  // does - by name, off the rail.
  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  await rail.getByRole("button", { name: /Fit the Frame at Every Width/i }).click();

  const detail = dashboard.locator(".detail-conv");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
  await expect(detail.getByRole("region", { name: "Session status" })).toBeVisible();
  await expect(detail.locator(".pty-title")).toBeVisible();
  await expect(detail.getByPlaceholder(/^Send the next instruction/)).toBeEnabled();

  await shoot(dashboard, detail, "04-console-detail");
});

test("a session's own choice beats the dashboard default, and the tab forgets it", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "override the terminal default");
  await useRendering(dashboard, daemon, "terminal");

  const card = dashboard.locator("article.card").first();
  await openConversation(card);
  // The default put this session in the terminal...
  const toggle = card.getByRole("button", { name: "Terminal view" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("region", { name: "Conversation terminal" })).toBeVisible();

  // ...and the session's own switch takes it back out, which is the direction that would
  // be missing if the override could only ever turn the terminal ON.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);
  await expect(card.getByPlaceholder(/^Reply to this session/)).toBeVisible();

  // The override is honestly scoped to the tab: a reload starts over from the daemon's
  // default. Nothing persists it, and this is the assertion that keeps it that way.
  await dashboard.reload();
  const reloaded = dashboard.locator("article.card").first();
  await openConversation(reloaded);
  await expect(reloaded.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
});
