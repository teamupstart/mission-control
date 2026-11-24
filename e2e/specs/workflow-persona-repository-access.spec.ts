import { existsSync, mkdirSync } from "node:fs";
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
    if (state === "publish-retry" || state === "discard-unreadable") {
      const drawer = page.getByRole("button", { name: "Properties", expanded: true });
      if (await drawer.isVisible()) await drawer.click();
      await target.click({ trial: true });
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
    const saved = dashboard.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/repository-access"));
    await dashboard.getByRole("button", { name: "Save repository access" }).click();
    expect((await saved).ok()).toBe(true);
    await dashboard.reload();
    await expect(grant).toHaveValue("none");
  }
});

test("duplicating a read-enabled Persona requires a fresh grant on the copy", async ({ dashboard, daemon }) => {
  const api = dashboard.request;
  expect((await api.put(`${daemon.baseURL}/api/feature-flags`, {
    data: { kind: "flag", id: "persona-repository-access", enabled: true },
  })).ok()).toBe(true);
  const personasUrl = `${daemon.baseURL}/api/personas`;
  const created = await api.post(personasUrl, { data: {
    name: "Source reviewer", guidanceMarkdown: "Check the submitted file.", repositoryAccess: "read",
  } });
  expect(created.ok()).toBe(true);
  const source = await created.json();
  const name = dashboard.getByPlaceholder("Untitled Persona");
  const grant = dashboard.getByRole("combobox", { name: "Repository access" });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas/${source.id}`);
  await expect(grant).toHaveValue("read");
  await dashboard.getByRole("button", { name: "More Persona actions" }).click();
  await dashboard.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
  await expect(grant).toHaveValue("none");
  await name.fill("Menu copy");
  await dashboard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dashboard.getByRole("button", { name: "Save repository access" })).toBeVisible();
  await dashboard.reload();
  await expect(name).toHaveValue("Menu copy");
  await expect(grant).toHaveValue("none");

  // A conflict can create a copy directly, without opening the new-Persona editor.
  await dashboard.getByRole("complementary", { name: "Persona library" })
    .getByRole("button", { name: /Source reviewer/ }).click();
  await expect(grant).toHaveValue("read");
  await grant.selectOption("none");
  await grant.selectOption("read");
  await dashboard.getByPlaceholder("One line on what this reviewer judges").fill("My local description");
  expect((await api.patch(`${personasUrl}/${source.id}`, {
    data: { expectedRevision: source.revision, description: "Changed by another editor" },
  })).ok()).toBe(true);
  await dashboard.getByRole("button", { name: "Save as duplicate" }).click();
  await expect(name).toHaveValue("Source reviewer copy");
  await expect(grant).toHaveValue("none");
  await dashboard.reload();
  await expect(grant).toHaveValue("none");
  await captureState(dashboard, "duplicate-default", grant);
  await grant.selectOption("read");
  await dashboard.getByRole("button", { name: "Save repository access" }).click();
  await expect(dashboard.getByRole("button", { name: "Save repository access" })).toBeDisabled();
  await dashboard.reload();
  await expect(grant).toHaveValue("read");
  const catalog = await (await api.get(personasUrl)).json() as { id: string; name: string; repositoryAccess: string }[];
  expect(catalog.find(row => row.id === source.id)?.repositoryAccess).toBe("read");
  expect(catalog.find(row => row.name === "Menu copy")?.repositoryAccess).toBe("none");
});

const scenarios = [
  { title: "claude reviews the submitted dirty checkout and cites exact MCP ranges", provider: "claude", marker: "Inspect submitted.txt." },
  { title: "codex reviews the submitted dirty checkout and cites exact MCP ranges", provider: "codex", marker: "Inspect submitted.txt." },
  { title: "query history labels file ranges with each round's submitted snapshot", provider: "claude", marker: "E2E_QUERY_SNAPSHOTS" },
  { title: "a fresh daemon confirms local provider and lease cleanup before retrying", provider: "claude", marker: "E2E_LOCAL_CLEANUP_RESTART" },
  { title: "a fresh daemon holds a mismatched lease until local ownership is verified", provider: "codex", marker: "E2E_LOCAL_CLEANUP_RESTART_MISMATCH" },
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
    const { readFileSync, writeFileSync } = await import("node:fs");
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
    if (marker === "E2E_LOCAL_CLEANUP_RESTART" || marker === "E2E_LOCAL_CLEANUP_RESTART_MISMATCH") {
      await expect.poll(() => existsSync(join(daemon.home, "repository-provider-started")), { timeout: 40_000 }).toBe(true);
      const owner = withDaemonDb(daemon, db => db.prepare("SELECT * FROM workflow_repository_local_owners").get())!;
      expect(Number(owner.group_pid)).toBeGreaterThan(1);
      expect(owner.group_identity).toBeTruthy();
      const lease = join(daemon.home, "workflow-repositories", "leases", String(owner.lease_id));
      expect(existsSync(lease)).toBe(true);
      expect(existsSync(String(owner.home_path))).toBe(true);
      const started = join(daemon.home, "repository-provider-started");
      const originalPid = Number(readFileSync(started, "utf8"));
      expect(originalPid).toBeGreaterThan(1);
      await daemon.crash();
      // Model a cancellation whose acknowledgement was lost just before the crash.
      withDaemonDb(daemon, db => db.prepare(`UPDATE workflow_repository_workloads SET state='cancellation_pending',
        cancellation_generation=1, error_code='cancellation_unconfirmed' WHERE id=?`).run(owner.workload_id!));
      if (marker === "E2E_LOCAL_CLEANUP_RESTART_MISMATCH")
        withDaemonDb(daemon, db => db.prepare("UPDATE workflow_repository_local_owners SET lease_nonce=? WHERE workload_id=?")
          .run(crypto.randomUUID(), owner.workload_id!));
      await daemon.restart();
      if (marker === "E2E_LOCAL_CLEANUP_RESTART_MISMATCH") {
        await expect.poll(async () => (await detail()).run.status, { timeout: 40_000 }).toBe("blocked");
        expect((await detail()).llmCalls.filter((call: { purpose: string }) => call.purpose === "persona_review")).toHaveLength(1);
        expect(existsSync(lease)).toBe(true);
        expect(existsSync(String(owner.home_path))).toBe(true);
        withDaemonDb(daemon, db => db.prepare("UPDATE workflow_repository_local_owners SET lease_nonce=? WHERE workload_id=?")
          .run(owner.lease_nonce!, owner.workload_id!));
        await post(`/api/workflow-runs/${run.id}/retry`, { requestId: "retry-confirmed-local-owner" });
      }
      await expect.poll(() => Number(readFileSync(started, "utf8")), { timeout: 40_000 }).not.toBe(originalPid);
      const replacementPid = Number(readFileSync(started, "utf8"));
      expect(() => process.kill(originalPid, 0)).toThrow(/ESRCH/);
      writeFileSync(join(daemon.home, `repository-review-ready-${replacementPid}`), "ready");
      await expect.poll(async () => (await detail()).run.status, { timeout: 40_000 }).toBe("completed");
      const result = await detail();
      expect(result.llmCalls.filter((call: { purpose: string }) => call.purpose === "persona_review")).toHaveLength(2);
      expect(withDaemonDb(daemon, db => db.prepare("SELECT state FROM workflow_repository_workloads WHERE id=?")
        .get(owner.workload_id!)?.state)).toBe("failed");
      expect(withDaemonDb(daemon, db => db.prepare("SELECT count(*) AS n FROM workflow_repository_local_owners").get()?.n)).toBe(0);
      expect(existsSync(lease)).toBe(false);
      expect(existsSync(String(owner.home_path))).toBe(false);
      return;
    }
    writeFileSync(join(daemon.home, "repository-review-ready"), "ready");
    if (marker === "E2E_QUERY_SNAPSHOTS") {
      await expect.poll(async () => (await detail()).run.status).toBe("waiting_for_session");
      await expect.poll(() => withDaemonDb(daemon, db => db.prepare(
        "SELECT payload FROM workflow_deliveries WHERE run_id=? AND kind='persona_feedback'",
      ).get(run.id)?.payload)).toContain("[repository] submitted.txt · lines [1, 2)");
      const first = (await detail()).repositoryReview.snapshot.digest as string;
      await post(`/api/workflow-runs/${run.id}/resubmit`, { requestId: "changed-checkout" });
      await expect.poll(async () => (await detail()).run.status).toBe("completed");
      const latest = (await detail()).repositoryReview.snapshot.digest as string;
      expect(latest).not.toBe(first);
      await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
      const history = dashboard.getByRole("region", { name: "Repository queries" });
      await expect(history.getByText(/Latest submission snapshot/)).toContainText(latest.slice(0, 12));
      for (const [digest, items] of [[first, 2], [latest, 1]] as const) {
        const row = history.locator("details").filter({ has: dashboard.locator("summary").filter({ hasText: digest.slice(0, 12) }) });
        await row.locator("summary").click();
        await expect(row.getByText(digest, { exact: true })).toBeVisible();
        await expect(row.getByText("submitted.txt · lines [1, 2)", { exact: true })).toBeVisible();
        await expect(row.getByText("submitted.txt · lines [2, 3)", { exact: true })).toHaveCount(items - 1);
      }
      await captureState(dashboard, "query-snapshots", history);
      const worklist = dashboard.getByRole("region", { name: "Review worklist" });
      const range = "submitted.txt · lines [1, 2)";
      for (const [round, digest] of [[2, latest], [1, first]] as const) {
        await dashboard.locator(".wf-run-scrubber").getByRole("button", { name: new RegExp("^Round " + round) }).click();
        await worklist.getByRole("button", { name: range, exact: true }).click();
        const selected = history.locator("details[open]").filter({ hasText: digest });
        await expect(selected.getByRole("mark")).toHaveText(range);
        await expect(selected.getByRole("mark")).toBeFocused();
      }
      await captureState(dashboard, "citation-query", history.getByRole("mark"));
      return;
    }
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
      await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
      const history = dashboard.getByRole("region", { name: "Repository queries" });
      await dashboard.route(/repository-queries\?after=[1-9]/, route => route.fulfill({ status: 503, body: "Unavailable" }), { times: 1 });
      await history.getByRole("button", { name: "Next queries" }).click();
      const retryQueries = history.getByRole("button", { name: "Retry loading queries" });
      await captureState(dashboard, "retry-query-page", retryQueries);
      await retryQueries.click();
      await expect(history.getByRole("alert")).toHaveCount(0);
      await expect(history.getByRole("button", { name: "Next queries" })).toHaveCount(0);
      await expect(history.getByText(/git_log · revision_out_of_range/)).toBeVisible();
      const releasePage = Promise.withResolvers<void>();
      await dashboard.route("**/repository-queries?after=0&limit=10", async route => {
        await releasePage.promise;
        await route.continue();
      }, { times: 1 });
      try {
        await history.getByRole("button", { name: "First queries" }).click();
        await expect(history.getByText(/git_log · revision_out_of_range/)).toHaveCount(0);
        await expect(history.getByRole("button", { name: "Next queries" })).toHaveCount(0);
      } finally {
        releasePage.resolve();
      }
      await expect(history.getByRole("button", { name: "Next queries" })).toBeVisible();
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
      await dashboard.context().addInitScript(() => {
        Object.defineProperty(navigator, "locks", { value: undefined });
      });
      await dashboard.evaluate(id => localStorage.setItem("mission.workflow.publish." + id, "{broken"), workflow.id);
      await dashboard.reload();
      const discard = dashboard.getByRole("button", { name: "Discard unreadable publish request" });
      await captureState(dashboard, "discard-unreadable", discard);
      await discard.click();
      const publishRequests: { requestId: string; expectedDraftRevision: number }[] = [];
      const firstResponse = Promise.withResolvers<void>();
      await dashboard.route(`**/api/workflows/${workflow.id}/publish`, async route => {
        publishRequests.push(route.request().postDataJSON());
        if (publishRequests.length === 1) {
          // The daemon commits the version, but the browser never receives its receipt.
          const committed = await route.fetch();
          expect(committed.ok()).toBe(true);
          await firstResponse.promise;
          await route.fulfill({ status: 503, json: { error: "Publish response unavailable" } });
        } else {
          await route.continue();
        }
      });
      const publish = dashboard.getByRole("button", { name: "Publish", exact: true });
      await publish.click();
      const second = dashboard.getByRole("button", { name: /^Version 2/ });
      await expect(second).toBeVisible();
      const reopened = await dashboard.context().newPage();
      try {
        await reopened.goto(dashboard.url());
        await expect(reopened.getByRole("button", { name: "Retry publish (revision 1)", exact: true })).toBeEnabled();
      } finally {
        firstResponse.resolve();
        await reopened.close();
      }
      const retry = dashboard.getByRole("button", { name: "Retry publish (revision 1)", exact: true });
      await expect(retry).toBeEnabled();
      const workflowUrl = `${daemon.baseURL}/api/workflows/${workflow.id}`;
      const advanced = await dashboard.request.patch(workflowUrl, {
        data: { expectedDraftRevision: 1, name: "Advanced review draft" },
      });
      expect(advanced.ok()).toBe(true);
      await expect(dashboard.getByRole("heading", { name: "Advanced review draft" })).toBeVisible();
      await expect(dashboard.getByText("Draft revision 2", { exact: true })).toBeVisible();
      await dashboard.reload();
      await expect(retry).toBeEnabled();
      await captureState(dashboard, "publish-retry", retry);
      const unbound = await dashboard.request.delete(`${daemon.baseURL}/api/workflow-bindings/${binding.id}`);
      expect(unbound.ok(), await unbound.text()).toBe(true);
      const archived = await dashboard.request.delete(workflowUrl, { data: { expectedDraftRevision: 2 } });
      expect(archived.ok(), await archived.text()).toBe(true);
      await expect(dashboard.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
      await expect(retry).toBeEnabled();
      const replayResponse = dashboard.waitForResponse(response => response.url() === workflowUrl + "/publish");
      await retry.click();
      const replay = await (await replayResponse).json();
      expect(replay).toMatchObject({ idempotent: true, version: { version: 2, sourceDraftRevision: 1 } });
      expect(publishRequests[0]).toMatchObject({ expectedDraftRevision: 1, requestId: expect.any(String) });
      expect(publishRequests).toEqual([publishRequests[0], publishRequests[0]]);
      await expect(publish).toBeDisabled();
      await dashboard.getByRole("button", { name: "Restore", exact: true }).click();
      await second.click();
      const source = dashboard.getByText(/Repository reviewer · revision/);
      if (!await dashboard.getByText("No repository access", { exact: true }).isVisible()) await source.click();
      await expect(dashboard.getByText("No repository access", { exact: true })).toBeVisible();
      await publish.click();
      await expect(dashboard.getByRole("button", { name: /^Version 3/ })).toBeVisible();
      expect(publishRequests[2]).toMatchObject({ expectedDraftRevision: 4, requestId: expect.any(String) });
      expect(publishRequests[2]!.requestId).not.toBe(publishRequests[0]!.requestId);
      await expect(publish).toBeDisabled();
      await dashboard.reload();
      await expect(publish).toBeDisabled();
      await expect(retry).toHaveCount(0);
      const granted = await dashboard.request.patch(`${daemon.baseURL}/api/personas/${persona.id}/repository-access`, {
        data: { repositoryAccess: "read", expectedAccessRevision: (await changed.json()).repositoryAccessRevision },
      });
      expect(granted.ok()).toBe(true);
      await publish.click();
      await expect(dashboard.getByRole("button", { name: /^Version 4/ })).toBeVisible();
      await expect(publish).toBeDisabled();
      const accessUrl = daemon.baseURL + "/api/personas/" + persona.id + "/repository-access";
      const removed = await dashboard.request.patch(accessUrl, {
        data: { repositoryAccess: "none", expectedAccessRevision: (await granted.json()).repositoryAccessRevision },
      });
      expect(removed.ok()).toBe(true);
      const releaseReceipt = Promise.withResolvers<void>();
      await dashboard.route("**/api/workflows/" + workflow.id + "/publish", async route => {
        const receipt = await route.fetch();
        await releaseReceipt.promise;
        await route.fulfill({ response: receipt });
      }, { times: 1 });
      try {
        await publish.click();
        await expect(dashboard.getByRole("button", { name: /^Version 5/ })).toBeVisible();
        const restored = await dashboard.request.patch(accessUrl, {
          data: { repositoryAccess: "read", expectedAccessRevision: (await removed.json()).repositoryAccessRevision },
        });
        expect(restored.ok()).toBe(true);
        const newer = await post("/api/workflows/" + workflow.id + "/publish", {
          expectedDraftRevision: 4, requestId: "separate-grant-at-same-revision",
        });
        expect(newer.version.version).toBe(6);
        await expect(dashboard.getByRole("button", { name: /^Version 6/ })).toBeVisible();
      } finally {
        releaseReceipt.resolve();
      }
      await expect.poll(() => dashboard.evaluate(id => localStorage.getItem("mission.workflow.publish." + id), workflow.id)).toBeNull();
      await expect(dashboard.getByRole("button", { name: "Duplicate", exact: true })).toBeEnabled();
      await expect(publish).toBeDisabled();
    }
  });
}
