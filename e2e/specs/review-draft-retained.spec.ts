import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * A half-written review answer outlives the modal it was typed into.
 *
 * Every pick and keystroke on a review card used to be state in the card, so anything that
 * unmounted it - Escape, a click outside, the session's review list blinking empty on a
 * reconnect, the dashboard reloading - threw the answer away. Dispatch never did that: close
 * it and reopen it and the form is as you left it. These specs hold the review modal to the
 * same bargain, through a real review raised on `POST /mcp/reviews`, real typing, and a real
 * close and a real page reload, then confirm the restored answer is the one the agent gets.
 */

const TASK = "tune the transcript cache";

const PLAN = {
  kind: "plan-decisions",
  title: "Transcript cache plan",
  body: "## Plan\n\nCache parsed transcripts so the conversation view stops re-reading JSONL.",
  decisions: [
    {
      id: "store",
      question: "Where should the cache live?",
      options: [
        { id: "memory", label: "In memory per session", recommended: true },
        { id: "disk", label: "On disk beside the transcript" },
      ],
      allowOther: true,
    },
  ],
};

const OPEN_QUESTION = "What retry budget should the reader use?";

async function evidence(target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = join(process.cwd(), "e2e", ".artifacts", "review-draft-retained");
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: join(dir, `${name}.png`) });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

async function ask(daemon: DaemonHandle, body: Record<string, unknown>): Promise<string> {
  let cwd: string | null = null;
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
        }>;
        cwd = sessions[0]?.cwd ?? null;
        return cwd;
      },
      { message: "the dispatched session is on the fleet, with a checkout to bind a review to" },
    )
    .toBeTruthy();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, `the review channel accepted the request: ${await res.clone().text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function agentResult(
  daemon: DaemonHandle,
  id: string,
): Promise<{ status: string; response: string | null; selections: Array<Record<string, unknown>> | null }> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
    headers: { "x-harness-token": token(daemon) },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    response: string | null;
    selections: Array<Record<string, unknown>> | null;
  };
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  return modal;
}

test("a review answer survives closing the modal and reloading the page", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const planId = await ask(daemon, PLAN);
  const inputId = await ask(daemon, { kind: "input", title: OPEN_QUESTION, body: OPEN_QUESTION });

  let modal = await openReview(dashboard);
  await expectContentClearsBorder(modal);
  await modal.getByRole("radio", { name: /On disk beside the transcript/ }).check();
  await modal.getByPlaceholder("Other…").fill("or a sidecar sqlite file");
  await modal
    .getByRole("textbox", { name: "Note to the agent: Where should the cache live?" })
    .fill("cap it at 200 turns");
  await modal.getByPlaceholder("Your answer…").fill("three retries, then give up");

  // Closed without resolving anything: the review is still pending, and so is the answer.
  await modal.getByRole("button", { name: "Close (esc)" }).click();
  await expect(modal).toBeHidden();

  modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /On disk beside the transcript/ })).toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue("or a sidecar sqlite file");
  await expect(
    modal.getByRole("textbox", { name: "Note to the agent: Where should the cache live?" }),
  ).toHaveValue("cap it at 200 turns");
  await expect(modal.getByPlaceholder("Your answer…")).toHaveValue("three retries, then give up");

  // Escape closes it too, and a reload is the harshest unmount there is.
  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await dashboard.reload();

  modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: /On disk beside the transcript/ })).toBeChecked();
  await expect(modal.getByPlaceholder("Other…")).toHaveValue("or a sidecar sqlite file");
  await expect(
    modal.getByRole("textbox", { name: "Note to the agent: Where should the cache live?" }),
  ).toHaveValue("cap it at 200 turns");
  await expect(modal.getByPlaceholder("Your answer…")).toHaveValue("three retries, then give up");
  await evidence(modal, "restored-after-reload");

  // The restored answer is the one that is sent, not a picture of it.
  await modal.getByRole("button", { name: "Send answer" }).click();
  await expect(modal.getByText(OPEN_QUESTION)).toHaveCount(0);
  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();

  const input = await agentResult(daemon, inputId);
  expect(input.status).toBe("answered");
  expect(input.response).toBe("three retries, then give up");
  const plan = await agentResult(daemon, planId);
  expect(plan.status).toBe("answered");
  expect(plan.selections).toEqual([
    { decisionId: "store", selected: ["disk"], other: "or a sidecar sqlite file", note: "cap it at 200 turns" },
  ]);

  // Delivered drafts are forgotten: nothing is left parked for the next page load.
  const stored = await dashboard.evaluate(() => sessionStorage.getItem("mission.reviewDrafts"));
  expect(stored).toBeNull();
});

test("an approval note survives a close and reopen", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, {
    kind: "plan",
    title: "Rollout plan",
    body: "## Rollout\n\nShip behind a flag.",
  });

  let modal = await openReview(dashboard);
  await modal.getByPlaceholder("Optional note to the agent…").fill("flag name should be cacheV2");
  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  modal = await openReview(dashboard);
  await expect(modal.getByPlaceholder("Optional note to the agent…")).toHaveValue(
    "flag name should be cacheV2",
  );
});

test("a submit the daemon refuses keeps the answer for the next open", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, { kind: "input", title: OPEN_QUESTION, body: OPEN_QUESTION });

  // The resolve fails the way a daemon mid-restart or a refused route does.
  await dashboard.route("**/api/reviews/*/resolve", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "daemon unavailable" }) }),
  );
  let modal = await openReview(dashboard);
  await modal.getByPlaceholder("Your answer…").fill("three retries, then give up");
  await modal.getByRole("button", { name: "Send answer" }).click();
  await expect(modal.getByText("daemon unavailable")).toBeVisible();

  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  modal = await openReview(dashboard);
  await expect(modal.getByPlaceholder("Your answer…")).toHaveValue("three retries, then give up");

  // Once the route answers again, the kept text is what goes out.
  await dashboard.unroute("**/api/reviews/*/resolve");
  await modal.getByRole("button", { name: "Send answer" }).click();
  await expect(modal).toBeHidden();
  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe("three retries, then give up");
});

test("a review answered elsewhere does not bring back its old draft", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const first = await ask(daemon, { kind: "input", title: OPEN_QUESTION, body: OPEN_QUESTION });

  let modal = await openReview(dashboard);
  await modal.getByPlaceholder("Your answer…").fill("a stale half-answer");
  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  const parked = () => dashboard.evaluate(() => sessionStorage.getItem("mission.reviewDrafts"));
  await expect.poll(parked).toContain(first);

  // Answered by someone else - another tab, Foreman - straight through the daemon, so the
  // only thing that can reach this tab is the `review_upsert` the stream delivers.
  const res = await fetch(`${daemon.baseURL}/api/reviews/${first}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "answer", response: "answered elsewhere" }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  await expect(dashboard.locator(".console-detail").getByRole("button", { name: /to review/ })).toHaveCount(0);
  await expect.poll(parked).toBeNull();

  // The agent asks again: the new card starts blank rather than inheriting stale text, and a
  // reload finds nothing parked to restore either.
  await ask(daemon, { kind: "input", title: OPEN_QUESTION, body: OPEN_QUESTION });
  await dashboard.reload();
  modal = await openReview(dashboard);
  await expect(modal.getByPlaceholder("Your answer…")).toHaveValue("");
});

test("the standing approval checkbox survives a close and a reload", async ({ dashboard, daemon }) => {
  const config = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planStorage: "local", enabled: true, skills: { "html-plans": true } }),
  });
  expect(config.ok).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Plan a documentation update");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await dialog.getByRole("combobox", { name: "After work", exact: true }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session!: { id: string; cwd: string; agentSessionId: string | null; state: string };
  await expect
    .poll(async () => {
      const snapshot = await (await fetch(`${daemon.baseURL}/api/sessions`)).json();
      session = snapshot.sessions?.[0] ?? snapshot[0];
      return Boolean(session?.agentSessionId && session.state === "idle");
    })
    .toBe(true);
  const post = (route: string, body: object) =>
    fetch(`${daemon.baseURL}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
      body: JSON.stringify({ env: {}, sessionId: session.id, cwd: session.cwd, ...body }),
    });
  const saved = await post("/mcp/plans/save", {
    repoSlot: "repo-01",
    slug: "documentation",
    requestId: randomUUID(),
    expectedRevision: 0,
    files: [
      { name: "plan.md", content: "# Documentation plan" },
      { name: "plan.html", content: "<h1>Documentation plan</h1>" },
    ],
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const plan = (await saved.json()) as { manifest: { planId: string } };
  const asked = await post("/mcp/v2/reviews", {
    kind: "plan-decisions",
    title: "Approve documentation plan revision 1",
    body: "Review the complete bundle.",
    managedPlan: { repoSlot: "repo-01", planId: plan.manifest.planId, revision: 1 },
  });
  expect(asked.status, await asked.clone().text()).toBe(200);

  const standingName = "Approve all future bundles for this task";
  let modal = await openReview(dashboard);
  await modal.getByRole("radio", { name: "Approve final bundle", exact: true }).check();
  await modal.getByRole("checkbox", { name: standingName }).check();
  await dashboard.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  modal = await openReview(dashboard);
  await expect(modal.getByRole("radio", { name: "Approve final bundle", exact: true })).toBeChecked();
  await expect(modal.getByRole("checkbox", { name: standingName })).toBeChecked();
  await dashboard.keyboard.press("Escape");
  await dashboard.reload();

  modal = await openReview(dashboard);
  await expect(modal.getByRole("checkbox", { name: standingName })).toBeChecked();
  await evidence(modal, "standing-approval-restored-after-reload");

  // The restored tick is what the resolve carries.
  const resolved = dashboard.waitForResponse((r) => /\/api\/reviews\/[^/]+\/resolve$/.test(r.url()));
  await modal.getByRole("button", { name: "Submit", exact: true }).click();
  const response = await resolved;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().approveFutureBundles).toBe(true);
  await expect(modal).toBeHidden();
});
