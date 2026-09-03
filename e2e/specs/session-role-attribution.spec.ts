import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * WHICH worker just finished, read off the conversation by a person.
 *
 * A session that delegates does not do its own work, so its in-progress row said
 * "subagent finished" for every one of ten different roles and the one fact worth having
 * at that moment was the one thing missing. The bridge now forwards the role the harness
 * names and the row renders it.
 *
 * Only a browser can settle this. The role travels the whole way here: a real
 * `/hooks/SubagentStop` POST on the daemon's token-guarded ingest, through
 * `Registry.applyHook`, out over the live SSE stream, into the row at the tail of the log.
 * The `renderToStaticMarkup` tests beside this one can assert the string appears in a
 * markup dump; they cannot say the ingest accepted the field or that the stream carried it.
 *
 * Both halves are asserted because both happen in production. The role arrives on some
 * events and, measured on a real machine, is absent from most `SubagentStop` payloads
 * despite Claude Code declaring it required there - so the generic wording is the line an
 * operator will often read, and it has to survive the change rather than degrade to
 * "undefined finished".
 *
 * No model is spent: `MISSION_CLAUDE_BIN` points at the fake agent throughout.
 */

const TASK = { title: "Attribute the worker that finished", intent: "exercise role attribution" };

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
 * Waiting for `agentSessionId` is what makes the hooks below land on this session rather
 * than on a unique-cwd guess: the ingest binds by pane key, then by agent session id, then
 * by cwd, and only the second of those is exact for a dispatched SDK agent.
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
 * Report a worker's return the way an instrumented Claude does.
 *
 * A real POST over the real route, so a schema that rejected `agentType` would fail here
 * with a 400 rather than quietly rendering the old line.
 */
async function subagentStop(
  daemon: DaemonHandle,
  target: FleetSession,
  named: { agentType?: string; agentId?: string },
): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/SubagentStop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({
      agent: target.agent,
      sessionId: target.agentSessionId,
      cwd: target.cwd,
      env: {},
      ...named,
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
  await expect(detail.locator(".transcript-log .turn").first()).toBeVisible({ timeout: 30_000 });
  return detail;
}

test("the conversation names the role that finished, and falls back when none is named", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const target = await session(daemon);
  const detail = await openDetail(dashboard, daemon);

  const row = detail.locator(".transcript-log .turn-progress");

  // A named role reads as itself. This is the whole point of the change: the operator
  // learns an investigator returned, not that "a subagent" did.
  await subagentStop(daemon, target, { agentType: "investigator", agentId: "a1" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("investigator finished");
  await expect(row).not.toContainText("subagent finished");

  // A plugin's role keeps its namespace, which is the half that disambiguates two
  // marketplaces shipping a role by the same name.
  await subagentStop(daemon, target, {
    agentType: "pr-review-toolkit:code-reviewer",
    agentId: "a2",
  });
  await expect(row).toContainText("pr-review-toolkit:code-reviewer finished");

  // And the fallback, driven from the same live session so this is the row changing rather
  // than a selector that never matched: an event carrying only an id reverts to the
  // generic wording instead of rendering an empty or undefined name.
  await subagentStop(daemon, target, { agentId: "a3" });
  await expect(row).toContainText("subagent finished");
  await expect(row).not.toContainText("undefined");
});
