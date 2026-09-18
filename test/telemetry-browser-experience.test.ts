import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { actionFetch, featureAction, featureVisit, flushExperience } from "../src/web/lib/experience.ts";
import { beginOperation } from "../src/web/lib/operation-context.ts";
import { personaRequest } from "../src/web/workflows/personaApi.ts";
import { workflowRequest } from "../src/web/workflows/workflowApi.ts";

const operationId = (init?: RequestInit) => new Headers(init?.headers).get("x-mission-operation-id");

test("persona and workflow transport errors keep the operation sent to the server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    if (path === "/api/telemetry/ingress") return new Response("{}", { status: 200 });
    throw new Error("PRIVATE_SENTINEL provider failure");
  });
  for (const [request, path] of [[personaRequest, "/api/personas"], [workflowRequest, "/api/workflows"]] as const) {
    requests.length = 0;
    await assert.rejects(request(path, { method: "POST", body: "{}" }), /PRIVATE_SENTINEL/);
    await flushExperience();
    const operation = requests.find((r) => r.path === path)!;
    const error = requests.find((r) => r.path === "/api/telemetry/ingress")!;
    assert.ok(error, "the transport failure must be reported");
    assert.equal(operationId(error.init), operationId(operation.init));
    assert.ok(!error.init?.body?.toString().includes("PRIVATE_SENTINEL"));
    t.mock.timers.tick(60_001);
  }
});

test("transient ingress failure retries without another gesture and stops after three attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => {
    attempts.push(init);
    return new Response("", { status: 503 });
  });
  featureAction("search", "select");
  await flushExperience();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(10_000); await setImmediate(); }
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map(operationId)).size, 1, "retries reuse the same operation");
  assert.equal(new Set(attempts.map((r) => r.body)).size, 1, "retries retain the record and timestamp");
});

test("reader visits survive StrictMode replay and count again after a real departure", async (t) => {
  const records: string[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(globalThis, "fetch", async (_path: string, init: RequestInit) => {
    if (JSON.parse(String(init.body)).records.some((r: { facts: { feature?: string } }) => r.facts.feature === "conversation")) records.push(String(init.body));
    return new Response("{}", { status: 200 });
  });
  const leave = featureVisit("reader", "session:conversation", "conversation");
  leave();
  const leaveAgain = featureVisit("reader", "session:conversation", "conversation");
  await setImmediate();
  await flushExperience();
  assert.equal(records.length, 1, "effect replay is not another visit");
  leaveAgain();
  await setImmediate();
  featureVisit("reader", "session:conversation", "conversation");
  await flushExperience();
  assert.equal(records.length, 2, "returning after departure is another visit");
});


test("telemetry controls retain their headers without recursively reporting their own failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const operation = beginOperation("settings");
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let disconnect = false;
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    requests.push({ path, init });
    if (disconnect) throw new Error("offline");
    return new Response("{}", { status: 503 });
  });
  const write = () => actionFetch("/api/telemetry/config", { method: "PUT", headers: operation.headers, body: "{}" });
  assert.equal((await write()).status, 503);
  disconnect = true;
  await assert.rejects(write(), /offline/);
  await flushExperience();
  assert.equal(requests.length, 2, "telemetry failures cannot enqueue error ingress");
  assert.ok(requests.every((r) => r.path === "/api/telemetry/config" && operationId(r.init) === operation.id));
});
