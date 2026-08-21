import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Line, end to end: daemon fold -> SSE -> the strip -> a click that navigates.
 *
 * This is the only layer that can see whether the strip WORKS. The fold's unit tests prove
 * the sentences are right given fixtures; the markup test proves the buttons are named; the
 * Electron test proves the height. None of them can see the wire. The specific thing at
 * stake here is that the strip is fed exclusively by the daemon: it holds no client-side
 * derivation to fall back on, so if `line_summary` does not arrive, or arrives and is not
 * reduced into the store, the strip silently sits on whatever the snapshot said at load and
 * every count on the fleet's permanent header goes quietly stale.
 *
 * So the assertions here are all about MOVEMENT with no reload: file a task and watch the
 * stage change, park it and watch the stage go amber. A spec that only loaded the page and
 * read six numbers would pass on a build whose SSE handler was deleted.
 *
 * The click at the end is Shipped's, and it is a drawer now rather than a navigation - that
 * stage pointed at `#/runs?status=completed` for one release, because nothing in the app
 * rendered the adoption ledger its count is made of. What is still checked through it is the
 * same thing: a press reaches its target, and the strip does not follow you off the fleet
 * when something finally does navigate.
 *
 * No model tokens: nothing here dispatches an agent. Every state is reached through the
 * task routes, which is also what makes it deterministic - the Backlog stage is the one
 * stage whose whole input is data a test can write directly.
 */

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const STAGES = ["Intake", "Backlog", "Working", "Review", "Decide", "Shipped"];

const EVIDENCE = artifactsDir("line-strip");

/**
 * Photograph the strip this spec is already asserting on.
 *
 * Behind `MC_E2E_EVIDENCE` for the reason the other captures give: an ordinary run would
 * rewrite the binaries for no added signal. Inside the regression test rather than in a
 * staged capture spec of its own, because the point of the picture is that the assertions
 * around it passed on the same run - a screenshot from a separate scripted walk proves the
 * walk, not the feature.
 */
async function shoot(page: Page, line: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and on a
  // strip of six adjacent buttons it lands squarely on the stage being photographed.
  await page.mouse.move(0, 0);
  await line.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-strip/${name}.png`);
}

/**
 * Narrate a step that just passed, so the pull-request transcript evidences the WALK and not
 * only its verdict.
 *
 * `2 passed` says a spec named some assertions and they held; it does not say the strip
 * rendered six stages, took an SSE update, went amber, and navigated. Those are the claims
 * a reader of the evidence is checking, and each line below is printed only after the
 * assertion above it has already succeeded - so the transcript cannot narrate a step that
 * did not happen. Same `OBSERVED` / `CAPTURED` vocabulary the dispatch-and-converse
 * evidence uses.
 */
function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

test("the Line renders every stage, tracks the fleet live, and its stages reach their targets", async ({
  dashboard,
  daemon,
}) => {
  const line = dashboard.getByRole("navigation", { name: "The Line" });
  await expect(line).toBeVisible();

  // ---- six stages, in pipeline order, each naming what its number counts ----

  const names = await line.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label") ?? ""),
  );
  expect(names).toHaveLength(STAGES.length);
  for (const [i, stage] of STAGES.entries()) {
    expect(names[i]).toMatch(new RegExp(`^${stage}, \\d`));
  }

  // A fresh daemon has nothing, and says so in words rather than leaving a stage blank.
  const backlog = line.getByRole("button", { name: /^Backlog,/ });
  await expect(backlog).toContainText("nothing waiting");
  await expect(line.getByRole("button", { name: /^Working,/ })).toContainText("no sessions open");
  observed(`the strip rendered ${STAGES.length} stages in pipeline order: ${STAGES.join(" -> ")}`);

  // ---- the strip moves with the fleet, over SSE, with no reload ----

  const task = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    intent: "Stop the pane stealing focus when a dialog opens",
    title: "Fix pane focus stealing",
    backlog: true,
  });

  // The count and the sentence both come from the daemon's fold. Asserting the SENTENCE is
  // what makes this a test of the fold arriving rather than of a number incrementing: no
  // client-side code in this build knows how to write "next up:".
  await expect(backlog).toHaveAccessibleName(/^Backlog, 1 task waiting - next up: Fix pane focus stealing$/);
  await expect(backlog).toContainText("next up: Fix pane focus stealing");
  observed("a filed backlog task reached the strip over SSE, no reload: Backlog 0 -> 1, \"next up: Fix pane focus stealing\"");
  await shoot(dashboard, line, "line-live");

  // ---- amber when it needs the operator ----

  // Parking the only backlog item leaves a queue nothing can start: capacity will never
  // clear it, so it is the operator's to unblock. That is the one backlog state the strip
  // is meant to shout about.
  await api(daemon, `/api/tasks/${task.id}/update`, { enabled: false });

  await expect(backlog).toContainText("nothing ready");
  await expect(backlog).toContainText("1 parked");
  // The colour is the point of the stage, and there is no ARIA for "amber" - the class is
  // what the stylesheet paints from, so it is what the assertion has to reach for.
  await expect(backlog).toHaveClass(/tone-attention/);
  // And it is the ONLY amber stage: a strip where everything glows says nothing.
  await expect(line.locator(".line-stage.tone-attention")).toHaveCount(1);
  observed("parking that task turned Backlog amber (tone-attention), and it is the only amber stage");
  await shoot(dashboard, line, "line-attention");

  // ---- a stage click does something real ----

  // Five of the six stages now open a drawer in place; Shipped used to navigate to the
  // completed workflow runs - a target that was wrong in both directions, since a session
  // ships without ever starting a run and a finished run ships nothing. What is checked here
  // is only that a stage press REACHES its target at all. The drawers' own semantics are
  // `line-drawers.spec.ts`' subject.
  await line.getByRole("button", { name: /^Shipped,/ }).click();
  const shipped = dashboard.getByRole("region", { name: "Shipped drawer" });
  await expect(shipped).toBeVisible();
  // And it did NOT leave the fleet. The retired route is the thing this line exists to catch:
  // a stale target would still "do something real" and pass a looser assertion.
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");
  observed("clicking the Shipped stage opened the Shipped drawer in place, without leaving #/fleet");

  // The drawer's own escalation is what leaves the page now, and it lands on the ledger's
  // full cross-repo reader rather than on a run list.
  await shipped.getByRole("button", { name: /^Ship log/ }).click();
  await expect(dashboard).toHaveURL(/#\/shipped$/);
  observed("the drawer's \"Ship log →\" escalation navigated to #/shipped");

  // The strip is the FLEET's chrome, not the app's: it must not follow you off the page.
  await expect(line).toBeHidden();
  observed("the strip is fleet-only: it did not follow the navigation off the fleet page");
});

test("the strip sits outside the topbar, preserving separate height budgets", async ({
  dashboard,
}) => {
  // `--topbar-h` is measured off `<header class="topbar">`. A strip inside that header would
  // mix its budget into the topbar's. The Electron test measures the consequence; this is
  // the structural fact it rests on, checked against the app rather than a fixture.
  await expect(dashboard.locator("header.topbar .line")).toHaveCount(0);
  await expect(dashboard.locator(".line")).toHaveCount(1);
  observed("the strip renders once, outside <header class=\"topbar\">, so the topbar and fleet body keep separate height budgets");
});
