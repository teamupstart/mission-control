// P14's complete Claude-session loop, without a dashboard or model calls. The fake daemon owns
// tasks and receipts; the real core, dispatch flow and pane controller consume its wire replies.
import assert from "node:assert/strict";
import test from "node:test";
import { detectClaude } from "../src/cli/claude-cli.ts";
import { createModCore } from "../src/mod/core.ts";
import { MOD_VERSION, POLL_INTERVAL_MS } from "../src/mod/constants.ts";
import { runDispatchCommand } from "../src/mod/flows/command.ts";
import { createPaneController } from "../src/mod/pane/controller.ts";
import type { HomeDispatchInbox, HomeDispatchInboxItem } from "../src/shared/home-dispatch.ts";
import {
  CANNED_INBOX, FAKE_REPO_ROOT, FAKE_SESSION_ID, createFakeClaude, createFakeDaemon, createFakeModHost,
} from "./helpers/home-dispatch-fakes.ts";

const SESSION = { sessionId: FAKE_SESSION_ID, cwd: FAKE_REPO_ROOT };
const FACTS = { ...SESSION, modVersion: MOD_VERSION, source: "startup" as const, entrypoint: "cli", interactive: true };
function inboxOf(items: HomeDispatchInboxItem[]): HomeDispatchInbox {
  const counts = { waiting: 0, blocked: 0, ready: 0, running: 0, queued: 0, shelved: 0, failed: 0 };
  for (const item of items) counts[item.state]++;
  return { items, counts, needsYou: items.filter((i) => i.state === "waiting" || i.state === "blocked").map((i) => i.taskId), slots: { used: counts.running, ceiling: 4 }, dashboardOnly: 0 };
}

for (const [columns, placement] of [[160, "dock"], [100, "inline"]] as const) {
  test(`Claude-session loop at ${columns} columns (${placement})`, async (t) => {
    const claude = createFakeClaude();
    t.after(claude.cleanup);
    // Installation's executable seam is the same fake Claude used by the setup tests.
    const cli = await detectClaude({ ...process.env, MISSION_CLAUDE_BIN: claude.path }, process.cwd());
    assert.ok(cli);
    const state = { items: structuredClone(CANNED_INBOX.items), revision: "rev1234567890", accepted: 0 };
    const daemon = createFakeDaemon({ routes: {
      "GET /dispatch/inbox": () => ({ body: inboxOf(state.items) }),
      "POST /dispatch/drafts/:id/confirm": (request) => {
        const { choice } = request.body as { choice: string };
        if (choice !== "start") return { body: { choice, taskId: null, started: false } };
        state.items.push({ taskId: "mc-loop", title: "clean up logging", kind: "ship", state: "running", origin: "home-session", changedAt: 1_700_000_000_000, canMessage: true, agent: "claude", runtime: "sdk" });
        return { body: { choice: "start", taskId: "mc-loop", started: true } };
      },
      "POST /dispatch/answers": (request) => {
        const body = request.body as { taskId: string; reviewId: string; option?: string; action: string; revisionHash?: string };
        if (body.action === "approve_plan" && body.revisionHash !== state.revision) return { status: 409, body: { error: "Plan revision is stale" } };
        state.accepted++;
        state.items = state.items.map((item) => item.taskId === body.taskId ? { ...item, state: "running", pending: undefined } : item);
        return { body: { taskId: body.taskId, reviewId: body.reviewId, sent: body.option ?? `approved ${body.revisionHash}`, at: 1_700_000_010_000 } };
      },
    } });
    const fake = createFakeModHost({ daemon, answers: (q) => ({ kind: "pick", label: q.header === "Confirm" ? "Start now" : q.options[0]!.label }) });
    const core = createModCore(fake.host, FACTS);
    t.after(core.stop);
    await core.start();
    assert.equal(fake.paneOpens.length, 1);
    const ctl = createPaneController({ host: fake.host, ...SESSION, getInbox: core.inbox, refresh: core.tick, redraw: () => {} });
    const draw = () => fake.drawPane({ tab: ctl.view().tab, placement, bodyColumns: columns, ctl, now: 1_700_000_600_000 });
    const text = () => { const view = draw(); return [...view.lines, ...view.buttons.map((b) => b.label)].join("\n"); };
    const press = async (pattern: RegExp) => {
      const view = draw();
      const button = view.buttons.find((b) => pattern.test(b.label));
      assert.ok(button, `Missing ${pattern} in ${JSON.stringify(view.buttons.map((b) => b.label))}`);
      await fake.press(button.label);
    };
    assert.equal(draw().placement, placement);
    assert.match(text(), /Needs you/);
    assert.match(text(), /Keep or delete/);
    await press(/^t Tasks$/);
    assert.match(text(), /flaky test/);
    const dispatched = await runDispatchCommand(fake.host, SESSION, "ship clean up logging");
    assert.equal(dispatched.outcome, "started");
    assert.ok(state.items.some((i) => i.taskId === "mc-loop"));
    await fake.advance(POLL_INTERVAL_MS);
    assert.match(text(), /clean up logging/);

    // Settle the seeded question before the new task asks its own question.
    state.items = state.items.map((i) => ({ ...i, state: "running", pending: undefined }));
    await fake.advance(POLL_INTERVAL_MS);
    const ask = (kind: "question" | "plan", reviewId: string) => {
      state.items = state.items.map((i) => i.taskId === "mc-loop" ? {
        ...i, state: "waiting", pending: kind === "question"
          ? { kind, reviewId, question: "Keep the logger?", options: ["Keep", "Delete"], allowsText: true, dashboardOnly: false }
          : { kind, reviewId, summary: "Retain the logger and remove dead imports.", revisionHash: state.revision, allowsText: false, dashboardOnly: false },
      } : i);
    };
    const toasts = fake.toasts.length;
    ask("question", "rv-loop-question");
    await fake.advance(POLL_INTERVAL_MS);
    assert.equal(fake.toasts.length, toasts + 1);
    assert.match(fake.toasts.at(-1)!, /asks a question/);
    assert.match(fake.statuses.at(-1)!, /clean up logging needs you/);
    assert.equal(fake.bands.at(-1)?.button.hotkey, "1");
    await fake.advance(POLL_INTERVAL_MS);
    assert.equal(fake.toasts.length, toasts + 1);
    await core.openNeedsYou();
    ctl.selectTab("needs-you");
    ctl.select("mc-loop");
    assert.match(text(), /Keep the logger/);
    await press(/Keep$/);
    assert.equal(state.accepted, 1);
    assert.match(text(), /Sent to.*Keep/);
    assert.ok(!ctl.needsYou().some((i) => i.taskId === "mc-loop"));
    const answer = daemon.requests.find((r) => r.path === "/dispatch/answers");
    assert.ok(answer);
    assert.equal((answer.body as { option: string }).option, "Keep");
    assert.equal(fake.bands.at(-1), undefined);

    ask("plan", "rv-loop-plan");
    await fake.advance(POLL_INTERVAL_MS);
    ctl.select("mc-loop");
    assert.match(text(), /Approve rev rev12345/);
    // Rev changes at the daemon before the next poll: the displayed approval must be refused.
    state.revision = "rev9876543210";
    await press(/^Approve rev/);
    assert.equal(state.accepted, 1);
    assert.match(text(), /Plan revision is stale.*Nothing was sent/);
    ask("plan", "rv-loop-plan");
    await fake.advance(POLL_INTERVAL_MS);
    ctl.select("mc-loop");
    assert.match(text(), /Approve rev rev98765/);
    await press(/^Approve rev/);
    assert.equal(state.accepted, 2);
    assert.match(text(), /Sent to.*approved rev9876543210/);
    assert.ok(!ctl.needsYou().some((i) => i.taskId === "mc-loop"));

    state.items = state.items.map((i) => i.taskId === "mc-loop" ? { ...i, state: "ready", pr: { number: 42, url: "https://github.com/example/repo/pull/42", checks: "passing" } } : i);
    await fake.advance(POLL_INTERVAL_MS);
    assert.match(fake.toasts.at(-1)!, /clean up logging.*is ready/);
    await runDispatchCommand(fake.host, SESSION, "check mc-loop");
    assert.equal(fake.paneOpens.at(-1)?.taskId, "mc-loop");
    ctl.selectTab("tasks");
    assert.match(text(), /✓ clean up logging.*ready/);
    assert.match(text(), /PR #42.*pull\/42/);
    assert.deepEqual(claude.launches(), []);
    assert.deepEqual(fake.modelWrites, []);
  });
}

test("flag off renders no pane or band, and dismissal and closing never answer", async (t) => {
  const daemon = createFakeDaemon({ flag: false });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  t.after(core.stop);
  await core.start();
  await fake.advance(POLL_INTERVAL_MS);
  assert.deepEqual(fake.paneOpens, []);
  assert.ok(fake.bands.every((b) => b === undefined));
  assert.ok(fake.banners.every((b) => b === undefined));
  daemon.setFlag(true);
  await fake.advance(POLL_INTERVAL_MS);
  const ctl = createPaneController({ host: fake.host, ...SESSION, getInbox: core.inbox, refresh: core.tick, redraw: () => {} });
  ctl.select("mc-91c2");
  ctl.setDraft("unsent text");
  ctl.back();
  fake.host.paneClose(); // Same host boundary the engine's Esc close invokes.
  assert.ok(!daemon.requests.some((r) => r.path === "/dispatch/answers"));
  await runDispatchCommand(fake.host, SESSION, "ship clean up logging"); // ask() dismisses by default.
  assert.ok(!daemon.requests.some((r) => r.path.endsWith("/confirm") && (r.body as { choice?: string })?.choice === "start"));
  assert.ok(!daemon.requests.some((r) => r.path === "/dispatch/answers"));
});
