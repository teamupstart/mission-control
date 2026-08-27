import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Foreman participation, driven the way an operator changes it: from the session's own
 * detail rail, and back again.
 *
 * What only this layer can prove. The `renderToStaticMarkup` tests pin each rail state's
 * markup from a session object handed to them, and `foreman-invite.test.ts` pins the two
 * routes against an in-process app - but neither can see whether the button the operator
 * presses reaches the route, or whether the `session_upsert` that route emits comes back
 * and swaps the control. That round trip IS the feature: the rail makes a claim about
 * what the Foreman worker will do in this session, and the claim is only worth anything
 * if the click and the daemon's answer are the same fact.
 *
 * The cycle runs on a dispatched SDK session, because that is the only kind of session
 * this suite can have - passive terminal discovery is switched off in the fixture
 * (`MISSION_POLL_MS=0`, safety-critical: it would otherwise adopt the developer's real
 * sessions) and every dispatch here is SDK runtime. An SDK session is invited by
 * construction, with no invite row behind it, so it can only be driven UNINVITED by the
 * `withdrawn` tombstone - which is exactly the mechanism this spec needs to exercise
 * anyway, and the reason the plan chose a tombstone over a deleted row.
 *
 * Foreman is switched on fleet-wide first. Not decoration: `foreman-off` outranks the
 * invite in `foremanSendBlock`, and correctly - inviting Foreman into a session while
 * Foreman is off buys nothing - so with the shipped default the work queue would explain
 * the switch instead of the invite, and this spec would be asserting the wrong sentence
 * for the right reason.
 */

const TASK = "write a haiku about flexbox";
const EVIDENCE = artifactsDir("foreman-invite");

/** The rail's uninvited state, by the words on it rather than by its accent class. */
const inviteButton = (page: Page) => page.getByRole("button", { name: "Invite foreman" });
/** Its invited state, before Foreman has decided anything here. */
const intentButton = (page: Page) => page.getByRole("button", { name: "Foreman intent" });

async function call(
  daemon: DaemonHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
  return res;
}

const put = (daemon: DaemonHandle, path: string, body: unknown): Promise<Response> =>
  call(daemon, "PUT", path, body);

/**
 * The one SDK session this daemon has, by id - discovery is off, so there is exactly one.
 *
 * Polled rather than read once: the dispatch modal closes when the route accepts the
 * dispatch, which is before the supervisor has adopted the session into the registry. Read
 * straight through, this raced the adoption and reported zero sessions.
 */
async function sessionId(daemon: DaemonHandle): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        const all = (await (await call(daemon, "GET", "/api/sessions")).json()) as {
          id: string;
          runtime: string;
        }[];
        const sdk = all.filter((s) => s.runtime === "sdk");
        found = sdk[0]?.id;
        return sdk.length;
      },
      { message: "the dispatched SDK session should reach the registry", timeout: 20_000 },
    )
    .toBe(1);
  return found!;
}

/**
 * Dispatch one agent from the real modal.
 *
 * `Escape` after the repo field is load-bearing rather than defensive: `RepoCombobox`
 * portals its listbox over the Task field below it and opens on every keystroke, so
 * without dismissing it the next `fill` lands on a covered control. Its own Escape
 * handler stops propagation, so this closes the list and not the modal.
 */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.getByLabel("Kind").selectOption("ship");
  // Pinned rather than left at the daemon's configured default, which would be refused
  // here: this repo is not allowlisted for Workflows Live delivery, and the modal would
  // stay open with the refusal in it.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * One reviewer-facing screenshot, only when capture is asked for.
 *
 * Scoped to a locator rather than the page: what has to be compared against the approved
 * mockup is the tab strip's right-hand slot and the drawer header, and a full-page shot of
 * a console at 1280px renders both about forty pixels tall.
 */
async function shot(
  locator: ReturnType<Page["locator"]>,
  name: string,
  observed: string,
): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await locator.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${observed}`);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/foreman-invite/${name}.png`);
}

/** The console's session detail, opened on the one session this daemon has. */
async function openDetail(page: Page, daemon: DaemonHandle) {
  await put(daemon, "/api/ui/config", { layout: "console" });
  await page.reload();

  const rail = page.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  // The first SESSION ROW, not the first button in the rail: the rail groups its rows by
  // repository, so the first button is that heading's collapse control and clicking it folds
  // the group instead of opening anything.
  await rail.locator("button.rail-row").first().click();
  return page.getByRole("tablist", { name: "Session detail" });
}

test("an operator can withdraw Foreman from a session and invite it back", async ({
  dashboard,
  daemon,
}) => {
  await put(daemon, "/api/foreman/config", { enabled: true });
  await dispatch(dashboard, daemon);
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);

  const tabs = await openDetail(dashboard, daemon);

  // State 2. A dispatched SDK session is invited by construction and has no decision
  // history yet - and the slot is occupied anyway, which is the invited half of this
  // change: it used to be empty until Foreman had captured an objective or made a call.
  await expect(intentButton(dashboard)).toBeVisible();
  await expect(inviteButton(dashboard)).toHaveCount(0);
  await shot(tabs, "rail-invited", 'the rail reads "Foreman intent" on an invited session');

  // The exit lives with the record of what Foreman has been doing, which is where an
  // operator forms the opinion that it should stop.
  await intentButton(dashboard).click();
  const withdraw = dashboard.getByRole("button", { name: "Withdraw invite" });
  await expect(withdraw).toBeVisible();
  await shot(
    dashboard.locator("header.fd-head"),
    "drawer-withdraw",
    'the drawer header carries "Withdraw invite" between the title and the pinned close',
  );
  await withdraw.click();

  // State 1, and NOT from an optimistic local flip: nothing in the browser writes this
  // field. The button changed because the daemon stored a `withdrawn` tombstone, resolved
  // the session again, and pushed it back over SSE - the same field, from the same place,
  // that the Foreman worker gates itself on.
  await expect(inviteButton(dashboard)).toBeVisible();
  await expect(intentButton(dashboard)).toHaveCount(0);
  // The drawer went with it: its only header action has already happened.
  await expect(withdraw).toHaveCount(0);
  await shot(tabs, "rail-uninvited", "the same slot now offers ＋ Invite foreman, in the Foreman purple");

  // And the silence has a sentence. This queue is empty and Foreman is on, live and
  // allowlisted-irrelevant - before this phase the panel said nothing at all, and an
  // operator watching a queue that never moves had no way to learn why.
  await tabs.getByRole("tab", { name: /Work queue/ }).click();
  const panel = dashboard.locator("section.work-queue");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Foreman is not in this session/)).toBeVisible();
  await expect(panel.getByText(/invite it from the rail above/)).toBeVisible();
  await shot(panel, "queue-not-invited", "the empty work queue explains the silence instead of showing an add box and nothing else");

  // Back in. The tombstone is deleted rather than overwritten with an `operator` grant,
  // so this SDK session resolves to its implicit `"sdk"` invite again - and the panel
  // stops explaining an absence that has ended.
  await inviteButton(dashboard).click();
  await expect(intentButton(dashboard)).toBeVisible();
  await expect(inviteButton(dashboard)).toHaveCount(0);
  await expect(panel.getByText(/Foreman is not in this session/)).toHaveCount(0);
  await shot(panel, "queue-reinvited", "the sentence is gone once Foreman is back in the session");
});

/**
 * A refused withdrawal must not look like a successful one.
 *
 * `api.withdrawForemanInvite` goes through `request()`, which never rejects: a 500, a
 * vanished session and a dropped connection all come back as a settled
 * `{ ok: false, error }`. Closing the drawer on that would hand the operator the exact
 * signal they get when it worked, while Foreman keeps triaging, wrapping up and following
 * PRs in a session they believe they just removed it from. That is the most dangerous
 * thing this feature can get wrong, and no other layer can see it - the render tests are
 * handed a session object, and the route tests never press a button.
 */
test("a refused withdrawal leaves Foreman visibly still in the session", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await openDetail(dashboard, daemon);

  await intentButton(dashboard).click();
  const withdraw = dashboard.getByRole("button", { name: "Withdraw invite" });
  await expect(withdraw).toBeVisible();

  // The daemon is fine; the answer is not. Fulfilled rather than aborted so this exercises
  // the non-2xx arm of `request()`, which is the one that resolves rather than throwing.
  await dashboard.route("**/foreman-invite", async (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
      : route.continue(),
  );

  await withdraw.click();

  // Every signal still says Foreman is here, because it is.
  await expect(dashboard.getByRole("alert")).toContainText("was not withdrawn");
  await expect(dashboard.getByRole("alert")).toContainText("may still be triaging");
  await expect(withdraw, "the drawer must not close on a write that did not land").toBeVisible();
  await expect(intentButton(dashboard)).toBeVisible();
  await expect(inviteButton(dashboard)).toHaveCount(0);

  // And the control is usable again rather than latched disabled by the failure.
  await dashboard.unroute("**/foreman-invite");
  await withdraw.click();
  await expect(inviteButton(dashboard)).toBeVisible();
  // The message went with the state it was describing.
  await expect(dashboard.getByRole("alert")).toHaveCount(0);
});

/**
 * An invite that ends somewhere else must not leave this drawer armed to reopen.
 *
 * `withdrawForeman` resets `drawerOpen`, but it covers exactly one of the ways an invite
 * ends. The daemon owns the field: another dashboard on the same session, a scripted
 * `DELETE`, or a session reset all withdraw it, and every one arrives here as an ordinary
 * `session_upsert`. The `invited` gate unmounts the drawer on any of them - but unmounting
 * does not clear the flag, so without the reset the next invite remounts the drawer with
 * `open` still true and pops it open in front of an operator who never clicked anything.
 *
 * Driven through the routes rather than a second browser because that is the same event
 * this component sees either way, and it keeps the spec to one page.
 */
test("an invite withdrawn elsewhere does not leave the drawer armed to reopen", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await sessionId(daemon);
  await openDetail(dashboard, daemon);

  // Open it, the way an operator would, and confirm it is really open.
  await intentButton(dashboard).click();
  await expect(dashboard.getByRole("button", { name: "Withdraw invite" })).toBeVisible();

  // Somebody else withdraws. This browser pressed nothing.
  await call(daemon, "DELETE", `/api/sessions/${encodeURIComponent(id)}/foreman-invite`);
  await expect(inviteButton(dashboard)).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Withdraw invite" })).toHaveCount(0);

  // And back in, again from elsewhere. The rail returns; the drawer must NOT.
  await call(daemon, "POST", `/api/sessions/${encodeURIComponent(id)}/foreman-invite`);
  await expect(intentButton(dashboard)).toBeVisible();
  await expect(
    dashboard.getByRole("button", { name: "Withdraw invite" }),
    "the drawer reopened without a click - a stale drawerOpen survived the withdrawal",
  ).toHaveCount(0);

  // Still usable rather than merely closed: the flag was reset, not wedged.
  await intentButton(dashboard).click();
  await expect(dashboard.getByRole("button", { name: "Withdraw invite" })).toBeVisible();
});

/**
 * The chip does not move while its own write is in flight.
 *
 * Not a nicety, and not something any other layer can see. `Tooltip` wraps a DISABLED
 * trigger in a `.tt-anchor` span - it has to, because a disabled button dispatches no
 * mouse events and would otherwise lose the sentence explaining itself - and that span is
 * `display: inline-flex`, so it becomes the flex item and `.foreman-rail`'s own
 * `margin-left: auto` lands on a child that no longer decides where it sits. Untreated,
 * pressing the button throws it from the right-hand end of the tab strip into the middle
 * of the row and back again. A markup assertion cannot see it; only a laid-out browser can.
 */
test("the invite chip holds its slot while the write is in flight", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const tabs = await openDetail(dashboard, daemon);

  await intentButton(dashboard).click();
  await dashboard.getByRole("button", { name: "Withdraw invite" }).click();
  await expect(inviteButton(dashboard)).toBeVisible();

  const strip = await tabs.boundingBox();
  const settled = await inviteButton(dashboard).boundingBox();

  // Hold the invite open so the disabled frame is not a frame. Only the POST: the DELETE
  // above has already run, and stalling every call on this path would strand the fixture.
  await dashboard.route("**/foreman-invite", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  await inviteButton(dashboard).click();
  await expect(inviteButton(dashboard)).toBeDisabled();
  const busy = await inviteButton(dashboard).boundingBox();

  // Same pixels, and pinned to the strip's right edge rather than to whatever the settled
  // measurement happened to be - so this still fails if BOTH states drift left together.
  expect(busy?.x).toBeCloseTo(settled?.x ?? 0, 0);
  expect(strip!.x + strip!.width - (busy!.x + busy!.width)).toBeLessThan(24);

  // And it comes back enabled rather than latching, once the daemon answers.
  await expect(intentButton(dashboard)).toBeVisible({ timeout: 15_000 });
});
