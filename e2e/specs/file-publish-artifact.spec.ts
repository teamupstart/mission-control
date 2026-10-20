import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { capabilitiesFor } from "../../src/shared/harness-capabilities.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Files toolbar's Publish control: one click asks the session's own agent to publish
 * the open file, unchanged, as a shareable page.
 *
 * Mission Control uploads nothing itself, so the browser is the only layer that can show
 * the whole contract: the control is offered on a report, the click becomes ONE turn whose
 * text is the harness's own prompt naming that exact file, the agent receives it, and the
 * person is told where the link will arrive. The same control is drawn disabled, with its
 * reason, on a file the vendor tool would refuse and on a harness that has no such tool.
 *
 * No model tokens: every agent binary is the fake from `fake-agents.ts`, which answers a
 * turn with "Mock reply to: <text>", except a publish request, which it answers through
 * Claude Code's own `Artifact` gate with a link derived from the file or the CLI's refusal.
 */

const EVIDENCE = artifactsDir("file-publish-artifact");
const REPORT = "docs/reports/auth-flow/report.html";
const SOURCE = "src/auth.ts";

const REPORT_HTML = `<!doctype html>
<html><head><title>Auth flow investigation</title></head>
<body><h1>Auth flow investigation</h1><p>Tokens refresh on the server.</p></body></html>
`;

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-publish-artifact/${name}.png`);
}

function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  task: string,
  agent: "claude" | "codex",
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox reopens on every keystroke and covers the Task field.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  if (agent !== "claude") {
    await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption(agent);
  }
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function onlySession(daemon: DaemonHandle): Promise<{ id: string; cwd: string }> {
  let found: { id: string; cwd: string } | null = null;
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        id: string;
        cwd: string | null;
        state: string;
      }[];
      const live = sessions[0];
      found = live?.cwd ? { id: live.id, cwd: live.cwd } : null;
      return live?.state ?? null;
    }, { message: "the dispatched session never settled", timeout: 60_000 })
    .toBe("idle");
  return found!;
}

/** Dispatch, seed a scout-shaped report and a source file, and open the Files tab. */
async function openFiles(
  page: Page,
  daemon: DaemonHandle,
  task: string,
  agent: "claude" | "codex",
): Promise<string> {
  await dispatch(page, daemon, task, agent);
  const { id, cwd } = await onlySession(daemon);
  mkdirSync(join(cwd, "docs", "reports", "auth-flow"), { recursive: true });
  writeFileSync(join(cwd, REPORT), REPORT_HTML);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, SOURCE), "export const refresh = true;\n");

  const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(config.ok, "the daemon accepted the Console layout").toBe(true);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
  return id;
}

test("Publish sends the open report to Claude as one turn asking for an unchanged artifact", async ({
  dashboard,
  daemon,
}) => {
  const sessionId = await openFiles(dashboard, daemon, "investigate the auth flow", "claude");
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  const toolbar = dashboard.locator(".file-main > .file-toolbar");
  const publish = toolbar.getByRole("button", { name: "Publish as Claude artifact" });

  // A source file is drawn the same control, disabled, and says which files can publish.
  await files.getByRole("option", { name: SOURCE }).click();
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription(
    "Only .html, .htm and .md files can be published as a Claude artifact",
  );

  await files.getByRole("option", { name: REPORT }).click();
  await expect(dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`).getByRole("heading", { name: "Auth flow investigation" })).toBeVisible();
  await expect(publish).toBeEnabled();
  await expect(publish).toHaveAccessibleDescription(
    "Ask the agent to publish this exact file, unchanged, as a Claude artifact",
  );
  await shoot(dashboard, "publish-control-on-report");

  const spec = capabilitiesFor("claude").artifactPublishing;
  if (!spec.publishes) throw new Error("Claude must declare artifact publishing");
  const prompt = spec.prompt(REPORT);

  const request = dashboard.waitForRequest((candidate) =>
    candidate.method() === "POST"
    && candidate.url().endsWith(`/api/sessions/${encodeURIComponent(sessionId)}/inject`)
  );
  await publish.click();
  // The composer's own one-turn path, carrying the harness's prompt verbatim.
  expect((await request).postDataJSON()).toEqual({ text: prompt, buffer: true });
  observed(`POST /inject carried the Claude artifact prompt for ${REPORT}`);

  // It reports the request, not a publish: the agent may lack the tool and say so instead.
  await expect(dashboard.getByRole("status").filter({ hasText: "Sent a request to publish" }))
    .toHaveText(
      `Sent a request to publish ${REPORT} as a Claude artifact. The conversation will show the link, or why the agent could not publish it.Dismiss`,
    );
  await shoot(dashboard, "publish-requested");

  // The agent received exactly that turn, as one message rather than one per line.
  await dashboard
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Conversation$/ })
    .click();
  const card = dashboard.locator(".console-detail");
  const humanTurn = card
    .locator("article.turn-user .turn-text")
    .filter({ hasText: `Publish ${REPORT} as a Claude artifact.` });
  await expect(humanTurn).toHaveCount(1);
  await expect(card.locator("article.turn-assistant .turn-text").filter({
    hasText: `Published ${REPORT} as a Claude artifact: https://claude.ai/artifact/`,
  })).toHaveCount(1);
  observed("the agent received the publish request as a single conversation turn");
});

test("an embedded session has the Artifact tool, so the report's link reaches the conversation", async ({
  dashboard,
  daemon,
}) => {
  // The reported failure: on the Agent SDK runtime Claude Code withholds `Artifact` unless
  // the launch opts in, and the session answered "this session doesn't have the Artifact
  // tool". The fake applies that same gate, so this fails on a driver that drops the opt-in.
  const report = "docs/reports/submission-job-run-relationship/report.html";
  await dispatch(dashboard, daemon, "map the submission and job run relationship", "claude");
  const { id: sessionId, cwd } = await onlySession(daemon);
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    id: string;
    runtime: string;
  }[];
  expect(sessions.find((s) => s.id === sessionId)?.runtime, "dispatched on the Agent SDK").toBe("sdk");
  mkdirSync(join(cwd, "docs", "reports", "submission-job-run-relationship"), { recursive: true });
  writeFileSync(
    join(cwd, report),
    "<!doctype html>\n<html><head><title>Submission and job run</title></head>\n" +
      "<body><h1>Submission and job run relationship</h1></body></html>\n",
  );

  const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(config.ok, "the daemon accepted the Console layout").toBe(true);
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Files$/ }).click();
  await dashboard.getByRole("listbox", { name: "Session files" }).getByRole("option", { name: report }).click();
  await expect(
    dashboard.frameLocator(`iframe[title="Preview of ${report}"]`)
      .getByRole("heading", { name: "Submission and job run relationship" }),
  ).toBeVisible();
  await dashboard
    .locator(".file-main > .file-toolbar")
    .getByRole("button", { name: "Publish as Claude artifact" })
    .click();
  await expect(dashboard.getByRole("status").filter({ hasText: "Sent a request to publish" }))
    .toContainText(`Sent a request to publish ${report} as a Claude artifact.`);

  await tabs.getByRole("tab", { name: /Conversation$/ }).click();
  const card = dashboard.locator(".console-detail");
  const reply = card.locator("article.turn-assistant .turn-text").filter({
    hasText: `Published ${report} as a Claude artifact: https://claude.ai/artifact/`,
  });
  await expect(reply).toHaveCount(1);
  await expect(card.getByText("doesn't have the Artifact tool")).toHaveCount(0);
  observed(`the embedded session published ${report} and its claude.ai link is in the conversation`);
  await reply.scrollIntoViewIfNeeded();
  await shoot(dashboard, "embedded-session-published-link");
});

test("a Codex session draws Publish disabled and says why", async ({ dashboard, daemon }) => {
  await openFiles(dashboard, daemon, "investigate the codex auth flow", "codex");
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();
  await expect(dashboard.frameLocator(`iframe[title="Preview of ${REPORT}"]`).getByRole("heading", { name: "Auth flow investigation" })).toBeVisible();

  const spec = capabilitiesFor("codex").artifactPublishing;
  if (spec.publishes) throw new Error("Codex must not declare artifact publishing");
  const publish = dashboard
    .locator(".file-main > .file-toolbar")
    .getByRole("button", { name: "Publish as artifact" });
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription(spec.unavailable);
  observed(`Codex Publish disabled: ${spec.unavailable}`);
  await shoot(dashboard, "codex-publish-disabled");
});

test("a refused publish request is reported, and Publish can be tried again", async ({
  dashboard,
  daemon,
}) => {
  const sessionId = await openFiles(dashboard, daemon, "investigate the refused publish", "claude");
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();
  const publish = dashboard
    .locator(".file-main > .file-toolbar")
    .getByRole("button", { name: "Publish as Claude artifact" });
  await expect(publish).toBeEnabled();

  // The daemon's own refusal shape, so the browser has to carry the route's sentence through
  // rather than a generic failure of its own.
  const refusal = "This session is not accepting messages right now";
  await dashboard.route(
    (url) => url.pathname === `/api/sessions/${encodeURIComponent(sessionId)}/inject`,
    (route) => route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: refusal }),
    }),
  );
  await publish.click();

  const alert = dashboard.getByRole("alert").filter({ hasText: refusal });
  await expect(alert).toHaveText(`${refusal}Dismiss`);
  // Nothing was sent, so nothing promises a link, and the control is live for a retry.
  await expect(dashboard.getByText("Sent a request to publish")).toHaveCount(0);
  await expect(publish).toBeEnabled();
  observed(`a refused publish showed "${refusal}" and left Publish enabled`);
  await shoot(dashboard, "publish-refused");

  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toHaveCount(0);
});

test("unsaved edits hold Publish until the save lands", async ({ dashboard, daemon }) => {
  await openFiles(dashboard, daemon, "investigate the unsaved report", "claude");
  await dashboard
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: REPORT })
    .click();
  const toolbar = dashboard.locator(".file-main > .file-toolbar");
  const publish = toolbar.getByRole("button", { name: "Publish as Claude artifact" });
  await expect(publish).toBeEnabled();

  // Hold the autosave in flight, so the visible edit is not yet the file on disk - the one
  // state in which publishing would share bytes the person is not looking at.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await dashboard.route(
    (url) => url.pathname.endsWith("/file"),
    async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      await held;
      return route.fallback();
    },
  );

  await toolbar.getByRole("group", { name: "File view mode" }).getByRole("button", { name: "Editor" }).click();
  const editor = dashboard.getByLabel(`Editor for ${REPORT}`);
  await expect(editor).toContainText("Auth flow investigation");
  await editor.click();
  await dashboard.keyboard.press("ControlOrMeta+End");
  await dashboard.keyboard.type("<!-- reviewed -->");

  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription(
    "Save this file first, so the published page is the file on disk",
  );
  observed("Publish disabled with the save-first reason while the edit was unsaved");
  await shoot(dashboard, "publish-held-for-save");

  release();
  await expect(toolbar.getByText("Saved", { exact: true })).toBeVisible();
  await expect(publish).toBeEnabled();
  observed("Publish enabled again once the save landed");
});

test("a publish answered after the person moved to another file stays with its own file", async ({
  dashboard,
  daemon,
}) => {
  const sessionId = await openFiles(dashboard, daemon, "investigate the moving reader", "claude");
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  const toolbar = dashboard.locator(".file-main > .file-toolbar");
  const publish = toolbar.getByRole("button", { name: "Publish as Claude artifact" });
  await files.getByRole("option", { name: REPORT }).click();
  await expect(publish).toBeEnabled();

  // Hold the request so its answer arrives only after the selection has moved on.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reached: () => void = () => {};
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  await dashboard.route(
    (url) => url.pathname === `/api/sessions/${encodeURIComponent(sessionId)}/inject`,
    async (route) => {
      reached();
      await held;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    },
  );
  await publish.click();
  await arrived;
  await expect(publish).toHaveText(/Publishing…/);

  await files.getByRole("option", { name: SOURCE }).click();
  await expect(dashboard.getByLabel(`Editor for ${SOURCE}`)).toContainText("refresh");
  // The other file's control is its own: not busy, refused for its own reason.
  await expect(publish).toHaveText(/^\W*Publish$/);
  await expect(publish).toHaveAccessibleDescription(
    "Only .html, .htm and .md files can be published as a Claude artifact",
  );

  const answered = dashboard.waitForResponse((response) =>
    response.url().endsWith(`/api/sessions/${encodeURIComponent(sessionId)}/inject`)
  );
  release();
  await answered;
  // A beat for React to commit whatever that answer set, so the absence is not a race.
  await dashboard.waitForTimeout(250);
  await expect(dashboard.getByText("Sent a request to publish")).toHaveCount(0);
  await expect(dashboard.locator(".file-notice")).toHaveCount(0);
  observed("a publish answered after moving to src/auth.ts drew no notice over that file");
  await shoot(dashboard, "publish-answer-not-shown-on-other-file");
});

test("overlapping publishes keep each file's own result", async ({ dashboard, daemon }) => {
  const sessionId = await openFiles(dashboard, daemon, "investigate two reports at once", "claude");
  const files = dashboard.getByRole("listbox", { name: "Session files" });
  const publish = dashboard
    .locator(".file-main > .file-toolbar")
    .getByRole("button", { name: "Publish as Claude artifact" });
  const SECOND = "README.md";
  const refusal = "The agent's outbox is full";

  // The report's request is held; the second file's is refused at once. The older request
  // therefore answers LAST, which is the order that used to erase the newer result.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reportAnswered: () => void = () => {};
  const reportDone = new Promise<void>((resolve) => { reportAnswered = resolve; });
  await dashboard.route(
    (url) => url.pathname === `/api/sessions/${encodeURIComponent(sessionId)}/inject`,
    async (route) => {
      const text = (route.request().postDataJSON() as { text: string }).text;
      if (text.startsWith(`Publish ${REPORT} `)) {
        await held;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        reportAnswered();
        return;
      }
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: refusal }),
      });
    },
  );

  await files.getByRole("option", { name: REPORT }).click();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(publish).toHaveText(/Publishing…/);

  await files.getByRole("option", { name: SECOND }).click();
  await expect(dashboard.getByLabel(`Preview of ${SECOND}`)).toBeVisible();
  await expect(publish).toBeEnabled();
  await publish.click();
  const alert = dashboard.getByRole("alert").filter({ hasText: refusal });
  await expect(alert).toBeVisible();

  release();
  await reportDone;
  // A beat for React to commit what the report's late answer set.
  await dashboard.waitForTimeout(250);
  await expect(alert).toHaveText(`${refusal}Dismiss`);
  await expect(dashboard.getByText("Sent a request to publish")).toHaveCount(0);
  observed(`${SECOND}'s refusal survived ${REPORT}'s later answer`);
  await shoot(dashboard, "overlap-newer-refusal-kept");

  // And the report's own answer was kept for the report, not dropped.
  await files.getByRole("option", { name: REPORT }).click();
  await expect(dashboard.getByRole("status").filter({ hasText: "Sent a request to publish" }))
    .toContainText(`Sent a request to publish ${REPORT} as a Claude artifact.`);
  await expect(dashboard.getByRole("alert").filter({ hasText: refusal })).toHaveCount(0);
  await expect(publish).toHaveText(/^\W*Publish$/);
  observed(`${REPORT}'s own result was shown when it was reopened`);
  await shoot(dashboard, "overlap-older-result-kept");
});
