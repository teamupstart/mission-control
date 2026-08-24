import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import { DAEMON_TERMINAL_IDENTITY, type DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { settled } from "../fixtures/settle.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";

/**
 * The path this suite exists to cover: a person dispatches an agent from the dashboard and
 * talks to it.
 *
 * Nothing here is stubbed on the browser side and nothing is stubbed inside the daemon. The
 * dispatch cuts a real git worktree, the session is a real SDK-runtime session with a real
 * child process behind it, the reply travels over the real `POST /api/sessions/:id/inject`
 * route, and the conversation is read back off a real transcript file by the real SSE
 * stream. The ONE thing replaced is the model: `MISSION_CLAUDE_BIN` points at a fake that
 * speaks Claude Code's control protocol and writes a transcript, so the suite costs nothing.
 *
 * This is the seam the rest of the test suite cannot reach. `renderToStaticMarkup` tests
 * assert markup shape, the `node:test` HTTP tests assert route behaviour against an
 * in-process app, and the Electron tests measure laid-out geometry - but none of them ever
 * connects a click to a route to a server event and back to the DOM.
 */

const TASK = "write a haiku about flexbox";
const FOREMAN_EVIDENCE = artifactsDir("foreman-pr-follow-through");
const EVIDENCE = artifactsDir("dispatch-and-converse");

async function captureForemanEvidence(
  popover: ReturnType<Page["getByRole"]>,
): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(FOREMAN_EVIDENCE, { recursive: true });

  console.log("OBSERVED Foreman Then exposes Ask and Straight to PR, with no automatic review option");
  console.log("OBSERVED review-comment and CI follow-through are separate checked controls");
  console.log("OBSERVED the CI control says it does not create a PR and requires one to exist");
  await popover.screenshot({ path: join(FOREMAN_EVIDENCE, "foreman-settings.png") });
  console.log("CAPTURED e2e/.artifacts/foreman-pr-follow-through/foreman-settings.png");

  // The workflow evidence packet can name a binary PNG but cannot display its pixels. Serialize
  // the exact asserted browser DOM beside it and link the dashboard's real stylesheet, giving the
  // reviewer a text-carried artifact it can render directly. Reflect live input properties onto
  // attributes because `outerHTML` alone does not preserve a checkbox's current checked state.
  const dialogHtml = await popover.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    const sourceInputs = [...element.querySelectorAll("input")];
    const clonedInputs = [...clone.querySelectorAll("input")];
    sourceInputs.forEach((source, index) => {
      const cloned = clonedInputs[index];
      if (!cloned) return;
      cloned.toggleAttribute("checked", source.checked);
      cloned.toggleAttribute("disabled", source.disabled);
    });
    return clone.outerHTML;
  });
  const renderedHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Evidence: Foreman PR follow-through settings</title>
    <!-- Generated from the built dashboard by dispatch-and-converse.spec.ts. -->
    <link rel="stylesheet" href="../../../src/web/styles.css" />
    <style>
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: start center;
        background: var(--bg);
      }
      .foreman-evidence {
        width: min(100%, 360px);
        padding: 20px;
      }
      .foreman-evidence-head {
        margin: 0 0 10px;
        font: 600 10.5px/1.4 var(--mono);
        color: var(--muted);
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      .foreman-evidence .foreman-pop {
        position: relative;
        inset: auto;
        width: 288px;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main class="foreman-evidence">
      <p class="foreman-evidence-head">Built dashboard · asserted browser state</p>
      ${dialogHtml}
    </main>
  </body>
</html>
`;
  writeFileSync(join(FOREMAN_EVIDENCE, "foreman-settings.html"), renderedHtml);
  console.log("CAPTURED e2e/.artifacts/foreman-pr-follow-through/foreman-settings.html");
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

/**
 * Dispatch one agent from the modal.
 *
 * `Escape` after the repo field is load-bearing rather than defensive: `RepoCombobox`
 * portals its listbox to `document.body` at `z-index: 60`, positioned directly over the
 * Task field below it, and it opens on focus AND on every keystroke. Without dismissing it,
 * the very next `fill` lands on a covered control. The combobox's own Escape handler calls
 * `stopPropagation`, so this closes the list and NOT the modal.
 */
async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  options: { task?: string; kind?: "ship" | "scout"; model?: string } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(options.task ?? TASK);
  await dialog.getByLabel("Kind").selectOption(options.kind ?? "ship");
  if (options.model) {
    await dialog.getByLabel("Model").selectOption(options.model);
  }

  // Pin the post-work Workflow to none. Left at "Dispatch default" the daemon's configured
  // default applies, and this repo is not allowlisted for Live delivery, so the dispatch is
  // refused with "requires Workflows Live mode and an allowlisted repository" and the modal
  // stays open. Selecting explicitly also keeps the spec independent of that config.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");

  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go, "the primary is disabled until both repo and task are non-empty").toBeEnabled();
  await go.click();

  await expect(dialog).toBeHidden();
}

test("dispatching an agent puts a live session on the fleet", async ({ dashboard, daemon }) => {
  await expect(dashboard.getByText("No agent sessions detected")).toBeVisible();

  await dispatch(dashboard, daemon);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();
  // Exactly one, not "at least one": the daemon has adopted the dispatch as a single
  // session rather than double-carding it, which is a real regression this repo has had.
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
  // Named by `deriveTitle`, which title-cases the intent. That is the SYNCHRONOUS name a
  // dispatch gets; `task-title.ts` refines it with a headless model call afterwards, so
  // asserting on the model's answer here would be racing an async refinement. What that
  // call went to instead is pinned in the launch spec below.
  await expect(card).toContainText("Write a Haiku About Flexbox");
  // Running on the SDK runtime, headless, with a worktree of its own.
  await expect(card).toContainText("Agent SDK");
  await expect(card).toContainText("worktree-pools/");
  // The driver accepts turn one before it reports the native conversation id. Once that
  // binding arrives, the same accepted prompt must become the card's Goal. Scoped to the
  // Goal line because both the title and the activity ticker also derive from this text.
  await expect(card.locator(".goal")).toHaveText(TASK);
  // The model the fake reported through the SDK's `system/init` frame, proving the card's
  // model line is fed by the driver rather than by a default.
  await expect(card).toContainText("Claude e2e Mock");
});

test("the dispatch shortcut works after focus leaves the task description", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();

  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");

  // Reproduce the reported boundary: the task textarea no longer owns DOM focus. The
  // shortcut belongs to the dialog, so moving into another field must not disable it.
  const kind = dialog.getByLabel("Kind");
  await kind.focus();
  await expect(kind).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeEnabled();
  await dashboard.keyboard.press("Control+Enter");

  await expect(dialog).toBeHidden();
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
});

test("an Agent SDK Fable 5 session uses its 1M context window", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, { model: "claude-fable-5" });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toContainText("Agent SDK");
  await expect(card).toContainText("Fable 5");
  await expect(card).toContainText("1M");
  await expect(card).toContainText("18%");
  await expect(card).not.toContainText("92%");
});

test("Complete closes promptly while an accepted SDK stop drains", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, { task: "E2E_SLOW_SESSION_STOP finish and close" });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();

  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Complete & close" }).click();

  // The fake keeps its SDK subprocess alive for four seconds after stdin closes. The modal
  // must follow the daemon's accepted stop rather than that later process exit and pump
  // drain. Completing also closes the selected Console detail immediately, while the
  // daemon truthfully reports the stopping state until the SDK process finishes draining.
  await expect(dialog).toBeHidden({ timeout: 1_500 });
  await expect(card.getByText("No session selected")).toBeVisible();
  await expect(card.getByRole("button", { name: "Complete" })).toHaveCount(0);
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string }>>(daemon, "/api/sessions");
    return sessions[0]?.state ?? "missing";
  }).toBe("stopping");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    console.log("OBSERVED Complete closed while the accepted SDK stop was still draining");
    await card.screenshot({
      path: `${EVIDENCE}complete-stopping-state.png`,
    });
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/complete-stopping-state.png");
  }
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string }>>(daemon, "/api/sessions");
    return sessions[0]?.state ?? "removed";
  }, { timeout: 10_000 }).toMatch(/^(exited|removed)$/);
});

test("typing into the conversation gets a reply back from the agent", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");

  // The composer is disabled until the session can be written to. For an SDK session
  // `canMessage` is true as soon as the runtime is known, but the card renders before the
  // driver has bound - so this is a real wait, not a sleep.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();

  // Binding makes the composer writable before the dispatched opening turn is necessarily
  // done. Wait for both halves of that completion before sending a new turn; otherwise this
  // test races the intentional queued-turn path and can leave its first assertion waiting on
  // a message that was correctly queued behind the opener. The card can already say idle
  // when passive transcript polling sees the answer just before the SDK's `result` frame is
  // consumed, so use the driver's durable turn boundary from the isolated fixture database.
  // This is a read-only synchronization point; the daemon remains the only writer.
  const [{ id: sessionId }] = await api<Array<{ id: string }>>(daemon, "/api/sessions");
  const waitForDriverIdle = async (): Promise<void> => {
    await expect.poll(async () => {
      const turnInProgress = withDaemonDb(daemon, (db) => {
        const row = db.prepare(
          "SELECT turn_in_progress FROM sdk_sessions WHERE id = ?",
        ).get(sessionId) as { turn_in_progress: number } | undefined;
        return row?.turn_in_progress ?? null;
      });
      const current = (await api<Array<{ id: string; pendingTurns: unknown[] }>>(
        daemon,
        "/api/sessions",
      )).find((session) => session.id === sessionId);
      return {
        pendingTurns: current?.pendingTurns.length ?? null,
        turnInProgress,
      };
    }).toEqual({ pendingTurns: 0, turnInProgress: 0 });
    await expect.poll(async () => {
      const current = (await api<Array<{
        id: string;
        lastActivity: number | null;
        state: string;
      }>>(daemon, "/api/sessions")).find((session) => session.id === sessionId);
      return current?.state === "idle" && current.lastActivity !== null
        ? Date.now() - current.lastActivity
        : 0;
    }).toBeGreaterThanOrEqual(1_500);
  };
  /**
   * A RECORDED turn carrying this text - never the live activity line above it.
   *
   * `.turn-progress` echoes what the session reports it is doing right now, and for this fake
   * that is the first line of the very reply being waited on. So while a turn is in flight the
   * same string is on screen twice, in `.turn-progress-text` and in the transcript's own
   * `.turn-text`, and an unscoped `getByText` resolves to two elements - a strict-mode violation
   * that fails as if the reply never arrived. Seen on a loaded machine under the full suite.
   */
  const turn = (text: string): Locator => card.locator(".turn").getByText(text, { exact: true });

  await expect(turn(`Mock reply to: ${TASK}`)).toBeVisible();
  await waitForDriverIdle();

  // Three messages, each with a distinct reply. A single message would pass even if only
  // the first turn ever rendered - the failure mode where a transcript binds once and then
  // stops following the file.
  const messages = ["first message", "second message", "third message"];
  for (const message of messages) {
    await reply.fill(message);
    await reply.press("Enter");
    await expect(turn(`Mock reply to: ${message}`)).toBeVisible();
    await waitForDriverIdle();
  }

  // All three are still on screen together - the conversation accumulated rather than
  // replacing itself - and the user's own turns are rendered too, not just the replies.
  for (const message of messages) {
    await expect(turn(`Mock reply to: ${message}`)).toBeVisible();
    await expect(turn(message)).toBeVisible();
  }

  // Visual evidence of the SUCCESSFUL path. Playwright's own `screenshot` setting captures
  // only on failure, which means a green run leaves nothing a reviewer can look at - and
  // "the conversation renders" is a claim that deserves to be seen rather than read.
  //
  // Behind an env flag, and gitignored, because the alternative is a binary that changes on
  // every run: the detail carries a relative timestamp and a fresh worktree uuid, so an
  // unconditional capture would churn the repository for no added signal. Regenerate with
  // `MC_E2E_EVIDENCE=1 npm run test:e2e`. This follows the same shape as the `*-evidence`
  // generators under `scripts/`, which also produce pull-request artifacts on demand.
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // The Console detail is a fixed-height pane and its log scrolls, so a plain capture shows
    // only the last turn and a half. Unclip both FOR THE CAPTURE ONLY, so one image holds
    // all six turns. This changes nothing the test asserted - every expectation above has
    // already passed against the real, clipped layout - and the clipping itself is covered
    // by `test/transcript-scroll-electron.test.ts`, which measures used height.
    await card.evaluate((el: HTMLElement) => {
      el.style.height = "auto";
      const log = el.querySelector<HTMLElement>(".transcript-log");
      if (log) {
        log.style.maxHeight = "none";
        log.style.height = "auto";
      }
    });
    await card.screenshot({
      path: `${EVIDENCE}conversation.png`,
    });
  }
});

test("Ship it starts No-Mistakes Review through the workflow route", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();
  // IDLE, not merely present. `dispatch` returns when the modal closes, which is well before
  // the launch turn ends - and the end of that turn runs the wrap-up flow, which ANSWERS the
  // ask this test is about to arm. Arming it first is a race the test loses about one run in
  // three under load: the Queue panel opens on time and simply has no Ship it choice in it,
  // because something answered it in between. Waiting here is the same gate the workflow
  // specs use, and it is what the note below was reaching for.
  await expect.poll(async () => {
    const live = (await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
      .filter((session) => session.state !== "exited");
    return live.length === 1 ? live[0]!.state : `${live.length} sessions`;
  }, { timeout: 60_000 }).toBe("idle");
  const sessions = await api<Array<{ id: string }>>(daemon, "/api/sessions");
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0]!.id;

  // Keep this on the manual path. Foreman's shipped workflow mode can otherwise claim the
  // ask between the route below and the click, proving automation rather than this control.
  await api(daemon, "/api/foreman/config", { wrapup: "ask" }, "PUT");
  await api(daemon, `/api/sessions/${sessionId}/queue/wrapup/asked`, {
    clearAnswer: true,
  });

  // Wait for the daemon to actually be holding an OPEN ask before opening the queue.
  //
  // The Ship it choice renders off `queue.wrapupAskedAt !== null` with the ask unanswered,
  // and both routes above are writes whose result reaches the browser over SSE. Clicking
  // straight after them is a hope, not a wait: on a loaded machine the dispatch's opening
  // turn is still settling, and the session upsert that carries the ask can land after the
  // panel has already rendered without it. `expect.poll` on the daemon's own projection is
  // the barrier - the e2e rule that anything outside the DOM gets polled rather than
  // assumed. It asserts the precondition this test needs, so a genuinely missing ask still
  // fails here rather than being papered over further down.
  await expect.poll(async () => {
    const session = (await api<Array<{
      id: string;
      queue: { wrapupAskedAt: number | null; wrapupAnswered: boolean } | null;
    }>>(daemon, "/api/sessions")).find((candidate) => candidate.id === sessionId);
    return session?.queue?.wrapupAskedAt !== null && session?.queue?.wrapupAnswered === false;
  }, { timeout: 40_000 }).toBe(true);

  await card.getByRole("tab", { name: "Work queue" }).click();
  const review = card.getByRole("button", { name: "Run No-Mistakes Review" });
  await expect(review).toBeVisible();
  await expect(card.getByLabel("Direct shipping instruction")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send direct PR instruction" })).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // eslint-disable-next-line no-console
    console.log('OBSERVED Ship it panel exposes "Run No-Mistakes Review" beside the direct shipping path');
    await card.screenshot({
      path: `${EVIDENCE}ship-it-review-control.png`,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/ship-it-review-control.png");
  }

  const request = dashboard.waitForRequest((candidate) =>
    candidate.method() === "POST"
    && candidate.url().endsWith(
      `/api/sessions/${encodeURIComponent(sessionId)}/workflow-review`,
    )
  );
  // The card is still settling around this button; click it once it has stopped moving.
  await settled(card);
  await review.click();
  const confirmation = dashboard.getByRole("dialog", { name: "Run No-Mistakes Review" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Run review" }).click();
  const sent = await request;
  expect(sent.postDataJSON()).toEqual({ requestId: expect.any(String), evidence: [] });
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // eslint-disable-next-line no-console
    console.log("OBSERVED POST /api/sessions/:id/workflow-review with a requestId");
  }

  await expect(review).toBeHidden();
  let runId = "";
  let runVersion = 0;
  await expect.poll(async () => {
    const page = await api<{
      items: Array<{
        id: string;
        workflowName: string;
        workflowVersion: number;
        sessionId: string;
      }>;
    }>(daemon, "/api/workflow-runs");
    const run = page.items.find((candidate) =>
      candidate.workflowName === "No-Mistakes Review" && candidate.sessionId === sessionId
    );
    runId = run?.id ?? "";
    runVersion = run?.workflowVersion ?? 0;
    return Boolean(run);
  }).toBe(true);

  // Finish on the user-visible result, not only the durable API record. This is the same
  // run the Ship it control created through the request observed above.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${encodeURIComponent(runId)}`);
  const selectedRun = dashboard.locator(".wf-run-row.active");
  await expect(selectedRun).toContainText("No-Mistakes Review");
  await expect(selectedRun).toContainText(`v${runVersion}`);
  await expect(dashboard.locator(".wf-run-reader")).toContainText("No-Mistakes Review");

  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log(
      `OBSERVED Runs monitor selected the created No-Mistakes Review v${runVersion} run`,
    );
    await dashboard.screenshot({
      path: `${EVIDENCE}ship-it-review-run.png`,
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/ship-it-review-run.png");
  }
});

test("Foreman completion safeguards default on and persist independently", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  await dashboard.getByRole("tab", { name: "Safety" }).click();

  const scout = dashboard.getByRole("checkbox", {
    name: "Skip automatic completion for Scout tasks",
  });
  const artifacts = dashboard.getByRole("checkbox", {
    name: "Skip automatic completion for mockups and review artifacts",
  });
  await expect(scout).toBeVisible();
  await expect(artifacts).toBeVisible();
  await expect(scout).toBeChecked();
  await expect(artifacts).toBeChecked();
  const recoveryWait = dashboard.getByRole("spinbutton", {
    name: "Quiet minutes before first recovery",
  });
  await expect(recoveryWait).toHaveValue("20");

  await artifacts.uncheck();
  await expect.poll(async () => {
    const config = await api<{
      skipScoutWrapup: boolean;
      skipReviewArtifactWrapup: boolean;
    }>(daemon, "/api/foreman/config");
    return {
      scout: config.skipScoutWrapup,
      artifacts: config.skipReviewArtifactWrapup,
    };
  }).toEqual({ scout: true, artifacts: false });
  await recoveryWait.fill("37");
  await recoveryWait.blur();
  await expect.poll(async () => {
    const config = await api<{ shipRecoveryMinutes: number }>(daemon, "/api/foreman/config");
    return config.shipRecoveryMinutes;
  }).toBe(37);

  await dashboard.reload();
  await dashboard.getByRole("tab", { name: "Safety" }).click();
  await expect(scout).toBeChecked();
  await expect(artifacts).not.toBeChecked();
  await expect(recoveryWait).toHaveValue("37");
});

test("Foreman removes automatic review and separates CI follow-through from review comments", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/foreman/config", {
    enabled: true,
    wrapup: "ask",
    trackReviewFeedback: true,
    trackCiFailures: true,
    keepShipTasksMoving: true,
  }, "PUT");
  await dashboard.goto(daemon.baseURL);

  await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const popover = dashboard.getByRole("dialog", { name: "Foreman settings" });
  await expect(popover).toBeVisible();
  await expect(popover.getByText("Run No-Mistakes Review automatically")).toHaveCount(0);
  await expect(popover.getByRole("radio", { name: /Ask me/ })).toBeVisible();
  await expect(popover.getByRole("radio", { name: /Straight to PR/ })).toBeVisible();

  const comments = popover.getByRole("checkbox", {
    name: "Keep sessions on track with review comments",
  });
  const ci = popover.getByRole("checkbox", { name: "Keep sessions on track with CI" });
  const recovery = popover.getByRole("checkbox", { name: "Keep pre-PR ship tasks moving" });
  await expect(recovery).toBeChecked();
  await expect(comments).toBeChecked();
  await expect(ci).toBeChecked();
  await expect(popover).toContainText(
    "Does not create a PR. Once one exists, sends failing CI back to its session.",
  );

  await captureForemanEvidence(popover);

  await recovery.uncheck();
  await ci.uncheck();
  await expect.poll(async () => {
    const config = await api<{
      trackReviewFeedback: boolean;
      trackCiFailures: boolean;
      keepShipTasksMoving: boolean;
    }>(daemon, "/api/foreman/config");
    return {
      comments: config.trackReviewFeedback,
      ci: config.trackCiFailures,
      recovery: config.keepShipTasksMoving,
    };
  }).toEqual({ comments: true, ci: false, recovery: false });

  await dashboard.reload();
  await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const reopened = dashboard.getByRole("dialog", { name: "Foreman settings" });
  await expect(reopened.getByRole("checkbox", {
    name: "Keep sessions on track with review comments",
  })).toBeChecked();
  await expect(reopened.getByRole("checkbox", {
    name: "Keep sessions on track with CI",
  })).not.toBeChecked();
  await expect(reopened.getByRole("checkbox", {
    name: "Keep pre-PR ship tasks moving",
  })).not.toBeChecked();
});

test("Foreman recovers one settled pre-PR ship turn, records it, and stops at the open PR", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  await dispatch(dashboard, daemon, {
    task: "Implement the retry path and leave shipping to Mission Control",
    kind: "ship",
  });
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  await expect(detail).toBeVisible();

  type RecoverySession = {
    id: string;
    agent: string;
    agentSessionId: string | null;
    cwd: string;
    repoRoot: string | null;
    state: string;
    goal: {
      relationship: string | null;
      promptRevision: number;
      resolvedPromptRevision: number;
    } | null;
    workCycle: {
      logicalKey: string;
      generation: number;
      active: boolean;
      completedAt: number | null;
    } | null;
  };
  let session: RecoverySession | null = null;
  await expect.poll(async () => {
    session = (await api<RecoverySession[]>(daemon, "/api/sessions"))[0] ?? null;
    return session?.agentSessionId ?? null;
  }, { timeout: 30_000 }).not.toBeNull();
  if (!session?.agentSessionId) throw new Error("the dispatched ship session did not bind");
  const logicalKey = session.agentSessionId;

  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const hook = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId,
      cwd: session.cwd,
      env: {},
    }),
  });
  expect(hook.status, await hook.clone().text()).toBe(204);

  let generation = 0;
  await expect.poll(async () => {
    const current = (await api<RecoverySession[]>(daemon, "/api/sessions"))
      .find((candidate) => candidate.agentSessionId === logicalKey) ?? null;
    if (current?.workCycle && !current.workCycle.active && current.workCycle.completedAt !== null) {
      session = current;
      generation = current.workCycle.generation;
    }
    return current ? {
      state: current.state,
      relationship: current.goal?.relationship ?? null,
      revisions: current.goal
        ? [current.goal.resolvedPromptRevision, current.goal.promptRevision]
        : null,
      cycle: current.workCycle
        ? [
            current.workCycle.logicalKey === logicalKey,
            current.workCycle.generation,
            current.workCycle.active,
            current.workCycle.completedAt !== null,
          ]
        : null,
    } : null;
  }, {
    message: "the exact ship session should have a settled intent and completed work cycle",
    timeout: 30_000,
  }).toEqual({
    state: "idle",
    relationship: "initial",
    revisions: [1, 1],
    cycle: [true, expect.any(Number), false, true],
  });
  if (!session) throw new Error("the completed ship session disappeared");

  const goal = await api<{
    objective: string;
    objectiveVersion: number;
    promptRevision: number;
  }>(daemon, `/api/sessions/${session.id}/goal`);
  const consumed = await fetch(`${daemon.baseURL}/api/sessions/${session.id}/queue/wrapup/prompted`, {
    method: "POST",
    headers: { host: new URL(daemon.baseURL).host, "content-type": "application/json" },
    body: JSON.stringify({
      logicalKey,
      generation,
      expectedIntent: {
        objective: goal.objective,
        objectiveVersion: goal.objectiveVersion,
        promptRevision: goal.promptRevision,
        episodeKey: `intent:${goal.objectiveVersion}:${goal.promptRevision}`,
      },
      decision: {
        outcome: "held",
        summary: "The built recovery path still needs focused browser coverage.",
        gaps: [{
          id: "browser-recovery",
          path: "e2e/specs/dispatch-and-converse.spec.ts",
          detail: "Cover the built recovery path.",
        }],
      },
    }),
  });
  expect(consumed.status, await consumed.clone().text()).toBe(200);
  await api(daemon, "/api/foreman/config", {
    enabled: true,
    mode: "live",
    repoAllowlist: [session.repoRoot ?? session.cwd],
    wrapupTriggers: [],
    keepShipTasksMoving: true,
    shipRecoveryMinutes: 1,
  }, "PUT");

  // The minimum is a real operator minute. Age the actual session rather than adding a
  // test-only clock or weakening the production threshold.
  await dashboard.waitForTimeout(61_000);
  await daemon.startForeman();
  await expect.poll(async () => {
    const queue = await api<{
      promptedRecovery?: { reason: string; attempt: number; lastDelivery: string } | null;
    }>(daemon, `/api/sessions/${session!.id}/queue`);
    return queue.promptedRecovery ?? null;
  }, {
    message: `Foreman did not deliver the held-gap recovery:\n${daemon.readLog()}`,
    timeout: 40_000,
  }).toMatchObject({ reason: "held_gaps", attempt: 1, lastDelivery: "delivered" });

  await expect(detail.getByText(/Mock reply to: Foreman's completion review found blocking work/))
    .toBeVisible({ timeout: 30_000 });
  // The note and its episode are separate worker requests. Under full-suite contention the
  // browser can refetch history after the note lands but before the episode does, leaving the
  // chip stale even though the durable record is correct. This test owns the RECORDED recovery,
  // not that independent live-fetch race: wait for its record, then read it from a fresh pane.
  await expect.poll(async () => {
    const episodes = await api<Array<{ situation: string }>>(
      daemon,
      `/api/sessions/${session!.id}/foreman-episodes`,
    );
    return episodes.filter((episode) => episode.situation === "ship-recovery").length;
  }, { timeout: 30_000 }).toBe(1);
  await dashboard.reload();
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: /Foreman · 1/ })).toBeVisible({ timeout: 30_000 });
  await detail.getByRole("button", { name: /Foreman · 1/ }).click();
  await detail.getByRole("button", {
    name: /Keep managed ship task moving before its first pull request/,
  }).click();
  const recoveryRecord = detail.getByRole("complementary");
  await expect(recoveryRecord.getByText("pre-PR ship recovery", { exact: true })).toBeVisible();
  await expect(recoveryRecord.getByText(/held completion gaps; attempt 1\/3; delivered/))
    .toBeVisible();

  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: session.cwd,
    encoding: "utf8",
  }).trim();
  writeGhPullRequests(daemon.home, [{
    cwd: session.cwd,
    url: "https://github.com/acme/mission-e2e/pull/27",
    number: 27,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: null,
    headRefOid: head,
  }]);
  const prHook = await fetch(`${daemon.baseURL}/hooks/PostToolUse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: logicalKey,
      cwd: session.cwd,
      toolName: "Bash",
      prCreated: true,
      prUrl: "https://github.com/acme/mission-e2e/pull/27",
      prUrls: ["https://github.com/acme/mission-e2e/pull/27"],
    }),
  });
  expect(prHook.status, await prHook.clone().text()).toBe(204);
  const prStop = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: logicalKey,
      cwd: session.cwd,
      env: {},
    }),
  });
  expect(prStop.status, await prStop.clone().text()).toBe(204);
  await expect.poll(async () => {
    const current = (await api<Array<{ agentSessionId: string | null; prState: string | null }>>(
      daemon,
      "/api/sessions",
    )).find((candidate) => candidate.agentSessionId === logicalKey);
    return current?.prState ?? null;
  }, { timeout: 40_000 }).toBe("open");
  const openPrLink = detail.getByRole("link", { name: /#27/ });
  await expect(openPrLink).toBeVisible();

  const before = await api<Array<{ situation: string }>>(
    daemon,
    `/api/sessions/${session.id}/foreman-episodes`,
  );
  await dashboard.waitForTimeout(5_000);
  const afterOpenPr = await api<Array<{ situation: string }>>(
    daemon,
    `/api/sessions/${session.id}/foreman-episodes`,
  );
  expect(afterOpenPr.filter((episode) => episode.situation === "ship-recovery")).toHaveLength(
    before.filter((episode) => episode.situation === "ship-recovery").length,
  );

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await detail.screenshot({ path: join(EVIDENCE, "pre-pr-ship-recovery.png") });
    await recoveryRecord.getByRole("button", { name: "Close" }).click();
    await expect(recoveryRecord).toBeHidden();
    await expect(openPrLink).toBeVisible();
    await detail.screenshot({ path: join(EVIDENCE, "pre-pr-open-pr-boundary.png") });
    // eslint-disable-next-line no-console
    console.log("OBSERVED one delivered pre-PR recovery in the session ledger and open PR #27");
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/pre-pr-ship-recovery.png");
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/pre-pr-open-pr-boundary.png");
  }
});

/**
 * The Foreman card is taller than a short window, and the tail of it must stay reachable.
 *
 * This is a regression test with a real failure behind it. The card is anchored under the
 * topbar and had no height bound, so on a short window - or simply a topbar that had grown
 * a second row - it ran off the bottom edge with no scroll container. The controls down
 * there were not merely clipped, they were unclickable: `uncheck()` on the CI row spent its
 * whole budget reporting `element is outside of the viewport`. It reproduced on CI while
 * passing locally, because how far down the card starts depends on the topbar's height.
 *
 * 560px is chosen to be shorter than the card's own content, which is what forces the
 * overflow deterministically instead of depending on the topbar. The assertion is the one
 * that matters to a person: the card ends inside the window, and the last control in it
 * still takes a click.
 */
test.describe(() => {
  test.use({ viewport: { width: 1280, height: 560 } });

  test("a Foreman card taller than the window scrolls instead of running off it", async ({
    dashboard,
    daemon,
  }) => {
    await api(daemon, "/api/foreman/config", { enabled: true, trackCiFailures: true }, "PUT");
    await dashboard.goto(daemon.baseURL);
    await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();

    const popover = dashboard.getByRole("dialog", { name: "Foreman settings" });
    await expect(popover).toBeVisible();

    const box = await popover.evaluate((el) => ({
      overflows: el.scrollHeight > el.clientHeight,
      bottom: Math.round(el.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
    }));
    // The defect, stated as a person meets it: the card ended below the window.
    expect(box.bottom).toBeLessThanOrEqual(box.viewport);
    // And the card really is taller than the room it has, so the above is not vacuous.
    expect(box.overflows).toBe(true);

    // And the control that was unreachable takes a click and persists.
    const ci = popover.getByRole("checkbox", { name: "Keep sessions on track with CI" });
    await ci.uncheck();
    await expect.poll(async () => {
      const config = await api<{ trackCiFailures: boolean }>(daemon, "/api/foreman/config");
      return config.trackCiFailures;
    }).toBe(false);
  });
});

test("Foreman never resurfaces Ship it actions after a scout completes", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, {
    task: "Compare the fleet layouts and report the findings",
    kind: "scout",
  });
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();

  await expect.poll(async () =>
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).length
  ).toBe(1);
  let session: {
    id: string;
    agent: string;
    agentSessionId: string | null;
    cwd: string;
  } | null = null;
  await expect.poll(async () => {
    const sessions = await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions");
    session = sessions[0] ?? null;
    return session?.agentSessionId ?? null;
  }, {
    message: "the SDK session should bind its conversation before Foreman observes it",
  }).not.toBeNull();
  if (!session) throw new Error("the dispatched scout never appeared in the fleet");
  const sessionId = session.id;

  // Make the forbidden surface present first. This proves the same detail can render the
  // controls and makes the later absence meaningful rather than a selector that never
  // matched. Answer the seeded ask before starting Foreman, then watch for any transient
  // reappearance while the real worker retires the scout completion.
  await api(daemon, "/api/foreman/config", {
    enabled: true,
    wrapup: "ask",
    wrapupTriggers: ["prompted"],
  }, "PUT");
  await api(daemon, `/api/sessions/${sessionId}/queue/wrapup/asked`, {
    clearAnswer: true,
  });
  // Wait for the daemon to actually be holding an OPEN ask before opening the queue - the
  // same barrier, for the same reason, as the sibling Ship it test above. Both routes are
  // writes whose result reaches the browser over SSE, so clicking straight after them is a
  // hope rather than a wait: on a loaded machine the dispatch's opening turn is still
  // settling and the session upsert carrying the ask can land after the panel has already
  // rendered without it. Observed as this test failing on the full-file run while passing in
  // isolation. The poll asserts the precondition the click needs, so a genuinely missing ask
  // still fails here rather than being papered over.
  await expect.poll(async () => {
    const current = (await api<Array<{
      id: string;
      queue: { wrapupAskedAt: number | null; wrapupAnswered: boolean } | null;
    }>>(daemon, "/api/sessions")).find((candidate) => candidate.id === sessionId);
    return current?.queue?.wrapupAskedAt !== null && current?.queue?.wrapupAnswered === false;
  }, { timeout: 40_000 }).toBe(true);
  await card.getByRole("tab", { name: "Work queue" }).click();
  await expect(card.getByRole("button", { name: "Run No-Mistakes Review" })).toBeVisible();
  await expect(card.getByLabel("Direct shipping instruction")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send direct PR instruction" })).toBeVisible();

  const seededAnswer = "e2e:cleared-before-scout-completion";
  await api(daemon, `/api/sessions/${sessionId}/queue/wrapup`, {
    answer: seededAnswer,
  }, "PUT");
  await expect(card.getByRole("button", { name: "Run No-Mistakes Review" })).toBeHidden();

  // The SDK acknowledgement already supplied the accepted human prompt and resolved
  // objective. The fake does not run machine-installed Claude hooks, so supply only the
  // completion event Foreman needs as proof that this idle session completed a work cycle.
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const postHook = async (event: string, body: Record<string, unknown>): Promise<void> => {
    const hook = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: session.agent,
        sessionId: session.agentSessionId,
        cwd: session.cwd,
        env: {},
        ...body,
      }),
    });
    expect(hook.status, `the ${event} hook was accepted: ${await hook.clone().text()}`).toBe(204);
  };
  await postHook("Stop", {});
  let completedGeneration: number | null = null;
  await expect.poll(async () => {
    const current = (await api<Array<{
      id: string;
      hooksSeen: boolean;
      instrumented: boolean;
      workCycle: {
        generation: number;
        active: boolean;
        completedAt: number | null;
      } | null;
      goal: {
        relationship: string | null;
        promptRevision: number;
        resolvedPromptRevision: number;
      } | null;
    }>>(daemon, "/api/sessions")).find((candidate) => candidate.id === sessionId);
    if (current?.workCycle && !current.workCycle.active && current.workCycle.completedAt !== null) {
      completedGeneration = current.workCycle.generation;
    }
    return current ? {
      hooksSeen: current.hooksSeen,
      instrumented: current.instrumented,
      relationship: current.goal?.relationship ?? null,
      revisions: current.goal
        ? [current.goal.resolvedPromptRevision, current.goal.promptRevision]
        : null,
      cycle: current.workCycle
        ? [current.workCycle.generation, current.workCycle.active, current.workCycle.completedAt !== null]
        : null,
    } : null;
  }, {
    message: "the completion hooks should leave a fresh objective and completed work cycle",
    timeout: 30_000,
  }).toEqual({
    hooksSeen: true,
    instrumented: true,
    relationship: "initial",
    revisions: [1, 1],
    cycle: [expect.any(Number), false, true],
  });
  if (completedGeneration === null) throw new Error("the scout work cycle never completed");

  await dashboard.evaluate(() => {
    type ShippingProbe = {
      seen: boolean;
      observer: MutationObserver;
    };
    const target = window as typeof window & { __mcShippingProbe?: ShippingProbe };
    target.__mcShippingProbe?.observer.disconnect();
    const probe = { seen: false } as ShippingProbe;
    probe.observer = new MutationObserver(() => {
      if (document.querySelector(".wq-wrapup")) probe.seen = true;
    });
    probe.observer.observe(document.body, { childList: true, subtree: true });
    target.__mcShippingProbe = probe;
  });

  await daemon.startForeman();
  await expect.poll(async () => {
    const queue = await api<{ promptedConsumedGeneration: number | null }>(
      daemon,
      `/api/sessions/${sessionId}/queue`,
    );
    return queue.promptedConsumedGeneration;
  }, {
    message: `Foreman did not consume the scout work-cycle generation:\n${daemon.readLog()}`,
    timeout: 40_000,
  }).toBe(completedGeneration);

  const completion = await api<{
    wrapupAnswer: string | null;
    promptedGoal: string | null;
    promptedConsumedGeneration: number | null;
  }>(
    daemon,
    `/api/sessions/${sessionId}/queue`,
  );
  expect(completion.wrapupAnswer).toBe(seededAnswer);
  expect(completion.promptedGoal).toBeNull();
  expect(completion.promptedConsumedGeneration).toBe(completedGeneration);
  const shippingSurfaceAppeared = await dashboard.evaluate(() => {
    type ShippingProbe = { seen: boolean; observer: MutationObserver };
    const target = window as typeof window & { __mcShippingProbe?: ShippingProbe };
    const seen = target.__mcShippingProbe?.seen ?? false;
    target.__mcShippingProbe?.observer.disconnect();
    return seen;
  });
  expect(shippingSurfaceAppeared).toBe(false);
  await expect(card.getByRole("button", { name: "Run No-Mistakes Review" })).toHaveCount(0);
  await expect(card.getByLabel("Direct shipping instruction")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send direct PR instruction" })).toHaveCount(0);
});

test("the dispatched agent was launched headless, without the daemon's terminal identity", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  interface Invocation {
    argv: string[];
    cwd: string;
    tmuxPane: string | null;
    weztermPane: string | null;
    termProgram: string | null;
    entrypoint: string | null;
  }

  // The fake records its own argv and env, so the mock doubles as an assertion surface:
  // these are properties of the launch that no amount of DOM inspection could reach.
  const dir = join(daemon.recordDir, "claude");
  const read = (): Invocation[] => recordsIn<Invocation>(dir);

  // POLLED, not read once. The card appears as soon as the daemon registers the session,
  // which is BEFORE the child process it launched has run far enough to write anything -
  // and a plain `readdirSync` here fails about one run in six. Playwright's auto-waiting
  // covers locators, not the filesystem, so the retry has to be asked for explicitly.
  //
  // A dispatch launches the binary through TWO unrelated paths, and waiting for only one of
  // them is how half the spend goes unnoticed. The titler is an app-owned Agent SDK one-shot
  // with no setting sources; the session is a long-lived Agent SDK stream that inherits the
  // interactive setting sources. Both must land on the fake, or an e2e run bills a real account.
  await expect
    .poll(() => read().map((r) => (
      r.argv.includes("--setting-sources=")
        ? "headless-sdk"
        : r.argv.includes("--input-format")
          ? "session-sdk"
          : "other"
    )).sort(), {
      message: "both the headless SDK titler and the SDK session should have launched the fake",
    })
    .toEqual(expect.arrayContaining(["headless-sdk", "session-sdk"]));

  const records = read();
  const oneShot = records.find((r) => r.argv.includes("--setting-sources="));
  expect(oneShot?.argv).toEqual(
    expect.arrayContaining(["--output-format", "stream-json", "--input-format", "stream-json"]),
  );
  expect(oneShot?.entrypoint).toBe("sdk-ts");

  const record = records.find(
    (r) => r.argv.includes("--input-format") && !r.argv.includes("--setting-sources="),
  );
  expect(record).toBeDefined();
  if (!record) return;

  // The SDK's own contract with the CLI.
  expect(record.argv).toEqual(
    expect.arrayContaining(["--output-format", "stream-json", "--input-format", "--permission-mode"]),
  );
  expect(record.entrypoint).toBe("sdk-ts");

  // `sdkSubprocessEnv` strips these three deliberately: the machine-installed hooks fire
  // inside this subprocess exactly as they do in a pane, and a daemon started from a
  // terminal would otherwise hand its own pane down to every session it launches - which
  // once fused two different real cards onto one headless run.
  //
  // The daemon was seeded with a recognisable identity for exactly this assertion
  // (`DAEMON_TERMINAL_IDENTITY`), so `null` here means the strip ran rather than meaning the
  // variable was never set. Asserted against the sentinel FIRST, because that is the failure
  // that reads as a leak; the null check then covers a partial strip that blanks instead of
  // deletes.
  for (const [key, sentinel, actual] of [
    ["TMUX_PANE", DAEMON_TERMINAL_IDENTITY.TMUX_PANE, record.tmuxPane],
    ["WEZTERM_PANE", DAEMON_TERMINAL_IDENTITY.WEZTERM_PANE, record.weztermPane],
    ["TERM_PROGRAM", DAEMON_TERMINAL_IDENTITY.TERM_PROGRAM, record.termProgram],
  ] as const) {
    expect(actual, `${key} leaked the daemon's own terminal identity into a dispatched session`)
      .not.toBe(sentinel);
    expect(actual, `${key} must not reach a dispatched session at all`).toBeNull();
  }

  // And it ran in the worktree the dispatch cut, not in the repo or the daemon's cwd.
  expect(record.cwd).toContain(join(daemon.home, "worktree-pools"));
});

/**
 * The launch contract Mission Control composes around the operator's request.
 *
 * Every dispatch appends the shared execution authorization, so this heading is in the
 * prompt the agent is given on every single ship task and is in NONE of the operator's own
 * words. It is therefore the exact string that separates "what a person asked for" from
 * "what the platform told the agent", and both halves of this spec turn on it.
 */
const PLATFORM_ONLY_LAUNCH_LINE = "## Mission Control execution authorization";

/**
 * The dispatch prompt for the launch-presentation case, deliberately unlike the other
 * tasks in this file: a short, complete sentence, so "the visible turn is exactly the
 * human request" can be asserted as an exact string rather than as a prefix.
 */
const HUMAN_REQUEST = "tidy the flexbox helper and add a test";

test("a managed launch shows only the human task request, and the agent still gets the whole prompt", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, { task: HUMAN_REQUEST });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  // The agent has replied, so the launch turn has certainly been written and read back.
  await expect(detail.locator(".turn").getByText(`Mock reply to: ${HUMAN_REQUEST}`)).toBeVisible();

  const log = detail.locator(".transcript-log");
  /**
   * The operator's OWN turns, in whichever rendering is up.
   *
   * Scoped to them rather than to the whole log, and the reason is a property of the
   * fixture that would otherwise make this spec dishonest: the fake agent echoes the prompt
   * it was given, so the launch contract is legitimately inside the AGENT's reply. That is
   * the agent quoting its instructions, which this feature does not touch and must not - the
   * claim being made here is about the turn attributed to the person.
   */
  const yourTurns = (author: "you" = "you"): Locator =>
    log.locator(`article[aria-label="${author}"]`);

  // 1. The visible first user turn is the human request and nothing else. Asserted as the
  //    turn's exact text, so an authorization block merely scrolled out of view fails here.
  await expect(yourTurns()).toHaveCount(1);
  await expect(yourTurns().locator(".turn-text")).toHaveText(HUMAN_REQUEST);

  // 2. The Native rendering draws the same projection. It is a second renderer over the
  //    same rows, which is exactly how a fix applied to only one of them would be caught.
  const terminalView = detail.getByRole("button", { name: "Terminal view" });
  await terminalView.click();
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
  // The terminal rendering draws a user turn as a command line rather than a bubble, so
  // the text lives under its own class. Same turn, same projection, different element.
  await expect(yourTurns()).toHaveCount(1);
  await expect(yourTurns().locator(".pty-command")).toHaveText(HUMAN_REQUEST);
  await terminalView.click();
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);

  // 3. Find-in-conversation cannot reach the hidden text - a hidden turn that is still
  //    searchable is the half-fix this asserts against - while the human request still is
  //    searchable, so find is looking at a real list. Under the "You" scope for the same
  //    reason the log assertions are: the agent's echo is a legitimate All-scope match.
  await detail.locator(".detail-body").focus();
  await dashboard.keyboard.press("Meta+f");
  const box = detail.getByRole("searchbox", { name: "Find in conversation" });
  const results = detail.getByRole("complementary", { name: "Search results" });
  await box.fill("Mission Control execution authorization");
  await results.getByRole("button", { name: "You", exact: true }).click();
  await expect(results).toContainText("Nothing matches");
  // And the All scope proves the query itself is not simply unmatchable - it finds the
  // agent's echo, so "no You matches" is a statement about attribution and not a typo.
  await results.getByRole("button", { name: "All", exact: true }).click();
  await expect(results).not.toContainText("Nothing matches");
  await box.fill("tidy the flexbox helper");
  await results.getByRole("button", { name: "You", exact: true }).click();
  await expect(results).not.toContainText("Nothing matches");
  // Closed from the box itself: find owns the rail's column while it is open, so the Yours
  // tab below is not mounted until this lands.
  await box.press("Escape");
  await expect(box).toHaveCount(0);

  // 4. The Yours rail indexes the human request under the operator's own name, not the
  //    platform contract typed on their behalf.
  const rail = detail.getByRole("region", { name: "Conversation rail" });
  await rail.getByRole("tab", { name: "Yours" }).click();
  await expect(rail.getByRole("button", { name: new RegExp(HUMAN_REQUEST) })).toBeVisible();
  await expect(rail).not.toContainText(PLATFORM_ONLY_LAUNCH_LINE);

  // Visual evidence of the asserted state, behind the same env flag and the same gitignored
  // path the rest of this file uses: "the first turn is the request you typed" is a claim
  // that deserves to be seen rather than only read. Every expectation above has already
  // passed against the real layout.
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // Park the pointer off the detail first: the Yours tab was just clicked, so its tooltip
    // is still open and lands over the controls above the log in the capture.
    await dashboard.mouse.move(0, 0);
    await expect(detail.getByText("The messages you sent in this conversation")).toHaveCount(0);
    console.log("OBSERVED the first user turn is the human task request, with no launch contract");
    console.log("OBSERVED the Yours rail indexes that same request");
    await detail.screenshot({ path: `${EVIDENCE}launch-turn-projection.png` });
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/launch-turn-projection.png");
  }

  // 5. A human follow-up with text overlapping the launch still renders and is searchable.
  //    Marker matching must be a fingerprint of one recorded turn, never "hide the first
  //    user message".
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  const followUp = `${HUMAN_REQUEST} in the smaller file too`;
  await reply.fill(followUp);
  await reply.press("Enter");
  await expect(detail.locator(".turn").getByText(followUp, { exact: true })).toBeVisible();

  // 6. Reloading re-reads the transcript from the daemon over a fresh stream. The launch
  //    text must not come back with it.
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const reopened = dashboard.locator(".console-detail");
  const reopenedLog = reopened.locator(".transcript-log");
  const reopenedYours = reopenedLog.locator('article[aria-label="you"]');
  await expect(reopenedYours.first().locator(".turn-text")).toHaveText(HUMAN_REQUEST);
  for (const text of await reopenedYours.allInnerTexts()) {
    expect(text).not.toContain(PLATFORM_ONLY_LAUNCH_LINE);
  }

  // 7. And the whole point: the agent was given the complete composed prompt. Read from
  //    the fake provider's own transcript file - written from the frame the driver sent it,
  //    so this is the provider boundary and not a server-side echo - and from the server's
  //    unprojected transcript route, which is what every evidence consumer reads.
  const sessions = await api<Array<{ id: string; transcriptPath: string | null }>>(
    daemon,
    "/api/sessions",
  );
  const live = sessions.find((candidate) => candidate.transcriptPath !== null);
  expect(live?.transcriptPath, "the fake provider wrote a transcript").toBeTruthy();
  const native = readFileSync(live!.transcriptPath!, "utf8");
  expect(native).toContain(PLATFORM_ONLY_LAUNCH_LINE);
  expect(native).toContain(HUMAN_REQUEST);

  const served = await api<{ messages: Array<{ role: string; text: string }> }>(
    daemon,
    `/api/sessions/${encodeURIComponent(live!.id)}/transcript`,
  );
  const launchTurn = served.messages.find((m) => m.role === "user");
  expect(launchTurn?.text).toContain(PLATFORM_ONLY_LAUNCH_LINE);
  expect(launchTurn?.text).toContain(HUMAN_REQUEST);
});
