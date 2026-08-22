import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Test Evidence Auditor's telemetry, read by a person.
 *
 * `test_evidence_audit` events were appended for every auditor attempt and read by nothing:
 * the scout report's own rollout criterion - first-pass acceptance, attempts per run - was
 * unevaluable on a running install without opening SQLite by hand. Only this layer can settle
 * that it is no longer true. The unit tests pin the arithmetic over synthetic events and the
 * render test pins the markup for a given aggregate; neither can tell whether a real verdict,
 * written by the real engine into the real database, comes back out through the real route and
 * reaches the panel. That whole chain is what a person checking their fleet depends on, and
 * every link in it is invisible to the other three layers.
 *
 * Both readings are covered because they must never look alike: a daemon that has recorded
 * nothing says so, and a daemon that has recorded a rejection shows the rate. Drawing the first
 * as "0%" would tell an operator their fleet is failing every submission when it has run none.
 *
 * No model tokens: the run's reviewer is the shipped built-in auditor - the only Persona whose
 * attempts produce this telemetry - and the fake `claude` binary recognises its published
 * guidance and answers with a fixed, schema-valid refusal asking for rendered pixels.
 */

const EVIDENCE = artifactsDir("workflow-test-evidence-readiness");

/** Photograph a state this spec has already asserted on, behind the suite's evidence flag. */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-test-evidence-readiness/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the test evidence readiness spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }).toBe("idle");
  return sessionId;
}

/**
 * One run whose single reviewer IS the built-in Test Evidence Auditor, refused.
 *
 * The shipped Persona itself, not a copy of it: the engine appends the telemetry only for the
 * built-in auditor, recognised by its source id or its exact name, and that name is reserved -
 * a created Persona cannot take it. So there is no way to seed this from a fixture Persona,
 * and the fake `claude` binary answers this one by its published guidance instead of by a
 * planted marker.
 */
async function seedRejectedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const persona = { id: "builtin:test-evidence-auditor" };
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E readiness telemetry",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "auditor", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        {
          id: "submit",
          source: "session",
          sourcePort: "submitted",
          target: "auditor",
          targetPort: "activate",
        },
        {
          id: "auditor-pass",
          source: "auditor",
          sourcePort: "pass",
          target: "end",
          targetPort: "terminal",
        },
        {
          id: "auditor-fail",
          source: "auditor",
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-test-evidence-readiness" },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "the refused round should return to the session", timeout: 40_000 })
      .toBe("waiting_for_session");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return submitted.run.id;
}

/**
 * The card, found by its heading rather than by any text it contains.
 *
 * `hasText` matched two cards here: the seeded workflow's NAME appears in the dispatch-default
 * card's options, so a substring match over the panel is not a stable way to name this one.
 */
const readinessCard = (page: Page): Locator =>
  page.locator("section.sc-card").filter({
    has: page.getByRole("heading", { name: "Test evidence readiness", exact: true }),
  });

test("an install with no auditor attempt says so instead of reading as zero per cent", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  const card = readinessCard(dashboard);
  await expect(card.getByRole("heading", { name: "Test evidence readiness" })).toBeVisible();
  await expect(
    card.getByText("No Test Evidence Auditor attempt has been recorded yet"),
  ).toBeVisible();
  // The distinction the whole card rests on: nothing recorded must not render as a rate.
  await expect(card.getByText("First-pass acceptance")).toHaveCount(0);
  await shoot(card, "no-attempts");
});

test("a refused first submission reaches the readiness panel as a rate an operator can act on", async ({
  dashboard,
  daemon,
}) => {
  await seedRejectedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  const card = readinessCard(dashboard);

  // The headline the scout report's rollout criterion is written in, with its target beside
  // it - one first submission, refused, so acceptance is zero over a population of one.
  await expect(
    card.getByText("First-pass acceptance 0% (0 of 1 first submissions) · target at least 70%"),
  ).toBeVisible();

  const attempts = card.getByRole("group", { name: "Attempts" });
  await expect(attempts.getByText("100% (1 of 1 attempts)").first()).toBeVisible();
  await expect(attempts.getByText("1.00 across 1 run · target at most 1.5")).toBeVisible();

  // The rejection breakdown, over failing attempts. The scripted refusal asks for rendered
  // pixels, so the report's most common reason carries the whole failure and the others stay
  // at zero - a row per reason either way, so "none seen" cannot be mistaken for "not known".
  const reasons = card.getByRole("group", { name: "Why attempts were refused" });
  await expect(
    reasons.locator("p").filter({ hasText: "No reviewer-visible UI artifact" }),
  ).toContainText("100% (1 of 1 failing attempts)");
  await expect(reasons.locator("p").filter({ hasText: "Other" }))
    .toContainText("0% (0 of 1 failing attempts)");

  // Evidence readiness adoption - the zero-image, zero-artifact first packet the report
  // measured, now visible on a running install.
  const readiness = card.getByRole("group", { name: "Evidence readiness on first submissions" });
  await expect(readiness.getByText("First submissions with no image")).toBeVisible();
  await expect(readiness.getByText("First submissions with no text artifact")).toBeVisible();
  await expect(readiness.getByText("100% (1 of 1 first submissions)").first()).toBeVisible();

  await shoot(card, "measured");
  // The card in situ, after the readings above have been asserted. The isolated shot proves
  // what the panel says; this one proves an operator can find it - it sits in the Workflows
  // settings column with the rest of the subsystem's cards, which is the claim "an operator
  // can check this without an agent" actually rests on.
  await card.scrollIntoViewIfNeeded();
  await shoot(dashboard, "settings-in-place");
});
