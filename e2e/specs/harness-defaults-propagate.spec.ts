import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * INVESTIGATION SPEC - reproduces the reported "per-harness model changes are not taken
 * into account immediately" behaviour.
 *
 * The daemon side is already proven fresh by `test/dispatch-model.test.ts` ("a backlogged
 * task launches on the default in force NOW") - `resolveDispatchModel` does an uncached
 * SELECT per dispatch, so no restart is involved. What that layer cannot see is the PANEL,
 * which is where the operator actually reads back whether their change stuck.
 *
 * `useHarnesses` polls `GET /api/harnesses/config` every 4s and writes every response into
 * state with no request-sequencing guard. A poll that left before an edit carries the
 * PRE-EDIT config, so if it lands after the edit's own confirming read, it overwrites the
 * new value with the old one - and the panel then shows the stale value until the next tick.
 */

const CLAUDE_MODEL = "Default model for dispatched Claude Code sessions";

const EVIDENCE = artifactsDir("harness-defaults-propagate");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the settings ledger's and the palette's: an ordinary run
 * would rewrite the binaries for no added signal. Inside the regression test rather than a
 * staged capture spec, so the picture is of a run whose assertions passed.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control, pointer AND focus: `Tooltip` opens on either, and the select that was
  // just changed would otherwise keep its bubble over the card the picture is of.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/harness-defaults-propagate/${name}.png`);
}

test("a model just changed in Settings is not overwritten by an in-flight config poll", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  const model = dashboard.getByRole("combobox", { name: CLAUDE_MODEL });
  await expect(model).toBeEnabled();

  // Hold the next config GET open. Its body is read NOW - before the edit below - and
  // delivered after, which is exactly the shape of a read that overtakes a save.
  let release: (() => void) | null = null;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let gatedBody: string | null = null;
  let hit: (() => void) | null = null;
  const gateHit = new Promise<void>((r) => {
    hit = r;
  });
  // AWAITED. Registration is asynchronous, and leaving it un-awaited let the write below
  // race it: with the route not yet installed, the read it provokes goes through unheld and
  // the gate closes on the NEXT request instead - the confirming read, which carries the
  // post-edit value and would let this spec pass against the very bug it exists to catch.
  await dashboard.route("**/api/harnesses/config", async (route) => {
    if (route.request().method() !== "GET" || gatedBody !== null) return route.fallback();
    const res = await route.fetch();
    gatedBody = await res.text();
    hit?.();
    await released;
    await route.fulfill({ response: res, body: gatedBody });
  });

  // Provoke that read from OUTSIDE the panel, the way a second dashboard tab would: the PUT
  // makes the daemon publish `harnesses_config_changed`, and the panel re-reads on it. That
  // is both the fast way to get a read in flight - no waiting out the backstop interval -
  // and a check that the new event is wired end to end, since a panel that ignored it would
  // never issue this request and the gate would never be hit.
  const stale = "claude-haiku-4-5";
  const next = "claude-sonnet-5";
  const seeded = await dashboard.request.put(`${daemon.baseURL}/api/harnesses/config`, {
    data: { defaultModel: { claude: stale } },
  });
  expect(seeded.ok(), "the out-of-band write should have been accepted").toBe(true);
  await gateHit;
  // The held read must be the one that PREDATES the edit below. Asserted rather than assumed:
  // if the gate ever closes on a later request instead, its body already contains the edit and
  // applying it proves nothing - the spec would pass with the ordering guard ripped out.
  expect(
    JSON.parse(gatedBody ?? "{}").defaultModel?.claude,
    "the gate closed on the wrong request, so this spec is not testing the race",
  ).toBe(stale);

  await model.selectOption(next);
  // The write landed: the daemon is the authority and it now holds `next`.
  await expect
    .poll(async () =>
      (
        await (await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`)).json()
      ).defaultModel.claude,
    )
    .toBe(next);

  release?.();

  // The panel must keep showing what is actually in force. Asserted as "never goes stale"
  // rather than with `toHaveValue`, which auto-retries and would be satisfied by the next
  // backstop read healing the value - hiding the window the operator actually sees.
  let observedStale: string | null = null;
  for (let i = 0; i < 60; i++) {
    const shown = await model.inputValue();
    if (shown === stale) {
      observedStale = shown;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(
    observedStale,
    `the panel reverted to the pre-edit model ${JSON.stringify(stale)} while the daemon held ${next}`,
  ).toBeNull();
});

test("a model changed in Settings reaches the very next dispatch's command line", async ({
  dashboard,
  daemon,
}) => {
  // The other half of the reported symptom: whether the DAEMON needs a restart to notice.
  // Proven against the launch itself rather than the card, because the command line is the
  // only place the answer is unambiguous - the fake records its own argv.
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  const model = dashboard.getByRole("combobox", {
    name: "Default model for dispatched Claude Code sessions",
  });
  await expect(model).toBeEnabled();
  await model.selectOption("claude-sonnet-5");
  await expect
    .poll(async () =>
      (
        await (await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`)).json()
      ).defaultModel.claude,
    )
    .toBe("claude-sonnet-5");
  // The saved card, with its own sentence naming the flag the next launch will carry.
  await shoot(dashboard, "harnesses-card-saved");

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  // The picker names the default it just read, which is the operator-facing half of "did
  // my change land" - and it is left on Default so the harness setting is what resolves.
  await expect(dialog.getByLabel("Model")).toHaveValue("");
  await expect(dialog.getByLabel("Model")).toContainText("Default - Sonnet 5");
  // The dispatch form naming the default it just read - the label that used to go on
  // advertising a retired model until the modal was closed and reopened.
  await shoot(dashboard, "dispatch-modal-names-new-default");

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("write a haiku about flexbox");
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const dir = join(daemon.recordDir, "claude");
  const read = (): { argv: string[] }[] => recordsIn<{ argv: string[] }>(dir);

  // Polled: the card registers before the child has run far enough to write its record.
  await expect
    .poll(() => read().some(
      (r) => r.argv.includes("--input-format") && !r.argv.includes("--setting-sources="),
    ), {
      message: "the SDK session should have launched the fake",
    })
    .toBe(true);

  const session = read().find(
    (r) => r.argv.includes("--input-format") && !r.argv.includes("--setting-sources="),
  );
  expect(
    session?.argv[session.argv.indexOf("--model") + 1],
    "the dispatch should run on the model saved moments earlier, with no daemon restart",
  ).toBe("claude-sonnet-5");
});

test("two quick edits both stick - the first one's confirming read must not clobber the second", async ({
  dashboard,
  daemon,
}) => {
  // The everyday trigger, with no request held open artificially. Every `update` fires a
  // PUT and then its OWN confirming GET; that GET reflects only the edit it belongs to. An
  // operator setting Model and then Effort - which is the normal way to configure a card -
  // can have edit one's confirming read land after edit two's optimistic write.
  //
  // The 120ms is latency, not a gate: a daemon streaming several live sessions is slower
  // than a loopback idle one, and the reordering window IS the round trip.
  await dashboard.route("**/api/harnesses/config", async (route) => {
    await new Promise((r) => setTimeout(r, 120));
    await route.fallback();
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  const model = dashboard.getByRole("combobox", {
    name: "Default model for dispatched Claude Code sessions",
  });
  const effort = dashboard.getByRole("combobox", {
    name: "Default effort for dispatched Claude Code sessions",
  });
  await expect(model).toBeEnabled();

  await model.selectOption("claude-sonnet-5");
  await effort.selectOption("high");

  // The daemon holds both - the writes themselves are fine, they merge server-side.
  await expect
    .poll(async () => {
      const cfg = await (
        await dashboard.request.get(`${daemon.baseURL}/api/harnesses/config`)
      ).json();
      return `${cfg.defaultModel.claude}/${cfg.defaultEffort.claude}`;
    })
    .toBe("claude-sonnet-5/high");

  // The panel must agree, and must not drop back through a value that is no longer in force.
  let reverted: string | null = null;
  for (let i = 0; i < 40; i++) {
    const [m, e] = [await model.inputValue(), await effort.inputValue()];
    if (m !== "claude-sonnet-5" || e !== "high") reverted = `${m}/${e}`;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(reverted, "the panel showed a model/effort pair the daemon was not holding").toBeNull();
});
