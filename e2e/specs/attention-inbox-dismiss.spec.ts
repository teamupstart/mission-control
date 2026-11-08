import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { writeConductorProjects } from "../fixtures/conductor.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectDashboardReady } from "../fixtures/dashboard-ready.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { dispatchedSdkHookIdentity } from "../fixtures/sdk-hook-identity.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * What is at stake: every row in the attention inbox can be dismissed, and a dismissed row does
 * not pop back up - not on the next frame, not after a reload, not in another window - even
 * though what it reports has not been resolved.
 *
 * The defect was the Pipeline lifecycle row. It offered "Open Pipeline" and nothing else, so an
 * operator who had read it, and could do nothing about it from here, met it again on every open
 * of the inbox and the `to answer` figure never went down.
 *
 * Everything here is real: a real daemon, the real conductor readiness gate holding a real
 * Pipeline commission, a real dispatched SDK session parked by the real Notification hook, the
 * real dismissal route and its SSE frame, and the real fold rendered in a browser. The only
 * stand-in is the model.
 */

const EVIDENCE = artifactsDir("attention-inbox-dismiss");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/attention-inbox-dismiss/${name}.png`);
}

async function request(daemon: DaemonHandle, path: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A pulse segment's figure, or 0 when the segment is hidden because it is at zero. */
async function pulseCount(page: Page, label: string): Promise<number> {
  const seg = page.locator(".pulse-seg", { hasText: label });
  if ((await seg.count()) === 0) return 0;
  return Number(await seg.locator(".pulse-n").innerText());
}

/** The `to answer` figure as the topbar draws it: the number, or no segment at all at zero. */
async function expectToAnswer(page: Page, n: number): Promise<void> {
  const seg = page.locator("button.pulse-seg", { hasText: "to answer" });
  if (n === 0) await expect(seg).toHaveCount(0);
  else await expect(seg.locator(".pulse-n")).toHaveText(String(n));
}

/**
 * Open the inbox from `to answer`. Retried as a whole for the reason `attention-pills-agree`
 * gives: an SSE frame re-renders the pulse and REPLACES the segment's node, so a click resolved
 * against the old one can miss.
 */
async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const toAnswer = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await toAnswer.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  return inbox;
}

/** A conductor whose readiness check stays blocked: the row reports a problem nobody fixes. */
const BLOCKED_PIPELINE_ENV = {
  MC_E2E_CONDUCTOR_ENGINEER_MODE: "supported",
  MC_E2E_CONDUCTOR_READINESS: "blocked-until-marker",
  MISSION_PIPELINE_TICK_MS: "500",
};

/**
 * Enable the conductor for this daemon's repository and dispatch a Pipeline task, whose launch
 * the readiness gate blocks - so the inbox holds one Pipeline lifecycle row. Returns its
 * commission id.
 */
async function blockAPipelineLaunch(dashboard: Page, daemon: DaemonHandle): Promise<string> {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  const configured = await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    launchRuntime: "agent-sdk",
    foremanMechanicalTriage: false,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
  expect(configured.ok, await configured.text()).toBe(true);
  await dashboard.reload();
  await expectDashboardReady(dashboard);

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog.getByPlaceholder("What should this agent do?").fill("Prove the inbox can let go");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  let commissionId: string | null = null;
  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      kind: string;
      pipelineCommissionId: string | null;
    }>;
    commissionId = tasks.find((task) => task.kind === "pipeline")?.pipelineCommissionId ?? null;
    return commissionId;
  }).toEqual(expect.any(String));
  return commissionId!;
}

/**
 * Post the Notification hook a real Claude install posts when it parks on a permission prompt,
 * for this daemon's one dispatched SDK session. A second call with a different message is the
 * same session now waiting on something else.
 */
async function notify(daemon: DaemonHandle, message: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const hook = await fetch(`${daemon.baseURL}/hooks/Notification`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: "claude",
      ...await dispatchedSdkHookIdentity(daemon),
      env: {},
      message,
    }),
  });
  expect(hook.status, "the daemon accepted the hook").toBe(204);
}

/**
 * How many reads of the stored dismissals the page has in flight, so a held answer is released
 * only once nothing else is on its way to repair what it might break.
 */
function trackDismissalReads(page: Page): () => number {
  let inFlight = 0;
  const isRead = (request: { method(): string; url(): string }) =>
    request.method() === "GET" && new URL(request.url()).pathname === "/api/attention/dismissals";
  page.on("request", (request) => { if (isRead(request)) inFlight++; });
  page.on("requestfinished", (request) => { if (isRead(request)) inFlight--; });
  page.on("requestfailed", (request) => { if (isRead(request)) inFlight--; });
  return () => inFlight;
}

/**
 * `holds` must be true on ten consecutive reads a tenth of a second apart. A dismissed row that
 * comes back does so within a frame of the answer that brings it, so a second of steady reads is
 * the honest form of "and it stayed that way".
 */
async function holdsSteady(holds: () => Promise<boolean>, message: string): Promise<void> {
  let steady = 0;
  await expect.poll(async () => {
    steady = (await holds()) ? steady + 1 : 0;
    return steady;
  }, { intervals: [100], timeout: 10_000, message }).toBeGreaterThanOrEqual(10);
}

/**
 * Dispatch a session and park it on a permission prompt through the real Notification hook,
 * so the inbox holds one more `Waiting on you` row. Returns both figures as they stood before
 * the prompt: deltas, not absolutes, because process discovery is machine-wide and a developer
 * box running real agents adds its own sessions to both.
 */
async function parkASession(
  dashboard: Page,
  daemon: DaemonHandle,
): Promise<{ beforeAmber: number; beforeOwed: number }> {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("check the linter config");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: "Check the Linter Config" }),
  ).toBeVisible();

  const beforeAmber = await pulseCount(dashboard, "need you");
  const beforeOwed = await pulseCount(dashboard, "to answer");

  await notify(daemon, "Claude needs your permission to use Bash");
  await expectToAnswer(dashboard, beforeOwed + 1);
  return { beforeAmber, beforeOwed };
}

test.describe("a Pipeline lifecycle row", () => {
  test.use({ daemonEnv: BLOCKED_PIPELINE_ENV });

  test("is dismissed without being resolved, and stays dismissed across a reload", async ({
    dashboard,
    daemon,
  }) => {
    const commissionId = await blockAPipelineLaunch(dashboard, daemon);

    const inbox = await openInbox(dashboard);
    const row = inbox.locator("section.inbox-item").filter({ hasText: "GitHub authentication is required" });
    await expect(inbox.getByRole("heading", { name: "Pipeline lifecycle" })).toBeVisible();
    await expect(row).toBeVisible();
    // It still opens the Pipeline, and now it also has a way out of the inbox.
    await expect(row.getByRole("button", { name: "Open Pipeline" })).toBeVisible();
    const dismiss = row.getByRole("button", { name: /^Dismiss .+ from the inbox$/ });
    await expect(dismiss).toHaveText("Dismiss");
    // Both ways a dismissed row comes back, in the words the attention guide uses.
    await expect(dismiss).toHaveAccessibleDescription(
      "Remove this from the inbox without resolving it. It comes back if it reports something new, or if it goes away for a week and then recurs",
    );
    // The new control sits in the row's header: it must clear the modal's border like the rest.
    await expectContentClearsBorder(inbox);
    await shoot(dashboard, "pipeline-row-before-dismiss", inbox);

    const owed = await pulseCount(dashboard, "to answer");
    expect(owed, "the lifecycle row is counted").toBeGreaterThan(0);
    await dismiss.click();

    await expect(row).toHaveCount(0);
    await expect(inbox.getByRole("heading", { name: "Pipeline lifecycle" })).toHaveCount(0);
    await expectToAnswer(dashboard, owed - 1);
    await expect(inbox.getByText(owed - 1 > 0 ? `${owed - 1} to answer` : "Nothing to answer")).toBeVisible();
    await shoot(dashboard, "pipeline-row-after-dismiss", inbox);

    // Dismissed is not resolved: the commission is exactly as blocked as it was.
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{ kind: string; status: string }>;
    expect(tasks.find((task) => task.kind === "pipeline")?.status).toBe("running");

    // And it does not pop back up. A reload re-reads everything: the commission frame, the
    // fold, and the dismissal the daemon kept.
    //
    // It must not expire either. The daemon forgets a dismissal only after dashboards have
    // reported its row absent for a week, so give this one a clock six days in: if the reloaded
    // dashboard does not report the row as still hidden, nothing stops it from being forgotten.
    const itemId = `pipeline-commission:${commissionId}`;
    const absentSince = () =>
      withDaemonDb(daemon, (db) =>
        (db.prepare("SELECT absent_since FROM attention_dismissals WHERE item_id = ?").get(itemId) as
          | { absent_since: number | null }
          | undefined)?.absent_since,
      );
    expect(absentSince(), "the dismissal was stored under the row's id").toBeNull();
    await dashboard.keyboard.press("Escape");
    await expect(inbox).toBeHidden();
    withDaemonDb(daemon, (db) =>
      db.prepare("UPDATE attention_dismissals SET absent_since = ? WHERE item_id = ?")
        .run(Date.now() - 6 * 24 * 60 * 60 * 1000, itemId));
    await dashboard.reload();
    await expectDashboardReady(dashboard);
    await expect.poll(absentSince, { message: "the reloaded dashboard reported the row still hidden" }).toBeNull();
    await expectToAnswer(dashboard, owed - 1);
    if (owed - 1 > 0) {
      const reopened = await openInbox(dashboard);
      await expect(reopened.getByRole("heading", { name: "Pipeline lifecycle" })).toHaveCount(0);
      await expect(reopened).not.toContainText("GitHub authentication is required");
    }
    await shoot(dashboard, "pipeline-row-after-reload");
  });
});

test.describe("a blocked session row", () => {
  // Pins the dispatched session's first turn open, so the synthetic permission prompt below
  // parks the same turn a real one would (see `attention-pills-agree.spec.ts`).
  test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

  test("leaves the inbox in every open window, while the session is still waiting", async ({
    dashboard,
    daemon,
  }) => {
    const { beforeAmber, beforeOwed } = await parkASession(dashboard, daemon);

    // A second window, open before the dismissal: it has to hear about it, not just reload into it.
    const other = await dashboard.context().newPage();
    await other.goto(dashboard.url());
    await expectDashboardReady(other);
    await expectToAnswer(other, beforeOwed + 1);

    const inbox = await openInbox(dashboard);
    await expect(inbox.getByRole("heading", { name: "Waiting on you" })).toBeVisible();
    const row = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    await expect(row.getByText("Waiting on you: Claude needs your permission to use Bash")).toBeVisible();
    await shoot(dashboard, "blocked-row-before-dismiss", inbox);
    await row.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" }).click();
    await expect(row).toHaveCount(0);

    await expectToAnswer(dashboard, beforeOwed);
    await expectToAnswer(other, beforeOwed);
    // The session is still blocked, and the topbar still says so. Only the inbox let go.
    await expect(dashboard.locator(".pulse-seg", { hasText: "need you" }).locator(".pulse-n")).toHaveText(
      String(beforeAmber + 1),
    );
    await dashboard.keyboard.press("Escape");
    await expect(inbox).toBeHidden();
    await shoot(dashboard, "blocked-row-after-dismiss");

    await other.reload();
    await expectDashboardReady(other);
    await expectToAnswer(other, beforeOwed);
    await other.close();
  });

  test("comes back with the reason when the daemon refuses the dismissal, and a retry still works", async ({
    dashboard,
    daemon,
  }) => {
    const { beforeOwed } = await parkASession(dashboard, daemon);

    // The daemon refuses the write - but only once the test has watched the row leave, so the
    // optimistic hide and the restore are both observed rather than raced past.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await dashboard.route("**/api/attention/dismissals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "attention dismissals are unavailable" }),
      });
    });

    const inbox = await openInbox(dashboard);
    const row = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    const dismiss = row.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" });
    await expect(row).toBeVisible();
    await dismiss.click();

    // Gone at once, before the daemon has answered.
    await expect(row).toHaveCount(0);
    await expectToAnswer(dashboard, beforeOwed);

    release();
    // Refused: the row is back, the count is back, and the inbox says why beneath the row.
    await expect(row).toBeVisible();
    await expect(row.getByText("Waiting on you: Claude needs your permission to use Bash")).toBeVisible();
    await expectToAnswer(dashboard, beforeOwed + 1);
    const refusal = inbox.getByRole("alert");
    await expect(refusal).toHaveText("Could not dismiss: attention dismissals are unavailable");
    await shoot(dashboard, "blocked-row-dismiss-refused", inbox);
    // And nothing was stored behind the operator's back.
    const stored = await (await fetch(`${daemon.baseURL}/api/attention/dismissals`)).json() as {
      dismissals: unknown[];
    };
    expect(stored.dismissals).toEqual([]);

    // A retry once the daemon accepts clears the reason and dismisses for real.
    await dashboard.unroute("**/api/attention/dismissals");
    await dismiss.click();
    await expect(row).toHaveCount(0);
    await expect(inbox.getByRole("alert")).toHaveCount(0);
    await expectToAnswer(dashboard, beforeOwed);
    const kept = await (await fetch(`${daemon.baseURL}/api/attention/dismissals`)).json() as {
      dismissals: { itemId: string }[];
    };
    expect(kept.dismissals.map((entry) => entry.itemId)).toEqual([expect.stringMatching(/^blocked:/)]);
  });

  test("keeps the newer dismissal when the row changes and the older write lands last", async ({
    dashboard,
    daemon,
  }) => {
    const { beforeOwed } = await parkASession(dashboard, daemon);
    const readsInFlight = trackDismissalReads(dashboard);

    // The FIRST dismissal is held before it reaches the daemon; every later one goes straight
    // through. Unserialized, the newer dismissal is stored first and this one overwrites it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    await dashboard.route("**/api/attention/dismissals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (++writes === 1) await held;
      await route.continue();
    });

    const inbox = await openInbox(dashboard);
    const row = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    const dismiss = row.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" });
    await dismiss.click();
    await expect(row).toHaveCount(0);

    // The session now waits on something else: the same row reporting something new, which the
    // first dismissal does not cover - so it is shown again, and dismissed again.
    await notify(daemon, "Claude needs your permission to use Edit");
    await expect(row.getByText("Waiting on you: Claude needs your permission to use Edit")).toBeVisible();
    await dismiss.click();
    await expect(row).toHaveCount(0);
    await expectToAnswer(dashboard, beforeOwed);
    await expect.poll(readsInFlight, { intervals: [100] }).toBe(0);

    // Now the older write reaches the daemon.
    release();
    await expect.poll(() => writes, { message: "both dismissals were sent" }).toBe(2);
    await expect.poll(readsInFlight, { intervals: [100] }).toBe(0);
    await holdsSteady(
      async () => (await row.count()) === 0 && (await pulseCount(dashboard, "to answer")) === beforeOwed,
      "the row came back saying what the newer dismissal covered",
    );

    // And the daemon kept the newer one: a reload knows nothing but what it stored.
    await dashboard.unroute("**/api/attention/dismissals");
    await dashboard.keyboard.press("Escape");
    await dashboard.reload();
    await expectDashboardReady(dashboard);
    await holdsSteady(
      async () => (await pulseCount(dashboard, "to answer")) === beforeOwed,
      "after a reload the row is back: the daemon kept the older dismissal",
    );
  });
});

test.describe("one row dismissed from two windows", () => {
  test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

  test("the newer dismissal stands when another window's older one reaches the daemon last", async ({
    dashboard,
    daemon,
  }) => {
    const { beforeOwed } = await parkASession(dashboard, daemon);
    const other = await dashboard.context().newPage();
    await other.goto(dashboard.url());
    await expectDashboardReady(other);
    await expectToAnswer(other, beforeOwed + 1);

    // This window's dismissal is held before it reaches the daemon. Routes are per page, so
    // the other window's writes go straight through.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let forwarded!: () => void;
    const reachedDaemon = new Promise<void>((resolve) => (forwarded = resolve));
    await dashboard.route("**/api/attention/dismissals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.continue();
      forwarded();
    });

    const inbox = await openInbox(dashboard);
    const row = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    await row.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" }).click();
    await expect(row).toHaveCount(0);

    // The session moves on to a new question, and the OTHER window dismisses that one.
    await notify(daemon, "Claude needs your permission to use Edit");
    const otherInbox = await openInbox(other);
    const otherRow = otherInbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    await expect(otherRow.getByText("Waiting on you: Claude needs your permission to use Edit")).toBeVisible();
    await otherRow.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" }).click();
    await expect(otherRow).toHaveCount(0);
    await expect.poll(async () =>
      ((await (await request(daemon, "/api/attention/dismissals")).json()) as { dismissals: unknown[] }).dismissals.length,
    ).toBe(1);

    // Now this window's older dismissal - of the question the session has moved past - lands.
    release();
    await reachedDaemon;

    const bothHidden = async () =>
      (await row.count()) === 0 &&
      (await otherRow.count()) === 0 &&
      (await pulseCount(dashboard, "to answer")) === beforeOwed &&
      (await pulseCount(other, "to answer")) === beforeOwed;
    await holdsSteady(bothHidden, "the newer question came back after the older dismissal landed");

    // A reload in each window knows nothing but what the daemon kept.
    await dashboard.unroute("**/api/attention/dismissals");
    await dashboard.keyboard.press("Escape");
    await other.keyboard.press("Escape");
    await Promise.all([dashboard.reload(), other.reload()]);
    await expectDashboardReady(dashboard);
    await expectDashboardReady(other);
    await holdsSteady(
      async () =>
        (await pulseCount(dashboard, "to answer")) === beforeOwed &&
        (await pulseCount(other, "to answer")) === beforeOwed,
      "after a reload the newer question is back: the daemon kept the older dismissal",
    );
    await other.close();
  });

  test("a click queued behind this window's own write is not upgraded by what another window did meanwhile", async ({
    dashboard,
    daemon,
  }) => {
    const { beforeOwed } = await parkASession(dashboard, daemon);
    const other = await dashboard.context().newPage();
    await other.goto(dashboard.url());
    await expectDashboardReady(other);

    // This window's FIRST write is held before it reaches the daemon, so its second click on the
    // same row waits in the queue behind it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    await dashboard.route("**/api/attention/dismissals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (++writes === 1) await held;
      await route.continue();
    });

    const inbox = await openInbox(dashboard);
    const row = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    const dismiss = row.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" });
    await dismiss.click();
    await expect(row).toHaveCount(0);
    // The question changes and this window dismisses it again: queued, not yet sent.
    await notify(daemon, "Claude needs your permission to use Edit");
    await expect(row.getByText("Waiting on you: Claude needs your permission to use Edit")).toBeVisible();
    await dismiss.click();
    await expect(row).toHaveCount(0);

    // Then it changes once more, and the OTHER window dismisses that newest question. This window
    // hears about it through the change event while its second click is still waiting.
    await notify(daemon, "Claude needs your permission to use Write");
    const otherInbox = await openInbox(other);
    const otherRow = otherInbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    await expect(otherRow.getByText("Waiting on you: Claude needs your permission to use Write")).toBeVisible();
    await otherRow.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" }).click();
    await expect(otherRow).toHaveCount(0);
    await expect.poll(async () =>
      ((await (await request(daemon, "/api/attention/dismissals")).json()) as { dismissals: unknown[] }).dismissals.length,
    ).toBe(1);
    await expect.poll(async () => await dashboard.evaluate(async () => {
      const body = await (await fetch("/api/attention/dismissals")).json() as { dismissals: unknown[] };
      return body.dismissals.length;
    })).toBe(1);

    // Release this window's writes. Both were clicks made before the other window's dismissal,
    // so neither may replace it - however much this window learned while they waited.
    release();
    await expect.poll(() => writes, { message: "this window sent both of its writes" }).toBe(2);

    const bothHidden = async () =>
      (await row.count()) === 0 &&
      (await otherRow.count()) === 0 &&
      (await pulseCount(dashboard, "to answer")) === beforeOwed &&
      (await pulseCount(other, "to answer")) === beforeOwed;
    await holdsSteady(bothHidden, "the newest question came back: a queued older click replaced its dismissal");

    await dashboard.unroute("**/api/attention/dismissals");
    await dashboard.keyboard.press("Escape");
    await other.keyboard.press("Escape");
    await Promise.all([dashboard.reload(), other.reload()]);
    await expectDashboardReady(dashboard);
    await expectDashboardReady(other);
    await holdsSteady(
      async () =>
        (await pulseCount(dashboard, "to answer")) === beforeOwed &&
        (await pulseCount(other, "to answer")) === beforeOwed,
      "after a reload the newest question is back: the daemon kept an older click",
    );
    await other.close();
  });
});

test.describe("two rows dismissed back to back", () => {
  test.use({ daemonEnv: { ...BLOCKED_PIPELINE_ENV, MC_E2E_HOLD_FIRST_TURN: "1" } });

  test("both stay dismissed when the first dismissal's answer arrives last", async ({
    dashboard,
    daemon,
  }) => {
    // Session first: its dispatch takes the modal's defaults, and the Pipeline dispatch after it
    // starts no session, so the hook still has exactly one SDK session to name.
    const { beforeOwed } = await parkASession(dashboard, daemon);
    const commissionId = await blockAPipelineLaunch(dashboard, daemon);
    await expectToAnswer(dashboard, beforeOwed + 2);

    const readsInFlight = trackDismissalReads(dashboard);

    // The FIRST dismissal reaches the daemon and is stored at once, but the dashboard hears back
    // about it only after the second one has been stored and answered.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let delivered!: () => void;
    const lateAnswer = new Promise<void>((resolve) => (delivered = resolve));
    let writes = 0;
    await dashboard.route("**/api/attention/dismissals", async (route) => {
      if (route.request().method() !== "POST" || ++writes > 1) return route.continue();
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
      delivered();
    });

    const stored = async () =>
      ((await (await request(daemon, "/api/attention/dismissals")).json()) as {
        dismissals: { itemId: string }[];
      }).dismissals.map((entry) => entry.itemId).sort();

    const inbox = await openInbox(dashboard);
    const pipelineRow = inbox.locator("section.inbox-item").filter({ hasText: "GitHub authentication is required" });
    const sessionRow = inbox.locator(".inbox-blocked").filter({ hasText: "Check the Linter Config" });
    await pipelineRow.getByRole("button", { name: /^Dismiss .+ from the inbox$/ }).click();
    await expect.poll(stored).toEqual([`pipeline-commission:${commissionId}`]);
    await sessionRow.getByRole("button", { name: "Dismiss Check the Linter Config from the inbox" }).click();
    await expect.poll(stored).toEqual([expect.stringMatching(/^blocked:/), `pipeline-commission:${commissionId}`]);
    await expectToAnswer(dashboard, beforeOwed);
    await expect.poll(readsInFlight, { intervals: [100] }).toBe(0);

    // Now the stale answer - the stored set as it stood before the second dismissal.
    release();
    await lateAnswer;

    // Both rows must stay gone, with the count where both dismissals left it.
    await holdsSteady(
      async () =>
        (await pipelineRow.count()) === 0 &&
        (await sessionRow.count()) === 0 &&
        (await pulseCount(dashboard, "to answer")) === beforeOwed,
      "a dismissed row came back when the older answer landed",
    );
    expect(await stored()).toHaveLength(2);
  });
});
