import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

async function captureState(page: Page, state: string, target = page.getByRole("region", { name: "Repository queries" })) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const directory = artifactsDir("persona-repository-access");
  mkdirSync(directory, { recursive: true });
  for (const width of [1440, 600]) {
    await page.setViewportSize({ width, height: 900 });
    if (state === "frozen-outdated" && !await target.isVisible()) {
      await page.getByRole("button", { name: "Properties", exact: true }).click();
    }
    await target.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, `${state}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("repository access is opt-in and survives reload for custom and built-in reviewers", async ({ dashboard, daemon }) => {
  const api = dashboard.request;
  const created = await api.post(`${daemon.baseURL}/api/personas`, {
    data: { name: "Checkout reviewer", guidanceMarkdown: "Read the submitted change." },
  });
  expect(created.ok()).toBe(true);
  const persona = await created.json();
  expect(persona.repositoryAccess).toBe("none");
  const grant = dashboard.getByRole("combobox", { name: "Repository access" });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  const rail = dashboard.getByRole("complementary", { name: "Persona library" });
  await rail.getByRole("button", { name: /Checkout reviewer/ }).click();
  await expect(grant).toHaveCount(0);
  expect((await api.patch(`${daemon.baseURL}/api/personas/${persona.id}/repository-access`, {
    data: { repositoryAccess: "read", expectedAccessRevision: persona.repositoryAccessRevision },
  })).status()).toBe(403);
  expect((await api.put(`${daemon.baseURL}/api/feature-flags`, {
    data: { kind: "flag", id: "persona-repository-access", enabled: true },
  })).ok()).toBe(true);
  const personas = await (await api.get(`${daemon.baseURL}/api/personas`)).json() as { name: string; builtin: boolean }[];
  const shipped = personas.find(row => row.builtin)!;
  for (const reviewer of [persona, shipped]) {
    await rail.getByRole("button", { name: new RegExp(reviewer.name) }).first().click();
    await expect(grant).toHaveValue("none");
    await grant.selectOption("read");
    await dashboard.getByRole("button", { name: "Save repository access" }).click();
    await expect(dashboard.getByRole("button", { name: "Save repository access" })).toBeDisabled();
    await dashboard.reload();
    await expect(grant).toHaveValue("read");
    const disclosure = dashboard.getByText("What the reviewer can read");
    await disclosure.click();
    await expect(dashboard.getByText(/History includes up to 2,048 commits/)).toBeVisible();
    if (reviewer.builtin) await expect(dashboard.getByText(/This local override applies/)).toBeVisible();
    await captureState(dashboard, reviewer.builtin ? "builtin" : "custom", grant);
    await grant.selectOption("none");
    await dashboard.getByRole("button", { name: "Save repository access" }).click();
    await dashboard.reload();
    await expect(grant).toHaveValue("none");
  }
});

const scenarios = [
  { title: "claude reviews the submitted dirty checkout and cites exact MCP ranges", provider: "claude", marker: "Inspect submitted.txt." },
  { title: "codex reviews the submitted dirty checkout and cites exact MCP ranges", provider: "codex", marker: "Inspect submitted.txt." },
  { title: "a fabricated repository citation retries and blocks without a verdict", provider: "claude", marker: "E2E_INVALID_REPOSITORY_CITATION" },
  { title: "MCP failure retries and blocks without a verdict", provider: "claude", marker: "E2E_REPOSITORY_MCP_FAILURE" },
  { title: "a read-enabled review retains the rejected verdict and corrects it against the same digest", provider: "codex", marker: "E2E_REVIEW_CORRECTION" },
  { title: "retained history exposes the boundary and withholds omitted commit information", provider: "codex", marker: "E2E_HISTORY_LIMIT" },
  { title: "provider token exhaustion blocks the read-enabled review immediately", provider: "claude", marker: "E2E_REPOSITORY_QUOTA" },
  { title: "a historical omitted grant uses ordinary prompt review without a capture or query", provider: "claude", marker: "E2E_PASS_VERDICT" },
] as const;

for (const { title, provider, marker } of scenarios) {
  test(title, async ({ dashboard, daemon }) => {
    test.setTimeout(120_000);
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const post = async (path: string, data: unknown) => {
      const response = await dashboard.request.post(daemon.baseURL + path, { data });
      expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
      return response.json();
    };
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await dashboard.keyboard.press("Escape");
    await dialog.getByPlaceholder("What should this agent do?").fill("Review the submitted working file.");
    await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
    await dialog.getByRole("button", { name: "Dispatch now" }).click();
    await expect(dialog).toBeHidden();
    let session: { id: string; cwd: string };
    await expect.poll(async () => {
      const sessions = await (await dashboard.request.get(daemon.baseURL + "/api/sessions")).json();
      session = sessions.find((s: {state: string}) => s.state === "idle");
      return Boolean(session);
    }).toBe(true);
    const cwd = session!.cwd;
    const file = join(cwd, "submitted.txt");
    writeFileSync(file, "committed line\n");
    execFileSync("git", ["add", "submitted.txt"], { cwd });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd });
    let guidance = marker as string;
    if (marker === "E2E_HISTORY_LIMIT") {
      // Fast-import makes a 2,049-commit linear fixture without a process per commit.
      const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      const previous = git("rev-parse", "HEAD");
      const branch = "refs/heads/fixture-retained-history";
      const commits = Array.from({ length: 2048 }, (_, i) =>
        `commit ${branch}\nmark :${i + 1}\ncommitter Fixture <fixture@example.invalid> ${1700000000 + i} +0000\ndata 1\nx\nfrom ${i ? ":" + i : previous}\n\n`);
      execFileSync("git", ["fast-import", "--quiet"], { cwd, input: commits.join("") + "done\n" });
      git("update-ref", "HEAD", git("rev-parse", branch), previous);
      guidance += " FRONTIER=" + git("rev-parse", "HEAD~2047") + " OMITTED=" + previous;
    }
    writeFileSync(file, "staged line\n");
    execFileSync("git", ["add", "submitted.txt"], { cwd });
    writeFileSync(file, "submitted working line\n" + "second line\n".repeat(104));
    writeFileSync(join(cwd, "untracked.txt"), "untracked line\n");
    expect((await dashboard.request.put(daemon.baseURL + "/api/feature-flags", {
      data: { kind: "flag", id: "persona-repository-access", enabled: true },
    })).ok()).toBe(true);
    const persona = await post("/api/personas", {
      name: "Repository reviewer", guidanceMarkdown: guidance, ...(marker === "E2E_PASS_VERDICT" ? {} : { repositoryAccess: "read" }), runner: "claude",
    });
    const { workflow } = await post("/api/workflows", {
      name: "Repository review", draft: {
        nodes: [
          { id: "session", kind: "session", position: { x: 0, y: 0 } },
          { id: "review", kind: "persona", personaId: persona.id, position: { x: 200, y: 0 },
            executionOverride: { runner: provider, model: provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.6-sol" } },
          { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
        ],
        edges: [
          { id: "submitted", source: "session", sourcePort: "submitted", target: "review", targetPort: "activate" },
          { id: "pass", source: "review", sourcePort: "pass", target: "end", targetPort: "terminal" },
          { id: "fail", source: "review", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
        ],
      },
    });
    const { version } = await post(`/api/workflows/${workflow.id}/publish`, { expectedDraftRevision: 1 });
    const binding = await post("/api/workflow-bindings", { workflowVersionId: version.id, sessionId: session!.id, deliveryMode: "preview" });
    const { run } = await post(`/api/workflow-bindings/${binding.id}/submit`, { requestId: "review-checkout" });
    const detail = async () => (await dashboard.request.get(daemon.baseURL + "/api/workflow-runs/" + run.id)).json();
    // HTTP 202 reserves a submission. The captured event marks the sealed checkout.
    await expect.poll(async () => (await detail()).events.some((e: { kind: string }) => e.kind === "submission_captured"), { timeout: marker === "E2E_HISTORY_LIMIT" ? 85_000 : 20_000 }).toBe(true);
    writeFileSync(file, "later checkout\n");
    writeFileSync(join(daemon.home, "repository-review-ready"), "ready");
    if (marker === "E2E_REPOSITORY_QUOTA") {
      await expect.poll(async () => (await detail()).run.currentPhase, { timeout: 30_000 }).toBe("provider_token_exhausted");
      const result = await detail();
      expect(result.llmCalls.filter((call: { purpose: string }) => call.purpose === "persona_review")).toHaveLength(1);
      return;
    }
    if (marker === "E2E_INVALID_REPOSITORY_CITATION" || marker === "E2E_REPOSITORY_MCP_FAILURE") {
      await expect.poll(async () => (await detail()).run.status, { timeout: 40_000 }).toBe("blocked");
      const blocked = await detail();
      const calls = blocked.llmCalls.filter((call: { purpose: string }) => call.purpose === "persona_review");
      expect(calls.length).toBeGreaterThan(1);
      expect(blocked.attempts.filter((a: { verdict: unknown }) => a.verdict)).toHaveLength(0);
      await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
      const history = dashboard.getByRole("region", { name: "Repository queries" });
      await expect(history).toBeVisible();
      await expect(dashboard.getByRole("button", { name: "Retry the failed call" })).toBeVisible();
      await captureState(dashboard, marker === "E2E_REPOSITORY_MCP_FAILURE" ? "mcp-blocked" : "citation-blocked", dashboard.getByRole("button", { name: "Retry the failed call" }));
      await dashboard.reload();
      if (marker === "E2E_REPOSITORY_MCP_FAILURE") await expect(history.getByText("0 recorded")).toBeVisible();
      else await expect(history.getByText(/read · denied_path/).first()).toBeVisible();
      return;
    }
    await expect.poll(async () => {
      const d = await detail();
      if (d.run.status === "blocked") throw Error(JSON.stringify({ phase: d.run.currentPhase, attempts: d.attempts.map((a: {error: string}) => a.error) }));
      return d.run.status;
    }, { timeout: 40_000 }).toBe("completed");
    const finished = await detail();
    expect(finished.attempts.find((a: {runner: string}) => a.runner === provider)).toBeTruthy();
    if (marker === "E2E_PASS_VERDICT") {
      expect(finished.repositoryReview).toBeUndefined();
      expect(finished.llmCalls.filter((call: { purpose: string }) => call.purpose === "persona_review")).toHaveLength(1);
      const counts = withDaemonDb(daemon, db => db.prepare(`SELECT
        (SELECT count(*) FROM workflow_repository_snapshot_claims) AS claims,
        (SELECT count(*) FROM workflow_repository_artifacts) AS artifacts,
        (SELECT count(*) FROM workflow_repository_workloads) AS workloads,
        (SELECT count(*) FROM workflow_repository_queries) AS queries`).get());
      expect(counts).toEqual({ claims: 0, artifacts: 0, workloads: 0, queries: 0 });
      await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
      await expect(dashboard.getByText(/No repository access/).first()).toBeVisible();
      await expect(dashboard.getByRole("region", { name: "Repository queries" })).toHaveCount(0);
      return;
    }
    expect(Object.keys(finished.repositoryReview.citations)).toHaveLength(3);
    if (marker === "E2E_HISTORY_LIMIT") {
      expect(finished.repositoryReview.snapshot.retainedCommits).toBe(2048);
      expect(finished.repositoryReview.snapshot.bounded).toBe(true);
      await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
      const history = dashboard.getByRole("region", { name: "Repository queries" });
      await expect(history.getByText(/2048 retained commits · retained history boundary/)).toBeVisible();
      await expect(history.getByText(/git_show · history_boundary/)).toBeVisible();
      await expect(history.getByText(/git_show · revision_out_of_range/)).toBeVisible();
      await expect(history).not.toContainText(guidance.split("OMITTED=")[1]!);
      return;
    }
    if (marker === "E2E_REVIEW_CORRECTION") {
      const reviewed = finished.attempts.find((a: { runner: string }) => a.runner === provider);
      expect(reviewed.reviewRejections).toHaveLength(1);
      expect(finished.llmCalls.filter((call: { purpose: string }) => call.purpose === "persona_review")).toHaveLength(2);
      const ownership = withDaemonDb(daemon, db => db.prepare(`SELECT count(*) AS workloads,
        count(DISTINCT digest) AS snapshots FROM workflow_repository_workloads WHERE attempt_id=?`).get(reviewed.id));
      expect(ownership).toEqual({ workloads: 2, snapshots: 1 });
      return;
    }
    await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
    const history = dashboard.getByRole("region", { name: "Repository queries" });
    await expect(history).toBeVisible();
    await expect(history.getByText(/read · denied_path/)).toBeVisible();
    await history.getByText(/read · ok.*truncated/).first().click();
    await expect(history.getByText(/Query [0-9a-f]{12} · next page available/).first()).toBeVisible();
    await expect(history.getByText(/submitted.txt · lines \[1, 2\)/).first()).toBeVisible();
    await expect(history.getByText(/git_log · revision_out_of_range/)).toBeVisible();
    await expect(history).not.toContainText("submitted working line");
    await captureState(dashboard, provider + "-queries", history);
    await dashboard.reload();
    await expect(history.getByText(/git_diff · ok/).first()).toBeVisible();
    if (provider === "claude") {
      const changed = await dashboard.request.patch(`${daemon.baseURL}/api/personas/${persona.id}/repository-access`, {
        data: { repositoryAccess: "none", expectedAccessRevision: persona.repositoryAccessRevision },
      });
      expect(changed.ok()).toBe(true);
      await dashboard.setViewportSize({ width: 1440, height: 900 });
      await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${workflow.id}`);
      await dashboard.getByRole("button", { name: /^Version 1/ }).click();
      const outdated = dashboard.getByText(/Repository reviewer · revision .*outdated/);
      await outdated.click();
      const frozen = dashboard.getByText("Read-only repository access", { exact: true });
      await expect(frozen).toBeVisible();
      await captureState(dashboard, "frozen-outdated", frozen);
      const publishRequests: string[] = [];
      await dashboard.route(`**/api/workflows/${workflow.id}/publish`, async route => {
        publishRequests.push(route.request().postDataJSON().requestId);
        if (publishRequests.length === 1) {
          await route.fulfill({ status: 503, json: { error: "Publish response unavailable" } });
        } else {
          await route.continue();
        }
      });
      const publish = dashboard.getByRole("button", { name: "Publish", exact: true });
      await publish.click();
      await expect(dashboard.getByText("Publish response unavailable")).toBeVisible();
      await publish.click();
      const second = dashboard.getByRole("button", { name: /^Version 2/ });
      await expect(second).toBeVisible();
      expect(publishRequests[0]).toBeTruthy();
      expect(publishRequests).toEqual([publishRequests[0], publishRequests[0]]);
      await second.click();
      const source = dashboard.getByText(/Repository reviewer · revision/);
      if (!await dashboard.getByText("No repository access", { exact: true }).isVisible()) await source.click();
      await expect(dashboard.getByText("No repository access", { exact: true })).toBeVisible();
    }
  });
}
