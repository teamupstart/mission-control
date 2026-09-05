import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A Board card states a run's PROGRESS by default and its REASONS only when asked.
 *
 * The card of a session under review used to argue the run's case unconditionally: the
 * reviewer's objection in full, and a control that opened the whole actionable ladder inside
 * the tile. On a full column that is a paragraph of somebody else's reading per card, so both
 * are now the `workflowDetails` Display item, and it ships OFF. What a card says without it is
 * still the whole stage track, which stage it is on, and how much repair budget is left.
 *
 * Only a browser can answer this. The claim spans a checkbox in Settings, a preference stored
 * through the daemon, a re-rendered Board tile, and a rebindable keyboard chord that must be
 * unclaimed rather than silently toggling a panel with no control to close it.
 *
 * The `dashboard` fixture deliberately does NOT pin `hiddenDisplayItems`, so the first half of
 * this spec reads the shipped default rather than a fixture's opinion of it. The four specs
 * that need the disclosure ask for it themselves through `displayItemsShowing`.
 *
 * No model tokens: the reviewer is a Persona whose guidance carries `E2E_FAIL_VERDICT`, which
 * `e2e/fixtures/fake-agents.ts` answers with a schema-valid failing verdict. That parks the run
 * on the session with a real objection to state - which is exactly the card in the report.
 */

const EVIDENCE = artifactsDir("board-card-workflow-details");

/** The persona whose name the peek's sentence attributes the objection to. */
const REVIEWER = "Card detail reviewer";

async function shoot(target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await target.page().mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-card-workflow-details/${name}.png`);
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

/** Dispatch one agent and wait for it to settle, with no workflow armed by the modal itself. */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle): Promise<string> {
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((s) => s.id),
  );
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("be read on the board without arguing its case");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const fresh = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    sessionId = fresh?.id ?? "";
    return fresh?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/** A one-reviewer workflow whose persona objects, so the run parks open with a reason to give. */
async function openRunOn(daemon: DaemonHandle, sessionId: string): Promise<void> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: REVIEWER,
    guidanceMarkdown: `# ${REVIEWER}\n\nE2E_FAIL_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Card detail review",
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
    { requestId: "e2e-card-workflow-details" },
  );
  await expect.poll(
    async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`))
        .run.status,
    { timeout: 60_000 },
  ).toBe("waiting_for_session");
}

/**
 * Put the dashboard in the Board layout, and only that.
 *
 * `hiddenDisplayItems` is deliberately not sent: the shipped default is the subject here, so
 * the spec must not state it. The reload is what makes the layout take - the web store
 * hydrates from `GET /api/ui/config` at boot and overwrites the local cache.
 */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a Board card states a run's progress by default and its reasons only when asked", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const session = await dispatchIdleAgent(dashboard, daemon);
  await openRunOn(daemon, session);
  await useBoardLayout(dashboard, daemon);

  const tile = dashboard.locator(".tile").filter({
    has: dashboard.locator(".tile-workflow-disclosure"),
  });
  await expect(tile).toHaveCount(1);
  const peek = tile.locator(".wf-tile-peek");
  const boardDetail = dashboard.locator(".board-detail");

  // ---- As shipped: the whole progress reading, and nothing about why. ----
  await expect(peek.locator(".wf-stage-meter")).toBeVisible();
  await expect(peek.locator(".wf-repair-meter")).toBeVisible();
  await expect(peek.getByRole("img", { name: "Round 1: current" })).toBeVisible();
  await expect(peek).toContainText("stages");
  // The objection exists - the run is parked on it - and the card does not repeat it.
  await expect(peek.locator(".wf-tile-peek-sentence")).toHaveCount(0);
  await expect(peek).not.toContainText("Deterministic e2e objection");
  await expect(tile.locator(".tile-workflow-disclosure-row")).toHaveCount(0);
  await expect(tile.getByRole("button", { name: "Show full workflow" })).toHaveCount(0);
  await shoot(tile, "01-progress-only");

  // The expand chord is UNCLAIMED rather than toggling a panel with no control to close it,
  // and it must not fall through to a drill-in either.
  await dashboard.keyboard.press("ArrowRight");
  await expect(dashboard.locator(".tile.selected")).toBeVisible();
  await dashboard.keyboard.press("v");
  await expect(tile.locator(".wf-ladder-panel")).toHaveCount(0);
  await expect(boardDetail).toHaveAttribute("aria-hidden", "true");

  // ---- Switched on, in the panel that owns it. ----
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const setting = dashboard.getByRole("checkbox", { name: "Workflow details", exact: true });
  await expect(setting).not.toBeChecked();
  await setting.check();
  // The panel's own preview card answers immediately, with no reload and no daemon round trip.
  const previewCard = dashboard.locator(".board-card-preview-stage");
  await expect(previewCard.getByRole("button", { name: "Show full workflow" })).toBeVisible();
  // The item's own row rather than the whole checklist: the customizer is taller than any
  // sensible viewport, and an element screenshot taken across a scroll is stitched rather
  // than photographed - the seam reads as a rendering fault in a frame meant for review.
  await shoot(
    dashboard.locator("label.settings-toggle").filter({ hasText: "Workflow details" }),
    "02-setting-checked",
  );

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  // The reason, attributed to the reviewer who gave it.
  await expect(peek.locator(".wf-tile-peek-sentence")).toContainText(REVIEWER);
  await expect(peek.locator(".wf-tile-peek-sentence"))
    .toContainText("Deterministic e2e objection");
  await shoot(tile, "03-details-on");

  // And the control it came with opens the same actionable ladder in place.
  await tile.getByRole("button", { name: "Show full workflow" }).click();
  await expect(tile.locator(".wf-ladder-panel")).toBeVisible();
  await expect(tile.getByRole("button", { name: "Collapse workflow" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(boardDetail).toHaveAttribute("aria-hidden", "true");
  await shoot(tile, "04-expanded");

  /*
   * ---- Switched off while still EXPANDED, then on again. ----
   *
   * Deliberately NOT collapsed first. Checking the box offers the ability to expand; it must
   * not restore an expansion. Left masked rather than cleared, the tile springs open into the
   * full ladder the moment the box is re-checked - with no click - while a neighbour that was
   * never expanded stays shut, so two identical cards disagree for a reason the operator
   * cannot see.
   *
   * This asserts the operator-visible END STATE, which is the durable claim. It does not by
   * itself isolate the reset: today `AppPageShell` mounts one page slot, so reaching the
   * checkbox unmounts the board and the tile's state dies on the way there regardless. The
   * reset is what stops that from being load-bearing - the settings surface was a modal over
   * the fleet before it was a page - and it is pinned where it can be observed, by the source
   * scan in `test/board-card-items.test.ts`.
   */
  await expect(tile.getByRole("button", { name: "Collapse workflow" })).toBeVisible();
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await setting.uncheck();
  await expect(previewCard.getByRole("button", { name: "Show full workflow" })).toHaveCount(0);
  await setting.check();
  await expect(previewCard.getByRole("button", { name: "Show full workflow" })).toBeVisible();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  // The control is back, offering the expansion - and it is offering it, not performing it.
  await expect(tile.getByRole("button", { name: "Show full workflow" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect(tile.getByRole("button", { name: "Collapse workflow" })).toHaveCount(0);
  await expect(tile.locator(".wf-ladder-panel")).toHaveCount(0);
  await expect(peek.locator(".wf-stage-meter")).toBeVisible();

  // ---- And back off, which is what makes it a preference rather than a one-way reveal. ----
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await setting.uncheck();
  await expect(previewCard.getByRole("button", { name: "Show full workflow" })).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await expect(peek.locator(".wf-stage-meter")).toBeVisible();
  await expect(peek.locator(".wf-tile-peek-sentence")).toHaveCount(0);
  await expect(tile.getByRole("button", { name: "Show full workflow" })).toHaveCount(0);
});
