import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The `＋ workflow` chip comes back once a session's run has finished.
 *
 * The bug was a dead end, and only a browser can see it. Both gates asked `!workflowRun` - "has
 * this session EVER had a run" - so a session whose review completed hid the chip for the rest of
 * its life, and there was no way left to bind a workflow to it from the card or the console detail
 * header. Every other held affordance in the product already released on a terminal run (the board
 * column's split, the card's held tag, the backlog drop target), so this one gate was the outlier
 * and the disagreement was invisible to every layer below this one: the run summary reaching the
 * browser is correct, the outcome chip drawn from it is correct, and it is only the rendered header
 * - outcome chip present, next move absent - where the surface is a dead end.
 *
 * So both halves are asserted, on both surfaces. An OPEN run must still withhold the chip, or the
 * fix would have traded one wrong reading for another; a COMPLETED run must offer it again beside
 * the `Approved` chip, because the outcome is history and the chip is the next move.
 *
 * The run is real: dispatched agent, published workflow, bound, submitted, and polled until the
 * daemon settles it. Nothing is stubbed into the browser.
 *
 * Deliberately NOT reached by the `session_disappeared` route that produces a `blocked` run: that
 * one gets there by killing the bound session, so the session leaves the fleet and there is no
 * card or detail header left to inspect. A seeded terminal run keeps its session.
 *
 * No model tokens: the reviewer is answered by `e2e/fixtures/fake-agents.ts`, which returns a
 * schema-valid verdict for any Persona whose published guidance carries the marker below.
 */

const EVIDENCE = artifactsDir("workflow-bind-chip-returns");

/**
 * The chip's accessible name. The glyph is U+FF0B FULLWIDTH PLUS SIGN, not an ASCII `+` - it is
 * what `SessionCard` and `ConsoleDetail` both render, so it is what a person's screen reader and
 * this selector both read.
 */
const BIND_CHIP = "＋ workflow";

/** The published workflow each test seeds, named per test so the bind dialog can pick it out. */
const workflowName = (label: string): string => `E2E bind chip ${label}`;

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-bind-chip-returns/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Dispatch one agent and wait for it to settle.
 *
 * `__none` on the workflow selector matters: the dispatch modal can arm a workflow itself, and a
 * run started that way would bind before the test had said anything about the chip. Each test here
 * binds its own run, explicitly, after the session is already idle.
 */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
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
  }, {
    message: "the dispatched session should settle before a workflow is bound to it",
    timeout: 60_000,
  }).toBe("idle");
  return sessionId;
}

/**
 * Publish a one-reviewer workflow over this session and submit it, then wait for `settle`.
 *
 * The verdict is chosen by the marker in the persona's guidance, which is how one recipe seeds
 * both states this spec needs: a passing reviewer runs the graph to its `Approved` end and the run
 * reaches `completed`, a failing one returns the work to the session and parks the run in
 * `waiting_for_session` - open, and stable enough to assert against.
 */
async function seedRun(
  daemon: DaemonHandle,
  sessionId: string,
  label: string,
  verdict: "E2E_PASS_VERDICT" | "E2E_FAIL_VERDICT",
  settle: "completed" | "waiting_for_session",
): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `E2E ${label} reviewer`,
    guidanceMarkdown: `# E2E ${label} reviewer\n\n${verdict}`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: workflowName(label),
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
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
    { requestId: `e2e-bind-chip-${label}` },
  );
  await expect.poll(
    async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`))
        .run.status,
    { message: `the seeded run should settle at ${settle}`, timeout: 60_000 },
  ).toBe(settle);
  return submitted.run.id;
}

/**
 * Put the dashboard in the Console layout and open the one session's detail.
 *
 * Written to the daemon rather than `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache. The reload is what makes it take.
 */
async function openConsoleDetail(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Console layout").toBe("console");
  await page.reload();

  const rail = page.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  await rail.getByRole("button").first().click();
  await expect(page.locator("header.detail-head")).toBeVisible();
}

test("an OPEN run withholds the bind chip from the card and the console detail", async ({
  dashboard,
  daemon,
}) => {
  // The half that would rot silently. `sessionCanBindWorkflow` is the only thing between "this
  // run owns the session" and "bind another one", and a spec that only asserted the chip coming
  // back would pass against a gate that had stopped withholding it at all - which would offer a
  // second binding the daemon refuses as a conflict.
  const session = await dispatchIdleAgent(dashboard, daemon, "get held by a run for the bind chip");

  // Before any run exists, the chip is on offer - the state it has always been offered in, and
  // the baseline that makes its absence below mean something.
  const card = dashboard.getByRole("article");
  await expect(card.getByRole("button", { name: BIND_CHIP })).toBeVisible();

  await seedRun(daemon, session, "open", "E2E_FAIL_VERDICT", "waiting_for_session");

  // The chip goes, over SSE, with no reload: the run summary landing is what withdraws the offer.
  await expect(card.getByRole("button", { name: "Review changes" })).toBeVisible();
  await expect(card.getByRole("button", { name: BIND_CHIP })).toHaveCount(0);

  // And the console detail header reads the same, because it reads the same predicate.
  await openConsoleDetail(dashboard, daemon);
  const head = dashboard.locator("header.detail-head");
  await expect(head.getByRole("button", { name: "Review changes" })).toBeVisible();
  await expect(head.getByRole("button", { name: BIND_CHIP })).toHaveCount(0);
});

test("a COMPLETED run gives the bind chip back, beside its outcome, on both surfaces", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatchIdleAgent(dashboard, daemon, "finish a review for the bind chip");
  await seedRun(daemon, session, "done", "E2E_PASS_VERDICT", "completed");

  // The pairing is the whole point, and it is why this fix is at the gate rather than in the
  // newest-run-per-session map: `Approved` is drawn from that map's terminal run, so narrowing it
  // would have deleted the history to restore the affordance. Both are here.
  const card = dashboard.getByRole("article");
  await expect(card.getByRole("button", { name: "Approved" })).toBeVisible();
  await expect(card.getByRole("button", { name: BIND_CHIP })).toBeVisible();
  await shoot(dashboard, "card-approved-and-bind-chip");

  // The restored chip must not COST anything. This head now carries an outcome chip, a bind chip
  // and the state badge at once - the crowding `.card-head`'s wrap rule and `.card-title`'s 9ch
  // floor were written for, since a held card already carried three trailing marks. So the name
  // keeps a readable stem rather than being deleted, and the trailing caret stays inside the
  // card rather than being clipped. Geometry, because no assertion on markup can say
  // "still visible".
  const title = card.locator(".card-title h2");
  expect((await title.boundingBox())!.width).toBeGreaterThan(40);
  const caret = card.getByRole("button", { name: "Expand conversation" });
  const caretBox = (await caret.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(caretBox.x + caretBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);

  // Reachable, not merely present: the chip opens the bind dialog, pinned to this session, so
  // the offer leads somewhere rather than being a decorative dead end of its own.
  await card.getByRole("button", { name: BIND_CHIP }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await expect(dialog).toBeVisible();
  const picker = dialog.getByRole("combobox", { name: "Session", exact: true });
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveValue(session);

  // And it leads somewhere the daemon will accept. Completion does NOT retire the binding, so a
  // second binding while the first is `active` is still refused as a conflict - which is exactly
  // why the restored chip has to land on a dialog that offers the bound version back rather than
  // an error. Choosing that version turns the primary into a resubmit.
  await dialog.getByRole("combobox", { name: "Published workflow" })
    .selectOption({ label: `${workflowName("done")} · v1` });
  await expect(dialog.getByRole("button", { name: "Submit bound version" })).toBeEnabled();
  await shoot(dashboard, "bind-dialog-from-finished-run");
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The console detail header is the second gate, and a person comparing the two layouts side by
  // side must not find the offer in one and a dead end in the other.
  await openConsoleDetail(dashboard, daemon);
  const head = dashboard.locator("header.detail-head");
  await expect(head.getByRole("button", { name: "Approved" })).toBeVisible();
  await expect(head.getByRole("button", { name: BIND_CHIP })).toBeVisible();
  // Captured before the click, because the modal covers the header it is evidence of.
  await shoot(dashboard, "console-detail-approved-and-bind-chip");
  await head.getByRole("button", { name: BIND_CHIP }).click();
  await expect(dashboard.getByRole("dialog", { name: "Bind workflow" })).toBeVisible();
  await shoot(dashboard, "console-detail-bind-dialog");
});
