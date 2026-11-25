import assert from "node:assert/strict";
import { afterEach, beforeEach, type TestContext } from "node:test";
import type { OpenCardsReport } from "../../src/shared/voice-answers.ts";
import { app, registry, reviews } from "./voice-http.ts";

export function mockCaptureClock(t: TestContext): number {
  const now = Date.now();
  const elapsed = performance.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  t.mock.method(performance, "now", () => elapsed + (Date.now() - now));
  return now;
}

const windowId = "voice-question-test";
export function question(title = "Which database?", sessionId = "sdk:Steve") {
  return reviews.create(sessionId, "input", title, title, [{ id: "q", question: title, allowOther: true,
    options: [{ id: "sqlite", label: "SQLite" }, { id: "postgres", label: "Postgres", recommended: true }] }]);
}

// Stand in for the dashboard's DOM and targeted event listener in in-process routing tests.
const drawn = new Map<string, { body: OpenCardsReport; headers: Record<string, string> }>();
const confirmations = new Map<string, number>();
beforeEach(() => {
  drawn.clear();
  confirmations.clear();
  // The previous fixture may have settled questions under a different simulated clock.
  registry.voiceRouter!.reset();
});
registry.subscribe(event => {
  if (event.type === "voice_open_question") {
    const snapshot = drawn.get(event.windowId);
    if (snapshot) void put("/api/voice/open-cards", { ...snapshot.body,
      cards: [{ kind: "question", id: event.reviewId, focused: true }] });
    return;
  }
  if (event.type !== "voice_confirm_focus") return;
  confirmations.set(event.windowId, event.sequence);
  const snapshot = drawn.get(event.windowId);
  if (snapshot && !snapshot.headers["x-voice-calibrating"]) void put("/api/voice/open-cards", snapshot.body, snapshot.headers);
});

export async function put(path: string, data: unknown, headers: Record<string, string> = {}) {
  const body = path === "/api/voice/open-cards" ? data as OpenCardsReport : undefined;
  const sequence = body && !headers["x-voice-calibrating"] && confirmations.get(body.windowId);
  const response = await app.request(path, { method: "PUT", headers: { host: "localhost", "content-type": "application/json", ...headers,
    ...(sequence && { "x-voice-confirm-focus": String(sequence) }) },
    body: JSON.stringify(data) });
  if (body && response.ok) {
    const previous = drawn.get(body.windowId)?.headers;
    const stamp = Number(headers["x-voice-focus-at-us"] ?? 0);
    const last = Number(previous?.["x-voice-focus-at-us"] ?? 0);
    if (stamp > last || (stamp === last && Number(headers["x-voice-report-revision"] ?? 0) >= Number(previous?.["x-voice-report-revision"] ?? 0))) {
      drawn.set(body.windowId, { body, headers });
    }
  }
  return response;
}

let disconnect: (() => void) | undefined;
export async function show(ids: string[], focused?: string) {
  disconnect ??= registry.voiceRouter!.openCards.connect(windowId);
  assert.equal((await put("/api/voice/open-cards", { windowId, focused: true,
    cards: ids.map(id => ({ kind: "question", id, focused: id === focused })) })).status, 200);
}

export const answers = () => registry.voiceRouter!.activeAnswers();
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  for (const q of registry.pendingReviews()) reviews.resolve(q.id, "dismiss", null);
});
