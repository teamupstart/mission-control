import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { app, registry, reviews } from "./voice-http.ts";

const windowId = "voice-question-test";
export function question(title = "Which database?", sessionId = "sdk:Steve") {
  return reviews.create(sessionId, "input", title, title, [{ id: "q", question: title, allowOther: true,
    options: [{ id: "sqlite", label: "SQLite" }, { id: "postgres", label: "Postgres", recommended: true }] }]);
}

export function put(path: string, data: unknown) {
  return app.request(path, { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify(data) });
}

export async function show(ids: string[], focused?: string) {
  registry.voiceRouter!.openCards.connect(windowId);
  assert.equal((await put("/api/voice/open-cards", { windowId, focused: true,
    cards: ids.map(id => ({ kind: "question", id, focused: id === focused })) })).status, 200);
}

export const answers = () => registry.voiceRouter!.activeAnswers();
afterEach(() => {
  for (const q of registry.pendingReviews()) reviews.resolve(q.id, "dismiss", null);
});
