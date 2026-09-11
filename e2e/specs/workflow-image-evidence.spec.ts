import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * Native image evidence, through the product rather than around it.
 *
 * The browser uploads the first PNG from WorkflowBindingDialog, captions and scopes it, and
 * submits it through a real built daemon. A parallel Claude and Codex stage then receives the
 * same bytes through each provider's native image transport; the fakes reject metadata-only
 * delivery and write their observed digests for this spec to compare. The failing Claude
 * reviewer parks the run so the browser can add a replacement GIF without changing the repo,
 * proving that fresh image evidence creates a fresh submission. Finally, history lazy-loads
 * the retained body, explicitly restages it, and renders an honest pruned ledger fixture.
 *
 * No model tokens: both providers are the extension-less fakes installed by the daemon fixture.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const INITIAL_CAPTION = "Initial dashboard evidence reaches both native provider transports";
const PREBINDING_CAPTION = "Session-staged proof visible before the first binding";
const REPLACEMENT_CAPTION = "Replacement visual evidence without a repository change";
const SWITCHED_BINDING_CAPTION = "This unsent draft belongs only to the first binding";
const EVIDENCE = artifactsDir("workflow-image-evidence");

/**
 * The Evidence pane, which is where frozen images live now that the run record is a tab bar.
 *
 * Image evidence stopped being a section of its own in the run-record consolidation: it is a
 * thumbnail strip above the claims, and every audit field the old ledger card printed - caption,
 * item id, scope, MIME type, size, availability, digest, the carry notice and "Use in next
 * review" - moved into the preview that a thumbnail opens.
 */
async function evidencePane(page: Page): Promise<Locator> {
  const tab = page.getByRole("tab", { name: /^Evidence/ });
  await expect(tab).toBeVisible({ timeout: 40_000 });
  if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  return page.getByRole("tabpanel", { name: /^Evidence/ });
}

/**
 * One image card in the strip, found by the name it was uploaded under.
 *
 * By prefix, because the daemon gives a frozen body a content suffix of its own: an upload named
 * `initial-proof.png` is displayed as `initial-proof-fe5ba1d9.png`, and pinning the whole name
 * here would pin a digest this spec has no business asserting.
 */
function card(pane: Locator, prefix: string): Locator {
  return pane.getByRole("button", { name: new RegExp(`^Preview ${prefix}[\\w.-]*$`) });
}

/** One frozen image at full size, with the ledger's own fields in its footer. */
async function openPreview(page: Page, pane: Locator, prefix: string): Promise<Locator> {
  const control = card(pane, prefix);
  const label = await control.getAttribute("aria-label");
  await control.click();
  const preview = page.getByRole("dialog", {
    name: `Preview of ${label!.slice("Preview ".length)}`,
  });
  await expect(preview).toBeVisible();
  return preview;
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("Review the dashboard image evidence without changing the repository");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((item) => item.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state ?? "";
  }, { message: "the evidence session should settle before capture", timeout: 40_000 }).toBe("idle");
  return sessionId;
}

async function createWorkflow(daemon: DaemonHandle): Promise<{ workflowId: string; versionId: string }> {
  const claude = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Claude image boundary",
    guidanceMarkdown: "# Claude image boundary\n\nE2E_FAIL_VERDICT",
    runner: "claude",
    model: null,
  });
  const codex = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Codex image boundary",
    guidanceMarkdown: "# Codex image boundary\n\nE2E_PASS_VERDICT",
    runner: "codex",
    model: null,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E native image evidence",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 80 } },
        { id: "claude", kind: "persona", personaId: claude.id, position: { x: 220, y: 0 } },
        { id: "codex", kind: "persona", personaId: codex.id, position: { x: 220, y: 160 } },
        { id: "gate", kind: "all_pass", position: { x: 440, y: 80 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 660, y: 80 } },
      ],
      edges: [
        { id: "submit-claude", source: "session", sourcePort: "submitted", target: "claude", targetPort: "activate" },
        { id: "submit-codex", source: "session", sourcePort: "submitted", target: "codex", targetPort: "activate" },
        { id: "claude-pass", source: "claude", sourcePort: "pass", target: "gate", targetPort: "result" },
        { id: "claude-fail", source: "claude", sourcePort: "fail", target: "gate", targetPort: "result" },
        { id: "codex-pass", source: "codex", sourcePort: "pass", target: "gate", targetPort: "result" },
        { id: "codex-fail", source: "codex", sourcePort: "fail", target: "gate", targetPort: "result" },
        { id: "gate-pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "gate-fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  return { workflowId: workflow.workflow.id, versionId: published.version.id };
}

function providerBoundary(daemon: DaemonHandle, provider: "claude" | "codex") {
  const dir = join(daemon.recordDir, provider);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((file) => file.startsWith("workflow-image-boundary-"));
  if (!name) return null;
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    valid: boolean;
    manifest: Array<{ sha256: string; bytes: number; mimeType: string }>;
    observed: Array<{ sha256: string; bytes: number; mimeType: string }>;
  };
}

async function addEvidence(
  dialog: ReturnType<Page["getByRole"]>,
  file: { name: string; mimeType: string; buffer: Buffer },
  caption: string,
): Promise<void> {
  await dialog.getByLabel("Choose workflow evidence images").setInputFiles(file);
  const captionInput = dialog.getByLabel(`Caption for ${file.name}`);
  await expect(captionInput).toBeVisible();
  await captionInput.fill(caption);
  await dialog.getByLabel(`Repository scope for ${file.name}`).selectOption("repo-01");
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  // The dashboard scrolls inner panels rather than the document, so `fullPage` on this page is
  // just the viewport. A named target is screenshotted directly, which is the only way to get
  // a section that sits below the fold into the frame.
  if (target) {
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  } else {
    await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  }
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-image-evidence/${name}.png`);
}

test("dashboard evidence reaches both native providers and remains auditable per submission", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  const sessionId = await dispatch(dashboard, daemon);
  const published = await createWorkflow(daemon);
  const evidenceSession = (await api<Array<{ id: string; agentSessionId?: string }>>(
    daemon,
    "/api/sessions",
  )).find((session) => session.id === sessionId);
  expect(evidenceSession).toBeTruthy();
  const noteKey = evidenceSession!.agentSessionId ?? evidenceSession!.id;
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_evidence_owners (
         note_key, generation, all_generation, updated_at
       ) VALUES (?, 1, 0, ?)`,
    ).run(noteKey, now);
    db.prepare(
      `INSERT INTO workflow_evidence_staging (
         id, note_key, client_item_id, source_kind, evidence_kind, source_root,
         source_locator, display_name, caption, repository_scope, mime_type, bytes,
         sha256, generation, state, reserved_group_key, created_at, updated_at
       ) VALUES (?, ?, ?, 'agent', 'image', ?, ?, ?, ?, 'repo-01', 'image/png', ?, ?,
         1, 'staged', NULL, ?, ?)`,
    ).run(
      "e2e-prebinding-staged",
      noteKey,
      "e2e-prebinding-proof",
      daemon.repo,
      ".evidence/prebinding-proof.png",
      "prebinding-proof.png",
      PREBINDING_CAPTION,
      PNG.byteLength,
      createHash("sha256").update(PNG).digest("hex"),
      now,
      now,
    );
  });

  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Bind to a session…" }).click();
  const bind = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await bind.getByLabel("Session").selectOption(sessionId);
  await bind.getByLabel("Published workflow").selectOption(published.versionId);
  // Staging belongs to the conversation, so the first composer must reveal it before a
  // binding exists and let the operator remove it through the session-owned route.
  expect(await api<unknown[]>(daemon, "/api/workflow-bindings")).toHaveLength(0);
  await expect(bind.getByText("Registered by the session")).toBeVisible();
  await expect(bind).toContainText(PREBINDING_CAPTION);
  const removedBeforeBinding = dashboard.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return response.request().method() === "DELETE"
      && path.startsWith("/api/sessions/")
      && path.endsWith("/workflow-evidence/e2e-prebinding-proof");
  });
  await bind.getByRole("button", { name: "Remove registered image prebinding-proof.png" }).click();
  expect((await removedBeforeBinding).status()).toBe(200);
  await expect(bind).not.toContainText(PREBINDING_CAPTION);
  await addEvidence(bind, { name: "initial-proof.png", mimeType: "image/png", buffer: PNG }, INITIAL_CAPTION);
  // The overlay is transient, but the draft belongs to the selected session. Closing and
  // reopening must preserve the upload, caption, and scope until the daemon accepts it.
  await bind.getByRole("button", { name: "Close" }).click();
  await expect(bind).toBeHidden();
  await dashboard.getByRole("button", { name: "Bind to a session…" }).click();
  await expect(bind).toBeVisible();
  await expect(bind.getByLabel(`Caption for initial-proof.png`)).toHaveValue(INITIAL_CAPTION);
  await expect(bind.getByLabel(`Repository scope for initial-proof.png`)).toHaveValue("repo-01");
  await bind.getByLabel("Published workflow").selectOption(published.versionId);
  await expect(bind.getByRole("button", { name: "Bind and submit" })).toBeEnabled();

  const accepted = dashboard.waitForResponse((response) =>
    response.request().method() === "POST"
    && /\/api\/workflow-bindings\/[^/]+\/submit$/.test(new URL(response.url()).pathname));
  await bind.getByRole("button", { name: "Bind and submit" }).click();
  const first = await (await accepted).json() as { run: { id: string } };
  await expect(bind).toBeHidden();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${first.run.id}$`));

  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${first.run.id}`)
  ).run.status, { message: "the scripted Claude objection should park round one", timeout: 120_000 })
    .toBe("waiting_for_session");

  const pngDigest = createHash("sha256").update(PNG).digest("hex");
  for (const provider of ["claude", "codex"] as const) {
    await expect.poll(() => providerBoundary(daemon, provider)?.valid ?? false, {
      message: `${provider} should receive real native image bytes`,
      timeout: 40_000,
    }).toBe(true);
    const proof = providerBoundary(daemon, provider)!;
    expect(proof.manifest[0]?.sha256).toBe(pngDigest);
    expect(proof.observed[0]?.sha256).toBe(pngDigest);
    expect(proof.observed[0]?.bytes).toBe(PNG.byteLength);
    expect(proof.observed[0]?.mimeType).toBe("image/png");
  }

  const initialLedger = await evidencePane(dashboard);
  await initialLedger.scrollIntoViewIfNeeded();
  await expect(initialLedger).toContainText(INITIAL_CAPTION);
  // The card's own thumbnail, painted from the retained body the pane fetched. The picture is
  // decorative beside a caption that already reads it out, so it is selected through the card
  // that names it rather than by an accessible name of its own.
  await expect(card(initialLedger, "initial-proof").locator("img"))
    .toBeVisible({ timeout: 40_000 });
  await shoot(dashboard, "01-retained-history");

  // The repository stays untouched. Only the replacement image changes, and it must still
  // produce a fresh immutable submission rather than the unchanged-evidence refusal.
  await dashboard.locator("header.wf-run-head").getByRole("button", { name: "Preview fresh evidence" }).click();
  const fresh = dashboard.getByRole("dialog", { name: "Preview fresh evidence" });
  await addEvidence(fresh, { name: "replacement-proof.gif", mimeType: "image/gif", buffer: GIF }, REPLACEMENT_CAPTION);
  await expect(fresh.getByRole("button", { name: "Preview fresh evidence" })).toBeEnabled();
  await fresh.getByRole("button", { name: "Preview fresh evidence" }).click();
  await expect(fresh).toBeHidden();

  await expect.poll(async () => (
    await api<{ submissions: Array<{ id: string }> }>(daemon, `/api/workflow-runs/${first.run.id}`)
  ).submissions.length, { message: "replacement pixels should create a fresh round", timeout: 120_000 })
    .toBe(2);
  let detail!: {
    binding: { id: string };
    submissions: Array<{ id: string; context: { evidence?: { headSha?: string } } }>;
    evidenceImages: Array<{ submissionId: string; images: Array<{ id: string; sha256: string }> }>;
  };
  await expect.poll(async () => {
    detail = await api<typeof detail>(daemon, `/api/workflow-runs/${first.run.id}`);
    const latest = detail.submissions.at(-1);
    const images = detail.evidenceImages.find((group) => group.submissionId === latest?.id)?.images;
    return latest?.context.evidence?.headSha && images?.length ? "captured" : "pending";
  }, { message: "the replacement submission should finish immutable capture", timeout: 40_000 })
    .toBe("captured");
  expect(detail.submissions[0]?.context.evidence?.headSha)
    .toBe(detail.submissions[1]?.context.evidence?.headSha);
  const newest = detail.submissions.at(-1)!;
  const newestImage = detail.evidenceImages.find((group) => group.submissionId === newest.id)!.images[0]!;
  expect(newestImage.sha256).toBe(createHash("sha256").update(GIF).digest("hex"));

  const ledger = await evidencePane(dashboard);
  await expect(ledger).toContainText(REPLACEMENT_CAPTION, { timeout: 40_000 });
  // The replacement round carries the first round's evidence forward, so this submission holds
  // two cards: the one it captured and the one it inherited. The strip says which round each
  // came from; the carry's full notice and every other audit field are in the preview.
  await expect(ledger).toContainText("from round 1");
  await shoot(dashboard, "02-carried-forward-ledger", ledger);

  // The carried record offers no restage of its own - the same digest is already offered by the
  // submission that captured it, and a second button would imply this submission captured it.
  const carried = await openPreview(dashboard, ledger, "initial-proof");
  await expect(carried).toContainText("Carried forward from round 1");
  await expect(carried.getByRole("button", { name: "Use in next review" })).toHaveCount(0);
  await carried.getByRole("button", { name: "Close" }).click();
  await expect(carried).toBeHidden();

  // The re-stage action moved into the preview with the rest of the ledger's fields, and it
  // still reaches the same route and settles into the same label.
  let captured = await openPreview(dashboard, ledger, "replacement-proof");
  await expect(captured).toContainText(newestImage.sha256);

  /*
   * A REFUSED re-stage first, because the settled label is a claim about the daemon.
   *
   * "Ready for next review" says these bytes are staged for the next fresh review. A button
   * that settled into it on a request that failed would be the surface asserting something
   * the daemon never did, and the operator would find out at the next submission. So the
   * reason is reported and the button stays pressable.
   */
  const reattach = "**/api/workflow-bindings/*/evidence/reattach";
  await dashboard.route(reattach, (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "Retained bytes could not be staged" }),
  }));
  await captured.getByRole("button", { name: "Use in next review" }).click();
  // INSIDE the dialog, which is the only place the press can be made from. This dialog draws a
  // backdrop over the pane, so the same sentence on the pane behind it would be an explanation
  // the operator has to close the dialog to read.
  const refusal = captured.getByRole("alert")
    .filter({ hasText: "Retained bytes could not be staged" });
  await expect(refusal).toBeVisible();
  // Once in the whole pane subtree, which the dialog is part of: the reason belongs beside the
  // button, and printing it here AND on the pane would be the same sentence twice.
  await expect(ledger.getByRole("alert")
    .filter({ hasText: "Retained bytes could not be staged" })).toHaveCount(1);
  await expect(captured.getByRole("button", { name: "Use in next review" })).toBeEnabled();
  await expect(captured.getByRole("button", { name: "Ready for next review" })).toHaveCount(0);

  /*
   * AND STILL SAID AFTER THE DIALOG CLOSES, on the card the press was made for.
   *
   * The request outlives the preview it was pressed in. An operator who closes the dialog - on
   * purpose or out of habit - would otherwise be told nothing at all, and could walk away
   * believing these bytes are queued for the next review when the daemon refused them.
   */
  await captured.getByRole("button", { name: "Close" }).click();
  await expect(captured).toBeHidden();
  const failedCard = card(ledger, "replacement-proof");
  await expect(failedCard).toContainText("Re-stage failed");
  // On that card only: a refusal belongs to the image it was pressed for.
  await expect(ledger.getByText("Re-stage failed")).toHaveCount(1);
  captured = await openPreview(dashboard, ledger, "replacement-proof");
  await dashboard.unroute(reattach);

  await captured.getByRole("button", { name: "Use in next review" }).click();
  await expect(captured.getByRole("button", { name: "Ready for next review" })).toBeVisible();
  await captured.getByRole("button", { name: "Close" }).click();
  await expect(captured).toBeHidden();

  await dashboard.locator("header.wf-run-head").getByRole("button", { name: "Preview fresh evidence" }).click();
  const staged = dashboard.getByRole("dialog", { name: "Preview fresh evidence" });
  await expect(staged.getByText("Registered by the session")).toBeVisible();
  await expect(staged).toContainText(REPLACEMENT_CAPTION);
  let releaseDelete!: () => void;
  let observeDelete!: () => void;
  const deleteHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deleteStarted = new Promise<void>((resolve) => { observeDelete = resolve; });
  const deletePattern = "**/api/workflow-bindings/*/evidence/*";
  await dashboard.route(deletePattern, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    observeDelete();
    await deleteHeld;
    await route.continue();
  });
  const removeRegistered = staged.getByRole("button", { name: /^Remove registered image / });
  await expect(removeRegistered).toBeVisible();
  await removeRegistered.click();
  await deleteStarted;
  await expect(staged.getByRole("button", { name: "Preview fresh evidence" })).toBeDisabled();
  releaseDelete();
  await expect(removeRegistered).toHaveCount(0);
  await dashboard.unroute(deletePattern);
  await staged.getByRole("button", { name: "Cancel" }).click();

  // A retention fixture changes only availability. The body route must answer 410 and the
  // dashboard must keep every audit field while removing the reuse action.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      "UPDATE workflow_submission_images SET availability = 'pruned', pruned_at = ? WHERE id = ?",
    ).run(Date.now(), newestImage.id);
  });
  const body = await fetch(`${daemon.baseURL}/api/workflow-runs/${first.run.id}/images/${newestImage.id}`);
  expect(body.status).toBe(410);

  await dashboard.reload();
  const pruned = await evidencePane(dashboard);
  await expect(pruned).toContainText(REPLACEMENT_CAPTION);
  // The card keeps its place and says the bytes are gone rather than rendering as a broken
  // image, and every auditable field survives in the preview with the reuse action withdrawn.
  await expect(card(pruned, "replacement-proof")).toContainText("Body pruned");
  const prunedPreview = await openPreview(dashboard, pruned, "replacement-proof");
  await expect(prunedPreview).toContainText("Raw body pruned");
  await expect(prunedPreview).toContainText(
    "Caption, scope, MIME, size, and SHA-256 remain auditable",
  );
  await expect(prunedPreview).toContainText(newestImage.sha256);
  await expect(prunedPreview.getByRole("button", { name: "Use in next review" })).toHaveCount(0);
  await shoot(dashboard, "02-pruned-history");
  await prunedPreview.getByRole("button", { name: "Close" }).click();
  await expect(prunedPreview).toBeHidden();

  // A browser draft survives closing this binding's modal, but cannot cross the mounted Runs
  // page into another binding. Change only the hash so this exercises the live component rather
  // than getting a free reset from a page reload.
  await dashboard.locator("header.wf-run-head").getByRole("button", { name: "Preview fresh evidence" }).click();
  const firstBindingDraft = dashboard.getByRole("dialog", { name: "Preview fresh evidence" });
  await addEvidence(
    firstBindingDraft,
    { name: "binding-one-only.png", mimeType: "image/png", buffer: PNG },
    SWITCHED_BINDING_CAPTION,
  );
  await firstBindingDraft.getByRole("button", { name: "Cancel" }).click();

  await api(daemon, `/api/workflow-bindings/${detail.binding.id}`, {}, "DELETE");
  const secondBinding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.versionId,
    sessionId,
    deliveryMode: "preview",
  });
  const second = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${secondBinding.id}/submit`,
    { requestId: "e2e-image-evidence-second-binding" },
  );
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${second.run.id}`)
  ).run.status, { message: "the second binding should reach its repair boundary", timeout: 120_000 })
    .toBe("waiting_for_session");
  await dashboard.evaluate((runId) => { window.location.hash = `#/runs/${runId}`; }, second.run.id);
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${second.run.id}$`));
  await dashboard.locator("header.wf-run-head").getByRole("button", { name: "Preview fresh evidence" }).click();
  const secondBindingDraft = dashboard.getByRole("dialog", { name: "Preview fresh evidence" });
  await expect(secondBindingDraft.getByLabel("Caption for binding-one-only.png")).toHaveCount(0);
  await expect(secondBindingDraft).not.toContainText(SWITCHED_BINDING_CAPTION);
  await secondBindingDraft.getByRole("button", { name: "Cancel" }).click();
});
