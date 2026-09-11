import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("workflow-run-intent-provenance");

/**
 * A run says what KIND of ask it froze, on the screen, before anyone has to ask SQLite.
 *
 * The defect behind this ran for months in the operator's own state: 21 of 25 runs carrying a
 * frozen intent were judged against something other than the session's durable objective, and
 * 10 of the 25 were text Mission Control typed itself. Every one of those was discoverable by
 * a query nobody had a reason to write, and the product said nothing at all.
 *
 * Nothing here is seeded behind the daemon. The suspicious run's ask is genuinely typed into
 * the Dispatch modal, genuinely captured by the Goal pipeline as that session's objective,
 * genuinely frozen by the real submit route, and genuinely classified inside the transaction
 * that creates the run. That whole chain is the thing under test - the classifier itself is a
 * pure function pinned in `test/workflow-goal-provenance.test.ts`, and the badge's markup in
 * `test/workflow-runs-render.test.ts`. Neither of those can see whether a real freeze reaches
 * a real badge, which is the only question this file asks.
 *
 * No model tokens: the one review round is answered by `e2e/fixtures/fake-agents.ts`.
 */

/**
 * The SDK restart continuation, verbatim.
 *
 * A copy rather than an import, for the reason the classifier keeps its own copy: this asserts
 * that the SHIPPED daemon recognises this exact text, and a spec that imported the constant
 * would agree with itself if the daemon stopped recognising it. `test/workflow-goal-provenance.test.ts`
 * is where the live constant and the classifier's copy are held together.
 */
const MACHINE_ASK =
  "Mission Control restarted while your previous turn was still in progress."
  + " Continue that work from the current checkout and conversation. Inspect the current"
  + " state before acting, do not repeat completed work, and ask again for any approval or"
  + " input you still need.";

const HUMAN_ASK = "Give the pipeline strip a visible scrollbar on every platform";

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-run-intent-provenance/${name}.png`);
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

/** Dispatch one agent whose typed request becomes this session's durable objective. */
async function dispatch(page: Page, daemon: DaemonHandle, ask: string): Promise<string> {
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((session) => session.id),
  );
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below, so close it before filling
  // the next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(ask);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const fresh = sessions.find((session) => !before.has(session.id) && session.state !== "exited");
    sessionId = fresh?.id ?? "";
    return fresh?.state ?? "";
  }, {
    message: "the dispatched session should settle before the workflow is bound",
    timeout: 60_000,
  }).toBe("idle");
  return sessionId;
}

interface SessionGoalView {
  promptRevision: number;
  resolvedPromptRevision: number;
}

/**
 * Send one more instruction, and wait until the goal pipeline is in the state under test.
 *
 * Three separate waits, and each one is load bearing:
 *
 *  1. The composer's `send` guards itself with `sending` for the whole `injectPrompt` round
 *     trip and empties the box only once the daemon has answered, so the empty box is the
 *     acceptance signal.
 *  2. The registry captures the prompt a beat AFTER that, so the revision this test is about
 *     does not exist yet when the box empties.
 *  3. The goal refiner is running in this suite - it reconciles the opening ask a few seconds
 *     in - so the resolved revision MOVES on its own. Submitting without waiting for it to
 *     settle races it, and the badge then names whichever number the freeze happened to catch.
 *
 * Waiting for `resolved >= 1` rather than for a fixed pair is what makes the wait honest: it
 * is the condition the verdict describes - one instruction classified, a later one still
 * pending - and it is stable, because the refiner takes the next revision no sooner than its
 * sixty-second debounce allows.
 */
async function steer(page: Page, daemon: DaemonHandle, text: string): Promise<void> {
  await page.getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  await composer.press("Enter");
  await expect(composer, "the composer should accept the steering instruction").toHaveValue("");

  await expect.poll(async () => {
    const sessions = await api<Array<{ goal?: SessionGoalView | null }>>(daemon, "/api/sessions");
    const goal = sessions[0]?.goal;
    if (!goal) return "no goal";
    return goal.resolvedPromptRevision >= 1 && goal.promptRevision > goal.resolvedPromptRevision
      ? "steering pending"
      : `prompt ${goal.promptRevision}, resolved ${goal.resolvedPromptRevision}`;
  }, {
    message: "the steering instruction should be captured and left unreconciled",
    timeout: 30_000,
  }).toBe("steering pending");
}

/** One passing single-reviewer run, built through the routes the dashboard itself uses. */
async function runFrozenAgainst(
  page: Page,
  daemon: DaemonHandle,
  label: string,
  ask: string,
  beforeSubmit?: () => Promise<void>,
): Promise<string> {
  const sessionId = await dispatch(page, daemon, ask);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `Provenance reviewer ${label}`,
    guidanceMarkdown: "# Provenance reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: `E2E run intent provenance ${label}`,
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
  if (beforeSubmit) await beforeSubmit();
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `provenance-${label}` },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "the seeded round should settle completed", timeout: 60_000 }).toBe("completed");
  } catch (caught) {
    // The seeding failure that matters here is server-side and invisible to a browser trace.
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return submitted.run.id;
}

const intentPane = (page: Page): Locator => page.getByRole("tabpanel", { name: /^Intent/ });

async function openIntent(page: Page, daemon: DaemonHandle, runId: string): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await page.getByRole("tab", { name: /^Intent/ }).click();
  const pane = intentPane(page);
  await expect(pane).toBeVisible();
  return pane;
}

test("a run frozen against text Mission Control typed itself says so in run detail", async ({
  dashboard,
  daemon,
}) => {
  const runId = await runFrozenAgainst(dashboard, daemon, "machine", MACHINE_ASK);
  const pane = await openIntent(dashboard, daemon, runId);

  // The one-word verdict is what a reader sees; the whole reason is the accessible name, so a
  // screen reader and a hover both get the sentence rather than the label alone.
  const badge = pane.getByRole("note");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Ask looks machine-authored");
  await expect(badge).toHaveAttribute(
    "aria-label",
    /matches an SDK restart continuation, which Mission Control types itself/,
  );

  // The ask it is about is the one that was frozen, and it really is the daemon's own prose.
  const contract = pane.locator("details.wf-run-disclosure")
    .filter({ hasText: "Review contract" }).first();
  await contract.locator("> summary").click();
  await expect(contract.locator("pre")).toContainText("Mission Control restarted while your");

  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "01-machine-authored-ask");
});

test("a run frozen against a real objective is badged with nothing at all", async ({
  dashboard,
  daemon,
}) => {
  const runId = await runFrozenAgainst(dashboard, daemon, "human", HUMAN_ASK);
  const pane = await openIntent(dashboard, daemon, runId);

  const contract = pane.locator("details.wf-run-disclosure")
    .filter({ hasText: "Review contract" }).first();
  await contract.locator("> summary").click();
  await expect(contract.locator("pre")).toContainText(HUMAN_ASK);

  // The load-bearing negative: a badge on the healthy case is a badge on every run, and a
  // reader stops seeing it. The disclosure above proves the pane rendered before this counts.
  await expect(pane.getByRole("note")).toHaveCount(0);

  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "02-healthy-ask-unbadged");
});


/**
 * The second verdict an operator can actually meet, and the one no seeded row could prove.
 *
 * `unreconciled` is not a property of the ask's TEXT - this run's objective is a perfectly good
 * one - so it cannot be demonstrated by choosing a suspicious string. It is a property of WHEN
 * the freeze happened: a second instruction the session has already accepted is still sitting
 * unclassified, so the objective this run is about to be judged against may be replaced by
 * something the human has already said. The real goal refiner runs in this suite, so `steer`
 * waits for it to settle rather than assuming it never speaks.
 *
 * This is also the regression for the false positive this check shipped with. Reading it as
 * `promptRevision > resolvedPromptRevision` badged EVERY freshly dispatched run, because the
 * opening ask becomes the objective without the refiner's help - which the healthy test above
 * would have caught, and did.
 */
test("a run frozen while a later instruction is unreconciled says which one it froze", async ({
  dashboard,
  daemon,
}) => {
  const runId = await runFrozenAgainst(
    dashboard,
    daemon,
    "unreconciled",
    HUMAN_ASK,
    () => steer(dashboard, daemon, "actually, start with the Windows case and leave macOS until later"),
  );
  const pane = await openIntent(dashboard, daemon, runId);

  const badge = pane.getByRole("note");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Ask frozen before the newest instruction was reconciled");
  await expect(badge).toHaveAttribute(
    "aria-label",
    /frozen at prompt revision 2 while the goal refiner had reconciled only up to revision 1/,
  );

  // The contract it froze is still the human's objective, not the steering. That pairing is
  // the point of the badge: the ask is fine, the MOMENT it was taken is what deserves a look.
  const contract = pane.locator("details.wf-run-disclosure")
    .filter({ hasText: "Review contract" }).first();
  await contract.locator("> summary").click();
  await expect(contract.locator("pre")).toContainText(HUMAN_ASK);

  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "03-unreconciled-instruction");
});
