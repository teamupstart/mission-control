import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("workflow-completion-pane");

/**
 * How a run finishes, as the fifth tab of the run record.
 *
 * The GitHub Inspector final gate was a status sentence, two fact ledgers of sixteen fields
 * between them, a findings-policy line, a settings button and one CARD per finding - ten of
 * them across eight Inspector rounds on the run this was measured against. The Foreman
 * completion claim was one card per claim, and four of that run's five were `already_claimed`
 * restating the same completion: five near-identical paragraphs saying what one sentence says.
 *
 * Both are now one pane, present only on a run that HAS one of them, which makes Completion the
 * only conditional tab in the bar.
 *
 * Only a browser proves any of this. `test/workflow-runs-model.test.ts` pins the counts and
 * `test/workflow-runs-render.test.ts` pins the markup a detail produces; neither can click a
 * tab that may not exist, open a disclosure and find a region inside it, expand a finding row,
 * or follow the settings button to the route it opens.
 *
 * No model tokens: the one review round is answered by `e2e/fixtures/fake-agents.ts`, and the
 * gate, its findings and the completion claims are seeded rows behind the daemon - a real
 * adoption needs `gh` and a live pull request, which this offline suite has by design not got.
 * Everything the pane DERIVES from those rows is computed by the real code.
 */

const PR_NUMBER = 969;
const PR_KEY = "owner/repo#969";
const OPEN_FINDING = "Coverage-claim carry tie-break is not oldest ancestry first past two hops";
const RESOLVED_FINDING = "Digest-dedup during evidence carry can silently orphan a coverage link";
const RESOLVED_BODY = "The carry deduplicates on digest and drops the coverage row that cited it.";

async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a visible bubble on hover, and a capture taken
  // where the last click left the pointer photographs that bubble over the thing under test.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-completion-pane/${name}.png`);
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
    .fill("hold a session for the completion pane spec");
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
 * One single-reviewer run that PASSES, built through the routes the dashboard itself uses.
 *
 * Passing matters twice here: the worklist has to be clean so the container's initial selection
 * lands on the pane under test, and a run with an open change would select the worklist instead
 * - which is correct behaviour and the wrong fixture for this spec.
 */
async function seedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Completion reviewer",
    guidanceMarkdown: "# Completion reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E completion pane",
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
    { requestId: "e2e-completion-pane" },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "the seeded round should settle completed", timeout: 40_000 }).toBe("completed");
  } catch (caught) {
    // The seeding failure that matters here is server-side and invisible to a browser trace.
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return submitted.run.id;
}

/**
 * The gate, its findings and the Foreman claims the pane reads.
 *
 * A real adoption needs `gh`, a live pull request and an Inspector poll, none of which this
 * offline suite has. These are the same narrow fabrications `workflow-round-limit-grant.spec.ts`
 * already makes - the gate state column, an `inspector_prs` row and `inspector_comments` rows -
 * plus the durable completion-claim events Foreman writes. Every count, chip, sentence and
 * disclosure the pane draws from them is real code on real records.
 */
function seedCompletionRecord(daemon: DaemonHandle, runId: string): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    // The run sits where a real run with an open finding sits: waiting on a new head. A
    // completed run carrying an open finding would be a fixture contradicting itself, and the
    // gate summary is read off the run's status rather than off the findings.
    db.prepare(
      `UPDATE workflow_runs
          SET status = 'waiting_for_new_head', current_phase = 'inspector_findings',
              inspector_pr_key = ?, inspector_head_sha = ?, gate_state_json = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      PR_KEY,
      "2235185212345678",
      JSON.stringify({
        prKey: PR_KEY,
        prUrl: `https://github.example/owner/repo/pull/${PR_NUMBER}`,
        targetHeadSha: "2235185212345678",
        failedHeadSha: null,
        enteredAt: now - 30_000,
        lastObservedAt: now - 10_000,
        observedHeadSha: "2235185212345678",
        reviewPosture: "live",
        waitReason: "findings",
        findingFingerprints: [],
      }),
      now,
      runId,
    );
    db.prepare(
      `INSERT INTO inspector_prs
         (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
          head_sha, review_posture, round, last_reviewed_at, last_error, fail_count,
          last_fail_kind, next_attempt_at, last_attempt_sha, merged_at, merge_block,
          observed_head_sha, observed_state, observed_at, head_ref_name, title,
          adopted_at, updated_at)
       VALUES (?, ?, 'owner', 'repo', ?, ?, ?, NULL, 'hook', 'open',
               ?, 'live', 8, ?, NULL, 0, NULL, NULL, ?, NULL, 'workflow-gate-pending',
               ?, 'OPEN', ?, 'feat/completion-pane', 'Completion pane', ?, ?)`,
    ).run(
      PR_KEY,
      `https://github.example/owner/repo/pull/${PR_NUMBER}`,
      PR_NUMBER,
      daemon.repo,
      daemon.repo,
      "2235185212345678",
      now - 10_000,
      "2235185212345678",
      "2235185212345678",
      now - 10_000,
      now - 30_000,
      now,
    );
    const finding = db.prepare(
      `INSERT INTO inspector_comments
         (id, pr_key, fingerprint, path, line, title, body, severity, round, status,
          replies, answered_comment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    finding.run(
      "finding-resolved", PR_KEY, "fingerprint-resolved", "src/server/workflows/store.ts", 87,
      RESOLVED_FINDING, RESOLVED_BODY, "major", 7, "resolved", now - 20_000, now - 15_000,
    );
    // A finding whose body predates body persistence, so the legacy arm is on screen rather
    // than only in a unit fixture.
    finding.run(
      "finding-legacy", PR_KEY, "fingerprint-legacy", "src/server/workflows/images.ts", 812,
      "carriedEvidenceStillMatches swallows all errors as unchanged", null, "minor", 4,
      "resolved", now - 19_000, now - 14_000,
    );
    // The one still open, which is why the gate has not passed.
    finding.run(
      "finding-open", PR_KEY, "fingerprint-open", "src/server/workflows/store.ts", 87,
      OPEN_FINDING, "Past two hops the comparison is on the carried row rather than its source.",
      "minor", 9, "drafted", now - 9_000, now - 1_000,
    );
    const event = db.prepare(
      `INSERT INTO workflow_events (event_id, run_id, ts, event_kind, payload_json)
       VALUES (NULL, ?, ?, 'workflow_completion_claimed', ?)`,
    );
    const claim = (marker: string, state: string, summary: string): void => {
      event.run(runId, now, JSON.stringify({ completionKind: "prompted", marker, summary, state }));
    };
    claim(
      "de36f73f2135aaaabbbbcccc",
      "started",
      "Phase 3 is implemented with independent all-city fanout and horizon auditing.\nThe rest of the paragraph is not the first line.",
    );
    claim("5eedc77c0d9baaaabbbbcccc", "already_claimed", "Phase 3 is implemented with an independent all-city materialization.");
    claim("5b265a91e0c9aaaabbbbcccc", "already_claimed", "Phase 3 is implemented with independent all-city materialization.");
    claim("52df9fa13bdaaaaabbbbcccc", "already_claimed", "Phase 3 is implemented with independent all-city fanout.");
    claim("b9deb0e5247eaaaabbbbcccc", "already_claimed", "Phase 3 is implemented with an independent horizon-audit job.");
  });
}

const tab = (page: Page, name: RegExp): Locator => page.getByRole("tab", { name });

test("the Completion tab folds the gate and the Foreman claims into one pane", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon);
  seedCompletionRecord(daemon, runId);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const bar = dashboard.getByRole("tablist", { name: "Run record" });
  await expect(bar).toBeVisible({ timeout: 30_000 });

  // THE TAB EXISTS AND IT REPORTS. One open finding, in amber, on a label nobody has clicked -
  // and the count is the open findings rather than the five claims, because five claims
  // restating one completion is one finish reported five times.
  const completionTab = tab(dashboard, /^Completion/);
  await expect(completionTab).toBeVisible();
  await expect(completionTab.locator(".workflow-tab-badge")).toHaveText("1");

  // FIRST PAINT: the worklist is clean on this run and the gate is not, so the container opens
  // on the pane that holds the thing stopping the run. A badge alone would leave it a click
  // away, which is the constraint the tab design had to answer.
  await expect(completionTab).toHaveAttribute("aria-selected", "true");
  const pane = dashboard.getByRole("tabpanel", { name: /^Completion/ });
  await expect(pane).toBeVisible();

  // The strip, and the numbers in it are counted from the rows in the table under it.
  await expect(pane).toContainText("Open findings");
  await expect(pane).toContainText("Inspector round");
  await expect(pane).toContainText(`#${PR_NUMBER} open`);
  await expect(pane.locator(".wf-run-stat").filter({ hasText: "Open findings" })).toContainText("1");
  await expect(pane.locator(".wf-run-stat").filter({ hasText: "Resolved" })).toContainText("2");
  await expect(pane.locator(".wf-run-stat").filter({ hasText: "Inspector round" })).toContainText("8");

  // TEN CARDS BECAME ROWS. Each carries severity, title, path:line, round and status.
  const rows = pane.locator("tr.wf-run-finding-row");
  await expect(rows).toHaveCount(3);
  await expect(pane).toContainText(OPEN_FINDING);
  await expect(pane).toContainText("src/server/workflows/store.ts:87");
  await expect(pane).toContainText("src/server/workflows/images.ts:812");
  await expect(rows.filter({ hasText: OPEN_FINDING })).toContainText("drafted");
  await expect(rows.filter({ hasText: RESOLVED_FINDING })).toContainText("resolved");
  await expect(rows.filter({ hasText: RESOLVED_FINDING })).toContainText("major");
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "01-completion-pane");

  // The OPEN finding's body is not behind a disclosure - it is why the gate has not passed,
  // and the delivery ledger treats a refused packet the same way.
  await expect(pane).toContainText("Past two hops the comparison is on the carried row");
  // A RESOLVED one's is, and opening it prints the body and the fingerprint the gate tracks
  // it by. Nothing is dropped; it moved behind the row's own control.
  await expect(pane).not.toContainText(RESOLVED_BODY);
  await rows.filter({ hasText: RESOLVED_FINDING }).getByRole("button", { name: "Show finding" })
    .click();
  const detail = pane.locator("tr.wf-run-ledger-detail");
  await expect(detail).toHaveCount(1);
  await expect(detail).toContainText(RESOLVED_BODY);
  await expect(detail).toContainText("fingerprint-resolved");
  await shoot(dashboard, pane, "02-finding-expanded");
  // And the LEGACY arm, for a row whose detail was never persisted, rather than an empty panel.
  await rows.filter({ hasText: "swallows all errors" })
    .getByRole("button", { name: "Show finding" }).click();
  await expect(pane.locator("tr.wf-run-ledger-detail"))
    .toContainText("Legacy finding: detail was not persisted");

  // FIVE PARAGRAPHS BECAME FIVE ROWS, with one sentence counting the states so nobody has to
  // read five restatements of one completion to learn there was one.
  const claims = pane.getByRole("list", { name: "Foreman completion claims" });
  await expect(claims.getByRole("listitem")).toHaveCount(5);
  await expect(claims).toContainText("once-only guard");
  await expect(claims).toContainText("de36f73f2135");
  await expect(pane).toContainText(
    "5 claims on this run: 4 already counted, 1 started the run.",
  );
  // Each state's SENTENCE once, not once per claim: four claims share a state here, and the
  // card this replaced printed one identical sentence on each of them.
  await expect(pane).toContainText(
    "already counted: A claim for this same turn had already been accepted",
  );
  await expect(pane).toContainText(
    "started the run: This claim created the run and the first submission it reviewed.",
  );
  /*
   * The row is the FIRST LINE, and the whole summary is the row's accessible DESCRIPTION.
   *
   * That is what keeps this a row without dropping a field: `Tooltip` renders its label into a
   * visually-hidden body-level portal the row points `aria-describedby` at, so the paragraph is
   * in the document and in the accessible tree whether or not anyone hovers. The locator is
   * page-scoped rather than pane-scoped for exactly that reason - the node lives on `body`.
   */
  await expect(claims).toContainText("Phase 3 is implemented with independent all-city fanout and horizon auditing.");
  await expect(claims).not.toContainText("The rest of the paragraph is not the first line.");
  const described = await claims.getByRole("listitem").first()
    .locator("[aria-describedby]").first().getAttribute("aria-describedby");
  await expect(dashboard.locator(`#${described}`))
    .toContainText("The rest of the paragraph is not the first line.");

  /*
   * THE FACT LEDGER, now one disclosure.
   *
   * This is the LIVE gate's nine-field shape. The spent gate's two named regions - "Last
   * workflow observation" and "Current Inspector" - go inside the same disclosure and keep
   * their accessible names; `workflow-round-limit-grant.spec.ts` drives a run all the way into
   * `round_limit` to produce one and asserts them there, which is a fixture this spec has no
   * reason to rebuild. The live shape had no browser coverage at all before this.
   */
  const ledgers = pane.locator("details.wf-run-disclosure").filter({ hasText: "Gate ledgers" });
  await expect(ledgers).toHaveCount(1);
  await expect(ledgers.locator("> summary"))
    .toContainText("the adopted pull request and its review, 9 facts");
  const facts = ledgers.locator(".wf-run-facts-list");
  await expect(facts).toBeHidden();
  await ledgers.locator("> summary").click();
  await expect(facts).toBeVisible();
  // Every field the section carried is still a field: nothing was dropped in the move.
  for (const label of [
    "Pull request",
    "Adopted provenance",
    "GitHub Inspector",
    "Review round",
    "Target head",
    "Observed head",
    "Reviewed head",
    "Observed",
    "Backoff",
  ]) {
    await expect(facts.locator("dt", { hasText: label }).first()).toBeVisible();
  }
  await expect(facts).toContainText("hook");
  await expect(facts).toContainText("22351852");
  await shoot(dashboard, pane, "03-gate-ledger-open");

  // The findings policy and the settings button came with the gate, and the button still
  // reaches the route it always did.
  await expect(pane).toContainText("Findings policy");

  /*
   * THE WHOLE PAGE, in order, which is the end state all three phases were building toward:
   * below the round scrubber the run detail is the scrubber, the notice band, session actions,
   * the tab container, the workflow-owned model calls and the Timeline. Seven stacked sections
   * became one bar with five panes, and the gate and the completion claims - the last two to
   * move - have no section of their own anywhere on it.
   *
   * The ORDER is pinned as markup in `test/workflow-runs-render.test.ts`, which can read
   * indices a browser cannot. What this adds is the laid-out consequence a person sees.
   */
  // This run took no session action, so the whole page carries exactly TWO section headings -
  // and neither is the gate or the completion claim, both of which it has a record of.
  const headings = dashboard.locator("section.wf-run-detail h4");
  await expect(headings).toHaveText(["Workflow-owned model calls", "Timeline"]);
  if (process.env.MC_E2E_EVIDENCE) {
    // Tall enough to hold the whole run in one frame: an element screenshot of a node longer
    // than the scrollport photographs the unrendered remainder as black, and the claim here is
    // about what is and is not on the page rather than about any one band of it.
    const viewport = dashboard.viewportSize();
    await dashboard.setViewportSize({ width: 1_280, height: 2_000 });
    await shoot(dashboard, dashboard.locator("section.wf-run-detail"), "05-page-below-the-scrubber");
    if (viewport) await dashboard.setViewportSize(viewport);
  }

  // The settings button came with the gate, and still reaches the route it always did.
  await pane.getByRole("button", { name: "Open GitHub Inspector settings" }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/inspector$/);
});

test("a run with no gate and no completion claim is offered no Completion tab", async ({
  dashboard,
  daemon,
}) => {
  // The ordinary run, which is most of them. Completion is the only conditional pane in the
  // bar, and a tab drawing "no gate and no claim" is a control answering a question nobody
  // asked - so `render` returns null and Phase 1's registry withholds the tab entirely.
  const runId = await seedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const bar = dashboard.getByRole("tablist", { name: "Run record" });
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(tab(dashboard, /^Completion/)).toHaveCount(0);
  await expect(tab(dashboard, /^Review worklist/)).toHaveAttribute("aria-selected", "true");

  // A kept link naming it lands on a real pane rather than an empty container. The spelling
  // survives the round trip - it is a pane this BUILD has - and the container ignores it for
  // selection because it is not a pane this RUN offers.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=completion`);
  await expect(bar).toBeVisible();
  await expect(tab(dashboard, /^Completion/)).toHaveCount(0);
  await expect(tab(dashboard, /^Review worklist/)).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("region", { name: "Review worklist" })).toBeVisible();

  // And a claim with no gate at all is still a completion record, so the tab appears for it.
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_events (event_id, run_id, ts, event_kind, payload_json)
       VALUES (NULL, ?, ?, 'workflow_completion_claimed', ?)`,
    ).run(runId, Date.now(), JSON.stringify({
      completionKind: "drain",
      marker: "1234567890abcdef",
      summary: "Foreman proved the queue complete.",
      state: "started",
    }));
  });
  // A reload, because the row went in behind the daemon: a direct write emits no run event, so
  // the open reader would go on showing the detail it already holds.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=completion`);
  await dashboard.reload();
  const completionTab = tab(dashboard, /^Completion$/);
  await expect(completionTab).toBeVisible({ timeout: 30_000 });
  // No badge and no count: a claim is a record of what happened, not a thing stopping the run.
  await expect(completionTab.locator(".workflow-tab-badge")).toHaveCount(0);
  await expect(completionTab.locator(".wf-run-tab-count")).toHaveCount(0);
  const pane = dashboard.getByRole("tabpanel", { name: /^Completion/ });
  await expect(pane).toContainText("Foreman proved the queue complete.");
  await expect(pane).toContainText("1 claim on this run: 1 started the run.");
  // No gate, so nothing on the pane pretends there is one.
  await expect(pane).not.toContainText("Findings policy");
  await expect(pane.getByRole("button", { name: "Open GitHub Inspector settings" }))
    .toHaveCount(0);
  await shoot(dashboard, dashboard.locator("section.wf-run-record"), "04-claims-without-a-gate");
});
