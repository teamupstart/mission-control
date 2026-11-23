// Headless mode phase 11: the dispatch flows. The command, the quick-path tool, the launcher and
// the pane arguments run against the fake host and a fake daemon whose draft routes keep state,
// so no engine and no model tokens are involved.
import assert from "node:assert/strict";
import test from "node:test";
import { LAUNCHER_ENABLED } from "../src/mod/constants.ts";
import { runDispatchCommand, runLauncher } from "../src/mod/flows/command.ts";
import { PANE_WIDER_NOTICE } from "../src/mod/flows/command.ts";
import { createFlowGate } from "../src/mod/flows/gate.ts";
import { FLOW_FAILED_TEXT, reportFlowFailure } from "../src/mod/flows/failure.ts";
import { DESCRIBE_NOTICE, EXPIRED_NOTICE } from "../src/mod/flows/dispatch.ts";
import { START_DISPATCH_DESCRIPTION, intentNudge, runStartDispatchTool } from "../src/mod/flows/tool.ts";
import type { ModAskAnswer, ModAskQuestion } from "../src/mod/host.ts";
import {
  HomeDispatchDraftCreateSchema,
  HomeDispatchDraftUpdateSchema,
  type HomeDispatchDraftSummary,
} from "../src/shared/home-dispatch.ts";
import { TASK_KIND_INFO } from "../src/shared/task.ts";
import { FAKE_NO_REPO_CWD } from "./helpers/home-dispatch-fakes-dispatch.ts";
import {
  CANNED_INBOX,
  FAKE_REPO_ROOT,
  FAKE_SESSION_ID,
  createFakeDaemon,
  createFakeModHost,
  type FakeDaemon,
  type FakeModHostOptions,
} from "./helpers/home-dispatch-fakes.ts";

const SESSION = { sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT };

interface StoredDraft {
  id: string;
  kind: keyof typeof TASK_KIND_INFO;
  workflowId?: string;
  repo?: string;
  words: string;
  context: string | null;
}

/** A daemon whose draft routes remember what they were sent, as the real ones do. */
function world(options: { host?: Omit<FakeModHostOptions, "daemon">; refuseRepo?: string[]; needsRepo?: boolean } = {}) {
  const daemon: FakeDaemon = createFakeDaemon();
  const drafts = new Map<string, StoredDraft>();
  const filed: Array<{ draftId: string; choice: string }> = [];
  let counter = 0;
  const summary = (draft: StoredDraft): HomeDispatchDraftSummary => {
    const kindLabel = TASK_KIND_INFO[draft.kind].label;
    const needsRepo = options.needsRepo === true && draft.repo === undefined;
    const needs = [...(draft.words.trim() === "" ? ["description"] : []), ...(needsRepo ? ["repo"] : [])];
    return {
      draftId: draft.id,
      repoRoot: draft.repo ?? (needsRepo ? "" : FAKE_REPO_ROOT),
      kind: draft.kind,
      kindLabel,
      afterWork: draft.workflowId ?? "None",
      afterWorkApplies: true,
      words: draft.words,
      context: draft.context,
      needs,
      brief: draft.words,
      text: `Repo: ${draft.repo ?? FAKE_REPO_ROOT}\nKind: ${kindLabel}\n\nDescription:\n${draft.words}`,
    };
  };
  daemon.override("POST /dispatch/drafts", (request) => {
    const body = HomeDispatchDraftCreateSchema.parse(request.body);
    if (body.repo !== undefined && options.refuseRepo?.includes(body.repo)) return { status: 400, body: { error: `unknown repository ${body.repo}` } };
    const draft: StoredDraft = {
      id: `draft-${++counter}`,
      kind: body.kind,
      ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
      ...(body.repo === undefined ? {} : { repo: body.repo }),
      words: body.words ?? "",
      context: body.context?.trim() || null,
    };
    drafts.set(draft.id, draft);
    return { body: summary(draft) };
  });
  daemon.override("POST /dispatch/drafts/:id", (request) => {
    const draft = drafts.get(request.params.id!);
    if (!draft) return { status: 404, body: { error: "no such draft" } };
    const body = HomeDispatchDraftUpdateSchema.parse(request.body);
    if (body.repo !== undefined && options.refuseRepo?.includes(body.repo)) return { status: 400, body: { error: `unknown repository ${body.repo}` } };
    if (body.kind !== undefined) draft.kind = body.kind;
    if (body.workflowId !== undefined) draft.workflowId = body.workflowId;
    if (body.repo !== undefined) draft.repo = body.repo;
    if (body.words !== undefined) draft.words = body.words;
    if (body.context !== undefined) draft.context = body.context.trim() || null;
    return { body: summary(draft) };
  });
  daemon.override("POST /dispatch/drafts/:id/confirm", (request) => {
    const id = request.params.id!;
    const choice = (request.body as { choice: "start" | "backlog" | "cancel" }).choice;
    if (!drafts.has(id)) return { status: 404, body: { error: "no such draft" } };
    drafts.delete(id);
    filed.push({ draftId: id, choice });
    if (choice === "cancel") return { body: { choice, taskId: null, started: false } };
    return { body: { choice, taskId: "mc-new1", started: choice === "start" } };
  });
  const answers = (question: ModAskQuestion): ModAskAnswer =>
    question.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: question.options[0]!.label };
  const fake = createFakeModHost({ daemon, answers, ...options.host });
  const bodies = () => daemon.requests.filter((r) => r.path.startsWith("/dispatch/")).map((r) => r.body);
  return { daemon, fake, drafts, filed, bodies };
}

const createdDrafts = (daemon: FakeDaemon) => daemon.requests.filter((r) => r.pattern === "/dispatch/drafts");

test("the fast path: a kind and the description start the dialogs at After work, and Start now files and starts the task", async () => {
  const { daemon, fake, filed } = world();
  await runDispatchCommand(fake.host, SESSION, "ship add retries to the webhook client");
  // No Kind page: the kind was given. After work is the first dialog, then the confirm.
  assert.deepEqual(fake.dialogs.map((d) => d.header), ["After work", "Confirm"]);
  const [draft] = createdDrafts(daemon);
  assert.equal((draft!.body as { words: string }).words, "add retries to the webhook client");
  assert.equal((draft!.body as { kind: string }).kind, "ship");
  assert.equal((draft!.body as { context?: string }).context, undefined);
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
  assert.match(fake.notices.at(-1)!, /^Started mc-new1: ship, after work .+, in repo\.$/);
  assert.equal(fake.toasts.at(-1), fake.notices.at(-1));
});

test("the confirm shows the draft's own summary and offers Start now first", async () => {
  const { fake } = world();
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  const confirm = fake.dialogs.find((d) => d.header === "Confirm")!;
  assert.deepEqual(confirm.options.map((o) => o.label), ["Start now", "Save to backlog", "Change something", "Cancel"]);
  assert.ok(fake.notices.some((n) => n.startsWith("Repo: /fake/repo\nKind: ship")));
  // There is no Codex line: Codex readiness is deferred (phased-plan 6).
  assert.ok(fake.notices.every((n) => !/codex/i.test(n)));
});

test("a brief starts at Kind with the daemon's recommendation first, and its pages are shown word for word", async () => {
  const { daemon, fake } = world();
  await runDispatchCommand(fake.host, SESSION, "fix the flaky logging test");
  const kind = fake.dialogs[0]!;
  assert.equal(kind.header, "Kind");
  assert.match(kind.options[0]!.label, /^bugfix: /);
  const options = daemon.requests.find((r) => r.pattern === "/dispatch/dispatch-options")!;
  assert.deepEqual({ entry: (options.body as { entry: string }).entry, brief: (options.body as { brief: string }).brief }, { entry: "command", brief: "fix the flaky logging test" });
});

test("More... moves to the daemon's next page, and the pick made there reaches the draft", async () => {
  const { daemon, fake } = world({
    host: {
      answers: (q) => {
        if (q.header === "Confirm") return { kind: "pick", label: "Start now" };
        if (q.header !== "Kind") return { kind: "pick", label: q.options[0]!.label };
        const more = q.options.find((o) => o.label === "More...");
        // First page: ask for the next one. Second page (no More...): take its last option.
        return { kind: "pick", label: more ? more.label : q.options.at(-1)!.label };
      },
    },
  });
  await runDispatchCommand(fake.host, SESSION, "hello there");
  const kindPages = fake.dialogs.filter((d) => d.header === "Kind");
  assert.equal(kindPages.length, 2);
  assert.equal(kindPages[0]!.options.at(-1)!.label, "More...");
  assert.ok(kindPages[1]!.options.every((o) => o.label !== "More..."));
  // The second page's option is not on the first page, and it is the kind the draft carries.
  const picked = kindPages[1]!.options.at(-1)!.label;
  assert.ok(kindPages[0]!.options.every((o) => o.label !== picked));
  const kind = picked.split(":")[0];
  assert.equal((createdDrafts(daemon)[0]!.body as { kind: string }).kind, kind);
  assert.notEqual(kind, "ship");
});

test("check the flaky logs is a brief, not the check command (L20)", async () => {
  const { fake } = world();
  await runDispatchCommand(fake.host, SESSION, "check the flaky logs");
  assert.equal(fake.paneOpens.length, 0);
  assert.equal(fake.dialogs[0]!.header, "Kind");
});

test("bare /mission-dispatch asks Start, then the description arrives in the prompt box and the next text is taken word for word", async () => {
  const { daemon, fake, filed } = world();
  const result = await runDispatchCommand(fake.host, SESSION, "");
  assert.equal(result.outcome, "waiting");
  assert.deepEqual(fake.dialogs.map((d) => d.header), ["Start", "Kind", "After work"]);
  assert.deepEqual(fake.prompts, ["/mission-dispatch "]);
  assert.equal(fake.notices.at(-1), DESCRIBE_NOTICE);
  const waiting = await fake.host.paneState.get("draftId");
  assert.ok(waiting);

  // Whatever is typed next is the description, even when its first word is a kind.
  await runDispatchCommand(fake.host, SESSION, "ship  Keep   my spacing, exactly");
  const update = daemon.requests.find((r) => r.pattern === "/dispatch/drafts/:id" && (r.body as { words?: string }).words !== undefined)!;
  assert.equal((update.body as { words: string }).words, "ship  Keep   my spacing, exactly");
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
  assert.equal(await fake.host.paneState.get("draftId"), null);
});

test("a waiting draft takes pane words and a listed task id as its description, and no pane opens", async () => {
  for (const description of ["inbox", "check", "pane", "mc-91c2", "check mc-91c2"]) {
    const { daemon, fake, filed } = world({ host: { initialState: { inbox: CANNED_INBOX as never } } });
    const waiting = await runDispatchCommand(fake.host, SESSION, "");
    assert.equal(waiting.outcome, "waiting", description);
    await runDispatchCommand(fake.host, SESSION, description);
    const update = daemon.requests.find((r) => r.pattern === "/dispatch/drafts/:id" && (r.body as { words?: string }).words !== undefined)!;
    assert.equal((update.body as { words: string }).words, description);
    assert.deepEqual(fake.paneOpens, [], description);
    assert.deepEqual(filed.map((f) => f.choice), ["start"], description);
  }
});

test("a dispatch whose session ends under an open dialog files nothing", async () => {
  let ended = false;
  const { daemon, fake, filed } = world({
    host: {
      answers: (q) => {
        if (q.header === "Confirm") {
          // The session ends while the confirm is open; the person then answers Start now.
          ended = true;
          return { kind: "pick", label: "Start now" };
        }
        return { kind: "pick", label: q.options[0]!.label };
      },
    },
  });
  const session = { ...SESSION, live: () => !ended };
  const result = await runDispatchCommand(fake.host, session, "ship add retries");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(filed, []);
  assert.ok(daemon.requests.every((r) => !r.path.endsWith("/confirm")));
  assert.ok(fake.notices.every((n) => !n.startsWith("Started")));
});

test("a session that ended before a draft is made creates none, and the tool answers cancelled", async () => {
  const { daemon, fake } = world();
  const gone = { ...SESSION, live: () => false };
  assert.equal(await runStartDispatchTool(fake.host, gone, { brief: "add retries" }), "cancelled");
  assert.equal(daemon.requests.length, 0);
});

test("a waiting draft's description keeps the spaces the person typed", async () => {
  const { daemon, fake } = world();
  await runDispatchCommand(fake.host, SESSION, "");
  await runDispatchCommand(fake.host, SESSION, "  keep my edges  ");
  const update = daemon.requests.find((r) => r.pattern === "/dispatch/drafts/:id" && (r.body as { words?: string }).words !== undefined)!;
  assert.equal((update.body as { words: string }).words, "  keep my edges  ");
});

test("a repository named cancelled under Other is a repository, not a cancellation", async () => {
  const { daemon, fake } = world({
    host: { answers: (q) => q.header === "Repo" ? { kind: "other", text: "cancelled" } : q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label } },
  });
  await runDispatchCommand(fake.host, { sessionId: FAKE_SESSION_ID, cwd: FAKE_NO_REPO_CWD }, "ship add retries");
  assert.ok(fake.dialogs.some((d) => d.header === "Repo"));
  assert.equal((createdDrafts(daemon)[0]!.body as { repo: string }).repo, "cancelled");
});

test("a request the host holds back because the session ended while it waited is never sent, and a cancel still goes", async () => {
  let ended = false;
  const { daemon, fake, filed } = world({
    host: { answers: (q) => q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label } },
  });
  const real = fake.host.fetch;
  // As the real host does: the session ends during the token read, and the guard is read as the request leaves.
  const guardedPaths: string[] = [];
  fake.host.fetch = async (path, init) => {
    if (init?.guard) guardedPaths.push(path);
    if (path.endsWith("/confirm")) ended = true;
    if (init?.guard && !init.guard()) throw new Error("the session ended before the request was sent");
    return real(path, init);
  };
  const result = await runDispatchCommand(fake.host, { ...SESSION, live: () => !ended }, "ship add retries");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(filed, []);
  assert.ok(daemon.requests.every((r) => !r.path.endsWith("/confirm")));
  // Every filing call carries the guard; a cancel carries none, so it still reaches the daemon.
  assert.deepEqual(guardedPaths.map((p) => p.replace(/\/draft-\d+/, "/:id")), ["/dispatch/dispatch-options", "/dispatch/drafts", "/dispatch/drafts/:id/confirm"]);
});

test("cancelling a draft after the session ended is still sent", async () => {
  let ended = false;
  const { daemon, fake, filed } = world({
    host: { answers: (q) => { if (q.header === "Confirm") { ended = true; return { kind: "pick", label: "Cancel" }; } return { kind: "pick", label: q.options[0]!.label }; } },
  });
  const real = fake.host.fetch;
  fake.host.fetch = async (path, init) => {
    if (init?.guard && !init.guard()) throw new Error("ended");
    return real(path, init);
  };
  await runDispatchCommand(fake.host, { ...SESSION, live: () => !ended }, "ship add retries");
  assert.deepEqual(filed.map((f) => f.choice), ["cancel"]);
  assert.ok(daemon.requests.some((r) => r.path.endsWith("/confirm")));
});

test("a description for a draft that has gone is treated as a new brief", async () => {
  const { fake, drafts } = world();
  await fake.host.paneState.set("draftId", "draft-gone");
  drafts.clear();
  await runDispatchCommand(fake.host, SESSION, "write up the logging design");
  assert.equal(fake.dialogs[0]!.header, "Kind");
});

test("when the prompt box refuses the fill, the description is asked in a dialog under Other (S12)", async () => {
  const typed = "tidy the logging module";
  const { fake, filed } = world({
    host: {
      answers: (q) => q.header === "Task" ? { kind: "other", text: typed } : q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label },
    },
  });
  fake.host.fillPrompt = () => false;
  await runDispatchCommand(fake.host, SESSION, "");
  assert.ok(fake.dialogs.some((d) => d.header === "Task"));
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
});

test("a fill that throws or rejects also falls back to the description dialog", async () => {
  for (const refuse of [() => { throw new Error("no prompt"); }, () => Promise.reject(new Error("no prompt"))]) {
    const { fake, filed } = world({
      host: { answers: (q) => q.header === "Task" ? { kind: "other", text: "tidy logging" } : q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label } },
    });
    fake.host.fillPrompt = refuse;
    await runDispatchCommand(fake.host, SESSION, "");
    assert.ok(fake.dialogs.some((d) => d.header === "Task"));
    assert.deepEqual(filed.map((f) => f.choice), ["start"]);
  }
});

test("a dismissed dialog counts as Cancel at every step, and nothing is filed", async () => {
  for (const header of ["Start", "Kind", "After work"]) {
    const { fake, filed, drafts } = world({
      host: { answers: (q) => q.header === header ? { kind: "dismissed" } : { kind: "pick", label: q.options[0]!.label } },
    });
    const result = await runDispatchCommand(fake.host, SESSION, "");
    assert.equal(result.outcome, "cancelled", header);
    assert.deepEqual(filed, [], header);
    assert.equal(drafts.size, 0, header);
    assert.equal(fake.notices.at(-1), "Cancelled. Nothing was created.", header);
  }
  // The confirm itself, dismissed once the draft exists: the draft is cancelled at the daemon.
  const { fake, filed } = world({ host: { answers: (q) => q.header === "Confirm" ? { kind: "dismissed" } : { kind: "pick", label: q.options[0]!.label } } });
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  assert.deepEqual(filed.map((f) => f.choice), ["cancel"]);
});

test("Cancel and Save to backlog on the confirm", async () => {
  const cancelled = world({ host: { answers: (q) => ({ kind: "pick", label: q.header === "Confirm" ? "Cancel" : q.options[0]!.label }) } });
  await runDispatchCommand(cancelled.fake.host, SESSION, "ship add retries");
  assert.deepEqual(cancelled.filed.map((f) => f.choice), ["cancel"]);

  const saved = world({ host: { answers: (q) => ({ kind: "pick", label: q.header === "Confirm" ? "Save to backlog" : q.options[0]!.label }) } });
  await runDispatchCommand(saved.fake.host, SESSION, "ship add retries");
  assert.deepEqual(saved.filed.map((f) => f.choice), ["backlog"]);
  assert.match(saved.fake.notices.at(-1)!, /^Saved mc-new1 to the backlog: /);
});

test("Change something returns to Kind then After work, updates the draft, and asks the confirm again", async () => {
  let confirms = 0;
  const { daemon, fake, filed } = world({
    host: {
      answers: (q) => {
        if (q.header === "Confirm") return { kind: "pick", label: ++confirms === 1 ? "Change something" : "Start now" };
        return { kind: "pick", label: q.options[0]!.label };
      },
    },
  });
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  assert.deepEqual(fake.dialogs.map((d) => d.header), ["After work", "Confirm", "Kind", "After work", "Confirm"]);
  assert.ok(fake.notices.includes("Current kind: ship."));
  const updates = daemon.requests.filter((r) => r.pattern === "/dispatch/drafts/:id").map((r) => r.body as { kind?: string; workflowId?: string });
  assert.ok(updates.some((u) => u.kind !== undefined));
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
});

test("a refused start is shown as written, with the task saved to the backlog", async () => {
  const { daemon, fake } = world();
  daemon.override("POST /dispatch/drafts/:id/confirm", () => ({ status: 409, body: { error: "launch is held", taskId: "mc-held", started: false } }));
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  assert.equal(fake.notices.at(-1), "Saved mc-held to the backlog; it did not start: launch is held");
});

test("an expired draft reads as expired", async () => {
  const { daemon, fake } = world();
  daemon.override("POST /dispatch/drafts/:id/confirm", () => ({ status: 404, body: { error: "no such draft" } }));
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  assert.equal(fake.notices.at(-1), EXPIRED_NOTICE);
});

test("no request the flows make names a runtime (Focus guard 1)", async () => {
  const { bodies, fake } = world();
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  await runStartDispatchTool(fake.host, SESSION, { brief: "add a test", context: "see client.ts" });
  for (const body of bodies()) assert.ok(!JSON.stringify(body ?? {}).includes("runtime"));
});

test("the pane arguments each open the pane once, on the right target, and nothing else happens", async () => {
  const cases: Array<[string, object]> = [
    ["inbox", { tab: "needs-you", focus: true }],
    ["check", { tab: "tasks", focus: true }],
    ["pane", { focus: true }],
    ["mc-91c2", { taskId: "mc-91c2", focus: true }],
    ["check mc-91c2", { taskId: "mc-91c2", focus: true }],
  ];
  for (const [args, target] of cases) {
    const { fake, daemon } = world({ host: { initialState: { inbox: CANNED_INBOX as never } } });
    const result = await runDispatchCommand(fake.host, SESSION, args);
    assert.equal(result.outcome, "pane", args);
    assert.deepEqual(fake.paneOpens, [target], args);
    assert.equal(fake.dialogs.length, 0, args);
    assert.equal(daemon.requests.length, 0, args);
  }
});

test("a task id the inbox does not list is a brief, and a pane that cannot be placed says so", async () => {
  const { fake } = world({ host: { initialState: { inbox: CANNED_INBOX as never } } });
  await runDispatchCommand(fake.host, SESSION, "mc-nope");
  assert.equal(fake.paneOpens.length, 0);
  assert.equal(fake.dialogs[0]!.header, "Kind");

  const unplaced = world({ host: { placed: false } });
  await runDispatchCommand(unplaced.fake.host, SESSION, "inbox");
  assert.deepEqual(unplaced.fake.notices, [PANE_WIDER_NOTICE]);
});

test("the quick path: the tool sends the person's words as words and Claude's context as context, never joined", async () => {
  const { daemon, fake, filed } = world();
  const line = await runStartDispatchTool(fake.host, SESSION, {
    brief: "add retries to the webhook client",
    context: "client.ts line 40 throws on a 502",
    intent: "now",
  });
  const [draft] = createdDrafts(daemon);
  const body = draft!.body as { words: string; context: string; intent: string };
  assert.equal(body.words, "add retries to the webhook client");
  assert.equal(body.context, "client.ts line 40 throws on a 502");
  assert.equal(body.intent, "now");
  assert.ok(!body.words.includes("502"));
  assert.deepEqual(fake.dialogs.map((d) => d.header), ["Confirm"]);
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
  // The tool answers the receipt line and nothing the person picked.
  assert.match(line, /^Started mc-new1: /);
  assert.deepEqual(fake.modelWrites, []);
});

test("the tool puts the intent's choice first, picks the kind from the words and context, and falls back to the default", async () => {
  const backlog = world();
  await runStartDispatchTool(backlog.fake.host, SESSION, { brief: "look into the failing build", intent: "backlog" });
  assert.deepEqual(backlog.fake.dialogs[0]!.options.map((o) => o.label).slice(0, 2), ["Save to backlog", "Start now"]);

  const recommended = world();
  await runStartDispatchTool(recommended.fake.host, SESSION, { brief: "this is wrong", context: "a flaky crash and a regression" });
  assert.equal((createdDrafts(recommended.daemon)[0]!.body as { kind: string }).kind, "bugfix");

  const fallback = world();
  await runStartDispatchTool(fallback.fake.host, SESSION, { brief: "hello there" });
  assert.equal((createdDrafts(fallback.daemon)[0]!.body as { kind: string }).kind, "ship");

  // A recommendation of chat counts as none.
  const chat = world();
  await runStartDispatchTool(chat.fake.host, SESSION, { brief: "brainstorm and talk through naming" });
  assert.equal((createdDrafts(chat.daemon)[0]!.body as { kind: string }).kind, "ship");
});

test("the tool answers cancelled, or the refusal text, and a missing brief asks for one", async () => {
  const cancelled = world({ host: { answers: () => ({ kind: "dismissed" }) } });
  assert.equal(await runStartDispatchTool(cancelled.fake.host, SESSION, { brief: "x" }), "cancelled");

  const refused = world();
  refused.daemon.override("POST /dispatch/drafts", () => ({ status: 409, body: { error: "Workflow is unavailable" } }));
  assert.equal(await runStartDispatchTool(refused.fake.host, SESSION, { brief: "x" }), "Workflow is unavailable");

  const none = world();
  assert.match(await runStartDispatchTool(none.fake.host, SESSION, { brief: "   " }), /needs a brief/);
  assert.equal(none.daemon.requests.length, 0);
});

test("an unknown repository is asked about under Other and retried with what the person typed", async () => {
  const { daemon, fake } = world({
    refuseRepo: ["webhooks"],
    host: {
      answers: (q) => q.header === "Repo" ? { kind: "other", text: "/fake/other" } : { kind: "pick", label: q.header === "Confirm" ? "Start now" : q.options[0]!.label },
    },
  });
  const line = await runStartDispatchTool(fake.host, SESSION, { brief: "add retries", repo: "webhooks" });
  assert.equal(fake.dialogs[0]!.header, "Repo");
  assert.match(fake.dialogs[0]!.question, /^unknown repository webhooks\./);
  assert.deepEqual(createdDrafts(daemon).map((r) => (r.body as { repo: string }).repo), ["webhooks", "/fake/other"]);
  assert.match(line, /^Started mc-new1: .+, in other\.$/);
});

test("a repository that stays unresolved is tried three times, then the refusal is shown and nothing is filed", async () => {
  let typed = 0;
  const { daemon, fake, filed } = world({
    refuseRepo: ["webhooks", "one", "two"],
    host: { answers: (q) => q.header === "Repo" ? { kind: "other", text: ["one", "two", "three"][typed++]! } : { kind: "pick", label: q.options[0]!.label } },
  });
  const line = await runStartDispatchTool(fake.host, SESSION, { brief: "add retries", repo: "webhooks" });
  assert.deepEqual(createdDrafts(daemon).map((r) => (r.body as { repo: string }).repo), ["webhooks", "one", "two"]);
  // Asked after the first and second refusals only: the third is shown, not asked about.
  assert.equal(fake.dialogs.filter((d) => d.header === "Repo").length, 2);
  assert.equal(line, "unknown repository two");
  assert.equal(fake.notices.at(-1), "unknown repository two");
  assert.deepEqual(filed, []);
  assert.ok(daemon.requests.every((r) => !r.path.endsWith("/confirm")));
  assert.equal(fake.dialogs.some((d) => d.header === "Confirm"), false);
});

test("a draft that still needs a repository asks for one, updates the draft, and confirms the updated draft", async () => {
  const { daemon, fake, filed } = world({
    needsRepo: true,
    host: { answers: (q) => q.header === "Repo" ? { kind: "other", text: "/fake/other" } : q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label } },
  });
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  assert.deepEqual(fake.dialogs.map((d) => d.header), ["After work", "Repo", "Confirm"]);
  const update = daemon.requests.find((r) => r.pattern === "/dispatch/drafts/:id")!;
  assert.deepEqual({ repo: (update.body as { repo: string }).repo }, { repo: "/fake/other" });
  // The confirm shows the updated draft, and the task is filed against it.
  assert.ok(fake.notices.some((n) => n.startsWith("Repo: /fake/other\n")));
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
  assert.match(fake.notices.at(-1)!, /^Started mc-new1: .+, in other\.$/);
});

test("a draft that needs a repository retries a refused name, three attempts in all", async () => {
  const typed = ["bad1", "bad2", "/fake/other"];
  const recovered = world({
    needsRepo: true,
    refuseRepo: ["bad1", "bad2", "bad3"],
    host: { answers: (q) => q.header === "Repo" ? { kind: "other", text: typed.shift()! } : q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label } },
  });
  await runDispatchCommand(recovered.fake.host, SESSION, "ship add retries");
  const repoAsks = recovered.fake.dialogs.filter((d) => d.header === "Repo");
  assert.equal(repoAsks.length, 3);
  assert.match(repoAsks[1]!.question, /^unknown repository bad1\./);
  assert.deepEqual(recovered.filed.map((f) => f.choice), ["start"]);

  const typedBad = ["bad1", "bad2", "bad3"];
  const refused = world({
    needsRepo: true,
    refuseRepo: ["bad1", "bad2", "bad3"],
    host: { answers: (q) => q.header === "Repo" ? { kind: "other", text: typedBad.shift()! } : { kind: "pick", label: q.options[0]!.label } },
  });
  await runDispatchCommand(refused.fake.host, SESSION, "ship add retries");
  const updates = refused.daemon.requests.filter((r) => r.pattern === "/dispatch/drafts/:id");
  assert.deepEqual(updates.map((r) => (r.body as { repo: string }).repo), ["bad1", "bad2", "bad3"]);
  assert.equal(refused.fake.notices.at(-1), "unknown repository bad3");
  assert.equal(refused.fake.dialogs.some((d) => d.header === "Confirm"), false);
  assert.deepEqual(refused.filed, []);
});

test("dismissing the repository question cancels the draft and files nothing", async () => {
  const { daemon, fake, filed } = world({
    needsRepo: true,
    host: { answers: (q) => q.header === "Repo" ? { kind: "dismissed" } : { kind: "pick", label: q.options[0]!.label } },
  });
  await runDispatchCommand(fake.host, SESSION, "ship add retries");
  assert.equal(fake.dialogs.some((d) => d.header === "Confirm"), false);
  assert.deepEqual(filed.map((f) => f.choice), ["cancel"]);
  assert.equal(daemon.requests.some((r) => r.pattern === "/dispatch/drafts/:id"), false);
  assert.equal(fake.notices.at(-1), "Cancelled. Nothing was created.");
});

test("every route the flows call is on the daemon's own list and every failure reads in the mod's words", async () => {
  const down = world();
  down.daemon.setDown(true);
  assert.equal((await runDispatchCommand(down.fake.host, SESSION, "ship x")).outcome, "refused");
  assert.match(down.fake.notices.at(-1)!, /Mission Control is not running/);

  const off = world();
  off.daemon.setFlag(false);
  assert.equal(await runStartDispatchTool(off.fake.host, SESSION, { brief: "x" }), "Mission Control headless mode is turned off.");
});

test("the launcher follows the recorded gate: off by default, and on only when enabled and offered", async () => {
  assert.equal(LAUNCHER_ENABLED, false);
  const off = world();
  assert.equal(await runLauncher(off.fake.host, SESSION, { offerLauncher: true }), null);
  assert.equal(off.fake.dialogs.length, 0);
  assert.equal(off.daemon.requests.length, 0);

  const notOffered = world();
  assert.equal(await runLauncher(notOffered.fake.host, SESSION, { offerLauncher: false }, true), null);
  assert.equal(notOffered.fake.dialogs.length, 0);

  const on = world();
  const result = await runLauncher(on.fake.host, SESSION, { offerLauncher: true }, true);
  assert.equal(result?.outcome, "waiting");
  assert.equal(on.fake.dialogs[0]!.header, "Start");
});

test("Check in on my tasks says so when the pane cannot be placed, and stays quiet when it can", async () => {
  const answers = (q: ModAskQuestion): ModAskAnswer => ({ kind: "pick", label: q.options.find((o) => o.label === "Check in on my tasks")?.label ?? q.options[0]!.label });
  const narrow = world({ host: { answers, placed: false } });
  await runDispatchCommand(narrow.fake.host, SESSION, "");
  assert.deepEqual(narrow.fake.notices, [PANE_WIDER_NOTICE]);
  const wide = world({ host: { answers, placed: true } });
  await runDispatchCommand(wide.fake.host, SESSION, "");
  assert.deepEqual(wide.fake.notices, []);
});

test("Check in on my tasks, from the Start dialog, opens the pane on Needs you", async () => {
  const { fake } = world({ host: { answers: (q) => ({ kind: "pick", label: q.options.find((o) => o.label === "Check in on my tasks")?.label ?? q.options[0]!.label }) } });
  const result = await runDispatchCommand(fake.host, SESSION, "");
  assert.equal(result.outcome, "pane");
  assert.deepEqual(fake.paneOpens, [{ tab: "needs-you", focus: true }]);
});

test("the intent nudge is the spec's one line, and the tool description keeps its promises", () => {
  assert.equal(intentNudge("now"), "The person asked to run this now in Mission Control. Call start_dispatch with intent now. Then return to what you were doing.");
  assert.equal(intentNudge("backlog"), "The person asked to save this to the backlog in Mission Control. Call start_dispatch with intent backlog. Then return to what you were doing.");
  for (const promise of ["unchanged as `brief`", "as `context`", "Never put secrets in `context`", "never change the session's files, branch or working folder"]) {
    assert.ok(START_DISPATCH_DESCRIPTION.includes(promise), promise);
  }
});

test("an exception from a flow is logged with its message and stack before the person sees the friendly line", () => {
  const fake = createFakeModHost();
  const logged: string[] = [];
  reportFlowFailure(fake.host, (text) => logged.push(text), new TypeError("boom in the flow"));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /dispatch flow threw: .*boom in the flow/);
  assert.deepEqual(fake.notices, [FLOW_FAILED_TEXT]);
  // A thrown non-error is still recorded.
  reportFlowFailure(fake.host, (text) => logged.push(text), "plain string");
  assert.match(logged[1]!, /plain string/);
});

test("a pane command carries its session's guard to the host, and opens nothing once the session has ended", async () => {
  const live = () => true;
  const { fake } = world();
  await runDispatchCommand(fake.host, { ...SESSION, live }, "inbox");
  assert.equal(fake.paneOpens.length, 1);
  assert.equal(fake.paneOpens[0]!.guard, live);

  const ended = world();
  const result = await runDispatchCommand(ended.fake.host, { ...SESSION, live: () => false }, "inbox");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(ended.fake.paneOpens, []);

  // The Start dialog's check-in path is guarded the same way.
  const checkin = world({ host: { answers: (q) => ({ kind: "pick", label: q.options.find((o) => o.label === "Check in on my tasks")?.label ?? q.options[0]!.label }) } });
  await runDispatchCommand(checkin.fake.host, { ...SESSION, live }, "");
  assert.equal(checkin.fake.paneOpens[0]!.guard, live);
});

test("the flow gate runs one flow at a time and frees itself when a flow ends or throws", async () => {
  const gate = createFlowGate();
  let release!: () => void;
  const first = gate.run(() => new Promise<string>((resolve) => { release = () => resolve("one"); }));
  assert.deepEqual(await gate.run(async () => "two"), { busy: true });
  release();
  assert.deepEqual(await first, { busy: false, value: "one" });
  assert.deepEqual(await gate.run(async () => "three"), { busy: false, value: "three" });
  await assert.rejects(gate.run(async () => { throw new Error("x"); }));
  assert.deepEqual(await gate.run(async () => "four"), { busy: false, value: "four" });
});

test("a pane open that finishes after the session ended gets no wider-window line", async () => {
  let ended = false;
  const { fake } = world();
  fake.host.paneOpen = async () => { ended = true; return { isPlaced: false }; };
  const result = await runDispatchCommand(fake.host, { ...SESSION, live: () => !ended }, "inbox");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(fake.notices, []);
  // A live session whose pane really cannot be placed still gets the line.
  const placed = world({ host: { placed: false } });
  await runDispatchCommand(placed.fake.host, { ...SESSION, live: () => true }, "inbox");
  assert.deepEqual(placed.fake.notices, [PANE_WIDER_NOTICE]);
});

test("a description request whose fill outlasts the session leaves no waiting draft behind", async () => {
  let ended = false;
  const { fake } = world();
  fake.host.fillPrompt = async () => { ended = true; };
  const result = await runDispatchCommand(fake.host, { ...SESSION, live: () => !ended }, "");
  assert.equal(result.outcome, "cancelled");
  assert.equal(await fake.host.paneState.get("draftId"), undefined);
});

test("a description update that outlasts the session does not clear a replacement's waiting draft", async () => {
  let ended = false;
  const { daemon, fake } = world();
  await runDispatchCommand(fake.host, SESSION, "");
  await fake.host.paneState.set("draftId", "draft-1");
  const real = fake.host.fetch;
  fake.host.fetch = async (path, init) => {
    // The session ends while the update is in flight, and a replacement has its own draft waiting.
    if (path.includes("/dispatch/drafts/")) { ended = true; await fake.host.paneState.set("draftId", "replacement-draft"); }
    return real(path, init);
  };
  await runDispatchCommand(fake.host, { ...SESSION, live: () => !ended }, "describe the old one");
  assert.equal(await fake.host.paneState.get("draftId"), "replacement-draft");
  assert.ok(daemon.requests.length > 0);
});

test("a blank command while a draft waits reminds first and drops the draft on the second blank, never silently", async () => {
  const { daemon, fake, filed } = world();
  const session = { ...SESSION, reminded: new Set<string>() };
  const waiting = await runDispatchCommand(fake.host, session, "");
  assert.equal(waiting.outcome, "waiting");
  const draftId = (await fake.host.paneState.get("draftId"))!;
  assert.ok(draftId);
  const dialogsBefore = fake.dialogs.length;
  const draftsBefore = createdDrafts(daemon).length;

  // First blank: the same draft is still waiting, the prompt is filled again, and nothing starts over.
  const again = await runDispatchCommand(fake.host, session, "");
  assert.equal(again.outcome, "waiting");
  assert.equal(await fake.host.paneState.get("draftId"), draftId);
  assert.equal(fake.dialogs.length, dialogsBefore);
  assert.equal(createdDrafts(daemon).length, draftsBefore);
  assert.match(fake.notices.at(-1)!, /Press Enter again with nothing typed to drop this draft/);
  assert.equal(fake.prompts.at(-1), "/mission-dispatch ");

  // The description then still reaches that draft.
  await runDispatchCommand(fake.host, session, "the real description");
  assert.deepEqual(filed.map((f) => f.choice), ["start"]);
  assert.equal(filed[0]!.draftId, draftId);
});

test("a second blank command drops the waiting draft at the daemon, says so, and starts over", async () => {
  const { fake, filed } = world();
  const session = { ...SESSION, reminded: new Set<string>() };
  await runDispatchCommand(fake.host, session, "");
  const draftId = (await fake.host.paneState.get("draftId"))!;
  await runDispatchCommand(fake.host, session, "");
  await runDispatchCommand(fake.host, session, "");
  assert.ok(fake.notices.includes("Dropped the draft that was waiting for its description."));
  assert.deepEqual(filed.filter((f) => f.draftId === draftId).map((f) => f.choice), ["cancel"]);
  // A new draft is waiting now, not the dropped one.
  assert.notEqual(await fake.host.paneState.get("draftId"), draftId);
});

test("a draft answer that arrives after the session ended fills no prompt and opens no dialog", async () => {
  // The description path: no prompt fill, no waiting draft left behind.
  let ended = false;
  const describing = world();
  const realDescribing = describing.fake.host.fetch;
  describing.fake.host.fetch = async (path, init) => {
    const reply = await realDescribing(path, init);
    if (path === "/dispatch/drafts") ended = true;
    return reply;
  };
  const first = await runDispatchCommand(describing.fake.host, { ...SESSION, live: () => !ended }, "");
  assert.equal(first.outcome, "cancelled");
  assert.deepEqual(describing.fake.prompts, []);
  assert.equal(await describing.fake.host.paneState.get("draftId"), undefined);

  // The confirm path: no summary shown, no Confirm dialog.
  let ended2 = false;
  const confirming = world();
  const realConfirming = confirming.fake.host.fetch;
  confirming.fake.host.fetch = async (path, init) => {
    const reply = await realConfirming(path, init);
    if (path === "/dispatch/drafts") ended2 = true;
    return reply;
  };
  const second = await runDispatchCommand(confirming.fake.host, { ...SESSION, live: () => !ended2 }, "ship add retries");
  assert.equal(second.outcome, "cancelled");
  assert.equal(confirming.fake.dialogs.some((d) => d.header === "Confirm"), false);
  assert.ok(confirming.fake.notices.every((n) => !n.startsWith("Repo:")));
  assert.deepEqual(confirming.filed, []);
});

test("a blank command whose waiting-draft read or fill outlasts the session fills no prompt and says nothing", async () => {
  // The read of the waiting draft outlasts the session.
  let ended = false;
  const reading = world();
  await runDispatchCommand(reading.fake.host, SESSION, "");
  const promptsBefore = reading.fake.prompts.length;
  const noticesBefore = reading.fake.notices.length;
  const realGet = reading.fake.host.paneState.get;
  reading.fake.host.paneState.get = (async (key: "draftId") => {
    const value = await realGet(key);
    ended = true;
    return value;
  }) as typeof realGet;
  const result = await runDispatchCommand(reading.fake.host, { ...SESSION, live: () => !ended }, "");
  assert.equal(result.outcome, "cancelled");
  assert.equal(reading.fake.prompts.length, promptsBefore);
  assert.equal(reading.fake.notices.length, noticesBefore);

  // The fill itself outlasts the session: no reminder is shown for a session that is gone.
  let ended2 = false;
  const filling = world();
  await runDispatchCommand(filling.fake.host, SESSION, "");
  const noticesBefore2 = filling.fake.notices.length;
  filling.fake.host.fillPrompt = async () => { ended2 = true; };
  const second = await runDispatchCommand(filling.fake.host, { ...SESSION, live: () => !ended2 }, "");
  assert.equal(second.outcome, "cancelled");
  assert.equal(filling.fake.notices.length, noticesBefore2);
});

test("the fill carries its session's guard to the host", async () => {
  const live = () => true;
  const { fake } = world();
  const seen: Array<(() => boolean) | undefined> = [];
  const real = fake.host.fillPrompt;
  fake.host.fillPrompt = (text, guard) => { seen.push(guard); return real(text, guard); };
  await runDispatchCommand(fake.host, { ...SESSION, live }, "");
  await runDispatchCommand(fake.host, { ...SESSION, live }, "");
  assert.deepEqual(seen, [live, live]);
});

test("reminders are kept per session, so a new session starts with none", async () => {
  const { fake } = world();
  const first = { ...SESSION, reminded: new Set<string>() };
  await runDispatchCommand(fake.host, first, "");
  await runDispatchCommand(fake.host, first, "");
  assert.equal(first.reminded.size, 1);
  // A different session object (a new session) has its own, empty set: its first blank only reminds.
  const second = { ...SESSION, reminded: new Set<string>() };
  await runDispatchCommand(fake.host, second, "");
  assert.equal(second.reminded.size, 1);
  assert.ok(!fake.notices.includes("Dropped the draft that was waiting for its description."));
});

test("a session that ended under a description request or a check-in open ends quietly", async () => {
  // The prompt fill outlasts the session.
  let ended = false;
  const filling = world();
  filling.fake.host.fillPrompt = async () => { ended = true; };
  await runDispatchCommand(filling.fake.host, { ...SESSION, live: () => !ended }, "");
  assert.ok(filling.fake.notices.every((n) => n !== "Cancelled. Nothing was created."));

  // The session has ended before the description request starts.
  const before = world();
  let endedBefore = false;
  const realFetch = before.fake.host.fetch;
  before.fake.host.fetch = async (path, init) => {
    const reply = await realFetch(path, init);
    if (path === "/dispatch/drafts") endedBefore = true;
    return reply;
  };
  await runDispatchCommand(before.fake.host, { ...SESSION, live: () => !endedBefore }, "");
  assert.ok(before.fake.notices.every((n) => n !== "Cancelled. Nothing was created."));

  // The session ends while the Start dialog's Check in answer is on its way to the pane.
  let endedCheckIn = false;
  const checkIn = world({
    host: { answers: (q) => { endedCheckIn = true; return { kind: "pick", label: q.options.find((o) => o.label === "Check in on my tasks")?.label ?? q.options[0]!.label }; } },
  });
  await runDispatchCommand(checkIn.fake.host, { ...SESSION, live: () => !endedCheckIn }, "");
  assert.deepEqual(checkIn.fake.paneOpens, []);
  assert.ok(checkIn.fake.notices.every((n) => n !== "Cancelled. Nothing was created."));

  // A dismissed dialog, with the person still there, still says so.
  const dismissed = world({ host: { answers: () => ({ kind: "dismissed" }) } });
  await runDispatchCommand(dismissed.fake.host, SESSION, "");
  assert.equal(dismissed.fake.notices.at(-1), "Cancelled. Nothing was created.");
});

test("a session that ended during the waiting-draft write or a dismissed dialog says nothing, and the draft is still cancelled", async () => {
  // The draftId write outlasts the session.
  let ended = false;
  const writing = world();
  const realSet = writing.fake.host.paneState.set;
  writing.fake.host.paneState.set = (async (key: "draftId", value: string | null) => {
    await realSet(key, value);
    ended = true;
  }) as typeof realSet;
  const result = await runDispatchCommand(writing.fake.host, { ...SESSION, live: () => !ended }, "");
  assert.equal(result.outcome, "cancelled");
  assert.ok(writing.fake.notices.every((n) => n !== DESCRIBE_NOTICE));

  // A confirm dismissed after the session ended: the draft is cancelled at the daemon, quietly.
  let endedConfirm = false;
  const confirming = world({
    host: { answers: (q) => { if (q.header === "Confirm") { endedConfirm = true; return { kind: "dismissed" }; } return { kind: "pick", label: q.options[0]!.label }; } },
  });
  const dismissed = await runDispatchCommand(confirming.fake.host, { ...SESSION, live: () => !endedConfirm }, "ship add retries");
  assert.equal(dismissed.outcome, "cancelled");
  assert.deepEqual(confirming.filed.map((f) => f.choice), ["cancel"]);
  assert.ok(confirming.fake.notices.every((n) => n !== "Cancelled. Nothing was created."));

  // The same dismissal with the person still there still says so.
  const present = world({ host: { answers: (q) => q.header === "Confirm" ? { kind: "dismissed" } : { kind: "pick", label: q.options[0]!.label } } });
  await runDispatchCommand(present.fake.host, SESSION, "ship add retries");
  assert.equal(present.fake.notices.at(-1), "Cancelled. Nothing was created.");
});

test("a confirm the daemon answered is reported as it happened, even when the session ended mid-request", async () => {
  for (const choice of ["Start now", "Save to backlog"]) {
    let ended = false;
    const { fake, filed } = world({
      host: { answers: (q) => q.header === "Confirm" ? { kind: "pick", label: choice } : { kind: "pick", label: q.options[0]!.label } },
    });
    const real = fake.host.fetch;
    fake.host.fetch = async (path, init) => {
      const reply = await real(path, init);
      // The session ends while the confirm is in flight; the daemon has already acted.
      if (path.endsWith("/confirm")) ended = true;
      return reply;
    };
    const result = await runDispatchCommand(fake.host, { ...SESSION, live: () => !ended }, "ship add retries");
    assert.deepEqual(filed.map((f) => f.choice), [choice === "Start now" ? "start" : "backlog"]);
    assert.equal(result.outcome, choice === "Start now" ? "started" : "backlog", choice);
    assert.equal(result.taskId, "mc-new1", choice);
    assert.match(result.line, /mc-new1/, choice);
  }
  // The tool gives the model the real receipt, not "cancelled".
  let ended = false;
  const tool = world();
  const realFetch = tool.fake.host.fetch;
  tool.fake.host.fetch = async (path, init) => {
    const reply = await realFetch(path, init);
    if (path.endsWith("/confirm")) ended = true;
    return reply;
  };
  const line = await runStartDispatchTool(tool.fake.host, { ...SESSION, live: () => !ended }, { brief: "add retries" });
  assert.match(line, /^Started mc-new1: /);
});

test("a description typed while the daemon is briefly down keeps the waiting draft, so typing it again reaches the same draft", async () => {
  const { daemon, fake, filed } = world();
  await runDispatchCommand(fake.host, SESSION, "");
  const draftId = (await fake.host.paneState.get("draftId"))!;
  assert.ok(draftId);

  // The daemon is down when the description arrives: the failure is shown and the draft stays waiting.
  daemon.setDown(true);
  const failed = await runDispatchCommand(fake.host, SESSION, "the real description");
  assert.equal(failed.outcome, "refused");
  assert.equal(await fake.host.paneState.get("draftId"), draftId);

  // Back up: the same text goes to the same draft (no Kind dialog starts over) and the task is filed.
  daemon.setDown(false);
  const dialogsBefore = fake.dialogs.length;
  await runDispatchCommand(fake.host, SESSION, "the real description");
  assert.equal(fake.dialogs.some((d, i) => i >= dialogsBefore && d.header === "Kind"), false);
  assert.deepEqual(filed.map((f) => [f.draftId, f.choice]), [[draftId, "start"]]);
  assert.equal(await fake.host.paneState.get("draftId"), null);
});

test("a dialog answered after the session ended opens no further dialog and posts no cancel notice", async () => {
  const headers = (fake: ReturnType<typeof world>["fake"]) => fake.dialogs.map((d) => d.header);

  // The Start answer arrives after the session ended: no Kind dialog follows.
  let endedStart = false;
  const start = world({ host: { answers: (q) => { endedStart = true; return { kind: "pick", label: q.options[0]!.label }; } } });
  const startResult = await runDispatchCommand(start.fake.host, { ...SESSION, live: () => !endedStart }, "");
  assert.deepEqual(headers(start.fake), ["Start"]);
  assert.equal(startResult.outcome, "cancelled");
  assert.deepEqual(start.fake.notices, []);

  // The After work answer arrives after the session ended: no Repo dialog follows.
  let endedAfter = false;
  const after = world({
    host: { answers: (q) => { if (q.header === "After work") endedAfter = true; return { kind: "pick", label: q.options[0]!.label }; } },
  });
  await runDispatchCommand(after.fake.host, { sessionId: FAKE_SESSION_ID, cwd: FAKE_NO_REPO_CWD, live: () => !endedAfter }, "ship add retries");
  assert.equal(headers(after.fake).includes("Repo"), false);
  assert.deepEqual(after.fake.notices, []);

  // A dialog dismissed after the session ended posts no cancellation.
  for (const header of ["Start", "Kind", "After work"]) {
    let ended = false;
    const dismissed = world({
      host: { answers: (q) => { if (q.header === header) { ended = true; return { kind: "dismissed" }; } return { kind: "pick", label: q.options[0]!.label }; } },
    });
    await runDispatchCommand(dismissed.fake.host, { ...SESSION, live: () => !ended }, "");
    assert.ok(dismissed.fake.notices.every((n) => n !== "Cancelled. Nothing was created."), header);
  }

  // With the person still there a dismissal still says so.
  const present = world({ host: { answers: () => ({ kind: "dismissed" }) } });
  await runDispatchCommand(present.fake.host, { ...SESSION, live: () => true }, "");
  assert.equal(present.fake.notices.at(-1), "Cancelled. Nothing was created.");
});

test("a draft whose id could not be saved is not reported as waiting; the description is asked in a dialog instead", async () => {
  for (const failure of ["dropped", "rejected"] as const) {
    const { daemon, fake, filed } = world({
      host: { answers: (q) => q.header === "Task" ? { kind: "other", text: "tidy the logging module" } : q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label } },
    });
    const real = fake.host.paneState.set;
    fake.host.paneState.set = (async (key: "draftId", value: string | null) => {
      if (failure === "rejected") throw new Error("the engine refused the write");
      void real; void key; void value; // the host swallowed it: nothing was stored
    }) as typeof real;
    const result = await runDispatchCommand(fake.host, SESSION, "");
    assert.ok(fake.notices.every((n) => n !== DESCRIBE_NOTICE), failure);
    assert.ok(fake.dialogs.some((d) => d.header === "Task"), failure);
    // The description reaches the draft that was made, and the task is filed.
    const update = daemon.requests.find((r) => r.pattern === "/dispatch/drafts/:id" && (r.body as { words?: string }).words !== undefined)!;
    assert.equal((update.body as { words: string }).words, "tidy the logging module", failure);
    assert.deepEqual(filed.map((f) => f.choice), ["start"], failure);
    assert.notEqual(result.outcome, "waiting", failure);
  }
});

test("local steps after an await stop once the session has ended: Change something, the waiting read-back and a dropped draft", async () => {
  // Change something chosen after the session ended: no "Current kind" notice, no Kind dialog.
  let endedConfirm = false;
  const change = world({
    host: { answers: (q) => { if (q.header === "Confirm") { endedConfirm = true; return { kind: "pick", label: "Change something" }; } return { kind: "pick", label: q.options[0]!.label }; } },
  });
  const changed = await runDispatchCommand(change.fake.host, { ...SESSION, live: () => !endedConfirm }, "ship add retries");
  assert.equal(changed.outcome, "cancelled");
  assert.ok(change.fake.notices.every((n) => !n.startsWith("Current kind")));
  assert.equal(change.fake.dialogs.filter((d) => d.header === "Kind").length, 0);

  // The session ends during the waiting-draft read-back: the draft is not reported as waiting.
  let endedRead = false;
  const reading = world();
  const realGet = reading.fake.host.paneState.get;
  reading.fake.host.paneState.get = (async (key: "draftId") => {
    const value = await realGet(key);
    endedRead = true;
    return value;
  }) as typeof realGet;
  const waiting = await runDispatchCommand(reading.fake.host, { ...SESSION, live: () => !endedRead }, "");
  assert.equal(waiting.outcome, "cancelled");
  assert.ok(reading.fake.notices.every((n) => n !== DESCRIBE_NOTICE));

  // The session ends while a dropped draft's marker is cleared: no "Dropped" notice, nothing starts over.
  let endedDrop = false;
  const dropping = world();
  const session = { ...SESSION, reminded: new Set<string>(), live: () => !endedDrop };
  await runDispatchCommand(dropping.fake.host, session, "");
  await runDispatchCommand(dropping.fake.host, session, "");
  const realSet = dropping.fake.host.paneState.set;
  dropping.fake.host.paneState.set = (async (key: "draftId", value: string | null) => {
    await realSet(key, value);
    if (value === null) endedDrop = true;
  }) as typeof realSet;
  const dialogsBefore = dropping.fake.dialogs.length;
  const dropped = await runDispatchCommand(dropping.fake.host, session, "");
  assert.equal(dropped.outcome, "cancelled");
  assert.ok(dropping.fake.notices.every((n) => n !== "Dropped the draft that was waiting for its description."));
  assert.equal(dropping.fake.dialogs.length, dialogsBefore);
});

test("only the daemon's no-such-draft answer retires a waiting draft; any other 404 keeps it and is shown", async () => {
  // A 404 that is not the daemon's own answer (a missing route): the draft stays waiting, the error is shown,
  // and the description is not turned into a new brief.
  const other = world();
  await runDispatchCommand(other.fake.host, SESSION, "");
  const draftId = (await other.fake.host.paneState.get("draftId"))!;
  other.daemon.override("POST /dispatch/drafts/:id", () => ({ status: 404, body: { error: "not found" } }));
  const dialogsBefore = other.fake.dialogs.length;
  const result = await runDispatchCommand(other.fake.host, SESSION, "the description");
  assert.equal(result.outcome, "refused");
  assert.equal(other.fake.notices.at(-1), "not found");
  assert.equal(await other.fake.host.paneState.get("draftId"), draftId);
  assert.equal(other.fake.dialogs.length, dialogsBefore);
  assert.equal(createdDrafts(other.daemon).length, 1);

  // The daemon's own "no such draft" still retires it, and the text starts a new brief.
  const gone = world();
  await runDispatchCommand(gone.fake.host, SESSION, "");
  gone.daemon.override("POST /dispatch/drafts/:id", () => ({ status: 404, body: { error: "no such draft" } }));
  await runDispatchCommand(gone.fake.host, SESSION, "write up the logging design");
  assert.equal(await gone.fake.host.paneState.get("draftId"), null);
  assert.ok(gone.fake.dialogs.some((d) => d.header === "Kind"));
});
