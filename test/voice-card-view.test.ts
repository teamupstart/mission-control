import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceCard } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { VoiceCardView, type VoiceCardActions } from "../src/web/components/VoiceCardView.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import type { DashboardVoiceCard } from "../src/web/lib/voice-card-clock.ts";

const target: SpokenName = { name: "Steve", key: "resident:build", kind: "resident", sessionId: "s", taskId: "t", role: "Maintains CI", colorId: "cyan", agent: "claude", state: "running" };
const actions = {
  sessions: [], roster: [target], reviews: [], setVoiceCardRetention() {}, openQuestion() {}, relaunch: async () => ({ ok: true }), followUp: () => ({ ok: true }),
};
const operation = { busy: false, feedback: "", run: async () => {} };
const copy = {
  pending: "Send now", resolving: "Working out who this is for", unsure: "Who is this for?",
  sent: "Sent to", queued: "Queued for", held: "Held for", "not-running": "Relaunch Steve",
  cancelled: "Cancelled", failed: "Failed to send",
} satisfies Record<VoiceCard["state"], string>;
for (const state of Object.keys(copy) as VoiceCard["state"][]) {
  test("voice confirmation renders " + state, (t) => {
    const allocate = t.mock.method(crypto, "randomUUID", () => { throw new Error("Request id allocated during render"); });
    const card: VoiceCard = { id: "one", state, reason: "exact", deadline: Date.now() + 4000,
      parts: [{ target, text: "check CI" }], candidates: [{ kind: "agent", title: target.name, detail: target.role, id: target.key }], openQuestions: 3 };
    const html = renderToStaticMarkup(createElement(VoiceCardView, { card, actions, operation }));
    assert.ok(html.includes(copy[state]));
    assert.equal(allocate.mock.callCount(), 0);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /data-spoken-action/);
    if (state === "sent" || state === "queued") assert.match(html, /3 open questions/);
  });
}

test("a failed immediate stop shows its reason alongside the pending message controls", () => {
  const card: VoiceCard = { id: "mixed", state: "pending", reason: "split", deadline: Date.now() + 4000,
    parts: [{ target, text: "check CI" }, { target: { ...target, name: "Will" }, text: "stop",
      immediateStop: true, outcome: "failed", detail: "The interrupt was refused." }], candidates: [], openQuestions: 0 };
  const html = renderToStaticMarkup(createElement(VoiceCardView, { card, actions, operation }));
  assert.match(html, /stop failed/);
  assert.match(html, /The interrupt was refused\./);
  assert.match(html, /Send to Steve now/);
  assert.match(html, />Cancel</);
});

test("only the ready or speaking ask for this unsure card shows the question and Stop", () => {
  const card: VoiceCard = { id: "one", state: "unsure", reason: "", parts: [{ target, text: "check CI" }],
    candidates: ["Steve", "Will"].map(name => ({ kind: "agent", id: name, title: name, detail: "" })), openQuestions: 0, deadline: null };
  for (const state of ["ready", "speaking", "stopping"] as const) {
    for (const cardId of ["one", "other"]) {
      const html = renderToStaticMarkup(createElement(VoiceCardView, { card, operation, actions: {
        ...actions,
        speechJob: { id: "job", purpose: "ask", state, cardId },
      } }));
      const asking = cardId === card.id && state !== "stopping";
      assert.equal(html.includes("Asking aloud"), asking);
      assert.equal(html.includes(">Stop</button>"), asking);
      assert.equal(html.includes("Steve or Will?"), asking);
    }
  }
});

test("a held card names the outstanding call even when an earlier filed plan still gates the task", () => {
  const question: ReviewItem = { id: "call", sessionId: "s", kind: "input", title: "Which build?", body: "",
    status: "pending", response: null, createdAt: 1, resolvedAt: null };
  const plan: ReviewItem = { ...question, id: "plan", kind: "plan-decisions", title: "Filed rollout plan", waitMode: "message" };
  const card: VoiceCard = { id: "held", state: "held", reason: "outbox", deadline: null, candidates: [], openQuestions: 2,
    parts: [{ target, text: "check the build", outcome: "held", turnId: "voice:held" }] };
  const html = renderToStaticMarkup(createElement(VoiceCardView, { card, operation,
    actions: { ...actions, sessions: [mkSession({ id: "s" })], reviews: [plan, question] } }));
  assert.match(html, /Asked: Which build\?/);
  assert.doesNotMatch(html, /Filed rollout plan|older session|predates/);
});

test("the floating pill stacks every open countdown oldest first and drops the selector", async () => {
  const { VoiceCardHost } = await import("../src/web/components/VoiceCardHost.tsx");
  const now = performance.now();
  const pending = (id: string, name: string, text: string, opened: number): DashboardVoiceCard => ({
    id, state: "pending", reason: "exact", deadline: performance.timeOrigin + opened + 30_000, windowMs: 30_000,
    localDeadline: now + opened + 30_000, firstReceivedAt: now + opened, candidates: [], openQuestions: 0,
    parts: [{ target: { ...target, name, key: "resident:" + name }, text }],
  });
  // Insertion order differs from opening order: the stack follows when each window opened.
  const cards = new Map([
    ["later", pending("later", "Will", "run the release checklist", 3000)],
    ["split:2", pending("split:2", "Carol", "give me a report", 0)],
    ["split:1", pending("split:1", "Steve", "check the build", 0)],
    ["sent", { ...pending("sent", "Steve", "an earlier message", -9000), state: "sent" as const, deadline: null, localDeadline: undefined }],
  ]);
  const render = (surface?: "pill" | "popover") => renderToStaticMarkup(createElement(VoiceCardHost, {
    cards, fadingCards: new Set<string>(), actions, surface, sound: false, notifications: false }));
  const pill = render("pill");
  const order = [...pill.matchAll(/aria-label="To ([^:"]+):/g)].map(match => match[1]);
  assert.deepEqual(order, ["Steve", "Carol", "Will"]);
  assert.equal(pill.match(/>Cancel</g)?.length, 3);
  assert.equal(pill.match(/class="vc-ring"/g)?.length, 3);
  assert.doesNotMatch(pill, /an earlier message/, "an outcome waits until the countdowns close");
  assert.doesNotMatch(pill, /Voice message/);
  assert.equal(pill.match(/This card opened with/g)?.length, 3);
  // The popover keeps one card at a time, the newest window first, with the selector.
  const popover = render("popover");
  assert.equal(popover.match(/>Cancel</g)?.length, 1);
  assert.match(popover, /run the release checklist/);
  assert.match(popover, /Voice message/);
});

test("only a delivered receipt with per-recipient rows renders the Dismiss control", () => {
  const withDismiss: VoiceCardActions = { ...actions, dismiss() {} };
  const render = (card: VoiceCard, cardActions: VoiceCardActions = withDismiss) => renderToStaticMarkup(createElement(VoiceCardView, { card, actions: cardActions, operation }));
  const base = { reason: "exact", deadline: null, candidates: [], openQuestions: 0 } satisfies Partial<VoiceCard>;
  const will = { ...target, name: "Will", key: "resident:will" };
  const split: VoiceCard = { ...base, id: "split", state: "sent", parts: [{ target, text: "check CI", outcome: "sent" },
    { target: will, text: "stop", command: "stop", outcome: "sent" }] };
  assert.match(render(split), /aria-label="Dismiss: Sent to Steve, Stop sent to Will"/);
  assert.match(render(split), /class="vc-dismiss"/);
  for (const state of ["pending", "resolving", "unsure", "queued", "held", "not-running", "cancelled", "failed"] as const) {
    assert.doesNotMatch(render({ ...base, id: state, state, deadline: state === "pending" ? Date.now() + 4000 : null,
      parts: [{ target, text: "check CI" }] }), /vc-dismiss/, state);
  }
  // A submitted voice answer shows the daemon's sentence, not a Sent to row.
  assert.doesNotMatch(render({ ...base, id: "answer", state: "sent", reason: "voice-answer", detail: "Answer submitted.", parts: [{ target, text: "yes" }] }), /vc-dismiss/);
  // A surface without the action renders the receipt without a control.
  assert.doesNotMatch(render({ ...split, id: "plain" }, actions), /vc-dismiss/);
});
