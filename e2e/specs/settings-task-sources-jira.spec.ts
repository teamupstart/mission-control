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

  // And the success sentence is the KIND's. It used to be hardcoded as "gh is reachable and
  // this repo lists issues", which a Jira source would have claimed while never going near
  // `gh` - a healthy verdict about somebody else's credential.
  answer = { ok: true, problem: null };
  await check.click();
  await expect(note).toContainText("Looks good - Jira answered, and this JQL filter runs.");
  await expect(note).not.toContainText("gh");
});
