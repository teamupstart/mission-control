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
  await expect(dashboard.getByRole("button", { name: "Refresh managed plans" })).toHaveAccessibleDescription("Load the latest saved plan revisions for this session's repositories");
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

test("Files discovers attached plans and pages beyond 100 saved plans", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();
  await dialog.getByPlaceholder("What should this agent do?").fill("Review plans across attached repositories");
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let session: { id: string; cwd: string; agentSessionId: string | null; state: string };
  await expect.poll(async () => {
    const snapshot = await (await fetch(`${daemon.baseURL}/api/sessions`)).json();
    session = snapshot.sessions?.[0] ?? snapshot[0];
    return Boolean(session?.agentSessionId && session.state === "idle");
  }, { message: "wait for the attributed writer to bind" }).toBe(true);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const saved: ManagedPlanRevision[] = [];
  for (const [repoSlot, slug, title] of [["repo-01", "primary-slot", "Primary repository plan"], ["repo-02", "attached-slot", "Attached repository plan"]]) {
    const response = await fetch(`${daemon.baseURL}/mcp/plans/save`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": token }, body: JSON.stringify({
      env: {}, sessionId: session!.id, cwd: session!.cwd, repoSlot, slug, requestId: randomUUID(), expectedRevision: 0,
      files: [{ name: "plan.md", content: `# ${title}` }, { name: "plan.html", content: `<h1>${title}</h1>` }],
    }) });
    expect(response.status, await response.clone().text()).toBe(200);
    saved.push(await response.json());
  }
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Files$/ }).click();
  await dashboard.getByRole("button", { name: "Refresh managed plans" }).click();
  await expect(dashboard.getByRole("link", { name: "primary-slot · revision 1" })).toHaveAttribute("href", saved[0]!.preview);
  const attached = dashboard.getByRole("link", { name: "attached-slot · revision 1" });
  await expect(attached).toHaveAttribute("href", saved[1]!.preview);
  mkdirSync(evidence, { recursive: true });
  await dashboard.setViewportSize({ width: 1440, height: 1000 });
  await dashboard.screenshot({ path: `${evidence}attached-repository-discovery.png` });
  const opened = dashboard.waitForEvent("popup");
  await attached.click();
  const reader = await opened;
  await expect(reader).toHaveURL(`${daemon.baseURL}${saved[1]!.preview}`);
  await expect(reader.frameLocator("iframe").getByRole("heading", { name: "Attached repository plan" })).toBeVisible();
  await reader.close();
  let last: ManagedPlanRevision;
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${daemon.baseURL}/mcp/plans/save`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": token }, body: JSON.stringify({
      env: {}, sessionId: session!.id, cwd: session!.cwd, repoSlot: "repo-02", slug: `page-${String(i).padStart(3, "0")}`, requestId: randomUUID(), expectedRevision: 0,
      files: [{ name: "plan.md", content: `# Catalog plan ${i}` }, { name: "plan.html", content: `<h1>Catalog plan ${i}</h1>` }],
    }) });
    expect(response.status, await response.clone().text()).toBe(200);
    last = await response.json();
  }
  await dashboard.getByRole("button", { name: "Refresh managed plans" }).click();
  const catalog = dashboard.getByRole("region", { name: "Managed plans", exact: true });
  await expect(catalog.getByText("100 saved plans loaded. More available.", { exact: true })).toBeVisible();
  await expect(catalog.getByRole("link")).toHaveCount(100);
  await expect(catalog.getByRole("link", { name: "page-099 · revision 1" })).toHaveCount(0);
  await dashboard.route("**/api/sessions/*/plans?cursor=*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Catalog temporarily unavailable" }) }), { times: 1 });
  const more = catalog.getByRole("button", { name: "Load more managed plans" });
  await more.click();
  await expect(catalog.getByRole("alert")).toHaveText("Catalog temporarily unavailable");
  await expect(catalog.getByRole("link")).toHaveCount(100);
  await more.click();
  await expect(catalog.getByText("102 saved plans loaded.", { exact: true })).toBeVisible();
  await expect(catalog.getByRole("link")).toHaveCount(102);
  await expect(more).toHaveCount(0);
  const tail = catalog.getByRole("link", { name: "page-099 · revision 1" });
  await expect(tail).toHaveAttribute("href", last!.preview);
  await catalog.getByText("102 saved plans loaded.", { exact: true }).scrollIntoViewIfNeeded();
  await dashboard.screenshot({ path: `${evidence}catalog-pagination.png` });
  const tailOpened = dashboard.waitForEvent("popup");
  await tail.click();
  const tailReader = await tailOpened;
  await expect(tailReader.frameLocator("iframe").getByRole("heading", { name: "Catalog plan 99" })).toBeVisible();
  await tailReader.close();
  await dashboard.getByRole("button", { name: "Refresh managed plans" }).click();
  await expect(catalog.getByRole("link")).toHaveCount(100);
  await expect(more).toBeVisible();
});

test("queued plan preference saves retain confirmed values after refusal and accept the next edit", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
  const html = dashboard.getByRole("checkbox", { name: "Commit generated HTML plan files" });
  const storage = dashboard.getByRole("combobox", { name: "Plan storage", exact: true });
  await dashboard.route("**/api/skills/config", async (route) => {
    const patch = route.request().postDataJSON();
    if (patch.planStorage === "local") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture save refusal" }) });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    }
  });
  await html.check();
  await storage.selectOption("local");
  await expect(dashboard.getByText("That didn't stick: fixture save refusal")).toBeVisible();
  await expect(storage).toHaveValue("repository");
  await expect(html).toBeEnabled(); await expect(html).toBeChecked();
  const confirmed = await (await fetch(`${daemon.baseURL}/api/skills`)).json();
  expect(confirmed.planStorage).toBe("repository"); expect(confirmed.commitPlanHtml).toBe(true);
  await dashboard.unroute("**/api/skills/config");
  const saved = dashboard.waitForResponse((response) => response.url().endsWith("/api/skills/config") && response.request().method() === "PUT");
  await storage.selectOption("local");
  expect((await saved).ok()).toBe(true);
  await expect(dashboard.getByText("That didn't stick: fixture save refusal")).toBeHidden();
  await expect(storage).toHaveValue("local");
  await expect(html).toBeDisabled(); await expect(html).toBeChecked();
});

test("local plans preserve preferences, require final human approval and release only their artifact prerequisite", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/skills`);
  const html = dashboard.getByRole("checkbox", { name: "Commit generated HTML plan files" });
  await html.check();
  const storage = dashboard.getByRole("combobox", { name: "Plan storage", exact: true });
  const initialSave = dashboard.waitForResponse((response) => response.url().endsWith("/api/skills/config")
    && response.request().method() === "PUT" && response.request().postDataJSON().planStorage === "local");
  await storage.selectOption("local");
  await expect(html).toBeDisabled(); await expect(html).toBeChecked();
  expect((await initialSave).ok()).toBe(true);
  await daemon.crash(); await daemon.restart(); await dashboard.reload();
  await expect(storage).toHaveValue("local"); await expect(html).toBeChecked(); await expect(html).toBeDisabled();
  // A slow earlier save must not overwrite the operator's later Local choice.
  await dashboard.route("**/api/skills/config", async (route) => {
    if (route.request().postDataJSON().planStorage === "repository") await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  const savedPolicy = (policy: string) => dashboard.waitForResponse((response) => response.url().endsWith("/api/skills/config")
    && response.request().method() === "PUT" && response.request().postDataJSON().planStorage === policy);
  const repositorySaved = savedPolicy("repository"), localSaved = savedPolicy("local");
  await storage.selectOption("repository"); await expect(html).toBeEnabled(); await expect(html).toBeChecked();
  await storage.selectOption("local");
  for (const response of await Promise.all([repositorySaved, localSaved])) expect(response.ok()).toBe(true);
  expect((await (await fetch(`${daemon.baseURL}/api/skills`)).json()).planStorage).toBe("local");
  await expect(storage).toHaveValue("local"); await expect(html).toBeDisabled(); await expect(html).toBeChecked();
  mkdirSync(evidence, { recursive: true }); await dashboard.setViewportSize({ width: 1440, height: 1000 });
  await dashboard.screenshot({ path: `${evidence}local-settings.png` });
  const enable = await fetch(`${daemon.baseURL}/api/skills/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, skills: { "html-plans": true, "phased-plan": true } }) });
  expect(enable.ok).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo); await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Plan a local documentation update");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  await expect(afterWork).toHaveValue("builtin-workflow:local-plan-validation");
  await afterWork.selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click(); await expect(dialog).toBeHidden();
  let session!: { id: string; cwd: string; agentSessionId: string | null; state: string; task: { id: string } };
  await expect.poll(async () => { const snapshot = await (await fetch(`${daemon.baseURL}/api/sessions`)).json(); session = snapshot.sessions?.[0] ?? snapshot[0]; return Boolean(session?.agentSessionId && session.state === "idle"); }).toBe(true);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const post = (route: string, body: object) => fetch(`${daemon.baseURL}${route}`, { method: "POST", headers: { "content-type": "application/json", "x-harness-token": token }, body: JSON.stringify({ env: {}, sessionId: session.id, cwd: session.cwd, ...body }) });
  const savedResponse = await post("/mcp/plans/save", { repoSlot: "repo-01", slug: "local-documentation", requestId: randomUUID(), expectedRevision: 0, files: [
    { name: "plan.md", content: "# Local documentation plan\n\n[Phase](phase-1.md)" },
    { name: "plan.html", content: '<h1>Local documentation plan</h1><p>Complete source retained outside Git.</p><a href="phase-1.html">Read phase</a>' },
    { name: "phase-1.md", content: "# Implement documentation\n\nWait for the previous code phase." },
    { name: "phase-1.html", content: "<h1>Implement documentation</h1><p>Wait for the previous code phase.</p>" },
  ] });
  expect(savedResponse.status, await savedResponse.clone().text()).toBe(200);
  const saved = await savedResponse.json() as ManagedPlanRevision;
  expect(saved.requiredPaths).toEqual([]);
  expect(execFileSync("git", ["-C", session.cwd, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  const target = { repoSlot: "repo-01", planId: saved.manifest.planId, revision: 1 };
  expect((await post("/mcp/plans/publish", target)).status).toBe(409);
  const reviewResponse = await post("/mcp/v2/reviews", { kind: "plan-decisions", title: "Publish local documentation plan", body: "Review the complete retained bundle.", managedPlan: target });
  expect(reviewResponse.status, await reviewResponse.clone().text()).toBe(200);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const form = dashboard.locator(".review-modal");
  await expectContentClearsBorder(form);
  await form.getByRole("radio", { name: "Approve final bundle", exact: true }).check();
  await dashboard.screenshot({ path: `${evidence}local-final-approval.png` });
  await form.getByRole("button", { name: "Submit", exact: true }).click(); await expect(form).toBeHidden();
  const identity = { repoKey: saved.manifest.repoKey, planId: saved.manifest.planId, revision: 1 };
  const codeResponse = await post("/mcp/v3/tasks", { repoRoot: daemon.repo, title: "Previous code phase", intent: "Implement preceding code", planInputs: [], planPrerequisites: [] });
  expect(codeResponse.status).toBe(200); const code = await codeResponse.json();
  const phaseResponse = await post("/mcp/v3/tasks", { repoRoot: daemon.repo, title: "Pinned local documentation phase", intent: "Implement documentation after the code phase", dependsOnTaskIds: [code.id], planInputs: [{ ...identity, files: ["plan.md", "phase-1.md"] }], planPrerequisites: [identity] });
  expect(phaseResponse.status, await phaseResponse.clone().text()).toBe(200); const phase = await phaseResponse.json();
  expect(phase.dependencies.every((edge: { satisfiedAt: number | null }) => edge.satisfiedAt === null)).toBe(true);
  await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
  await dashboard.reload();
  const phaseCard = dashboard.locator(".bl-card", { hasText: "Pinned local documentation phase" });
  await expect(phaseCard.getByRole("button", { name: "waiting for dependencies" })).toBeVisible();
  await phaseCard.getByRole("button", { name: "Pinned local documentation phase", exact: true }).click();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expectContentClearsBorder(editor);
  await expect(editor).toContainText("waiting for publication");
  await expect(editor).toContainText("exact plan publication and code merges");
  await expect(editor).toContainText("its exact plan publications and code merges are ready");
  await dashboard.screenshot({ path: `${evidence}local-phase-waiting.png` });
  await dashboard.keyboard.press("Escape"); await expect(editor).toBeHidden();
  const publication = await post("/mcp/plans/publish", target);
  expect(publication.status, await publication.clone().text()).toBe(200);
  const receipt = await publication.json(); expect(receipt.submissionId).toBe(null);
  const readTask = async (id: string) => { const response = await fetch(`${daemon.baseURL}/api/tasks`); const body = await response.json(); return body.find((task: { id: string }) => task.id === id); };
  await expect.poll(async () => (await readTask(session.task.id)).status).toBe("done");
  const after = await readTask(phase.id);
  expect(after.dependencies.find((edge: { type: string }) => edge.type === "plan").satisfiedAt).toBe(receipt.publishedAt);
  expect(after.dependencies.find((edge: { type: string }) => edge.type === "task").satisfiedAt).toBe(null);
  expect(after.status).toBe("backlog");
  await expect(phaseCard.getByRole("button", { name: "waiting for dependencies" })).toBeVisible();
  await phaseCard.getByRole("button", { name: "Pinned local documentation phase", exact: true }).click();
  await expect(editor).toContainText("local-documentation revision 1 publication (published)");
  await dashboard.screenshot({ path: `${evidence}local-phase-code-blocked.png` });
  await dashboard.keyboard.press("Escape");
  expect((await readTask(session.task.id)).outcomeUrl).toBeNull();
  await dashboard.goto(`${daemon.baseURL}${saved.preview}`);
  await expect(dashboard.getByRole("status")).toContainText("Published locally");
  await expect(dashboard.frameLocator("iframe").getByRole("heading", { name: "Local documentation plan" })).toBeVisible();
  await dashboard.screenshot({ path: `${evidence}local-published-preview.png` });
  await dashboard.frameLocator("iframe").getByRole("link", { name: "Read phase" }).click();
  await expect(dashboard.frameLocator("iframe").getByRole("heading", { name: "Implement documentation" })).toBeVisible();
  await dashboard.getByRole("button", { name: "Refresh publication status" }).click();
  await expect(dashboard.getByRole("status")).toContainText("Published locally");
  await daemon.crash(); await daemon.restart(); await dashboard.reload();
  await expect(dashboard.getByRole("status")).toContainText("Published locally");
  const retained = await readTask(phase.id);
  expect(retained.planInputs).toEqual(phase.planInputs);
  expect(retained.dependencies.find((edge: { type: string }) => edge.type === "task").satisfiedAt).toBe(null);
});
