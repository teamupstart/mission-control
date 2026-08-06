import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";

/**
 * Adding a Jira task source, in the panel an operator actually uses.
 *
 * What only this layer can prove. `test/jira-map.test.ts` and `test/jira-preflight.test.ts`
 * pin the sweep and the auth ladder against a fake `jira` binary, and
 * `test/task-sources-panel.test.ts` pins the directory row - but the editor beside that list
 * is gated on an effect that picks a selection, and `renderToStaticMarkup` runs no effects,
 * so no other layer can see the Jira field group at all. This is also the only place where a
 * click reaches the config route, the daemon writes it, and the panel reads back what it
 * stored.
 *
 * Two claims:
 *
 *  1. The kind is REACHABLE - offered by the add control with its own blurb, arriving
 *     switched off with the Jira fields (not the GitHub ones), and keeping its filter across
 *     a reload, which is what proves the config went to the daemon rather than into
 *     component state.
 *  2. An unusable source SAYS SO. The empty-filter sentence comes from the real daemon here,
 *     because the whole feature exists so a misconfigured source is never a silent empty
 *     sweep. The credential sentences are then fulfilled locally: what the panel owes an
 *     operator is that it renders the daemon's answer rather than swallowing it, and
 *     reaching a real Jira for that would put a token and a VPN in the test's path.
 *
 * No model tokens: nothing here dispatches an agent, and nothing here sweeps.
 */

/** Enough of a JQL query to be a real one, and recognisable in a stored blob. */
const JQL = 'project = MC AND status = "To Do" ORDER BY created DESC';

/** What the daemon says when neither rung of the auth ladder is available. */
const NO_CREDENTIAL =
  "no way to reach Jira: install the CLI (`brew install ankitpokhrel/jira-cli/jira-cli` " +
  "then `jira init`), or set JIRA_API_TOKEN and JIRA_EMAIL in the daemon's environment";

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/jira-task-source/", import.meta.url));

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the palette's and the settings ledger's: an ordinary run
 * would rewrite the binaries for no added signal. Inside the regression rather than a staged
 * capture spec, so each frame is of a run whose assertions passed.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control, pointer AND focus: `Tooltip` opens on either, and a bubble over the
  // field group would be the one thing in the frame that is not what the spec is about.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/jira-task-source/${name}.png`);
}

test("a Jira source is addable from the panel, arrives off, and keeps its filter", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const add = page.getByRole("button", { name: "Add source" });
  await expect(add).toBeVisible();
  await add.click();

  // The add control is derived from the daemon's own kinds list, so this is also the check
  // that the kind is registered end to end rather than merely compiled.
  await page.getByRole("combobox", { name: "What kind of source to add" }).selectOption("jira");
  await expect(page.getByText(/Files the issues a JQL filter matches/)).toBeVisible();

  // Escape closes the combobox's portalled list, which otherwise covers the Add button.
  await page.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // Off, always: adding a source is configuration and turning it on is consent.
  await expect(page.getByRole("checkbox", { name: "Sweep Jira on a schedule" })).not.toBeChecked();

  // The Jira field group, and the shipped site default reaching the operator.
  await expect(page.getByLabel("Jira site")).toHaveValue("upstartnetwork.atlassian.net");
  await expect(page.getByLabel("JQL filter")).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: /priority from the Jira issue/ })).toBeChecked();
  // And not the other kind's, which would be a source configured for an upstream it will
  // never ask - the GitHub filters cannot narrow a JQL query.
  await expect(page.getByLabel("Labels (any of)")).toHaveCount(0);
  await expect(page.getByLabel("Milestone (optional)")).toHaveCount(0);

  // A source with no filter sweeps nothing, which is indistinguishable from a filter with no
  // matching issues - so the panel says it before the first sweep can look healthy.
  await expect(page.getByText(/Without a JQL filter this source sweeps nothing/)).toBeVisible();
  await shoot(page, "jira-source-without-a-filter");

  // Text fields commit on blur, so filling the next one is what saves the last.
  await page.getByLabel("Jira site").fill("acme.atlassian.net");
  await page.getByLabel("JQL filter").fill(JQL);
  await page.keyboard.press("Tab");

  // Gone once there is a filter. This is the PANEL's own state and nothing more: the save is
  // applied optimistically and the PUT is still in flight, so this proves nobody has to wait
  // for a round trip to see their edit - not that the edit was stored.
  await expect(page.getByText(/Without a JQL filter this source sweeps nothing/)).toHaveCount(0);

  // That is asserted here, against the daemon's own config, and it has to be waited for
  // rather than assumed: reloading straight after the blur cancels the in-flight write, which
  // is what made this spec pass alone and fail under a loaded suite.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
        const body = (await res.json()) as { sources?: { config?: { jql?: string } }[] };
        return body.sources?.[0]?.config?.jql ?? "";
      },
      { message: "the daemon should have stored the filter the panel accepted" },
    )
    .toBe(JQL);

  // And it survives a fresh page, which is what an operator comes back to tomorrow.
  await page.reload();
  await expect(page.getByLabel("JQL filter")).toHaveValue(JQL);
  await expect(page.getByLabel("Jira site")).toHaveValue("acme.atlassian.net");
  await shoot(page, "jira-source-configured");
});

test("a config read that left before an edit cannot revert the field, or be saved over it", async ({
  page,
  daemon,
}) => {
  // The defect this pins is a LOST WRITE, not a flash. `useTaskSources` polls every 4s and
  // used to write every response into state unconditionally, and a kind's fields compose the
  // whole config blob from what is on screen (`{...cfg, jql}`) - so a read that left before
  // an edit put the old value back, and the NEXT field's commit then persisted it. Editing
  // the Jira site and then the JQL filter saved the filter and silently reverted the site.
  //
  // Found by the case above failing under the full suite's parallel load, where the 4s poll
  // happened to land inside the two edits. Reproduced here on purpose by holding one read
  // open, which is how `harness-defaults-propagate.spec.ts` pins the same class of bug.
  const seeded = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: {
      sources: [{ id: "jira-race", kind: "jira", label: "platform queue", repoRoot: daemon.repo }],
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const site = page.getByLabel("Jira site");
  await expect(site).toHaveValue("upstartnetwork.atlassian.net");

  // Hold one config GET open. Its body is read NOW - before the edit below - and delivered
  // later, which is exactly the shape of a poll that overtakes a save.
  let release: (() => void) | null = null;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let delivered: (() => void) | null = null;
  const staleLanded = new Promise<void>((r) => {
    delivered = r;
  });
  let stale: string | null = null;
  let hit: (() => void) | null = null;
  const gateHit = new Promise<void>((r) => {
    hit = r;
  });
  // AWAITED: registration is asynchronous, and an un-awaited route lets the edit below race
  // it - the gate would then close on the save's own confirming read instead, which carries
  // the NEW value and would let this pass against the very bug it exists to catch.
  await page.route("**/api/task-sources/config", async (route) => {
    if (route.request().method() !== "GET" || stale !== null) return route.fallback();
    const res = await route.fetch();
    stale = await res.text();
    hit?.();
    await released;
    await route.fulfill({ response: res, body: stale });
    delivered?.();
  });
  await gateHit;
  expect(stale).toContain("upstartnetwork.atlassian.net");

  // Armed BEFORE the edit, so it cannot match the gated request: the save's own confirming
  // read. Waiting for it is what makes this deterministic - see below.
  const confirmingRead = page.waitForResponse(
    (r) =>
      r.url().includes("/api/task-sources/config") &&
      r.request().method() === "GET" &&
      r.status() === 200,
  );

  // Edit one field and commit it. The PUT and the confirming GET both fall through to the
  // daemon, so the panel settles on the new value first...
  await site.fill("acme.atlassian.net");
  await page.keyboard.press("Tab");
  await confirmingRead;
  await expect(site).toHaveValue("acme.atlassian.net");

  // ...and only THEN does the pre-edit body land, with nothing behind it to heal the view.
  // That order is the whole test. A first draft released the stale read immediately, and the
  // confirming read arrived a few hundred milliseconds later and corrected the field before
  // anything could be composed from it - so the draft passed against the very bug it was
  // written for. Measured, not reasoned about: a throwaway probe printed the field after each
  // step and the stored config at the end.
  release?.();
  await staleLanded;
  // The response is in the browser; give the render that would apply it a chance to happen,
  // so the next edit reads whatever `cfg` the panel actually ended up with. Two frames rather
  // than a fixed sleep, and it is a barrier for the UNFIXED path - a guarded read changes
  // nothing observable here, which is the whole point of the assertions below.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

  // The flash half: the field must not have snapped back to what the operator changed away
  // from. Read ONCE rather than through `toHaveValue`, deliberately - that assertion retries
  // for 20 seconds, and the next 4s poll heals the field inside that window, so a retrying
  // assertion passes over the very revert it is looking at. The barrier above is what makes
  // "right now" a well-defined moment to read.
  expect(await site.inputValue(), "a read from before the edit put the old value back").toBe(
    "acme.atlassian.net",
  );

  // The lost-write half, and the expensive one: the NEXT field's commit composes the whole
  // config blob from what is on screen, so a reverted value gets PERSISTED by it.
  await page.getByLabel("JQL filter").fill(JQL);
  await page.keyboard.press("Tab");
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
        const body = (await res.json()) as {
          sources?: { config?: { site?: string; jql?: string } }[];
        };
        return body.sources?.[0]?.config ?? {};
      },
      { message: "both edits should be in force on the daemon" },
    )
    .toMatchObject({ site: "acme.atlassian.net", jql: JQL });
});

test("a slow save cannot land after a newer one and put the older value back", async ({
  page,
  daemon,
}) => {
  // The write half of the same class of defect as the case above. Every save PUTs the WHOLE
  // source list, so two in flight together are decided by ARRIVAL rather than by intent: hold
  // the first one past the second and it lands last, putting its own older blob back and
  // dropping the newer field. `readIsCurrent` does not help here - it guards reads and local
  // reverts, and a request already on the wire is neither.
  const seeded = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: {
      sources: [{ id: "jira-writes", kind: "jira", label: "platform queue", repoRoot: daemon.repo }],
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const site = page.getByLabel("Jira site");
  await expect(site).toHaveValue("upstartnetwork.atlassian.net");

  // Hold the FIRST write open. Later ones pass straight through, which is what lets an
  // unserialized panel deliver them out of order.
  let release: (() => void) | null = null;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  let hit: (() => void) | null = null;
  const gateHit = new Promise<void>((r) => {
    hit = r;
  });
  await page.route("**/api/task-sources/config", async (route) => {
    if (route.request().method() !== "PUT" || held) return route.fallback();
    held = true;
    hit?.();
    await released;
    await route.fallback();
  });

  // Two commits, back to back, with the first one's PUT stuck in the gate.
  await site.fill("acme.atlassian.net");
  await page.keyboard.press("Tab");
  await gateHit;
  await page.getByLabel("JQL filter").fill(JQL);
  await page.keyboard.press("Tab");
  release?.();

  // Both edits in force. Unserialized, the second PUT went out while the first was held, and
  // the first then arrived last carrying the pre-JQL blob - so the filter was silently lost.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
        const body = (await res.json()) as {
          sources?: { config?: { site?: string; jql?: string } }[];
        };
        return body.sources?.[0]?.config ?? {};
      },
      { message: "neither edit may be overwritten by the other's write" },
    )
    .toMatchObject({ site: "acme.atlassian.net", jql: JQL });
});

test("an unusable Jira source names the fix, and a healthy one names Jira rather than gh", async ({
  page,
  daemon,
}) => {
  // Seeded through the route the panel writes with, so this test is about preflight rather
  // than about the add form the case above already drives. No filter: that is the state a
  // freshly added source is in.
  const seeded = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: {
      sources: [{ id: "jira-e2e", kind: "jira", label: "platform queue", repoRoot: daemon.repo }],
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const check = page.getByRole("button", { name: "Check it works" });
  await expect(check).toBeVisible();
  const note = page.locator("p.ts-note");

  // The REAL daemon answering: an empty filter is refused by name, and it is refused before
  // any binary or network is reached, so this assertion is the same on every machine.
  await check.click();
  await expect(note).toContainText("set a JQL query");
  await expect(note).not.toContainText("Looks good");
  // And it is READ, not merely rendered. The card is taller than the pane, so an answer
  // printed at the top of it lands off screen above the button that asked for it - which for
  // this one sentence is the same as not answering.
  await expect(note).toBeInViewport();

  await page.getByLabel("JQL filter").fill(JQL);
  await page.keyboard.press("Tab");
  await expect(page.getByText(/Without a JQL filter/)).toHaveCount(0);

  // From here the answers are fulfilled locally. What the panel owes an operator is that it
  // renders the daemon's sentence verbatim instead of flattening it to "something went
  // wrong" - and that a source with no credential is never reported as healthy.
  let answer: { ok: boolean; problem: string | null } = { ok: false, problem: NO_CREDENTIAL };
  await page.route("**/api/task-sources/*/preflight", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(answer),
    }),
  );

  await check.click();
  await expect(note).toContainText("no way to reach Jira");
  await expect(note).toContainText("brew install ankitpokhrel/jira-cli/jira-cli");
  await expect(note).toContainText("JIRA_API_TOKEN and JIRA_EMAIL");
  await expect(note).not.toContainText("Looks good");
  // A problem reads as a problem. In the hint tone it shared with "Forgotten - the next sweep
  // will file these items again", a broken credential read as reassurance.
  await expect(note).toHaveClass(/settings-error/);
  await shoot(page, "preflight-names-the-fix");

  // And the success sentence is the KIND's. It used to be hardcoded as "gh is reachable and
  // this repo lists issues", which a Jira source would have claimed while never going near
  // `gh` - a healthy verdict about somebody else's credential.
  answer = { ok: true, problem: null };
  await check.click();
  await expect(note).toContainText("Looks good - Jira answered, and this JQL filter runs.");
  await expect(note).not.toContainText("gh");
  await expect(note).not.toHaveClass(/settings-error/, { timeout: 2000 });
});
