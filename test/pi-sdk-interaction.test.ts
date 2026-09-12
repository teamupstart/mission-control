import test from "node:test";
import assert from "node:assert/strict";
import { PiUIBridge } from "../src/server/harness/pi/sdk-ui.ts";
import { vendorUI, narrowPiEvent } from "../src/server/harness/pi/sdk-deps.ts";
import { piSdkSpec } from "../src/server/harness/pi/sdk.ts";
import { driverDialog } from "../src/server/sdk/dialog.ts";
import { driverFormAnswer, driverOptionAnswer } from "../src/server/sdk/answer.ts";
import type { SdkEvent, SessionRequest } from "../src/server/harness/types.ts";
import { FakePiSdk, collect, fakePiSdkDeps, launchOptions, settle } from "./helpers/pi-sdk-fake.ts";

function bridge(timeout = 5000) {
  const events: SdkEvent[] = [];
  const notes: string[] = [];
  const ui = new PiUIBridge((event) => events.push(event), (note) => notes.push(note), timeout);
  const request = (): SessionRequest => {
    const event = events.findLast((e) => e.kind === "request");
    assert.ok(event?.kind === "request");
    return event.request;
  };
  return { ui, events, notes, request };
}

test("select preserves order, validates id and row, and settles once", async () => {
  const { ui, request, events } = bridge();
  const value = ui.select("Choose", ["Zebra", "Alpha"]);
  const asked = request();
  assert.deepEqual(asked.options.map((o) => o.label), ["Zebra", "Alpha"]);
  assert.throws(() => ui.answer("wrong", { kind: "option", number: 1, label: "Zebra" }));
  assert.throws(() => ui.answer(asked.id, { kind: "option", number: 1, label: "Alpha" }));
  ui.answer(asked.id, { kind: "option", number: 2, label: "Alpha" });
  assert.equal(await value, "Alpha");
  assert.throws(() => ui.answer(asked.id, { kind: "option", number: 2, label: "Alpha" }));
  assert.equal(events.filter((e) => e.kind === "request_resolved").length, 1);
});

test("confirm returns boolean; input and editor preserve empty values, prefill and whitespace", async () => {
  const { ui, request } = bridge();
  const confirmation = ui.confirm("Apply?", "The description");
  assert.match(request().prompt, /Apply\?\n\nThe description/);
  ui.answer(request().id, { kind: "option", number: 1, label: "Yes" });
  assert.equal(await confirmation, true);
  for (const [multiline, value] of [[false, ""], [true, "  first\nsecond  \n"]] as const) {
    const pending = multiline ? ui.editor("Edit", "original\ntext") : ui.input("Name", "placeholder");
    const asked = request();
    const field = asked.questions![0]!.textInput!;
    assert.equal(field.multiline, multiline);
    assert.equal(multiline ? field.initialValue : field.placeholder, multiline ? "original\ntext" : "placeholder");
    const projected = driverFormAnswer(driverDialog(asked), [{ question: asked.prompt, labels: [], text: value }], asked.id);
    assert.equal(projected.ok, true);
    if (projected.ok) ui.answer(projected.requestId, projected.answer);
    assert.equal(await pending, value);
  }
});

test("stale browser correlation cannot answer an identical later question", async () => {
  const { ui, request } = bridge();
  const first = ui.select("same", ["Yes"]);
  const id = request().id;
  ui.answer(id, { kind: "option", number: 1, label: "Yes" });
  await first;
  const second = ui.select("same", ["Yes"]);
  assert.equal(driverOptionAnswer(driverDialog(request()), { number: 1, label: "Yes", requestId: id }).ok, false);
  ui.close();
  assert.equal(await second, undefined);
});

test("timeout, abort signal, replacement and disconnect cancel with method values", async () => {
  const { ui, request, events } = bridge(15);
  const timed = ui.input("timeout");
  const oldId = request().id;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await timed, undefined);
  assert.throws(() => ui.answer(oldId, { kind: "text", text: "late" }));
  const controller = new AbortController();
  const aborted = ui.confirm("cancel", "signal", { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, false);
  const old = ui.context();
  const replaced = old.editor("old");
  ui.invalidate();
  assert.equal(await replaced, undefined);
  assert.equal(await old.input("retired context"), undefined);
  const disconnected = ui.confirm("disconnect", "shutdown");
  ui.close();
  assert.equal(await disconnected, false);
  assert.equal(events.filter((e) => e.kind === "request_resolved").length, 4);
});

test("concurrent requests serialize on the shared dialog and shutdown never exposes abandoned tails", async () => {
  const { ui, request, events } = bridge();
  const a = ui.input("A");
  const b = ui.input("B");
  assert.equal(request().prompt, "A");
  ui.answer(request().id, { kind: "form", answers: [{ question: "A", labels: [], text: "one" }] });
  assert.equal(await a, "one");
  assert.equal(request().prompt, "B");
  const c = ui.input("C");
  ui.close();
  assert.equal(await b, undefined);
  assert.equal(await c, undefined);
  assert.equal(events.filter((e) => e.kind === "request").length, 2);
});

test("unsupported TUI factories never run and diagnostics are bounded", async () => {
  const { ui, notes } = bridge();
  const vendor = vendorUI(ui);
  let called = false;
  await assert.rejects(vendor.custom(() => { called = true; throw new Error("unreachable"); }), /unavailable/);
  vendor.setWidget("widget", () => { called = true; throw new Error("unreachable"); });
  for (let i = 0; i < 100; i++) vendor.notify("x".repeat(5000));
  assert.equal(called, false);
  assert.equal(notes.length, 1);
  assert.ok(notes[0]!.length < 550);
  ui.close();
});

for (const trusted of [true, false]) {
  test(`undecided trust ${trusted ? "allow" : "deny"} is answered before resource construction`, async () => {
    const sdk = new FakePiSdk();
    sdk.trustRequiring = true;
    const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
    const stream = collect(handle);
    await settle();
    assert.equal(sdk.runtime.session.deliveries.length, 0);
    assert.equal(stream.events.some((e) => e.kind === "bound"), false);
    assert.equal(await handle.sendIfIdle({ text: "queue" }), null);
    const request = stream.events.find((e) => e.kind === "request");
    assert.ok(request?.kind === "request");
    assert.equal(request.request.kind, "trust");
    await handle.answer(request.request.id, { kind: "option", number: trusted ? 1 : 2, label: trusted ? "Trust project" : "Skip project resources" });
    await settle();
    assert.equal(sdk.trust, trusted);
    assert.deepEqual(sdk.trustDecisions, [trusted]);
    assert.equal(sdk.runtime.session.deliveries.length, 1);
    await handle.stop();
    await stream.done;
  });
}

test("stop during trust leaves Pi's decision untouched and creates no session", async () => {
  const sdk = new FakePiSdk(); sdk.trustRequiring = true;
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
  const stream = collect(handle);
  await handle.stop(); await stream.done;
  assert.equal(sdk.trust, null);
  assert.equal(sdk.runtime.session.deliveries.length, 0);
  assert.equal(stream.events.some((e) => e.kind === "bound"), false);
});

test("invalid trust state fails closed", async () => {
  const sdk = new FakePiSdk(); sdk.trustRequiring = true;
  sdk.projectTrust = () => "yes" as unknown as boolean;
  await assert.rejects(piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions()), /invalid project trust/);
  assert.equal(sdk.runtime.session.deliveries.length, 0);
});

test("questions block queue delivery; replacement and stop cancel the old UI", async () => {
  const sdk = new FakePiSdk();
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions({ prompt: "" }));
  const stream = collect(handle);
  const oldUi = sdk.runtime.session.ui!;
  const answer = oldUi.input("waiting");
  assert.equal(await handle.sendIfIdle({ text: "queue" }), null);
  await handle.clearContext!();
  assert.equal(await answer, undefined);
  assert.equal(await oldUi.input("late"), undefined);
  assert.equal(await handle.sendIfIdle({ text: "/skill:pull-request" }), "started");
  sdk.runtime.session.emit({ type: "agent_settled" }, { type: "agent_settled" });
  sdk.runtime.session.finish();
  await settle();
  assert.equal(stream.events.filter((e) => e.kind === "turn_done").length, 1);
  const last = sdk.runtime.session.ui!.confirm("stop", "cancel");
  await handle.stop();
  assert.equal(await last, false);
});

test("a failed clear cancels the pending ask but preserves the current extension context", async () => {
  const sdk = new FakePiSdk();
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions({ prompt: "" }));
  const stream = collect(handle);
  const ui = sdk.runtime.session.ui!;
  const pending = ui.input("before failed clear");
  sdk.runtime.newSessionError = new Error("replacement unavailable");
  await assert.rejects(handle.clearContext!(), /replacement unavailable/);
  assert.equal(await pending, undefined);
  const next = ui.input("still usable");
  await settle();
  const asked = stream.events.findLast((e) => e.kind === "request");
  assert.ok(asked?.kind === "request");
  assert.equal(asked.request.prompt, "still usable");
  await handle.answer(asked.request.id, { kind: "form", answers: [{ question: "still usable", labels: [], text: "yes" }] });
  assert.equal(await next, "yes");
  await handle.stop(); await stream.done;
});

test("interrupt refuses chained extension questions while the accepted turn is aborting", async () => {
  const sdk = new FakePiSdk();
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
  const stream = collect(handle);
  try {
    const ui = sdk.runtime.session.ui!;
    const first = ui.input("interrupted question");
    const chained = first.then(() => ui.input("abort continuation"));
    await handle.interrupt();
    await settle();
    assert.equal(stream.events.filter((e) => e.kind === "request").length, 1);
    assert.equal(await chained, undefined);
    assert.equal(stream.events.filter((e) => e.kind === "turn_done").length, 1);
  } finally {
    await handle.stop(); await stream.done;
  }
});

test("stop during extension startup settles its question and disposes the runtime exactly once", async () => {
  const sdk = new FakePiSdk();
  let answered: string | undefined = "unsettled";
  sdk.runtime.session.bindExtensions = async (ui) => { answered = await ui.input("startup"); };
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
  const stream = collect(handle);
  await Promise.all([handle.stop(), handle.stop()]);
  await stream.done;
  assert.equal(answered, undefined);
  assert.equal(sdk.runtime.disposals, 1);
  assert.equal(sdk.runtime.session.deliveries.length, 0);
});

test("unavailable repository evidence leaves PR provenance absent", async () => {
  const sdk = new FakePiSdk();
  const deps = fakePiSdkDeps(sdk);
  deps.repositories = async () => [];
  const handle = await piSdkSpec(deps).launch(launchOptions());
  const stream = collect(handle);
  sdk.runtime.session.emit(
    { type: "tool_execution_start", toolName: "bash", toolCallId: "create", command: "gh pr create", opensPullRequest: true },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "create", isError: false, prUrls: ["https://github.com/owner/repo/pull/975"] },
  );
  await settle();
  assert.equal(stream.events.some((e) => e.kind === "pr_created"), false);
  await handle.stop(); await stream.done;
});

test("successful correlated bash output proves PR provenance, never prose or unrelated results", async () => {
  const sdk = new FakePiSdk();
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
  const stream = collect(handle);
  const session = sdk.runtime.session;
  for (const [id, failed, repo, command] of [
    ["failed", true, "owner/repo", "gh pr create"],
    ["other", false, "stranger/repo", "gh pr create"],
    ["view", false, "owner/repo", "gh pr view"],
    ["opened", false, "owner/repo", "gh pr create"],
  ] as const) {
    const start = narrowPiEvent({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
    const end = narrowPiEvent({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: failed, result: { content: [{ type: "text", text: `https://github.com/${repo}/pull/975` }], details: {} } });
    assert.ok(start && end); session.emit(start, end, end);
  }
  session.emit({ type: "message_end", assistant: { modelId: null, usage: null, stopReason: "stop", errorMessage: "https://github.com/owner/repo/pull/999" } });
  await settle();
  assert.deepEqual(stream.events.filter((e) => e.kind === "pr_created"), [{ kind: "pr_created", urls: ["https://github.com/owner/repo/pull/975"] }]);
  await handle.stop();
});
