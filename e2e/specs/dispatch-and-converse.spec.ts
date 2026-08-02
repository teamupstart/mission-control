import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { DAEMON_TERMINAL_IDENTITY, type DaemonHandle } from "../fixtures/daemon.ts";

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
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);

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

test("typing into the conversation gets a reply back from the agent", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

  // The composer is disabled until the session can be written to. For an SDK session
  // `canMessage` is true as soon as the runtime is known, but the card renders before the
  // driver has bound - so this is a real wait, not a sleep.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();

  // Three messages, each with a distinct reply. A single message would pass even if only
  // the first turn ever rendered - the failure mode where a transcript binds once and then
  // stops following the file.
  const messages = ["first message", "second message", "third message"];
  for (const message of messages) {
    await reply.fill(message);
    await reply.press("Enter");
    await expect(card.getByText(`Mock reply to: ${message}`)).toBeVisible();
  }

  // All three are still on screen together - the conversation accumulated rather than
  // replacing itself - and the user's own turns are rendered too, not just the replies.
  for (const message of messages) {
    await expect(card.getByText(`Mock reply to: ${message}`)).toBeVisible();
    await expect(card.getByText(message, { exact: true })).toBeVisible();
  }

  // Visual evidence of the SUCCESSFUL path. Playwright's own `screenshot` setting captures
  // only on failure, which means a green run leaves nothing a reviewer can look at - and
  // "the conversation renders" is a claim that deserves to be seen rather than read.
  //
  // Behind an env flag, and committed, because the alternative is a binary that changes on
  // every run: the card carries a relative timestamp and a fresh worktree uuid, so an
  // unconditional capture would churn the repository for no added signal. Regenerate with
  // `MC_E2E_EVIDENCE=1 npm run test:e2e`. This follows the same shape as the `*-evidence`
  // generators under `scripts/`, which also produce committed artifacts on demand.
  if (process.env.MC_E2E_EVIDENCE) {
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
      path: fileURLToPath(new URL("../evidence/conversation.png", import.meta.url)),
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
  await expect.poll(async () =>
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).length
  ).toBe(1);
  const sessions = await api<Array<{ id: string }>>(daemon, "/api/sessions");
  expect(sessions).toHaveLength(1);
  const sessionId = sessions[0]!.id;

  // Keep this on the manual path. Foreman's shipped workflow mode can otherwise claim the
  // ask between the route below and the click, proving automation rather than this control.
  await api(daemon, "/api/foreman/config", { wrapup: "ask" }, "PUT");
  await api(daemon, `/api/sessions/${sessionId}/queue/wrapup/asked`, {
    clearAnswer: true,
  });
  await card.getByRole("button", { name: "Queue" }).click();
  const review = card.getByRole("button", { name: "Run No-Mistakes Review" });
  await expect(review).toBeVisible();
  await expect(card.getByLabel("Direct shipping instruction")).toBeVisible();
  await expect(card.getByRole("button", { name: "Send direct PR instruction" })).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log('OBSERVED Ship it panel exposes "Run No-Mistakes Review" beside the direct shipping path');
    await card.screenshot({
      path: fileURLToPath(new URL("../evidence/ship-it-review-control.png", import.meta.url)),
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/evidence/ship-it-review-control.png");
  }

  const request = dashboard.waitForRequest((candidate) =>
    candidate.method() === "POST"
    && candidate.url().endsWith(
      `/api/sessions/${encodeURIComponent(sessionId)}/workflow-review`,
    )
  );
  await review.click();
  const sent = await request;
  expect(sent.postDataJSON()).toEqual({ requestId: expect.any(String) });
  if (process.env.MC_E2E_EVIDENCE) {
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
  await dashboard.goto(`${daemon.baseURL}/#/workflows/runs/${encodeURIComponent(runId)}`);
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
      path: fileURLToPath(new URL("../evidence/ship-it-review-run.png", import.meta.url)),
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/evidence/ship-it-review-run.png");
  }
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
  const read = (): Invocation[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Invocation);
  };

  // POLLED, not read once. The card appears as soon as the daemon registers the session,
  // which is BEFORE the child process it launched has run far enough to write anything -
  // and a plain `readdirSync` here fails about one run in six. Playwright's auto-waiting
  // covers locators, not the filesystem, so the retry has to be asked for explicitly.
  //
  // A dispatch launches the binary through TWO unrelated paths, and waiting for only one of
  // them is how half the spend goes unnoticed. The titler is a one-shot `claude -p` from
  // `llm/claude-cli.ts`; the session is the Agent SDK's `--input-format stream-json`. Both
  // must land on the fake, or an e2e run bills a real account.
  await expect
    .poll(() => read().map((r) => (r.argv.includes("-p") ? "headless" : r.argv.includes("--input-format") ? "sdk" : "other")).sort(), {
      message: "both the headless titler and the SDK session should have launched the fake",
    })
    .toEqual(expect.arrayContaining(["headless", "sdk"]));

  const records = read();
  const record = records.find((r) => r.argv.includes("--input-format"));
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
