import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

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
 * What the chip SAYS moved after this was written. It now names the workflow a session is armed
 * with, and falls back to `＋ workflow` both when nothing is bound and when the binding that
 * exists is no longer `active` - orphaned or paused, which will not run at completion and so
 * must not be named as though they will. The completed-run test below reads `armedChip` rather
 * than the offer because completion retires neither the binding nor its `active` state. The
 * claim under test is unchanged and is still the point: the button is present, and it opens the
 * bind dialog rather than dead-ending.
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
 * what the shared session detail renders, so it is what a person's screen reader and this
 * selector both read.
 */
const BIND_CHIP = "＋ workflow";

/** The published workflow each test seeds, named per test so the bind dialog can pick it out. */
const workflowName = (label: string): string => `E2E bind chip ${label}`;

/**
 * The same chip's accessible name once a workflow IS bound.
 *
 * It names the binding rather than offering to add one, so an armed session stops reading as
 * unarmed - which under the Foreman-complete trigger it did for its whole working life, since
 * no run exists until the work is finished. Completion does not retire a binding, so the
 * session in the second test below is still armed when its run reaches `Approved`: the chip
 * there is this one, not the offer. Same button, same dialog, honest label.
 *
 * No `⌘` in the pattern, deliberately: the glyph is decoration and is `aria-hidden`, so the
 * accessible name a screen reader announces is the workflow and its version and nothing else.
 * Matching the glyph here would pin a mark no assistive technology ever reads.
 */
const armedChip = (label: string): RegExp => new RegExp(`^${workflowName(label)} v\\d+$`);

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
  // The first SESSION ROW, not the first button in the rail: the rail groups its rows by
  // repository, so the first button is that heading's collapse control and clicking it folds
  // the group instead of opening anything.
  await rail.locator("button.rail-row").first().click();
  await expect(page.locator("header.detail-head")).toBeVisible();
}

test("an OPEN run withholds the bind chip from the shared session detail", async ({
  dashboard,
  daemon,
}) => {
  // The half that would rot silently. `sessionCanBindWorkflow` is the only thing between "this
  // run owns the session" and "bind another one", and a spec that only asserted the chip coming
  // back would pass against a gate that had stopped withholding it at all - which would offer a
  // second binding the daemon refuses as a conflict.
  const session = await dispatchIdleAgent(dashboard, daemon, "get held by a run for the bind chip");

  await openConsoleDetail(dashboard, daemon);
  const head = dashboard.locator("header.detail-head");
  await expect(head.getByRole("button", { name: BIND_CHIP })).toBeVisible();

  await seedRun(daemon, session, "open", "E2E_FAIL_VERDICT", "waiting_for_session");

  // The chip goes, over SSE, with no reload: the run summary landing is what withdraws the offer.
  await expect(head.getByRole("button", { name: "Review changes" })).toBeVisible();
  await expect(head.getByRole("button", { name: BIND_CHIP })).toHaveCount(0);
});

test("a COMPLETED run gives the bind chip back beside its outcome", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatchIdleAgent(dashboard, daemon, "finish a review for the bind chip");
  await seedRun(daemon, session, "done", "E2E_PASS_VERDICT", "completed");

  await openConsoleDetail(dashboard, daemon);
  const head = dashboard.locator("header.detail-head");
  await expect(head.getByRole("button", { name: "Approved" })).toBeVisible();
  await expect(head.getByRole("button", { name: armedChip("done") })).toBeVisible();
  await shoot(dashboard, "console-detail-approved-and-bind-chip");

  // Reachable, not merely present: the chip opens the bind dialog, pinned to this session, so
  // the offer leads somewhere rather than being a decorative dead end of its own.
  await head.getByRole("button", { name: armedChip("done") }).click();
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
  // Legibly, too. This dialog drops its prose and its fields straight into `.modal` and its
  // footer carried the ruleless `.modal-actions`, so every line of it touched the border.
  await expectContentClearsBorder(dialog);
  await shoot(dashboard, "bind-dialog-from-finished-run");
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
