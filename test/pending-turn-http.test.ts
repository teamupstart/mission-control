import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-pending-turn-http-"));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { clearScoutPromptContext, openScoutPromptContext, scoutPromptTurns } = await import(
  "../src/server/scouts/prompt-context.ts"
);
const { mkTask } = await import("./helpers/session-fixture.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function post(app: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

let fixtureSerial = 0;

function fixture() {
  fixtureSerial += 1;
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: `sdk:pending-http:${fixtureSerial}`,
    agent: "claude",
    name: "pending routes",
    cwd: "/repo/http",
    agentSessionId: `agent:pending-http:${fixtureSerial}`,
  });
  const direct: string[] = [];
  const acceptedGoals: Array<{ prompt: string; noteKey: string } | undefined> = [];
  const supervisor = {
    send: async (
      _id: string,
      turn: { text: string },
      _beforeSend?: () => string | null,
      acceptedGoal?: { prompt: string; noteKey: string },
    ) => {
      direct.push(turn.text);
      acceptedGoals.push(acceptedGoal);
      return "started" as const;
    },
    sendWhenIdle: async () => "started" as const,
  } as unknown as SdkSupervisor;
  const pending = new PendingTurnManager(registry, supervisor, { idleSettleMs: 0 });
  pending.start();
  const app = buildApp({
    registry,
    reviews: {} as ReviewManager,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
    sdkSessions: supervisor,
    pendingTurns: pending,
  });
  return { registry, session, direct, acceptedGoals, pending, app };
}

test("send returns the full durable pending row instead of an opaque queued indicator", async () => {
  const f = fixture();
  const response = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "show this entire message",
    submit: true,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    delivery: string;
    pendingTurn: { id: string; text: string; state: string; revision: number };
  };
  assert.equal(body.ok, true);
  assert.equal(body.delivery, "pending");
  assert.equal(body.pendingTurn.text, "show this entire message");
  assert.equal(body.pendingTurn.state, "queued");
  assert.equal(f.registry.getSession(f.session.id)?.pendingTurns[0]?.id, body.pendingTurn.id);
  f.pending.stop();
});

test("direct SDK delivery tags only acknowledged human text for Goal capture", async () => {
  const f = fixture();
  const buffered = await post(f.app, `/api/sessions/${f.session.id}/inject`, {
    text: "free-form reply",
  });
  assert.equal(buffered.status, 200);
  assert.equal(((await buffered.json()) as { delivery: string }).delivery, "pending");
  assert.deepEqual(f.direct, []);

  const direct = await post(f.app, `/api/sessions/${f.session.id}/inject`, {
    text: "human follow-up",
    buffer: false,
  });
  assert.equal(direct.status, 200);
  assert.equal(((await direct.json()) as { delivery: string }).delivery, "started");
  assert.deepEqual(f.direct, ["human follow-up"]);
  assert.deepEqual(f.acceptedGoals, [{
    prompt: "human follow-up",
    noteKey: f.session.agentSessionId,
  }]);

  const automated = await post(f.app, `/api/sessions/${f.session.id}/inject`, {
    text: "workflow repair packet",
    buffer: false,
    origin: "workflow",
  });
  assert.equal(automated.status, 200);
  assert.deepEqual(f.direct, ["human follow-up", "workflow repair packet"]);
  assert.deepEqual(f.acceptedGoals, [
    { prompt: "human follow-up", noteKey: f.session.agentSessionId },
    undefined,
  ]);

  const automatedSend = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "workflow submitted through send",
    submit: true,
    origin: "workflow",
  });
  assert.equal(automatedSend.status, 200);
  assert.deepEqual(f.direct, [
    "human follow-up",
    "workflow repair packet",
    "workflow submitted through send",
  ]);
  assert.deepEqual(f.acceptedGoals, [
    { prompt: "human follow-up", noteKey: f.session.agentSessionId },
    undefined,
    undefined,
  ]);
  f.pending.stop();
});

test("recall is a CAS mutation and returns the exact message text", async () => {
  const f = fixture();
  const sent = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "line one\nline two",
  });
  const pendingTurn = ((await sent.json()) as {
    pendingTurn: { id: string; revision: number };
  }).pendingTurn;

  const stale = await post(
    f.app,
    `/api/sessions/${f.session.id}/pending-turns/${pendingTurn.id}/recall`,
    { revision: pendingTurn.revision + 1 },
  );
  assert.equal(stale.status, 409);
  assert.equal(f.registry.getSession(f.session.id)?.pendingTurns.length, 1);

  const recalled = await post(
    f.app,
    `/api/sessions/${f.session.id}/pending-turns/${pendingTurn.id}/recall`,
    { revision: pendingTurn.revision },
  );
  assert.equal(recalled.status, 200);
  assert.deepEqual(await recalled.json(), { ok: true, text: "line one\nline two" });
  assert.deepEqual(f.registry.getSession(f.session.id)?.pendingTurns, []);
  f.pending.stop();
});

test("pending-turn mutations reject malformed revisions before touching state", async () => {
  const f = fixture();
  const sent = await post(f.app, `/api/sessions/${f.session.id}/send`, { text: "keep me" });
  const id = ((await sent.json()) as { pendingTurn: { id: string } }).pendingTurn.id;
  const response = await post(
    f.app,
    `/api/sessions/${f.session.id}/pending-turns/${id}/recall`,
    { revision: -1 },
  );
  assert.equal(response.status, 400);
  assert.equal(f.registry.getSession(f.session.id)?.pendingTurns[0]?.text, "keep me");
  f.pending.stop();
});

/** Give a fixture's session a running scout task with a frozen prompt boundary. */
function scoutEpisode(
  registry: InstanceType<typeof Registry>,
  sessionId: string,
): { taskId: string; episodeId: string } {
  const taskId = `task-${sessionId}`;
  registry.upsertTask(
    mkTask({ id: taskId, kind: "scout", status: "running", sessionId, title: "Scout something" }),
  );
  const episode = registry.workEpisodeForSession(sessionId);
  assert.ok(episode, "precondition: the session has a work episode to own the prompts");
  assert.ok(
    openScoutPromptContext({
      taskId,
      episodeId: episode.episodeId,
      sessionId,
      sessionName: "pending routes",
      transcriptPath: null,
      transcriptOffset: 0,
    }),
    "precondition: the boundary was frozen at delivery",
  );
  return { taskId, episodeId: episode.episodeId };
}

test("a human turn that skips the outbox journals nothing in this phase", async () => {
  // Route behavior belongs to a later phase, so the immediate `/inject` arm deliberately
  // records no prompt yet even though it is a real human delivery. The consequence is
  // bounded rather than a correctness hole: a turn delivered this way still reaches the
  // harness transcript, which is where a collector reads human prompts from - the journal
  // is the fallback for turns the transcript cannot show, not the primary source.
  const f = fixture();
  const episode = scoutEpisode(f.registry, f.session.id);
  const response = await post(f.app, `/api/sessions/${f.session.id}/inject`, {
    text: "and check whether pi behaves the same way",
    buffer: false,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId), []);
  f.pending.stop();
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a composer draft is not a prompt, however successfully it is typed", async () => {
  // `submit: false` is Foreman leaving text in the composer for a person to read and send.
  // The agent has not been given it, and archiving it would put words in its ears - which is
  // the same mistake as archiving a recalled turn, arriving one Enter earlier.
  const f = fixture();
  const episode = scoutEpisode(f.registry, f.session.id);
  const response = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "a draft nobody has sent",
    submit: false,
    origin: "foreman",
  });
  assert.notEqual(response.status, 404);
  assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId), []);
  f.pending.stop();
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});

test("a submitted human turn waits for acceptance rather than journaling on the response", async () => {
  // The route answers as soon as the row is in the durable outbox, which is BEFORE any
  // runtime has seen it. Journaling here would archive every queued row, recalls included.
  const f = fixture();
  const episode = scoutEpisode(f.registry, f.session.id);
  const response = await post(f.app, `/api/sessions/${f.session.id}/send`, {
    text: "queued, not yet delivered",
    submit: true,
  });
  assert.equal(((await response.json()) as { delivery: string }).delivery, "pending");
  assert.deepEqual(scoutPromptTurns(episode.taskId, episode.episodeId), []);
  f.pending.stop();
  clearScoutPromptContext(episode.taskId, episode.episodeId);
});
