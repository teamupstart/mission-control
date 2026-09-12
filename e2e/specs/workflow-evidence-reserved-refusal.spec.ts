import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * What the dashboard says when a submission has already frozen the id an upload is reusing.
 *
 * The composer mints attachment ids from a per-page counter, so the first image uploaded after
 * a reload is always `att-1`. Once a submission has reserved an `att-1`, uploading different
 * bytes under that id is a real collision an operator can reach in two clicks - and it used to
 * answer with "Workflow evidence could not be staged", which names neither the item nor the
 * repair. The store's refusals now carry a code and a sentence, and the binding dialog prints
 * the sentence.
 *
 * The row is seeded rather than earned through a first full submission: what is under test is
 * the refusal the second upload meets, not the reservation that produced it, and a real
 * reservation here would cost a whole review round to reach the same state.
 *
 * No model tokens: nothing in this spec runs a Persona.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const RESERVED_BYTES = Buffer.from("the bytes a previous round already froze", "utf8");
const EVIDENCE = artifactsDir("workflow-evidence-reserved-refusal");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
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
  await dialog.getByPlaceholder("What should this agent do?").fill(
    "Keep the evidence this round proved reachable to the next one",
  );
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((candidate) => candidate.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state;
  }, { timeout: 40_000 }).toBe("idle");
  return sessionId;
}

async function publishWorkflow(daemon: DaemonHandle): Promise<string> {
  // A Persona node is not decoration here: browser evidence is refused outright unless the
  // bound version has one, so a session-to-end graph never reaches the staging code under test.
  // The reviewer never runs - the submission is refused while its evidence is being staged.
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E reserved evidence reviewer",
    guidanceMarkdown: "# E2E reserved evidence reviewer\n\nE2E_PASS_VERDICT",
    runner: "claude",
    model: null,
  });
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E reserved evidence refusal",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 80 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 80 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 440, y: 80 } },
      ],
      edges: [
        {
          id: "submit-reviewer",
          source: "session",
          sourcePort: "submitted",
          target: "reviewer",
          targetPort: "activate",
        },
        {
          id: "reviewer-pass",
          source: "reviewer",
          sourcePort: "pass",
          target: "end",
          targetPort: "terminal",
        },
        {
          id: "reviewer-fail",
          source: "reviewer",
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${created.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  return published.version.id;
}

/** One image evidence row a previous submission consumed, under the id the next upload takes. */
function seedReservedAttachment(daemon: DaemonHandle, noteKey: string, cwd: string): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO workflow_evidence_owners (note_key, generation, all_generation, updated_at)
       VALUES (?, 1, 0, ?)`,
    ).run(noteKey, now);
    db.prepare(
      `INSERT INTO workflow_evidence_staging (
         id, note_key, client_item_id, source_kind, evidence_kind, source_root,
         source_locator, inline_content, command_exit_code, episode_key, display_name, caption,
         repository_scope, mime_type, bytes, sha256, generation, state,
         reserved_group_key, created_at, updated_at
       ) VALUES (?, ?, 'att-1', 'upload', 'image', ?, 'frozen.png', NULL, NULL, 'intent:1:1',
         'frozen.png', ?, 'repo-01', 'image/png', ?, ?, 1, 'reserved', ?, ?, ?)`,
    ).run(
      "e2e-reserved-att-1",
      noteKey,
      cwd,
      "The screenshot a previous submission froze",
      RESERVED_BYTES.byteLength,
      createHash("sha256").update(RESERVED_BYTES).digest("hex"),
      "e2e-reserved-group",
      now,
      now,
    );
  });
}

async function capture(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  if (target) await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  else await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-evidence-reserved-refusal/${name}.png`);
}

test("a reserved evidence id refuses by name, so the operator knows which upload to rename", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const sessionId = await dispatch(dashboard, daemon);
  const versionId = await publishWorkflow(daemon);
  const session = (await api<Array<{ id: string; cwd: string; agentSessionId?: string | null }>>(
    daemon,
    "/api/sessions",
  )).find((candidate) => candidate.id === sessionId);
  expect(session).toBeTruthy();
  seedReservedAttachment(daemon, session!.agentSessionId ?? session!.id, session!.cwd);

  // A reload is what puts the attachment counter back to zero, which is exactly how an
  // operator reaches `att-1` a second time.
  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Bind to a session…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await dialog.getByLabel("Session").selectOption(sessionId);
  await dialog.getByLabel("Published workflow").selectOption(versionId);
  await expectContentClearsBorder(dialog);

  await dialog.getByLabel("Choose workflow evidence images")
    .setInputFiles({ name: "second-round.png", mimeType: "image/png", buffer: PNG });
  const caption = dialog.getByLabel("Caption for second-round.png");
  await expect(caption).toBeVisible();
  await caption.fill("Different bytes, reusing the id a submission already froze");
  await dialog.getByLabel("Repository scope for second-round.png").selectOption("repo-01");

  await dialog.getByRole("button", { name: "Bind and submit" }).click();
  const alert = dialog.getByRole("alert").filter({ hasText: "already reserved" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("att-1");
  await expect(alert).toContainText("Register the new content under a new id");
  // Naming the reserved id was never the whole repair. A new evidence id orphans every claim
  // that cited the old one, and re-pointing such a claim is refused in turn, so the refusal has
  // to carry the second half an operator or agent needs to act on in one read.
  await expect(alert).toContainText("new criterion id");
  await expect(alert).toContainText("criterion text identical");
  await expect(alert).not.toContainText("Workflow evidence could not be staged");
  await capture(dashboard, "01-reserved-id-named-in-the-refusal", dialog);
});
