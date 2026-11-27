// Headless mode phase 5: the dispatch-options route, drafts and starting a task (spec 7.5, 7.6),
// and guard 1 of plan 4.2: a home-dispatched task takes the runtime and Focus a dashboard task has.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, mock, test } from "node:test";

// Above the imports: `openDb` refuses a state dir this file did not name.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-home-dispatch-drafts-")));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { closeDb, openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const shared = await import("../src/shared/home-dispatch.ts");
const { dispatchBannerPlain } = await import("../src/shared/home-dispatch-banner.ts");
const drafts = await import("../src/server/home-dispatch/drafts.ts");
const { resolveDispatchRuntime } = await import("../src/server/harnesses.ts");
const { configuredTerminalDeps } = await import("../src/server/terminals-config.ts");
const { OK, fakeEmulator, fakeMultiplexer } = await import("./helpers/terminal-fakes.ts");
const { mkMuxHandle } = await import("./helpers/session-fixture.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const registry = new Registry();
const tasks = new TaskManager(registry);
const workflows = new WorkflowManager(registry, new PersonaManager(registry).store);

// Focus is answered by fake terminals, so no window opens on whoever runs the suite.
const opened: string[][] = [];
const fakeIterm = fakeEmulator({
  id: "iterm",
  label: "iTerm2",
  spawn: { tab: async (spec: { argv: readonly string[] }) => { opened.push([...spec.argv]); return { ...OK, target: null }; } },
});
const tmux = fakeMultiplexer({
  sessions: {
    spawnDetached: async () => OK,
    attachArgv: (name: string) => ["fake-mux", "attach", "-t", name],
    rename: async () => OK,
    kill: async () => OK,
    alive: null,
    closeIfOnlyPane: null,
    names: { validate: () => null, sanitize: (t: string) => t },
  },
  clients: async () => [],
  select: async () => OK,
});
const focusTerminals = {
  ...configuredTerminalDeps,
  multiplexers: { tmux, herdr: fakeMultiplexer({ id: "herdr" }), cmux: fakeMultiplexer({ id: "cmux" }) },
  emulators: { ...configuredTerminalDeps.emulators, wezterm: fakeIterm, ghostty: fakeIterm, iterm: fakeIterm },
  installed: () => true,
};
const app = buildApp({
  registry,
  reviews: new ReviewManager(registry),
  tasks,
  queues: new QueueManager(registry),
  workflows,
  focusTerminals,
});
const headers = { host: "127.0.0.1:7317", "x-harness-token": ensureToken(), "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

function git(path: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  return realpathSync(path);
}
const repo = git(join(home, "repo"));
const other = git(join(home, "other"));
const plain = join(home, "plain");
mkdirSync(plain);

let dispatched: Array<{ id: string; options: unknown }> = [];
let dispatchResult: { ok: true } | { ok: false; error: string } = { ok: true };

beforeEach(() => {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: true }).ok, true);
  const d = openDb();
  d.exec("DELETE FROM home_dispatch_sessions");
  drafts.clearHomeDispatchDrafts();
  mock.restoreAll();
  mock.method(Date, "now", Date.now);
  dispatched = [];
  dispatchResult = { ok: true };
  // Starting a task would launch a real agent; record the call instead.
  mock.method(tasks, "dispatch", async (id: string, opts: unknown) => {
    dispatched.push({ id, options: opts });
    return dispatchResult.ok ? { ok: true as const, task: registry.getTask(id)! } : { ok: false as const, error: dispatchResult.error };
  });
});

async function register(sessionId: string, cwd: string): Promise<void> {
  const res = await post("/dispatch/sessions", {
    sessionId, harness: "claude", cwd, clientVersion: "1.0.0", source: "startup",
    entrypoint: "cli", interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
  });
  assert.equal(res.status, 200);
}

async function createDraft(body: Record<string, unknown>) {
  const res = await post("/dispatch/drafts", { sessionId: "s1", ...body });
  return { res, body: await res.json() as Record<string, any> };
}
const confirm = (id: string, choice: string, sessionId = "s1") =>
  post(`/dispatch/drafts/${id}/confirm`, { sessionId, choice });

/* ------------------------------------------------------------------------ options */

test("dispatch-options answers a registered home session with pages, and refuses any other", async () => {
  const refused = await post("/dispatch/dispatch-options", { sessionId: "ghost", cwd: repo, entry: "command" });
  assert.equal(refused.status, 403);

  await register("s1", repo);
  const res = await post("/dispatch/dispatch-options", { sessionId: "s1", cwd: repo, entry: "first-message", brief: "fix the crash" });
  assert.equal(res.status, 200);
  const { questions } = shared.HomeDispatchOptionsResponseSchema.parse(await res.json());
  assert.deepEqual([...new Set(questions.map((q) => q.id))], ["start", "kind"], "inside a repository there is no Repo page");
  assert.equal(questions.find((q) => q.id === "kind")!.options[0]!.value, "bugfix");

  const withKind = await post("/dispatch/dispatch-options", { sessionId: "s1", cwd: repo, entry: "command", kind: "ship" });
  const pages = shared.HomeDispatchOptionsResponseSchema.parse(await withKind.json()).questions;
  assert.ok(pages.every((q) => q.id === "after-work"));
  assert.equal(pages[0]!.options[0]!.value, "builtin-workflow:no-mistakes-review", "the kind's default leads");
  assert.equal(pages[0]!.options[1]!.value, "none");
});

test("dispatch-options is 404 with the flag off", async () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
  const res = await post("/dispatch/dispatch-options", { sessionId: "s1", cwd: repo, entry: "command" });
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------------------- drafts */

test("a draft summary has the 7.6 fields and the Form 3 text", async () => {
  await register("s1", repo);
  const { res, body } = await createDraft({ kind: "ship", words: "add retries", context: "see client.ts" });
  assert.equal(res.status, 200);
  const summary = shared.HomeDispatchDraftSummarySchema.parse(body);
  assert.equal(summary.repoRoot, repo);
  assert.equal(summary.kind, "ship");
  assert.equal(summary.kindLabel, "ship");
  assert.equal(summary.afterWork, "No-Mistakes Review (High Rigor)");
  assert.equal(summary.afterWorkApplies, true);
  assert.equal(summary.words, "add retries");
  assert.equal(summary.context, "see client.ts");
  assert.deepEqual(summary.needs, []);
  assert.equal(summary.brief, "add retries\n\n## Context Claude added\nsee client.ts");
  assert.equal(summary.text, [
    `Repo: ${repo}`, "Kind: ship", "After work: No-Mistakes Review (High Rigor)", "", "Description:", "add retries", "",
    "Context Claude added:", "see client.ts",
  ].join("\n"));
});

test("scout and none read as None, with no diff for the kinds that have none", async () => {
  await register("s1", repo);
  const scout = (await createDraft({ kind: "scout", words: "look into it" })).body;
  assert.equal(scout.afterWork, "None (no diff)");
  assert.equal(scout.afterWorkApplies, false);
  const none = (await createDraft({ kind: "ship", words: "x", workflowId: "none" })).body;
  assert.equal(none.afterWork, "None");
});

test("a session has at most one draft, and a new one replaces the old", async () => {
  await register("s1", repo);
  const first = (await createDraft({ kind: "ship", words: "one" })).body;
  const second = (await createDraft({ kind: "ship", words: "two" })).body;
  assert.notEqual(first.draftId, second.draftId);
  const stale = await post(`/dispatch/drafts/${first.draftId}`, { sessionId: "s1", words: "late" });
  assert.equal(stale.status, 404);
  const current = await post(`/dispatch/drafts/${second.draftId}`, { sessionId: "s1", words: "later" });
  assert.equal(current.status, 200);
});

test("create refuses chat with the backlog sentence, an unknown path, and an unknown name", async () => {
  await register("s1", repo);
  const chat = await createDraft({ kind: "chat", words: "talk" });
  assert.equal(chat.res.status, 400);
  assert.equal(chat.body.error, "Chat tasks must be launched immediately from Dispatch.");
  const pipeline = await createDraft({ kind: "pipeline", words: "x" });
  assert.equal(pipeline.res.status, 400);
  const notRepo = await createDraft({ kind: "ship", words: "x", repo: plain });
  assert.equal(notRepo.res.status, 400);
  assert.equal(notRepo.body.error, `not a repository: ${plain}`);
  const unknown = await createDraft({ kind: "ship", words: "x", repo: "no-such-repo-anywhere" });
  assert.equal(unknown.res.status, 400);
  assert.equal(unknown.body.error, "unknown repository no-such-repo-anywhere");
});

test("a named repository path wins over the session's own, and a missing one is listed in needs", async () => {
  await register("s1", repo);
  assert.equal((await createDraft({ kind: "ship", words: "x", repo: other })).body.repoRoot, other);

  await register("s2", plain);
  const res = await post("/dispatch/drafts", { sessionId: "s2", kind: "ship", words: "" });
  const summary = shared.HomeDispatchDraftSummarySchema.parse(await res.json());
  assert.equal(summary.repoRoot, "");
  assert.deepEqual(summary.needs, ["description", "repo"]);
});

test("a draft route refuses an unregistered session and another session's draft", async () => {
  const unregistered = await post("/dispatch/drafts", { sessionId: "ghost", kind: "ship" });
  assert.equal(unregistered.status, 403);
  await register("s1", repo);
  await register("s2", repo);
  const mine = (await createDraft({ kind: "ship", words: "x" })).body;
  assert.equal((await post(`/dispatch/drafts/${mine.draftId}`, { sessionId: "s2", words: "y" })).status, 404);
  assert.equal((await confirm(mine.draftId, "cancel", "s2")).status, 404);
});

test("update changes the fields, and a kind change without a workflow resets after work to the new default", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "ship", words: "x", workflowId: "none" })).body;
  assert.equal(draft.afterWork, "None");

  const words = await (await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", words: "new words", context: "ctx" })).json() as any;
  assert.equal(words.words, "new words");
  assert.equal(words.context, "ctx");
  assert.equal(words.afterWork, "None", "other edits keep the pick");

  const kind = await (await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", kind: "bugfix" })).json() as any;
  assert.equal(kind.kind, "bugfix");
  assert.equal(kind.afterWork, "Bug Fix Review", "the new kind's default");

  const repoChange = await (await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", repo: other })).json() as any;
  assert.equal(repoChange.repoRoot, other);

  const cleared = await (await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", context: "  " })).json() as any;
  assert.equal(cleared.context, null);

  const chat = await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", kind: "chat" });
  assert.equal(chat.status, 400);
});

test("a draft expires 24 hours after its last change", async () => {
  await register("s1", repo);
  let now = 1_800_000_000_000;
  mock.method(Date, "now", () => now);
  const draft = (await createDraft({ kind: "ship", words: "x" })).body;
  now += drafts.DRAFT_TTL_MS - 1;
  assert.equal((await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", words: "y" })).status, 200, "a change restarts the clock");
  now += drafts.DRAFT_TTL_MS - 1;
  assert.equal((await post(`/dispatch/drafts/${draft.draftId}`, { sessionId: "s1", words: "z" })).status, 200);
  now += drafts.DRAFT_TTL_MS + 1;
  assert.equal((await confirm(draft.draftId, "cancel")).status, 404);
});

/* ------------------------------------------------------------------------ confirm */

function taskRow(taskId: string) {
  return openDb()
    .prepare("SELECT status, enabled, intent, kind, agent, repo_root, origin_surface, origin_repo, origin_session_id, workflow_id FROM tasks WHERE id = ?")
    .get(taskId) as Record<string, unknown>;
}

test("cancel creates nothing and deletes the draft", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "ship", words: "x", workflowId: "none" })).body;
  const before = registry.listTasks().length;
  const res = await confirm(draft.draftId, "cancel");
  assert.deepEqual(shared.HomeDispatchConfirmResultSchema.parse(await res.json()), { choice: "cancel", taskId: null, started: false });
  assert.equal(registry.listTasks().length, before);
  assert.equal((await confirm(draft.draftId, "cancel")).status, 404, "the draft is gone");
});

test("backlog files a shelved task with its origin stamped and starts nothing", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "ship", words: "add retries", context: "see client.ts", repo: other, workflowId: "none" })).body;
  const res = await confirm(draft.draftId, "backlog");
  assert.equal(res.status, 200);
  const result = shared.HomeDispatchConfirmResultSchema.parse(await res.json());
  assert.equal(result.choice, "backlog");
  assert.equal(result.started, false);
  assert.deepEqual(dispatched, []);

  const row = taskRow(result.taskId!);
  assert.equal(row.status, "backlog");
  assert.equal(row.enabled, 0, "shelved");
  assert.equal(row.intent, "add retries\n\n## Context Claude added\nsee client.ts", "the brief is exactly what the worker receives");
  assert.equal(row.repo_root, other);
  assert.equal(row.origin_surface, "home-session");
  assert.equal(row.origin_repo, repo, "the session's own repository, though the task targets another");
  assert.equal(row.origin_session_id, "s1");
  assert.equal(row.agent, "claude");
  assert.equal((await confirm(draft.draftId, "backlog")).status, 404, "the draft is gone");
});

test("start files the task disabled and starts it with an override, passing no runtime", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "scout", words: "look into the flaky test" })).body;
  const res = await confirm(draft.draftId, "start");
  assert.equal(res.status, 200);
  const result = shared.HomeDispatchConfirmResultSchema.parse(await res.json());
  assert.equal(result.started, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.id, result.taskId);
  assert.deepEqual(dispatched[0]!.options, { overrideDisabled: true }, "no runtime, no pause-hold override");
  const row = taskRow(result.taskId!);
  assert.equal(row.enabled, 0, "created disabled, so autopilot cannot start it between the two calls");
  assert.equal(row.origin_surface, "home-session");
});

test("a start the daemon refuses keeps the filed task shelved and says so", async () => {
  await register("s1", repo);
  dispatchResult = { ok: false, error: "launches are held" };
  const draft = (await createDraft({ kind: "scout", words: "x" })).body;
  const res = await confirm(draft.draftId, "start");
  assert.equal(res.status, 409);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, "launches are held");
  assert.equal(body.started, false);
  assert.equal(taskRow(body.taskId as string).status, "backlog");
  assert.equal((await confirm(draft.draftId, "start")).status, 404, "the draft was spent by the failed start");
  assert.equal((await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", words: "y" })).status, 404);
});

test("a draft missing its words or its repository is refused and kept", async () => {
  await register("s1", plain);
  const draft = (await createDraft({ kind: "ship", words: "  ", workflowId: "none" })).body;
  const empty = await confirm(draft.draftId, "start");
  assert.equal(empty.status, 400);
  assert.equal((await empty.json() as any).error, "the task needs a description");
  assert.equal((await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", words: "x" })).status, 200, "kept");

  const noRepo = await confirm(draft.draftId, "backlog");
  assert.equal(noRepo.status, 400);
  assert.equal((await noRepo.json() as any).error, "the task needs a repo");
  assert.equal((await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", repo })).status, 200, "kept");
  assert.equal((await confirm(draft.draftId, "backlog")).status, 200);
});

test("an after-work Workflow that cannot launch refuses a start but not a backlog save", async () => {
  await register("s1", repo);
  const start = (await createDraft({ kind: "ship", words: "x" })).body;
  const refused = await confirm(start.draftId, "start");
  assert.equal(refused.status, 409, "the default review cannot arm in this fixture");
  assert.match((await refused.json() as any).error, /Foreman|Live delivery/);
  assert.deepEqual(dispatched, []);

  const backlog = (await createDraft({ kind: "ship", words: "x" })).body;
  assert.equal((await confirm(backlog.draftId, "backlog")).status, 200);
});

/* ----------------------------------------------------------------------- guard 1 */

test("guard 1: a task started from a confirmed draft keeps the dashboard's runtime, and Focus answers the same", async () => {
  await register("s1", repo);
  // The operator's terminal choice for Claude, so the default under test is a terminal pane.
  const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
  setHarnessesConfig({ sessionRuntime: { claude: "terminal" } });

  // A dashboard task of the same kind, filed through the dashboard's own route.
  const dash = await post("/api/tasks", {
    repoRoot: repo, intent: "look into it", kind: "scout", agent: "claude", workflowId: null, backlog: true,
  });
  assert.equal(dash.status, 200);
  const dashTask = await dash.json() as { id: string; agent: string };

  const draft = (await createDraft({ kind: "scout", words: "look into it" })).body;
  const started = shared.HomeDispatchConfirmResultSchema.parse(await (await confirm(draft.draftId, "start")).json());
  const homeRow = taskRow(started.taskId!);

  // Same agent, hence the same runtime resolution: nothing in the draft path names one.
  assert.equal(homeRow.agent, dashTask.agent);
  assert.deepEqual(dispatched[0]!.options, { overrideDisabled: true });
  assert.equal(resolveDispatchRuntime(homeRow.agent as "claude"), resolveDispatchRuntime(dashTask.agent as "claude"));
  assert.equal(resolveDispatchRuntime("claude"), "terminal", "a terminal pane is what a scout gets by default");

  // Each task gets a terminal pane, bound to it, and both are focused through the one existing
  // route. The answers match, because headless mode adds no Focus branch.
  const answers = [];
  const panes: Array<[string, string]> = [["dash", dashTask.id], ["home", started.taskId!]];
  for (const [i, [name, taskId]] of panes.entries()) {
    const discovered = {
      syntheticId: "pane-" + name, agent: "claude", name, nameSource: "process", cwd: "/wt/" + name, gitBranch: null,
      pid: 100 + i, tty: "ttys10" + i, terminals: [mkMuxHandle({ session: name, windowName: "0", paneId: "%" + i })], startedAt: 0,
    } as DiscoveredSession;
    registry.applyDiscovery([discovered]);
    registry.upsertTask({ ...registry.getTask(taskId)!, sessionId: "pane-" + name, status: "running" });
    assert.equal(registry.taskForSession("pane-" + name, "/wt/" + name)?.id, taskId, "the pane belongs to the filed task");
    const res = await app.request("/api/sessions/pane-" + name + "/focus", { method: "POST", headers, body: "{}" });
    answers.push({ status: res.status, body: await res.json() });
  }
  assert.equal(answers[0]!.status, 200);
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(opened.length, 2, "each focus opened a terminal on its pane");
});

test("options and drafts never touch the terminal layer", async () => {
  const source = await import("node:fs").then((fs) =>
    ["options.ts", "drafts.ts"].map((f) => fs.readFileSync(new URL(`../src/server/home-dispatch/${f}`, import.meta.url), "utf8")).join("\n"));
  assert.ok(!/runtime|terminal/i.test(source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
    "the code names no runtime and no terminal");
});

/* ------------------------------------------------------------- repair-round additions */

test("an explicitly picked workflow that cannot be filed is refused, and a rejected update keeps the prior pick", async () => {
  await register("s1", repo);
  const refusedCreate = await createDraft({ kind: "ship", words: "x", workflowId: "no-such-workflow" });
  assert.equal(refusedCreate.res.status, 409);
  assert.equal(refusedCreate.body.error, "Choose a workflow with a published version");

  const draft = (await createDraft({ kind: "ship", words: "x", workflowId: "none" })).body;
  assert.equal(draft.afterWork, "None");
  const refusedUpdate = await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", workflowId: "no-such-workflow", words: "changed" });
  assert.equal(refusedUpdate.status, 409);
  assert.equal((await refusedUpdate.json() as any).error, "Choose a workflow with a published version");
  const kept = await (await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1" })).json() as any;
  assert.equal(kept.afterWork, "None", "the prior pick stands");
  assert.equal(kept.words, "x", "and nothing else in the rejected update was applied");
});

test("the options route lists only active published workflows", async () => {
  await register("s1", repo);
  const summary = (id: string, name: string, over: Record<string, unknown>) =>
    ({ id, name, archivedAt: null, currentVersionId: "v1", ...over });
  mock.method(workflows, "list", () => [
    summary("w-live", "Live Review", {}),
    summary("w-archived", "Archived Review", { archivedAt: 5 }),
    summary("w-unpublished", "Draft Review", { currentVersionId: null }),
  ] as never);
  const res = await post("/dispatch/dispatch-options", { sessionId: "s1", cwd: repo, entry: "command", kind: "ship" });
  const labels = shared.HomeDispatchOptionsResponseSchema.parse(await res.json()).questions.flatMap((q) => q.options.map((o) => o.label));
  assert.ok(labels.includes("Live Review"));
  assert.ok(!labels.includes("Archived Review"));
  assert.ok(!labels.includes("Draft Review"));
});

test("the daemon builds the banner on a startup registration only", async () => {
  const reg = (source: string) => post("/dispatch/sessions", {
    sessionId: "s1", harness: "claude", cwd: repo, clientVersion: "9.9.9-mod", source,
    entrypoint: "cli", interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
  });
  const startup = shared.HomeSessionRegistrationAnswerSchema.parse(await (await reg("startup")).json());
  assert.equal(startup.banner?.length, 3);
  assert.equal(startup.banner![2], "mod and daemon versions differ | run mctl doctor");
  for (const source of ["resume", "clear", "compact"]) {
    assert.equal(shared.HomeSessionRegistrationAnswerSchema.parse(await (await reg(source)).json()).banner, undefined, source);
  }
});

/* ------------------------------------------------------------- repair round 2 additions */

test("a startup registration with matching versions returns the daemon's counts and launcher hint", async () => {
  const { SERVICE_VERSION } = await import("../src/server/version.ts");
  const reg = () => post("/dispatch/sessions", {
    sessionId: "s1", harness: "claude", cwd: repo, clientVersion: SERVICE_VERSION, source: "startup",
    entrypoint: "cli", interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
  });
  const first = shared.HomeSessionRegistrationAnswerSchema.parse(await (await reg()).json());
  assert.equal(first.offerLauncher, true);
  assert.equal(first.banner![0]!.includes("Claude Code"), true);
  const expected = (counts: typeof first.counts, menuOffered: boolean) =>
    dispatchBannerPlain({ harness: "claude", counts, menuOffered, versionMismatch: false })[2];
  assert.equal(first.banner![2], expected(first.counts, true), "the banner shows the daemon's own counts and the launcher decision");
  assert.match(first.banner![2]!, /I will ask how you want to start$/);
  const again = shared.HomeSessionRegistrationAnswerSchema.parse(await (await reg()).json());
  assert.equal(again.offerLauncher, false);
  assert.equal(again.banner![2], expected(again.counts, false));
  assert.match(again.banner![2]!, /\/mission-dispatch opens the menu$/);
});

test("a repository name matches case-insensitively, and several matches are refused by name", async () => {
  const { setRepoIndexConfig } = await import("../src/server/repo-index.ts");
  const ws = realpathSync(mkdtempSync(join(home, "ws-")));
  const widgets = git(join(ws, "Widgets"));
  const twinA = git(join(ws, "g1", "twin"));
  const twinB = git(join(ws, "g2", "twin"));
  setRepoIndexConfig({ directories: [{ path: ws }] });
  await register("s1", plain);

  const named = await createDraft({ kind: "ship", words: "x", repo: "widgets", workflowId: "none" });
  assert.equal(named.res.status, 200);
  assert.equal(named.body.repoRoot, widgets);

  const twin = await createDraft({ kind: "ship", words: "x", repo: "TWIN", workflowId: "none" });
  assert.equal(twin.res.status, 400);
  assert.equal(twin.body.error, "TWIN matches " + [twinA, twinB].sort().join(", "));
});

test("a saved workflow that became unavailable is refused at confirm, creates nothing and keeps the draft", async () => {
  await register("s1", repo);
  const real = workflows.workflowSelectionBlock.bind(workflows);
  let unavailable = false;
  mock.method(workflows, "workflowSelectionBlock", (id: string) =>
    unavailable ? { message: "The selected workflow is archived" } : real(id) ?? null);
  mock.method(workflows, "dispatchWorkflowBlock", () => null);
  const draft = (await createDraft({ kind: "ship", words: "x", workflowId: NO_MISTAKES })).body;
  assert.equal(draft.kind, "ship");

  unavailable = true;
  const before = registry.listTasks().length;
  const refused = await confirm(draft.draftId, "backlog");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json() as any).error, "The selected workflow is archived");
  assert.equal(registry.listTasks().length, before, "no task was created");
  assert.equal((await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", workflowId: "none" })).status, 200, "the draft remains");
});

test("a draft is still available at exactly 24 hours and gone one millisecond later", async () => {
  await register("s1", repo);
  let now = 1_800_000_000_000;
  mock.method(Date, "now", () => now);
  const draft = (await createDraft({ kind: "ship", words: "x" })).body;
  now += drafts.DRAFT_TTL_MS;
  assert.equal((await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", words: "y" })).status, 200);
  now += drafts.DRAFT_TTL_MS + 1;
  assert.equal((await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", words: "z" })).status, 404);
});

const NO_MISTAKES = "builtin-workflow:no-mistakes-review";

test("a valid workflow update changes the saved pick and the filed task", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "ship", words: "x" })).body;
  assert.equal(draft.afterWork, "No-Mistakes Review (High Rigor)");
  const updated = await (await post("/dispatch/drafts/" + draft.draftId, { sessionId: "s1", workflowId: "none" })).json() as any;
  assert.equal(updated.afterWork, "None");
  const result = shared.HomeDispatchConfirmResultSchema.parse(await (await confirm(draft.draftId, "backlog")).json());
  assert.equal(taskRow(result.taskId!).workflow_id, null, "the task carries None, not the kind's default");
});

test("the options route offers the workspace repositories, then Other, outside a repository", async () => {
  const { setRepoIndexConfig } = await import("../src/server/repo-index.ts");
  const ws = realpathSync(mkdtempSync(join(home, "ws-opts-")));
  const listed = git(join(ws, "Listed"));
  setRepoIndexConfig({ directories: [{ path: ws }] });
  await register("s1", plain);
  const res = await post("/dispatch/dispatch-options", { sessionId: "s1", cwd: plain, entry: "command", kind: "scout" });
  const repoPages = shared.HomeDispatchOptionsResponseSchema.parse(await res.json()).questions.filter((q) => q.id === "repo");
  const options = repoPages.flatMap((q) => q.options);
  assert.ok(options.some((o) => o.value === listed && o.label === "Listed"), "the workspace repository is offered");
  assert.equal(repoPages.at(-1)!.options.at(-1)!.value, "other");
});

test("two concurrent confirms of one draft file one task, and a newer draft survives", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "scout", words: "x" })).body;
  const before = registry.listTasks().length;
  const [a, b] = await Promise.all([confirm(draft.draftId, "backlog"), confirm(draft.draftId, "backlog")]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(registry.listTasks().length, before + 1, "exactly one task was filed");

  const first = (await createDraft({ kind: "scout", words: "one" })).body;
  const racing = confirm(first.draftId, "backlog");
  const newer = (await createDraft({ kind: "scout", words: "two" })).body;
  await racing;
  assert.equal((await post("/dispatch/drafts/" + newer.draftId, { sessionId: "s1", words: "three" })).status, 200, "the newer draft was not deleted");
});

test("a pre-creation refusal releases the claim so the same draft can be confirmed again", async () => {
  await register("s1", repo);
  const draft = (await createDraft({ kind: "ship", words: "x" })).body;
  assert.equal((await confirm(draft.draftId, "start")).status, 409, "the default review cannot arm here");
  assert.deepEqual(dispatched, []);
  assert.equal((await confirm(draft.draftId, "backlog")).status, 200, "the draft was not left claimed");
});

test("context is stored trimmed on create and on update", async () => {
  await register("s1", repo);
  const created = (await createDraft({ kind: "scout", words: "x", context: "\n  see client.ts \n" })).body;
  assert.equal(created.context, "see client.ts");
  assert.equal(created.brief, "x\n\n## Context Claude added\nsee client.ts");
  const updated = await (await post("/dispatch/drafts/" + created.draftId, { sessionId: "s1", context: "  other  \n" })).json() as any;
  assert.equal(updated.context, "other");
});

test("a start that throws still reports the filed task id", async () => {
  await register("s1", repo);
  mock.method(tasks, "dispatch", async () => { throw new Error("stacking failed"); });
  const draft = (await createDraft({ kind: "scout", words: "x" })).body;
  const res = await confirm(draft.draftId, "start");
  assert.equal(res.status, 409);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.error, "stacking failed");
  assert.equal(body.started, false);
  assert.equal(taskRow(body.taskId as string).status, "backlog");
});

test("a slower earlier create cannot overwrite a newer draft", async () => {
  await register("s1", repo);
  const slow = createDraft({ kind: "ship", words: "older", repo: other, workflowId: "none" });
  const fast = await createDraft({ kind: "ship", words: "newer", workflowId: "none" });
  assert.equal(fast.res.status, 200);
  const older = await slow;
  assert.equal(older.res.status, 409);
  assert.equal(older.body.error, "a newer draft was started for this session");
  const kept = await post("/dispatch/drafts/" + fast.body.draftId, { sessionId: "s1", words: "still here" });
  assert.equal(kept.status, 200, "the newer draft survived");
});

test("an earlier create stays rejected after the newer draft was confirmed", async () => {
  await register("s1", repo);
  const slow = createDraft({ kind: "ship", words: "older", repo: other, workflowId: "none" });
  const fast = await createDraft({ kind: "ship", words: "newer", workflowId: "none" });
  assert.equal((await confirm(fast.body.draftId, "cancel")).status, 200, "the newer draft is spent");
  const older = await slow;
  assert.equal(older.res.status, 409);
  assert.equal((await post("/dispatch/drafts/" + older.body.draftId, { sessionId: "s1", words: "x" })).status, 404, "no draft came back");
});

test("the draft summary names only published workflows, as the options page does", async () => {
  await register("s1", repo);
  const live = { id: "builtin-workflow:no-mistakes-review", name: "Live Name", archivedAt: null, currentVersionId: "v1" };
  mock.method(workflows, "list", () => [live] as never);
  assert.equal((await createDraft({ kind: "ship", words: "x" })).body.afterWork, "Live Name");
  mock.method(workflows, "list", () => [{ ...live, archivedAt: 5 }] as never);
  assert.equal((await createDraft({ kind: "ship", words: "x" })).body.afterWork, "Unavailable workflow", "archived");
  mock.method(workflows, "list", () => [{ ...live, currentVersionId: null }] as never);
  assert.equal((await createDraft({ kind: "ship", words: "x" })).body.afterWork, "Unavailable workflow", "unpublished");
});
