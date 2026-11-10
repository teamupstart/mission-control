import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectorComment, InspectorCommentStatus, InspectorSeverity } from "../src/shared/types.ts";

// `GET /api/inspector/findings?pr=<prKey>` is the only way Foreman's worker and the dashboard
// can read a pull request's individual findings: the worker never touches SQLite, and no
// other route returns finding rows outside a gated workflow run. Both clients parse the same
// response schema, so this file drives the route and then each client against it.
const home = mkdtempSync(join(tmpdir(), "mission-inspector-findings-route-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { adoptInspectorPr, openDb, upsertInspectorComment } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ForemanClient } = await import("../src/server/foreman/client.ts");
const { fetchInspectorFindings } = await import("../src/web/lib/api.ts");
const { InspectorFindingsResponseSchema } = await import("../src/shared/protocol.ts");
const { findingPublication } = await import("../src/shared/inspector-findings.ts");

openDb();
const registry = new Registry();
const app = buildApp({
  registry,
  reviews: new ReviewManager(registry),
  tasks: new TaskManager(registry),
  queues: new QueueManager(registry),
});
const LOOPBACK = { host: "127.0.0.1:7317" };
const KEY = "owner/repo#7";

function adopt(number: number, state: "open" | "closed" = "open"): void {
  adoptInspectorPr({
    key: `owner/repo#${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    owner: "owner",
    repo: "repo",
    number,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: "sess-1",
    source: "hook",
    state,
    headSha: "head-1",
    reviewPosture: "live",
    round: 2,
    lastReviewedAt: 1_000,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: "feature",
    title: "Findings route",
    adoptedAt: 1_000,
    updatedAt: 1_000,
  });
}

function seed(
  fingerprint: string,
  status: InspectorCommentStatus,
  severity: InspectorSeverity,
  over: Partial<InspectorComment> = {},
): void {
  upsertInspectorComment({
    id: `id-${fingerprint}`,
    prKey: KEY,
    fingerprint,
    path: "src/a.ts",
    line: 10,
    title: `Issue ${fingerprint}`,
    body: `Detail ${fingerprint}`,
    severity,
    round: 1,
    status,
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
}

beforeEach(() => {
  openDb().exec("DELETE FROM inspector_prs; DELETE FROM inspector_comments");
});

test("a missing or malformed pull request key is a 400, before the ledger is asked", async () => {
  adopt(7);
  for (const query of ["", "?pr=", "?pr=nope", "?pr=owner/repo", "?pr=owner/repo%23", "?pr=a/b/c%231",
    "?pr=owner/repo%237%20", "?pr=owner/repo%23x"]) {
    const res = await app.request(`/api/inspector/findings${query}`, { headers: LOOPBACK });
    assert.equal(res.status, 400, `"${query}" must be refused`);
    assert.match(((await res.json()) as { error: string }).error, /owner\/repo#123/);
  }
});

test("a pull request number may be at most ten digits", async () => {
  adopt(7);
  // Ten digits is a well-formed key, so it reaches the ledger lookup and misses: a 404.
  const ten = await app.request(`/api/inspector/findings?pr=${encodeURIComponent("owner/repo#1234567890")}`, {
    headers: LOOPBACK,
  });
  assert.equal(ten.status, 404);
  assert.deepEqual(await ten.json(), { error: "no adopted pull request with that key" });
  // Eleven is refused by shape before the ledger is asked: a 400.
  const eleven = await app.request(`/api/inspector/findings?pr=${encodeURIComponent("owner/repo#12345678901")}`, {
    headers: LOOPBACK,
  });
  assert.equal(eleven.status, 400);
  assert.match(((await eleven.json()) as { error: string }).error, /owner\/repo#123/);
});

test("a well-formed key for a pull request the ledger never adopted is a 404", async () => {
  adopt(7);
  const res = await app.request(`/api/inspector/findings?pr=${encodeURIComponent("owner/repo#8")}`, {
    headers: LOOPBACK,
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no adopted pull request with that key" });
});

test("an adopted pull request returns every finding, in every status, in the renderer's order", async () => {
  adopt(7);
  // Seeded out of order on purpose: the route sorts, the ledger's insertion order does not.
  seed("f-resolved-blocker", "resolved", "blocker", { postedAt: 500, githubUrl: "https://github.com/owner/repo/pull/7#discussion_r1" });
  seed("f-nit", "drafted", "nit");
  seed("f-major-b", "open", "major", { path: "src/b.ts", postedAt: 600 });
  seed("f-major-a", "posting", "major", { path: "src/a.ts" });
  seed("f-resolved-minor", "resolved", "minor");
  seed("f-blocker", "open", "blocker", { line: null, postedAt: 700 });

  const res = await app.request(`/api/inspector/findings?pr=${encodeURIComponent(KEY)}`, {
    headers: LOOPBACK,
  });
  assert.equal(res.status, 200);
  const body = InspectorFindingsResponseSchema.parse(await res.json());

  assert.equal(body.pr.key, KEY);
  assert.equal(body.pr.openFindings, 4, "drafted, posting and open all count as unresolved");
  assert.equal(body.pr.postedOpenFindings, 2);
  assert.equal(body.pr.resolvedFindings, 2);
  assert.deepEqual(
    body.findings.map((f) => f.fingerprint),
    // Unresolved first; then severity, path, line and fingerprint.
    ["f-blocker", "f-major-a", "f-major-b", "f-nit", "f-resolved-blocker", "f-resolved-minor"],
  );
  const byFp = new Map(body.findings.map((f) => [f.fingerprint, f]));
  assert.equal(byFp.get("f-resolved-blocker")?.postedAt, 500);
  assert.equal(byFp.get("f-resolved-blocker")?.githubUrl, "https://github.com/owner/repo/pull/7#discussion_r1");
  assert.equal(byFp.get("f-nit")?.postedAt, null);
  assert.equal(byFp.get("f-nit")?.legacyPosted, null, "a row this build wrote carries no legacy answer");
  assert.deepEqual(
    body.findings.map((f) => findingPublication(f).state),
    ["posted", "posting", "posted", "not-posted", "posted", "not-posted"],
  );
});

// A draft GitHub refused 3 times is no longer offered, but it is not resolved: it still counts
// as an open finding, so Shipping and YOLO still see it (they count every row that is not
// resolved) and Foreman, which triggers on that count, still relays it.
test("a refused draft stays unresolved, and its count and reason travel with it", async () => {
  adopt(8);
  const key = "owner/repo#8";
  const reason = "Line could not be resolved (HTTP 422)";
  seed("f-once", "drafted", "major", { prKey: key, postRefusals: 1, lastPostError: reason });
  seed("f-capped", "drafted", "major", { prKey: key, postRefusals: 3, lastPostError: reason });

  const res = await app.request(`/api/inspector/findings?pr=${encodeURIComponent(key)}`, {
    headers: LOOPBACK,
  });
  assert.equal(res.status, 200);
  const body = InspectorFindingsResponseSchema.parse(await res.json());
  assert.equal(body.pr.openFindings, 2, "a refused draft is still an open finding");
  assert.equal(body.pr.resolvedFindings, 0);
  const byFp = new Map(body.findings.map((f) => [f.fingerprint, findingPublication(f)]));
  assert.deepEqual(
    (({ state, refusals, reason: why }) => ({ state, refusals, why }))(byFp.get("f-once")!),
    { state: "not-posted", refusals: 1, why: reason },
  );
  assert.deepEqual(
    (({ state, refusals, reason: why }) => ({ state, refusals, why }))(byFp.get("f-capped")!),
    { state: "refused", refusals: 3, why: reason },
  );
});

test("an adopted pull request with no findings returns an empty list rather than a 404", async () => {
  adopt(9);
  const res = await app.request(`/api/inspector/findings?pr=${encodeURIComponent("owner/repo#9")}`, {
    headers: LOOPBACK,
  });
  assert.equal(res.status, 200);
  const body = InspectorFindingsResponseSchema.parse(await res.json());
  assert.deepEqual(body.findings, []);
  assert.equal(body.pr.openFindings, 0);
});

/** Route `fetch` into the in-process app, so each client reads the real route. */
async function withAppFetch<T>(run: (paths: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://127.0.0.1:7317");
    paths.push(url.pathname + url.search);
    return app.request(url.pathname + url.search, { headers: LOOPBACK });
  }) as typeof fetch;
  try {
    return await run(paths);
  } finally {
    globalThis.fetch = real;
  }
}

test("Foreman's client reads the route through the shared schema, and a refusal throws", async () => {
  adopt(7);
  seed("f-open", "open", "major", { postedAt: 600 });
  seed("f-draft", "drafted", "minor");
  await withAppFetch(async (paths) => {
    const client = new ForemanClient();
    const read = await client.inspectorFindings(KEY);
    assert.equal(read.pr.key, KEY);
    assert.deepEqual(read.findings.map((f) => f.fingerprint), ["f-open", "f-draft"]);
    assert.equal(read.findings[0]?.postedAt, 600);
    assert.equal(paths.at(-1), "/api/inspector/findings?pr=owner%2Frepo%237", "the key is encoded");
    // A failed read must be distinguishable from an empty one, so the relay can hold.
    await assert.rejects(client.inspectorFindings("owner/repo#404"), /404/);
  });
});

test("the web client reads the same route through the same schema, and a refusal reads as null", async () => {
  adopt(7);
  seed("f-open", "open", "major", { postedAt: 600 });
  await withAppFetch(async () => {
    const read = await fetchInspectorFindings(KEY);
    assert.ok(read);
    assert.deepEqual(read.findings.map((f) => f.fingerprint), ["f-open"]);
    assert.equal(read.findings[0]?.postedAt, 600);
    assert.equal(await fetchInspectorFindings("owner/repo#404"), null);
    assert.equal(await fetchInspectorFindings("not a key"), null);
  });
});

test("both clients refuse a successful response that does not match the shared schema", async () => {
  // HTTP 200 bodies that a cast would pass through: a finding with an unknown status, a
  // pull request missing its tallies, and a body that is not the response shape at all.
  const missingTallies = {
    pr: { key: KEY },
    findings: [],
  };
  const bodies: unknown[] = [
    { ...missingTallies, findings: [{ fingerprint: "f", status: "refused" }] },
    missingTallies,
    { findings: "nope" },
    null,
  ];
  const real = globalThis.fetch;
  try {
    for (const body of bodies) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      await assert.rejects(new ForemanClient().inspectorFindings(KEY), (err: unknown) =>
        err instanceof Error && err.name === "ZodError", `Foreman must reject ${JSON.stringify(body)}`);
      assert.equal(await fetchInspectorFindings(KEY), null, `the web client must reject ${JSON.stringify(body)}`);
    }
  } finally {
    globalThis.fetch = real;
  }
});

// `?state=open` is how Foreman's follow-through finds an open pull request the Inspector adopted
// under a session whose card no longer carries it.
test("/api/inspector/prs?state=open returns only open rows, with tallies and CodeRabbit standing", async () => {
  adopt(7);
  adopt(8, "closed");
  seed("f-draft", "drafted", "minor");
  const res = await app.request("/api/inspector/prs?state=open", { headers: LOOPBACK });
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ key: string; openFindings: number; codeRabbit?: unknown }>;
  assert.deepEqual(rows.map((row) => row.key), [KEY]);
  assert.equal(rows[0]?.openFindings, 1);
  assert.ok(rows[0]?.codeRabbit, "codeRabbit is added as the unfiltered reading adds it");

  await withAppFetch(async (paths) => {
    const read = await new ForemanClient().openInspections();
    assert.deepEqual(read.map((row) => row.key), [KEY]);
    assert.equal(paths.at(-1), "/api/inspector/prs?state=open");
  });
});

test("/api/inspector/prs refuses a state it does not serve, and state with adoptedSince", async () => {
  adopt(7);
  for (const query of ["?state=closed", "?state=", "?state=OPEN", "?state=open&adoptedSince=1"]) {
    const res = await app.request(`/api/inspector/prs${query}`, { headers: LOOPBACK });
    assert.equal(res.status, 400, `"${query}" must be refused`);
  }
});
