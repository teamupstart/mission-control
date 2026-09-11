import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * The refusal is EARNED rather than written behind the daemon: the seeded row names a real file
 * in the session's checkout and records the digest of DIFFERENT bytes, so
 * `inspectReservedSource` refuses it through the ordinary `image_changed` path. Seeding the
 * blocked run directly would assert the page against a state nothing proved reachable.
 */

const EVIDENCE = artifactsDir("workflow-capture-failure-reason");

/** A 1x1 PNG. Valid enough to pass the format authority, which runs before the digest check. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** The bytes the session REGISTERED, before the later run overwrote the file with `PNG`. */
const STALE_BYTES = Buffer.from("the screenshot as it was when it was staged", "utf8");

const ITEM_NAME = "steering-context.png";
const ITEM_CLIENT_ID = "phase2-steering-disclosure";

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: "PUT",
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-capture-failure-reason/${name}.png`);
}

/** Dispatch one agent and wait for IDLE - capture aborts if the transcript moves under it. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(
    "hold a session for the capture-failure spec",
  );
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
    message: "the dispatched session should settle to idle before evidence capture",
    timeout: 40_000,
  }).toBe("idle");
  return sessionId;
}

async function publishWorkflow(daemon: DaemonHandle): Promise<string> {
  // A Persona node is not decoration: a version with no reviewer does not support image
  // evidence at all, so the reservation under test would never be taken. It never runs - the
  // submission is refused while its evidence is being frozen, which is the point.
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E capture failure reviewer",
    guidanceMarkdown: "# E2E capture failure reviewer\n\nE2E_PASS_VERDICT",
    runner: "claude",
    model: null,
  });
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E capture failure reason",
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

/** Two registered screenshots: the first intact, the second recorded against stale bytes. */
function seedStaleEvidence(daemon: DaemonHandle, noteKey: string, cwd: string): void {
  const now = Date.now();
  writeFileSync(join(cwd, "intact-evidence.png"), PNG);
  writeFileSync(join(cwd, "steering-context.png"), PNG);
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO workflow_evidence_owners (note_key, generation, all_generation, updated_at)
       VALUES (?, 1, 0, ?)`,
    ).run(noteKey, now);
    const insert = db.prepare(
      `INSERT INTO workflow_evidence_staging (
         id, note_key, client_item_id, source_kind, evidence_kind, source_root,
         source_locator, inline_content, command_exit_code, episode_key, display_name, caption,
         repository_scope, mime_type, bytes, sha256, generation, state,
         reserved_group_key, created_at, updated_at
       ) VALUES (?, ?, ?, 'agent', 'image', ?, ?, NULL, NULL, 'intent:1:1', ?, ?,
         'all', 'image/png', ?, ?, 1, 'staged', NULL, ?, ?)`,
    );
    insert.run(
      "e2e-capture-intact",
      noteKey,
      "phase1-intact-capture",
      cwd,
      "intact-evidence.png",
      "intact-evidence.png",
      "The screenshot that is still exactly what was registered",
      PNG.byteLength,
      createHash("sha256").update(PNG).digest("hex"),
      now,
      now,
    );
    insert.run(
      "e2e-capture-stale",
      noteKey,
      ITEM_CLIENT_ID,
      cwd,
      ITEM_NAME,
      ITEM_NAME,
      "The screenshot a later run overwrote",
      STALE_BYTES.byteLength,
      createHash("sha256").update(STALE_BYTES).digest("hex"),
      now,
      now,
    );
  });
}

test("a run blocked by evidence capture says what failed, which item, and what to do", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  // The reported run was a live No-Mistakes Review, and live delivery is refused outright
  // without both of these. Granted the way an operator grants it, so the run under test is in
  // the posture the incident happened in rather than a preview stand-in for it.
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");
  const sessionId = await dispatch(dashboard, daemon);
  const versionId = await publishWorkflow(daemon);
  const session = (await api<Array<{ id: string; cwd: string; agentSessionId?: string | null }>>(
    daemon,
    "/api/sessions",
  )).find((candidate) => candidate.id === sessionId);
  expect(session).toBeTruthy();
  // The REAL path. `resolveCheckoutEntry` re-resolves every component and requires the result
  // to stay inside the root it was handed, so a `/var` root against a `/private/var` realpath
  // would be refused as an escaped path - a different refusal than the one under test.
  seedStaleEvidence(
    daemon,
    session!.agentSessionId ?? session!.id,
    realpathSync(session!.cwd),
  );

  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId,
    sessionId,
    deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-capture-failure-1" },
  );
  const runId = submitted.run.id;

  await expect.poll(async () => {
    const detail = await api<{ run: { status: string; currentPhase: string } }>(
      daemon,
      `/api/workflow-runs/${runId}`,
    );
    return `${detail.run.status}/${detail.run.currentPhase}`;
  }, {
    message: "a registered image whose bytes moved should block the run in image_evidence_capture",
    timeout: 60_000,
  }).toBe("blocked/image_evidence_capture");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const why = header.locator("p.wf-run-refused");
  await expect(why).toBeVisible({ timeout: 40_000 });

  await expect(why).toContainText("Evidence capture refused this round");
  await expect(why).toContainText("Evidence image changed after it was staged");
  await expect(why).toContainText(`${ITEM_NAME} (registered as ${ITEM_CLIENT_ID})`);
  await expect(why).not.toContainText("intact-evidence.png");
  await expect(why).toContainText("nothing was reviewed and no repair round was spent");
  await expect(why).toContainText("picked up by the next round and not by a resume");
  await expect(why).toContainText("resuming replays the same frozen reservation");

  // With no disclosure opened: this explanation was already reachable as raw JSON inside a
  // collapsed `<details>`, which is the version nobody found.
  const packet = dashboard.getByRole("group", { name: "Join and gate packet" });
  if (await packet.count() > 0) await expect(packet).not.toHaveAttribute("open", "");

  // Beside the resubmit button, not instead of it. `runNoMoveReason` is withheld whenever a
  // move exists, so a blocked run with a button used to have nowhere to state its cause.
  const primary = header.locator("button.btn-primary");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Start repair round 2");
  await expect(primary).toBeEnabled();
  await expect(header.locator("p.wf-run-why")).toHaveCount(0);

  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-capture-failure-names-the-item");
});
