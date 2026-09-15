import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// The Foreman-invite foundation (docs/plans/foreman-invite/phase-1-invite-foundation.md):
// every session carries a truthful, durable `foremanInvite`, resolved by the registry from
// one rule - a 'withdrawn' tombstone means null, any other row speaks for itself, no row
// means the runtime decides. What is at stake in the rotation tests is the bug class the
// design exists to prevent: an invite written under the pre-hook synthetic key that does
// NOT move with the key silently un-invites Foreman from a session Mission Control just
// dispatched, which is indistinguishable on the dashboard from "Foreman chose to ignore
// this" - no error, no event, just a quiet session.

const home = mkdtempSync(join(tmpdir(), "mission-foreman-invite-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const {
  upsertForemanInvite,
  getForemanInvite,
  deleteForemanInvite,
  loadForemanInvites,
  moveForemanInvite,
  pruneForemanInvites,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

let seq = 0;
/** A fresh key per test, so nothing here depends on test order in one shared db. */
function key(name: string): string {
  return `${name}-${++seq}`;
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys00${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/task-${n}`,
    gitBranch: "harness/task",
    pid: n,
    tty: `ttys00${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** Register one discovered terminal session and return it. */
function discover(
  registry: InstanceType<typeof Registry>,
  over: Partial<DiscoveredSession> = {},
): Session {
  const d = mkDiscovered(over);
  registry.applyDiscovery([d]);
  const s = registry.getSession(d.syntheticId);
  assert.ok(s, "discovery should register the session");
  return s;
}

function mkSdk(registry: InstanceType<typeof Registry>): Session {
  return registry.registerSdkSession({
    id: `sdk:invite-${++seq}`,
    agent: "claude",
    name: "embedded",
    cwd: "/repo",
  });
}

/** Collect session_upsert emissions for one session id. */
function upserts(registry: InstanceType<typeof Registry>, id: string): Session[] {
  const seen: Session[] = [];
  registry.on("event", (e: ServerEvent) => {
    if (e.type === "session_upsert" && e.session.id === id) seen.push(e.session);
  });
  return seen;
}

// ---- db accessors ----

test("invite rows round-trip, and the tombstone upserts over a grant", () => {
  const k = key("roundtrip");
  assert.equal(getForemanInvite(k), undefined);
  upsertForemanInvite(k, "dispatch", 100);
  assert.deepEqual(getForemanInvite(k), { noteKey: k, source: "dispatch", createdAt: 100 });
  // One row per key holds the LATEST explicit state: withdrawal replaces the grant.
  upsertForemanInvite(k, "withdrawn", 200);
  assert.deepEqual(getForemanInvite(k), { noteKey: k, source: "withdrawn", createdAt: 200 });
  assert.ok(loadForemanInvites().some((r) => r.noteKey === k && r.source === "withdrawn"));
  deleteForemanInvite(k);
  assert.equal(getForemanInvite(k), undefined);
});

test("the CHECK constraint refuses a source outside the persisted domain", () => {
  // The domain is append-only; a value this build never defined must fail loudly at the
  // write rather than surface later as an unreadable invite.
  assert.throws(() =>
    openDb()
      .prepare(`INSERT INTO foreman_invites (note_key, source, created_at) VALUES (?, ?, ?)`)
      .run(key("check"), "sneaky", 1),
  );
});

test("a source written by a newer build is reported and read as no row", () => {
  // The downgrade scenario the change-contracts entry names: a newer build widened the
  // CHECK constraint (this build's CREATE is a no-op on the existing table) and wrote a
  // value these types never named. Simulated by suspending check enforcement for one
  // insert - the same bytes that schema would leave on disk. The guard is at the READ:
  // the raw string must never masquerade as a ForemanInvite on the wire, and the row
  // must not be destroyed - it belongs to the build that understands it.
  const k = key("future-source");
  const d = openDb();
  d.exec("PRAGMA ignore_check_constraints = ON;");
  d.prepare(`INSERT INTO foreman_invites (note_key, source, created_at) VALUES (?, ?, ?)`)
    .run(k, "future-grant", 1);
  d.exec("PRAGMA ignore_check_constraints = OFF;");
  try {
    assert.equal(getForemanInvite(k), undefined, "an unreadable source narrows to no row");
    assert.ok(!loadForemanInvites().some((r) => r.noteKey === k), "boot load drops it too");
    const raw = d
      .prepare(`SELECT source FROM foreman_invites WHERE note_key = ?`)
      .get(k) as unknown as { source: string };
    assert.equal(raw.source, "future-grant", "the row itself is left in place, not deleted");

    // A registry booted over it resolves from the runtime alone: a terminal session on
    // that key is uninvited, an SDK session keeps its implicit grant.
    const registry = new Registry();
    const term = discover(registry, { agentSessionId: k } as Partial<DiscoveredSession>);
    assert.equal(term.foremanInvite, null);
    const sdk = registry.registerSdkSession({
      id: `sdk:future-${++seq}`,
      agent: "claude",
      name: "embedded",
      cwd: "/repo",
      agentSessionId: k,
    });
    assert.equal(sdk.foremanInvite, "sdk");
  } finally {
    d.prepare(`DELETE FROM foreman_invites WHERE note_key = ?`).run(k);
  }
});

test("moveForemanInvite carries the row, and the moved row wins a conflict", () => {
  const from = key("move-from");
  const to = key("move-to");
  upsertForemanInvite(from, "dispatch", 100);
  moveForemanInvite(from, to);
  assert.equal(getForemanInvite(from), undefined);
  assert.deepEqual(getForemanInvite(to), { noteKey: to, source: "dispatch", createdAt: 100 });

  // Nothing at the source: a no-op that must not disturb the target.
  moveForemanInvite(key("move-empty"), to);
  assert.equal(getForemanInvite(to)?.source, "dispatch");

  // A resident row under the target is the same pane's earlier state; the moved row
  // followed the pane and wins, keeping its own created_at.
  const from2 = key("move-from2");
  upsertForemanInvite(from2, "withdrawn", 300);
  moveForemanInvite(from2, to);
  assert.deepEqual(getForemanInvite(to), { noteKey: to, source: "withdrawn", createdAt: 300 });
});

test("pruneForemanInvites keeps live keys, and an empty live set deletes nothing", () => {
  const live = key("prune-live");
  const dead = key("prune-dead");
  upsertForemanInvite(live, "operator", 10);
  upsertForemanInvite(dead, "operator", 10);
  // An empty set means "liveness unknown", never "nothing is live" - pruneSessionGoals'
  // safety property, inherited whole.
  assert.equal(pruneForemanInvites([], 1_000), 0);
  assert.ok(getForemanInvite(dead));
  // ">=": the shared db may hold stale keys from earlier tests in this file, and the
  // prune rightly takes them too. What is pinned is the pair below, not the count.
  assert.ok(pruneForemanInvites([live], 1_000) >= 1);
  assert.ok(getForemanInvite(live), "a live key is never touched, whatever its age");
  assert.equal(getForemanInvite(dead), undefined);
  deleteForemanInvite(live);
});

// ---- registry resolution ----

test("resolution: sdk implicitly, rows explicitly, tombstone beats everything", () => {
  const registry = new Registry();

  // No row, SDK runtime: invited by construction, nothing stored.
  const sdk = mkSdk(registry);
  assert.equal(sdk.foremanInvite, "sdk");
  assert.equal(getForemanInvite(sdk.id), undefined);

  // No row, terminal runtime: uninvited.
  const term = discover(registry);
  assert.equal(term.foremanInvite, null);

  // A dispatch row resolves to "dispatch" - the dispatcher's door - and persists.
  assert.equal(registry.setForemanInvite(term.id, "dispatch"), "dispatch");
  assert.equal(registry.getSession(term.id)?.foremanInvite, "dispatch");
  assert.equal(getForemanInvite(term.id)?.source, "dispatch");

  // An operator row resolves to "operator".
  const term2 = discover(registry);
  assert.equal(registry.inviteForeman(term2.id), "operator");
  assert.equal(registry.getSession(term2.id)?.foremanInvite, "operator");

  // The tombstone resolves to null on a terminal session...
  assert.equal(registry.withdrawForemanInvite(term2.id), null);
  assert.equal(registry.getSession(term2.id)?.foremanInvite, null);
  // ...and on an SDK session, where it beats the implicit grant - the one state no
  // absence of a row can express.
  assert.equal(registry.withdrawForemanInvite(sdk.id), null);
  assert.equal(registry.getSession(sdk.id)?.foremanInvite, null);
  assert.equal(getForemanInvite(sdk.id)?.source, "withdrawn");

  // Unknown session: undefined, not a write.
  assert.equal(registry.setForemanInvite("no-such", "dispatch"), undefined);
  assert.equal(registry.inviteForeman("no-such"), undefined);
  assert.equal(registry.withdrawForemanInvite("no-such"), undefined);
});

test("restore-then-elevate: re-inviting a withdrawn SDK session restores the implicit grant", () => {
  const registry = new Registry();
  const sdk = mkSdk(registry);
  registry.withdrawForemanInvite(sdk.id);
  assert.equal(registry.getSession(sdk.id)?.foremanInvite, null);

  // The tombstone is deleted and the runtime-implied grant RESUMES - "sdk", not a
  // permanent invisible "operator" downgrade (which phase 2's backlog gate would then
  // silently exclude from assignment).
  assert.equal(registry.inviteForeman(sdk.id), "sdk");
  assert.equal(registry.getSession(sdk.id)?.foremanInvite, "sdk");
  assert.equal(getForemanInvite(sdk.id), undefined, "no row - the grant is implicit again");
});

test("restore-then-elevate: 'operator' is written only from a truly null state", () => {
  const registry = new Registry();

  // Never-invited terminal: elevates to "operator".
  const fresh = discover(registry);
  assert.equal(registry.inviteForeman(fresh.id), "operator");

  // Withdrawn previously-dispatched terminal: the tombstone replaced the 'dispatch' row,
  // so re-inviting yields "operator" until a fresh dispatch restores "dispatch". The
  // documented one-way residue (contract C3), pinned so it stays deliberate.
  const dispatched = discover(registry);
  registry.setForemanInvite(dispatched.id, "dispatch");
  registry.withdrawForemanInvite(dispatched.id);
  assert.equal(registry.inviteForeman(dispatched.id), "operator");
  assert.equal(getForemanInvite(dispatched.id)?.source, "operator");

  // Already invited: a no-op, which is also what keeps the API from downgrading a live
  // 'dispatch' row to 'operator'.
  const busy = discover(registry);
  registry.setForemanInvite(busy.id, "dispatch");
  assert.equal(registry.inviteForeman(busy.id), "dispatch");
  assert.equal(getForemanInvite(busy.id)?.source, "dispatch");
  const sdk = mkSdk(registry);
  assert.equal(registry.inviteForeman(sdk.id), "sdk");
  assert.equal(getForemanInvite(sdk.id), undefined);
});

test("invite and withdrawal emit session_upsert carrying the new state", () => {
  const registry = new Registry();
  const term = discover(registry);
  const seen = upserts(registry, term.id);
  registry.inviteForeman(term.id);
  assert.equal(seen.at(-1)?.foremanInvite, "operator");
  registry.withdrawForemanInvite(term.id);
  assert.equal(seen.at(-1)?.foremanInvite, null);
  // A repeat withdrawal changes nothing and must not wake every browser.
  const emitted = seen.length;
  registry.withdrawForemanInvite(term.id);
  assert.equal(seen.length, emitted);
});

// ---- key rotation ----

test("an invite written under the synthetic key survives the hook binding", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  // The dispatcher's write: discovery just confirmed the spawn, hooks have not fired,
  // so the row lands under the synthetic id.
  registry.setForemanInvite(d.syntheticId, "dispatch");
  assert.ok(getForemanInvite(d.syntheticId));

  // The first hook binds the agent session id, which rotates the note key.
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: `agent-rotate-${seq}`,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });

  const s = registry.getSession(d.syntheticId);
  assert.equal(s?.agentSessionId, `agent-rotate-${seq}`, "the hook bound the id");
  assert.equal(s?.foremanInvite, "dispatch", "the invite followed the key");
  assert.equal(getForemanInvite(d.syntheticId), undefined, "nothing strands under the old key");
  assert.equal(getForemanInvite(`agent-rotate-${seq}`)?.source, "dispatch");
});

test("a Pi-shaped launch rebind carries the invite (bindLaunchedAgentSession)", () => {
  // Pi's dispatch injects a pre-assigned session id and rebinds through
  // `bindLaunchedAgentSession` rather than a hook - the fourth rotation site, whose
  // omission would strand a freshly dispatched Pi session's invite with no implicit
  // grant to catch it (Pi's runtime is terminal).
  const registry = new Registry();
  const d = mkDiscovered({ agent: "pi" });
  registry.applyDiscovery([d]);
  registry.setForemanInvite(d.syntheticId, "dispatch");

  const piId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  const bound = registry.bindLaunchedAgentSession(d.syntheticId, "pi", piId);
  assert.equal(bound?.agentSessionId, piId);
  assert.equal(bound?.foremanInvite, "dispatch", "the invite followed the rebind");
  assert.equal(getForemanInvite(piId)?.source, "dispatch");
  assert.equal(getForemanInvite(d.syntheticId), undefined);
});

test("moveForemanInviteKey re-syncs live sessions holding the destination key", () => {
  // The reset path's move: the session has already rotated to the post-reset key when
  // resetSession calls this, so the destination holder is the one that must re-emit.
  // The row exists BEFORE the registry boots - the registry is the only invite writer,
  // and its cache loads at construction like notes and goals.
  const preResetKey = key("pre-reset");
  upsertForemanInvite(preResetKey, "operator", 50);
  const registry = new Registry();
  const d = mkDiscovered({ agentSessionId: "agent-reset-move-1" } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  const s = registry.getSession(d.syntheticId);
  assert.equal(s?.agentSessionId, "agent-reset-move-1", "discovery carried the binding");
  assert.equal(
    s?.foremanInvite,
    null,
    "the stranded row is under the wrong key until something moves it",
  );
  const seen = upserts(registry, d.syntheticId);
  registry.moveForemanInviteKey(preResetKey, "agent-reset-move-1");
  assert.equal(seen.at(-1)?.foremanInvite, "operator", "the destination holder re-emitted");
  assert.equal(getForemanInvite(preResetKey), undefined);
  assert.equal(getForemanInvite("agent-reset-move-1")?.source, "operator");
});

test("a daemon restart preserves invites - the cache reloads and resolution agrees", () => {
  const before = new Registry();
  const d = mkDiscovered();
  before.applyDiscovery([d]);
  before.setForemanInvite(d.syntheticId, "dispatch");

  // A new registry over the same db is the restart. The same discovered process comes
  // back under the same synthetic id and resolves the persisted row.
  const afterRestart = new Registry();
  afterRestart.applyDiscovery([d]);
  assert.equal(afterRestart.getSession(d.syntheticId)?.foremanInvite, "dispatch");
});

test("registry prune drops orphaned invites and never a live session's", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]); // first sweep: liveness is now known
  registry.setForemanInvite(d.syntheticId, "dispatch");
  const orphan = key("registry-orphan");
  upsertForemanInvite(orphan, "operator", 10);

  const removed = new Registry().pruneForemanInvites(Date.now() + 60_000);
  assert.equal(removed, 0, "an unswept registry refuses to prune - liveness unknown");

  const n = registry.pruneForemanInvites(Date.now() + 60_000);
  assert.ok(n >= 1, "the orphan went");
  assert.equal(getForemanInvite(orphan), undefined);
  assert.ok(getForemanInvite(d.syntheticId), "the live session's invite stayed, despite its age");
});

// ---- routes ----

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function mkApp(registry: InstanceType<typeof Registry>): ReturnType<typeof buildApp> {
  return buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
}

test("POST /api/sessions/:id/foreman-invite invites; DELETE withdraws; both 404 on unknown", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  const term = discover(registry);

  const post = await app.request(`/api/sessions/${term.id}/foreman-invite`, {
    method: "POST",
    headers: HEADERS,
  });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { foremanInvite: "operator" });
  assert.equal(registry.getSession(term.id)?.foremanInvite, "operator");

  const del = await app.request(`/api/sessions/${term.id}/foreman-invite`, {
    method: "DELETE",
    headers: HEADERS,
  });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { foremanInvite: null });
  assert.equal(registry.getSession(term.id)?.foremanInvite, null);

  for (const method of ["POST", "DELETE"]) {
    const r = await app.request("/api/sessions/no-such/foreman-invite", { method, headers: HEADERS });
    assert.equal(r.status, 404);
  }
});

test("the routes drive the full withdraw-and-restore cycle on an SDK session", async () => {
  // The cycle phase 3's e2e spec will click through: withdraw beats the implicit grant
  // and survives in the db; re-invite restores "sdk" rather than "operator".
  const registry = new Registry();
  const app = mkApp(registry);
  const sdk = mkSdk(registry);

  const del = await app.request(`/api/sessions/${sdk.id}/foreman-invite`, {
    method: "DELETE",
    headers: HEADERS,
  });
  assert.deepEqual(await del.json(), { foremanInvite: null });
  assert.equal(getForemanInvite(sdk.id)?.source, "withdrawn");

  const post = await app.request(`/api/sessions/${sdk.id}/foreman-invite`, {
    method: "POST",
    headers: HEADERS,
  });
  assert.deepEqual(await post.json(), { foremanInvite: "sdk" });
  assert.equal(getForemanInvite(sdk.id), undefined, "the implicit grant is rowless again");
});
