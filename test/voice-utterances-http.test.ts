import { VOICE_LISTENER_PROTOCOL_VERSION } from "../src/shared/voice.ts";
import type { HeardEntry } from "../src/shared/voice-routing.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, app, applyFeatureFlagIntent, capture, cards, home, interrupts, name, pending, post, queued, readHeard, registry, roster, say, sdk, token, voiceStateStore } from "./helpers/voice-http.ts";

test("token and schema gates, muted drop, and push-to-talk acceptance", async () => {
  assert.equal((await post("/voice/utterances", capture("Steve hello"))).status, 401);
  assert.equal((await post("/voice/utterances", { ...capture("Steve hello"), words: [{ text: "x", startMs: 3, endMs: 1 }] }, token)).status, 400);
  await post("/api/voice/mute", { muted: true });
  assert.deepEqual(await (await say("Steve muted words")).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  await post("/api/voice/mute", { muted: false });
  await post("/voice/shell-report", { callActive: true, pushToTalk: true }, token);
  assert.equal(voiceStateStore.state().mode, "push-to-talk");
  assert.deepEqual(await (await say("Steve push to talk")).json(), { accepted: true });
});

test("only the selected live recognizer can open or cancel a card after switching backends", async (t) => {
  const configure = (backend: string) => app.request("/api/voice/config", { method: "PUT",
    headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ backend }) });
  const sayWithSherpa = (text: string, id: string) =>
    post("/voice/utterances", { ...capture(text, id), backend: "sherpa-onnx" }, token);
  t.after(async () => { await configure("auto"); });
  await say("Will keep this", "pending");
  assert.equal((await configure("sherpa-onnx")).status, 200);
  assert.deepEqual(await (await say("cancel", "retry")).json(), { accepted: false });
  assert.deepEqual(await (await sayWithSherpa("cancel", "retry")).json(), { accepted: false });
  await post("/voice/listener/hello", { backend: "sherpa-onnx", version: VOICE_LISTENER_PROTOCOL_VERSION,
    devices: [], microphone: "granted", modelLoaded: true }, token);
  await configure("auto");
  assert.deepEqual(await (await say("Will stale", "stale")).json(), { accepted: false });
  assert.deepEqual(await (await say("cancel", "retry")).json(), { accepted: false });
  assert.deepEqual((await readHeard()).map((entry) => entry.id), ["pending"]);
  assert.deepEqual(await (await sayWithSherpa("cancel", "retry")).json(), { accepted: true });
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["pending", "pending"], ["pending", "cancelled"]]);
});

test("future captures beyond clock tolerance are dropped and a cancel on the same listener clock can act immediately", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const unsure = capture("Steven ask Will", "clock");
  const postAt = (capturedAt: number) => post("/voice/utterances", { ...unsure, capturedAt }, token);
  assert.deepEqual(await (await postAt(now + 1001)).json(), { accepted: false });
  assert.deepEqual(await readHeard(), []);
  assert.equal(cards.length, 0);
  assert.deepEqual(await (await postAt(now + 1000)).json(), { accepted: true });
  await post("/voice/utterances", { ...capture("cancel"), capturedAt: now + 1000 }, token);
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["clock", "unsure"], ["clock", "cancelled"]]);
});

test("a listener clock ahead of the daemon preserves out-of-order cancel and pick eligibility", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, offset: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt: now + offset }, token);
  await postAt("older", "Will discard this", 100);
  await postAt("newer", "Will keep this", 500);
  assert.equal(cards.at(-1)?.deadline, now + 1000);
  await postAt("delayed-cancel", "cancel", 300);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["older", "cancelled"]);
  await postAt("unsure", "Steven ask Will", 700);
  await postAt("delayed-pick", "Will", 600);
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["newer", "pending"], ["unsure", "unsure"]]);
  assert.deepEqual((await readHeard()).map((entry) => [entry.id, entry.time - now]), [
    ["unsure", 700], ["delayed-pick", 600], ["newer", 500], ["delayed-cancel", 300], ["older", 100],
  ]);
});

test("capture IDs must address a single card action URL segment", async () => {
  for (const id of [".", "..", "%2e", "a/b", "x?y", "x#y", "a b"]) {
    assert.equal((await say("Steve check the build", id)).status, 400, id);
  }
  assert.deepEqual(await readHeard(), []);
  assert.equal(cards.length, 0);
  const id = "call.1~A_b-c";
  assert.equal((await say("Steven ask Will", id)).status, 200);
  assert.equal((await act(id, "pick", { id: "task:Will" })).status, 200);
  assert.equal((await act(id, "cancel")).status, 200);
  assert.equal(cards.at(-1)?.state, "cancelled");
});

test("turning voice off clears pending actions and gates every contract D route", async () => {
  await say("Steve stale", "disabled");
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 0);
  for (const response of [await say("hello"), await act("disabled", "pick"), await act("disabled", "cancel"),
    await act("disabled", "send-now"), ...await Promise.all(["GET", "DELETE"].map((method) =>
      app.request("/api/voice/heard", { method, headers: { host: "localhost" } })))]) assert.equal(response.status, 404);
});

test("a cancel retried after toggling voice cannot dismiss a new card", async () => {
  await say("Steve old message", "old");
  await say("Steve cancel this one", "cancelled");
  const cancel = capture("cancel", "original-cancel");
  await post("/voice/utterances", cancel, token);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), ["old"]);

  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.deepEqual(await readHeard(), []);
  await say("Will check the new build", "new");
  assert.deepEqual(await (await post("/voice/utterances", cancel, token)).json(), { accepted: true });
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["new", "pending"]]);
  assert.deepEqual((await readHeard()).map((entry) => entry.id), ["new"]);
  await say("cancel", "fresh-cancel");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["new", "cancelled"]);
});

test("at the deadline only the older uncancelled card reaches the real pending-turn queue", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await say("Steve check the build", "older");
  await say("Steve drop this one", "newer");
  assert.deepEqual(registry.snapshot().voiceCards?.map((c) => c.id), ["older", "newer"]);
  const deadline = cards[0]!.deadline;
  assert.equal(deadline, Date.now() + 1000);
  await say("cancel");
  t.mock.timers.tick(999);
  assert.ok(!queued("Steve").includes("check the build"));
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(queued("Steve").filter((s) => ["check the build", "drop this one"].includes(s)), ["check the build"]);
  assert.deepEqual(cards.map((c) => c.reason === "delivering" ? c.reason : c.state), ["pending", "pending", "cancelled", "delivering", "sent"]);
  assert.equal((await readHeard()).find((e) => e.id === "newer")?.outcome, "cancelled");
});

test("quoted or comma-prefixed cancel leaves the pending card open until a bare cancel dismisses it", async () => {
  await say("Will check the build", "waiting");
  for (const text of ["“cancel”", '"CANCEL!"', "'cancel'", "«cancel».", ",cancel"]) {
    await say(text);
    assert.equal((await readHeard())[0]?.outcome, "ignored");
    assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["waiting", "pending"]]);
  }
  await say("Cancel!");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["waiting", "cancelled"]);
});

test("successive cancels stop exactly one action across kinds; a duplicate capture does nothing", async () => {
  await say("Will first", "a");
  const actions = registry.voiceRouter!.pendingVoiceActions;
  actions.push({ id: "answer", kind: "answer", openedAt: Date.now(), cancel: () => { actions.pop(); } });
  await say("Will second", "b");
  await say("cancel", "cancel-b");
  await say("cancel", "cancel-b");
  assert.deepEqual(actions.map((a) => a.id), ["a", "answer"]);
  await say("cancel");
  await say("cancel");
  await say("cancel");
  assert.deepEqual(cards.filter((c) => c.state === "cancelled").map((c) => c.id), ["b", "a"]);
  assert.equal((await readHeard())[0]?.rule, "nothing-pending");
});

test("API and spoken cancels respect the deadline even when the timer callback is late", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  await say("Will keep the first", "api-expired");
  t.mock.timers.setTime(now + 1000);
  assert.equal((await act("api-expired", "cancel")).status, 409);

  await say("Steven ask Will", "still-eligible");
  await say("Will keep the second", "spoken-expired");
  t.mock.timers.setTime(now + 2001);
  await say("cancel", "cancel-choice");
  assert.equal((await readHeard()).find(({ id }) => id === "cancel-choice")?.detail, "still-eligible");
  await say("cancel", "empty");
  assert.equal((await readHeard()).find(({ id }) => id === "empty")?.rule, "nothing-pending");
  t.mock.timers.tick(0);
  assert.deepEqual(queued("Will").filter((text) => text === "keep the first" || text === "keep the second"),
    ["keep the first", "keep the second"]);
});

test("a delayed spoken cancel targets the latest preceding capture even when POSTs arrive out of order", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postCapture = (id: string, text: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt }, token);
  await postCapture("middle", "Will discard the middle message", now - 300);
  await postCapture("oldest", "Will keep the first message", now - 400);
  await postCapture("newest", "Will keep the last message", now - 100);
  await postCapture("delayed", "cancel", now - 200);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["middle", "cancelled"]);
  assert.equal((await readHeard()).find((entry) => entry.id === "delayed")?.detail, "middle");

  await postCapture("before-all", "cancel", now - 500);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-all")?.rule, "nothing-pending");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), ["oldest", "newest"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(queued("Will").slice(-2), ["keep the first message", "keep the last message"]);
});

test("a picked card's new cancel window follows the time of the pick", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  await post("/voice/utterances", { ...capture("Steven ask Will", "choice"), capturedAt: now - 400 }, token);
  await post("/voice/utterances", { ...capture("Will"), capturedAt: now - 200 }, token);

  await post("/voice/utterances", { ...capture("cancel", "before-pick"), capturedAt: now - 300 }, token);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-pick")?.rule, "nothing-pending");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await post("/voice/utterances", { ...capture("cancel"), capturedAt: now - 100 }, token);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
});

test("an API pick and a spoken cancel use the shared host clock", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt }, token);
  await postAt("choice", "Steven ask Will about the clock", now);
  t.mock.timers.tick(900);
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  assert.equal(cards.at(-1)?.deadline, Date.now() + 1000);
  await postAt("before-click", "cancel", now + 850);
  assert.equal((await readHeard()).find((entry) => entry.id === "before-click")?.rule, "nothing-pending");
  t.mock.timers.tick(200);
  await postAt("after-click", "cancel", now + 1100);
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  t.mock.timers.tick(1000);
  assert.ok(!queued("Will").includes("ask Will about the clock"));
});

test("capture transport delay does not move an API pick before a pre-click cancel", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const postAt = (id: string, text: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt }, token);
  await postAt("choice", "Steven ask Will about transit", now - 300);
  t.mock.timers.tick(500);
  assert.equal((await act("choice", "pick", { id: "task:Will" })).status, 200);
  t.mock.timers.tick(50);
  await postAt("in-transit", "cancel", now + 400);
  assert.deepEqual(registry.snapshot().voiceCards?.map(({ id, state }) => [id, state]), [["choice", "pending"]]);
  assert.equal((await readHeard()).find(({ id }) => id === "in-transit")?.rule, "nothing-pending");
});

test("Cancel targets its own card, Send now queues once, and clearing history leaves no entry", async () => {
  await say("Steve cancel by id", "a");
  await say("Will send now", "b");
  assert.equal((await act("a", "cancel")).status, 200);
  assert.equal((await act("b", "send-now")).status, 200);
  assert.equal((await act("b", "send-now")).status, 409);
  assert.deepEqual(queued("Will").filter((s) => s === "send now"), ["send now"]);
  assert.ok(!queued("Steve").includes("cancel by id"));
  assert.equal((await app.request("/api/voice/heard", { method: "DELETE", headers: { host: "localhost" } })).status, 204);
  assert.deepEqual(await readHeard(), []);
});

test("window off queues immediately and an addressed stop interrupts the session", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  await say("Steve's, ship   it!");
  assert.ok(queued("Steve").includes("ship   it!"));
  await say("Steve, stop.");
  assert.deepEqual(interrupts, ["sdk:Steve"]);
  assert.deepEqual(cards.map((c) => c.reason === "delivering" ? c.reason : c.state), ["delivering", "sent", "delivering", "sent"]);
});

test("quoted stop messages reach the queue verbatim while bare stop still interrupts", async () => {
  const before = interrupts.length;
  const messages = ['"stop"', "'STOP!'", "“stop”", "«stop»."];
  for (const [index, message] of messages.entries()) {
    const id = "quoted-stop-" + index;
    await say("Steve, " + message, id);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual([cards.at(-1)?.state, queued("Steve").at(-1)], ["sent", message]);
  }
  assert.equal(interrupts.length, before);
  for (const command of ["stop", "Stop!"]) {
    const id = randomUUID();
    await say("Steve, " + command, id);
    assert.equal((await act(id, "send-now")).status, 409);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Steve", "sdk:Steve"]);
});

test("extra message punctuation is queued verbatim and cannot turn stop into an interrupt", async () => {
  const before = interrupts.length;
  for (const [captureText, message] of [
    ["Will,,,stop", ",,stop"], ["“Will,”,,,stop", ",,stop"], ["Will, #stop!", "#stop!"], ["Will, stop,", "stop,"],
  ] as const) {
    const id = randomUUID();
    await say(captureText, id);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["sent", message]);
  }
  assert.equal(interrupts.length, before);
  await say("Will, STOP。", "punctuated-command");
  assert.equal((await act("punctuated-command", "send-now")).status, 409);
  assert.deepEqual(interrupts.slice(before), ["sdk:Will"]);
});

test("space before an address's closing quote preserves bare and quoted stop behavior", async () => {
  const before = interrupts.length;
  for (const text of ["“Will, ” stop", "“ Will ” , stop", "“Will, ”! stop"]) {
    const id = randomUUID();
    await say(text, id);
    assert.equal((await act(id, "send-now")).status, 409);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Will", "sdk:Will", "sdk:Will"]);
  await say("“Will, ” “stop”", "message-quote");
  assert.equal((await act("message-quote", "send-now")).status, 200);
  assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["sent", "“stop”"]);
  await say("“Will, ” ! stop", "message-exclamation");
  assert.equal((await act("message-exclamation", "send-now")).status, 200);
  assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["sent", "! stop"]);
  assert.equal(interrupts.length, before + 3);
});

test("mismatched address wrappers stay in the queued message and cannot trigger a stop", async () => {
  const before = interrupts.length;
  for (const [captureText, message] of [
    ["[Will, ) stop", ") stop"], ["“Will, ’ stop", "’ stop"], ["[Will), stop", "), stop"],
    ["「[Will, ] 』 stop", "』 stop"], ["Will[ stop", "[ stop"], ["“Will”[ stop", "[ stop"],
    ["Will“ stop”", "“ stop”"], ["Will[] stop", "[] stop"],
  ] as const) {
    const id = randomUUID();
    await say(captureText, id);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.deepEqual([cards.at(-1)?.state, queued("Will").at(-1)], ["sent", message]);
  }
  assert.equal(interrupts.length, before);
  for (const captureText of ["[Will, ] stop", "「[Will, ] 」 stop"]) {
    const id = randomUUID();
    await say(captureText, id);
    assert.equal((await act(id, "send-now")).status, 409);
  }
  assert.deepEqual(interrupts.slice(before), ["sdk:Will", "sdk:Will"]);
});

test("a stop after an unclosed address wrapper queues as text at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const before = interrupts.length;
  const messages = queued("Will");
  for (const text of ["[Will, stop", "“Will, STOP!", "「[Will, ] stop", ", [Will, stop"]) await say(text);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(interrupts.length, before);
  assert.deepEqual(queued("Will").slice(messages.length), ["stop", "STOP!", "stop", "stop"]);
  assert.deepEqual(cards.slice(-4).map(({ state }) => state), ["sent", "sent", "sent", "sent"]);
});

test("a later mention of Steve opens a pending card for Will and queues the entire message to Will alone", async () => {
  const body = "ask Steve about the build";
  await say("Will, " + body, "mention");
  assert.equal(cards[0]?.state, "pending");
  assert.equal(cards[0]?.parts[0]?.target?.name, "Will");
  assert.equal(cards[0]?.parts[0]?.text, body);
  assert.deepEqual(cards[0]?.candidates, []);
  assert.equal((await act("mention", "send-now")).status, 200);
  assert.ok(queued("Will").includes(body));
  assert.ok(!queued("Steve").includes(body));
});

test("unsure waits indefinitely, cancels without sending, and accepts a spoken or clicked candidate", async () => {
  await say("Steven tell Will something", "ambiguous");
  assert.equal(cards[0]?.state, "unsure");
  assert.equal(cards[0]?.deadline, null);
  assert.equal((await act("ambiguous", "send-now")).status, 409);
  await say("cancel");
  assert.equal(cards.at(-1)?.state, "cancelled");
  assert.ok(!queued("Steve").includes("tell Will something"));
  for (const method of ["spoken", "click"]) {
    await say("Steven ask Will", method);
    assert.equal((await act(method, "pick", { id: "unknown" })).status, 409);
    if (method === "spoken") await say("Will");
    else assert.equal((await act(method, "pick", { id: "task:Will" })).status, 200);
    assert.equal(cards.at(-1)?.state, "pending");
    assert.equal(cards.at(-1)?.parts[0]?.target?.name, "Will");
    assert.equal((await act(method, "cancel")).status, 200);
  }
});

test("a spoken pick finds the only matching unsure card, even when it is older", async () => {
  await say("Steven ask Will about the build", "older");
  await say("Steven ask Bill about the release", "newer");
  await say("Steve");
  assert.deepEqual(cards.map((card) => [card.id, card.state]), [["older", "unsure"], ["newer", "unsure"]]);
  assert.equal((await readHeard())[0]?.rule, "ambiguous-pick");

  await say("Will.");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [
    ["newer", "unsure"], ["older", "pending"],
  ]);
  assert.equal(cards.at(-1)?.parts[0]?.target?.name, "Will");
  assert.equal((await act("older", "send-now")).status, 200);
  assert.deepEqual(queued("Will").filter((text) => text === "ask Will about the build"), ["ask Will about the build"]);
});

test("a candidate with leading or nonterminal boundary punctuation leaves the card open until a bare pick", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const before = queued("Will");
  await say("Steven ask Will about the results", "choice");
  for (const text of [",Will", " ?Will.", "Will,", "(Will)", "“Will”", '"Will"!', "'Will'", "“ Will ”", '" Will "!', "「 “ Will ” 」"]) {
    await say(text);
    assert.equal((await readHeard())[0]?.rule, "no-message");
    assert.deepEqual(queued("Will"), before);
    assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.state), ["unsure"]);
  }
  await say("Will.");
  assert.deepEqual(queued("Will"), [...before, "ask Will about the results"]);
  assert.deepEqual(registry.snapshot().voiceCards, []);
});

test("a delayed spoken pick can only queue an unsure capture that preceded it", async () => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  const now = Date.now();
  const postAt = (id: string, text: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture(text, id), capturedAt }, token);
  const before = queued("Will");
  await postAt("newer", "Steven ask Will about tomorrow", now - 100);
  await postAt("too-early", "Will", now - 400);
  assert.deepEqual(queued("Will"), before);
  assert.equal((await readHeard()).find((entry) => entry.id === "too-early")?.rule, "no-message");
  await postAt("older", "Steven ask Will about yesterday", now - 300);
  await postAt("between", "Will", now - 200);
  assert.deepEqual(queued("Will"), [...before, "ask Will about yesterday"]);
  assert.equal((await readHeard()).find((entry) => entry.id === "between")?.rule, "pick");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["newer", "unsure"]]);
});

test("a quote immediately after the address comma survives the preview and queued delivery", async () => {
  for (const [text, body] of [
    ['Will,"ship it"', '"ship it"'], ['"Will, "ship it"', '"ship it"'],
    ["'Will, 'ship it'", "'ship it'"], ['"Will, "stop', '"stop'],
  ] as const) {
    const id = randomUUID();
    await say(text, id);
    assert.equal(cards.at(-1)?.parts[0]?.text, body);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.equal(queued("Will").at(-1), body);
  }
});

test("punctuation-only messages reach the named agent and leave an unsure card open", async () => {
  await say("Steven ask Will about the build", "unsure");
  for (const [id, text, body] of [
    ["spaced", "Will, ???", "???"],
    ["adjacent", "Will,!!!", "!!!"],
    ["plain", "Will ...", "..."],
    ["commas", "Will, ,,,", ",,,"],
    ["adjacent-commas", "Will,,,", ",,"],
    ["quoted-name", '"Will",,,', ",,"],
    ["inner-and-outer-separator", "“Will,”,,,", ",,"],
  ] as const) {
    await say(text, id);
    const card = cards.at(-1);
    assert.deepEqual([card?.id, card?.state, card?.parts[0]?.text], [id, "pending", body]);
    assert.equal((await act(id, "send-now")).status, 200);
    assert.equal(queued("Will").at(-1), body);
  }
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["unsure", "unsure"]]);
});

test("a stop reaches the original session immediately and a pending message cannot follow its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const will = name("Will");
  voiceStateStore.useRoster(() => [will, name("Steve")]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  const startingInterrupts = interrupts.length;
  await say("Will, stop", "stop-original");
  assert.deepEqual(interrupts.slice(startingInterrupts), ["sdk:Will"]);
  await say("Steven ask Will about the deployment", "picked-message");
  await say("Will.");
  const replacementQueue = queued("Bill");
  const beforeInterrupts = [...interrupts];
  will.sessionId = "sdk:Bill";

  assert.equal((await act("stop-original", "send-now")).status, 409);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(queued("Bill"), replacementQueue);
  assert.deepEqual(interrupts, beforeInterrupts);
  const final = cards.at(-1);
  assert.deepEqual([final?.id, final?.state, final?.parts[0]?.target?.sessionId], ["picked-message", "not-running", "sdk:Will"]);
  const entries = await readHeard();
  assert.equal(entries.find(entry => entry.id === "stop-original")?.outcome, "sent");
  const stale = entries.find(entry => entry.id === "picked-message");
  assert.deepEqual([stale?.outcome, stale?.detail], ["not-running", "The selected session is unavailable."]);
});

test("a reconnect sees an in-flight interrupt until its final event and cannot act on it again", async (t) => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const driver = t.mock.method(sdk, "interrupt", async () => { started(); await delayed; return "idle"; });
  await say("Will, stop", "in-flight");
  await entered;
  try {
    const card = cards.at(-1);
    assert.deepEqual([card?.id, card?.state, card?.reason, card?.deadline], ["in-flight", "pending", "delivering", null]);
    assert.deepEqual(registry.snapshot().voiceCards, [card]);
    assert.deepEqual(registry.voiceRouter!.pendingVoiceActions, []);
    assert.equal((await act("in-flight", "send-now")).status, 409);
    assert.equal((await act("in-flight", "cancel")).status, 409);
  } finally {
    finish();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(driver.mock.callCount(), 1);
  assert.equal(cards.at(-1)?.state, "sent");
  assert.deepEqual(registry.snapshot().voiceCards, []);
});

test("acknowledging an immediate interrupt lets the listener send another message and cancel while delivery runs", async (t) => {
  await app.request("/api/voice/config", { method: "PUT", headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cancelWindow: { enabled: false } }) });
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(sdk, "interrupt", async () => { await delayed; return "idle"; });
  await say("Steven ask Will", "choice");
  const captures = (async () => {
    for (const [text, id] of [["Will, stop", "slow-stop"], ["Bill keep going", "other"], ["cancel", "dismiss"]] as const) {
      assert.deepEqual(await (await say(text, id)).json(), { accepted: true });
    }
  })();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(queued("Bill").includes("keep going"));
    assert.equal(cards.findLast((card) => card.id === "choice")?.state, "cancelled");
    assert.deepEqual(registry.snapshot().voiceCards?.map(({ id, reason }) => [id, reason]), [["slow-stop", "delivering"]]);
  } finally {
    finish();
    await captures;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(cards.findLast((card) => card.id === "slow-stop")?.state, "sent");
});

test("a selected session missing from the registry is reported as unavailable", async (t) => {
  const will = { ...name("Will"), sessionId: "sdk:gone" };
  voiceStateStore.useRoster(() => [will]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  await say("Will finish the report", "gone");
  assert.equal((await act("gone", "send-now")).status, 200);
  assert.equal(cards.at(-1)?.state, "not-running");
  assert.equal((await readHeard())[0]?.outcome, "not-running");
});

test("a spoken pick for a departed candidate records why the unsure card stays open", async (t) => {
  await say("Steven ask Will about the release", "choose");
  voiceStateStore.useRoster(() => roster.filter((target) => target.name !== "Will"));
  t.after(() => voiceStateStore.useRoster(() => roster));
  await say("Will", "departed");
  const [pick, original] = await readHeard();
  assert.deepEqual([pick?.id, pick?.outcome, pick?.rule], ["departed", "ignored", "candidate-unavailable"]);
  assert.equal(original?.outcome, "unsure");
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => [card.id, card.state]), [["choose", "unsure"]]);
  await say("Steve");
  assert.deepEqual([cards.at(-1)?.state, cards.at(-1)?.parts[0]?.target?.name], ["pending", "Steve"]);
});

test("ignored, pending and cancelled captures leave no transcript in the daemon state directory", async () => {
  const marker = randomUUID();
  await say("Morning " + marker);
  await say("Steve remember " + marker, "cancel-this");
  await say("Will pending " + marker);
  await act("cancel-this", "cancel");
  const response = await app.request("/api/voice/heard", { headers: { host: "localhost" } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { entries } = await response.json() as { entries: HeardEntry[] };
  assert.deepEqual(entries.map((entry) => entry.outcome), ["pending", "cancelled", "ignored"]);
  assert.ok(entries.every((entry) => entry.text.includes(marker)));
  const files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  assert.ok(files.some((file) => file.name === "harness.db"));
  for (const file of files) {
    assert.equal(readFileSync(join(file.parentPath, file.name)).includes(marker), false, file.name);
  }
});

test("Recently heard measures the pause between aligned words and leaves unclear timings empty", async (t) => {
  voiceStateStore.useRoster(() => [name("Release"), name("Build Captain")]);
  t.after(() => voiceStateStore.useRoster(() => roster));
  for (const [text, labels, pause] of [
    ["Release , run tests", ["Release", ",", "run", "tests"], 150],
    ["Build Captain , run tests", ["Build", "Captain,", "run", "tests"], 50],
    ["Release, run tests", ["Other", "run"], null],
    ["Release, run tests", ["Release", ",", "tests"], null],
    ["Build Captain, run tests", ["Other", "Captain", "run"], null],
    ["Release, ???", ["Release", "???"], null],
  ] as const) {
    const words = labels.map((label, i) => ({ text: label, startMs: 100 * i, endMs: 100 * i + 50 }));
    assert.equal((await post("/voice/utterances", { ...capture(text), words }, token)).status, 200);
    const [entry] = await readHeard();
    assert.deepEqual([entry?.outcome, entry?.pauseMs], ["pending", pause], text);
  }
});


test("the downstream say fixture establishes a listener and posts contiguous or supplied word timings", async (t) => {
  const { say: sayFixture } = await import("../e2e/fixtures/voice.ts");
  voiceStateStore.reset();
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => app.request(url, init));
  const daemon = { home, baseURL: "http://localhost" };
  assert.deepEqual(await (await sayFixture(daemon, "Will, grab the door")).json(), { accepted: true });
  assert.equal((await readHeard())[0]?.pauseMs, 0);
  assert.deepEqual(await (await sayFixture(daemon, "Will you grab the door", { words: [
    { text: "Will", startMs: 0, endMs: 130 }, { text: "you", startMs: 100, endMs: 175 },
  ] })).json(), { accepted: true });
  const entries = await readHeard();
  assert.equal(entries[0]?.pauseMs, -30);
  assert.deepEqual(entries.map((entry) => [entry.matchedName, entry.rule]), [["Will", "exact"], ["Will", "exact"]]);
});

test("the listener posts a delayed message before a concurrently spoken cancel", async (t) => {
  const { say: sayFixture } = await import("../e2e/fixtures/voice.ts");
  const daemon = { home, baseURL: "http://localhost" };
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/voice/utterances")) {
      const { id } = JSON.parse(String(init.body));
      posted.push(id);
      if (id === "first") {
        markStarted();
        await delayed;
      }
    }
    return app.request(url, init);
  });

  const message = sayFixture(daemon, "Will discard these words", { id: "first" });
  await started;
  const cancel = sayFixture({ ...daemon }, "cancel", { id: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const inFlight = [...posted];
  release();
  const responses = await Promise.all([message, cancel]);
  assert.deepEqual(inFlight, ["first"]);
  assert.deepEqual(posted, ["first", "second"]);
  for (const response of responses) assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(cards.map(({ id, state }) => [id, state]), [["first", "pending"], ["first", "cancelled"]]);
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.ok(!queued("Will").includes("discard these words"));
});

test("two weak matches followed by a bare name leave only ignored history", async () => {
  const before = queued("Will");
  for (const text of ["fill in the form", "till tomorrow", "Will?"]) await say(text);
  assert.deepEqual((await readHeard()).map(({ outcome, rule }) => [outcome, rule]), [
    ["ignored", "no-message"], ["ignored", "near-miss"], ["ignored", "near-miss"],
  ]);
  assert.deepEqual(cards, []);
  assert.deepEqual(registry.snapshot().voiceCards, []);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions, []);
  assert.deepEqual(queued("Will"), before);
});

test("a sixth unsure card cancels the oldest unsure card and preserves pending delivery", async () => {
  await say("Will keep this", "pending");
  for (let i = 0; i < 6; i++) await say("Steven told Will about it", "unsure-" + i);
  const openIds = ["pending", "unsure-1", "unsure-2", "unsure-3", "unsure-4", "unsure-5"];
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), openIds);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), openIds);
  assert.deepEqual(cards.filter((card) => card.state === "cancelled").map((card) => card.id), ["unsure-0"]);
  assert.equal((await readHeard()).find((entry) => entry.id === "unsure-0")?.outcome, "cancelled");
  assert.equal((await act("unsure-0", "pick", { id: "task:Will" })).status, 409);
});

test("at capacity the router rejects new cards but preserves deadlines, picks, cancels and retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  await say("Steven ask Will", "choice");
  for (let i = 1; i < 50; i++) {
    assert.deepEqual(await (await say("Will wait", "pending-" + i)).json(), { accepted: true });
  }
  const snapshot = registry.snapshot().voiceCards;
  assert.equal(snapshot?.length, 50);
  assert.deepEqual(await (await say("Will try again", "overflow")).json(), { accepted: false });
  assert.deepEqual(registry.snapshot().voiceCards, snapshot);
  assert.equal(registry.voiceRouter!.pendingVoiceActions.length, 50);
  assert.ok(!(await readHeard()).some(({ id }) => id === "overflow"));
  assert.deepEqual(await (await say("Will")).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "pending"]);
  await say("cancel");
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["choice", "cancelled"]);
  assert.deepEqual(await (await say("Will try again", "overflow")).json(), { accepted: true });
  assert.deepEqual([cards.at(-1)?.id, cards.at(-1)?.state], ["overflow", "pending"]);
});

test("out-of-order unsure captures keep the five newest choices, including when the incoming card is oldest", async () => {
  const postUnsure = (id: string, capturedAt: number) =>
    post("/voice/utterances", { ...capture("Steven ask Will", id), capturedAt }, token);
  for (const time of [30, 10, 50, 20, 40]) await postUnsure(String(time), time);
  await postUnsure("stale", 5);
  assert.deepEqual(cards.filter((card) => card.id === "stale").map((card) => card.state), ["cancelled"]);
  assert.equal((await act("stale", "pick", { id: "task:Will" })).status, 409);
  await postUnsure("tie", 10);
  assert.deepEqual(registry.snapshot().voiceCards?.map((card) => card.id), ["30", "50", "20", "40", "tie"]);
  assert.deepEqual(registry.voiceRouter!.pendingVoiceActions.map((action) => action.id), ["30", "50", "20", "40", "tie"]);
  const cancelled = (await readHeard()).filter((entry) => entry.outcome === "cancelled");
  assert.deepEqual(cancelled.map((entry) => entry.id), ["10", "stale"]);
});

test("Recently heard keeps the refusal reasons from the queue and interrupt adapters", async (t) => {
  t.mock.method(pending, "submitSpoken", () => ({ ok: false, error: "Queue full." }));
  await say("Steve send this", "queue-refusal");
  await act("queue-refusal", "send-now");
  t.mock.method(sdk, "interrupt", async () => null);
  await say("Steve stop", "interrupt-refusal");
  await act("interrupt-refusal", "send-now");
  assert.deepEqual((await readHeard()).map(({ outcome, detail }) => [outcome, detail]), [
    ["failed", "this session has no live embedded driver"], ["failed", "Queue full."],
  ]);
});

test("a busy session's accepted turn stays queued on its card and in Recently heard", async () => {
  registry.applyDriverEvent("sdk:Bill", { kind: "state", state: "working", activity: "Running tests" });
  await say("Bill, review the logs", "busy");
  assert.equal((await act("busy", "send-now")).status, 200);
  const session = registry.getSession("sdk:Bill")!;
  assert.equal(session.state, "working");
  assert.ok(session.pendingTurns.some((turn) => turn.text === "review the logs" && turn.claimedAt === null));
  assert.deepEqual(cards.map((card) => [card.state, card.reason]), [["pending", "exact"], ["pending", "delivering"], ["queued", "exact"]]);
  assert.equal((await readHeard())[0]?.outcome, "queued");
});
