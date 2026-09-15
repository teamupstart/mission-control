import { test } from "node:test";
import assert from "node:assert/strict";

import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";
import { buildApp } from "../src/server/routes.ts";
import { MODEL_CATALOG } from "../src/shared/model.ts";
import { HarnessModelCatalogsSchema } from "../src/shared/protocol.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
import { HarnessModelCatalogService } from "../src/server/harness/model-catalog-service.ts";

const registry = {} as Registry;
const reviews = {} as ReviewManager;
const tasks = {} as TaskManager;
const queues = {} as QueueManager;

function appWith(service?: HarnessModelCatalogService) {
  return buildApp({ registry, reviews, tasks, queues, modelCatalogs: service });
}

function serviceWith(discover: () => Promise<
  | { ok: true; choices: Array<{ id: string; label: string; hint: null; provider: string; contextWindow: number; reasoning: boolean; inputModes: ["text"] }> }
  | { ok: false; problem: "timeout" }
>) {
  return new HarnessModelCatalogService({
    specs: {
      claude: { shipped: MODEL_CATALOG.claude, discover: null },
      codex: { shipped: MODEL_CATALOG.codex, discover: null },
      pi: { shipped: MODEL_CATALOG.pi, discover },
    },
    now: () => Date.parse("2026-08-18T15:00:00.000Z"),
  });
}

test("GET /api/harnesses/models returns the exhaustive schema and honors forced refresh", async () => {
  let calls = 0;
  const service = serviceWith(async () => {
    calls++;
    return {
      ok: true,
      choices: [{
        id: `openai/live-${calls}`,
        label: `Live ${calls}`,
        hint: null,
        provider: "openai",
        contextWindow: 272_000,
        reasoning: true,
        inputModes: ["text"],
      }],
    };
  });
  const app = appWith(service);

  const live = await app.request("/api/harnesses/models", { headers: { host: "127.0.0.1:7317" } });
  assert.equal(live.status, 200);
  const liveBody = await live.json();
  assert.equal(HarnessModelCatalogsSchema.safeParse(liveBody).success, true);
  assert.deepEqual(Object.keys(liveBody as object), [...AGENT_TYPES]);
  assert.equal((liveBody as { pi: { source: string } }).pi.source, "live");

  const cached = await app.request("/api/harnesses/models", { headers: { host: "localhost:7317" } });
  assert.equal(cached.status, 200);
  assert.equal(((await cached.json()) as { pi: { source: string } }).pi.source, "cached");
  assert.equal(calls, 1);

  const refreshed = await app.request("/api/harnesses/models?refresh=1", { headers: { host: "[::1]:7317" } });
  assert.equal(refreshed.status, 200);
  const refreshedBody = (await refreshed.json()) as { pi: { choices: Array<{ id: string }> } };
  assert.equal(refreshedBody.pi.choices[0]!.id, "openai/live-2");
  assert.equal(calls, 2);
});

test("the route exposes stale-cache and shipped-fallback quality without raw errors", async () => {
  let fail = false;
  const service = serviceWith(async () => fail
    ? { ok: false, problem: "timeout" }
    : {
        ok: true,
        choices: [{ id: "openai/live", label: "Live", hint: null, provider: "openai", contextWindow: 272_000, reasoning: true, inputModes: ["text"] }],
      });
  const app = appWith(service);
  await app.request("/api/harnesses/models", { headers: { host: "127.0.0.1" } });
  fail = true;
  const stale = await app.request("/api/harnesses/models?refresh=1", { headers: { host: "127.0.0.1" } });
  assert.equal(stale.status, 200);
  const staleBody = (await stale.json()) as { pi: { source: string; problem: string; choices: Array<{ id: string }> } };
  assert.deepEqual(staleBody.pi, {
    choices: [{ id: "openai/live", label: "Live", hint: null, provider: "openai", contextWindow: 272_000, reasoning: true, inputModes: ["text"] }],
    source: "cached",
    refreshedAt: "2026-08-18T15:00:00.000Z",
    problem: "timeout",
  });

  const fallbackApp = appWith(serviceWith(async () => ({ ok: false, problem: "timeout" })));
  const fallback = await fallbackApp.request("/api/harnesses/models", { headers: { host: "localhost" } });
  assert.equal(fallback.status, 200);
  const fallbackBody = (await fallback.json()) as { pi: { source: string; problem: string; choices: Array<{ id: string }> } };
  assert.equal(fallbackBody.pi.source, "fallback");
  assert.equal(fallbackBody.pi.problem, "timeout");
  assert.deepEqual(fallbackBody.pi.choices.map((choice) => choice.id), MODEL_CATALOG.pi.map((choice) => choice.id));
  assert.equal(JSON.stringify(fallbackBody).includes("secret"), false);
});

test("the route refuses an injected service result that violates the shared response bound", async () => {
  const overlong = "x".repeat(10_000);
  const invalidService = {
    async getCatalogs() {
      const invalidChoice = {
        id: "openai/model",
        label: overlong,
        hint: null,
        provider: "openai",
        contextWindow: 272_000,
        reasoning: true,
        inputModes: ["text"],
      };
      const catalog = { choices: [invalidChoice], source: "live", refreshedAt: new Date().toISOString(), problem: null };
      return { claude: catalog, codex: catalog, pi: catalog };
    },
  } as unknown as HarnessModelCatalogService;
  const app = appWith(invalidService);
  const response = await app.request("/api/harnesses/models", { headers: { host: "127.0.0.1" } });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes(overlong), false);
});

test("the route validates refresh, returns 503 without its daemon service, and stays loopback-only", async () => {
  const missing = appWith();
  const unavailable = await missing.request("/api/harnesses/models", { headers: { host: "127.0.0.1" } });
  assert.equal(unavailable.status, 503);

  let calls = 0;
  const service = serviceWith(async () => {
    calls++;
    return { ok: false, problem: "timeout" };
  });
  const app = appWith(service);
  assert.equal(calls, 0);
  const invalid = await app.request("/api/harnesses/models?refresh=true", { headers: { host: "127.0.0.1" } });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0, "an invalid refresh query must be refused before discovery");

  const forbidden = await app.request("/api/harnesses/models", { headers: { host: "evil.example.com" } });
  assert.equal(forbidden.status, 403);
});
