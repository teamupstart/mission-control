import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The completion guardrail on a Recurring Mission: whether Foreman's own settled verdict may
 * conclude the task a run files.
 *
 * The failure it exists for is silent. A mission whose run has nothing to ship - the sweep
 * found nothing, the report was written, the audit came back clean - opens no pull request,
 * and a merge is what every other route to `done` reads. That task stays `running`, the
 * default `skip-active` overlap policy refuses every later occurrence against it, and the
 * cadence stops for good while the catalog still says the mission is healthy.
 *
 * What only a browser can say here:
 *
 *   - The control EXISTS, in the guardrails group beside the two policies it belongs with.
 *     A stored field with no picker is a setting nobody can reach.
 *   - A NEW mission rests on automatic completion, which is the whole point of the change -
 *     while a mission SAVED without the field keeps reading `manual`, because the wire
 *     default speaks for callers written before it existed.
 *   - The choice survives the round trip through the daemon and comes back onto the
 *     mission's own Configuration disclosure, which is the half an optimistic DOM cannot
 *     prove - so this asserts against `GET /api/schedules` after the save as well.
 *
 * NO AGENT IS DISPATCHED. A mission files backlog rows on a cadence and never launches one,
 * and nothing here fires an occurrence. No binary runs, faked or otherwise, and no model
 * tokens are spent. Every control is reached by role and accessible name.
 */

const EVIDENCE = artifactsDir("mission-completion-policy");

/** A viewport frame, scrolled so `scrollTo` is actually in it. */
async function shoot(page: Page, name: string, scrollTo?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // `Tooltip` portals a bubble over whatever is being photographed once anything is hovered.
  await page.mouse.move(0, 0);
  if (scrollTo) await scrollTo.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/mission-completion-policy/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  init?: { method: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} answered ${response.status} with non-JSON: ${text.slice(0, 160)}`);
  }
}

interface StoredSchedule {
  id: string;
  name: string;
  completionPolicy: string | null;
}

/** A mission saved WITHOUT the field, which is what an older caller sends. */
async function seedMission(daemon: DaemonHandle, name: string): Promise<StoredSchedule> {
  return api<StoredSchedule>(daemon, "/api/schedules", {
    method: "POST",
    body: {
      name,
      expression: "0 3 * * *",
      timezone: "UTC",
      overlapPolicy: "skip-active",
      missedPolicy: "coalesce-latest",
      template: {
        title: `${name} task`,
        intent: `Whatever ${name} is for.`,
        repoRoot: daemon.repo,
        kind: "ship",
      },
    },
  });
}

function storedPolicy(daemon: DaemonHandle, id: string): Promise<string | null | undefined> {
  return api<StoredSchedule[]>(daemon, "/api/schedules").then(
    (all) => all.find((s) => s.id === id)?.completionPolicy,
  );
}

const COMPLETION = "When Foreman concludes a run's work is done";

test("a mission's completion guardrail is chosen in the editor and shown on its detail", async ({
  dashboard,
  daemon,
}) => {
  const mission = await seedMission(daemon, "Nightly sweep");
  // The wire contract first: a request that never mentioned the field saves the behaviour it
  // was written for, rather than being opted into a policy its author never chose.
  expect(await storedPolicy(daemon, mission.id)).toBe("manual");

  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Nightly sweep", exact: false }).first().click();

  // The stored configuration is where an operator goes to ask why a mission stopped running,
  // so the setting that explains it has to be readable there.
  await dashboard.getByText(/^Configuration/).first().click();
  await expect(dashboard.getByText(/Foreman never concludes it/)).toBeVisible();
  await shoot(dashboard, "01-detail-manual", dashboard.getByText(/Foreman never concludes it/));

  await dashboard.getByRole("button", { name: "Edit" }).first().click();
  const completion = dashboard.getByRole("combobox", { name: COMPLETION });
  await expect(completion).toBeVisible();
  // Resting state on an EXISTING mission: what the daemon stored, never the new-mission
  // default. An edit must not silently change a policy the operator did not touch.
  await expect(completion).toHaveValue("manual");
  await shoot(dashboard, "02-editor-manual", completion);

  await completion.selectOption("auto-on-conclusion");
  await dashboard.getByRole("button", { name: "Save & enable" }).click();

  await expect
    .poll(async () => storedPolicy(daemon, mission.id), {
      message: "choosing automatic completion should reach the daemon",
    })
    .toBe("auto-on-conclusion");

  // And back out of the daemon onto the surface that reads it, which is the half a DOM
  // assertion on the select cannot prove.
  await dashboard.getByText(/^Configuration/).first().click();
  await expect(dashboard.getByText(/Foreman may complete the task/)).toBeVisible();
  await shoot(dashboard, "03-detail-auto", dashboard.getByText(/Foreman may complete the task/));
});

test("a new mission rests on automatic completion, and can still be turned off", async ({
  dashboard,
}) => {
  // Deliberately different from the wire default. A recurring mission written today is one
  // whose cadence is the whole point, and one un-concluded run would stop it for good; a
  // caller that never mentioned the field is somebody else's older code.
  await dashboard.getByRole("button", { name: "Recurring missions" }).click();
  await dashboard.getByRole("button", { name: "Create mission" }).click();

  const completion = dashboard.getByRole("combobox", { name: COMPLETION });
  await expect(completion).toBeVisible();
  await expect(completion).toHaveValue("auto-on-conclusion");
  // The hint says why the setting exists at all, because "complete the task automatically"
  // alone does not explain why a mission would ever need it.
  await expect(dashboard.getByText(/never completes on its own/)).toBeVisible();
  await shoot(dashboard, "04-new-mission-default", completion);

  // Still a choice, not a policy imposed: a mission whose runs are meant to be reviewed by
  // hand can say so.
  await completion.selectOption("manual");
  await expect(completion).toHaveValue("manual");
});
