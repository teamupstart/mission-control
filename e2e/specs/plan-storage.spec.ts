import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ManagedPlanRevision } from "../../src/shared/managed-plans.ts";

const evidence = artifactsDir("plan-storage");
test("new plan policy persists, stages eligible files, and renders exact previews and phase links", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
  const control = dashboard.getByRole("checkbox", { name: "Commit generated HTML plan files" });
  await expect(control).not.toBeChecked();
  await expect(control).toHaveAccessibleDescription("Include rendered HTML in Git for new managed plans; existing plans keep their saved policy");
  await dashboard.getByRole("checkbox", { name: "Enable Mission Control skills" }).uncheck();
  await expect(control).toBeEnabled();
  await expect.poll(async () => (await (await fetch(`${daemon.baseURL}/api/skills`)).json()).enabled).toBe(false);
  mkdirSync(evidence, { recursive: true });
  await dashboard.setViewportSize({ width: 1440, height: 1000 });
  await dashboard.screenshot({ path: `${evidence}settings-default.png` });

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Author managed repository plans");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let session: { id: string; cwd: string; agentSessionId: string | null; state: string };
  await expect.poll(async () => {
    const snapshot = await (await fetch(`${daemon.baseURL}/api/sessions`)).json();
    session = snapshot.sessions?.[0] ?? snapshot[0];
    // Dispatch exposes the session before the SDK finishes binding its writer identity.
    return Boolean(session?.agentSessionId && session.state === "idle");
  }, { message: "the fake agent must finish binding before an attributed plan save" }).toBe(true);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const save = async (slug: string, previous?: ManagedPlanRevision): Promise<ManagedPlanRevision> => {
    const title = previous ? "Updated repository plan" : "Managed repository plans";
    const response = await fetch(`${daemon.baseURL}/mcp/plans/save`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": token }, body: JSON.stringify({
      env: {}, sessionId: session.id, cwd: session.cwd, repoSlot: "repo-01", slug, requestId: randomUUID(), expectedRevision: previous?.manifest.revision ?? 0, planId: previous?.manifest.planId,
      files: [
        { name: "plan.md", content: `# ${title}\n\nMarkdown is authoritative. [Phases](phased-plan.md)` },
        { name: "plan.html", content: `<!doctype html><html><head><style>body{font:20px system-ui;max-width:900px;margin:50px auto;color:#203248}h1{font-size:42px}a{color:#176368}</style></head><body><h1>${title}</h1><p>Markdown is authoritative. HTML remains available for review.</p><a href="phased-plan.html">Review implementation phases</a></body></html>` },
        { name: "phased-plan.md", content: "# Implementation phases\n\nPhase 2 waits for Phase 1 to merge." },
        { name: "phased-plan.html", content: '<h1>Implementation phases</h1><p>Phase 2 waits for Phase 1 to merge.</p><a href="plan.md">Read source Markdown</a>' },
      ],
    }) });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const markdown = await save("markdown-default");
  const git = (...args: string[]) => execFileSync("git", ["-C", session.cwd, ...args], { encoding: "utf8" });
  git("add", "docs/plans");
  expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual(["docs/plans/markdown-default/phased-plan.md", "docs/plans/markdown-default/plan.md"]);
  expect(existsSync(join(session.cwd, "docs/plans/markdown-default/plan.html"))).toBe(false);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
  await dashboard.getByRole("button", { name: "Refresh managed plans" }).click();
  await expect(dashboard.getByRole("button", { name: "Refresh managed plans" })).toHaveAccessibleDescription("Load the latest saved plan revisions for this repository");
  await expect(dashboard.getByRole("link", { name: "markdown-default · revision 1" })).toHaveAttribute("href", markdown.preview);
  await dashboard.screenshot({ path: `${evidence}managed-plan-discovery.png` });
  const updated = await save("markdown-default", markdown);
  await dashboard.getByRole("button", { name: "Refresh managed plans" }).click();
  const latest = dashboard.getByRole("link", { name: "markdown-default · revision 2" });
  await expect(latest).toHaveAttribute("href", updated.preview);
  const opened = dashboard.waitForEvent("popup");
  await latest.click();
  const reader = await opened;
  await expect(reader.frameLocator("iframe").getByRole("heading", { name: "Updated repository plan" })).toBeVisible();
  const previous = reader.getByRole("navigation", { name: "Plan revision history" }).getByRole("link", { name: "Previous revision" });
  await expect(previous).toHaveAttribute("href", markdown.preview);
  await expect(previous).toHaveAccessibleDescription("Open the retained plan at revision 1");
  await reader.screenshot({ path: `${evidence}revision-history.png` });
  await previous.click();
  await expect(reader).toHaveURL(`${daemon.baseURL}${markdown.preview}`);
  await expect(reader.frameLocator("iframe").getByRole("heading", { name: "Managed repository plans" })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Previous revision" })).toHaveCount(0);
  await reader.close();

  await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
  await control.check();
  await expect.poll(async () => (await (await fetch(`${daemon.baseURL}/api/skills`)).json()).commitPlanHtml).toBe(true);
  await dashboard.screenshot({ path: `${evidence}settings-opt-in.png` });
  const included = await save("html-opt-in");
  expect(included.requiredPaths).toContain("docs/plans/html-opt-in/plan.html");
  git("add", "docs/plans");
  expect(git("diff", "--cached", "--name-only")).toContain("docs/plans/html-opt-in/plan.html");
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await expect(control).toBeChecked();

  await dashboard.goto(`${daemon.baseURL}${markdown.preview}`);
  await expect(dashboard.getByText("Revision 1 · Markdown in Git; HTML retained locally")).toBeVisible();
  await expect(dashboard.frameLocator("iframe").getByRole("heading", { name: "Managed repository plans" })).toBeVisible();
  await dashboard.screenshot({ path: `${evidence}retained-preview.png` });
  await dashboard.frameLocator("iframe").getByRole("link", { name: "Review implementation phases" }).click();
  await expect(dashboard.frameLocator("iframe").getByRole("heading", { name: "Implementation phases" })).toBeVisible();
  await dashboard.frameLocator("iframe").getByRole("link", { name: "Read source Markdown" }).click();
  await expect(dashboard.locator("article").getByRole("heading", { name: "Managed repository plans" })).toBeVisible();
  await dashboard.locator("article").getByRole("link", { name: "Phases" }).click();
  await expect(dashboard.locator("article").getByRole("heading", { name: "Implementation phases" })).toBeVisible();
  await dashboard.getByRole("button", { name: "plan.html", exact: true }).click();
  await expect(dashboard.frameLocator("iframe").getByRole("heading", { name: "Managed repository plans" })).toBeVisible();
});

test("refused preference changes revert and show the daemon error", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
  const control = dashboard.getByRole("checkbox", { name: "Commit generated HTML plan files" });
  await expect(control).not.toBeChecked();
  await dashboard.route("**/api/skills/config", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Stored Skills settings are invalid" }) }));
  // A refused save can roll back before check() verifies the post-click checked state.
  await control.click();
  await expect(control).not.toBeChecked();
  await expect(dashboard.getByText("That didn't stick: Stored Skills settings are invalid")).toBeVisible();
});
