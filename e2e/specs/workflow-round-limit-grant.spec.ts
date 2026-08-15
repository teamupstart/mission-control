import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("workflow-round-limit-grant");

/**
 * Photograph a state this spec has already asserted on.
 *
 * The assertions prove the button is there and the sentence reads right; neither shows a
 * reader that the header now leads with a primary where it used to lead with a paragraph.
 * Behind `MC_E2E_EVIDENCE` like every other capture in the suite.
 */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-round-limit-grant/${name}.png`);
}

/**
 * The dead end a round-limited run used to be, and the two things that now end it.
 *
 * Reported from a No-Mistakes Review that exhausted its repair budget: the run stopped at
 * `blocked`/`round_limit`, its Inspector gate went on vetoing the pull request forever, and
 * NOTHING on the dashboard could clear it. The escapes were all off-surface - SQL, or an
 * HTTP call nobody surfaces - and the merge block said "an active workflow still owns the
 * Inspector final gate", which reads as "wait" for something that was never coming.
 *
 * Worse, the one remedy the page did name was the one guaranteed not to work: it sent the
 * operator to the binding's repair budget, and a run compares against the `maxRepairRounds`
 * it snapshotted when its row was inserted, which no binding edit rewrites.
 *
 * The veto itself is correct and stays - a gate that gave up did not pass, and auto-merging
 * it is the bypass the veto exists to stop. What changed is that the daemon now says WHICH
 * veto it is, and the run carries a control that lifts it.
 *
 * Only a browser proves this. The unit tables asserts the predicate and the merge verdict,
 * and the SSR render test asserts markup for a detail handed to it; neither one drives a run
 * into `round_limit` through the operator's own button and clicks the way out.
 */

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
): Promise<T> {
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

/** A POST whose refusal is the point - the round-limit 409 is how the run gets blocked. */
async function post(
  daemon: DaemonHandle,
  path: string,
  body: unknown,
): Promise<{ status: number; code: string }> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let code = "";
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? "";
  } catch {
    code = text.slice(0, 120);
  }
  return { status: response.status, code };
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("hold a session for the round-limit spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

const statusOf = async (daemon: DaemonHandle, runId: string): Promise<string> =>
  (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status;

/**
 * A run driven to `blocked`/`round_limit` the way production reaches it.
 *
 * The budget is set to ONE on the binding, so the run's own snapshot is one, and then the
 * operator's resubmit button spends it: round 2 is affordable, and the request after that
 * is the one the manager refuses with `workflow_round_limit` while writing the block. No
 * hand-written row - the refusal that blocks the run is the same code path the reported run
 * went through.
 */
async function seedRoundLimitedRun(
  page: Page,
  daemon: DaemonHandle,
): Promise<string> {
  await dispatch(page, daemon);
  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle to idle before evidence capture" })
    .toBe("idle");

  const reviewer = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Never satisfied",
    guidanceMarkdown: "# Never satisfied\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E round limit",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: reviewer.id, position: { x: 220, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "e-pass", source: "reviewer", sourcePort: "pass", target: "end-node", targetPort: "terminal" },
        { id: "e-fail", source: "reviewer", sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
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
    maxRepairRounds: 1,
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-round-limit-submit" },
  );
  const runId = submitted.run.id;

  const parked = async (why: string): Promise<void> => {
    try {
      await expect
        .poll(async () => statusOf(daemon, runId), { message: why, timeout: 40_000 })
        .toBe("waiting_for_session");
    } catch (caught) {
      // eslint-disable-next-line no-console
      console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
      throw caught;
    }
  };

  await parked("round 1 should park on the scripted fail verdict");
  // Round 2 is the last one a budget of 1 affords: `round > maxRepairRounds` is what the
  // guard tests, so the round EQUAL to the budget is still spendable.
  // `resubmitUnchanged`, because the scripted reviewer fails without the session changing a
  // byte and an ordinary resubmission refuses on the identical evidence snapshot. The round
  // budget is what this spec is about, so the evidence gate is stepped over deliberately.
  await api(daemon, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "e2e-round-limit-2",
    resubmitUnchanged: true,
  });
  await parked("round 2 should park on the scripted fail verdict");

  // And this is the refusal that blocks the run.
  const refused = await post(daemon, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "e2e-round-limit-3",
    resubmitUnchanged: true,
  });
  expect(refused.status).toBe(409);
  expect(refused.code).toBe("workflow_round_limit");
  await expect
    .poll(async () => statusOf(daemon, runId), { message: "the refusal should block the run" })
    .toBe("blocked");
  return runId;
}

test("a run out of repair rounds offers the grant, and the grant revives it", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRoundLimitedRun(dashboard, daemon);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const primary = header.locator("button.btn-primary");

  /*
   * The headline. This used to be a paragraph and no button at all - the page's one true
   * dead end, on the one run whose pull request could not merge until somebody acted.
   */
  const grant = header.getByRole("button", { name: /Grant \d+ more rounds/ });
  await expect(grant).toBeVisible({ timeout: 40_000 });
  await expect(grant).toBeEnabled();
  await expect(primary).toHaveCount(1);

  /*
   * And no dead-end paragraph beside it. Asserted as the ABSENCE OF THE ELEMENT the header
   * uses for "there is no move here" - not as the absence of the old copy, which would be a
   * vacuous assertion the moment that string left the bundle, and it has.
   */
  await expect(header.locator("p.wf-run-why")).toHaveCount(0);
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-out-of-rounds-offers-the-grant");

  await grant.click();
  const confirm = dashboard.getByRole("dialog");
  await expect(confirm).toBeVisible();
  // The one move on this page that changes what a pull request is waiting for, so it says so
  // before it is taken rather than after.
  await expect(confirm).toContainText("pull request cannot merge");
  await confirm.getByRole("button", { name: "Grant the rounds" }).click();
  await expect(confirm).toBeHidden();

  // The daemon moved the number the guards actually read - the run's own snapshot, not the
  // binding's default.
  await expect
    .poll(
      async () =>
        (await api<{ run: { maxRepairRounds: number } }>(daemon, `/api/workflow-runs/${runId}`))
          .run.maxRepairRounds,
      { message: "the grant should raise the run's own repair budget", timeout: 20_000 },
    )
    .toBe(3);

  /*
   * And the dead end is gone from the page: the grant retires itself and hands the run back
   * to the ordinary resume move, which is the whole reason the grant moves one number rather
   * than opening a round of its own.
   */
  await expect(grant).toHaveCount(0, { timeout: 20_000 });
  await expect(primary).toHaveCount(1);
  await expect(primary).toBeEnabled();

  await dashboard.mouse.move(0, 0);
  await shoot(header, "02-granted-hands-back-the-resume");
});

/**
 * Pin an Inspector gate onto a run, standing in for the adoption this fixture cannot do.
 *
 * Reaching a gate for real needs a passing reviewer, an adopted pull request and an
 * Inspector poll that shells out to `gh` - none of which exists here. This writes the one
 * column the operator-visible consequence reads (`gate_state_json.prKey`, which the run
 * summary turns into `gatePrNumber`), the same single sanctioned fabrication
 * `workflow-pull-request-mismatch.spec.ts` makes when it writes an observed head.
 */
function pinGate(daemon: DaemonHandle, runId: string, prNumber: number): void {
  withDaemonDb(daemon, (db) => {
    db.prepare("UPDATE workflow_runs SET gate_state_json = ? WHERE id = ?").run(
      JSON.stringify({
        prKey: `owner/repo#${prNumber}`,
        prUrl: `https://github.example/owner/repo/pull/${prNumber}`,
        targetHeadSha: "sha1",
        failedHeadSha: "sha1",
        enteredAt: 1_700_000_000_000,
        lastObservedAt: null,
        observedHeadSha: null,
        reviewPosture: null,
        waitReason: "findings",
        findingFingerprints: [],
      }),
      runId,
    );
  });
}

/**
 * The RETIRE half of the two controls that clear a spent gate.
 *
 * The Merge queue sends an operator here in as many words - "open the run to grant more
 * rounds or retire it" - and retiring is the destructive one: it does not just tidy a queue,
 * it releases the Shipping veto this run holds over somebody's pull request. A confirmation
 * that stayed silent about that would be a trap, so the sentence is asserted where a person
 * reads it, in the dialog, rather than only in a render test.
 */
test("retiring a round-limited gate says what it unblocks, then releases it", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRoundLimitedRun(dashboard, daemon);
  pinGate(daemon, runId, 486);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  // Both controls stand together on a spent run: grant to carry on, retire to let the pull
  // request go. Asserting the pair is the point - the reported dead end had neither.
  await expect(header.getByRole("button", { name: /Grant .* rounds?/ })).toBeVisible({ timeout: 40_000 });
  const retire = header.getByRole("button", { name: "Cancel run" });
  await expect(retire).toBeVisible();
  await dashboard.mouse.move(0, 0);
  await shoot(header, "04-grant-and-retire-stand-together");

  await retire.click();
  const confirm = dashboard.getByRole("dialog");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("It will not resume");
  // The half that was silent. Naming the number matters: an operator retiring one run of
  // several needs to know WHICH pull request they just let through.
  await expect(confirm).toContainText("lifts the merge block this run holds on #486");
  // Off the control before the capture: `Tooltip` portals a bubble under a resting pointer,
  // and the pointer is still on the button that opened this dialog.
  await dashboard.mouse.move(0, 0);
  await shoot(dashboard, "05-retire-names-what-it-unblocks");
  await confirm.getByRole("button", { name: "Cancel run" }).click();
  await expect(confirm).toBeHidden();

  /*
   * And the veto is genuinely gone, not merely described as gone. `mergeGate` walks active
   * bindings and takes `activeRunForBinding`, which excludes exactly the three terminal
   * statuses in SQL - so a cancelled run is one no gate can veto from, and the next
   * Inspector sweep recomputes the block without it.
   */
  await expect
    .poll(async () => statusOf(daemon, runId), {
      message: "retiring the gate should end the run that holds the veto",
      timeout: 20_000,
    })
    .toBe("cancelled");

  // The binding keeps the run in history and stops offering it as the active one, which is
  // the whole mechanism: no active run, no veto, and the row is still there to read.
  const runs = await api<{ items: Array<{ id: string; status: string }> }>(
    daemon,
    "/api/workflow-runs",
  );
  const row = runs.items.find((item) => item.id === runId);
  expect(row?.status, "the retired run vanished from history instead of ending").toBe("cancelled");
});

/**
 * The other half, on the surface where an operator actually hits the wall.
 *
 * Somebody looking at a stuck pull request reads the Merge queue, not the run page, and what
 * it told them was "an active workflow still owns the Inspector final gate" - the same
 * sentence a healthy, mid-review gate produces. Seeded as a stored block code because that
 * is exactly what the column renders: `recordBlock` writes the code on the Inspector's own
 * sweep, and the panel expands it through `MERGE_BLOCK_LABEL`.
 */
test("the merge queue tells a spent gate apart from a working one", async ({
  dashboard,
  daemon,
}) => {
  withDaemonDb(daemon, (db) => {
    const insert = db.prepare(
      `INSERT INTO inspector_prs
         (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
          head_sha, round, last_reviewed_at, merge_block, adopted_at, updated_at)
       VALUES (?, ?, 'owner', 'repo', ?, '/repo', '/repo', NULL, 'hook', 'open',
               'sha1', 1, ?, ?, ?, ?)`,
    );
    const at = 1_700_000_000_000;
    insert.run("owner/repo#486", "https://github.example/owner/repo/pull/486", 486, at, "workflow-gate-spent", at, at);
    insert.run("owner/repo#487", "https://github.example/owner/repo/pull/487", 487, at - 1000, "workflow-gate-pending", at - 1000, at - 1000);
  });

  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  const ledger = dashboard.locator(".sc-ledger");
  await expect(ledger.locator(".sc-scroll .sc-row").first()).toBeVisible({ timeout: 20_000 });

  const spent = ledger.locator(".sc-scroll .sc-row").filter({ hasText: "#486" });
  const working = ledger.locator(".sc-scroll .sc-row").filter({ hasText: "#487" });

  // The gate that is still reviewing keeps the sentence it always had: waiting is correct.
  await expect(working).toContainText("an active workflow still owns the Inspector final gate");

  /*
   * The gate that gave up does not, and that difference is the fix. It has to say the stop
   * is permanent - no further push clears it, because the gate re-tests the budget on every
   * new head - and it has to name the way out, because there is no other one.
   */
  await expect(spent).not.toContainText("an active workflow still owns the Inspector final gate");
  await expect(spent).toContainText("gave up");
  await expect(spent).toContainText(/grant|retire/i);

  /*
   * And it says the distinguishing part where a person can SEE it. This column is one
   * ellipsized line, so `toContainText` alone is not enough - it reads `textContent`, which
   * carries the whole label however much of it CSS has clipped away. The first draft of this
   * label passed a text assertion while rendering "a workflow gate ran out of repair rou…",
   * with the entire remedy hidden. So the rendered width is measured too.
   */
  const clipped = await spent.locator(".sc-standing").evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
  if (clipped) {
    const visible = await spent.locator(".sc-standing").evaluate((el) => {
      const ratio = el.clientWidth / el.scrollWidth;
      return (el.textContent ?? "").slice(0, Math.floor((el.textContent ?? "").length * ratio));
    });
    expect(visible, "the clipped label hides what makes it different from a working gate")
      .toContain("gave up");
  }

  await dashboard.mouse.move(0, 0);
  await shoot(ledger, "03-merge-queue-tells-them-apart");
});
