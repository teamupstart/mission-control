import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { buildApp, type RouteDeps } from "../src/server/routes.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";

/**
 * Every registered route, bound to an asserted result.
 *
 * The composition contract test proves `buildApp` refuses a miswired dependency. This proves
 * the other half: that composing by name did not change WHICH route answers WHAT. It is a
 * differential rather than 303 hand-written expectations, because the property at issue is
 * equivalence, and a differential cannot drift out of date the way a transcribed status can.
 *
 * The two apps differ only in the order their dependency fields are written. Under the old
 * positional seam that was the whole bug surface; under a named one it must be invisible, on
 * every route, in both status and bytes.
 */

const LOOPBACK = { host: "127.0.0.1:7317" };

const registry = {} as unknown as Registry;
const reviews = {} as unknown as ReviewManager;
const tasks = {} as unknown as TaskManager;
const queues = {} as unknown as QueueManager;

/** The same four services, written in opposite orders. */
const FORWARD: RouteDeps = { registry, reviews, tasks, queues };
const REVERSED: RouteDeps = { queues, tasks, reviews, registry };

/**
 * Two routes answer 200 with a body that carries a fresh id or clock reading, so their bytes
 * differ between any two calls, not just between these two apps. Their STATUS is still
 * compared like every other route; only the byte comparison is skipped, and naming them here
 * keeps that exemption auditable rather than silent.
 */
const NON_DETERMINISTIC_BODIES = new Set([
  "POST /api/foreman/planner/retry",
  "GET /api/setup/checks",
]);

function routeKeys(app: ReturnType<typeof buildApp>): string[] {
  const keys = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue; // middleware, not a route
    keys.add(`${route.method} ${route.path}`);
  }
  return [...keys].sort();
}

/** `/api/tasks/:id` cannot be requested as written; give every parameter a value. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+\??/g, "x").replace(/\*/g, "x");
}

test("every route registered in source is present in the composed surface", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/server/routes.ts", import.meta.url)),
    "utf8",
  );
  const declared = source.match(/^ {2}app\.(get|post|put|patch|delete)\(/gm)?.length ?? 0;
  const composed = routeKeys(buildApp(FORWARD)).length;
  assert.ok(declared > 300, `expected the full surface in source, saw ${declared}`);
  assert.equal(
    composed,
    declared,
    `source declares ${declared} routes but the composed app registers ${composed}`,
  );
  console.log(`route surface: ${declared} declared in source, ${composed} composed`);
});

test("every registered route answers identically however the deps are ordered", async () => {
  const forward = buildApp(FORWARD);
  const reversed = buildApp(REVERSED);
  const keys = routeKeys(forward);
  assert.deepEqual(routeKeys(reversed), keys, "both compositions must register the same routes");

  const byStatus = new Map<number, number>();
  let bodiesCompared = 0;

  for (const key of keys) {
    const [method = "GET", path = "/"] = key.split(" ");
    const target = concrete(path);
    const [a, b] = await Promise.all([
      forward.request(target, { method, headers: LOOPBACK }),
      reversed.request(target, { method, headers: LOOPBACK }),
    ]);

    assert.equal(a.status, b.status, `${key} answered ${a.status} then ${b.status}`);
    const [textA, textB] = [await a.text(), await b.text()];
    if (!NON_DETERMINISTIC_BODIES.has(key)) {
      assert.equal(textA, textB, `${key} returned different bodies`);
      bodiesCompared += 1;
    }

    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    console.log(`  ${String(a.status).padStart(3)}  ${key}`);
  }

  // The tally is a census, not a pass mark. These stubs are bare objects, so a handler that
  // reaches into the registry throws and Hono answers 500; that is a property of the fixture,
  // not of the route. What is asserted per route is EQUIVALENCE - same status, same bytes,
  // either ordering - which is exactly what a positional seam could not guarantee.
  const tally = [...byStatus.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([status, count]) => `${status}:${count}`)
    .join("  ");
  console.log(`routes asserted: ${keys.length}   bodies compared: ${bodiesCompared}   ${tally}`);
  assert.equal(keys.length, bodiesCompared + NON_DETERMINISTIC_BODIES.size);
});

test("a dependency-gated route stops reporting itself unavailable once supplied", async () => {
  // The differential above holds every route steady; this shows the surface is not merely
  // inert. `/api/keep-awake` is 503 with no owner and 200 with one, so the equivalence being
  // asserted is over live handlers rather than a uniformly dead table.
  const without = buildApp(FORWARD);
  assert.equal((await without.request("/api/keep-awake", { headers: LOOPBACK })).status, 503);

  const status = {
    supported: true,
    unavailableReason: null,
    state: "off",
    provider: "caffeinate",
    since: null,
    error: null,
  } as const;
  const withOwner = buildApp({ ...FORWARD, keepAwake: { status: () => status } as never });
  const res = await withOwner.request("/api/keep-awake", { headers: LOOPBACK });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), status);
});
