import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The route boundary owns source attribution and MCP authentication. This isolated app uses
// one discovered session and an injected product-issue service, never the operator's gh.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-product-issues-http-"));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { ProductIssueService } = await import("../src/server/product-issues.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
const { PRODUCT_ISSUE_REQUIRED_LABELS } = await import("../src/shared/product-issues.ts");
const { mkMuxHandle } = await import("./helpers/session-fixture.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ProductIssueService as ProductIssueServiceType } from "../src/server/product-issues.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const JSON_HEADERS = { ...LOOPBACK, "content-type": "application/json" };
const MCP_HEADERS = { ...JSON_HEADERS, "x-harness-token": TOKEN };

const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const queues = new QueueManager(registry);
const discovered: DiscoveredSession = {
  syntheticId: "product-reporter",
  agent: "claude",
  name: "reporter",
  nameSource: "tmux",
  cwd: "/repo/product",
  gitBranch: "main",
  gitRoot: null,
  repoRoot: null,
  pid: 8112,
  tty: "ttys019",
  terminals: [mkMuxHandle({
    session: "reporter",
    windowName: "work",
    windowIndex: 0,
    paneId: "%19",
  })],
  startedAt: 0,
};
registry.applyDiscovery([discovered]);

function appFor(service: ProductIssueServiceType) {
  const args: Parameters<typeof buildApp> = [registry, reviews, tasks, queues];
  args[21] = service;
  return buildApp(...args);
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    type: "documentation",
    title: "Clarify the session guide",
    details: "The runtime section needs one complete example.",
    attachmentUploadIds: [],
    requestId: randomUUID(),
    client: "browser",
    ...overrides,
  };
}

test("dashboard and MCP routes derive different fixed source labels", async () => {
  const calls: string[][] = [];
  const service = new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async (_bin, args) => {
      calls.push(args);
      return stubRun({
        stdout: "https://github.com/acme/public-issues/issues/3\n",
        stderr: "",
        code: 0,
      });
    },
  });
  const app = appFor(service);
  const dashboardDraft = draft();
  const dashboard = await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(dashboardDraft),
  });
  assert.equal(dashboard.status, 200);
  assert.deepEqual(
    ((await dashboard.json()) as { labels: string[] }).labels,
    ["documentation", "status:needs-triage", "source:dashboard"],
  );

  const agentDraft = draft();
  const agent = await app.request("/mcp/product-issues/preview", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      ...agentDraft,
      env: { tmuxPane: "%19" },
      cwd: "/repo/product",
    }),
  });
  assert.equal(agent.status, 200);
  assert.deepEqual(
    ((await agent.json()) as { labels: string[] }).labels,
    ["documentation", "status:needs-triage", "source:agent"],
  );
  const agentSubmit = await app.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      ...agentDraft,
      env: { tmuxPane: "%19" },
      cwd: "/repo/product",
    }),
  });
  assert.equal(agentSubmit.status, 201);
  assert.deepEqual(
    calls[0]!.filter((value, index, all) => all[index - 1] === "--label"),
    ["documentation", "status:needs-triage", "source:agent"],
  );
});

test("MCP preview and mutation require the token and a live attributed session", async () => {
  const app = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
  }));
  const input = draft();
  for (const path of ["/mcp/product-issues/preview", "/mcp/product-issues"]) {
    const unauthorized = await app.request(path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...input, env: { tmuxPane: "%19" } }),
    });
    assert.equal(unauthorized.status, 401, path);

    const missing = await app.request(path, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ ...input, env: { tmuxPane: "%404" } }),
    });
    assert.equal(missing.status, 404, path);
  }
});

test("mutation revalidates the previewed draft and returns the exact issue URL", async () => {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const app = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async (_bin, args, options) => {
      calls.push({ args, input: options?.input });
      return stubRun({
        stdout: "https://github.com/acme/public-issues/issues/88\n",
        stderr: "",
        code: 0,
      });
    },
  }));
  const input = draft();
  assert.equal((await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })).status, 200);

  const changed = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, title: "Changed after preview" }),
  });
  assert.equal(changed.status, 502);
  assert.equal(calls.length, 0);

  const submitted = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(submitted.status, 201);
  assert.deepEqual(await submitted.json(), {
    outcome: "created",
    issueUrl: "https://github.com/acme/public-issues/issues/88",
    target: "acme/public-issues",
  });
  assert.deepEqual(
    calls[0]!.args.flatMap((value, index) => value === "--label" ? [calls[0]!.args[index + 1]!] : []),
    ["documentation", "status:needs-triage", "source:dashboard"],
  );
  assert.match(calls[0]!.input ?? "", /## Environment/);
});

test("caller-owned routing fields are rejected at both write boundaries", async () => {
  const app = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
  }));
  const forged = draft({
    source: "agent",
    repo: "attacker/target",
    labels: ["arbitrary"],
  });
  const dashboard = await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(forged),
  });
  assert.equal(dashboard.status, 400);
  const mcp = await app.request("/mcp/product-issues/preview", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ ...forged, env: { tmuxPane: "%19" } }),
  });
  assert.equal(mcp.status, 400);
});

test("refusal is retry-safe, while unknown outcome is a typed 504", async () => {
  let attempt = 0;
  const retryApp = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async () => {
      attempt++;
      return attempt === 1
        ? stubRun({ stdout: "", stderr: "not authenticated", code: 1 })
        : stubRun({
            stdout: "https://github.com/acme/public-issues/issues/91\n",
            stderr: "",
            code: 0,
          });
    },
  }));
  const retryDraft = draft();
  await retryApp.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(retryDraft),
  });
  const refused = await retryApp.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(retryDraft),
  });
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), {
    outcome: "refused",
    message: "GitHub CLI refused the issue: not authenticated",
    retrySafe: true,
  });
  assert.equal((await retryApp.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(retryDraft),
  })).status, 201);

  const unknownApp = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async () => ({
      ...stubRun({ stdout: "", stderr: "", code: 1 }),
      outcomeUnknown: true,
    }),
  }));
  const unknownDraft = draft();
  await unknownApp.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(unknownDraft),
  });
  const unknown = await unknownApp.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(unknownDraft),
  });
  assert.equal(unknown.status, 504);
  const unknownBody = (await unknown.json()) as { outcome: string; retrySafe: boolean };
  assert.equal(unknownBody.outcome, "unknown");
  assert.equal(unknownBody.retrySafe, false);
});

test("production attachment and demo-mode gates run before the subprocess", async () => {
  let calls = 0;
  const runner = async () => {
    calls++;
    return stubRun({ stdout: "", stderr: "", code: 0 });
  };
  const productionApp = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner,
  }));
  const attachment = await productionApp.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(draft({ attachmentUploadIds: ["fabricated.png"] })),
  });
  assert.equal(attachment.status, 502);

  const demoApp = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner,
    demoMode: true,
  }));
  const demoDraft = draft();
  const preview = await demoApp.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(demoDraft),
  });
  assert.equal(preview.status, 503);
  assert.equal(((await preview.json()) as { outcome: string }).outcome, "configuration");
  const demo = await demoApp.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(demoDraft),
  });
  assert.equal(demo.status, 503);
  assert.equal(((await demo.json()) as { outcome: string }).outcome, "configuration");
  assert.equal(calls, 0);
});

test("read-only preflight is exposed without creating or editing GitHub state", async () => {
  const args: string[][] = [];
  const responses = [
    stubRun({ stdout: "gh version 2\n", stderr: "", code: 0 }),
    stubRun({ stdout: "authenticated\n", stderr: "", code: 0 }),
    stubRun({ stdout: "acme/public-issues\n", stderr: "", code: 0 }),
    stubRun({
      stdout: JSON.stringify(PRODUCT_ISSUE_REQUIRED_LABELS.map((name) => ({ name }))),
      stderr: "",
      code: 0,
    }),
  ];
  const app = appFor(new ProductIssueService({
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async (_bin, argv) => {
      args.push(argv);
      return responses.shift()!;
    },
  }));
  const response = await app.request("/api/product-issues/preflight", { headers: LOOPBACK });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ready: boolean }).ready, true);
  assert.deepEqual(args.map((argv) => argv.slice(0, 2)), [
    ["--version"],
    ["auth", "status"],
    ["repo", "view"],
    ["label", "list"],
  ]);
  assert.equal(args.some((argv) => argv.includes("create") || argv.includes("edit")), false);
});
