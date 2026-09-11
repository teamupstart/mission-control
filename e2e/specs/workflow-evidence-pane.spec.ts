import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * Frozen screenshots, where they matter.
 *
 * Image evidence used to be a section of its own, reachable only by scrolling past four
 * delivery cards, and its link to the claim it proved was a bare `clientItemId` printed in a
 * chip that a reader had to match by eye. This spec covers what replaced that: a thumbnail
 * strip inside the Evidence pane, a small copy of each cited picture on the claim row citing
 * it, and a preview that opens on a single click and carries every audit field the old ledger
 * card printed.
 *
 * Only a browser can settle any of it. `test/workflow-runs-model.test.ts` pins the counts, the
 * claim-to-criterion match and the citation derivation as pure functions and
 * `test/workflow-runs-render.test.ts` pins the markup those produce - neither can fetch a body
 * through the daemon's authenticated route, paint it, click a card, measure a dialog against
 * its own border, or watch focus come back to the thumbnail that opened it.
 *
 * No model tokens: the one reviewer is answered by `e2e/fixtures/fake-agents.ts`, and both
 * image bodies are two-pixel PNGs this file writes into the fixture checkout.
 */

/** Two real PNGs with different pixels, so their digests differ and neither deduplicates away. */
const ALPHA = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO44eAARAwQCgAoDgVhKrNqHwAAAABJRU5ErkJggg==",
  "base64",
);
const BETA = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNwaLgBRAwQCgAqTgZhTDgZaAAAAABJRU5ErkJggg==",
  "base64",
);
const ALPHA_CAPTION = "The Evidence pane strip renders a frozen thumbnail above the claims";
const BETA_CAPTION = "The claim row carries a small copy of every picture it cites";
const CRITERION = "Frozen images are visible beside the claim they prove";
const NOTE = "e2e-evidence-pane";
const EVIDENCE = artifactsDir("workflow-evidence-pane");

async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a visible bubble on hover, and a capture taken
  // where the last click left the pointer photographs that bubble over the thing under test.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-evidence-pane/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

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
    .fill("hold a session for the evidence pane spec");
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

/**
 * Two images and the one claim that cites them, staged the way a session stages them.
 *
 * Written as staging rows rather than driven through the composer because the composer is not
 * what is under test here and has its own spec. Everything the pane reads is still produced by
 * the daemon's real capture: it reserves these rows, reads the bytes off disk, sniffs and
 * digests them, freezes an immutable image record and a coverage claim, and reconciles the
 * claim against the canonical criteria the compaction returned. The link between the claim's
 * public item ids and the frozen image rows - which is what puts a picture on a claim row - is
 * the reconciliation's own, never this file's.
 */
function stageEvidence(daemon: DaemonHandle, noteKey: string, cwd: string): void {
  const now = Date.now();
  for (const [name, body] of [["pane-alpha.png", ALPHA], ["pane-beta.png", BETA]] as const) {
    const path = join(cwd, ".evidence", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_evidence_owners (
         note_key, generation, all_generation, updated_at
       ) VALUES (?, 1, 0, ?)`,
    ).run(noteKey, now);
    db.prepare(
      `INSERT INTO workflow_evidence_scope_generations (
         note_key, source_root, generation, updated_at
       ) VALUES (?, ?, 1, ?)`,
    ).run(noteKey, cwd, now);
    const insertImage = db.prepare(
      `INSERT INTO workflow_evidence_staging (
         id, note_key, client_item_id, source_kind, evidence_kind, source_root,
         source_locator, display_name, caption, repository_scope, mime_type, bytes,
         sha256, generation, state, reserved_group_key, created_at, updated_at
       ) VALUES (?, ?, ?, 'agent', 'image', ?, ?, ?, ?, 'repo-01', 'image/png', ?, ?,
         1, 'staged', NULL, ?, ?)`,
    );
    for (const [id, item, name, caption, body] of [
      ["e2e-pane-alpha", "item-alpha", "pane-alpha.png", ALPHA_CAPTION, ALPHA],
      ["e2e-pane-beta", "item-beta", "pane-beta.png", BETA_CAPTION, BETA],
    ] as const) {
      insertImage.run(
        id,
        noteKey,
        item,
        cwd,
        `.evidence/${name}`,
        name,
        caption,
        body.byteLength,
        createHash("sha256").update(body).digest("hex"),
        now,
        now,
      );
    }
    /*
     * `rendered_artifact` is satisfied by a rendered output alone, so this packet reads `ready`
     * and the pane's healthy arms are what this spec measures. The two roles differ on purpose:
     * an image card states what it is cited AS, and one that said "rendered output" for both
     * would pass whether or not the roles were read at all.
     */
    db.prepare(
      `INSERT INTO workflow_evidence_coverage_staging (
         id, note_key, client_criterion_id, criterion, proof_class, repository_scope,
         source_root, links_json, episode_key, generation, state, reserved_group_key,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'rendered_artifact', 'repo-01', ?, ?, NULL, 1, 'staged', NULL, ?, ?)`,
    ).run(
      "e2e-pane-coverage",
      noteKey,
      "pane-criterion",
      CRITERION,
      cwd,
      JSON.stringify([
        { clientItemId: "item-alpha", role: "rendered_output" },
        { clientItemId: "item-beta", role: "state_snapshot" },
      ]),
      now,
      now,
    );
  });
}

/** One passing single-reviewer run, published and submitted through the daemon's own routes. */
async function seedRun(daemon: DaemonHandle, sessionId: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Evidence pane reviewer",
    guidanceMarkdown: "# Evidence pane reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E evidence pane",
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
    { requestId: NOTE },
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

test("a frozen screenshot is visible beside the claim it proves, and one click from full size", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(240_000);
  const sessionId = await dispatch(dashboard, daemon);
  const session = (await api<Array<{ id: string; cwd: string; agentSessionId?: string }>>(
    daemon,
    "/api/sessions",
  )).find((entry) => entry.id === sessionId);
  expect(session).toBeTruthy();
  stageEvidence(daemon, session!.agentSessionId ?? session!.id, session!.cwd);
  const runId = await seedRun(daemon, sessionId);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const tab = dashboard.getByRole("tab", { name: /^Evidence/ });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  // The label carries the frozen author claims, which is what this pane is for. Nothing here
  // blocks, so the count is plain rather than the amber badge.
  await expect(dashboard.getByRole("tab", { name: /^Evidence 1$/ })).toBeVisible();
  await expect(tab.locator(".wf-run-tab-count")).toHaveText("1");
  await expect(tab.locator(".workflow-tab-badge")).toHaveCount(0);
  await tab.click();
  const pane = dashboard.getByRole("tabpanel", { name: /^Evidence/ });
  await expect(pane).toBeVisible();

  // ONE PANE. The two sections this replaced - Image evidence and Evidence readiness - are gone
  // from the page, and everything they said is in here.
  await expect(dashboard.getByRole("heading", { name: "Image evidence" })).toHaveCount(0);
  await expect(dashboard.getByRole("heading", { name: "Evidence readiness" })).toHaveCount(0);
  await expect(pane).toContainText("Readiness");
  await expect(pane).toContainText("ready");

  // THE STRIP. Both frozen bodies are fetched through the daemon's authenticated route and
  // painted, without anything being opened - which is the whole point of the change.
  const alphaCard = pane.getByRole("button", { name: "Preview pane-alpha.png" });
  const betaCard = pane.getByRole("button", { name: "Preview pane-beta.png" });
  await expect(alphaCard.locator("img")).toBeVisible({ timeout: 40_000 });
  await expect(betaCard.locator("img")).toBeVisible({ timeout: 40_000 });
  await expect(alphaCard).toContainText(ALPHA_CAPTION);
  // Who cites it, and as what, read off the record rather than left as an id to match by eye.
  await expect(alphaCard).toContainText("Cited by 1 claim as rendered output");
  await expect(betaCard).toContainText("Cited by 1 claim as state snapshot");
  await expect(alphaCard).toContainText("item-alpha");

  // THE CLAIM ROW carries a small copy of both pictures it cites. A screenshot as evidence is
  // only evidence if it can be seen beside the claim it proves.
  await expect(pane).toContainText(CRITERION);
  const claim = pane.locator(".wf-evidence-claim").filter({ hasText: CRITERION });
  const minis = claim.locator(".wf-evidence-mini img");
  await expect(minis).toHaveCount(2);
  // The same two bodies the strip painted, not a second fetch: one object URL per image, shared
  // by the card, every claim-row copy of it, and the preview.
  const stripSources = await Promise.all(
    [alphaCard, betaCard].map((card) => card.locator("img").getAttribute("src")),
  );
  await expect(minis.nth(0)).toHaveAttribute("src", stripSources[0]!);
  await expect(minis.nth(1)).toHaveAttribute("src", stripSources[1]!);
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "01-evidence-pane");

  // A SINGLE CLICK opens the preview - deliberately not the dispatch strip's double-click,
  // which exists there only because a single click would land the second press of a double on
  // the backdrop that has just appeared.
  await alphaCard.click();
  const preview = dashboard.getByRole("dialog", { name: "Preview of pane-alpha.png" });
  await expect(preview).toBeVisible();
  const full = preview.getByRole("img", { name: ALPHA_CAPTION });
  await expect(full).toBeVisible();
  /*
   * FULL SIZE, measured rather than assumed.
   *
   * `.attach-preview-image` alone only CAPS its picture, so a small frozen image kept its
   * natural size and "open it full size" produced a two-pixel dot in an empty panel. The
   * preview sizes the image to its own area instead, so this asserts the laid-out box is
   * something a person can read, and that the aspect ratio survived: these fixtures are square,
   * so a box that stretched rather than contained would come back wider than it is tall.
   */
  const painted = await full.evaluate((img: HTMLImageElement) => {
    const rect = img.getBoundingClientRect();
    // `object-fit: contain` letterboxes inside the element box, so the ELEMENT's rectangle is
    // not what a person sees. The painted picture is the natural size scaled by whichever axis
    // runs out first, which is what this computes.
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    return {
      width: img.naturalWidth * scale,
      height: img.naturalHeight * scale,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  });
  // The source is two pixels square. Before the preview sized its own image it was painted at
  // two pixels square, which is what "full size" must not mean.
  expect(painted.naturalWidth).toBe(2);
  expect(painted.width, "the preview should paint the image at a readable size")
    .toBeGreaterThan(300);
  expect(painted.height).toBeGreaterThan(300);
  expect(
    Math.abs(painted.width - painted.height),
    "a square source must be contained, never stretched",
  ).toBeLessThan(1);
  // EVERY FIELD the old ledger card printed. The strip stays scannable because these are here.
  await expect(preview).toContainText(ALPHA_CAPTION);
  await expect(preview).toContainText(createHash("sha256").update(ALPHA).digest("hex"));
  await expect(preview).toContainText("item-alpha");
  await expect(preview).toContainText("image/png");
  await expect(preview).toContainText("retained");
  await expect(preview).toContainText("Cited by 1 claim as rendered output");
  // The preview is a new modal, so its content has to clear its own border. Nothing inside it
  // re-declares a horizontal inset; `.modal` owns `--modal-inset` and the bands apply it.
  await expectContentClearsBorder(preview);
  await shoot(dashboard, preview, "02-preview");

  // ESCAPE CLOSES THIS LAYER ONLY. The overlay registry hands the key to the topmost surface,
  // so the run beneath keeps its round, its pane and its address - and focus comes back to the
  // thumbnail that opened the dialog rather than being dropped at the top of the document.
  await dashboard.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}\\?pane=evidence$`));
  await expect(pane).toBeVisible();
  await expect(alphaCard).toBeFocused();

  // And the keyboard route in: a click no pointer produced opens on the first press, because
  // there is no second one for it to strand.
  await dashboard.keyboard.press("Enter");
  await expect(dashboard.getByRole("dialog", { name: "Preview of pane-alpha.png" })).toBeVisible();
  // The close control dismisses it too, and restores focus by the same bookmark.
  await dashboard.getByRole("dialog", { name: "Preview of pane-alpha.png" })
    .getByRole("button", { name: "Close" }).click();
  await expect(dashboard.getByRole("dialog", { name: "Preview of pane-alpha.png" })).toBeHidden();
  await expect(alphaCard).toBeFocused();
});

/**
 * A body the daemon cannot serve.
 *
 * The pane fetches each retained body itself now, which adds a failure the old scroll-triggered
 * ledger shared but nothing ever demonstrated: the request can be refused. The consequence has
 * to be a fact about THAT image rather than a broken page - a card that vanished, or an <img>
 * rendering as the browser's broken-image glyph, would both read as "the run detail is broken"
 * beside a record whose every other field is intact.
 *
 * The route is refused in the browser rather than by breaking the daemon, because what is under
 * test is the arm the pane draws, not the daemon's own 404 and 410 paths - those already have
 * their own coverage in `workflow-image-evidence.spec.ts`, which asserts the pruned route
 * answers 410.
 */
test("an image body the route refuses shows why on its own card, and nothing else breaks", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(240_000);
  const sessionId = await dispatch(dashboard, daemon);
  const session = (await api<Array<{ id: string; cwd: string; agentSessionId?: string }>>(
    daemon,
    "/api/sessions",
  )).find((entry) => entry.id === sessionId);
  expect(session).toBeTruthy();
  stageEvidence(daemon, session!.agentSessionId ?? session!.id, session!.cwd);
  const runId = await seedRun(daemon, sessionId);

  const refused = "**/api/workflow-runs/*/images/*";
  await dashboard.route(refused, (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "Image body could not be read" }),
  }));
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=evidence`);
  const pane = dashboard.getByRole("tabpanel", { name: /^Evidence/ });
  await expect(pane).toBeVisible({ timeout: 30_000 });

  // The daemon's own reason, in the frame where the picture would have been. Both cards say it,
  // because both bodies were refused - and so do both copies on the claim row that cites them,
  // which share the same failed request rather than each retrying it.
  await expect(pane.locator(".wf-evidence-card .wf-image-error")).toHaveCount(2);
  await expect(pane.locator(".wf-evidence-mini .wf-image-error")).toHaveCount(2);
  const alphaCard = pane.getByRole("button", { name: "Preview pane-alpha.png" });
  await expect(alphaCard).toContainText("Image body could not be read");
  await expect(alphaCard.locator("img")).toHaveCount(0);
  // Everything the record carries is still there: the card keeps its name, its caption, its
  // item id and who cites it, and the claim row keeps its status.
  await expect(alphaCard).toContainText(ALPHA_CAPTION);
  await expect(alphaCard).toContainText("item-alpha");
  await expect(alphaCard).toContainText("Cited by 1 claim as rendered output");
  await expect(pane).toContainText(CRITERION);
  await expect(pane).toContainText("ready");

  // And the preview still opens on a refused body, carrying every audit field and saying the
  // same thing about the picture rather than framing an empty box.
  await alphaCard.click();
  const preview = dashboard.getByRole("dialog", { name: "Preview of pane-alpha.png" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Image body could not be read");
  await expect(preview).toContainText(createHash("sha256").update(ALPHA).digest("hex"));
  await shoot(dashboard, preview, "03-refused-body");
  await dashboard.unroute(refused);
});
