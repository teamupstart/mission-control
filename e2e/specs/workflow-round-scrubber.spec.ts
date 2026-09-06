import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("workflow-round-scrubber");

/**
 * One tile per ROUND, whatever a round spent getting its evidence.
 *
 * The reported defect, from a live No-Mistakes run: three rounds that captured evidence 3,
 * 11 and 9 times drew TWENTY-THREE tiles - `Round 2 · evidence 7` and its twenty-two
 * siblings - wrapping three rows deep across the top of the reader, above a header that had
 * already said "round 3 of 6". A strip of twenty-three tiles reads as twenty-three rounds,
 * which inverts the one fact the segment model exists to convey: a continuation costs no
 * repair budget.
 *
 * What ships instead: the round is the unit of the tile and the snapshots inside it are the
 * unit of selection. The tile carries a static count badge - `11 evidence` - and the captures
 * themselves live in a tray below the strip, one labelled chip each, in a grid of equal cells
 * naming the capture and its state. Exactly one tray is open at a time and it belongs to the
 * round being read, which the tile announces with `aria-expanded`. Each chip wears its own
 * capture's tone, so a collapsed round still admits that one of its captures failed.
 *
 * Only a browser proves this. `test/workflow-runs-model.test.ts` pins the fold, and no
 * assertion on markup can say whether the strip is one row or three - which is the entire
 * complaint being answered, so this spec MEASURES it.
 *
 * No model tokens: the one real review round is answered by `e2e/fixtures/fake-agents.ts`,
 * and the twenty-two extra snapshots are seeded rows. Capturing evidence twenty-three times
 * for real is a session doing twenty-three turns; the shape is what is under test, not the
 * capture, so it is written behind the daemon and everything the reader derives stays real.
 */

/** The screenshot's own shape: how many snapshots each round of the reported run took. */
const SHAPE = [3, 11, 9] as const;

async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a visible bubble on hover, and a capture taken
  // with the pointer resting where the last click left it covers the tile being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-round-scrubber/${name}.png`);
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
  // The repo combobox portals its listbox over the fields below, so close it before filling
  // the next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the round scrubber spec");
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
  }, { message: "the dispatched session should settle before the workflow is bound" }).toBe("idle");
  return sessionId;
}

/** One single-reviewer run that passes, built through the routes the dashboard itself uses. */
async function seedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Scrubber reviewer",
    guidanceMarkdown: "# Scrubber reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E round scrubber",
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
    { requestId: "e2e-round-scrubber" },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "round 1 should settle completed", timeout: 40_000 }).toBe("completed");
  } catch (caught) {
    // The seeding failure that matters here is server-side and invisible to a browser trace.
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return submitted.run.id;
}

/**
 * Grow the real run into the reported shape: 3, 11 and 9 snapshots across three rounds.
 *
 * Segment zero of round 1 already exists and is the run's real, reviewed submission, so it
 * is left exactly as the engine wrote it and every other snapshot is inserted around it. The
 * last snapshot of round 3 is `failed` and one in its middle is too, which is what the tray's
 * chips exist to keep visible once the tile above them speaks only for the newest.
 */
function growRounds(daemon: DaemonHandle, runId: string): void {
  withDaemonDb(daemon, (db) => {
    const template = db.prepare(
      `SELECT * FROM workflow_submissions WHERE run_id = ? ORDER BY round, segment LIMIT 1`,
    ).get(runId) as Record<string, unknown> | undefined;
    if (!template) throw new Error("the seeded run should already hold its first submission");
    const insert = db.prepare(
      `INSERT INTO workflow_submissions (
         id, run_id, round, segment, parent_submission_id, continuation_node_id,
         continuation_node_attempt_id, refinement_reason, mode, trigger_source, trigger_key,
         evidence_group_key, staged_image_generation, evidence_fingerprint, context_json,
         evidence_json, readiness_json, pr_head_sha, status, created_at, updated_at,
         completed_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'full_workflow', 'manual', ?, '', 0, ?, '{}',
                 '{}', NULL, NULL, ?, ?, ?, NULL)`,
    );
    const created = Number(template.created_at);
    for (const [index, count] of SHAPE.entries()) {
      const round = index + 1;
      for (let segment = 0; segment < count; segment += 1) {
        if (round === 1 && segment === 0) continue;
        // The screenshot's own mix, so the tray's chips have more than one tone to draw. The
        // last snapshot of the last round failed - that is the state the run is parked in.
        const status = round === 3 && (segment === count - 1 || segment === 4)
          ? "failed"
          : segment % 3 === 1
            ? "running"
            : "waiting_for_evidence_readiness";
        // A refinement's provenance is all-or-nothing, and the store refuses a row whose
        // reason and columns disagree - so the chain is written the way the runtime writes
        // it: each snapshot names the one it refined, and segment zero names nothing.
        const parent = segment === 0
          ? null
          : segment === 1 && round === 1
            ? String(template.id)
            : `seed-${round}-${segment - 1}`;
        insert.run(
          `seed-${round}-${segment}`,
          runId,
          round,
          segment,
          parent,
          segment === 0 ? null : "evidence_preflight",
          `e2e-round-scrubber-${round}-${segment}`,
          `fingerprint-${round}-${segment}`,
          status,
          created + round * 1000 + segment,
          created + round * 1000 + segment,
        );
      }
    }
  });
}

test("a round is one tile however many times it captured evidence", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const scrubber = dashboard.getByRole("group", { name: "Select a round" });

  // First, the ordinary run this reader has always drawn: one round, one snapshot, no count
  // badge and NO tray. Stamping "1 evidence" on every run, or opening a one-chip tray under
  // it, would spend the reader's attention on a distinction nobody is drawing.
  await expect(scrubber.locator(".wf-run-round-name")).toHaveText(["Round 1"]);
  await expect(scrubber.locator(".wf-run-round-count")).toHaveCount(0);
  await expect(dashboard.getByRole("group", { name: /^Select evidence/ })).toHaveCount(0);

  growRounds(daemon, runId);
  await dashboard.reload();
  await expect(scrubber).toBeVisible();

  // THE REGRESSION. Three tiles, named for their rounds - not twenty-three named for their
  // snapshots. The `· evidence N` suffix belongs to a submission, and the tile is not one.
  await expect(scrubber.locator(".wf-run-round-name")).toHaveText([
    "Round 1",
    "Round 2",
    "Round 3",
  ]);
  await expect(scrubber.locator(".wf-run-round")).toHaveCount(3);
  // Each tile says how many times its round captured, so the count is never the thing a
  // reader has to open the tray to learn.
  await expect(scrubber.locator(".wf-run-round-count")).toHaveText([
    "3 evidence",
    "11 evidence",
    "9 evidence",
  ]);

  // One row. No assertion on markup can make this claim, and three rows across the top of
  // the reader is the whole of what was reported. Measured against a tile's own height, so
  // it survives a font or padding change that a hard-coded pixel budget would not.
  const stripBox = await scrubber.boundingBox();
  const tileBox = await scrubber.locator(".wf-run-round").first().boundingBox();
  expect(stripBox, "the scrubber should be laid out").not.toBeNull();
  expect(tileBox, "a round tile should be laid out").not.toBeNull();
  expect(stripBox!.height).toBeLessThan(tileBox!.height * 1.5);

  // EXACTLY ONE tray, belonging to the round being read - the newest, on load - and it lists
  // that round's captures in words, which is what the tray is for.
  const trays = dashboard.getByRole("group", { name: /^Select evidence in round/ });
  await expect(trays).toHaveCount(1);
  const tray = dashboard.getByRole("group", { name: "Select evidence in round 3" });
  await expect(tray.locator(".wf-run-tray-chip")).toHaveCount(9);
  await expect(tray.locator(".wf-run-tray-chip-name").first()).toHaveText("evidence 1");
  await expect(tray.locator(".wf-run-tray-chip-name").last()).toHaveText("evidence 9");
  await expect(dashboard.getByText("Round 3 evidence")).toBeVisible();
  // A failed capture inside a collapsed round is not swallowed by the tile above it: round 3
  // is parked on a failure, and the one in its middle is still there to be found.
  await expect(tray.locator(".wf-run-tray-chip.workflow-failed")).toHaveCount(2);
  await expect(tray.locator(".wf-run-tray-chip").last()).toHaveAttribute("aria-pressed", "true");
  await shoot(dashboard, dashboard.locator(".wf-run-rounds"), "01-one-tile-per-round");

  // The tile announces the tray as its own rather than leaving a reader to infer it.
  const tileOf = (round: number) => scrubber.locator(".wf-run-round").nth(round - 1);
  await expect(tileOf(3)).toHaveAttribute("aria-expanded", "true");
  await expect(tileOf(2)).toHaveAttribute("aria-expanded", "false");

  // Read BEFORE the click that has to leave them alone: the strip's height and the geometry
  // of a tile whose round is NOT the one being picked in. The count badge is deliberately
  // static, so choosing a capture must move nothing in the strip at all.
  const beforeStrip = stripBox!.height;
  const beforeSecond = (await tileOf(2).boundingBox())!;

  // Opening another round: its tray replaces the first, and there is still only one.
  await tileOf(2).click();
  await expect(trays).toHaveCount(1);
  const second = dashboard.getByRole("group", { name: "Select evidence in round 2" });
  await expect(second.locator(".wf-run-tray-chip")).toHaveCount(11);
  await expect(tileOf(2)).toHaveAttribute("aria-pressed", "true");
  await expect(tileOf(3)).toHaveAttribute("aria-expanded", "false");
  // The round opens on its NEWEST capture, which is what a reader clicking a round wants.
  await expect(second.locator(".wf-run-tray-chip").last())
    .toHaveAttribute("aria-pressed", "true");

  // Picking a capture inside the open round: the chip takes the press, the provenance line
  // moves onto it, and the strip above does not budge.
  const chips = second.locator(".wf-run-tray-chip");
  await chips.nth(6).click();
  await expect(chips.nth(6)).toHaveAttribute("aria-pressed", "true");
  await expect(chips.last()).toHaveAttribute("aria-pressed", "false");
  await expect(dashboard.locator(".wf-run-notice")).toContainText("Evidence 7 of round 2");
  await expect(dashboard.locator(".wf-run-notice"))
    .toContainText("does not spend a Persona repair round");
  await shoot(dashboard, dashboard.locator(".wf-run-rounds"), "02-evidence-selected");
  // The TILE STRIP on its own, with a capture selected inside round 2. Framed on the strip
  // rather than the whole panel because the assertions below are about the strip
  // specifically - three tiles, one row, unmoved - and a full-panel frame cannot isolate it.
  await shoot(dashboard, scrubber, "03-strip-with-capture-selected");

  // Nothing in the strip moved. The badges are static text for exactly this reason.
  const afterSecond = (await tileOf(2).boundingBox())!;
  expect(afterSecond.x).toBeCloseTo(beforeSecond.x, 0);
  expect(afterSecond.y).toBeCloseTo(beforeSecond.y, 0);
  expect(afterSecond.width).toBeCloseTo(beforeSecond.width, 0);
  expect((await scrubber.boundingBox())!.height).toBeCloseTo(beforeStrip, 0);

  // The chips are a GRID, not a ragged wrapping row: every chip in a row shares a left edge
  // with the chip below it and they share widths. A row of chips sized to their own state
  // sentences is what made the tray unreadable as rows in the mockup.
  const widths = await chips.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  expect(new Set(widths).size, `chips should share one width, got ${widths.join(",")}`).toBe(1);
});
