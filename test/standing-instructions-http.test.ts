import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// The four standing-instruction routes.
//
// The through-line is that this feature can lie in exactly one direction that costs an
// operator anything: reporting that NOTHING will be sent when a block in fact will be. A
// marker saying "nothing" is the reason somebody stops looking, so every path in and out is
// canonicalized through `resolveRepoPath` and every refusal is loud.

const home = mkdtempSync(join(tmpdir(), "mission-standing-http-"));
process.env.HARNESS_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { openDb } = await import("../src/server/db.ts");
const { resolveRepoPath } = await import("../src/server/repos.ts");
const { STANDING_INSTRUCTIONS_HEADING } = await import("../src/server/instructions/compose.ts");
const { STANDING_INSTRUCTIONS_CONFLICT_CODE } = await import("../src/shared/protocol.ts");
const { STANDING_INSTRUCTIONS_MAX_LENGTH } = await import(
  "../src/shared/standing-instructions.ts"
);

type Registry = import("../src/server/registry.ts").Registry;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type StandingInstructionsSnapshot =
  import("../src/server/db.ts").StandingInstructionsSnapshot;

after(() => rmSync(home, { recursive: true, force: true }));

const sessions = new Map<string, { id: string }>();
const snapshots = new Map<string, StandingInstructionsSnapshot>();
const registry = {
  getSession: (id: string) => sessions.get(id),
  standingInstructionsFor: (id: string) => snapshots.get(id) ?? null,
} as unknown as Registry;
const app = buildApp({
  registry,
  reviews: {} as unknown as ReviewManager,
  tasks: {} as unknown as TaskManager,
  queues: {} as unknown as QueueManager,
});

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

/** This checkout, and a package-level subdirectory of it. */
const CHECKOUT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SUBDIR = fileURLToPath(new URL("../src/shared", import.meta.url)).replace(/\/$/, "");

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  sessions.clear();
  snapshots.clear();
});

interface View {
  default: string;
  repositories: Record<string, string>;
  etag: string;
}

async function view(): Promise<View> {
  const res = await app.request("/api/instructions", { headers: HEADERS });
  assert.equal(res.status, 200);
  return (await res.json()) as View;
}

async function put(body: unknown): Promise<Response> {
  return app.request("/api/instructions", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

test("a stored repository key is the canonical repo-rooted PATH, never the repository root", async () => {
  // The trap this closes. `resolveRepoRoot` is lossy by design - `/repo/packages/web`
  // resolves to `/repo` - so storing `.repoRoot` would collapse a package-level rule onto the
  // monorepo, overwrite whatever was there, and make the longest-match behaviour the store
  // advertises impossible to configure at all.
  const before = await view();
  const res = await put({ expectedEtag: before.etag, repositories: { [SUBDIR]: "package rule" } });
  assert.equal(res.status, 200);

  const resolved = await resolveRepoPath(SUBDIR);
  assert.ok(resolved, "the fixture must resolve");
  assert.notEqual(resolved.path, resolved.repoRoot, "the fixture must be a SUBDIRECTORY");
  const stored = (await res.json()) as View;
  assert.deepEqual(Object.keys(stored.repositories), [resolved.path]);
  // And a linked worktree is re-rooted onto the main checkout it belongs to, so a throwaway
  // pool path never reaches durable config. This test file runs inside such a worktree.
  assert.equal(resolved.path.startsWith(resolved.repoRoot), true);
});

test("an unresolvable repository key is refused, and nothing is written", async () => {
  const before = await view();
  const res = await put({
    expectedEtag: before.etag,
    repositories: { "/definitely/not/a/repo/xyzzy": "rule" },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /not a git repository/);
  assert.deepEqual((await view()).repositories, {});
});

test("two spellings of one checkout in a single patch are refused rather than last-wins", async () => {
  const before = await view();
  const res = await put({
    expectedEtag: before.etag,
    repositories: { [CHECKOUT]: "one rule", [`${CHECKOUT}/`]: "a different rule" },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /listed twice/);
});

test("a stale expectedEtag is a 409 carrying the current view, and writes nothing", async () => {
  const first = await view();
  assert.equal((await put({ expectedEtag: first.etag, default: "machine rule" })).status, 200);

  const res = await put({ expectedEtag: first.etag, default: "clobbered" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string; current: View };
  assert.equal(body.code, STANDING_INSTRUCTIONS_CONFLICT_CODE);
  assert.equal(body.current.default, "machine rule", "the conflict carries what is stored now");
  assert.equal((await view()).default, "machine rule");
});

test("an oversize body is a 413 before the schema ever sees it", async () => {
  const first = await view();
  const res = await put({ expectedEtag: first.etag, default: "x".repeat(20_000_000) });
  assert.equal(res.status, 413);
});

test("a multi-repository patch the schema accepts is not refused by the transport first", async () => {
  // The failure this closes: the body limit budgeted for ONE box and ONE key, while the
  // schema accepts up to STANDING_INSTRUCTIONS_MAX_REPOSITORIES of them. Eleven full-length
  // repositories is already enough to be rejected with 413 before the schema it satisfies is
  // ever consulted - the API saying yes and the transport saying no, with nothing in the
  // refusal to tell a caller which limit it hit.
  const first = await view();
  const repositories: Record<string, string> = {};
  // Eleven DISTINCT keys - package-level directories of this checkout, which is what a
  // monorepo's per-package rules look like and what `resolveRepoPath` preserves. Real paths,
  // because the route canonicalizes every key: a fixture that was merely long would clear the
  // transport and then be refused for an entirely different reason.
  for (const dir of [
    "src/shared",
    "src/server",
    "src/web",
    "test",
    "docs",
    "e2e",
    "scripts",
    "skills",
    "personas",
    "src/server/harness",
    "src/server/instructions",
  ]) {
    repositories[join(CHECKOUT, dir)] = "x".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH);
  }
  const res = await put({
    expectedEtag: first.etag,
    default: "y".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH),
    repositories,
  });
  assert.equal(res.status, 200, "a schema-valid patch is not a 413");
  const stored = (await res.json()) as View;
  assert.equal(stored.default.length, STANDING_INSTRUCTIONS_MAX_LENGTH);
  assert.equal(Object.keys(stored.repositories).length, 11);
});

test("the resolved route previews what a launch would send, for this exact pair", async () => {
  const first = await view();
  assert.equal(
    (await put({ expectedEtag: first.etag, repositories: { [CHECKOUT]: "never run E2E locally" } }))
      .status,
    200,
  );

  const res = await app.request(
    `/api/instructions/resolved?repoPath=${encodeURIComponent(SUBDIR)}&agent=claude&runtime=terminal`,
    { headers: HEADERS },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { text: string; mechanism: string; sources: unknown[] };
  // A SUBDIRECTORY of the configured checkout, previewed through the same canonicalization
  // and the same longest-match rule the launch uses.
  assert.equal(body.text, `${STANDING_INSTRUCTIONS_HEADING}\n\nnever run E2E locally`);
  // The mechanism is a property of the PAIR, not of the repository - the same text is a
  // system prompt here and on Pi, while Codex terminal uses turn-one prose.
  assert.equal(body.mechanism, "claude-append-system-prompt");

  const pi = await app.request(
    `/api/instructions/resolved?repoPath=${encodeURIComponent(CHECKOUT)}&agent=pi&runtime=terminal`,
    { headers: HEADERS },
  );
  assert.equal(((await pi.json()) as { mechanism: string }).mechanism, "pi-append-system-prompt");
});

test("the resolved route refuses a missing repoPath, an unknown agent and an unoffered runtime", async () => {
  const ask = (query: string) =>
    app.request(`/api/instructions/resolved?${query}`, { headers: HEADERS });

  assert.equal((await ask("agent=claude&runtime=terminal")).status, 400);
  assert.equal(
    (await ask(`repoPath=${encodeURIComponent(CHECKOUT)}&agent=gpt&runtime=terminal`)).status,
    400,
  );
  // Pi declares no embedded driver. Answering with a default here would invent the one thing
  // `resolveSessionRuntime` already owns.
  assert.equal(
    (await ask(`repoPath=${encodeURIComponent(CHECKOUT)}&agent=pi&runtime=sdk`)).status,
    400,
  );
  assert.equal(
    (await ask(`repoPath=/definitely/not/a/repo&agent=claude&runtime=terminal`)).status,
    400,
  );
});

test("a two-repo preview where only the SECOND repository has rules returns that block", async () => {
  // The preview has to answer for the whole manifest. Asking about only the repository the
  // operator picked would report that nothing will be sent while the launch sends the
  // secondary's rules.
  const first = await view();
  assert.equal(
    (await put({ expectedEtag: first.etag, repositories: { [CHECKOUT]: "the second rule" } }))
      .status,
    200,
  );
  const res = await app.request(
    `/api/instructions/resolved?repoPath=%2F&repoPath=${encodeURIComponent(CHECKOUT)}` +
      `&agent=claude&runtime=terminal`,
    { headers: HEADERS },
  );
  // `/` is not a repository, so a launch could not attach it - the refusal is the honest
  // answer, and it is loud. The point of the case is that the SECOND value is read at all.
  assert.equal(res.status, 400);

  const both = await app.request(
    `/api/instructions/resolved?repoPath=${encodeURIComponent(SUBDIR)}` +
      `&repoPath=${encodeURIComponent(CHECKOUT)}&agent=claude&runtime=terminal`,
    { headers: HEADERS },
  );
  assert.equal(both.status, 200);
  const body = (await both.json()) as { text: string; sources: { repoPath: string }[] };
  assert.equal(body.sources.length, 2, "both checkouts inherit the same key here");
  assert.match(body.text, /the second rule/);
});

test("the session route answers with what THAT session received, or 404", async () => {
  sessions.set("s1", { id: "s1" });
  assert.equal((await app.request("/api/sessions/s1/standing-instructions", { headers: HEADERS })).status, 404);
  assert.equal((await app.request("/api/sessions/nope/standing-instructions", { headers: HEADERS })).status, 404);

  snapshots.set("s1", {
    noteKey: "s1",
    text: "## Standing instructions for this repository\n\nnever force-push",
    mechanism: "claude-append-system-prompt",
    sources: [{ repoPath: "/ws/repo", matchedKey: "/ws/repo" }],
    createdAt: 1,
  });
  const res = await app.request("/api/sessions/s1/standing-instructions", { headers: HEADERS });
  assert.equal(res.status, 200);
  // The same shape the resolved route returns, deliberately: "what will be sent" and "what
  // was sent" render through one component and neither can acquire a field the other lacks.
  assert.deepEqual(await res.json(), {
    text: "## Standing instructions for this repository\n\nnever force-push",
    mechanism: "claude-append-system-prompt",
    sources: [{ repoPath: "/ws/repo", matchedKey: "/ws/repo" }],
  });
});
