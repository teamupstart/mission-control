import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_LIMITS } from "../src/shared/workflow.ts";
import { SessionActionCapabilitiesSchema } from "../src/shared/protocol.ts";

// What is at stake: HTTP is the only write boundary for a SessionAction. Every mutation must
// pass the shared Zod schema, a stale revision must preserve both tabs' text, archive must
// leave a readable row rather than turning Delete into historical data loss, and a skill id
// must never be able to smuggle a command through a field the daemon later resolves.

const home = mkdtempSync(join(tmpdir(), "mission-session-actions-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SessionActionManager } = await import("../src/server/workflows/session-actions.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { PULL_REQUEST_SESSION_ACTION_ID } =
  await import("../src/server/workflows/builtin-session-actions.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function fixture() {
  clearWorkflowTables(db);
  const registry = new Registry();
  const sessionActions = new SessionActionManager(registry, new WorkflowStore(db));
  const app = buildApp({
    registry,
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
    sessionActions,
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
  return { registry, request };
}

const body = (value: unknown): string => JSON.stringify(value);

test("create goes through parseBody, answers 201, and preserves the prompt exactly", async () => {
  const { request } = fixture();
  const malformed = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "No prompt" }),
  });
  assert.equal(malformed.status, 400);

  const promptMarkdown = "# Ship it\r\n\r\nExact trailing space  \r\n";
  const response = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Ship it", promptMarkdown, requiredSkillId: "pull-request" }),
  });
  assert.equal(response.status, 201);
  const created = await response.json() as { id: string; promptMarkdown: string; revision: number; completion: { kind: string } };
  assert.equal(created.promptMarkdown, promptMarkdown);
  assert.equal(created.revision, 1);
  assert.deepEqual(created.completion, { kind: "session_turn" });

  const fetched = await request(`/api/session-actions/${created.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json() as { promptMarkdown: string }).promptMarkdown, promptMarkdown);
});

test("a required skill is data, so anything shaped like a command is a 400", async () => {
  const { request } = fixture();
  for (const requiredSkillId of ["npm test", "a; rm -rf /", "../escape", "$(id)"]) {
    const response = await request("/api/session-actions", {
      method: "POST",
      body: body({ name: `n${requiredSkillId}`, promptMarkdown: "p", requiredSkillId }),
    });
    assert.equal(response.status, 400, `${requiredSkillId} must be refused`);
  }
});

test("a completion adapter outside the closed registry is a 400", async () => {
  const { request } = fixture();
  const response = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Bad", promptMarkdown: "p", completion: { kind: "shell" } }),
  });
  assert.equal(response.status, 400);
});

test("a stale revision is a 409 that names the code and returns the current row", async () => {
  const { request } = fixture();
  const created = await (await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Ship it", promptMarkdown: "# One\n" }),
  })).json() as { id: string };

  const first = await request(`/api/session-actions/${created.id}`, {
    method: "PATCH",
    body: body({ expectedRevision: 1, promptMarkdown: "# First tab\n" }),
  });
  assert.equal(first.status, 200);

  const stale = await request(`/api/session-actions/${created.id}`, {
    method: "PATCH",
    body: body({ expectedRevision: 1, promptMarkdown: "# Second tab\n" }),
  });
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as { code: string; current: { promptMarkdown: string } };
  assert.equal(conflict.code, "session_action_revision_conflict");
  // Both tabs keep their text: the loser is told what is on disk rather than overwritten.
  assert.equal(conflict.current.promptMarkdown, "# First tab\n");
});

test("a name already taken is its own 409 code, not a generic conflict", async () => {
  const { request } = fixture();
  await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Ship it", promptMarkdown: "p" }),
  });
  const duplicate = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "  SHIP   IT ", promptMarkdown: "p" }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { code: string }).code, "session_action_name_conflict");
});

test("DELETE archives, and the row stays readable and listable", async () => {
  const { request } = fixture();
  const created = await (await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Ship it", promptMarkdown: "p" }),
  })).json() as { id: string };

  const missingRevision = await request(`/api/session-actions/${created.id}`, { method: "DELETE" });
  assert.equal(missingRevision.status, 400);

  // Archive parses a body, so it is bounded like every other write here - and bounded to its
  // OWN size. Its whole schema is one integer, so a cap sized from the prompt ceiling would
  // have been a body limit in name only.
  const oversize = await request(`/api/session-actions/${created.id}`, {
    method: "DELETE",
    body: body({ expectedRevision: 1, padding: "x".repeat(4096) }),
  });
  assert.equal(oversize.status, 413);
  // And the row is untouched: a refused request must not have archived anything.
  assert.equal(
    (await (await request(`/api/session-actions/${created.id}`)).json() as { archivedAt: number | null }).archivedAt,
    null,
  );

  const archived = await request(`/api/session-actions/${created.id}`, {
    method: "DELETE",
    body: body({ expectedRevision: 1 }),
  });
  assert.equal(archived.status, 200);
  assert.notEqual((await archived.json() as { archivedAt: number | null }).archivedAt, null);

  const active = await (await request("/api/session-actions")).json() as Array<{ id: string }>;
  assert.equal(active.some((action) => action.id === created.id), false);
  const all = await (await request("/api/session-actions?includeArchived=true")).json() as Array<{ id: string }>;
  assert.ok(all.some((action) => action.id === created.id));
  // Still addressable by id, because a draft or a version may already name it.
  assert.equal((await request(`/api/session-actions/${created.id}`)).status, 200);
});

test("a built-in refuses every write and names the way forward", async () => {
  const { request } = fixture();
  const listed = await (await request("/api/session-actions")).json() as Array<{ id: string }>;
  assert.ok(listed.some((action) => action.id === PULL_REQUEST_SESSION_ACTION_ID));

  for (const [method, payload] of [
    ["PATCH", { expectedRevision: 1, description: "mine" }],
    ["DELETE", { expectedRevision: 1 }],
  ] as const) {
    const response = await request(`/api/session-actions/${PULL_REQUEST_SESSION_ACTION_ID}`, {
      method,
      body: body(payload),
    });
    assert.equal(response.status, 409);
    const refusal = await response.json() as { code: string; error: string };
    assert.equal(refusal.code, "session_action_builtin");
    assert.match(refusal.error, /Duplicate it/);
  }
  // And its name is reserved, so a copy has to be named something else.
  const shadow = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Pull Request", promptMarkdown: "p" }),
  });
  assert.equal(shadow.status, 409);
  assert.equal((await shadow.json() as { code: string }).code, "session_action_name_conflict");
});

test("unknown ids, bad query values, and oversized bodies are refused at the door", async () => {
  const { request } = fixture();
  assert.equal((await request("/api/session-actions/nope")).status, 404);
  assert.equal((await request("/api/session-actions?includeArchived=yes")).status, 400);

  // The route's cap sits above the schema's, so a prompt the schema would accept is never
  // rejected as "too large" - and one far past both is refused before it is parsed.
  const oversize = "x".repeat(WORKFLOW_LIMITS.sessionActionPromptBytes * 8);
  const tooLarge = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Huge", promptMarkdown: oversize }),
  });
  assert.equal(tooLarge.status, 413);

  // Just over the schema's ceiling is a 400, which is the boundary doing the deciding.
  const overSchema = "x".repeat(WORKFLOW_LIMITS.sessionActionPromptBytes + 1);
  const refused = await request("/api/session-actions", {
    method: "POST",
    body: body({ name: "Big", promptMarkdown: overSchema }),
  });
  assert.equal(refused.status, 400);
});

test("the capabilities route serves the daemon's OWN registry, before the id route", async () => {
  const { request } = fixture();
  const res = await request("/api/session-actions/capabilities");
  assert.equal(res.status, 200, "the literal path was swallowed as a session action id");
  const parsed = SessionActionCapabilitiesSchema.safeParse(await res.json());
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  // The client never invents support: whatever this says is what the runtime will do, and a
  // published version naming an unavailable adapter is refused at Publish for the same reason.
  // Every shipped adapter runs now, and the shape that carries a refusal is still here rather
  // than deleted - it is what a future adapter arrives unavailable through.
  //
  // The ORDER is asserted too, and it is the append-only tuple's: a capability list served in
  // some other order would let a browser that reads it positionally offer the wrong proof.
  assert.deepEqual(
    parsed.data.completions.map((item) => [item.kind, item.available]),
    [["session_turn", true], ["pull_request", true], ["repo_commit", true]],
  );
  for (const completion of parsed.data.completions) {
    assert.equal(
      completion.unavailableReason,
      null,
      `${completion.kind} is available, so it states no refusal`,
    );
  }
});

test("the routes answer honestly when the daemon supplied no manager", async () => {
  const registry = new Registry();
  const app = buildApp({ registry, reviews: null as never, tasks: null as never, queues: null as never });
  const response = await app.request("/api/session-actions", {
    headers: { host: "127.0.0.1:7317" },
  });
  assert.equal(response.status, 503);
});
