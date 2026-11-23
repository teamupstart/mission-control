// Headless mode phase 11: the dispatch flows. The command, the quick-path tool, the launcher and
// the pane arguments run against the fake host and a fake daemon whose draft routes keep state,
// so no engine and no model tokens are involved.
import assert from "node:assert/strict";
import test from "node:test";
import { LAUNCHER_ENABLED } from "../src/mod/constants.ts";
import { runDispatchCommand, runLauncher } from "../src/mod/flows/command.ts";
import { PANE_WIDER_NOTICE } from "../src/mod/flows/command.ts";
import { DESCRIBE_NOTICE, EXPIRED_NOTICE } from "../src/mod/flows/dispatch.ts";
import { START_DISPATCH_DESCRIPTION, intentNudge, runStartDispatchTool } from "../src/mod/flows/tool.ts";
import type { ModAskAnswer, ModAskQuestion } from "../src/mod/host.ts";
import {
  HomeDispatchDraftCreateSchema,
  HomeDispatchDraftUpdateSchema,
  type HomeDispatchDraftSummary,
} from "../src/shared/home-dispatch.ts";
import { TASK_KIND_INFO } from "../src/shared/task.ts";
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
function world(options: { host?: Omit<FakeModHostOptions, "daemon">; refuseRepo?: string[] } = {}) {
  const daemon: FakeDaemon = createFakeDaemon();
  const drafts = new Map<string, StoredDraft>();
  const filed: Array<{ draftId: string; choice: string }> = [];
  let counter = 0;
  const summary = (draft: StoredDraft): HomeDispatchDraftSummary => {
    const kindLabel = TASK_KIND_INFO[draft.kind].label;
    const needs = draft.words.trim() === "" ? ["description"] : [];
    return {
      draftId: draft.id,
      repoRoot: draft.repo ?? FAKE_REPO_ROOT,
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
