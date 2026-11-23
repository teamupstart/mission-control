// Headless mode phase 5: the shared dispatch registries and the dialog pages (spec 7.5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HOME_DISPATCH_KINDS,
  HOME_DISPATCH_KIND_ORDER,
  HOME_DISPATCH_OFFERED_KINDS,
  KIND_HINTS,
  UNAVAILABLE_WORKFLOW_LABEL,
  briefText,
  buildDispatchQuestions,
  draftSummaryText,
  kindAfterWork,
  pageOptions,
  recommendKind,
  type DispatchQuestionFacts,
} from "../src/shared/dispatch-options.ts";
import {
  BUG_FIX_REVIEW_WORKFLOW_ID,
  DOCUMENTATION_REVIEW_WORKFLOW_ID,
  LOCAL_PLAN_VALIDATION_WORKFLOW_ID,
  NO_MISTAKES_REVIEW_WORKFLOW_ID,
  PLAN_VALIDATION_WORKFLOW_ID,
} from "../src/shared/builtin-workflow.ts";
import { HomeDispatchOptionsResponseSchema } from "../src/shared/home-dispatch.ts";
import { TASK_KIND_INFO } from "../src/shared/task.ts";
import { TASK_KINDS } from "../src/shared/types.ts";

const builtins = [
  { id: NO_MISTAKES_REVIEW_WORKFLOW_ID, name: "No Mistakes Review" },
  { id: BUG_FIX_REVIEW_WORKFLOW_ID, name: "Bug Fix Review" },
  { id: PLAN_VALIDATION_WORKFLOW_ID, name: "Plan Validation" },
  { id: DOCUMENTATION_REVIEW_WORKFLOW_ID, name: "Documentation Review" },
  { id: LOCAL_PLAN_VALIDATION_WORKFLOW_ID, name: "Local Plan Validation" },
];
const facts = (over: Partial<DispatchQuestionFacts> = {}): DispatchQuestionFacts => ({
  entry: "command",
  inRepository: true,
  workspaceRepos: [],
  workflows: builtins,
  configured: {},
  planStorage: "repository",
  ...over,
});
const ids = (questions: ReturnType<typeof buildDispatchQuestions>) => questions.map((q) => q.id);

test("the kind order holds exactly the home kinds, so a new kind needs a place in it", () => {
  assert.deepEqual([...HOME_DISPATCH_KIND_ORDER].sort(), [...HOME_DISPATCH_KINDS].sort());
  assert.deepEqual([...HOME_DISPATCH_KIND_ORDER], ["ship", "bugfix", "plan", "scout", "document", "chat"]);
  assert.deepEqual(Object.keys(KIND_HINTS).sort(), [...HOME_DISPATCH_KINDS].sort());
  assert.ok(!HOME_DISPATCH_OFFERED_KINDS.includes("chat"));
  for (const kind of HOME_DISPATCH_KINDS) assert.ok(TASK_KINDS.includes(kind));
});

test("recommendKind counts whole-word hints and breaks ties by kind order", () => {
  assert.equal(recommendKind("the checkout is flaky and crashes: please fix this bug"), "bugfix");
  assert.equal(recommendKind("add a retry and refactor the client"), "ship");
  assert.equal(recommendKind("design and architect the new queue"), "plan");
  assert.equal(recommendKind("find out why the audit is slow"), "scout");
  assert.equal(recommendKind("update the readme and docs"), "document");
  assert.equal(recommendKind("let us brainstorm and talk through it"), "chat");
  assert.equal(recommendKind("hello there"), null);
  assert.equal(recommendKind("prefix the debugger"), null, "a hint inside a longer word does not count");
  assert.equal(recommendKind("fix it and add it"), "ship", "a tie goes to the earlier kind");
  assert.equal(recommendKind("FIX the Bug"), "bugfix", "case-insensitive");
});

test("pageOptions makes pages of at most four, and every page but the last ends with More", () => {
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
  assert.deepEqual(pageOptions([]).map((p) => p.length), [0]);
  assert.deepEqual(pageOptions(make(4)).map((p) => p.length), [4]);
  const five = pageOptions(make(5));
  assert.deepEqual(five.map((p) => p.map((o) => o.value)), [["v0", "v1", "v2", "more"], ["v3", "v4"]]);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 30]) {
    const pages = pageOptions(make(n));
    pages.forEach((page, i) => {
      assert.ok(page.length <= 4, `${n} options, page ${i}`);
      assert.equal(page.at(-1)!.value === "more", i < pages.length - 1, `${n} options, page ${i}`);
    });
    assert.deepEqual(pages.flat().filter((o) => o.value !== "more").map((o) => o.value), make(n).map((o) => o.value));
    if (n > 1) assert.ok(pages.at(-1)!.length >= 2, "the last page is never a single option");
  }
});

test("the launcher entry asks Start first; the command and conversation do not", () => {
  const launcher = buildDispatchQuestions(facts({ entry: "first-message" }));
  assert.equal(launcher[0]!.id, "start");
  assert.equal(launcher[0]!.header, "Start");
  assert.equal(launcher[0]!.question, "What do you want to do?");
  assert.deepEqual(launcher[0]!.options.map((o) => o.value), ["dispatch", "check-in", "work-here"]);
  assert.deepEqual(launcher[0]!.options.map((o) => o.label), ["Dispatch a task", "Check in on my tasks", "Work in this session"]);
  for (const entry of ["command", "conversation"] as const) {
    assert.ok(!ids(buildDispatchQuestions(facts({ entry }))).includes("start"), entry);
  }
});

test("the kind page lists every kind but chat, each titled label: blurb, with the recommendation first", () => {
  const pages = buildDispatchQuestions(facts()).filter((q) => q.id === "kind");
  assert.equal(pages.length, 2, "five kinds are two pages");
  assert.ok(pages.every((q) => q.header === "Kind" && q.question === "What kind of task?"));
  const values = pages.flatMap((q) => q.options).map((o) => o.value).filter((v) => v !== "more");
  assert.deepEqual(values, ["ship", "bugfix", "plan", "scout", "document"]);
  assert.equal(pages[0]!.options[0]!.label, `${TASK_KIND_INFO.ship.label}: ${TASK_KIND_INFO.ship.blurb}`);
  assert.equal(pages[0]!.options.at(-1)!.value, "more");
  assert.equal(pages[1]!.options.at(-1)!.value, "document");

  const flaky = buildDispatchQuestions(facts({ brief: "fix the flaky test" })).filter((q) => q.id === "kind");
  assert.deepEqual(flaky.flatMap((q) => q.options).map((o) => o.value).filter((v) => v !== "more"),
    ["bugfix", "ship", "plan", "scout", "document"]);
  const chatty = buildDispatchQuestions(facts({ brief: "let us brainstorm" })).filter((q) => q.id === "kind");
  assert.equal(chatty[0]!.options[0]!.value, "ship", "a recommended chat counts as none, so the default leads");
});

test("a given kind drops the kind page, and the pages are valid wire responses", () => {
  const questions = buildDispatchQuestions(facts({ kind: "ship" }));
  assert.ok(!ids(questions).includes("kind"));
  HomeDispatchOptionsResponseSchema.parse({ questions });
  HomeDispatchOptionsResponseSchema.parse({ questions: buildDispatchQuestions(facts({ entry: "first-message" })) });
});

test("after work puts the kind's default first, then None, then the other workflows", () => {
  const byKind = (kind: Parameters<typeof kindAfterWork>[0], over: Partial<DispatchQuestionFacts> = {}) =>
    buildDispatchQuestions(facts({ kind, ...over })).filter((q) => q.id === "after-work");

  const ship = byKind("ship");
  assert.equal(ship.length, 2, "six options are two pages");
  assert.ok(ship.every((q) => q.header === "After work" && q.question === "What runs after the work?"));
  assert.deepEqual(ship[0]!.options.map((o) => o.value), [NO_MISTAKES_REVIEW_WORKFLOW_ID, "none", BUG_FIX_REVIEW_WORKFLOW_ID, "more"]);
  assert.equal(ship[0]!.options[0]!.label, "No Mistakes Review");
  assert.equal(ship[0]!.options[0]!.description, `Default for ${TASK_KIND_INFO.ship.label}`);

  assert.equal(byKind("bugfix")[0]!.options[0]!.value, BUG_FIX_REVIEW_WORKFLOW_ID);
  assert.equal(byKind("document")[0]!.options[0]!.value, DOCUMENTATION_REVIEW_WORKFLOW_ID);
  assert.equal(byKind("plan")[0]!.options[0]!.value, PLAN_VALIDATION_WORKFLOW_ID);
  assert.equal(byKind("plan", { planStorage: "local" })[0]!.options[0]!.value, LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  assert.equal(byKind("ship", { configured: { ship: "none-picked" } })[0]!.options[0]!.label, UNAVAILABLE_WORKFLOW_LABEL,
    "a default naming an unpublished workflow is kept and labelled");
  assert.equal(byKind("ship", { configured: { ship: null } })[0]!.options[0]!.value, "none", "an explicit None row leads with None");
});

test("after work is absent for scout and chat, and when only None would be offered", () => {
  assert.ok(!ids(buildDispatchQuestions(facts({ kind: "scout" }))).includes("after-work"));
  assert.ok(!ids(buildDispatchQuestions(facts({ kind: "chat" }))).includes("after-work"));
  assert.ok(!ids(buildDispatchQuestions(facts({ kind: "ship", workflows: [], configured: { ship: null } }))).includes("after-work"));
  assert.ok(ids(buildDispatchQuestions(facts({ kind: "ship", workflows: [], configured: {} }))).includes("after-work"),
    "an unavailable default is still a choice");
});

test("the repo page appears only outside a repository with workspace repositories, ending in other", () => {
  const repos = ["/work/api", "/work/web"];
  assert.ok(!ids(buildDispatchQuestions(facts({ inRepository: true, workspaceRepos: repos }))).includes("repo"));
  assert.ok(!ids(buildDispatchQuestions(facts({ inRepository: false, workspaceRepos: [] }))).includes("repo"));
  const [repo] = buildDispatchQuestions(facts({ inRepository: false, workspaceRepos: repos })).filter((q) => q.id === "repo");
  assert.equal(repo!.header, "Repo");
  assert.equal(repo!.question, "Which repo is this for?");
  assert.deepEqual(repo!.options.map((o) => o.value), ["/work/api", "/work/web", "other"]);
  assert.equal(repo!.options[0]!.label, "api");
  assert.equal(repo!.options[0]!.description, "/work/api");
});

test("the pages come in the order start, kind, after work, repo", () => {
  const order = ids(buildDispatchQuestions(facts({ entry: "first-message", inRepository: false, workspaceRepos: ["/a/b"], kind: "ship" })));
  assert.deepEqual([...new Set(order)], ["start", "after-work", "repo"]);
  const full = ids(buildDispatchQuestions(facts({ entry: "first-message", inRepository: false, workspaceRepos: ["/a/b"] })));
  assert.deepEqual([...new Set(full)], ["start", "kind", "repo"]);
});

test("the dispatch form reads the shared after-work rule, and the rule gives each kind's default", () => {
  const form = readFileSync(new URL("../src/web/components/DispatchModal.tsx", import.meta.url), "utf8");
  assert.ok(form.includes('from "@shared/after-work.ts"'), "the dispatch form imports the shared rule");
  assert.ok(!form.includes("taskDefaultWorkflowId"), "and no longer spells the rule itself");
  assert.equal(kindAfterWork("ship", {}), NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.equal(kindAfterWork("bugfix", {}), BUG_FIX_REVIEW_WORKFLOW_ID);
  assert.equal(kindAfterWork("scout", {}), null);
  assert.equal(kindAfterWork("chat", {}), null);
  assert.equal(kindAfterWork("plan", {}, "local"), LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  assert.equal(kindAfterWork("ship", { ship: null }), null, "an operator's None row wins");
  assert.equal(kindAfterWork("ship", { ship: "w-1" }), "w-1");
});

test("briefText keeps the words unchanged and adds context under its own heading", () => {
  assert.equal(briefText({ words: "add retries" }), "add retries");
  assert.equal(briefText({ words: "add retries", context: "" }), "add retries");
  assert.equal(briefText({ words: "add retries", context: "   " }), "add retries");
  assert.equal(briefText({ words: "add retries", context: "see client.ts" }), "add retries\n\n## Context Claude added\nsee client.ts");
});

test("the draft text is the Form 3 message", () => {
  const input = { repoRoot: "/r", kindLabel: "ship", afterWork: "None", words: "add retries", context: null };
  assert.equal(draftSummaryText(input), "Repo: /r\nKind: ship\nAfter work: None\n\nDescription:\nadd retries");
  assert.equal(draftSummaryText({ ...input, context: "see client.ts" }),
    "Repo: /r\nKind: ship\nAfter work: None\n\nDescription:\nadd retries\n\nContext Claude added:\nsee client.ts");
});
