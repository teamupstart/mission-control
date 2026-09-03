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
const { PRODUCT_ISSUE_CONFIRMATION_TTL_MS, PRODUCT_ISSUE_REQUIRED_LABELS } = await import(
  "../src/shared/product-issues.ts"
);
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

/**
 * The two answers a person can give, and the shell that cannot ask.
 *
 * Injected rather than mocked at the transport, because the point of the design is that the
 * answer does NOT come over the transport: in the shipped app this port reaches the Electron
 * shell over its utility-process channel and resolves when a native dialog is clicked.
 */
const YES = { unavailable: null, ask: () => Promise.resolve(true) };
const NO = { unavailable: null, ask: () => Promise.resolve(false) };

/**
 * Take the confirming step, the way the modal's first press does.
 *
 * A helper rather than five copies, because every publishing test below needs it and the
 * point of the design is that publishing is unreachable without it.
 */
async function confirm(
  app: ReturnType<typeof appFor>,
  input: unknown,
): Promise<{ token: string; draftIdentity: string; target: string; expiresAt: number }> {
  const res = await app.request("/api/product-issues/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    token: string;
    draftIdentity: string;
    target: string;
    expiresAt: number;
  };
}

test("dashboard and MCP routes derive different fixed source labels", async () => {
  const calls: string[][] = [];
  const service = new ProductIssueService({
    consent: YES,
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
    consent: YES,
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

/**
 * The dashboard mutation, and the two things that make it safe to have.
 *
 * Phase 1 held this route back on purpose: "preview then submit" alone proves only that
 * SOMETHING called preview, not that anybody asked for the public content to go out. What
 * closes that is a grant minted by its own confirming step - unguessable, so it cannot be
 * computed from the draft the way the `draftIdentity` hash can, and NOT handed out by the
 * preview reply, so it cannot arrive merely because a form re-read its own content.
 *
 * Both of those were revisions of this route that were wrong, and both regressions are
 * pinned below: a hash of the request authorizes every submission of that request forever,
 * and a token in the preview reply is a publish capability delivered by typing.
 */
test("the dashboard mutation publishes only against the confirmation it minted", async () => {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const app = appFor(new ProductIssueService({
    consent: YES,
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
  const previewed = await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(previewed.status, 200);
  const preview = (await previewed.json()) as Record<string, unknown>;
  // Reading hands out no publishing authority at all. This is the regression guard on the
  // revision that shipped a token in this reply: the modal previews on every settled
  // keystroke, so a capability delivered here is one that arrives by typing.
  assert.equal(
    "confirmationToken" in preview,
    false,
    "the preview reply must carry no publish token - confirming is its own step",
  );

  // Publishing needs the confirming step, which is where the grant is minted.
  const grant = await confirm(app, input);
  // Unguessable, and NOT the draft hash. A token equal to `draftIdentity` would be
  // reproducible by any holder of the draft, which is exactly the bypass this replaced.
  assert.match(grant.token, /^[0-9a-f]{64}$/);
  assert.notEqual(grant.token, grant.draftIdentity);
  assert.equal(grant.draftIdentity, preview.draftIdentity);
  assert.equal(grant.target, "acme/public-issues");

  // No confirmation at all is refused by the schema, before the service is reached.
  const unconfirmed = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(calls.length, 0);

  // The draft's own hash is not a confirmation. This is the regression guard on the earlier
  // revision: it was accepted then, and must never be again.
  const hashAsToken = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: grant.draftIdentity }),
  });
  assert.equal(hashAsToken.status, 502);
  assert.equal(calls.length, 0);

  // Nor is a well-formed token that was never issued.
  const forged = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: "b".repeat(64) }),
  });
  assert.equal(forged.status, 502);
  assert.equal(((await forged.json()) as { outcome: string }).outcome, "refused");
  assert.equal(calls.length, 0);

  // Confirmed for one title, submitted with another. The preview no longer describes what
  // would be published, so the token that named it does not authorize it.
  const edited = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...input,
      title: "A different title entirely",
      confirmationToken: grant.token,
    }),
  });
  assert.equal(edited.status, 502);
  assert.equal(calls.length, 0);

  const created = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: grant.token }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    outcome: "created",
    issueUrl: "https://github.com/acme/public-issues/issues/88",
    target: "acme/public-issues",
  });
  assert.equal(calls.length, 1);
  // The browser named a type, a title and details. Everything that can steer GitHub is the
  // daemon's - including the source label, which the request has no field for at all.
  assert.deepEqual(
    calls[0]!.args.filter((value, index, all) => all[index - 1] === "--label"),
    ["documentation", "status:needs-triage", "source:dashboard"],
  );
  assert.deepEqual(
    calls[0]!.args.slice(0, 4),
    ["issue", "create", "--repo", "acme/public-issues"],
  );
  assert.match(calls[0]!.input ?? "", /mission-control-product-report:v1/);
});

/**
 * The confirmation names content, not just a draft.
 *
 * This is the case the browser cannot make on its own: the reporter's words never change, but
 * the daemon's DERIVATION does - the operator repoints the target between the moment a person
 * reads the preview and the moment they press. Publishing then would put the report in a
 * repository nobody was shown, which is precisely the "trusted preview" the plan asks for.
 */
test("a confirmation is refused once the daemon's own derivation has moved", async () => {
  let calls = 0;
  let repo = "acme/public-issues";
  const app = appFor(new ProductIssueService({
    consent: YES,
    target: () => ({ ok: true, repo }),
    runner: async () => {
      calls++;
      return stubRun({
        stdout: `https://github.com/${repo}/issues/99\n`,
        stderr: "",
        code: 0,
      });
    },
  }));
  const input = draft();
  await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  const first = await confirm(app, input);
  assert.equal(first.target, "acme/public-issues");

  // The operator repoints the target. The draft on screen is untouched.
  repo = "somewhere/else-entirely";

  const stale = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: first.token }),
  });
  assert.equal(stale.status, 502);
  assert.equal(calls, 0, "a moved target must not publish against the old confirmation");

  // Previewing shows the NEW target, and confirming that mints a different grant. Only the
  // one taken against what is now on screen publishes.
  const previewedAgain = (await (await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  })).json()) as { target: string };
  assert.equal(previewedAgain.target, "somewhere/else-entirely");
  const second = await confirm(app, input);
  assert.equal(second.target, "somewhere/else-entirely");
  assert.notEqual(second.token, first.token);
  const republished = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: second.token }),
  });
  assert.equal(republished.status, 201);
  assert.equal(calls, 1);
});

/**
 * A retry-safe refusal keeps its confirmation; a publish retires it.
 *
 * Both halves matter. Retiring on a refusal would cost a person the confirmation they just
 * gave for content that provably did not go anywhere, and NOT retiring after a publish would
 * leave a token that files the same public issue again.
 */
test("a refused submission may be retried on the same confirmation, a published one may not", async () => {
  let outcome: "refused" | "created" = "refused";
  let calls = 0;
  const app = appFor(new ProductIssueService({
    consent: YES,
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async () => {
      calls++;
      return outcome === "refused"
        ? stubRun({ stdout: "", stderr: "label not found", code: 1 })
        : stubRun({
            stdout: "https://github.com/acme/public-issues/issues/91\n",
            stderr: "",
            code: 0,
          });
    },
  }));
  const input = draft();
  await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  const { token } = await confirm(app, input);
  const body = JSON.stringify({ ...input, confirmationToken: token });

  const refused = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body,
  });
  assert.equal(refused.status, 502);
  assert.equal(((await refused.json()) as { retrySafe: boolean }).retrySafe, true);

  outcome = "created";
  const created = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body,
  });
  assert.equal(created.status, 201, "the same confirmation must still work after a refusal");

  // And now it is spent. 504 rather than 201: an issue provably exists for this opening, and
  // the honest answer to "did my second press file a second one" is "go and look".
  const replay = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body,
  });
  assert.equal(replay.status, 504);
  assert.equal(((await replay.json()) as { retrySafe: boolean }).retrySafe, false);
  assert.equal(calls, 2);
});

/** No preview carries a publish token, and the agent cannot reach the confirming step. */
test("neither preview mints a publish token, and confirming is dashboard-only", async () => {
  const app = appFor(new ProductIssueService({
    consent: YES,
    target: () => ({ ok: true, repo: "acme/public-issues" }),
  }));
  const dashboard = (await (await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(draft()),
  })).json()) as Record<string, unknown>;
  assert.equal("confirmationToken" in dashboard, false);

  const agent = (await (await app.request("/mcp/product-issues/preview", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ ...draft(), env: { tmuxPane: "%19" }, cwd: "/repo/product" }),
  })).json()) as Record<string, unknown>;
  assert.equal("confirmationToken" in agent, false);

  // And there is no confirming step on the MCP side at all. An agent that could mint its own
  // grant would be a second way to publish beside the `input` review Phase 1 built, which is
  // the authorization the agent path actually has.
  const agentConfirm = await app.request("/mcp/product-issues/confirm", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ ...draft(), env: {}, cwd: "/repo/product" }),
  });
  assert.equal(agentConfirm.status, 404);
});

/**
 * The bypass this feature has been rebuilt four times to close, driven exactly as reported.
 *
 * A local process previews, confirms, and publishes, in that order, over the loopback API that
 * every process running as the operator can reach. It gets as far as reading the public content
 * - previewing is a read, and reads were never the problem - and then stops, because the
 * confirming step is not answered by the request. It is answered by a person, through a channel
 * the caller is not on.
 *
 * The three revisions this replaces each failed by trying to make the confirmation something a
 * caller PRESENTS: a hash of the request, then a token from the preview reply, then the
 * per-machine bearer token. Each was reachable by the caller, the last one because the token is
 * a file a process running as the operator can read. This one is not a value at all.
 */
test("a caller the operator refuses can preview, confirm nothing, and publish nothing", async () => {
  let calls = 0;
  let asked = 0;
  const app = appFor(new ProductIssueService({
    consent: {
      unavailable: null,
      ask: () => {
        asked++;
        return Promise.resolve(false);
      },
    },
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async () => {
      calls++;
      return stubRun({ stdout: "https://x/1\n", stderr: "", code: 0 });
    },
  }));
  const input = draft();

  const previewed = await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(previewed.status, 200);
  const preview = (await previewed.json()) as Record<string, unknown>;
  assert.equal("confirmationToken" in preview, false);

  // The caller may ask. Asking is all it can do - and every ask reaches a real person, which
  // is why a script cannot do this quietly.
  const confirmed = await app.request("/api/product-issues/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(confirmed.status, 409);
  assert.equal(asked, 1, "the confirming route must actually ask, not decide for itself");
  assert.match(
    ((await confirmed.json()) as { message: string }).message,
    /not confirmed/,
  );

  // And the draft's own hash, the very first revision's authorization, still publishes nothing.
  const published = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: preview.draftIdentity as string }),
  });
  assert.equal(published.status, 502);
  assert.equal(calls, 0, "the reported bypass must reach no gh at any step");
});

/**
 * A daemon nobody can ask publishes nothing, and says so before anything is typed.
 *
 * This is the daemon started on its own - `npm run dev`, a LaunchAgent, a plain `node` - where
 * there is no shell to raise a dialog. It refuses rather than falling back to a confirmation it
 * could satisfy by itself, and preflight carries the reason so the form is honest on open.
 */
test("a daemon with no way to ask refuses to confirm, and announces it in preflight", async () => {
  let calls = 0;
  const app = appFor(new ProductIssueService({
    consent: {
      unavailable: "Publishing needs the Mission Control desktop app",
      ask: () => Promise.resolve(false),
    },
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async () => {
      calls++;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  }));
  const input = draft();
  await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  const confirmed = await app.request("/api/product-issues/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  assert.equal(confirmed.status, 503);
  assert.equal(((await confirmed.json()) as { outcome: string }).outcome, "configuration");

  const preflight = (await (await app.request("/api/product-issues/preflight", { headers: LOOPBACK })).json()) as {
    ready: boolean;
    problems: Array<{ code: string; message: string }>;
  };
  assert.equal(preflight.ready, false);
  assert.equal(preflight.problems[0]?.code, "consent-unavailable");
  assert.equal(calls, 0, "a daemon that cannot ask must not run gh, even for preflight");
});

/**
 * Confirming is refused for content the daemon never rendered.
 *
 * Without this the confirming step would be a way to mint a grant for anything at all, and
 * "the grant describes something a person was shown" would stop being true.
 */
test("a report that was never previewed cannot be confirmed", async () => {
  const app = appFor(new ProductIssueService({
    consent: YES,
    target: () => ({ ok: true, repo: "acme/public-issues" }),
  }));
  const res = await app.request("/api/product-issues/confirm", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(draft()),
  });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { message: string }).message, /Preview this product issue/);
});

/**
 * A grant goes stale on its own, without anybody touching the draft.
 *
 * Two minutes, mirrored by the modal. An approval that never ages is one that can be taken
 * once and spent whenever - which is a different thing from the deliberate second press this
 * design is built around.
 */
test("a confirmation expires, and an expired one publishes nothing", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const app = appFor(new ProductIssueService({
    consent: YES,
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    now: () => now,
    runner: async () => {
      calls++;
      return stubRun({
        stdout: "https://github.com/acme/public-issues/issues/77\n",
        stderr: "",
        code: 0,
      });
    },
  }));
  const input = draft();
  await app.request("/api/product-issues/preview", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  const grant = await confirm(app, input);
  assert.equal(grant.expiresAt, now + PRODUCT_ISSUE_CONFIRMATION_TTL_MS);

  now += PRODUCT_ISSUE_CONFIRMATION_TTL_MS + 1;
  const late = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: grant.token }),
  });
  assert.equal(late.status, 502);
  assert.match(
    ((await late.json()) as { message: string }).message,
    /confirmation expired|was not confirmed/,
  );
  assert.equal(calls, 0, "an expired confirmation must reach no gh");

  // Confirming again is all it takes; nothing about the report had to change.
  const fresh = await confirm(app, input);
  const published = await app.request("/api/product-issues", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...input, confirmationToken: fresh.token }),
  });
  assert.equal(published.status, 201);
  assert.equal(calls, 1);
});

test("MCP mutation revalidates the previewed draft and returns the exact issue URL", async () => {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const app = appFor(new ProductIssueService({
    consent: YES,
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
  const envelope = { ...input, env: { tmuxPane: "%19" }, cwd: "/repo/product" };
  assert.equal((await app.request("/mcp/product-issues/preview", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(envelope),
  })).status, 200);

  const changed = await app.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ ...envelope, title: "Changed after preview" }),
  });
  assert.equal(changed.status, 502);
  assert.equal(calls.length, 0);

  const submitted = await app.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(envelope),
  });
  assert.equal(submitted.status, 201);
  assert.deepEqual(await submitted.json(), {
    outcome: "created",
    issueUrl: "https://github.com/acme/public-issues/issues/88",
    target: "acme/public-issues",
  });
  assert.deepEqual(
    calls[0]!.args.flatMap((value, index) => value === "--label" ? [calls[0]!.args[index + 1]!] : []),
    ["documentation", "status:needs-triage", "source:agent"],
  );
  assert.match(calls[0]!.input ?? "", /## Environment/);
});

test("caller-owned routing fields are rejected at both preview boundaries", async () => {
  const app = appFor(new ProductIssueService({
    consent: YES,
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
    consent: YES,
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
  const retryEnvelope = {
    ...retryDraft,
    env: { tmuxPane: "%19" },
    cwd: "/repo/product",
  };
  await retryApp.request("/mcp/product-issues/preview", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(retryEnvelope),
  });
  const refused = await retryApp.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(retryEnvelope),
  });
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), {
    outcome: "refused",
    message: "GitHub CLI refused the issue: not authenticated",
    retrySafe: true,
  });
  assert.equal((await retryApp.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(retryEnvelope),
  })).status, 201);

  const unknownApp = appFor(new ProductIssueService({
    consent: YES,
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner: async () => ({
      ...stubRun({ stdout: "", stderr: "", code: 1 }),
      outcomeUnknown: true,
    }),
  }));
  const unknownDraft = draft();
  const unknownEnvelope = {
    ...unknownDraft,
    env: { tmuxPane: "%19" },
    cwd: "/repo/product",
  };
  await unknownApp.request("/mcp/product-issues/preview", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(unknownEnvelope),
  });
  const unknown = await unknownApp.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(unknownEnvelope),
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
    consent: YES,
    target: () => ({ ok: true, repo: "acme/public-issues" }),
    runner,
  }));
  const attachment = await productionApp.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      ...draft({ attachmentUploadIds: ["fabricated.png"] }),
      env: { tmuxPane: "%19" },
      cwd: "/repo/product",
    }),
  });
  assert.equal(attachment.status, 502);

  const demoApp = appFor(new ProductIssueService({
    consent: YES,
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
  const demo = await demoApp.request("/mcp/product-issues", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      ...demoDraft,
      env: { tmuxPane: "%19" },
      cwd: "/repo/product",
    }),
  });
  assert.equal(demo.status, 503);
  assert.equal(((await demo.json()) as { outcome: string }).outcome, "configuration");
  assert.equal(calls, 0);
});

test("read-only preflight is exposed without creating or editing GitHub state", async () => {
  const args: string[][] = [];
  const responses = [
    stubRun({ stdout: "gh version 2.99.0 (test)\n", stderr: "", code: 0 }),
    stubRun({ stdout: "authenticated\n", stderr: "", code: 0 }),
    stubRun({ stdout: "acme/public-issues\n", stderr: "", code: 0 }),
    stubRun({
      stdout: JSON.stringify([PRODUCT_ISSUE_REQUIRED_LABELS.map((name) => ({ name }))]),
      stderr: "",
      code: 0,
    }),
  ];
  const app = appFor(new ProductIssueService({
    consent: YES,
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
    ["api", "--paginate"],
  ]);
  assert.deepEqual(args[3], [
    "api",
    "--paginate",
    "--slurp",
    "repos/acme/public-issues/labels?per_page=100",
  ]);
  assert.equal(args.some((argv) => argv.includes("create") || argv.includes("edit")), false);
});
