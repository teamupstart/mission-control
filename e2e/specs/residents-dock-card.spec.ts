import { mkdirSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { HARNESS_CAPABILITIES } from "../../src/shared/harness-capabilities.ts";

// The Residents dock draws each live resident as a card in its own marker color: the name, state
// and Open, the loop's facts, then one footer holding the run controls and the session control
// status on a single line. The profiles under it share one chip column, so
// their names and Launch buttons line up whatever each label's length. No model tokens are
// spent: every agent binary is the fake from `fixtures/fake-agents.ts`.

const PERSONA_ID = "builtin:code-risk-reviewer";
const LIVE = "Fleet Steward";
const WAKE_REASON = "Check the release branch again after the nightly build lands.";
const EVIDENCE = artifactsDir("residents-dock-card");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off the Residents button, whose tooltip would otherwise cover the dock's top edge.
  await target.page().mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/residents-dock-card/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

interface LiveRunRow { loop_state: string; pause_reason: string | null; wake_reason: string | null; next_wake_at: number | null }
function liveRun(daemon: DaemonHandle): LiveRunRow | undefined {
  return withDaemonDb(daemon, (db) => db.prepare(
    "SELECT loop_state, pause_reason, wake_reason, next_wake_at FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'",
  ).get() as LiveRunRow | undefined);
}

/**
 * The compaction line a Claude Code resident's card must print, read from the harness
 * capability table the run summary is built from - each layer with its own value.
 */
function claudeCompactionLayers(): string[] {
  const layers = HARNESS_CAPABILITIES.claude.residentCompaction!;
  const word = (on: boolean): string => on ? "active" : "unavailable";
  return [
    `Compaction before wakes ${word(layers.betweenIterations)}`,
    `Native backstop ${word(layers.nativeBackstop)}`,
  ];
}

/** The dock's countdown wording for a wake `ms` from now: seconds under a minute, else minutes. */
function nextWakeText(ms: number): string {
  const remaining = Math.max(0, Math.ceil(ms / 1000));
  return `next in ${remaining < 60 ? `${remaining}s` : `${Math.ceil(remaining / 60)}m`}`;
}

type Box = { x: number; y: number; width: number; height: number };
async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  expect(found, "the element is laid out").not.toBeNull();
  return found!;
}
const middle = (b: Box): number => b.y + b.height / 2;

test("a live resident is a card in its color with one footer of actions, and the profiles line up under it", async ({
  dashboard,
  daemon,
}) => {
  // One live resident that asks for session control, which a browser launch never grants, and
  // whose one-iteration cap pauses it with a guardrail reason - every fact the card can carry.
  const live = await api<{ id: string }>(daemon, "/api/residents/profiles", {
    settings: {
      identity: { name: LIVE },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
      execution: { model: "claude-fable-5" },
      board: { colorId: "violet", label: "FS" },
      authority: { controlOtherSessions: true },
      loop: { delaySeconds: 2, minDelaySeconds: 1, maxDelaySeconds: 3600, iterationCap: 1 },
    },
  });
  // Two more profiles: the widest label a marker allows, and one with no default repository,
  // whose button reads "Launch…".
  await api(daemon, "/api/residents/profiles", {
    settings: {
      identity: { name: "Inbox Triage" },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
      board: { colorId: "amber", label: "WWWW" },
    },
  });
  await api(daemon, "/api/residents/profiles", {
    settings: { identity: { name: "Contract Owner" }, persona: { personaId: PERSONA_ID } },
  });
  await api(daemon, `/api/residents/profiles/${live.id}/launch`, { repoRoot: daemon.repo, requestId: "dock-card" });
  await expect.poll(() => liveRun(daemon)?.loop_state, { timeout: 60_000 }).toBe("paused");
  expect(liveRun(daemon)?.pause_reason).toContain("Iteration guardrail");

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents", exact: true });
  const card = dock.locator("li.residents-pop-card");
  await expect(card).toHaveCount(1);
  const head = card.locator(".residents-pop-card-head");
  const footer = card.locator(".residents-pop-card-foot");
  const open = head.getByRole("button", { name: `Open ${LIVE}`, exact: true });
  await expect(open).toBeEnabled({ timeout: 60_000 });

  // The card wears the resident's marker color, as the palette token.
  const accent = await card.evaluate((el) => ({
    card: getComputedStyle(el).getPropertyValue("--resident").trim(),
    violet: getComputedStyle(document.documentElement).getPropertyValue("--resident-violet").trim(),
  }));
  expect(accent.card).toBe(accent.violet);

  // The name is the dock's 12.5px, no longer the page's body size.
  const name = card.locator(".residents-pop-name");
  await expect(name).toHaveText(LIVE);
  await expect(name).toHaveCSS("font-size", "12.5px");

  // The loop's facts: the short ones as tags, the guardrail's reason as its sentence.
  const status = card.getByLabel("Resident loop status");
  await expect(status.locator(".resident-loop-tag")).toHaveText(["paused", "iteration 1"]);
  await expect(status).toContainText("Iteration guardrail");
  // Each compaction layer keeps its own value, not just its name.
  await expect(status.locator(".resident-compaction-layer")).toHaveText(claudeCompactionLayers());

  // The footer holds the run controls and the control status on one line: Resume, Run now, then
  // the status with the existing session control menu at the right edge.
  const resume = footer.getByRole("button", { name: "Resume", exact: true });
  const runNow = footer.getByRole("button", { name: "Run now", exact: true });
  const control = footer.getByRole("status", { name: "control not granted", exact: true });
  const menu = footer.getByRole("button", { name: "Session control: Off" });
  await expect(control).toHaveText("No control");
  await expect(menu).toBeVisible();
  const line = await Promise.all([resume, runNow, control, menu].map(box));
  for (const item of line) {
    expect(Math.abs(middle(item) - middle(line[0]!)), "the footer's actions share one line").toBeLessThan(2);
  }
  const footerBox = await box(footer);
  const menuBox = line.at(-1)!;
  expect(footerBox.x + footerBox.width - (menuBox.x + menuBox.width), "the control status ends the footer").toBeLessThan(1);

  // Open ends the card's top line, on the name's line and at its right edge.
  const nameBox = await box(name);
  const headBox = await box(head);
  const openBox = await box(open);
  expect(Math.abs(middle(openBox) - middle(nameBox)), "Open shares the name's line").toBeLessThan(2);
  expect(headBox.x + headBox.width - (openBox.x + openBox.width), "Open ends the top line").toBeLessThan(1);

  // Head, facts, footer: stacked in that order, and all inside the card.
  const statusBox = await box(status);
  const cardBox = await box(card);
  expect(statusBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
  expect(footerBox.y).toBeGreaterThanOrEqual(statusBox.y + statusBox.height);
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
  await capture(dock, "01-dock-card-control-not-granted");

  // The profiles share one chip column: every name, and every Launch button, starts on one line.
  // Four rows: the three authored here and the built-in Agent Shepherd every install ships, whose
  // "built-in" tag sits beside its name without moving the column.
  const rows = dock.locator(".residents-pop-profiles > .residents-pop-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Agent Shepherd" }).locator(".resident-builtin-tag")).toHaveText("built-in");
  const indexes = [0, 1, 2, 3];
  const names = await Promise.all(indexes.map((i) => box(rows.nth(i).locator(".residents-pop-name"))));
  const launches = await Promise.all(indexes.map((i) => box(rows.nth(i).getByRole("button", { name: /^Launch / }))));
  await expect(dock.getByRole("button", { name: "Launch Inbox Triage" })).toHaveText("Launch");
  await expect(dock.getByRole("button", { name: "Launch Contract Owner" })).toHaveText("Launch…");
  for (const [i, each] of names.entries()) {
    expect(Math.abs(each.x - names[0]!.x), `profile name ${i} starts in the name column`).toBeLessThan(0.5);
  }
  for (const [i, each] of launches.entries()) {
    expect(Math.abs(each.x - launches[0]!.x), `Launch ${i} starts in the button column`).toBeLessThan(0.5);
    expect(Math.abs(each.width - launches[0]!.width), `Launch ${i} is the column's width`).toBeLessThan(0.5);
  }

  // Manage residents spans the content under its divider rather than floating indented.
  const manage = await box(dock.getByRole("button", { name: /Manage residents/ }));
  const list = await box(dock.locator(".residents-pop-profiles"));
  expect(Math.abs(manage.width - list.width)).toBeLessThan(1);
});

test("a waiting resident's card shows its next wake as a tag beside its state and iteration, and its wake reason under them", async ({
  dashboard,
  daemon,
}) => {
  // No iteration cap to stop it: after its first turn the run waits for a scheduled wake ten
  // minutes out, long enough that the countdown cannot run out while the test reads it.
  const profile = await api<{ id: string }>(daemon, "/api/residents/profiles", {
    settings: {
      identity: { name: "Wake Keeper" },
      persona: { personaId: PERSONA_ID },
      workspace: { defaultRepoRoot: daemon.repo },
      execution: { model: "claude-fable-5" },
      loop: { delaySeconds: 600, minDelaySeconds: 1, maxDelaySeconds: 3600 },
    },
  });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "dock-card-next-wake" });
  await expect.poll(() => {
    const run = liveRun(daemon);
    return run?.loop_state === "waiting" && run.next_wake_at !== null;
  }, { timeout: 60_000 }).toBe(true);
  const nextWakeAt = liveRun(daemon)!.next_wake_at!;
  expect(nextWakeAt - Date.now(), "the wake is minutes out, not imminent").toBeGreaterThan(60_000);
  // The reason a resident gives for its next wake arrives only through its own signed
  // `schedule_next_iteration` call, which the fake agent never makes. Written into this
  // disposable fixture's run while the daemon is down instead, so the successor seeds its run
  // summaries from it at boot and the dashboard reads it the ordinary way.
  await daemon.crash();
  withDaemonDb(daemon, (db) => db.prepare(
    "UPDATE resident_runs SET wake_reason = ? WHERE ended_at IS NULL AND launch_state = 'launched'",
  ).run(WAKE_REASON));
  await daemon.restart();
  await expect.poll(() => {
    const run = liveRun(daemon);
    return run?.loop_state === "waiting" && run.wake_reason === WAKE_REASON && run.next_wake_at === nextWakeAt;
  }, { timeout: 60_000, message: "the restored run keeps its wait, its wake and its reason" }).toBe(true);

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = dashboard.getByRole("dialog", { name: "Residents", exact: true });
  const status = dock.locator("li.residents-pop-card").getByLabel("Resident loop status");
  const tags = status.locator(".resident-loop-tag");
  await expect(tags).toHaveCount(3);
  await expect(tags.nth(0)).toHaveText("waiting");
  await expect(tags.nth(1)).toHaveText("iteration 1");
  // The countdown is the run's own `next_wake_at`, worded the way the dock words it. Polled,
  // because the tag ticks every second and can cross a minute between two reads.
  await expect.poll(async () => {
    const shown = await tags.nth(2).textContent();
    return shown === nextWakeText(nextWakeAt - Date.now());
  }, { message: "the third tag is the next wake's countdown" }).toBe(true);
  await expect(tags.nth(2)).toHaveText(/^next in \d+m$/);
  // The wake reason is its own sentence under the tags, read whole.
  await expect(status.locator(".resident-loop-reason")).toHaveText([WAKE_REASON]);
  await expect(status.locator(".resident-compaction-layer")).toHaveText(claudeCompactionLayers());
  await capture(dock, "02-dock-card-next-wake");
});
