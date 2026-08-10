import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A finished review was a dead end, and this is the click that ends it.
 *
 * A `completed`, `cancelled` or `failed` run used to render six controls and not one of them ran
 * anything: both submissions are refused on a terminal run, `Cancel run` is not rendered because
 * there is nothing left to stop, and the rest copy, download or navigate. So a review that had
 * finished could not be run again from the run page - or, until the bind chip's own fix, from the
 * session surfaces either.
 *
 * The header's primary on a terminal run is now `Run this review again`, and it needs no new
 * route: the binding stays `active` after completion, and the daemon's active-run check excludes
 * exactly the three terminal statuses, so the existing binding submit accepts it.
 *
 * Only this layer settles it. The unit table decides the descriptor from a detail handed to it,
 * and `renderToStaticMarkup` can assert the button exists - neither can prove that clicking it
 * creates a second durable run against the same binding, nor that the reader is taken to it. The
 * navigation is the half most likely to rot: this is the one move on the page whose success lands
 * on a DIFFERENT run, so staying put would leave an operator watching the finished run they just
 * asked to repeat.
 *
 * No model tokens: the seeded Persona's guidance carries `E2E_PASS_VERDICT`, which the fake
 * `claude` binary answers with a fixed schema-valid verdict.
 */

const NODE = { persona: "run-again-persona" };

const EVIDENCE = artifactsDir("workflow-run-again");

/**
 * Photograph a state this spec has already asserted on.
 *
 * The reported defect is what a person SEES on a finished run - a header of controls, none of
 * which run anything - and a green Playwright run leaves nothing behind to look at. Behind
 * `MC_E2E_EVIDENCE` like every other capture in the suite, because an ordinary
 * `npm run test:e2e` would rewrite the binaries for no added signal.
 */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-run-again/${name}.png`);
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

interface RunProbe {
  binding: { id: string; state: string };
  run: { id: string; status: string };
}

const probe = (daemon: DaemonHandle, runId: string): Promise<RunProbe> =>
  api<RunProbe>(daemon, `/api/workflow-runs/${runId}`);

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below, so close it before filling the
  // next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the run-again spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // Idle rather than merely alive: evidence capture aborts with `conversation_changed` if the
  // transcript moves under it, and the dispatch's seeded first turn is still being answered.
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
 * One single-reviewer run, taken to `completed` through the routes the dashboard itself uses.
 *
 * `deliveryMode: "preview"` is the seed, so the label asserted below is the preview branch of it.
 * A bound preview must never invite an operator to a live submission, and that branch is only
 * observable if the seed picks one and the assertion matches it.
 */
async function seedCompletedRun(
  page: Page,
  daemon: DaemonHandle,
): Promise<{ runId: string; bindingId: string }> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Approving reviewer",
    guidanceMarkdown: "# Approving reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E run again",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        {
          id: NODE.persona,
          kind: "persona",
          personaId: persona.id,
          position: { x: 220, y: 0 },
        },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        {
          id: "submit",
          source: "session",
          sourcePort: "submitted",
          target: NODE.persona,
          targetPort: "activate",
        },
        {
          id: "persona-pass",
          source: NODE.persona,
          sourcePort: "pass",
          target: "end",
          targetPort: "terminal",
        },
        {
          id: "persona-fail",
          source: NODE.persona,
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
    { requestId: "e2e-run-again-first" },
  );
  // On a miss the daemon's own log tail is attached: the seeding failure that matters here is
  // server-side (capture, compaction, the engine) and invisible to a browser trace.
  try {
    await expect.poll(async () => (await probe(daemon, submitted.run.id)).run.status, {
      message: "the seeded round should approve and finish",
      timeout: 40_000,
    }).toBe("completed");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return { runId: submitted.run.id, bindingId: binding.id };
}

/** The run the address bar is on, which is where the new run has to appear. */
const runIdInUrl = (page: Page): string => {
  const hash = new URL(page.url()).hash;
  const match = /^#\/runs\/([^?]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]!) : "";
};

test("a finished run offers to run the review again, and lands the reader on the new run", async ({
  dashboard,
  daemon,
}) => {
  // Two full review rounds against a real daemon, each with its own evidence capture.
  test.setTimeout(360_000);
  const { runId, bindingId } = await seedCompletedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const header = dashboard.locator("header.wf-run-head");
  const primary = header.locator("button.btn-primary");

  // One primary, and it is the only control here that changes anything: `Cancel run` is correctly
  // absent on a finished run, which is precisely what used to leave this header inert.
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Preview this review again");
  await expect(header.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Preview fresh evidence" })).toHaveCount(0);
  // A run with a move needs no paragraph explaining itself.
  await expect(header.locator("p.wf-run-why")).toHaveCount(0);
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the header
  // being photographed is what the pointer was last over.
  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-finished-header");

  /*
   * It confirms first, because it captures fresh evidence and spends model tokens - and it does
   * NOT demand a typed phrase. The phrase gate exists for the two actions that abandon work
   * (`Restart full workflow`, `Discard and send new round`); this one only adds, so a phrase here
   * would be ceremony charged to the person the page is for.
   */
  await primary.click();
  const confirm = dashboard.getByRole("dialog", { name: "Preview this review again" });
  await expect(confirm).toContainText("spends model tokens");
  await expect(confirm).toContainText("this finished run stays in history");
  await expect(confirm.getByRole("textbox")).toHaveCount(0);
  const go = confirm.getByRole("button", { name: "Preview again" });
  await expect(go).toBeEnabled();
  // The whole viewport rather than the dialog element: the confirm autofocuses, and a focused
  // control's tooltip is a body-level portal that reaches outside the dialog's own box - framing
  // the dialog alone would crop that bubble mid-sentence and invent an artifact.
  await dashboard.mouse.move(0, 0);
  await shoot(dashboard, "02-confirm");
  await go.click();

  // The reader is taken to the run that was just created, rather than left on the finished one.
  await expect.poll(() => runIdInUrl(dashboard), {
    message: "confirming should route to the newly created run",
    timeout: 40_000,
  }).not.toBe(runId);
  const newRunId = runIdInUrl(dashboard);
  expect(newRunId).not.toBe("");

  /*
   * A second durable run of the SAME binding: same workflow, same session, new run.
   *
   * Asserted as the binding's whole set of runs rather than as "the new run is still in flight".
   * The fake reviewer answers in milliseconds, so a `not.toContain("completed")` here would be
   * racing it to the finish line - the claim that matters is that the review was REPEATED, not
   * that this probe caught it mid-flight.
   */
  const started = await probe(daemon, newRunId);
  expect(started.run.id).toBe(newRunId);
  expect(started.binding.id).toBe(bindingId);
  expect(started.binding.state).toBe("active");
  const listed = await api<{ items: Array<{ id: string; bindingId: string }> }>(
    daemon,
    "/api/workflow-runs?limit=50",
  );
  expect(
    listed.items.filter((run) => run.bindingId === bindingId).map((run) => run.id).sort(),
  ).toEqual([runId, newRunId].sort());

  // And the page followed it, not merely the address bar. The audit disclosure carries the run id
  // the reader is actually looking at, so opening it names the new run and not the old one.
  const audit = dashboard.locator("details").filter({ hasText: "Audit and bug reports" });
  await audit.getByText("Audit and bug reports").click();
  await expect(audit.getByText(newRunId)).toBeVisible();
  await expect(audit.getByText(runId)).toHaveCount(0);

  // The new run really reviews the work: it captures its own evidence, runs the Persona and
  // approves. Then it offers the same move, so a finished review is repeatable rather than a
  // one-shot escape from one dead end into another.
  await expect.poll(async () => (await probe(daemon, newRunId)).run.status, {
    message: "the new run should capture fresh evidence and finish its own review",
    timeout: 120_000,
  }).toBe("completed");
  await expect(primary).toHaveText("Preview this review again", { timeout: 40_000 });
  await expect(primary).toHaveCount(1);
});

/**
 * The one refusal the client cannot rule out, and what a reader sees when it fires.
 *
 * Run detail carries no sibling runs, so a page reading an OLDER terminal run of a binding that
 * has since started another cannot know the daemon will answer `run_active`. That is the single
 * path to a refused click here, and it needs two runs of one binding plus a step back to reach -
 * so it is faked at the transport rather than raced into existence.
 *
 * What it pins is the retention contract the shared action store depends on: the `send` callback
 * must let the rejection through. Swallowing it would leave the store believing the POST
 * succeeded - the pending state cleared, the request id dropped, and nothing on screen saying the
 * daemon said no, which is the exact failure the store's `keepError` path exists to prevent.
 */
test("a refused rerun says what the daemon said, and the primary stays clickable", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  const { runId } = await seedCompletedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const header = dashboard.locator("header.wf-run-head");
  const primary = header.locator("button.btn-primary");
  await expect(primary).toHaveText("Preview this review again");

  // Only the browser's own submit is intercepted; the seeding above went over Node's fetch.
  await dashboard.route("**/api/workflow-bindings/*/submit", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "This binding already has an active run" }),
  }));

  await primary.click();
  await dashboard.getByRole("dialog", { name: "Preview this review again" })
    .getByRole("button", { name: "Preview again" }).click();

  // The daemon's own sentence, on the page's error line rather than swallowed.
  await expect(dashboard.getByRole("alert"))
    .toContainText("This binding already has an active run");
  // Still on the finished run, and the control is live again rather than stuck pending.
  expect(runIdInUrl(dashboard)).toBe(runId);
  await expect(primary).toBeEnabled();
});
