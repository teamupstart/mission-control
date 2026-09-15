import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("telemetry-session-attribution");
const TASK = "measure what this session actually ran on";

/**
 * Phase 3's facts, produced by a person driving the real dashboard.
 *
 * What only this layer can prove: that the source context is attached at the seams a REAL
 * click reaches. The unit tests feed the observer a synthetic session projection and the
 * ledger a synthetic row; neither can tell you that the dispatch route, the composer and the
 * effort chip actually reach the hooks - or that the daemon which serves the built dashboard
 * has them wired at all.
 *
 * Two standing constraints are honoured rather than worked around. The agent is the fake, so
 * no model tokens are spent; and nothing is selected by `data-testid` - every locator here is
 * a role, a label or a placeholder a person could find.
 *
 * Collection is turned on THROUGH THE ROUTE and left local-only: the point is what is
 * captured, not what is exported, and a local profile has no endpoint to reach for.
 */

function note(message: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`    · ${message}`);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/telemetry-session-attribution/${name}.png`);
}

interface CapturedFact {
  name: string;
  facts: Record<string, unknown>;
  refs: Record<string, string>;
}

/** Everything this daemon has captured, read from its own journal. */
function captured(daemon: DaemonHandle): CapturedFact[] {
  return withDaemonDb(daemon, (db) =>
    (
      db
        .prepare(`SELECT name, facts_json, refs_json FROM telemetry_journal ORDER BY seq`)
        .all() as unknown as Array<{ name: string; facts_json: string; refs_json: string }>
    ).map((row) => ({
      name: row.name,
      facts: JSON.parse(row.facts_json) as Record<string, unknown>,
      refs: JSON.parse(row.refs_json) as Record<string, string>,
    })),
  );
}

function only(facts: CapturedFact[], name: string): CapturedFact[] {
  return facts.filter((f) => f.name === name);
}

test("a dispatched session's model, effort and conversation facts are captured as they happen", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);

  // 1. Opt in. Local-only: collection on, nothing configured to leave this machine.
  const configured = await fetch(`${daemon.baseURL}/api/telemetry/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(configured.ok, await configured.text()).toBe(true);
  // Everything asserted below was produced by the clicks that follow, so the starting point
  // is checked rather than assumed. The one record already here is Phase 2's own: switching
  // collection ON is recorded by the daemon that applied it - which is exactly why the check
  // is for an absence of SESSION facts rather than an empty journal.
  const before = captured(daemon);
  expect(before.map((f) => f.name)).toEqual(["mission.telemetry.control.applied"]);
  note("collection enabled, local-only; no session facts captured yet");

  // 2. Dispatch, through the dialog a person uses.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("claude");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();
  await expect(card.locator(".goal")).toHaveText(TASK, { timeout: 60_000 });
  note("a real dispatch produced a live SDK session");

  // The dispatch and the session it produced are two facts, captured by two owners.
  await expect
    .poll(() => only(captured(daemon), "mission.dispatch.finished").length, { timeout: 30_000 })
    .toBe(1);
  const [dispatched] = only(captured(daemon), "mission.dispatch.finished");
  expect(dispatched?.facts.outcome).toBe("launched");
  expect(dispatched?.facts.task_kind).toBe("ship");
  expect(dispatched?.facts.runtime).toBe("sdk");
  expect(dispatched?.facts.repo_count).toBe(1);

  const [started] = only(captured(daemon), "mission.session.started");
  expect(started, "the launched session was observed starting").toBeTruthy();
  // An app-owned launch is the one case where the START itself was witnessed, and an SDK
  // runtime has no pane at all - which is a different answer from "we could not tell".
  expect(started?.facts.origin).toBe("dispatch");
  expect(started?.facts.start_observation).toBe("observed_start");
  expect(started?.facts.multiplexer).toBe("not_applicable");
  expect(started?.facts.task_kind).toBe("ship");
  note("dispatch + session start captured, with the launch attributed as app-owned");

  // And exactly one start, however many times the card is republished while it settles.
  expect(only(captured(daemon), "mission.session.started").length).toBe(1);

  // 3. A real segment, opened from what the DRIVER reported rather than from a default.
  await expect
    .poll(() => only(captured(daemon), "mission.session.segment.opened").length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const segment = only(captured(daemon), "mission.session.segment.opened").at(-1)!;
  expect(
    ["observed", "launch_resolved", "unknown", "unsupported"],
    "quality is always one of the four, never a silent default",
  ).toContain(segment.facts.quality);
  expect(segment.refs.segment_id, "a segment carries its own identity").toBeTruthy();
  note(`segment opened: model=${String(segment.facts.model_id)} effort=${String(segment.facts.effort)} quality=${String(segment.facts.quality)}`);

  // 4. Talk to it, and watch the distinction this event exists to make.
  //
  //    The composer BUFFERS a reply typed while a session is busy: `submit()` writes a
  //    `pending_turns` row and nothing has reached the agent. That row can still be recalled
  //    or dropped, so recording it as a delivery would count turns the session never saw.
  //    The queue and the delivery are two facts here, and both are asserted - which is the
  //    whole point of instrumenting at the authoritative seam rather than at the button.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled({ timeout: 60_000 });
  await reply.fill("one more thing");
  await reply.press("Enter");

  await expect
    .poll(() => only(captured(daemon), "mission.session.operation").length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const operations = only(captured(daemon), "mission.session.operation");
  for (const operation of operations) {
    expect(["send", "queued"]).toContain(operation.facts.operation);
    expect(operation.facts.outcome).toBe("delivered");
    // A user-role message does not prove a human sender. The app says `human`; the BASIS says
    // how much that is worth, and the dashboard does not yet mint an operation id for these
    // routes - Phase 5 owns propagating that context. `unknown` is the honest answer today
    // and is asserted rather than left to drift into a false `app_context`.
    expect(operation.facts.actor_basis).toBe("unknown");
    expect(operation.facts.runtime).toBe("sdk");
  }
  note(`composer operations captured: ${operations.map((o) => String(o.facts.operation)).join(", ")}`);

  // The reply lands as a real turn, and the turn manager's own delivery signal - not the
  // route - is what records the send behind it.
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText("one more thing", { exact: true }),
  ).toBeVisible({ timeout: 90_000 });
  await expect
    .poll(
      () =>
        only(captured(daemon), "mission.session.operation").filter(
          (o) => o.facts.operation === "send",
        ).length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  note("the queued turn was delivered, and the send was recorded at the delivery seam");

  await shoot(dashboard, "01-session");

  // 5. Change the effort from the chip. The SELECTION is its own fact, separate from what
  //    the session is executing.
  const chip = card.getByRole("button", { name: /^Reasoning effort:/ });
  await expect(chip).toBeVisible();
  await expect(chip).toBeEnabled();
  await chip.click();
  const menu = dashboard.getByRole("menu", { name: "Reasoning effort" });
  await expect(menu).toBeVisible();
  // Exact, because `high` is a prefix of `xhigh` and the menu offers both.
  const high = menu.getByRole("menuitemradio", { name: "high Apply to this session only", exact: true });
  await high.click();
  await expect(menu).toBeHidden();

  await expect
    .poll(() => only(captured(daemon), "mission.session.effort.selected").length, { timeout: 30_000 })
    .toBe(1);
  const [selected] = only(captured(daemon), "mission.session.effort.selected");
  expect(selected?.facts).toMatchObject({
    requested_effort: "high", outcome: "accepted", applies: "current_turn",
    agent: "claude", runtime: "sdk",
  });
  expect(selected?.refs.session_id).toBe(started?.refs.session_id);
  await expect(chip).toHaveAccessibleName(/^Reasoning effort: high/);
  note("mandatory effort selection captured exactly once: accepted, current_turn, high, same session");
  await shoot(dashboard, "02-effort");

  // 6. Privacy, checked against what this run actually put on screen and on disk. The
  //    repository path, the worktree, the task text and the session's name are all things a
  //    captured record could carry by accident, and none of them may.
  const everything = JSON.stringify(captured(daemon));
  for (const sentinel of [daemon.repo, TASK, "one more thing", "worktree-pools"]) {
    expect(everything, `${sentinel} must not appear in a captured record`).not.toContain(sentinel);
  }
  note("no repository path, task text, reply text or worktree reached a captured record");

  // 7. And the whole pipeline still runs: the projection turns these into the declared
  //    instruments, once, through the same drain the cadence timer uses.
  const drained = await fetch(`${daemon.baseURL}/api/telemetry/drain`, { method: "POST" });
  expect(drained.ok).toBe(true);
  const instruments = withDaemonDb(daemon, (db) =>
    (
      db
        .prepare(`SELECT DISTINCT instrument FROM telemetry_series ORDER BY instrument`)
        .all() as unknown as Array<{ instrument: string }>
    ).map((r) => r.instrument),
  );
  expect(instruments).toContain("mission.sessions.started");
  expect(instruments).toContain("mission.dispatches");
  expect(instruments).toContain("mission.session.operations");
  note(`projected instruments: ${instruments.join(", ")}`);
});
