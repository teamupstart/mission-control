import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("telemetry-settings");

/**
 * The telemetry Settings surface, driven the way a person drives it.
 *
 * What this layer proves that no other one can: that a click on a consent switch reaches the
 * daemon, that the daemon's answer comes back through the live settings-status channel rather
 * than a poll, and that the panel's sentences match what actually happened. The unit tests pin
 * the transitions; this pins that the transitions are REACHABLE and legible.
 *
 * Two facts hold this spec together and are asserted rather than assumed:
 *
 *  - collection starts OFF, and nothing in the app turns it on;
 *  - local-only capture survives a daemon restart, which is the whole claim behind the phrase
 *    "saved locally" in the panel's own copy.
 *
 * No agent is launched anywhere in here, so no model tokens are spent - the fake-agent fixtures
 * are in place regardless, and this spec never reaches them.
 */

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    fullPage,
    animations: "disabled",
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/telemetry-settings/${name}.png`);
}

test("telemetry Settings: off by default, local-only capture, and an honest product state", async ({
  dashboard,
  daemon,
}) => {
  // The palette is one route into the category, and it is the route somebody actually takes -
  // "telemetry" is a word people search for rather than a rail row they remember.
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("telemetry");
  await dashboard.getByRole("option", { name: /Collect telemetry on this machine/ }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/telemetry$/);
  await expect(dashboard.getByRole("tab", { name: /Telemetry/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const collect = dashboard.getByLabel("Collect Mission Control telemetry on this machine");
  await expect(collect).not.toBeChecked();
  // Default-off is a claim about storage, not about a checkbox, so it is checked at the route.
  const before = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/config`)
  ).json()) as {
    config: { enabled: boolean };
  };
  expect(before.config.enabled).toBe(false);

  // The distinction the whole page rests on: this is not the Cost section.
  await expect(dashboard.getByText(/Cost.*section, which configures Claude Code/s)).toBeVisible();
  await shoot(dashboard, "01-off");

  // Turn collection on. This is local-only: nothing is configured to leave.
  await collect.check();
  await expect(
    dashboard.getByText(/Collecting locally\. Everything recorded stays in this daemon's database/),
  ).toBeVisible();
  await expect(dashboard.getByText("On this machine", { exact: true })).toBeVisible();
  await shoot(dashboard, "02-local-only", true);

  // Separate opt-ins: collection being on has not enabled either destination.
  await expect(dashboard.getByLabel("Export telemetry to your own backend")).not.toBeChecked();
  await expect(dashboard.getByLabel("Share anonymous product analytics")).not.toBeChecked();

  // With no product endpoint yet, the switch is not offered: turning it on would claim to be
  // sharing while queueing for somewhere that cannot answer. The panel says which it is.
  await expect(dashboard.getByLabel("Share anonymous product analytics")).toBeDisabled();
  await expect(
    dashboard.getByText(/Mission Control does not run a public analytics service/),
  ).toBeVisible();

  // And the restore boundary is stated on the page, because it is the thing an operator cannot
  // discover any other way.
  await expect(
    dashboard.getByText(/Nothing on this page is carried by a settings snapshot/),
  ).toBeVisible();
});

test("product analytics is an independently operable export, to a collector you run", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await dashboard.getByLabel("Collect Mission Control telemetry on this machine").check();

  // Unavailable while there is nowhere to send it - not unavailable as a property of the build.
  const share = dashboard.getByLabel("Share anonymous product analytics");
  await expect(share).toBeDisabled();

  // Supplying an address is what enrolls this installation. No hosted service is involved and
  // none is implied; this is a second collector the operator runs.
  await dashboard.getByLabel("Product analytics endpoint").fill("http://127.0.0.1:14398");
  await dashboard.getByRole("button", { name: "Save the product analytics destination" }).click();

  await expect(share).toBeEnabled({ timeout: 15_000 });
  await share.check();
  await expect(share).toBeChecked();
  await shoot(dashboard, "06-product-enabled", true);

  // The two destinations stay independent all the way down: separate opt-in, separate endpoint,
  // separate queue. Enabling product has not enabled the personal backend.
  await expect(dashboard.getByLabel("Export telemetry to your own backend")).not.toBeChecked();
  const health = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/health`)
  ).json()) as {
    productEnrollment: string;
    profiles: { profile: string; capturing: boolean; exporting: boolean }[];
  };
  expect(health.productEnrollment).toBe("available");
  expect(health.profiles.find((p) => p.profile === "product")?.exporting).toBe(true);
  expect(health.profiles.find((p) => p.profile === "user")?.capturing).toBe(false);

  // Withdrawing product consent leaves everything else alone, which is what independent means.
  await share.uncheck();
  await expect(share).not.toBeChecked();
  await expect(
    dashboard.getByLabel("Collect Mission Control telemetry on this machine"),
  ).toBeChecked();
});

test("local capture survives a daemon restart, which is what saved locally means", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await dashboard.getByLabel("Collect Mission Control telemetry on this machine").check();

  // Produce a real fact through the ordinary path: the panel's own browser-originated event is
  // submitted on mount, so a reload is a capture. Drain projects it out of the journal.
  await dashboard.reload();
  await expect(dashboard.getByText("On this machine", { exact: true })).toBeVisible();
  const drained = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);
  expect(drained.ok()).toBe(true);

  // Kill the daemon and bring it back. A SIGKILL rather than an orderly stop on purpose: an
  // orderly shutdown gets a projection pass and a clean-shutdown marker, so it would prove only
  // that the exit path works. The claim behind the word "locally" is that acceptance means
  // COMMITTED - that the fact was already on disk before anything asked it to be - and only a
  // death with no shutdown at all can demonstrate that.
  const beforeRestart = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/health`)
  ).json()) as { usedBytes: number; installationId: string };
  expect(beforeRestart.usedBytes).toBeGreaterThan(0);

  await daemon.crash();
  await daemon.restart();
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const afterRestart = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/health`)
  ).json()) as { usedBytes: number; installationId: string; enabled: boolean };
  expect(afterRestart.enabled).toBe(true);
  expect(afterRestart.usedBytes).toBeGreaterThan(0);
  expect(afterRestart.installationId).toBe(beforeRestart.installationId);
  await expect(
    dashboard.getByLabel("Collect Mission Control telemetry on this machine"),
  ).toBeChecked();
});

test("a remote plaintext endpoint carrying a credential is refused by the form and the API", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await dashboard.getByLabel("Collect Mission Control telemetry on this machine").check();

  await dashboard.getByLabel("Telemetry export endpoint").fill("http://telemetry.example.com:4318");
  await dashboard.getByLabel("Telemetry export credential").fill("a-secret-token");

  // The form says so, in the same words the daemon would, because both call the same predicate.
  await expect(
    dashboard.getByText("A credential may only be sent over HTTPS, or to a loopback Collector."),
  ).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Save destination" })).toBeDisabled();
  await shoot(dashboard, "03-credential-requires-https");

  // And the API refuses it independently, so a client that skipped the form gains nothing.
  const refused = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: {
      user: { enabled: true, endpoint: "http://telemetry.example.com:4318" },
      userCredential: "a-secret-token",
    },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.text()).toMatch(/HTTPS/);

  // A loopback Collector over plain HTTP stays supported - it is what the reference stack is.
  await dashboard.getByLabel("Telemetry export endpoint").fill("http://127.0.0.1:14318");
  await expect(
    dashboard.getByText("A credential may only be sent over HTTPS, or to a loopback Collector."),
  ).toBeHidden();
  await expect(dashboard.getByRole("button", { name: "Save destination" })).toBeEnabled();
});

test("an unreachable destination reports offline, keeps its queue, and can be discarded", async ({
  dashboard,
  daemon,
}) => {
  // A loopback port nothing is listening on: the honest "your backend is down" case, produced
  // without a network and without a second service.
  await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: {
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14399" },
    },
  });
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await expect(dashboard.getByLabel("Export telemetry to your own backend")).toBeChecked();

  // Nothing is queued yet, so the panel has somewhere to move FROM. Asserting the end state
  // without this would pass against a panel that had shown a queue all along.
  await expect(dashboard.getByText(/queued \(/)).toBeHidden();

  // Produce a fact and try to send it. The probe is a real request to a dead port.
  const probed = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/probe`, {
    data: { profile: "user" },
  });
  expect(probed.ok()).toBe(true);
  expect((await probed.json()).outcome).toBe("unreachable");
  await dashboard.request.post(`${daemon.baseURL}/api/telemetry/drain`);

  // The queue is kept rather than dropped: an unreachable backend is a reason to wait, not a
  // reason to lose data.
  //
  // And this page is NOT reloaded, which is the point of the assertion rather than an economy.
  // The panel's whole claim is that queue health arrives on its own over the settings-status
  // channel this dashboard already holds open - no poll, no second store. A reload would prove
  // only that the health route returns the right numbers, which is a different and much weaker
  // statement, and it is what the first version of this spec actually tested.
  await expect(dashboard.getByText(/queued \(/)).toBeVisible({
    timeout: 15_000,
  });
  // The rail dot rides the same frame, so it converges without a reload too.
  await expect(
    dashboard.getByRole("img", {
      name: "A telemetry destination stopped or is not getting through",
    }),
  ).toBeVisible({ timeout: 15_000 });
  await shoot(dashboard, "04-offline-queue", true);
  // The lower half of the panel - product enrollment, the restore boundary and the identity -
  // lives below the fold of its own scroll container, which `fullPage` cannot reach.
  await dashboard.locator('[data-anchor="telemetry/identity"]').scrollIntoViewIfNeeded();
  await shoot(dashboard, "04b-offline-lower");

  // Discarding is deliberate: it confirms in place rather than firing on the first click.
  const discard = dashboard
    .getByRole("button", { name: "Discard the queue for your own backend" })
    .first();
  await discard.click();
  const confirm = dashboard
    .getByRole("button", {
      name: "Discard the queue for your own backend - confirm",
    })
    .first();
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect(dashboard.getByText(/Dropped \d+ batch/)).toBeVisible({
    timeout: 15_000,
  });
});

test("pausing stops sending without stopping collection, and says which it is", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: {
      enabled: true,
      user: { enabled: true, endpoint: "http://127.0.0.1:14399" },
    },
  });
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);

  // SCOPED to the destination each sentence is about, rather than searched for across the whole
  // panel. Every destination draws its own status line, so an unscoped match can be satisfied by
  // a different card that happens to say the same thing - and "Off. Nothing is being collected
  // for this destination." is exactly that sentence, because the unconfigured product
  // destination says it the whole time. Unscoped, the final assertion below passed against the
  // product card and would have passed with the user destination left switched on.
  const userQueue = dashboard.locator('[data-anchor="telemetry/queue-user"]');

  await dashboard.getByLabel("Pause sending to your own backend").check();
  await expect(userQueue).toContainText(
    "Paused by you. Collection continues and the queue is kept.",
  );
  await shoot(dashboard, "05-paused");

  // Disabling is a different sentence, and a different consequence.
  await dashboard.getByLabel("Export telemetry to your own backend").uncheck();
  await expect(userQueue).toContainText("Off. Nothing is being collected for this destination.");
});

test("resetting the identity mints a new pseudonym and says what it cost", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: true },
  });
  // Capture something so an identity exists to reset.
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const before = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/health`)
  ).json()) as { installationId: string };
  expect(before.installationId).toMatch(/^[0-9a-f]{24}$/);
  await expect(dashboard.getByText(before.installationId)).toBeVisible({
    timeout: 15_000,
  });

  const reset = dashboard.getByRole("button", {
    name: "Reset this installation's telemetry pseudonym",
  });
  await reset.click();
  await dashboard
    .getByRole("button", {
      name: "Reset this installation's telemetry pseudonym - confirm",
    })
    .click();

  await expect(dashboard.getByText(/now reports as a new pseudonym/)).toBeVisible({
    timeout: 15_000,
  });
  const after = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/health`)
  ).json()) as { installationId: string; identityEpoch: number };
  expect(after.installationId).not.toBe(before.installationId);
  // Consent is not withdrawn by a reset - the two are different decisions.
  await expect(
    dashboard.getByLabel("Collect Mission Control telemetry on this machine"),
  ).toBeChecked();
});

test("the typed ingress refuses what a page may not assert, without failing the page", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: true },
  });

  // A daemon-owned event, named from outside the app. Answered 200 with a refusal rather than
  // an error status: a telemetry refusal must never surface as a failed application action.
  const forged = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/ingress`, {
    data: {
      records: [
        {
          event: "mission.daemon.started",
          facts: {
            startup_ms: 1,
            schema_upgraded: false,
            launch_mode: "daemon",
          },
        },
      ],
    },
  });
  expect(forged.status()).toBe(200);
  expect(await forged.json()).toEqual({
    accepted: 0,
    rejected: [{ index: 0, reason: "not_browser_eligible" }],
  });

  // An oversized body is refused before it is parsed.
  const huge = await dashboard.request.post(`${daemon.baseURL}/api/telemetry/ingress`, {
    data: {
      records: [
        {
          event: "mission.telemetry.settings.opened",
          facts: {
            collection_enabled: true,
            destinations_enabled: 0,
            junk: "x".repeat(64 * 1024),
          },
        },
      ],
    },
  });
  expect(huge.status()).toBe(413);
});

test("two dashboards cannot overwrite each other's consent decision", async ({
  dashboard,
  daemon,
  context,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  const second = await context.newPage();
  await second.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await expect(
    second.getByLabel("Collect Mission Control telemetry on this machine"),
  ).toBeVisible();

  // The first tab changes something, which moves the stored revision.
  await dashboard.getByLabel("Collect Mission Control telemetry on this machine").check();
  await expect(dashboard.getByText(/Collecting locally/)).toBeVisible();

  // The second tab converges through the live channel rather than a poll, so its own next write
  // is composed against the current revision instead of being refused forever.
  await expect(second.getByLabel("Collect Mission Control telemetry on this machine")).toBeChecked({
    timeout: 15_000,
  });

  // And a genuinely stale write - composed against the revision before that change - is refused
  // at the API with a conflict rather than silently winning.
  const stale = await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: false, ifRevision: 0 },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).conflict).toBe(true);
  const still = (await (
    await dashboard.request.get(`${daemon.baseURL}/api/telemetry/config`)
  ).json()) as {
    config: { enabled: boolean };
  };
  expect(still.config.enabled).toBe(true);
  await second.close();
});

/**
 * Every `mission.telemetry.settings.opened` row the daemon has durably committed.
 *
 * Read straight out of the journal, because that is the only place the answer exists: the
 * health route reports counts rather than event names, and nothing else in the app would show
 * that a browser-originated fact landed. A READ, like the two other specs that reach the file.
 */
function settingsOpenedRows(daemon: DaemonHandle): {
  facts: { collection_enabled: boolean; destinations_enabled: number };
  actor: { kind: string; origin: string; basis: string };
  refs: Record<string, string>;
}[] {
  return withDaemonDb(daemon, (db) =>
    (
      db
        .prepare(
          `SELECT facts_json, actor_json, refs_json FROM telemetry_journal
            WHERE name = 'mission.telemetry.settings.opened' ORDER BY seq ASC`,
        )
        .all() as unknown as { facts_json: string; actor_json: string; refs_json: string }[]
    ).map((row) => ({
      facts: JSON.parse(row.facts_json),
      actor: JSON.parse(row.actor_json),
      refs: JSON.parse(row.refs_json),
    })),
  );
}

test("opening the telemetry panel records what the operator was shown, through the ingress", async ({
  dashboard,
  daemon,
}) => {
  // Collection on and one destination enabled, so `destinations_enabled` has a value worth
  // asserting rather than a zero that a broken implementation would also produce.
  await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, {
    data: { enabled: true, user: { enabled: true, endpoint: "http://127.0.0.1:14397" } },
  });

  // Settings on ANOTHER category first. The panel is what claims to have been opened, so a hook
  // that ran for the whole Settings page would record that claim when somebody opened Display -
  // which is exactly what it did before this spec existed.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(dashboard.getByRole("tab", { name: /Display/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(settingsOpenedRows(daemon)).toHaveLength(0);

  // Now the panel itself.
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await expect(dashboard.getByText("On this machine", { exact: true })).toBeVisible();

  await expect.poll(() => settingsOpenedRows(daemon).length, { timeout: 15_000 }).toBe(1);

  const [opened] = settingsOpenedRows(daemon);
  // The facts the panel reported: the state a person was actually shown.
  expect(opened.facts.collection_enabled).toBe(true);
  expect(opened.facts.destinations_enabled).toBe(1);
  // And the attribution the browser's own operation context earned end to end. This is the only
  // place that is proved from the browser side rather than from hand-built headers: the client
  // minted the id, the daemon judged it worth `app_context`, and the ref links this fact to the
  // server-side facts of the same operation.
  expect(opened.actor).toEqual({ kind: "human", origin: "dashboard", basis: "app_context" });
  expect(opened.refs.operation_id).toMatch(/^[0-9a-z]{8,32}$/);
});

test("the panel records nothing while collection is off, because consent gates the ingress too", async ({
  dashboard,
  daemon,
}) => {
  // Default-off, and the panel is opened anyway. The browser submits on mount either way; the
  // daemon is what refuses it, which is the property worth pinning - a page cannot write into
  // the journal of an installation that has not opted in.
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await expect(
    dashboard.getByLabel("Collect Mission Control telemetry on this machine"),
  ).not.toBeChecked();

  // Give the submission every chance to land before concluding it did not.
  await dashboard.waitForTimeout(1_000);
  expect(settingsOpenedRows(daemon)).toHaveLength(0);

  // Turning collection on and reopening the panel records exactly one, so the zero above is a
  // refusal rather than a spec that could never observe anything.
  await dashboard.getByLabel("Collect Mission Control telemetry on this machine").check();
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await dashboard.goto(`${daemon.baseURL}/#/settings/telemetry`);
  await expect.poll(() => settingsOpenedRows(daemon).length, { timeout: 15_000 }).toBe(1);
  expect(settingsOpenedRows(daemon)[0].facts.collection_enabled).toBe(true);
});
