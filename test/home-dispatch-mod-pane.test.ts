// Headless mode phase 12: the Mission Control pane. Needs you and Tasks run against the fake host
// and a stateful fake daemon, so no engine and no model tokens are involved. The adapter's own
// drawing is proved by `claude plugin test` (src/mod/engine-tests/register.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { postAnswer } from "../src/mod/client.ts";
import { createModCore, type ModSessionFacts } from "../src/mod/core.ts";
import { MOD_VERSION } from "../src/mod/constants.ts";
import { createPaneController } from "../src/mod/pane/controller.ts";
import { plain, wrap } from "../src/mod/pane/text.ts";
import type { PaneView } from "../src/mod/pane/types.ts";
import type { ModPanePlacement } from "../src/mod/host.ts";
import { needsYouOrder } from "../src/shared/home-dispatch-inbox.ts";
import type { HomeDispatchInbox, HomeDispatchInboxItem } from "../src/shared/home-dispatch.ts";
import { FAKE_REPO_ROOT, FAKE_SESSION_ID, createFakeDaemon, createFakeModHost } from "./helpers/home-dispatch-fakes.ts";

const FACTS: ModSessionFacts = {
  sessionId: FAKE_SESSION_ID,
  cwd: FAKE_REPO_ROOT,
  modVersion: MOD_VERSION,
  source: "startup",
  entrypoint: "cli",
  interactive: true,
};

const NOW = 1_700_000_600_000;
const REVISION = "rev0123456789abcdef";

function item(partial: Partial<HomeDispatchInboxItem> & Pick<HomeDispatchInboxItem, "taskId" | "title" | "state">): HomeDispatchInboxItem {
  return {
    kind: "ship",
    origin: "home-session",
    changedAt: NOW - 120_000,
    canMessage: true,
    agent: "claude",
    runtime: "sdk",
    ...partial,
  };
}

const QUESTION = item({
  taskId: "mc-q",
  title: "logging cleanup",
  state: "waiting",
  changedAt: NOW - 3_600_000,
  pending: { reviewId: "rv-q", kind: "question", question: "Keep or delete the old logger?", options: ["Keep", "Delete"], allowsText: true, dashboardOnly: false },
});
const PLAN = item({
  taskId: "mc-p",
  title: "retry budget",
  state: "waiting",
  changedAt: NOW - 1_800_000,
  pending: { reviewId: "rv-p", kind: "plan", summary: "Add a retry budget of three attempts to the uploader.", revisionHash: REVISION, allowsText: false, dashboardOnly: false },
});
const DIFF = item({
  taskId: "mc-d",
  title: "ship the exporter",
  state: "waiting",
  changedAt: NOW - 900_000,
  pending: { reviewId: "rv-d", kind: "diff", summary: "Two files changed in the exporter.", revisionHash: "diffhash0001", allowsText: false, dashboardOnly: false, link: "http://127.0.0.1:7317/review/rv-d" },
});
const BLOCKED = item({
  taskId: "mc-b",
  title: "migration run",
  state: "blocked",
  changedAt: NOW - 600_000,
  run: { workflowId: "w1", slug: "ship", version: 1, status: "blocked", phase: "review", step: 2, of: 4, checks: [], blockedReason: "A reviewer is signed out.", reviewers: [] },
});
const RUNNING = item({ taskId: "mc-r", title: "flaky test", state: "running", kind: "bugfix", elapsedMs: 245_000, changedAt: NOW - 245_000 });
const READY = item({
  taskId: "mc-y",
  title: "docs sweep",
  state: "ready",
  changedAt: NOW - 7_200_000,
  pr: { number: 412, url: "https://github.com/acme/repo/pull/412", checks: "passing" },
});
const READY_NO_PR = item({ taskId: "mc-n", title: "dead code audit", state: "ready", changedAt: NOW - 9_000_000 });
const QUEUED = item({ taskId: "mc-u", title: "rename config keys", state: "queued", queuePosition: 2, changedAt: NOW - 30_000, shaping: { state: "degraded", summary: "Context degraded: the brief names no repository." } });

function inboxOf(items: HomeDispatchInboxItem[]): HomeDispatchInbox {
  const counts = { waiting: 0, blocked: 0, ready: 0, running: 0, queued: 0, shelved: 0, failed: 0 };
  for (const i of items) counts[i.state] += 1;
  return { items, needsYou: needsYouOrder(items), counts, slots: { used: counts.running, ceiling: 4 }, dashboardOnly: 0 };
}

interface Rig {
  daemon: ReturnType<typeof createFakeDaemon>;
  fake: ReturnType<typeof createFakeModHost>;
  core: ReturnType<typeof createModCore>;
  ctl: ReturnType<typeof createPaneController>;
  state: { inbox: HomeDispatchInbox };
  posts: Record<string, unknown>[];
  redraws: () => number;
  draw: (placement?: ModPanePlacement, columns?: number) => PaneView;
  pressMatching: (pattern: RegExp) => Promise<void>;
  /** Replaces the answers route; default settles the item and returns a receipt. */
  answerWith: (route: Parameters<ReturnType<typeof createFakeDaemon>["override"]>[1]) => void;
}

async function rig(items: HomeDispatchInboxItem[]): Promise<Rig> {
  const state = { inbox: inboxOf(items) };
  const posts: Record<string, unknown>[] = [];
  const daemon = createFakeDaemon({
    routes: {
      "GET /dispatch/inbox": () => ({ body: state.inbox }),
      "POST /dispatch/answers": (request) => {
        const body = request.body as Record<string, unknown>;
        posts.push(body);
        // Settling removes the ask: the item goes back to running, as the daemon's inbox would show.
        state.inbox = inboxOf(state.inbox.items.map((i) => (i.taskId === body.taskId ? { ...i, state: "running" as const, pending: undefined } : i)));
        return { body: { reviewId: body.reviewId, taskId: body.taskId, sent: String(body.option ?? body.text ?? `approved ${body.revisionHash}`), at: NOW } };
      },
    },
  });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  let redrawn = 0;
  const ctl = createPaneController({
    host: fake.host,
    sessionId: FACTS.sessionId,
    cwd: FACTS.cwd,
    getInbox: () => core.inbox(),
    refresh: () => core.tick(),
    redraw: () => void (redrawn += 1),
  });
  const draw: Rig["draw"] = (placement = "dock", columns = 160) =>
    fake.drawPane({ tab: ctl.view().tab, placement, bodyColumns: columns, ctl, now: NOW });
  return {
    daemon, fake, core, ctl, state, posts,
    redraws: () => redrawn,
    draw,
    pressMatching: async (pattern) => {
      const view = fake.views.at(-1)?.view ?? draw();
      const button = view.buttons.find((b) => pattern.test(b.label));
      assert.ok(button, `no button matching ${pattern} in ${JSON.stringify(view.buttons.map((b) => b.label))}`);
      await fake.press(button.label);
    },
    answerWith: (route) => daemon.override("POST /dispatch/answers", route),
  };
}

const text = (view: PaneView): string => view.lines.join("\n");

test("Needs you then Tasks render from a seeded inbox, docked at 160 columns", async () => {
  const r = await rig([QUESTION, PLAN, BLOCKED, RUNNING, READY, READY_NO_PR, QUEUED]);
  const needs = r.draw("dock", 160);
  assert.equal(needs.tab, "needs-you");
  assert.deepEqual(needs.buttons.filter((b) => b.group === "tab").map((b) => b.label), ["n Needs you", "t Tasks"]);
  assert.match(text(needs), /Needs you · 3/);
  const rows = needs.buttons.filter((b) => b.group === "row").map((b) => b.label);
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /^1 \? logging cleanup .*asks a question · 1h$/);
  assert.match(rows[1]!, /^2 \? retry budget .*plan to approve · 30m$/);
  assert.match(rows[2]!, /^3 ! migration run .*blocked · 10m$/);
  assert.match(text(needs), /Keep or delete the old logger\?/);
  assert.match(text(needs), /Add a retry budget/);
  assert.match(text(needs), /A reviewer is signed out\./);

  await r.fake.press("t Tasks");
  assert.equal(r.ctl.view().tab, "tasks");
  assert.equal(r.fake.state.paneTab, "tasks");
  const tasks = r.draw("dock", 160);
  assert.equal(tasks.tab, "tasks");
  const t = text(tasks);
  assert.match(t, /Tasks · 4/);
  assert.ok(t.indexOf("flaky test") < t.indexOf("docs sweep") && t.indexOf("docs sweep") < t.indexOf("rename config keys"));
  assert.doesNotMatch(t, /logging cleanup|retry budget|migration run/);
  assert.match(t, /● flaky test +running · 4m/);
  assert.match(t, /✓ docs sweep +ready · 2h/);
  assert.match(t, /○ rename config keys +queued #2 · now/);
  assert.match(t, /start ✓ · work ● · review ○ · pr ○ · merge ○/);
  assert.match(t, /start ✓ · work ✓ · review ✓ · pr ✓ · merge ○/);
  assert.match(t, /PR #412 https:\/\/github\.com\/acme\/repo\/pull\/412 · checks passing/);
  assert.match(t, /Finished with no pull request\./);
  assert.match(t, /Shaping \(degraded\): Context degraded: the brief names no repository\./);
  assert.ok(tasks.buttons.every((b) => b.group === "tab"));
});

test("inline at 100 columns: the same content, wrapped and budgeted to the body", async () => {
  const long = item({
    taskId: "mc-w",
    title: "t".repeat(200),
    state: "waiting",
    pending: { reviewId: "rv-w", kind: "question", question: "word ".repeat(80), options: ["Yes"], allowsText: false, dashboardOnly: false },
  });
  const many = Array.from({ length: 9 }, (_, i) => item({ taskId: `mc-run-${i}`, title: `run ${i}`, state: "running", changedAt: NOW - i * 1000 }));
  const r = await rig([long, ...many]);
  r.draw();
  r.ctl.back();
  const needs = r.draw("inline", 100);
  assert.equal(needs.placement, "inline");
  for (const line of needs.lines) assert.ok(line.length <= 100, `line over 100 columns: ${line.length}`);
  for (const b of needs.buttons) assert.ok(b.label.length <= 100);
  assert.equal(needs.lines.filter((l) => l.startsWith("    word")).length, 1);
  assert.equal(r.draw("dock", 100).lines.filter((l) => l.startsWith("    word")).length, 2);

  await r.fake.press("t Tasks");
  const tasks = r.draw("inline", 100);
  assert.equal(tasks.lines.filter((l) => l.startsWith("● run ")).length, 6);
  assert.match(text(tasks), /\+3 more in the dashboard/);
  assert.equal(r.draw("dock", 160).lines.filter((l) => l.startsWith("● run ")).length, 9);
});

test("tab switching by key: n and t, kept in the pane state", async () => {
  const r = await rig([QUESTION, RUNNING]);
  const view = r.draw();
  assert.deepEqual(view.buttons.filter((b) => b.group === "tab").map((b) => b.hotkey), ["n", "t"]);
  await r.fake.press("t Tasks");
  assert.equal(r.draw().tab, "tasks");
  await r.fake.press("n Needs you");
  assert.equal(r.draw().tab, "needs-you");
  assert.deepEqual(r.fake.state.paneTab, "needs-you");
  // The band's `1` button writes the same state key; the controller follows it without writing back.
  r.ctl.selectTab("tasks");
  r.ctl.selectTab("needs-you", { persist: false });
  assert.equal(r.ctl.view().tab, "needs-you");
});

test("answering an option: it is posted for that ask, a receipt shows, the item leaves and Tasks updates on the next poll", async () => {
  const r = await rig([QUESTION, RUNNING]);
  const view = r.draw();
  const kinds = view.nodes!.filter((n) => n.kind !== "text").map((n) => (n.kind === "button" ? `button:${n.button.group}` : "input"));
  assert.deepEqual(kinds, ["button:tab", "button:tab", "button:nav", "button:action", "button:action", "input"]);
  const options = view.buttons.filter((b) => b.group === "action");
  assert.deepEqual(options.map((b) => b.label), ["1 Keep", "2 Delete"]);
  assert.equal(options[0]!.autoFocus, true);
  assert.equal(view.inputs?.[0]?.placeholder, "Or write an answer");

  await r.fake.press("2 Delete");
  assert.deepEqual(r.posts, [{ action: "answer", sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT, taskId: "mc-q", reviewId: "rv-q", option: "Delete" }]);
  const after = r.draw();
  assert.match(text(after), /✓ Sent to "logging cleanup": Delete/);
  assert.match(text(after), /Needs you · 0/);
  assert.match(text(after), /Nothing needs you right now\./);
  assert.equal(r.core.inbox()!.needsYou.length, 0);
  await r.fake.press("t Tasks");
  assert.match(text(r.draw()), /● logging cleanup/);
});

test("a settled answer hides the item at once, even before the daemon's list catches up", async () => {
  const r = await rig([QUESTION, PLAN]);
  // The daemon accepts the answer but its inbox is slow to change.
  r.daemon.override("GET /dispatch/inbox", () => ({ body: inboxOf([QUESTION, PLAN]) }));
  await r.core.tick();
  r.draw();
  r.ctl.select("mc-q");
  await r.ctl.answer({ taskId: "mc-q", reviewId: "rv-q" }, { option: "Keep" });
  const rows = r.draw().buttons.filter((b) => b.group === "row");
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.label, /retry budget/);
});

test("writing an answer sends the text; an empty answer sends nothing", async () => {
  const r = await rig([QUESTION]);
  const input = r.draw().inputs![0]!;
  await input.onSubmit("   ");
  assert.equal(r.posts.length, 0);
  assert.match(text(r.draw()), /! Write an answer first\./);
  input.onInput("Delete it, but keep the audit lines.");
  assert.equal(r.ctl.view().draft, "Delete it, but keep the audit lines.");
  assert.equal(r.draw().inputs![0]!.value, "Delete it, but keep the audit lines.");
  await r.draw().inputs![0]!.onSubmit("Delete it, but keep the audit lines.");
  assert.deepEqual(r.posts, [{ action: "answer", sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT, taskId: "mc-q", reviewId: "rv-q", text: "Delete it, but keep the audit lines." }]);
  assert.match(text(r.draw()), /✓ Sent to "logging cleanup": Delete it, but keep the audit lines\./);
  assert.equal(r.ctl.view().draft, "");
});

test("a refused answer keeps what was typed and says why", async () => {
  const r = await rig([QUESTION]);
  r.answerWith(() => ({ status: 400, body: { error: "this question takes an option, not text" } }));
  r.draw().inputs![0]!.onInput("free text");
  await r.draw().inputs![0]!.onSubmit("free text");
  const view = r.draw();
  assert.match(text(view), /! this question takes an option, not text Nothing was sent\./);
  assert.equal(view.inputs![0]!.value, "free text");
  assert.equal(r.ctl.needsYou().length, 1);
});

test("approving a plan with the matching revision: no hotkey, the revision on the button, the hash sent", async () => {
  const r = await rig([PLAN]);
  const view = r.draw();
  const approve = view.buttons.find((b) => b.label === "Approve rev rev01234");
  assert.ok(approve);
  // Confirmed by Enter on the focused button, never by a stray key.
  assert.equal(approve.hotkey, undefined);
  assert.equal(approve.autoFocus, true);
  assert.match(text(view), /Revision rev01234/);
  assert.match(text(view), /Add a retry budget of three attempts/);
  await r.fake.press("Approve rev rev01234");
  assert.deepEqual(r.posts, [{ action: "approve_plan", sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT, taskId: "mc-p", reviewId: "rv-p", revisionHash: REVISION }]);
  assert.match(text(r.draw()), /✓ Sent to "retry budget": approved rev0123456789abcdef/);
  assert.equal(r.ctl.needsYou().length, 0);
});

test("a stale revision is refused and shown as such: nothing is sent and the new revision is named", async () => {
  const r = await rig([PLAN]);
  const drawn = r.draw();
  const approve = drawn.buttons.find((b) => b.label.startsWith("Approve rev"))!;
  // The plan is revised between the draw and the press, and a poll has already read the new one.
  const revised = item({ ...PLAN, pending: { ...PLAN.pending!, revisionHash: "newrev9876543210" } });
  r.state.inbox = inboxOf([revised]);
  await r.core.tick();
  await approve.press();
  assert.equal(r.posts.length, 0);
  const view = r.draw();
  assert.match(text(view), /! The plan changed since you read it\. Revision newrev98 is now shown\. Review it, then approve\. Nothing was sent\./);
  assert.ok(view.buttons.some((b) => b.label === "Approve rev newrev98"));
});

test("a stale revision the daemon catches is refused too, with its own reason", async () => {
  const r = await rig([PLAN]);
  r.draw();
  r.answerWith(() => ({ status: 409, body: { error: "the plan changed; show the new revision before approving" } }));
  await r.fake.press("Approve rev rev01234");
  assert.match(text(r.draw()), /! the plan changed; show the new revision before approving Nothing was sent\./);
  assert.equal(r.ctl.needsYou().length, 1);
});

test("a question replaced while open clears what was typed and says so", async () => {
  const r = await rig([QUESTION]);
  r.draw().inputs![0]!.onInput("half an answer");
  const replaced = item({ ...QUESTION, pending: { ...QUESTION.pending!, reviewId: "rv-q2", question: "Which logger do you want?" } });
  r.state.inbox = inboxOf([replaced]);
  await r.core.tick();
  const view = r.draw();
  assert.equal(view.inputs![0]!.value, "");
  assert.match(text(view), /! This ask changed while it was open\./);
  assert.match(text(view), /Which logger do you want\?/);
  await r.fake.press("1 Keep");
  assert.equal(r.posts[0]!.reviewId, "rv-q2");
});

test("request changes opens a field, and sends the text for the plan", async () => {
  const r = await rig([PLAN]);
  assert.equal(r.draw().inputs?.length, 0);
  await r.fake.press("c Request changes");
  const view = r.draw();
  assert.deepEqual(view.nodes!.filter((n) => n.kind !== "text").slice(-3).map((n) => n.kind), ["button", "button", "input"]);
  assert.equal(view.inputs![0]!.placeholder, "What should change?");
  await view.inputs![0]!.onSubmit("  ");
  assert.equal(r.posts.length, 0);
  assert.match(text(r.draw()), /! Say what should change first\./);
  await r.draw().inputs![0]!.onSubmit("Make it five attempts.");
  assert.deepEqual(r.posts, [{ action: "request_changes", sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT, taskId: "mc-p", reviewId: "rv-p", text: "Make it five attempts." }]);
  assert.match(text(r.draw()), /✓ Sent to "retry budget": Make it five attempts\./);
});

test("review decisions are read-only with a pointer to the dashboard, and the pane never sends them", async () => {
  const r = await rig([DIFF, BLOCKED]);
  assert.equal(r.draw().buttons.filter((b) => b.group === "row").length, 2);
  r.ctl.select("mc-d");
  const view = r.draw();
  assert.match(text(view), /Two files changed in the exporter\./);
  assert.match(text(view), /Decide this in the Mission Control dashboard; it is not sent from here\./);
  assert.match(text(view), /Open: http:\/\/127\.0\.0\.1:7317\/review\/rv-d/);
  assert.deepEqual(view.buttons.map((b) => b.group), ["tab", "tab", "nav"]);
  assert.equal(view.inputs?.length, 0);
  r.ctl.back();
  r.ctl.select("mc-b");
  const blocked = r.draw();
  assert.match(text(blocked), /A reviewer is signed out\./);
  assert.match(text(blocked), /Decide this in the Mission Control dashboard/);
  assert.deepEqual(blocked.buttons.map((b) => b.group), ["tab", "tab", "nav"]);
  assert.equal(r.posts.length, 0);
});

test("Back returns to the list and sends nothing; a new sole ask opens at once", async () => {
  const r = await rig([QUESTION]);
  assert.ok(r.draw().buttons.some((b) => b.label === "b Back"));
  const before = r.daemon.requests.length;
  await r.fake.press("b Back");
  const list = r.draw();
  assert.equal(list.buttons.filter((b) => b.group === "row").length, 1);
  assert.ok(!list.buttons.some((b) => b.label === "b Back"));
  assert.equal(r.posts.length, 0);
  assert.equal(r.daemon.requests.length, before);
  assert.equal(r.draw().buttons.filter((b) => b.group === "row").length, 1);
  r.state.inbox = inboxOf([PLAN]);
  await r.core.tick();
  const reopened = r.draw();
  assert.equal(r.ctl.view().selected?.taskId, "mc-p");
  assert.ok(reopened.buttons.some((b) => b.label.startsWith("Approve rev")));
  assert.equal(r.ctl.view().draft, "");
});

test("empty inbox, and before the first poll", async () => {
  const empty = await rig([RUNNING]);
  const needs = empty.draw();
  assert.equal(empty.draw().tab, "needs-you");
  assert.match(text(needs), /Needs you · 0/);
  assert.match(text(needs), /Nothing needs you right now\./);
  await empty.fake.press("t Tasks");
  const none = await rig([QUESTION]);
  none.draw();
  await none.fake.press("t Tasks");
  assert.match(text(none.draw()), /No running, ready or queued tasks\./);

  const down = createFakeModHost();
  const ctl = createPaneController({ host: down.host, sessionId: "s", cwd: "/r", getInbox: () => null, refresh: async () => {}, redraw: () => {} });
  const view = down.drawPane({ tab: "needs-you", placement: "dock", bodyColumns: 80, ctl });
  assert.match(view.lines.join("\n"), /Waiting for Mission Control\./);
  assert.equal(down.drawPane({ tab: "tasks", placement: "dock", bodyColumns: 80, ctl }).lines.at(-1), "Waiting for Mission Control.");
});

test("worker text is plain text: escape sequences and control codes never reach the draw", async () => {
  const hostile = item({
    taskId: "mc-h",
    title: "clean\u001b]0;pwned\u0007 up\u001b[31m red\u001b[0m",
    state: "waiting",
    pending: { reviewId: "rv-h", kind: "question", question: "Run \u001b[2Jthis?\u0007\r\nNow", options: ["\u001b[1mYes"], allowsText: false, dashboardOnly: false },
  });
  const r = await rig([hostile, RUNNING]);
  const needs = r.draw();
  await r.fake.press("t Tasks");
  const tasks = r.draw();
  for (const v of [needs, tasks]) {
    const all = [...v.lines, ...v.buttons.map((b) => b.label)].join("\n");
    assert.ok(![...all].some((c) => c === "\u001b" || c === "\u0007" || c === "\r"));
  }
  assert.match(text(needs), /Run this\?\nNow/);
  assert.ok(needs.buttons.some((b) => b.label === "1 Yes"));
  assert.equal(plain("a\u001b[31mb"), "ab");
  assert.deepEqual(wrap("abcdefghijklmnopqrstuvwxyz".repeat(2), 20).map((l) => l.length), [20, 20, 12]);
});

test("the small widget form draws one summary line", async () => {
  const r = await rig([QUESTION, RUNNING]);
  const view = r.draw("widget", 24);
  assert.deepEqual(view.lines, ["1 need you · 1 running"]);
  assert.deepEqual(view.buttons, []);
});

test("an answer posted while the daemon is down says nothing was sent", async () => {
  const r = await rig([QUESTION]);
  r.draw();
  r.daemon.setDown(true);
  await r.fake.press("1 Keep");
  assert.match(text(r.draw()), /! Mission Control is not running, so nothing was sent\./);
  assert.equal(r.ctl.needsYou().length, 1);
});

test("the client tells a refused answer from the flag being off", async () => {
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  const body = { action: "answer", sessionId: "s", taskId: "t", reviewId: "r", option: "x" } as const;
  daemon.override("POST /dispatch/answers", () => ({ status: 404, body: { error: "no such review" } }));
  assert.deepEqual(await postAnswer(fake.host, body), { kind: "error", status: 404, message: "no such review" });
  daemon.override("POST /dispatch/answers", () => ({ status: 404, body: { error: "This feature is disabled.", feature: "headless-mode" } }));
  assert.deepEqual(await postAnswer(fake.host, body), { kind: "off" });
});

test("a refused token and the flag turning off each say nothing was sent, and the ask stays", async () => {
  const r = await rig([QUESTION]);
  r.draw();
  r.answerWith(() => ({ status: 401, body: { error: "bad token" } }));
  await r.fake.press("1 Keep");
  let view = r.draw();
  assert.match(text(view), /! Mission Control refused this session's token\. Run `mctl doctor`\. Nothing was sent\./);
  assert.doesNotMatch(text(view), /✓ Sent/);
  assert.equal(r.ctl.needsYou().length, 1);
  assert.ok(view.buttons.some((b) => b.label === "1 Keep"));

  r.answerWith(() => ({ status: 404, body: { error: "This feature is disabled.", feature: "headless-mode" } }));
  await r.fake.press("1 Keep");
  view = r.draw();
  assert.match(text(view), /! Mission Control's headless mode is off, so nothing was sent\./);
  assert.doesNotMatch(text(view), /✓ Sent/);
  assert.equal(r.ctl.needsYou().length, 1);
  assert.equal(r.posts.length, 0);
});

test("pressing twice while an answer is in flight sends exactly one", async () => {
  const r = await rig([QUESTION]);
  r.draw();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen: unknown[] = [];
  r.answerWith(async (request) => {
    seen.push(request.body);
    await held;
    const body = request.body as Record<string, unknown>;
    return { body: { reviewId: body.reviewId, taskId: body.taskId, sent: "Keep", at: NOW } };
  });
  const first = r.fake.press("1 Keep");
  const second = r.fake.press("1 Keep");
  await second;
  assert.equal(seen.length, 1);
  assert.equal(r.ctl.view().busy, true);
  release();
  await first;
  assert.equal(seen.length, 1);
  assert.equal(r.ctl.view().busy, false);
  assert.match(text(r.draw()), /✓ Sent to "logging cleanup": Keep/);
});

test("a plan revised under the same review clears request-changes feedback written for the old revision", async () => {
  const r = await rig([PLAN]);
  r.draw();
  await r.fake.press("c Request changes");
  r.draw().inputs![0]!.onInput("Make it five attempts.");
  r.state.inbox = inboxOf([item({ ...PLAN, pending: { ...PLAN.pending!, revisionHash: "newrev9876543210", summary: "Now with backoff." } })]);
  await r.core.tick();
  const view = r.draw();
  assert.match(text(view), /! This ask changed while it was open\./);
  assert.match(text(view), /Now with backoff\./);
  assert.equal(view.inputs?.length, 0);
  assert.equal(r.ctl.view().draft, "");
  assert.equal(r.ctl.view().changing, false);
  assert.ok(view.buttons.some((b) => b.label === "Approve rev newrev98"));
  assert.equal(r.posts.length, 0);
});

test("request changes drawn for one revision is refused when the plan was revised before Submit", async () => {
  const r = await rig([PLAN]);
  r.draw();
  await r.fake.press("c Request changes");
  const stale = r.draw().inputs![0]!;
  // A poll replaces the plan under the same review; no draw happens before the person submits.
  r.state.inbox = inboxOf([item({ ...PLAN, pending: { ...PLAN.pending!, revisionHash: "newrev9876543210" } })]);
  await r.core.tick();
  await stale.onSubmit("Make it five attempts.");
  assert.equal(r.posts.length, 0);
  const view = r.draw();
  assert.match(text(view), /! The plan changed since you read it\. Revision newrev98 is now shown\. Review it, then send changes\. Nothing was sent\./);
  assert.equal(r.ctl.view().draft, "");
  assert.equal(r.ctl.needsYou().length, 1);
});

test("a revised plan under an answered review shows again", async () => {
  const r = await rig([PLAN]);
  r.draw();
  // The daemon is slow to drop the answered plan, then offers a new revision of the same review.
  r.daemon.override("GET /dispatch/inbox", () => ({ body: inboxOf([PLAN]) }));
  await r.fake.press("Approve rev rev01234");
  assert.equal(r.ctl.needsYou().length, 0);
  r.daemon.override("GET /dispatch/inbox", () => ({ body: inboxOf([item({ ...PLAN, pending: { ...PLAN.pending!, revisionHash: "newrev9876543210" } })]) }));
  await r.core.tick();
  assert.equal(r.ctl.needsYou().length, 1);
  assert.ok(r.draw().buttons.some((b) => b.label === "Approve rev newrev98"));
});
