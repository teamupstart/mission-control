import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceCard } from "../src/shared/voice-routing.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { VoiceCardView } from "../src/web/components/VoiceCardView.tsx";

const target: SpokenName = { name: "Steve", key: "resident:build", kind: "resident", sessionId: "s", taskId: "t", role: "Maintains CI", colorId: "cyan", agent: "claude", state: "running" };
const copy = {
  pending: "Send now", resolving: "Working out who this is for", unsure: "Who is this for?",
  sent: "Sent to", queued: "current turn", held: "Held for", "not-running": "Relaunch Steve",
  cancelled: "Cancelled", failed: "Failed to send",
} satisfies Record<VoiceCard["state"], string>;
for (const state of Object.keys(copy) as VoiceCard["state"][]) {
  test("voice confirmation renders " + state, (t) => {
    const allocate = t.mock.method(crypto, "randomUUID", () => { throw new Error("Request id allocated during render"); });
    const card: VoiceCard = { id: "one", state, reason: "exact", deadline: Date.now() + 4000,
      parts: [{ target, text: "check CI" }], candidates: [{ kind: "agent", title: target.name, detail: target.role, id: target.key }], openQuestions: 3 };
    const html = renderToStaticMarkup(createElement(VoiceCardView, { card, actions: {
      sessions: [], roster: [target], reviews: [], openQuestion() {}, relaunch: async () => ({ ok: true }), followUp: () => ({ ok: true }),
    } }));
    assert.ok(html.includes(copy[state]));
    assert.equal(allocate.mock.callCount(), 0);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /data-spoken-action/);
    if (state === "sent" || state === "queued") assert.match(html, /3 open questions/);
  });
}
