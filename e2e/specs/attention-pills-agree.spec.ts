import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";
import type { Locator, Page } from "@playwright/test";

/**
 * What is at stake: the topbar must not say a session is stuck and then open an empty inbox.
 *
 * The pulse carries two amber figures. `N need you` counts SESSIONS in an attention tone;
 * `N to answer` counts the attention fold's total and is the one that opens the inbox. They
 * are different UNITS of one set on purpose - agents blocked, versus replies owed - so a
 * session holding three questions correctly reads `1 need you / 3 to answer`.
 *
 * They were different SETS as well, and this spec pins the worst case shut. `awaiting_input`
 * has exactly two writers in the whole daemon - the Claude `Notification` and Codex
 * `PermissionRequest` hook translators - and NEITHER files a review. So the most common way a
 * session becomes blocked produced `1 need you` beside no `to answer` segment at all: the
 * operator saw an amber count with nothing to click, and the inbox that was supposed to be the
 * one place to drain everything reported "Nothing needs you" while an agent sat waiting.
 *
 * Everything here is real: a real daemon, a real dispatched SDK session, a real
 * `POST /hooks/Notification` carrying exactly what `hooks/harness-hook.mjs` sends, the real
 * registry `applyHook` path that writes the state, and the real fold rendered in a browser.
 * The only stand-in is the model.
 */

const TASK = "check the linter config";

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/attention-pills-agree/", import.meta.url));

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE` like every other capture in this suite: an ordinary run would
 * rewrite the binaries for no added signal. Taken inside the regression test rather than from
 * a staged fixture, so the picture is of a run whose assertions passed.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/attention-pills-agree/${name}.png`);
}

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
  // The dispatched card, NOT a card count. Process discovery is machine-wide, so on a
  // developer box driving real agents this daemon also finds their sessions, and every
  // absolute figure here would be a function of what else happens to be running.
  await expect(page.locator("article.card").filter({ hasText: "Check the Linter Config" })).toBeVisible();
}

/**
 * Post the hook a real Claude install posts when it parks on a permission prompt.
 *
 * Byte-for-byte the shape `hooks/harness-hook.mjs` forwards: the raw event's selected fields
 * plus the terminal env it captured. Bound to the session by `cwd`, which is
 * `findSessionByEnv`'s third resolution path and the only one available to a session the
 * daemon launched itself rather than discovered in a pane.
 *
 * The message deliberately avoids "waiting for your input" - `isIdleNudge` treats that exact
 * phrase as the periodic prompt-nudge and reports `idle`, which would make this spec assert
 * against a session that is not blocked at all.
 */
async function parkOnPermissionPrompt(daemon: DaemonHandle, cwd: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/hooks/Notification`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: "claude",
      cwd,
      env: {},
      message: "Claude needs your permission to use Bash",
    }),
  });
  expect(res.status, "the daemon accepted the hook").toBe(204);
}

/**
 * The dispatched session's checkout, which is what binds the hook to it.
 *
 * Picked by runtime rather than by being the only row: this daemon's process discovery is
 * machine-wide, so on a developer box it also finds the operator's own running agents. Those
 * arrive as discovered TERMINAL sessions; the one dispatched here is the only `sdk` one.
 */
async function dispatchedSessionCwd(daemon: DaemonHandle): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/api/sessions`);
  const all = (await res.json()) as { id: string; cwd: string; runtime: string }[];
  const dispatched = all.filter((s) => s.runtime === "sdk");
  expect(dispatched.length, "exactly one SDK session was dispatched").toBe(1);
  return dispatched[0]!.cwd;
}

/** A pulse segment's figure, or 0 when the segment is hidden because it is at zero. */
async function pulseCount(page: Page, label: string): Promise<number> {
  const seg = page.locator(".pulse-seg", { hasText: label });
  if ((await seg.count()) === 0) return 0;
  return Number(await seg.locator(".pulse-n").innerText());
}

test("a session parked on a permission prompt is counted AND answerable", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  // Deltas, not absolutes, for the discovery reason above: what matters is that ONE new
  // blocked session moves BOTH figures by one, whatever else the box happens to be running.
  const beforeAmber = await pulseCount(dashboard, "need you");
  const beforeOwed = await pulseCount(dashboard, "to answer");

  await parkOnPermissionPrompt(daemon, await dispatchedSessionCwd(daemon));

  const needYou = dashboard.locator(".pulse-seg", { hasText: "need you" });
  const toAnswer = dashboard.locator("button.pulse-seg", { hasText: "to answer" });

  await expect(needYou.locator(".pulse-n")).toHaveText(String(beforeAmber + 1));
  // The defect: this segment did not move, and at a quiet fleet it did not render at all -
  // an amber count on the left with nothing to click on the right.
  await expect(toAnswer, "an amber session with nothing to click is the whole defect").toBeVisible();
  await expect(toAnswer.locator(".pulse-n")).toHaveText(String(beforeOwed + 1));
  await shoot(dashboard, "pulse-both-segments", dashboard.locator(".pulse"));

  // And the click has to land somewhere. It used to open a modal reading "Nothing needs you".
  //
  // Settled first: a segment appearing re-flows every one beside it, so the pill can still be
  // moving when the assertions above have already passed. Under the full suite's parallel load
  // that raced the click and failed with `element was detached from the DOM`.
  await settled(toAnswer);
  await toAnswer.click();
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toBeVisible();
  // The heading borrows the segment's words, not the other segment's.
  await expect(inbox.getByText(`${beforeOwed + 1} to answer`)).toBeVisible();
  const row = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
  await expect(inbox.getByRole("heading", { name: "Waiting on you" })).toBeVisible();
  await expect(row).toBeVisible();
  await expect(
    row.getByText("Waiting on you: Claude needs your permission to use Bash"),
  ).toBeVisible();
  await expect(row.getByRole("button", { name: "Open session" })).toBeVisible();
  await shoot(dashboard, "inbox-blocked-row", inbox);
});
