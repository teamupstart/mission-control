import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The run header, after the four controls that serve nobody reading a run left it.
 *
 * `Copy run id`, `Export run` and `Export version` are bug-report material - the id has no
 * filter on this page to be pasted into and the route already carries it, and neither export
 * has an importer anywhere in the product, by deliberate design. All three now sit in a
 * collapsed `Audit and bug reports` disclosure beside the Timeline. `Open version` left a
 * different way: the version badge it duplicated became the link itself.
 *
 * Only this layer can settle any of it. The SSR tests assert the markup a given detail
 * produces; they cannot tell a `<details>` that is collapsed from one whose rows a reader can
 * never reach, cannot follow the badge to the composer, and - the reason the run-id copy was
 * rebuilt at all - cannot execute a clipboard call. The old button called
 * `navigator.clipboard.writeText` behind a `void`, so where the async Clipboard API is
 * permission-blocked (the Electron renderer, and the third case below) it copied nothing and
 * said nothing. The rebuilt control goes through `copyText()`, whose synchronous textarea
 * fallback is what the third case makes it fall back to.
 *
 * The fourth case is here because writing the first one found a defect: an open disclosure shut
 * itself about a second after the page settled. The reader was being unmounted and rebuilt on
 * every summary bump for the run being read, so it is not only this disclosure that was lost -
 * the evidence and gate-packet disclosures closed with it, and the scrubbed round snapped back
 * to the newest. That case pins the repair through the loop that exposed it.
 *
 * No model tokens: the seeded Persona's guidance carries `E2E_PASS_VERDICT` or
 * `E2E_FAIL_VERDICT`, which the fake `claude` binary answers with a fixed schema-valid verdict.
 */

/** The one reviewer each seeded run authors, so the disable toggle can be named exactly. */
const NODE = { persona: "audit-persona" };

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/workflow-run-audit/", import.meta.url));

/**
 * Photograph a state this spec has already asserted on.
 *
 * The claim being made is about what a person SEES - a header carrying two controls instead of
 * six, and three audit rows that read as one group - and a green run leaves nothing behind to
 * look at. Behind `MC_E2E_EVIDENCE` like every other capture in the suite, because an ordinary
 * `npm run test:e2e` would rewrite the binaries for no added signal.
 */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/workflow-run-audit/${name}.png`);
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
    .fill("hold a session for the run audit disclosure spec");
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
 * One single-reviewer run, built through the routes the dashboard itself uses.
 *
 * `verdict` decides where it parks: an approval finishes the run, a refusal returns it to the
 * session, which is the only state that still offers the per-run disable toggle the live-update
 * case needs. Both are stable, so no case below waits out a mid-review race.
 */
async function seedRun(
  page: Page,
  daemon: DaemonHandle,
  verdict: "pass" | "fail",
): Promise<{ runId: string; workflowId: string }> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Audit reviewer",
    guidanceMarkdown: `# Audit reviewer\n\nE2E_${verdict === "pass" ? "PASS" : "FAIL"}_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E run audit",
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
    { requestId: "e2e-run-audit" },
  );
  const settled = verdict === "pass" ? "completed" : "waiting_for_session";
  // On a miss the daemon's own log tail is attached: the seeding failure that matters here is
  // server-side (capture, compaction, the engine) and invisible to a browser trace.
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: `round 1 should settle in ${settled}`, timeout: 40_000 }).toBe(settled);
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return { runId: submitted.run.id, workflowId: workflow.workflow.id };
}

/**
 * Every control under one name, whichever element carries it.
 *
 * Both roles, because the exports are `<a download>` and the copy is a `<button>` - a
 * count-zero assertion against one role would pass while the other still rendered.
 */
const controlsNamed = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));

/** The disclosure, found by the words that say who its contents are for. */
const auditOf = (page: Page) => page.locator("details").filter({ hasText: "Audit and bug reports" });

test("the run id and both JSON records leave the header for a collapsed disclosure", async ({
  dashboard,
  daemon,
}) => {
  const { runId } = await seedRun(dashboard, daemon, "pass");
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  // The header rendered and still offers what a reader reaches for. The four removals below
  // mean nothing unless the row they left is on screen and populated.
  const header = dashboard.locator("header.wf-run-head");
  await expect(header.getByRole("button", { name: "Copy feedback" })).toBeVisible();
  await expect(header.getByRole("button", { name: /Open workflow version/ })).toBeVisible();

  for (const gone of ["Copy run id", "Export run", "Export version", "Open version"]) {
    await expect(controlsNamed(dashboard, gone), `${gone} is still reachable`).toHaveCount(0);
  }
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // header being photographed is what the pointer was last over.
  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-header");

  // Collapsed: the summary is on screen and the rows behind it are not.
  const audit = auditOf(dashboard);
  const summary = audit.getByText("Audit and bug reports");
  await expect(summary).toBeVisible();
  const runHistory = controlsNamed(audit, "Download the run history as JSON");
  const versionJson = controlsNamed(audit, "Download workflow version 1 as JSON");
  await expect(runHistory).toBeHidden();
  await expect(versionJson).toBeHidden();
  await shoot(audit, "02-collapsed");

  await summary.click();

  // Opened: the id itself, and one download per record, each named for the record it fetches
  // rather than for the identical "Download JSON" both of them read on screen.
  await expect(audit.getByText(runId)).toBeVisible();
  await expect(runHistory).toBeVisible();
  await expect(versionJson).toBeVisible();
  await expect(runHistory).toHaveAttribute("href", `/api/workflow-runs/${runId}/export`);
  // The filenames are the server's own `Content-Disposition` names, which
  // test/workflows-http.test.ts pins. A file must not be named two ways.
  await expect(runHistory).toHaveAttribute("download", `workflow-run-${runId}.json`);
  await expect(versionJson).toHaveAttribute("download", "workflow-version-1.json");
  await dashboard.mouse.move(0, 0);
  await shoot(audit, "03-opened");

  // The copy puts the id on the real clipboard, and says so where the click was.
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copy = audit.getByRole("button", { name: "Copy" });
  await copy.click();
  await expect(audit.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(runId);
  // Then it goes back, so a second copy reads as available rather than spent.
  await expect(copy).toBeVisible({ timeout: 4000 });
});

test("the run id copy survives a renderer whose Clipboard API refuses", async ({
  dashboard,
  daemon,
}) => {
  const { runId } = await seedRun(dashboard, daemon, "pass");

  // What the Electron renderer does: a permission-blocked async Clipboard API that rejects
  // after a direct click. The control this replaced swallowed exactly that rejection in a
  // `void`, leaving the reader with no id and no message.
  await dashboard.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Write permission denied.")) },
    });
  });
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const audit = auditOf(dashboard);
  await audit.getByText("Audit and bug reports").click();
  await audit.getByRole("button", { name: "Copy" }).click();

  // `copyText()`'s synchronous selection fallback carried it, so the label flips and the page
  // raises no failure. Both refusals are reachable in this test - the stub guarantees the async
  // path fails, so if the fallback failed too the host would render one of these sentences.
  await expect(audit.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(dashboard.getByText("Could not copy the run id")).toHaveCount(0);
  await expect(dashboard.getByText("The browser refused the clipboard copy")).toHaveCount(0);

  // And the id is really on the clipboard, read from a second page in the same context: this
  // page's `navigator.clipboard` is the rejecting stub, so it cannot be asked. A flipped label
  // proves the promise resolved; this proves something was copied.
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const reader = await dashboard.context().newPage();
  await reader.goto(`${daemon.baseURL}/#/fleet`);
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(runId);
  await reader.close();
});

test("an opened disclosure survives the run's own live updates", async ({ dashboard, daemon }) => {
  const { runId } = await seedRun(dashboard, daemon, "fail");
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const audit = auditOf(dashboard);
  const runHistory = controlsNamed(audit, "Download the run history as JSON");
  await audit.getByText("Audit and bug reports").click();
  await expect(runHistory).toBeVisible();

  // A real update for the run being read: clicking the reviewer off travels
  // POST -> SQLite -> SSE summary bump -> detail refetch -> repaint. That last step used to
  // null the detail and rebuild the whole reader, which shut every disclosure on the page and
  // sent a scrubbed round back to the newest.
  const reviewer = dashboard.locator(".wf-pipeline-strip li.wf-pipeline-reviewer")
    .filter({ hasText: "Audit reviewer" });
  await reviewer.getByRole("button").click();

  // The update landed - the row goes red and its toggle reads pressed. Its chip still says
  // `Changes requested`, because switching a reviewer off is a promise about the next round
  // rather than an eraser for the verdict it already gave.
  await expect(reviewer.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(reviewer).toHaveClass(/is-disabled/);
  // ...and it landed in place, with the reader's own state intact.
  await expect(runHistory).toBeVisible();
  await expect(audit.getByText(runId)).toBeVisible();
});

test("the version badge is the way to the composer, on the version it names", async ({
  dashboard,
  daemon,
}) => {
  const { runId, workflowId } = await seedRun(dashboard, daemon, "pass");
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  // The badge already displayed the version; now it carries the navigation the header used to
  // spend a whole button on, and its accessible name says where it goes - `v1` would not.
  await dashboard.getByRole("button", { name: "Open workflow version 1 in the composer" }).click();

  await expect(dashboard.getByRole("complementary", { name: "Workflow library and node palette" }))
    .toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe(`#/library/workflows/${workflowId}`);
});
