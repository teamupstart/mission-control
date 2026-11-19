// F3: the dispatch choices come from the shared registries, so they match the dashboard.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-options-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-home-dispatch-options-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openDb, closeDb } = await import("../src/server/db.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const options = await import("../src/shared/dispatch-options.ts");
const afterWorkLib = await import("../src/shared/after-work.ts");
const { HOME_DISPATCH_KIND_ORDER, HOME_DISPATCH_KINDS, DISPATCH_FEATURE_DISABLED } = await import("../src/shared/home-dispatch.ts");
const task = await import("../src/shared/task.ts");
const { TASK_KINDS } = await import("../src/shared/types.ts");
const builtin = await import("../src/shared/builtin-workflow.ts");
const { setUiConfig } = await import("../src/server/ui-config.ts");

const FLAG = "headless-mode" as const;

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});
afterEach(() => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false });
  openDb().exec("DELETE FROM app_config");
});

function gitRepo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

function app() {
  const registry = new Registry();
  return buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
}
const headers = () => ({ host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() });
const post = (a: ReturnType<typeof app>, body: unknown) =>
  a.request("/mcp/dispatch/dispatch-options", { method: "POST", headers: headers(), body: JSON.stringify(body) });

const FACTS = {
  request: { entry: "command" as const } as { entry: "command" | "first-message" | "conversation"; kind?: "ship" | "scout" | "plan" | "chat"; brief?: string },
  cwdInRepo: true,
  repos: [] as string[],
  workflows: [] as { id: string; name: string }[],
  configured: {} as Record<string, string | null>,
  storage: "repository" as "repository" | "local",
  guidedDispatch: true,
};
type Facts = typeof FACTS;
const build = (over: Partial<Facts> = {}) => options.buildDispatchOptions({ ...FACTS, ...over });

test("F3 order: the kind order holds exactly the dispatch kinds", () => {
  assert.deepEqual([...HOME_DISPATCH_KIND_ORDER].sort(), [...HOME_DISPATCH_KINDS].sort());
});

test("F3 recommend: whole-word hints, ties to the earlier kind, no match is null", () => {
  assert.equal(options.recommendKind("fix the flaky login test"), "bugfix");
  assert.equal(options.recommendKind("investigate why the build is slow"), "scout");
  assert.equal(options.recommendKind("write up the readme"), "document");
  assert.equal(options.recommendKind("let us brainstorm"), "chat");
  assert.equal(options.recommendKind("a fixture for the debugger"), null, "fixture is not fix, debugger is not bug");
  assert.equal(options.recommendKind("add a fix"), "ship", "one hint each: the earlier kind wins the tie");
  assert.equal(options.recommendKind("fix the crash and add nothing"), "bugfix");
  assert.equal(options.recommendKind("hello there"), null);
  assert.equal(options.recommendKind(undefined), null);
});

test("F3 paging: pages of at most four, every page but the last ends with More", () => {
  const choices = (n: number) => Array.from({ length: n }, (_, i) => ({ value: "v" + i, label: "L" + i }));
  assert.deepEqual(options.pageOptions(choices(4)).map((p) => p.length), [4]);
  const pages = options.pageOptions(choices(9));
  assert.deepEqual(pages.map((p) => p.length), [4, 4, 3]);
  assert.deepEqual(pages.flat().filter((c) => c.value !== "more").map((c) => c.value), choices(9).map((c) => c.value));
  for (const page of pages.slice(0, -1)) assert.deepEqual(page.at(-1), { value: "more", label: "More..." });
  assert.ok(pages.at(-1)!.every((c) => c.value !== "more"));
  assert.deepEqual(options.pageOptions([]), []);
});

test("F3 schema: elicitationSchemaFor is one required string with oneOf in option order and the default", () => {
  const schema = options.elicitationSchemaFor(
    { title: "T", default: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    "pick",
  );
  assert.deepEqual(schema, {
    type: "object",
    properties: { pick: { type: "string", title: "T", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }], default: "b" } },
    required: ["pick"],
  });
});

test("F3 dashboard parity: kindAfterWork agrees with the dashboard rule for every kind, row and storage", () => {
  const rows = [{}, { ship: null }, { ship: "w1", bugfix: "w2", plan: null, document: "w3" }];
  for (const kind of TASK_KINDS) {
    for (const configured of rows) {
      for (const storage of ["repository", "local"] as const) {
        assert.equal(
          options.kindAfterWork(kind, configured, storage),
          task.taskDefaultWorkflowId(kind, configured, storage),
          kind + " " + storage,
        );
      }
    }
  }
});

test("F3 dashboard parity: the dispatch modal reads its default through the shared rule", () => {
  const source = readFileSync(new URL("../src/web/components/DispatchModal.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("kindAfterWork"));
  assert.ok(!source.includes("taskDefaultWorkflowId"), "the modal has no second copy of the rule");
});

test("F3 form 1: kinds except chat in order, then work-here and check-in, every title from the registry", () => {
  const form = build().forms.start!;
  assert.equal(form.title, "What do you want to do?");
  assert.deepEqual(
    form.options.map((o) => o.value),
    [...HOME_DISPATCH_KIND_ORDER.filter((k) => k !== "chat"), "work-here", "check-in"],
  );
  for (const kind of HOME_DISPATCH_KIND_ORDER.filter((k) => k !== "chat")) {
    const info = task.TASK_KIND_INFO[kind];
    assert.equal(form.options.find((o) => o.value === kind)!.label, info.label + ": " + info.blurb);
  }
});

test("F3 form 1 default: a recommendation, else work-here for a first message, else the default kind", () => {
  const start = (entry: "command" | "first-message" | "conversation", brief?: string) =>
    build({ request: { entry, brief } }).forms.start!.default;
  assert.equal(start("first-message", "fix the crash"), "bugfix");
  assert.equal(start("first-message", "hello"), "work-here");
  assert.equal(start("command", "hello"), "ship");
  assert.equal(start("conversation"), "ship");
  assert.equal(start("first-message", "let us brainstorm"), "work-here", "chat is not offered, so it counts as no recommendation");
  assert.equal(start("command", "let us brainstorm"), "ship");
});

test("F3 form 1: a given kind skips it", () => {
  assert.equal(build({ request: { entry: "command", kind: "ship" } }).forms.start, null);
});

test("F3 form 2: the kind's default first and preselected, then None, then every published workflow", () => {
  const workflows = [
    { id: builtin.NO_MISTAKES_REVIEW_WORKFLOW_ID, name: "No Mistakes Review" },
    { id: "w-ops", name: "Ops Review" },
  ];
  const request = { entry: "command" as const, kind: "ship" as const };
  const form = build({ workflows, request }).forms.afterWork!;
  assert.equal(form.default, builtin.NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.deepEqual(form.options.map((o) => o.value), [builtin.NO_MISTAKES_REVIEW_WORKFLOW_ID, "none", "w-ops"]);
  const configured = build({ workflows, configured: { ship: "w-ops" }, request }).forms.afterWork!;
  assert.deepEqual(configured.options.map((o) => o.value), ["w-ops", "none", builtin.NO_MISTAKES_REVIEW_WORKFLOW_ID]);
  const none = build({ workflows, configured: { ship: null }, request }).forms.afterWork!;
  assert.equal(none.default, "none");
  assert.equal(none.options[0]!.value, "none");
});

test("F3 form 2: plan with local storage shows Local Plan Validation as its default", () => {
  const form = build({
    storage: "local",
    workflows: [{ id: builtin.LOCAL_PLAN_VALIDATION_WORKFLOW_ID, name: "Local Plan Validation" }],
    request: { entry: "command", kind: "plan" },
  }).forms.afterWork!;
  assert.equal(form.default, builtin.LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  assert.equal(form.options[0]!.label, "Local Plan Validation");
});

test("F3 form 2: an unavailable default is kept and labelled", () => {
  const form = build({ workflows: [{ id: "w-ops", name: "Ops Review" }], request: { entry: "command", kind: "ship" } }).forms.afterWork!;
  assert.equal(form.options[0]!.value, builtin.NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.equal(form.options[0]!.label, "Unavailable workflow");
});

test("F3 form 2: null for scout and chat, with guided dispatch off, and when only None would be offered", () => {
  const workflows = [{ id: "w-ops", name: "Ops Review" }];
  assert.equal(build({ workflows, request: { entry: "command", kind: "scout" } }).forms.afterWork, null);
  assert.equal(build({ workflows, request: { entry: "command", kind: "chat" } }).forms.afterWork, null);
  assert.equal(build({ workflows, guidedDispatch: false, request: { entry: "command", kind: "ship" } }).forms.afterWork, null);
  assert.equal(build({ configured: { ship: null }, request: { entry: "command", kind: "ship" } }).forms.afterWork, null);
  assert.equal(build().forms.afterWork, null, "no kind yet");
  assert.ok(build({ guidedDispatch: false }).forms.start, "guided off never removes the launcher");
});

test("F3 repo form: only outside a repository with workspace repositories, then other", () => {
  assert.equal(build({ cwdInRepo: true, repos: ["/w/a"] }).forms.repo, null);
  assert.equal(build({ cwdInRepo: false, repos: [] }).forms.repo, null);
  const form = build({ cwdInRepo: false, repos: ["/w/a", "/w/b"] }).forms.repo!;
  assert.deepEqual(form.options.map((o) => o.value), ["/w/a", "/w/b", "other"]);
  assert.equal(form.default, "/w/a");
});

test("F3 fallback: stable ids, headers, pages of four, and the fallback keeps chat", () => {
  const response = build({ cwdInRepo: false, repos: ["/w/a"] });
  assert.deepEqual(response.questions.map((q) => q.header), ["Start", "Repo", "Kind", "Kind"]);
  assert.deepEqual(response.questions[0]!.options.map((o) => o.value), ["work-here", "dispatch", "check-in"]);
  assert.ok(response.questions.every((q) => q.options.length <= 4));
  const kindValues = response.questions
    .filter((q) => q.header === "Kind")
    .flatMap((q) => q.options.map((o) => o.value))
    .filter((v) => v !== "more");
  assert.deepEqual(kindValues, [...HOME_DISPATCH_KIND_ORDER]);
  const afterWork = build({ request: { entry: "command", kind: "ship" } });
  assert.deepEqual(afterWork.questions.map((q) => q.header), ["After work"]);
  assert.ok(afterWork.fallbackText.includes("none"));
  assert.ok(response.fallbackText.includes("work-here"));
});

test("F3 values: the form and fallback shapes carry the same option values", () => {
  const response = build({ cwdInRepo: false, repos: ["/w/a"] });
  const repoQuestion = response.questions.find((q) => q.header === "Repo")!;
  assert.deepEqual(repoQuestion.options.map((o) => o.value), response.forms.repo!.options.map((o) => o.value));
});

test("F3 after-work identity: a built-in keeps its slug, others are kebab-cased, empty falls back to the id", () => {
  assert.deepEqual(afterWorkLib.afterWorkFor({ id: builtin.BUG_FIX_REVIEW_WORKFLOW_ID, name: "Bug Fix Review" }), {
    id: builtin.BUG_FIX_REVIEW_WORKFLOW_ID, slug: "bug-fix-review", label: "Bug Fix Review",
  });
  assert.equal(afterWorkLib.afterWorkFor({ id: "w1", name: "Ops  Review!" }).slug, "ops-review");
  assert.equal(afterWorkLib.afterWorkFor({ id: "w2", name: "!!!" }).slug, "w2");
});

test("F3 briefText: the words unchanged, context under its own heading, never merged", () => {
  assert.equal(options.briefText({ words: "add retries" }), "add retries");
  assert.equal(options.briefText({ words: "add retries", context: "  " }), "add retries");
  assert.equal(options.briefText({ words: "add retries", context: "in client.ts" }), "add retries\n\n## Context Claude added\nin client.ts");
});

test("F3 summary text: repo, kind, after work, the words exactly, then context only when present", () => {
  const base = { repoLabel: "/r", kindLabel: "ship", afterWork: "Review", afterWorkApplies: true, words: "do it\nnow", context: "" };
  assert.equal(options.summaryText(base), "Repo: /r\nKind: ship\nAfter work: Review\n\nDescription:\ndo it\nnow");
  assert.ok(options.summaryText({ ...base, context: "ctx" }).endsWith("\n\nContext Claude added:\nctx"));
  assert.ok(options.summaryText({ ...base, afterWork: null }).includes("After work: None\n"));
  assert.ok(options.summaryText({ ...base, afterWork: null, afterWorkApplies: false }).includes("After work: None (no diff)\n"));
});

test("F3 route flag off: dispatch-options answers the 404 disabled body", async () => {
  const res = await post(app(), { cwd: repos, entry: "command" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), DISPATCH_FEATURE_DISABLED);
});

test("F3 route: inside a repository there is no repo form; outside, the workspace repositories are offered", async () => {
  const a = app();
  const repo = gitRepo("alpha");
  gitRepo("beta");
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const inside = (await (await post(a, { cwd: repo, entry: "command" })).json()) as { forms: { repo: unknown; start: { default: string } } };
  assert.equal(inside.forms.repo, null);
  assert.equal(inside.forms.start.default, "ship");
  const outside = (await (await post(a, { cwd: tmpdir(), entry: "first-message", brief: "why is it slow" })).json()) as {
    forms: { repo: { options: { value: string; label: string }[] }; start: { default: string } };
  };
  assert.deepEqual(outside.forms.repo.options.map((o) => o.label), ["alpha", "beta", "Another repository"]);
  assert.equal(outside.forms.start.default, "scout");
});

test("F3 route: guided dispatch off removes form 2 but not form 1, read per request", async () => {
  const a = app();
  const repo = gitRepo("gamma");
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const ask = async () =>
    (await (await post(a, { cwd: repo, entry: "command", kind: "ship" })).json()) as { forms: { afterWork: unknown } };
  assert.ok((await ask()).forms.afterWork);
  setUiConfig({ guidedDispatch: false });
  assert.equal((await ask()).forms.afterWork, null);
  const start = (await (await post(a, { cwd: repo, entry: "command" })).json()) as { forms: { start: unknown } };
  assert.ok(start.forms.start);
});

test("F3 route: a request without cwd or entry is a 400", async () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  assert.equal((await post(app(), { entry: "command" })).status, 400);
  assert.equal((await post(app(), { cwd: repos })).status, 400);
});
