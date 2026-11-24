// Headless mode: the Claude-session loop (plan.md section 0.3). A person opens Claude Code in a
// repository with the mod installed and the dashboard closed; the pane shows their tasks, they
// dispatch from the conversation, get a glance-layer signal, answer or approve in Needs you, and
// the task finishes with a result the pane shows.
//
// Everything real is the mod's own code: `createModCore` (poll, toasts, band, status entry,
// banner, pane at session start), `createPaneController` and `renderPane` (the pane), and
// `runDispatchCommand` (the flow). Everything else is a fake: one stateful daemon, the fake mod
// host, and the clock. No model tokens, no engine, no real Claude Code.
import assert from "node:assert/strict";
import test from "node:test";
import { MOD_VERSION, POLL_INTERVAL_MS } from "../src/mod/constants.ts";
import { createModCore, type ModSessionFacts } from "../src/mod/core.ts";
import { runDispatchCommand } from "../src/mod/flows/command.ts";
import type { ModAskAnswer, ModAskQuestion } from "../src/mod/host.ts";
import { createPaneController } from "../src/mod/pane/controller.ts";
import type { PaneView } from "../src/mod/pane/types.ts";
import { needsYouOrder } from "../src/shared/home-dispatch-inbox.ts";
import {
  HomeDispatchDraftCreateSchema,
  HomeDispatchDraftUpdateSchema,
  type HomeDispatchDraftSummary,
  type HomeDispatchInbox,
  type HomeDispatchInboxItem,
} from "../src/shared/home-dispatch.ts";
import { TASK_KIND_INFO } from "../src/shared/task.ts";
import { FAKE_REPO_ROOT, FAKE_SESSION_ID, createFakeDaemon, createFakeModHost } from "./helpers/home-dispatch-fakes.ts";

const FACTS: ModSessionFacts = {
  sessionId: FAKE_SESSION_ID,
  cwd: FAKE_REPO_ROOT,
  modVersion: MOD_VERSION,
  source: "startup",
  entrypoint: "cli",
  interactive: true,
};
const SESSION = { sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT };
const NOW = 1_700_000_600_000;
const REV_1 = "rev0123456789abcdef";
const REV_2 = "rev9876543210fedcba";

function task(partial: Partial<HomeDispatchInboxItem> & Pick<HomeDispatchInboxItem, "taskId" | "title" | "state">): HomeDispatchInboxItem {
  return { kind: "ship", origin: "home-session", changedAt: NOW - 60_000, canMessage: true, agent: "claude", runtime: "sdk", ...partial };
}

function inboxOf(items: HomeDispatchInboxItem[]): HomeDispatchInbox {
  const counts = { waiting: 0, blocked: 0, ready: 0, running: 0, queued: 0, shelved: 0, failed: 0 };
  for (const i of items) counts[i.state] += 1;
  return { items, needsYou: needsYouOrder(items), counts, slots: { used: counts.running, ceiling: 4 }, dashboardOnly: 0 };
}

/**
 * The repository's tasks as the daemon lists them, and the routes a session uses. `tasks` is the
 * one source of truth: a dispatch adds to it, an answer settles in it, and a test scripts the
 * task the way the real worker would (raise a question, finish).
 */
function loop(options: { seed?: HomeDispatchInboxItem[]; answers?: (q: ModAskQuestion) => ModAskAnswer; placed?: boolean } = {}) {
  const tasks: HomeDispatchInboxItem[] = [...(options.seed ?? [])];
  const posts: Record<string, unknown>[] = [];
  const drafts = new Map<string, { id: string; kind: keyof typeof TASK_KIND_INFO; words: string }>();
  const filed: string[] = [];
  const daemon = createFakeDaemon({
    routes: {
      "GET /dispatch/inbox": () => ({ body: inboxOf(tasks) }),
      "POST /dispatch/answers": (request) => {
        const body = request.body as Record<string, unknown>;
        const index = tasks.findIndex((t) => t.taskId === body.taskId);
        const current = tasks[index];
        // The daemon's own stale-revision guard, behind the pane's.
        if (body.action === "approve_plan" && current?.pending?.revisionHash !== body.revisionHash) {
          return { status: 409, body: { error: "the plan changed; show the new revision before approving" } };
        }
        posts.push(body);
        if (index >= 0) tasks[index] = { ...current!, state: "running", pending: undefined };
        return { body: { reviewId: body.reviewId, taskId: body.taskId, sent: String(body.option ?? body.text ?? "approved " + body.revisionHash), at: NOW } };
      },
      "POST /dispatch/drafts": (request) => {
        const body = HomeDispatchDraftCreateSchema.parse(request.body);
        const draft = { id: "draft-" + (drafts.size + 1), kind: body.kind, words: body.words ?? "" };
        drafts.set(draft.id, draft);
        return { body: summary(draft) };
      },
      "POST /dispatch/drafts/:id": (request) => {
        const draft = drafts.get(request.params.id!);
        if (!draft) return { status: 404, body: { error: "no such draft" } };
        const body = HomeDispatchDraftUpdateSchema.parse(request.body);
        if (body.words !== undefined) draft.words = body.words;
        return { body: summary(draft) };
      },
      "POST /dispatch/drafts/:id/confirm": (request) => {
        const draft = drafts.get(request.params.id!);
        const choice = (request.body as { choice: "start" | "backlog" | "cancel" }).choice;
        if (!draft) return { status: 404, body: { error: "no such draft" } };
        drafts.delete(draft.id);
        filed.push(choice);
        if (choice === "cancel") return { body: { choice, taskId: null, started: false } };
        tasks.push(task({ taskId: "mc-new1", title: draft.words, state: "running", changedAt: NOW }));
        return { body: { choice, taskId: "mc-new1", started: choice === "start" } };
      },
    },
  });
  function summary(draft: { id: string; kind: keyof typeof TASK_KIND_INFO; words: string }): HomeDispatchDraftSummary {
    const kindLabel = TASK_KIND_INFO[draft.kind].label;
    return {
      draftId: draft.id, repoRoot: FAKE_REPO_ROOT, kind: draft.kind, kindLabel, afterWork: "None", afterWorkApplies: true,
      words: draft.words, context: null, needs: draft.words.trim() === "" ? ["description"] : [], brief: draft.words,
      text: "Repo: " + FAKE_REPO_ROOT + "\nKind: " + kindLabel + "\n\nDescription:\n" + draft.words,
    };
  }
  const answers = options.answers ?? ((q: ModAskQuestion): ModAskAnswer =>
    q.header === "Confirm" ? { kind: "pick", label: "Start now" } : { kind: "pick", label: q.options[0]!.label });
  const fake = createFakeModHost({ daemon, answers, placed: options.placed });
  const core = createModCore(fake.host, FACTS);
  let redraws = 0;
  const ctl = createPaneController({
    host: fake.host,
    sessionId: FACTS.sessionId,
    cwd: FACTS.cwd,
    getInbox: () => core.inbox(),
    refresh: () => core.tick(),
    redraw: () => void (redraws += 1),
  });
  const draw = (placement: "dock" | "inline" = "dock", columns = 160): PaneView =>
    fake.drawPane({ tab: ctl.view().tab, placement, bodyColumns: columns, ctl, now: NOW });
  /** One poll, the way the clock fires it. */
  const poll = () => fake.advance(POLL_INTERVAL_MS);
  const set = (taskId: string, patch: Partial<HomeDispatchInboxItem>) => {
    const i = tasks.findIndex((t) => t.taskId === taskId);
    tasks[i] = { ...tasks[i]!, ...patch };
  };
  return { tasks, posts, filed, daemon, fake, core, ctl, draw, poll, set, redraws: () => redraws };
}

const text = (view: PaneView): string => view.lines.join("\n");
const QUESTION = {
  reviewId: "rv-q", kind: "question" as const, question: "Keep or delete the old logger?", options: ["Keep", "Delete"], allowsText: true, dashboardOnly: false,
};
const PLAN = {
  reviewId: "rv-p", kind: "plan" as const, summary: "Add a retry budget of three attempts.", revisionHash: REV_1, allowsText: false, dashboardOnly: false,
};

test("at session start the pane opens on Needs you, with the banner, and shows Needs you and Tasks docked and inline", async () => {
  const w = loop({
    seed: [
      task({ taskId: "mc-q", title: "logging cleanup", state: "waiting", pending: QUESTION }),
      task({ taskId: "mc-r", title: "flaky test", state: "running", kind: "bugfix", elapsedMs: 245_000 }),
    ],
  });
  await w.core.start();
  assert.deepEqual(w.fake.paneOpens, [{ tab: "needs-you" }], "the pane is opened once, unasked");
  assert.equal(w.fake.banners.length, 1, "the banner is drawn above the prompt");
  assert.ok(w.fake.banners[0]!.length > 0);
  assert.equal(w.fake.toasts.length, 0, "the first poll toasts nothing: the banner and band already say what waits");
  assert.match(w.fake.bands.at(-1)!.text, /1 task needs you/);

  // Docked at 160 columns.
  const docked = w.draw("dock", 160);
  assert.equal(docked.tab, "needs-you");
  // A sole ask opens at once; Back returns to the list.
  assert.match(text(docked), /Keep or delete the old logger\?/);
  await w.fake.press("b Back");
  assert.match(text(w.draw("dock", 160)), /Needs you · 1/);
  w.ctl.selectTab("tasks");
  assert.match(text(w.draw("dock", 160)), /● flaky test +running/);

  // Inline at 100 columns: the same content, within the width.
  w.ctl.selectTab("needs-you");
  const inline = w.draw("inline", 100);
  assert.equal(inline.placement, "inline");
  assert.match(text(inline), /Keep or delete the old logger\?/);
  for (const line of inline.lines) assert.ok(line.length <= 100, "inline line over 100 columns: " + line.length);
  w.ctl.selectTab("tasks");
  assert.match(text(w.draw("inline", 100)), /● flaky test +running/);
});

test("dispatching from the conversation files a task that the pane's Tasks lists after one poll", async () => {
  const w = loop();
  await w.core.start();
  const result = await runDispatchCommand(w.fake.host, SESSION, "ship add retries to the webhook client");
  assert.notEqual(result.outcome, "cancelled");
  assert.deepEqual(w.filed, ["start"]);
  assert.deepEqual(w.tasks.map((t) => t.taskId), ["mc-new1"]);
  assert.match(w.fake.notices.at(-1)!, /^Started mc-new1: ship/);

  // The pane learns of it on the next poll, not before.
  w.ctl.selectTab("tasks");
  assert.doesNotMatch(text(w.draw()), /add retries to the webhook client/);
  await w.poll();
  w.ctl.selectTab("tasks");
  assert.match(text(w.draw()), /● add retries to the webhook client +running/);
});

test("a question raises one toast, the band, the status entry and a Needs you row, and answering it in the pane posts the answer with its receipt", async () => {
  const w = loop({ seed: [task({ taskId: "mc-r", title: "flaky test", state: "running" })] });
  await w.core.start();
  assert.equal(w.fake.bands.at(-1), undefined, "nothing needs the person yet, so no band");
  assert.equal(w.fake.statuses.at(-1), undefined);

  w.set("mc-r", { state: "waiting", pending: QUESTION });
  await w.poll();
  assert.deepEqual(w.fake.toasts, ['Mission Control: "flaky test" asks a question']);
  assert.match(w.fake.bands.at(-1)!.text, /1 task needs you/);
  assert.equal(w.fake.bands.at(-1)!.button.hotkey, "1");
  assert.match(w.fake.statuses.at(-1)!, /flaky test needs you/);
  // The same ask on the next poll is not announced again.
  await w.poll();
  assert.equal(w.fake.toasts.length, 1);

  assert.equal(w.ctl.needsYou().length, 1);
  w.draw();
  await w.fake.press("2 Delete");
  assert.deepEqual(w.posts, [{ action: "answer", sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT, taskId: "mc-r", reviewId: "rv-q", option: "Delete" }]);
  const after = w.draw();
  assert.match(text(after), /✓ Sent to "flaky test": Delete/);
  assert.equal(w.ctl.needsYou().length, 0, "the answered row left Needs you");
  assert.match(text(after), /Nothing needs you right now\./);
  await w.poll();
  assert.equal(w.fake.bands.at(-1), undefined, "the band clears once nothing needs the person");
  assert.equal(w.fake.statuses.at(-1), undefined);
});

test("approving a plan names its revision, refuses a stale one, and sends the current revision's hash", async () => {
  const w = loop({ seed: [task({ taskId: "mc-p", title: "retry budget", state: "waiting", pending: PLAN })] });
  await w.core.start();
  const drawn = w.draw();
  const approve = drawn.buttons.find((b) => b.label === "Approve rev rev01234")!;
  assert.ok(approve, "the button shows the revision");
  assert.equal(approve.autoFocus, true, "it is focused and confirmed with Enter");

  // The plan is revised after the draw and a poll has read the new revision.
  w.set("mc-p", { pending: { ...PLAN, revisionHash: REV_2 } });
  await w.poll();
  await approve.press();
  assert.equal(w.posts.length, 0, "the stale approval sent nothing");
  const refused = w.draw();
  assert.match(text(refused), /The plan changed since you read it\. Revision rev98765 is now shown/);
  assert.match(text(refused), /Nothing was sent\./);

  await w.fake.press("Approve rev rev98765");
  assert.deepEqual(w.posts, [{ action: "approve_plan", sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT, taskId: "mc-p", reviewId: "rv-p", revisionHash: REV_2 }]);
  assert.match(text(w.draw()), /✓ Sent to "retry budget"/);
});

test("a task that finishes raises a toast and its Tasks row shows ready with its result", async () => {
  const w = loop({ seed: [task({ taskId: "mc-r", title: "docs sweep", state: "running" })] });
  await w.core.start();
  w.set("mc-r", { state: "ready", pr: { number: 412, url: "https://github.com/acme/repo/pull/412", checks: "passing" } });
  await w.poll();
  assert.deepEqual(w.fake.toasts, ['Mission Control: "docs sweep" is ready']);
  w.ctl.selectTab("tasks");
  const tasks = text(w.draw());
  assert.match(tasks, /✓ docs sweep +ready/);
  assert.match(tasks, /PR #412 https:\/\/github\.com\/acme\/repo\/pull\/412 · checks passing/);
});

test("with the flag off nothing is shown: no pane, no banner, no band; and turning it off mid-session clears them", async () => {
  const off = loop({ seed: [task({ taskId: "mc-q", title: "logging cleanup", state: "waiting", pending: QUESTION })] });
  off.daemon.setFlag(false);
  await off.core.start();
  await off.poll();
  assert.deepEqual(off.fake.paneOpens, []);
  assert.deepEqual(off.fake.banners, []);
  assert.deepEqual(off.fake.bands, []);
  assert.deepEqual(off.fake.statuses, []);
  assert.deepEqual(off.fake.toasts, []);
  assert.equal(off.daemon.requests.filter((r) => r.path === "/dispatch/inbox").length, 0, "no inbox is even read while the flag is off");

  const on = loop({ seed: [task({ taskId: "mc-q", title: "logging cleanup", state: "waiting", pending: QUESTION })] });
  await on.core.start();
  assert.equal(on.fake.paneOpens.length, 1);
  assert.ok(on.fake.bands.at(-1));
  on.daemon.setFlag(false);
  await on.poll();
  assert.equal(on.fake.bands.at(-1), undefined);
  assert.equal(on.fake.statuses.at(-1), undefined);
  assert.equal(on.fake.paneCloses, 1, "the pane is taken back when the flag goes off");
});

test("dismissing a dialog or leaving the pane sends nothing", async () => {
  const w = loop({ seed: [task({ taskId: "mc-q", title: "logging cleanup", state: "waiting", pending: QUESTION })], answers: () => ({ kind: "dismissed" }) });
  await w.core.start();

  // Esc on the first dispatch dialog counts as Cancel: nothing is filed and no task is made.
  const result = await runDispatchCommand(w.fake.host, SESSION, "ship add retries");
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(w.filed.filter((c) => c !== "cancel"), []);
  assert.deepEqual(w.tasks.map((t) => t.taskId), ["mc-q"]);

  // Back out of the open ask: no request of any kind goes to the daemon and no answer is posted.
  w.draw();
  const before = w.daemon.requests.length;
  await w.fake.press("b Back");
  w.draw();
  assert.equal(w.daemon.requests.length, before);
  assert.deepEqual(w.posts, []);
  // An empty written answer sends nothing either.
  await w.draw().inputs![0]?.onSubmit("   ");
  assert.deepEqual(w.posts, []);
});
