import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceCard } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { VoiceCardView } from "../src/web/components/VoiceCardView.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

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
