import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import { DAEMON_TERMINAL_IDENTITY, type DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

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

  const card = dashboard.locator("article.card").first();
  await expect(card).toBeVisible();
  // Exactly one, not "at least one": the daemon has adopted the dispatch as a single
  // session rather than double-carding it, which is a real regression this repo has had.
  await expect(dashboard.locator("article.card")).toHaveCount(1);
  // Named by `deriveTitle`, which title-cases the intent. That is the SYNCHRONOUS name a
  // dispatch gets; `task-title.ts` refines it with a headless model call afterwards, so
  // asserting on the model's answer here would be racing an async refinement. What that
  // call went to instead is pinned in the launch spec below.
  await expect(card).toContainText("Write a Haiku About Flexbox");
  // Running on the SDK runtime, headless, with a worktree of its own.
  await expect(card).toContainText("Agent SDK");
  await expect(card).toContainText("worktrees/");
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
  await expect(dashboard.locator("article.card")).toHaveCount(1);
});

test("an Agent SDK Fable 5 session uses its 1M context window", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, { model: "claude-fable-5" });

  const card = dashboard.locator("article.card").first();
  await expect(card).toContainText("Agent SDK");
  await expect(card).toContainText("Fable 5");
  await expect(card).toContainText("1M");
  await expect(card).toContainText("18%");
  await expect(card).not.toContainText("92%");
});

test("Complete closes promptly while an accepted SDK stop drains", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, { task: "E2E_SLOW_SESSION_STOP finish and close" });

  const card = dashboard.locator("article.card").first();
  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();

  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Complete & close" }).click();

  // The fake keeps its SDK subprocess alive for four seconds after stdin closes. The modal
  // must follow the daemon's accepted stop rather than that later process exit and pump
  // drain, while the retained card truthfully becomes unavailable in between.
  await expect(dialog).toBeHidden({ timeout: 1_500 });
  await expect(card).toContainText("stopping");
  await expect(card.getByRole("button", { name: "Complete" })).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    console.log("OBSERVED Complete closed while the accepted SDK stop was still draining");
    await card.screenshot({
      path: `${EVIDENCE}complete-stopping-state.png`,
    });
    console.log("CAPTURED e2e/.artifacts/dispatch-and-converse/complete-stopping-state.png");
  }
  await expect(card).toContainText("exited", { timeout: 10_000 });
});

test("typing into the conversation gets a reply back from the agent", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

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
      const db = new DatabaseSync(join(daemon.home, "harness.db"));
      let turnInProgress: number | null;
      try {
        const row = db.prepare(
          "SELECT turn_in_progress FROM sdk_sessions WHERE id = ?",
        ).get(sessionId) as { turn_in_progress: number } | undefined;
        turnInProgress = row?.turn_in_progress ?? null;
      } finally {
        db.close();
      }
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
  // every run: the card carries a relative timestamp and a fresh worktree uuid, so an
  // unconditional capture would churn the repository for no added signal. Regenerate with
  // `MC_E2E_EVIDENCE=1 npm run test:e2e`. This follows the same shape as the `*-evidence`
  // generators under `scripts/`, which also produce pull-request artifacts on demand.
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // The expanded card is a fixed-height box and its log scrolls, so a plain capture shows
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
  const card = dashboard.locator("article.card").first();
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

  await card.getByRole("button", { name: "Queue" }).click();
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
  const sent = await request;
  expect(sent.postDataJSON()).toEqual({ requestId: expect.any(String) });
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

  await dashboard.reload();
  await dashboard.getByRole("tab", { name: "Safety" }).click();
  await expect(scout).toBeChecked();
  await expect(artifacts).not.toBeChecked();
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
  await expect(comments).toBeChecked();
  await expect(ci).toBeChecked();
  await expect(popover).toContainText(
    "Does not create a PR. Once one exists, sends failing CI back to its session.",
  );

  await captureForemanEvidence(popover);

  await ci.uncheck();
  await expect.poll(async () => {
    const config = await api<{
      trackReviewFeedback: boolean;
      trackCiFailures: boolean;
    }>(daemon, "/api/foreman/config");
    return {
      comments: config.trackReviewFeedback,
      ci: config.trackCiFailures,
    };
  }).toEqual({ comments: true, ci: false });

  await dashboard.reload();
  await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const reopened = dashboard.getByRole("dialog", { name: "Foreman settings" });
  await expect(reopened.getByRole("checkbox", {
    name: "Keep sessions on track with review comments",
  })).toBeChecked();
  await expect(reopened.getByRole("checkbox", {
    name: "Keep sessions on track with CI",
  })).not.toBeChecked();
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
  const card = dashboard.locator("article.card").first();
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

  // Make the forbidden surface present first. This proves the same card can render the
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
  await card.getByRole("button", { name: "Queue" }).click();
  await expect(card.getByRole("button", { name: "Run No-Mistakes Review" })).toBeVisible();
  await expect(card.getByLabel("Direct shipping instruction")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send direct PR instruction" })).toBeVisible();

  const seededAnswer = "e2e:cleared-before-scout-completion";
  await api(daemon, `/api/sessions/${sessionId}/queue/wrapup`, {
    answer: seededAnswer,
  }, "PUT");
  await expect(card.getByRole("button", { name: "Run No-Mistakes Review" })).toBeHidden();

  // The fake SDK speaks the agent protocol, but it does not run the machine-installed
  // Claude hooks. Supply the same prompt and completion events a real turn sends so Foreman
  // has both a resolved objective and proof that this idle card is instrumented, rather than
  // relying on the registry's conservative startup defaults. The exact agent conversation id
  // makes these real hook joins, not fixture-only database mutations.
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
  const scoutObjective = "Compare the fleet layouts and report the findings";
  await postHook("UserPromptSubmit", { prompt: scoutObjective });
  await postHook("Stop", {});
  await expect.poll(async () => {
    const current = (await api<Array<{
      id: string;
      hooksSeen: boolean;
      instrumented: boolean;
      goal: {
        relationship: string | null;
        promptRevision: number;
        resolvedPromptRevision: number;
      } | null;
    }>>(daemon, "/api/sessions")).find((candidate) => candidate.id === sessionId);
    return current ? {
      hooksSeen: current.hooksSeen,
      instrumented: current.instrumented,
      relationship: current.goal?.relationship ?? null,
      revisions: current.goal
        ? [current.goal.resolvedPromptRevision, current.goal.promptRevision]
        : null,
    } : null;
  }, {
    message: "the completion hooks should leave a fresh, fully reconciled scout objective",
    timeout: 30_000,
  }).toEqual({
    hooksSeen: true,
    instrumented: true,
    relationship: "initial",
    revisions: [1, 1],
  });

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
    const queue = await api<{ promptedGoal: string | null }>(
      daemon,
      `/api/sessions/${sessionId}/queue`,
    );
    return queue.promptedGoal;
  }, {
    message: `Foreman did not retire the scout completion:\n${daemon.readLog()}`,
    timeout: 40_000,
  }).not.toBeNull();

  const completion = await api<{ wrapupAnswer: string | null }>(
    daemon,
    `/api/sessions/${sessionId}/queue`,
  );
  expect(completion.wrapupAnswer).toBe(seededAnswer);
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
  expect(record.cwd).toContain("worktrees");
});
