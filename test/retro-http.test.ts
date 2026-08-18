import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-retro-http-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-retro-http-repos-"));
process.env.MISSION_HOME = home;

const { bindTaskWorkEpisode, openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { setSkillsConfig } = await import("../src/server/skills/config.ts");
const { skillsDirFor } = await import("../src/server/skills/reconcile.ts");
const { originOf, forgetInjections } = await import("../src/server/injections.ts");
const { CLAUDE_SKILLS } = await import("../src/shared/harness-capabilities.ts");
const { PULL_REQUEST_SKILL, RETRO_SKILL, missionSkillDirName } = await import("../src/shared/skills.ts");
const { COMPLETE_RETRO_NO_CHANGE_TOOL } = await import("../src/server/retro-tool.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Task = import("../src/shared/types.ts").Task;
type DiscoveredSession = import("../src/server/discovery/correlate.ts").DiscoveredSession;

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

openDb();

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

/**
 * Install the retro skill the way the reconciler does, into the isolated home this test set.
 *
 * `requiredSkillCommand` is the fail-closed gate the route delivers behind, and it checks the
 * SYMLINK, not just the toggle. Faking that check away would leave the route's most important
 * refusal unproven, so the link is real and `MISSION_HOME` keeps it out of the operator's own
 * `~/.claude/skills`.
 */
function installRetroSkill(): void {
  const dir = skillsDirFor(CLAUDE_SKILLS);
  mkdirSync(dir, { recursive: true });
  for (const skillId of [RETRO_SKILL, PULL_REQUEST_SKILL]) {
    try {
      symlinkSync(join(process.cwd(), "skills", skillId), join(dir, missionSkillDirName(skillId)), "dir");
    } catch {
      // Already linked by an earlier case in this file.
    }
  }
}

function enableSkills(enabled: boolean): void {
  // No generation is set, so it stays at the schema default of 0 and the reload watermark is
  // skipped: no skill set has changed under a running session here, and that ladder is proven
  // in `skills-required-invoke.test.ts`.
  setSkillsConfig({
    enabled,
    skills: { [RETRO_SKILL]: enabled, [PULL_REQUEST_SKILL]: enabled },
  });
}

let serial = 0;

function gitRepo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

function fixture(over: { send?: () => Promise<never> } = {}) {
  serial += 1;
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const typed: string[] = [];
  const supervisor = {
    send: over.send
      ?? (async (_id: string, turn: { text: string }) => {
        typed.push(turn.text);
        return "started" as const;
      }),
  } as unknown as SdkSupervisor;
  const app = buildApp(
    registry,
    {} as ReviewManager,
    tasks,
    {} as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisor,
  );
  return { registry, tasks, typed, app, serial };
}

function liveSession(f: ReturnType<typeof fixture>, cwd: string) {
  return f.registry.registerSdkSession({
    id: `sdk:retro:${f.serial}`,
    agent: "claude",
    name: "retro subject",
    cwd,
    agentSessionId: `agent:retro:${f.serial}`,
  });
}

/** A discovered terminal session whose pane is gone: live on the board, impossible to type into. */
function paneless(f: ReturnType<typeof fixture>, repo: string, branch: string) {
  const discovered = {
    syntheticId: `proc:ttys90${f.serial}:${f.serial}:0`,
    agent: "claude",
    name: "finished work",
    nameSource: "process",
    cwd: repo,
    gitBranch: branch,
    gitRoot: repo,
    repoRoot: repo,
    pid: 9000 + f.serial,
    tty: `ttys90${f.serial}`,
    terminals: [],
    startedAt: Date.now(),
  } as unknown as DiscoveredSession;
  f.registry.applyDiscovery([discovered]);
  const session = f.registry.getSession(discovered.syntheticId);
  assert.ok(session);
  return session;
}

function retro(app: ReturnType<typeof buildApp>, id: string) {
  return app.request(`/api/sessions/${id}/retro`, { method: "POST", headers: HEADERS });
}

function bindSourceTask(
  f: ReturnType<typeof fixture>,
  session: ReturnType<typeof liveSession>,
  repo: string,
  mergedAt: number | null,
) {
  const task = f.tasks.create({
    repoRoot: repo,
    title: `Source work ${f.serial}`,
    intent: "Ship the source work",
    kind: "ship",
    agent: "claude",
    backlog: true,
  });
  const now = Date.now();
  f.registry.upsertTask({
    ...task,
    status: "done",
    sessionId: session.id,
    outcome: "merged source work",
    outcomeUrl: "https://github.example/o/r/pull/40",
    completedAt: now,
    updatedAt: now,
  });
  bindTaskWorkEpisode({
    taskId: task.id,
    episodeId: `source-episode-${f.serial}`,
    sessionId: session.id,
    agentSessionId: session.agentSessionId!,
    branch: "feature/source-work",
    prUrl: "https://github.example/o/r/pull/40",
    prHeadSha: "c".repeat(40),
    mergedAt,
    boundAt: now - 1_000,
    updatedAt: now,
  });
  return task;
}

test("a live session is asked to run its own retro, and the turn is attributed to us", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture();
  const session = liveSession(f, "/repo/live");
  forgetInjections(session.id);

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    kind: string;
    sessionId: string;
    payloadSha256: string;
    submitVerified: boolean;
  };
  assert.equal(body.kind, "delivered");
  assert.equal(body.sessionId, session.id);
  assert.equal(body.payloadSha256.length, 64);
  assert.equal(body.submitVerified, true);

  assert.equal(f.typed.length, 1, "exactly one turn is typed");
  const payload = f.typed[0]!;
  // The skill invocation leads, so the harness resolves it as the turn's first line.
  assert.ok(payload.startsWith("/retro\n"), payload.slice(0, 40));
  // The envelope names the receiving session, which is how the skill reads its own transcript.
  assert.ok(payload.includes(`Session: ${session.id}`));
  // The authored action arrives whole.
  assert.ok(payload.includes("Use the invoked retro skill"));
  // Attribution: this turn is the daemon's, not the human's. Without it the conversation shows
  // the operator asking for a retrospective they never typed.
  assert.equal(originOf(session.id, payload), "harness");
});

test("an open work pull request preserves the same-session retro path", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture();
  const repo = gitRepo(`open-source-${f.serial}`);
  const session = liveSession(f, repo);
  const source = bindSourceTask(f, session, repo, null);

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { kind: string; sessionId: string };
  assert.equal(body.kind, "delivered");
  assert.equal(body.sessionId, session.id);
  assert.equal(f.typed.length, 1);
  assert.equal(f.tasks.get(source.id)?.status, "done", "running a retro never reopens the source");
});

test("a merged work pull request starts one linked task and duplicate clicks reuse it", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture();
  const repo = gitRepo(`merged-source-${f.serial}`);
  const session = liveSession(f, repo);
  const source = bindSourceTask(f, session, repo, Date.now());
  let launches = 0;
  f.tasks.dispatch = async (id, options) => {
    assert.deepEqual(options?.missionMcp?.tools, [COMPLETE_RETRO_NO_CHANGE_TOOL]);
    const current = f.tasks.get(id);
    assert.ok(current);
    if (current.status === "backlog") {
      launches += 1;
      f.registry.upsertTask({ ...current, status: "dispatching", updatedAt: Date.now() });
    }
    return { ok: true as const, task: f.tasks.get(id)! };
  };

  const firstResponse = await retro(f.app, session.id);
  assert.equal(firstResponse.status, 200);
  const first = (await firstResponse.json()) as { kind: string; task: Task };
  assert.equal(first.kind, "started");
  assert.notEqual(first.task.id, source.id);
  assert.equal(first.task.repoRoot, source.repoRoot);
  assert.match(first.task.intent, /pull-request skill/);
  assert.ok(first.task.intent.includes(COMPLETE_RETRO_NO_CHANGE_TOOL));
  assert.equal(f.typed.length, 0, "the merged source session receives no retro prompt");

  const replayResponse = await retro(f.app, session.id);
  assert.equal(replayResponse.status, 200);
  const replay = (await replayResponse.json()) as { kind: string; task: Task };
  assert.equal(replay.kind, "started");
  assert.equal(replay.task.id, first.task.id);
  assert.equal(launches, 1, "the second click does not launch a second session");
  assert.equal(
    f.tasks.list().filter((task) => task.title === first.task.title).length,
    1,
    "the second click does not create a second task",
  );
  assert.equal(f.tasks.get(source.id)?.status, "done");
});

test("a retryable post-merge launch refusal returns the linked queued task and reason", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture();
  const repo = gitRepo(`queued-source-${f.serial}`);
  const session = liveSession(f, repo);
  const source = bindSourceTask(f, session, repo, Date.now());
  f.tasks.dispatch = async (id) => ({
    ok: false as const,
    error: "the required MCP bundle needs a rebuild",
    task: f.tasks.get(id),
  });

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { kind: string; task: Task; reason: string };
  assert.equal(body.kind, "queued");
  assert.equal(body.task.status, "backlog");
  assert.match(body.reason, /needs a rebuild/);
  assert.equal(f.tasks.get(source.id)?.status, "done");
});

test("a post-merge retro fails closed when the pull-request skill is unavailable", async () => {
  installRetroSkill();
  setSkillsConfig({
    enabled: true,
    skills: { [RETRO_SKILL]: true, [PULL_REQUEST_SKILL]: false },
  });
  const f = fixture();
  const repo = gitRepo(`no-pr-skill-${f.serial}`);
  const session = liveSession(f, repo);
  const source = bindSourceTask(f, session, repo, Date.now());
  const before = f.tasks.list().length;

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /pull-request skill/);
  assert.equal(f.tasks.list().length, before);
  assert.equal(f.tasks.get(source.id)?.status, "done");
  enableSkills(true);
});

test("a disabled retro skill fails closed, and nothing is typed", async () => {
  installRetroSkill();
  enableSkills(false);
  const f = fixture();
  const session = liveSession(f, "/repo/disabled");

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Enable Skills and the retro skill/);
  // The refusal names the instruction rather than a pull request nobody asked to prepare.
  assert.ok(!body.error.includes("pull request"));
  assert.equal(f.typed.length, 0, "a refused retro types nothing");
  enableSkills(true);
});

test("a session that cannot be typed into files a retro task against its repository", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture();
  const repo = gitRepo(`gone-${f.serial}`);
  const session = paneless(f, repo, "feature/retro-me");

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { kind: string; task: Task };
  assert.equal(body.kind, "dispatched");
  assert.equal(f.typed.length, 0, "a dead session is not typed into");

  const task = body.task;
  assert.equal(task.repoRoot, repo);
  // Backlogged, never dispatched: a retrospective over finished work must not jump a queue of
  // real work or take a worktree lease the instant somebody clicks.
  assert.equal(task.status, "backlog");
  assert.match(task.title, /^Retro: /);
  // Everything a session that was never there can act on.
  assert.ok(task.intent.includes(session.id));
  assert.ok(task.intent.includes("feature/retro-me"));
  assert.ok(task.intent.includes(".agents/memory"));
  assert.ok(task.intent.includes("retro skill"));
  // The honest limit is stated rather than glossed.
  assert.match(task.intent, /transcript may no longer be readable/);
  assert.equal(f.tasks.get(task.id)?.id, task.id, "the task is really in the backlog");
});

/**
 * The dispatch arm's half of "fails closed", and the easier half to lose.
 *
 * It types nothing, so it looks like it has nothing to gate - but the retro skill is where the
 * human-approval ceremony lives. A task filed while the skill is off reaches an agent holding
 * an intent that names a procedure it cannot load, and the one rule the retro has (write
 * nothing a human did not approve) would survive only as prose nobody enforces.
 */
test("a disabled retro skill refuses the dead-session fallback too, filing nothing", async () => {
  installRetroSkill();
  enableSkills(false);
  const f = fixture();
  const repo = gitRepo(`closed-${f.serial}`);
  const session = paneless(f, repo, "feature/no-skill");
  const before = f.tasks.list().length;

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Enable Skills and the retro skill/);
  // The refusal says why filing it would not have helped, rather than only naming the toggle.
  assert.match(body.error, /cannot load the procedure/);
  assert.equal(f.tasks.list().length, before, "a refused retro files nothing");
  enableSkills(true);
});

/**
 * A live session is not a promise of delivery, which `docs/repository-memory.md` now states as
 * its own row. The status is 503 and the body carries `pasted`, because a caller that retried a
 * refusal whose text is already in the composer would type a second retro under the first.
 */
test("a live session whose driver rejects the turn answers 503, saying nothing was pasted", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture({ send: () => Promise.reject(new Error("driver said no")) });
  const session = liveSession(f, "/repo/refused");

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string; pasted: boolean };
  assert.match(body.error, /driver said no/);
  // An embedded session's send is one acked call, so a rejection is positive evidence that
  // nothing was appended to any composer - the state a caller may safely retry from.
  assert.equal(body.pasted, false);
});

test("a session the registry has never heard of is a 404, not a task", async () => {
  const f = fixture();
  // Counted rather than asserted empty: tasks are durable rows in this file's one database,
  // so an earlier case's backlog card is still there and only the DELTA is this test's.
  const before = f.tasks.list().length;
  const response = await retro(f.app, "sdk:does-not-exist");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no such session" });
  assert.equal(f.tasks.list().length, before);
});

test("a paneless session outside any repository is refused rather than filed nowhere", async () => {
  installRetroSkill();
  enableSkills(true);
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "mission-retro-not-a-repo-"));
  const session = paneless(f, realpathSync(outside), "main");
  const before = f.tasks.list().length;

  const response = await retro(f.app, session.id);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /not a git repository/);
  assert.equal(f.tasks.list().length, before, "a refusal files nothing");
  rmSync(outside, { recursive: true, force: true });
});
