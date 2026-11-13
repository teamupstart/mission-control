import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "../src/shared/types.ts";
import type { Persona } from "../src/shared/workflow.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

// A dispatch Persona: the Library Persona an ordinary task names under Advanced, delivered to
// the launched agent as part of its standing instructions.
//
// Three things are pinned. The wire and the task owner refuse a Persona that cannot be
// delivered - a kind whose launch Mission Control does not compose, an archived or deleted
// Persona, an assignment into a process that is already running. The launch delivers the
// Persona's text exactly once, on the pair's own channel, after the repository block. And a
// task with no Persona launches byte-identically to one filed before this existed.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-persona-"));
process.env.HARNESS_HOME = home;
// Binaries that exist, so bin resolution is never what fails a launch. The terminal home is
// faked through the dispatcher's `spawn` seam.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
// No MCP bundle: with the ask channel off, only standing instructions can put
// `--append-system-prompt` on a Claude command line, so the argv is a clean measurement.
process.env.MISSION_MCP_SERVER = join(home, "no-such-mcp-bundle.mjs");

const { DispatchSchema, UpdateTaskSchema, McpTaskConfigurationSchema, McpUpdateTaskSchema } = await import(
  "../src/shared/protocol.ts"
);
const { TASK_KINDS } = await import("../src/shared/types.ts");
const { TASK_KIND_BEHAVIOR, taskKindPersonaRefusal } = await import("../src/shared/task.ts");
const { readyBacklog } = await import("../src/shared/backlog.ts");
const { appendStandingSections } = await import("../src/server/instructions/compose.ts");
const { TASK_PERSONA_HEADING, pipelineHostStanding, resolveTaskPersona, taskPersonaSection, withTaskPersona } = await import(
  "../src/server/instructions/persona.ts"
);
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { TaskManager, TaskPersonaError } = await import("../src/server/tasks.ts");
const { openDb, getTask } = await import("../src/server/db.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { standingInstructionsView, updateStandingInstructions } = await import("../src/server/instructions/config.ts");
const { setPipelinesConfig } = await import("../src/server/pipelines/config.ts");

type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_CODEX_BIN;
  delete process.env.MISSION_MCP_SERVER;
});

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
  setHarnessesConfig({ sessionRuntime: { claude: "terminal", codex: "terminal", pi: "terminal" } });
});

const GUIDANCE = "# Reviewer\n\nRead every diff as if you will be paged for it at 3am.";

function persona(over: Partial<Persona> = {}): Persona {
  return {
    id: "persona-reviewer",
    name: "Reviewer",
    normalizedName: "reviewer",
    description: "Reads diffs adversarially.",
    guidanceMarkdown: GUIDANCE,
    runner: null,
    model: null,
    effort: null,
    revision: 3,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    provenance: null,
    builtin: false,
    ...over,
  };
}

const REVIEWER = persona();
const ARCHIVED = persona({ id: "persona-archived", name: "Retired", normalizedName: "retired", archivedAt: 5 });
const LIBRARY = new Map<string, Persona>([[REVIEWER.id, REVIEWER], [ARCHIVED.id, ARCHIVED]]);
const lookup = (id: string): Persona | null => LIBRARY.get(id) ?? null;
const SECTION = `${TASK_PERSONA_HEADING}: Reviewer\n\n${GUIDANCE}`;

// ---- the wire ----

test("every kind Dispatch offers may carry a Persona; a resident takes its own from its profile", () => {
  for (const kind of TASK_KINDS) {
    assert.equal(
      taskKindPersonaRefusal(kind) === null,
      TASK_KIND_BEHAVIOR[kind].launch !== "resident",
      `${kind}: only the resident launch owner has another source for its Persona`,
    );
  }
  assert.equal(taskKindPersonaRefusal("pipeline"), null);
  assert.match(taskKindPersonaRefusal("resident") ?? "", /takes its Persona from its resident profile/);
});

test("the dispatch body carries a Persona id for every kind the form offers", () => {
  const base = { repoRoot: "/r", intent: "go" };
  assert.equal(DispatchSchema.parse({ ...base, personaId: "persona-reviewer" }).personaId, "persona-reviewer");
  assert.equal(DispatchSchema.parse(base).personaId, undefined);
  for (const kind of ["scout", "plan", "pipeline", "chat", "bugfix", "document"] as const) {
    assert.equal(DispatchSchema.safeParse({ ...base, kind, personaId: "p" }).success, true, kind);
  }
  assert.equal(DispatchSchema.safeParse({ ...base, personaId: "" }).success, false);

  // An update can set one or take it back off; absent leaves it alone.
  assert.equal(UpdateTaskSchema.parse({ personaId: "p" }).personaId, "p");
  assert.equal(UpdateTaskSchema.parse({ personaId: null }).personaId, null);
  assert.equal("personaId" in UpdateTaskSchema.parse({ priority: "high" }), false);

  // Not an MCP field yet: the strict MCP schemas say so rather than drop it silently.
  assert.equal(McpTaskConfigurationSchema.safeParse({ personaId: "p" }).success, false);
  assert.equal(McpUpdateTaskSchema.safeParse({ personaId: "p" }).success, false);
});

// ---- composition ----

test("the Persona section follows the repository block on the repository's own channel", () => {
  const repository = {
    text: "## Standing instructions for this repository\n\nPreserve unrelated work.",
    mechanism: "claude-append-system-prompt" as const,
    sources: [{ repoPath: "/repo", matchedKey: "/repo" }],
  };
  assert.equal(taskPersonaSection(REVIEWER), SECTION);
  assert.equal(taskPersonaSection(persona({ guidanceMarkdown: "  \n" })), `${TASK_PERSONA_HEADING}: Reviewer`);
  assert.deepEqual(withTaskPersona(repository, REVIEWER, "claude", "terminal"), {
    text: `${repository.text}\n\n${SECTION}`,
    mechanism: "claude-append-system-prompt",
    sources: repository.sources,
  });

  // With no repository rules the Persona still needs a channel: the pair's own, or turn one.
  const none = { text: "", mechanism: "none" as const, sources: [] };
  assert.deepEqual(withTaskPersona(none, REVIEWER, "claude", "sdk"), {
    text: SECTION,
    mechanism: "claude-sdk-system-prompt-append",
    sources: [],
  });
  assert.equal(withTaskPersona(none, REVIEWER, "codex", "terminal").mechanism, "prompt-prefix");
  // Nothing to append returns the repository delivery by identity.
  assert.equal(appendStandingSections(repository, ["", "  "], "claude", "terminal"), repository);
});

test("the Persona's Markdown reaches the section as written, leading indentation included", () => {
  // An indented code block is Markdown content: trimming its first line would turn it into prose.
  const code = persona({ guidanceMarkdown: "\n\n    npm test -- --only persona\n\nThen read the diff.\n\n" });
  const section = `${TASK_PERSONA_HEADING}: Reviewer\n\n    npm test -- --only persona\n\nThen read the diff.`;
  assert.equal(taskPersonaSection(code), section);
  // And it survives composition, which trims each appended section as a whole.
  const none = { text: "", mechanism: "none" as const, sources: [] };
  assert.equal(withTaskPersona(none, code, "claude", "sdk").text, section);
  assert.equal(
    withTaskPersona({ text: "## Rules\n\nBe careful.", mechanism: "claude-append-system-prompt", sources: [] }, code, "claude", "terminal").text,
    `## Rules\n\nBe careful.\n\n${section}`,
  );
});

test("a Pipeline host is sent the Persona alone on the managed runtime, and no standing instructions on Terminal", () => {
  assert.deepEqual(pipelineHostStanding(REVIEWER, "claude", "agent-sdk"), {
    text: SECTION,
    mechanism: "claude-sdk-system-prompt-append",
    sources: [],
  });
  assert.equal(pipelineHostStanding(REVIEWER, "codex", "agent-sdk").mechanism, "codex-developer-instructions");
  assert.deepEqual(pipelineHostStanding(REVIEWER, "claude", "terminal"), { text: "", mechanism: "none", sources: [] });
  assert.deepEqual(pipelineHostStanding(null, "claude", "agent-sdk"), { text: "", mechanism: "none", sources: [] });
});

test("an archived, deleted, or unreadable Persona is refused with a reason", () => {
  assert.deepEqual(resolveTaskPersona(lookup, REVIEWER.id), { ok: true, persona: REVIEWER });
  assert.deepEqual(resolveTaskPersona(lookup, ARCHIVED.id), { ok: false, error: "the Persona Retired is archived" });
  assert.deepEqual(resolveTaskPersona(lookup, "gone"), { ok: false, error: "the selected Persona no longer exists" });
  assert.equal(resolveTaskPersona(undefined, REVIEWER.id).ok, false);
});

// ---- the task owner ----

function manager(): { registry: InstanceType<typeof Registry>; tasks: InstanceType<typeof TaskManager> } {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  tasks.registerPersonaLookup(lookup);
  return { registry, tasks };
}

const shelf = { repoRoot: "/repo", intent: "review it", title: "Review", kind: "ship" as const, agent: "claude" as const, workflowId: null, backlog: true };

test("create stores a live Persona and refuses one the launch could not deliver", () => {
  const { tasks } = manager();
  const created = tasks.create({ ...shelf, personaId: REVIEWER.id });
  assert.equal(created.personaId, REVIEWER.id);
  assert.equal(getTask(created.id)?.personaId, REVIEWER.id, "the id round-trips through the row");
  assert.equal(tasks.create(shelf).personaId, null, "omitted is none");

  assert.throws(() => tasks.create({ ...shelf, personaId: ARCHIVED.id }), (error) =>
    error instanceof TaskPersonaError && /archived/.test(error.message));
  assert.throws(() => tasks.create({ ...shelf, personaId: "gone" }), TaskPersonaError);
  assert.equal(tasks.create({ ...shelf, kind: "pipeline", personaId: REVIEWER.id }).personaId, REVIEWER.id);
  // A daemon with no reader refuses rather than shelving a task it could never launch.
  assert.throws(() => new TaskManager(new Registry()).create({ ...shelf, personaId: REVIEWER.id }), TaskPersonaError);
});

test("an edit sets, clears, and drops a Persona the way it does a model", async () => {
  const library = new Map(LIBRARY);
  const tasks = new TaskManager(new Registry());
  tasks.registerPersonaLookup((id) => library.get(id) ?? null);
  const task = tasks.create(shelf);
  assert.equal((await tasks.update(task.id, { personaId: REVIEWER.id })).task?.personaId, REVIEWER.id);
  // Omitted leaves it alone; an explicit null takes it back off.
  assert.equal((await tasks.update(task.id, { priority: "high" })).task?.personaId, REVIEWER.id);
  assert.equal((await tasks.update(task.id, { personaId: null })).task?.personaId, null);

  // A newly named Persona is checked...
  assert.deepEqual(await tasks.update(task.id, { personaId: ARCHIVED.id }), {
    ok: false,
    error: "the Persona Retired is archived",
  });
  // ...but the stored one is not re-checked on an unrelated edit: the launch refuses it, and
  // the editor is where the operator takes it off.
  await tasks.update(task.id, { personaId: REVIEWER.id });
  library.set(REVIEWER.id, { ...REVIEWER, archivedAt: 9 });
  assert.equal((await tasks.update(task.id, { intent: "review it again" })).task?.personaId, REVIEWER.id);
  library.set(REVIEWER.id, REVIEWER);

  // Every kind the form offers keeps it across a kind change.
  assert.equal((await tasks.update(task.id, { kind: "scout" })).task?.personaId, REVIEWER.id);
  assert.equal((await tasks.update(task.id, { kind: "pipeline" })).task?.personaId, REVIEWER.id);
});

test("a Persona task is dispatched, never typed into a running agent", async () => {
  const { registry, tasks } = manager();
  const task = tasks.create({ ...shelf, personaId: REVIEWER.id });
  registry.upsertTask(getTask(task.id)!);
  const refused = await tasks.assign(task.id, "any-session");
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? null : refused.scope, "task");
  assert.match(refused.ok ? "" : refused.error ?? "", /launches with a Persona/);
});

test("a Persona archived while the task waited refuses the dispatch on the click, before any launch", async () => {
  const library = new Map(LIBRARY);
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  tasks.registerPersonaLookup((id) => library.get(id) ?? null);
  const task = tasks.create({ ...shelf, personaId: REVIEWER.id });
  library.set(REVIEWER.id, { ...REVIEWER, archivedAt: 9 });
  const behind = tasks.create({ ...shelf, title: "Behind it" });
  const r = await tasks.dispatch(task.id);
  assert.equal(r.ok, false);
  const refusal = "the Persona Reviewer is archived; choose another Persona, or none, under Advanced";
  assert.equal(r.ok ? "" : r.error, refusal);
  // Recorded on the task, which stays shelved: autopilot's ready set passes over it, so it
  // cannot be picked again every tick ahead of the work behind it, and its card says why.
  const refused = registry.getTask(task.id)!;
  assert.equal(refused.status, "backlog");
  assert.equal(refused.error, refusal);
  assert.equal(getTask(task.id)?.error, refusal, "the refusal is durable");
  // Scoped to this case's two tasks: earlier cases leave their own shelved tasks in the store.
  const ready = () => readyBacklog(registry.listTasks(), null)
    .map((t) => t.id)
    .filter((id) => id === task.id || id === behind.id);
  assert.deepEqual(ready(), [behind.id]);

  // An unrelated edit leaves it; choosing another Persona answers it and returns the task.
  assert.equal((await tasks.update(task.id, { priority: "high" })).task?.error, refusal);
  library.set("persona-other", persona({ id: "persona-other", name: "Other", normalizedName: "other" }));
  assert.equal((await tasks.update(task.id, { personaId: "persona-other" })).task?.error, null);
  assert.deepEqual(new Set(ready()), new Set([task.id, behind.id]));
});

// ---- the launch ----

function seedRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return realpathSync(repo);
}

let seq = 0;
function mkDiscovered(over: Partial<DiscoveredSession>): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys20${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/task-${n}`,
    gitBranch: "harness/task",
    pid: 2000 + n,
    tty: `ttys20${n}`,
    terminals: [mkMuxHandle({ session: `dp${n}`, windowName: "w", windowIndex: 0, paneId: `%${200 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** One real terminal dispatch, faking only the terminal home and the pane. */
async function terminalDispatch(options: {
  agent: "claude" | "codex";
  repo: string;
  taskId: string;
  personaId: string | null;
  library?: (id: string) => Persona | null;
}) {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: options.taskId,
    status: "dispatching",
    repoRoot: options.repo,
    title: "Persona launch",
    intent: "review the change",
    agent: options.agent,
    personaId: options.personaId,
  }));
  const nativeId = `native-${options.taskId}`;
  let argv: string[] | null = null;
  let pasted: string | null = null;
  let sessionId = "";
  await new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => null,
    persona: options.library ?? lookup,
    spawn: async (_label, _short, cwd, _bin, args) => {
      argv = [...(args ?? [])];
      const discovered = mkDiscovered({ agent: options.agent, cwd, syntheticId: `sid-${options.taskId}` });
      registry.applyDiscovery([discovered]);
      sessionId = discovered.syntheticId;
      registry.applyHook({
        agent: options.agent,
        event: "SessionStart",
        sessionId: nativeId,
        cwd,
        transcriptPath: null,
        env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
      });
      return { homeName: `home-${options.taskId}`, homeBackend: "tmux", terminalResourceId: null };
    },
    inject: async (session, text) => {
      pasted = text;
      registry.applyHook({
        agent: options.agent,
        event: "UserPromptSubmit",
        sessionId: nativeId,
        cwd: session.cwd,
        transcriptPath: null,
        prompt: text,
        env: { tmuxPane: "%1" },
      });
      return { ok: true, pasted: true, submitVerified: true };
    },
  }).dispatch(options.taskId);
  const task = registry.getTask(options.taskId)!;
  return { registry, task, argv: argv as string[] | null, prompt: pasted as string | null, sessionId };
}

function release(registry: InstanceType<typeof Registry>, taskId: string): void {
  const task = registry.getTask(taskId)!;
  registry.upsertTask({ ...task, status: "done", worktreePath: null, homeName: null, homeBackend: null, terminalResourceId: null });
}

test("a Claude terminal launch carries the Persona once, on its system-prompt append", async () => {
  const repo = seedRepo("claude-terminal");
  const baseline = await terminalDispatch({ agent: "claude", repo, taskId: "persona-none", personaId: null });
  assert.equal(baseline.task.status, "running", baseline.task.error ?? "");
  assert.equal(baseline.argv?.includes("--append-system-prompt"), false, "no Persona, no flag");
  assert.equal(baseline.registry.standingInstructionsFor(baseline.sessionId), null);
  release(baseline.registry, "persona-none");

  const run = await terminalDispatch({ agent: "claude", repo, taskId: "persona-claude", personaId: REVIEWER.id });
  assert.equal(run.task.status, "running", run.task.error ?? "");
  // The ONLY argv difference is the delivery, and turn one is untouched: exactly once.
  assert.deepEqual(run.argv, [...baseline.argv!, "--append-system-prompt", SECTION]);
  assert.equal(run.prompt?.includes(GUIDANCE), false);
  // Recorded, so a resume replays the Persona the launch sent.
  assert.deepEqual(
    (({ text, mechanism }) => ({ text, mechanism }))(run.registry.standingInstructionsFor(run.sessionId)!),
    { text: SECTION, mechanism: "claude-append-system-prompt" },
  );
  release(run.registry, "persona-claude");
});

test("a pair with no channel of its own reads the Persona at the head of turn one", async () => {
  const run = await terminalDispatch({ agent: "codex", repo: seedRepo("codex-terminal"), taskId: "persona-codex", personaId: REVIEWER.id });
  assert.equal(run.task.status, "running", run.task.error ?? "");
  assert.ok(run.prompt?.startsWith(`${SECTION}\n\n---\n\n`), run.prompt ?? "no prompt");
  assert.equal(run.registry.standingInstructionsFor(run.sessionId)?.mechanism, "prompt-prefix");
  release(run.registry, "persona-codex");
});

test("a Persona archived after the task was filed refuses the launch before any terminal opens", async () => {
  const run = await terminalDispatch({
    agent: "claude",
    repo: seedRepo("archived-launch"),
    taskId: "persona-archived",
    personaId: REVIEWER.id,
    library: (id) => (id === REVIEWER.id ? { ...REVIEWER, archivedAt: 7 } : null),
  });
  assert.equal(run.argv, null, "no terminal was spawned");
  assert.match(run.task.error ?? "", /the Persona Reviewer is archived; choose another Persona, or none, under Advanced/);
});

test("an Agent SDK launch hands the Persona to the supervisor as its standing instructions", async () => {
  setHarnessesConfig({ sessionRuntime: { claude: "sdk" } });
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "persona-sdk",
    status: "dispatching",
    repoRoot: seedRepo("claude-sdk"),
    title: "Persona launch",
    intent: "review the change",
    agent: "claude",
    personaId: REVIEWER.id,
  }));
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({ id: `sdk:persona:${++seq}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
  } as unknown as SdkSupervisor;
  await new Dispatcher(registry, async () => {}, {
    supervisor,
    persona: lookup,
    missionMcpDescriptor: async () => null,
    inject: async () => {
      throw new Error("an embedded dispatch must never type at a pane");
    },
  }).dispatch("persona-sdk");
  assert.equal(registry.getTask("persona-sdk")?.status, "running", registry.getTask("persona-sdk")?.error ?? "");
  const start = starts[0]!;
  assert.deepEqual(start.standingInstructions?.delivery, {
    text: SECTION,
    mechanism: "claude-sdk-system-prompt-append",
    sources: [],
  });
  assert.equal(start.prompt.includes(GUIDANCE), false, "the SDK channel carries it, so turn one does not");
});

// ---- the forecast ----

test("the Dispatch preview appends the chosen Persona exactly as the launch will", async () => {
  const repo = seedRepo("preview");
  const app = buildApp({
    registry: new Registry(),
    reviews: {} as never,
    tasks: {} as never,
    queues: {} as never,
    personas: { store: { getPersona: lookup } } as never,
  });
  const preview = (personaId?: string) => {
    const q = new URLSearchParams({ repoPath: repo, agent: "claude", runtime: "sdk" });
    if (personaId) q.set("personaId", personaId);
    return app.request(`/api/instructions/resolved?${q}`, { headers: { host: "127.0.0.1:7317" } });
  };
  // No rules and no Persona: nothing will be sent, as before.
  assert.deepEqual(await (await preview()).json(), { text: "", mechanism: "none", sources: [] });
  const chosen = await preview(REVIEWER.id);
  assert.equal(chosen.status, 200);
  assert.deepEqual(await chosen.json(), withTaskPersona({ text: "", mechanism: "none", sources: [] }, REVIEWER, "claude", "sdk"));
  // The forecast refuses what the launch would refuse, rather than promising a role.
  const archived = await preview(ARCHIVED.id);
  assert.equal(archived.status, 409);
  assert.deepEqual(await archived.json(), { error: "the Persona Retired is archived" });
});

// ---- the Pipeline hosts ----

const PIPELINE_LINK = { provider: "ai-conductor" as const, repoRoot: "/repo/pipeline", slug: "review-the-pipeline" };

function pipelineTask(registry: InstanceType<typeof Registry>, id: string, personaId: string | null): void {
  registry.upsertTask(mkTask({
    id,
    agent: "codex",
    kind: "pipeline",
    repoRoot: "/repo/pipeline",
    intent: "Review the pipeline",
    title: "Review the pipeline",
    workflowId: null,
    personaId,
  }));
}

test("a managed Pipeline host receives the Persona on its channel, behind its skill invocation", async () => {
  const registry = new Registry();
  pipelineTask(registry, "pipeline-persona", REVIEWER.id);
  pipelineTask(registry, "pipeline-plain", null);
  const starts: Parameters<SdkSupervisor["start"]>[0][] = [];
  const supervisor = {
    async start(input: Parameters<SdkSupervisor["start"]>[0]): Promise<Session> {
      starts.push(input);
      return registry.registerSdkSession({ id: input.sessionId ?? `sdk:pipe:${++seq}`, agent: input.agent, name: input.name, cwd: input.cwd });
    },
    async stop(): Promise<void> {},
    taskLiveness: () => null,
    liveSessionForTask: () => null,
    handleFor: () => null,
  } as unknown as SdkSupervisor;
  const dispatcher = new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    supervisor,
    persona: lookup,
    missionMcpDescriptor: async () => ({ serverName: "mission-control", command: "/usr/bin/node", args: ["/m.mjs"], env: {} }),
    verifyMissionMcpTools: async () => ({ ok: true }),
    pipelineLaunch: async () => ({ ok: true, launchRuntime: "agent-sdk", cwd: "/repo/pipeline", pipelineRun: PIPELINE_LINK }),
    spawn: async () => assert.fail("the managed host opens no terminal"),
  });

  await dispatcher.dispatch("pipeline-plain");
  assert.equal(registry.getTask("pipeline-plain")?.status, "running", registry.getTask("pipeline-plain")?.error ?? "");
  // No Persona: the host's launch carries no standing instructions at all, as before.
  assert.equal("standingInstructions" in starts[0]!, false);
  registry.upsertTask({ ...registry.getTask("pipeline-plain")!, status: "done" });

  await dispatcher.dispatch("pipeline-persona");
  assert.equal(registry.getTask("pipeline-persona")?.status, "running", registry.getTask("pipeline-persona")?.error ?? "");
  const start = starts[1]!;
  assert.deepEqual(start.standingInstructions?.delivery, {
    text: SECTION,
    mechanism: "codex-developer-instructions",
    sources: [],
  });
  // Turn one still opens with the skill invocation and does not carry the Persona; the fallback
  // for an unusable channel keeps the invocation first and the Persona after it.
  assert.match(start.prompt, /^\$engineer /);
  assert.equal(start.prompt.includes(GUIDANCE), false);
  assert.equal(start.standingInstructions?.fallbackPrompt, `${start.prompt}\n\n${SECTION}`);
});

test("a Terminal Pipeline host refuses a Persona before it spawns, and its idea never carries one", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "pipeline-terminal-persona",
    agent: "claude",
    kind: "pipeline",
    repoRoot: "/repo/pipeline-terminal",
    intent: "Review the pipeline",
    title: "Review the pipeline",
    workflowId: null,
    personaId: REVIEWER.id,
  }));
  const ideas: string[] = [];
  let spawned = false;
  await new Dispatcher(registry, async () => assert.fail("no worktree is owned"), {
    persona: lookup,
    // The provider composes the Terminal argv from the idea it is handed, as Conductor's does.
    pipelineLaunch: async (_repoRoot, idea) => {
      ideas.push(idea);
      return {
        ok: true,
        launchRuntime: "terminal",
        cwd: "/repo/pipeline-terminal",
        argv: ["/bin/conduct-ts", "engineer", "--idea", idea],
        // Its own run identity: the managed-host case above leaves its task owning that one.
        pipelineRun: { ...PIPELINE_LINK, repoRoot: "/repo/pipeline-terminal", slug: "review-the-terminal-pipeline" },
      };
    },
    spawn: async () => {
      spawned = true;
      return { homeName: "unreachable", homeBackend: "tmux", terminalResourceId: null };
    },
  }).dispatch("pipeline-terminal-persona");
  assert.equal(spawned, false);
  assert.match(
    registry.getTask("pipeline-terminal-persona")?.error ?? "",
    /a Terminal Pipeline host cannot receive a Persona; switch Settings → Conductor → Launch runtime to Managed Agent SDK, or choose No Persona under Advanced/,
  );
  // The idea is the work Engineer specifies, so the Persona is never written into it.
  assert.equal(ideas[0]?.includes(GUIDANCE), false);
  assert.ok(ideas[0]?.startsWith("Review the pipeline\n\n"));
});

test("the Pipeline preview shows what its Engineer host is sent, never the repository rules", async () => {
  const repo = seedRepo("pipeline-preview");
  const rule = "Never force-push.";
  const saved = updateStandingInstructions({ expectedEtag: standingInstructionsView().etag, default: "", repositories: { [repo]: rule } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const app = buildApp({
    registry: new Registry(),
    reviews: {} as never,
    tasks: {} as never,
    queues: {} as never,
    personas: { store: { getPersona: lookup } } as never,
  });
  const preview = async (params: Record<string, string>) => {
    const q = new URLSearchParams({ repoPath: repo, agent: "claude", runtime: "sdk", ...params });
    const response = await app.request(`/api/instructions/resolved?${q}`, { headers: { host: "127.0.0.1:7317" } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as { text: string; mechanism: string; sources: unknown[] };
  };
  try {
    // A harness-launched kind gets the repository rule, then the Persona.
    const ship = await preview({ kind: "ship", personaId: REVIEWER.id });
    assert.ok(ship.text.includes(rule));
    assert.ok(ship.text.endsWith(SECTION));

    // The managed Engineer host gets the Persona alone - the same answer the dispatcher sends.
    setPipelinesConfig({ launchRuntime: "agent-sdk" });
    assert.deepEqual(await preview({ kind: "pipeline", personaId: REVIEWER.id }), pipelineHostStanding(REVIEWER, "claude", "agent-sdk"));
    // With no Persona, nothing: the rule was never part of a Pipeline launch.
    assert.deepEqual(await preview({ kind: "pipeline" }), { text: "", mechanism: "none", sources: [] });
    // The Terminal host takes no standing instructions at all.
    setPipelinesConfig({ launchRuntime: "terminal" });
    assert.deepEqual(await preview({ kind: "pipeline", personaId: REVIEWER.id }), { text: "", mechanism: "none", sources: [] });

    const unknown = await app.request(
      `/api/instructions/resolved?${new URLSearchParams({ repoPath: repo, agent: "claude", runtime: "sdk", kind: "nonsense" })}`,
      { headers: { host: "127.0.0.1:7317" } },
    );
    assert.equal(unknown.status, 400);
  } finally {
    setPipelinesConfig({ launchRuntime: "agent-sdk" });
  }
});
